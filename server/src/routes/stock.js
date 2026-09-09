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
const { randomUUID } = require('crypto');
const {
  applyStockDelta, transferStock, resolveLocation,
  MANUAL_MOVEMENT_DIRECTION, MOVEMENT_TYPES,
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

// ── Locations ─────────────────────────────────────────────────────────
router.get('/locations', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.code, l.is_default, l.active, l.created_at,
            COALESCE(b.products, 0)::int AS products_held,
            COALESCE(b.quantity, 0)      AS quantity_held
       FROM stock_locations l
       LEFT JOIN (
         SELECT location_id, COUNT(*) FILTER (WHERE quantity <> 0) AS products,
                SUM(quantity) AS quantity
           FROM stock_balances WHERE user_id = $1 GROUP BY location_id
       ) b ON b.location_id = l.id
      WHERE l.user_id = $1
      ORDER BY l.is_default DESC, l.active DESC, l.name ASC`, [req.userId]);
  res.json({ rows });
}));

function locationName(body) {
  const name = String((body || {}).name || '').trim();
  if (!name) throw bad('A location name is required.');
  if (name.length > 120) throw bad('That location name is too long.');
  return name;
}
function locationCode(body) {
  const code = String((body || {}).code || '').trim();
  if (!code) return null;
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(code)) {
    throw bad('A location code may use letters, digits, hyphen and underscore only (up to 24).');
  }
  return code.toUpperCase();
}

router.post('/locations', asyncRoute(async (req, res) => {
  const name = locationName(req.body);
  const code = locationCode(req.body);
  const wantDefault = !!(req.body || {}).is_default;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The first location a tenant creates is its default whether or not
    // it was asked for: stock has to land somewhere.
    const { rows: existing } = await client.query(
      'SELECT COUNT(*)::int n FROM stock_locations WHERE user_id = $1', [req.userId]);
    const isDefault = wantDefault || existing[0].n === 0;
    // Only one default per tenant - the partial unique index enforces it,
    // so the previous holder is stood down first rather than colliding.
    if (isDefault) {
      await client.query(
        'UPDATE stock_locations SET is_default = FALSE, updated_at = NOW() WHERE user_id = $1 AND is_default',
        [req.userId]);
    }
    const { rows } = await client.query(
      `INSERT INTO stock_locations (user_id, name, code, is_default, active)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id, name, code, is_default, active`,
      [req.userId, name, code, isDefault]);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505') throw bad('A location with that code already exists.');
    throw err;
  } finally { client.release(); }
}));

router.patch('/locations/:id', asyncRoute(async (req, res) => {
  badId(req.params.id, 'location id');
  const body = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: own } = await client.query(
      'SELECT id, is_default FROM stock_locations WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.userId]);
    if (!own.length) { const e = new Error('Location not found.'); e.status = 404; e.expose = true; throw e; }

    const set = [], vals = [];
    if ('name' in body) { set.push(`name = ${set.length + 1}`); vals.push(locationName(body)); }
    if ('code' in body) { set.push(`code = ${set.length + 1}`); vals.push(locationCode(body)); }
    if ('active' in body) {
      const active = !!body.active;
      // The default location is where undirected stock lands; switching it
      // off would leave documents with nowhere to go.
      if (!active && own[0].is_default) {
        throw bad('The default location cannot be deactivated. Make another location the default first.');
      }
      set.push(`active = ${set.length + 1}`); vals.push(active);
    }
    if (body.is_default === true) {
      await client.query(
        'UPDATE stock_locations SET is_default = FALSE, updated_at = NOW() WHERE user_id = $1 AND is_default',
        [req.userId]);
      set.push(`is_default = TRUE`);
      set.push(`active = TRUE`);            // a default must be usable
    }
    if (!set.length) throw bad('Nothing to update.');

    vals.push(req.params.id, req.userId);
    const { rows } = await client.query(
      `UPDATE stock_locations SET ${set.join(', ')}, updated_at = NOW()
        WHERE id = ${vals.length - 1} AND user_id = ${vals.length}
        RETURNING id, name, code, is_default, active`, vals);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505') throw bad('A location with that code already exists.');
    throw err;
  } finally { client.release(); }
}));

// Deletion is refused whenever the location has ever been used. A ledger
// that cannot say where its stock went is worse than a tidy location list,
// so the answer is deactivation - which the message says plainly.
router.delete('/locations/:id', asyncRoute(async (req, res) => {
  badId(req.params.id, 'location id');
  const { rows: own } = await pool.query(
    'SELECT id, is_default FROM stock_locations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]);
  if (!own.length) { const e = new Error('Location not found.'); e.status = 404; e.expose = true; throw e; }
  if (own[0].is_default) throw bad('The default location cannot be deleted. Make another location the default first.');

  const { rows: held } = await pool.query(
    'SELECT COALESCE(SUM(quantity),0) q FROM stock_balances WHERE user_id = $1 AND location_id = $2',
    [req.userId, req.params.id]);
  if (+held[0].q !== 0) {
    throw bad(`This location still holds ${round3(+held[0].q)} in stock. Move it elsewhere, or deactivate the location instead.`);
  }
  const { rows: used } = await pool.query(
    'SELECT COUNT(*)::int n FROM stock_movements WHERE user_id = $1 AND (location_id = $2 OR to_location_id = $2)',
    [req.userId, req.params.id]);
  if (used[0].n > 0) {
    throw bad('This location appears in the stock ledger and cannot be deleted. Deactivate it instead.');
  }
  await pool.query('DELETE FROM stock_locations WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ ok: true });
}));

// ── Transfer ──────────────────────────────────────────────────────────
// A repeated request must not move the stock twice. The client sends a
// reference it generated; the pair of movements carries it, and a unique
// index on (transfer_id, movement_type) is what actually enforces the rule
// - a retry collides in the database rather than relying on a disabled
// button or a check that another request could race past.
router.post('/transfer', asyncRoute(async (req, res) => {
  const body = req.body || {};
  badId(body.product_id, 'product id');
  badId(body.from_location_id, 'source location id');
  badId(body.to_location_id, 'destination location id');
  const transferId = body.transfer_id || randomUUID();
  badId(transferId, 'transfer reference');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transferStock(client, req.userId, {
      productId: body.product_id,
      fromLocationId: body.from_location_id,
      toLocationId: body.to_location_id,
      quantity: body.quantity,
      transferId,
      reason: String(body.reason || '').trim() || null,
      notes: body.notes || null
    });
    await client.query('COMMIT');
    res.status(201).json({ ...result, transfer_id: transferId });
  } catch (err) {
    await client.query('ROLLBACK');
    // The unique index on (transfer_id, movement_type) fired: this exact
    // transfer already happened, so report it as already done rather than
    // as a failure the user should retry.
    if (err && err.code === '23505') {
      const e = new Error('This transfer has already been recorded.');
      e.status = 409; e.expose = true; e.code = 'transfer_already_recorded'; throw e;
    }
    throw err;
  } finally { client.release(); }
}));

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
    where.push(`p.category = ${params.length}`);
  }
  // "what is in this location" — products holding stock there.
  if (req.query.location_id) {
    badId(req.query.location_id, 'location id');
    params.push(req.query.location_id);
    where.push(`EXISTS (SELECT 1 FROM stock_balances b
                          WHERE b.user_id = p.user_id AND b.product_id = p.id
                            AND b.location_id = ${params.length} AND b.quantity <> 0)`);
  }

  const sql = `
    SELECT p.id, p.name, p.sku, p.hsn_code, p.category, p.unit,
           p.stock, p.reorder_level, ${STOCK_STATUS_SQL} AS status,
           -- The location breakdown travels with the row, aggregated in SQL.
           -- The browser is never handed every balance to group itself.
           COALESCE((
             SELECT json_agg(json_build_object(
                      'location_id', l.id, 'location', l.name, 'quantity', b.quantity)
                      ORDER BY l.name)
               FROM stock_balances b
               JOIN stock_locations l ON l.id = b.location_id
              WHERE b.user_id = p.user_id AND b.product_id = p.id AND b.quantity <> 0
           ), '[]'::json) AS locations
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
  if (req.query.location_id) {
    badId(req.query.location_id, 'location id');
    params.push(req.query.location_id);
    where.push(`(m.location_id = ${params.length} OR m.to_location_id = ${params.length})`);
  }
  if (req.query.from) { params.push(req.query.from); where.push(`m.created_at >= ${params.length}`); }
  if (req.query.to)   { params.push(req.query.to);   where.push(`m.created_at < ($${params.length}::date + 1)`); }

  const sql = `
    SELECT m.id, m.product_id, p.name AS product_name, p.sku,
           m.movement_type, m.direction, m.quantity, m.unit, m.rate,
           m.balance_after, m.source_type, m.source_id, m.source_item_id,
           m.reason, m.notes, m.created_at,
           m.location_id, fl.name AS location_name,
           m.to_location_id, tl.name AS to_location_name, m.transfer_id
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id AND p.user_id = m.user_id
      LEFT JOIN stock_locations fl ON fl.id = m.location_id
      LEFT JOIN stock_locations tl ON tl.id = m.to_location_id
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

  const { rows: byLocation } = await pool.query(
    `SELECT l.id AS location_id, l.name AS location, l.is_default, b.quantity
       FROM stock_balances b
       JOIN stock_locations l ON l.id = b.location_id
      WHERE b.user_id = $1 AND b.product_id = $2
      ORDER BY l.name`, [req.userId, req.params.productId]);
  const locationTotal = round3(byLocation.reduce((a, r) => a + (+r.quantity), 0));

  res.json({
    product,
    by_location: byLocation,
    // A product held across locations must have its balances add up to the
    // company total. Reported rather than assumed - a tenant that has not
    // run the location backfill has no balances at all, which is a
    // different state from balances that disagree.
    location_reconciliation: {
      location_total: locationTotal,
      matches_company_total: byLocation.length === 0 ? null : locationTotal === cached,
      locations: byLocation.length
    },
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
            m.created_at,
            m.location_id, fl.name AS location_name,
            m.to_location_id, tl.name AS to_location_name, m.transfer_id
       FROM stock_movements m
       LEFT JOIN stock_locations fl ON fl.id = m.location_id
       LEFT JOIN stock_locations tl ON tl.id = m.to_location_id
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
      locationId: (req.body || {}).location_id || null,
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
      { type, sourceType: 'adjustment', reason, notes: body.notes || null,
        locationId: body.location_id || null });

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
