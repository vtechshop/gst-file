// Saves a Credit / Debit Note together with the products it applies to,
// in one transaction.
//
// A note's money - its taxable amount, GST split and total - stays on the
// note, exactly as before, and stays authoritative. The item rows only say
// WHICH products of the original invoice the note is for, so a customer can
// see what was credited or debited. They are a snapshot of the invoice
// lines taken here, on the server, from the stored invoice: the browser
// sends which lines it chose and how many of each, never the name, HSN,
// rate or value it wants printed.
//
// Everything is checked before the first write, so a rejected note leaves
// the note, its items and the invoice exactly as they were. Nothing here
// touches stock, serials or the invoice itself - a Sales Return is the
// document for goods that come back.
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { TABLES } = require('./generic');
const { round2 } = require('../utils/validation');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(message, status) {
  const e = new Error(message); e.status = status || 400; e.expose = true; throw e;
}
function badId(id, what) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) refuse(what || 'Invalid id.');
}

// The two tables a note can be issued against, and the invoice_type their
// lines carry. Anything else is refused rather than interpolated.
const INVOICE_TABLES = { b2b_invoices: 'b2b', b2c_invoices: 'b2c' };

// Set here and nowhere else: the id and owner of the note, and its link to
// the invoice, which is only ever the invoice this route has verified.
const SERVER_OWNED = ['id', 'user_id', 'created_at', 'updated_at',
  'original_invoice_id', 'original_invoice_table'];

// Money compared in whole paise, so 0.1 + 0.2 can never fail to equal 0.3.
const paise = n => Math.round(round2(n) * 100);
const sameRate = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const rateText = v => String(Math.round(Number(v) * 1000) / 1000);
const money = n => (Math.round(Number(n) * 100) / 100).toFixed(2);

// A GSTIN compared as a GSTIN, a name compared without its spacing,
// punctuation or case - "M/s. Mega Kitchen" is the customer "MEGA KITCHEN".
const gstinOf = v => String(v || '').replace(/\s+/g, '').toUpperCase();
const nameOf = v => String(v || '').toUpperCase().replace(/^M\/S\.?\s*/, '').replace(/[^A-Z0-9]/g, '');

// Is this invoice the note's customer's? A registered customer is known by
// GSTIN, so the GSTINs must agree - and a note naming no GSTIN is not the
// note of an invoice issued to one. Without a GSTIN on either side the
// names must agree. An invoice that names no customer at all (a walk-in
// sale) has nothing to compare, so the question does not apply.
function customerMatches(inv, header) {
  const invG = gstinOf(inv.gst_number), noteG = gstinOf(header.gstin);
  if (invG || noteG) return invG === noteG;
  if (!nameOf(inv.customer_name)) return true;
  return nameOf(inv.customer_name) === nameOf(header.customer_name);
}

function customerRefusal(inv) {
  const who = inv.customer_name || 'another customer';
  const g = gstinOf(inv.gst_number);
  return `Invoice ${inv.invoice_number || ''} was issued to ${who}${g ? ' (GSTIN ' + g + ')' : ''}, `
    + 'not to the customer on this note. Select that invoice\'s customer, or the right invoice.';
}

const INVOICE_COLS = 'id, invoice_number, invoice_date, customer_name, gst_number';

// The invoice the browser selected, if it is this tenant's.
async function selectedInvoice(client, userId, invoice) {
  if (!invoice || typeof invoice !== 'object' || !INVOICE_TABLES[invoice.table]) {
    refuse('Select the original invoice again - the one chosen could not be read.');
  }
  badId(invoice.id, 'Select the original invoice again - the one chosen could not be read.');
  const { rows } = await client.query(
    `SELECT ${INVOICE_COLS} FROM ${invoice.table} WHERE id = $1 AND user_id = $2`,
    [invoice.id, userId]);
  // Another tenant's invoice and no invoice at all get the same answer.
  if (!rows.length) refuse('That invoice was not found.', 404);
  return { ...rows[0], table: invoice.table, type: INVOICE_TABLES[invoice.table] };
}

// A note that names its invoice only by typed number. Linked when the
// number names exactly one of this tenant's invoices AND that invoice is
// the note's customer's; left as text, as every note before this was, when
// it names none (an invoice raised outside this system) or is someone
// else's. Two invoices can legitimately share a number - one per table and
// per numbering series - and guessing between them is exactly what must
// not happen, so that case is refused and the user asked to choose.
async function typedInvoice(client, userId, header) {
  const num = String(header.original_invoice || '').trim();
  if (!num) return null;
  const { rows } = await client.query(
    `SELECT ${INVOICE_COLS}, 'b2b_invoices' AS tbl FROM b2b_invoices
      WHERE user_id = $1 AND lower(btrim(invoice_number)) = lower($2)
     UNION ALL
     SELECT ${INVOICE_COLS}, 'b2c_invoices' AS tbl FROM b2c_invoices
      WHERE user_id = $1 AND lower(btrim(invoice_number)) = lower($2)`,
    [userId, num]);
  if (rows.length > 1) {
    refuse(`More than one invoice is numbered "${num}". Select the invoice from the list `
      + 'so the note is linked to the right one.', 409);
  }
  if (!rows.length) return null;
  const inv = { ...rows[0], table: rows[0].tbl, type: INVOICE_TABLES[rows[0].tbl] };
  return customerMatches(inv, header) ? inv : null;
}

// Each chosen line, re-read from the invoice and turned into the snapshot
// that is stored. The browser's copy of the line is never used.
async function snapshotItems(client, userId, inv, header, lines) {
  const ids = [];
  lines.forEach((line, i) => {
    if (!line || typeof line !== 'object') refuse(`Item ${i + 1} could not be read.`);
    badId(line.invoice_item_id, `Item ${i + 1} is not a line of the selected invoice.`);
    if (ids.includes(line.invoice_item_id)) refuse('The same invoice line is selected twice.');
    ids.push(line.invoice_item_id);
  });

  const { rows } = await client.query(
    `SELECT id, product_id, product_name, hsn_code, unit, quantity, rate, taxable_value, gst_percentage
       FROM invoice_items
      WHERE user_id = $1 AND invoice_id = $2 AND invoice_type = $3 AND id = ANY($4::uuid[])`,
    [userId, inv.id, inv.type, ids]);
  const byId = new Map(rows.map(r => [r.id, r]));

  // A product reference is kept only when it is this tenant's product.
  const productIds = [...new Set(rows.map(r => r.product_id).filter(Boolean))];
  const own = new Set(productIds.length
    ? (await client.query('SELECT id FROM products WHERE user_id = $1 AND id = ANY($2::uuid[])',
      [userId, productIds])).rows.map(r => r.id)
    : []);

  return lines.map((line, i) => {
    const src = byId.get(line.invoice_item_id);
    if (!src) refuse(`Item ${i + 1} is not a line of the selected invoice.`);
    const name = src.product_name || `Item ${i + 1}`;

    // One note, one rate. Not averaged, not the highest, not the lowest.
    if (!sameRate(src.gst_percentage, header.gst_percentage)) {
      refuse(`${name} is charged at ${rateText(src.gst_percentage)}% GST on the invoice, but this note `
        + `is at ${rateText(header.gst_percentage)}%. A note has one GST rate, so an item at another `
        + 'rate needs a note of its own.');
    }

    const full = Number(src.quantity);
    const asked = line.quantity;
    const qty = (asked === undefined || asked === null || asked === '') ? full : Number(asked);
    if (!Number.isFinite(qty) || qty <= 0) refuse(`${name}: enter a quantity greater than zero.`);
    if (Number.isFinite(full) && full > 0 && qty > full + 1e-9) {
      refuse(`${name}: the invoice has ${rateText(full)}, so the note cannot cover ${rateText(qty)}.`);
    }

    // The whole line is the line's own stored value, to the paisa. Part of
    // it is that value in proportion, which carries any discount on the
    // line with it: 2 for 6000 is 3000 each, whatever the list rate was.
    const whole = !(full > 0) || Math.abs(qty - full) < 1e-9;
    const taxable = src.taxable_value === null ? null
      : whole ? round2(src.taxable_value) : round2(Number(src.taxable_value) * qty / full);

    return {
      product_id: src.product_id && own.has(src.product_id) ? src.product_id : null,
      product_name: src.product_name,
      hsn_code: src.hsn_code || null,
      unit: src.unit || null,
      quantity: Math.round(qty * 1000) / 1000,
      rate: src.rate === null ? null : round2(src.rate),
      taxable_value: taxable
    };
  });
}

router.post('/save-with-items', asyncRoute(async (req, res) => {
  const { editId, header, invoice } = req.body || {};
  const items = req.body ? req.body.items : undefined;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    refuse('The note is missing or malformed.');
  }
  if (items !== undefined && items !== null && !Array.isArray(items)) refuse('Items must be a list.');
  const lines = items || [];
  if (editId) badId(editId);
  if (lines.length && !invoice) refuse('Select the original invoice the items are on.');
  if (!['credit', 'debit'].includes(header.note_type)) refuse('Choose Credit Note or Debit Note.');
  if (!Number.isFinite(Number(header.taxable_amount)) || Number(header.taxable_amount) <= 0) {
    refuse('Taxable amount must be positive.');
  }
  if (!Number.isFinite(Number(header.gst_percentage))) refuse('Choose the GST rate.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── The invoice: the one selected, or the one a typed number names ──
    let inv = null;
    if (invoice) {
      inv = await selectedInvoice(client, req.userId, invoice);
      if (!customerMatches(inv, header)) refuse(customerRefusal(inv));
    } else {
      inv = await typedInvoice(client, req.userId, header);
    }

    // ── The items, from the invoice ──
    const snapshot = lines.length ? await snapshotItems(client, req.userId, inv, header, lines) : [];
    if (snapshot.length) {
      // The items explain the note; they do not restate it. So they must
      // add up to it exactly, and neither side is adjusted to make them.
      const sum = snapshot.reduce((s, it) => s + paise(it.taxable_value || 0), 0);
      if (sum !== paise(header.taxable_amount)) {
        refuse(`The selected items add up to Rs.${money(sum / 100)}, but the note's taxable amount `
          + `is Rs.${money(header.taxable_amount)}. They must be equal - change the items or the amount.`);
      }
    }

    // ── The note ──
    const own = { ...header };
    if (inv) {
      // Printed as the invoice is numbered and dated, not as it was typed.
      if (inv.invoice_number) own.original_invoice = inv.invoice_number;
      if (inv.invoice_date) own.original_invoice_date = inv.invoice_date;
    }
    const cols = TABLES.cdn_notes.columns.filter(c =>
      !SERVER_OWNED.includes(c) && Object.prototype.hasOwnProperty.call(own, c));
    const values = cols.map(c => own[c]);
    // The link is written every time, so a note taken off an invoice is
    // unlinked rather than left pointing at it.
    cols.push('original_invoice_id', 'original_invoice_table');
    values.push(inv ? inv.id : null, inv ? inv.table : null);

    let noteId = editId;
    if (editId) {
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const { rows } = await client.query(
        `UPDATE cdn_notes SET ${set} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]);
      // Another tenant's note and a deleted one get the same answer.
      if (!rows.length) refuse('That note was not found.', 404);
    } else {
      const all = cols.concat('user_id');
      const { rows } = await client.query(
        `INSERT INTO cdn_notes (${all.join(', ')}) VALUES (${all.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
        [...values, req.userId]);
      noteId = rows[0].id;
    }

    // Replaced, never merged: an edit leaves exactly the items it saved.
    await client.query('DELETE FROM cdn_note_items WHERE note_id = $1 AND user_id = $2', [noteId, req.userId]);
    for (const [i, it] of snapshot.entries()) {
      await client.query(
        `INSERT INTO cdn_note_items (user_id, note_id, product_id, product_name, hsn_code, unit,
           quantity, rate, taxable_value, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [req.userId, noteId, it.product_id, it.product_name, it.hsn_code, it.unit,
          it.quantity, it.rate, it.taxable_value, i]);
    }

    await client.query('COMMIT');
    res.json({ id: noteId, items: snapshot.length,
      original_invoice_id: inv ? inv.id : null, original_invoice_table: inv ? inv.table : null });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
