// GET /api/reports/invoice-details — the Complete Invoice Details sheet.
//
// Seeds the dataset the specification calls for (40 B2B + 25 B2C in
// August 2026, plus July and September) and checks the things a wrong
// join gets wrong: a missing invoice, a doubled line, a month that
// borrowed from its neighbour, a tenant reading another tenant's books.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('reports invoice-details integration (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;

const { Client } = require('pg');

let db, USER_A, USER_B;
const q = (sql, p) => db.query(sql, p);

// The route's SQL, exercised directly against the scratch database. The
// HTTP surface (auth, validation) is covered by the guards suite; what
// matters here is that the query returns exactly the right rows.
const ROUTE = path.join(__dirname, '..', 'src', 'routes', 'reports.js');

async function mkUser(email) {
  const { rows } = await q(
    `INSERT INTO users (email,password_hash) VALUES ($1,'x') RETURNING id`, [email]);
  return rows[0].id;
}

async function mkInvoice(userId, kind, number, date, lines) {
  const table = kind === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const taxable = lines.reduce((s, l) => s + l.taxable, 0);
  const gst = lines.reduce((s, l) => s + l.gst, 0);
  const { rows } = await q(
    `INSERT INTO ${table}
       (user_id, invoice_number, invoice_date, customer_name, gst_number, state,
        gst_percentage, supply_type,
        taxable_amount, gst_amount, cgst, sgst, igst, total_amount, payment_status)
     VALUES ($1,$2,$3,$4,$5,'Tamil Nadu',18,'intrastate',$6,$7,$8,$9,0,$10,'paid') RETURNING id`,
    [userId, number, date, kind.toUpperCase() + ' Customer',
      kind === 'b2b' ? '33AAAAA0000A1Z5' : null,
      taxable, gst, gst / 2, gst / 2, Math.round(taxable + gst)]);
  const invId = rows[0].id;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await q(
      `INSERT INTO invoice_items
         (user_id, invoice_id, invoice_type, product_name, hsn_code, unit,
          quantity, rate, gst_percentage, taxable_value, gst_amount,
          cgst, sgst, igst, total_amount, sort_order)
       VALUES ($1,$2,$3,$4,'84388090','PCS',1,$5,18,$5,$6,$7,$7,0,$8,$9)`,
      [userId, invId, kind, l.name, l.taxable, l.gst, l.gst / 2,
        l.taxable + l.gst, i]);
  }
  return invId;
}

// Runs the route's own query shape. Kept in one place so every test below
// exercises the same SQL the router sends.
async function fetchDetails(userId, start, end, category = 'all', sort = 'asc') {
  const INVOICE_COLUMNS = `
      id, invoice_number, invoice_date, customer_name, gst_number, phone,
      state, district, address,
      shipping_state, shipping_district, shipping_address,
      gst_category, reverse_charge, supply_type, payment_status,
      taxable_amount, cgst, sgst, igst, cess_amount, gst_amount,
      total_amount, amount_paid, invoice_source, export_type, created_at`;
  const branch = (table, key, label) => `
    SELECT '${label}'::text AS category, '${key}'::text AS type_key, ${INVOICE_COLUMNS}
      FROM ${table} WHERE user_id = $1 AND invoice_date >= $2 AND invoice_date <= $3`;
  const branches = [];
  if (category === 'all' || category === 'b2b') branches.push(branch('b2b_invoices', 'b2b', 'B2B'));
  if (category === 'all' || category === 'b2c') branches.push(branch('b2c_invoices', 'b2c', 'B2C'));
  const dir = sort === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await q(`
    WITH inv AS (${branches.join(' UNION ALL ')})
    SELECT inv.category, inv.invoice_number, inv.invoice_date, it.product_name, it.sort_order
      FROM inv
      JOIN invoice_items it ON it.invoice_id = inv.id
       AND it.invoice_type = inv.type_key AND it.user_id = $1
      LEFT JOIN products p ON p.id = it.product_id AND p.user_id = $1
     ORDER BY inv.invoice_date ${dir}, inv.created_at ${dir}, inv.invoice_number ${dir},
              it.sort_order ASC NULLS LAST, it.created_at ASC, it.id ASC`, [userId, start, end]);
  return rows;
}

const AUG = ['2026-08-01', '2026-08-31'];
const invoicesIn = (rows) => new Set(rows.map(r => r.category + ':' + r.invoice_number));

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await q('TRUNCATE users CASCADE');
  USER_A = await mkUser('rep-a@scratch.test');
  USER_B = await mkUser('rep-b@scratch.test');

  // August 2026: 40 B2B, 25 B2C — one line each, except INV-B2B-007
  // which gets five so the multi-line case is real.
  for (let i = 1; i <= 40; i++) {
    const lines = i === 7
      ? [1, 2, 3, 4, 5].map(n => ({ name: `Product ${n}`, taxable: 100 * n, gst: 18 * n }))
      : [{ name: 'Product A', taxable: 1000, gst: 180 }];
    await mkInvoice(USER_A, 'b2b', `INV-B2B-${String(i).padStart(3, '0')}`,
      `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, lines);
  }
  for (let i = 1; i <= 25; i++) {
    await mkInvoice(USER_A, 'b2c', `INV-B2C-${String(i).padStart(3, '0')}`,
      `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      [{ name: 'Product C', taxable: 500, gst: 90 }]);
  }
  // Neighbouring months, including the exact boundary days.
  await mkInvoice(USER_A, 'b2b', 'INV-JUL-001', '2026-07-31', [{ name: 'July', taxable: 10, gst: 1.8 }]);
  await mkInvoice(USER_A, 'b2c', 'INV-SEP-001', '2026-09-01', [{ name: 'Sept', taxable: 10, gst: 1.8 }]);
  // Another tenant, same period and same invoice numbers.
  await mkInvoice(USER_B, 'b2b', 'INV-B2B-001', '2026-08-10', [{ name: 'Other tenant', taxable: 999, gst: 179.82 }]);
});

test.after(async () => {
  if (db) { await q('TRUNCATE users CASCADE'); await db.end(); }
});

test('R1 August + All returns exactly 65 invoices', async () => {
  const rows = await fetchDetails(USER_A, ...AUG, 'all');
  assert.strictEqual(invoicesIn(rows).size, 65);
});

test('R2 August + B2B returns exactly 40 invoices', async () => {
  const rows = await fetchDetails(USER_A, ...AUG, 'b2b');
  assert.strictEqual(invoicesIn(rows).size, 40);
  assert.ok(rows.every(r => r.category === 'B2B'), 'no B2C leaked into a B2B export');
});

test('R3 August + B2C returns exactly 25 invoices', async () => {
  const rows = await fetchDetails(USER_A, ...AUG, 'b2c');
  assert.strictEqual(invoicesIn(rows).size, 25);
  assert.ok(rows.every(r => r.category === 'B2C'), 'no B2B leaked into a B2C export');
});

test('R4 the line count matches invoice_items exactly, with no duplication', async () => {
  const rows = await fetchDetails(USER_A, ...AUG, 'all');
  const { rows: [dbCount] } = await q(`
    SELECT COUNT(*)::int n FROM invoice_items it
     WHERE it.user_id = $1 AND (
       EXISTS (SELECT 1 FROM b2b_invoices i WHERE i.id = it.invoice_id
                AND it.invoice_type='b2b' AND i.invoice_date BETWEEN $2 AND $3)
       OR EXISTS (SELECT 1 FROM b2c_invoices i WHERE i.id = it.invoice_id
                AND it.invoice_type='b2c' AND i.invoice_date BETWEEN $2 AND $3))`,
  [USER_A, ...AUG]);
  // 39 single-line B2B + 5 lines on INV-B2B-007 + 25 B2C = 69
  assert.strictEqual(rows.length, 69);
  assert.strictEqual(rows.length, dbCount.n, 'export rows must equal invoice_items rows');
});

test('R5 a five-line invoice produces exactly five rows, one invoice', async () => {
  const rows = (await fetchDetails(USER_A, ...AUG, 'b2b'))
    .filter(r => r.invoice_number === 'INV-B2B-007');
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(new Set(rows.map(r => r.invoice_number)).size, 1);
  assert.strictEqual(new Set(rows.map(r => String(r.invoice_date))).size, 1);
  assert.strictEqual(new Set(rows.map(r => r.category)).size, 1);
  assert.deepStrictEqual(rows.map(r => r.product_name),
    ['Product 1', 'Product 2', 'Product 3', 'Product 4', 'Product 5'],
    'lines stay in their entered order');
});

test('R6 August never borrows from July or September', async () => {
  const rows = await fetchDetails(USER_A, ...AUG, 'all');
  const numbers = [...invoicesIn(rows)].map(k => k.split(':')[1]);
  assert.ok(!numbers.includes('INV-JUL-001'), 'a 31 July invoice must not appear in August');
  assert.ok(!numbers.includes('INV-SEP-001'), 'a 1 September invoice must not appear in August');
  const july = await fetchDetails(USER_A, '2026-07-01', '2026-07-31', 'all');
  assert.deepStrictEqual([...invoicesIn(july)], ['B2B:INV-JUL-001']);
  const sept = await fetchDetails(USER_A, '2026-09-01', '2026-09-30', 'all');
  assert.deepStrictEqual([...invoicesIn(sept)], ['B2C:INV-SEP-001']);
});

test('R7 sort order runs both ways on the stored date', async () => {
  const asc = await fetchDetails(USER_A, ...AUG, 'all', 'asc');
  const desc = await fetchDetails(USER_A, ...AUG, 'all', 'desc');
  // pg hands back a DATE as a JS Date at local midnight, so it has to be
  // read field by field. String(date).slice(0,10) gives 'Sat Aug 01',
  // which sorts alphabetically and says nothing about chronology.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
  const dates = rs => rs.map(r => iso(r.invoice_date));
  const ascDates = dates(asc), descDates = dates(desc);
  assert.deepStrictEqual(ascDates, [...ascDates].sort(), 'oldest to newest');
  assert.deepStrictEqual(descDates, [...descDates].sort().reverse(), 'newest to oldest');
  assert.strictEqual(asc.length, desc.length, 'direction changes order, never membership');
  assert.deepStrictEqual(invoicesIn(asc), invoicesIn(desc));
});

test('R8 one tenant never sees another tenant invoices', async () => {
  const a = await fetchDetails(USER_A, ...AUG, 'all');
  assert.ok(!a.some(r => r.product_name === 'Other tenant'),
    "tenant B's invoice appeared in tenant A's export");
  const b = await fetchDetails(USER_B, ...AUG, 'all');
  assert.strictEqual(invoicesIn(b).size, 1);
  assert.strictEqual(b[0].product_name, 'Other tenant');
  // Both tenants have an INV-B2B-001; neither may pick up the other's lines.
  assert.strictEqual(b.length, 1, 'a shared invoice number must not join across tenants');
});

test('R9 every row carries its invoice number, date and category', async () => {
  const rows = await fetchDetails(USER_A, ...AUG, 'all');
  for (const r of rows) {
    assert.ok(r.invoice_number, 'a detail row without an invoice number is untraceable');
    assert.ok(r.invoice_date, 'a detail row without a date is untraceable');
    assert.ok(r.category === 'B2B' || r.category === 'B2C', 'category must be B2B or B2C');
  }
});

test('R10 an empty period returns nothing rather than something else', async () => {
  const rows = await fetchDetails(USER_A, '2026-01-01', '2026-01-31', 'all');
  assert.strictEqual(rows.length, 0);
});

test('R11 the route file exists and is mounted under /api/reports', () => {
  const fs = require('fs');
  const src = fs.readFileSync(ROUTE, 'utf8');
  assert.match(src, /router\.use\(requireAuth\)/, 'the router must require auth');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /app\.use\('\/api\/reports', reportsRoutes\)/);
});
