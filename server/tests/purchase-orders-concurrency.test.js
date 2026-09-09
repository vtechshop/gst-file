// Two people doing the same thing at the same moment.
//
// These are the tests that a single-threaded run cannot fake: real
// simultaneous HTTP requests against real Postgres connections, where the
// only thing standing between them is the row lock and the constraint.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('purchase orders concurrency (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'po-conc-secret';

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

let server, base, db, USER, TOKEN, VENDOR, PRODUCT;

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const stockOf = async () => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [PRODUCT])).rows[0].stock);

function orderBody(over) {
  return Object.assign({
    document_date: '2026-09-01', vendor_id: VENDOR, vendor_name: 'Acme Supplies',
    state: 'Tamil Nadu', supply_type: 'intrastate', gst_percentage: 18,
    taxable_amount: 10000, gst_amount: 1800, cgst: 900, sgst: 900, igst: 0, total_amount: 11800
  }, over || {});
}
const line = (qty) => ({
  product_id: PRODUCT, product_name: 'Machine A', hsn_code: '84388090', unit: 'PCS',
  quantity: qty, rate: 1000, gst_percentage: 18,
  taxable_value: 1000 * qty, gst_amount: 180 * qty, cgst: 90 * qty, sgst: 90 * qty,
  igst: 0, total_amount: 1180 * qty
});

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('conc@scratch.test','x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Scratch Co')`, [USER]);
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });
  VENDOR = (await db.query(
    `INSERT INTO vendors (user_id,name) VALUES ($1,'Acme Supplies') RETURNING id`, [USER])).rows[0].id;
  PRODUCT = (await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock)
     VALUES ($1,'Machine A','84388090','PCS',18,0) RETURNING id`, [USER])).rows[0].id;

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('N1 two simultaneous receipts of the whole remainder: exactly one wins', async () => {
  const start = await stockOf();
  const po = await api('POST', '/purchase-orders/save',
    { order: orderBody(), items: [line(10)] });
  const id = po.body.id;
  const itemId = po.body.items[0].id;
  await api('POST', `/purchase-orders/${id}/status`, { status: 'CONFIRMED' });

  // Fired together, on separate connections. Only the row lock decides.
  const [a, b] = await Promise.all([
    api('POST', `/purchase-orders/${id}/receive`, {
      purchase_number: 'PUR-N1-A', purchase_date: '2026-09-10',
      lines: [{ item_id: itemId, quantity: 10 }]
    }),
    api('POST', `/purchase-orders/${id}/receive`, {
      purchase_number: 'PUR-N1-B', purchase_date: '2026-09-10',
      lines: [{ item_id: itemId, quantity: 10 }]
    })
  ]);

  const ok = [a, b].filter(r => r.status === 201);
  const refused = [a, b].filter(r => r.status !== 201);
  assert.strictEqual(ok.length, 1, `exactly one receipt may succeed, got ${ok.length}`);
  assert.strictEqual(refused.length, 1);
  assert.ok([409].includes(refused[0].status),
    `the loser must be refused cleanly, got ${refused[0].status}`);

  assert.strictEqual(await stockOf(), start + 10, 'stock moved once, not twice');

  const view = await api('GET', `/purchase-orders/${id}`);
  assert.strictEqual(Number(view.body.items[0].received_quantity), 10);
  assert.strictEqual(Number(view.body.items[0].pending_quantity), 0);
  assert.strictEqual(view.body.order.status, 'FULLY_RECEIVED');

  const { rows: purchases } = await db.query(
    'SELECT id FROM purchases WHERE purchase_order_id=$1', [id]);
  assert.strictEqual(purchases.length, 1, 'exactly one purchase was written');
  const { rows: moves } = await db.query(
    `SELECT COUNT(*)::int n FROM stock_movements
      WHERE product_id=$1 AND source_id=$2`, [PRODUCT, purchases[0].id]);
  assert.strictEqual(moves[0].n, 1, 'exactly one stock movement');
});

test('N2 repeated clicks on Receive cannot receive the same goods twice', async () => {
  const start = await stockOf();
  const po = await api('POST', '/purchase-orders/save',
    { order: orderBody(), items: [line(4)] });
  const id = po.body.id, itemId = po.body.items[0].id;
  await api('POST', `/purchase-orders/${id}/status`, { status: 'CONFIRMED' });

  // Five clicks in flight at once, each asking for the whole order.
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
    api('POST', `/purchase-orders/${id}/receive`, {
      purchase_number: 'PUR-N2-' + n, purchase_date: '2026-09-11',
      lines: [{ item_id: itemId, quantity: 4 }]
    })));
  assert.strictEqual(results.filter(r => r.status === 201).length, 1,
    'only one of five clicks may write anything');
  assert.strictEqual(await stockOf(), start + 4, 'stock moved once');
  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM purchases WHERE purchase_order_id=$1', [id]);
  assert.strictEqual(rows[0].n, 1, 'one purchase, not five');
});

test('N3 simultaneous partial receipts add up and never exceed the order', async () => {
  const start = await stockOf();
  const po = await api('POST', '/purchase-orders/save',
    { order: orderBody(), items: [line(10)] });
  const id = po.body.id, itemId = po.body.items[0].id;
  await api('POST', `/purchase-orders/${id}/status`, { status: 'CONFIRMED' });

  // 6 + 6 = 12 against an order of 10: whichever lands second must be cut
  // off, not allowed to overshoot.
  const [a, b] = await Promise.all([
    api('POST', `/purchase-orders/${id}/receive`, {
      purchase_number: 'PUR-N3-A', purchase_date: '2026-09-12',
      lines: [{ item_id: itemId, quantity: 6 }]
    }),
    api('POST', `/purchase-orders/${id}/receive`, {
      purchase_number: 'PUR-N3-B', purchase_date: '2026-09-12',
      lines: [{ item_id: itemId, quantity: 6 }]
    })
  ]);
  const won = [a, b].filter(r => r.status === 201).length;
  assert.strictEqual(won, 1, 'the second must be refused rather than overshoot');
  assert.strictEqual(await stockOf(), start + 6);

  const view = await api('GET', `/purchase-orders/${id}`);
  assert.strictEqual(Number(view.body.items[0].received_quantity), 6);
  assert.strictEqual(Number(view.body.items[0].pending_quantity), 4);
  assert.strictEqual(view.body.order.status, 'PARTIALLY_RECEIVED');
});

test('N4 simultaneous order creation produces two distinct numbers', async () => {
  const before = Number((await db.query(
    'SELECT COUNT(*)::int n FROM purchase_orders WHERE user_id=$1', [USER])).rows[0].n);

  const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
    api('POST', '/purchase-orders/save', { order: orderBody(), items: [line(1)] })));

  const created = results.filter(r => r.status === 200);
  assert.strictEqual(created.length, 5, 'every one of them should have been issued a number');
  const numbers = created.map(r => r.body.order.document_number);
  assert.strictEqual(new Set(numbers).size, 5,
    `five simultaneous orders must get five different numbers, got ${numbers.join(', ')}`);
  for (const n of numbers) assert.match(n, /^PO-\d{5}$/);

  const after = Number((await db.query(
    'SELECT COUNT(*)::int n FROM purchase_orders WHERE user_id=$1', [USER])).rows[0].n);
  assert.strictEqual(after - before, 5, 'five orders, no duplicates and none lost');
});

test('N5 the database itself refuses a duplicate number, whatever the code does', async () => {
  // Straight past the application, to prove the index is real.
  const po = await api('POST', '/purchase-orders/save',
    { order: orderBody({ document_number: 'PO-DUPE-1' }), items: [line(1)] });
  assert.strictEqual(po.status, 200);
  await assert.rejects(
    () => db.query(
      `INSERT INTO purchase_orders (user_id, document_number, document_date, vendor_name)
       VALUES ($1,'po-dupe-1','2026-09-01','Acme Supplies')`, [USER]),
    /duplicate key value|uq_purchase_orders/,
    'the unique index is what makes the number race-safe');
});

test('N6 the database itself refuses an over-receipt, whatever the code does', async () => {
  const po = await api('POST', '/purchase-orders/save',
    { order: orderBody(), items: [line(3)] });
  const itemId = po.body.items[0].id;
  await assert.rejects(
    () => db.query(
      'UPDATE purchase_order_items SET received_quantity = 4 WHERE id = $1', [itemId]),
    /no_over_receipt/,
    'received can never exceed ordered, even by direct write');
});
