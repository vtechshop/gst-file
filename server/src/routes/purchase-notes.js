// Saves a Purchase Credit / Debit Note together with the purchase lines it
// applies to, in one transaction.
//
// This document is a FINANCIAL adjustment against a completed purchase - a
// rate difference, a shortfall, a discount agreed after the bill. It is not
// a Purchase Return, and the difference matters:
//
//   Purchase Return        goods go back; moves stock and serials
//   Purchase Credit/Debit  money only; moves NOTHING
//
// So nothing in this file writes a stock movement, touches a serial, or
// changes the purchase it is raised against. Raising a note and returning
// goods are two separate acts, and filing one never files the other.
//
// The note's money - taxable amount, GST split, total - stays on the note
// and stays authoritative. The item rows only say WHICH lines of the
// purchase the note is for. They are a snapshot taken here, on the server,
// from the stored purchase: the browser sends which lines it chose and how
// many of each, never the name, HSN, rate or value it wants printed.
//
// Everything is checked before the first write, so a rejected note leaves
// the note, its items and the purchase exactly as they were.
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

// Set here and nowhere else: the id and owner of the note, and its link to
// the purchase, which is only ever the purchase this route has verified.
const SERVER_OWNED = ['id', 'user_id', 'created_at', 'updated_at', 'original_purchase_id'];

// Money compared in whole paise, so 0.1 + 0.2 can never fail to equal 0.3.
const paise = n => Math.round(round2(n) * 100);
const sameRate = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const rateText = v => String(Math.round(Number(v) * 1000) / 1000);
const money = n => (Math.round(Number(n) * 100) / 100).toFixed(2);

// A GSTIN compared as a GSTIN, a name compared without its spacing,
// punctuation or case - "M/s. Kookmate India" is the vendor "KOOKMATE INDIA".
const gstinOf = v => String(v || '').replace(/\s+/g, '').toUpperCase();
const nameOf = v => String(v || '').toUpperCase().replace(/^M\/S\.?\s*/, '').replace(/[^A-Z0-9]/g, '');

// Is this purchase the note's supplier's? A registered supplier is known by
// GSTIN, so the GSTINs must agree. Without a GSTIN on either side the names
// must agree. A purchase naming no supplier at all has nothing to compare.
function vendorMatches(pur, header) {
  const purG = gstinOf(pur.vendor_gstin), noteG = gstinOf(header.vendor_gstin);
  if (purG || noteG) return purG === noteG;
  if (!nameOf(pur.vendor_name)) return true;
  return nameOf(pur.vendor_name) === nameOf(header.vendor_name);
}

function vendorRefusal(pur) {
  const who = pur.vendor_name || 'another supplier';
  const g = gstinOf(pur.vendor_gstin);
  return `Purchase ${pur.purchase_number || ''} was billed by ${who}${g ? ' (GSTIN ' + g + ')' : ''}, `
    + 'not by the supplier on this note. Select that purchase\'s supplier, or the right purchase.';
}

const PURCHASE_COLS = 'id, purchase_number, purchase_date, vendor_id, vendor_name, vendor_gstin, state, supply_type';

// The purchase the browser selected, if it is this tenant's.
async function selectedPurchase(client, userId, purchaseId) {
  badId(purchaseId, 'Select the original purchase again - the one chosen could not be read.');
  const { rows } = await client.query(
    `SELECT ${PURCHASE_COLS} FROM purchases WHERE id = $1 AND user_id = $2`, [purchaseId, userId]);
  // Another tenant's purchase and no purchase at all get the same answer.
  if (!rows.length) refuse('That purchase was not found.', 404);
  return rows[0];
}

// Each chosen line, re-read from the purchase and turned into the snapshot
// that is stored. The browser's copy of the line is never used.
//
// cess_rate is read straight from the column here even though the purchase
// entry screen does not yet capture it (the generic API's purchase_items
// allow-list omits it). It is stored so a note stays correct if purchases
// ever start carrying cess; today it is the column default.
async function snapshotItems(client, userId, pur, header, lines) {
  const ids = [];
  lines.forEach((line, i) => {
    if (!line || typeof line !== 'object') refuse(`Item ${i + 1} could not be read.`);
    badId(line.purchase_item_id, `Item ${i + 1} is not a line of the selected purchase.`);
    if (ids.includes(line.purchase_item_id)) refuse('The same purchase line is selected twice.');
    ids.push(line.purchase_item_id);
  });

  const { rows } = await client.query(
    `SELECT id, product_id, product_name, hsn_code, unit, quantity, rate,
            discount_percentage, gst_percentage, cess_rate, taxable_value
       FROM purchase_items
      WHERE user_id = $1 AND purchase_id = $2 AND id = ANY($3::uuid[])`,
    [userId, pur.id, ids]);
  const byId = new Map(rows.map(r => [r.id, r]));

  // A product reference is kept only when it is this tenant's product.
  const productIds = [...new Set(rows.map(r => r.product_id).filter(Boolean))];
  const own = new Set(productIds.length
    ? (await client.query('SELECT id FROM products WHERE user_id = $1 AND id = ANY($2::uuid[])',
      [userId, productIds])).rows.map(r => r.id)
    : []);

  return lines.map((line, i) => {
    const src = byId.get(line.purchase_item_id);
    if (!src) refuse(`Item ${i + 1} is not a line of the selected purchase.`);
    const name = src.product_name || `Item ${i + 1}`;

    // One note, one rate. Not averaged, not the highest, not the lowest.
    if (!sameRate(src.gst_percentage, header.gst_percentage)) {
      refuse(`${name} is charged at ${rateText(src.gst_percentage)}% GST on the purchase, but this note `
        + `is at ${rateText(header.gst_percentage)}%. A note has one GST rate, so an item at another `
        + 'rate needs a note of its own.');
    }

    // Note Qty cannot exceed the quantity the purchase itself carries.
    // Quantities already sent back on a Purchase RETURN are deliberately not
    // subtracted: a return moves goods, this note moves money, and the two
    // are independent documents.
    const full = Number(src.quantity);
    const asked = line.quantity;
    const qty = (asked === undefined || asked === null || asked === '') ? full : Number(asked);
    if (!Number.isFinite(qty) || qty <= 0) refuse(`${name}: enter a quantity greater than zero.`);
    if (Number.isFinite(full) && full > 0 && qty > full + 1e-9) {
      refuse(`${name}: the purchase has ${rateText(full)}, so the note cannot cover ${rateText(qty)}.`);
    }

    // The whole line is the line's own stored value, to the paisa. Part of
    // it is that value in proportion, which carries any discount on the line
    // with it: 2 for 6000 is 3000 each, whatever the list rate was.
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
      discount_percentage: src.discount_percentage === null ? 0 : Number(src.discount_percentage),
      gst_percentage: src.gst_percentage === null ? 0 : Number(src.gst_percentage),
      cess_rate: src.cess_rate === null ? 0 : Number(src.cess_rate),
      taxable_value: taxable
    };
  });
}

router.post('/save-with-items', asyncRoute(async (req, res) => {
  const { editId, header, purchase } = req.body || {};
  const items = req.body ? req.body.items : undefined;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    refuse('The note is missing or malformed.');
  }
  if (items !== undefined && items !== null && !Array.isArray(items)) refuse('Items must be a list.');
  const lines = items || [];
  if (editId) badId(editId);
  if (lines.length && !purchase) refuse('Select the original purchase the items are on.');
  if (!['credit', 'debit'].includes(header.note_type)) refuse('Choose Credit Note or Debit Note.');
  if (!String(header.note_number || '').trim()) refuse('Enter a note number.');
  if (!String(header.vendor_name || '').trim()) refuse('Enter the supplier name.');
  if (!Number.isFinite(Number(header.taxable_amount)) || Number(header.taxable_amount) <= 0) {
    refuse('Taxable amount must be positive.');
  }
  if (!Number.isFinite(Number(header.gst_percentage))) refuse('Choose the GST rate.');
  if (!['intrastate', 'interstate'].includes(header.supply_type)) refuse('Choose the supply type.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── The purchase, if one was selected ──
    let pur = null;
    if (purchase) {
      const purchaseId = (typeof purchase === 'object' && purchase) ? purchase.id : purchase;
      pur = await selectedPurchase(client, req.userId, purchaseId);
      if (!vendorMatches(pur, header)) refuse(vendorRefusal(pur));
    }

    // ── The items, from the purchase ──
    const snapshot = lines.length ? await snapshotItems(client, req.userId, pur, header, lines) : [];
    if (snapshot.length) {
      // The items explain the note; they do not restate it. So they must add
      // up to it exactly, and neither side is adjusted to make them.
      const sum = snapshot.reduce((s, it) => s + paise(it.taxable_value || 0), 0);
      if (sum !== paise(header.taxable_amount)) {
        refuse(`The selected items add up to Rs.${money(sum / 100)}, but the note's taxable amount `
          + `is Rs.${money(header.taxable_amount)}. They must be equal - change the items or the amount.`);
      }
    }

    // A note raised against a purchase the user CHOSE must name the lines it
    // covers - "which items is this note for" is the whole point of the link.
    if (purchase && !snapshot.length) {
      refuse('Select the product(s) this note is for - a note linked to a purchase must say which items it covers.');
    }

    // ── The note ──
    const own = { ...header };
    if (pur) {
      // Printed as the purchase is numbered and dated, not as it was typed.
      if (pur.purchase_number) own.original_purchase_number = pur.purchase_number;
      if (pur.purchase_date) own.original_purchase_date = pur.purchase_date;
      if (pur.vendor_id) own.vendor_id = pur.vendor_id;
    }
    const cols = TABLES.purchase_notes.columns.filter(c =>
      !SERVER_OWNED.includes(c) && Object.prototype.hasOwnProperty.call(own, c));
    const values = cols.map(c => own[c]);
    // The link is written every time, so a note taken off a purchase is
    // unlinked rather than left pointing at it.
    cols.push('original_purchase_id');
    values.push(pur ? pur.id : null);

    let noteId = editId;
    if (editId) {
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const { rows } = await client.query(
        `UPDATE purchase_notes SET ${set} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]);
      // Another tenant's note and a deleted one get the same answer.
      if (!rows.length) refuse('That note was not found.', 404);
    } else {
      const all = cols.concat('user_id');
      const { rows } = await client.query(
        `INSERT INTO purchase_notes (${all.join(', ')}) VALUES (${all.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
        [...values, req.userId]);
      noteId = rows[0].id;
    }

    // Replaced, never merged: an edit leaves exactly the items it saved.
    await client.query('DELETE FROM purchase_note_items WHERE note_id = $1 AND user_id = $2',
      [noteId, req.userId]);
    for (const [i, it] of snapshot.entries()) {
      await client.query(
        `INSERT INTO purchase_note_items (user_id, note_id, product_id, product_name, hsn_code, unit,
           quantity, rate, discount_percentage, gst_percentage, cess_rate, taxable_value, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [req.userId, noteId, it.product_id, it.product_name, it.hsn_code, it.unit,
          it.quantity, it.rate, it.discount_percentage, it.gst_percentage, it.cess_rate,
          it.taxable_value, i]);
    }

    await client.query('COMMIT');
    // No stock movement, no serial change, no touch of the purchase: this
    // document adjusts money only.
    res.json({ id: noteId, items: snapshot.length, original_purchase_id: pur ? pur.id : null });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
