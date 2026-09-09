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

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
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

    await client.query('COMMIT');
    res.json({ id: headerId, purchase_order: reconciled });
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
    // Deleting a saved record un-applies its stock effect — a purchase
    // being deleted must give back the stock it added; a return being
    // deleted must give back the stock it took away. Opposite sign from
    // the original apply, same magnitude.
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, -stockSign * (+it.quantity || 0), {
      type: movementType, sourceType, sourceId: id, sourceItemId: it.id,
      unit: it.unit, rate: it.rate, reason: kind === 'purchase' ? 'Purchase deleted' : 'Purchase return deleted'
    });

    // A purchase raised against an order counted towards what that order
    // had received. Deleting it has to give that back too, in this same
    // transaction - stock reversed but the order still claiming the goods
    // arrived is exactly the inconsistency this guards against. An
    // ordinary purchase has no order and this does nothing.
    let reconciled = null;
    if (kind === 'purchase') {
      reconciled = await reversePurchaseOrderReceipt(client, req.userId, id, items);
    }

    await client.query(`DELETE FROM ${itemsTable} WHERE ${itemFk} = $1 AND user_id = $2`, [id, req.userId]);
    await client.query('COMMIT');
    res.json({ ok: true, purchase_order: reconciled });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
