// The two returns, and what they do to a unit.
//
// A customer's return and a supplier's return are different facts about
// the same goods and must not share a state. A customer return brings a
// unit back onto the premises, unsellable until somebody inspects it. A
// supplier return sends it away for good.
//
// Both are driven by their own DOCUMENT: nobody should have to call a
// status endpoint afterwards to make the inventory true, and a document
// that moved the quantity but left the units alone would leave the two
// accounts of the same goods disagreeing.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('serial returns (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'serial-returns-secret';

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

async function mkProduct(userId, name, { serial = true } = {}) {
  const { rows } = await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock,serial_tracking)
     VALUES ($1,$2,'84388090','PCS',18,0,$3) RETURNING id`, [userId, name, serial]);
  return rows[0].id;
}
const statusOf = async (userId, serial) => {
  const { rows } = await db.query(
    'SELECT status FROM stock_serials WHERE user_id=$1 AND upper(btrim(serial_no))=upper($2)',
    [userId, serial]);
  return rows.length ? rows[0].status : null;
};
const stockOf = async (productId) => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock);
const idOf = async (userId, serial) => (await db.query(
  'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [userId, serial])).rows[0].id;

const purchase = (productId, qty, serials, number, token, editId) =>
  api('POST', '/api/purchases/purchase/save-with-items', {
    token: token || TOKEN_A,
    body: {
      editId,
      header: {
        vendor_name: 'Acme', purchase_number: number, purchase_date: '2026-09-10',
        taxable_amount: 1000 * qty, gst_percentage: 18, gst_amount: 180 * qty,
        total_amount: 1180 * qty, supply_type: 'intrastate', cgst: 90 * qty, sgst: 90 * qty, igst: 0
      },
      items: [{
        product_id: productId, product_name: 'Serialised', hsn_code: '84388090', unit: 'PCS',
        quantity: qty, rate: 1000, gst_percentage: 18, taxable_value: 1000 * qty,
        gst_amount: 180 * qty, cgst: 90 * qty, sgst: 90 * qty, igst: 0,
        total_amount: 1180 * qty, serials
      }]
    }
  });

// A purchase RETURN — goods going back to the supplier.
const supplierReturn = (productId, qty, serials, number, token, editId, originalPurchaseId) =>
  api('POST', '/api/purchases/return/save-with-items', {
    token: token || TOKEN_A,
    body: {
      editId,
      header: {
        vendor_name: 'Acme', return_number: number, return_date: '2026-09-12',
        taxable_amount: 1000 * qty, gst_percentage: 18, gst_amount: 180 * qty,
        total_amount: 1180 * qty, supply_type: 'intrastate', cgst: 90 * qty, sgst: 90 * qty,
        igst: 0, original_purchase_id: originalPurchaseId || null
      },
      items: [{
        product_id: productId, product_name: 'Serialised', hsn_code: '84388090', unit: 'PCS',
        quantity: qty, rate: 1000, gst_percentage: 18, taxable_value: 1000 * qty,
        gst_amount: 180 * qty, cgst: 90 * qty, sgst: 90 * qty, igst: 0,
        total_amount: 1180 * qty, serials
      }]
    }
  });

const sell = (productId, qty, serials, number, token, editId) =>
  api('POST', '/api/invoices/b2c/save-with-items', {
    token: token || TOKEN_A,
    body: {
      editId,
      header: {
        invoice_number: number, invoice_date: '2026-09-11', state: 'Tamil Nadu',
        supply_type: 'intrastate', taxable_amount: 2000 * qty, gst_percentage: 18,
        gst_amount: 360 * qty, total_amount: 2360 * qty, cgst: 180 * qty, sgst: 180 * qty, igst: 0
      },
      items: [{
        product_id: productId, product_name: 'Serialised', hsn_code: '84388090', unit: 'PCS',
        quantity: qty, rate: 2000, gst_percentage: 18, taxable_value: 2000 * qty,
        gst_amount: 360 * qty, cgst: 180 * qty, sgst: 180 * qty, igst: 0,
        total_amount: 2360 * qty, serials
      }]
    }
  });

// A SALES return — a customer bringing goods back.
const salesReturn = (productId, qty, serials, number, invoiceId, token, editId) =>
  api('POST', '/api/sales_returns/save-with-items', {
    token: token || TOKEN_A,
    body: {
      editId,
      header: {
        customer_name: 'Walk-in', return_number: number, return_date: '2026-09-13',
        original_invoice_id: invoiceId, original_invoice_type: 'b2c',
        taxable_amount: 2000 * qty, gst_percentage: 18, gst_amount: 360 * qty,
        total_amount: 2360 * qty, supply_type: 'intrastate',
        cgst: 180 * qty, sgst: 180 * qty, igst: 0
      },
      items: [{
        product_id: productId, product_name: 'Serialised', hsn_code: '84388090', unit: 'PCS',
        quantity: qty, rate: 2000, gst_percentage: 18, taxable_value: 2000 * qty,
        gst_amount: 360 * qty, cgst: 180 * qty, sgst: 180 * qty, igst: 0,
        total_amount: 2360 * qty, serials
      }]
    }
  });

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('ret-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('ret-b@scratch.test','x') RETURNING id`)).rows[0].id;
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

// ── the mandatory numeric flow, end to end ───────────────────────────
test('T1 purchase, sale, customer return, inspection, resale', async () => {
  const p = await mkProduct(USER_A, 'Flow');
  assert.strictEqual((await purchase(p, 3, ['SN001', 'SN002', 'SN003'], 'PUR-T1')).status, 200);
  assert.strictEqual(await stockOf(p), 3);

  const inv = await sell(p, 2, ['SN001', 'SN002'], 'INV-T1');
  assert.strictEqual(inv.status, 200, msg(inv));
  assert.strictEqual(await stockOf(p), 1);
  assert.strictEqual(await statusOf(USER_A, 'SN001'), 'SOLD');
  assert.strictEqual(await statusOf(USER_A, 'SN003'), 'AVAILABLE');

  // The return document itself moves the unit. No separate call.
  const ret = await salesReturn(p, 1, ['SN001'], 'SR-T1', inv.body.invoiceId);
  assert.strictEqual(ret.status, 200, msg(ret));
  assert.strictEqual(await stockOf(p), 2, 'the goods are back');
  assert.strictEqual(await statusOf(USER_A, 'SN001'), 'RETURNED', 'not AVAILABLE');
  assert.strictEqual(await statusOf(USER_A, 'SN002'), 'SOLD', 'the other unit is untouched');
  assert.strictEqual(await statusOf(USER_A, 'SN003'), 'AVAILABLE');

  // Not sellable until somebody has looked at it.
  const early = await sell(p, 1, ['SN001'], 'INV-T1b');
  assert.strictEqual(early.status, 409, msg(early));
  assert.match(msg(early), /returned/i);

  // Inspected and put back.
  const inspect = await api('POST', `/api/stock/serials/${await idOf(USER_A, 'SN001')}/status`,
    { token: TOKEN_A, body: { status: 'AVAILABLE', reason: 'inspected, as new' } });
  assert.strictEqual(inspect.status, 200, msg(inspect));
  assert.strictEqual(await statusOf(USER_A, 'SN001'), 'AVAILABLE');

  const resell = await sell(p, 1, ['SN001'], 'INV-T1c');
  assert.strictEqual(resell.status, 200, 'now it sells: ' + msg(resell));
  assert.strictEqual(await statusOf(USER_A, 'SN001'), 'SOLD');
});

test('T2 inspection can send a returned unit to DAMAGED instead', async () => {
  const p = await mkProduct(USER_A, 'Inspect2');
  await purchase(p, 1, ['SN010'], 'PUR-T2');
  const inv = await sell(p, 1, ['SN010'], 'INV-T2');
  await salesReturn(p, 1, ['SN010'], 'SR-T2', inv.body.invoiceId);
  assert.strictEqual(await statusOf(USER_A, 'SN010'), 'RETURNED');

  const damaged = await api('POST', `/api/stock/serials/${await idOf(USER_A, 'SN010')}/status`,
    { token: TOKEN_A, body: { status: 'DAMAGED', reason: 'screen cracked' } });
  assert.strictEqual(damaged.status, 200, msg(damaged));
  assert.strictEqual(await statusOf(USER_A, 'SN010'), 'DAMAGED');
  assert.strictEqual((await sell(p, 1, ['SN010'], 'INV-T2b')).status, 409, 'and it cannot be sold');
});

// ── customer return validation ───────────────────────────────────────
test('T3 a customer return refuses every unit that is not its own', async () => {
  const p = await mkProduct(USER_A, 'RetGuards');
  const other = await mkProduct(USER_A, 'RetOther');
  await purchase(p, 3, ['SN020', 'SN021', 'SN022'], 'PUR-T3');
  await purchase(other, 1, ['SN023'], 'PUR-T3b');
  const invA = await sell(p, 1, ['SN020'], 'INV-T3a');
  const invB = await sell(p, 1, ['SN021'], 'INV-T3b');

  // A unit sold on a DIFFERENT invoice, even though the product matches.
  const wrongInvoice = await salesReturn(p, 1, ['SN021'], 'SR-T3a', invA.body.invoiceId);
  assert.strictEqual(wrongInvoice.status, 409, msg(wrongInvoice));
  assert.match(msg(wrongInvoice), /not sold on the invoice/);

  // A unit that was never sold at all.
  const notSold = await salesReturn(p, 1, ['SN022'], 'SR-T3b', invA.body.invoiceId);
  assert.strictEqual(notSold.status, 409, msg(notSold));

  // A unit of another product.
  const wrongProduct = await salesReturn(p, 1, ['SN023'], 'SR-T3c', invA.body.invoiceId);
  assert.strictEqual(wrongProduct.status, 409, msg(wrongProduct));

  // Count must equal the returned quantity. The existing quantity guard
  // may catch this first - returning 2 of something only 1 was sold of is
  // already impossible - so either refusal is correct here.
  const mismatch = await salesReturn(p, 2, ['SN020'], 'SR-T3d', invA.body.invoiceId);
  assert.ok(mismatch.status === 409 || mismatch.status === 400,
    'a count mismatch is refused: ' + mismatch.status + ' ' + msg(mismatch));

  // And nothing moved through any of that.
  assert.strictEqual(await statusOf(USER_A, 'SN020'), 'SOLD');
  assert.strictEqual(await statusOf(USER_A, 'SN021'), 'SOLD');
  assert.strictEqual(await statusOf(USER_A, 'SN022'), 'AVAILABLE');
  void invB;
});

test('T4 editing a customer return gives back exactly the unit it dropped', async () => {
  const p = await mkProduct(USER_A, 'RetEdit');
  await purchase(p, 2, ['SN030', 'SN031'], 'PUR-T4');
  const inv = await sell(p, 2, ['SN030', 'SN031'], 'INV-T4');
  const ret = await salesReturn(p, 2, ['SN030', 'SN031'], 'SR-T4', inv.body.invoiceId);
  assert.strictEqual(ret.status, 200, msg(ret));
  assert.strictEqual(await statusOf(USER_A, 'SN030'), 'RETURNED');
  assert.strictEqual(await statusOf(USER_A, 'SN031'), 'RETURNED');

  // Drop SN031 from the return. The line rows are re-created by this save,
  // so an implementation keyed on sales_return_items.id would lose both.
  const edit = await salesReturn(p, 1, ['SN030'], 'SR-T4', inv.body.invoiceId, TOKEN_A, ret.body.id);
  assert.strictEqual(edit.status, 200, msg(edit));
  assert.strictEqual(await statusOf(USER_A, 'SN030'), 'RETURNED', 'still returned');
  assert.strictEqual(await statusOf(USER_A, 'SN031'), 'SOLD', 'back to being sold, exactly that one');
});

// ── supplier returns ─────────────────────────────────────────────────
test('T5 a supplier return sends the exact units away and takes the stock', async () => {
  const p = await mkProduct(USER_A, 'Supplier');
  const pur = await purchase(p, 2, ['SN040', 'SN041'], 'PUR-T5');
  assert.strictEqual(await stockOf(p), 2);

  const ret = await supplierReturn(p, 1, ['SN040'], 'PRET-T5', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(ret.status, 200, msg(ret));
  assert.strictEqual(await stockOf(p), 1, 'the quantity went with it');
  assert.strictEqual(await statusOf(USER_A, 'SN040'), 'RETURNED_TO_SUPPLIER');
  assert.strictEqual(await statusOf(USER_A, 'SN041'), 'AVAILABLE', 'the other unit is untouched');
});

test('T6 a unit returned to the supplier is out of the business for good', async () => {
  const p = await mkProduct(USER_A, 'Gone');
  const pur = await purchase(p, 1, ['SN050'], 'PUR-T6');
  await supplierReturn(p, 1, ['SN050'], 'PRET-T6', TOKEN_A, undefined, pur.body.id);
  const id = await idOf(USER_A, 'SN050');

  assert.strictEqual((await sell(p, 1, ['SN050'], 'INV-T6')).status, 409, 'cannot be sold');
  const moved = await api('POST', `/api/stock/serials/${id}/transfer`,
    { token: TOKEN_A, body: { to_location_id: LOC_SECOND } });
  assert.strictEqual(moved.status, 409, 'cannot be moved');
  for (const next of ['AVAILABLE', 'DAMAGED', 'SCRAPPED', 'RETURNED']) {
    const r = await api('POST', `/api/stock/serials/${id}/status`,
      { token: TOKEN_A, body: { status: next } });
    assert.strictEqual(r.status, 409, `cannot become ${next}`);
  }
  assert.strictEqual(await statusOf(USER_A, 'SN050'), 'RETURNED_TO_SUPPLIER');
});

test('T7 a supplier return refuses units it has no claim on', async () => {
  const p = await mkProduct(USER_A, 'SupGuards');
  const other = await mkProduct(USER_A, 'SupOther');
  const pur = await purchase(p, 3, ['SN060', 'SN061', 'SN062'], 'PUR-T7');
  await purchase(other, 1, ['SN063'], 'PUR-T7b');
  const pur2 = await purchase(p, 1, ['SN064'], 'PUR-T7c');
  await sell(p, 1, ['SN060'], 'INV-T7');

  // Already sold to a customer.
  const sold = await supplierReturn(p, 1, ['SN060'], 'PRET-T7a', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(sold.status, 409, msg(sold));

  // Another product.
  const wrongProduct = await supplierReturn(p, 1, ['SN063'], 'PRET-T7b', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(wrongProduct.status, 409, msg(wrongProduct));

  // A unit that came from a DIFFERENT purchase than the one being returned.
  const wrongPurchase = await supplierReturn(p, 1, ['SN064'], 'PRET-T7c', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(wrongPurchase.status, 409, msg(wrongPurchase));
  assert.match(msg(wrongPurchase), /did not come from the purchase/);

  // The same number twice on one return.
  const dup = await supplierReturn(p, 2, ['SN061', 'sn061'], 'PRET-T7d', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(dup.status, 409, msg(dup));

  // Count must match.
  const mismatch = await supplierReturn(p, 2, ['SN061'], 'PRET-T7e', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(mismatch.status, 409, msg(mismatch));

  assert.strictEqual(await statusOf(USER_A, 'SN061'), 'AVAILABLE', 'nothing moved');
  void pur2;
});

test('T8 the same unit cannot be returned to the supplier twice', async () => {
  const p = await mkProduct(USER_A, 'Twice');
  const pur = await purchase(p, 1, ['SN070'], 'PUR-T8');
  assert.strictEqual((await supplierReturn(p, 1, ['SN070'], 'PRET-T8a', TOKEN_A, undefined, pur.body.id)).status, 200);
  const again = await supplierReturn(p, 1, ['SN070'], 'PRET-T8b', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(again.status, 409, msg(again));
  assert.match(msg(again), /already been returned to the supplier/);
});

test('T9 deleting a supplier return brings the units back', async () => {
  const p = await mkProduct(USER_A, 'UndoSupplier');
  const pur = await purchase(p, 2, ['SN080', 'SN081'], 'PUR-T9');
  const ret = await supplierReturn(p, 2, ['SN080', 'SN081'], 'PRET-T9', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(await stockOf(p), 0);

  const del = await api('POST', `/api/purchases/return/${ret.body.id}/cascade-delete`, { token: TOKEN_A });
  assert.strictEqual(del.status, 200, msg(del));
  assert.strictEqual(await stockOf(p), 2, 'the quantity came back');
  assert.strictEqual(await statusOf(USER_A, 'SN080'), 'AVAILABLE');
  assert.strictEqual(await statusOf(USER_A, 'SN081'), 'AVAILABLE');
});

test('T10 editing a supplier return releases exactly the unit it dropped', async () => {
  const p = await mkProduct(USER_A, 'EditSupplier');
  const pur = await purchase(p, 2, ['SN090', 'SN091'], 'PUR-T10');
  const ret = await supplierReturn(p, 2, ['SN090', 'SN091'], 'PRET-T10', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(ret.status, 200, msg(ret));

  const edit = await supplierReturn(p, 1, ['SN090'], 'PRET-T10', TOKEN_A, ret.body.id, pur.body.id);
  assert.strictEqual(edit.status, 200, msg(edit));
  assert.strictEqual(await statusOf(USER_A, 'SN090'), 'RETURNED_TO_SUPPLIER');
  assert.strictEqual(await statusOf(USER_A, 'SN091'), 'AVAILABLE', 'exactly the dropped one came back');
  assert.strictEqual(await stockOf(p), 1);
});

// ── serial tracking toggle ───────────────────────────────────────────
test('T11 serial tracking cannot be switched off once units exist', async () => {
  const p = await mkProduct(USER_A, 'NoDisable');
  await purchase(p, 1, ['SN100'], 'PUR-T11');

  const off = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: false } });
  assert.strictEqual(off.status, 409, msg(off));
  assert.match(msg(off), /serial number/);
  const { rows } = await db.query('SELECT serial_tracking FROM products WHERE id=$1', [p]);
  assert.strictEqual(rows[0].serial_tracking, true, 'still on');

  // Even history counts: a unit sent back to the supplier is still history.
  const pur2 = await purchase(p, 1, ['SN101'], 'PUR-T11b');
  await supplierReturn(p, 1, ['SN101'], 'PRET-T11', TOKEN_A, undefined, pur2.body.id);
  const off2 = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: false } });
  assert.strictEqual(off2.status, 409, 'history is still history: ' + msg(off2));
});

test('T12 a product that never had a serial switches off freely', async () => {
  const p = await mkProduct(USER_A, 'CanDisable');
  const off = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: false } });
  assert.strictEqual(off.status, 200, msg(off));
  const { rows } = await db.query('SELECT serial_tracking FROM products WHERE id=$1', [p]);
  assert.strictEqual(rows[0].serial_tracking, false);

  // And back on again, which is always allowed.
  const on = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: true } });
  assert.strictEqual(on.status, 200, msg(on));
});

// ── reconciliation ───────────────────────────────────────────────────
test('T13 units that have left are not counted as stock', async () => {
  const p = await mkProduct(USER_A, 'Reconcile');
  const pur = await purchase(p, 3, ['SN110', 'SN111', 'SN112'], 'PUR-T13');
  const before = await api('GET', `/api/stock/serials/reconcile?product_id=${p}`, { token: TOKEN_A });
  assert.ok(before.body.balanced, 'three units against a balance of three');

  // One to a customer, one back to the supplier. Neither is our stock now.
  await sell(p, 1, ['SN110'], 'INV-T13');
  await supplierReturn(p, 1, ['SN111'], 'PRET-T13', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(await stockOf(p), 1);

  const after = await api('GET', `/api/stock/serials/reconcile?product_id=${p}`, { token: TOKEN_A });
  assert.ok(after.body.balanced, 'one unit held, one in stock: ' + JSON.stringify(after.body.rows));
  const row = after.body.rows.find(r => r.held_serials > 0);
  assert.strictEqual(row.held_serials, 1);
  assert.strictEqual(Number(row.balance_quantity), 1);
});

// ── concurrency, against real Postgres ───────────────────────────────
test('T14 two simultaneous supplier returns of one unit: exactly one wins', async () => {
  const p = await mkProduct(USER_A, 'RaceSupplier');
  const pur = await purchase(p, 1, ['SN120'], 'PUR-T14');
  const [a, b] = await Promise.all([
    supplierReturn(p, 1, ['SN120'], 'PRET-T14a', TOKEN_A, undefined, pur.body.id),
    supplierReturn(p, 1, ['SN120'], 'PRET-T14b', TOKEN_A, undefined, pur.body.id)
  ]);
  assert.strictEqual([a, b].filter(r => r.status === 200).length, 1,
    `one return, not two: ${a.status}/${b.status}`);
  assert.strictEqual(await statusOf(USER_A, 'SN120'), 'RETURNED_TO_SUPPLIER');
  assert.strictEqual(await stockOf(p), 0, 'and the stock left once');
});

test('T15 two simultaneous customer returns of one unit: exactly one wins', async () => {
  const p = await mkProduct(USER_A, 'RaceCustomer');
  await purchase(p, 1, ['SN130'], 'PUR-T15');
  const inv = await sell(p, 1, ['SN130'], 'INV-T15');
  const [a, b] = await Promise.all([
    salesReturn(p, 1, ['SN130'], 'SR-T15a', inv.body.invoiceId),
    salesReturn(p, 1, ['SN130'], 'SR-T15b', inv.body.invoiceId)
  ]);
  assert.strictEqual([a, b].filter(r => r.status === 200).length, 1,
    `one return, not two: ${a.status}/${b.status}`);
  assert.strictEqual(await statusOf(USER_A, 'SN130'), 'RETURNED');
  assert.strictEqual(await stockOf(p), 1, 'the goods came back once');
});

test('T16 a supplier return and a transfer cannot both take the same unit', async () => {
  const p = await mkProduct(USER_A, 'RaceMove');
  const pur = await purchase(p, 1, ['SN140'], 'PUR-T16');
  const id = await idOf(USER_A, 'SN140');
  const [ret, move] = await Promise.all([
    supplierReturn(p, 1, ['SN140'], 'PRET-T16', TOKEN_A, undefined, pur.body.id),
    api('POST', `/api/stock/serials/${id}/transfer`,
      { token: TOKEN_A, body: { to_location_id: LOC_SECOND } })
  ]);
  const winners = [ret.status === 200, move.status === 201].filter(Boolean).length;
  assert.ok(winners >= 1, 'at least one must succeed');
  const status = await statusOf(USER_A, 'SN140');
  // Whichever won, the unit is in ONE coherent state.
  if (status === 'RETURNED_TO_SUPPLIER') {
    const { rows } = await db.query('SELECT location_id FROM stock_serials WHERE id=$1', [id]);
    assert.strictEqual(rows[0].location_id, null, 'a returned unit is nowhere');
  } else {
    assert.strictEqual(status, 'AVAILABLE', 'or it stayed available and simply moved');
  }
});

// ── tenancy and auth ─────────────────────────────────────────────────
test('T17 another tenant cannot return, sell or move a unit that is not theirs', async () => {
  const p = await mkProduct(USER_A, 'IsolationRet');
  const bProd = await mkProduct(USER_B, 'IsolationB');
  const pur = await purchase(p, 1, ['SN150'], 'PUR-T17');

  const theirs = await supplierReturn(bProd, 1, ['SN150'], 'PRET-T17', TOKEN_B, undefined, pur.body.id);
  assert.strictEqual(theirs.status, 404, "B cannot send back A's unit: " + msg(theirs));
  assert.strictEqual(await statusOf(USER_A, 'SN150'), 'AVAILABLE');

  const id = await idOf(USER_A, 'SN150');
  assert.strictEqual((await api('POST', `/api/stock/serials/${id}/status`,
    { token: TOKEN_B, body: { status: 'DAMAGED' } })).status, 404);
  assert.strictEqual((await api('POST', `/api/stock/serials/${id}/transfer`,
    { token: TOKEN_B, body: { to_location_id: LOC_SECOND } })).status, 404);
  assert.strictEqual(await statusOf(USER_A, 'SN150'), 'AVAILABLE', 'still untouched');
});

test('T18 both return endpoints require authentication', async () => {
  for (const url of ['/api/purchases/return/save-with-items', '/api/sales_returns/save-with-items']) {
    const r = await api('POST', url, { body: { header: {}, items: [] } });
    assert.strictEqual(r.status, 401, url);
  }
});

// ── regressions ──────────────────────────────────────────────────────
test('T19 returns of quantity-only products are unaffected', async () => {
  const p = await mkProduct(USER_A, 'PlainReturns', { serial: false });
  const pur = await purchase(p, 5, undefined, 'PUR-T19');
  assert.strictEqual(pur.status, 200, msg(pur));
  assert.strictEqual(await stockOf(p), 5);

  const ret = await supplierReturn(p, 2, undefined, 'PRET-T19', TOKEN_A, undefined, pur.body.id);
  assert.strictEqual(ret.status, 200, 'no serials asked for: ' + msg(ret));
  assert.strictEqual(await stockOf(p), 3);

  const inv = await sell(p, 1, undefined, 'INV-T19');
  assert.strictEqual(inv.status, 200, msg(inv));
  const sr = await salesReturn(p, 1, undefined, 'SR-T19', inv.body.invoiceId);
  assert.strictEqual(sr.status, 200, msg(sr));
  assert.strictEqual(await stockOf(p), 3, 'sold one, got it back');
  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM stock_serials WHERE product_id=$1', [p]);
  assert.strictEqual(rows[0].n, 0, 'and no serial rows were invented');
});

test('T20 the timeline carries every serialised movement', async () => {
  const p = await mkProduct(USER_A, 'Timeline');
  const pur = await purchase(p, 1, ['SN160'], 'PUR-T20');
  const id = await idOf(USER_A, 'SN160');
  await supplierReturn(p, 1, ['SN160'], 'PRET-T20', TOKEN_A, undefined, pur.body.id);

  const detail = await api('GET', `/api/stock/serials/${id}`, { token: TOKEN_A });
  assert.strictEqual(detail.status, 200, msg(detail));
  assert.strictEqual(detail.body.serial.status, 'RETURNED_TO_SUPPLIER');
  assert.deepStrictEqual(detail.body.allowed_transitions, [], 'nothing follows');
});
