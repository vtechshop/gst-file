// Product-wise monthly sales quantity.
//
// "In August, how many of each machine did we sell." One row per PRODUCT —
// not per invoice, not per line — counted from the invoices themselves.
//
// The three things that make this report easy to get wrong, and which each
// have a case below:
//
//   the period      a sale belongs to its invoice's month; a RETURN belongs
//                   to the month of the return, not of the sale it reverses
//   the identity    invoice_items ids are regenerated on every save, so
//                   grouping must be by product, and one product must
//                   produce exactly one row however many lines or invoices
//                   it appears on
//   the state       an edited invoice reports its CURRENT lines, never the
//                   sum of what it used to say
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('product sales report (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'product-sales-test-secret';

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
const P = {};   // product name -> id, for tenant A

// `token: null` means "send no Authorization header" — not the same as
// omitting the option, and the auth case depends on it.
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

const report = async (q, token = TOKEN_A) => {
  const r = await api('GET', '/api/reports/product-sales?' + q, { token });
  assert.strictEqual(r.status, 200, msg(r));
  return r.body;
};
// The row for one product, by displayed name.
const row = (rep, name) => rep.products.find(p => p.product_name === name);

// ── Fixtures written straight to the tables ───────────────────────────
// The point of every case here is the AGGREGATION, so the documents are
// inserted directly rather than through the save path — going through it
// would be testing the save path, and would drag stock, serials and
// numbering into a report test.
let invSeq = 0, retSeq = 0;

async function mkProduct(userId, name, sku, unit = 'PCS') {
  const { rows } = await db.query(
    `INSERT INTO products (user_id, name, sku, hsn_code, unit, gst_percentage, stock)
     VALUES ($1,$2,$3,'84388090',$4,18,0) RETURNING id`, [userId, name, sku, unit]);
  return rows[0].id;
}

// One invoice with its lines. `type` picks the table, which is also what
// makes it B2B or B2C.
async function mkInvoice(userId, { type = 'b2b', date, lines }) {
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const taxable = lines.reduce((t, l) => t + l.qty * 100, 0);
  const { rows } = await db.query(
    `INSERT INTO ${table} (user_id, customer_name, gst_number, invoice_number, invoice_date,
       supply_type, taxable_amount, gst_percentage, gst_amount, cgst, sgst, igst, total_amount)
     VALUES ($1,'Cust','29AABCU9603R1ZJ',$2,$3,'intrastate',$4,18,$5,$6,$6,0,$7)
     RETURNING id`,
    [userId, 'INV-' + (++invSeq), date, taxable, taxable * 0.18, taxable * 0.09, taxable * 1.18]);
  const id = rows[0].id;
  for (const [i, l] of lines.entries()) {
    await db.query(
      `INSERT INTO invoice_items (user_id, invoice_id, invoice_type, product_id, product_name,
         hsn_code, unit, quantity, rate, gst_percentage, taxable_value, gst_amount, total_amount, sort_order)
       VALUES ($1,$2,$3,$4,$5,'84388090',$6,$7,100,18,$8,$9,$10,$11)`,
      [userId, id, type, l.product_id === undefined ? null : l.product_id, l.name,
        l.unit || 'PCS', l.qty, l.qty * 100, l.qty * 18, l.qty * 118, i]);
  }
  return id;
}

async function mkReturn(userId, { type = 'b2b', date, invoiceId, lines }) {
  const taxable = lines.reduce((t, l) => t + l.qty * 100, 0);
  const { rows } = await db.query(
    `INSERT INTO sales_returns (user_id, original_invoice_id, original_invoice_type,
       customer_name, return_number, return_date, taxable_amount, gst_percentage,
       gst_amount, total_amount, supply_type, cgst, sgst, igst)
     VALUES ($1,$2,$3,'Cust',$4,$5,$6,18,$7,$8,'intrastate',$9,$9,0) RETURNING id`,
    [userId, invoiceId, type, 'SR-' + (++retSeq), date, taxable,
      taxable * 0.18, taxable * 1.18, taxable * 0.09]);
  const id = rows[0].id;
  for (const l of lines) {
    await db.query(
      `INSERT INTO sales_return_items (user_id, return_id, product_id, product_name,
         hsn_code, unit, quantity, rate, gst_percentage, taxable_value, gst_amount, total_amount)
       VALUES ($1,$2,$3,$4,'84388090',$5,$6,100,18,$7,$8,$9)`,
      [userId, id, l.product_id === undefined ? null : l.product_id, l.name,
        l.unit || 'PCS', l.qty, l.qty * 100, l.qty * 18, l.qty * 118]);
  }
  return id;
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('psr-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('psr-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) {
    await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
  }
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });

  P.A = await mkProduct(USER_A, 'Chapathi Press Machine', 'CP-01');
  P.B = await mkProduct(USER_A, 'Dough Kneader 10 KG', 'DK-10');
  P.C = await mkProduct(USER_A, 'Mixer Grinder 3 HP', 'MG-03');

  // ── The mandatory dataset ──
  // A: January 5, February 8, August 20 (11 B2B + 9 B2C, over three invoices)
  await mkInvoice(USER_A, { date: '2026-01-14', lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 5 }] });
  await mkInvoice(USER_A, { date: '2026-02-09', lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 8 }] });
  // August, split so the multi-invoice and B2B/B2C cases share one dataset:
  //   B2B 3 + B2B 8 = 11,  B2C 9  ->  20
  await mkInvoice(USER_A, { type: 'b2b', date: '2026-08-03', lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 3 }] });
  await mkInvoice(USER_A, { type: 'b2b', date: '2026-08-11', lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 8 }] });
  await mkInvoice(USER_A, { type: 'b2c', date: '2026-08-19', lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 9 }] });

  // B: August 12, on one invoice that also carries A — proving the invoice
  // itself is never counted as a quantity.
  const multi = await mkInvoice(USER_A, {
    date: '2026-08-21',
    lines: [{ product_id: P.B, name: 'Dough Kneader 10 KG', qty: 12 }]
  });

  // C: August 5, as TWO lines of the same product on ONE invoice (2 + 3).
  await mkInvoice(USER_A, {
    date: '2026-08-25',
    lines: [
      { product_id: P.C, name: 'Mixer Grinder 3 HP', qty: 2 },
      { product_id: P.C, name: 'Mixer Grinder 3 HP', qty: 3 }
    ]
  });

  // Returns: A returned 2 in August; C returned 1 in SEPTEMBER.
  await mkReturn(USER_A, { date: '2026-08-28', invoiceId: multi, lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 2 }] });
  await mkReturn(USER_A, { date: '2026-09-04', invoiceId: multi, lines: [{ product_id: P.C, name: 'Mixer Grinder 3 HP', qty: 1 }] });

  // Tenant B sells the SAME product name in the same month, at a very
  // different quantity, so a leak would be unmistakable.
  const bProduct = await mkProduct(USER_B, 'Chapathi Press Machine', 'CP-01');
  await mkInvoice(USER_B, { date: '2026-08-15', lines: [{ product_id: bProduct, name: 'Chapathi Press Machine', qty: 50 }] });

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// ═══ The headline case ════════════════════════════════════════════════

test('R1 MANDATORY August 2026 - one row per product, with the expected quantities', async () => {
  const rep = await report('year=2026&month=8');

  assert.strictEqual(rep.products.length, 3, 'exactly three products sold in August');
  const a = row(rep, 'Chapathi Press Machine');
  const b = row(rep, 'Dough Kneader 10 KG');
  const c = row(rep, 'Mixer Grinder 3 HP');

  assert.strictEqual(a.sold_qty, 20, 'A: 3 + 8 + 9 across three invoices');
  assert.strictEqual(a.return_qty, 2);
  assert.strictEqual(a.net_qty, 18);

  assert.strictEqual(b.sold_qty, 12);
  assert.strictEqual(b.return_qty, 0);
  assert.strictEqual(b.net_qty, 12);

  // C's September return must NOT reduce August.
  assert.strictEqual(c.sold_qty, 5, 'two lines of the same product on one invoice: 2 + 3');
  assert.strictEqual(c.return_qty, 0, 'the September return belongs to September');
  assert.strictEqual(c.net_qty, 5);

  // SKU and unit come through for the report to be readable.
  assert.strictEqual(a.sku, 'CP-01');
  assert.strictEqual(a.unit, 'PCS');
});

test('R2 January and February sales stay out of August', async () => {
  const aug = await report('year=2026&month=8');
  assert.strictEqual(row(aug, 'Chapathi Press Machine').sold_qty, 20);

  const jan = await report('year=2026&month=1');
  assert.strictEqual(jan.products.length, 1);
  assert.strictEqual(row(jan, 'Chapathi Press Machine').sold_qty, 5);

  const feb = await report('year=2026&month=2');
  assert.strictEqual(row(feb, 'Chapathi Press Machine').sold_qty, 8);

  // July has nothing at all.
  const jul = await report('year=2026&month=7');
  assert.strictEqual(jul.products.length, 0);
  assert.strictEqual(jul.summary.sold_qty, 0);

  // ...and neither does August of the previous year.
  const aug25 = await report('year=2025&month=8');
  assert.strictEqual(aug25.products.length, 0);
});

test('R3 a return is counted in the month it was RETURNED', async () => {
  const sep = await report('year=2026&month=9');
  const c = row(sep, 'Mixer Grinder 3 HP');
  assert.ok(c, 'a product with only a return in the period must still appear');
  assert.strictEqual(c.sold_qty, 0, 'nothing was sold in September');
  assert.strictEqual(c.return_qty, 1);
  assert.strictEqual(c.net_qty, -1, 'reported as it is, not clamped to zero');
  assert.strictEqual(c.negative_net, true, 'and flagged as the anomaly it is');
  assert.strictEqual(sep.summary.negative_rows, 1);
});

// ═══ B2B / B2C ════════════════════════════════════════════════════════

test('R4 MANDATORY the B2B and B2C splits add back to the total', async () => {
  const all = await report('year=2026&month=8&category=all');
  const b2b = await report('year=2026&month=8&category=b2b');
  const b2c = await report('year=2026&month=8&category=b2c');

  const qa = (rep) => (row(rep, 'Chapathi Press Machine') || { sold_qty: 0 }).sold_qty;
  assert.strictEqual(qa(all), 20);
  assert.strictEqual(qa(b2b), 11, '3 + 8');
  assert.strictEqual(qa(b2c), 9);
  assert.strictEqual(qa(b2b) + qa(b2c), qa(all));

  // A B2C-only report must not carry the B2B-only products at all.
  assert.strictEqual(row(b2c, 'Dough Kneader 10 KG'), undefined);
});

// ═══ Grouping and edits ═══════════════════════════════════════════════

test('R5 MANDATORY one product appears exactly once, however many lines', async () => {
  const rep = await report('year=2026&month=8');
  for (const name of ['Chapathi Press Machine', 'Dough Kneader 10 KG', 'Mixer Grinder 3 HP']) {
    assert.strictEqual(rep.products.filter(p => p.product_name === name).length, 1, name);
  }
  // ...and the keys themselves are unique, which is the invariant behind it.
  const keys = rep.products.map(p => p.group_key);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('R6 MANDATORY an edited invoice reports its current lines, never the sum', async () => {
  const id = await mkInvoice(USER_A, {
    date: '2026-10-06', lines: [{ product_id: P.A, name: 'Chapathi Press Machine', qty: 5 }]
  });
  let rep = await report('year=2026&month=10');
  assert.strictEqual(row(rep, 'Chapathi Press Machine').sold_qty, 5);

  // What save-with-items does: delete the lines and write them again, with
  // NEW ids. Nothing may carry over from the old ones.
  await db.query('DELETE FROM invoice_items WHERE invoice_id = $1 AND user_id = $2', [id, USER_A]);
  await db.query(
    `INSERT INTO invoice_items (user_id, invoice_id, invoice_type, product_id, product_name,
       hsn_code, unit, quantity, rate, gst_percentage, taxable_value, gst_amount, total_amount, sort_order)
     VALUES ($1,$2,'b2b',$3,'Chapathi Press Machine','84388090','PCS',8,100,18,800,144,944,0)`,
    [USER_A, id, P.A]);

  rep = await report('year=2026&month=10');
  assert.strictEqual(row(rep, 'Chapathi Press Machine').sold_qty, 8, 'the current line, not 5 + 8');

  await db.query('DELETE FROM invoice_items WHERE invoice_id = $1', [id]);
  await db.query('DELETE FROM b2b_invoices WHERE id = $1', [id]);
});

test('R7 a deleted invoice stops counting', async () => {
  const id = await mkInvoice(USER_A, {
    date: '2026-11-02', lines: [{ product_id: P.B, name: 'Dough Kneader 10 KG', qty: 7 }]
  });
  assert.strictEqual(row(await report('year=2026&month=11'), 'Dough Kneader 10 KG').sold_qty, 7);

  // The cascade delete the app performs: lines first, then the header.
  await db.query('DELETE FROM invoice_items WHERE invoice_id = $1', [id]);
  await db.query('DELETE FROM b2b_invoices WHERE id = $1', [id]);

  const rep = await report('year=2026&month=11');
  assert.strictEqual(rep.products.length, 0, 'a deleted invoice is not a sale');
});

test('R8 a line whose product was deleted still reports, grouped by name', async () => {
  const gone = await mkProduct(USER_A, 'Discontinued Slicer', 'DS-99');
  const id = await mkInvoice(USER_A, {
    date: '2026-12-03', lines: [{ product_id: gone, name: 'Discontinued Slicer', qty: 4 }]
  });
  // ON DELETE SET NULL: the line survives with product_id NULL.
  await db.query('DELETE FROM products WHERE id = $1', [gone]);

  const rep = await report('year=2026&month=12');
  const r = row(rep, 'Discontinued Slicer');
  assert.ok(r, 'the sale still happened and must still be reported');
  assert.strictEqual(r.sold_qty, 4);
  assert.strictEqual(r.product_id, null);
  assert.strictEqual(r.sku, '', 'no master row, so no SKU');

  await db.query('DELETE FROM invoice_items WHERE invoice_id = $1', [id]);
  await db.query('DELETE FROM b2b_invoices WHERE id = $1', [id]);
});

// ═══ Sorting ══════════════════════════════════════════════════════════

test('R9 MANDATORY sorting reorders rows and never changes a quantity', async () => {
  const qty = (rep) => rep.products.map(p => [p.product_name, p.sold_qty]);

  const high = await report('year=2026&month=8&sort=qty_desc');
  assert.deepStrictEqual(high.products.map(p => p.sold_qty), [20, 12, 5]);
  assert.strictEqual(high.products[0].product_name, 'Chapathi Press Machine');

  const low = await report('year=2026&month=8&sort=qty_asc');
  assert.deepStrictEqual(low.products.map(p => p.sold_qty), [5, 12, 20]);

  const az = await report('year=2026&month=8&sort=name_asc');
  assert.deepStrictEqual(az.products.map(p => p.product_name),
    ['Chapathi Press Machine', 'Dough Kneader 10 KG', 'Mixer Grinder 3 HP']);

  const za = await report('year=2026&month=8&sort=name_desc');
  assert.deepStrictEqual(za.products.map(p => p.product_name),
    ['Mixer Grinder 3 HP', 'Dough Kneader 10 KG', 'Chapathi Press Machine']);

  // Same figures throughout, only the order moved.
  const asMap = (rep) => Object.fromEntries(qty(rep));
  assert.deepStrictEqual(asMap(low), asMap(high));
  assert.deepStrictEqual(asMap(az), asMap(high));
  assert.deepStrictEqual(asMap(za), asMap(high));

  // Sl.no. is the position in the sheet, so it renumbers with the order.
  assert.deepStrictEqual(high.products.map(p => p.sl_no), [1, 2, 3]);
  assert.deepStrictEqual(low.products.map(p => p.sl_no), [1, 2, 3]);
});

// ═══ Search ═══════════════════════════════════════════════════════════

test('R10 search matches product name or SKU, server-side', async () => {
  const byName = await report('year=2026&month=8&search=kneader');
  assert.strictEqual(byName.products.length, 1);
  assert.strictEqual(byName.products[0].product_name, 'Dough Kneader 10 KG');

  const bySku = await report('year=2026&month=8&search=MG-03');
  assert.strictEqual(bySku.products.length, 1);
  assert.strictEqual(bySku.products[0].product_name, 'Mixer Grinder 3 HP');

  const none = await report('year=2026&month=8&search=nothing-matches-this');
  assert.strictEqual(none.products.length, 0);

  // The summary describes the filtered table, not the whole month.
  assert.strictEqual(byName.summary.products, 1);
  assert.strictEqual(byName.summary.sold_qty, 12);
});

test('R11 a search containing SQL or LIKE metacharacters is harmless', async () => {
  for (const q of ["%", "_", "100%", "'; DROP TABLE invoice_items; --", "a\\b"]) {
    const r = await api('GET', '/api/reports/product-sales?year=2026&month=8&search=' + encodeURIComponent(q),
      { token: TOKEN_A });
    assert.strictEqual(r.status, 200, msg(r));
    // A bare wildcard must not match everything — it is searched for as text.
    if (q === '%' || q === '_') assert.strictEqual(r.body.products.length, 0, `"${q}" must be literal`);
  }
  // The table is still there.
  const still = await report('year=2026&month=8');
  assert.strictEqual(still.products.length, 3);
});

// ═══ Summary ══════════════════════════════════════════════════════════

test('R12 the summary equals the table underneath it', async () => {
  const rep = await report('year=2026&month=8');
  assert.strictEqual(rep.summary.products, 3);
  assert.strictEqual(rep.summary.sold_qty, 37, '20 + 12 + 5');
  assert.strictEqual(rep.summary.return_qty, 2);
  assert.strictEqual(rep.summary.net_qty, 35);
  // ...and is genuinely derived from the rows, not computed twice.
  assert.strictEqual(rep.summary.sold_qty, rep.products.reduce((t, p) => t + p.sold_qty, 0));
  assert.strictEqual(rep.summary.net_qty, rep.products.reduce((t, p) => t + p.net_qty, 0));
});

test('R13 a whole year adds the months together', async () => {
  const yr = await report('year=2026&month=all');
  const a = row(yr, 'Chapathi Press Machine');
  assert.strictEqual(a.sold_qty, 33, 'Jan 5 + Feb 8 + Aug 20');
  assert.strictEqual(a.return_qty, 2);
  assert.strictEqual(a.net_qty, 31);
});

// ═══ Tenant isolation and auth ════════════════════════════════════════

test('R14 MANDATORY one tenant never sees another tenant\'s quantities', async () => {
  const a = await report('year=2026&month=8', TOKEN_A);
  assert.strictEqual(row(a, 'Chapathi Press Machine').sold_qty, 20, 'never 70');

  const b = await report('year=2026&month=8', TOKEN_B);
  assert.strictEqual(row(b, 'Chapathi Press Machine').sold_qty, 50);
  assert.strictEqual(b.products.length, 1, 'B sold one product; A\'s other two are not B\'s');

  // The identically-named product is a different row in each report.
  assert.notStrictEqual(row(a, 'Chapathi Press Machine').product_id,
    row(b, 'Chapathi Press Machine').product_id);
});

test('R15 the report is authenticated, and takes no tenant from the caller', async () => {
  const anon = await api('GET', '/api/reports/product-sales?year=2026&month=8', { token: null });
  assert.strictEqual(anon.status, 401, msg(anon));
  const bad = await api('GET', '/api/reports/product-sales?year=2026&month=8', { token: 'not-a-token' });
  assert.strictEqual(bad.status, 401, msg(bad));

  // A user_id in the query string is ignored: B asking for A's id gets B's
  // own figures, because the id comes from the token.
  const spoof = await api('GET',
    `/api/reports/product-sales?year=2026&month=8&user_id=${USER_A}&tenant_id=${USER_A}`,
    { token: TOKEN_B });
  assert.strictEqual(spoof.status, 200, msg(spoof));
  assert.strictEqual(spoof.body.products.length, 1);
  assert.strictEqual(spoof.body.products[0].sold_qty, 50, 'B\'s own figures, not A\'s');
});

// ═══ Parameter validation ═════════════════════════════════════════════

test('R16 bad parameters are refused, not guessed at', async () => {
  const cases = [
    ['year=abcd&month=8', /year/i],
    ['year=1999&month=8', /year/i],
    ['month=8', /year/i],
    ['year=2026&month=13', /month/i],
    ['year=2026&month=0', /month/i],
    ['year=2026&month=8&category=b2x', /category/i],
    ['year=2026&month=8&sort=qty', /sort/i],
    ['year=2026&month=8&sort=sold_qty%3B+DROP', /sort/i]
  ];
  for (const [q, wanted] of cases) {
    const r = await api('GET', '/api/reports/product-sales?' + q, { token: TOKEN_A });
    assert.strictEqual(r.status, 400, q + ' must be refused: ' + msg(r));
    assert.match(msg(r), wanted);
  }
});

// ═══ Shape the sheet depends on ═══════════════════════════════════════

test('R17 quantities arrive as JSON numbers, labels as strings', async () => {
  const rep = await report('year=2026&month=8');
  for (const p of rep.products) {
    for (const k of ['sl_no', 'sold_qty', 'return_qty', 'net_qty', 'invoice_count']) {
      assert.strictEqual(typeof p[k], 'number', `${k} must be a number for Excel to sum it`);
    }
    for (const k of ['product_name', 'sku', 'unit']) {
      assert.strictEqual(typeof p[k], 'string', `${k} must be text`);
    }
  }
  // Invoice count is the optional column, and counts INVOICES not lines:
  // A sold on three August invoices, C on one (as two lines).
  assert.strictEqual(row(rep, 'Chapathi Press Machine').invoice_count, 3);
  assert.strictEqual(row(rep, 'Mixer Grinder 3 HP').invoice_count, 1);
});

test('R18 the whole period is returned, never a first page', async () => {
  // Forty products in one month: every one of them must come back, and the
  // summary must agree with the rows.
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(await mkProduct(USER_A, `Bulk Product ${String(i).padStart(2, '0')}`, `BP-${i}`));
  const inv = await mkInvoice(USER_A, {
    date: '2027-03-05',
    lines: ids.map((id, i) => ({ product_id: id, name: `Bulk Product ${String(i).padStart(2, '0')}`, qty: i + 1 }))
  });

  const rep = await report('year=2027&month=3');
  assert.strictEqual(rep.products.length, 40, 'all forty, not the first 20 or 25');
  assert.strictEqual(rep.summary.products, 40);
  assert.strictEqual(rep.summary.sold_qty, 820, '1 + 2 + ... + 40');

  await db.query('DELETE FROM invoice_items WHERE invoice_id = $1', [inv]);
  await db.query('DELETE FROM b2b_invoices WHERE id = $1', [inv]);
  await db.query('DELETE FROM products WHERE id = ANY($1)', [ids]);
});

// ═══ The stock tables are NOT the source ══════════════════════════════

test('R19 the report reads invoices, not the stock tables', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
  const fn = src.slice(src.indexOf("router.get('/product-sales'"), src.indexOf("router.post('/workbook'"));
  const code = fn.replace(/--[^\n]*/g, '').replace(/\/\/[^\n]*/g, '');
  for (const t of ['stock_balances', 'stock_movements', 'stock_serials', 'products.stock']) {
    assert.ok(!code.includes(t), `the quantity must not come from ${t}`);
  }
  assert.ok(code.includes('invoice_items'), 'sales come from the invoice lines');
  assert.ok(code.includes('sales_return_items'), 'returns come from the return lines');
  // Grouping never touches a line id, which save-with-items regenerates.
  assert.ok(!/GROUP BY[^\n]*ii\.id/.test(code), 'must not group by an invoice_item id');
});
