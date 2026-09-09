// Purchase orders.
//
// A purchase order is an intent to buy. It moves no stock, ever. Goods
// arrive as a PURCHASE, and it is that purchase - written here in the same
// transaction as the receipt - which calls the existing stock ledger. There
// is no second stock engine in this file, only a call into the one that
// already exists.
//
// Why this router exists at all, when purchase_order is registered in
// routes/documents.js: the generic document save replaces line items
// wholesale, deleting and re-inserting them. That is right for a quotation
// and fatally wrong here, because every item carries how much of it has
// already arrived. Re-inserting the rows would reset that to zero and the
// order would be receivable all over again. So the save below merges items
// instead, and the numbering, duplicate rule and audit trail are borrowed
// from documents.js rather than reimplemented.
//
// Every query is scoped to req.userId from the JWT. Nothing here reads a
// tenant id from the request.
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { TABLES } = require('./generic');
const { applyStockDelta } = require('../services/stock-ledger');
const { reserveDocumentNumberOn, writeAudit } = require('./documents');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIES = 'purchase_order';
const MAX_PAGE = 200;

// Where an order can go next. Receiving moves it to PARTIALLY_RECEIVED or
// FULLY_RECEIVED on its own, so those are not listed as things a person
// sets; what a person can do is send, confirm, cancel and close.
const STATUS_TRANSITIONS = {
  DRAFT:              ['SENT', 'CONFIRMED', 'CANCELLED'],
  SENT:               ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:          ['CANCELLED', 'CLOSED'],
  // Something has already arrived. The order may be closed short, but
  // cancelling it would deny receipts that really happened.
  PARTIALLY_RECEIVED: ['CLOSED'],
  FULLY_RECEIVED:     ['CLOSED'],
  CANCELLED:          [],
  CLOSED:             []
};
// Receiving is only meaningful once the order is real and still open.
const RECEIVABLE_STATUSES = new Set(['CONFIRMED', 'SENT', 'PARTIALLY_RECEIVED']);

function bad(message, status) {
  const e = new Error(message);
  e.status = status || 400; e.expose = true;
  return e;
}
function badId(id, what) {
  if (!UUID_RE.test(String(id || ''))) throw bad(`Invalid ${what || 'id'}.`);
}
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

// A real calendar date, not merely the right shape: '2026-13-45' matches
// YYYY-MM-DD and is not a date, and letting it through means Postgres
// rejects it as a 500 instead of this saying so as a 400.
function checkDate(value, what) {
  const v = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${what} must be a date in YYYY-MM-DD form.`);
  const [y, m, d] = v.split('-').map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) {
    throw bad(`${what} is not a real calendar date.`);
  }
  return v;
}

// ── The order, with its items ─────────────────────────────────────────
// One round trip for the header and one for the items: two queries for a
// document, never one per line.
async function loadOrder(client, userId, id) {
  const { rows } = await client.query(
    'SELECT * FROM purchase_orders WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows.length) throw bad('Purchase order not found.', 404);
  const { rows: items } = await client.query(
    `SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2
      ORDER BY sort_order ASC, created_at ASC, id ASC`, [id, userId]);
  return { order: rows[0], items };
}

// What the status should be, given what has actually arrived. Only the
// three receipt-derived states are computed; a cancelled or closed order
// keeps the state a person put it in.
function receiptStatus(items, current) {
  if (current === 'CANCELLED' || current === 'CLOSED') return current;
  const ordered = items.reduce((s, i) => s + Number(i.quantity), 0);
  const received = items.reduce((s, i) => s + Number(i.received_quantity), 0);
  if (received <= 0) return current === 'PARTIALLY_RECEIVED' || current === 'FULLY_RECEIVED'
    ? 'CONFIRMED' : current;
  return round3(received) >= round3(ordered) ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';
}

// A number is required, and unique within this tenant's purchase-order
// book. The unique index enforces it too; this exists so the caller gets a
// sentence rather than a constraint violation.
async function assertNumberFree(client, userId, number, editId) {
  const n = String(number == null ? '' : number).trim();
  if (!n) throw bad('A purchase order number is required.');
  const params = [userId, n];
  let where = 'user_id = $1 AND document_series = $3 AND UPPER(document_number) = UPPER($2)';
  params.push(SERIES);
  if (editId) { params.push(editId); where += ` AND id <> $${params.length}`; }
  const { rows } = await client.query(
    `SELECT 1 FROM purchase_orders WHERE ${where} LIMIT 1`, params);
  if (rows.length) throw bad('Purchase order number already exists.', 409);
  return n;
}

// Vendor and every product must belong to the caller. Checked in one query
// each rather than one per line.
async function assertOwnership(client, userId, vendorId, productIds) {
  if (vendorId) {
    const { rows } = await client.query(
      'SELECT 1 FROM vendors WHERE id = $1 AND user_id = $2', [vendorId, userId]);
    if (!rows.length) throw bad('Vendor not found.', 404);
  }
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length) {
    const { rows } = await client.query(
      'SELECT id FROM products WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, ids]);
    if (rows.length !== ids.length) throw bad('A product on this order does not exist.', 404);
  }
}

// ── List ──────────────────────────────────────────────────────────────
// Paged in SQL with the ordered/received totals aggregated there too, so a
// list of orders is one query however many lines they have between them.
router.get('/', asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_PAGE);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = ['po.user_id = $1'];
  const params = [req.userId];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$$', '$' + params.length)); };

  const q = String(req.query.q || '').trim();
  if (q) {
    params.push('%' + q + '%');
    where.push(`(po.document_number ILIKE $${params.length} OR po.vendor_name ILIKE $${params.length})`);
  }
  const status = String(req.query.status || '').trim().toUpperCase();
  if (status) {
    if (!Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS, status)) throw bad('Unknown status.');
    add('po.status = $$', status);
  }
  if (req.query.vendor_id) { badId(req.query.vendor_id, 'vendor id'); add('po.vendor_id = $$', req.query.vendor_id); }
  for (const [key, sql] of [['from', 'po.document_date >= $$'], ['to', 'po.document_date <= $$'],
    ['delivery_from', 'po.expected_delivery_date >= $$'], ['delivery_to', 'po.expected_delivery_date <= $$']]) {
    const v = String(req.query[key] || '').trim();
    if (v) { add(sql, checkDate(v, key)); }
  }

  // "Show me what is still owed to me."
  const pendingOnly = String(req.query.pending || '') === '1';
  const having = pendingOnly
    ? 'HAVING COALESCE(SUM(i.quantity),0) - COALESCE(SUM(i.received_quantity),0) > 0' : '';

  const sql = `
    SELECT po.id, po.document_number, po.document_date, po.status, po.vendor_id, po.vendor_name,
           po.expected_delivery_date, po.total_amount,
           COALESCE(SUM(i.quantity), 0)          AS ordered_quantity,
           COALESCE(SUM(i.received_quantity), 0) AS received_quantity,
           COALESCE(SUM(i.quantity), 0) - COALESCE(SUM(i.received_quantity), 0) AS pending_quantity,
           COUNT(i.id)::int AS line_count
      FROM purchase_orders po
      LEFT JOIN purchase_order_items i
        ON i.purchase_order_id = po.id AND i.user_id = po.user_id
     WHERE ${where.join(' AND ')}
     GROUP BY po.id
     ${having}
     ORDER BY po.document_date DESC, po.created_at DESC, po.document_number DESC
     LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `
    SELECT COUNT(*)::int n FROM (
      SELECT po.id FROM purchase_orders po
      LEFT JOIN purchase_order_items i
        ON i.purchase_order_id = po.id AND i.user_id = po.user_id
      WHERE ${where.join(' AND ')} GROUP BY po.id ${having}) x`;

  const [rows, count] = await Promise.all([pool.query(sql, params), pool.query(countSql, params)]);
  res.json({ rows: rows.rows, total: count.rows[0].n, limit, offset });
}));

// ── One order ─────────────────────────────────────────────────────────
router.get('/:id', asyncRoute(async (req, res) => {
  badId(req.params.id, 'purchase order id');
  const client = await pool.connect();
  try {
    const { order, items } = await loadOrder(client, req.userId, req.params.id);
    // What may still be received, per line — the number the purchase form
    // defaults to, computed here rather than trusted from the browser.
    const withPending = items.map(i => ({
      ...i,
      pending_quantity: round3(Number(i.quantity) - Number(i.received_quantity))
    }));
    res.json({ order, items: withPending, can_receive: RECEIVABLE_STATUSES.has(order.status) });
  } finally { client.release(); }
}));

// ── Save (create or edit) ─────────────────────────────────────────────
router.post('/save', asyncRoute(async (req, res) => {
  const { editId, order, items } = req.body || {};
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw bad('The order is missing or malformed.');
  if (!Array.isArray(items) || !items.length) throw bad('Add at least one product with a quantity and rate.');
  if (editId) badId(editId, 'purchase order id');
  if (!String(order.vendor_name || '').trim()) throw bad('A vendor is required.');
  if (!String(order.document_date || '').trim()) throw bad('A purchase order date is required.');
  checkDate(order.document_date, 'order date');
  if (order.expected_delivery_date) checkDate(order.expected_delivery_date, 'expected delivery date');
  if (order.expected_delivery_date && String(order.expected_delivery_date) < String(order.document_date)) {
    throw bad('The expected delivery date cannot be before the order date.');
  }
  for (const it of items) {
    if (!(Number(it.quantity) > 0)) throw bad('Every line needs a quantity greater than zero.');
    if (!(Number(it.rate) >= 0)) throw bad('Every line needs a valid rate.');
    if (!String(it.product_name || '').trim()) throw bad('Every line needs a product.');
  }

  const itemCols = TABLES.purchase_order_items.columns.filter(c =>
    !['id', 'user_id', 'purchase_order_id', 'received_quantity', 'sort_order',
      'created_at', 'updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // On an edit the order is found and locked FIRST. Anything else would
    // answer a stranger's edit with a complaint about the number rather
    // than "no such order", and would leak that the order exists.
    let existingOrder = null;
    if (editId) {
      const { rows: locked } = await client.query(
        'SELECT id, status, document_number FROM purchase_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [editId, req.userId]);
      if (!locked.length) throw bad('Purchase order not found.', 404);
      if (locked[0].status === 'CANCELLED') throw bad('A cancelled purchase order cannot be edited.', 409);
      existingOrder = locked[0];
    }

    // A number is issued only for a brand new order, and inside this
    // transaction, so a number taken and then rolled back leaves no hole.
    //
    // Absent and blank are different things on an edit. A save that does
    // not mention the number keeps the one the order has. A save that sends
    // an EMPTY number is someone who cleared the field, and is refused -
    // quietly restoring the old number would ignore what they did, and
    // issuing a fresh one would renumber an order the supplier may already
    // be holding.
    const numberGiven = Object.prototype.hasOwnProperty.call(order, 'document_number');
    let number = String(order.document_number == null ? '' : order.document_number).trim();
    if (!number) {
      if (editId && numberGiven) throw bad('A purchase order number is required.');
      number = editId
        ? existingOrder.document_number
        : (await reserveDocumentNumberOn(client, req.userId, 'purchase_order')).documentNumber;
    }
    number = await assertNumberFree(client, req.userId, number, editId);

    await assertOwnership(client, req.userId, order.vendor_id || null, items.map(i => i.product_id));

    // Built AFTER the number is settled, and the column list taken from the
    // payload rather than the request: an auto-numbered order carries no
    // document_number of its own, and a list built from the request would
    // leave the column out of the INSERT entirely.
    const payload = { ...order, document_number: number, document_series: SERIES };
    const headerCols = TABLES.purchase_orders.columns.filter(c =>
      !['id', 'user_id', 'created_at', 'updated_at', 'status', 'created_by'].includes(c)
      && Object.prototype.hasOwnProperty.call(payload, c));
    let id = editId;

    if (editId) {
      const values = headerCols.map(c => payload[c]);
      const setClause = headerCols.map((c, i) => `${c} = $${i + 1}`).join(',');
      await client.query(
        `UPDATE purchase_orders SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2}`,
        [...values, editId, req.userId]);
    } else {
      const cols = headerCols.concat(['user_id', 'created_by']);
      const vals = cols.map(c => (c === 'user_id' || c === 'created_by') ? req.userId : payload[c]);
      const { rows } = await client.query(
        `INSERT INTO purchase_orders (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
        vals);
      id = rows[0].id;
    }

    // ── Merge, not replace ──
    // Existing lines are updated in place so their received_quantity
    // survives. A line that has already had goods against it cannot be
    // removed, and cannot be ordered down below what already arrived.
    const { rows: existing } = await client.query(
      `SELECT id, received_quantity FROM purchase_order_items
        WHERE purchase_order_id = $1 AND user_id = $2 FOR UPDATE`, [id, req.userId]);
    const existingById = new Map(existing.map(r => [r.id, r]));
    const keep = new Set();

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rowId = it.id && UUID_RE.test(String(it.id)) ? String(it.id) : null;
      const prior = rowId ? existingById.get(rowId) : null;

      if (prior) {
        const already = Number(prior.received_quantity);
        if (round3(Number(it.quantity)) < round3(already)) {
          throw bad(`"${it.product_name}" already has ${already} received, so it cannot be ordered down to ${it.quantity}.`, 409);
        }
        const cols = itemCols.filter(c => Object.prototype.hasOwnProperty.call(it, c));
        const vals = cols.map(c => it[c]);
        vals.push(i);
        await client.query(
          `UPDATE purchase_order_items
              SET ${cols.map((c, n) => `${c} = $${n + 1}`).join(',')}, sort_order = $${vals.length}
            WHERE id = $${vals.length + 1} AND user_id = $${vals.length + 2}`,
          [...vals, rowId, req.userId]);
        keep.add(rowId);
      } else {
        const cols = itemCols.filter(c => Object.prototype.hasOwnProperty.call(it, c))
          .concat(['user_id', 'purchase_order_id', 'sort_order']);
        const vals = cols.map(c => c === 'user_id' ? req.userId
          : c === 'purchase_order_id' ? id
            : c === 'sort_order' ? i : it[c]);
        const { rows } = await client.query(
          `INSERT INTO purchase_order_items (${cols.join(',')})
           VALUES (${cols.map((_, n) => '$' + (n + 1)).join(',')}) RETURNING id`, vals);
        keep.add(rows[0].id);
      }
    }

    for (const row of existing) {
      if (keep.has(row.id)) continue;
      if (Number(row.received_quantity) > 0) {
        throw bad('A line that has already been received cannot be removed from the order.', 409);
      }
      await client.query('DELETE FROM purchase_order_items WHERE id = $1 AND user_id = $2',
        [row.id, req.userId]);
    }

    // Ordering more of something already fully received reopens the order.
    const { rows: after } = await client.query(
      'SELECT quantity, received_quantity FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2',
      [id, req.userId]);
    const { rows: cur } = await client.query(
      'SELECT status FROM purchase_orders WHERE id = $1 AND user_id = $2', [id, req.userId]);
    const next = receiptStatus(after, cur[0].status);
    if (next !== cur[0].status) {
      await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 AND user_id = $3',
        [next, id, req.userId]);
    }

    await writeAudit(client, req.userId, 'purchase_order', 'purchase_orders', id, number,
      editId ? 'updated' : 'created', { document_number: number });

    await client.query('COMMIT');
    const fresh = await loadOrder(client, req.userId, id);
    res.json({ id, order: fresh.order, items: fresh.items });
  } catch (err) {
    await client.query('ROLLBACK');
    // The unique index is the last word on a duplicate number; two saves
    // racing can both pass the check above and only one can pass this.
    if (err && err.code === '23505' && String(err.constraint || '').includes('purchase_orders')) {
      throw bad('Purchase order number already exists.', 409);
    }
    throw err;
  } finally { client.release(); }
}));

// ── Status ────────────────────────────────────────────────────────────
router.post('/:id/status', asyncRoute(async (req, res) => {
  badId(req.params.id, 'purchase order id');
  const to = String((req.body || {}).status || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS, to)) throw bad('Unknown status.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, status, document_number FROM purchase_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.userId]);
    if (!rows.length) throw bad('Purchase order not found.', 404);
    const from = rows[0].status;
    if (!STATUS_TRANSITIONS[from].includes(to)) {
      throw bad(`A ${from.replace(/_/g, ' ').toLowerCase()} purchase order cannot be marked ${to.replace(/_/g, ' ').toLowerCase()}.`, 409);
    }

    const sets = ['status = $1'];
    const params = [to];
    if (to === 'CANCELLED') {
      params.push(new Date()); sets.push(`cancelled_at = $${params.length}`);
      params.push(req.userId); sets.push(`cancelled_by = $${params.length}`);
      params.push(String((req.body || {}).reason || '').trim() || null);
      sets.push(`cancel_reason = $${params.length}`);
    }
    params.push(req.params.id, req.userId);
    await client.query(
      `UPDATE purchase_orders SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND user_id = $${params.length}`, params);

    await writeAudit(client, req.userId, 'purchase_order', 'purchase_orders',
      req.params.id, rows[0].document_number, to.toLowerCase(), { from, to });
    await client.query('COMMIT');
    res.json({ id: req.params.id, status: to });
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}));

// ── Receive ───────────────────────────────────────────────────────────
//
// The one place stock moves in this feature, and it does so by calling the
// existing ledger. Everything happens in one transaction: the order's lines
// are locked, the remainder is checked, a purchase is written, the stock
// movement is posted against THAT purchase, and the received quantities
// move. Any failure rolls all of it back, so a rejected receipt leaves no
// purchase, no movement and no changed quantity.
router.post('/:id/receive', asyncRoute(async (req, res) => {
  badId(req.params.id, 'purchase order id');
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('Nothing to receive.');
  const purchaseNumber = String(body.purchase_number || '').trim();
  if (!purchaseNumber) throw bad('A purchase number is required.');
  const purchaseDate = String(body.purchase_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw bad('A purchase date is required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: orderRows } = await client.query(
      'SELECT * FROM purchase_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.userId]);
    if (!orderRows.length) throw bad('Purchase order not found.', 404);
    const order = orderRows[0];
    if (!RECEIVABLE_STATUSES.has(order.status)) {
      throw bad(`A ${order.status.replace(/_/g, ' ').toLowerCase()} purchase order cannot receive goods.`, 409);
    }

    // Locked in a stable order so two receipts on one order queue rather
    // than interleave.
    const { rows: items } = await client.query(
      `SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2
        ORDER BY id FOR UPDATE`, [req.params.id, req.userId]);
    const byId = new Map(items.map(i => [i.id, i]));

    // Validate every line BEFORE writing anything.
    const planned = [];
    for (const l of lines) {
      badId(l.item_id, 'order line id');
      const item = byId.get(String(l.item_id));
      if (!item) throw bad('That line is not on this purchase order.', 404);
      const qty = round3(Number(l.quantity));
      if (!(qty > 0)) continue;
      const remaining = round3(Number(item.quantity) - Number(item.received_quantity));
      if (qty > remaining) {
        throw bad(`"${item.product_name}" has only ${remaining} left to receive, not ${qty}.`, 409);
      }
      planned.push({ item, qty });
    }
    if (!planned.length) throw bad('Nothing to receive.');

    // ── the purchase ──
    const taxable = planned.reduce((s, p) => s + (Number(p.item.rate) * p.qty), 0);
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    let cgst = 0, sgst = 0, igst = 0, gst = 0;
    for (const p of planned) {
      const base = Number(p.item.rate) * p.qty;
      const amount = base * (Number(p.item.gst_percentage) || 0) / 100;
      gst += amount;
      if (order.supply_type === 'interstate') igst += amount;
      else { cgst += amount / 2; sgst += amount / 2; }
    }
    const { rows: pRows } = await client.query(
      `INSERT INTO purchases
         (user_id, vendor_id, vendor_name, vendor_gstin, phone, address, state, district,
          gst_category, purchase_number, purchase_date, taxable_amount, gst_percentage,
          gst_amount, total_amount, supply_type, igst, cgst, sgst, payment_status,
          amount_paid, purchase_order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'unpaid',0,$20)
       RETURNING id`,
      [req.userId, order.vendor_id, order.vendor_name, order.vendor_gstin, order.phone,
        order.address, order.state, order.district, order.gst_category, purchaseNumber,
        purchaseDate, round2(taxable), order.gst_percentage, round2(gst),
        round2(taxable + gst), order.supply_type, round2(igst), round2(cgst), round2(sgst),
        req.params.id]);
    const purchaseId = pRows[0].id;

    // ── lines, received quantities, and stock ──
    for (let n = 0; n < planned.length; n++) {
      const { item, qty } = planned[n];
      const base = Number(item.rate) * qty;
      const amount = base * (Number(item.gst_percentage) || 0) / 100;
      // purchase_order_item_id is what makes a later reversal exact. Without
      // it, an order carrying the same product on two lines could only be
      // unwound by guessing which of them a receipt had filled.
      await client.query(
        `INSERT INTO purchase_items
           (user_id, purchase_id, purchase_order_item_id, product_id, product_name, hsn_code,
            unit, quantity, rate, discount_percentage, gst_percentage, taxable_value, gst_amount,
            igst, cgst, sgst, total_amount, gst_treatment, cess_rate, cess_amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16,$17,0,0,$18)`,
        [req.userId, purchaseId, item.id, item.product_id, item.product_name, item.hsn_code,
          item.unit, qty, item.rate, item.gst_percentage, round2(base), round2(amount),
          order.supply_type === 'interstate' ? round2(amount) : 0,
          order.supply_type === 'interstate' ? 0 : round2(amount / 2),
          order.supply_type === 'interstate' ? 0 : round2(amount / 2),
          round2(base + amount), item.gst_treatment, n]);

      // The database also refuses received > ordered, so a bug here cannot
      // over-receive; this is the check that produces a sentence.
      await client.query(
        `UPDATE purchase_order_items SET received_quantity = received_quantity + $1
          WHERE id = $2 AND user_id = $3`, [qty, item.id, req.userId]);

      // Stock. The movement's source is the PURCHASE, never the order -
      // the order did not bring anything in. Location is left to the ledger,
      // which puts it in the tenant's default, exactly as an ordinary
      // purchase does today.
      if (item.product_id) {
        await applyStockDelta(client, req.userId, item.product_id, qty, {
          type: 'PURCHASE', sourceType: 'purchase', sourceId: purchaseId,
          unit: item.unit, rate: item.rate,
          reason: `Received against ${order.document_number}`
        });
      }
    }

    const { rows: afterItems } = await client.query(
      'SELECT quantity, received_quantity FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2',
      [req.params.id, req.userId]);
    const next = receiptStatus(afterItems, order.status);
    await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 AND user_id = $3',
      [next, req.params.id, req.userId]);

    await writeAudit(client, req.userId, 'purchase_order', 'purchase_orders', req.params.id,
      order.document_number, 'received',
      { purchase_id: purchaseId, purchase_number: purchaseNumber, status: next });

    await client.query('COMMIT');
    res.status(201).json({
      purchase_id: purchaseId, purchase_number: purchaseNumber, status: next,
      received: planned.map(p => ({ item_id: p.item.id, quantity: p.qty }))
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23514' && String(err.constraint || '').includes('no_over_receipt')) {
      throw bad('That would receive more than was ordered.', 409);
    }
    throw err;
  } finally { client.release(); }
}));


// ── Reversing a receipt ───────────────────────────────────────────────
//
// Called by the purchase cascade-delete when the purchase being deleted
// came from an order. Deleting a receipt has to give back what it took:
// the stock goes back through the ledger (the purchase route's own job),
// and the quantities it counted as received come off the order here, in
// that same transaction.
//
// Lines are matched by product. purchase_items carries no link to the
// order line it came from, and a product normally appears once on an
// order, so this is exact in every ordinary case. Where one product
// appears on SEVERAL lines of one order, the total given back is still
// exact; which of those lines gives it back is decided by taking from the
// fullest first, because there is nothing recorded that could say how the
// receipt was split. A per-line link would make that exact too, and would
// need a column on purchase_items.
async function reversePurchaseOrderReceipt(client, userId, purchaseId, deletedItems) {
  const { rows: link } = await client.query(
    'SELECT purchase_order_id FROM purchases WHERE id = $1 AND user_id = $2', [purchaseId, userId]);
  const orderId = link.length ? link[0].purchase_order_id : null;
  if (!orderId) return null;          // an ordinary purchase: nothing to reconcile

  // Locked in the same order the receive path locks them, so a receipt and
  // a reversal on one order queue rather than interleave.
  const { rows: orderRows } = await client.query(
    'SELECT id, status FROM purchase_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [orderId, userId]);
  if (!orderRows.length) return null;
  await client.query(
    `SELECT id FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2
      ORDER BY id FOR UPDATE`, [orderId, userId]);

  // Straight down the link. Each deleted purchase line names the order line
  // it received against, so nothing is inferred and an order carrying the
  // same product on several lines unwinds exactly as it was filled.
  //
  // A line with no link is one raised before this column existed, or one
  // whose order line has since been deleted. It gives nothing back rather
  // than guessing which line to take it from.
  for (const it of deletedItems) {
    const lineId = it.purchase_order_item_id;
    if (!lineId) continue;
    const quantity = Number(it.quantity) || 0;
    if (quantity <= 0) continue;
    // Bounded by what that line actually holds, so a reversal can never
    // drive it negative however the row was written.
    await client.query(
      `UPDATE purchase_order_items
          SET received_quantity = GREATEST(received_quantity - $1, 0)
        WHERE id = $2 AND user_id = $3 AND purchase_order_id = $4`,
      [quantity, lineId, userId, orderId]);
  }

  // The status follows what is actually left, so an order emptied of its
  // receipts goes back to being confirmed and receivable.
  const { rows: after } = await client.query(
    'SELECT quantity, received_quantity FROM purchase_order_items WHERE purchase_order_id = $1 AND user_id = $2',
    [orderId, userId]);
  const next = receiptStatus(after, orderRows[0].status);
  if (next !== orderRows[0].status) {
    await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 AND user_id = $3',
      [next, orderId, userId]);
  }
  return { order_id: orderId, status: next };
}

module.exports = router;
// Shared with routes/purchases.js, whose cascade-delete must give back the
// received quantities in the same transaction that gives back the stock.
module.exports.reversePurchaseOrderReceipt = reversePurchaseOrderReceipt;
module.exports.receiptStatus = receiptStatus;
// Quantities are compared against an order's remaining capacity in two
// places now, and both have to round the same way or a line could be
// refused in one path and accepted in the other.
module.exports.round3 = round3;
