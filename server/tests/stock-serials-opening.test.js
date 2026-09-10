// Naming the units a product already holds, and the rule that makes it
// necessary.
//
// A product counted for years has a quantity but no names. Switching
// serial tracking on for it would have the system claiming ten
// identifiable things while knowing none of them, so it is refused until
// the units are named — and naming them is a reconciliation, not a
// purchase: no goods arrive, no quantity changes, no movement is written.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('opening reconciliation (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'serial-opening-secret';

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
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 60000);
    child.stdout.on('data', d => { out += d; if (out.includes('listening on')) { clearTimeout(done); resolve(child); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

let server, base, db, USER_A, TOKEN_A, USER_B, TOKEN_B, LOC_MAIN, LOC_SECOND;

async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}
const msg = r => (r && r.body && r.body.error && r.body.error.message) || JSON.stringify(r.body);

// A product with stock but no serials — the shape a business that has been
// counting for years actually has.
async function mkStocked(userId, name, qty, locationId) {
  const { rows } = await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock,serial_tracking)
     VALUES ($1,$2,'84388090','PCS',18,$3,FALSE) RETURNING id`, [userId, name, qty]);
  const id = rows[0].id;
  if (qty > 0) {
    await db.query(
      `INSERT INTO stock_balances (user_id,product_id,location_id,quantity) VALUES ($1,$2,$3,$4)`,
      [userId, id, locationId, qty]);
  }
  return id;
}
const reconcile = (productId, serials, token) =>
  api('POST', '/api/stock/serials/reconcile-opening',
    { token: token || TOKEN_A, body: { product_id: productId, serials } });
const trackingOf = async (id) => (await db.query(
  'SELECT serial_tracking FROM products WHERE id=$1', [id])).rows[0].serial_tracking;
const serialRows = async (userId, productId) => (await db.query(
  `SELECT serial_no, status, location_id, source_type, source_id
     FROM stock_serials WHERE user_id=$1 AND product_id=$2 ORDER BY upper(btrim(serial_no))`,
  [userId, productId])).rows;
const stockOf = async (id) => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [id])).rows[0].stock);

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('open-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('open-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) {
    await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
  }
  LOC_MAIN = (await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'Main','MAIN',TRUE,TRUE) RETURNING id`, [USER_A])).rows[0].id;
  LOC_SECOND = (await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'Second','SEC',FALSE,TRUE) RETURNING id`, [USER_A])).rows[0].id;
  await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'B Main','BMAIN',TRUE,TRUE)`, [USER_B]);
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '2h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '2h' });

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// ── the mandatory numeric flow ───────────────────────────────────────
test('O1 stock with no serials refuses to become serial-tracked, then reconciles', async () => {
  const p = await mkStocked(USER_A, 'Legacy', 3, LOC_MAIN);

  const enable = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: true } });
  assert.strictEqual(enable.status, 409, msg(enable));
  assert.match(msg(enable), /must be reconciled with serial numbers/);
  assert.strictEqual(await trackingOf(p), false, 'still quantity-tracked');

  const done = await reconcile(p, ['SN001', 'SN002', 'SN003']);
  assert.strictEqual(done.status, 201, msg(done));
  assert.strictEqual(await trackingOf(p), true, 'tracking begins with the units, not before');
  assert.strictEqual(await stockOf(p), 3, 'the quantity did not move');

  const rows = await serialRows(USER_A, p);
  assert.deepStrictEqual(rows.map(r => r.serial_no), ['SN001', 'SN002', 'SN003']);
  assert.ok(rows.every(r => r.status === 'AVAILABLE'));
  assert.ok(rows.every(r => r.location_id === LOC_MAIN), 'at the location the stock is at');
  assert.ok(rows.every(r => r.source_type === 'opening'), 'marked as opening, not a purchase');
  assert.ok(rows.every(r => r.source_id === null), 'and pointing at no document');
});

test('O2 reconciliation invents no purchase and no stock movement', async () => {
  const p = await mkStocked(USER_A, 'NoMovement', 2, LOC_MAIN);
  const before = (await db.query(
    'SELECT COUNT(*)::int n FROM stock_movements WHERE user_id=$1 AND product_id=$2',
    [USER_A, p])).rows[0].n;
  assert.strictEqual((await reconcile(p, ['SN010', 'SN011'])).status, 201);

  const after = (await db.query(
    'SELECT COUNT(*)::int n FROM stock_movements WHERE user_id=$1 AND product_id=$2',
    [USER_A, p])).rows[0].n;
  assert.strictEqual(after, before, 'no movement was written');
  const purchases = (await db.query(
    'SELECT COUNT(*)::int n FROM purchases WHERE user_id=$1', [USER_A])).rows[0].n;
  assert.strictEqual(purchases, 0, 'and no purchase was invented');
  assert.strictEqual(await stockOf(p), 2);
});

// ── count must match the balance exactly ─────────────────────────────
test('O3 the serial count must equal the stock, in both directions', async () => {
  const p = await mkStocked(USER_A, 'Counts', 3, LOC_MAIN);

  const short = await reconcile(p, ['SN020', 'SN021']);
  assert.strictEqual(short.status, 409, msg(short));
  assert.match(short.body.error.message, /needs exactly 3 serial numbers/);

  const over = await reconcile(p, ['SN020', 'SN021', 'SN022', 'SN023']);
  assert.strictEqual(over.status, 409, msg(over));

  assert.strictEqual(await trackingOf(p), false, 'and neither attempt turned tracking on');
  assert.strictEqual((await serialRows(USER_A, p)).length, 0, 'nothing was created');
});

test('O4 blanks, duplicates and case/space collisions are all refused', async () => {
  const p = await mkStocked(USER_A, 'Bad', 2, LOC_MAIN);

  assert.strictEqual((await reconcile(p, ['SN030', '  '])).status, 400, 'a blank');
  assert.strictEqual((await reconcile(p, ['SN030', 'SN030'])).status, 409, 'the same twice');
  assert.strictEqual((await reconcile(p, ['SN030', 'sn030'])).status, 409, 'differing only by case');
  assert.strictEqual((await reconcile(p, ['SN030', ' SN030 '])).status, 409, 'differing only by spaces');

  // And one that already exists elsewhere in the tenant.
  const other = await mkStocked(USER_A, 'Owner', 1, LOC_MAIN);
  assert.strictEqual((await reconcile(other, ['SN040'])).status, 201);
  const clash = await reconcile(p, ['SN040', 'SN041']);
  assert.strictEqual(clash.status, 409, msg(clash));

  assert.strictEqual((await serialRows(USER_A, p)).length, 0, 'nothing was created by any of them');
  assert.strictEqual(await trackingOf(p), false);
});

test('O5 a product that already has serials cannot be reconciled again', async () => {
  const p = await mkStocked(USER_A, 'Again', 1, LOC_MAIN);
  assert.strictEqual((await reconcile(p, ['SN050'])).status, 201);
  const again = await reconcile(p, ['SN051']);
  assert.strictEqual(again.status, 409, msg(again));
  assert.match(msg(again), /already has serial numbers/);
});

test('O6 stock spread across locations is refused rather than guessed', async () => {
  const p = await mkStocked(USER_A, 'TwoPlaces', 3, LOC_MAIN);
  await db.query(
    `INSERT INTO stock_balances (user_id,product_id,location_id,quantity) VALUES ($1,$2,$3,2)`,
    [USER_A, p, LOC_SECOND]);
  await db.query('UPDATE products SET stock = 5 WHERE id = $1', [p]);

  const r = await reconcile(p, ['SN060', 'SN061', 'SN062', 'SN063', 'SN064']);
  assert.strictEqual(r.status, 409, msg(r));
  assert.match(msg(r), /2 locations/);
  assert.strictEqual((await serialRows(USER_A, p)).length, 0, 'nothing was placed anywhere');
});

test('O7 a product with no stock has nothing to reconcile', async () => {
  const p = await mkStocked(USER_A, 'Empty', 0, LOC_MAIN);
  const r = await reconcile(p, []);
  assert.strictEqual(r.status, 400, msg(r));
  assert.strictEqual(await trackingOf(p), false);
});

test('O8 an untracked product has no units to name', async () => {
  const { rows } = await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock,serial_tracking)
     VALUES ($1,'Service','998729','NA',18,NULL,FALSE) RETURNING id`, [USER_A]);
  const r = await reconcile(rows[0].id, ['SN070']);
  assert.strictEqual(r.status, 400, msg(r));
  assert.match(msg(r), /not stock-tracked/);
});

// ── enabling without stock is still allowed ──────────────────────────
test('O9 a product with no stock turns tracking on freely', async () => {
  const p = await mkStocked(USER_A, 'Fresh', 0, LOC_MAIN);
  const on = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: true } });
  assert.strictEqual(on.status, 200, msg(on));
  assert.strictEqual(await trackingOf(p), true);
});

// ── tenancy and auth ─────────────────────────────────────────────────
test('O10 another tenant cannot reconcile a product that is not theirs', async () => {
  const p = await mkStocked(USER_A, 'MineOnly', 2, LOC_MAIN);
  const theirs = await reconcile(p, ['SN080', 'SN081'], TOKEN_B);
  assert.strictEqual(theirs.status, 404, msg(theirs));
  assert.strictEqual(await trackingOf(p), false);
  assert.strictEqual((await serialRows(USER_A, p)).length, 0);

  // And the same numbers may legitimately exist in the other tenant.
  const bProd = await mkStocked(USER_B, 'TheirOwn', 2, (await db.query(
    'SELECT id FROM stock_locations WHERE user_id=$1', [USER_B])).rows[0].id);
  assert.strictEqual((await reconcile(bProd, ['SN080', 'SN081'], TOKEN_B)).status, 201);
});

test('O11 reconciliation requires authentication', async () => {
  const r = await api('POST', '/api/stock/serials/reconcile-opening',
    { body: { product_id: '00000000-0000-4000-8000-000000000000', serials: ['X'] } });
  assert.strictEqual(r.status, 401);
});

// ── the two accounts agree afterwards ────────────────────────────────
test('O12 stock and serials reconcile after opening', async () => {
  const p = await mkStocked(USER_A, 'Balanced', 4, LOC_MAIN);
  assert.strictEqual((await reconcile(p, ['SN090', 'SN091', 'SN092', 'SN093'])).status, 201);

  const rec = await api('GET', `/api/stock/serials/reconcile?product_id=${p}`, { token: TOKEN_A });
  assert.strictEqual(rec.status, 200, msg(rec));
  assert.ok(rec.body.balanced, 'four units against a balance of four: ' + JSON.stringify(rec.body.rows));
  const row = rec.body.rows[0];
  assert.strictEqual(row.held_serials, 4);
  assert.strictEqual(Number(row.balance_quantity), 4);
  assert.strictEqual(row.location_id, LOC_MAIN);
});

test('O13 a reconciled product then behaves like any other serialised one', async () => {
  const p = await mkStocked(USER_A, 'ThenSells', 2, LOC_MAIN);
  assert.strictEqual((await reconcile(p, ['SN100', 'SN101'])).status, 201);

  // It now requires serials on a sale, like any tracked product.
  const noSerials = await api('POST', '/api/invoices/b2c/save-with-items', {
    token: TOKEN_A,
    body: {
      header: {
        invoice_number: 'INV-O13', invoice_date: '2026-09-11', state: 'Tamil Nadu',
        supply_type: 'intrastate', taxable_amount: 2000, gst_percentage: 18,
        gst_amount: 360, total_amount: 2360, cgst: 180, sgst: 180, igst: 0
      },
      items: [{
        product_id: p, product_name: 'ThenSells', hsn_code: '84388090', unit: 'PCS',
        quantity: 1, rate: 2000, gst_percentage: 18, taxable_value: 2000,
        gst_amount: 360, cgst: 180, sgst: 180, igst: 0, total_amount: 2360
      }]
    }
  });
  assert.strictEqual(noSerials.status, 409, msg(noSerials));
  assert.match(msg(noSerials), /serial-tracked/);
  assert.strictEqual(await stockOf(p), 2, 'and nothing was sold');
});

test('O14 the reconciled units can be switched off only while none exist', async () => {
  const p = await mkStocked(USER_A, 'NoOff', 1, LOC_MAIN);
  assert.strictEqual((await reconcile(p, ['SN110'])).status, 201);
  const off = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: false } });
  assert.strictEqual(off.status, 409, msg(off));
  assert.strictEqual(await trackingOf(p), true);
});
