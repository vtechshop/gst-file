// The Complete Invoice Details export through its real HTTP surface.
//
// The integration suite proves the query returns the right rows. This
// proves the route as mounted: that it refuses an unauthenticated caller,
// rejects rubbish in every filter rather than passing it to Postgres, and
// scopes to the token's own tenant no matter what the caller asks for.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('reports API integration (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'reports-test-secret';

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

let server, base, db, USER_A, USER_B, TOKEN_A, TOKEN_B;
const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(url, token) {
  const res = await fetch(base + url, {
    headers: token ? { authorization: 'Bearer ' + token } : {}
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

async function mkInvoice(userId, kind, number, date, lineCount) {
  const table = kind === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  // b2b_invoices.gst_number is NOT NULL — a registered customer always
  // has one, which is what makes the invoice B2B in the first place.
  const { rows } = await db.query(
    `INSERT INTO ${table}
       (user_id, invoice_number, invoice_date, customer_name, gst_number, state,
        gst_percentage, supply_type, taxable_amount, gst_amount, cgst, sgst, igst,
        total_amount, payment_status)
     VALUES ($1,$2,$3,'Cust',$4,'Tamil Nadu',18,'intrastate',1000,180,90,90,0,1180,'paid')
     RETURNING id`,
    [userId, number, date, kind === 'b2b' ? '33AAAAA0000A1Z5' : null]);
  for (let i = 0; i < lineCount; i++) {
    await db.query(
      `INSERT INTO invoice_items
         (user_id, invoice_id, invoice_type, product_name, hsn_code, unit, quantity,
          rate, gst_percentage, taxable_value, gst_amount, cgst, sgst, igst, total_amount, sort_order)
       VALUES ($1,$2,$3,$4,'84388090','PCS',1,1000,18,1000,180,90,90,0,1180,$5)`,
      [userId, rows[0].id, kind, 'Line ' + (i + 1), i]);
  }
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('rapi-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('rapi-b@scratch.test','x') RETURNING id`)).rows[0].id;
  TOKEN_A = tok(USER_A); TOKEN_B = tok(USER_B);

  await mkInvoice(USER_A, 'b2b', 'A-B2B-001', '2026-08-05', 3);
  await mkInvoice(USER_A, 'b2c', 'A-B2C-001', '2026-08-06', 2);
  await mkInvoice(USER_B, 'b2b', 'B-B2B-001', '2026-08-07', 4);

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

const AUG = 'start=2026-08-01&end=2026-08-31';

test('X1 an unauthenticated export is refused', async () => {
  const r = await api(`/reports/invoice-details?${AUG}`, null);
  assert.strictEqual(r.status, 401);
});

test('X2 a garbage token is refused', async () => {
  const r = await api(`/reports/invoice-details?${AUG}`, 'not.a.token');
  assert.strictEqual(r.status, 401);
});

test('X3 an authenticated export returns only its own tenant', async () => {
  const a = await api(`/reports/invoice-details?${AUG}`, TOKEN_A);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.invoice_count, 2);
  assert.strictEqual(a.body.item_count, 5, '3 B2B lines + 2 B2C lines');
  const numbers = a.body.rows.map(r => r.invoice_number);
  assert.ok(!numbers.includes('B-B2B-001'), "tenant B's invoice must not appear");

  const b = await api(`/reports/invoice-details?${AUG}`, TOKEN_B);
  assert.strictEqual(b.body.invoice_count, 1);
  assert.strictEqual(b.body.item_count, 4);
});

test('X4 the category filter narrows correctly over HTTP', async () => {
  const all = await api(`/reports/invoice-details?${AUG}&category=all`, TOKEN_A);
  const b2b = await api(`/reports/invoice-details?${AUG}&category=b2b`, TOKEN_A);
  const b2c = await api(`/reports/invoice-details?${AUG}&category=b2c`, TOKEN_A);
  assert.strictEqual(all.body.invoice_count, 2);
  assert.strictEqual(b2b.body.invoice_count, 1);
  assert.strictEqual(b2c.body.invoice_count, 1);
  assert.ok(b2b.body.rows.every(r => r.category === 'B2B'));
  assert.ok(b2c.body.rows.every(r => r.category === 'B2C'));
  assert.strictEqual(b2b.body.item_count + b2c.body.item_count, all.body.item_count);
});

test('X5 injection attempts in every filter are rejected, not executed', async () => {
  const payloads = [
    "'; DROP TABLE invoice_items; --",
    "' OR '1'='1",
    '2026-08-01; DELETE FROM users',
    'all UNION SELECT * FROM users',
    '../../etc/passwd'
  ];
  for (const p of payloads) {
    const enc = encodeURIComponent(p);
    for (const url of [
      `/reports/invoice-details?start=${enc}&end=2026-08-31`,
      `/reports/invoice-details?${AUG}&category=${enc}`,
      `/reports/invoice-details?${AUG}&sort=${enc}`
    ]) {
      const r = await api(url, TOKEN_A);
      assert.strictEqual(r.status, 400, `expected 400 for ${url}`);
    }
  }
  // The tables are all still there and still hold their rows.
  const still = await api(`/reports/invoice-details?${AUG}`, TOKEN_A);
  assert.strictEqual(still.status, 200);
  assert.strictEqual(still.body.item_count, 5, 'nothing was deleted by an injection attempt');
  const { rows } = await db.query('SELECT COUNT(*)::int n FROM users');
  assert.strictEqual(rows[0].n, 2, 'the users table is intact');
});

test('X6 a malformed but well-shaped date is rejected', async () => {
  const r = await api('/reports/invoice-details?start=2026-02-31&end=2026-03-01', TOKEN_A);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error.message, /not a real calendar date/);
});

test('X7 start after end is rejected', async () => {
  const r = await api('/reports/invoice-details?start=2026-09-01&end=2026-08-01', TOKEN_A);
  assert.strictEqual(r.status, 400);
});

test('X8 a tenant id in the query string is ignored', async () => {
  // Tenancy comes from the token. Asking for another user changes nothing.
  const r = await api(
    `/reports/invoice-details?${AUG}&user_id=${USER_B}&tenant_id=${USER_B}`, TOKEN_A);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.invoice_count, 2, "still tenant A's two invoices");
  assert.ok(!r.body.rows.some(x => x.invoice_number === 'B-B2B-001'));
});

test('X9 sort direction changes order, never membership', async () => {
  const asc = await api(`/reports/invoice-details?${AUG}&sort=asc`, TOKEN_A);
  const desc = await api(`/reports/invoice-details?${AUG}&sort=desc`, TOKEN_A);
  assert.strictEqual(asc.body.item_count, desc.body.item_count);
  assert.deepStrictEqual(
    [...new Set(asc.body.rows.map(r => r.invoice_number))].sort(),
    [...new Set(desc.body.rows.map(r => r.invoice_number))].sort());
  assert.notDeepStrictEqual(
    asc.body.rows.map(r => r.invoice_number),
    desc.body.rows.map(r => r.invoice_number));
});

test('X11 invoice_date crosses the wire as a plain date, not a UTC instant', async () => {
  // node-postgres builds a JS Date at local midnight for a DATE column, and
  // res.json() serialises that to UTC. East of Greenwich an invoice dated
  // 2026-08-01 would arrive as "2026-07-31T18:30:00.000Z" and land in the
  // previous month. The route sends the characters Postgres holds instead.
  await mkInvoice(USER_A, 'b2b', 'A-EDGE-001', '2026-08-01', 1);
  const r = await api(`/reports/invoice-details?${AUG}`, TOKEN_A);
  const edge = r.body.rows.find(x => x.invoice_number === 'A-EDGE-001');
  assert.ok(edge, 'the first-of-the-month invoice must be in the August export');
  assert.strictEqual(edge.invoice_date, '2026-08-01',
    'the date must arrive as YYYY-MM-DD with no time and no zone');
  assert.ok(!String(edge.invoice_date).includes('T'),
    'a T in the value means a Date object was serialised and the day can shift');
  // Every row, not just this one.
  assert.ok(r.body.rows.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.invoice_date)),
    'every invoice_date must be a plain YYYY-MM-DD string');
  await db.query(`DELETE FROM invoice_items WHERE user_id=$1 AND product_name='Line 1'
                   AND invoice_id IN (SELECT id FROM b2b_invoices WHERE invoice_number='A-EDGE-001')`, [USER_A]);
  await db.query(`DELETE FROM b2b_invoices WHERE user_id=$1 AND invoice_number='A-EDGE-001'`, [USER_A]);
});

test('X10 an empty period returns zero rows and zero counts', async () => {
  const r = await api('/reports/invoice-details?start=2026-01-01&end=2026-01-31', TOKEN_A);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.item_count, 0);
  assert.strictEqual(r.body.invoice_count, 0);
  assert.deepStrictEqual(r.body.rows, []);
});
