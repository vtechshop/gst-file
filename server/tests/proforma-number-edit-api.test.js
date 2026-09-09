// Editing the number on a saved proforma, through the real HTTP surface.
//
// Runs the scenario the specification names: two records, rename one, then
// try to rename it onto the other's number and confirm nothing moved.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('proforma number edit API (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-test-secret';

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

let server, base, db, USER_A, USER_B, TOKEN_A, TOKEN_B, idA, idB;
const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function post(url, body, token) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}
const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';

const doc = (number) => ({
  document_number: number, document_date: '2026-08-01', customer_name: 'Acme',
  status: 'draft', taxable_amount: 100, gst_amount: 18, total_amount: 118
});
const ITEMS = [{
  product_name: 'Widget', quantity: 1, rate: 100, taxable_value: 100,
  gst_percentage: 18, gst_amount: 18, total_amount: 118, sort_order: 0
}];
const save = (body, token) => post('/documents/proforma_invoice/save', body, token);

// What the Proforma List and a reload both read: the stored row.
const rowsOf = async (userId) => (await db.query(
  `SELECT id, document_number FROM proforma_invoices WHERE user_id=$1 ORDER BY document_number`,
  [userId])).rows;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  const mkUser = async (email) => {
    const id = (await db.query(
      `INSERT INTO users (email,password_hash) VALUES ($1,'x') RETURNING id`, [email])).rows[0].id;
    await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Scratch Co')`, [id]);
    return id;
  };
  USER_A = await mkUser('pfa@scratch.test');
  USER_B = await mkUser('pfb@scratch.test');
  TOKEN_A = tok(USER_A); TOKEN_B = tok(USER_B);

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;

  idA = (await save({ document: doc('PI-00002'), items: ITEMS }, TOKEN_A)).body.document.id;
  idB = (await save({ document: doc('PI-00003'), items: ITEMS }, TOKEN_A)).body.document.id;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('E1 an existing proforma number can be changed, on the same record', async () => {
  const r = await save({ editId: idA, document: doc('PI-00025'), items: ITEMS }, TOKEN_A);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.document.document_number, 'PI-00025');
  assert.strictEqual(r.body.document.id, idA, 'the id must not change');
});

test('E2 the rename updated the row rather than adding one', async () => {
  const rows = await rowsOf(USER_A);
  assert.strictEqual(rows.length, 2, 'still exactly two proformas');
  assert.deepStrictEqual(rows.map(r => r.document_number), ['PI-00003', 'PI-00025']);
  const a = rows.find(r => r.id === idA);
  assert.strictEqual(a.document_number, 'PI-00025', 'A is the renamed record');
  const b = rows.find(r => r.id === idB);
  assert.strictEqual(b.document_number, 'PI-00003', 'B is untouched');
});

test('E3 reload reads the new number back from the database', async () => {
  // What loadProformaForEdit and the Proforma List both do.
  const { rows } = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE id=$1 AND user_id=$2', [idA, USER_A]);
  assert.strictEqual(rows[0].document_number, 'PI-00025');
});

test('E4 renaming onto another proforma number is refused, and nothing moves', async () => {
  const r = await save({ editId: idA, document: doc('PI-00003'), items: ITEMS }, TOKEN_A);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(msg(r), 'Proforma number already exists.');
  const rows = await rowsOf(USER_A);
  assert.strictEqual(rows.length, 2, 'no record was added');
  assert.strictEqual(rows.find(r => r.id === idA).document_number, 'PI-00025', 'A kept its number');
  assert.strictEqual(rows.find(r => r.id === idB).document_number, 'PI-00003', 'B kept its number');
});

test('E5 the comparison is case-insensitive, so pi-00003 is the same number', async () => {
  const r = await save({ editId: idA, document: doc('pi-00003'), items: ITEMS }, TOKEN_A);
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await rowsOf(USER_A)).find(x => x.id === idA).document_number, 'PI-00025');
});

test('E6 saving the same record with its own number unchanged still works', async () => {
  const r = await save({ editId: idA, document: doc('PI-00025'), items: ITEMS }, TOKEN_A);
  assert.strictEqual(r.status, 200, 'a record must not be its own duplicate');
  assert.strictEqual(r.body.document.document_number, 'PI-00025');
  assert.strictEqual((await rowsOf(USER_A)).length, 2);
});

test('E7 a blank or whitespace-only number is refused', async () => {
  for (const bad of ['', '   ', '\t']) {
    const r = await save({ editId: idA, document: doc(bad), items: ITEMS }, TOKEN_A);
    assert.strictEqual(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.match(msg(r), /number is required/);
  }
  assert.strictEqual((await rowsOf(USER_A)).find(x => x.id === idA).document_number, 'PI-00025');
});

test('E8 a surrounding space is trimmed rather than stored', async () => {
  const r = await save({ editId: idA, document: doc('  PI-00025  '), items: ITEMS }, TOKEN_A);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.document.document_number, 'PI-00025');
});

test('E9 another tenant may hold the same number without conflict', async () => {
  const r = await save({ document: doc('PI-00025'), items: ITEMS }, TOKEN_B);
  assert.strictEqual(r.status, 200, "tenant B's own book is separate");
  const bRows = await rowsOf(USER_B);
  assert.strictEqual(bRows.length, 1);
  assert.strictEqual(bRows[0].document_number, 'PI-00025');
  // And tenant A still has exactly its own two.
  assert.strictEqual((await rowsOf(USER_A)).length, 2);
});

test('E10 one tenant cannot edit another tenant proforma', async () => {
  const r = await save({ editId: idA, document: doc('PI-99999'), items: ITEMS }, TOKEN_B);
  assert.strictEqual(r.status, 404, "another tenant's record must not be reachable");
  assert.strictEqual((await rowsOf(USER_A)).find(x => x.id === idA).document_number, 'PI-00025');
});

test('E11 auto-numbering still issues the next free number', async () => {
  const r = await post('/documents/reserve-number', { documentType: 'proforma_invoice' }, TOKEN_A);
  assert.strictEqual(r.status, 200);
  assert.match(r.body.documentNumber, /^PI-\d{5}$/, 'the PI-##### format is unchanged');
  // It must not hand back a number already in the book.
  const taken = (await rowsOf(USER_A)).map(x => x.document_number.toUpperCase());
  assert.ok(!taken.includes(r.body.documentNumber.toUpperCase()),
    'the generator must skip numbers already taken');
});

test('E12 a manually renamed proforma does not corrupt the sequence', async () => {
  // Rename onto something outside the PI-##### pattern entirely, then check
  // the generator still produces a valid, unused PI number.
  const renamed = await save({ editId: idA, document: doc('CUSTOM-100'), items: ITEMS }, TOKEN_A);
  assert.strictEqual(renamed.status, 200);
  const next = await post('/documents/reserve-number', { documentType: 'proforma_invoice' }, TOKEN_A);
  assert.match(next.body.documentNumber, /^PI-\d{5}$/);
  const taken = (await rowsOf(USER_A)).map(x => x.document_number.toUpperCase());
  assert.ok(!taken.includes(next.body.documentNumber.toUpperCase()));
  // Put it back so later assertions read a familiar number.
  await save({ editId: idA, document: doc('PI-00025'), items: ITEMS }, TOKEN_A);
});

test('E13 a rename keeps the line items attached to the same record', async () => {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM proforma_invoice_items WHERE proforma_invoice_id=$1', [idA]);
  assert.strictEqual(rows[0].n, 1, 'the one line item is still on the renamed proforma');
});

test('E14 a rename does not disturb the conversion link', async () => {
  // Conversion records an invoice id on the proforma. Renaming the proforma
  // must leave that link exactly as it was.
  const fakeInvoice = '11111111-2222-3333-4444-555555555555';
  await db.query(
    `UPDATE proforma_invoices SET status='converted', converted_invoice_id=$1,
       converted_invoice_type='b2b' WHERE id=$2`, [fakeInvoice, idB]);
  const r = await save({ editId: idB, document: doc('PI-00777'), items: ITEMS }, TOKEN_A);
  assert.strictEqual(r.status, 200);
  const { rows } = await db.query(
    'SELECT document_number, converted_invoice_id, converted_invoice_type FROM proforma_invoices WHERE id=$1',
    [idB]);
  assert.strictEqual(rows[0].document_number, 'PI-00777');
  assert.strictEqual(rows[0].converted_invoice_id, fakeInvoice, 'the link survived the rename');
  assert.strictEqual(rows[0].converted_invoice_type, 'b2b');
});

// The number check lives on the shared /documents/:type/save route, so it
// applies to every document that route writes. These two confirm the other
// books behave the same way rather than being quietly broken by it.
test('E16 the same rules apply to a bill of supply, and normal saves still work', async () => {
  const bos = (n) => ({ document_number: n, document_date: '2026-08-01', party_name: 'Acme' });
  const ok1 = await post('/documents/bill_of_supply/save', { document: bos('BOS-001') }, TOKEN_A);
  assert.strictEqual(ok1.status, 200, 'an ordinary bill of supply still saves');

  const blank = await post('/documents/bill_of_supply/save', { document: bos('  ') }, TOKEN_A);
  assert.strictEqual(blank.status, 400);
  assert.match(msg(blank), /bill of supply number is required/);

  const dup = await post('/documents/bill_of_supply/save', { document: bos('BOS-001') }, TOKEN_A);
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(msg(dup), 'Bill of supply number already exists.');

  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM bill_of_supply WHERE user_id=$1', [USER_A]);
  assert.strictEqual(rows[0].n, 1, 'the refused saves wrote nothing');
});

test('E17 a delivery challan is unaffected too, and its own book is separate', async () => {
  const dc = (n) => ({ document_number: n, document_date: '2026-08-01', party_name: 'Acme' });
  const a = await post('/documents/dc_job_work/save', { document: dc('DC-001') }, TOKEN_A);
  assert.strictEqual(a.status, 200);
  // Same number in a DIFFERENT book is not a clash: the series scopes it.
  const b = await post('/documents/dc_other/save', { document: dc('DC-001') }, TOKEN_A);
  assert.strictEqual(b.status, 200, 'a different series is a different book');
  // Same number in the SAME book is.
  const c = await post('/documents/dc_job_work/save', { document: dc('DC-001') }, TOKEN_A);
  assert.strictEqual(c.status, 409);
  assert.strictEqual(msg(c), 'Delivery challan number already exists.');
});

test('E15 no proforma was created anywhere along the way', async () => {
  const a = await rowsOf(USER_A);
  const b = await rowsOf(USER_B);
  assert.strictEqual(a.length, 2, 'tenant A still has the two it started with');
  assert.strictEqual(b.length, 1, 'tenant B has only the one it created');
});
