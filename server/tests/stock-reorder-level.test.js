// Reorder level, and the one rule that decides Low Stock.
//
// Two things are proved here. That reorder_level is accepted and refused
// on the right values through the real API, and that the Dashboard, the
// /stock/stats counters and the Stock Summary list agree about every
// product — because they now all read the same SQL classification instead
// of the browser keeping a copy of the rule.
//
// The eight boundary cases are the ones where an off-by-one would be
// invisible in ordinary use: stock exactly at the level, one above it,
// zero, negative, and a reorder level of 0 versus none at all.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('reorder level (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'reorder-test-secret';

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

let server, base, db, USER_A, TOKEN_A, USER_B, TOKEN_B;

async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const msg = r => (r && r.body && r.body.error && r.body.error.message) || JSON.stringify(r.body);

// stock and reorder_level are written directly: the point of each case is
// the CLASSIFICATION of a given pair, and going through the ledger to
// reach a balance would test the ledger instead. reorder_level via the API
// is what the validation tests below cover.
async function mkProduct(userId, name, stock, reorder) {
  const { rows } = await db.query(
    `INSERT INTO products (user_id, name, hsn_code, unit, gst_percentage, stock, reorder_level)
     VALUES ($1,$2,'84388090','PCS',18,$3,$4) RETURNING id`,
    [userId, name, stock, reorder]);
  return rows[0].id;
}
const statusOf = async (id, token) =>
  (await api('GET', `/api/stock/${id}`, { token })).body.product.status;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('reorder-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('reorder-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) {
    await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
    await db.query(
      `INSERT INTO stock_locations (user_id,name,code,is_default,active)
       VALUES ($1,'Main','MAIN',TRUE,TRUE)`, [u]);
  }
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// ── the eight mandatory boundary cases ───────────────────────────────
test('R1 the eight boundary cases classify exactly as specified', async () => {
  const cases = [
    { n: 'case 1  stock 10, level 10', stock: 10, reorder: 10, expect: 'LOW_STOCK' },
    { n: 'case 2  stock 11, level 10', stock: 11, reorder: 10, expect: 'IN_STOCK' },
    { n: 'case 3  stock 0,  level 10', stock: 0, reorder: 10, expect: 'OUT_OF_STOCK' },
    { n: 'case 4  stock -1, level 10', stock: -1, reorder: 10, expect: 'OUT_OF_STOCK' },
    { n: 'case 5  stock 5,  no level', stock: 5, reorder: null, expect: 'IN_STOCK' },
    { n: 'case 6  stock 0,  no level', stock: 0, reorder: null, expect: 'OUT_OF_STOCK' },
    { n: 'case 7  stock 5,  level 0', stock: 5, reorder: 0, expect: 'IN_STOCK' },
    { n: 'case 8  stock 0,  level 0', stock: 0, reorder: 0, expect: 'OUT_OF_STOCK' }
  ];
  for (const c of cases) {
    const id = await mkProduct(USER_A, c.n, c.stock, c.reorder);
    assert.strictEqual(await statusOf(id, TOKEN_A), c.expect, c.n);
    await db.query('DELETE FROM products WHERE id=$1', [id]);
  }
});

test('R2 a product with no reorder level is never LOW_STOCK, at any quantity', async () => {
  for (const qty of [0.001, 1, 5, 10, 1000]) {
    const id = await mkProduct(USER_A, 'no level ' + qty, qty, null);
    assert.strictEqual(await statusOf(id, TOKEN_A), 'IN_STOCK',
      `${qty} with no reorder level is in stock, not low`);
    await db.query('DELETE FROM products WHERE id=$1', [id]);
  }
});

test('R3 a reorder level of 0 is not the same as having none', async () => {
  // Zero is a real level: it is simply never reached while any stock
  // remains. The difference from NULL only shows at the boundary, and
  // both end up OUT_OF_STOCK at zero for the same reason.
  const zero = await mkProduct(USER_A, 'level zero', 0.001, 0);
  const none = await mkProduct(USER_A, 'level none', 0.001, null);
  assert.strictEqual(await statusOf(zero, TOKEN_A), 'IN_STOCK');
  assert.strictEqual(await statusOf(none, TOKEN_A), 'IN_STOCK');
  const rows = await db.query('SELECT reorder_level FROM products WHERE id IN ($1,$2) ORDER BY reorder_level NULLS LAST', [zero, none]);
  assert.strictEqual(+rows.rows[0].reorder_level, 0, 'one stores 0');
  assert.strictEqual(rows.rows[1].reorder_level, null, 'the other stores NULL');
  await db.query('DELETE FROM products WHERE id IN ($1,$2)', [zero, none]);
});

// ── validation through the real API ──────────────────────────────────
test('R4 reorder_level accepts null, zero, positive and decimal', async () => {
  const mk = async (value) => api('POST', '/api/products', {
    token: TOKEN_A,
    body: { name: 'v' + String(value), hsn_code: '84388090', unit: 'PCS',
      gst_percentage: 18, reorder_level: value }
  });
  for (const value of [null, 0, 5, 10.5, '7.250']) {
    const r = await mk(value);
    assert.strictEqual(r.status, 201, `${JSON.stringify(value)} must be accepted: ${msg(r)}`);
    const stored = r.body.reorder_level;
    if (value === null) assert.strictEqual(stored, null, 'blank stores NULL');
    else assert.strictEqual(+stored, +value, `${value} stored intact`);
    await db.query('DELETE FROM products WHERE id=$1', [r.body.id]);
  }
});

test('R5 reorder_level refuses negatives and things that are not numbers', async () => {
  const bad = [-1, '-5', 'abc', 'NaN', 'Infinity', '1e400', {}, [], true, '5abc'];
  for (const value of bad) {
    const r = await api('POST', '/api/products', {
      token: TOKEN_A,
      body: { name: 'bad', hsn_code: '84388090', unit: 'PCS', gst_percentage: 18, reorder_level: value }
    });
    assert.strictEqual(r.status, 400, `${JSON.stringify(value)} must be refused, got ${r.status}`);
    assert.match(msg(r), /[Rr]eorder level/, 'and say which field');
  }
  const n = (await db.query('SELECT COUNT(*)::int n FROM products WHERE user_id=$1 AND name=$2',
    [USER_A, 'bad'])).rows[0].n;
  assert.strictEqual(n, 0, 'nothing was written by a refused request');
});

test('R6 an edit that sets ONLY a reorder level is still validated', async () => {
  // This is the request the validator used to wave through: no hsn_code in
  // the body, so the "nothing to check on update" early return fired first.
  const id = await mkProduct(USER_A, 'edit only', 10, null);

  const bad = await api('PATCH', `/api/products?id=eq.${id}`,
    { token: TOKEN_A, body: { reorder_level: -3 } });
  assert.strictEqual(bad.status, 400, msg(bad));
  assert.strictEqual((await db.query('SELECT reorder_level FROM products WHERE id=$1', [id])).rows[0].reorder_level,
    null, 'and the row is untouched');

  // A level BELOW the stock leaves it in stock ...
  const under = await api('PATCH', `/api/products?id=eq.${id}`,
    { token: TOKEN_A, body: { reorder_level: 4 } });
  assert.strictEqual(under.status, 200, msg(under));
  assert.strictEqual(await statusOf(id, TOKEN_A), 'IN_STOCK', '10 is above a level of 4');

  // ... and raising it to the stock itself makes it low, which is what
  // proves the accepted edit actually reached the row.
  const at = await api('PATCH', `/api/products?id=eq.${id}`,
    { token: TOKEN_A, body: { reorder_level: 10 } });
  assert.strictEqual(at.status, 200, msg(at));
  assert.strictEqual(await statusOf(id, TOKEN_A), 'LOW_STOCK', '10 is at a level of 10');
  await db.query('DELETE FROM products WHERE id=$1', [id]);
});

test('R7 clearing a reorder level puts the product back to never-low', async () => {
  const id = await mkProduct(USER_A, 'clearable', 3, 5);
  assert.strictEqual(await statusOf(id, TOKEN_A), 'LOW_STOCK');

  const cleared = await api('PATCH', `/api/products?id=eq.${id}`,
    { token: TOKEN_A, body: { reorder_level: null } });
  assert.strictEqual(cleared.status, 200, msg(cleared));
  assert.strictEqual((await db.query('SELECT reorder_level FROM products WHERE id=$1', [id])).rows[0].reorder_level, null);
  assert.strictEqual(await statusOf(id, TOKEN_A), 'IN_STOCK', 'no level, so never low');
  await db.query('DELETE FROM products WHERE id=$1', [id]);
});

// ── the three views must agree ───────────────────────────────────────
test('R8 stats, the list and each product agree on every classification', async () => {
  await db.query('DELETE FROM products WHERE user_id=$1', [USER_A]);
  // Two low, one out, two in stock — and one untracked, which belongs to
  // none of the three counts.
  const made = [
    await mkProduct(USER_A, 'low at level', 10, 10),
    await mkProduct(USER_A, 'low below', 2, 5),
    await mkProduct(USER_A, 'out', 0, 4),
    await mkProduct(USER_A, 'in above', 11, 10),
    await mkProduct(USER_A, 'in no level', 5, null),
    await mkProduct(USER_A, 'untracked', null, null)
  ];

  const stats = (await api('GET', '/api/stock/stats', { token: TOKEN_A })).body;
  assert.strictEqual(stats.low_stock, 2, 'two low');
  assert.strictEqual(stats.out_of_stock, 1, 'one out');
  assert.strictEqual(stats.tracked_products, 5, 'the untracked product is not counted');

  const lowList = (await api('GET', '/api/stock?status=LOW_STOCK', { token: TOKEN_A })).body;
  const outList = (await api('GET', '/api/stock?status=OUT_OF_STOCK', { token: TOKEN_A })).body;
  assert.strictEqual(lowList.total, stats.low_stock, 'the list total matches the counter');
  assert.strictEqual(outList.total, stats.out_of_stock);

  // And every row's own status matches what the per-product read says, so
  // the list badge cannot disagree with the product page.
  for (const row of lowList.rows) {
    assert.strictEqual(row.status, 'LOW_STOCK');
    assert.strictEqual(await statusOf(row.id, TOKEN_A), 'LOW_STOCK');
  }
  for (const row of outList.rows) {
    assert.strictEqual(row.status, 'OUT_OF_STOCK');
    assert.strictEqual(await statusOf(row.id, TOKEN_A), 'OUT_OF_STOCK');
  }
  await db.query('DELETE FROM products WHERE id = ANY($1)', [made]);
});

test('R9 the counters never mix tenants', async () => {
  await db.query('DELETE FROM products WHERE user_id IN ($1,$2)', [USER_A, USER_B]);
  await mkProduct(USER_A, 'A low', 1, 5);          // A: one low
  await mkProduct(USER_B, 'B normal', 100, 5);     // B: one normal
  await mkProduct(USER_B, 'B low', 1, 5);          // B: one low of its own

  const a = (await api('GET', '/api/stock/stats', { token: TOKEN_A })).body;
  const b = (await api('GET', '/api/stock/stats', { token: TOKEN_B })).body;
  assert.strictEqual(a.low_stock, 1, "A sees only A's low product");
  assert.strictEqual(a.tracked_products, 1);
  assert.strictEqual(b.low_stock, 1);
  assert.strictEqual(b.tracked_products, 2);

  const aList = (await api('GET', '/api/stock?status=LOW_STOCK', { token: TOKEN_A })).body;
  assert.strictEqual(aList.rows.length, 1);
  assert.strictEqual(aList.rows[0].name, 'A low');

  // A cannot reach B's product even knowing its id.
  const bLow = (await db.query(
    'SELECT id FROM products WHERE user_id=$1 AND name=$2', [USER_B, 'B low'])).rows[0].id;
  const stolen = await api('GET', `/api/stock/${bLow}`, { token: TOKEN_A });
  assert.strictEqual(stolen.status, 404, "another tenant's product is simply not there");
  await db.query('DELETE FROM products WHERE user_id IN ($1,$2)', [USER_A, USER_B]);
});

test('R10 the stats endpoints require authentication', async () => {
  for (const url of ['/api/stock/stats', '/api/stock?status=LOW_STOCK']) {
    const r = await api('GET', url);
    assert.strictEqual(r.status, 401, url + ' without a token');
  }
});

// ── the browser no longer holds a second copy of the rule ────────────
test('R11 the Dashboard reads the server summary and classifies nothing', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard.html'), 'utf8');
  assert.equal(/LOW_STOCK_THRESHOLD/.test(dash), false, 'no flat threshold');
  assert.equal(/function dashStockStatus/.test(dash), false, 'no client classifier');
  assert.equal(/'LOW_STOCK'/.test(dash), false, 'no second rule in the browser at all');
  assert.match(dash, /apiFetch\('\/stock\/stats'\)/);
  assert.match(dash, /apiFetch\('\/stock\?status=LOW_STOCK&limit=8'\)/);
  assert.match(dash, /apiFetch\('\/stock\?status=OUT_OF_STOCK&limit=8'\)/);
  assert.match(dash, /stats\.low_stock/);
  assert.match(dash, /stats\.out_of_stock/);
  // and it does not filter the product cache to reach those two numbers
  assert.equal(/tracked\.filter\(p => dash/.test(dash), false);
});

test('R12 Product Master can edit the reorder level', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'products.html'), 'utf8');
  const js = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'js', 'pages', 'products.js'), 'utf8');
  assert.match(html, /id="prodReorderLevel"/, 'the field exists');
  assert.match(html, /id="prodReorderLevelError"/, 'and can show its own error');
  assert.match(html, /min="0"/, 'the control itself refuses negatives');
  // Read back into the form, blank when there is none.
  assert.match(js, /set\('prodReorderLevel', r\?\.reorder_level == null \? '' : \+r\.reorder_level\)/);
  // Blank saved as NULL, never as 0.
  assert.match(js, /reorder_level: val\('prodReorderLevel'\)\.trim\(\) === '' \? null/);
  assert.match(js, /reorder_level: v\.reorder_level === null \? null : \+v\.reorder_level/);
  assert.match(js, /show\('reorder_level', 'prodReorderLevelError'\)/);
});

test('R13 a synced product can still be given a reorder level', () => {
  // Sync owns the catalogue; the reorder level is this business's own
  // inventory policy and sits outside the synced block for that reason.
  const js = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'js', 'pages', 'products.js'), 'utf8');
  const payload = js.slice(js.indexOf('const payload = {'), js.indexOf('if (!synced) {'));
  assert.match(payload, /reorder_level/, 'it is in the base payload, not the catalogue block');
});

test('R14 the server validates a synced payload reorder level too', async () => {
  // Product Sync never sends the column, so nothing it writes changes —
  // but if anything ever did send a bad one, source:'synced' must not be
  // a way past the check.
  const r = await api('POST', '/api/products', {
    token: TOKEN_A,
    body: { name: 'synced bad', hsn_code: '84388090', unit: 'PCS',
      gst_percentage: 18, source: 'synced', reorder_level: -2 }
  });
  assert.strictEqual(r.status, 400, msg(r));
});
