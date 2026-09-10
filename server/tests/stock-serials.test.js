// Serial number inventory, through the real HTTP surface.
//
// A serial is a unit of stock tracked by name. The thing worth proving is
// that the two accounts of the same goods — the quantity ledger and the
// serial rows — never disagree, through every document that moves them and
// every edit of those documents.
//
// The hard case throughout is identity: invoice_items and purchase_items
// are deleted and re-inserted on save, so a serial can never be owned by a
// line. These tests edit documents deliberately, because that is where an
// implementation that relied on line ids would come apart.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('stock serials (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'serial-test-secret';

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

let server, base, db, USER_A, TOKEN_A, USER_B, TOKEN_B, LOC_MAIN, LOC_SECOND, LOC_B;

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

async function mkProduct(userId, name, { serial = true, stock = 0 } = {}) {
  const { rows } = await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock,serial_tracking)
     VALUES ($1,$2,'84388090','PCS',18,$3,$4) RETURNING id`, [userId, name, stock, serial]);
  return rows[0].id;
}
const serialsOf = async (userId, productId) => (await db.query(
  `SELECT serial_no, status, location_id, source_id, sold_source_id
     FROM stock_serials WHERE user_id=$1 AND product_id=$2 ORDER BY upper(btrim(serial_no))`,
  [userId, productId])).rows;
const statusOf = async (userId, serial) => {
  const { rows } = await db.query(
    'SELECT status FROM stock_serials WHERE user_id=$1 AND upper(btrim(serial_no))=upper($2)',
    [userId, serial]);
  return rows.length ? rows[0].status : null;
};
const stockOf = async (productId) => Number((await db.query(
  'SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock);
const balanceAt = async (productId, loc) => Number(((await db.query(
  'SELECT quantity FROM stock_balances WHERE product_id=$1 AND location_id=$2', [productId, loc]))
  .rows[0] || { quantity: 0 }).quantity);

// A purchase carrying serials, through the real save path.
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

// An invoice selling serials, through the real save path.
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

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('sn-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('sn-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) {
    await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
  }
  LOC_MAIN = (await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'Main','MAIN',TRUE,TRUE) RETURNING id`, [USER_A])).rows[0].id;
  LOC_SECOND = (await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'Second','SEC',FALSE,TRUE) RETURNING id`, [USER_A])).rows[0].id;
  LOC_B = (await db.query(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active)
     VALUES ($1,'B Main','BMAIN',TRUE,TRUE) RETURNING id`, [USER_B])).rows[0].id;
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

// ── FLOW 1: purchase ─────────────────────────────────────────────────
test('S1 a serialised purchase creates one AVAILABLE unit per quantity', async () => {
  const p = await mkProduct(USER_A, 'Flow1');
  const r = await purchase(p, 3, ['SN001', 'SN002', 'SN003'], 'PUR-S1');
  assert.strictEqual(r.status, 200, msg(r));

  assert.strictEqual(await stockOf(p), 3, 'quantity stock rose by three');
  const rows = await serialsOf(USER_A, p);
  assert.deepStrictEqual(rows.map(x => x.serial_no), ['SN001', 'SN002', 'SN003']);
  assert.ok(rows.every(x => x.status === 'AVAILABLE'), 'all three are available');
  assert.ok(rows.every(x => x.source_id === r.body.id), 'each names the purchase HEADER that brought it in');
});

test('S2 the serial count must equal the quantity, in both directions', async () => {
  const p = await mkProduct(USER_A, 'Counts');
  const short = await purchase(p, 3, ['SN010', 'SN011'], 'PUR-S2a');
  assert.strictEqual(short.status, 409, msg(short));
  assert.match(msg(short), /needs exactly 3 serial numbers, but 2/);

  const over = await purchase(p, 2, ['SN010', 'SN011', 'SN012'], 'PUR-S2b');
  assert.strictEqual(over.status, 409, msg(over));

  const none = await purchase(p, 2, [], 'PUR-S2c');
  assert.strictEqual(none.status, 409, 'missing serials are refused');

  assert.strictEqual(await stockOf(p), 0, 'and no stock was created by any of them');
  assert.strictEqual((await serialsOf(USER_A, p)).length, 0);
});

test('S3 duplicates are refused by name, across case, spaces and products', async () => {
  const p = await mkProduct(USER_A, 'Dup1');
  const q = await mkProduct(USER_A, 'Dup2');
  assert.strictEqual((await purchase(p, 1, ['SN100'], 'PUR-S3a')).status, 200);

  const sameLine = await purchase(p, 2, ['SN200', 'sn200'], 'PUR-S3b');
  assert.strictEqual(sameLine.status, 409, 'the same number twice on one line');

  const caseDup = await purchase(p, 1, ['sn100'], 'PUR-S3c');
  assert.strictEqual(caseDup.status, 409, msg(caseDup));

  const spaceDup = await purchase(p, 1, ['  SN100  '], 'PUR-S3d');
  assert.strictEqual(spaceDup.status, 409, msg(spaceDup));

  // Tenant-wide: the same number cannot reappear on a DIFFERENT product.
  const otherProduct = await purchase(q, 1, ['SN100'], 'PUR-S3e');
  assert.strictEqual(otherProduct.status, 409, msg(otherProduct));

  const blank = await purchase(p, 1, ['   '], 'PUR-S3f');
  assert.strictEqual(blank.status, 400, 'a blank serial is refused, not accepted as one');
});

test('S4 the serial is stored exactly as typed, leading zeros and all', async () => {
  const p = await mkProduct(USER_A, 'Zeros');
  assert.strictEqual((await purchase(p, 1, ['00123'], 'PUR-S4')).status, 200);
  const rows = await serialsOf(USER_A, p);
  assert.strictEqual(rows[0].serial_no, '00123', 'not 123');
});

test('S5 another tenant may hold the same serial number', async () => {
  const a = await mkProduct(USER_A, 'TenantA');
  const b = await mkProduct(USER_B, 'TenantB');
  assert.strictEqual((await purchase(a, 1, ['SHARED-1'], 'PUR-S5a')).status, 200);
  assert.strictEqual((await purchase(b, 1, ['SHARED-1'], 'PUR-S5b', TOKEN_B)).status, 200,
    'uniqueness is per tenant, not global');
});

// ── FLOW 2 and 10: sale, and editing one ─────────────────────────────
test('S6 selling marks exactly the chosen units SOLD', async () => {
  const p = await mkProduct(USER_A, 'Flow2');
  await purchase(p, 3, ['SN301', 'SN302', 'SN303'], 'PUR-S6');
  const r = await sell(p, 2, ['SN301', 'SN303'], 'INV-S6');
  assert.strictEqual(r.status, 200, msg(r));

  assert.strictEqual(await stockOf(p), 1, 'stock fell by two');
  assert.strictEqual(await statusOf(USER_A, 'SN301'), 'SOLD');
  assert.strictEqual(await statusOf(USER_A, 'SN303'), 'SOLD');
  assert.strictEqual(await statusOf(USER_A, 'SN302'), 'AVAILABLE', 'the one not sold is untouched');
});

test('S7 a sale refuses every unsellable unit', async () => {
  const p = await mkProduct(USER_A, 'SaleGuards');
  const other = await mkProduct(USER_A, 'OtherProduct');
  await purchase(p, 2, ['SN401', 'SN402'], 'PUR-S7');
  await purchase(other, 1, ['SN403'], 'PUR-S7b');
  await sell(p, 1, ['SN401'], 'INV-S7a');

  const already = await sell(p, 1, ['SN401'], 'INV-S7b');
  assert.strictEqual(already.status, 409, 'a sold unit cannot be sold twice');

  const wrongProduct = await sell(p, 1, ['SN403'], 'INV-S7c');
  assert.strictEqual(wrongProduct.status, 409, msg(wrongProduct));
  assert.match(msg(wrongProduct), /different product/);

  const unknown = await sell(p, 1, ['NOPE-1'], 'INV-S7d');
  assert.strictEqual(unknown.status, 404, msg(unknown));

  const mismatch = await sell(p, 2, ['SN402'], 'INV-S7e');
  assert.strictEqual(mismatch.status, 409, 'two sold needs two serials');

  assert.strictEqual(await statusOf(USER_A, 'SN402'), 'AVAILABLE', 'nothing changed');
});

test('S8 another tenant cannot sell, read or move a serial that is not theirs', async () => {
  const a = await mkProduct(USER_A, 'IsolationA');
  const bProd = await mkProduct(USER_B, 'IsolationB');
  await purchase(a, 1, ['SN-ISO-A'], 'PUR-S8');

  const steal = await sell(bProd, 1, ['SN-ISO-A'], 'INV-S8', TOKEN_B);
  assert.strictEqual(steal.status, 404, "B cannot reach A's serial");
  assert.strictEqual(await statusOf(USER_A, 'SN-ISO-A'), 'AVAILABLE');

  const id = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SN-ISO-A'])).rows[0].id;
  assert.strictEqual((await api('GET', `/api/stock/serials/${id}`, { token: TOKEN_B })).status, 404);
  assert.strictEqual((await api('POST', `/api/stock/serials/${id}/status`,
    { token: TOKEN_B, body: { status: 'DAMAGED' } })).status, 404);
  assert.strictEqual((await api('POST', `/api/stock/serials/${id}/transfer`,
    { token: TOKEN_B, body: { to_location_id: LOC_B } })).status, 404);
  assert.strictEqual(await statusOf(USER_A, 'SN-ISO-A'), 'AVAILABLE', 'still untouched');
});

test('S9 every serial endpoint requires authentication', async () => {
  for (const [m, u, b] of [
    ['GET', '/api/stock/serials', undefined],
    ['GET', '/api/stock/serials/00000000-0000-4000-8000-000000000000', undefined],
    ['POST', '/api/stock/serials/00000000-0000-4000-8000-000000000000/status', { status: 'DAMAGED' }],
    ['POST', '/api/stock/serials/00000000-0000-4000-8000-000000000000/transfer', { to_location_id: LOC_MAIN }]
  ]) {
    assert.strictEqual((await api(m, u, { body: b })).status, 401, `${m} ${u}`);
  }
});

// ── FLOW 9 and 10: document edits ────────────────────────────────────
test('S10 editing a purchase releases exactly the serial that was removed', async () => {
  const p = await mkProduct(USER_A, 'PurchaseEdit');
  const r = await purchase(p, 3, ['SN501', 'SN502', 'SN503'], 'PUR-S10');
  assert.strictEqual(r.status, 200, msg(r));

  // Drop SN502 and nothing else. The line rows are re-created by this save,
  // so an implementation keyed on purchase_items.id would lose all three.
  const edit = await purchase(p, 2, ['SN501', 'SN503'], 'PUR-S10', TOKEN_A, r.body.id);
  assert.strictEqual(edit.status, 200, msg(edit));

  assert.strictEqual(await statusOf(USER_A, 'SN501'), 'AVAILABLE');
  assert.strictEqual(await statusOf(USER_A, 'SN503'), 'AVAILABLE');
  assert.strictEqual(await statusOf(USER_A, 'SN502'), null, 'exactly the removed unit is gone');
  assert.strictEqual(await stockOf(p), 2, 'and the quantity followed it');
});

test('S11 editing a sale releases exactly the serial that was removed', async () => {
  const p = await mkProduct(USER_A, 'SaleEdit');
  await purchase(p, 3, ['SN601', 'SN602', 'SN603'], 'PUR-S11');
  const inv = await sell(p, 2, ['SN601', 'SN603'], 'INV-S11');
  assert.strictEqual(inv.status, 200, msg(inv));

  const edit = await sell(p, 1, ['SN601'], 'INV-S11', TOKEN_A, inv.body.invoiceId);
  assert.strictEqual(edit.status, 200, msg(edit));

  assert.strictEqual(await statusOf(USER_A, 'SN601'), 'SOLD', 'the kept unit stays sold');
  assert.strictEqual(await statusOf(USER_A, 'SN603'), 'AVAILABLE', 'the dropped one comes back');
  assert.strictEqual(await statusOf(USER_A, 'SN602'), 'AVAILABLE', 'the untouched one is untouched');
  assert.strictEqual(await stockOf(p), 2);
});

test('S12 a purchase cannot drop a serial that has since been sold', async () => {
  const p = await mkProduct(USER_A, 'SoldGuard');
  const r = await purchase(p, 2, ['SN701', 'SN702'], 'PUR-S12');
  await sell(p, 1, ['SN701'], 'INV-S12');

  const edit = await purchase(p, 1, ['SN702'], 'PUR-S12', TOKEN_A, r.body.id);
  assert.strictEqual(edit.status, 409, msg(edit));
  assert.match(msg(edit), /sold/i);
  assert.strictEqual(await statusOf(USER_A, 'SN701'), 'SOLD', 'the sale still holds it');
});

// ── FLOW 11: deletions ───────────────────────────────────────────────
test('S13 deleting a sale returns exactly its units to AVAILABLE', async () => {
  const p = await mkProduct(USER_A, 'SaleDelete');
  await purchase(p, 2, ['SN801', 'SN802'], 'PUR-S13');
  const inv = await sell(p, 1, ['SN801'], 'INV-S13');
  assert.strictEqual(await stockOf(p), 1);

  const del = await api('POST', `/api/invoices/b2c/${inv.body.invoiceId}/cascade-delete`, { token: TOKEN_A });
  assert.strictEqual(del.status, 200, msg(del));
  assert.strictEqual(await statusOf(USER_A, 'SN801'), 'AVAILABLE');
  assert.strictEqual(await statusOf(USER_A, 'SN802'), 'AVAILABLE');
  assert.strictEqual(await stockOf(p), 2, 'stock came back once');

  // A second delete must not give anything back twice.
  await api('POST', `/api/invoices/b2c/${inv.body.invoiceId}/cascade-delete`, { token: TOKEN_A });
  assert.strictEqual(await stockOf(p), 2);
});

test('S14 deleting a purchase removes the units it brought in', async () => {
  const p = await mkProduct(USER_A, 'PurchaseDelete');
  const r = await purchase(p, 2, ['SN901', 'SN902'], 'PUR-S14');
  const del = await api('POST', `/api/purchases/purchase/${r.body.id}/cascade-delete`, { token: TOKEN_A });
  assert.strictEqual(del.status, 200, msg(del));
  assert.strictEqual(await statusOf(USER_A, 'SN901'), null, 'no orphan inventory left behind');
  assert.strictEqual(await statusOf(USER_A, 'SN902'), null);
  assert.strictEqual(await stockOf(p), 0);
});

// ── FLOW 3, 4, 5: return, inspection, scrap ──────────────────────────
test('S15 a returned unit is RETURNED, never straight back to AVAILABLE', async () => {
  const p = await mkProduct(USER_A, 'Returns');
  await purchase(p, 1, ['SNR-1'], 'PUR-S15');
  await sell(p, 1, ['SNR-1'], 'INV-S15');
  const id = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SNR-1'])).rows[0].id;

  // A sold unit cannot be walked back to AVAILABLE by hand: that is what
  // reversing the sale is for.
  const shortcut = await api('POST', `/api/stock/serials/${id}/status`,
    { token: TOKEN_A, body: { status: 'AVAILABLE' } });
  assert.strictEqual(shortcut.status, 409, msg(shortcut));

  await db.query(`UPDATE stock_serials SET status='RETURNED', location_id=$2 WHERE id=$1`, [id, LOC_MAIN]);
  assert.strictEqual(await statusOf(USER_A, 'SNR-1'), 'RETURNED');

  // A returned unit is not sellable until it has been inspected.
  const resell = await sell(p, 1, ['SNR-1'], 'INV-S15b');
  assert.strictEqual(resell.status, 409, msg(resell));
  assert.match(msg(resell), /returned/i);
});

test('S16 inspection sends a returned unit either way', async () => {
  const p = await mkProduct(USER_A, 'Inspect');
  await purchase(p, 2, ['SNI-1', 'SNI-2'], 'PUR-S16');
  const ids = {};
  for (const s of ['SNI-1', 'SNI-2']) {
    ids[s] = (await db.query(
      'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, s])).rows[0].id;
    await db.query(`UPDATE stock_serials SET status='RETURNED' WHERE id=$1`, [ids[s]]);
  }
  const back = await api('POST', `/api/stock/serials/${ids['SNI-1']}/status`,
    { token: TOKEN_A, body: { status: 'AVAILABLE', reason: 'inspected, as new' } });
  assert.strictEqual(back.status, 200, msg(back));
  assert.strictEqual(await statusOf(USER_A, 'SNI-1'), 'AVAILABLE');

  const damaged = await api('POST', `/api/stock/serials/${ids['SNI-2']}/status`,
    { token: TOKEN_A, body: { status: 'DAMAGED', reason: 'cracked case' } });
  assert.strictEqual(damaged.status, 200, msg(damaged));
  assert.strictEqual(await statusOf(USER_A, 'SNI-2'), 'DAMAGED');

  // A damaged unit is not sellable.
  const sale = await sell(p, 1, ['SNI-2'], 'INV-S16');
  assert.strictEqual(sale.status, 409, msg(sale));
});

test('S17 scrap is terminal and takes the quantity with it', async () => {
  const p = await mkProduct(USER_A, 'Scrap');
  await purchase(p, 1, ['SNS-1'], 'PUR-S17');
  const id = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SNS-1'])).rows[0].id;

  // Only a damaged unit can be scrapped.
  await api('POST', `/api/stock/serials/${id}/status`, { token: TOKEN_A, body: { status: 'DAMAGED' } });
  assert.strictEqual(await stockOf(p), 1, 'damage keeps the goods on the premises');

  const scrap = await api('POST', `/api/stock/serials/${id}/status`,
    { token: TOKEN_A, body: { status: 'SCRAPPED', reason: 'beyond repair' } });
  assert.strictEqual(scrap.status, 200, msg(scrap));
  assert.strictEqual(await stockOf(p), 0, 'scrapping removes the quantity');

  for (const next of ['AVAILABLE', 'DAMAGED', 'RETURNED']) {
    const r = await api('POST', `/api/stock/serials/${id}/status`, { token: TOKEN_A, body: { status: next } });
    assert.strictEqual(r.status, 409, `scrapped cannot become ${next}`);
  }
  const resell = await sell(p, 1, ['SNS-1'], 'INV-S17');
  assert.strictEqual(resell.status, 409, 'and it cannot be sold');
});

// ── FLOW 6: transfer ─────────────────────────────────────────────────
test('S18 transferring a unit moves both the unit and the balance', async () => {
  const p = await mkProduct(USER_A, 'Transfer');
  await purchase(p, 2, ['SNT-1', 'SNT-2'], 'PUR-S18');
  const id = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SNT-1'])).rows[0].id;
  const mainBefore = await balanceAt(p, LOC_MAIN);

  const r = await api('POST', `/api/stock/serials/${id}/transfer`,
    { token: TOKEN_A, body: { to_location_id: LOC_SECOND } });
  assert.strictEqual(r.status, 201, msg(r));

  const row = (await db.query('SELECT location_id FROM stock_serials WHERE id=$1', [id])).rows[0];
  assert.strictEqual(row.location_id, LOC_SECOND, 'the unit is at the new location');
  assert.strictEqual(await balanceAt(p, LOC_MAIN), mainBefore - 1);
  assert.strictEqual(await balanceAt(p, LOC_SECOND), 1);
  assert.strictEqual(await stockOf(p), 2, 'a transfer moves stock, it does not create or destroy it');

  const same = await api('POST', `/api/stock/serials/${id}/transfer`,
    { token: TOKEN_A, body: { to_location_id: LOC_SECOND } });
  assert.strictEqual(same.status, 400, 'already there');
});

test('S19 a sold or scrapped unit cannot be moved', async () => {
  const p = await mkProduct(USER_A, 'NoMove');
  await purchase(p, 2, ['SNM-1', 'SNM-2'], 'PUR-S19');
  await sell(p, 1, ['SNM-1'], 'INV-S19');
  const soldId = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SNM-1'])).rows[0].id;
  const r = await api('POST', `/api/stock/serials/${soldId}/transfer`,
    { token: TOKEN_A, body: { to_location_id: LOC_SECOND } });
  assert.strictEqual(r.status, 409, msg(r));
});

// ── adjustments ──────────────────────────────────────────────────────
test('S20 a serialised product cannot be adjusted anonymously', async () => {
  const p = await mkProduct(USER_A, 'NoAdjust');
  await purchase(p, 1, ['SNA-1'], 'PUR-S20');
  for (const type of ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT']) {
    const r = await api('POST', '/api/stock/adjustment', {
      token: TOKEN_A,
      body: { product_id: p, movement_type: type, quantity: 1, reason: 'stocktake' }
    });
    assert.strictEqual(r.status, 409, `${type}: ${msg(r)}`);
    assert.match(msg(r), /serial-tracked/);
  }
  assert.strictEqual(await stockOf(p), 1, 'nothing moved');
});

test('S21 a quantity-only product still adjusts exactly as before', async () => {
  const p = await mkProduct(USER_A, 'PlainProduct', { serial: false });
  const r = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A,
    body: { product_id: p, movement_type: 'ADJUSTMENT_IN', quantity: 4, reason: 'found in the van' }
  });
  assert.strictEqual(r.status, 201, msg(r));
  assert.strictEqual(await stockOf(p), 4);
  assert.strictEqual((await serialsOf(USER_A, p)).length, 0, 'and needs no serials');
});

test('S22 a non-serialised product ignores serials entirely', async () => {
  const p = await mkProduct(USER_A, 'Untracked', { serial: false });
  const r = await purchase(p, 2, undefined, 'PUR-S22');
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(await stockOf(p), 2);
  assert.strictEqual((await serialsOf(USER_A, p)).length, 0);
});

// ── list, detail, timeline, reconciliation ───────────────────────────
test('S23 the list filters, and the detail carries the timeline', async () => {
  const p = await mkProduct(USER_A, 'Listing');
  await purchase(p, 2, ['SNL-1', 'SNL-2'], 'PUR-S23');
  await sell(p, 1, ['SNL-1'], 'INV-S23');

  const all = await api('GET', `/api/stock/serials?product_id=${p}`, { token: TOKEN_A });
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.body.total, 2);
  assert.ok(all.body.rows.every(r => r.product_name === 'Listing'), 'the product name travels with the row');

  const available = await api('GET', `/api/stock/serials?product_id=${p}&status=AVAILABLE`, { token: TOKEN_A });
  assert.strictEqual(available.body.total, 1);
  assert.strictEqual(available.body.rows[0].serial_no, 'SNL-2');

  // Scanner-style: a lower-case scan finds the unit.
  const scanned = await api('GET', '/api/stock/serials?q=snl-1', { token: TOKEN_A });
  assert.strictEqual(scanned.body.total, 1);
  assert.strictEqual(scanned.body.rows[0].serial_no, 'SNL-1');

  const bad = await api('GET', '/api/stock/serials?status=BANANA', { token: TOKEN_A });
  assert.strictEqual(bad.status, 400);

  const id = all.body.rows.find(r => r.serial_no === 'SNL-1').id;
  const detail = await api('GET', `/api/stock/serials/${id}`, { token: TOKEN_A });
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.serial.status, 'SOLD');
  assert.ok(Array.isArray(detail.body.timeline));
  assert.deepStrictEqual(detail.body.allowed_transitions, ['RETURNED', 'AVAILABLE']);
});

test('S24 reconciliation reports a mismatch rather than correcting it', async () => {
  const p = await mkProduct(USER_A, 'Reconcile');
  await purchase(p, 3, ['SNC-1', 'SNC-2', 'SNC-3'], 'PUR-S24');

  const ok = await api('GET', `/api/stock/serials/reconcile?product_id=${p}`, { token: TOKEN_A });
  assert.strictEqual(ok.status, 200, msg(ok));
  assert.ok(ok.body.balanced, 'three units against a balance of three');

  // Break it behind the application's back, the way a bad import would.
  await db.query('UPDATE stock_balances SET quantity = quantity + 1 WHERE product_id=$1', [p]);
  const broken = await api('GET', `/api/stock/serials/reconcile?product_id=${p}`, { token: TOKEN_A });
  assert.strictEqual(broken.body.balanced, false, 'the mismatch is reported');
  const row = broken.body.rows.find(r => !r.balanced);
  assert.strictEqual(row.held_serials, 3);
  assert.strictEqual(Number(row.balance_quantity), 4);
  // And nothing was quietly fixed.
  assert.strictEqual((await serialsOf(USER_A, p)).length, 3);
});

// ── concurrency, against real Postgres ───────────────────────────────
test('S25 two simultaneous sales of one unit: exactly one succeeds', async () => {
  const p = await mkProduct(USER_A, 'RaceSale');
  await purchase(p, 1, ['SNX-1'], 'PUR-S25');
  const [a, b] = await Promise.all([
    sell(p, 1, ['SNX-1'], 'INV-S25a'),
    sell(p, 1, ['SNX-1'], 'INV-S25b')
  ]);
  const won = [a, b].filter(r => r.status === 200);
  assert.strictEqual(won.length, 1, `exactly one sale should win: ${a.status}/${b.status}`);
  assert.strictEqual(await statusOf(USER_A, 'SNX-1'), 'SOLD');
  assert.strictEqual(await stockOf(p), 0, 'and the unit was only sold once');
});

test('S26 two simultaneous purchases of one serial: exactly one succeeds', async () => {
  const p = await mkProduct(USER_A, 'RaceBuy');
  const [a, b] = await Promise.all([
    purchase(p, 1, ['SN999'], 'PUR-S26a'),
    purchase(p, 1, ['SN999'], 'PUR-S26b')
  ]);
  const won = [a, b].filter(r => r.status === 200);
  assert.strictEqual(won.length, 1, `the unique index must stop the second: ${a.status}/${b.status}`);
  const { rows } = await db.query(
    'SELECT COUNT(*)::int n FROM stock_serials WHERE user_id=$1 AND upper(btrim(serial_no))=$2',
    [USER_A, 'SN999']);
  assert.strictEqual(rows[0].n, 1, 'one row, never two');
});

test('S27 two simultaneous transfers of one unit resolve to one location', async () => {
  const p = await mkProduct(USER_A, 'RaceMove');
  await purchase(p, 1, ['SNY-1'], 'PUR-S27');
  const id = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SNY-1'])).rows[0].id;
  const [a, b] = await Promise.all([
    api('POST', `/api/stock/serials/${id}/transfer`, { token: TOKEN_A, body: { to_location_id: LOC_SECOND } }),
    api('POST', `/api/stock/serials/${id}/transfer`, { token: TOKEN_A, body: { to_location_id: LOC_SECOND } })
  ]);
  assert.strictEqual([a, b].filter(r => r.status === 201).length, 1,
    `one transfer, not two: ${a.status}/${b.status}`);
  assert.strictEqual(await balanceAt(p, LOC_SECOND), 1, 'and the balance moved once');
});

// ── generic API cannot reach serials ─────────────────────────────────
test('S28 stock_serials is not reachable through the generic router', async () => {
  const p = await mkProduct(USER_A, 'GenericGuard');
  await purchase(p, 1, ['SNG-1'], 'PUR-S28');
  for (const [m, b] of [['GET', undefined], ['POST', { serial_no: 'X', status: 'AVAILABLE' }],
    ['PATCH', { status: 'AVAILABLE' }], ['DELETE', undefined]]) {
    const r = await api(m, '/api/stock_serials', { token: TOKEN_A, body: b });
    assert.strictEqual(r.status, 404, `${m} /api/stock_serials must not exist`);
  }
  assert.strictEqual(await statusOf(USER_A, 'SNG-1'), 'AVAILABLE');
});

test('S30 every serialised movement names the unit it moved', async () => {
  // A counted product nets its change into one movement. A serialised one
  // cannot and still say WHICH unit moved — one row of three can carry
  // only one serial_id — so each unit gets its own movement of one. The
  // balance is identical either way; what this buys is a unit's history.
  const p = await mkProduct(USER_A, 'Movements');
  const r = await purchase(p, 3, ['SNM-01', 'SNM-02', 'SNM-03'], 'PUR-S30');
  assert.strictEqual(r.status, 200, msg(r));

  const bought = (await db.query(
    `SELECT quantity::float q, serial_id FROM stock_movements
      WHERE user_id=$1 AND product_id=$2 AND movement_type='PURCHASE'`, [USER_A, p])).rows;
  assert.strictEqual(bought.length, 3, 'three units, three movements');
  assert.ok(bought.every(m => m.q === 1), 'each of one');
  assert.ok(bought.every(m => m.serial_id), 'each naming its unit');
  assert.strictEqual(new Set(bought.map(m => m.serial_id)).size, 3, 'three different units');
  assert.strictEqual(await stockOf(p), 3, 'and the balance is the same as one movement of three');

  await sell(p, 1, ['SNM-01'], 'INV-S30');
  const sold = (await db.query(
    `SELECT quantity::float q, serial_id FROM stock_movements
      WHERE user_id=$1 AND product_id=$2 AND movement_type='SALE'`, [USER_A, p])).rows;
  assert.strictEqual(sold.length, 1);
  assert.ok(sold[0].serial_id, 'the sale names the unit too');

  // Which makes the unit's timeline a query over the ledger — no second
  // history table anywhere.
  const id = (await db.query(
    'SELECT id FROM stock_serials WHERE user_id=$1 AND serial_no=$2', [USER_A, 'SNM-01'])).rows[0].id;
  const detail = await api('GET', `/api/stock/serials/${id}`, { token: TOKEN_A });
  assert.strictEqual(detail.status, 200);
  assert.ok(detail.body.timeline.length >= 2,
    'bought then sold, both on its timeline: ' + JSON.stringify(detail.body.timeline.map(t => t.movement_type)));
});

test('S31 a quantity-only product still nets into one movement', async () => {
  const p = await mkProduct(USER_A, 'StillNets', { serial: false });
  const r = await purchase(p, 5, undefined, 'PUR-S31');
  assert.strictEqual(r.status, 200, msg(r));
  const rows = (await db.query(
    `SELECT quantity::float q, serial_id FROM stock_movements
      WHERE user_id=$1 AND product_id=$2 AND movement_type='PURCHASE'`, [USER_A, p])).rows;
  assert.strictEqual(rows.length, 1, 'one movement, not five');
  assert.strictEqual(rows[0].q, 5);
  assert.strictEqual(rows[0].serial_id, null, 'and nothing to name');
});

test('S29 serial_tracking is a product setting the owner can change', async () => {
  const p = await mkProduct(USER_A, 'ToggleMe', { serial: false });
  const on = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_A, body: { serial_tracking: true } });
  assert.strictEqual(on.status, 200, msg(on));
  const { rows } = await db.query('SELECT serial_tracking FROM products WHERE id=$1', [p]);
  assert.strictEqual(rows[0].serial_tracking, true);

  // And another tenant cannot flip it.
  const theirs = await api('PATCH', `/api/products?eq_id=${p}`,
    { token: TOKEN_B, body: { serial_tracking: false } });
  assert.strictEqual(theirs.body.length, 0, 'no row of A was updated by B');
});
