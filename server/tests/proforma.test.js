// =============================================
// Proforma Invoice — isolation, validity and conversion
// =============================================
// The point of most of these is not that proforma works, but that it stays
// OUT of everything: GSTR-1, the Dashboard, the ledgers, the Invoice List
// and the tax invoice numbering. Those are the guarantees that would be
// expensive to discover broken, so they are asserted against the real
// registry and the real route tables rather than described in a comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

// The client registry and helpers, loaded the way a page loads them.
function loadClient() {
  const noop = () => {};
  const sb = {
    console, Math, Date, JSON, RegExp, parseInt, parseFloat, isNaN, isFinite, Intl,
    // utils.js is written for a browser and touches these while loading.
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
      body: { appendChild: noop }, head: { appendChild: noop }, documentElement: { style: {} },
      readyState: 'complete'
    },
    navigator: { userAgent: 'node' }, location: { hostname: 'localhost', href: '', search: '' },
    setTimeout, clearTimeout
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'india-districts.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'client', 'js', 'utilities', 'utils.js'), 'utf8')
    + ';globalThis.__X = { GST_DOCUMENT_TYPES, PROFORMA_STATUSES, PROFORMA_STATUS_DEFAULT,'
    + ' PROFORMA_VALIDITY_DAYS, proformaEffectiveStatus, proformaDefaultValidUntil, proformaStatus };', sb);
  return sb.__X;
}

const X = loadClient();
const registry = X.GST_DOCUMENT_TYPES.find(d => d.key === 'proforma_invoice');

test('P1 the proforma type is registered', () => {
  assert.ok(registry, 'proforma_invoice missing from GST_DOCUMENT_TYPES');
  assert.equal(registry.storage, 'proforma_invoices');
});

test('P2 it has its own numbering series, never the invoice book', () => {
  assert.equal(registry.series, 'proforma_invoice');
  const invoice = X.GST_DOCUMENT_TYPES.find(d => d.key === 'tax_invoice');
  assert.notEqual(registry.series, invoice.series);
});

// The exact filter GSTR-1 Table 13 uses. If this ever passes for proforma,
// quotations start appearing in a return.
test('P3 GSTR-1 Table 13 cannot pick it up', () => {
  const qualifies = registry.enabled && registry.docNum !== null && registry.storage;
  assert.equal(!!qualifies, false, 'proforma qualifies for Table 13 — it must not');
  assert.equal(registry.docNum, null);
});

test('P4 it carries no tax weight anywhere', () => {
  assert.equal(registry.taxable, false);
  assert.equal(registry.affectsTurnover, false);
  assert.equal(registry.affectsHsn, false);
  assert.equal(registry.affectsLiability, false);
  assert.equal(registry.affectsAmendments, false);
  assert.equal(registry.sections.length, 0, 'a proforma reports in no return');
});

test('P5 default validity is 30 days from the proforma date', () => {
  assert.equal(X.PROFORMA_VALIDITY_DAYS, 30);
  assert.equal(X.proformaDefaultValidUntil('2026-08-27'), '2026-09-26');
  // month and year rollover
  assert.equal(X.proformaDefaultValidUntil('2026-12-15'), '2027-01-14');
});

test('P6 an unconverted proforma past its date reads as Expired', () => {
  const row = { status: 'sent', valid_until: '2026-09-26' };
  assert.equal(X.proformaEffectiveStatus(row, '2026-09-26'), 'sent', 'the last day is still open');
  assert.equal(X.proformaEffectiveStatus(row, '2026-09-27'), 'expired');
});

test('P7 converted and cancelled outrank the calendar', () => {
  const past = '2026-09-27';
  assert.equal(X.proformaEffectiveStatus({ status: 'converted', valid_until: '2026-09-26' }, past), 'converted');
  assert.equal(X.proformaEffectiveStatus({ status: 'cancelled', valid_until: '2026-09-26' }, past), 'cancelled');
});

test('P8 a proforma with no expiry never expires', () => {
  assert.equal(X.proformaEffectiveStatus({ status: 'sent', valid_until: null }, '2030-01-01'), 'sent');
});

test('P9 Expired is derived, never a stored status', () => {
  assert.equal(X.PROFORMA_STATUSES.includes('expired'), false);
  assert.equal(X.proformaStatus({ status: 'expired' }), X.PROFORMA_STATUS_DEFAULT,
    'an unknown stored status falls back to the default');
});

// ── server side ──
// generic.js is read as text rather than required: requiring it pulls in
// config/pool.js, which refuses to load without DATABASE_URL, and none of
// these assertions needs a database. The column allow-lists are what a
// client is actually held to, so reading them is the real check.
const GENERIC = fs.readFileSync(path.join(ROOT, 'server', 'src', 'routes', 'generic.js'), 'utf8');

function columnsOf(table) {
  const at = GENERIC.indexOf('  ' + table + ': {');
  assert.ok(at > -1, table + ' is not in the route registry');
  const block = GENERIC.slice(at, GENERIC.indexOf('columns: [', at) + 4000);
  const list = block.slice(block.indexOf('columns: ['), block.indexOf(']', block.indexOf('columns: [')));
  return list.match(/'([a-z_0-9]+)'/g).map(x => x.replace(/'/g, ''));
}

test('P10 both proforma tables are exposed with their own columns', () => {
  assert.ok(columnsOf('proforma_invoices').length > 10);
  assert.ok(columnsOf('proforma_invoice_items').length > 10);
});

test('P11 the conversion link lives on the proforma, not the invoice', () => {
  const pf = columnsOf('proforma_invoices');
  assert.ok(pf.includes('converted_invoice_id'));
  assert.ok(pf.includes('converted_invoice_type'));
  // and the invoice tables gained nothing
  for (const t of ['b2b_invoices', 'b2c_invoices']) {
    const cols = columnsOf(t);
    assert.equal(cols.includes('source_document_id'), false, t + ' must not carry a proforma link');
    assert.equal(cols.includes('source_document_type'), false, t + ' must not carry a proforma link');
    assert.equal(cols.includes('proforma_id'), false, t + ' must not carry a proforma link');
  }
});

test('P12 a proforma cannot be written into an invoice table', () => {
  // The allow-lists are what a client is held to; no proforma column exists
  // on either invoice table, so a crafted payload cannot smuggle one in.
  for (const t of ['b2b_invoices', 'b2c_invoices']) {
    const proformaish = columnsOf(t).filter(c => /proforma/i.test(c));
    assert.deepEqual(proformaish, [], t + ' exposes a proforma column');
  }
});

test('P13 the two registries agree on the proforma series', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'server', 'src', 'routes', 'documents.js'), 'utf8');
  assert.match(docs, /proforma_invoice:\s*\{\s*table:\s*'proforma_invoices',\s*series:\s*'proforma_invoice'/,
    'documents.js and the client registry disagree');
  assert.match(docs, /items:\s*'proforma_invoice_items',\s*itemsFk:\s*'proforma_invoice_id'/);
});

// ── the tax invoice is untouched ──
const PDF = fs.readFileSync(path.join(ROOT, 'client', 'js', 'pages', 'invoice-pdf.js'), 'utf8');

test('P14 the tax invoice keeps its three copies and its title', () => {
  assert.match(PDF, /const INVOICE_COPY_LABELS = \[/);
  assert.match(PDF, /'Original for Recipient'/);
  assert.match(PDF, /'Duplicate for File Copy'/);
  assert.match(PDF, /'Duplicate for Transporter'/);
  assert.match(PDF, /doc\.text\('TAX INVOICE'/);
});

const PROFORMA_PDF = fs.readFileSync(path.join(ROOT, 'client', 'js', 'pages', 'proforma-pdf.js'), 'utf8');

test('P15 the proforma PDF is its own builder, titled PROFORMA INVOICE', () => {
  assert.match(PROFORMA_PDF, /async function buildProformaPDFDoc\(/);
  assert.match(PROFORMA_PDF, /doc\.text\('PROFORMA INVOICE'/);
  // The name appears in a comment explaining why this is a sibling builder;
  // what must not exist is a CALL to it.
  assert.equal(/(?:await\s+|=\s*)buildInvoicePDFDoc\s*\(/.test(PROFORMA_PDF), false,
    'the proforma must not call the tax invoice builder');
});

test('P16 the proforma PDF carries no tax-invoice copy labels', () => {
  for (const label of ['Original for Recipient', 'Duplicate for File Copy', 'Duplicate for Transporter']) {
    assert.equal(PROFORMA_PDF.includes(label), false, 'proforma must not print: ' + label);
  }
  assert.match(PROFORMA_PDF, /Not a Tax Invoice/);
});

// ── import / conversion ──
const ENTRY = fs.readFileSync(path.join(ROOT, 'client', 'js', 'pages', 'invoice-entry.js'), 'utf8');
const LIST = fs.readFileSync(path.join(ROOT, 'client', 'js', 'pages', 'proforma-list.js'), 'utf8');

test('P17 import reuses the existing prefill route, not a second one', () => {
  assert.match(LIST, /sessionStorage\.setItem\('invoice_duplicate_draft'/);
  assert.match(LIST, /invoice\.html\?duplicate=1/);
});

test('P18 importing reserves no invoice number and saves nothing', () => {
  const fn = LIST.slice(LIST.indexOf('function importProformaIntoInvoice'));
  const body = fn.slice(0, fn.search(/\r?\n\}/));
  assert.equal(/reserve-number/.test(body), false, 'import must not reserve a tax invoice number');
  assert.equal(/save-with-items|\/save/.test(body), false, 'import must not save anything');
});

test('P19 the proforma is marked converted only after the invoice saves', () => {
  const save = ENTRY.slice(ENTRY.indexOf('async function saveInvoice'));
  const guardAt = save.indexOf('if (!invoiceId) return;');
  const markAt = save.indexOf('markProformaConverted(');
  assert.ok(guardAt > -1, 'the failed-save guard is missing');
  assert.ok(markAt > guardAt, 'conversion must happen after the save guard, never before');
});

test('P20 conversion writes only to the proforma table', () => {
  const fn = ENTRY.slice(ENTRY.indexOf('async function markProformaConverted'));
  const body = fn.slice(0, fn.search(/\r?\n\}\r?\n/));
  assert.match(body, /from\('proforma_invoices'\)/);
  assert.match(body, /status: 'converted'/);
  assert.equal(/b2b_invoices|b2c_invoices/.test(body), false,
    'conversion must not touch the invoice tables');
});

// ── schema ──
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema', 'schema.sql'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'server', 'db', 'migrations', 'migration_proforma_invoices.sql'), 'utf8');

test('P21 the migration is additive and alters no existing table', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS proforma_invoices/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS proforma_invoice_items/);
  const alters = MIGRATION.match(/ALTER TABLE\s+(\w+)/g) || [];
  assert.deepEqual(alters, [], 'the proforma migration must not alter any existing table');
  assert.equal(/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE\s+\w+\s+SET/i.test(MIGRATION), false,
    'the migration must not touch existing data');
});

test('P22 schema.sql carries the same two tables', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS proforma_invoices/);
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS proforma_invoice_items/);
});

test('P23 the migration is registered in the manifest, last', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'server', 'db', 'migrations', '_manifest.json'), 'utf8'));
  assert.equal(manifest.order[manifest.order.length - 1], 'migration_proforma_invoices.sql');
  assert.ok(fs.existsSync(path.join(ROOT, 'server', 'db', 'migrations', 'migration_proforma_invoices.sql')));
});

test('P24 the invoice tables gained no columns for this feature', () => {
  for (const t of ['b2b_invoices', 'b2c_invoices']) {
    const start = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    const body = SCHEMA.slice(start, SCHEMA.indexOf('\n);', start));
    assert.equal(/proforma/i.test(body), false, t + ' mentions proforma');
    assert.equal(/source_document/i.test(body), false, t + ' gained a source_document column');
  }
});

// ── numbering ──
// The bug these guard: document_number is NOT NULL and the save route does not
// invent one, so a form that never reserved a number could not save at all -
// and with no proforma row on disk there was nothing for a converted invoice to
// link back to. Every check above still passed while that was true, because
// none of them went through an actual save.
const PFENTRY = fs.readFileSync(path.join(ROOT, 'client', 'js', 'pages', 'proforma-entry.js'), 'utf8');
const DOCROUTE = fs.readFileSync(path.join(ROOT, 'server', 'src', 'routes', 'documents.js'), 'utf8');

test('P25 saving a new proforma reserves a number from the proforma book', () => {
  const fn = PFENTRY.slice(PFENTRY.indexOf('async function saveProforma'));
  const body = fn.slice(0, fn.search(/\r?\n\}\r?\n/));
  assert.match(body, /\/documents\/reserve-number/,
    'saveProforma must reserve a number - document_number is NOT NULL');
  assert.match(body, /documentType: 'proforma_invoice'/,
    'it must reserve from the proforma book, not another document type');
  assert.ok(body.indexOf('/documents/proforma_invoice/save') > body.indexOf('reserve-number'),
    'the number must be reserved before the save, not after');
});

test('P26 the proforma book has its own number format', () => {
  const table = DOCROUTE.slice(DOCROUTE.indexOf('const DEFAULT_DOCUMENT_FORMATS = {'));
  const body = table.slice(0, table.indexOf('};'));
  assert.match(body, /proforma_invoice:\s*'[A-Z]+-#+'/,
    'without its own entry a proforma falls back to the generic DOC- prefix');
  assert.equal(/proforma_invoice:\s*'DOC-/.test(body), false);
});
