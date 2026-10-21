// Invoice numbering is automatic by default, and only the server decides a
// number - including one the user types.
//
// Two halves. The first reads the page and the scripts: there is no switch
// to turn numbering off, no button to generate one, nothing to type into,
// and nothing that sends a number. The second runs real invoices through
// the real HTTP surface against a disposable database, because "the next
// invoice after 1 is 2" is a claim about what the database does, not about
// what the code looks like.
//
// The second half is skipped unless STOCK_TEST_DATABASE_URL names a
// DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = rd('invoice.html');
const ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const SCAN = rd('client', 'js', 'pages', 'invoice-scan.js');
const PROFILE = rd('client', 'js', 'pages', 'profile.js');
const ROUTE = rd('server', 'src', 'routes', 'invoices.js');

// ═══════════════════════════════════════════════════════════════════════
//  1. The page offers no way to set a number
// ═══════════════════════════════════════════════════════════════════════

// (required tests 1 and 2)
test('N1 a new invoice opens on Automatic, with the number read-only', () => {
  const tag = /<input[^>]*\bid="invNum"[^>]*>/.exec(HTML);
  assert.ok(tag, 'the field is on the page');
  assert.match(tag[0], /\breadonly\b/, 'it is read-only');
  assert.match(tag[0], /aria-readonly="true"/, 'and says so to a screen reader');
  // Not merely a styling choice: readonly is what stops typing. The page
  // also says where the number comes from, so a blank box before the first
  // save does not read as something the user forgot to fill in.
  assert.match(HTML, /id="invNumNote"/);
  assert.match(HTML, /Issued automatically when you save/);

  // Automatic is the default, in the markup and in the script.
  const autoBtn = /<button[^>]*\bid="invNumAuto"[^>]*>/.exec(HTML);
  const manBtn = /<button[^>]*\bid="invNumManual"[^>]*>/.exec(HTML);
  assert.ok(autoBtn && manBtn, 'both modes are offered');
  assert.match(autoBtn[0], /class="active"/, 'Auto is the one selected');
  assert.match(autoBtn[0], /aria-pressed="true"/);
  assert.match(manBtn[0], /aria-pressed="false"/);
  assert.match(ENTRY, /let invoiceNumberMode = 'auto';/);
  assert.match(ENTRY, /const INV_NUMBER_MODE_DEFAULT = 'auto';/);
});

// (required test 3)
test('N1b choosing Manual makes the number typeable, and only then', () => {
  const fn = ENTRY.slice(ENTRY.indexOf('function setInvoiceNumberMode('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Typeable on a NEW invoice in manual mode, and in no other case.
  assert.match(body, /const typeable = manual && !editing;/);
  assert.match(body, /numEl\.readOnly = !typeable;/);
  // The preview never types over what the user is entering.
  assert.match(ENTRY, /if \(invoiceNumberingIsManual\(\)\) return;/);
  // Both buttons are unavailable while editing, because the number cannot move.
  assert.match(body, /auto\.disabled = editing;/);
  assert.match(body, /man\.disabled = editing;/);
});

// (required test 5 - the mode is not remembered)
test('N1c the next new invoice is Automatic again', () => {
  const fn = ENTRY.slice(ENTRY.indexOf('function clearInvoiceFormFields()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /setInvoiceNumberMode\(INV_NUMBER_MODE_DEFAULT\);/,
    'the form returns to Automatic after every save and reset');
  // And the choice is never written to the business profile, so it cannot
  // become the default for future invoices or for another device.
  for (const [name, src] of [['invoice.html', HTML], ['invoice-entry.js', ENTRY]]) {
    assert.equal(/invoice_auto_number/.test(src), false,
      name + ' must not persist a numbering mode');
  }
  assert.equal(/invoiceNumberMode/.test(PROFILE), false,
    'Settings does not store the mode either');
});

// (required test 2)
test('N2 the old persisted on/off flag and the generate button stay gone', () => {
  // The mode is per-invoice now. What must not come back is the SETTING that
  // left a business in manual mode, and the controls that drove it.
  for (const gone of ['autoInvToggle', 'autoInvLabel', 'setAutoInvToggle',
                      'onAutoToggleChange', 'isAutoInvoiceOn', 'updateAutoToggleUI']) {
    for (const [name, src] of [['invoice.html', HTML], ['invoice-entry.js', ENTRY],
                               ['invoice-scan.js', SCAN], ['profile.js', PROFILE]]) {
      assert.equal(src.includes(gone), false, name + ' still mentions ' + gone);
    }
  }
  // The magic-wand "Generate Now" button went with them, and nothing on the
  // page asks for a number to be generated - the mode buttons set the mode.
  assert.equal(/fa-magic/.test(HTML), false, 'the generate button is gone');
  assert.equal(/generateInvoiceNo\([^)]/.test(HTML), false,
    'nothing on the page asks for a number to be generated');
  // No pencil, either: Manual is chosen by name, not by an icon to decode.
  assert.equal(/fa-pen|fa-pencil|fa-edit/.test(
    HTML.slice(HTML.indexOf('iv-f-num'), HTML.indexOf('iv-f-source'))), false,
    'no pencil control beside the number');
});

test('N3 a number is sent only in Manual, and the column is never written from the payload', () => {
  // The header carries a number only on a new invoice in manual mode.
  const header = ENTRY.slice(ENTRY.indexOf('const headerBase = {'));
  const built = header.slice(0, header.indexOf('};'));
  assert.match(built, /\.\.\.\(wasNewInvoice && invoiceNumberingIsManual\(\) \? \{ invoice_number: invNum \} : \{\}\),/);
  assert.equal(/^\s*invoice_number:\s*invNum,/m.test(built), false,
    'and never unconditionally');

  // Whatever any client sends is still removed before the column list that
  // decides what gets written is built, so nothing reaches the column
  // without passing through the two helpers below.
  const fn = ROUTE.slice(ROUTE.indexOf("router.post('/:type/save-with-items'"));
  const dropAt = fn.indexOf('delete header.invoice_number');
  assert.ok(dropAt > 0, 'the route removes any number in the payload');
  assert.ok(dropAt < fn.indexOf('const headerCols ='),
    'it is removed before the columns to write are chosen');
  // Automatic unless the caller explicitly says manual - so an older page,
  // which sends no mode at all, is numbered by the server exactly as before.
  assert.match(fn, /const manualNumbering = numberingMode === 'manual';/);
});

test('N4 the preview is asked of the server, not computed from a cached profile', () => {
  // The old version did arithmetic on the cached profile row, which is only
  // refreshed by a page load - so after a save the browser previewed the
  // number it had just used. This is that bug's guard.
  assert.match(ENTRY, /\/invoices\/next-number\?source=/);
  const fn = ENTRY.slice(ENTRY.indexOf('async function generateInvoiceNo('));
  const body = fn.slice(0, fn.indexOf('\nconst INV_NUMBER_NOTE'));
  assert.equal(/getCachedProfile\(\)/.test(body), false,
    'the preview must not read the cached profile');
  assert.equal(/applyInvoiceNumberFormat\(/.test(body), false,
    'nor do the numbering arithmetic itself');
  // It is a GET, and the route it calls takes no lock and writes nothing.
  const route = ROUTE.slice(ROUTE.indexOf("router.get('/next-number'"));
  const handler = route.slice(0, route.indexOf('}));'));
  assert.match(handler, /previewInvoiceNumberOn/);
  assert.equal(/UPDATE profiles/.test(handler), false, 'a preview writes nothing');
  assert.equal(/FOR UPDATE/.test(handler), false, 'and locks nothing');
});

test('N5 the number is issued inside the transaction that writes the invoice', () => {
  const fn = ROUTE.slice(ROUTE.indexOf("router.post('/:type/save-with-items'"));
  const begin = fn.indexOf("client.query('BEGIN')");
  const assign = fn.indexOf('assignInvoiceNumberOn(client');
  const commit = fn.indexOf("client.query('COMMIT')");
  const manual = fn.indexOf('applyManualInvoiceNumberOn(client');
  assert.ok(begin > 0 && assign > begin && assign < commit,
    'the number is issued between BEGIN and COMMIT, on the same client');
  assert.ok(manual > begin && manual < commit,
    'and a typed number is judged in that same transaction');
  // Which is what makes a failed save leave the counter alone: the counter
  // UPDATE is in that same transaction.
  const helper = ROUTE.slice(ROUTE.indexOf('async function assignInvoiceNumberOn'));
  const body = helper.slice(0, helper.indexOf('\n}'));
  assert.match(body, /FOR UPDATE/, 'the profile row is locked first');
  assert.ok(body.indexOf('FOR UPDATE') < body.indexOf('takenNumbersFor'),
    'the lock is taken before the taken-numbers scan, or the race is still open');
  assert.match(body, /setSeriesCounterOn\(client, userId, series, issued\.seq \+ 1\)/,
    'it leaves the counter past the number it issued');
  // One writer for that counter, shared with the manual path, so the two
  // modes cannot disagree about where the book is kept.
  const writer = ROUTE.slice(ROUTE.indexOf('async function setSeriesCounterOn'));
  assert.match(writer.slice(0, writer.indexOf('\n}')), /UPDATE profiles SET invoice_current_sequence/);
});

test('N6 a reclassified invoice keeps its own number, read from the database', () => {
  const helper = ROUTE.slice(ROUTE.indexOf('async function numberOfMovedInvoice'));
  const body = helper.slice(0, helper.indexOf('\n}\n'));
  assert.match(body, /SELECT invoice_number FROM \$\{invoiceTable\(type\)\} WHERE id = \$1 AND user_id = \$2/);
  // The payload says WHICH row, never what the number is.
  assert.match(ENTRY, /movedFrom: \{ type: invoiceEditType, id: invoiceEditId \}/);
  assert.match(ITEMS, /movedFrom: opts && opts\.movedFrom/);
});

test('N7 an edit never writes the number column', () => {
  const fn = ROUTE.slice(ROUTE.indexOf("router.post('/:type/save-with-items'"));
  // invoice_number is deleted from the header for every path, so the UPDATE
  // branch cannot include it in its SET clause whatever was sent.
  assert.ok(fn.indexOf('delete header.invoice_number') < fn.indexOf('if (editId) {'));
  // The edit branch reports the number the row already carries.
  assert.match(fn, /RETURNING id, invoice_number/);
});

test('N8 a scanned document cannot name this invoice', () => {
  assert.equal(/setInvIfUntouched\('invNum'/.test(SCAN), false,
    'the scanner must not write the invoice number field');
});

// ── The page, run for real, counting what it asks the server ─────────
//
// Everything above reads the source. This runs it: utils.js and
// invoice-entry.js in a browser-shaped sandbox with the REAL
// generateInvoiceNo() and a counting apiFetch, which is the only way to
// prove how many requests one reset actually makes.
const vm = require('node:vm');
function page() {
  const noop = () => {};
  const store = new Map();
  const mk = (value = '') => ({
    value, checked: false, textContent: '', innerHTML: '', className: '',
    readOnly: false, disabled: false, style: {}, dataset: {},
    options: [], add(o) { this.options.push(o); },
    querySelector: () => null, querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    addEventListener: noop, dispatchEvent: noop, focus: noop, select: noop, scrollIntoView: noop
  });
  const el = (id) => { if (!store.has(id)) store.set(id, mk()); return store.get(id); };
  const sb = {
    console: { log: noop, warn: noop, error: noop }, setTimeout, clearTimeout,
    URL, URLSearchParams, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN, Symbol,
    Event: class { constructor(type) { this.type = type; } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x', replace: noop },
    localStorage: { getItem: () => 'test-jwt', setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      documentElement: mk(), body: mk(), head: mk(), getElementById: el,
      querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
      createElement: () => mk()
    },
    alert: noop, fetch: async () => { throw new Error('no network in this test'); },
    __nextNumberCalls: []
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(rd('client', 'js', 'pages', 'invoice-entry.js'), sb, { filename: 'invoice-entry.js' });
  vm.runInContext(`
    // The one call that matters here, recorded rather than stubbed away.
    apiFetch = async function (url) {
      if (String(url).indexOf('next-number') !== -1) {
        __nextNumberCalls.push(url);
        return { invoiceNumber: '7' };
      }
      return {};
    };
    showToast = function () {}; handleApiError = function () {};
    getCachedProfile = function () { return { state: 'Tamil Nadu' }; };
    getCurrentUser = async function () { return { id: 'u1' }; };
    getInvoiceSource = function () { return 'offline'; };
    if (typeof INVOICE_SOURCE_DEFAULT === 'undefined') INVOICE_SOURCE_DEFAULT = 'offline';
    if (typeof GST_CUSTOMER_CATEGORY_DEFAULT === 'undefined') GST_CUSTOMER_CATEGORY_DEFAULT = 'regular';
    // Everything the reset touches that belongs to another concern.
    for (const name of ['resetInvoiceItems', 'restoreInvoiceTransport', 'clearDraft',
      'clearItemsDraft', 'setInvGstCategory', 'setInvoiceTypeToggle',
      'updateGstinValidationStatus', 'detectSupplyType', 'onInvShipSameChange',
      'restoreExportFields', 'restoreEcomFields', 'onTransportToggleChange',
      'onInvPaymentStatusChange', 'setPaymentSectionMode', 'resetWarrantyFields',
      'updateClassifyBadge', 'populateDistrictList', 'toISO',
      // reached through this file's own resetWarrantyFields()
      'setItemsHeaderWarrantyDefault',
      // payments.js, reached through this file's payment-preview wrapper
      'renderPaymentPreview', 'paymentPreviewValues', 'validatePaymentPreviewAmount']) {
      if (typeof globalThis[name] !== 'function') globalThis[name] = function () { return ''; };
    }
  `, sb);
  sb.__el = el;
  sb.__calls = () => sb.__nextNumberCalls.length;
  sb.__run = (expr) => vm.runInContext(expr, sb);
  return sb;
}

test('N24 one reset asks the server for one number, not two', async () => {
  const sb = page();
  sb.__run('__nextNumberCalls.length = 0;');
  sb.__run('clearInvoiceFormFields();');
  await new Promise((r) => setTimeout(r, 20));   // the preview is a promise
  assert.strictEqual(sb.__calls(), 1,
    'exactly one next-number request per reset, got ' + sb.__calls());
  assert.strictEqual(sb.__run('invoiceNumberMode'), 'auto', 'and the form is back on Automatic');
  assert.strictEqual(sb.__el('invNum').value, '7', 'showing what the server offered');
});

test('N25 Auto and Manual behave, and neither asks twice', async () => {
  const sb = page();
  const settle = () => new Promise((r) => setTimeout(r, 20));

  // Manual: no request, the field becomes typeable, and the preview does not
  // type over what is entered.
  sb.__run('__nextNumberCalls.length = 0;');
  sb.__run("setInvoiceNumberMode('manual');");
  await settle();
  assert.strictEqual(sb.__calls(), 0, 'choosing Manual asks for nothing');
  assert.strictEqual(sb.__el('invNum').readOnly, false, 'the number is typeable');
  sb.__el('invNum').value = 'MY-001';
  sb.__run('generateInvoiceNo();');
  await settle();
  assert.strictEqual(sb.__calls(), 0, 'and the preview stays out of the way');
  assert.strictEqual(sb.__el('invNum').value, 'MY-001', 'what was typed survives');

  // Back to Auto: exactly one request, read-only again, server value shown.
  sb.__run("setInvoiceNumberMode('auto');");
  await settle();
  assert.strictEqual(sb.__calls(), 1, 'returning to Auto asks once');
  assert.strictEqual(sb.__el('invNum').readOnly, true, 'and the field is read-only again');
  assert.strictEqual(sb.__el('invNum').value, '7');

  // Editing an existing invoice: the mode cannot be changed and nothing is asked.
  sb.__run("invoiceEditId = 'inv-1'; __nextNumberCalls.length = 0;");
  sb.__run("setInvoiceNumberMode('manual');");
  await settle();
  assert.strictEqual(sb.__run('invoiceNumberMode'), 'auto', 'the mode is left alone while editing');
  assert.strictEqual(sb.__calls(), 0, 'and no number is fetched for an invoice that has one');
  assert.strictEqual(sb.__el('invNumManual').disabled, true, 'the switch says so');
});

// ═══════════════════════════════════════════════════════════════════════
//  2. What the database actually does
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('invoice numbering against a database (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'invoice-number-test-secret';

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
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (c) => { clearTimeout(done); reject(new Error('server exited ' + c + ':\n' + out)); });
  });
}

let server = null;
let BASE = '';
let USER = '';
let TOKEN = '';
const db = new Client({ connectionString: SCRATCH });

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (f) => {
  let s = 0;
  for (let i = 0; i < 14; i++) { const p = CH.indexOf(f[i]) * (i % 2 ? 2 : 1); s += Math.floor(p / 36) + (p % 36); }
  return f + CH[(36 - (s % 36)) % 36];
};

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || TOKEN) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes answer no body */ }
  return { status: res.status, body: json };
}

// One B2C invoice, saved through the same route the page uses.
function invoicePayload(extra) {
  return {
    header: {
      customer_name: 'Anand Caterers', address: 'Coimbatore', state: 'Tamil Nadu',
      district: 'Coimbatore', gst_number: '',
      invoice_date: '2026-10-17', supply_type: 'intrastate',
      taxable_amount: 1000, gst_percentage: 18, gst_amount: 180, total_amount: 1180,
      cgst: 90, sgst: 90,
      // Deliberately present, deliberately a lie: the server must ignore it.
      invoice_number: 'HACKED-999',
      ...(extra && extra.header)
    },
    items: [{
      product_name: 'Idli Steamer 12 Tray', hsn_code: '84198190', unit: 'PCS',
      quantity: 1, rate: 1000, gst_percentage: 18, taxable_value: 1000,
      gst_amount: 180, cgst: 90, sgst: 90, total_amount: 1180,
      ...(extra && extra.item)
    }],
    ...(extra && extra.top)
  };
}

const saveInvoice = (extra, token) => api('POST', '/api/invoices/b2c/save-with-items', invoicePayload(extra), token);
// The same save, declaring the number as one the user typed.
const saveManual = (number, extra) => api('POST', '/api/invoices/b2c/save-with-items', {
  ...invoicePayload(extra),
  numberingMode: 'manual',
  header: { ...invoicePayload(extra).header, invoice_number: number }
});
const nextNumber = (source) => api('GET', '/api/invoices/next-number' + (source ? '?source=' + source : ''));
const storedSequence = async () => {
  const { rows } = await db.query('SELECT invoice_current_sequence FROM profiles WHERE id = $1', [USER]);
  return rows[0].invoice_current_sequence;
};

test('database setup', async () => {
  await db.connect();
  // The export columns, if this scratch database is older than them. The
  // project's own migration, which adds each column IF NOT EXISTS, so
  // running it on a database that already has them changes nothing.
  await db.query(rd('server', 'db', 'migrations', 'migration_invoice_export_currency.sql'));
  await db.query('TRUNCATE users CASCADE');
  const { rows } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('numbering@scratch.test','x') RETURNING id");
  USER = rows[0].id;
  // A plain numeric format, so "the next one after 1 is 2" is literally that.
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address,
                           invoice_number_format, invoice_current_sequence)
     VALUES ($1,'VTECH','VTECH Engineering Works',$2,'Tamil Nadu','Coimbatore','14, Avinashi Road','#',1)`,
    [USER, gstin('33AAGCV4521K1Z')]);
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;
});

// (required tests 3 and 4)
test('N9 1 then 2 then 3, each from the invoice saved before it', async () => {
  assert.equal((await nextNumber()).body.invoiceNumber, '1', 'the first invoice previews 1');

  const first = await saveInvoice();
  assert.equal(first.status, 200);
  assert.equal(first.body.invoiceNumber, '1', 'and is issued 1');

  // The preview moves on by itself - nothing told it to.
  assert.equal((await nextNumber()).body.invoiceNumber, '2');
  const second = await saveInvoice();
  assert.equal(second.body.invoiceNumber, '2', 'after 1 comes 2');

  assert.equal((await nextNumber()).body.invoiceNumber, '3');
  const third = await saveInvoice();
  assert.equal(third.body.invoiceNumber, '3', 'after 2 comes 3');

  // What is actually stored, not merely reported.
  const { rows } = await db.query(
    'SELECT invoice_number FROM b2c_invoices WHERE user_id = $1 ORDER BY invoice_number', [USER]);
  assert.deepStrictEqual(rows.map(r => r.invoice_number), ['1', '2', '3']);
  // And the number sent in the payload went nowhere.
  const { rows: hacked } = await db.query(
    "SELECT 1 FROM b2c_invoices WHERE user_id = $1 AND invoice_number = 'HACKED-999'", [USER]);
  assert.equal(hacked.length, 0, 'a client-supplied number must never be stored');
});

// (required test 5)
test('N10 the sequence survives a backend restart - it is read, not remembered', async () => {
  const before = (await nextNumber()).body.invoiceNumber;
  assert.equal(before, '4');

  server.kill();
  await new Promise(r => server.on('exit', r));
  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;

  assert.equal((await nextNumber()).body.invoiceNumber, '4', 'a fresh process reads the same answer');
  const saved = await saveInvoice();
  assert.equal(saved.body.invoiceNumber, '4');
  // A second reader - this test's own connection - agrees, which is what
  // "survives a page refresh or another session" means underneath.
  assert.equal(await storedSequence(), 5);
});

// (required test 6)
test('N11 a failed save leaves the counter where it was', async () => {
  const before = await storedSequence();
  const preview = (await nextNumber()).body.invoiceNumber;

  // Refused by the route: a B2C invoice carrying a GST Number. The failure
  // happens before the transaction, so nothing could have moved.
  const early = await saveInvoice({ header: { gst_number: gstin('33AAGCV4521K1Z') } });
  assert.equal(early.status, 400);

  // Refused INSIDE the transaction, after the number has been issued: a
  // line item whose product does not exist for this user. This is the case
  // the old code got wrong - it had already committed the counter.
  const inTx = await api('POST', '/api/invoices/b2c/save-with-items', {
    header: invoicePayload().header,
    items: [{ ...invoicePayload().items[0], product_id: '00000000-0000-4000-8000-000000000000' }]
  });
  assert.ok(inTx.status >= 400, 'the save failed: ' + JSON.stringify(inTx.body));

  assert.equal(await storedSequence(), before, 'the counter did not move');
  assert.equal((await nextNumber()).body.invoiceNumber, preview, 'the number is still on offer');
  const ok = await saveInvoice();
  assert.equal(ok.body.invoiceNumber, preview, 'and the next invoice gets it');
});

// (required test 7)
test('N12 simultaneous saves get different numbers, with no gap', async () => {
  const before = (await nextNumber()).body.invoiceNumber;
  const results = await Promise.all(Array.from({ length: 8 }, () => saveInvoice()));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

  const issued = results.map(r => r.body.invoiceNumber);
  assert.equal(new Set(issued).size, 8, 'eight saves, eight distinct numbers: ' + issued.join(','));

  const n = Number(before);
  assert.deepStrictEqual(issued.map(Number).sort((a, b) => a - b),
    Array.from({ length: 8 }, (_, i) => n + i), 'and they are consecutive');

  // The same is true of what the table holds - no duplicate reached it.
  const { rows } = await db.query(
    'SELECT invoice_number, COUNT(*) c FROM b2c_invoices WHERE user_id = $1 GROUP BY invoice_number HAVING COUNT(*) > 1',
    [USER]);
  assert.deepStrictEqual(rows, [], 'no number was issued twice');
});

test('N13 a number already taken is skipped rather than collided with', async () => {
  // A counter that has fallen behind the invoices - however it got there.
  const next = Number((await nextNumber()).body.invoiceNumber);
  await db.query('UPDATE profiles SET invoice_current_sequence = 1 WHERE id = $1', [USER]);
  assert.equal((await nextNumber()).body.invoiceNumber, String(next),
    'the scan walks past everything already issued');
  const saved = await saveInvoice();
  assert.equal(saved.body.invoiceNumber, String(next), 'and the save agrees with the preview');
});

// (required test 9)
test('N14 editing an invoice changes neither its number nor the sequence', async () => {
  const created = await saveInvoice();
  const id = created.body.invoiceId;
  const number = created.body.invoiceNumber;
  const seqBefore = await storedSequence();

  const edited = await api('POST', '/api/invoices/b2c/save-with-items', {
    editId: id,
    header: { ...invoicePayload().header, customer_name: 'Anand Caterers (edited)', invoice_number: 'RENAMED-1' },
    items: invoicePayload().items
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.invoiceNumber, number, 'the invoice keeps the number it was issued');

  const { rows } = await db.query(
    'SELECT invoice_number, customer_name FROM b2c_invoices WHERE id = $1', [id]);
  assert.equal(rows[0].invoice_number, number, 'and the stored number is untouched');
  assert.equal(rows[0].customer_name, 'Anand Caterers (edited)', 'while the edit itself landed');
  assert.equal(await storedSequence(), seqBefore, 'an edit does not advance the sequence');
});

// (required test 8)
test('N15 formats and per-series counters are unchanged', async () => {
  // Each series counts on its own and writes its own way: the shop reaching
  // 12 does not push the website past 1.
  await db.query(
    `UPDATE profiles SET invoice_series_formats = '{"online":"W-#####"}'::jsonb,
                         invoice_series_sequences = '{"online":1}'::jsonb WHERE id = $1`, [USER]);
  assert.equal((await nextNumber('online')).body.invoiceNumber, 'W-00001');

  const saved = await saveInvoice({ header: { invoice_source: 'online' } });
  assert.equal(saved.body.invoiceNumber, 'W-00001', 'padded and prefixed exactly as configured');
  assert.equal((await nextNumber('online')).body.invoiceNumber, 'W-00002');

  // The shop series is untouched by all of that.
  const offline = (await nextNumber()).body.invoiceNumber;
  assert.ok(/^\d+$/.test(offline), 'the offline series still numbers plainly: ' + offline);

  // A financial-year format is applied by the same formatter, so the year
  // in it is preserved verbatim and only the counter moves.
  await db.query(
    `UPDATE profiles SET invoice_series_formats = '{"online":"VTE/2026-27/###"}'::jsonb,
                         invoice_series_sequences = '{"online":7}'::jsonb WHERE id = $1`, [USER]);
  assert.equal((await nextNumber('online')).body.invoiceNumber, 'VTE/2026-27/007');
  const fy = await saveInvoice({ header: { invoice_source: 'online' } });
  assert.equal(fy.body.invoiceNumber, 'VTE/2026-27/007');
  assert.equal((await nextNumber('online')).body.invoiceNumber, 'VTE/2026-27/008');
});

// (required test 10)
test('N16 domestic and export invoices are both numbered and saved', async () => {
  const domestic = await saveInvoice();
  assert.equal(domestic.status, 200);
  assert.ok(domestic.body.invoiceNumber, 'a domestic invoice is numbered');

  const exported = await saveInvoice({
    header: {
      export_type: 'WOPAY', export_of: 'goods', port_code: 'INMAA1',
      destination_country: 'United States',
      currency_code: 'USD', exchange_rate: 83.25,
      fx_taxable_amount: 12.01, fx_gst_amount: 2.16, fx_total_amount: 14.17
    },
    item: { fx_rate: 12.01, fx_taxable_value: 12.01, fx_total_amount: 14.17 }
  });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.ok(exported.body.invoiceNumber, 'so is an export');
  assert.notEqual(exported.body.invoiceNumber, domestic.body.invoiceNumber);

  const { rows } = await db.query(
    'SELECT currency_code, exchange_rate, destination_country, export_type FROM b2c_invoices WHERE id = $1',
    [exported.body.invoiceId]);
  assert.equal(rows[0].currency_code, 'USD', 'and the currency it was billed in survived');
  assert.equal(Number(rows[0].exchange_rate), 83.25);
  assert.equal(rows[0].export_type, 'WOPAY');
});

test('N17 one business cannot see or consume another\'s numbers', async () => {
  const { rows } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('other@scratch.test','x') RETURNING id");
  const other = rows[0].id;
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address,
                           invoice_number_format, invoice_current_sequence)
     VALUES ($1,'Other','Other Traders',$2,'Tamil Nadu','Coimbatore','1 Street','#',1)`,
    [other, gstin('33AACCO1234M1Z')]);
  const otherToken = jwt.sign({ sub: other }, process.env.JWT_SECRET, { expiresIn: '2h' });

  const mineBefore = await storedSequence();
  const theirs = await saveInvoice({}, otherToken);
  assert.equal(theirs.body.invoiceNumber, '1', 'their first invoice is their own 1');
  assert.equal(await storedSequence(), mineBefore, 'and ours did not move');
});

// ═══════════════════════════════════════════════════════════════════════
//  3. Manual numbering, and what it leaves behind
// ═══════════════════════════════════════════════════════════════════════

// (required tests 4 and 5 - the worked example from the brief)
test('N18 a number typed by hand becomes the basis for the next automatic one', async () => {
  // Put the book at 6, the way a business that has issued six invoices is.
  await db.query('UPDATE profiles SET invoice_current_sequence = 7 WHERE id = $1', [USER]);
  await db.query('DELETE FROM invoice_items WHERE user_id = $1', [USER]);
  await db.query('DELETE FROM b2c_invoices WHERE user_id = $1', [USER]);
  await db.query(
    `INSERT INTO b2c_invoices (user_id, gst_number, customer_name, address, state, district,
       invoice_number, invoice_date, taxable_amount, gst_percentage, gst_amount, total_amount,
       supply_type, cgst, sgst, invoice_source)
     VALUES ($1,'','Anand Caterers','Coimbatore','Tamil Nadu','Coimbatore','6','2026-10-21',
             1000,18,180,1180,'intrastate',90,90,'offline')`, [USER]);
  assert.equal((await nextNumber()).body.invoiceNumber, '7', 'automatic would offer 7');

  // The user types 1 instead.
  const manual = await saveManual('1');
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.invoiceNumber, '1', 'the typed number is what gets stored');

  // ...and the book now continues from THERE, not from where it had wandered.
  assert.equal(await storedSequence(), 2, 'the counter followed the typed number');
  assert.equal((await nextNumber()).body.invoiceNumber, '2');

  const second = await saveInvoice();
  assert.equal(second.body.invoiceNumber, '2', 'after a manual 1 comes an automatic 2');
  assert.equal((await nextNumber()).body.invoiceNumber, '3');
  const third = await saveInvoice();
  assert.equal(third.body.invoiceNumber, '3', 'and then 3');

  const { rows } = await db.query(
    'SELECT invoice_number FROM b2c_invoices WHERE user_id = $1 ORDER BY invoice_number', [USER]);
  assert.deepStrictEqual(rows.map(r => r.invoice_number), ['1', '2', '3', '6']);
});

// (required test 6)
test('N19 a duplicate typed number is refused, and nothing is written', async () => {
  const before = await storedSequence();
  const { rows: countBefore } = await db.query(
    'SELECT count(*)::int n FROM b2c_invoices WHERE user_id = $1', [USER]);

  const clash = await saveManual('2');
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.match(clash.body.error.message, /already exists in this series/i);

  // Case is not a way around it, nor is a stray space.
  assert.equal((await saveManual(' 2 ')).status, 409, 'a padded duplicate is still a duplicate');

  // A blank is refused too, with its own reason.
  const blank = await saveManual('   ');
  assert.equal(blank.status, 400);
  assert.match(blank.body.error.message, /Enter an invoice number/i);

  const { rows: countAfter } = await db.query(
    'SELECT count(*)::int n FROM b2c_invoices WHERE user_id = $1', [USER]);
  assert.equal(countAfter[0].n, countBefore[0].n, 'no row was written');
  assert.equal(await storedSequence(), before, 'and the counter did not move');
});

test('N20 a typed number is stored trimmed, and its series is respected', async () => {
  const padded = await saveManual('  SPECIAL/2026  ');
  assert.equal(padded.status, 200, JSON.stringify(padded.body));
  assert.equal(padded.body.invoiceNumber, 'SPECIAL/2026', 'stored without the spaces');

  // It does not fit the "#" format, so there is no sequence to read from it
  // and the counter is left exactly where it was rather than guessed at.
  const after = await storedSequence();
  const next = await saveInvoice();
  assert.equal(next.body.invoiceNumber, String(after),
    'the automatic sequence carried on undisturbed: ' + next.body.invoiceNumber);

  // Another series counts on its own: the shop's numbers do not block it.
  await db.query(
    `UPDATE profiles SET invoice_series_formats = '{"online":"W-#####"}'::jsonb,
                         invoice_series_sequences = '{"online":1}'::jsonb WHERE id = $1`, [USER]);
  const online = await saveManual('W-00009', { header: { invoice_source: 'online' } });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  assert.equal(online.body.invoiceNumber, 'W-00009');
  assert.equal((await nextNumber('online')).body.invoiceNumber, 'W-00010',
    'the online book continues from the typed number');
  // ...and the shop book is untouched by all of that.
  const offline = (await nextNumber()).body.invoiceNumber;
  assert.ok(/^\d+$/.test(offline), 'the shop series still numbers plainly: ' + offline);
});

// (required test 7, for the manual path)
test('N21 a failed manual save leaves the counter where it was', async () => {
  const before = await storedSequence();
  // Refused inside the transaction, after the number has been judged: a line
  // item whose product does not exist for this user.
  const failed = await api('POST', '/api/invoices/b2c/save-with-items', {
    ...invoicePayload(),
    numberingMode: 'manual',
    header: { ...invoicePayload().header, invoice_number: 'MANUAL-FAIL-1' },
    items: [{ ...invoicePayload().items[0], product_id: '00000000-0000-4000-8000-000000000000' }]
  });
  assert.ok(failed.status >= 400, 'the save failed: ' + JSON.stringify(failed.body));
  assert.equal(await storedSequence(), before, 'the counter did not move');
  const { rows } = await db.query(
    "SELECT 1 FROM b2c_invoices WHERE user_id = $1 AND invoice_number = 'MANUAL-FAIL-1'", [USER]);
  assert.equal(rows.length, 0, 'and no invoice carries that number');
});

// (required test 9, with both modes racing)
test('N22 manual and automatic saves at the same moment each get their own number', async () => {
  const start = Number((await nextNumber()).body.invoiceNumber);
  // The typed number is clear of the range the automatic saves will consume,
  // which is the ordinary case: someone numbering by hand is not racing the
  // sequence for the same value.
  const results = await Promise.all([
    saveInvoice(), saveInvoice(), saveManual(String(start + 500)), saveInvoice(), saveInvoice()
  ]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const issued = results.map(r => r.body.invoiceNumber);
  assert.equal(new Set(issued).size, issued.length, 'every save got its own number: ' + issued.join(','));

  const { rows } = await db.query(
    'SELECT invoice_number, COUNT(*) c FROM b2c_invoices WHERE user_id = $1 GROUP BY invoice_number HAVING COUNT(*) > 1',
    [USER]);
  assert.deepStrictEqual(rows, [], 'and the table holds no number twice');
});

test('N22b when a typed number IS the one automatic is about to issue, one wins cleanly', async () => {
  const contested = (await nextNumber()).body.invoiceNumber;
  // Deliberately the same value, fired together. Whichever reaches the
  // profile-row lock first takes it; the other must either be refused with a
  // plain 409 or be handed the next free number - never a second row on the
  // same one.
  const [manual, auto] = await Promise.all([saveManual(contested), saveInvoice()]);

  const ok = [manual, auto].filter(r => r.status === 200);
  const refused = [manual, auto].filter(r => r.status !== 200);
  assert.ok(ok.length >= 1, 'at least one save succeeded');
  for (const r of refused) {
    assert.equal(r.status, 409, 'a loser is refused cleanly: ' + JSON.stringify(r.body));
    assert.match(r.body.error.message, /already exists in this series/i);
  }
  if (ok.length === 2) {
    assert.notEqual(ok[0].body.invoiceNumber, ok[1].body.invoiceNumber,
      'if both succeeded the automatic one stepped past the typed number');
  }

  const { rows } = await db.query(
    'SELECT invoice_number, COUNT(*) c FROM b2c_invoices WHERE user_id = $1 GROUP BY invoice_number HAVING COUNT(*) > 1',
    [USER]);
  assert.deepStrictEqual(rows, [], 'the table holds no number twice, whichever way it went');
});

// (required test 10, with a manual number)
test('N23 editing an invoice created manually keeps its number', async () => {
  const created = await saveManual('MANUAL-EDIT-1');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.invoiceId;
  const seqBefore = await storedSequence();

  const edited = await api('POST', '/api/invoices/b2c/save-with-items', {
    editId: id,
    numberingMode: 'manual',
    header: { ...invoicePayload().header, customer_name: 'Renamed Co', invoice_number: 'RENAMED-9' },
    items: invoicePayload().items
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.invoiceNumber, 'MANUAL-EDIT-1', 'the invoice keeps its number');

  const { rows } = await db.query(
    'SELECT invoice_number, customer_name FROM b2c_invoices WHERE id = $1', [id]);
  assert.equal(rows[0].invoice_number, 'MANUAL-EDIT-1', 'even asked to rename it');
  assert.equal(rows[0].customer_name, 'Renamed Co', 'while the edit itself landed');
  assert.equal(await storedSequence(), seqBefore, 'and the sequence did not move');
});

test('teardown', async () => {
  if (server) { server.kill(); await new Promise(r => server.on('exit', r)); }
  await db.end();
});
