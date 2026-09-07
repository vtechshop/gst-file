// Stock reporting and the two manual movement entries.
//
// Everything a document does to stock already happens in invoices.js,
// purchases.js and sales-returns.js — this router does not duplicate any
// of it. What lives here is the reading side (summary, ledger, movement
// feed, low/out) plus the two ways stock legitimately moves without a
// document behind it: an opening balance, and an adjustment.
//
// Every query is scoped to req.userId from the JWT, exactly as the rest of
// the application does it. Aggregation is server-side: a ledger can run to
// thousands of rows per product and is never shipped to the browser to be
// summed there.
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const {
  applyStockDelta, MANUAL_MOVEMENT_DIRECTION, MOVEMENT_TYPES,
  SIGNED_QTY_SQL, STOCK_STATUS_SQL, round3
} = require('../services/stock-ledger');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badId(id, what) {
  if (!UUID_RE.test(String(id || ''))) {
    const e = new Error(`Invalid ${what || 'id'}.`); e.status = 400; e.expose = true; throw e;
  }
}
function bad(msg) { const e = new Error(msg); e.status = 400; e.expose = true; return e; }

// A quantity the user typed. Must be a real, positive, finite number —
// "" , "abc", 0, -1 and Infinity are all refused rather than coerced,
// because each of them would write a movement nobody meant.
function positiveQty(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${field} must be a number greater than zero.`);
  return round3(n);
}

// Paging. Capped so one request cannot pull an entire ledger into memory.
function paging(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

// ── Stock Summary — one row per stock-tracked product ─────────────────
// Also serves Low Stock and Out of Stock, which are this list with a
// status filter, so the three can never classify a product differently.
router.get('/', asyncRoute(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const params = [req.userId];
  const where = ['p.user_id = $1', 'p.stock IS NOT NULL'];

  if (req.query.status) {
    const wanted = String(req.query.status).toUpperCase();
    if (!['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'].includes(wanted)) {
      throw bad('status must be IN_STOCK, LOW_STOCK or OUT_OF_STOCK.');
    }
    params.push(wanted);
    where.push(`${STOCK_STATUS_SQL} = $${params.length}`);
  }
  // One search box over the fields a user would actually search stock by.
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    const i = params.length;
    where.push(`(p.name ILIKE $${i} OR COALESCE(p.sku,'') ILIKE $${i} OR COALESCE(p.hsn_code,'') ILIKE $${i})`);
  }
  if (req.query.category) {
    params.push(String(req.query.category));
    where.push(`p.category = $${params.length}`);
  }

  const sql = `
    SELECT p.id, p.name, p.sku, p.hsn_code, p.category, p.unit,
           p.stock, p.reorder_level, ${STOCK_STATUS_SQL} AS status
      FROM products p
     WHERE ${where.join(' AND ')}
     ORDER BY (${STOCK_STATUS_SQL} = 'OUT_OF_STOCK') DESC,
              (${STOCK_STATUS_SQL} = 'LOW_STOCK') DESC,
              p.name ASC
     LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `SELECT COUNT(*)::int AS total FROM products p WHERE ${where.join(' AND ')}`;
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(sql, params), pool.query(countSql, params)
  ]);
  res.json({ rows, total: countRows[0].total, limit, offset });
}));

// ── Headline counters, for the summary page ───────────────────────────
router.get('/stats', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS tracked_products,
       COALESCE(SUM(p.stock), 0) AS total_quantity,
       COUNT(*) FILTER (WHERE ${STOCK_STATUS_SQL} = 'LOW_STOCK')::int AS low_stock,
       COUNT(*) FILTER (WHERE ${STOCK_STATUS_SQL} = 'OUT_OF_STOCK')::int AS out_of_stock
     FROM products p
    WHERE p.user_id = $1 AND p.stock IS NOT NULL`, [req.userId]);

  const { rows: today } = await pool.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE direction = 'IN'), 0)  AS in_today,
       COALESCE(SUM(quantity) FILTER (WHERE direction = 'OUT'), 0) AS out_today
     FROM stock_movements
    WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())`, [req.userId]);

  res.json({ ...rows[0], ...today[0] });
}));

// ── The movement feed, across all products ────────────────────────────
router.get('/movements', asyncRoute(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const params = [req.userId];
  const where = ['m.user_id = $1'];

  if (req.query.product_id) {
    badId(req.query.product_id, 'product id');
    params.push(req.query.product_id);
    where.push(`m.product_id = $${params.length}`);
  }
  if (req.query.movement_type) {
    const types = String(req.query.movement_type).split(',').map(t => t.trim().toUpperCase());
    const unknown = types.filter(t => !MOVEMENT_TYPES.includes(t));
    if (unknown.length) throw bad(`Unknown movement type: ${unknown.join(', ')}.`);
    params.push(types);
    where.push(`m.movement_type = ANY($${params.length})`);
  }
  if (req.query.direction) {
    const d = String(req.query.direction).toUpperCase();
    if (d !== 'IN' && d !== 'OUT') throw bad('direction must be IN or OUT.');
    params.push(d);
    where.push(`m.direction = $${params.length}`);
  }
  if (req.query.from) { params.push(req.query.from); where.push(`m.created_at >= $${params.length}`); }
  if (req.query.to)   { params.push(req.query.to);   where.push(`m.created_at < ($${params.length}::date + 1)`); }

  const sql = `
    SELECT m.id, m.product_id, p.name AS product_name, p.sku,
           m.movement_type, m.direction, m.quantity, m.unit, m.rate,
           m.balance_after, m.source_type, m.source_id, m.source_item_id,
           m.reason, m.notes, m.created_at
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id AND p.user_id = m.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ${limit} OFFSET ${offset}`;
  const countSql = `
    SELECT COUNT(*)::int AS total FROM stock_movements m
     WHERE ${where.join(' AND ')}`;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(sql, params), pool.query(countSql, params)
  ]);
  res.json({ rows, total: countRows[0].total, limit, offset });
}));

// ── One product: balance, ledger and reconciliation ───────────────────
// The reconciliation is the point of the ledger: it re-sums every movement
// in SQL and reports whether products.stock agrees with them.
//
// A product carrying stock from before the ledger existed has no history
// to sum, so it reports UNRECONCILED with the difference spelled out.
// That is the honest answer — nothing here invents an opening movement to
// make the two agree.
router.get('/:productId', asyncRoute(async (req, res) => {
  badId(req.params.productId, 'product id');
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.sku, p.hsn_code, p.unit, p.category,
            p.stock, p.reorder_level, ${STOCK_STATUS_SQL} AS status
       FROM products p WHERE p.id = $1 AND p.user_id = $2`,
    [req.params.productId, req.userId]);
  if (!rows.length) { const e = new Error('Product not found.'); e.status = 404; e.expose = true; throw e; }

  const { rows: agg } = await pool.query(
    `SELECT COALESCE(SUM(${SIGNED_QTY_SQL}), 0) AS ledger_balance,
            COUNT(*)::int AS movement_count
       FROM stock_movements WHERE user_id = $1 AND product_id = $2`,
    [req.userId, req.params.productId]);

  const { rows: byType } = await pool.query(
    `SELECT movement_type,
            COALESCE(SUM(${SIGNED_QTY_SQL}), 0) AS net_quantity,
            COUNT(*)::int AS movements
       FROM stock_movements WHERE user_id = $1 AND product_id = $2
      GROUP BY movement_type ORDER BY movement_type`,
    [req.userId, req.params.productId]);

  const product = rows[0];
  const ledger = round3(+agg[0].ledger_balance);
  const cached = product.stock === null ? null : round3(+product.stock);
  const movementCount = agg[0].movement_count;

  res.json({
    product,
    reconciliation: {
      cached_stock: cached,
      ledger_balance: ledger,
      difference: cached === null ? null : round3(cached - ledger),
      movement_count: movementCount,
      // No movements at all and a non-zero balance means stock predates the
      // ledger, which is a different situation from a genuine mismatch.
      status: cached === null ? 'NOT_TRACKED'
        : cached === ledger ? 'RECONCILED'
          : movementCount === 0 ? 'NO_LEDGER_HISTORY'
            : 'UNRECONCILED'
    },
    by_type: byType
  });
}));

// ── The ledger for one product, oldest first ──────────────────────────
router.get('/:productId/ledger', asyncRoute(async (req, res) => {
  badId(req.params.productId, 'product id');
  const { limit, offset } = paging(req.query);
  const params = [req.userId, req.params.productId];
  const { rows } = await pool.query(
    `SELECT m.id, m.movement_type, m.direction, m.quantity, m.unit, m.rate,
            m.balance_after, m.source_type, m.source_id, m.reason, m.notes,
            m.created_at
       FROM stock_movements m
      WHERE m.user_id = $1 AND m.product_id = $2
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ${limit} OFFSET ${offset}`, params);
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM stock_movements WHERE user_id = $1 AND product_id = $2', params);
  res.json({ rows, total: countRows[0].total, limit, offset });
}));

// ── Opening balance ───────────────────────────────────────────────────
// The controlled way a product acquires a starting quantity. Refused once
// the product has any movement history, because a second "opening" would
// not be an opening — that is what an adjustment is for.
router.post('/opening', asyncRoute(async (req, res) => {
  const { product_id: productId } = req.body || {};
  badId(productId, 'product id');
  const quantity = positiveQty((req.body || {}).quantity, 'Opening quantity');
  const rateRaw = (req.body || {}).rate;
  const rate = rateRaw == null || rateRaw === '' ? null : Number(rateRaw);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0)) throw bad('Opening rate must be zero or more.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock first, so two opening balances for the same product cannot both
    // pass the "has no history" test.
    const { rows } = await client.query(
      'SELECT id, stock, unit FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [productId, req.userId]);
    if (!rows.length) { const e = new Error('Product not found.'); e.status = 404; e.expose = true; throw e; }

    const { rows: existing } = await client.query(
      'SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1 AND product_id = $2',
      [req.userId, productId]);
    if (existing[0].n > 0) {
      throw bad('This product already has stock movements. Use a stock adjustment instead of an opening balance.');
    }

    // A product that was never stock-tracked becomes tracked here: NULL is
    // the "not tracked" sentinel, and an opening balance is precisely the
    // decision to start tracking it.
    await client.query('UPDATE products SET stock = 0 WHERE id = $1 AND user_id = $2', [productId, req.userId]);

    const balance = await applyStockDelta(client, req.userId, productId, quantity, {
      type: 'OPENING', sourceType: 'opening', rate,
      reason: (req.body || {}).reason || 'Opening balance'
    });

    await client.query('COMMIT');
    res.status(201).json({ product_id: productId, stock: balance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── Adjustment, damage, scrap, consumption, sample, free issue ────────
// One endpoint for every movement that has no source document. Each needs
// a reason, because the reason is the only justification such a movement
// will ever have.
router.post('/adjustment', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const { product_id: productId } = body;
  badId(productId, 'product id');

  const type = String(body.movement_type || '').toUpperCase();
  const direction = MANUAL_MOVEMENT_DIRECTION[type];
  if (!direction) {
    throw bad(`movement_type must be one of ${Object.keys(MANUAL_MOVEMENT_DIRECTION).join(', ')}.`);
  }
  const quantity = positiveQty(body.quantity, 'Quantity');
  const reason = String(body.reason || '').trim();
  if (!reason) throw bad('A reason is required for a manual stock movement.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT stock FROM products WHERE id = $1 AND user_id = $2',
      [productId, req.userId]);
    if (!rows.length) { const e = new Error('Product not found.'); e.status = 404; e.expose = true; throw e; }
    if (rows[0].stock === null) {
      throw bad('This product is not stock-tracked. Record an opening balance first.');
    }

    const balance = await applyStockDelta(
      client, req.userId, productId,
      direction === 'IN' ? quantity : -quantity,
      { type, sourceType: 'adjustment', reason, notes: body.notes || null });

    await client.query('COMMIT');
    res.status(201).json({ product_id: productId, stock: balance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
