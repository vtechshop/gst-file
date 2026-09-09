// The GSTR-1 workbook as a FILE.
//
// Everything here is asserted against a real .xlsx produced by the real
// route and read back with ExcelJS: the five sheets, the bold header, the
// frozen first row, the AutoFilter, the cell types and the values. Nothing
// is inferred from the source.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database — the
// route runs behind requireAuth, so a real server and a real token are
// needed to exercise it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('gstr1 workbook format (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'workbook-test-secret';

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
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(done); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

let server, base, db, USER, TOKEN, wb;
const SHEET_NAMES = ['B2B Invoices', 'B2C Invoices', 'B2B HSN', 'B2C HSN', 'Complete Invoice Details'];

// The exact shape reports.js sends: four legacy sheets of plain values and
// the combined detail sheet, with its date column declared.
function buildPayload(detailRows) {
  const toSheet = (name, data, extra) => {
    const headers = [];
    const seen = new Set();
    for (const row of data) {
      for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
    }
    return Object.assign({
      name, headers,
      rows: data.map(r => headers.map(h => (r[h] === undefined ? null : r[h])))
    }, extra || {});
  };
  return {
    filename: 'GSTR1_Complete_Report',
    sheets: [
      toSheet('B2B Invoices', [{ 'S.No': 1, 'GST No': '33AAAAA0000A1Z5', 'Customer': 'Acme',
        'Invoice No': 'INV-B2B-001', 'Date': '05/08/2026', 'Taxable': 1000, 'Total': 1180 }]),
      toSheet('B2C Invoices', [{ 'S.No': 1, 'State': 'Tamil Nadu', 'Date': '06/08/2026',
        'Taxable': 500, 'Total': 590 }]),
      toSheet('B2B HSN', [{ 'S.No': 1, 'HSN': '84388090', 'Product': 'Widget', 'Qty': 3, 'Taxable': 1000 }]),
      toSheet('B2C HSN', [{ 'S.No': 1, 'HSN': '84388090', 'Product': 'Retail', 'Taxable': 500 }]),
      toSheet('Complete Invoice Details', detailRows, {
        autofilter: true,
        dateColumns: ['Invoice Date'],
        widths: Object.keys(detailRows[0]).map(() => ({ wch: 14 }))
      })
    ]
  };
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('wb@scratch.test','x') RETURNING id`)).rows[0].id;
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;

  // Three detail rows: two lines of one B2B invoice and one B2C line, so
  // the combined sheet really carries both categories.
  const detail = [
    { 'Invoice Number': 'INV-B2B-001', 'Invoice Date': '2026-08-05', 'Category': 'B2B',
      'Product Name': 'Product 1', 'Qty': 1, 'Rate': 100, 'Taxable Value': 100, 'Line Total': 118 },
    { 'Invoice Number': 'INV-B2B-001', 'Invoice Date': '2026-08-05', 'Category': 'B2B',
      'Product Name': 'Product 2', 'Qty': 2, 'Rate': 200, 'Taxable Value': 400, 'Line Total': 472 },
    { 'Invoice Number': 'INV-B2C-001', 'Invoice Date': '2026-08-01', 'Category': 'B2C',
      'Product Name': 'Retail 1', 'Qty': 1, 'Rate': 500, 'Taxable Value': 500, 'Line Total': 590 }
  ];

  const res = await fetch(base + '/reports/workbook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(buildPayload(detail))
  });
  assert.strictEqual(res.status, 200, 'the workbook route must answer 200');
  assert.match(res.headers.get('content-type'),
    /spreadsheetml\.sheet/, 'it must be served as an xlsx');
  const buf = Buffer.from(await res.arrayBuffer());
  wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('W1 the workbook has exactly the five expected sheets, in order', () => {
  assert.deepStrictEqual(wb.worksheets.map(w => w.name), SHEET_NAMES);
});

test('W2 the header row is bold on every sheet', () => {
  for (const name of SHEET_NAMES) {
    const ws = wb.getWorksheet(name);
    const header = ws.getRow(1);
    assert.ok(header.font && header.font.bold === true,
      `${name}: the header row must be bold`);
    // And the data below it is not, so the header still stands out.
    const first = ws.getRow(2);
    assert.ok(!(first.font && first.font.bold), `${name}: data rows must not be bold`);
  }
});

test('W3 the first row is frozen on every sheet', () => {
  for (const name of SHEET_NAMES) {
    const ws = wb.getWorksheet(name);
    assert.ok(Array.isArray(ws.views) && ws.views.length, `${name}: no view recorded`);
    const v = ws.views[0];
    assert.strictEqual(v.state, 'frozen', `${name}: the pane must be frozen`);
    assert.strictEqual(v.ySplit, 1, `${name}: exactly the first row must be frozen`);
  }
});

test('W4 AutoFilter covers the Complete Invoice Details header', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  assert.ok(ws.autoFilter, 'the combined sheet must carry an AutoFilter');
  // ExcelJS accepts { from, to } on write but hands back the range as a
  // string ref ("A1:H4") on read, so both shapes are accepted here.
  const af = ws.autoFilter;
  const ref = typeof af === 'string'
    ? af
    : `${af.from.column}:${af.to.column}`;
  assert.match(String(ref), /^A1:/, 'the filter must start on the header row at column A');
  // It must reach the last column and the last data row, or the far side of
  // the sheet is not filterable.
  const headerCount = ws.getRow(1).values.slice(1).length;
  const lastCol = String(ref).split(':')[1];
  assert.match(lastCol, new RegExp(`${ws.rowCount}$`),
    `the filter must extend to the last row (${ws.rowCount}), got ${ref}`);
  assert.strictEqual(headerCount, 8, 'this fixture sheet has eight columns');
  assert.match(lastCol, /^H/, `the filter must reach the last column, got ${ref}`);
});

test('W5 the combined sheet is one sheet holding both categories', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  const headers = ws.getRow(1).values.slice(1);
  const catCol = headers.indexOf('Category') + 1;
  assert.ok(catCol > 0, 'there must be a Category column');
  const cats = [];
  ws.eachRow((row, n) => { if (n > 1) cats.push(row.getCell(catCol).value); });
  assert.deepStrictEqual(cats, ['B2B', 'B2B', 'B2C']);
  // And it was not split into per-category sheets.
  assert.ok(!wb.worksheets.some(w => /B2B Complete|B2C Complete/.test(w.name)));
});

test('W6 numbers are numbers, not text', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  const headers = ws.getRow(1).values.slice(1);
  for (const h of ['Qty', 'Rate', 'Taxable Value', 'Line Total']) {
    const cell = ws.getRow(2).getCell(headers.indexOf(h) + 1);
    assert.strictEqual(typeof cell.value, 'number', `${h} must be numeric`);
  }
  assert.strictEqual(ws.getRow(2).getCell(headers.indexOf('Qty') + 1).value, 1);
  assert.strictEqual(ws.getRow(3).getCell(headers.indexOf('Taxable Value') + 1).value, 400);
});

test('W7 the invoice date is a real date cell, on the right day', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  const headers = ws.getRow(1).values.slice(1);
  const col = headers.indexOf('Invoice Date') + 1;
  const cell = ws.getRow(2).getCell(col);
  assert.ok(cell.value instanceof Date, 'it must be a date cell, not a string');
  // Read in UTC: the cell was built at UTC midnight precisely so no zone
  // can move it onto the day before.
  assert.strictEqual(cell.value.getUTCFullYear(), 2026);
  assert.strictEqual(cell.value.getUTCMonth() + 1, 8);
  assert.strictEqual(cell.value.getUTCDate(), 5, 'the 5th must not drift to the 4th');
  assert.ok(cell.numFmt, 'it must carry a display format');
  // The 1st of the month is the case a UTC shift would move into July.
  const first = ws.getRow(4).getCell(col);
  assert.strictEqual(first.value.getUTCDate(), 1);
  assert.strictEqual(first.value.getUTCMonth() + 1, 8);
});

test('W8 the invoice number is preserved exactly, as text', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  const headers = ws.getRow(1).values.slice(1);
  const col = headers.indexOf('Invoice Number') + 1;
  assert.strictEqual(ws.getRow(2).getCell(col).value, 'INV-B2B-001');
  assert.strictEqual(ws.getRow(4).getCell(col).value, 'INV-B2C-001');
});

test('W9 every row that went in came out, with no duplication', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  assert.strictEqual(ws.rowCount, 4, 'one header plus three detail rows');
  const headers = ws.getRow(1).values.slice(1);
  const numCol = headers.indexOf('Invoice Number') + 1;
  const seen = new Set();
  ws.eachRow((row, n) => { if (n > 1) seen.add(row.getCell(numCol).value); });
  assert.strictEqual(seen.size, 2, 'two distinct invoices across three lines');
});

test('W10 the four existing sheets keep their columns and values', () => {
  const b2b = wb.getWorksheet('B2B Invoices');
  assert.deepStrictEqual(b2b.getRow(1).values.slice(1),
    ['S.No', 'GST No', 'Customer', 'Invoice No', 'Date', 'Taxable', 'Total']);
  assert.strictEqual(b2b.getRow(2).getCell(4).value, 'INV-B2B-001');
  assert.strictEqual(b2b.getRow(2).getCell(6).value, 1000);
  // A pre-formatted date string on a legacy sheet stays the string it was.
  assert.strictEqual(b2b.getRow(2).getCell(5).value, '05/08/2026');

  const hsn = wb.getWorksheet('B2C HSN');
  assert.deepStrictEqual(hsn.getRow(1).values.slice(1),
    ['S.No', 'HSN', 'Product', 'Taxable']);
  assert.strictEqual(hsn.getRow(2).getCell(2).value, '84388090');
});

test('W11 columns carry usable widths', () => {
  const ws = wb.getWorksheet('Complete Invoice Details');
  assert.ok(ws.columns.length >= 8);
  for (const c of ws.columns) {
    assert.ok(c.width >= 6, `a column width of ${c.width} is too narrow to read`);
  }
});

test('W12 the route refuses an unauthenticated caller', async () => {
  const res = await fetch(base + '/reports/workbook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'x', sheets: [{ name: 'S', headers: ['A'], rows: [[1]] }] })
  });
  assert.strictEqual(res.status, 401);
});

test('W13 a malformed workbook request is rejected, not written', async () => {
  const bad = [
    { filename: 'x', sheets: [] },
    { filename: 'x', sheets: [{ name: '', headers: ['A'], rows: [] }] },
    { filename: 'x', sheets: [{ name: 'Has/Slash', headers: ['A'], rows: [] }] },
    { filename: 'x', sheets: [{ name: 'S', headers: [], rows: [] }] }
  ];
  for (const body of bad) {
    const res = await fetch(base + '/reports/workbook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body)
    });
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
  }
});
