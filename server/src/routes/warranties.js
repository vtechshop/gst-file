// =============================================
// Warranty register - manual create and edit
// =============================================
// The register has two doors. One is automatic: saving an invoice with cover
// on a line registers that line inside the invoice's own transaction (see
// services/warranty-sync.js). This file is the other: a person standing in
// the Warranty Register creating a record by hand, without opening Invoice
// Entry at all.
//
// The two must not fight over the same rows, and the schema already draws the
// line between them. warranty-sync always stores the invoice_item_id of the
// line it registered; a record made by hand has no single line behind it and
// stores NULL, which is exactly what the partial unique index in
// migration_warranty_register.sql was written for:
//
//     WHERE invoice_item_id IS NOT NULL
//
// So `invoice_item_id IS NULL` IS the manual marker. No column had to be
// added to tell the two apart, and warranty-sync now reconciles only the rows
// it owns, which is what stops a re-saved invoice from cancelling a record a
// person entered by hand.
//
// Why a manual record stores no invoice_item_id even though the form makes
// you pick a line: save-with-items DELETEs and re-INSERTs every line on every
// save (routes/invoices.js), so an item id captured today is a dangling
// reference to a deleted row tomorrow. Storing it would create exactly the
// fake reference this module must never produce. The line is still required,
// still validated, and still the ONLY source of the product written down.
//
// Nothing here touches a total, a tax column, stock, a payment or an invoice
// number. A warranty is a promise about goods already sold.
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { reserveDocumentNumberOn } = require('./documents');
const { warrantyUntilFrom } = require('../services/warranty-sync');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_TABLES = { b2b: 'b2b_invoices', b2c: 'b2c_invoices' };

function bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

function isoDay(value) {
  if (!value) return null;
  return String(value.toISOString ? value.toISOString() : value).slice(0, 10);
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).slice(0, 10);
  if (!DATE_RE.test(s)) throw bad(label + ' must be a valid date.');
  return s;
}

// 1-12, or null for "No warranty". Anything else is a typed mistake rather
// than a period, and is refused instead of being silently coerced.
function periodMonths(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  if (!(n >= 1 && n <= 12)) throw bad('Warranty period must be between 1 and 12 months.');
  return n;
}

// What makes two manual records "the same warranty". The invoice line cannot
// be it: its id is regenerated on every invoice save. The product is, with
// the serial number separating two units of the same product sold on one
// invoice - which is a legitimate pair of warranties, not a duplicate.
function productKey(row) {
  return row.product_id
    ? String(row.product_id)
    : 'name:' + String(row.product_name || '').trim().toLowerCase();
}

const PRODUCT_KEY_SQL =
  "COALESCE(product_id::text, 'name:' || lower(trim(COALESCE(product_name, ''))))";

// ── Create one warranty by hand ──
//
// Every descriptive field is copied from the invoice and the line as they are
// stored, NOT from the request. The browser chooses which invoice and which
// line; it never gets to say what the customer is called, what the product
// was, or what it cost. That is what makes a fabricated invoice number, or a
// product that was never on the invoice, impossible to write.
router.post('/manual', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const type = String(b.invoice_type || '').trim().toLowerCase();
  if (!INVOICE_TABLES[type]) throw bad('Choose a B2B or B2C invoice.');
  if (!UUID_RE.test(String(b.invoice_id || ''))) throw bad('Choose an invoice.');
  if (!UUID_RE.test(String(b.invoice_item_id || ''))) throw bad('Choose a product from that invoice.');

  const months = periodMonths(b.warranty_period_months);
  const startIn = optionalDate(b.warranty_start_date, 'Warranty start date');
  const untilIn = optionalDate(b.warranty_until, 'Warranty until date');
  const serial = String(b.serial_number || '').trim() || null;
  const terms = String(b.warranty_terms || '').trim() || null;
  const qtyIn = b.quantity === undefined || b.quantity === null || b.quantity === ''
    ? null : Number(b.quantity);
  if (qtyIn !== null && !(qtyIn > 0)) throw bad('Quantity must be greater than zero.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) The invoice must exist AND belong to the caller. Scoped on the
    //    user_id from the verified JWT - never on anything the body carries.
    // customer_id is deliberately NOT read here: neither b2b_invoices nor
    // b2c_invoices carries one (see the allow-lists in routes/generic.js), so
    // asking for it would be a 42703 on every save. The register's own
    // customer_id stays NULL rather than being filled with a guess - the
    // customer NAME is copied, which is what a warranty is honoured against.
    const { rows: invRows } = await client.query(
      `SELECT id, invoice_number, invoice_date, customer_name, phone
         FROM ${INVOICE_TABLES[type]} WHERE id = $1 AND user_id = $2`,
      [b.invoice_id, req.userId]);
    const invoice = invRows[0];
    if (!invoice) throw bad('That invoice was not found.', 404);

    // 2) The line must belong to THAT invoice, and to the same owner. Both
    //    halves matter: an id alone would let one invoice's line be attached
    //    to another invoice, which is the arbitrary combination the register
    //    must never hold.
    const { rows: itemRows } = await client.query(
      `SELECT id, product_id, product_name, hsn_code, quantity, rate, total_amount
         FROM invoice_items
        WHERE id = $1 AND invoice_id = $2 AND invoice_type = $3 AND user_id = $4`,
      [b.invoice_item_id, invoice.id, type, req.userId]);
    const item = itemRows[0];
    if (!item) throw bad('That product is not on the selected invoice.');

    // 3) Duplicate guard for hand-made records. The database's partial unique
    //    index covers the automatic ones (which carry an invoice_item_id);
    //    these carry none, so the rule is enforced here instead. A cancelled
    //    record does not block a fresh one - that is how a mistake is redone.
    const { rows: dupe } = await client.query(
      `SELECT warranty_number FROM warranties
        WHERE user_id = $1 AND invoice_type = $2 AND invoice_id = $3
          AND status <> 'cancelled'
          AND ${PRODUCT_KEY_SQL} = $4
          AND lower(trim(COALESCE(serial_number, ''))) = $5
        LIMIT 1`,
      [req.userId, type, invoice.id, productKey(item), (serial || '').toLowerCase()]);
    if (dupe[0]) {
      throw bad('This product on this invoice is already covered by ' + dupe[0].warranty_number + '.'
        + (serial ? '' : ' Add a serial number to register another unit.'), 409);
    }

    // 4) Its own book (WAR-#####), drawn in this transaction so a failed
    //    insert rolls the number back instead of leaving a hole. This cannot
    //    reach a tax invoice counter: the series comes from the fixed
    //    registry in routes/documents.js, never from the request.
    const { documentNumber } = await reserveDocumentNumberOn(client, req.userId, 'warranty');

    const start = startIn || isoDay(invoice.invoice_date);
    // The user may overrule the computed end date; where they have not, it is
    // derived by the same function the automatic path uses, so a manual and
    // an automatic record of the same cover end on the same day.
    const until = untilIn || warrantyUntilFrom(start, months);

    const { rows: created } = await client.query(
      `INSERT INTO warranties
         (user_id, warranty_number, document_series, invoice_id, invoice_type, invoice_item_id,
          invoice_number, invoice_date, customer_id, customer_name, customer_phone,
          product_id, product_name, product_sku, serial_number,
          quantity, rate, purchase_amount, purchase_date,
          warranty_period_months, warranty_start_date, warranty_until, warranty_terms, status)
       VALUES ($1,$2,'warranty',$3,$4,NULL,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'active')
       RETURNING *`,
      [req.userId, documentNumber, invoice.id, type,
       invoice.invoice_number || null, invoice.invoice_date || null,
       invoice.customer_name || '', invoice.phone || null,
       item.product_id || null, item.product_name || '', item.hsn_code || null, serial,
       qtyIn === null ? (+item.quantity || 1) : qtyIn,
       +item.rate || 0, +item.total_amount || 0, invoice.invoice_date || null,
       months, start, until, terms]);

    await client.query('COMMIT');
    res.status(201).json(created[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── Edit one warranty ──
//
// Updates the record in place, so editing never mints a second number for one
// promise. The number, the invoice it points at and the copied
// customer/product identity are all absent from the editable list on purpose:
// changing them would rewrite a record so it describes goods that were never
// sold that way. What a person may correct is what they typed - the serial,
// the quantity, the cover and its terms - plus withdrawing the cover.
router.patch('/:id', asyncRoute(async (req, res) => {
  if (!UUID_RE.test(String(req.params.id || ''))) throw bad('Warranty not found.', 404);
  const b = req.body || {};

  const set = {};
  if ('serial_number' in b) set.serial_number = String(b.serial_number || '').trim() || null;
  if ('warranty_terms' in b) set.warranty_terms = String(b.warranty_terms || '').trim() || null;
  if ('notes' in b) set.notes = String(b.notes || '').trim() || null;
  if ('warranty_period_months' in b) set.warranty_period_months = periodMonths(b.warranty_period_months);
  if ('warranty_start_date' in b) set.warranty_start_date = optionalDate(b.warranty_start_date, 'Warranty start date');
  if ('warranty_until' in b) set.warranty_until = optionalDate(b.warranty_until, 'Warranty until date');
  if ('quantity' in b) {
    const q = Number(b.quantity);
    if (!(q > 0)) throw bad('Quantity must be greater than zero.');
    set.quantity = q;
  }

  // Cancelling is a status change, never a delete: a tag may already be on
  // the goods, and a QR that 404s tells the customer nothing where one
  // reporting CANCELLED tells them exactly where they stand.
  if ('status' in b) {
    const st = String(b.status || '').trim().toLowerCase();
    if (st !== 'active' && st !== 'cancelled') throw bad('A warranty is either active or cancelled.');
    set.status = st;
    set.cancelled_at = st === 'cancelled' ? new Date().toISOString() : null;
    set.cancel_reason = st === 'cancelled'
      ? (String(b.cancel_reason || '').trim() || 'Cancelled from Warranty Register')
      : null;
  }

  const cols = Object.keys(set);
  if (!cols.length) throw bad('Nothing to update.');

  // Scoped to the caller's own user_id, so another company's warranty is not
  // merely hidden from the list - it cannot be written either.
  const params = [req.params.id, req.userId, ...cols.map(c => set[c])];
  const assignments = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE warranties SET ${assignments} WHERE id = $1 AND user_id = $2 RETURNING *`, params);
  if (!rows[0]) throw bad('Warranty not found.', 404);
  res.json(rows[0]);
}));

module.exports = router;
