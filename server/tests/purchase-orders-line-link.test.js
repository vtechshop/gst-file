// The same product on two lines of one order.
//
// This is the case the product-matching reversal could not tell apart: an
// order with Product A twice, 5 and 5, receiving 6, cannot say from the
// quantities alone whether that was 5+1 or 3+3. Every test here uses that
// shape, and checks each LINE rather than only the order total.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('purchase order line link (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'po-link-secret';

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

let server, base, db, USER, TOKEN, VENDOR, PRODUCT_A, PRODUCT_B;
const tok = id => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token || TOKEN) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}
const msg = r => (r && r.body && r.body.error && r.body.error.message) || '';
const stockOf = async (pid) => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [pid || PRODUCT_A])).rows[0].stock);

const line = (productId, name, qty) => ({
  product_id: productId, product_name: name, hsn_code: '84388090', unit: 'PCS',
  quantity: qty, rate: 1000, gst_percentage: 18,
  taxable_value: 1000 * qty, gst_amount: 180 * qty, cgst: 90 * qty, sgst: 90 * qty,
  igst: 0, total_amount: 1180 * qty
});

// An order with Product A on TWO separate lines, 5 and 5.
async function twoLineOrder() {
  const po = await api('POST', '/purchase-orders/save', {
    order: {
      document_date: '2026-09-01', vendor_id: VENDOR, vendor_name: 'Acme Supplies',
      state: 'Tamil Nadu', supply_type: 'intrastate', gst_percentage: 18,
      taxable_amount: 10000, gst_amount: 1800, cgst: 900, sgst: 900, igst: 0, total_amount: 11800
    },
    items: [line(PRODUCT_A, 'Machine A', 5), line(PRODUCT_A, 'Machine A', 5)]
  });
  assert.strictEqual(po.status, 200, 'two lines of one product is a legitimate order');
  await api('POST', `/purchase-orders/${po.body.id}/status`, { status: 'CONFIRMED' });
  return { id: po.body.id, l1: po.body.items[0].id, l2: po.body.items[1].id };
}
const receive = (id, lines, number, token) => api('POST', `/purchase-orders/${id}/receive`,
  { purchase_number: number, purchase_date: '2026-09-10', lines }, token);
const del = (purchaseId) => api('POST', `/purchases/purchase/${purchaseId}/cascade-delete`);

// Per-line received and pending, in line order.
async function lineState(id) {
  const r = await api('GET', `/purchase-orders/${id}`);
  return {
    status: r.body.order.status,
    lines: r.body.items.map(i => ({
      received: Number(i.received_quantity), pending: Number(i.pending_quantity)
    })),
    received: r.body.items.reduce((s, i) => s + Number(i.received_quantity), 0),
    pending: r.body.items.reduce((s, i) => s + Number(i.pending_quantity), 0)
  };
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('link@scratch.test','x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Scratch Co')`, [USER]);
  TOKEN = tok(USER);
  VENDOR = (await db.query(
    `INSERT INTO vendors (user_id,name) VALUES ($1,'Acme Supplies') RETURNING id`, [USER])).rows[0].id;
  const mkProduct = async (n) => (await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock)
     VALUES ($1,$2,'84388090','PCS',18,0) RETURNING id`, [USER, n])).rows[0].id;
  PRODUCT_A = await mkProduct('Machine A');
  PRODUCT_B = await mkProduct('Machine B');
  await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'Main Warehouse','MAIN',TRUE,TRUE)`, [USER]);

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('L1 a receipt records the exact order line it received against', async () => {
  const { id, l1, l2 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 5 }, { item_id: l2, quantity: 1 }], 'PUR-L1');
  assert.strictEqual(r.status, 201);

  const { rows } = await db.query(
    `SELECT quantity, purchase_order_item_id FROM purchase_items
      WHERE purchase_id=$1 ORDER BY sort_order`, [r.body.purchase_id]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].purchase_order_item_id, l1, 'the 5 is against line 1');
  assert.strictEqual(Number(rows[0].quantity), 5);
  assert.strictEqual(rows[1].purchase_order_item_id, l2, 'the 1 is against line 2');
  assert.strictEqual(Number(rows[1].quantity), 1);

  // 5+1, not 3+3 — which is the thing product matching could not tell.
  const st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 1, pending: 4 }]);
});

test('L2 the mandatory numeric flow, line by line', async () => {
  const start = await stockOf();
  const { id, l1, l2 } = await twoLineOrder();

  // Receipt 1: line 1 gets 3.
  await receive(id, [{ item_id: l1, quantity: 3 }], 'PUR-L2-1');
  let st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 3, pending: 2 }, { received: 0, pending: 5 }]);
  assert.strictEqual(st.received, 3);
  assert.strictEqual(st.pending, 7);
  assert.strictEqual(await stockOf(), start + 3);

  // Receipt 2: line 1 gets its last 2, line 2 gets 4.
  const r2 = await receive(id, [{ item_id: l1, quantity: 2 }, { item_id: l2, quantity: 4 }], 'PUR-L2-2');
  st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 4, pending: 1 }]);
  assert.strictEqual(st.received, 9);
  assert.strictEqual(st.pending, 1);
  assert.strictEqual(await stockOf(), start + 9);

  // Receipt 3: line 2's last one.
  await receive(id, [{ item_id: l2, quantity: 1 }], 'PUR-L2-3');
  st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 5, pending: 0 }]);
  assert.strictEqual(st.status, 'FULLY_RECEIVED');
  assert.strictEqual(await stockOf(), start + 10);

  // Delete receipt 2 (2 + 4 = 6): each line gives back its own share.
  await del(r2.body.purchase_id);
  st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 3, pending: 2 }, { received: 1, pending: 4 }],
    'line 1 gave back 2 and line 2 gave back 4 — not six taken from wherever');
  assert.strictEqual(st.received, 4);
  assert.strictEqual(st.pending, 6);
  assert.strictEqual(st.status, 'PARTIALLY_RECEIVED');
  assert.strictEqual(await stockOf(), start + 4, 'stock reversed exactly receipt 2');
});

test('L3 a line cannot borrow capacity from another line of the same product', async () => {
  const { id, l1, l2 } = await twoLineOrder();
  await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-L3-1');
  const stockBefore = await stockOf();

  // Line 1 has 1 left. Line 2 has 5 free, but that is line 2's.
  const over = await receive(id, [{ item_id: l1, quantity: 2 }], 'PUR-L3-2');
  assert.strictEqual(over.status, 409);
  assert.match(msg(over), /only 1 left to receive/);
  assert.strictEqual(await stockOf(), stockBefore, 'nothing moved');

  const st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 4, pending: 1 }, { received: 0, pending: 5 }]);
});

test('L4 deleting a receipt twice gives back one line-share, once', async () => {
  const start = await stockOf();
  const { id, l1, l2 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 5 }, { item_id: l2, quantity: 2 }], 'PUR-L4');
  assert.strictEqual(await stockOf(), start + 7);

  await del(r.body.purchase_id);
  const after = await lineState(id);
  await del(r.body.purchase_id);

  assert.deepStrictEqual(await lineState(id), after, 'the retry changed nothing');
  assert.deepStrictEqual(after.lines, [{ received: 0, pending: 5 }, { received: 0, pending: 5 }]);
  assert.strictEqual(await stockOf(), start, 'stock given back once');
});

test('L5 two simultaneous receipts on ONE line: exactly one wins', async () => {
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder();
  const [a, b] = await Promise.all([
    receive(id, [{ item_id: l1, quantity: 5 }], 'PUR-L5-A'),
    receive(id, [{ item_id: l1, quantity: 5 }], 'PUR-L5-B')
  ]);
  assert.strictEqual([a, b].filter(r => r.status === 201).length, 1);
  const st = await lineState(id);
  assert.deepStrictEqual(st.lines[0], { received: 5, pending: 0 }, 'five, not ten');
  assert.strictEqual(await stockOf(), start + 5);
});

test('L6 simultaneous receipts on DIFFERENT lines both succeed', async () => {
  const start = await stockOf();
  const { id, l1, l2 } = await twoLineOrder();
  const [a, b] = await Promise.all([
    receive(id, [{ item_id: l1, quantity: 5 }], 'PUR-L6-A'),
    receive(id, [{ item_id: l2, quantity: 5 }], 'PUR-L6-B')
  ]);
  assert.strictEqual(a.status, 201, 'line 1 has its own capacity');
  assert.strictEqual(b.status, 201, 'and so does line 2');
  const st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 5, pending: 0 }]);
  assert.strictEqual(st.status, 'FULLY_RECEIVED');
  assert.strictEqual(await stockOf(), start + 10);
});

test('L7 an order line cannot be received against from another tenant', async () => {
  const other = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('link-b@scratch.test','x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Other Co')`, [other]);
  const otherToken = tok(other);

  const { id, l1 } = await twoLineOrder();
  const before = await lineState(id);
  const stockBefore = await stockOf();

  // The order is located by id AND user_id, so to the other tenant it
  // simply is not there — the line id being valid changes nothing.
  const r = await receive(id, [{ item_id: l1, quantity: 1 }], 'PUR-L7', otherToken);
  assert.strictEqual(r.status, 404, 'the order does not exist for another tenant');
  assert.deepStrictEqual(await lineState(id), before, 'nothing was received');
  assert.strictEqual(await stockOf(), stockBefore, 'and no stock moved');
});

test('L8 a line id from a DIFFERENT order is refused', async () => {
  const a = await twoLineOrder();
  const b = await twoLineOrder();
  const r = await receive(a.id, [{ item_id: b.l1, quantity: 1 }], 'PUR-L8');
  assert.strictEqual(r.status, 404);
  assert.match(msg(r), /not on this purchase order/);
});

test('L9 an ordinary purchase has no link and is unaffected', async () => {
  const start = await stockOf(PRODUCT_B);
  const saved = await api('POST', '/purchases/purchase/save-with-items', {
    header: {
      vendor_id: VENDOR, vendor_name: 'Acme Supplies', state: 'Tamil Nadu',
      purchase_number: 'PUR-L9', purchase_date: '2026-09-10', supply_type: 'intrastate',
      taxable_amount: 3000, gst_percentage: 18, gst_amount: 540, cgst: 270, sgst: 270,
      igst: 0, total_amount: 3540, payment_status: 'unpaid', amount_paid: 0
    },
    items: [{
      product_id: PRODUCT_B, product_name: 'Machine B', hsn_code: '84388090', unit: 'PCS',
      quantity: 3, rate: 1000, discount_percentage: 0, gst_percentage: 18,
      taxable_value: 3000, gst_amount: 540, cgst: 270, sgst: 270, igst: 0, total_amount: 3540
    }]
  });
  assert.strictEqual(saved.status, 200);
  const { rows } = await db.query(
    'SELECT purchase_order_item_id FROM purchase_items WHERE purchase_id=$1', [saved.body.id]);
  assert.strictEqual(rows[0].purchase_order_item_id, null, 'no order line, and that is valid');
  assert.strictEqual(await stockOf(PRODUCT_B), start + 3);

  const d = await del(saved.body.id);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.purchase_order, null);
  assert.strictEqual(await stockOf(PRODUCT_B), start, 'reversed exactly as it always did');
});

test('L10 deleting the ORDER leaves the purchase and its history intact', async () => {
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 2 }], 'PUR-L10');
  const purchaseId = r.body.purchase_id;
  assert.strictEqual(await stockOf(), start + 2);

  // ON DELETE SET NULL, not CASCADE: a purchase outlives the order.
  await db.query('DELETE FROM purchase_orders WHERE id=$1 AND user_id=$2', [id, USER]);

  const { rows } = await db.query(
    'SELECT purchase_order_item_id, quantity FROM purchase_items WHERE purchase_id=$1', [purchaseId]);
  assert.strictEqual(rows.length, 1, 'the purchase line survived');
  assert.strictEqual(rows[0].purchase_order_item_id, null, 'only the link was dropped');
  assert.strictEqual(Number(rows[0].quantity), 2);
  const { rows: head } = await db.query('SELECT id FROM purchases WHERE id=$1', [purchaseId]);
  assert.strictEqual(head.length, 1, 'and so did the purchase');
  assert.strictEqual(await stockOf(), start + 2, 'and the stock it brought in');
});

test('L11 a purchase return never gives quantity back to an order line', async () => {
  const { id, l1 } = await twoLineOrder();
  await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-L11');
  const before = await lineState(id);

  const ret = await api('POST', '/purchases/return/save-with-items', {
    header: {
      vendor_id: VENDOR, vendor_name: 'Acme Supplies', state: 'Tamil Nadu',
      return_number: 'PRET-L11', return_date: '2026-09-12', supply_type: 'intrastate',
      taxable_amount: 1000, gst_percentage: 18, gst_amount: 180, cgst: 90, sgst: 90,
      igst: 0, total_amount: 1180
    },
    items: [{
      product_id: PRODUCT_A, product_name: 'Machine A', hsn_code: '84388090', unit: 'PCS',
      quantity: 1, rate: 1000, discount_percentage: 0, gst_percentage: 18,
      taxable_value: 1000, gst_amount: 180, cgst: 90, sgst: 90, igst: 0, total_amount: 1180
    }]
  });
  assert.strictEqual(ret.status, 200);
  assert.deepStrictEqual(await lineState(id), before,
    'the goods were still received; the return is its own movement');
});
