// Bespoke transactional endpoints for the Purchase Module — mirrors
// server/routes/invoices.js exactly (same header+items+stock-in-one-
// transaction shape, same permanent-delete cascade shape), generalized
// over `kind` ('purchase' | 'return') instead of hardcoding one
// header/items table pair, since Purchase Entry and Purchase Returns
// are two genuinely separate table pairs (not one shared-with-
// discriminator table the way b2b_invoices/b2c_invoices share
// invoice_items).
//
// Stock direction is the one real difference between the two kinds: a
// purchase increases stock, a return decreases it — both expressed as
// the sign passed to applyStockDelta() (imported from invoices.js, not
// reimplemented — same row-locked SELECT...FOR UPDATE race-safety).
//
// Frontend call site: js/purchase-items.js's savePurchaseWithItems() /
// cascadePurchaseItemsDelete().
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { TABLES } = require('./generic');
const { applyStockDelta } = require('./invoices');
// Reversing a receipt is the purchase order's own rule, so it lives with
// the rest of them rather than being restated here. receiptStatus and
// round3 come from the same place for the same reason: an edit that
// reconciles an order must land on the status the order's own code would
// have chosen, and compare quantities the way it compares them.
const { reversePurchaseOrderReceipt, receiptStatus, round3 } = require('./purchase-orders');
// Serials are the other account of the same goods, so they move in the
// same transaction as the quantity and the rows that explain it.
const serialsSvc = require('../services/stock-serials');
// The same default location the quantity movement uses, so units and
// counts land on one shelf rather than two.
const { defaultLocationId } = require('../services/stock-ledger');

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
  purchase: { headerTable: 'purchases', itemsTable: 'purchase_items', itemFk: 'purchase_id', stockSign: 1,
              movementType: 'PURCHASE', sourceType: 'purchase' },
  return:   { headerTable: 'purchase_returns', itemsTable: 'purchase_return_items', itemFk: 'return_id', stockSign: -1,
              movementType: 'PURCHASE_RETURN', sourceType: 'purchase_return' }
};

function badKind(kind) {
  if (!KIND_CONFIG[kind]) { const e = new Error('kind must be purchase or return.'); e.status = 400; e.expose = true; throw e; }
}

function bad(message, status) {
  const e = new Error(message); e.status = status || 400; e.expose = true; return e;
}
// Two free-text lines both carrying no product are the same product for
// this purpose, which `=` in SQL and `===` on null would each get wrong in
// opposite directions.
const sameProduct = (a, b) => (a == null && b == null) || String(a) === String(b);

// ── The serial side of a purchase ─────────────────────────────────────
//
// A serialised product is received by NAME, not by count: six units means
// six numbers. The count check is the whole enforcement — quantity stock
// and serial stock are two accounts of one delivery, and letting them
// disagree at the moment goods arrive is how they stay wrong forever.
//
// Which serials a purchase owns is read from the PURCHASE HEADER, never
// from its line rows, because those are deleted and re-inserted on every
// save. On an edit the payload states what the purchase now holds and the
// database states what it held before, so what to release is the
// difference between two explicit lists — not a guess about which unit the
// user meant to drop.
async function planPurchaseSerials(client, userId, kind, purchaseId, items) {
  const productIds = items.map(i => i.product_id).filter(Boolean);
  const tracked = await serialsSvc.serialTrackedProducts(client, userId, productIds);
  if (!tracked.size) return null;

  const wanted = [];               // { productId, serials[], poItemId }
  for (const [index, item] of items.entries()) {
    if (!item.product_id || !tracked.has(item.product_id)) continue;
    const where = `Line ${index + 1} ("${item.product_name || 'product'}")`;
    const serials = serialsSvc.readSerialList(item.serials, { where });
    const quantity = round3(Number(item.quantity) || 0);
    if (serials.length !== quantity) {
      const verb = kind === 'purchase' ? 'received' : 'returned';
      throw bad(
        `${where} is serial-tracked: ${quantity} ${verb} needs exactly ${quantity} serial `
        + `number${quantity === 1 ? '' : 's'}, but ${serials.length} `
        + `${serials.length === 1 ? 'was' : 'were'} given.`, 409);
    }
    wanted.push({ productId: item.product_id, serials, poItemId: item.purchase_order_item_id || null });
  }

  // One number may only appear once across the whole document, or two
  // lines would each claim the same unit.
  const seen = new Map();
  for (const line of wanted) {
    for (const value of line.serials) {
      const key = serialsSvc.serialKey(value);
      if (seen.has(key)) throw bad(`Serial "${value}" is listed on more than one line.`, 409);
      seen.set(key, line.productId);
    }
  }
  return { wanted, keys: seen };
}

// A purchase RETURN sends units back to the supplier. Reconciled the same
// way a purchase is — the payload says which units the return now covers,
// the database says which it covered before, and the difference is what
// changes — so an edited return gives back exactly the unit it dropped.
async function applySupplierReturnSerials(client, userId, returnId, plan, { locationId, originalPurchaseId }) {
  const already = await serialsSvc.serialsReturnedToSupplierBy(client, userId, 'purchase_return', returnId);
  const byKey = new Map(already.map(r => [serialsSvc.serialKey(r.serial_no), r]));

  if (!plan) {
    if (already.length) await serialsSvc.unreturnSupplierSerials(client, userId, already, { locationId });
    return { returned: [], restored: already };
  }

  // Dropped from the return: back on the shelf they left.
  const dropped = already.filter(r => !plan.keys.has(serialsSvc.serialKey(r.serial_no)));
  if (dropped.length) await serialsSvc.unreturnSupplierSerials(client, userId, dropped, { locationId });

  const returned = [];
  for (const line of plan.wanted) {
    const fresh = line.serials.filter(v => !byKey.has(serialsSvc.serialKey(v)));
    if (!fresh.length) continue;
    const rows = await serialsSvc.returnSerialsToSupplier(client, userId, {
      productId: line.productId, serials: fresh,
      sourceType: 'purchase_return', sourceId: returnId,
      purchaseId: originalPurchaseId || null
    });
    returned.push(...rows);
  }
  return { returned, restored: dropped };
}

async function applyPurchaseSerials(client, userId, purchaseId, plan, { locationId, createdBy }) {
  if (!plan) {
    // Nothing serialised on the document NOW — but it may have been before
    // this edit, and those units must still be given back.
    const held = await serialsSvc.serialsReceivedBy(client, userId, 'purchase', purchaseId);
    if (held.length) await serialsSvc.releaseReceivedSerials(client, userId, held);
    return { created: [], released: held };
  }

  const held = await serialsSvc.serialsReceivedBy(client, userId, 'purchase', purchaseId);
  const heldByKey = new Map(held.map(r => [serialsSvc.serialKey(r.serial_no), r]));

  // Gone from the payload: released, exactly those and no others.
  const dropped = held.filter(r => !plan.keys.has(serialsSvc.serialKey(r.serial_no)));
  if (dropped.length) await serialsSvc.releaseReceivedSerials(client, userId, dropped);

  const created = [];
  for (const line of plan.wanted) {
    const fresh = line.serials.filter(v => !heldByKey.has(serialsSvc.serialKey(v)));
    if (fresh.length) {
      const rows = await serialsSvc.receiveSerials(client, userId, {
        productId: line.productId, serials: fresh, locationId,
        sourceType: 'purchase', sourceId: purchaseId,
        purchaseOrderItemId: line.poItemId, createdBy
      });
      created.push(...rows);
    }
    // A serial kept across the edit may have moved to a different line of
    // the same document; its PO line link is refreshed so the two agree.
    for (const value of line.serials) {
      const existing = heldByKey.get(serialsSvc.serialKey(value));
      if (!existing) continue;
      if (existing.product_id !== line.productId) {
        throw bad(`Serial "${value}" already belongs to a different product on this purchase.`, 409);
      }
      if ((existing.purchase_order_item_id || null) !== (line.poItemId || null)) {
        await client.query(
          `UPDATE stock_serials SET purchase_order_item_id = $1, updated_at = NOW()
            WHERE id = $2 AND user_id = $3`, [line.poItemId, existing.id, userId]);
      }
    }
  }
  return { created, released: dropped };
}

// ── One movement per unit, for serialised goods ───────────────────────
//
// A counted product nets its whole change into a single movement: five
// bought is one row of five. A serialised product cannot do that and still
// say which unit moved — one row of five can name only one serial — so
// each unit gets its own movement of one, carrying its own serial_id.
//
// The quantity arithmetic is identical either way: three movements of one
// come to the same balance as one movement of three. What changes is that
// a unit's history becomes a query over the ledger, which is why there is
// no second history table.
//
// Uses the SAME applyStockDelta as everything else. No second stock engine.
// `nameUnit: false` for units that no longer exist. A serial dropped from
// a purchase is DELETED — it was received in error and there is nothing
// left to point at — so its reversing movement carries no serial_id. The
// quantity still comes back; only the name is gone, which is the truth.
async function movePerUnit(client, userId, rows, sign, movement, { nameUnit = true } = {}) {
  for (const row of rows) {
    await applyStockDelta(client, userId, row.product_id, sign, {
      ...movement,
      locationId: movement.locationId || row.location_id || null,
      serialId: nameUnit ? row.id : null
    });
  }
}

// ── The order's side of a purchase edit ───────────────────────────────
//
// A purchase raised against an order is a receipt against particular LINES
// of it, and the order — not the purchase — is the authority on how much
// each line ordered. So an edit is never measured against itself. The
// question is not "how much does this purchase now claim" but "how much is
// this order line still free to receive once everything OTHER than this
// purchase is counted", which is what lets a purchase of 3 be edited up to
// 6 on a line of 10 that another purchase already filled 4 of, and refuses
// 7.
//
// Nothing is written here. The plan is built and every line is checked
// before the first row of the save is touched, so a rejected edit leaves
// the purchase, the order and the stock exactly as they were.
async function planOrderReconciliation(client, userId, orderId, oldItems, newItems) {
  const claimsLine = newItems.filter(
    i => i.purchase_order_item_id != null && i.purchase_order_item_id !== '');

  if (!orderId) {
    // An ordinary purchase has no order line to receive against. A link
    // arriving on one is either a mistake or an attempt to write a
    // relationship that no order would agree to, and both are refused
    // rather than quietly dropped.
    if (claimsLine.length) {
      throw bad('This purchase is not raised against a purchase order, so its lines cannot name one.');
    }
    return null;
  }

  // The same lock order the receive and reversal paths use: the order
  // first, then its lines by id. A receipt, a reversal and an edit on one
  // order therefore queue behind each other instead of interleaving, and
  // two edits cannot both measure the same remaining capacity and both fit
  // inside it.
  const { rows: orderRows } = await client.query(
    'SELECT id, status FROM purchase_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [orderId, userId]);
  // Scoped by user_id, so another tenant's order is not found rather than
  // refused — the same answer they get everywhere else.
  if (!orderRows.length) throw bad('Purchase order not found.', 404);

  const { rows: lines } = await client.query(
    `SELECT id, product_id, product_name, quantity, received_quantity
       FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2
      ORDER BY id FOR UPDATE`, [orderId, userId]);
  const byId = new Map(lines.map(l => [String(l.id), l]));

  // What this purchase itself currently contributes to each line, taken out
  // of the line's received total before the new quantity is measured. This
  // is the step that stops an edit being checked against its own old
  // figure and counting it twice.
  const mine = new Map();
  for (const it of oldItems) {
    const lineId = it.purchase_order_item_id;
    if (!lineId) continue;
    const k = String(lineId);
    mine.set(k, round3((mine.get(k) || 0) + (Number(it.quantity) || 0)));
  }

  // What it will contribute after the edit. Several lines of one purchase
  // may point at the same order line, so they are summed: checking them one
  // at a time would let a quantity be split in two so that neither half
  // exceeds a capacity their total does.
  const wanted = new Map();
  for (const it of newItems) {
    const lineId = it.purchase_order_item_id;
    if (lineId == null || lineId === '') {
      // The link is how a receipt is unwound exactly. A purchase against an
      // order that no longer says which line it filled is refused rather
      // than matched back by product, which is the guesswork this column
      // exists to end.
      throw bad('Every line of a purchase made against an order must say which order line it received against.');
    }
    const line = byId.get(String(lineId));
    // Not a line of this order, not this tenant's, or not a line at all —
    // one answer for all three, and none of them a reason to go looking for
    // a different line that would fit.
    if (!line) throw bad('That line is not on this purchase order.', 404);
    if (!sameProduct(line.product_id, it.product_id)) {
      throw bad(`"${line.product_name}" on the order does not match the product on that purchase line.`);
    }
    const qty = round3(Number(it.quantity) || 0);
    if (qty < 0) throw bad('A quantity cannot be negative.');
    const k = String(lineId);
    wanted.set(k, round3((wanted.get(k) || 0) + qty));
  }

  const deltas = [];
  for (const [lineId, qty] of wanted) {
    const line = byId.get(lineId);
    const mineNow = mine.get(lineId) || 0;
    // Everything on this line that is NOT this purchase. That is the figure
    // the order's remaining capacity has to be measured against.
    const byOthers = round3(Number(line.received_quantity) - mineNow);
    const room = round3(Number(line.quantity) - byOthers);
    if (qty > room) {
      throw bad(
        `"${line.product_name}" has only ${room} left to receive on that order line, not ${qty}.`, 409);
    }
    deltas.push({ lineId, delta: round3(qty - mineNow) });
  }
  // A line this purchase used to fill and no longer mentions gives its
  // whole share back, or the order would keep claiming goods that this
  // edit just removed.
  for (const [lineId, qty] of mine) {
    if (!wanted.has(lineId)) deltas.push({ lineId, delta: round3(-qty) });
  }

  return { orderId, status: orderRows[0].status, deltas };
}

// The write half, run inside the same transaction as the purchase rows and
// the stock movement. Either all three land or none of them do.
async function applyOrderReconciliation(client, userId, plan) {
  if (!plan) return null;
  for (const { lineId, delta } of plan.deltas) {
    if (!delta) continue;
    // Bounded below at zero for the same reason the reversal is: however a
    // row came to be written, an adjustment must not drive a line negative.
    // The table's own CHECK still refuses received above ordered.
    await client.query(
      `UPDATE purchase_order_items
          SET received_quantity = GREATEST(received_quantity + $1, 0)
        WHERE id = $2 AND user_id = $3 AND purchase_order_id = $4`,
      [delta, lineId, userId, plan.orderId]);
  }
  const { rows: after } = await client.query(
    `SELECT quantity, received_quantity FROM purchase_order_items
      WHERE purchase_order_id = $1 AND user_id = $2`, [plan.orderId, userId]);
  const next = receiptStatus(after, plan.status);
  if (next !== plan.status) {
    await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 AND user_id = $3',
      [next, plan.orderId, userId]);
  }
  return { order_id: plan.orderId, status: next };
}

// ── 1) Save header + line items + stock, one transaction ──
router.post('/:kind/save-with-items', asyncRoute(async (req, res) => {
  badKind(req.params.kind);
  const kind = req.params.kind;
  const { headerTable, itemsTable, itemFk, stockSign, movementType, sourceType } = KIND_CONFIG[kind];
  const { editId, header, items } = req.body;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    const e = new Error('Header is missing or malformed.'); e.status = 400; e.expose = true; throw e;
  }
  if (!Array.isArray(items) || !items.length) {
    const e = new Error('Add at least one product with a quantity and rate.'); e.status = 400; e.expose = true; throw e;
  }
  if (editId) badId(editId);

  const headerCols = TABLES[headerTable].columns.filter(c => c !== 'id' && c !== 'user_id' && header && Object.prototype.hasOwnProperty.call(header, c));
  const itemCols = TABLES[itemsTable].columns.filter(c => !['id','user_id',itemFk,'sort_order','created_at','updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let headerId = editId;
    let oldItems = [];
    // Settled before anything is written, so a purchase that the order
    // refuses leaves the order, the purchase and the stock untouched.
    let orderPlan = null;
    // Same for the serials: counted and checked before the first write.
    const serialPlan = await planPurchaseSerials(client, req.userId, kind, editId, items);

    if (editId) {
      // Locked before it is read. Two edits of one purchase would otherwise
      // both measure the same starting point, and both fit inside the
      // order's remaining capacity that only one of them can have.
      const { rows: locked } = await client.query(
        `SELECT id${kind === 'purchase' ? ', purchase_order_id' : ''} FROM ${headerTable}
          WHERE id = $1 AND user_id = $2 FOR UPDATE`, [editId, req.userId]);
      if (!locked.length) { const e = new Error('Record not found.'); e.status = 404; e.expose = true; throw e; }

      // The link comes back for a purchase so the order below can be
      // reconciled exactly; purchase_return_items has no such column.
      const linkCol = kind === 'purchase' ? ', purchase_order_item_id' : '';
      const { rows: oldRows } = await client.query(
        `SELECT product_id, quantity${linkCol} FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`,
        [editId, req.userId]
      );
      oldItems = oldRows;

      // The order is read from the locked row, never from the request: which
      // order a purchase belongs to is not the browser's to restate.
      if (kind === 'purchase') {
        orderPlan = await planOrderReconciliation(
          client, req.userId, locked[0].purchase_order_id, oldItems, items);
      }

      const values = headerCols.map(c => header[c]);
      const setClause = headerCols.map((c, i) => `${c} = $${i + 1}`).join(',');
      const { rows } = await client.query(
        `UPDATE ${headerTable} SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]
      );
      if (!rows.length) { const e = new Error('Record not found.'); e.status = 404; e.expose = true; throw e; }
      headerId = rows[0].id;
    } else {
      // purchase_order_id is not a column this route can set, so a purchase
      // created here is never against an order. A line claiming one is
      // refused rather than stored as an orphan link.
      if (kind === 'purchase') {
        orderPlan = await planOrderReconciliation(client, req.userId, null, [], items);
      }
      const payload = { ...header, user_id: req.userId };
      const cols = headerCols.concat('user_id');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      const { rows } = await client.query(`INSERT INTO ${headerTable} (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
      headerId = rows[0].id;
    }

    await client.query(`DELETE FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`, [headerId, req.userId]);

    const newQtyByProduct = {};
    const unitByProduct = {};
    const rateByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const payload = { ...items[i], user_id: req.userId, [itemFk]: headerId, sort_order: i };
      const cols = itemCols.concat(['user_id', itemFk, 'sort_order']).filter(c => Object.prototype.hasOwnProperty.call(payload, c));
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      await client.query(`INSERT INTO ${itemsTable} (${cols.join(',')}) VALUES (${placeholders})`, values);
      if (payload.product_id) {
        newQtyByProduct[payload.product_id] = (newQtyByProduct[payload.product_id] || 0) + (+payload.quantity || 0);
        unitByProduct[payload.product_id] = payload.unit;
        rateByProduct[payload.product_id] = payload.rate;
      }
    }

    // The units, before the quantity. Run the other way round, a serial
    // that cannot move fails as "insufficient stock" - true, but it does
    // not tell the person WHICH unit is the problem.
    const serialLocation = serialPlan ? await defaultLocationId(client, req.userId) : null;
    const serialResult = kind === 'purchase'
      ? await applyPurchaseSerials(client, req.userId, headerId, serialPlan,
        { locationId: serialLocation, createdBy: req.userId })
      : await applySupplierReturnSerials(client, req.userId, headerId, serialPlan,
        { locationId: serialLocation, originalPurchaseId: header.original_purchase_id || null });

    // Serialised goods move a unit at a time, so each movement can name the
    // unit it moved. Everything else nets, exactly as before.
    const perUnit = { type: movementType, sourceType, sourceId: headerId };
    if (kind === 'purchase') {
      await movePerUnit(client, req.userId, serialResult.created || [], 1, perUnit);
      await movePerUnit(client, req.userId, serialResult.released || [], -1,
        { ...perUnit, reason: 'Serial removed from the purchase', locationId: serialLocation },
        { nameUnit: false });
    } else {
      await movePerUnit(client, req.userId, serialResult.returned || [], -1,
        { ...perUnit, locationId: serialLocation });
      await movePerUnit(client, req.userId, serialResult.restored || [], 1,
        { ...perUnit, reason: 'Serial removed from the return', locationId: serialLocation });
    }
    // Those products are already accounted for one unit at a time; counting
    // their quantity again here would move the same goods twice.
    const serialProducts = new Set(
      (serialPlan ? serialPlan.wanted.map(l => l.productId) : [])
        .concat([...(serialResult.created || []), ...(serialResult.released || []),
          ...(serialResult.returned || []), ...(serialResult.restored || [])]
          .map(r => r.product_id)));

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
      if (serialProducts.has(pid)) continue;
      // Net change only, same reasoning as the sale: a purchase edited from
      // 10 to 15 writes one +5 movement, and re-saving it unchanged writes
      // nothing at all.
      const delta = (newQtyByProduct[pid] || 0) - (oldQtyByProduct[pid] || 0);
      if (delta) await applyStockDelta(client, req.userId, pid, stockSign * delta, {
        type: movementType, sourceType, sourceId: headerId,
        unit: unitByProduct[pid], rate: rateByProduct[pid]
      });
    }

    // The order's received quantities move in the same transaction as the
    // purchase rows and the stock, so the three can never disagree: a
    // failure anywhere above rolls all of it back.
    const reconciled = await applyOrderReconciliation(client, req.userId, orderPlan);

    // And the serials with them. Planned before anything was written so a
    // miscounted delivery is refused with nothing changed; applied here so
    // the units, the quantity and the document all land together.
    // Units land where the quantity landed. applyStockDelta above put the
    // goods in the tenant's default location, so resolving the same one
    // here keeps the two accounts pointing at the same shelf — a serial
    // with no location could not be transferred or reconciled.
    await client.query('COMMIT');
    res.json({ id: headerId, purchase_order: reconciled, serials: serialResult });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 2) Permanent delete cascade — line items + stock reversal, one
// transaction. The header row's own delete happens separately via the
// generic router's plain (already permanent) DELETE — this only
// touches the downstream line-item rows.
router.post('/:kind/:id/cascade-delete', asyncRoute(async (req, res) => {
  badKind(req.params.kind);
  const { kind, id } = req.params;
  badId(id);
  const { headerTable, itemsTable, itemFk, stockSign, movementType, sourceType } = KIND_CONFIG[kind];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The record being deleted is locked first. Without it two deletions
    // firing together both read the same line items before either removes
    // them, and each reverses the stock - giving back twice what was ever
    // taken. The second now waits, finds the items gone, and reverses
    // nothing.
    const { rows: locked } = await client.query(
      `SELECT id FROM ${headerTable} WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, req.userId]);
    if (!locked.length) { const e = new Error('Record not found.'); e.status = 404; e.expose = true; throw e; }

    // purchase_order_item_id comes back for a purchase so the order-line
    // reversal below is exact. purchase_return_items has no such column, so
    // it is selected only for the kind that has one.
    const linkCol = kind === 'purchase' ? ', purchase_order_item_id' : '';
    const { rows: items } = await client.query(
      `SELECT id, product_id, quantity, unit, rate${linkCol}
         FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`,
      [id, req.userId]
    );
    // The units this document moved, read before anything is reversed so
    // each one can be given its own movement. A serialised product is
    // reversed a unit at a time; everything else nets by line, as before.
    const undoing = kind === 'purchase'
      ? await serialsSvc.serialsReceivedBy(client, req.userId, 'purchase', id)
      : await serialsSvc.serialsReturnedToSupplierBy(client, req.userId, 'purchase_return', id);
    const serialProducts = new Set(undoing.map(r => r.product_id));
    const undoReason = kind === 'purchase' ? 'Purchase deleted' : 'Purchase return deleted';

    // Deleting a saved record un-applies its stock effect — a purchase
    // being deleted must give back the stock it added; a return being
    // deleted must give back the stock it took away. Opposite sign from
    // the original apply, same magnitude.
    for (const it of items) {
      if (serialProducts.has(it.product_id)) continue;   // handled per unit below
      await applyStockDelta(client, req.userId, it.product_id, -stockSign * (+it.quantity || 0), {
        type: movementType, sourceType, sourceId: id, sourceItemId: it.id,
        unit: it.unit, rate: it.rate, reason: undoReason
      });
    }
    await movePerUnit(client, req.userId, undoing, -stockSign, {
      type: movementType, sourceType, sourceId: id, reason: undoReason,
      locationId: kind === 'purchase' ? null : await defaultLocationId(client, req.userId)
    });

    // A purchase raised against an order counted towards what that order
    // had received. Deleting it has to give that back too, in this same
    // transaction - stock reversed but the order still claiming the goods
    // arrived is exactly the inconsistency this guards against. An
    // ordinary purchase has no order and this does nothing.
    let reconciled = null;
    let serialsRemoved = 0;
    if (kind === 'purchase') {
      reconciled = await reversePurchaseOrderReceipt(client, req.userId, id, items);
      // Every unit this purchase brought in goes with it. A serial that has
      // since been sold refuses the deletion rather than vanishing from
      // under the invoice that sold it — better a blocked delete than
      // inventory that never existed.
      if (undoing.length) {
        serialsRemoved = await serialsSvc.releaseReceivedSerials(client, req.userId, undoing);
      }
    } else {
      // Deleting a purchase return un-sends the units: they were never
      // returned, so they go back to the shelf they left. The stock the
      // return took out is given back by the loop above, so the two
      // accounts move together.
      if (undoing.length) {
        serialsRemoved = await serialsSvc.unreturnSupplierSerials(client, req.userId, undoing,
          { locationId: await defaultLocationId(client, req.userId) });
      }
    }

    await client.query(`DELETE FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`, [id, req.userId]);
    await client.query('COMMIT');
    res.json({ ok: true, purchase_order: reconciled, serials_removed: serialsRemoved });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
