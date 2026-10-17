// Invoice numbering is automatic, and only the server does it.
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

// (required test 1)
test('N1 the Invoice Number box is read-only', () => {
  const tag = /<input[^>]*\bid="invNum"[^>]*>/.exec(HTML);
  assert.ok(tag, 'the field is on the page');
  assert.match(tag[0], /\breadonly\b/, 'it is read-only');
  assert.match(tag[0], /aria-readonly="true"/, 'and says so to a screen reader');
  // Not merely a styling choice: readonly is what stops typing. The page
  // also says where the number comes from, so a blank box before the first
  // save does not read as something the user forgot to fill in.
  assert.match(HTML, /id="invNumNote"/);
  assert.match(HTML, /Issued automatically when you save/);
});

// (required test 2)
test('N2 the Auto ON/OFF switch and the generate button are gone', () => {
  for (const gone of ['autoInvToggle', 'autoInvLabel', 'setAutoInvToggle',
                      'onAutoToggleChange', 'isAutoInvoiceOn', 'updateAutoToggleUI']) {
    for (const [name, src] of [['invoice.html', HTML], ['invoice-entry.js', ENTRY],
                               ['invoice-scan.js', SCAN], ['profile.js', PROFILE]]) {
      assert.equal(src.includes(gone), false, name + ' still mentions ' + gone);
    }
  }
  // The magic-wand "Generate Now" button went with them.
  assert.equal(/fa-magic/.test(HTML), false, 'the generate button is gone');
  assert.equal(/generateInvoiceNo\([^)]/.test(HTML), false,
    'nothing on the page asks for a number to be generated');
  // And no replacement switch was put anywhere in the invoice flow.
  for (const [name, src] of [['invoice.html', HTML], ['invoice-entry.js', ENTRY]]) {
    assert.equal(/invoice_auto_number/.test(src), false,
      name + ' must not read or write the old on/off flag');
  }
});

test('N3 the form sends no invoice number, and the server accepts none', () => {
  // The payload the page builds carries every other header field and not
  // this one.
  const header = ENTRY.slice(ENTRY.indexOf('const headerBase = {'));
  assert.equal(/^\s*invoice_number:/m.test(header.slice(0, header.indexOf('};'))), false,
    'headerBase must not carry invoice_number');
  // And whatever any client sends is dropped before the column list that
  // decides what gets written is built.
  const fn = ROUTE.slice(ROUTE.indexOf("router.post('/:type/save-with-items'"));
  const dropAt = fn.indexOf('delete header.invoice_number');
  assert.ok(dropAt > 0, 'the route drops any number in the payload');
  assert.ok(dropAt < fn.indexOf('const headerCols ='),
    'it is dropped before the columns to write are chosen');
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
  assert.ok(begin > 0 && assign > begin && assign < commit,
    'the number is issued between BEGIN and COMMIT, on the same client');
  // Which is what makes a failed save leave the counter alone: the counter
  // UPDATE is in that same transaction.
  const helper = ROUTE.slice(ROUTE.indexOf('async function assignInvoiceNumberOn'));
  const body = helper.slice(0, helper.indexOf('\n}'));
  assert.match(body, /FOR UPDATE/, 'the profile row is locked first');
  assert.ok(body.indexOf('FOR UPDATE') < body.indexOf('takenNumbersFor'),
    'the lock is taken before the taken-numbers scan, or the race is still open');
  assert.match(body, /UPDATE profiles SET invoice_current_sequence/);
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

test('teardown', async () => {
  if (server) { server.kill(); await new Promise(r => server.on('exit', r)); }
  await db.end();
});
