// Warranty register: the properties that must hold for the module to be safe
// to ship. These are read from the source and the schema rather than from a
// running database, for the same reason the proforma tests are - they assert
// structure that no amount of test data can prove.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const UTILS = rd('client', 'js', 'utilities', 'utils.js');
const CONFIG = rd('client', 'js', 'core', 'config.js');
// The manual create page was removed when registration became automatic;
// its guarantees now live in the server-side sync (see warranty-auto.test.js).
const CREATE = rd('server', 'src', 'services', 'warranty-sync.js');
const DETAIL = rd('client', 'js', 'pages', 'warranty-detail.js');
const LIST = rd('client', 'js', 'pages', 'warranty-list.js');
const PUBLIC = rd('client', 'js', 'pages', 'warranty-verify.js');
const VERIFY = rd('server', 'src', 'routes', 'verify.js');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const GENERIC = rd('server', 'src', 'routes', 'generic.js');
const MIGRATION = rd('server', 'db', 'migrations', 'migration_warranty_register.sql');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');

// ── numbering ──
test('W1 warranty draws from its own book, never the invoice series', () => {
  assert.match(DOCS, /warranty:\s*\{\s*table:\s*'warranties',\s*series:\s*'warranty'/);
  assert.match(DOCS, /warranty:\s*'WAR-#+'/);
  assert.ok(CREATE.includes("reserveNumber(client, userId, 'warranty')"),
    'the sync must draw from the warranty book');
  // The invoice reservation endpoint is a different route and must not appear.
  assert.equal(/\/invoices\/reserve-number/.test(CREATE), false);
});

test('W2 the two registries agree on the warranty series', () => {
  const entry = UTILS.slice(UTILS.indexOf("key: 'warranty'"));
  const body = entry.slice(0, entry.indexOf('}'));
  assert.match(body, /series:\s*'warranty'/);
  assert.match(body, /storage:\s*'warranties'/);
});

// ── reporting isolation ──
test('W3 GSTR-1 Table 13 cannot pick a warranty up', () => {
  const entry = UTILS.slice(UTILS.indexOf("key: 'warranty'"));
  const body = entry.slice(0, entry.indexOf('}'));
  // Table 13 filters on docNum !== null, so null is what excludes it.
  assert.match(body, /docNum:\s*null/);
});

test('W4 a warranty carries no tax weight anywhere', () => {
  const entry = UTILS.slice(UTILS.indexOf("key: 'warranty'"));
  const body = entry.slice(0, entry.indexOf('}'));
  for (const flag of ['taxable', 'affectsTurnover', 'affectsHsn', 'affectsLiability', 'affectsAmendments']) {
    assert.match(body, new RegExp(flag + ':\\s*false'), flag + ' must be false');
  }
});

test('W5 no reporting surface reads the warranties table', () => {
  for (const f of [['client', 'js', 'gst', 'gstr1-export.js'], ['client', 'js', 'gst', 'gstr3b.js'],
                   ['client', 'js', 'reports', 'reports.js'], ['client', 'js', 'reports', 'dashboard.js']]) {
    assert.equal(/warrant/i.test(rd(...f)), false, f.join('/') + ' mentions warranty');
  }
});

// ── one record per warranted line ──
test('W6 records are created per invoice LINE, and only where cover exists', () => {
  assert.ok(CREATE.includes('.filter(it => monthsOf(it.warranty_period_months))'),
    'only lines that carry cover may produce a record');
  assert.ok(CREATE.includes('invoice_item_id'), 'the line id is recorded');
});

test('W7 a line already registered cannot be created twice', () => {
  // A line is matched by product across saves, because save-with-items
  // re-creates every row with a new id (see A6).
  assert.match(CREATE, /function lineKey\(row\)/);
  assert.match(CREATE, /claimed\.has\(w\.id\)/);
  // and the database refuses it even if the UI is bypassed
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_invoice_item/);
  assert.match(MIGRATION, /WHERE invoice_item_id IS NOT NULL/);
});

test('W8 the register is only written by a save that reached the database', () => {
  // Nothing runs before the invoice exists: the sync takes the caller's
  // transaction and never opens one of its own.
  assert.equal(/pool\.connect\(\)|BEGIN|COMMIT/.test(CREATE), false);
});

// ── status ──
test('W9 expiry is derived, never stored', () => {
  assert.match(UTILS, /const WARRANTY_STATUSES = \['active', 'cancelled'\]/);
  const fn = UTILS.slice(UTILS.indexOf('function warrantyEffectiveStatus'));
  const body = fn.slice(0, fn.search(/\r?\n\}/));
  assert.match(body, /return .*'expired'|\? 'expired'/);
  assert.match(MIGRATION, /status TEXT NOT NULL DEFAULT 'active'/);
});

test('W10 cancelled outranks the calendar', () => {
  const fn = UTILS.slice(UTILS.indexOf('function warrantyEffectiveStatus'));
  const body = fn.slice(0, fn.search(/\r?\n\}/));
  const cancelledAt = body.indexOf("'cancelled'");
  const expiredAt = body.indexOf("'expired'");
  assert.ok(cancelledAt > -1 && expiredAt > cancelledAt,
    'cancelled must be decided before the date is consulted');
});

// ── canonical URL: QR and NFC must agree ──
test('W11 one canonical verification URL, built in one place', () => {
  assert.match(CONFIG, /function warrantyVerifyUrl\(id\)/);
  assert.match(CONFIG, /warranty-verify\.html\?id=/);
});

test('W12 QR and NFC encode the SAME url and nothing else', () => {
  // both read the one input the canonical builder filled
  assert.match(DETAIL, /QRCode\.toCanvas\(canvas,\s*url/);
  assert.match(DETAIL, /records:\s*\[\{\s*recordType:\s*'url',\s*data:\s*url\s*\}\]/);
  const nfc = DETAIL.slice(DETAIL.indexOf('async function writeWarrantyNfc'),
                           DETAIL.indexOf('async function editWarrantySerial'));
  // no warranty field may be written onto the tag
  for (const f of ['customer_name', 'serial_number', 'purchase_amount', 'warranty_terms']) {
    assert.equal(nfc.includes(f), false, 'NFC payload must not carry ' + f);
  }
});

test('W13 the tag is never the source of truth', () => {
  // the public page asks the endpoint on every load rather than reading state
  assert.match(PUBLIC, /fetch\(API_BASE \+ '\/verify\/warranty\/'/);
  // and the endpoint computes the state itself
  assert.match(VERIFY, /const state = cancelled \? 'CANCELLED' : expired \? 'EXPIRED' : 'ACTIVE'/);
});

// ── NFC support handling ──
test('W14 unsupported browsers are told, not lied to', () => {
  assert.match(DETAIL, /'NDEFReader' in window/);
  assert.match(DETAIL, /NFC writing is not supported on this device\/browser/);
  const fn = DETAIL.slice(DETAIL.indexOf('async function writeWarrantyNfc'));
  // success is only reported after the browser's own write resolves
  const awaitAt = fn.indexOf('await ndef.write');
  const okAt = fn.indexOf('Written Successfully');
  assert.ok(awaitAt > -1 && okAt > awaitAt, 'success must follow the actual write');
  assert.match(fn, /catch \(err\)[\s\S]*Write Failed/);
});

// ── public endpoint security ──
test('W15 the public route validates the id by shape before querying', () => {
  const fn = VERIFY.slice(VERIFY.indexOf("router.get('/warranty/:id'"));
  assert.match(fn, /UUID_RE\.test/);
  const guardAt = fn.indexOf('UUID_RE.test');
  const queryAt = fn.indexOf('pool.query');
  assert.ok(guardAt < queryAt, 'the shape check must precede the query');
});

test('W16 the public query is parameterised and names one table', () => {
  const fn = VERIFY.slice(VERIFY.indexOf("router.get('/warranty/:id'"));
  assert.match(fn, /FROM warranties w/);
  assert.match(fn, /WHERE w\.id = \$1/);
  assert.match(fn, /\[req\.params\.id\]/);
  // no interpolation of anything request-supplied into the SQL
  assert.equal(/\$\{req\./.test(fn), false);
});

test('W17 the public response carries only approved fields', () => {
  const fn = VERIFY.slice(VERIFY.indexOf("router.get('/warranty/:id'"));
  const APPROVED = ['warranty_number', 'status', 'days_remaining', 'supplier_name', 'customer_name',
    'invoice_number', 'invoice_date', 'purchase_date', 'product_name', 'product_sku',
    'serial_number', 'quantity', 'warranty_period_months', 'warranty_start_date',
    'warranty_until', 'warranty_terms'];
  const body = fn.slice(fn.indexOf('warranty: {'), fn.indexOf('});'));
  const keys = [...body.matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1])
    .filter(k => k !== 'warranty');            // the wrapper, not a field
  for (const k of keys) assert.ok(APPROVED.includes(k), 'unapproved public field: ' + k);
  // and the things that must never be there
  for (const bad of ['user_id', 'customer_phone', 'notes', 'created_at', 'updated_at', 'invoice_id', 'id:']) {
    assert.equal(body.includes(bad), false, 'public response leaks ' + bad);
  }
});

test('W18 every failure answers one generic 404', () => {
  assert.match(VERIFY, /function warrantyNotFound\(res\)/);
  assert.match(VERIFY, /status\(404\)[\s\S]*WARRANTY_NOT_FOUND/);
  const fn = VERIFY.slice(VERIFY.indexOf("router.get('/warranty/:id'"));
  // bad shape and missing row take the same exit
  assert.equal((fn.match(/warrantyNotFound\(res\)/g) || []).length, 2);
});

test('W19 the existing invoice verification route is untouched', () => {
  assert.match(VERIFY, /const INVOICE_TABLES = \{ b2b: 'b2b_invoices', b2c: 'b2c_invoices' \}/);
  assert.match(VERIFY, /router\.get\('\/invoice\/:type\/:id'/);
  assert.match(VERIFY, /status: 'VALID_INVOICE'/);
});

// ── tenant isolation ──
test('W20 internal reads are scoped by the server, not the browser', () => {
  assert.match(GENERIC, /warranties: \{/);
  // the generic layer scopes on req.userId from the verified JWT
  assert.match(GENERIC, /buildWhere\(req\.query, ownerColumn, req\.userId, columns\)/);
  // nothing in the warranty pages sends a user id as a security argument
  for (const src of [LIST, DETAIL, CREATE]) {
    assert.equal(/workshopId|tenantId|role:/.test(src), false);
  }
});

// ── migration safety ──
test('W21 the migration is additive and alters no existing table', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS warranties/);
  assert.equal(/ALTER TABLE/i.test(MIGRATION), false, 'no existing table may be altered');
  // Statement-level, not word-level: ON DELETE CASCADE is a constraint
  // and BEFORE UPDATE names a trigger event. Neither rewrites a row, and
  // an earlier version of this test failed on both.
  assert.equal(/^\s*(UPDATE|INSERT|DELETE|TRUNCATE|DROP\s+TABLE)\b/im.test(MIGRATION), false,
    'the migration must contain no data-modifying statement');
});

test('W22 schema.sql carries the same table and the manifest registers it', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS warranties/);
  const manifest = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));
  assert.ok(manifest.order.includes('migration_warranty_register.sql'));
  assert.ok(fs.existsSync(path.join(ROOT, 'server', 'db', 'migrations', 'migration_warranty_register.sql')));
});

// ── the existing invoice warranty feature must be untouched ──
test('W23 invoice-level and item-level warranty still persist', () => {
  const gen = GENERIC;
  assert.match(gen, /'warranty_period_months','warranty_start_date','warranty_until','warranty_terms'\]/);
  const items = gen.slice(gen.indexOf('invoice_items: {'), gen.indexOf('vendors: {'));
  assert.match(items, /'warranty_period_months'/);
  for (const t of ['b2b_invoices', 'b2c_invoices']) {
    const start = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    const body = SCHEMA.slice(start, SCHEMA.indexOf('\n);', start));
    assert.match(body, /warranty_period_months INTEGER/);
    assert.match(body, /warranty_terms TEXT/);
  }
});

test('W24 the tax invoice PDF keeps its three copies and its warranty block', () => {
  const PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');
  const labels = PDF.slice(PDF.indexOf('INVOICE_COPY_LABELS = ['));
  const block = labels.slice(0, labels.indexOf(']'));
  for (const l of ['Original for Recipient', 'Duplicate for File Copy', 'Duplicate for Transporter'])
    assert.ok(block.includes(l), 'copy label missing: ' + l);
  assert.match(PDF, /function warrantyDetailLines\(inv\)/);
  assert.match(PDF, /doc\.text\('WARRANTY', L, wy\)/);
  // The per-line warranty COLUMN was removed from the product table by
  // instruction. The invoice-level WARRANTY block asserted above is a
  // different thing, and is now the only place cover is printed.
  assert.match(PDF, /warrantyLabel\(inv\.warranty_period_months\)/);
  assert.equal(/'Warranty'/.test(PDF), false, 'the warranty COLUMN must stay removed');
  // the invoice QR is still the invoice's own
  assert.match(PDF, /invoiceVerifyUrl\(inv\.type, inv\.id\)/);
});

test('W25 no serial number is ever invented', () => {
  assert.equal(/generateSerial|makeSerial|randomSerial/.test(CREATE + DETAIL), false);
  const ins = CREATE.slice(CREATE.indexOf('INSERT INTO warranties'));
  assert.ok(ins.includes(',NULL,'), 'serial must be inserted as NULL');
});

// ── the PDF's input object ──
// The bug this guards: buildInvoicePDFDoc() draws the WARRANTY block from the
// invoice object it is HANDED, and that object is built by fetchInvoiceRecord()
// from a named field list, not a spread. The columns existed, saved and read
// back correctly, but were never copied onto that object, so the block drew
// nothing. The per-item column kept working because line rows come back through
// select('*'), which is why the failure looked partial.
//
// Every earlier warranty test hand-built the invoice object with the fields
// already on it, which is exactly why they passed while the real path was broken.
test('W26 fetchInvoiceRecord carries the warranty header fields to the PDF', () => {
  const PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');
  const fn = PDF.slice(PDF.indexOf('async function fetchInvoiceRecord'));
  const body = fn.slice(0, fn.indexOf('items' + String.fromCharCode(10) + '  };'));
  for (const f of ['warranty_period_months', 'warranty_start_date', 'warranty_until', 'warranty_terms']) {
    assert.ok(body.includes(f + ': data.' + f),
      'fetchInvoiceRecord must copy ' + f + ' or the WARRANTY block cannot draw');
  }
});

// Same class of defect, one layer out: the code was right and the browser never
// saw it. A file must not share a ?v= with an older version of itself, so these
// four moved together when their contents last changed.
test('W27 every asset whose contents changed carries its own cache key', () => {
  const page = rd('invoice-list.html');
  // Each pinned to the version its CURRENT contents were published under.
  for (const [file, want] of [['client/js/utilities/utils.js', 33],
                              ['client/js/core/config.js', 33],
                              ['client/js/pages/invoice-pdf.js', 45],
                              ['client/js/pages/invoice-list.js', 34],
                              ['client/js/pages/invoice-items.js', 35]]) {
    assert.ok(page.includes(file + '?v=' + want), file + ' must be referenced at v=' + want);
  }
});
