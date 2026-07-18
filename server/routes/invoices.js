// Bespoke transactional endpoints — the three places in the app that do
// multi-step orchestration across several tables and need real Postgres
// transactions (BEGIN/COMMIT/ROLLBACK) rather than the generic
// single-table CRUD router (routes/generic.js):
//   1. POST /:type/save-with-items   — invoice header + line items + stock
//   2. POST /reserve-number           — Auto Generate invoice numbering
//   3. POST /:type/:id/cascade-*      — Recycle Bin delete/restore/hard-delete
//
// Frontend call sites (unchanged signatures, only their internals swap
// to a single fetch() each): js/invoice-items.js's saveInvoiceWithItems()
// and cascadeInvoiceItemsDelete/Restore/HardDelete(), js/invoice-entry.js's
// reserveNextInvoiceNumber().
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { applyInvoiceNumberFormat } = require('../utils/invoiceNumberFormat');
const { TABLES } = require('./generic');

const router = express.Router();
router.use(requireAuth);

function invoiceTable(type) { return type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices'; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badId(id) {
  if (!UUID_RE.test(id)) { const e = new Error('Invalid invoice id.'); e.status = 400; e.expose = true; throw e; }
}
function hsnTable(type) { return type === 'b2b' ? 'b2b_hsn' : 'b2c_hsn'; }
function badType(type) {
  if (type !== 'b2b' && type !== 'b2c') { const e = new Error('type must be b2b or b2c.'); e.status = 400; e.expose = true; throw e; }
}

// Row-locks the product (FOR UPDATE) before adjusting stock — this is
// the actual race-safety upgrade over the old client-side read-then-write
// loop, which had no way to prevent two concurrent saves from reading
// the same stale stock value.
async function applyStockDelta(client, userId, productId, deltaQty) {
  if (!productId || !deltaQty) return;
  const { rows } = await client.query('SELECT stock FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE', [productId, userId]);
  if (!rows.length || rows[0].stock === null) return; // not stock-tracked
  const next = Math.round((+rows[0].stock + deltaQty) * 1000) / 1000;
  await client.query('UPDATE products SET stock = $1 WHERE id = $2', [next, productId]);
}

// ── 1) Save invoice header + line items + stock, one transaction ──
router.post('/:type/save-with-items', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const type = req.params.type;
  const table = invoiceTable(type);
  const { editId, header, items } = req.body;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    const e = new Error('Invoice header is missing or malformed.'); e.status = 400; e.expose = true; throw e;
  }
  if (!Array.isArray(items) || !items.length) {
    const e = new Error('Add at least one product with a quantity and rate.'); e.status = 400; e.expose = true; throw e;
  }
  if (editId) badId(editId);

  const headerCols = TABLES[table].columns.filter(c => c !== 'id' && c !== 'user_id' && header && Object.prototype.hasOwnProperty.call(header, c));
  const itemCols = TABLES.invoice_items.columns.filter(c => !['id','user_id','invoice_id','invoice_type','sort_order','is_deleted','deleted_at','created_at','updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let invoiceId = editId;
    let oldItems = [];

    if (editId) {
      const values = headerCols.map(c => header[c]);
      const setClause = headerCols.map((c, i) => `${c} = $${i + 1}`).join(',');
      const { rows } = await client.query(
        `UPDATE ${table} SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]
      );
      if (!rows.length) { const e = new Error('Invoice not found.'); e.status = 404; e.expose = true; throw e; }
      invoiceId = rows[0].id;

      const { rows: oldRows } = await client.query(
        'SELECT product_id, quantity FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
        [editId, type, req.userId]
      );
      oldItems = oldRows;
    } else {
      const payload = { ...header, user_id: req.userId };
      const cols = headerCols.concat('user_id');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      const { rows } = await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
      invoiceId = rows[0].id;
    }

    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3', [invoiceId, type, req.userId]);

    const newQtyByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const payload = { ...items[i], user_id: req.userId, invoice_id: invoiceId, invoice_type: type, sort_order: i };
      const cols = itemCols.concat(['user_id', 'invoice_id', 'invoice_type', 'sort_order']).filter(c => Object.prototype.hasOwnProperty.call(payload, c));
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      await client.query(`INSERT INTO invoice_items (${cols.join(',')}) VALUES (${placeholders})`, values);
      if (payload.product_id) newQtyByProduct[payload.product_id] = (newQtyByProduct[payload.product_id] || 0) + (+payload.quantity || 0);
    }

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
      // A sale decrements stock — delta here is "more sold" (positive =
      // stock should go down), so it's applied negated, same sign
      // convention the old client-side applyStockDeltaForSave() used.
      const delta = (newQtyByProduct[pid] || 0) - (oldQtyByProduct[pid] || 0);
      if (delta) await applyStockDelta(client, req.userId, pid, -delta);
    }

    await client.query('COMMIT');
    res.json({ invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 2) Reserve the next Auto Generate invoice number, one transaction ──
router.post('/reserve-number', asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the profile row FIRST, serializing concurrent reservations for
    // this user — the taken-numbers scan below only runs once that lock
    // is held, so two simultaneous saves can never both read the same
    // "next" number before either commits (reading before locking would
    // reopen exactly the race this transaction exists to close).
    const { rows: profRows } = await client.query(
      'SELECT invoice_number_format, invoice_current_sequence FROM profiles WHERE id = $1 FOR UPDATE', [req.userId]
    );
    const format = profRows[0]?.invoice_number_format || 'INV-###';
    let seq = Math.max(1, parseInt(profRows[0]?.invoice_current_sequence, 10) || 1);

    // Both tables, INCLUDING soft-deleted rows — a deleted invoice's
    // number must never be reissued.
    const [{ rows: b2bRows }, { rows: b2cRows }] = await Promise.all([
      client.query('SELECT invoice_number FROM b2b_invoices WHERE user_id = $1', [req.userId]),
      client.query('SELECT invoice_number FROM b2c_invoices WHERE user_id = $1', [req.userId])
    ]);
    const taken = new Set([...b2bRows, ...b2cRows].map(r => (r.invoice_number || '').toUpperCase()));

    let candidate = applyInvoiceNumberFormat(format, seq);
    let guard = 0;
    while (taken.has(candidate.toUpperCase()) && guard < 100000) {
      seq++;
      candidate = applyInvoiceNumberFormat(format, seq);
      guard++;
    }
    if (guard >= 100000) candidate = candidate + '-' + Date.now(); // pathological format (no #) — guarantee uniqueness anyway

    await client.query('UPDATE profiles SET invoice_current_sequence = $1 WHERE id = $2', [seq + 1, req.userId]);
    await client.query('COMMIT');
    res.json({ invoiceNumber: candidate });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 3) Recycle Bin cascades — invoice_items + HSN (+ stock), one transaction ──
// The invoice HEADER row's own soft-delete/restore/hard-delete happens
// separately via the generic router (js/recycle-bin.js and
// js/invoice-list.js both already do that plain update/delete call
// themselves) — these three endpoints only ever touch the DOWNSTREAM
// rows a header row's state change cascades to.
router.post('/:type/:id/cascade-delete', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const { type, id } = req.params;
  badId(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
      [id, type, req.userId]
    );
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, +it.quantity || 0);

    const now = new Date().toISOString();
    await client.query(
      'UPDATE invoice_items SET is_deleted = true, deleted_at = $1 WHERE invoice_id = $2 AND invoice_type = $3 AND user_id = $4',
      [now, id, type, req.userId]
    );
    await client.query(
      `UPDATE ${hsnTable(type)} SET is_deleted = true, deleted_at = $1 WHERE source_invoice_id = $2 AND source_invoice_type = $3 AND user_id = $4`,
      [now, id, type, req.userId]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:type/:id/cascade-restore', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const { type, id } = req.params;
  badId(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE invoice_items SET is_deleted = false, deleted_at = null WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
      [id, type, req.userId]
    );
    await client.query(
      `UPDATE ${hsnTable(type)} SET is_deleted = false, deleted_at = null WHERE source_invoice_id = $1 AND source_invoice_type = $2 AND user_id = $3`,
      [id, type, req.userId]
    );
    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
      [id, type, req.userId]
    );
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, -(+it.quantity || 0));
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:type/:id/cascade-hard-delete', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const { type, id } = req.params;
  badId(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3', [id, type, req.userId]);
    await client.query(
      `DELETE FROM ${hsnTable(type)} WHERE source_invoice_id = $1 AND source_invoice_type = $2 AND user_id = $3`,
      [id, type, req.userId]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
