// Export details on a proforma, ported from New Invoice.
//
// The point of these tests is fidelity: Proforma must reproduce what Invoice
// Entry already does, not a simplified version of it. So several assertions
// read BOTH files and compare, rather than restating the rule twice and
// letting the two drift.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const PF_JS = strip(rd('client', 'js', 'pages', 'proforma-entry.js'));
const INV_JS = strip(rd('client', 'js', 'pages', 'invoice-entry.js'));
const PF_HTML = rd('proforma.html');
const INV_HTML = rd('invoice.html');
const GENERIC = strip(rd('server', 'src', 'routes', 'generic.js'));
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const MIGRATION = rd('server', 'db', 'migrations', 'migration_proforma_export.sql');
const MANIFEST = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));

const EXPORT_COLS = ['export_type', 'shipping_bill_number', 'shipping_bill_date',
  'port_code', 'export_of', 'sez_recipient_type', 'lut_number', 'differential_65'];

const tableBlock = (sql, name) => {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS ' + name);
  return start < 0 ? '' : sql.slice(start, sql.indexOf('\n);', start));
};

// ── the migration ──
test('X1 the migration is additive and registered', () => {
  assert.match(MIGRATION, /ALTER TABLE proforma_invoices/);
  for (const c of EXPORT_COLS) {
    assert.ok(MIGRATION.includes('ADD COLUMN IF NOT EXISTS ' + c),
      c + ' must be added with IF NOT EXISTS');
  }
  // nothing destructive, and no backfill inventing export data
  assert.equal(/DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i.test(MIGRATION), false);
  assert.equal(/^\s*(UPDATE|INSERT)\b/im.test(MIGRATION), false, 'no backfill');
  // only proforma_invoices is touched - the invoice tables must not move
  const altered = [...MIGRATION.matchAll(/ALTER TABLE (\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(altered)], ['proforma_invoices']);
  // the runner refuses to start if the manifest and the directory disagree
  assert.ok(MANIFEST.order.includes('migration_proforma_export.sql'));
  const files = fs.readdirSync(path.join(ROOT, 'server', 'db', 'migrations'))
    .filter(f => f.endsWith('.sql')).sort();
  assert.deepEqual([...MANIFEST.order].sort(), files, 'manifest and directory must agree');
  // it must come after the migration that creates the table
  assert.ok(MANIFEST.order.indexOf('migration_proforma_export.sql')
          > MANIFEST.order.indexOf('migration_proforma_invoices.sql'));
});

test('X2 schema.sql declares the same columns, with the invoice tables\' types', () => {
  const pf = tableBlock(SCHEMA, 'proforma_invoices');
  const b2b = tableBlock(SCHEMA, 'b2b_invoices');
  assert.ok(pf.length && b2b.length);
  for (const c of EXPORT_COLS) {
    const pfLine = pf.split('\n').find(l => l.trim().startsWith(c + ' '));
    const b2bLine = b2b.split('\n').find(l => l.trim().startsWith(c + ' '));
    assert.ok(pfLine, c + ' must be declared on proforma_invoices');
    assert.ok(b2bLine, c + ' must exist on b2b_invoices to mirror');
    assert.strictEqual(pfLine.trim().replace(/,$/, ''), b2bLine.trim().replace(/,$/, ''),
      c + ' must have the same type/constraint as on b2b_invoices');
  }
});

test('X3 the API will actually accept the new columns', () => {
  const block = GENERIC.slice(GENERIC.indexOf('proforma_invoices: {'),
                              GENERIC.indexOf('proforma_invoice_items: {'));
  for (const c of EXPORT_COLS) {
    assert.ok(block.includes("'" + c + "'"), c + ' must be in the allow-list');
  }
  // the generic layer still scopes on the server's own user_id
  assert.match(GENERIC, /ownerColumn = 'user_id'/);
});

// ── the two mechanisms, as Invoice implements them ──
test('X4 the GST category — not the toggle — drives State and District', () => {
  const fn = PF_JS.slice(PF_JS.indexOf('function onProformaGstCategoryChange'),
                         PF_JS.indexOf('function onProformaExportToggleChange'));
  assert.match(fn, /syncExportStateDistrict\(gstIsExportCategory\(value\)/);
  assert.match(fn, /'pfState', 'pfDistrict', 'pfDistrictList', 'pfDistrictError', true/);
  // and the page is wired to call it
  assert.match(PF_HTML, /id="pfGstCategory"[^>]*onchange="onProformaGstCategoryChange\(\)"/);
  // the toggle must NOT be what changes State/District - that would be a
  // behaviour Invoice does not have
  const toggleFn = PF_JS.slice(PF_JS.indexOf('function onProformaExportToggleChange'),
                               PF_JS.indexOf('function restoreProformaExportFields'));
  assert.equal(/syncExportStateDistrict|pfState|pfDistrict/.test(toggleFn), false,
    'the export toggle must not touch State/District');
});

test('X5 the toggle reveals the fields, exactly as Invoice does', () => {
  const pf = PF_JS.slice(PF_JS.indexOf('function onProformaExportToggleChange'),
                         PF_JS.indexOf('function restoreProformaExportFields'));
  const inv = INV_JS.slice(INV_JS.indexOf('function onExportToggleChange'),
                           INV_JS.indexOf('function restoreExportFields'));
  // same shape: toggle d-none, set the Yes/No label, grey it when off
  for (const re of [/classList\.toggle\('d-none', !on\)/,
                    /textContent = on \? 'Yes' : 'No'/,
                    /classList\.toggle\('text-gray-mid', !on\)/]) {
    assert.match(pf, re);
    assert.match(inv, re, 'invoice reference must still contain ' + re);
  }
});

test('X6 every Invoice export control exists on Proforma', () => {
  const controls = [
    ['exportToggle', 'pfExportToggle'], ['exportToggleLabel', 'pfExportToggleLabel'],
    ['exportFields', 'pfExportFields'], ['invExportType', 'pfExportType'],
    ['invPortCode', 'pfPortCode'], ['invShippingBillNo', 'pfShippingBillNo'],
    ['invShippingBillDate', 'pfShippingBillDate'], ['invExportOf', 'pfExportOf'],
    ['invSezRecipient', 'pfSezRecipient'], ['invDifferential65', 'pfDifferential65']
  ];
  for (const [inv, pf] of controls) {
    assert.ok(INV_HTML.includes('id="' + inv + '"'), inv + ' must exist on invoice.html');
    assert.ok(PF_HTML.includes('id="' + pf + '"'), pf + ' must exist on proforma.html');
  }
  // the same label the Invoice uses
  assert.match(PF_HTML, /<span class="fs-12 fw-700">Export Invoice<\/span>/);
  // same option values, so a converted proforma needs no translation
  for (const v of ['WPAY', 'WOPAY', 'goods', 'services', 'unit', 'developer']) {
    assert.ok(PF_HTML.includes('value="' + v + '"'), 'option ' + v + ' must be offered');
  }
  // the fields start hidden
  assert.match(PF_HTML, /id="pfExportFields"[^>]*class="[^"]*d-none/);
});

// ── save ──
test('X7 the save payload reproduces Invoice\'s gating rule exactly', () => {
  const fn = PF_JS.slice(PF_JS.indexOf('function buildProformaExport'));
  // gated on the toggle
  for (const c of ['export_type', 'port_code', 'shipping_bill_number',
                   'shipping_bill_date', 'export_of']) {
    assert.match(fn, new RegExp(c + ':\\s*isExport \\?'), c + ' must be nulled when off');
  }
  // NOT gated - the invoice records these regardless
  assert.match(fn, /sez_recipient_type: document\.getElementById\('pfSezRecipient'\)\?\.value \|\| null/);
  assert.match(fn, /differential_65: !!document\.getElementById\('pfDifferential65'\)\?\.checked/);
  assert.equal(/sez_recipient_type:\s*isExport/.test(fn), false,
    'sez_recipient_type is not gated on the export toggle in Invoice');
  assert.equal(/differential_65:\s*isExport/.test(fn), false,
    'differential_65 is not gated on the export toggle in Invoice');
  // the LUT is copied from the profile, never typed
  assert.match(fn, /lut_number: \(typeof getCachedProfile === 'function'/);
  assert.equal(/getElementById\('pfLut/.test(PF_JS), false, 'there is no LUT input to trust');
  // and it is actually spread into the saved document
  assert.match(PF_JS, /\.\.\.buildProformaExport\(\)/);
});

// ── restore ──
test('X8 reopening a proforma keeps it an export', () => {
  const fn = PF_JS.slice(PF_JS.indexOf('function restoreProformaExportFields'),
                         PF_JS.indexOf('function buildProformaExport'));
  // the stored export_type IS the record of the toggle, same as Invoice
  assert.match(fn, /t\.checked = !!\(rec && rec\.export_type\)/);
  assert.match(INV_JS, /t\.checked = !!\(inv && inv\.export_type\)/);
  for (const [id, col] of [['pfExportType', 'export_type'], ['pfPortCode', 'port_code'],
      ['pfShippingBillNo', 'shipping_bill_number'], ['pfShippingBillDate', 'shipping_bill_date'],
      ['pfExportOf', 'export_of'], ['pfSezRecipient', 'sez_recipient_type']]) {
    assert.ok(fn.includes("'" + id + "'") && fn.includes(col), id + ' must be restored from ' + col);
  }
  assert.match(fn, /onProformaExportToggleChange\(\)/, 'the UI must follow the restored state');
  // called on edit AND reset on a fresh form
  assert.match(PF_JS, /restoreProformaExportFields\(rec\)/);
  assert.match(PF_JS, /restoreProformaExportFields\(null\)/);
});

// ── nothing else moved ──
test('X9 the Proforma PDF and the Invoice export flow are untouched', () => {
  // No export field is printed on the proforma PDF: the layout, its
  // "Not a Tax Invoice" wording, bank details, validity and seal are the
  // approved design and this change does not alter them.
  const PDF = strip(rd('client', 'js', 'pages', 'proforma-pdf.js'));
  for (const c of EXPORT_COLS) {
    assert.equal(PDF.includes(c), false, 'proforma-pdf.js must not read ' + c + ' yet');
  }
  // the Invoice implementation this was copied from is unchanged
  assert.match(INV_JS, /function onExportToggleChange\(\)/);
  assert.match(INV_JS, /function restoreExportFields\(inv\)/);
  assert.match(INV_HTML, /id="exportToggle"/);
});

test('X10 the changed script carries a new cache key', () => {
  assert.ok(PF_HTML.includes('client/js/pages/proforma-entry.js?v=40'),
    'proforma-entry.js must be referenced at v=40');
  // and nothing unrelated was bumped along with it
  assert.ok(PF_HTML.includes('client/js/pages/proforma-pdf.js?v=31'),
    'proforma-pdf.js did not change, so its key must not move');
  assert.ok(PF_HTML.includes('client/js/utilities/utils.js?v=33'),
    'utils.js did not change, so its key must not move');
});
