// The stock module through its real HTTP surface.
//
// stock-ledger-integration.test.js proves the helper. This proves the app:
// the routes as mounted, behind the real auth middleware, with the real
// document endpoints doing the stock arithmetic. It is the only place that
// can show a rejected sale rolling back the INVOICE as well as the stock,
// and the only place that can show PATCH /api/products refusing to set a
// balance.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('stock API integration (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'stock-test-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

// src/app.js is an entry point, not a module: it calls app.listen() itself
// and exports nothing. So the real server is started as a child process
// against the scratch database, which also means these tests exercise it
// exactly as production runs it rather than a re-wired copy of it.
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
    const done = setTimeout(() => reject(new Error('server did not start:\n' + out)), 25000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(done); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

let server, base, db;
let USER_A, USER_B, TOKEN_A, TOKEN_B;

const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

// The API's error envelope is { error: { message, code, requestId } }.
const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';

async function mkProduct(userId, name, unit = 'PCS') {
  const { rows } = await db.query(
    `INSERT INTO products (user_id, name, hsn_code, unit, gst_percentage, stock)
     VALUES ($1,$2,'84388090',$3,18,NULL) RETURNING id`, [userId, name, unit]);
  return rows[0].id;
}
async function stockOf(id) {
  const { rows } = await db.query('SELECT stock FROM products WHERE id=$1', [id]);
  return rows[0].stock === null ? null : +rows[0].stock;
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  const a = await db.query(`INSERT INTO users (email,password_hash) VALUES ($1,'x') RETURNING id`,
    [`api-a-${Date.now()}@test.invalid`]);
  const b = await db.query(`INSERT INTO users (email,password_hash) VALUES ($1,'x') RETURNING id`,
    [`api-b-${Date.now()}@test.invalid`]);
  USER_A = a.rows[0].id; USER_B = b.rows[0].id;
  TOKEN_A = tok(USER_A); TOKEN_B = tok(USER_B);
  const port = await freePort();
  server = await startServer(port);
  base = 'http://127.0.0.1:' + port;
});

test.after(async () => {
  await db.query('DELETE FROM stock_movements WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await db.query('DELETE FROM invoice_items WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await db.query('DELETE FROM b2b_invoices WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await db.query('DELETE FROM products WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
  await db.end();
  if (server) { server.kill(); await new Promise(r => server.on('exit', r)); }
});

// ── Auth ──────────────────────────────────────────────────────────────
test('A1 every stock route requires authentication', async () => {
  for (const [m, u] of [
    ['GET', '/api/stock'], ['GET', '/api/stock/stats'], ['GET', '/api/stock/movements'],
    ['POST', '/api/stock/opening'], ['POST', '/api/stock/adjustment']
  ]) {
    // fetch refuses a body on GET, so only the POSTs carry one.
    const r = await api(m, u, m === 'POST' ? { body: {} } : {});
    assert.strictEqual(r.status, 401, `${m} ${u} must be 401 without a token`);
  }
  // ...and a token signed with the wrong secret is not a token.
  const forged = jwt.sign({ sub: USER_A }, 'not-the-secret');
  const r = await api('GET', '/api/stock', { token: forged });
  assert.strictEqual(r.status, 401, 'a forged token must be refused');
});

// ── Direct stock writes are refused ───────────────────────────────────
test('A2 PATCH /api/products cannot set a stock balance', async () => {
  const p = await mkProduct(USER_A, 'Guarded Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 10 } });
  assert.strictEqual(await stockOf(p), 10);

  const r = await api('PATCH', `/api/products?id=eq.${p}`, {
    token: TOKEN_A, body: { stock: 9999 }
  });
  assert.strictEqual(r.status, 400, 'the write must be refused, not silently ignored');
  assert.match(msg(r), /stock cannot be set directly/i);
  assert.strictEqual(await stockOf(p), 10, 'the balance must be unchanged');

  // ...while an ordinary product edit still works, including reorder_level
  const ok = await api('PATCH', `/api/products?id=eq.${p}`, {
    token: TOKEN_A, body: { name: 'Guarded Product v2', reorder_level: 4 }
  });
  assert.strictEqual(ok.status, 200, 'legitimate product updates must still work');
  const { rows } = await db.query('SELECT name, reorder_level FROM products WHERE id=$1', [p]);
  assert.strictEqual(rows[0].name, 'Guarded Product v2');
  assert.strictEqual(+rows[0].reorder_level, 4);
});

test('A3 stock is still readable, filterable and orderable', async () => {
  const r = await api('GET', '/api/products?select=id,name,stock,reorder_level&order=stock.desc', { token: TOKEN_A });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(Object.prototype.hasOwnProperty.call(r.body[0], 'stock'),
    'removing stock from writes must not remove it from reads');
});

// ── Opening balance ───────────────────────────────────────────────────
test('A4 opening balance is once per product', async () => {
  const p = await mkProduct(USER_A, 'Opened Product');
  const first = await api('POST', '/api/stock/opening', {
    token: TOKEN_A, body: { product_id: p, quantity: 10, rate: 40000 } });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(+first.body.stock, 10);

  const second = await api('POST', '/api/stock/opening', {
    token: TOKEN_A, body: { product_id: p, quantity: 5 } });
  assert.strictEqual(second.status, 400, 'a second opening must be refused');
  assert.match(msg(second), /already has stock movements/i);
  assert.strictEqual(await stockOf(p), 10);

  const bad = await api('POST', '/api/stock/opening', {
    token: TOKEN_A, body: { product_id: p, quantity: -1 } });
  assert.strictEqual(bad.status, 400);
});

// ── Adjustments and the other manual movements ────────────────────────
test('A5 adjustments require a reason and move stock both ways', async () => {
  const p = await mkProduct(USER_A, 'Adjusted Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 20 } });

  const noReason = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'ADJUSTMENT_OUT', quantity: 2 } });
  assert.strictEqual(noReason.status, 400);
  assert.match(msg(noReason), /reason is required/i);

  const down = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A,
    body: { product_id: p, movement_type: 'ADJUSTMENT_OUT', quantity: 2, reason: 'Physical count' } });
  assert.strictEqual(down.status, 201);
  assert.strictEqual(+down.body.stock, 18);

  const dmg = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'DAMAGE', quantity: 3, reason: 'Water damage' } });
  assert.strictEqual(+dmg.body.stock, 15);

  const badType = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'TRANSFER_IN', quantity: 1, reason: 'x' } });
  assert.strictEqual(badType.status, 400, 'a deferred movement type must not be accepted');

  const over = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'SCRAP', quantity: 999, reason: 'too much' } });
  assert.strictEqual(over.status, 400);
  assert.match(msg(over), /Insufficient Stock/);
  assert.strictEqual(await stockOf(p), 15, 'a refused adjustment changes nothing');
});

// ── The reporting surface ─────────────────────────────────────────────
test('A6 summary, ledger, movements and reconciliation all agree', async () => {
  const p = await mkProduct(USER_A, 'Reported Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 10 } });
  await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'ADJUSTMENT_IN', quantity: 5, reason: 'found' } });
  await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'DAMAGE', quantity: 3, reason: 'broken' } });

  const one = await api('GET', `/api/stock/${p}`, { token: TOKEN_A });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(+one.body.product.stock, 12);
  assert.strictEqual(+one.body.reconciliation.ledger_balance, 12);
  assert.strictEqual(+one.body.reconciliation.difference, 0);
  assert.strictEqual(one.body.reconciliation.status, 'RECONCILED');
  assert.strictEqual(one.body.reconciliation.movement_count, 3);

  const led = await api('GET', `/api/stock/${p}/ledger`, { token: TOKEN_A });
  assert.strictEqual(led.body.total, 3);
  assert.deepStrictEqual(led.body.rows.map(r => r.movement_type),
    ['OPENING', 'ADJUSTMENT_IN', 'DAMAGE'], 'ledger reads oldest first');
  assert.deepStrictEqual(led.body.rows.map(r => +r.balance_after), [10, 15, 12],
    'the running balance is recorded, not recomputed in the browser');

  const mv = await api('GET', `/api/stock/movements?product_id=${p}&movement_type=DAMAGE`, { token: TOKEN_A });
  assert.strictEqual(mv.body.total, 1);
  assert.strictEqual(mv.body.rows[0].reason, 'broken');
  assert.strictEqual(mv.body.rows[0].product_name, 'Reported Product');

  const badFilter = await api('GET', '/api/stock/movements?movement_type=NONSENSE', { token: TOKEN_A });
  assert.strictEqual(badFilter.status, 400);
});

test('A7 status classification and the low/out reports', async () => {
  const p = await mkProduct(USER_A, 'Classified Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 10 } });
  await api('PATCH', `/api/products?id=eq.${p}`, { token: TOKEN_A, body: { reorder_level: 5 } });

  const inStock = await api('GET', `/api/stock/${p}`, { token: TOKEN_A });
  assert.strictEqual(inStock.body.product.status, 'IN_STOCK');

  await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'CONSUMPTION', quantity: 6, reason: 'internal use' } });
  const low = await api('GET', `/api/stock/${p}`, { token: TOKEN_A });
  assert.strictEqual(+low.body.product.stock, 4);
  assert.strictEqual(low.body.product.status, 'LOW_STOCK', '4 <= reorder level 5');

  const lowList = await api('GET', '/api/stock?status=LOW_STOCK', { token: TOKEN_A });
  assert.ok(lowList.body.rows.some(r => r.id === p), 'and it appears in the Low Stock report');

  await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'SAMPLE', quantity: 4, reason: 'demo unit' } });
  const out = await api('GET', `/api/stock/${p}`, { token: TOKEN_A });
  assert.strictEqual(out.body.product.status, 'OUT_OF_STOCK');
  const outList = await api('GET', '/api/stock?status=OUT_OF_STOCK', { token: TOKEN_A });
  assert.ok(outList.body.rows.some(r => r.id === p));

  const badStatus = await api('GET', '/api/stock?status=BANANA', { token: TOKEN_A });
  assert.strictEqual(badStatus.status, 400);
});

test('A8 an untracked product stays out of the stock reports', async () => {
  const p = await mkProduct(USER_A, 'Service Line');
  const list = await api('GET', '/api/stock?limit=500', { token: TOKEN_A });
  assert.ok(!list.body.rows.some(r => r.id === p),
    'products.stock IS NULL means not tracked, and the summary honours that');
  const one = await api('GET', `/api/stock/${p}`, { token: TOKEN_A });
  assert.strictEqual(one.body.reconciliation.status, 'NOT_TRACKED');

  const adj = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_A, body: { product_id: p, movement_type: 'DAMAGE', quantity: 1, reason: 'x' } });
  assert.strictEqual(adj.status, 400);
  assert.match(msg(adj), /not stock-tracked/i);
});

// ── Tenant isolation, over HTTP ───────────────────────────────────────
test('A9 one tenant cannot read or move another tenant stock', async () => {
  const p = await mkProduct(USER_A, 'Private Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 10 } });

  const read = await api('GET', `/api/stock/${p}`, { token: TOKEN_B });
  assert.strictEqual(read.status, 404, 'B must not be able to read A stock');

  const ledger = await api('GET', `/api/stock/${p}/ledger`, { token: TOKEN_B });
  assert.strictEqual(ledger.body.total, 0, 'nor A ledger');

  const open = await api('POST', '/api/stock/opening', { token: TOKEN_B, body: { product_id: p, quantity: 5 } });
  assert.strictEqual(open.status, 404);

  const adj = await api('POST', '/api/stock/adjustment', {
    token: TOKEN_B, body: { product_id: p, movement_type: 'ADJUSTMENT_OUT', quantity: 5, reason: 'theft' } });
  assert.strictEqual(adj.status, 404);

  const patch = await api('PATCH', `/api/products?id=eq.${p}`, { token: TOKEN_B, body: { name: 'hijacked' } });
  assert.strictEqual(patch.body.length, 0, 'and cannot edit the product either');

  assert.strictEqual(await stockOf(p), 10, 'A stock is untouched throughout');
  const summaryB = await api('GET', '/api/stock?limit=500', { token: TOKEN_B });
  assert.ok(!summaryB.body.rows.some(r => r.id === p), 'and it never appears in B summary');
});

// ── A real invoice: stock out, rollback, idempotency ──────────────────
async function saveInvoice(token, items, editId) {
  return api('POST', '/api/invoices/b2b/save-with-items', {
    token,
    body: {
      editId,
      header: {
        gst_number: '24AAMCM2964J1Z4', customer_name: 'Stock Test Buyer',
        invoice_number: 'STK-' + Math.random().toString(36).slice(2, 9),
        invoice_date: '2026-09-07', taxable_amount: 100, gst_percentage: 18,
        gst_amount: 18, total_amount: 118, supply_type: 'intrastate', cgst: 9, sgst: 9
      },
      items
    }
  });
}

test('A10 a finalised invoice takes stock out and records why', async () => {
  const p = await mkProduct(USER_A, 'Sold Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 10 } });

  const r = await saveInvoice(TOKEN_A, [{
    product_id: p, product_name: 'Sold Product', hsn_code: '84388090', unit: 'PCS',
    quantity: 3, rate: 100, gst_percentage: 18, taxable_value: 300, total_amount: 354
  }]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await stockOf(p), 7, '10 - 3');

  const one = await api('GET', `/api/stock/${p}`, { token: TOKEN_A });
  assert.strictEqual(one.body.reconciliation.status, 'RECONCILED');
  const mv = await api('GET', `/api/stock/movements?product_id=${p}&movement_type=SALE`, { token: TOKEN_A });
  assert.strictEqual(mv.body.total, 1);
  assert.strictEqual(mv.body.rows[0].source_type, 'b2b');
  assert.strictEqual(mv.body.rows[0].source_id, r.body.invoiceId, 'traceable to the invoice');
  assert.strictEqual(mv.body.rows[0].unit, 'PCS');

  // edit 3 -> 8: costs 5 more, not 8
  const edited = await saveInvoice(TOKEN_A, [{
    product_id: p, product_name: 'Sold Product', hsn_code: '84388090', unit: 'PCS',
    quantity: 8, rate: 100, gst_percentage: 18, taxable_value: 800, total_amount: 944
  }], r.body.invoiceId);
  assert.strictEqual(edited.status, 200);
  assert.strictEqual(await stockOf(p), 2, 'edit 3 -> 8 must cost 5 more, not 8');

  // re-save unchanged: no further effect, and no new movement
  const before = (await api('GET', `/api/stock/movements?product_id=${p}`, { token: TOKEN_A })).body.total;
  await saveInvoice(TOKEN_A, [{
    product_id: p, product_name: 'Sold Product', hsn_code: '84388090', unit: 'PCS',
    quantity: 8, rate: 100, gst_percentage: 18, taxable_value: 800, total_amount: 944
  }], r.body.invoiceId);
  assert.strictEqual(await stockOf(p), 2, 'a repeated save must not deduct again');
  const after = (await api('GET', `/api/stock/movements?product_id=${p}`, { token: TOKEN_A })).body.total;
  assert.strictEqual(after, before, 'and must not write a movement');

  // delete: gives it all back, once
  await api('POST', `/api/invoices/b2b/${r.body.invoiceId}/cascade-delete`, { token: TOKEN_A });
  assert.strictEqual(await stockOf(p), 10, 'deleting restores the whole quantity');
  await api('POST', `/api/invoices/b2b/${r.body.invoiceId}/cascade-delete`, { token: TOKEN_A });
  assert.strictEqual(await stockOf(p), 10, 'and a repeated delete reverses nothing further');
});

test('A11 an invoice beyond available stock is refused and NOTHING is saved', async () => {
  const p = await mkProduct(USER_A, 'Short Product');
  await api('POST', '/api/stock/opening', { token: TOKEN_A, body: { product_id: p, quantity: 3 } });

  const before = await db.query('SELECT COUNT(*)::int n FROM b2b_invoices WHERE user_id=$1', [USER_A]);

  const r = await saveInvoice(TOKEN_A, [{
    product_id: p, product_name: 'Short Product', hsn_code: '84388090', unit: 'PCS',
    quantity: 5, rate: 100, gst_percentage: 18, taxable_value: 500, total_amount: 590
  }]);
  assert.strictEqual(r.status, 400);
  assert.match(msg(r), /Insufficient Stock/);
  assert.match(msg(r), /Available: 3 PCS/);
  assert.match(msg(r), /Required: 5 PCS/);

  assert.strictEqual(await stockOf(p), 3, 'stock is unchanged');
  const after = await db.query('SELECT COUNT(*)::int n FROM b2b_invoices WHERE user_id=$1', [USER_A]);
  assert.strictEqual(after.rows[0].n, before.rows[0].n,
    'the invoice header must not survive a rejected save');
  const mv = await api('GET', `/api/stock/movements?product_id=${p}&movement_type=SALE`, { token: TOKEN_A });
  assert.strictEqual(mv.body.total, 0, 'and no SALE movement may be committed');
});

test('A12 stats reflect the ledger', async () => {
  const s = await api('GET', '/api/stock/stats', { token: TOKEN_A });
  assert.strictEqual(s.status, 200);
  for (const k of ['tracked_products', 'total_quantity', 'low_stock', 'out_of_stock', 'in_today', 'out_today']) {
    assert.ok(Object.prototype.hasOwnProperty.call(s.body, k), `stats must report ${k}`);
  }
  assert.ok(+s.body.in_today > 0, 'today opened balances count as stock in');
  assert.ok(+s.body.out_today > 0, 'and the damages/sales count as stock out');
});
