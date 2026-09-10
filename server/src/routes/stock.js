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
  applyStockDelta, transferStock, resolveLocation, defaultLocationId,
  MANUAL_MOVEMENT_DIRECTION, MOVEMENT_TYPES,
  SIGNED_QTY_SQL, STOCK_STATUS_SQL, round3
} = require('../services/stock-ledger');
const serialsSvc = require('../services/stock-serials');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badId(id, what) {
  if (!UUID_RE.test(String(id || ''))) {
    const e = new Error(`Invalid ${what || 'id'}.`); e.status = 400; e.expose = true; throw e;
  }
}
// Most refusals here are malformed input, so 400 is the default; a
// conflict with the state of the goods (already sold, already there, not
// movable) is a 409 and says so.
function bad(msg, status) {
  const e = new Error(msg); e.status = status || 400; e.expose = true; return e;
}

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

// ── Serial numbers ────────────────────────────────────────────────────
//
// Declared BEFORE /:productId, or Express would read "serials" as a
// product id and this whole section would be unreachable.
//
// Everything here is scoped to req.userId from the token. A serial that
// belongs to another tenant is not found rather than refused, which is the
// same answer the rest of the application gives and tells a caller nothing
// about what other tenants hold.
const SERIAL_LIST_COLUMNS = `
  s.id, s.serial_no, s.status, s.product_id, s.location_id,
  s.source_type, s.source_id, s.sold_source_type, s.sold_source_id,
  s.purchase_order_item_id, s.notes, s.created_at, s.updated_at,
  p.name AS product_name, p.sku AS product_sku,
  l.name AS location_name`;

router.get('/serials', asyncRoute(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const where = ['s.user_id = $1'];
  const params = [req.userId];

  // Scanner-friendly: an exact serial match wins, and a partial one still
  // finds it. Compared the way the unique index compares, so a scan of
  // "sn001" finds "SN001".
  const q = String(req.query.q || '').trim();
  if (q) {
    params.push('%' + q.toUpperCase() + '%');
    where.push(`upper(btrim(s.serial_no)) LIKE $${params.length}`);
  }
  if (req.query.status) {
    const wanted = String(req.query.status).toUpperCase();
    if (!serialsSvc.SERIAL_STATUSES.includes(wanted)) {
      throw bad(`status must be one of ${serialsSvc.SERIAL_STATUSES.join(', ')}.`);
    }
    params.push(wanted); where.push(`s.status = $${params.length}`);
  }
  if (req.query.product_id) {
    badId(req.query.product_id, 'product id');
    params.push(req.query.product_id); where.push(`s.product_id = $${params.length}`);
  }
  if (req.query.location_id) {
    badId(req.query.location_id, 'location id');
    params.push(req.query.location_id); where.push(`s.location_id = $${params.length}`);
  }
  // "Which units did THIS document bring in / take out." A return picker
  // must offer only the units its own document is entitled to: the ones
  // that purchase received, or the ones that invoice sold. Filtering by
  // product alone would offer a unit from another delivery or another
  // customer's invoice, which the save path would then rightly refuse.
  if (req.query.source_id) {
    badId(req.query.source_id, 'source id');
    params.push(req.query.source_id); where.push(`s.source_id = $${params.length}`);
  }
  if (req.query.sold_source_id) {
    badId(req.query.sold_source_id, 'sold source id');
    params.push(req.query.sold_source_id); where.push(`s.sold_source_id = $${params.length}`);
  }
  // Several states at once, for a picker that accepts more than one.
  if (req.query.statuses) {
    const wanted = String(req.query.statuses).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    for (const st of wanted) {
      if (!serialsSvc.SERIAL_STATUSES.includes(st)) throw bad(`Unknown status "${st}".`);
    }
    if (wanted.length) { params.push(wanted); where.push(`s.status = ANY($${params.length})`); }
  }

  const sql = `
    SELECT ${SERIAL_LIST_COLUMNS}
      FROM stock_serials s
      JOIN products p ON p.id = s.product_id AND p.user_id = s.user_id
      LEFT JOIN stock_locations l ON l.id = s.location_id AND l.user_id = s.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.created_at DESC, upper(btrim(s.serial_no)) ASC
     LIMIT ${limit} OFFSET ${offset}`;
  const countSql = `SELECT COUNT(*)::int AS total FROM stock_serials s WHERE ${where.join(' AND ')}`;
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(sql, params), pool.query(countSql, params)
  ]);
  res.json({ rows, total: countRows[0].total, limit, offset });
}));

// Reconciliation: the quantity balance against the units actually held.
// Reported, never corrected — see reconcileSerials().
router.get('/serials/reconcile', asyncRoute(async (req, res) => {
  if (req.query.product_id) badId(req.query.product_id, 'product id');
  const client = await pool.connect();
  try {
    const rows = await serialsSvc.reconcileSerials(client, req.userId,
      { productId: req.query.product_id || null });
    res.json({ rows, balanced: rows.every(r => r.balanced) });
  } finally { client.release(); }
}));

// ── Naming the units a product already holds ──────────────────────────
//
// A product that has been counted for years has a quantity but no names.
// Serial tracking cannot simply be switched on for it: the system would be
// claiming ten identifiable units while knowing none of them.
//
// This is the reconciliation that makes it possible — the person enters
// the numbers actually on the shelf, and only if there are exactly as many
// as the balance says does tracking begin.
//
// It is NOT a purchase. No stock arrives, no quantity changes, and no
// movement is written: inventing a PURCHASE row would put goods on a date
// and a supplier nobody recorded. The units are marked as coming from
// 'opening', the same word the ledger already uses for a balance that
// predates its history.
router.post('/serials/reconcile-opening', asyncRoute(async (req, res) => {
  const body = req.body || {};
  badId(body.product_id, 'product id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: prod } = await client.query(
      'SELECT id, name, stock, serial_tracking FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [body.product_id, req.userId]);
    if (!prod.length) { const e = new Error('Product not found.'); e.status = 404; e.expose = true; throw e; }
    const product = prod[0];
    if (product.stock === null) {
      throw bad('This product is not stock-tracked, so it has no units to name.');
    }

    const { rows: existing } = await client.query(
      'SELECT COUNT(*)::int AS n FROM stock_serials WHERE user_id = $1 AND product_id = $2',
      [req.userId, body.product_id]);
    if (existing[0].n > 0) {
      throw bad('This product already has serial numbers recorded. '
        + 'Reconciliation is for a product whose units have never been named.', 409);
    }

    const serials = serialsSvc.readSerialList(body.serials, { where: 'This reconciliation' });
    const stock = Number(product.stock);
    if (serials.length !== stock) {
      throw bad(
        `"${product.name}" holds ${stock} in stock, so it needs exactly ${stock} serial `
        + `number${stock === 1 ? '' : 's'} — ${serials.length} `
        + `${serials.length === 1 ? 'was' : 'were'} entered.`, 409);
    }
    if (!stock) throw bad('There is no stock to reconcile.');

    // The units go where the quantity already is. Stock spread across
    // several locations cannot be divided up from a flat list of numbers
    // without guessing which unit sits where, so it is refused and said so
    // rather than assigned arbitrarily.
    const { rows: balances } = await client.query(
      `SELECT location_id, quantity FROM stock_balances
        WHERE user_id = $1 AND product_id = $2 AND quantity <> 0`,
      [req.userId, body.product_id]);
    if (balances.length > 1) {
      throw bad(
        `"${product.name}" is held at ${balances.length} locations. Reconciling a product `
        + 'spread across more than one location is not supported yet — the numbers alone '
        + 'do not say which unit is where.', 409);
    }
    const locationId = balances.length ? balances[0].location_id
      : await defaultLocationId(client, req.userId);

    const created = await serialsSvc.receiveSerials(client, req.userId, {
      productId: body.product_id, serials, locationId,
      // Not a purchase. 'opening' is the ledger's own word for a balance
      // that was already there when the history began.
      sourceType: 'opening', sourceId: null, createdBy: req.userId
    });

    // Only now does tracking begin — the flag and the units are set
    // together, so the product is never serial-tracked with nothing named.
    await client.query(
      'UPDATE products SET serial_tracking = TRUE WHERE id = $1 AND user_id = $2',
      [body.product_id, req.userId]);

    await client.query('COMMIT');
    res.status(201).json({
      product_id: body.product_id, serial_tracking: true,
      stock, created: created.length, location_id: locationId
    });
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}));

// One unit, with the timeline that explains it. The movements carry the
// document each step belonged to, so the history needs no table of its own.
router.get('/serials/:id', asyncRoute(async (req, res) => {
  badId(req.params.id, 'serial id');
  const { rows } = await pool.query(
    `SELECT ${SERIAL_LIST_COLUMNS}
       FROM stock_serials s
       JOIN products p ON p.id = s.product_id AND p.user_id = s.user_id
       LEFT JOIN stock_locations l ON l.id = s.location_id AND l.user_id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2`, [req.params.id, req.userId]);
  if (!rows.length) { const e = new Error('Serial not found.'); e.status = 404; e.expose = true; throw e; }

  const { rows: timeline } = await pool.query(
    `SELECT m.id, m.movement_type, m.direction, m.quantity, m.balance_after,
            m.source_type, m.source_id, m.reason, m.notes, m.created_at,
            l.name AS location_name, t.name AS to_location_name
       FROM stock_movements m
       LEFT JOIN stock_locations l ON l.id = m.location_id AND l.user_id = m.user_id
       LEFT JOIN stock_locations t ON t.id = m.to_location_id AND t.user_id = m.user_id
      WHERE m.serial_id = $1 AND m.user_id = $2
      ORDER BY m.created_at ASC, m.id ASC`, [req.params.id, req.userId]);

  const { rows: warranty } = await pool.query(
    `SELECT id, warranty_number, status, warranty_until
       FROM warranties WHERE serial_id = $1 AND user_id = $2`, [req.params.id, req.userId]);

  res.json({
    serial: rows[0],
    timeline,
    warranty: warranty[0] || null,
    allowed_transitions: serialsSvc.SERIAL_TRANSITIONS[rows[0].status] || []
  });
}));

// Inspection, damage, scrap and repair. Selling is deliberately not
// reachable here: a unit is sold by raising an invoice for it, so that the
// quantity, the document and the unit move together.
router.post('/serials/:id/status', asyncRoute(async (req, res) => {
  badId(req.params.id, 'serial id');
  const next = String((req.body || {}).status || '').toUpperCase();
  const reason = String((req.body || {}).reason || '').trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { before, after } = await serialsSvc.transitionSerial(
      client, req.userId, req.params.id, next, { reason });

    // Damage and scrap take the unit out of sellable stock, and the
    // quantity account has to agree. DAMAGE keeps the goods on the
    // premises, so only SCRAP removes the quantity.
    // Only SCRAP moves quantity. A damaged unit is still on the premises
    // and still in the balance — it has stopped being sellable, which the
    // serial's own status records; scrapping is when the goods actually
    // leave. Writing a DAMAGE movement here would mean a quantity of zero,
    // which the ledger's own CHECK (quantity > 0) rightly refuses: a
    // movement that moves nothing is not a movement.
    let balance = null;
    if (next === 'SCRAPPED') {
      balance = await applyStockDelta(client, req.userId, after.product_id, -1, {
        type: 'SCRAP', sourceType: 'serial', sourceId: after.id,
        reason: reason || 'Serial scrapped', locationId: before.location_id || null,
        serialId: after.id
      });
    }
    await client.query('COMMIT');
    res.json({ serial: after, stock: balance,
      allowed_transitions: serialsSvc.SERIAL_TRANSITIONS[after.status] || [] });
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}));

// Moving one unit between locations. The quantity moves through the
// existing transfer engine — this adds the unit's own location to the same
// transaction rather than building a second way to move stock.
router.post('/serials/:id/transfer', asyncRoute(async (req, res) => {
  badId(req.params.id, 'serial id');
  const body = req.body || {};
  badId(body.to_location_id, 'destination location id');
  const transferId = body.transfer_id || randomUUID();
  badId(transferId, 'transfer reference');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The unit is locked first, then the balances, which is the order
    // transferStock() itself locks in — so a serial move and a quantity
    // move on the same product queue instead of deadlocking.
    const locked = await serialsSvc.lockSerials(client, req.userId, [req.params.id]);
    const row = locked.get(req.params.id);
    if (!row) { const e = new Error('Serial not found.'); e.status = 404; e.expose = true; throw e; }
    if (!row.location_id) throw bad('This serial is not held at a location.', 409);
    if (row.location_id === body.to_location_id) {
      throw bad('That serial is already at this location.');
    }

    const moved = await serialsSvc.transferSerial(client, req.userId, req.params.id, {
      fromLocationId: row.location_id, toLocationId: body.to_location_id
    });
    const result = await transferStock(client, req.userId, {
      productId: row.product_id,
      fromLocationId: row.location_id,
      toLocationId: body.to_location_id,
      quantity: 1,
      transferId,
      reason: String(body.reason || '').trim() || `Serial ${row.serial_no}`,
      notes: body.notes || null,
      serialId: row.id
    });
    await client.query('COMMIT');
    res.status(201).json({ serial: moved, ...result, transfer_id: transferId });
  } catch (err) {
    await client.query('ROLLBACK');
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

    // A serialised product cannot gain or lose stock anonymously: +1 with
    // no serial would be a unit nobody can name, and -1 with no serial
    // would leave the two accounts disagreeing about which unit went.
    const tracked = await serialsSvc.serialTrackedProducts(client, req.userId, [productId]);
    if (tracked.has(productId)) {
      throw bad(
        'This product is serial-tracked. Adjust its stock by entering or selecting the '
        + 'individual serial numbers, so the units and the quantity stay in step.', 409);
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
