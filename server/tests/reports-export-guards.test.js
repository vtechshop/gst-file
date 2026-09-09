// Static guards for the Complete Invoice Details export.
//
// These read the source rather than the database: they are about the
// shape of the code that will run in production — that filters are bound
// not interpolated, that the four existing sheets were not disturbed, and
// that the sheet is built from the server rather than from whatever the
// page happened to load.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ROUTE = read('server/src/routes/reports.js');
const REPORTS_JS = read('client/js/reports/reports.js');
const EXPORT_JS = read('client/js/utilities/export.js');
const REPORTS_HTML = read('reports.html');

test('G1 the export route requires authentication', () => {
  assert.match(ROUTE, /const \{ requireAuth \} = require\('\.\.\/middleware\/auth'\)/);
  assert.match(ROUTE, /router\.use\(requireAuth\)/);
});

test('G2 tenancy comes from the JWT, never from the request', () => {
  // Every query parameter list starts with req.userId.
  assert.match(ROUTE, /pool\.query\(sql, \[req\.userId, start, end\]\)/);
  assert.equal(/query\.user_id|body\.user_id|query\.tenant_id|body\.tenant_id|workshopId/.test(ROUTE),
    false, 'a tenant id must never be read from the request');
  // Both invoice tables and both joins are filtered by the same bound id.
  const userScoped = ROUTE.match(/user_id = \$1/g) || [];
  assert.ok(userScoped.length >= 3,
    `expected the invoice branch, the items join and the products join to be scoped; found ${userScoped.length}`);
});

test('G3 filter values are bound or whitelisted, never interpolated', () => {
  // Scanned over the SQL only. An earlier version of this guard read every
  // ${} in the file, which swept up error-message templates that never go
  // near a query and said nothing about injection either way.
  const sqlBlocks = [
    ROUTE.match(/const INVOICE_COLUMNS = `([\s\S]*?)`;/),
    ROUTE.match(/function branchSql[\s\S]*?return `([\s\S]*?)`;/),
    ROUTE.match(/const sql = `([\s\S]*?)`;/)
  ];
  assert.ok(sqlBlocks.every(Boolean), 'every SQL block must still be found');

  const allowed = new Set([
    '${INVOICE_COLUMNS}', '${table}', '${typeKey}', '${label}',
    "${branches.join('\\n    UNION ALL\\n')}", '${dir}',
    '${MAX_DETAIL_ROWS + 1}'
  ]);
  for (const block of sqlBlocks) {
    for (const i of block[1].match(/\$\{[^}]+\}/g) || []) {
      assert.ok(allowed.has(i), `unexpected SQL interpolation ${i} — filter values must be bound`);
    }
  }
  // And the caller's values reach the query only as bind parameters.
  assert.match(ROUTE, /pool\.query\(sql, \[req\.userId, start, end\]\)/);
  // dir can only ever be one of two literals.
  assert.match(ROUTE, /const dir = sort === 'desc' \? 'DESC' : 'ASC'/);
});

test('G4 category and sort are closed enumerations', () => {
  assert.match(ROUTE, /const CATEGORIES = new Set\(\['all', 'b2b', 'b2c'\]\)/);
  assert.match(ROUTE, /const SORTS = new Set\(\['asc', 'desc'\]\)/);
  assert.match(ROUTE, /if \(!CATEGORIES\.has\(category\)\) throw bad/);
  assert.match(ROUTE, /if \(!SORTS\.has\(sort\)\) throw bad/);
});

test('G5 dates are validated for shape and for being real calendar dates', () => {
  assert.match(ROUTE, /const DATE_RE = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(ROUTE, /is not a real calendar date/);
  assert.match(ROUTE, /if \(start > end\) throw bad/);
});

test('G6 the join names invoice_type as well as invoice_id', () => {
  // This is what stops a b2b invoice picking up b2c lines and doubling
  // its rows — the duplicate-row failure mode the sheet must not have.
  assert.match(ROUTE, /ON it\.invoice_id = inv\.id\s*\n\s*AND it\.invoice_type = inv\.type_key/);
});

test('G7 B2B/B2C classification is the table the row lives in, not a formula', () => {
  // Each category is a branch over its own table, labelled by that table.
  assert.match(ROUTE, /branchSql\('b2b_invoices', 'b2b', 'B2B'\)/);
  assert.match(ROUTE, /branchSql\('b2c_invoices', 'b2c', 'B2C'\)/);
  // No threshold, no GSTIN test, no state comparison deciding category.
  assert.equal(/category\s*=\s*.*(gst_number|gstin|threshold|100000)/i.test(ROUTE), false,
    'category must come from the source table, never be recomputed');
});

test('G8 the four existing sheets are untouched', () => {
  for (const name of ['B2B Invoices', 'B2C Invoices', 'B2B HSN', 'B2C HSN']) {
    assert.ok(REPORTS_JS.includes(`name: '${name}'`), `${name} sheet must still be built`);
  }
  // They still come from the same four in-memory arrays as before.
  assert.match(REPORTS_JS, /name: 'B2B Invoices',\s*\n\s*data: repB2B\.map/);
  assert.match(REPORTS_JS, /name: 'B2C Invoices',\s*\n\s*data: repB2C\.map/);
  assert.match(REPORTS_JS, /name: 'B2B HSN',\s*\n\s*data: repB2BHSN\.map/);
  assert.match(REPORTS_JS, /name: 'B2C HSN',\s*\n\s*data: repB2CHSN\.map/);
});

test('G9 exactly one new sheet is added, with the required name', () => {
  const names = [...REPORTS_JS.matchAll(/name: '([^']+)',\s*\n\s*data:/g)].map(m => m[1]);
  assert.deepStrictEqual(names,
    ['B2B Invoices', 'B2C Invoices', 'B2B HSN', 'B2C HSN', 'Complete Invoice Details'],
    'the four original sheets must come first, with exactly one new sheet after them');
  // Not split into two category sheets.
  assert.equal(/B2B Complete|B2C Complete/.test(REPORTS_JS), false);
});

test('G10 the new sheet is fetched from the server, not from page state', () => {
  assert.match(REPORTS_JS, /apiFetch\('\/reports\/invoice-details\?'/);
  // It must not be rebuilt from the arrays the page already holds.
  assert.equal(/buildCompleteInvoiceRows\(\s*(repB2B|repB2C|repItemsByInvoice)/.test(REPORTS_JS), false);
  assert.match(REPORTS_JS, /buildCompleteInvoiceRows\(detail\.rows\)/);
});

test('G11 the export refuses to write a workbook it cannot vouch for', () => {
  // A failed read aborts rather than silently writing four sheets.
  assert.match(REPORTS_JS, /handleApiError\(err, 'loading the complete invoice details'\)/);
  // Counts are checked against what the database reported.
  assert.match(REPORTS_JS, /detail\.invoice_count/);
  assert.match(REPORTS_JS, /detail\.item_count/);
  assert.match(REPORTS_JS, /No invoices found for the selected period\/category\./);
});

test('G12 Category and Sort controls exist and the period picker was not duplicated', () => {
  assert.match(REPORTS_HTML, /id="repDetailCategory"/);
  assert.match(REPORTS_HTML, /id="repDetailSort"/);
  for (const v of ['all', 'b2b', 'b2c']) {
    assert.ok(REPORTS_HTML.includes(`value="${v}"`), `category option ${v} must exist`);
  }
  assert.ok(REPORTS_HTML.includes('value="asc"') && REPORTS_HTML.includes('value="desc"'));
  // Exactly one month/period selector on the page, the pre-existing one.
  const monthPickers = REPORTS_HTML.match(/id="reportMonth"/g) || [];
  assert.strictEqual(monthPickers.length, 1, 'the period picker must not be duplicated');
});

test('G13 the Excel writer gained options without changing existing behaviour', () => {
  assert.match(EXPORT_JS, /sheets\.forEach\(\(\{ data, name, widths, autofilter \}\)/);
  // Both hints are opt-in, so a { name, data } sheet is written as before.
  assert.match(EXPORT_JS, /if \(widths\) ws\['!cols'\] = widths;/);
  assert.match(EXPORT_JS, /if \(autofilter && data\.length\)/);
  // The SheetJS writer still offers no freeze: that build silently drops
  // it. Freezing is done by the ExcelJS route instead (see G16).
  const code = EXPORT_JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\['!freeze'\]\s*=|\['!views'\]\s*=/.test(code), false,
    'freeze must not be written through SheetJS, which silently ignores it');
});

test('G16 the GSTR-1 workbook is written by ExcelJS, on the server', () => {
  // Bold headers and a frozen row are the two things the browser build
  // cannot do, so this workbook is built server-side.
  assert.match(ROUTE, /const ExcelJS = require\('exceljs'\)/);
  assert.match(ROUTE, /ws\.getRow\(1\)\.font = \{ bold: true \}/);
  assert.match(ROUTE, /ws\.views = \[\{ state: 'frozen', ySplit: 1 \}\]/);
  assert.match(ROUTE, /router\.post\('\/workbook'/);
  // Still behind the router's requireAuth.
  assert.match(ROUTE, /router\.use\(requireAuth\)/);

  // The GSTR-1 export uses it; the other export buttons on the page are
  // untouched and still use the SheetJS writer.
  assert.match(REPORTS_JS, /await downloadExcelWorkbook\(sheets, 'GSTR1_Complete_Report'\)/);
  assert.equal(/exportMultiSheetExcel\(sheets, 'GSTR1_Complete_Report'\)/.test(REPORTS_JS), false,
    'the GSTR-1 workbook must no longer go through the SheetJS writer');
  assert.match(EXPORT_JS, /async function downloadExcelWorkbook\(sheets, fileName\)/);
});

test('G17 the workbook route formats rows, it does not compute them', () => {
  // It must not read the database: every figure in the workbook is the one
  // the page already computed and verified.
  const workbook = ROUTE.slice(ROUTE.indexOf("router.post('/workbook'"));
  assert.equal(/pool\.query|SELECT |FROM /.test(workbook), false,
    'the workbook route must not query anything');
  // The date column crosses as YYYY-MM-DD and becomes a UTC-midnight date,
  // so no zone can move an invoice onto the day before.
  assert.match(ROUTE, /new Date\(Date\.UTC\(\+m\[1\], \+m\[2\] - 1, \+m\[3\]\)\)/);
  assert.match(REPORTS_JS, /dateColumns: \['Invoice Date'\]/);
  assert.equal(/new Date\(y, m - 1, d\)/.test(REPORTS_JS), false,
    'a local Date must not be built for transport — it serialises to UTC');
});

test('G18 every detail column is sized, with no width ExcelJS would drop', () => {
  const widths = REPORTS_JS.match(/const COMPLETE_DETAIL_WIDTHS = \[([\s\S]*?)\]\s*\.map/);
  assert.ok(widths, 'the width table must exist');
  const values = widths[1].replace(/\/\/[^\n]*/g, '').split(',')
    .map(v => Number(v.trim())).filter(v => Number.isFinite(v));
  assert.strictEqual(values.length, 42, 'one width per column');
  assert.ok(values.every(v => v >= 6), 'no column may be unusably narrow');
  // A width of exactly 9 is Excel's own default, and ExcelJS emits no
  // customWidth for it — that column arrives unsized while every other
  // carries what was asked for. Verified against the library, not assumed.
  assert.ok(!values.includes(9),
    'a width of exactly 9 is dropped by ExcelJS — use 8.43, 9.14 or 10');
});

test('G14 no migration was added for this feature', () => {
  const manifest = JSON.parse(read('server/db/migrations/_manifest.json')).order;
  assert.equal(manifest.some(m => /report|invoice_detail|gstr1_export/i.test(m)), false,
    'this feature must use the existing invoice tables');
  assert.strictEqual(manifest.length, 29, 'the migration count must not have changed');
});

test('G15 cache keys were bumped for both changed scripts', () => {
  // ?v= is the only cache mechanism these pages have.
  assert.match(REPORTS_HTML, /client\/js\/reports\/reports\.js\?v=30/);
  assert.match(REPORTS_HTML, /client\/js\/utilities\/export\.js\?v=30/);
});
