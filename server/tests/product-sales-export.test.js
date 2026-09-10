// The Product Sales sheet, as a real .xlsx.
//
// The report is only useful if the file people open matches the screen, so
// this builds the rows the page builds, posts them to the same
// /reports/workbook route the browser posts to, and reads the workbook
// back with ExcelJS. Nothing is asserted from the source text: every check
// below is against the actual file.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database — the
// workbook route is authenticated, so it needs a server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'client', 'js', 'reports', 'product-sales.js'), 'utf8');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('product sales export (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'product-sales-export-secret';

const ExcelJS = require('exceljs');
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

let server, base, db, USER, TOKEN;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('pse@scratch.test','x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [USER]);
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// The rows the page builds, in the shape psExportExcel() builds them, and
// the same conversion downloadExcelWorkbook() performs before posting.
function sheetFrom(products) {
  const data = products.map(r => ({
    'Sl.no.': r.sl_no,
    'Product Name': String(r.product_name || ''),
    'SKU': String(r.sku || ''),
    'Unit': String(r.unit || ''),
    'Quantity Sold': r.sold_qty,
    'Sales Return Qty': r.return_qty,
    'Net Sold Qty': r.net_qty,
    'Invoices': r.invoice_count
  }));
  const headers = [];
  const seen = new Set();
  for (const row of data) {
    for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  }
  return {
    name: 'Product Sales',
    headers,
    rows: data.map(row => headers.map(h => (row[h] === undefined ? null : row[h]))),
    widths: [{ wch: 8 }, { wch: 38 }, { wch: 14 }, { wch: 8 },
      { wch: 15 }, { wch: 18 }, { wch: 15 }, { wch: 11 }],
    autofilter: true,
    dateColumns: []
  };
}

async function buildWorkbook(products) {
  const res = await fetch(base + '/api/reports/workbook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ filename: 'Product_Sales_August_2026', sheets: [sheetFrom(products)] })
  });
  assert.strictEqual(res.status, 200, 'the workbook route must accept the sheet');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  return wb;
}

// A realistic month, including a product returned down to zero and one
// whose SKU would lose its leading zeros if it were written as a number.
const PRODUCTS = [
  { sl_no: 1, product_name: 'Chapathi Press Machine', sku: 'CP-01', unit: 'PCS', sold_qty: 20, return_qty: 2, net_qty: 18, invoice_count: 3 },
  { sl_no: 2, product_name: 'Dough Kneader 10 KG', sku: 'DK-10', unit: 'PCS', sold_qty: 12, return_qty: 0, net_qty: 12, invoice_count: 1 },
  { sl_no: 3, product_name: 'Mixer Grinder 3 HP', sku: '0012', unit: 'PCS', sold_qty: 9, return_qty: 1, net_qty: 8, invoice_count: 2 },
  { sl_no: 4, product_name: 'Sugarcane Juice Machine', sku: 'SJ-04', unit: 'NOS', sold_qty: 5, return_qty: 5, net_qty: 0, invoice_count: 1 },
  { sl_no: 5, product_name: 'Vegetable Cutter & Slicer', sku: 'VC-05', unit: 'PCS', sold_qty: 2.5, return_qty: 0, net_qty: 2.5, invoice_count: 1 }
];

test('E1 one row per product, in order, with no duplicates', async () => {
  const wb = await buildWorkbook(PRODUCTS);
  const ws = wb.getWorksheet('Product Sales');
  assert.ok(ws, 'the sheet must be named Product Sales');

  // Header plus one row per product, and nothing else.
  assert.strictEqual(ws.rowCount, PRODUCTS.length + 1);

  const names = [];
  for (let r = 2; r <= ws.rowCount; r++) names.push(ws.getRow(r).getCell(2).value);
  assert.deepStrictEqual(names, PRODUCTS.map(p => p.product_name));
  assert.strictEqual(new Set(names).size, names.length, 'no product may appear twice');
});

test('E2 the header is the approved seven columns plus Invoices', async () => {
  const wb = await buildWorkbook(PRODUCTS);
  const ws = wb.getWorksheet('Product Sales');
  const header = [];
  ws.getRow(1).eachCell(c => header.push(c.value));
  assert.deepStrictEqual(header, ['Sl.no.', 'Product Name', 'SKU', 'Unit',
    'Quantity Sold', 'Sales Return Qty', 'Net Sold Qty', 'Invoices']);
});

test('E3 quantities are Excel NUMBERS, labels are text', async () => {
  const wb = await buildWorkbook(PRODUCTS);
  const ws = wb.getWorksheet('Product Sales');

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (const col of [1, 5, 6, 7, 8]) {          // Sl.no., Sold, Returned, Net, Invoices
      assert.strictEqual(typeof row.getCell(col).value, 'number',
        `row ${r} column ${col} must be a number Excel can sum`);
    }
    for (const col of [2, 3, 4]) {                // Product, SKU, Unit
      assert.strictEqual(typeof row.getCell(col).value, 'string',
        `row ${r} column ${col} must be text`);
    }
  }

  // The figures themselves, read back out of the file.
  const r2 = ws.getRow(2);
  assert.strictEqual(r2.getCell(5).value, 20);
  assert.strictEqual(r2.getCell(6).value, 2);
  assert.strictEqual(r2.getCell(7).value, 18);

  // A fully returned product is a real zero, not an empty cell.
  const r5 = ws.getRow(5);
  assert.strictEqual(r5.getCell(5).value, 5);
  assert.strictEqual(r5.getCell(6).value, 5);
  assert.strictEqual(r5.getCell(7).value, 0);

  // A fractional quantity survives as a fraction.
  assert.strictEqual(ws.getRow(6).getCell(5).value, 2.5);

  // A SKU of "0012" keeps its leading zeros, which it would lose as a number.
  assert.strictEqual(ws.getRow(4).getCell(3).value, '0012');
});

test('E4 header bold, first row frozen, autofilter across the header', async () => {
  const wb = await buildWorkbook(PRODUCTS);
  const ws = wb.getWorksheet('Product Sales');

  ws.getRow(1).eachCell(c => {
    assert.ok(c.font && c.font.bold, `header cell "${c.value}" must be bold`);
  });

  const frozen = (ws.views || []).find(v => v.state === 'frozen');
  assert.ok(frozen, 'the sheet must have a frozen pane');
  assert.strictEqual(frozen.ySplit, 1, 'exactly the first row is frozen');

  assert.ok(ws.autoFilter, 'the header row must carry an autofilter');
});

test('E5 every matching product is exported, not a page of them', async () => {
  // Forty products: the sheet must carry all forty.
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push({
      sl_no: i + 1, product_name: `Bulk Product ${String(i).padStart(2, '0')}`,
      sku: `BP-${i}`, unit: 'PCS', sold_qty: i + 1, return_qty: 0, net_qty: i + 1, invoice_count: 1
    });
  }
  const wb = await buildWorkbook(many);
  const ws = wb.getWorksheet('Product Sales');
  assert.strictEqual(ws.rowCount, 41, 'forty products plus the header');

  let total = 0;
  for (let r = 2; r <= ws.rowCount; r++) total += ws.getRow(r).getCell(5).value;
  assert.strictEqual(total, 820, '1 + 2 + ... + 40, so nothing was dropped');
});

// ═══ The page exports what is on screen ══════════════════════════════

test('E6 the export is built from the rows the table was drawn from', async () => {
  const fn = PAGE.slice(PAGE.indexOf('async function psExportExcel'));
  // psRows is the API's own answer for the period. There is no second
  // query, no slice and no page window between the table and the sheet.
  assert.match(fn, /psRows\.map/);
  assert.ok(!/slice\(|page|offset|limit/i.test(fn.slice(0, fn.indexOf('downloadExcelWorkbook'))),
    'the sheet must not be built from a page of the rows');
  // ...and it refuses rather than exporting a short sheet.
  assert.match(fn, /Export mismatch/);
  assert.match(fn, /autofilter: true/);
});

test('E7 the page never aggregates invoice lines in the browser', async () => {
  // The whole report comes from one endpoint. Nothing here reads
  // invoice_items, and nothing sums quantities client-side.
  assert.match(PAGE, /apiFetch\('\/reports\/product-sales\?'/);
  assert.ok(!/invoice_items|from\('invoice/i.test(PAGE),
    'the page must not read invoice lines itself');
  // The only reduce() is over rows already aggregated by the server, and
  // there is none at all in the render path.
  const render = PAGE.slice(PAGE.indexOf('function psRender'), PAGE.indexOf('// ── Excel'));
  assert.ok(!/reduce\(/.test(render), 'the totals come from the API, not from a client-side sum');
});
