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
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { applyInvoiceNumberFormat, invoiceSeriesFormat } = require('../utils/invoiceNumberFormat');
const { TABLES } = require('./generic');

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

// Row-locks the product (FOR UPDATE) before adjusting stock — this is
// the actual race-safety upgrade over the old client-side read-then-write
// loop, which had no way to prevent two concurrent saves from reading
// the same stale stock value.
async function applyStockDelta(client, userId, productId, deltaQty) {
  if (!productId || !deltaQty) return;
  const { rows } = await client.query('SELECT stock FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE', [productId, userId]);
  if (!rows.length || rows[0].stock === null) return; // not stock-tracked
  const next = Math.round((+rows[0].stock + deltaQty) * 1000) / 1000;
  await client.query('UPDATE products SET stock = $1 WHERE id = $2', [next, productId]);
}

// ── 1) Save invoice header + line items + stock, one transaction ──
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

  // Whatever the client sends, the stored series is lower-cased and
  // never blank, so 'Online', 'online' and ' Online ' are one series and
  // an omitted source is the shop series.
  if (Object.prototype.hasOwnProperty.call(header, 'invoice_source')) {
    header.invoice_source = normaliseSource(header.invoice_source);
  }

  const headerCols = TABLES[table].columns.filter(c => c !== 'id' && c !== 'user_id' && header && Object.prototype.hasOwnProperty.call(header, c));
  const itemCols = TABLES.invoice_items.columns.filter(c => !['id','user_id','invoice_id','invoice_type','sort_order','created_at','updated_at'].includes(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let invoiceId = editId;
    let oldItems = [];

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

    const newQtyByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const payload = { ...items[i], user_id: req.userId, invoice_id: invoiceId, invoice_type: type, sort_order: i };
      const cols = itemCols.concat(['user_id', 'invoice_id', 'invoice_type', 'sort_order']).filter(c => Object.prototype.hasOwnProperty.call(payload, c));
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(',');
      const values = cols.map(c => payload[c]);
      await client.query(`INSERT INTO invoice_items (${cols.join(',')}) VALUES (${placeholders})`, values);
      if (payload.product_id) newQtyByProduct[payload.product_id] = (newQtyByProduct[payload.product_id] || 0) + (+payload.quantity || 0);
    }

    const oldQtyByProduct = {};
    oldItems.forEach(r => { if (r.product_id) oldQtyByProduct[r.product_id] = (oldQtyByProduct[r.product_id] || 0) + (+r.quantity || 0); });

    const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
    for (const pid of productIds) {
      // A sale decrements stock — delta here is "more sold" (positive =
      // stock should go down), so it's applied negated, same sign
      // convention the old client-side applyStockDeltaForSave() used.
      const delta = (newQtyByProduct[pid] || 0) - (oldQtyByProduct[pid] || 0);
      if (delta) await applyStockDelta(client, req.userId, pid, -delta);
    }

    await client.query('COMMIT');
    res.json({ invoiceId });
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
      'SELECT product_id, quantity FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
      [id, type, req.userId]
    );
    for (const it of items) await applyStockDelta(client, req.userId, it.product_id, +it.quantity || 0);

    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3', [id, type, req.userId]);
    await client.query(
      `DELETE FROM ${hsnTable(type)} WHERE source_invoice_id = $1 AND source_invoice_type = $2 AND user_id = $3`,
      [id, type, req.userId]
    );
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
module.exports.applyStockDelta = applyStockDelta;
