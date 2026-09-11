// Bespoke transactional endpoints — the three places in the app that do
// multi-step orchestration across several tables and need real Postgres
// transactions (BEGIN/COMMIT/ROLLBACK) rather than the generic
// single-table CRUD router (routes/generic.js):
//   1. POST /:type/save-with-items   — invoice header + line items + stock
//   2. POST /reserve-number           — Auto Generate invoice numbering
//   3. POST /:type/:id/cascade-delete — permanent delete cascade (items +
//                                       HSN + stock reversal)
//
// Frontend call sites (unchanged signatures, only their internals swap
// to a single fetch() each): js/invoice-items.js's saveInvoiceWithItems()
// and cascadeInvoiceItemsDelete(), js/invoice-entry.js's
// reserveNextInvoiceNumber().
const express = require('express');
const pool = require('../config/pool');
const { syncWarrantiesForInvoice } = require('../services/warranty-sync');
const { reserveDocumentNumberOn } = require('./documents');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { applyInvoiceNumberFormat, invoiceSeriesFormat } = require('../utils/invoiceNumberFormat');
const { TABLES } = require('./generic');
const { applyStockDelta } = require('../services/stock-ledger');
// Serial units move with the sale that moves them, in its transaction.
const serialsSvc = require('../services/stock-serials');
const { validateTransportCharge, transportGstAmount, principalGstRate } = require('../utils/validation');

const router = express.Router();
router.use(requireAuth);

function invoiceTable(type) { return type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices'; }

// Which numbering series an invoice belongs to. Anything unrecognised —
// including every invoice saved before series existed — is the shop
// series, which is what those invoices were.
//
// Not restricted to a fixed list: a business that starts selling through
// another channel gets that series numbered and reported without a code
// change.
const DEFAULT_INVOICE_SOURCE = 'offline';
function normaliseSource(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v || DEFAULT_INVOICE_SOURCE;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badId(id) {
  if (!UUID_RE.test(id)) { const e = new Error('Invalid invoice id.'); e.status = 400; e.expose = true; throw e; }
}
function hsnTable(type) { return type === 'b2b' ? 'b2b_hsn' : 'b2c_hsn'; }
function badType(type) {
  if (type !== 'b2b' && type !== 'b2c') { const e = new Error('type must be b2b or b2c.'); e.status = 400; e.expose = true; throw e; }
}

// The row-locked stock helper now lives in services/stock-ledger.js, where
// the same statement pair that moves the balance also writes the movement
// explaining it and enforces the negative-stock guard. Re-exported at the
// foot of this file under its original name, so purchases.js and
// sales-returns.js keep importing it from here as they always have.

// ── 1) Save invoice header + line items + stock, one transaction ──
// ── The serial side of a sale ─────────────────────────────────────────
//
// A serialised product is sold by NAME: two units means two numbers, and
// the count must match the quantity exactly. Anything else would put stock
// out of the door that no unit accounts for.
//
// Which units an invoice sold is read from the INVOICE HEADER, never from
// its line rows — save-with-items deletes and re-inserts every line, so
// invoice_items.id is a different value after each edit. On an edit the
// payload says which units the invoice now sells and the database says
// which it sold before, so the ones to give back are the difference
// between two explicit lists. Nothing is chosen for the user.
async function planInvoiceSerials(client, userId, items) {
  const productIds = items.map(i => i.product_id).filter(Boolean);
  const tracked = await serialsSvc.serialTrackedProducts(client, userId, productIds);
  if (!tracked.size) return null;

  const wanted = [];
  const seen = new Map();
  for (const [index, item] of items.entries()) {
    if (!item.product_id || !tracked.has(item.product_id)) continue;
    const where = `Line ${index + 1} ("${item.product_name || 'product'}")`;
    const serials = serialsSvc.readSerialList(item.serials, { where });
    const quantity = Number(item.quantity) || 0;
    if (serials.length !== quantity) {
      const e = new Error(
        `${where} is serial-tracked: ${quantity} sold needs exactly ${quantity} serial `
        + `number${quantity === 1 ? '' : 's'}, but ${serials.length} `
        + `${serials.length === 1 ? 'was' : 'were'} selected.`);
      e.status = 409; e.expose = true; throw e;
    }
    for (const value of serials) {
      const key = serialsSvc.serialKey(value);
      if (seen.has(key)) {
        const e = new Error(`Serial "${value}" is on more than one line of this invoice.`);
        e.status = 409; e.expose = true; throw e;
      }
      seen.set(key, item.product_id);
    }
    wanted.push({ productId: item.product_id, serials });
  }
  return { wanted, keys: seen };
}

async function applyInvoiceSerials(client, userId, type, invoiceId, plan) {
  const sold = await serialsSvc.serialsSoldBy(client, userId, type, invoiceId);
  const soldByKey = new Map(sold.map(r => [serialsSvc.serialKey(r.serial_no), r]));

  if (!plan) {
    // Nothing serialised now; anything this invoice used to sell is given
    // back, because the invoice no longer says it sold it.
    if (sold.length) await serialsSvc.unsellSerials(client, userId, sold);
    return { sold: [], released: sold };
  }

  const dropped = sold.filter(r => !plan.keys.has(serialsSvc.serialKey(r.serial_no)));
  if (dropped.length) await serialsSvc.unsellSerials(client, userId, dropped);

  const soldNow = [];
  for (const line of plan.wanted) {
    const fresh = line.serials.filter(v => !soldByKey.has(serialsSvc.serialKey(v)));
    if (!fresh.length) continue;
    const rows = await serialsSvc.sellSerials(client, userId, {
      productId: line.productId, serials: fresh, sourceType: type, sourceId: invoiceId
    });
    soldNow.push(...rows);
  }
  return { sold: soldNow, released: dropped };
}

router.post('/:type/save-with-items', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const type = req.params.type;
  const table = invoiceTable(type);
  const { editId, header, items } = req.body;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    const e = new Error('Invoice header is missing or malformed.'); e.status = 400; e.expose = true; throw e;
  }
  if (!Array.isArray(items) || !items.length) {
    const e = new Error('Add at least one product with a quantity and rate.'); e.status = 400; e.expose = true; throw e;
  }
  if (editId) badId(editId);

  // B2B or B2C follows the customer's GST Number: a B2B invoice names the
  // registered customer's GSTIN, a B2C invoice names none. The invoice page
  // keeps the two in step as the user types; this refuses the combination
  // whoever sent it, before anything is written. An edit whose payload does
  // not mention gst_number is not changing it, so only a create, or a payload
  // that sets it, is judged.
  if (!editId || Object.prototype.hasOwnProperty.call(header, 'gst_number')) {
    const gstNumber = String(header.gst_number == null ? '' : header.gst_number).trim();
    if (type === 'b2b' && !gstNumber) {
      const e = new Error('A B2B invoice needs the customer\'s GST Number. Enter it, or save the invoice as B2C.');
      e.status = 400; e.expose = true; e.code = 'b2b_gstin_required'; throw e;
    }
    if (type === 'b2c' && gstNumber) {
      const e = new Error('A B2C invoice cannot carry a GST Number. Clear it, or save the invoice as B2B.');
      e.status = 400; e.expose = true; e.code = 'b2c_gstin_not_allowed'; throw e;
    }
  }

  // Whatever the client sends, the stored series is lower-cased and
  // never blank, so 'Online', 'online' and ' Online ' are one series and
  // an omitted source is the shop series.
  if (Object.prototype.hasOwnProperty.call(header, 'invoice_source')) {
    header.invoice_source = normaliseSource(header.invoice_source);
  }

  // Transport charge: checked here, and its tax DERIVED here.
  //
  // The charge is the only part of this the browser gets to decide. The
  // 18% on it is computed from the charge that just passed validation, so
  // a client that sends a charge of 1000 with a tax of 5000 - or with no
  // tax at all - stores 180 either way. Absent from the payload means the
  // caller is not touching transport, which is not the same as clearing it,
  // so nothing is written and an existing charge survives the save.
  if (Object.prototype.hasOwnProperty.call(header, 'transport_charge')) {
    const check = validateTransportCharge(header.transport_charge);
    if (!check.valid) {
      const e = new Error(check.error); e.status = 400; e.expose = true; throw e;
    }
    // The rate comes from the LINE ITEMS being stored, not from the caller:
    // delivery is taxed at the principal supply's rate, and letting the
    // browser name that rate would let it choose its own tax.
    const rate = principalGstRate(items);
    const gst = transportGstAmount(check.value, rate);
    if (check.value > 0 && gst === null) {
      const e = new Error(
        'Transport is taxed at the rate of the principal supply, and this invoice does not have '
        + 'a single one — its products carry more than one GST rate (or it has no taxable product). '
        + 'Bill the delivery on its own invoice, or split the products.');
      e.status = 400; e.expose = true; e.code = 'transport_rate_indeterminate'; throw e;
    }
    header.transport_charge = check.value;
    header.transport_gst_amount = gst;
  } else {
    // Never writable on its own: the tax exists only as a function of the
    // charge, so a payload naming it without the charge is refused rather
    // than quietly storing a figure nothing derived.
    delete header.transport_gst_amount;
  }

  const headerCols = TABLES[table].columns.filter(c => c !== 'id' && c !== 'user_id' && header && Object.prototype.hasOwnProperty.call(header, c));
  const itemCols = TABLES.invoice_items.columns.filter(c => !['id','user_id','invoice_id','invoice_type','sort_order','created_at','updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let invoiceId = editId;
    let oldItems = [];
    // Checked before the first write: a mismatched selection must leave the
    // invoice, the stock and the units exactly as they were.
    const serialPlan = await planInvoiceSerials(client, req.userId, items);

    if (editId) {
      const values = headerCols.map(c => header[c]);
      const setClause = headerCols.map((c, i) => `${c} = $${i + 1}`).join(',');
      const { rows } = await client.query(
        `UPDATE ${table} SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING id`,
        [...values, editId, req.userId]
      );
      if (!rows.length) { const e = new Error('Invoice not found.'); e.status = 404; e.expose = true; throw e; }
      invoiceId = rows[0].id;

      const { rows: oldRows } = await client.query(
        'SELECT product_id, quantity FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
        [editId, type, req.userId]
      );
      oldItems = oldRows;
    } else {
      const payload = { ...header, user_id: req.userId };
      const cols = headerCols.concat('user_id');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      const { rows } = await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
      invoiceId = rows[0].id;
    }

    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3', [invoiceId, type, req.userId]);

    const savedItems = [];
    const newQtyByProduct = {};
    // What the ledger records each movement was counted and priced in,
    // gathered from the lines as they are written.
    const unitByProduct = {};
    const rateByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const payload = { ...items[i], user_id: req.userId, invoice_id: invoiceId, invoice_type: type, sort_order: i };
      const cols = itemCols.concat(['user_id', 'invoice_id', 'invoice_type', 'sort_order']).filter(c => Object.prototype.hasOwnProperty.call(payload, c));
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      const { rows: itemRows } = await client.query(
        `INSERT INTO invoice_items (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
      // Kept for the warranty sync below: the register stores the line's id,
      // and every save re-creates these rows with new ones.
      savedItems.push({ ...payload, id: itemRows[0].id });
      if (payload.product_id) {
        newQtyByProduct[payload.product_id] = (newQtyByProduct[payload.product_id] || 0) + (+payload.quantity || 0);
        unitByProduct[payload.product_id] = payload.unit;
        rateByProduct[payload.product_id] = payload.rate;
      }
    }

    // The units this invoice sells, settled BEFORE the quantity moves.
    // Order matters for the message the user gets: run the other way round,
    // a sale of a unit that is already sold fails as "insufficient stock",
    // which is true but useless — the person needs to be told WHICH serial
    // is unavailable, not that the shelf is empty.
    const serials = await applyInvoiceSerials(client, req.userId, type, invoiceId, serialPlan);

    // Serialised goods move a unit at a time so each movement can name the
    // unit it moved; a counted product nets, exactly as before. One row of
    // three can only carry one serial_id, which is why three units bought
    // are three movements of one.
    //
    // The arithmetic is identical either way — three of one come to the
    // same balance as one of three — and it is the SAME applyStockDelta.
    // There is no second stock engine here.
    for (const row of serials.sold || []) {
      await applyStockDelta(client, req.userId, row.product_id, -1, {
        type: 'SALE', sourceType: type, sourceId: invoiceId, serialId: row.id
      });
    }
    for (const row of serials.released || []) {
      await applyStockDelta(client, req.userId, row.product_id, 1, {
        type: 'SALE', sourceType: type, sourceId: invoiceId, serialId: row.id,
        reason: 'Serial removed from the invoice', locationId: row.location_id || null
      });
    }
    // Those products are accounted for one unit at a time above; netting
    // their quantity again below would move the same goods twice.
    const serialProducts = new Set(
      (serialPlan ? serialPlan.wanted.map(l => l.productId) : [])
        .concat([...(serials.sold || []), ...(serials.released || [])].map(r => r.product_id)));

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
      if (serialProducts.has(pid)) continue;
      // A sale decrements stock — delta here is "more sold" (positive =
      // stock should go down), so it's applied negated, same sign
      // convention the old client-side applyStockDeltaForSave() used.
      const delta = (newQtyByProduct[pid] || 0) - (oldQtyByProduct[pid] || 0);
      // One movement per product per save, carrying the NET change. On a
      // first save that net IS the whole quantity; on an edit from 5 to 8
      // it is the extra 3. Re-saving an unchanged invoice gives a delta of
      // zero and writes no row at all - a stronger idempotency guarantee
      // than a reversal pair that merely nets to zero.
      if (delta) await applyStockDelta(client, req.userId, pid, -delta, {
        type: 'SALE', sourceType: type, sourceId: invoiceId,
        unit: unitByProduct[pid], rate: rateByProduct[pid]
      });
    }

    // ── Warranty register ──
    // Inside the transaction and after the lines exist, so a warranty can
    // only survive if the invoice did, and a number drawn here rolls back
    // with it. Reconciles rather than inserts, so saving the same invoice
    // twice cannot produce a second record for a line.
    //
    // Descriptive only: it reads the lines and writes to warranties, and
    // moves no total, tax column, sequence, payment or stock quantity.
    const warranty = await syncWarrantiesForInvoice(
      client, req.userId, type, invoiceId, header, savedItems, reserveDocumentNumberOn);

    await client.query('COMMIT');
    res.json({ invoiceId, warranty, serials });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 2) Reserve the next Auto Generate invoice number, one transaction ──
router.post('/reserve-number', asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the profile row FIRST, serializing concurrent reservations for
    // this user — the taken-numbers scan below only runs once that lock
    // is held, so two simultaneous saves can never both read the same
    // "next" number before either commits (reading before locking would
    // reopen exactly the race this transaction exists to close).
    const { rows: profRows } = await client.query(
      `SELECT invoice_number_format, invoice_current_sequence,
              invoice_series_sequences, invoice_series_formats
         FROM profiles WHERE id = $1 FOR UPDATE`, [req.userId]
    );

    // Each series counts on its own AND is written its own way. The shop
    // counter reaching 170 must not push the website's next number past
    // 5, and the website's numbers are W-00005, not 5.
    //
    // The offline series keeps using invoice_number_format and
    // invoice_current_sequence — the format and counter that existed
    // before series did — so a business already on Auto Generate carries
    // on issuing exactly what it issued yesterday. Every other series
    // reads its own entry in invoice_series_formats /
    // invoice_series_sequences.
    const series = normaliseSource(req.body && req.body.source);
    const format = invoiceSeriesFormat(profRows[0], series);
    const seriesSeqs = profRows[0]?.invoice_series_sequences || {};
    const storedSeq = series === DEFAULT_INVOICE_SOURCE
      ? profRows[0]?.invoice_current_sequence
      : seriesSeqs[series];
    let seq = Math.max(1, parseInt(storedSeq, 10) || 1);

    // Only this series' numbers are "taken". Two series may legitimately
    // both hold a 5 — they are different documents in different books.
    const [{ rows: b2bRows }, { rows: b2cRows }] = await Promise.all([
      client.query('SELECT invoice_number FROM b2b_invoices WHERE user_id = $1 AND invoice_source = $2', [req.userId, series]),
      client.query('SELECT invoice_number FROM b2c_invoices WHERE user_id = $1 AND invoice_source = $2', [req.userId, series])
    ]);
    const taken = new Set([...b2bRows, ...b2cRows].map(r => (r.invoice_number || '').toUpperCase()));

    let candidate = applyInvoiceNumberFormat(format, seq);
    let guard = 0;
    while (taken.has(candidate.toUpperCase()) && guard < 100000) {
      seq++;
      candidate = applyInvoiceNumberFormat(format, seq);
      guard++;
    }
    if (guard >= 100000) candidate = candidate + '-' + Date.now(); // pathological format (no #) — guarantee uniqueness anyway

    if (series === DEFAULT_INVOICE_SOURCE) {
      await client.query('UPDATE profiles SET invoice_current_sequence = $1 WHERE id = $2', [seq + 1, req.userId]);
    } else {
      await client.query(
        `UPDATE profiles
            SET invoice_series_sequences = COALESCE(invoice_series_sequences, '{}'::jsonb) || jsonb_build_object($1::text, $2::int)
          WHERE id = $3`, [series, seq + 1, req.userId]);
    }
    await client.query('COMMIT');
    res.json({ invoiceNumber: candidate, source: series, format });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 2b) Bulk-move a set of invoices into one numbering series ──
//
// The one-time tool for a business that was already running two books
// before the app could record which was which — website orders 4 to 25
// sitting in the shop series because that is where the migration
// defaulted every existing invoice. Opening twenty-two invoices to
// change one field each is not a reasonable way to correct that.
//
// The ids are chosen on the client, where the invoice-number ordering
// lives (js/utils.js's compareInvoiceNumbers, the same comparator the
// GSTR-1 export uses to decide a series' from/to range) — so the range
// the operator previewed is exactly the set that moves, with no second
// implementation of that ordering in SQL to drift from it.
//
// invoice_source is the ONLY column written. Nothing here touches an
// invoice number, date, customer, tax figure or total, and no line item
// or HSN row is read at all.
router.post('/series-migration', asyncRoute(async (req, res) => {
  const { b2b = [], b2c = [], source, rangeFrom = '', rangeTo = '' } = req.body || {};
  const series = normaliseSource(source);
  if (!Array.isArray(b2b) || !Array.isArray(b2c)) {
    const e = new Error('Invoice ids must be arrays.'); e.status = 400; e.expose = true; throw e;
  }
  [...b2b, ...b2c].forEach(badId);
  if (!b2b.length && !b2c.length) {
    const e = new Error('No invoices were selected to move.'); e.status = 400; e.expose = true; throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Read the current state first, inside the transaction and scoped to
    // this user, so the log records what actually moved rather than what
    // the client believed was there. Rows belonging to anyone else simply
    // do not come back, and are therefore never updated below.
    const moved = [];
    const oldSources = {};
    for (const [table, ids] of [['b2b_invoices', b2b], ['b2c_invoices', b2c]]) {
      if (!ids.length) continue;
      const { rows } = await client.query(
        `SELECT id, invoice_number, invoice_source FROM ${table}
          WHERE id = ANY($1::uuid[]) AND user_id = $2 AND invoice_source IS DISTINCT FROM $3
          FOR UPDATE`,
        [ids, req.userId, series]
      );
      rows.forEach(r => {
        moved.push(r.invoice_number);
        const from = r.invoice_source || DEFAULT_INVOICE_SOURCE;
        oldSources[from] = (oldSources[from] || 0) + 1;
      });
      if (rows.length) {
        await client.query(
          `UPDATE ${table} SET invoice_source = $1 WHERE id = ANY($2::uuid[]) AND user_id = $3`,
          [series, rows.map(r => r.id), req.userId]
        );
      }
    }

    // Logged even when nothing moved: that a range was examined and found
    // to need no change is part of the same record.
    const { rows: logRows } = await client.query(
      `INSERT INTO invoice_series_migrations
         (user_id, range_from, range_to, old_sources, new_source, invoice_count, invoice_numbers)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) RETURNING id, created_at`,
      [req.userId, String(rangeFrom), String(rangeTo), JSON.stringify(oldSources),
       series, moved.length, JSON.stringify(moved)]
    );

    await client.query('COMMIT');
    res.json({ updated: moved.length, invoiceNumbers: moved, oldSources, newSource: series,
               migrationId: logRows[0].id, at: logRows[0].created_at });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 3) Permanent delete cascade — invoice_items + HSN + stock reversal,
// one transaction. The invoice HEADER row's own delete happens
// separately via the generic router's plain (already permanent)
// DELETE (js/invoice-list.js does that call itself) — this endpoint
// only ever touches the DOWNSTREAM rows a header delete cascades to.
router.post('/:type/:id/cascade-delete', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const { type, id } = req.params;
  badId(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: items } = await client.query(
      'SELECT id, product_id, quantity, unit, rate FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
      [id, type, req.userId]
    );
    // Deleting a sale gives back exactly what it took, once: the line rows
    // go in the same transaction, so a repeated call finds nothing to
    // reverse and moves nothing.
    // The units this invoice sold, read before anything is reversed so
    // each can be given back with its own movement.
    const soldUnits = await serialsSvc.serialsSoldBy(client, req.userId, type, id);
    const serialProducts = new Set(soldUnits.map(r => r.product_id));

    for (const it of items) {
      if (serialProducts.has(it.product_id)) continue;   // handled per unit below
      await applyStockDelta(client, req.userId, it.product_id, +it.quantity || 0, {
        type: 'SALE', sourceType: type, sourceId: id, sourceItemId: it.id,
        unit: it.unit, rate: it.rate, reason: 'Invoice deleted'
      });
    }
    for (const row of soldUnits) {
      await applyStockDelta(client, req.userId, row.product_id, 1, {
        type: 'SALE', sourceType: type, sourceId: id,
        reason: 'Invoice deleted', serialId: row.id
      });
    }

    // Every unit this invoice sold comes back to stock, exactly those and
    // once. A unit already RETURNED through a sales return has moved on and
    // is left alone by unsellSerials.
    if (soldUnits.length) await serialsSvc.unsellSerials(client, req.userId, soldUnits);

    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3', [id, type, req.userId]);
    await client.query(
      `DELETE FROM ${hsnTable(type)} WHERE source_invoice_id = $1 AND source_invoice_type = $2 AND user_id = $3`,
      [id, type, req.userId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, serials_released: soldUnits.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
module.exports.applyStockDelta = applyStockDelta;
