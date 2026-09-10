// Bespoke transactional endpoints for the Sales Return module — same
// shape as server/routes/purchases.js's transactional endpoints (header
// + line items + stock, one Postgres transaction; permanent-delete
// cascade as a second transaction), simplified to a single kind since
// Sales Return only ever writes to one header/items table pair, unlike
// Purchase's purchase/return split.
//
// A sales return always increases stock (goods physically come back
// into inventory) — same direction, same applyStockDelta() (imported
// from invoices.js, not reimplemented) that Purchase Entry already
// uses. b2b_invoices/b2c_invoices themselves are never read for
// mutation here beyond the initial invoice-items lookup the frontend
// does directly via the generic router — this file never writes to
// either invoice table.
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { TABLES } = require('./generic');
const { applyStockDelta } = require('./invoices');
// A customer's return brings the UNITS back too, in this same transaction:
// a return that moved the quantity but left its serials sold would leave
// the two accounts of the same goods disagreeing.
const serialsSvc = require('../services/stock-serials');
// The same default location the returned quantity is credited to.
const { defaultLocationId } = require('../services/stock-ledger');
// The SAME rule file the browser loads — see shared/sales-return-rules.js.
// Requiring it rather than restating the arithmetic is what guarantees the
// limit the user was shown is the limit actually enforced here.
const { validateReturnQty } = require('../../shared/sales-return-rules');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badId(id) {
  if (!UUID_RE.test(id)) { const e = new Error('Invalid id.'); e.status = 400; e.expose = true; throw e; }
}

// Re-derives sold and already-returned quantities FROM THE DATABASE and
// checks every submitted line against them.
//
// The browser performs the same check, but a request can be replayed,
// edited or crafted by hand — so the frontend result is treated as a
// convenience, never as authority. Runs inside the caller's transaction
// so it reads the same snapshot the write will use.
async function assertReturnQuantitiesAllowed(client, userId, header, items, editId) {
  const invoiceId = header.original_invoice_id;
  const invoiceType = header.original_invoice_type;
  if (!invoiceId || !invoiceType) return;      // nothing to validate against

  // What was sold on the original invoice.
  const { rows: soldRows } = await client.query(
    `SELECT product_id, product_name, SUM(quantity) AS qty
       FROM invoice_items
      WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3
      GROUP BY product_id, product_name`,
    [invoiceId, invoiceType, userId]
  );

  // What OTHER returns against this same invoice have already taken —
  // excluding the return being edited, whose own quantities are being
  // replaced by this request.
  const { rows: returnedRows } = await client.query(
    `SELECT i.product_id, i.product_name, SUM(i.quantity) AS qty
       FROM sales_return_items i
       JOIN sales_returns r ON r.id = i.return_id
      WHERE r.user_id = $1
        AND r.original_invoice_id = $2
        AND r.original_invoice_type = $3
        AND ($4::uuid IS NULL OR r.id <> $4::uuid)
      GROUP BY i.product_id, i.product_name`,
    [userId, invoiceId, invoiceType, editId || null]
  );

  // Keyed on product_id where there is one, else the name — matching how
  // the frontend pairs a return line back to its invoice line.
  const key = r => (r.product_id ? 'id:' + r.product_id : 'name:' + (r.product_name || ''));
  const sold = new Map(soldRows.map(r => [key(r), Number(r.qty) || 0]));
  const returned = new Map(returnedRows.map(r => [key(r), Number(r.qty) || 0]));

  // Several submitted lines can point at the same product; they must be
  // judged together, not one at a time.
  const wanted = new Map();
  for (const it of items) {
    const k = key(it);
    wanted.set(k, (wanted.get(k) || 0) + (Number(it.quantity) || 0));
  }

  for (const [k, qty] of wanted) {
    const soldQty = sold.get(k) || 0;
    if (!sold.has(k)) {
      const e = new Error('That product is not on the original invoice and cannot be returned.');
      e.status = 400; e.expose = true; throw e;
    }
    const verdict = validateReturnQty(soldQty, returned.get(k) || 0, qty);
    if (!verdict.valid) {
      const name = items.find(it => key(it) === k)?.product_name || 'item';
      const e = new Error(`${name}: ${verdict.message}`);
      e.status = 400; e.expose = true; throw e;
    }
  }
}

// ── Already-returned quantities for one invoice ──────
// { [product_id]: qty } summed across every OTHER return against this
// invoice, so Sales Return Entry knows what is still outstanding.
//
// Exists because the frontend previously answered this by downloading
// every sales_return_item in the account and filtering client-side —
// work proportional to total history for a question about a single
// invoice. One indexed join, grouped in Postgres, returns a few rows.
router.get('/returned-by-product', asyncRoute(async (req, res) => {
  const { invoice_id, invoice_type, exclude_return_id } = req.query;
  if (!invoice_id || !invoice_type) {
    const e = new Error('invoice_id and invoice_type are required.'); e.status = 400; e.expose = true; throw e;
  }
  badId(invoice_id);
  if (exclude_return_id) badId(exclude_return_id);

  const { rows } = await pool.query(
    `SELECT i.product_id, SUM(i.quantity)::float8 AS qty
       FROM sales_return_items i
       JOIN sales_returns r ON r.id = i.return_id
      WHERE r.user_id = $1
        AND r.original_invoice_id = $2
        AND r.original_invoice_type = $3
        AND ($4::uuid IS NULL OR r.id <> $4::uuid)
        AND i.product_id IS NOT NULL
      GROUP BY i.product_id`,
    [req.userId, invoice_id, invoice_type, exclude_return_id || null]
  );

  const byProduct = {};
  rows.forEach(r => { byProduct[r.product_id] = r.qty; });
  res.json(byProduct);
}));

// ── 1) Save header + line items + stock, one transaction ──
// ── The units a customer sent back ────────────────────────────────────
//
// The return document owns this transition: nobody should have to call a
// separate endpoint afterwards to make the inventory true, and a return
// saved without it would leave units marked sold that are sitting on the
// counter.
//
// A returned unit becomes RETURNED, not AVAILABLE. It has been out of the
// building and nobody has looked at it yet; putting it straight back on
// the shelf would offer it for sale on the strength of a customer's word.
// Inspection is a separate, deliberate decision.
async function planReturnSerials(client, userId, header, items) {
  const productIds = items.map(i => i.product_id).filter(Boolean);
  const tracked = await serialsSvc.serialTrackedProducts(client, userId, productIds);
  if (!tracked.size) return null;

  const invoiceId = header.original_invoice_id || null;
  const invoiceType = header.original_invoice_type || null;
  const wanted = [];
  const seen = new Map();

  for (const [index, item] of items.entries()) {
    if (!item.product_id || !tracked.has(item.product_id)) continue;
    const where = `Line ${index + 1} ("${item.product_name || 'product'}")`;
    const serials = serialsSvc.readSerialList(item.serials, { where });
    const quantity = Number(item.quantity) || 0;
    if (serials.length !== quantity) {
      const e = new Error(
        `${where} is serial-tracked: ${quantity} returned needs exactly ${quantity} serial `
        + `number${quantity === 1 ? '' : 's'}, but ${serials.length} `
        + `${serials.length === 1 ? 'was' : 'were'} given.`);
      e.status = 409; e.expose = true; throw e;
    }
    for (const value of serials) {
      const key = serialsSvc.serialKey(value);
      if (seen.has(key)) {
        const e = new Error(`Serial "${value}" is on more than one line of this return.`);
        e.status = 409; e.expose = true; throw e;
      }
      seen.set(key, item.product_id);
    }
    wanted.push({ productId: item.product_id, serials });
  }
  return { wanted, keys: seen, invoiceId, invoiceType };
}

async function applyReturnSerials(client, userId, returnId, plan) {
  // Units this return already brought back, found by the return's own id.
  const { rows: held } = await client.query(
    `SELECT * FROM stock_serials
      WHERE user_id = $1 AND returned_source_type = 'sales_return' AND returned_source_id = $2
      ORDER BY upper(btrim(serial_no)) FOR UPDATE`, [userId, returnId]);
  const byKey = new Map(held.map(r => [serialsSvc.serialKey(r.serial_no), r]));

  if (!plan) {
    for (const row of held) await sendBackToSold(client, userId, row);
    return { returned: 0, undone: held.length };
  }

  // Dropped from the return: they were never returned, so they go back to
  // being sold by the invoice that sold them.
  const dropped = held.filter(r => !plan.keys.has(serialsSvc.serialKey(r.serial_no)));
  for (const row of dropped) await sendBackToSold(client, userId, row);

  let count = 0;
  for (const line of plan.wanted) {
    const fresh = line.serials.filter(v => !byKey.has(serialsSvc.serialKey(v)));
    count += line.serials.length;
    if (!fresh.length) continue;

    const found = await serialsSvc.lockSerialsByText(client, userId, fresh);
    for (const value of fresh) {
      const row = found.get(serialsSvc.serialKey(value));
      const refuse = (msg, status) => {
        const e = new Error(msg); e.status = status || 409; e.expose = true; throw e;
      };
      // Not ours, or not a serial: one answer for both.
      if (!row) refuse(`Serial "${value}" was not found in your inventory.`, 404);
      if (row.product_id !== line.productId) refuse(`Serial "${value}" belongs to a different product.`);
      if (row.status !== 'SOLD') {
        refuse(`Serial "${value}" is ${row.status.toLowerCase().replace(/_/g, ' ')} `
          + 'and was not sold, so it cannot be returned.');
      }
      // A unit may only be returned against the invoice that sold it.
      // Matching on the product alone would let one customer's return take
      // back a unit another customer is holding.
      if (plan.invoiceId && row.sold_source_id && row.sold_source_id !== plan.invoiceId) {
        refuse(`Serial "${value}" was not sold on the invoice being returned.`);
      }
      // Back on the premises, at the location the returned quantity was
      // credited to, but NOT sellable until it has been inspected.
      await client.query(
        `UPDATE stock_serials
            SET status = 'RETURNED', location_id = $1,
                returned_source_type = 'sales_return', returned_source_id = $2, updated_at = NOW()
          WHERE id = $3 AND user_id = $4`,
        [await defaultLocationId(client, userId), returnId, row.id, userId]);
    }
  }
  return { returned: count, undone: dropped.length };
}

// Undoing one: the unit goes back to being sold by the invoice that sold
// it, which is where it was before this return claimed it.
async function sendBackToSold(client, userId, row) {
  if (row.status !== 'RETURNED') return;
  await client.query(
    `UPDATE stock_serials
        SET status = 'SOLD', location_id = NULL,
            returned_source_type = NULL, returned_source_id = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`, [row.id, userId]);
}

router.post('/save-with-items', asyncRoute(async (req, res) => {
  const { editId, header, items } = req.body;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    const e = new Error('Header is missing or malformed.'); e.status = 400; e.expose = true; throw e;
  }
  if (!Array.isArray(items) || !items.length) {
    const e = new Error('Add at least one product with a quantity and rate.'); e.status = 400; e.expose = true; throw e;
  }
  if (editId) badId(editId);

  const headerCols = TABLES.sales_returns.columns.filter(c => c !== 'id' && c !== 'user_id' && header && Object.prototype.hasOwnProperty.call(header, c));
  const itemCols = TABLES.sales_return_items.columns.filter(c => !['id','user_id','return_id','sort_order','created_at','updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Before anything is written. A rejection here rolls the whole
    // transaction back, so an over-quantity return never reaches the
    // database even partially.
    await assertReturnQuantitiesAllowed(client, req.userId, header, items, editId);

    // Settled before the first write: a return whose serials do not match
    // must leave the document, the stock and the units exactly as they were.
    const serialPlan = await planReturnSerials(client, req.userId, header, items);

    let returnId = editId;
    let oldItems = [];

    if (editId) {
      const values = headerCols.map(c => header[c]);
      const setClause = headerCols.map((c, i) => `${c} = $${i + 1}`).join(',');
      const { rows } = await client.query(
        `UPDATE sales_returns SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]
      );
      if (!rows.length) { const e = new Error('Sales return not found.'); e.status = 404; e.expose = true; throw e; }
      returnId = rows[0].id;

      const { rows: oldRows } = await client.query(
        'SELECT product_id, quantity FROM sales_return_items WHERE return_id = $1 AND user_id = $2',
        [editId, req.userId]
      );
      oldItems = oldRows;
    } else {
      const payload = { ...header, user_id: req.userId };
      const cols = headerCols.concat('user_id');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      const { rows } = await client.query(`INSERT INTO sales_returns (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
      returnId = rows[0].id;
    }

    await client.query('DELETE FROM sales_return_items WHERE return_id = $1 AND user_id = $2', [returnId, req.userId]);

    const newQtyByProduct = {};
    // What the ledger records each movement was counted and priced in.
    const unitByProduct = {};
    const rateByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const payload = { ...items[i], user_id: req.userId, return_id: returnId, sort_order: i };
      const cols = itemCols.concat(['user_id', 'return_id', 'sort_order']).filter(c => Object.prototype.hasOwnProperty.call(payload, c));
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      await client.query(`INSERT INTO sales_return_items (${cols.join(',')}) VALUES (${placeholders})`, values);
      if (payload.product_id) {
        newQtyByProduct[payload.product_id] = (newQtyByProduct[payload.product_id] || 0) + (+payload.quantity || 0);
        unitByProduct[payload.product_id] = payload.unit;
        rateByProduct[payload.product_id] = payload.rate;
      }
    }

    // The units, before the quantity. Run the other way round, a serial
    // that was never sold fails as a stock error instead of naming itself.
    const serialResult = await applyReturnSerials(client, req.userId, returnId, serialPlan);

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
      // A sales return increases stock — delta here is "more returned"
      // (positive = stock should go up), applied un-negated, opposite
      // sign convention from a sale (invoices.js negates its own delta).
      const delta = (newQtyByProduct[pid] || 0) - (oldQtyByProduct[pid] || 0);
      if (delta) await applyStockDelta(client, req.userId, pid, delta, {
        type: 'SALES_RETURN', sourceType: 'sales_return', sourceId: returnId,
        unit: unitByProduct[pid], rate: rateByProduct[pid]
      });
    }

    await client.query('COMMIT');
    res.json({ id: returnId, serials: serialResult });
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
// touches the downstream line-item rows, same pattern as
// invoices.js/purchases.js.
router.post('/:id/cascade-delete', asyncRoute(async (req, res) => {
  const { id } = req.params;
  badId(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: items } = await client.query(
      'SELECT id, product_id, quantity, unit, rate FROM sales_return_items WHERE return_id = $1 AND user_id = $2',
      [id, req.userId]
    );
    // Deleting a saved return un-applies the stock it added back.
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, -(+it.quantity || 0), {
      type: 'SALES_RETURN', sourceType: 'sales_return', sourceId: id, sourceItemId: it.id,
      unit: it.unit, rate: it.rate, reason: 'Sales return deleted'
    });

    await client.query('DELETE FROM sales_return_items WHERE return_id = $1 AND user_id = $2', [id, req.userId]);
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
