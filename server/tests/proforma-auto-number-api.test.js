// Automatic / Manual proforma numbering, through the real HTTP surface and
// against a real database.
//
// The browser half of this feature is in proforma-auto-number.test.js. These
// are the questions only a database can answer: does the book actually count,
// is a typed number stored exactly as typed, is a duplicate refused with a
// message rather than a 500, can two simultaneous saves collide, and - the
// one that motivated moving the numbering into the save - does a save that
// FAILS leave the counter where it was.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('proforma auto numbering API (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-autonum-secret';

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
    child.on('exit', (code) => { clearTimeout(done); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

let server, base, db, USER, TOKEN;
const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function req(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}
const post = (url, body, token) => req('POST', url, body, token);
const get = (url, token) => req('GET', url, undefined, token);
const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';

// A quotation header WITHOUT a number: that absence is what "Automatic"
// means on the wire, exactly as the page sends it.
const doc = (extra) => ({
  document_date: '2026-10-29', customer_name: 'Numbering Co', status: 'draft',
  taxable_amount: 100, gst_amount: 18, total_amount: 118, ...(extra || {})
});
const ITEMS = [{
  product_name: 'Widget', quantity: 1, rate: 100, taxable_value: 100,
  gst_percentage: 18, gst_amount: 18, total_amount: 118, sort_order: 0
}];
const save = (body, token) => post('/documents/proforma_invoice/save', body, token || TOKEN);

const numbersOf = async () => (await db.query(
  'SELECT document_number FROM proforma_invoices WHERE user_id=$1 ORDER BY document_number',
  [USER])).rows.map((r) => r.document_number);
const countOf = async () => (await db.query(
  'SELECT COUNT(*)::int n FROM proforma_invoices WHERE user_id=$1', [USER])).rows[0].n;
// Where the proforma book's counter stands. Read directly, because the whole
// argument for issuing inside the transaction is about this value.
const counter = async () => (await db.query(
  "SELECT (document_series_sequences->>'proforma_invoice')::int AS seq FROM profiles WHERE id=$1",
  [USER])).rows[0].seq;

async function freshUser(email) {
  const id = (await db.query(
    'INSERT INTO users (email,password_hash) VALUES ($1,$2) RETURNING id',
    [email, 'x'])).rows[0].id;
  await db.query("INSERT INTO profiles (id,name) VALUES ($1,'Scratch Co')", [id]);
  return id;
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = await freshUser('autonum@scratch.test');
  TOKEN = tok(USER);
  const port = await freePort();
  server = await startServer(port);
  base = 'http://127.0.0.1:' + port + '/api';
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// ═══ Automatic ════════════════════════════════════════════════════════

test('A1 a new proforma with no number at all is issued one from the proforma book', async () => {
  const r = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(r.status, 200, msg(r));
  // PI-##### is the proforma book's default format. The prefix matters: a
  // quotation must not be mistaken for a tax document at a glance.
  assert.match(r.body.document.document_number, /^PI-\d{5}$/);
  assert.strictEqual(r.body.document.document_number, 'PI-00001', 'the first in an empty book');
  assert.strictEqual(await countOf(), 1);
});

test('A2 an explicitly blank number means the same thing', async () => {
  // The page omits the key; a caller that sends "" must not be treated
  // differently, and certainly must not store a blank.
  for (const blank of ['', '   ']) {
    const r = await save({ document: doc({ document_number: blank }), items: ITEMS });
    assert.strictEqual(r.status, 200, msg(r));
    assert.match(r.body.document.document_number, /^PI-\d{5}$/);
  }
  assert.deepStrictEqual(await numbersOf(), ['PI-00001', 'PI-00002', 'PI-00003']);
});

test('A3 the book counts, and the counter is where the next number comes from', async () => {
  assert.strictEqual(await counter(), 4, 'three issued, so the next is 4');
  const r = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(r.body.document.document_number, 'PI-00004');
  assert.strictEqual(await counter(), 5);
});

// ═══ The preview ══════════════════════════════════════════════════════

test('A4 GET next-number answers what the next save will take', async () => {
  const p = await get('/documents/proforma_invoice/next-number', TOKEN);
  assert.strictEqual(p.status, 200, msg(p));
  assert.strictEqual(p.body.documentNumber, 'PI-00005');
  assert.strictEqual(p.body.series, 'proforma_invoice');
  assert.strictEqual(p.body.format, 'PI-#####');
});

test('A5 the preview consumes nothing, however many times it is asked', async () => {
  const before = await counter();
  for (let i = 0; i < 6; i++) {
    const p = await get('/documents/proforma_invoice/next-number', TOKEN);
    assert.strictEqual(p.body.documentNumber, 'PI-00005', 'the same answer every time');
  }
  assert.strictEqual(await counter(), before, 'no counter moved');
  assert.strictEqual(await countOf(), 4, 'and no row was written');

  // And the save still gets exactly that number, so the preview was honest.
  const r = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(r.body.document.document_number, 'PI-00005');
});

// ═══ Manual ═══════════════════════════════════════════════════════════

test('A6 a typed number is stored exactly as typed', async () => {
  for (const typed of ['PI-99001', 'LEGACY/2026/0918', 'pi-mixed-Case-7', 'PI 00099']) {
    const r = await save({ document: doc({ document_number: typed }), items: ITEMS });
    assert.strictEqual(r.status, 200, msg(r));
    assert.strictEqual(r.body.document.document_number, typed,
      'the exact valid custom number must be preserved');
    const { rows } = await db.query(
      'SELECT document_number FROM proforma_invoices WHERE id=$1', [r.body.document.id]);
    assert.strictEqual(rows[0].document_number, typed, 'and read back identical');
  }
});

test('A7 a surrounding space is trimmed rather than stored', async () => {
  const r = await save({ document: doc({ document_number: '  PI-77001  ' }), items: ITEMS });
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, 'PI-77001');
});

test('A8 a duplicate typed number is refused with a message, not a 500', async () => {
  const before = await countOf();
  const r = await save({ document: doc({ document_number: 'PI-99001' }), items: ITEMS });
  assert.strictEqual(r.status, 409, 'a conflict, not a server error');
  assert.strictEqual(msg(r), 'Proforma number already exists.');
  assert.strictEqual(await countOf(), before, 'and nothing was written');
});

test('A9 the duplicate check is case-insensitive, as the automatic side compares', async () => {
  const before = await countOf();
  const r = await save({ document: doc({ document_number: 'pi-99001' }), items: ITEMS });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(await countOf(), before);
});

test('A10 a typed number the automatic side would collide with is walked past', async () => {
  // PI-99001 was typed by hand above, so the automatic scan must step over it
  // rather than hand out a duplicate. The counter is only a starting point.
  const { rows } = await db.query(
    "UPDATE profiles SET document_series_sequences = document_series_sequences"
    + " || jsonb_build_object('proforma_invoice', 99001) WHERE id=$1 RETURNING 1", [USER]);
  assert.strictEqual(rows.length, 1);
  const r = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, 'PI-99002',
    'the number already issued by hand must not be handed out again');
});

// ═══ Editing ══════════════════════════════════════════════════════════

test('A11 editing without sending a number preserves the one it was issued', async () => {
  const created = await save({ document: doc(), items: ITEMS });
  const id = created.body.document.id;
  const number = created.body.document.document_number;

  // Exactly what the page sends on Automatic: no document_number key at all.
  const edited = await save({
    id: undefined, editId: id,
    document: doc({ customer_name: 'Renamed Customer' }), items: ITEMS
  });
  assert.strictEqual(edited.status, 200, msg(edited));
  assert.strictEqual(edited.body.document.document_number, number,
    'an absent number must leave the stored one untouched');
  assert.strictEqual(edited.body.document.customer_name, 'Renamed Customer',
    'while the rest of the edit did apply');
  assert.strictEqual(edited.body.document.id, id, 'the id must not change');
});

test('A12 editing is never given a FRESH number, even repeatedly', async () => {
  const created = await save({ document: doc(), items: ITEMS });
  const id = created.body.document.id;
  const number = created.body.document.document_number;
  const seqBefore = await counter();

  for (let i = 0; i < 3; i++) {
    const r = await save({ editId: id, document: doc({ notes: 'pass ' + i }), items: ITEMS });
    assert.strictEqual(r.status, 200, msg(r));
    assert.strictEqual(r.body.document.document_number, number);
  }
  assert.strictEqual(await counter(), seqBefore,
    'an edit must not move the book - it issues nothing');

  // And it survives a reload, which is what the edit page and the list read.
  const { rows } = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE id=$1 AND user_id=$2', [id, USER]);
  assert.strictEqual(rows[0].document_number, number);
});

test('A13 a blank number on an EDIT is refused - never silently renumbered', async () => {
  const created = await save({ document: doc(), items: ITEMS });
  const id = created.body.document.id;
  const number = created.body.document.document_number;

  for (const blank of ['', '   ', '\t']) {
    const r = await save({ editId: id, document: doc({ document_number: blank }), items: ITEMS });
    assert.strictEqual(r.status, 400, 'expected 400 for ' + JSON.stringify(blank));
    assert.match(msg(r), /number is required/);
  }
  const { rows } = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE id=$1', [id]);
  assert.strictEqual(rows[0].document_number, number, 'it kept its number');
});

test('A14 an edit may change the number to a free one', async () => {
  const created = await save({ document: doc(), items: ITEMS });
  const id = created.body.document.id;
  const r = await save({
    editId: id, document: doc({ document_number: 'PI-EDITED-1' }), items: ITEMS
  });
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, 'PI-EDITED-1');
  assert.strictEqual(r.body.document.id, id, 'the same offer, so the same row');
});

// ═══ The guarantee that moved the numbering into the save ═════════════

test('A15 a save that fails leaves the counter where it was, and writes nothing', async () => {
  const seqBefore = await counter();
  const countBefore = await countOf();
  const numbersBefore = await numbersOf();

  // A line item the database cannot accept. The header has been written and
  // the number issued by the time this fails, so the only thing that can save
  // us is the transaction - which is precisely the point of issuing it there.
  const r = await save({
    document: doc(),
    items: [{ ...ITEMS[0], quantity: 'not-a-number' }]
  });
  assert.ok(r.status >= 400, 'the save must fail, got ' + r.status);
  assert.ok(r.status < 500 || r.status === 500, 'any failure is enough for this test');

  assert.strictEqual(await countOf(), countBefore, 'no proforma row survived');
  assert.deepStrictEqual(await numbersOf(), numbersBefore, 'and no number appeared');
  assert.strictEqual(await counter(), seqBefore,
    'the counter must not have moved - a refused save burns no number');

  // The clincher: the next successful save takes the very number the failed
  // one nearly had.
  const ok = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(ok.status, 200, msg(ok));
  const expected = 'PI-' + String(seqBefore).padStart(5, '0');
  assert.strictEqual(ok.body.document.document_number, expected,
    'the number the failed save nearly took goes to the next one instead');
});

// ═══ Concurrency ══════════════════════════════════════════════════════

test('A16 simultaneous automatic saves cannot take the same number', async () => {
  const fresh = await freshUser('autonum-race@scratch.test');
  const token = tok(fresh);
  const N = 8;

  // All in flight at once, which is the only way to exercise the FOR UPDATE
  // on the profile row. Without it two saves read the same "next" number
  // before either commits.
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      post('/documents/proforma_invoice/save', { document: doc(), items: ITEMS }, token)));

  const ok = results.filter((r) => r.status === 200);
  assert.strictEqual(ok.length, N,
    'every save must succeed: ' + JSON.stringify(results.filter((r) => r.status !== 200).map(msg)));

  const issued = ok.map((r) => r.body.document.document_number);
  assert.strictEqual(new Set(issued).size, N, 'every number must be distinct: ' + issued.join(', '));

  // And the book is a contiguous run, so nothing was skipped either.
  assert.deepStrictEqual(issued.slice().sort(),
    Array.from({ length: N }, (_, i) => 'PI-' + String(i + 1).padStart(5, '0')));

  const { rows } = await db.query(
    'SELECT COUNT(*)::int n, COUNT(DISTINCT document_number)::int d'
    + ' FROM proforma_invoices WHERE user_id=$1', [fresh]);
  assert.strictEqual(rows[0].n, N);
  assert.strictEqual(rows[0].d, N, 'the database agrees there are no duplicates');
});

test('A17 a manual and an automatic save racing for the same number cannot both win', async () => {
  const fresh = await freshUser('autonum-race2@scratch.test');
  const token = tok(fresh);
  // PI-00001 is what the automatic side would take first. Send a typed
  // PI-00001 at the same moment.
  const [a, b] = await Promise.all([
    post('/documents/proforma_invoice/save', { document: doc(), items: ITEMS }, token),
    post('/documents/proforma_invoice/save',
      { document: doc({ document_number: 'PI-00001' }), items: ITEMS }, token)
  ]);

  const statuses = [a.status, b.status].sort();
  // Either both got through with different numbers, or one was refused as a
  // duplicate. What must never happen is two rows claiming PI-00001.
  assert.ok(statuses[0] === 200, 'at least one must succeed: ' + JSON.stringify([msg(a), msg(b)]));
  const { rows } = await db.query(
    "SELECT COUNT(*)::int n FROM proforma_invoices WHERE user_id=$1 AND document_number='PI-00001'",
    [fresh]);
  assert.strictEqual(rows[0].n, 1, 'exactly one row may hold PI-00001');
});

test('A18 two simultaneous MANUAL saves of the same number: one wins, one is refused', async () => {
  const fresh = await freshUser('autonum-race3@scratch.test');
  const token = tok(fresh);

  // The other half of the same hole. The duplicate check cannot see a row
  // another transaction has inserted but not yet committed, so without the
  // profile-row lock both of these passed the check and both wrote.
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      post('/documents/proforma_invoice/save',
        { document: doc({ document_number: 'PI-DUP-1' }), items: ITEMS }, token)));

  const ok = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status === 409);
  assert.strictEqual(ok.length, 1, 'exactly one may win');
  assert.strictEqual(refused.length, 3, 'the rest must be refused as duplicates');
  for (const r of refused) assert.strictEqual(msg(r), 'Proforma number already exists.');

  const { rows } = await db.query(
    "SELECT COUNT(*)::int n FROM proforma_invoices WHERE user_id=$1 AND document_number='PI-DUP-1'",
    [fresh]);
  assert.strictEqual(rows[0].n, 1, 'exactly one row may hold PI-DUP-1');
});

// ═══ Tenancy and the invoice book ═════════════════════════════════════

test('A19 another business numbers its own book from one', async () => {
  const other = await freshUser('autonum-other@scratch.test');
  const r = await post('/documents/proforma_invoice/save',
    { document: doc(), items: ITEMS }, tok(other));
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, 'PI-00001',
    "a tenant's book is its own, however far another tenant's has run");
});

test('A20 issuing proforma numbers never moves a tax invoice counter', async () => {
  const before = (await db.query(
    'SELECT invoice_current_sequence, invoice_series_sequences FROM profiles WHERE id=$1',
    [USER])).rows[0];

  for (let i = 0; i < 3; i++) {
    const r = await save({ document: doc(), items: ITEMS });
    assert.strictEqual(r.status, 200, msg(r));
  }
  await get('/documents/proforma_invoice/next-number', TOKEN);

  const after = (await db.query(
    'SELECT invoice_current_sequence, invoice_series_sequences FROM profiles WHERE id=$1',
    [USER])).rows[0];
  assert.strictEqual(after.invoice_current_sequence, before.invoice_current_sequence,
    'the offline invoice counter must be untouched');
  assert.deepStrictEqual(after.invoice_series_sequences, before.invoice_series_sequences,
    'and so must every invoice series');
});

test('A21 the tax invoice preview still answers for itself', async () => {
  // Proforma numbering must not have disturbed the invoice endpoint it was
  // modelled on.
  const r = await get('/invoices/next-number?source=offline', TOKEN);
  assert.strictEqual(r.status, 200, msg(r));
  assert.ok(r.body.invoiceNumber, 'an invoice number is still previewed');
  assert.strictEqual(r.body.source, 'offline');
  assert.strictEqual(/^PI-/.test(r.body.invoiceNumber), false,
    'and it is emphatically not a proforma number');
});

test('A22 no proforma was created in any invoice table along the way', async () => {
  for (const table of ['b2b_invoices', 'b2c_invoices']) {
    const { rows } = await db.query(
      'SELECT COUNT(*)::int n FROM ' + table + ' WHERE user_id=$1', [USER]);
    assert.strictEqual(rows[0].n, 0, table + ' must be empty');
  }
});
