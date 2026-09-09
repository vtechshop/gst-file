// Deleting a purchase that came from an order.
//
// Stock going back while the order still claims the goods arrived is the
// inconsistency these cover: every test checks the stock balance AND the
// order's received/pending/status together, because getting one right and
// the other wrong is the defect.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('purchase order reversal (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'po-rev-secret';

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

let server, base, db, USER_A, USER_B, TOK_A, TOK_B, VENDOR, PRODUCT;
const tok = id => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const stockOf = async () => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [PRODUCT])).rows[0].stock);
const balanceAt = async (locationId) => Number((await db.query(
  'SELECT COALESCE(quantity,0) q FROM stock_balances WHERE product_id=$1 AND location_id=$2',
  [PRODUCT, locationId])).rows[0]?.q || 0);
const defaultLocation = async () => (await db.query(
  'SELECT id FROM stock_locations WHERE user_id=$1 AND is_default', [USER_A])).rows[0]?.id || null;

function orderBody() {
  return {
    document_date: '2026-09-01', vendor_id: VENDOR, vendor_name: 'Acme Supplies',
    state: 'Tamil Nadu', supply_type: 'intrastate', gst_percentage: 18,
    taxable_amount: 10000, gst_amount: 1800, cgst: 900, sgst: 900, igst: 0, total_amount: 11800
  };
}
const line = (qty) => ({
  product_id: PRODUCT, product_name: 'Machine A', hsn_code: '84388090', unit: 'PCS',
  quantity: qty, rate: 1000, gst_percentage: 18,
  taxable_value: 1000 * qty, gst_amount: 180 * qty, cgst: 90 * qty, sgst: 90 * qty,
  igst: 0, total_amount: 1180 * qty
});

// An order, confirmed and ready to receive.
async function newOrder(qty) {
  const po = await api('POST', '/purchase-orders/save',
    { token: TOK_A, body: { order: orderBody(), items: [line(qty)] } });
  await api('POST', `/purchase-orders/${po.body.id}/status`,
    { token: TOK_A, body: { status: 'CONFIRMED' } });
  return { id: po.body.id, itemId: po.body.items[0].id };
}
const receive = (id, itemId, qty, number) => api('POST', `/purchase-orders/${id}/receive`,
  { token: TOK_A, body: { purchase_number: number, purchase_date: '2026-09-10', lines: [{ item_id: itemId, quantity: qty }] } });
// The existing purchase deletion flow, unchanged.
const deletePurchase = (purchaseId, token) =>
  api('POST', `/purchases/purchase/${purchaseId}/cascade-delete`, { token: token || TOK_A });

async function orderState(id) {
  const r = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  return {
    status: r.body.order.status,
    received: Number(r.body.items[0].received_quantity),
    pending: Number(r.body.items[0].pending_quantity)
  };
}

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
  USER_A = await mkUser('rev-a@scratch.test');
  USER_B = await mkUser('rev-b@scratch.test');
  TOK_A = tok(USER_A); TOK_B = tok(USER_B);
  VENDOR = (await db.query(
    `INSERT INTO vendors (user_id,name) VALUES ($1,'Acme Supplies') RETURNING id`, [USER_A])).rows[0].id;
  PRODUCT = (await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock)
     VALUES ($1,'Machine A','84388090','PCS',18,0) RETURNING id`, [USER_A])).rows[0].id;
  // A default location, so the reversal can be checked against it.
  await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'Main Warehouse','MAIN',TRUE,TRUE)`, [USER_A]);

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('R1 the reported case: order 10, receive 6, delete the purchase', async () => {
  const start = await stockOf();
  const { id, itemId } = await newOrder(10);
  const r = await receive(id, itemId, 6, 'PUR-R1');
  assert.strictEqual(r.status, 201);

  assert.deepStrictEqual(await orderState(id),
    { status: 'PARTIALLY_RECEIVED', received: 6, pending: 4 });
  assert.strictEqual(await stockOf(), start + 6);

  const del = await deletePurchase(r.body.purchase_id);
  assert.strictEqual(del.status, 200);

  assert.strictEqual(await stockOf(), start, 'stock returns to exactly what it was');
  assert.deepStrictEqual(await orderState(id),
    { status: 'CONFIRMED', received: 0, pending: 10 },
    'and the order stops claiming the goods arrived');
});

test('R2 three receipts, then the middle one deleted', async () => {
  const start = await stockOf();
  const { id, itemId } = await newOrder(10);
  const a = await receive(id, itemId, 3, 'PUR-R2-A');
  const b = await receive(id, itemId, 2, 'PUR-R2-B');
  const c = await receive(id, itemId, 5, 'PUR-R2-C');
  assert.deepStrictEqual(await orderState(id),
    { status: 'FULLY_RECEIVED', received: 10, pending: 0 });
  assert.strictEqual(await stockOf(), start + 10);

  await deletePurchase(b.body.purchase_id);
  assert.deepStrictEqual(await orderState(id),
    { status: 'PARTIALLY_RECEIVED', received: 8, pending: 2 }, 'the middle receipt only');
  assert.strictEqual(await stockOf(), start + 8);

  await deletePurchase(a.body.purchase_id);
  assert.deepStrictEqual(await orderState(id),
    { status: 'PARTIALLY_RECEIVED', received: 5, pending: 5 });
  assert.strictEqual(await stockOf(), start + 5);

  await deletePurchase(c.body.purchase_id);
  assert.deepStrictEqual(await orderState(id),
    { status: 'CONFIRMED', received: 0, pending: 10 }, 'back to where it began');
  assert.strictEqual(await stockOf(), start, 'and so is the stock');
});

test('R3 deleting the same purchase twice reverses once', async () => {
  const start = await stockOf();
  const { id, itemId } = await newOrder(10);
  const r = await receive(id, itemId, 6, 'PUR-R3');
  const movesBefore = Number((await db.query(
    'SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1', [PRODUCT])).rows[0].n);

  await deletePurchase(r.body.purchase_id);
  const afterFirst = await stockOf();
  const state = await orderState(id);
  const movesAfterFirst = Number((await db.query(
    'SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1', [PRODUCT])).rows[0].n);

  // Again. The line items are gone, so there is nothing left to reverse.
  await deletePurchase(r.body.purchase_id);
  assert.strictEqual(await stockOf(), afterFirst, 'stock reversed once, not twice');
  assert.deepStrictEqual(await orderState(id), state, 'the order is unchanged by the retry');
  assert.strictEqual(Number((await db.query(
    'SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1', [PRODUCT])).rows[0].n),
  movesAfterFirst, 'no duplicate reversal movement');
  assert.strictEqual(await stockOf(), start);
  assert.ok(movesAfterFirst > movesBefore);
});

test('R4 two simultaneous deletions of one purchase reverse once', async () => {
  const start = await stockOf();
  const { id, itemId } = await newOrder(10);
  const r = await receive(id, itemId, 7, 'PUR-R4');
  assert.strictEqual(await stockOf(), start + 7);

  const [a, b] = await Promise.all([
    deletePurchase(r.body.purchase_id),
    deletePurchase(r.body.purchase_id)
  ]);
  assert.ok([a.status, b.status].every(s => s === 200 || s === 404),
    `both should finish cleanly, got ${a.status} and ${b.status}`);

  assert.strictEqual(await stockOf(), start, 'stock gave back 7 once, not 14');
  assert.deepStrictEqual(await orderState(id), { status: 'CONFIRMED', received: 0, pending: 10 });
});

test('R5 the reversal comes out of the same location it went into', async () => {
  const loc = await defaultLocation();
  assert.ok(loc, 'the tenant has a default location');
  const before = await balanceAt(loc);

  const { id, itemId } = await newOrder(8);
  const r = await receive(id, itemId, 5, 'PUR-R5');
  assert.strictEqual(await balanceAt(loc), before + 5, 'received into Main Warehouse');

  await deletePurchase(r.body.purchase_id);
  assert.strictEqual(await balanceAt(loc), before, 'and given back from Main Warehouse');

  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM stock_balances WHERE product_id=$1 AND location_id <> $2',
    [PRODUCT, loc]);
  assert.strictEqual(rows[0].n, 0, 'no other location was touched');
});

test('R6 an ordinary purchase with no order behaves exactly as before', async () => {
  const start = await stockOf();
  // Saved through the existing purchase route, with no order behind it.
  const saved = await api('POST', '/purchases/purchase/save-with-items', {
    token: TOK_A,
    body: {
      header: {
        vendor_id: VENDOR, vendor_name: 'Acme Supplies', state: 'Tamil Nadu',
        purchase_number: 'PUR-R6', purchase_date: '2026-09-10', supply_type: 'intrastate',
        taxable_amount: 4000, gst_percentage: 18, gst_amount: 720, cgst: 360, sgst: 360,
        igst: 0, total_amount: 4720, payment_status: 'unpaid', amount_paid: 0
      },
      items: [{
        product_id: PRODUCT, product_name: 'Machine A', hsn_code: '84388090', unit: 'PCS',
        quantity: 4, rate: 1000, discount_percentage: 0, gst_percentage: 18,
        taxable_value: 4000, gst_amount: 720, cgst: 360, sgst: 360, igst: 0, total_amount: 4720
      }]
    }
  });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(await stockOf(), start + 4);

  const del = await deletePurchase(saved.body.id);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.purchase_order, null, 'there was no order to reconcile');
  assert.strictEqual(await stockOf(), start, 'stock reversed exactly as it always did');
});

test('R7 the order can be edited down once its receipts are gone', async () => {
  const { id, itemId } = await newOrder(10);
  const r = await receive(id, itemId, 6, 'PUR-R7');

  // Refused while 6 have arrived.
  const tooLow = await api('POST', '/purchase-orders/save', {
    token: TOK_A,
    body: { editId: id, order: { ...orderBody(), document_number: undefined },
      items: [{ ...line(5), id: itemId }] }
  });
  assert.strictEqual(tooLow.status, 409);

  await deletePurchase(r.body.purchase_id);
  const now = await api('POST', '/purchase-orders/save', {
    token: TOK_A,
    body: { editId: id, items: [{ ...line(5), id: itemId }], order: { ...orderBody() } }
  });
  assert.strictEqual(now.status, 200, 'allowed once nothing has been received');
  assert.deepStrictEqual(await orderState(id), { status: 'CONFIRMED', received: 0, pending: 5 });
});

test('R8 a purchase return does not give quantity back to the order', async () => {
  const start = await stockOf();
  const { id, itemId } = await newOrder(10);
  const r = await receive(id, itemId, 6, 'PUR-R8');
  const before = await orderState(id);

  // Goods arrived and were sent back. They were still received.
  const ret = await api('POST', '/purchases/return/save-with-items', {
    token: TOK_A,
    body: {
      header: {
        vendor_id: VENDOR, vendor_name: 'Acme Supplies', state: 'Tamil Nadu',
        return_number: 'PRET-R8', return_date: '2026-09-12', supply_type: 'intrastate',
        taxable_amount: 2000, gst_percentage: 18, gst_amount: 360, cgst: 180, sgst: 180,
        igst: 0, total_amount: 2360
      },
      items: [{
        product_id: PRODUCT, product_name: 'Machine A', hsn_code: '84388090', unit: 'PCS',
        quantity: 2, rate: 1000, discount_percentage: 0, gst_percentage: 18,
        taxable_value: 2000, gst_amount: 360, cgst: 180, sgst: 180, igst: 0, total_amount: 2360
      }]
    }
  });
  assert.strictEqual(ret.status, 200);
  assert.strictEqual(await stockOf(), start + 6 - 2, 'the return took stock out');
  assert.deepStrictEqual(await orderState(id), before,
    'but the order still records that 6 were received');
  await deletePurchase(r.body.purchase_id);
});

test('R9 one tenant cannot reverse another tenant purchase', async () => {
  const start = await stockOf();
  const { id, itemId } = await newOrder(10);
  const r = await receive(id, itemId, 4, 'PUR-R9');

  const other = await deletePurchase(r.body.purchase_id, TOK_B);
  // The record is located by id AND user_id, so to tenant B it simply does
  // not exist.
  assert.strictEqual(other.status, 404,
    `tenant B must not reverse tenant A's purchase, got ${other.status}`);
  assert.strictEqual(await stockOf(), start + 4, 'nothing was reversed');
  assert.deepStrictEqual(await orderState(id),
    { status: 'PARTIALLY_RECEIVED', received: 4, pending: 6 });

  await deletePurchase(r.body.purchase_id);
});

test('R10 the reversal route still requires authentication', async () => {
  const r = await api('POST', '/purchases/purchase/'
    + '00000000-0000-0000-0000-000000000000/cascade-delete');
  assert.strictEqual(r.status, 401);
});
