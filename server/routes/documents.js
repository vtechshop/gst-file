// Vouchers and self invoices (Phase 2, Module 4B-impl).
//
// Three things the generic CRUD router cannot do for these documents,
// each needing a transaction or a rule the router has no opinion about:
//
//   1. POST /documents/reserve-number  — issue the next number from a
//      document type's own numbering book, serialized the same way
//      invoice numbering is.
//   2. POST /documents/:type/save      — write the document AND its
//      audit entry in one transaction, so a document can never exist
//      without a record of who made it.
//   3. POST /documents/:type/:id/cancel — cancel rather than delete,
//      because GSTR-1 Table 13 counts cancelled documents and a deleted
//      one cannot be counted.
//
// The server keeps its own small map of document type to table below.
// That is a deliberate mirror of the registry in js/utils.js, the same
// arrangement validation.js has with the GSTIN checksum: two runtimes,
// no shared bundle, so the alternative is shipping the browser registry
// to the server, and the alternative to THAT is trusting a table name
// sent by a client, which is not an option.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { applyInvoiceNumberFormat } = require('../utils/invoiceNumberFormat');
const { TABLES } = require('./generic');

const router = express.Router();
router.use(requireAuth);

// documentType -> { table, series }. `series` mirrors the registry's
// field of the same name and is the numbering book the type draws from.
// Where a type has line items, `items` names the child table and `itemsFk`
// the column pointing back. Documents without items simply omit both.
//
// The four delivery challan variants share one TABLE but have four
// separate numbering books, because they report as four separate Table 13
// rows and a shared book would interleave their ranges. The uniqueness
// check below filters on (table, series), so each book counts only its
// own. `stamp` records the registry key on each row so Table 13 can tell
// the variants apart without anything having to list them.
//
// These `series` values mirror the registry in js/utils.js and must match
// it — a test asserts they do, so the two cannot drift.
const DOCUMENT_TABLES = {
  self_invoice:    { table: 'self_invoices',    series: 'self_invoice' },
  receipt_voucher: { table: 'receipt_vouchers', series: 'receipt_voucher' },
  payment_voucher: { table: 'payment_vouchers', series: 'payment_voucher' },
  refund_voucher:  { table: 'refund_vouchers',  series: 'refund_voucher' },

  revised_invoice: { table: 'revised_invoices', series: 'revised_invoice',
                     items: 'revised_invoice_items', itemsFk: 'revised_invoice_id' },

  bill_of_supply:  { table: 'bill_of_supply', series: 'bill_of_supply',
                     items: 'bill_of_supply_items', itemsFk: 'bill_of_supply_id' },

  dc_job_work:     { table: 'delivery_challans', series: 'dc_job_work',
                     items: 'delivery_challan_items', itemsFk: 'challan_id', stamp: 'dc_job_work' },
  dc_approval:     { table: 'delivery_challans', series: 'dc_approval',
                     items: 'delivery_challan_items', itemsFk: 'challan_id', stamp: 'dc_approval' },
  dc_liquid_gas:   { table: 'delivery_challans', series: 'dc_liquid_gas',
                     items: 'delivery_challan_items', itemsFk: 'challan_id', stamp: 'dc_liquid_gas' },
  dc_other:        { table: 'delivery_challans', series: 'dc_other',
                     items: 'delivery_challan_items', itemsFk: 'challan_id', stamp: 'dc_other' }
};

// The default numbering format for a document type that has none
// configured. Same shape rule the invoice series defaults follow: an
// initial and five digits, correctable in Settings.
//
// Keyed by series rather than by type, because the numbering book is what
// a format belongs to. Today every type has a book to itself; if two were
// ever pointed at one book they would share one format and one run of
// numbers, which is the behaviour that keying by series gives for free.
const DEFAULT_DOCUMENT_FORMATS = {
  self_invoice:    'SI-#####',
  receipt_voucher: 'RV-#####',
  payment_voucher: 'PV-#####',
  refund_voucher:  'RF-#####',
  revised_invoice: 'RI-#####',
  bill_of_supply:  'BOS-#####',
  // One per challan book, so each variant's numbers are visibly its own
  // rather than four prefixes competing for one run of digits.
  dc_job_work:     'JW-#####',
  dc_approval:     'AP-#####',
  dc_liquid_gas:   'LG-#####',
  dc_other:        'DC-#####'
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function docSpec(type) {
  const spec = DOCUMENT_TABLES[String(type || '').trim().toLowerCase()];
  if (!spec) {
    const e = new Error(`Unknown document type "${type}".`);
    e.status = 400; e.expose = true; throw e;
  }
  return spec;
}

function badId(id) {
  if (!UUID_RE.test(id)) { const e = new Error('Invalid document id.'); e.status = 400; e.expose = true; throw e; }
}

// Every write lands an audit entry in the same transaction as the write
// itself, so a document can never exist without a record of how it got
// there — and a rolled-back write leaves no orphan log line either.
async function writeAudit(client, userId, type, table, id, number, action, changes) {
  await client.query(
    `INSERT INTO document_audit_log
       (user_id, document_type, document_table, document_id, document_number, action, changes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [userId, type, table, id, number || null, action, JSON.stringify(changes || {})]
  );
}

// ── 1) Reserve the next number for a document type ──
//
// Deliberately separate from POST /invoices/reserve-number: that one
// counts invoices per invoice_source and must keep doing exactly that.
// This counts documents per document type, from its own columns on
// profiles, and cannot move an invoice counter by a single digit.
router.post('/reserve-number', asyncRoute(async (req, res) => {
  const { table, series } = docSpec(req.body && req.body.documentType);
  const type = String(req.body.documentType).trim().toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the profile row first, so two simultaneous saves cannot both
    // read the same "next" number — the same ordering the invoice
    // reservation uses, and for the same reason.
    const { rows: prof } = await client.query(
      `SELECT document_series_sequences, document_series_formats
         FROM profiles WHERE id = $1 FOR UPDATE`, [req.userId]);
    const seqs = prof[0]?.document_series_sequences || {};
    const formats = prof[0]?.document_series_formats || {};
    // Series first: the numbering book decides the format. Where a type's
    // series and key are the same word — every voucher — this reads
    // exactly as it did before; where they differ, the book still wins.
    const format = (formats[series] && String(formats[series]).trim())
      || DEFAULT_DOCUMENT_FORMATS[series] || DEFAULT_DOCUMENT_FORMATS[type] || 'DOC-#####';
    let seq = Math.max(1, parseInt(seqs[series], 10) || 1);

    // Only this book's numbers are taken. A receipt voucher numbered 5
    // does not stop a payment voucher being numbered 5.
    const { rows: taken } = await client.query(
      `SELECT document_number FROM ${table} WHERE user_id = $1 AND document_series = $2`,
      [req.userId, series]);
    const used = new Set(taken.map(r => (r.document_number || '').toUpperCase()));

    let candidate = applyInvoiceNumberFormat(format, seq);
    let guard = 0;
    while (used.has(candidate.toUpperCase()) && guard < 100000) {
      seq++; candidate = applyInvoiceNumberFormat(format, seq); guard++;
    }

    await client.query(
      `UPDATE profiles
          SET document_series_sequences =
              COALESCE(document_series_sequences, '{}'::jsonb) || jsonb_build_object($1::text, $2::int)
        WHERE id = $3`, [series, seq + 1, req.userId]);
    await client.query('COMMIT');
    res.json({ documentNumber: candidate, series, format });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 2) Create or update a document, with its audit entry ──
router.post('/:type/save', asyncRoute(async (req, res) => {
  const type = String(req.params.type).trim().toLowerCase();
  const spec = docSpec(type);
  const { table } = spec;
  const { editId, document, items } = req.body || {};
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    const e = new Error('The document is missing or malformed.'); e.status = 400; e.expose = true; throw e;
  }
  if (editId) badId(editId);
  if (items != null && !Array.isArray(items)) {
    const e = new Error('Items must be a list.'); e.status = 400; e.expose = true; throw e;
  }

  // Which variant this is comes from the URL, never from the body — a
  // client cannot file a job-work challan under another Table 13 row by
  // sending a different document_type.
  if (spec.stamp) document.document_type = spec.stamp;
  // Likewise the numbering book: a client cannot move a document into
  // another book by sending a different document_series.
  if (spec.series) document.document_series = spec.series;

  const allowed = TABLES[table].columns.filter(c =>
    c !== 'id' && c !== 'user_id' && c !== 'created_at' && c !== 'updated_at' &&
    Object.prototype.hasOwnProperty.call(document, c));
  if (!allowed.length) {
    const e = new Error('Nothing to save.'); e.status = 400; e.expose = true; throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let row;
    if (editId) {
      const setClause = allowed.map((c, i) => `${c} = $${i + 1}`).join(',');
      const values = allowed.map(c => document[c]);
      const { rows } = await client.query(
        `UPDATE ${table} SET ${setClause} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} RETURNING *`,
        [...values, editId, req.userId]);
      if (!rows.length) { const e = new Error('Document not found.'); e.status = 404; e.expose = true; throw e; }
      row = rows[0];
      await writeAudit(client, req.userId, type, table, row.id, row.document_number, 'updated',
        Object.fromEntries(allowed.map(c => [c, document[c]])));
    } else {
      const cols = allowed.concat('user_id');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const values = cols.map(c => (c === 'user_id' ? req.userId : document[c]));
      const { rows } = await client.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, values);
      row = rows[0];
      await writeAudit(client, req.userId, type, table, row.id, row.document_number, 'created', {});
    }

    // Line items are replaced wholesale rather than merged: a challan's
    // lines are the challan, and reconciling them one by one would let a
    // half-applied edit through if anything failed midway. Same
    // transaction as the document, so either both land or neither does.
    let savedItems = [];
    if (spec.items && Array.isArray(items)) {
      await client.query(`DELETE FROM ${spec.items} WHERE ${spec.itemsFk} = $1 AND user_id = $2`,
        [row.id, req.userId]);
      const itemCols = TABLES[spec.items].columns.filter(c =>
        c !== 'id' && c !== 'user_id' && c !== 'created_at' && c !== 'updated_at' && c !== spec.itemsFk);
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const cols = itemCols.filter(c => Object.prototype.hasOwnProperty.call(it, c));
        if (!cols.length) continue;
        const all = cols.concat([spec.itemsFk, 'user_id']);
        const placeholders = all.map((_, n) => `$${n + 1}`).join(',');
        const values = all.map(c => (c === spec.itemsFk ? row.id : c === 'user_id' ? req.userId : it[c]));
        const { rows: ir } = await client.query(
          `INSERT INTO ${spec.items} (${all.join(',')}) VALUES (${placeholders}) RETURNING *`, values);
        savedItems.push(ir[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ document: row, items: savedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 3) Cancel, rather than delete ──
//
// GSTR-1 Table 13 reports how many documents were issued AND how many
// were cancelled. A deleted document cannot be counted in either, so a
// cancelled one keeps its row and its number — which also stops the
// number being silently reissued.
router.post('/:type/:id/cancel', asyncRoute(async (req, res) => {
  const type = String(req.params.type).trim().toLowerCase();
  const spec = docSpec(type);
  const { table } = spec;
  badId(req.params.id);

  // The registry decides what may be cancelled. Every type built so far
  // may be, so this refuses nothing today — it is here so a type that
  // must not be cancellable cannot be cancelled through this route by
  // omission.
  if (spec.cancellable === false) {
    const e = new Error(`A ${type.replace(/_/g, ' ')} cannot be cancelled.`);
    e.status = 409; e.expose = true; throw e;
  }

  // Tables that record when and why keep that; the others just change
  // status. Driven off the column list so neither has a special case.
  const cols = TABLES[table].columns;
  const stamps = [];
  if (cols.includes('cancelled_at')) stamps.push(`cancelled_at = NOW()`);
  if (cols.includes('cancel_reason')) stamps.push(`cancel_reason = $3`);
  const extra = stamps.length ? ', ' + stamps.join(', ') : '';
  const params = [req.params.id, req.userId];
  if (cols.includes('cancel_reason')) params.push((req.body && req.body.reason) || '');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE ${table} SET status = 'cancelled'${extra}
        WHERE id = $1 AND user_id = $2 AND status <> 'cancelled' RETURNING *`,
      params);
    if (!rows.length) {
      const e = new Error('Document not found, or already cancelled.'); e.status = 404; e.expose = true; throw e;
    }
    await writeAudit(client, req.userId, type, table, rows[0].id, rows[0].document_number,
      'cancelled', { reason: (req.body && req.body.reason) || '' });
    await client.query('COMMIT');
    res.json({ document: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── 4) Delete, only where nothing depends on the document ──
//
// A cancelled document is the normal way to withdraw one. Deletion is
// for a mistake made and caught immediately, and is refused where
// another document points at this one — a payment voucher settles a self
// invoice, a refund voucher reverses a receipt voucher, and removing the
// referenced document would leave the other explaining nothing.
router.delete('/:type/:id', asyncRoute(async (req, res) => {
  const type = String(req.params.type).trim().toLowerCase();
  const { table } = docSpec(type);
  badId(req.params.id);

  const dependants = {
    self_invoice:    [{ table: 'payment_vouchers', column: 'self_invoice_id', label: 'payment voucher' }],
    receipt_voucher: [{ table: 'refund_vouchers',  column: 'receipt_voucher_id', label: 'refund voucher' }]
  }[type] || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const dep of dependants) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${dep.table} WHERE ${dep.column} = $1 AND user_id = $2`,
        [req.params.id, req.userId]);
      if (rows[0].n) {
        const e = new Error(
          `${rows[0].n} ${dep.label}${rows[0].n === 1 ? '' : 's'} refer${rows[0].n === 1 ? 's' : ''} to this document — cancel it instead of deleting it.`);
        e.status = 409; e.expose = true; throw e;
      }
    }
    const { rows } = await client.query(
      `DELETE FROM ${table} WHERE id = $1 AND user_id = $2 RETURNING id, document_number`,
      [req.params.id, req.userId]);
    if (!rows.length) { const e = new Error('Document not found.'); e.status = 404; e.expose = true; throw e; }
    await writeAudit(client, req.userId, type, table, rows[0].id, rows[0].document_number, 'deleted', {});
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
module.exports.DOCUMENT_TABLES = DOCUMENT_TABLES;
module.exports.DEFAULT_DOCUMENT_FORMATS = DEFAULT_DOCUMENT_FORMATS;
