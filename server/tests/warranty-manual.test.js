// Manual warranty creation: the properties that must hold for the Warranty
// Register to be a real master list with two working doors.
//
// Read from the source and the schema rather than from a running database,
// for the same reason the other warranty tests are: they assert structure
// that no amount of test data can prove. Comments are stripped before any
// assertion that looks for behaviour, so a test can never pass by matching
// the prose that describes the code instead of the code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const ROUTE_RAW = rd('server', 'src', 'routes', 'warranties.js');
const ROUTE = strip(ROUTE_RAW);
const SYNC = strip(rd('server', 'src', 'services', 'warranty-sync.js'));
const LIST = strip(rd('client', 'js', 'pages', 'warranty-list.js'));
const DETAIL = strip(rd('client', 'js', 'pages', 'warranty-detail.js'));
const APP = strip(rd('server', 'src', 'app.js'));
const GENERIC = strip(rd('server', 'src', 'routes', 'generic.js'));
const VERIFY = strip(rd('server', 'src', 'routes', 'verify.js'));
const CONFIG = strip(rd('client', 'js', 'core', 'config.js'));
const MIGRATION = rd('server', 'db', 'migrations', 'migration_warranty_register.sql');
const PAGE = rd('warranty-list.html');

// The three handlers, sliced so an assertion about one cannot be satisfied
// by something in another. The boundaries follow the file's order:
// POST /manual, then GET /search, then PATCH /:id.
const CREATE_FN = ROUTE.slice(ROUTE.indexOf("router.post('/manual'"), ROUTE.indexOf("router.get('/search'"));
const SEARCH_FN = ROUTE.slice(ROUTE.indexOf("router.get('/search'"), ROUTE.indexOf("router.patch('/:id'"));
const EDIT_FN = ROUTE.slice(ROUTE.indexOf("router.patch('/:id'"));

// ── 1. manual creation exists and is reachable ──
test('M1 the register can be written by hand, not only by an invoice', () => {
  assert.ok(CREATE_FN.length > 0, 'POST /manual must exist');
  assert.match(APP, /app\.use\('\/api\/warranties', warrantyRoutes\)/);
  // Mounted BEFORE the generic layer, or the generic router would answer first.
  assert.ok(APP.indexOf("app.use('/api/warranties', warrantyRoutes)") < APP.indexOf('mountGenericRoutes(app)'),
    'the warranty routes must be mounted before the generic ones');
  // The button that opens it, on the register page itself.
  assert.match(PAGE, /onclick="openAddWarranty\(\)"/);
  assert.match(PAGE, /Add Warranty/);
  assert.match(LIST, /async function openAddWarranty\(\)/);
});

// ── 2. warranty number reservation ──
test('M2 a manual warranty draws from the warranty book, inside the transaction', () => {
  assert.match(CREATE_FN, /reserveDocumentNumberOn\(client, req\.userId, 'warranty'\)/);
  // Drawn on the transaction's own client, so a failed insert rolls the
  // number back rather than leaving a hole in the book.
  assert.match(CREATE_FN, /BEGIN/);
  assert.match(CREATE_FN, /COMMIT/);
  assert.match(CREATE_FN, /ROLLBACK/);
  assert.ok(CREATE_FN.indexOf('reserveDocumentNumberOn') > CREATE_FN.indexOf('BEGIN'),
    'the number must be drawn inside the transaction');
  // It must never reach a tax invoice counter.
  assert.equal(/\/invoices\/reserve-number/.test(ROUTE), false);
  assert.equal(/invoice_current_sequence|invoice_series_sequences/.test(ROUTE), false);
  assert.match(CREATE_FN, /document_series/);
});

// ── 3. the list refreshes without a page reload ──
test('M3 a saved warranty refreshes the register in place', () => {
  const save = LIST.slice(LIST.indexOf('async function saveWarrantyForm'), LIST.indexOf('function wrRevealRow'));
  assert.match(save, /await reloadWarranties\(\)/);
  assert.match(save, /wrRevealRow\(saved\)/);
  // No page reload anywhere in the register page.
  assert.equal(/location\.reload\(\)/.test(LIST), false, 'the list must not reload the page');
  assert.match(LIST, /async function reloadWarranties\(\)/);
});

// ── 4. persistence: the row comes from the database, every time ──
test('M4 the register is read from the database, never from browser storage', () => {
  // One endpoint serves the searched and the unsearched read alike, so the
  // rows on screen always came from the database on this load.
  assert.match(LIST, /apiFetch\('\/warranties\/search'/);
  for (const bad of ['localStorage', 'sessionStorage']) {
    assert.equal(LIST.includes(bad), false, 'the register must not read ' + bad);
  }
});

// ── 5. edit updates in place ──
test('M5 editing updates the record and mints no second number', () => {
  assert.match(EDIT_FN, /UPDATE warranties SET/);
  assert.equal(/INSERT INTO warranties/.test(EDIT_FN), false, 'edit must never insert');
  assert.equal(/reserveDocumentNumberOn/.test(EDIT_FN), false, 'edit must never draw a number');
  // The identity of the record is not editable at all.
  for (const col of ['warranty_number', 'invoice_id', 'invoice_type', 'invoice_item_id',
                     'customer_name', 'product_name', 'document_series']) {
    assert.equal(new RegExp("set\\." + col + "\\s*=").test(EDIT_FN), false,
      col + ' must not be editable');
  }
  // and the client does not even send them
  const save = LIST.slice(LIST.indexOf('async function saveWarrantyForm'), LIST.indexOf('function wrRevealRow'));
  const patchCall = save.slice(save.indexOf("method: 'PATCH'"), save.indexOf('} else {'));
  assert.equal(/warranty_number|invoice_id|product_name/.test(patchCall), false);
});

// ── 6. search ──
test('M6 search covers customer, mobile, warranty no, product, invoice and serial', () => {
  // Searched in SQL, so a match is found whether or not its row was loaded.
  for (const col of ['warranty_number', 'customer_name', 'customer_phone',
                     'product_name', 'invoice_number', 'serial_number']) {
    assert.ok(new RegExp(col + '\\s+ILIKE').test(SEARCH_FN), 'search must cover ' + col);
  }
  assert.match(PAGE, /id="wrSearch"/);
  assert.match(PAGE, /placeholder="Customer name, mobile, warranty no, invoice, product or serial"/);

  // ONE search system: the browser must not also filter rows by the term,
  // which would silently disagree with the server.
  const filters = LIST.slice(LIST.indexOf('function warrantyMatchesFilters'),
                             LIST.indexOf('function warrantyStatusBadge'));
  for (const f of ['customer_name', 'product_name', 'invoice_number', 'serial_number', 'customer_phone']) {
    assert.equal(filters.includes('row.' + f), false,
      'the client must not re-filter on ' + f + '; the server owns the search');
  }
});

test('M6b a typed mobile number matches however it was stored', () => {
  // '98765 43210', '+91-98765-43210' and '9876543210' are one number, so the
  // stored value is reduced to digits and compared to the typed digits.
  assert.match(SEARCH_FN, /regexp_replace\(COALESCE\(customer_phone, ''\), '\[\^0-9\]', '', 'g'\)/);
  assert.match(SEARCH_FN, /const digits = q\.replace\(\/\\D\/g, ''\)/);
  assert.match(SEARCH_FN, /digits\.length >= 3/);
});

test('M6c the search term is bound and its wildcards escaped', () => {
  // Never concatenated into SQL.
  assert.equal(/\$\{q\}|' \+ q \+ '|\$\{req\.query/.test(SEARCH_FN), false,
    'the term must never be interpolated into SQL');
  assert.match(SEARCH_FN, /params\.push\('%' \+ esc \+ '%'\)/);
  // A typed % or _ searches for that character instead of matching everything.
  assert.match(SEARCH_FN, /q\.replace\(\/\[!%_\]\/g/);
  assert.match(SEARCH_FN, /ESCAPE '!'/);
});

test('M6d typing is debounced, and the term drives a fresh read', () => {
  assert.match(PAGE, /oninput="onWarrantySearchInput\(\)"/);
  assert.match(LIST, /function onWarrantySearchInput\(\)/);
  const fn = LIST.slice(LIST.indexOf('function onWarrantySearchInput'),
                        LIST.indexOf('function warrantyMatchesFilters'));
  assert.match(fn, /clearTimeout\(wrSearchTimer\)/);
  assert.match(fn, /setTimeout\(/);
  assert.match(fn, /loadWarranties\(\)/);
  // and a new term starts at page 1 rather than stranding the user on page 4
  assert.match(fn, /warrantyPage = 1/);
});

// ── 7. status filter ──
test('M7 the status filter offers All, Active, Cancelled and Expired', () => {
  const init = LIST.slice(LIST.indexOf('async function initWarrantyList'), LIST.indexOf('async function loadWarranties'));
  assert.match(init, /WARRANTY_STATUSES\.concat\(\['expired'\]\)/);
  assert.match(init, /<option value="">All<\/option>/);
  const fn = LIST.slice(LIST.indexOf('function warrantyMatchesFilters'), LIST.indexOf('function warrantyStatusBadge'));
  assert.match(fn, /warrantyEffectiveStatus\(row\) !== want/);
});

// ── 8/10. QR and NFC use the one canonical URL ──
test('M8 the list QR and the list NFC write the same canonical address', () => {
  assert.match(CONFIG, /function warrantyVerifyUrl\(id\)/);
  const qr = LIST.slice(LIST.indexOf('async function openWarrantyQr'), LIST.indexOf('function closeWarrantyQr'));
  assert.match(qr, /warrantyVerifyUrl\(r\.id\)/);
  assert.match(qr, /QRCode\.toCanvas\(canvas, url/);

  const nfc = LIST.slice(LIST.indexOf('async function writeWarrantyNfcFor'), LIST.indexOf('async function cancelWarranty'));
  assert.match(nfc, /warrantyVerifyUrl\(id\)/);
  assert.match(nfc, /records: \[\{ recordType: 'url', data: url \}\]/);
  // Nothing about the warranty itself may travel on the tag.
  for (const f of ['customer_name', 'serial_number', 'purchase_amount', 'warranty_terms', 'product_name']) {
    assert.equal(nfc.includes(f), false, 'the NFC payload must not carry ' + f);
  }
  // An unsupported browser is told, not given a button that quietly fails.
  assert.match(LIST, /'NDEFReader' in window/);
  assert.match(nfc, /not supported on this device\/browser/);
});

// ── 9. public verification is unchanged and still narrow ──
test('M9 a manual warranty verifies publicly through the same narrow endpoint', () => {
  const fn = VERIFY.slice(VERIFY.indexOf("router.get('/warranty/:id'"));
  assert.match(fn, /UUID_RE\.test/);
  // Scoped to the response object itself: user_id legitimately appears in the
  // JOIN that finds the supplier name, so asserting over the whole handler
  // would be testing the query rather than what is sent back.
  const body = fn.slice(fn.indexOf('res.json({'));
  for (const f of ['invoice_item_id', 'customer_phone', 'notes', 'user_id',
                   'cancel_reason', 'purchase_amount', 'rate']) {
    assert.equal(body.includes(f), false, 'the public response must not expose ' + f);
  }
  // and it still answers with the fields a customer actually needs
  for (const f of ['warranty_number', 'product_name', 'warranty_until', 'days_remaining']) {
    assert.ok(body.includes(f), 'the public response must carry ' + f);
  }
});

// ── 11. the invoice / item / product chain is validated on the server ──
test('M11 the server revalidates the whole chain under its own user scope', () => {
  // the invoice must belong to the caller
  assert.match(CREATE_FN, /FROM \$\{INVOICE_TABLES\[type\]\} WHERE id = \$1 AND user_id = \$2/);
  // the line must belong to THAT invoice, and to the same owner
  assert.match(CREATE_FN, /WHERE id = \$1 AND invoice_id = \$2 AND invoice_type = \$3 AND user_id = \$4/);
  assert.match(CREATE_FN, /That invoice was not found/);
  assert.match(CREATE_FN, /That product is not on the selected invoice/);
  // ids are shape-checked before they reach the database
  assert.match(CREATE_FN, /UUID_RE\.test\(String\(b\.invoice_id/);
  assert.match(CREATE_FN, /UUID_RE\.test\(String\(b\.invoice_item_id/);
  // and the type is chosen from a fixed map, never interpolated from the body
  assert.match(ROUTE, /const INVOICE_TABLES = \{ b2b: 'b2b_invoices', b2c: 'b2c_invoices' \}/);
  assert.match(CREATE_FN, /if \(!INVOICE_TABLES\[type\]\)/);
});

// ── 12. duplicate prevention, on both paths ──
test('M12 neither path can register the same cover twice', () => {
  // the database still guards the automatic path
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_invoice_item/);
  assert.match(MIGRATION, /WHERE invoice_item_id IS NOT NULL/);
  // and the hand-made path, which carries no invoice_item_id, is guarded here
  assert.match(CREATE_FN, /SELECT warranty_number FROM warranties/);
  assert.match(CREATE_FN, /status <> 'cancelled'/);
  assert.match(CREATE_FN, /already covered by/);
  // the check runs BEFORE a number is spent
  assert.ok(CREATE_FN.indexOf('already covered by') < CREATE_FN.indexOf('reserveDocumentNumberOn'),
    'the duplicate check must run before the number is drawn');
  // a direct insert that would bypass all of this is closed off
  const w = GENERIC.slice(GENERIC.indexOf('warranties: {'), GENERIC.indexOf('vendors: {'));
  assert.match(w, /insertable: false/);
});

// ── 13. tenant isolation ──
test('M13 every read and write is scoped to the verified user', () => {
  const queries = ROUTE.match(/client\.query\(|pool\.query\(/g) || [];
  assert.ok(queries.length >= 5, 'expected several queries');
  // Every handler scopes on the JWT's user, and filters on the column.
  for (const [name, fn] of [['create', CREATE_FN], ['search', SEARCH_FN], ['edit', EDIT_FN]]) {
    assert.ok(/req\.userId/.test(fn), name + ' must take its owner from req.userId');
    assert.ok(/user_id/.test(fn), name + ' must filter on user_id');
  }
  // and never on anything the browser sent
  assert.equal(/req\.body\.user_id|b\.user_id|workshopId|workshop_id|tenantId/.test(ROUTE), false,
    'ownership must never come from the request body');
  assert.match(EDIT_FN, /WHERE id = \$1 AND user_id = \$2/);
  // The search's owner clause is the FIRST thing in its WHERE, and is not
  // something a query string can remove.
  assert.match(SEARCH_FN, /let where = 'user_id = \$1'/);
  assert.match(SEARCH_FN, /const params = \[req\.userId\]/);
});

test('M13b the search endpoint cannot widen the public verification response', () => {
  // The internal list may carry the phone; the public QR answer may not.
  const pub = VERIFY.slice(VERIFY.indexOf("router.get('/warranty/:id'"));
  const body = pub.slice(pub.indexOf('res.json({'));
  assert.equal(body.includes('customer_phone'), false,
    'the public endpoint must never expose customer_phone');
  // and the public route is not what the list search calls
  assert.equal(/warranties\/search/.test(VERIFY), false);
});

// ── 14. the automatic path still works ──
test('M14 invoice auto-registration is untouched', () => {
  assert.match(SYNC, /async function syncWarrantiesForInvoice/);
  assert.match(SYNC, /reserveNumber\(client, userId, 'warranty'\)/);
  assert.match(SYNC, /INSERT INTO warranties/);
  // still per covered line, still cancelling rather than deleting
  assert.match(SYNC, /filter\(it => monthsOf\(it\.warranty_period_months\)\)/);
  assert.match(SYNC, /SET status = 'cancelled', cancelled_at = NOW\(\)/);
  const INV = strip(rd('server', 'src', 'routes', 'invoices.js'));
  assert.match(INV, /syncWarrantiesForInvoice\(/);
  assert.ok(INV.indexOf('syncWarrantiesForInvoice(') < INV.indexOf("client.query('COMMIT')"),
    'the sync must still run before the invoice commits');
});

// ── 15. the two kinds coexist ──
test('M15 a re-saved invoice cannot touch a hand-made record', () => {
  // The sync reconciles only rows it created, and every row it creates
  // carries the invoice line it was made from.
  const read = SYNC.slice(SYNC.indexOf('SELECT id, invoice_item_id'), SYNC.indexOf('const covered'));
  assert.match(read, /AND invoice_item_id IS NOT NULL/);
  // A hand-made record deliberately stores none, so it falls outside that set.
  assert.match(CREATE_FN, /invoice_item_id[\s\S]{0,400}VALUES \(\$1,\$2,'warranty',\$3,\$4,NULL,/);
  // which is also what the UI uses to label the two apart
  assert.match(LIST, /function warrantySource\(row\)[\s\S]{0,120}invoice_item_id \? 'invoice_auto' : 'manual'/);
});

// ── 16. nothing descriptive is taken from the browser ──
test('M16 no invoice or product detail is ever taken from the request', () => {
  const insert = CREATE_FN.slice(CREATE_FN.indexOf('INSERT INTO warranties'));
  // Every copied field is read off the invoice/item rows the server fetched.
  for (const f of ['invoice.invoice_number', 'invoice.invoice_date', 'invoice.customer_name',
                   'item.product_id', 'item.product_name', 'item.rate']) {
    assert.ok(insert.includes(f), 'the insert must take ' + f + ' from the database row');
  }
  // Neither invoice table carries a customer_id, so the register stores NULL
  // rather than inventing one. Asserted so a future "helpful" fill-in from
  // the request body has to break a test first.
  assert.equal(/invoice\.customer_id/.test(CREATE_FN), false);
  assert.equal(/b\.customer_id/.test(CREATE_FN), false);
  // and none of them is read off the body
  for (const f of ['customer_name', 'product_name', 'invoice_number', 'invoice_date',
                   'product_sku', 'purchase_amount', 'rate']) {
    assert.equal(new RegExp('b\\.' + f).test(CREATE_FN), false,
      f + ' must never come from the request body');
  }
  // no serial number is ever invented
  assert.equal(/generateSerial|makeSerial|randomSerial/.test(ROUTE + LIST), false);
});

// ── 17. a failed read is not an empty register ──
test('M17 an API failure is reported as a failure, never as "no warranties"', () => {
  assert.match(LIST, /let warrantyListState = 'loading'/);
  const load = LIST.slice(LIST.indexOf('async function loadWarranties'), LIST.indexOf('async function reloadWarranties'));
  assert.match(load, /warrantyListState = 'error'/);
  assert.match(load, /warrantyListState = 'ready'/);
  // the failure branch must not blank the rows
  const fail = load.slice(load.indexOf('catch'));
  assert.equal(/warrantyRows = \[\]/.test(fail), false, 'a failed read must not empty the rows');

  const render = LIST.slice(LIST.indexOf('function renderWarrantyList'), LIST.indexOf('function renderWarrantyPagination'));
  assert.match(render, /Loading warranties/);
  assert.match(render, /Could not load Warranty List\. Please try again\./);
  assert.match(render, /No warranties yet/);
  // "No warranties yet" is only reachable once the read succeeded
  const emptyAt = render.indexOf('No warranties yet');
  const errorAt = render.indexOf("warrantyListState === 'error'");
  assert.ok(errorAt > -1 && errorAt < emptyAt, 'the error state must be handled before the empty state');
});

// ── the schema was not weakened to make any of this work ──
test('M18 no migration, no altered table, no relaxed constraint', () => {
  assert.equal(/ALTER TABLE/i.test(MIGRATION), false, 'no existing table may be altered');
  assert.match(MIGRATION, /invoice_id UUID NOT NULL/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_number/);
  // the register still has exactly one table
  const files = fs.readdirSync(path.join(ROOT, 'server', 'db', 'migrations'));
  const warrantyTables = files.filter(f => /warrant/i.test(f))
    .map(f => rd('server', 'db', 'migrations', f))
    .join('\n').match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || [];
  assert.deepEqual(warrantyTables, ['CREATE TABLE IF NOT EXISTS warranties'],
    'there must be exactly one warranty table');
});

// ── the changed assets carry their own cache keys ──
test('M19 every asset whose contents changed carries a new cache key', () => {
  assert.ok(PAGE.includes('client/js/pages/warranty-list.js?v=38'),
    'warranty-list.js must be referenced at v=38');
  assert.ok(rd('warranty.html').includes('client/js/pages/warranty-detail.js?v=37'),
    'warranty-detail.js must be referenced at v=37');
});

// ── the detail page routes Edit to the one editor ──
test('M20 Warranty Details offers Edit, and reuses the register editor', () => {
  assert.match(DETAIL, /warranty-list\.html\?edit=/);
  assert.match(LIST, /const editId = params\.get\('edit'\)/);
  assert.match(LIST, /async function openEditWarranty\(id\)/);
});
