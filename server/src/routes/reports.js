// Report exports that are too large to assemble in the browser.
//
// The GSTR-1 page builds its four existing sheets from rows it already
// holds. The Complete Invoice Details sheet cannot work that way: it is
// one row per invoice LINE across both invoice tables, for a whole period,
// and the browser's copy of the data is whatever the page happened to
// load. So this route does the join in Postgres and returns exactly the
// rows the sheet needs — no pagination, no N+1, nothing reconstructed
// from what is on screen.
//
// Every query is scoped to req.userId from the JWT, exactly as the rest of
// the application does it. Nothing here reads a tenant id from the query
// string or the body.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

// A workbook of a whole period is legitimately larger than the 100kb
// express.json() allows by default. Raised for this one route rather than
// globally — see the note beside the parser in app.js.
const WORKBOOK_BODY_LIMIT = '25mb';
const MAX_SHEETS = 12;
const MAX_SHEET_ROWS = 200000;

// A period export is bounded by the period, but a caller can still ask for
// a whole financial year on a busy tenant. This is the point at which we
// would rather say "too large" than build a workbook nobody can open.
const MAX_DETAIL_ROWS = 100000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = new Set(['all', 'b2b', 'b2c']);
const SORTS = new Set(['asc', 'desc']);

function bad(message) {
  const e = new Error(message);
  e.status = 400; e.expose = true;
  return e;
}

// Dates arrive as YYYY-MM-DD and are checked twice: the shape, and then
// that Postgres' own date parser agrees the value is a real calendar date.
// '2026-02-31' passes the regex and must not reach the query.
function checkDate(value, what) {
  const v = String(value || '');
  if (!DATE_RE.test(v)) throw bad(`${what} must be a date in YYYY-MM-DD form.`);
  const [y, m, d] = v.split('-').map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) {
    throw bad(`${what} is not a real calendar date.`);
  }
  return v;
}

// invoice_date is a DATE column, so a period is compared date to date and
// no timezone conversion happens anywhere in this path. August is the
// invoices Postgres stores as August.
//
// The two invoice tables are separate, which is also what makes an invoice
// B2B or B2C — there is no classification formula here to disagree with
// the rest of the app, only the table the row already lives in.
//
// The join carries invoice_type as well as invoice_id. Ids are UUIDs so a
// collision is not the worry; naming both is what guarantees a b2b invoice
// can never pick up a b2c invoice's lines and double its rows.
const INVOICE_COLUMNS = `
      id, invoice_number, invoice_date, customer_name, gst_number, phone,
      state, district, address,
      shipping_state, shipping_district, shipping_address,
      gst_category, reverse_charge, supply_type, payment_status,
      taxable_amount, cgst, sgst, igst, cess_amount, gst_amount,
      total_amount, amount_paid, invoice_source, export_type, created_at`;

function branchSql(table, typeKey, label) {
  return `
    SELECT '${label}'::text AS category, '${typeKey}'::text AS type_key, ${INVOICE_COLUMNS}
      FROM ${table}
     WHERE user_id = $1 AND invoice_date >= $2 AND invoice_date <= $3`;
}

// GET /api/reports/invoice-details?start=&end=&category=&sort=
//
// One row per invoice line, both categories, for the period. Returns the
// counts alongside the rows so the caller can prove the sheet it wrote
// matches what the database actually holds.
router.get('/invoice-details', asyncRoute(async (req, res) => {
  const start = checkDate(req.query.start, 'start');
  const end = checkDate(req.query.end, 'end');
  if (start > end) throw bad('start must not be after end.');

  const category = String(req.query.category || 'all').toLowerCase();
  if (!CATEGORIES.has(category)) throw bad('category must be all, b2b or b2c.');
  const sort = String(req.query.sort || 'asc').toLowerCase();
  if (!SORTS.has(sort)) throw bad('sort must be asc or desc.');

  // The branch list is chosen by code from a validated enum, never built
  // from caller text, and the values themselves are always bound.
  const branches = [];
  if (category === 'all' || category === 'b2b') branches.push(branchSql('b2b_invoices', 'b2b', 'B2B'));
  if (category === 'all' || category === 'b2c') branches.push(branchSql('b2c_invoices', 'b2c', 'B2C'));

  // Ordering is deterministic to the last tiebreak so two exports of the
  // same period are byte-identical. invoice_date leads; created_at is the
  // real order invoices were raised in; sort_order then id keeps a single
  // invoice's own lines in the order they were entered.
  //
  // Only the date direction flips. Lines within an invoice always read
  // top to bottom, because a reversed line order is not what "newest
  // first" means to anyone reading the sheet.
  const dir = sort === 'desc' ? 'DESC' : 'ASC';

  const sql = `
    WITH inv AS (
      ${branches.join('\n    UNION ALL\n')}
    )
    SELECT
      -- The invoice's own id, so a caller can group lines by the invoice
      -- itself. Numbers are unique per (user, invoice_source, number), NOT
      -- per user — two invoices in different sources may legitimately share
      -- a number, and grouping on the number alone would silently merge
      -- them into one.
      inv.id AS invoice_id,
      inv.category, inv.invoice_number,
      -- Formatted in SQL, deliberately. node-postgres turns a DATE into a
      -- JS Date at LOCAL midnight, and res.json() then serialises that to
      -- UTC: east of Greenwich 2026-08-05 leaves here as
      -- "2026-08-04T18:30:00.000Z" and an invoice moves to the previous
      -- day — across a month boundary, into the previous month. Sending
      -- the characters Postgres already holds means no Date object is
      -- ever constructed and there is nothing to convert.
      to_char(inv.invoice_date, 'YYYY-MM-DD') AS invoice_date,
      inv.customer_name, inv.gst_number, inv.phone,
      inv.state, inv.district, inv.address,
      inv.shipping_state, inv.shipping_district, inv.shipping_address,
      inv.gst_category, inv.reverse_charge, inv.supply_type, inv.payment_status,
      inv.taxable_amount AS inv_taxable_amount,
      inv.cgst AS inv_cgst, inv.sgst AS inv_sgst, inv.igst AS inv_igst,
      inv.cess_amount AS inv_cess_amount, inv.gst_amount AS inv_gst_amount,
      inv.total_amount AS inv_total_amount, inv.amount_paid,
      inv.invoice_source, inv.export_type,
      it.product_name, it.product_id, it.hsn_code, it.unit,
      it.quantity, it.rate, it.discount_percentage, it.gst_percentage,
      it.taxable_value, it.gst_amount, it.igst, it.cgst, it.sgst,
      it.cess_rate, it.cess_amount, it.total_amount, it.sort_order,
      p.sku
      FROM inv
      JOIN invoice_items it
        ON it.invoice_id = inv.id
       AND it.invoice_type = inv.type_key
       AND it.user_id = $1
      LEFT JOIN products p
        ON p.id = it.product_id
       AND p.user_id = $1
     ORDER BY inv.invoice_date ${dir}, inv.created_at ${dir}, inv.invoice_number ${dir},
              it.sort_order ASC NULLS LAST, it.created_at ASC, it.id ASC
     LIMIT ${MAX_DETAIL_ROWS + 1}`;

  const { rows } = await pool.query(sql, [req.userId, start, end]);

  if (rows.length > MAX_DETAIL_ROWS) {
    const e = new Error(
      `This period has more than ${MAX_DETAIL_ROWS.toLocaleString('en-IN')} invoice lines, `
      + 'which is too many for one workbook. Export a shorter period.');
    e.status = 413; e.expose = true; throw e;
  }

  // Counted from the same rows the caller receives, so the caller can
  // check its sheet against them without a second round trip. Counted by
  // invoice id rather than by number, for the reason given above the
  // projection: two invoices can share a number across sources.
  const invoiceKeys = new Set(rows.map(r => r.invoice_id));

  res.json({
    rows,
    item_count: rows.length,
    invoice_count: invoiceKeys.size,
    period: { start, end },
    category,
    sort
  });
}));

// ── POST /api/reports/workbook ───────────────────────────────────────
//
// Writes an .xlsx and streams it back. The caller sends the rows it has
// already built; this route decides nothing about their content and reads
// no data of its own, so no sheet's figures can change by passing through
// here. It exists because two things a finished workbook needs — a bold
// header row and a frozen first row — are Pro-only in the SheetJS build the
// browser loads, and ExcelJS (already a dependency here) writes both.
//
// Rows arrive as arrays aligned to `headers`, which is both compact and
// unambiguous about column order.
function badBody(message) {
  const e = new Error(message);
  e.status = 400; e.expose = true;
  return e;
}

// A YYYY-MM-DD string becomes a real Excel date. Built at UTC midnight and
// paired with a display format: constructing it from local parts would put
// the cell an hour either side of midnight and, in some zones, on the day
// before. The API sends these as plain date strings for exactly that reason.
function excelDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

router.post('/workbook', express.json({ limit: WORKBOOK_BODY_LIMIT }),
  asyncRoute(async (req, res) => {
    const { filename, sheets } = req.body || {};
    if (!Array.isArray(sheets) || !sheets.length) throw badBody('A workbook needs at least one sheet.');
    if (sheets.length > MAX_SHEETS) throw badBody(`A workbook cannot have more than ${MAX_SHEETS} sheets.`);

    // Excel's own rules for a sheet name, applied here so a bad name fails
    // as a clear 400 rather than a corrupt file.
    const safeName = (n, i) => {
      const name = String(n == null ? '' : n).trim();
      if (!name) throw badBody(`Sheet ${i + 1} has no name.`);
      if (name.length > 31) throw badBody(`Sheet name "${name}" is longer than Excel allows.`);
      if (/[*?:\\/\[\]]/.test(name)) throw badBody(`Sheet name "${name}" uses a character Excel forbids.`);
      return name;
    };

    const wb = new ExcelJS.Workbook();
    wb.created = new Date();

    sheets.forEach((sheet, i) => {
      const name = safeName(sheet && sheet.name, i);
      const headers = Array.isArray(sheet.headers) ? sheet.headers.map(h => String(h == null ? '' : h)) : [];
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      if (!headers.length) throw badBody(`Sheet "${name}" has no header row.`);
      if (rows.length > MAX_SHEET_ROWS) throw badBody(`Sheet "${name}" has too many rows.`);

      const ws = wb.addWorksheet(name);
      // Keys are positional: a header like "GST %" or "HSN/SAC" is a label,
      // not an identifier, and must reach the sheet exactly as given.
      ws.columns = headers.map((h, c) => ({
        header: h,
        key: 'c' + c,
        width: (sheet.widths && sheet.widths[c] && sheet.widths[c].wch) || Math.min(Math.max(h.length + 2, 10), 40)
      }));

      const dateCols = new Set((Array.isArray(sheet.dateColumns) ? sheet.dateColumns : [])
        .map(h => headers.indexOf(h)).filter(idx => idx >= 0));

      // How a column should DISPLAY, by header name. It never changes a
      // value or its type — a money column still has to arrive as a JSON
      // number to be one here. This exists so 1700 can read as "1700.00"
      // while staying a number Excel can sum, which a string "1700.00"
      // never is.
      //
      // Only applied to cells that really are numbers or dates: a format
      // on a text cell is meaningless, and silently formatting one would
      // hide the fact that a value arrived as text when it should not have.
      const fmts = (sheet.numberFormats && typeof sheet.numberFormats === 'object'
        && !Array.isArray(sheet.numberFormats)) ? sheet.numberFormats : {};
      const fmtByCol = new Map();
      headers.forEach((h, c) => {
        if (!Object.prototype.hasOwnProperty.call(fmts, h)) return;
        const f = String(fmts[h]);
        if (!f || f.length > 40) throw badBody(`Sheet "${name}" has an unusable number format for "${h}".`);
        fmtByCol.set(c, f);
      });

      for (const row of rows) {
        const values = Array.isArray(row) ? row : [];
        const added = ws.addRow(headers.map((_, c) => {
          const v = values[c];
          if (dateCols.has(c)) return excelDate(v) || (v == null ? null : v);
          return v === undefined ? null : v;
        }));
        // Numbers and strings keep the type JSON gave them; only the date
        // columns need telling how to render.
        for (const c of dateCols) {
          const cell = added.getCell(c + 1);
          if (cell.value instanceof Date) cell.numFmt = fmtByCol.get(c) || 'dd-mm-yyyy';
        }
        for (const [c, f] of fmtByCol) {
          if (dateCols.has(c)) continue;            // already given its format above
          const cell = added.getCell(c + 1);
          if (typeof cell.value === 'number') cell.numFmt = f;
        }
      }

      // The two things this route exists for.
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];

      if (sheet.autofilter && rows.length) {
        ws.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: rows.length + 1, column: headers.length }
        };
      }
    });

    const buffer = await wb.xlsx.writeBuffer();
    const base = String(filename || 'report').replace(/[^A-Za-z0-9_-]/g, '') || 'report';
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    res.send(Buffer.from(buffer));
  }));

module.exports = router;
