// Purchase orders through their real HTTP surface.
//
// The rule this whole feature turns on is that an ORDER moves no stock and
// a RECEIPT does, so almost every test here checks a stock balance as well
// as a status.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('purchase orders API (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'po-test-secret';

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

let server, base, db, USER_A, USER_B, TOK_A, TOK_B, VENDOR_A, VENDOR_B, PROD_A, PROD_B;
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
const msg = r => (r && r.body && r.body.error && r.body.error.message) || '';

const stockOf = async (pid) => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [pid])).rows[0].stock);
const movementsOf = async (pid) => (await db.query(
  `SELECT movement_type, direction, quantity, source_type, source_id
     FROM stock_movements WHERE product_id=$1 ORDER BY created_at, id`, [pid])).rows;

function orderBody(over) {
  return Object.assign({
    document_date: '2026-09-01', vendor_id: VENDOR_A, vendor_name: 'Acme Supplies',
    vendor_gstin: '33AAAAA0000A1Z5', state: 'Tamil Nadu', district: 'Coimbatore',
    supply_type: 'intrastate', gst_percentage: 18,
    taxable_amount: 10000, gst_amount: 1800, cgst: 900, sgst: 900, igst: 0,
    total_amount: 11800, payment_terms: '100% Advance', logistics_mode: 'By Transport',
    expected_delivery_date: '2026-09-20', purchase_representative: 'R. Kumar',
    terms: 'Goods to be delivered within the agreed period.'
  }, over || {});
}
function line(over) {
  return Object.assign({
    product_id: PROD_A, product_name: 'Machine A', hsn_code: '84388090', unit: 'PCS',
    quantity: 10, rate: 1000, gst_percentage: 18,
    taxable_value: 10000, gst_amount: 1800, cgst: 900, sgst: 900, igst: 0, total_amount: 11800
  }, over || {});
}
const save = (body, token) => api('POST', '/purchase-orders/save', { token, body });
const receive = (id, body, token) => api('POST', `/purchase-orders/${id}/receive`, { token, body });
const setStatus = (id, status, token) =>
  api('POST', `/purchase-orders/${id}/status`, { token, body: { status } });

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
  USER_A = await mkUser('po-a@scratch.test');
  USER_B = await mkUser('po-b@scratch.test');
  TOK_A = tok(USER_A); TOK_B = tok(USER_B);
  const mkVendor = async (u, n) => (await db.query(
    `INSERT INTO vendors (user_id,name,gstin,state) VALUES ($1,$2,'33AAAAA0000A1Z5','Tamil Nadu') RETURNING id`,
    [u, n])).rows[0].id;
  VENDOR_A = await mkVendor(USER_A, 'Acme Supplies');
  VENDOR_B = await mkVendor(USER_B, 'Other Supplies');
  const mkProduct = async (u, n) => (await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock)
     VALUES ($1,$2,'84388090','PCS',18,0) RETURNING id`, [u, n])).rows[0].id;
  PROD_A = await mkProduct(USER_A, 'Machine A');
  PROD_B = await mkProduct(USER_B, 'Other Machine');

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// ── A. create, number, no stock ───────────────────────────────────────
test('A1 a draft order is created, auto-numbered, and moves NO stock', async () => {
  const before = await stockOf(PROD_A);
  const r = await save({ order: orderBody(), items: [line()] }, TOK_A);
  assert.strictEqual(r.status, 200);
  assert.match(r.body.order.document_number, /^PO-\d{5}$/, 'auto-numbered from its own book');
  assert.strictEqual(r.body.order.status, 'DRAFT');
  assert.strictEqual(r.body.items.length, 1);
  assert.strictEqual(Number(r.body.items[0].received_quantity), 0);
  assert.strictEqual(await stockOf(PROD_A), before, 'creating an order must not move stock');
  assert.strictEqual((await movementsOf(PROD_A)).length, 0, 'and must write no movement');
});

test('A2 the order and its items reload exactly as saved', async () => {
  const created = await save({ order: orderBody(), items: [line({ quantity: 4 })] }, TOK_A);
  const r = await api('GET', `/purchase-orders/${created.body.id}`, { token: TOK_A });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.order.payment_terms, '100% Advance');
  assert.strictEqual(r.body.order.logistics_mode, 'By Transport');
  assert.strictEqual(String(r.body.order.expected_delivery_date).slice(0, 10), '2026-09-20');
  assert.strictEqual(r.body.items[0].hsn_code, '84388090');
  assert.strictEqual(Number(r.body.items[0].pending_quantity), 4);
});

test('A3 a duplicate number is refused, and a blank one too', async () => {
  const first = await save({ order: orderBody({ document_number: 'PO-9001' }), items: [line()] }, TOK_A);
  assert.strictEqual(first.status, 200);
  const dup = await save({ order: orderBody({ document_number: 'po-9001' }), items: [line()] }, TOK_A);
  assert.strictEqual(dup.status, 409, 'case-insensitively duplicate');
  assert.strictEqual(msg(dup), 'Purchase order number already exists.');
  const blank = await save(
    { editId: first.body.id, order: orderBody({ document_number: '  ' }), items: [line()] }, TOK_A);
  assert.strictEqual(blank.status, 400);
});

// ── the mandatory numeric flow ────────────────────────────────────────
test('B1 order 10, receive 6, then 4 — stock follows receipts, never the order', async () => {
  const start = await stockOf(PROD_A);
  const po = await save({ order: orderBody(), items: [line({ quantity: 10 })] }, TOK_A);
  const id = po.body.id;
  assert.strictEqual(await stockOf(PROD_A), start, 'ordered: stock unchanged');

  await setStatus(id, 'CONFIRMED', TOK_A);
  const itemId = po.body.items[0].id;

  const r1 = await receive(id, {
    purchase_number: 'PUR-B1-1', purchase_date: '2026-09-05',
    lines: [{ item_id: itemId, quantity: 6 }]
  }, TOK_A);
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r1.body.status, 'PARTIALLY_RECEIVED');
  assert.strictEqual(await stockOf(PROD_A), start + 6, 'received 6: stock +6');

  let view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  assert.strictEqual(Number(view.body.items[0].quantity), 10, 'ordered');
  assert.strictEqual(Number(view.body.items[0].received_quantity), 6, 'received');
  assert.strictEqual(Number(view.body.items[0].pending_quantity), 4, 'pending');

  const r2 = await receive(id, {
    purchase_number: 'PUR-B1-2', purchase_date: '2026-09-09',
    lines: [{ item_id: itemId, quantity: 4 }]
  }, TOK_A);
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.body.status, 'FULLY_RECEIVED');
  assert.strictEqual(await stockOf(PROD_A), start + 10, 'received the rest: stock +10 in total');

  view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  assert.strictEqual(Number(view.body.items[0].received_quantity), 10);
  assert.strictEqual(Number(view.body.items[0].pending_quantity), 0);
  assert.strictEqual(view.body.order.status, 'FULLY_RECEIVED');
});

test('B2 three receipts of 3, 2 and 5 land exactly, and only then is it full', async () => {
  const start = await stockOf(PROD_A);
  const po = await save({ order: orderBody(), items: [line({ quantity: 10 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);

  const steps = [[3, 7, 'PARTIALLY_RECEIVED'], [2, 5, 'PARTIALLY_RECEIVED'], [5, 0, 'FULLY_RECEIVED']];
  let got = 0;
  for (const [qty, pending, status] of steps) {
    const r = await receive(id, {
      purchase_number: `PUR-B2-${qty}`, purchase_date: '2026-09-10',
      lines: [{ item_id: itemId, quantity: qty }]
    }, TOK_A);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.status, status);
    got += qty;
    const view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
    assert.strictEqual(Number(view.body.items[0].received_quantity), got);
    assert.strictEqual(Number(view.body.items[0].pending_quantity), pending);
  }
  assert.strictEqual(await stockOf(PROD_A), start + 10);
});

test('B3 over-receipt is refused, and leaves no purchase, movement or change', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 10 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  await receive(id, { purchase_number: 'PUR-B3-1', purchase_date: '2026-09-10',
    lines: [{ item_id: itemId, quantity: 10 }] }, TOK_A);

  const stockBefore = await stockOf(PROD_A);
  const movesBefore = (await movementsOf(PROD_A)).length;
  const purchasesBefore = Number((await db.query(
    'SELECT COUNT(*)::int n FROM purchases WHERE user_id=$1', [USER_A])).rows[0].n);

  const over = await receive(id, { purchase_number: 'PUR-B3-OVER', purchase_date: '2026-09-11',
    lines: [{ item_id: itemId, quantity: 1 }] }, TOK_A);
  assert.strictEqual(over.status, 409);
  assert.match(msg(over), /cannot receive goods|left to receive/,
    'refused either by the status gate or by the remainder — both are correct');

  assert.strictEqual(await stockOf(PROD_A), stockBefore, 'stock unchanged');
  assert.strictEqual((await movementsOf(PROD_A)).length, movesBefore, 'no movement written');
  assert.strictEqual(Number((await db.query(
    'SELECT COUNT(*)::int n FROM purchases WHERE user_id=$1', [USER_A])).rows[0].n),
  purchasesBefore, 'no purchase written');
});

test('B4 a receipt beyond the remainder in one call is refused whole', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 5 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  const stockBefore = await stockOf(PROD_A);
  const r = await receive(id, { purchase_number: 'PUR-B4', purchase_date: '2026-09-10',
    lines: [{ item_id: itemId, quantity: 6 }] }, TOK_A);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(await stockOf(PROD_A), stockBefore);
});

// ── the purchase it creates ───────────────────────────────────────────
test('C1 the receipt writes a real purchase that points back at the order', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 2 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  const r = await receive(id, { purchase_number: 'PUR-C1', purchase_date: '2026-09-12',
    lines: [{ item_id: itemId, quantity: 2 }] }, TOK_A);

  const { rows } = await db.query(
    'SELECT * FROM purchases WHERE id=$1 AND user_id=$2', [r.body.purchase_id, USER_A]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].purchase_order_id, id, 'the purchase references its order');
  assert.strictEqual(rows[0].vendor_name, 'Acme Supplies', 'vendor carried over');
  assert.strictEqual(rows[0].purchase_number, 'PUR-C1');
  assert.strictEqual(Number(rows[0].taxable_amount), 2000);
  assert.strictEqual(Number(rows[0].cgst), 180);
  assert.strictEqual(Number(rows[0].sgst), 180);
  assert.strictEqual(Number(rows[0].total_amount), 2360);

  const { rows: pi } = await db.query(
    'SELECT * FROM purchase_items WHERE purchase_id=$1', [r.body.purchase_id]);
  assert.strictEqual(pi.length, 1);
  assert.strictEqual(pi[0].hsn_code, '84388090', 'HSN carried over');
  assert.strictEqual(pi[0].unit, 'PCS', 'unit carried over');
  assert.strictEqual(Number(pi[0].gst_percentage), 18, 'GST carried over');
});

test('C2 the stock movement is a PURCHASE sourced to the purchase, not the order', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 3 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  const r = await receive(id, { purchase_number: 'PUR-C2', purchase_date: '2026-09-13',
    lines: [{ item_id: itemId, quantity: 3 }] }, TOK_A);

  const { rows } = await db.query(
    `SELECT * FROM stock_movements WHERE source_id=$1 AND user_id=$2`, [r.body.purchase_id, USER_A]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].movement_type, 'PURCHASE');
  assert.strictEqual(rows[0].direction, 'IN');
  assert.strictEqual(Number(rows[0].quantity), 3);
  assert.strictEqual(rows[0].source_type, 'purchase', 'sourced to the purchase');
  assert.notStrictEqual(rows[0].source_id, id, 'never to the order itself');
  // It landed in the tenant's default location, like any other purchase.
  const { rows: loc } = await db.query(
    'SELECT is_default FROM stock_locations WHERE id=$1', [rows[0].location_id]);
  if (loc.length) assert.strictEqual(loc[0].is_default, true, 'default location');
});

// ── editing ───────────────────────────────────────────────────────────
test('D1 editing updates the same order and keeps received quantities', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 10 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  await receive(id, { purchase_number: 'PUR-D1', purchase_date: '2026-09-14',
    lines: [{ item_id: itemId, quantity: 6 }] }, TOK_A);

  const edited = await save({
    editId: id,
    order: orderBody({ document_number: po.body.order.document_number, purchase_representative: 'S. Devi' }),
    items: [{ ...line({ quantity: 12 }), id: itemId }]
  }, TOK_A);
  assert.strictEqual(edited.status, 200);
  assert.strictEqual(edited.body.id, id, 'same record');
  assert.strictEqual(edited.body.order.purchase_representative, 'S. Devi');
  assert.strictEqual(Number(edited.body.items[0].received_quantity), 6, 'received survived the edit');
  assert.strictEqual(Number(edited.body.items[0].quantity), 12);
  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM purchase_orders WHERE user_id=$1 AND document_number=$2',
    [USER_A, po.body.order.document_number]);
  assert.strictEqual(rows[0].n, 1, 'no duplicate order row');
});

test('D2 ordering down below what already arrived is refused', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 10 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  await receive(id, { purchase_number: 'PUR-D2', purchase_date: '2026-09-15',
    lines: [{ item_id: itemId, quantity: 6 }] }, TOK_A);

  const r = await save({
    editId: id, order: orderBody({ document_number: po.body.order.document_number }),
    items: [{ ...line({ quantity: 5 }), id: itemId }]
  }, TOK_A);
  assert.strictEqual(r.status, 409);
  assert.match(msg(r), /already has 6 received/);
  const view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  assert.strictEqual(Number(view.body.items[0].quantity), 10, 'the order is unchanged');
});

test('D3 a received line cannot be deleted off the order', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 4 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  await receive(id, { purchase_number: 'PUR-D3', purchase_date: '2026-09-15',
    lines: [{ item_id: itemId, quantity: 1 }] }, TOK_A);
  const r = await save({
    editId: id, order: orderBody({ document_number: po.body.order.document_number }),
    items: [line({ product_id: PROD_A, product_name: 'Machine A', quantity: 2 })]
  }, TOK_A);
  assert.strictEqual(r.status, 409);
  assert.match(msg(r), /already been received cannot be removed/);
});

test('D4 ordering more of a fully received line reopens the order', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 2 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  await receive(id, { purchase_number: 'PUR-D4', purchase_date: '2026-09-16',
    lines: [{ item_id: itemId, quantity: 2 }] }, TOK_A);
  let view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  assert.strictEqual(view.body.order.status, 'FULLY_RECEIVED');

  const r = await save({
    editId: id, order: orderBody({ document_number: po.body.order.document_number }),
    items: [{ ...line({ quantity: 5 }), id: itemId }]
  }, TOK_A);
  assert.strictEqual(r.status, 200);
  view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  assert.strictEqual(view.body.order.status, 'PARTIALLY_RECEIVED', 'reopened');
  assert.strictEqual(Number(view.body.items[0].pending_quantity), 3);
});

// ── status ────────────────────────────────────────────────────────────
test('E1 status moves only along the allowed path', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 1 })] }, TOK_A);
  const id = po.body.id;
  assert.strictEqual((await setStatus(id, 'SENT', TOK_A)).status, 200);
  assert.strictEqual((await setStatus(id, 'CONFIRMED', TOK_A)).status, 200);
  const back = await setStatus(id, 'DRAFT', TOK_A);
  assert.strictEqual(back.status, 409, 'a confirmed order cannot go back to draft');
  assert.strictEqual((await setStatus(id, 'CLOSED', TOK_A)).status, 200);
  assert.strictEqual((await setStatus(id, 'CANCELLED', TOK_A)).status, 409, 'closed is final');
});

test('E2 cancelling a draft records why, and moves no stock', async () => {
  const start = await stockOf(PROD_A);
  const po = await save({ order: orderBody(), items: [line({ quantity: 5 })] }, TOK_A);
  const r = await api('POST', `/purchase-orders/${po.body.id}/status`,
    { token: TOK_A, body: { status: 'CANCELLED', reason: 'Ordered in error' } });
  assert.strictEqual(r.status, 200);
  const { rows } = await db.query('SELECT * FROM purchase_orders WHERE id=$1', [po.body.id]);
  assert.strictEqual(rows[0].status, 'CANCELLED');
  assert.strictEqual(rows[0].cancel_reason, 'Ordered in error');
  assert.strictEqual(rows[0].cancelled_by, USER_A);
  assert.ok(rows[0].cancelled_at);
  assert.strictEqual(await stockOf(PROD_A), start, 'cancelling moves no stock');
});

test('E3 a partially received order cannot be cancelled, only closed', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 10 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CONFIRMED', TOK_A);
  await receive(id, { purchase_number: 'PUR-E3', purchase_date: '2026-09-17',
    lines: [{ item_id: itemId, quantity: 4 }] }, TOK_A);
  assert.strictEqual((await setStatus(id, 'CANCELLED', TOK_A)).status, 409,
    'cancelling would deny receipts that really happened');
  assert.strictEqual((await setStatus(id, 'CLOSED', TOK_A)).status, 200);
  // The receipt and its stock survive being closed short.
  const view = await api('GET', `/purchase-orders/${id}`, { token: TOK_A });
  assert.strictEqual(Number(view.body.items[0].received_quantity), 4);
});

test('E4 a cancelled order cannot receive goods', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 3 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  await setStatus(id, 'CANCELLED', TOK_A);
  const stockBefore = await stockOf(PROD_A);
  const r = await receive(id, { purchase_number: 'PUR-E4', purchase_date: '2026-09-18',
    lines: [{ item_id: itemId, quantity: 1 }] }, TOK_A);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(await stockOf(PROD_A), stockBefore);
});

// ── security ──────────────────────────────────────────────────────────
test('F1 every route refuses an unauthenticated caller', async () => {
  assert.strictEqual((await api('GET', '/purchase-orders')).status, 401);
  assert.strictEqual((await api('GET', '/purchase-orders/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12))).status, 401);
  assert.strictEqual((await api('POST', '/purchase-orders/save', { body: {} })).status, 401);
  assert.strictEqual((await api('POST', '/purchase-orders/x/status', { body: {} })).status, 401);
  assert.strictEqual((await api('POST', '/purchase-orders/x/receive', { body: {} })).status, 401);
});

test('F2 one tenant cannot read, edit, receive or cancel another tenant order', async () => {
  const po = await save({ order: orderBody(), items: [line({ quantity: 5 })] }, TOK_A);
  const id = po.body.id, itemId = po.body.items[0].id;
  assert.strictEqual((await api('GET', `/purchase-orders/${id}`, { token: TOK_B })).status, 404);
  assert.strictEqual((await save({ editId: id, order: orderBody({ vendor_id: VENDOR_B, vendor_name: 'Other Supplies' }), items: [line({ product_id: PROD_B, product_name: 'Other Machine' })] }, TOK_B)).status, 404);
  assert.strictEqual((await receive(id, { purchase_number: 'X', purchase_date: '2026-09-19',
    lines: [{ item_id: itemId, quantity: 1 }] }, TOK_B)).status, 404);
  assert.strictEqual((await setStatus(id, 'CANCELLED', TOK_B)).status, 404);
});

test('F3 an order cannot be placed with another tenant vendor or product', async () => {
  const badVendor = await save(
    { order: orderBody({ vendor_id: VENDOR_B }), items: [line()] }, TOK_A);
  assert.strictEqual(badVendor.status, 404);
  const badProduct = await save(
    { order: orderBody(), items: [line({ product_id: PROD_B })] }, TOK_A);
  assert.strictEqual(badProduct.status, 404);
});

test('F4 the list is scoped to the caller and rejects rubbish filters', async () => {
  const a = await api('GET', '/purchase-orders?limit=200', { token: TOK_A });
  assert.strictEqual(a.status, 200);
  assert.ok(a.body.total > 0);
  const b = await api('GET', '/purchase-orders', { token: TOK_B });
  assert.strictEqual(b.body.total, 0, 'tenant B has none of its own');
  for (const bad of ['status=NONSENSE', 'from=2026-13-45', 'vendor_id=not-a-uuid']) {
    assert.strictEqual((await api('GET', '/purchase-orders?' + bad, { token: TOK_A })).status, 400, bad);
  }
  const inj = await api('GET',
    "/purchase-orders?q=" + encodeURIComponent("'; DROP TABLE purchase_orders; --"), { token: TOK_A });
  assert.strictEqual(inj.status, 200, 'a quote in a search box is just text');
  const { rows } = await db.query("SELECT to_regclass('purchase_orders') t");
  assert.ok(rows[0].t, 'the table is still there');
});

// ── validation ────────────────────────────────────────────────────────
test('G1 an order needs a vendor, a date, and lines with real quantities', async () => {
  assert.strictEqual((await save({ order: orderBody({ vendor_name: '' }), items: [line()] }, TOK_A)).status, 400);
  assert.strictEqual((await save({ order: orderBody({ document_date: '' }), items: [line()] }, TOK_A)).status, 400);
  assert.strictEqual((await save({ order: orderBody(), items: [] }, TOK_A)).status, 400);
  assert.strictEqual((await save({ order: orderBody(), items: [line({ quantity: 0 })] }, TOK_A)).status, 400);
  assert.strictEqual((await save({ order: orderBody(), items: [line({ quantity: -3 })] }, TOK_A)).status, 400);
  const early = await save(
    { order: orderBody({ expected_delivery_date: '2026-08-01' }), items: [line()] }, TOK_A);
  assert.strictEqual(early.status, 400, 'delivery cannot precede the order');
});

test('G2 status and received_quantity cannot be set through a save', async () => {
  const po = await save({
    order: orderBody({ status: 'FULLY_RECEIVED' }),
    items: [line({ quantity: 5, received_quantity: 5 })]
  }, TOK_A);
  assert.strictEqual(po.status, 200);
  assert.strictEqual(po.body.order.status, 'DRAFT', 'status is not a field a save can set');
  assert.strictEqual(Number(po.body.items[0].received_quantity), 0,
    'received quantity moves only when goods actually arrive');
});
