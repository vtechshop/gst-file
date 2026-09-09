// Editing a purchase that was raised against a purchase order.
//
// The edit path deletes and re-inserts a purchase's line items, so the two
// things this file exists to prove are that the exact order-line link
// SURVIVES that, and that the order's ordered quantity — not the
// purchase's own previous figure — is what an edit is measured against.
//
// Every order here puts the same product on TWO lines, because that is the
// shape where "which line did this receipt fill" cannot be answered by
// looking at the product.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('purchase order edit link (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'po-edit-secret';

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
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = 'Bearer ' + (token || TOKEN);
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
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

// An order with Product A on TWO separate lines.
async function twoLineOrder(q1 = 5, q2 = 5) {
  const po = await api('POST', '/purchase-orders/save', {
    order: {
      document_date: '2026-09-01', vendor_id: VENDOR, vendor_name: 'Acme Supplies',
      state: 'Tamil Nadu', supply_type: 'intrastate', gst_percentage: 18,
      taxable_amount: 0, gst_amount: 0, cgst: 0, sgst: 0, igst: 0, total_amount: 0
    },
    items: [line(PRODUCT_A, 'Machine A', q1), line(PRODUCT_A, 'Machine A', q2)]
  });
  assert.strictEqual(po.status, 200, 'two lines of one product is a legitimate order');
  await api('POST', `/purchase-orders/${po.body.id}/status`, { status: 'CONFIRMED' });
  return { id: po.body.id, l1: po.body.items[0].id, l2: po.body.items[1].id };
}
const receive = (id, lines, number, token) => api('POST', `/purchase-orders/${id}/receive`,
  { purchase_number: number, purchase_date: '2026-09-10', lines }, token);
const del = (purchaseId, token) =>
  api('POST', `/purchases/purchase/${purchaseId}/cascade-delete`, undefined, token);

// Re-saving a purchase the way the purchase screen does: the whole header
// and the whole set of lines, every time.
const edit = (purchaseId, items, token, number) => api('POST', '/purchases/purchase/save-with-items', {
  editId: purchaseId,
  header: {
    vendor_name: 'Acme Supplies', purchase_number: number || 'PUR-EDIT',
    purchase_date: '2026-09-10', taxable_amount: 0, gst_percentage: 18,
    gst_amount: 0, total_amount: 0, supply_type: 'intrastate', cgst: 0, sgst: 0, igst: 0
  },
  items
  // `null` means "no Authorization header at all" to api(); an edit always
  // wants the default token when a caller does not name one.
}, token || undefined);

// Per-line received and pending, in line order.
async function lineState(id) {
  const r = await api('GET', `/purchase-orders/${id}`);
  return {
    status: r.body.order.status,
    lines: r.body.items.map(i => ({
      received: Number(i.received_quantity), pending: Number(i.pending_quantity)
    })),
    received: r.body.items.reduce((s, i) => s + Number(i.received_quantity), 0)
  };
}
const rowsOf = async (purchaseId) => (await db.query(
  `SELECT quantity::float AS quantity, purchase_order_item_id
     FROM purchase_items WHERE purchase_id=$1 ORDER BY sort_order`, [purchaseId])).rows;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('edit@scratch.test','x') RETURNING id`)).rows[0].id;
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

test('E1 the order line link survives an edit', async () => {
  const { id, l2 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l2, quantity: 1 }], 'PUR-E1');
  const before = await rowsOf(r.body.purchase_id);
  assert.strictEqual(before[0].purchase_order_item_id, l2);

  const ok = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 2), purchase_order_item_id: l2 }], null, 'PUR-E1');
  assert.strictEqual(ok.status, 200, msg(ok));

  const after = await rowsOf(r.body.purchase_id);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].purchase_order_item_id, l2,
    'the row was deleted and re-inserted — the link has to come back with it');
  assert.strictEqual(after[0].quantity, 2);
});

test('E2 editing up, within the line capacity', async () => {
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-E2');
  assert.strictEqual(await stockOf(), start + 4);

  const ok = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l1 }], null, 'PUR-E2');
  assert.strictEqual(ok.status, 200, msg(ok));

  const st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 0, pending: 5 }]);
  assert.strictEqual(await stockOf(), start + 5, 'stock moved by the difference, not the whole quantity');
});

test('E3 editing beyond the line capacity is refused', async () => {
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-E3');
  const before = await lineState(id);

  const over = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 6), purchase_order_item_id: l1 }], null, 'PUR-E3');
  assert.strictEqual(over.status, 409, msg(over));
  assert.match(msg(over), /only 5 left to receive/);

  assert.deepStrictEqual(await lineState(id), before, 'the order is exactly as it was');
  assert.strictEqual(await stockOf(), start + 4, 'and so is the stock');
  const rows = await rowsOf(r.body.purchase_id);
  assert.strictEqual(rows[0].quantity, 4, 'and so is the purchase');
});

test('E4 editing down gives the difference back to the line', async () => {
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder(10, 5);
  const r = await receive(id, [{ item_id: l1, quantity: 6 }], 'PUR-E4');

  const ok = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 4), purchase_order_item_id: l1 }], null, 'PUR-E4');
  assert.strictEqual(ok.status, 200, msg(ok));

  const st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 4, pending: 6 }, { received: 0, pending: 5 }]);
  assert.strictEqual(await stockOf(), start + 4, 'two came back out of stock');
});

test('E5 capacity counts the OTHER receipts, never this one twice', async () => {
  // Ordered 10. Purchase A took 4, purchase B took 3. Editing B, the room
  // is 10 - 4 = 6 — B's own 3 must not be counted against it.
  const { id, l1 } = await twoLineOrder(10, 5);
  await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-E5-A');
  const b = await receive(id, [{ item_id: l1, quantity: 3 }], 'PUR-E5-B');

  const toSix = await edit(b.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 6), purchase_order_item_id: l1 }], null, 'PUR-E5-B');
  assert.strictEqual(toSix.status, 200, '3 -> 6 fits in the remaining 6: ' + msg(toSix));
  assert.deepStrictEqual((await lineState(id)).lines[0], { received: 10, pending: 0 });

  const toSeven = await edit(b.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 7), purchase_order_item_id: l1 }], null, 'PUR-E5-B');
  assert.strictEqual(toSeven.status, 409, '3 -> 7 does not: ' + msg(toSeven));
  assert.deepStrictEqual((await lineState(id)).lines[0], { received: 10, pending: 0 },
    'the refused edit left the line where the accepted one put it');
});

test('E6 one line cannot borrow the other line capacity', async () => {
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-E6');

  // Line 1 has 1 left. Line 2 has all 5 free, but that is line 2's.
  const over = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 6), purchase_order_item_id: l1 }], null, 'PUR-E6');
  assert.strictEqual(over.status, 409, msg(over));
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 4, pending: 1 }, { received: 0, pending: 5 }]);
});

test('E7 each line of one purchase is measured against its own order line', async () => {
  const { id, l1, l2 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 3 }, { item_id: l2, quantity: 2 }], 'PUR-E7');

  // 5 and 5 is exactly both lines, and fits.
  const ok = await edit(r.body.purchase_id, [
    { ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l1 },
    { ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l2 }
  ], null, 'PUR-E7');
  assert.strictEqual(ok.status, 200, msg(ok));
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 5, pending: 0 }, { received: 5, pending: 0 }]);

  // 6 and 4 is the same total of 10 but line 1 alone is over.
  const lopsided = await edit(r.body.purchase_id, [
    { ...line(PRODUCT_A, 'Machine A', 6), purchase_order_item_id: l1 },
    { ...line(PRODUCT_A, 'Machine A', 4), purchase_order_item_id: l2 }
  ], null, 'PUR-E7');
  assert.strictEqual(lopsided.status, 409, 'the total fitting is not the test: ' + msg(lopsided));
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 5, pending: 0 }, { received: 5, pending: 0 }]);
});

test('E8 two lines of one purchase pointing at ONE order line are summed', async () => {
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 1 }], 'PUR-E8');

  // 3 + 3 against a line of 5. Neither half exceeds it; together they do.
  const split = await edit(r.body.purchase_id, [
    { ...line(PRODUCT_A, 'Machine A', 3), purchase_order_item_id: l1 },
    { ...line(PRODUCT_A, 'Machine A', 3), purchase_order_item_id: l1 }
  ], null, 'PUR-E8');
  assert.strictEqual(split.status, 409, 'a quantity split in two is still that quantity: ' + msg(split));
  assert.deepStrictEqual((await lineState(id)).lines[0], { received: 1, pending: 4 });
});

test('E9 edit then delete reverses the exact order line', async () => {
  const start = await stockOf();
  const { id, l1, l2 } = await twoLineOrder();
  await receive(id, [{ item_id: l1, quantity: 3 }], 'PUR-E9-1');
  const r2 = await receive(id, [{ item_id: l2, quantity: 1 }], 'PUR-E9-2');
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 3, pending: 2 }, { received: 1, pending: 4 }]);

  const ok = await edit(r2.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 2), purchase_order_item_id: l2 }], null, 'PUR-E9-2');
  assert.strictEqual(ok.status, 200, msg(ok));
  assert.strictEqual((await rowsOf(r2.body.purchase_id))[0].purchase_order_item_id, l2);
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 3, pending: 2 }, { received: 2, pending: 3 }]);
  assert.strictEqual(await stockOf(), start + 5);

  await del(r2.body.purchase_id);
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 3, pending: 2 }, { received: 0, pending: 5 }],
    'the edited quantity came off line 2, and line 1 was not touched');
  assert.strictEqual(await stockOf(), start + 3, 'stock back to before that receipt');
});

test('E10 an edit that changes nothing changes nothing', async () => {
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 1 }], 'PUR-E10');
  const before = await lineState(id);

  const ok = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 1), purchase_order_item_id: l1 }], null, 'PUR-E10');
  assert.strictEqual(ok.status, 200, msg(ok));
  assert.deepStrictEqual(await lineState(id), before);
  assert.strictEqual(await stockOf(), start + 1);
  assert.strictEqual((await rowsOf(r.body.purchase_id))[0].purchase_order_item_id, l1);
});

test('E11 an ordinary purchase still saves and edits, with no link', async () => {
  const start = await stockOf();
  const made = await api('POST', '/purchases/purchase/save-with-items', {
    header: {
      vendor_name: 'Acme Supplies', purchase_number: 'PUR-E11', purchase_date: '2026-09-11',
      taxable_amount: 2000, gst_percentage: 18, gst_amount: 360, total_amount: 2360,
      supply_type: 'intrastate', cgst: 180, sgst: 180, igst: 0
    },
    items: [line(PRODUCT_B, 'Machine B', 2)]
  });
  assert.strictEqual(made.status, 200, msg(made));
  const row = (await db.query(
    `SELECT p.purchase_order_id, i.purchase_order_item_id
       FROM purchases p JOIN purchase_items i ON i.purchase_id = p.id WHERE p.id = $1`,
    [made.body.id])).rows[0];
  assert.strictEqual(row.purchase_order_id, null);
  assert.strictEqual(row.purchase_order_item_id, null);

  const ok = await edit(made.body.id, [line(PRODUCT_B, 'Machine B', 3)], null, 'PUR-E11');
  assert.strictEqual(ok.status, 200, 'a purchase with no order edits as it always did: ' + msg(ok));
  assert.strictEqual(Number((await db.query(
    'SELECT stock FROM products WHERE id=$1', [PRODUCT_B])).rows[0].stock), 3);
  assert.strictEqual(await stockOf(), start, 'and product A was not involved');
});

test('E12 a line claiming an order line on a purchase with no order is refused', async () => {
  const { l1 } = await twoLineOrder();
  const made = await api('POST', '/purchases/purchase/save-with-items', {
    header: {
      vendor_name: 'Acme Supplies', purchase_number: 'PUR-E12', purchase_date: '2026-09-11',
      taxable_amount: 1000, gst_percentage: 18, gst_amount: 180, total_amount: 1180,
      supply_type: 'intrastate', cgst: 90, sgst: 90, igst: 0
    },
    items: [{ ...line(PRODUCT_A, 'Machine A', 1), purchase_order_item_id: l1 }]
  });
  assert.strictEqual(made.status, 400, msg(made));
  assert.match(msg(made), /not raised against a purchase order/);
});

test('E13 a nonsense or foreign order line id is refused', async () => {
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 1 }], 'PUR-E13');
  const before = await lineState(id);

  // A line of a DIFFERENT order.
  const other = await twoLineOrder();
  const foreign = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 1), purchase_order_item_id: other.l1 }], null, 'PUR-E13');
  assert.strictEqual(foreign.status, 404, msg(foreign));

  // A well-formed id that is not a line at all.
  const missing = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 1), purchase_order_item_id: '00000000-0000-4000-8000-000000000000' }],
    null, 'PUR-E13');
  assert.strictEqual(missing.status, 404, msg(missing));

  // And dropping the link entirely, rather than being matched back by product.
  const unlinked = await edit(r.body.purchase_id,
    [line(PRODUCT_A, 'Machine A', 1)], null, 'PUR-E13');
  assert.strictEqual(unlinked.status, 400, msg(unlinked));
  assert.match(msg(unlinked), /must say which order line/);

  assert.deepStrictEqual(await lineState(id), before, 'none of that touched the order');
});

test('E14 an order line from another tenant is refused', async () => {
  const other = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('edit-b@scratch.test','x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Other Co')`, [other]);
  await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'B Warehouse','BMAIN',TRUE,TRUE)`, [other]);
  const otherToken = tok(other);

  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 1 }], 'PUR-E14');
  const before = await lineState(id);

  // The other tenant cannot even see the purchase, let alone re-point it.
  const theirs = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 1), purchase_order_item_id: l1 }], otherToken, 'PUR-E14');
  assert.strictEqual(theirs.status, 404, msg(theirs));
  assert.deepStrictEqual(await lineState(id), before);
});

test('E15 two simultaneous edits cannot both take the same remaining capacity', async () => {
  // Ordered 10, another purchase holds 4, this one holds 3. Room is 6.
  const start = await stockOf();
  const { id, l1 } = await twoLineOrder(10, 5);
  await receive(id, [{ item_id: l1, quantity: 4 }], 'PUR-E15-A');
  const b = await receive(id, [{ item_id: l1, quantity: 3 }], 'PUR-E15-B');
  assert.strictEqual(await stockOf(), start + 7);

  const [toSix, toSeven] = await Promise.all([
    edit(b.body.purchase_id,
      [{ ...line(PRODUCT_A, 'Machine A', 6), purchase_order_item_id: l1 }], null, 'PUR-E15-B'),
    edit(b.body.purchase_id,
      [{ ...line(PRODUCT_A, 'Machine A', 7), purchase_order_item_id: l1 }], null, 'PUR-E15-B')
  ]);
  // 7 can never be right; 6 may or may not have been applied depending on
  // which went first, but the line must never exceed what was ordered.
  assert.strictEqual(toSeven.status, 409, 'seven never fits: ' + msg(toSeven));
  assert.ok(toSix.status === 200 || toSix.status === 409, 'six either applied or queued and failed');

  const st = await lineState(id);
  assert.ok(st.lines[0].received <= 10, 'never more than ordered');
  assert.ok(st.lines[0].pending >= 0, 'and never a negative pending');
  assert.strictEqual(st.lines[0].received, 4 + Number((await rowsOf(b.body.purchase_id))[0].quantity),
    'the line holds exactly the other purchase plus whatever this one now says');
});

test('E16 the mandatory numeric flow', async () => {
  const start = await stockOf();
  const { id, l1, l2 } = await twoLineOrder();

  await receive(id, [{ item_id: l1, quantity: 3 }], 'PUR-E16-1');
  const r2 = await receive(id, [{ item_id: l2, quantity: 1 }], 'PUR-E16-2');
  let st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 3, pending: 2 }, { received: 1, pending: 4 }]);
  assert.strictEqual(st.status, 'PARTIALLY_RECEIVED');

  // Receipt 1: 3 -> 5.
  const r1id = (await db.query(
    `SELECT id FROM purchases WHERE user_id=$1 AND purchase_number='PUR-E16-1'`, [USER])).rows[0].id;
  const up = await edit(r1id,
    [{ ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l1 }], null, 'PUR-E16-1');
  assert.strictEqual(up.status, 200, msg(up));
  st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 1, pending: 4 }]);
  assert.strictEqual(await stockOf(), start + 6);

  // 5 -> 6 on a line of 5, with line 2 sitting on four free. Still no.
  const over = await edit(r1id,
    [{ ...line(PRODUCT_A, 'Machine A', 6), purchase_order_item_id: l1 }], null, 'PUR-E16-1');
  assert.strictEqual(over.status, 409, msg(over));
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 5, pending: 0 }, { received: 1, pending: 4 }]);

  // Delete the edited purchase: line 1 empties, line 2 is untouched.
  await del(r1id);
  st = await lineState(id);
  assert.deepStrictEqual(st.lines, [{ received: 0, pending: 5 }, { received: 1, pending: 4 }]);
  assert.strictEqual(st.status, 'PARTIALLY_RECEIVED');
  assert.strictEqual(await stockOf(), start + 1, 'exactly the deleted quantity came back out');
  void r2;
});

test('E17 the order status follows the edited quantities', async () => {
  const { id, l1, l2 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 5 }, { item_id: l2, quantity: 5 }], 'PUR-E17');
  assert.strictEqual((await lineState(id)).status, 'FULLY_RECEIVED');

  // Editing one line down reopens the order.
  const down = await edit(r.body.purchase_id, [
    { ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l1 },
    { ...line(PRODUCT_A, 'Machine A', 3), purchase_order_item_id: l2 }
  ], null, 'PUR-E17');
  assert.strictEqual(down.status, 200, msg(down));
  let st = await lineState(id);
  assert.strictEqual(st.status, 'PARTIALLY_RECEIVED');
  assert.deepStrictEqual(st.lines, [{ received: 5, pending: 0 }, { received: 3, pending: 2 }]);

  // And back up again closes it.
  const upAgain = await edit(r.body.purchase_id, [
    { ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l1 },
    { ...line(PRODUCT_A, 'Machine A', 5), purchase_order_item_id: l2 }
  ], null, 'PUR-E17');
  assert.strictEqual(upAgain.status, 200, msg(upAgain));
  st = await lineState(id);
  assert.strictEqual(st.status, 'FULLY_RECEIVED');
  assert.strictEqual(st.received, 10);
});

test('E18 dropping a line gives that line its quantity back', async () => {
  const { id, l1, l2 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 3 }, { item_id: l2, quantity: 2 }], 'PUR-E18');

  // The purchase is re-saved mentioning only line 1.
  const ok = await edit(r.body.purchase_id,
    [{ ...line(PRODUCT_A, 'Machine A', 3), purchase_order_item_id: l1 }], null, 'PUR-E18');
  assert.strictEqual(ok.status, 200, msg(ok));
  assert.deepStrictEqual((await lineState(id)).lines,
    [{ received: 3, pending: 2 }, { received: 0, pending: 5 }],
    'line 2 stopped being claimed and went back to empty');
});

test('E19 the link cannot be set through the generic purchase_items route', async () => {
  const { id, l1 } = await twoLineOrder();
  const r = await receive(id, [{ item_id: l1, quantity: 1 }], 'PUR-E19');
  const rows = await rowsOf(r.body.purchase_id);

  const patched = await api('PATCH', `/purchase_items?eq_id=${rows[0] && ''}`, {
    purchase_order_item_id: l1
  });
  assert.strictEqual(patched.status, 400, 'the generic route refuses it loudly');
  assert.match(msg(patched), /cannot be set directly/);

  const inserted = await api('POST', '/purchase_items', {
    purchase_id: r.body.purchase_id, product_name: 'Machine A', quantity: 1,
    purchase_order_item_id: l1
  });
  assert.strictEqual(inserted.status, 400, 'and on insert too');
});
