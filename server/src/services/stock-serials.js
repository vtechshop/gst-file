// Serial number inventory — the single place a unit changes hands or
// changes state.
//
// services/stock-ledger.js owns HOW MANY of a product exist. This owns
// WHICH ones, and where each is in its life. They are two accounts of the
// same goods and must agree, so every function here is called from inside
// the caller's transaction, alongside the quantity movement it belongs
// to — never in one of its own. A serial that became SOLD in a committed
// transaction of its own, while the invoice that sold it rolled back,
// would be a unit sold by nothing.
//
// The identity rule this file is built around: a serial is owned by a
// DOCUMENT HEADER (source_type + source_id), never by a document LINE.
// routes/invoices.js and routes/purchases.js DELETE and re-INSERT every
// line on save, so invoice_items.id and purchase_items.id are different
// after each edit. services/warranty-sync.js learned that the hard way and
// had to match lines by product instead; nothing here repeats it.
// purchase_order_items.id is the one line id that IS stable — those rows
// are updated in place — so it alone may be referenced.
const { randomUUID } = require('crypto');

// ── Lifecycle ─────────────────────────────────────────────────────────
//
// A unit arrives AVAILABLE, is sold, and comes back RETURNED rather than
// straight to AVAILABLE: goods that have been out of the building are not
// sellable again until somebody has looked at them. Inspection is the step
// that decides, and it is a person's decision, not an automatic one.
//
// SCRAPPED is terminal. A scrapped unit does not come back, cannot be
// sold, moved or repaired, and there is no transition out of it — which is
// the point of recording it.
const SERIAL_STATUSES = ['AVAILABLE', 'SOLD', 'RETURNED', 'RETURNED_TO_SUPPLIER', 'DAMAGED', 'SCRAPPED'];

const SERIAL_TRANSITIONS = {
  AVAILABLE: ['SOLD', 'DAMAGED', 'RETURNED_TO_SUPPLIER'],
  SOLD: ['RETURNED', 'AVAILABLE'],      // AVAILABLE only by reversing the sale
  RETURNED: ['AVAILABLE', 'DAMAGED'],   // the inspection decision
  DAMAGED: ['SCRAPPED', 'AVAILABLE', 'RETURNED_TO_SUPPLIER'],
  // Gone back to the supplier. Not stock, not sellable, not movable. The
  // only way out is reversing the purchase return that sent it, which the
  // return's own code does - never a hand-set status.
  RETURNED_TO_SUPPLIER: [],
  SCRAPPED: []
};

// Which states a unit is physically in stock in. AVAILABLE is the only one
// that can be sold; RETURNED and DAMAGED are held but not sellable.
const SELLABLE_STATUS = 'AVAILABLE';

function bad(message, status, code) {
  const e = new Error(message);
  e.status = status || 400; e.expose = true;
  if (code) e.code = code;
  return e;
}

// ── The serial as text ────────────────────────────────────────────────
//
// Stored exactly as typed, compared case- and space-insensitively. "00123"
// keeps its leading zeros because they are part of the identifier, and
// normalising the stored value would quietly hand back a different serial
// from the one on the box.
function normaliseSerial(raw) {
  return String(raw == null ? '' : raw).trim();
}
function serialKey(raw) {
  return normaliseSerial(raw).toUpperCase();
}

// The serials a caller sent for one line, cleaned and checked as a set.
// Blank entries are refused rather than dropped: a blank in a list of six
// means the person entering them missed one, and silently accepting five
// would create stock with a unit missing.
function readSerialList(raw, { where }) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Map();
  for (const entry of list) {
    const value = normaliseSerial(entry);
    if (!value) throw bad(`${where} has a blank serial number.`);
    const key = value.toUpperCase();
    if (seen.has(key)) {
      throw bad(`${where} lists serial "${value}" more than once.`, 409);
    }
    seen.set(key, value);
    out.push(value);
  }
  return out;
}

// ── Which products need serials ───────────────────────────────────────
async function serialTrackedProducts(client, userId, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const { rows } = await client.query(
    `SELECT id FROM products WHERE user_id = $1 AND id = ANY($2) AND serial_tracking`,
    [userId, ids]);
  return new Set(rows.map(r => r.id));
}

// ── Locking ───────────────────────────────────────────────────────────
//
// Serial rows are locked by id in sorted order, the same convention
// lockBalances() uses for balances, so two transactions touching an
// overlapping set of units queue instead of deadlocking against each other.
async function lockSerials(client, userId, serialIds) {
  const ids = [...new Set(serialIds.filter(Boolean))].sort();
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `SELECT * FROM stock_serials
      WHERE user_id = $1 AND id = ANY($2)
      ORDER BY id FOR UPDATE`, [userId, ids]);
  return new Map(rows.map(r => [r.id, r]));
}

// Locks by serial TEXT, for the paths that are given numbers rather than
// ids. Same sorted order, on the same rows.
async function lockSerialsByText(client, userId, serials) {
  const keys = [...new Set(serials.map(serialKey))].sort();
  if (!keys.length) return new Map();
  const { rows } = await client.query(
    `SELECT * FROM stock_serials
      WHERE user_id = $1 AND upper(btrim(serial_no)) = ANY($2)
      ORDER BY upper(btrim(serial_no)) FOR UPDATE`, [userId, keys]);
  return new Map(rows.map(r => [serialKey(r.serial_no), r]));
}

// ── Receiving units in ────────────────────────────────────────────────
//
// Creates one row per serial, AVAILABLE at the receiving location, owned by
// the document header that brought them in.
//
// A serial that already exists in this tenant is refused by name rather
// than by constraint violation, so the person entering six numbers is told
// which one is the duplicate. The unique index still stands behind that:
// two requests racing on the same number cannot both get past it, and the
// loser is reported as a duplicate rather than a crash.
async function receiveSerials(client, userId, {
  productId, serials, locationId, sourceType, sourceId,
  purchaseOrderItemId = null, createdBy = null
}) {
  if (!serials.length) return [];

  const existing = await lockSerialsByText(client, userId, serials);
  for (const value of serials) {
    const row = existing.get(serialKey(value));
    if (row) {
      throw bad(
        `Serial "${value}" already exists in your inventory` +
        (row.status === 'SCRAPPED' ? ' and has been scrapped.' : ` (${row.status.toLowerCase()}).`),
        409, 'serial_exists');
    }
  }

  const created = [];
  for (const value of serials) {
    try {
      const { rows } = await client.query(
        `INSERT INTO stock_serials
           (user_id, product_id, serial_no, status, location_id,
            source_type, source_id, purchase_order_item_id, created_by)
         VALUES ($1,$2,$3,'AVAILABLE',$4,$5,$6,$7,$8) RETURNING *`,
        [userId, productId, value, locationId || null,
          sourceType || null, sourceId || null, purchaseOrderItemId, createdBy]);
      created.push(rows[0]);
    } catch (err) {
      // Lost a race against another request creating the same number.
      if (err && err.code === '23505') {
        throw bad(`Serial "${value}" already exists in your inventory.`, 409, 'serial_exists');
      }
      throw err;
    }
  }
  return created;
}

// ── Releasing units that were received in error ───────────────────────
//
// The counterpart of receiveSerials: a purchase deleted, or a serial
// removed from one on edit, must take its units away with it. A unit that
// has since been SOLD is not the purchase's to remove any more, so it is
// refused rather than quietly deleted out from under an invoice.
async function releaseReceivedSerials(client, userId, serialRows) {
  for (const row of serialRows) {
    if (row.status !== 'AVAILABLE') {
      throw bad(
        `Serial "${row.serial_no}" is ${row.status.toLowerCase()} and cannot be removed from this purchase.`,
        409, 'serial_in_use');
    }
  }
  const ids = serialRows.map(r => r.id);
  if (!ids.length) return 0;
  // Movements keep their history: serial_id is ON DELETE SET NULL, so the
  // ledger still shows what happened even though the unit is gone.
  const { rowCount } = await client.query(
    'DELETE FROM stock_serials WHERE user_id = $1 AND id = ANY($2)', [userId, ids]);
  return rowCount;
}

// ── Selling ───────────────────────────────────────────────────────────
//
// Takes serial TEXT because that is what a scanner and a picker produce,
// resolves each to a locked row, and checks every reason a unit might not
// be sellable before changing any of them.
async function sellSerials(client, userId, {
  productId, serials, sourceType, sourceId, locationId = null
}) {
  if (!serials.length) return [];
  const found = await lockSerialsByText(client, userId, serials);
  const rows = [];

  for (const value of serials) {
    const row = found.get(serialKey(value));
    // Not this tenant's, or not a serial at all — one answer for both, so
    // the endpoint never reveals that another tenant holds it.
    if (!row) throw bad(`Serial "${value}" was not found in your inventory.`, 404, 'serial_not_found');
    if (row.product_id !== productId) {
      throw bad(`Serial "${value}" belongs to a different product.`, 409, 'serial_wrong_product');
    }
    if (row.status !== SELLABLE_STATUS) {
      throw bad(
        `Serial "${value}" is ${row.status.toLowerCase()} and cannot be sold.`,
        409, 'serial_not_available');
    }
    if (locationId && row.location_id && row.location_id !== locationId) {
      throw bad(`Serial "${value}" is held at another location.`, 409, 'serial_wrong_location');
    }
    rows.push(row);
  }

  for (const row of rows) {
    await client.query(
      `UPDATE stock_serials
          SET status = 'SOLD', sold_source_type = $1, sold_source_id = $2,
              location_id = NULL, updated_at = NOW()
        WHERE id = $3 AND user_id = $4`,
      [sourceType || null, sourceId || null, row.id, userId]);
  }
  return rows;
}

// Un-sells exactly the units a document sold: an invoice deleted, or a
// serial dropped from one on edit. The unit goes back where it was sold
// from, which is the location the reversing quantity movement credits.
async function unsellSerials(client, userId, serialRows, { locationId = null } = {}) {
  for (const row of serialRows) {
    // Only a unit still SOLD by this document is given back. One already
    // RETURNED through a sales return has moved on and is not this
    // reversal's to touch.
    if (row.status !== 'SOLD') continue;
    await client.query(
      `UPDATE stock_serials
          SET status = 'AVAILABLE', sold_source_type = NULL, sold_source_id = NULL,
              location_id = COALESCE($1, location_id), updated_at = NOW()
        WHERE id = $2 AND user_id = $3`,
      [locationId, row.id, userId]);
  }
  return serialRows.length;
}

// ── Everything a document currently owns ──────────────────────────────
const serialsReceivedBy = async (client, userId, sourceType, sourceId) => (await client.query(
  `SELECT * FROM stock_serials
    WHERE user_id = $1 AND source_type = $2 AND source_id = $3
    ORDER BY upper(btrim(serial_no)) FOR UPDATE`, [userId, sourceType, sourceId])).rows;

const serialsSoldBy = async (client, userId, sourceType, sourceId) => (await client.query(
  `SELECT * FROM stock_serials
    WHERE user_id = $1 AND sold_source_type = $2 AND sold_source_id = $3
    ORDER BY upper(btrim(serial_no)) FOR UPDATE`, [userId, sourceType, sourceId])).rows;

// ── State changes a person makes ──────────────────────────────────────
//
// Inspection, damage, scrap and repair all come through here so the
// allowed-transition table is the only thing that decides what is legal.
async function transitionSerial(client, userId, serialId, nextStatus, { reason = null } = {}) {
  if (!SERIAL_STATUSES.includes(nextStatus)) {
    throw bad(`status must be one of ${SERIAL_STATUSES.join(', ')}.`);
  }
  const locked = await lockSerials(client, userId, [serialId]);
  const row = locked.get(serialId);
  if (!row) throw bad('Serial not found.', 404);

  const allowed = SERIAL_TRANSITIONS[row.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw bad(
      row.status === 'SCRAPPED'
        ? `Serial "${row.serial_no}" has been scrapped and cannot change state again.`
        : `A ${row.status.toLowerCase()} serial cannot become ${nextStatus.toLowerCase()}.`,
      409, 'serial_bad_transition');
  }
  // Selling and un-selling belong to the documents that do them, so they
  // carry a source and are not reachable from here.
  if (nextStatus === 'SOLD') {
    throw bad('A serial is sold by raising an invoice for it, not by setting its state.', 409);
  }
  if (row.status === 'SOLD' && nextStatus === 'AVAILABLE') {
    throw bad('A sold serial returns to stock through a sales return, not by setting its state.', 409);
  }

  const { rows } = await client.query(
    `UPDATE stock_serials SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
      WHERE id = $3 AND user_id = $4 RETURNING *`,
    [nextStatus, reason, serialId, userId]);
  return { before: row, after: rows[0] };
}

// ── Returning ─────────────────────────────────────────────────────────
//
// A sales return puts the unit back in the building but NOT back on the
// shelf. RETURNED is deliberately not sellable: somebody has to look at it
// first, and that decision is transitionSerial's to record.
async function returnSerials(client, userId, serialRows, { locationId = null, sourceType = null, sourceId = null } = {}) {
  for (const row of serialRows) {
    if (row.status !== 'SOLD') {
      throw bad(`Serial "${row.serial_no}" is ${row.status.toLowerCase()} and was not sold, so it cannot be returned.`,
        409, 'serial_not_sold');
    }
    await client.query(
      `UPDATE stock_serials
          SET status = 'RETURNED', location_id = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3`,
      [locationId, row.id, userId]);
    void sourceType; void sourceId;
  }
  return serialRows.length;
}

// ── Sending units back to the supplier ────────────────────────────────
//
// The unit leaves our inventory. Not sold, not scrapped, not awaiting
// inspection — returned to where it was bought, which is a different fact
// from all three and needs its own state to stay answerable.
//
// Takes serial TEXT, because a purchase return is typed or scanned from
// the goods being sent back. Every reason a unit might not be returnable
// is checked before any of them changes.
async function returnSerialsToSupplier(client, userId, {
  productId, serials, sourceType, sourceId, purchaseId = null
}) {
  if (!serials.length) return [];
  const found = await lockSerialsByText(client, userId, serials);
  const rows = [];

  for (const value of serials) {
    const row = found.get(serialKey(value));
    // Not ours, or not a serial at all: one answer for both.
    if (!row) throw bad(`Serial "${value}" was not found in your inventory.`, 404, 'serial_not_found');
    if (row.product_id !== productId) {
      throw bad(`Serial "${value}" belongs to a different product.`, 409, 'serial_wrong_product');
    }
    if (row.status === 'RETURNED_TO_SUPPLIER') {
      throw bad(`Serial "${value}" has already been returned to the supplier.`, 409, 'serial_already_returned');
    }
    // A unit we no longer hold cannot be sent back. SOLD is a customer's;
    // RETURNED is awaiting inspection and belongs to the customer return
    // that produced it; SCRAPPED no longer exists.
    if (!['AVAILABLE', 'DAMAGED'].includes(row.status)) {
      throw bad(
        `Serial "${value}" is ${row.status.toLowerCase().replace(/_/g, ' ')} and cannot be returned to the supplier.`,
        409, 'serial_not_returnable');
    }
    // Only units this purchase actually brought in may go back on its
    // return. Matching by product alone would let a return send back a
    // unit from a different delivery.
    if (purchaseId && row.source_id && row.source_id !== purchaseId) {
      throw bad(`Serial "${value}" did not come from the purchase being returned.`,
        409, 'serial_wrong_purchase');
    }
    rows.push(row);
  }

  for (const row of rows) {
    await client.query(
      `UPDATE stock_serials
          SET status = 'RETURNED_TO_SUPPLIER', supplier_return_type = $1,
              supplier_return_id = $2, location_id = NULL, updated_at = NOW()
        WHERE id = $3 AND user_id = $4`,
      [sourceType || null, sourceId || null, row.id, userId]);
  }
  return rows;
}

// Undoing that: a purchase return edited or deleted gives its units back
// to the shelf they left. Only units still marked as returned by THIS
// document are touched.
async function unreturnSupplierSerials(client, userId, serialRows, { locationId = null } = {}) {
  for (const row of serialRows) {
    if (row.status !== 'RETURNED_TO_SUPPLIER') continue;
    await client.query(
      `UPDATE stock_serials
          SET status = 'AVAILABLE', supplier_return_type = NULL, supplier_return_id = NULL,
              location_id = COALESCE($1, location_id), updated_at = NOW()
        WHERE id = $2 AND user_id = $3`,
      [locationId, row.id, userId]);
  }
  return serialRows.length;
}

const serialsReturnedToSupplierBy = async (client, userId, sourceType, sourceId) => (await client.query(
  `SELECT * FROM stock_serials
    WHERE user_id = $1 AND supplier_return_type = $2 AND supplier_return_id = $3
    ORDER BY upper(btrim(serial_no)) FOR UPDATE`, [userId, sourceType, sourceId])).rows;

// ── Moving between locations ──────────────────────────────────────────
//
// Only a unit that is actually held somewhere can move, and only from
// where it actually is. A SOLD unit has left the building and a SCRAPPED
// one no longer exists, so neither has a location to move from.
async function transferSerial(client, userId, serialId, { fromLocationId, toLocationId }) {
  const locked = await lockSerials(client, userId, [serialId]);
  const row = locked.get(serialId);
  if (!row) throw bad('Serial not found.', 404);
  if (!['AVAILABLE', 'RETURNED', 'DAMAGED'].includes(row.status)) {
    throw bad(`A ${row.status.toLowerCase()} serial cannot be moved.`, 409, 'serial_not_movable');
  }
  if (fromLocationId && row.location_id && row.location_id !== fromLocationId) {
    throw bad(`Serial "${row.serial_no}" is not held at that location.`, 409, 'serial_wrong_location');
  }
  const { rows } = await client.query(
    `UPDATE stock_serials SET location_id = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 RETURNING *`,
    [toLocationId, serialId, userId]);
  return rows[0];
}

// ── Reconciliation ────────────────────────────────────────────────────
//
// For a serialised product the two accounts must agree: the quantity
// balance at a location and the number of units held there. Reported, never
// corrected — a mismatch means something happened that neither account
// explains, and silently adjusting one to match the other would destroy the
// evidence of it.
//
// Only AVAILABLE and RETURNED units are counted as held: SOLD has left,
// SCRAPPED is gone, and DAMAGED is counted because the goods are still on
// the premises and still in the quantity balance until they are scrapped.
async function reconcileSerials(client, userId, { productId = null } = {}) {
  const params = [userId];
  let filter = '';
  // Filters the `tracked` CTE below, where the table carries no alias.
  if (productId) { params.push(productId); filter = ' AND id = $2'; }
  // The two accounts are aggregated SEPARATELY and then matched up.
  // Joining balances to serials directly multiplies one against the other:
  // three units at a location joined to that location's single balance row
  // counts the balance three times, and the report would disagree with
  // itself while nothing was actually wrong.
  const { rows } = await client.query(
    `WITH tracked AS (
       SELECT id, name FROM products
        WHERE user_id = $1 AND serial_tracking${filter}
     ),
     bal AS (
       SELECT b.product_id, b.location_id, SUM(b.quantity)::float AS quantity
         FROM stock_balances b JOIN tracked t ON t.id = b.product_id
        WHERE b.user_id = $1
        GROUP BY b.product_id, b.location_id
     ),
     held AS (
       -- AVAILABLE and RETURNED are on the shelf and in the balance.
       -- SOLD has left, SCRAPPED is gone, and DAMAGED is still physically
       -- present, so it is counted too.
       SELECT s.product_id, s.location_id, COUNT(*)::int AS units
         FROM stock_serials s JOIN tracked t ON t.id = s.product_id
        WHERE s.user_id = $1 AND s.status IN ('AVAILABLE','RETURNED','DAMAGED')
        GROUP BY s.product_id, s.location_id
     ),
     -- Every (product, location) either account mentions, listed once.
     -- A FULL JOIN would have been the obvious shape, but Postgres cannot
     -- FULL JOIN on IS NOT DISTINCT FROM, and a location_id of NULL is a
     -- real case here - a unit that has no shelf yet still has to appear.
     keys AS (
       SELECT product_id, location_id FROM bal
       UNION
       SELECT product_id, location_id FROM held
     )
     SELECT k.product_id, t.name AS product_name, k.location_id,
            COALESCE(b.quantity, 0)::float AS balance_quantity,
            COALESCE(h.units, 0)::int AS held_serials
       FROM keys k
       JOIN tracked t ON t.id = k.product_id
       LEFT JOIN bal b ON b.product_id = k.product_id
             AND b.location_id IS NOT DISTINCT FROM k.location_id
       LEFT JOIN held h ON h.product_id = k.product_id
             AND h.location_id IS NOT DISTINCT FROM k.location_id`, params);
  return rows
    .map(r => ({ ...r, balanced: Number(r.balance_quantity) === Number(r.held_serials) }))
    .filter(r => Number(r.balance_quantity) !== 0 || r.held_serials !== 0);
}

module.exports = {
  SERIAL_STATUSES,
  SERIAL_TRANSITIONS,
  normaliseSerial,
  serialKey,
  readSerialList,
  serialTrackedProducts,
  lockSerials,
  lockSerialsByText,
  receiveSerials,
  releaseReceivedSerials,
  sellSerials,
  unsellSerials,
  serialsReceivedBy,
  serialsSoldBy,
  transitionSerial,
  returnSerials,
  returnSerialsToSupplier,
  unreturnSupplierSerials,
  serialsReturnedToSupplierBy,
  transferSerial,
  reconcileSerials,
  randomUUID
};
