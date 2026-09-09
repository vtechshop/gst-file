// The one place stock is allowed to move.
//
// products.stock was already mutated transactionally by the four document
// flows through a single row-locked helper. What it lacked was a reason:
// the number moved and nothing recorded who moved it, against which
// document, or from what to what. This module is that helper, widened so
// that a balance change and the ledger row explaining it are written by
// the same statement pair inside the caller's transaction - which is what
// makes "never silently mutate current_stock" an invariant rather than a
// convention.
//
// Two rules the callers rely on:
//
//   1. products.stock IS NULL means the product is not stock-tracked.
//      Nothing is written, no movement is recorded, and no guard fires.
//      Services and untracked goods keep behaving exactly as before.
//
//   2. A movement context is REQUIRED. Calling this without one throws,
//      so a future call site cannot quietly move stock without leaving a
//      ledger row behind.
const MOVEMENT_TYPES = Object.freeze([
  'OPENING',
  'PURCHASE', 'PURCHASE_RETURN',
  'SALE', 'SALES_RETURN',
  'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
  'DAMAGE', 'SCRAP', 'CONSUMPTION', 'SAMPLE', 'FREE_ISSUE',
  // Phase 2: the two halves of a transfer. Raised only by the transfer
  // endpoint, never by the adjustment one - moving stock between two
  // places is not an adjustment of how much there is.
  'TRANSFER_IN', 'TRANSFER_OUT'
]);
const MOVEMENT_TYPE_SET = new Set(MOVEMENT_TYPES);

// Movement types a user may raise by hand, and which way each one moves
// stock. A manual movement has no source document, so `reason` is what
// justifies it and the API requires one.
const MANUAL_MOVEMENT_DIRECTION = Object.freeze({
  ADJUSTMENT_IN: 'IN',
  ADJUSTMENT_OUT: 'OUT',
  DAMAGE: 'OUT',
  SCRAP: 'OUT',
  CONSUMPTION: 'OUT',
  SAMPLE: 'OUT',
  FREE_ISSUE: 'OUT'
});

// Quantities are DECIMAL(15,3) throughout this schema, and the original
// helper rounded to three places for exactly that reason - so that a
// float sum of 0.1 + 0.2 cannot drift the stored balance.
function round3(n) { return Math.round(n * 1000) / 1000; }

// A rejection the user is meant to read, not a crash. `expose` and
// `status` are what the existing error handler uses to decide that.
function insufficientStock(productName, available, required, unit) {
  const u = unit ? ' ' + unit : '';
  const e = new Error(
    `Insufficient Stock${productName ? ' — ' + productName : ''}\n`
    + `Available: ${round3(available)}${u}\n`
    + `Required: ${round3(required)}${u}`);
  e.status = 400;
  e.expose = true;
  e.code = 'insufficient_stock';
  e.detail = {
    product_name: productName || null,
    available: round3(available),
    required: round3(required),
    unit: unit || null
  };
  return e;
}

// ── Locations ─────────────────────────────────────────────────────────
//
// A tenant that has never created a location keeps Phase 1's behaviour
// exactly: products.stock moves, the movement records no location, and
// nothing is invented. The moment locations exist, the same engine starts
// maintaining a balance per location as well as the company total.
//
// That conditional is what lets this ship before the backfill runs, rather
// than requiring a data change and a code change to land together.
async function defaultLocationId(client, userId) {
  const { rows } = await client.query(
    'SELECT id FROM stock_locations WHERE user_id = $1 AND is_default AND active LIMIT 1',
    [userId]);
  return rows.length ? rows[0].id : null;
}

// Resolve where a movement happens: what the caller asked for, else the
// tenant's default, else nowhere (pre-locations tenant).
//
// A caller-supplied location is VALIDATED against this tenant before use -
// a location id arriving from a browser is a request, not an authorisation.
async function resolveLocation(client, userId, requested) {
  if (!requested) return defaultLocationId(client, userId);
  const { rows } = await client.query(
    'SELECT id FROM stock_locations WHERE id = $1 AND user_id = $2 AND active',
    [requested, userId]);
  if (!rows.length) {
    const e = new Error('That stock location does not exist or is not active.');
    e.status = 400; e.expose = true; throw e;
  }
  return rows[0].id;
}

// Make sure a balance row exists for each (product, location), creating in
// a deterministic order so two transactions doing this for the same pair
// cannot deadlock against each other, then lock them all in that same
// order and hand back their quantities.
//
// The ordering is the whole point: a transfer A->B and a simultaneous
// transfer B->A would otherwise grab their two rows in opposite orders and
// deadlock. Sorting by location id means every transaction in the system
// takes these locks in one agreed sequence.
async function lockBalances(client, userId, productId, locationIds) {
  const ids = [...new Set(locationIds.filter(Boolean))].sort();
  if (!ids.length) return new Map();
  for (const id of ids) {
    await client.query(
      `INSERT INTO stock_balances (user_id, product_id, location_id, quantity)
       VALUES ($1,$2,$3,0)
       ON CONFLICT (user_id, product_id, location_id) DO NOTHING`,
      [userId, productId, id]);
  }
  const { rows } = await client.query(
    `SELECT location_id, quantity FROM stock_balances
      WHERE user_id = $1 AND product_id = $2 AND location_id = ANY($3)
      ORDER BY location_id
      FOR UPDATE`,
    [userId, productId, ids]);
  return new Map(rows.map(r => [r.location_id, +r.quantity]));
}

// Apply a signed change to one product's stock and record why.
//
// deltaQty is signed: negative takes stock out, positive puts it back.
// The ledger stores the magnitude in `quantity` and the sign in
// `direction`, so a CHECK can insist quantity > 0 and a typo cannot
// write a negative "IN".
//
// The SELECT ... FOR UPDATE is the concurrency control, and it is load
// bearing: it serialises two concurrent saves of the same product so the
// second reads the first's committed balance rather than the same stale
// one. The guard below is only sound because of that lock - checking a
// balance nobody holds a lock on would let both callers pass the check
// and both write.
async function applyStockDelta(client, userId, productId, deltaQty, movement) {
  if (!productId || !deltaQty) return null;

  if (!movement || !movement.type) {
    // Not user-facing: this is a programming error at a call site.
    throw new Error('applyStockDelta requires a movement context ({ type, ... })');
  }
  if (!MOVEMENT_TYPE_SET.has(movement.type)) {
    throw new Error(`Unknown stock movement type: ${movement.type}`);
  }

  // The product row is locked FIRST, before any balance row. Every caller
  // takes the locks in this same order - product, then balances sorted by
  // location - which is what keeps two transactions touching the same
  // product from deadlocking against each other.
  const { rows } = await client.query(
    'SELECT stock, unit, name FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [productId, userId]
  );
  // Not this tenant's product, or not stock-tracked. Either way there is
  // nothing to move and nothing to record.
  if (!rows.length || rows[0].stock === null) return null;

  // Where this happens. null means the tenant has no locations yet, in
  // which case this behaves exactly as Phase 1 did.
  const locationId = movement.locationLocked
    ? movement.locationId
    : await resolveLocation(client, userId, movement.locationId);

  const current = +rows[0].stock;
  const next = round3(current + deltaQty);

  // Negative stock is blocked, at the LOCATION when the product is managed
  // across locations and company-wide when it is not. Checking only the
  // company total would let a showroom sell stock that is in the
  // warehouse. The rejection throws, which rolls the caller's transaction
  // back - so the document does not half-save and no movement is left
  // behind claiming stock that never left.
  let balances = new Map();
  if (locationId) {
    balances = movement.locationLocked
      ? movement.lockedBalances
      : await lockBalances(client, userId, productId, [locationId]);
    const here = balances.get(locationId) || 0;
    const hereNext = round3(here + deltaQty);
    if (hereNext < 0) {
      throw insufficientStock(rows[0].name, here, -deltaQty, movement.unit || rows[0].unit);
    }
    await client.query(
      `UPDATE stock_balances SET quantity = $1, updated_at = NOW()
        WHERE user_id = $2 AND product_id = $3 AND location_id = $4`,
      [hereNext, userId, productId, locationId]);
    balances.set(locationId, hereNext);
  }

  if (next < 0) {
    throw insufficientStock(rows[0].name, current, -deltaQty, movement.unit || rows[0].unit);
  }

  await client.query('UPDATE products SET stock = $1 WHERE id = $2', [next, productId]);

  await client.query(
    `INSERT INTO stock_movements
       (user_id, product_id, movement_type, direction, quantity, unit, rate,
        balance_after, source_type, source_id, source_item_id, reason, notes,
        location_id, to_location_id, transfer_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$1)`,
    [
      userId, productId, movement.type,
      deltaQty > 0 ? 'IN' : 'OUT',
      Math.abs(round3(deltaQty)),
      movement.unit || rows[0].unit || null,
      movement.rate == null ? null : +movement.rate,
      next,
      movement.sourceType || null,
      movement.sourceId || null,
      movement.sourceItemId || null,
      movement.reason || null,
      movement.notes || null,
      locationId,
      movement.toLocationId || null,
      movement.transferId || null
    ]
  );

  return next;
}

// Move stock between two locations, in one transaction.
//
// products.stock is deliberately untouched: a transfer changes where the
// goods are, not how many there are, so the company total must come out
// the same on both sides of it.
//
// Both balance rows are locked up front, in location-id order, BEFORE
// either is written. That single ordering rule is what makes A->B and a
// simultaneous B->A safe: they queue rather than each holding the row the
// other needs.
async function transferStock(client, userId, opts) {
  const { productId, fromLocationId, toLocationId, quantity, transferId, reason, notes } = opts;

  if (fromLocationId === toLocationId) {
    const e = new Error('Source and destination must be different locations.');
    e.status = 400; e.expose = true; throw e;
  }
  const qty = round3(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) {
    const e = new Error('Transfer quantity must be a number greater than zero.');
    e.status = 400; e.expose = true; throw e;
  }

  // Both ends must belong to this tenant. resolveLocation throws otherwise.
  const from = await resolveLocation(client, userId, fromLocationId);
  const to = await resolveLocation(client, userId, toLocationId);

  const { rows } = await client.query(
    'SELECT stock, unit, name FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [productId, userId]);
  if (!rows.length) {
    const e = new Error('Product not found.'); e.status = 404; e.expose = true; throw e;
  }
  if (rows[0].stock === null) {
    const e = new Error('This product is not stock-tracked. Record an opening balance first.');
    e.status = 400; e.expose = true; throw e;
  }

  const locked = await lockBalances(client, userId, productId, [from, to]);
  const available = locked.get(from) || 0;
  if (round3(available - qty) < 0) {
    throw insufficientStock(rows[0].name, available, qty, rows[0].unit);
  }

  // Both halves reuse the same engine, with the locks already held so it
  // does not re-take them in a different order.
  const shared = {
    locationLocked: true, lockedBalances: locked,
    transferId, reason, notes, unit: rows[0].unit
  };
  await applyStockDelta(client, userId, productId, -qty, {
    ...shared, type: 'TRANSFER_OUT', locationId: from, toLocationId: to,
    sourceType: 'transfer', sourceId: transferId
  });
  await applyStockDelta(client, userId, productId, qty, {
    ...shared, type: 'TRANSFER_IN', locationId: to, toLocationId: from,
    sourceType: 'transfer', sourceId: transferId
  });

  return {
    product_id: productId,
    from_location_id: from, to_location_id: to,
    from_quantity: locked.get(from), to_quantity: locked.get(to),
    quantity: qty
  };
}

// The signed value of a movement, for SQL that has to re-sum the ledger.
// Kept here as one string so the reconciliation report and any future
// caller cannot disagree about the sign convention.
const SIGNED_QTY_SQL =
  "CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END";

// stock = 0                          -> OUT_OF_STOCK
// 0 < stock <= reorder_level         -> LOW_STOCK
// otherwise                          -> IN_STOCK
//
// A product with no reorder_level can never be LOW_STOCK, which is not
// the same as having a reorder level of 0. Written once, in SQL, so the
// summary list and the low/out reports cannot classify differently.
const STOCK_STATUS_SQL = `
  CASE
    WHEN p.stock IS NULL THEN 'NOT_TRACKED'
    WHEN p.stock <= 0 THEN 'OUT_OF_STOCK'
    WHEN p.reorder_level IS NOT NULL AND p.stock <= p.reorder_level THEN 'LOW_STOCK'
    ELSE 'IN_STOCK'
  END`;

module.exports = {
  applyStockDelta,
  transferStock,
  defaultLocationId,
  resolveLocation,
  lockBalances,
  insufficientStock,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_SET,
  MANUAL_MOVEMENT_DIRECTION,
  SIGNED_QTY_SQL,
  STOCK_STATUS_SQL,
  round3
};
