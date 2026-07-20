// Bespoke transactional endpoints for the Purchase Module — mirrors
// server/routes/invoices.js exactly (same header+items+stock-in-one-
// transaction shape, same Recycle Bin cascade shape), generalized over
// `kind` ('purchase' | 'return') instead of hardcoding one header/items
// table pair, since Purchase Entry and Purchase Returns are two
// genuinely separate table pairs (not one shared-with-discriminator
// table the way b2b_invoices/b2c_invoices share invoice_items).
//
// Stock direction is the one real difference between the two kinds: a
// purchase increases stock, a return decreases it — both expressed as
// the sign passed to applyStockDelta() (imported from invoices.js, not
// reimplemented — same row-locked SELECT...FOR UPDATE race-safety).
//
// Frontend call site: js/purchase-items.js's savePurchaseWithItems() /
// cascadePurchaseItemsDelete/Restore/HardDelete().
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { TABLES } = require('./generic');
const { applyStockDelta } = require('./invoices');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badId(id) {
  if (!UUID_RE.test(id)) { const e = new Error('Invalid id.'); e.status = 400; e.expose = true; throw e; }
}

// kind -> { headerTable, itemsTable, itemFk, stockSign }
// stockSign: +1 = a purchase's line quantity increases stock (goods
// received), -1 = a return's line quantity decreases stock (goods sent
// back) — the sign applyStockDelta() is called with is this value times
// the qty delta.
const KIND_CONFIG = {
  purchase: { headerTable: 'purchases', itemsTable: 'purchase_items', itemFk: 'purchase_id', stockSign: 1 },
  return:   { headerTable: 'purchase_returns', itemsTable: 'purchase_return_items', itemFk: 'return_id', stockSign: -1 }
};

function badKind(kind) {
  if (!KIND_CONFIG[kind]) { const e = new Error('kind must be purchase or return.'); e.status = 400; e.expose = true; throw e; }
}

// ── 1) Save header + line items + stock, one transaction ──
router.post('/:kind/save-with-items', asyncRoute(async (req, res) => {
  badKind(req.params.kind);
  const kind = req.params.kind;
  const { headerTable, itemsTable, itemFk, stockSign } = KIND_CONFIG[kind];
  const { editId, header, items } = req.body;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    const e = new Error('Header is missing or malformed.'); e.status = 400; e.expose = true; throw e;
  }
  if (!Array.isArray(items) || !items.length) {
    const e = new Error('Add at least one product with a quantity and rate.'); e.status = 400; e.expose = true; throw e;
  }
  if (editId) badId(editId);

  const headerCols = TABLES[headerTable].columns.filter(c => c !== 'id' && c !== 'user_id' && header && Object.prototype.hasOwnProperty.call(header, c));
  const itemCols = TABLES[itemsTable].columns.filter(c => !['id','user_id',itemFk,'sort_order','is_deleted','deleted_at','created_at','updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let headerId = editId;
    let oldItems = [];

    if (editId) {
      const values = headerCols.map(c => header[c]);
      const setClause = headerCols.map((c, i) => `${c} = $${i + 1}`).join(',');
      const { rows } = await client.query(
        `UPDATE ${headerTable} SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]
      );
      if (!rows.length) { const e = new Error('Record not found.'); e.status = 404; e.expose = true; throw e; }
      headerId = rows[0].id;

      const { rows: oldRows } = await client.query(
        `SELECT product_id, quantity FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`,
        [editId, req.userId]
      );
      oldItems = oldRows;
    } else {
      const payload = { ...header, user_id: req.userId };
      const cols = headerCols.concat('user_id');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      const { rows } = await client.query(`INSERT INTO ${headerTable} (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
      headerId = rows[0].id;
    }

    await client.query(`DELETE FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`, [headerId, req.userId]);

    const newQtyByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const payload = { ...items[i], user_id: req.userId, [itemFk]: headerId, sort_order: i };
      const cols = itemCols.concat(['user_id', itemFk, 'sort_order']).filter(c => Object.prototype.hasOwnProperty.call(payload, c));
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      await client.query(`INSERT INTO ${itemsTable} (${cols.join(',')}) VALUES (${placeholders})`, values);
      if (payload.product_id) newQtyByProduct[payload.product_id] = (newQtyByProduct[payload.product_id] || 0) + (+payload.quantity || 0);
    }

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
      const delta = (newQtyByProduct[pid] || 0) - (oldQtyByProduct[pid] || 0);
      if (delta) await applyStockDelta(client, req.userId, pid, stockSign * delta);
    }

    await client.query('COMMIT');
    res.json({ id: headerId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 2) Recycle Bin cascades — line items (+ stock), one transaction ──
// The header row's own soft-delete/restore/hard-delete happens
// separately via the generic router (same pattern invoices.js's cascade
// endpoints use) — these only touch the downstream line-item rows.
router.post('/:kind/:id/cascade-delete', asyncRoute(async (req, res) => {
  badKind(req.params.kind);
  const { kind, id } = req.params;
  badId(id);
  const { itemsTable, itemFk, stockSign } = KIND_CONFIG[kind];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: items } = await client.query(
      `SELECT product_id, quantity FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`,
      [id, req.userId]
    );
    // Deleting a saved record un-applies its stock effect — a purchase
    // being deleted must give back the stock it added; a return being
    // deleted must give back the stock it took away. Opposite sign from
    // the original apply, same magnitude.
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, -stockSign * (+it.quantity || 0));

    const now = new Date().toISOString();
    await client.query(
      `UPDATE ${itemsTable} SET is_deleted = true, deleted_at = $1 WHERE ${itemFk} = $2 AND user_id = $3`,
      [now, id, req.userId]
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

router.post('/:kind/:id/cascade-restore', asyncRoute(async (req, res) => {
  badKind(req.params.kind);
  const { kind, id } = req.params;
  badId(id);
  const { itemsTable, itemFk, stockSign } = KIND_CONFIG[kind];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${itemsTable} SET is_deleted = false, deleted_at = null WHERE ${itemFk} = $1 AND user_id = $2`,
      [id, req.userId]
    );
    const { rows: items } = await client.query(
      `SELECT product_id, quantity FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`,
      [id, req.userId]
    );
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, stockSign * (+it.quantity || 0));
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:kind/:id/cascade-hard-delete', asyncRoute(async (req, res) => {
  badKind(req.params.kind);
  const { kind, id } = req.params;
  badId(id);
  const { itemsTable, itemFk } = KIND_CONFIG[kind];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`, [id, req.userId]);
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
