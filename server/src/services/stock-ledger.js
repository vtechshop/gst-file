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
  'DAMAGE', 'SCRAP', 'CONSUMPTION', 'SAMPLE', 'FREE_ISSUE'
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

  const { rows } = await client.query(
    'SELECT stock, unit, name FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [productId, userId]
  );
  // Not this tenant's product, or not stock-tracked. Either way there is
  // nothing to move and nothing to record.
  if (!rows.length || rows[0].stock === null) return null;

  const current = +rows[0].stock;
  const next = round3(current + deltaQty);

  // Negative stock is blocked. The rejection throws, which rolls the
  // caller's transaction back - so the document does not half-save and
  // no SALE movement is left behind claiming stock that never left.
  if (next < 0) {
    throw insufficientStock(rows[0].name, current, -deltaQty, movement.unit || rows[0].unit);
  }

  await client.query('UPDATE products SET stock = $1 WHERE id = $2', [next, productId]);

  await client.query(
    `INSERT INTO stock_movements
       (user_id, product_id, movement_type, direction, quantity, unit, rate,
        balance_after, source_type, source_id, source_item_id, reason, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$1)`,
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
      movement.notes || null
    ]
  );

  return next;
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
  insufficientStock,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_SET,
  MANUAL_MOVEMENT_DIRECTION,
  SIGNED_QTY_SQL,
  STOCK_STATUS_SQL,
  round3
};
