// New Invoice: B2C by default, B2B as soon as a GST Number is entered.
//
// Two halves. The page's own invoice-entry.js runs in a sandbox with a
// small fake DOM and every flow that touches the GST Number is driven the
// way the browser drives it: typing, clearing, the toggle, a Customer
// Master match, a GST register fetch, a restored draft, Edit, Duplicate,
// Reset and Save. Only helpers unrelated to the type (items, warranty,
// shipping, payment) are stubbed. The other half saves and reloads real
// invoices through the API on a DISPOSABLE database - skipped unless
// STOCK_TEST_DATABASE_URL names one - because the server refuses a B2C
// with a GST Number and a B2B without one whoever sends it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');
const HTML = rd('invoice.html');
const ROUTE = rd('server', 'src', 'routes', 'invoices.js');

// Checksum-valid, so they pass the page's own validateGstin().
const GSTIN = '24AAMCM2964J1Z4';
const GSTIN_2 = '27AAPFU0939F1ZV';

const noop = () => {};

function load() {
  const store = new Map();
  const mk = (value = '') => ({
    value, checked: false, textContent: '', innerHTML: '', className: '', readOnly: false, disabled: false,
    style: {}, dataset: {}, onclick: null,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, dispatchEvent: noop, focus: noop, select: noop, scrollIntoView: noop
  });
  const el = id => { if (!store.has(id)) store.set(id, mk()); return store.get(id); };
  // The markup: two radios, B2C checked.
  const b2b = el('invTypeB2B'); b2b.value = 'b2b';
  const b2c = el('invTypeB2C'); b2c.value = 'b2c'; b2c.checked = /id="invTypeB2C" value="b2c" checked/.test(HTML);
  const session = new Map();

  const sb = {
    console: { log: noop, warn: noop, error: noop }, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN, Symbol,
    Event: class { constructor(type) { this.type = type; } },
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x', replace: noop },
    localStorage: { getItem: () => 'test-jwt', setItem: noop, removeItem: noop },
    sessionStorage: {
      getItem: k => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)), removeItem: k => session.delete(k)
    },
    document: {
      documentElement: mk(), body: mk(), head: mk(),
      getElementById: el,
      querySelector: sel => (sel === 'input[name="invType"]:checked' ? [b2b, b2c].find(r => r.checked) || null : null),
      querySelectorAll: () => [], addEventListener: noop, createElement: () => mk()
    },
    alert: noop,
    fetch: async () => { throw new Error('no network in this test'); },
    __toasts: [], __saved: [], __draft: {}, __rec: null, __fetchBody: null
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(ENTRY, sb, { filename: 'invoice-entry.js' });
  vm.runInContext(`
    showToast = function (m, k) { __toasts.push({ m: m, k: k }); };
    getCachedProfile = function () { return { state: 'Tamil Nadu', gstin: '33AABCU9603R1ZX' }; };
    getCurrentUser = async function () { return { id: 'u1' }; };
    handleApiError = function () {};
    apiErrorFrom = function () { return new Error('api'); };
    if (typeof API_BASE_URL === 'undefined') API_BASE_URL = '/api';
    if (typeof INVOICE_SOURCE_DEFAULT === 'undefined') INVOICE_SOURCE_DEFAULT = 'offline';
    if (typeof GST_CUSTOMER_CATEGORY_DEFAULT === 'undefined') GST_CUSTOMER_CATEGORY_DEFAULT = 'regular';
    if (typeof INVOICE_LIST_RETURN_KEY === 'undefined') INVOICE_LIST_RETURN_KEY = 'invoice_list_return';

    // Other files' helpers the flows call - not what is under test.
    for (const name of ['restoreItemsFromDraft', 'loadItemsIntoTable', 'synthesizeLegacyItemRow',
      'restoreInvoiceTransport', 'resetInvoiceItems', 'clearDraft', 'clearItemsDraft',
      'populateDistrictList', 'syncDistrictField', 'setListReturnState', 'recordPayment']) {
      if (typeof globalThis[name] !== 'function') globalThis[name] = function () {};
    }
    if (typeof matchIndianState !== 'function') matchIndianState = function () { return ''; };
    if (typeof toISO !== 'function') toISO = function () { return '2026-09-11'; };
    peekListReturnState = function () { return null; };
    restoreDraft = function () {
      for (const k of Object.keys(__draft)) document.getElementById(k).value = __draft[k];
    };
    const chain = { select: () => chain, eq: () => chain, single: () => chain, order: () => chain };
    _supabase = { from: () => chain };
    readMaybeOne = async function () { return __rec; };
    readAll = async function () { return [[]]; };
    saveInvoiceWithItems = async function (type, header) { __saved.push({ type: type, header: header }); return 'saved-id'; };

    // This file's own helpers for things other than the invoice type:
    // shipping, warranty, series, payment, export. Stubbed so each flow
    // below runs only its type-related code for real.
    onInvShipSameChange = function () {}; mirrorInvShipFromBilling = function () {};
    applyCustomerGstCategory = function () {}; restoreWarrantyFields = function () {};
    resetWarrantyFields = function () {}; setInvoiceSourceValue = function () {};
    setInvGstCategory = function () {}; setPaymentSectionMode = function () {};
    onTransportToggleChange = function () {}; restoreExportFields = function () {};
    restoreEcomFields = function () {}; onInvPaymentStatusChange = function () {};
    generateInvoiceNo = async function () {};
    buildInvShipTo = function () { return {}; }; collectWarrantyHeader = function () { return {}; };
    validateInvPaymentAmount = function () { return true; };
    showInvoiceSavedPanel = function () {}; markProformaConverted = async function () {};
    getInvoiceSource = function () { return 'offline'; }; getInvGstCategory = function () { return 'regular'; };
    isAutoInvoiceOn = function () { return false; };
  `, sb);

  sb.__el = el;
  sb.type = () => sb.getSelectedInvoiceType();
  sb.flag = () => vm.runInContext('invTypeChosenByUser', sb);
  // What the browser does when the user types into / empties the field.
  sb.typeGstin = v => { el('invGstin').value = v; sb.onInvoiceGstinInput(el('invGstin')); };
  // What the browser does when the user clicks a radio.
  sb.click = t => { b2b.checked = t === 'b2b'; b2c.checked = t === 'b2c'; sb.onInvoiceTypeToggle(); };
  return sb;
}

// ═══════════════════════════════════════════════════════════════════════
//  1. The page
// ═══════════════════════════════════════════════════════════════════════

test('A1 a fresh invoice is B2C', () => {
  assert.match(HTML, /id="invTypeB2C" value="b2c" checked/, 'the markup checks B2C');
  assert.ok(!/id="invTypeB2B" value="b2b" checked/.test(HTML), 'and not B2B');
  assert.match(HTML, /id="invClassifyBadge" class="badge badge-green" style="font-size:12px;">B2C</);
  const sb = load();
  assert.strictEqual(sb.type(), 'b2c');
  // Both options stay on the page.
  assert.match(HTML, /id="invTypeB2B" value="b2b"/);
});

test('A2 entering a GST Number switches to B2B', () => {
  const sb = load();
  sb.typeGstin(GSTIN.toLowerCase());
  assert.strictEqual(sb.type(), 'b2b');
  assert.strictEqual(sb.__el('invGstin').value, GSTIN, 'upper-cased as before');
  assert.strictEqual(sb.__el('invClassifyBadge').textContent, 'B2B');
  assert.match(sb.__el('invModeHeaderText').textContent, /^B2B/);
  // Even the first character counts: the field is non-empty.
  const sb2 = load();
  sb2.typeGstin('2');
  assert.strictEqual(sb2.type(), 'b2b');
});

test('A3 clearing the GST Number switches back to B2C', () => {
  const sb = load();
  sb.typeGstin(GSTIN);
  sb.typeGstin('');
  assert.strictEqual(sb.type(), 'b2c');
  assert.strictEqual(sb.__el('invClassifyBadge').textContent, 'B2C');
  sb.typeGstin('   ');
  assert.strictEqual(sb.type(), 'b2c', 'blank is empty');
});

test('A4 entering a GST Number again switches to B2B again', () => {
  const sb = load();
  sb.typeGstin(GSTIN); sb.typeGstin(''); sb.typeGstin(GSTIN_2);
  assert.strictEqual(sb.type(), 'b2b');
});

test('A5 choosing B2C with a GST Number clears it, stays B2C, and says so', () => {
  const sb = load();
  sb.typeGstin(GSTIN);
  assert.strictEqual(sb.type(), 'b2b');
  sb.click('b2c');
  assert.strictEqual(sb.type(), 'b2c', 'remains B2C');
  assert.strictEqual(sb.__el('invGstin').value, '', 'no GST Number left on a B2C invoice');
  assert.ok(sb.__toasts.some(t => /GST Number cleared/.test(t.m)), 'the user is told');
  // ...and a GST Number typed afterwards makes it B2B again.
  sb.typeGstin(GSTIN);
  assert.strictEqual(sb.type(), 'b2b');
  // Choosing B2C on an invoice with no GST Number clears nothing and says nothing.
  const sb2 = load();
  sb2.click('b2c');
  assert.strictEqual(sb2.__toasts.length, 0);
});

test('A6 choosing B2B without a GST Number is allowed and stays B2B', () => {
  const sb = load();
  sb.click('b2b');
  assert.strictEqual(sb.type(), 'b2b');
  assert.strictEqual(sb.flag(), true, 'remembered as the user\'s choice');
  // Typing and then clearing a GST Number does not undo a deliberate B2B.
  sb.typeGstin(GSTIN); sb.typeGstin('');
  assert.strictEqual(sb.type(), 'b2b');
  // B2B still requires the GST Number at Save, exactly as before.
  assert.match(ENTRY, /if \(type === 'b2b' && !gstin\) \{ showToast\('B2B is selected — enter the customer\\'s GST Number, or switch to B2C\.', 'error'\); return; \}/);
});

test('A7 a GST Number entered by B2B auto-selection is not a deliberate choice', () => {
  const sb = load();
  sb.typeGstin(GSTIN);
  assert.strictEqual(sb.flag(), false);
  sb.click('b2b');          // the user now clicks B2B themselves
  sb.typeGstin('');
  assert.strictEqual(sb.type(), 'b2b', 'after a deliberate click, clearing keeps B2B');
});

test('A8 picking a Customer Master customer with a GSTIN switches to B2B', () => {
  const sb = load();
  vm.runInContext(`invoiceCustomersList = [
    { id: 'c1', name: 'Mega Kitchen', gstin: '${GSTIN.toLowerCase()}', phone: '', address: '', state: '' },
    { id: 'c2', name: 'Cash Buyer', gstin: '', phone: '', address: '', state: '' }];`, sb);
  sb.__el('invCustName').value = 'Mega Kitchen';
  sb.onInvoiceCustomerInput();
  assert.strictEqual(sb.__el('invGstin').value, GSTIN);
  assert.strictEqual(sb.type(), 'b2b');
  // A customer without a GSTIN leaves a fresh invoice B2C.
  const sb2 = load();
  vm.runInContext(`invoiceCustomersList = [{ id: 'c2', name: 'Cash Buyer', gstin: '' }];`, sb2);
  sb2.__el('invCustName').value = 'Cash Buyer';
  sb2.onInvoiceCustomerInput();
  assert.strictEqual(sb2.type(), 'b2c');
});

test('A9 a GST register fetch lands on B2B', async () => {
  const sb = load();
  // The number is in the field (e.g. pasted before the page reacted) but
  // the invoice is still B2C; Fetch must leave it B2B.
  sb.__el('invGstin').value = GSTIN;
  sb.fetch = async () => ({ ok: true, json: async () => ({ taxpayer: { gstin: GSTIN, tradeName: 'Mega Kitchen', status: 'Active' } }) });
  await sb.verifyInvoiceGstin();
  assert.strictEqual(sb.__el('invCustName').value, 'Mega Kitchen');
  assert.strictEqual(sb.type(), 'b2b');
});

test('A10 a restored draft takes its type from the GST Number it brings back', () => {
  const sb = load();
  sb.__draft = { invGstin: GSTIN, invCustName: 'Draft Co' };
  sb.restoreInvoiceDraftFull('invoice_invoice');
  assert.strictEqual(sb.type(), 'b2b');
  const sb2 = load();
  sb2.__draft = { invGstin: '', invCustName: 'Walk-in Customer' };
  sb2.restoreInvoiceDraftFull('invoice_invoice');
  assert.strictEqual(sb2.type(), 'b2c');
});

test('A11 Edit keeps the saved type', async () => {
  // A B2B invoice opens as B2B, and clearing its GST Number does not move it.
  const sb = load();
  sb.__rec = { id: 'i1', gst_number: GSTIN, customer_name: 'Mega', invoice_number: 'INV-1', invoice_source: 'offline' };
  await sb.loadInvoiceForEdit('b2b', 'i1');
  assert.strictEqual(sb.type(), 'b2b');
  assert.strictEqual(sb.__el('invGstin').value, GSTIN);
  sb.typeGstin('');
  assert.strictEqual(sb.type(), 'b2b', 'the saved B2B type is kept');

  // A B2C invoice opens as B2C; entering a GST Number makes it B2B.
  const sb2 = load();
  sb2.__rec = { id: 'i2', gst_number: null, customer_name: 'Walk-in Customer', invoice_number: 'INV-2', invoice_source: 'offline' };
  await sb2.loadInvoiceForEdit('b2c', 'i2');
  assert.strictEqual(sb2.type(), 'b2c');
  assert.strictEqual(sb2.__toasts.length, 0);
  sb2.typeGstin(GSTIN);
  assert.strictEqual(sb2.type(), 'b2b');

  // A B2B invoice saved with a blank GST Number keeps B2B.
  const sb3 = load();
  sb3.__rec = { id: 'i3', gst_number: '', customer_name: 'Old B2B', invoice_number: 'INV-3', invoice_source: 'offline' };
  await sb3.loadInvoiceForEdit('b2b', 'i3');
  assert.strictEqual(sb3.type(), 'b2b');
});

test('A12 an old B2C invoice that carries a GST Number is not re-typed, but warned about', async () => {
  const sb = load();
  sb.__rec = { id: 'i4', gst_number: GSTIN, customer_name: 'Legacy', invoice_number: 'INV-4', invoice_source: 'offline' };
  await sb.loadInvoiceForEdit('b2c', 'i4');
  assert.strictEqual(sb.type(), 'b2c', 'not switched on the user\'s behalf');
  assert.strictEqual(sb.__el('invGstin').value, GSTIN, 'and nothing cleared on the user\'s behalf');
  assert.ok(sb.__toasts.some(t => t.k === 'warning' && /saved as B2C with a GST Number/.test(t.m)));
});

test('A13 Duplicate: a GST Number makes the copy B2B; without one it keeps the source type', async () => {
  const run = async draft => {
    const sb = load();
    sb.sessionStorage.setItem('invoice_duplicate_draft', JSON.stringify({ invoice_source: 'offline', ...draft }));
    await sb.loadInvoiceDuplicateDraft();
    return sb;
  };
  assert.strictEqual((await run({ type: 'b2b', gst_number: GSTIN })).type(), 'b2b');
  assert.strictEqual((await run({ type: 'b2c', gst_number: null })).type(), 'b2c');
  // An old B2C source with a GST Number becomes a B2B copy.
  const legacy = await run({ type: 'b2c', gst_number: GSTIN });
  assert.strictEqual(legacy.type(), 'b2b');
  // A B2B source without one stays B2B, deliberately.
  const bare = await run({ type: 'b2b', gst_number: '' });
  assert.strictEqual(bare.type(), 'b2b');
  bare.typeGstin(GSTIN); bare.typeGstin('');
  assert.strictEqual(bare.type(), 'b2b');
});

test('A14 Reset returns to B2C and forgets a deliberate B2B', () => {
  const sb = load();
  sb.click('b2b');
  sb.typeGstin(GSTIN);
  sb.clearInvoiceFormFields();
  assert.strictEqual(sb.type(), 'b2c');
  assert.strictEqual(sb.__el('invGstin').value, '');
  assert.strictEqual(sb.flag(), false);
  sb.typeGstin(GSTIN); sb.typeGstin('');
  assert.strictEqual(sb.type(), 'b2c', 'after Reset, clearing returns to B2C again');
});

test('A15 Save sends B2C without a GST Number and B2B with one, and refuses the mixes', async () => {
  const fill = sb => {
    sb.__el('invCustName').value = 'Buyer'; sb.__el('invNum').value = 'INV-9';
    sb.__el('invDate').value = '2026-09-11'; sb.__el('invState').value = 'Tamil Nadu';
  };
  // B2C: saved as b2c, gst_number null.
  let sb = load(); fill(sb);
  await sb.saveInvoice();
  assert.strictEqual(sb.__saved.length, 1);
  assert.strictEqual(sb.__saved[0].type, 'b2c');
  assert.strictEqual(sb.__saved[0].header.gst_number, null);

  // B2B: saved as b2b with the GST Number.
  sb = load(); fill(sb); sb.typeGstin(GSTIN);
  await sb.saveInvoice();
  assert.strictEqual(sb.__saved[0].type, 'b2b');
  assert.strictEqual(sb.__saved[0].header.gst_number, GSTIN);

  // B2C carrying a GST Number (an old invoice): refused before anything is sent.
  sb = load(); fill(sb);
  sb.__el('invGstin').value = GSTIN;     // loaded, not typed
  await sb.saveInvoice();
  assert.strictEqual(sb.__saved.length, 0);
  assert.ok(sb.__toasts.some(t => t.k === 'error' && /a B2C invoice cannot carry a GST Number/.test(t.m)));

  // B2B without one: refused, as it always was.
  sb = load(); fill(sb); sb.click('b2b');
  await sb.saveInvoice();
  assert.strictEqual(sb.__saved.length, 0);
  assert.ok(sb.__toasts.some(t => /B2B is selected — enter the customer's GST Number/.test(t.m)));
});

test('A16 the invoice scanner still sets B2B through the same handlers', () => {
  const SCAN = rd('client', 'js', 'pages', 'invoice-scan.js');
  assert.match(SCAN, /if \(inv\.customer\.gstin && typeof setInvoiceTypeToggle === 'function'\) setInvoiceTypeToggle\('b2b'\);/);
  assert.match(SCAN, /onInvoiceGstinInput\(gstEl\)/);
});

test('A17 the page loads the changed script under a new cache key only', () => {
  assert.match(HTML, /client\/js\/pages\/invoice-entry\.js\?v=37/);
  // The other invoice scripts keep their keys.
  assert.match(HTML, /client\/js\/pages\/invoice-items\.js\?v=40/);
  assert.match(HTML, /client\/js\/pages\/invoice-pdf\.js\?v=51/);
});

test('A18 the server refuses B2C with a GST Number and B2B without one', () => {
  const fn = ROUTE.slice(ROUTE.indexOf("router.post('/:type/save-with-items'"));
  const at = fn.indexOf("e.code = 'b2c_gstin_not_allowed'");
  assert.ok(at > 0 && fn.indexOf("e.code = 'b2b_gstin_required'") > 0);
  assert.ok(at < fn.indexOf("client.query('BEGIN')"), 'judged before anything is written');
});

// ═══════════════════════════════════════════════════════════════════════
//  2. Saving and reloading, against a disposable database
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('invoice type API (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'invoice-type-test-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function startServer(port) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: SCRATCH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', d => { out += d; if (out.includes('listening on')) { clearTimeout(done); resolve(child); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

let server, base, db, USER_A, TOKEN_A, PRODUCT_A;

async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const errOf = r => (r && r.body && r.body.error) || {};

let seq = 0;
function header(gst, extra = {}) {
  return { customer_name: 'Type Test Co', invoice_number: 'TY-' + (++seq), invoice_date: '2026-09-11',
    supply_type: 'intrastate', gst_number: gst, taxable_amount: 2700, gst_percentage: 18, gst_amount: 486,
    igst: 0, cgst: 243, sgst: 243, total_amount: 3186, ...extra };
}
const line = () => ([{
  product_id: PRODUCT_A, product_name: 'Machine', hsn_code: '84388090', unit: 'PCS',
  quantity: 1, rate: 2700, discount_percentage: 0, gst_percentage: 18,
  taxable_value: 2700, gst_amount: 486, gst_treatment: 'taxable',
  igst: 0, cgst: 243, sgst: 243, cess_rate: 0, cess_amount: 0, total_amount: 3186
}]);
const save = (type, body, token = TOKEN_A) => api('POST', `/api/invoices/${type}/save-with-items`, { token, body });
const read = async (type, id) => (await api('GET', `/api/${type}_invoices?eq_id=${id}`, { token: TOKEN_A })).body;
const count = async table => (await db.query(`SELECT COUNT(*)::int n FROM ${table} WHERE user_id = $1`, [USER_A])).rows[0].n;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(`INSERT INTO users (email,password_hash) VALUES ('type-a@scratch.test','x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [USER_A]);
  await db.query(`INSERT INTO stock_locations (user_id,name,code,is_default,active) VALUES ($1,'Main','MAIN',TRUE,TRUE)`, [USER_A]);
  PRODUCT_A = (await db.query(`INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock)
    VALUES ($1,'Machine','84388090','PCS',18,500) RETURNING id`, [USER_A])).rows[0].id;
  const loc = (await db.query('SELECT id FROM stock_locations WHERE user_id=$1 AND is_default LIMIT 1', [USER_A])).rows[0].id;
  await db.query(`INSERT INTO stock_balances (user_id, product_id, location_id, quantity) VALUES ($1,$2,$3,500)`, [USER_A, PRODUCT_A, loc]);
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('S1 a B2B invoice with a GST Number saves and reloads as B2B', async () => {
  const r = await save('b2b', { editId: null, header: header(GSTIN), items: line() });
  assert.strictEqual(r.status, 200, errOf(r).message);
  const [row] = await read('b2b', r.body.invoiceId);
  assert.strictEqual(row.gst_number, GSTIN);
  assert.strictEqual((await read('b2c', r.body.invoiceId)).length, 0, 'not in the B2C table');
});

test('S2 a B2C invoice without a GST Number saves and reloads as B2C', async () => {
  const r = await save('b2c', { editId: null, header: header(null, { customer_name: 'Walk-in Customer' }), items: line() });
  assert.strictEqual(r.status, 200, errOf(r).message);
  const [row] = await read('b2c', r.body.invoiceId);
  assert.strictEqual(row.gst_number, null);
  assert.strictEqual((await read('b2b', r.body.invoiceId)).length, 0, 'not in the B2B table');
});

test('S3 a B2C invoice carrying a GST Number is refused, and nothing is written', async () => {
  const before = await count('b2c_invoices');
  const r = await save('b2c', { editId: null, header: header(GSTIN), items: line() });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(errOf(r).code, 'b2c_gstin_not_allowed');
  assert.match(errOf(r).message, /A B2C invoice cannot carry a GST Number/);
  assert.strictEqual(await count('b2c_invoices'), before);
});

test('S4 a B2B invoice without a GST Number is refused plainly, not with a database error', async () => {
  const before = await count('b2b_invoices');
  for (const gst of [null, '', '   ']) {
    const r = await save('b2b', { editId: null, header: header(gst), items: line() });
    assert.strictEqual(r.status, 400, `gst_number ${JSON.stringify(gst)}`);
    assert.strictEqual(errOf(r).code, 'b2b_gstin_required');
  }
  const omitted = header(null); delete omitted.gst_number;
  const r = await save('b2b', { editId: null, header: omitted, items: line() });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(await count('b2b_invoices'), before);
});

test('S5 editing a B2C invoice keeps it B2C', async () => {
  const made = await save('b2c', { editId: null, header: header(null), items: line() });
  assert.strictEqual(made.status, 200, errOf(made).message);
  const id = made.body.invoiceId;
  const r = await save('b2c', { editId: id, header: header(null, { customer_name: 'Renamed Buyer', invoice_number: 'TY-E1' }), items: line() });
  assert.strictEqual(r.status, 200, errOf(r).message);
  const [row] = await read('b2c', id);
  assert.strictEqual(row.customer_name, 'Renamed Buyer');
  assert.strictEqual(row.gst_number, null);
  assert.strictEqual((await read('b2b', id)).length, 0);
});

test('S6 editing a B2B invoice keeps its GST Number; blanking it is refused', async () => {
  const made = await save('b2b', { editId: null, header: header(GSTIN), items: line() });
  assert.strictEqual(made.status, 200, errOf(made).message);
  const id = made.body.invoiceId;
  let r = await save('b2b', { editId: id, header: header(GSTIN_2, { invoice_number: 'TY-E2' }), items: line() });
  assert.strictEqual(r.status, 200, errOf(r).message);
  assert.strictEqual((await read('b2b', id))[0].gst_number, GSTIN_2);
  r = await save('b2b', { editId: id, header: header('', { invoice_number: 'TY-E2' }), items: line() });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(errOf(r).code, 'b2b_gstin_required');
  assert.strictEqual((await read('b2b', id))[0].gst_number, GSTIN_2, 'unchanged by the refused edit');
  // An edit that does not mention the GST Number is not judged on it.
  const partial = header(null, { invoice_number: 'TY-E2', customer_name: 'Partial Edit Co' });
  delete partial.gst_number;
  r = await save('b2b', { editId: id, header: partial, items: line() });
  assert.strictEqual(r.status, 200, errOf(r).message);
  const [row] = await read('b2b', id);
  assert.strictEqual(row.customer_name, 'Partial Edit Co');
  assert.strictEqual(row.gst_number, GSTIN_2);
});

test('S7 an old B2C invoice carrying a GST Number still reads, and saves once cleared', async () => {
  const { rows } = await db.query(
    `INSERT INTO b2c_invoices (user_id, customer_name, gst_number, invoice_number, invoice_date, supply_type,
       taxable_amount, gst_percentage, gst_amount, cgst, sgst, igst, total_amount)
     VALUES ($1,'Legacy Buyer',$2,'LEG-1','2026-01-01','intrastate',2700,18,486,243,243,0,3186) RETURNING id`,
    [USER_A, GSTIN]);
  const id = rows[0].id;
  const [row] = await read('b2c', id);
  assert.strictEqual(row.gst_number, GSTIN, 'nothing rewrites it on read');
  let r = await save('b2c', { editId: id, header: header(GSTIN, { invoice_number: 'LEG-1' }), items: line() });
  assert.strictEqual(r.status, 400, 'saving it unchanged is refused - the page says why first');
  r = await save('b2c', { editId: id, header: header(null, { invoice_number: 'LEG-1' }), items: line() });
  assert.strictEqual(r.status, 200, errOf(r).message);
  assert.strictEqual((await read('b2c', id))[0].gst_number, null);
});

test('S8 the save route still requires sign-in', async () => {
  const r = await save('b2c', { editId: null, header: header(null), items: line() }, null);
  assert.strictEqual(r.status, 401);
});
