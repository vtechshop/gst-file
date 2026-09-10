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

// ── GET /api/reports/product-sales ───────────────────────────────────
//
// "How many of each machine did we sell this month." One row per PRODUCT,
// not per invoice and not per line.
//
// Counted from the invoices themselves — invoice_items joined to the two
// invoice tables — and never from products.stock, stock_balances or
// stock_movements. Those describe what is on the shelf, which is a
// different question and answers it differently the moment anything is
// adjusted, damaged, transferred or reconciled.
//
// Deleting an invoice deletes its lines (routes/invoices.js cascade), and
// saving one replaces them, so the rows this reads are always the CURRENT
// state of the current invoices. An invoice edited from 5 to 8 reports 8;
// a deleted invoice reports nothing. There is no soft-delete or cancelled
// flag on either invoice table, so "valid" is simply "still there" — the
// same rule the invoice-details report above already uses.
const MONTHS_ALL = 'all';
const PRODUCT_SORTS = new Map([
  // Every ordering is chosen from this map by key. Nothing a caller sends
  // reaches the SQL text.
  //
  // Each carries a full tiebreak so two runs of the same report cannot
  // disagree about the order of two products with equal quantities.
  ['qty_desc', 'sold_qty DESC, display_name ASC, gkey ASC'],
  ['qty_asc', 'sold_qty ASC, display_name ASC, gkey ASC'],
  ['name_asc', 'display_name ASC, gkey ASC'],
  ['name_desc', 'display_name DESC, gkey ASC']
]);

// A tenant with a very large catalogue could ask for a whole year. This is
// the point at which saying "too large" beats returning a page nobody
// asked for — the report is explicitly all-or-nothing, because a silently
// truncated quantity report is a wrong quantity report.
const MAX_PRODUCT_ROWS = 20000;

// The last day of a month, without constructing a local Date: day 0 of the
// next month is the last of this one, in UTC.
function monthRange(year, month) {
  if (month === MONTHS_ALL) return [`${year}-01-01`, `${year}-12-31`];
  const end = new Date(Date.UTC(year, month, 0));
  const mm = String(month).padStart(2, '0');
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(end.getUTCDate()).padStart(2, '0')}`];
}

// A quantity leaves Postgres as a NUMERIC string ("20.000"). Excel needs a
// real number, and so does any comparison here, so it is converted once —
// and rounded to the three decimals the column actually stores, so binary
// floating point cannot turn 17.999999999 into a report figure.
function qtyNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

router.get('/product-sales', asyncRoute(async (req, res) => {
  const yearRaw = String(req.query.year || '');
  if (!/^\d{4}$/.test(yearRaw)) throw bad('year must be a four-digit year.');
  const year = Number(yearRaw);
  if (year < 2000 || year > 2100) throw bad('year must be between 2000 and 2100.');

  const monthRaw = String(req.query.month == null || req.query.month === '' ? MONTHS_ALL : req.query.month)
    .toLowerCase();
  let month = MONTHS_ALL;
  if (monthRaw !== MONTHS_ALL) {
    if (!/^\d{1,2}$/.test(monthRaw)) throw bad('month must be 1-12, or "all".');
    month = Number(monthRaw);
    if (month < 1 || month > 12) throw bad('month must be 1-12, or "all".');
  }
  const [start, end] = monthRange(year, month);

  const category = String(req.query.category || 'all').toLowerCase();
  if (!CATEGORIES.has(category)) throw bad('category must be all, b2b or b2c.');

  const sortKey = String(req.query.sort || 'qty_desc').toLowerCase();
  if (!PRODUCT_SORTS.has(sortKey)) {
    throw bad('sort must be qty_desc, qty_asc, name_asc or name_desc.');
  }

  // Matched against the product's displayed name and its SKU. Bound as a
  // parameter; the wildcards are added here, and the caller's own % and _
  // are escaped so a search for "50%" cannot become a match-anything.
  const searchRaw = String(req.query.search || '').trim();
  if (searchRaw.length > 100) throw bad('search is too long.');
  const search = searchRaw ? '%' + searchRaw.replace(/([\\%_])/g, '\\$1') + '%' : null;

  // Which invoice tables to read, chosen by code from the validated enum.
  const invBranches = [];
  if (category === 'all' || category === 'b2b') {
    invBranches.push("SELECT id, invoice_date, 'b2b'::text AS type_key FROM b2b_invoices"
      + ' WHERE user_id = $1 AND invoice_date >= $2 AND invoice_date <= $3');
  }
  if (category === 'all' || category === 'b2c') {
    invBranches.push("SELECT id, invoice_date, 'b2c'::text AS type_key FROM b2c_invoices"
      + ' WHERE user_id = $1 AND invoice_date >= $2 AND invoice_date <= $3');
  }

  // A return belongs to the month of the RETURN, not of the sale it
  // reverses: an August sale returned in September reduces September.
  // Its B2B/B2C side is the original invoice's, which the return row
  // records itself.
  const returnCategorySql = category === 'all' ? '' : ' AND sr.original_invoice_type = $4';

  const params = [req.userId, start, end];
  if (category !== 'all') params.push(category);
  const searchParam = search ? '$' + (params.length + 1) : null;
  if (search) params.push(search);

  // Grouping key: the product id whenever the line has one, and the
  // trimmed lower-cased name when it does not.
  //
  // invoice_items ids are regenerated on every save, so nothing may group
  // by them. product_id is the stable identity — but it is nullable
  // (ON DELETE SET NULL, and a line can be typed freehand), so the name is
  // the fallback that keeps such lines from collapsing into one anonymous
  // row. Two lines of the same product on one invoice therefore land in
  // the same group and are summed, which is what "one product, one row"
  // means.
  const sql = `
    WITH inv AS (
      ${invBranches.join('\n      UNION ALL\n      ')}
    ),
    sold AS (
      SELECT
        COALESCE(ii.product_id::text, 'name:' || lower(btrim(ii.product_name))) AS gkey,
        (array_agg(ii.product_id) FILTER (WHERE ii.product_id IS NOT NULL))[1] AS product_id,
        SUM(ii.quantity) AS qty,
        COUNT(DISTINCT ii.invoice_type || ':' || ii.invoice_id::text) AS invoice_count,
        (array_agg(ii.product_name ORDER BY inv.invoice_date DESC, ii.id DESC))[1] AS line_name,
        (array_agg(ii.unit ORDER BY inv.invoice_date DESC, ii.id DESC))[1] AS line_unit
      FROM invoice_items ii
      JOIN inv ON inv.id = ii.invoice_id AND inv.type_key = ii.invoice_type
      WHERE ii.user_id = $1
      GROUP BY 1
    ),
    returned AS (
      SELECT
        COALESCE(sri.product_id::text, 'name:' || lower(btrim(sri.product_name))) AS gkey,
        (array_agg(sri.product_id) FILTER (WHERE sri.product_id IS NOT NULL))[1] AS product_id,
        SUM(sri.quantity) AS qty,
        (array_agg(sri.product_name ORDER BY sr.return_date DESC, sri.id DESC))[1] AS line_name,
        (array_agg(sri.unit ORDER BY sr.return_date DESC, sri.id DESC))[1] AS line_unit
      FROM sales_return_items sri
      JOIN sales_returns sr ON sr.id = sri.return_id AND sr.user_id = sri.user_id
      WHERE sri.user_id = $1 AND sr.return_date >= $2 AND sr.return_date <= $3${returnCategorySql}
      GROUP BY 1
    ),
    joined AS (
      -- FULL JOIN: a product may have only sales in the period, or only a
      -- return (an August sale returned in September appears in September
      -- with nothing sold). gkey is never NULL on either side, so plain
      -- equality is the whole join.
      SELECT
        COALESCE(s.gkey, r.gkey) AS gkey,
        COALESCE(s.product_id, r.product_id) AS product_id,
        COALESCE(s.qty, 0) AS sold_qty,
        COALESCE(r.qty, 0) AS return_qty,
        COALESCE(s.invoice_count, 0) AS invoice_count,
        COALESCE(s.line_name, r.line_name) AS line_name,
        COALESCE(s.line_unit, r.line_unit) AS line_unit
      FROM sold s FULL JOIN returned r ON s.gkey = r.gkey
    )
    SELECT
      j.gkey, j.product_id,
      -- The master's current name and unit where the product still exists,
      -- so a renamed product reads as it is called today; the line's own
      -- text when it does not.
      COALESCE(p.name, j.line_name) AS display_name,
      p.sku AS sku,
      COALESCE(p.unit, j.line_unit) AS unit,
      j.sold_qty, j.return_qty,
      (j.sold_qty - j.return_qty) AS net_qty,
      j.invoice_count
    FROM joined j
    LEFT JOIN products p ON p.id = j.product_id AND p.user_id = $1
    ${search ? `WHERE (COALESCE(p.name, j.line_name) ILIKE ${searchParam} ESCAPE '\\'
             OR COALESCE(p.sku, '') ILIKE ${searchParam} ESCAPE '\\')` : ''}
    ORDER BY ${PRODUCT_SORTS.get(sortKey)}`;

  const { rows } = await pool.query(sql, params);
  if (rows.length > MAX_PRODUCT_ROWS) {
    throw bad(`This period covers ${rows.length} products, which is more than this report returns at once. `
      + 'Narrow it to a single month, or use the search box.');
  }

  const products = rows.map((r, i) => {
    const sold = qtyNum(r.sold_qty);
    const returned = qtyNum(r.return_qty);
    const net = Math.round((sold - returned) * 1000) / 1000;
    return {
      sl_no: i + 1,
      product_id: r.product_id || null,
      group_key: r.gkey,
      product_name: r.display_name || '',
      sku: r.sku || '',
      unit: r.unit || '',
      sold_qty: sold,
      return_qty: returned,
      net_qty: net,
      invoice_count: Number(r.invoice_count) || 0,
      // Returned as a fact rather than clamped away: more returned than
      // sold in one period is either a return against an earlier month's
      // sale or a data problem, and both are things the reader needs to
      // see rather than have quietly rounded up to zero.
      negative_net: net < 0
    };
  });

  res.json({
    period: { year, month: month === MONTHS_ALL ? MONTHS_ALL : month, start, end },
    category,
    sort: sortKey,
    search: searchRaw,
    // Over the rows actually returned, so the figures at the top of the
    // page always describe the table underneath them.
    summary: {
      products: products.length,
      sold_qty: Math.round(products.reduce((t, p) => t + p.sold_qty, 0) * 1000) / 1000,
      return_qty: Math.round(products.reduce((t, p) => t + p.return_qty, 0) * 1000) / 1000,
      net_qty: Math.round(products.reduce((t, p) => t + p.net_qty, 0) * 1000) / 1000,
      negative_rows: products.filter(p => p.negative_net).length
    },
    products
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
