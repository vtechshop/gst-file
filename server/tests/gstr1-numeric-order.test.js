// GSTR-1 workbook: cell TYPES, number formats, and the order of the
// Complete Invoice Details sheet.
//
// Everything here goes through the real client builder in
// client/js/reports/reports.js and the real /api/reports/workbook route,
// and is then asserted against the .xlsx that comes back. A column that
// merely looks numeric on screen is exactly the bug this file exists to
// catch, so nothing is inferred from the source.
//
// The figures deliberately arrive as STRINGS, because NUMERIC columns
// reach the browser that way: node-postgres returns them as text so no
// paise are lost to a float, and res.json() sends that text on.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('gstr1 numeric/order (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'numeric-order-secret';

const ExcelJS = require('exceljs');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');
const { createBrowserContext } = require('./helpers/browser-context');

const ctx = createBrowserContext();

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

// One row of GET /reports/invoice-details — an invoice LINE.
function lineRow(id, number, dateISO, rate, extra) {
  return Object.assign({
    invoice_id: id, category: 'B2B', invoice_number: number, invoice_date: dateISO,
    gst_number: '33ABCDE1234F1Z4', state: 'Tamil Nadu', address: '1 Mill Road',
    hsn_code: '08439000', product_name: 'Pump', gst_percentage: rate,
    inv_taxable_amount: '1000.00', inv_sgst: '90.00', inv_cgst: '90.00',
    inv_igst: '0.00', inv_total_amount: '1180.00'
  }, extra || {});
}

// The real builder, called inside the vm the client files were loaded into.
function buildDetail(rows, direction) {
  ctx.__data = { rows, direction: direction || 'asc' };
  return ctx.__eval('buildCompleteInvoiceRows(__data.rows, __data.direction)');
}

const WIDTHS = [7, 12, 16, 18, 22, 16, 34, 34, 14, 14, 12, 12, 12, 14].map(wch => ({ wch }));
const DETAIL_FORMATS = {
  'Sl.no.': '0', 'Amount': '0.00', 'GST%': '0.00',
  'SGST': '0.00', 'CGST': '0.00', 'IGST': '0.00', 'Total Rs.': '0.00'
};

async function workbookOf(sheets) {
  const res = await fetch(base + '/reports/workbook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ filename: 'types_check', sheets })
  });
  assert.strictEqual(res.status, 200, 'the route wrote a workbook');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  return wb;
}
function detailSheet(rows) {
  const headers = Object.keys(rows[0]);
  return [{
    name: 'Complete Invoice Details', headers,
    rows: rows.map(r => headers.map(h => (r[h] === undefined ? null : r[h]))),
    widths: WIDTHS, autofilter: true, dateColumns: ['Date'], numberFormats: DETAIL_FORMATS
  }];
}
// Every value of one column, header row excluded.
function column(ws, header) {
  const headers = ws.getRow(1).values.slice(1).map(String);
  const c = headers.indexOf(header) + 1;
  assert.ok(c > 0, `column "${header}" exists`);
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) out.push(ws.getRow(r).getCell(c).value);
  return out;
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('numorder@scratch.test','x') RETURNING id`)).rows[0].id;
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('N1 money, quantity and rate cells are numbers, not text that looks numeric', async () => {
  // The four legacy sheets, built exactly as exportFullGSTR1 builds them.
  ctx.__money = {
    b2b: [{ gst_number: '33ABCDE1234F1Z4', customer_name: 'Acme', invoice_number: '183',
      invoice_date: '2026-08-14', supply_type: 'intrastate', taxable_amount: '1700.00',
      gst_percentage: '18.00', igst: '0.00', cgst: '153.00', sgst: '153.00', total_amount: '2006.00' }],
    hsn: [{ hsn_code: '08439000', product_name: 'Pump', type: 'Goods', quantity: '3.000',
      taxable_value: '1700.00', gst_percentage: '18.00', igst: '0.00', cgst: '153.00',
      sgst: '153.00', total_gst: '306.00', total_invoice_value: '2006.00' }]
  };
  const b2b = ctx.__eval(`__money.b2b.map((r,i) => ({ 'S.No': i+1, 'GST No': r.gst_number,
    'Customer': r.customer_name, 'Invoice No': r.invoice_number, 'Date': r.invoice_date,
    'Supply': r.supply_type, 'Taxable': excelNumber(r.taxable_amount),
    'GST%': excelNumber(r.gst_percentage), 'IGST': excelNumber(r.igst),
    'CGST': excelNumber(r.cgst), 'SGST': excelNumber(r.sgst), 'Total': excelNumber(r.total_amount) }))`);
  const hsn = ctx.__eval(`__money.hsn.map((r,i) => ({ 'S.No': i+1, 'HSN': r.hsn_code,
    'Product': r.product_name, 'Type': r.type, 'Qty': excelNumber(r.quantity),
    'Taxable': excelNumber(r.taxable_value), 'GST%': excelNumber(r.gst_percentage) }))`);

  const mk = (name, data, extra) => {
    const headers = Object.keys(data[0]);
    return Object.assign({ name, headers, rows: data.map(r => headers.map(h => r[h])) }, extra || {});
  };
  const wb = await workbookOf([
    mk('B2B Invoices', b2b, {
      dateColumns: ['Date'],
      numberFormats: { 'S.No': '0', 'Date': 'dd/mm/yyyy', 'Taxable': '0.00', 'GST%': '0.00',
        'IGST': '0.00', 'CGST': '0.00', 'SGST': '0.00', 'Total': '0.00' }
    }),
    mk('B2B HSN', hsn, { numberFormats: { 'S.No': '0', 'Qty': '0.###', 'Taxable': '0.00', 'GST%': '0.00' } })
  ]);

  const inv = wb.getWorksheet('B2B Invoices');
  for (const h of ['S.No', 'Taxable', 'GST%', 'IGST', 'CGST', 'SGST', 'Total']) {
    assert.strictEqual(typeof column(inv, h)[0], 'number', `${h} must be a number cell`);
  }
  // The one that proves it: 1700.00 is stored as 1700 and DISPLAYED as
  // "1700.00" by the format. A string "1700.00" would not sum.
  assert.strictEqual(column(inv, 'Taxable')[0], 1700);
  assert.strictEqual(inv.getRow(2).getCell(7).numFmt, '0.00');

  const h = wb.getWorksheet('B2B HSN');
  assert.strictEqual(typeof column(h, 'Qty')[0], 'number');
  assert.strictEqual(column(h, 'Qty')[0], 3, 'a quantity of "3.000" is the number 3');
});

test('N2 identifiers stay text even when they are all digits', async () => {
  const rows = buildDetail([
    lineRow('i1', '00123', '2026-08-14', '18.00',
      { gst_number: '33ABCDE1234F1Z4', hsn_code: '08439000' })
  ]);
  const wb = await workbookOf(detailSheet(rows));
  const ws = wb.getWorksheet('Complete Invoice Details');

  // A bill number of 00123 that became the number 123 would have lost a
  // leading zero that is part of the identifier.
  assert.strictEqual(column(ws, 'Bill Number')[0], '00123');
  assert.strictEqual(typeof column(ws, 'Bill Number')[0], 'string');
  assert.strictEqual(column(ws, 'HSN code')[0], '08439000');
  assert.strictEqual(typeof column(ws, 'HSN code')[0], 'string');
  assert.strictEqual(typeof column(ws, 'GST NUMBER')[0], 'string');
  for (const h of ['State', 'Bill Address', 'Item']) {
    assert.strictEqual(typeof column(ws, h)[0], 'string', `${h} is a label`);
  }
});

test('N3 the detail sheet money columns are numbers and the date is a date', async () => {
  const rows = buildDetail([lineRow('i1', '183', '2026-08-14', '18.00')]);
  const wb = await workbookOf(detailSheet(rows));
  const ws = wb.getWorksheet('Complete Invoice Details');

  for (const h of ['Sl.no.', 'Amount', 'SGST', 'CGST', 'IGST', 'Total Rs.']) {
    assert.strictEqual(typeof column(ws, h)[0], 'number', `${h} must be a number cell`);
  }
  assert.strictEqual(column(ws, 'Amount')[0], 1000);
  assert.strictEqual(column(ws, 'Total Rs.')[0], 1180);
  const date = column(ws, 'Date')[0];
  assert.ok(date instanceof Date, 'the date is a real date cell');
  assert.strictEqual(date.toISOString().slice(0, 10), '2026-08-14', 'and on the day the invoice says');
});

test('N4 GST% is a number for one rate and text only when there are several', async () => {
  const rows = buildDetail([
    lineRow('single', '1', '2026-08-14', '18.00'),
    lineRow('mixed', '2', '2026-08-14', '18.00'),
    lineRow('mixed', '2', '2026-08-14', '5.00', { product_name: 'Seal Kit' })
  ]);
  const wb = await workbookOf(detailSheet(rows));
  const gst = column(wb.getWorksheet('Complete Invoice Details'), 'GST%');

  assert.strictEqual(typeof gst[0], 'number', 'one rate is a number');
  assert.strictEqual(gst[0], 18);
  assert.strictEqual(gst[1], '5%, 18%', 'two rates cannot be one number, so they stay text');
});

test('N5 the sheet is ordered by bill number, counting digit runs as numbers', async () => {
  // Dates descend as the numbers ascend: a date-ordered sheet would come
  // out reversed, so only bill-number ordering can pass this.
  const nums = ['9', '10', '2', '100', '11'];
  const rows = buildDetail(nums.map((n, i) =>
    lineRow('n' + i, n, `2026-08-${String(20 - i).padStart(2, '0')}`, '18.00')));
  const wb = await workbookOf(detailSheet(rows));
  const ws = wb.getWorksheet('Complete Invoice Details');

  assert.deepStrictEqual(column(ws, 'Bill Number'), ['2', '9', '10', '11', '100'],
    'text ordering would put 100 before 9');
  assert.deepStrictEqual(column(ws, 'Sl.no.'), [1, 2, 3, 4, 5],
    'renumbered in the order the sheet is read');
});

test('N6 alphanumeric bill numbers order naturally and are not converted', async () => {
  const nums = ['INV-9', 'INV-10', 'INV-2', 'INV-100'];
  const rows = buildDetail(nums.map((n, i) =>
    lineRow('a' + i, n, `2026-08-${String(20 - i).padStart(2, '0')}`, '18.00')));
  const wb = await workbookOf(detailSheet(rows));
  const ws = wb.getWorksheet('Complete Invoice Details');

  assert.deepStrictEqual(column(ws, 'Bill Number'),
    ['INV-2', 'INV-9', 'INV-10', 'INV-100']);
  assert.ok(column(ws, 'Bill Number').every(v => typeof v === 'string'),
    'the identifier is untouched');
});

test('N7 a same-date run keeps its number order', async () => {
  // 183, 184 and 185 all on one day, with a LATER invoice on an EARLIER
  // date. Bill number decides, not the date.
  const rows = buildDetail([
    lineRow('c', '185', '2026-08-14', '18.00'),
    lineRow('a', '183', '2026-08-14', '18.00'),
    lineRow('d', '186', '2026-08-01', '18.00'),
    lineRow('b', '184', '2026-08-14', '18.00')
  ]);
  const wb = await workbookOf(detailSheet(rows));
  assert.deepStrictEqual(
    column(wb.getWorksheet('Complete Invoice Details'), 'Bill Number'),
    ['183', '184', '185', '186']);
});

test('N8 65 invoices over 69 lines: one row each, nothing lost, filter to N66', async () => {
  const src = [];
  const expected = [];
  for (let i = 0; i < 65; i++) {
    const num = String(183 + i);
    expected.push(num);
    src.push(lineRow('b' + i, num, `2026-08-${String(10 + (i % 18)).padStart(2, '0')}`, '18.00'));
  }
  // Four invoices carry a second line: 69 lines in, still 65 invoices out.
  src.push(lineRow('b0', '183', '2026-08-10', '5.00', { hsn_code: '84139190', product_name: 'Seal Kit' }));
  src.push(lineRow('b1', '184', '2026-08-11', '18.00', { hsn_code: '84139190', product_name: 'Seal Kit' }));
  src.push(lineRow('b2', '185', '2026-08-12', '18.00', { hsn_code: '84139190', product_name: 'Gasket' }));
  src.push(lineRow('b3', '186', '2026-08-13', '18.00', { hsn_code: '84139190', product_name: 'Gasket' }));
  assert.strictEqual(src.length, 69);

  const rows = buildDetail(src);
  assert.strictEqual(rows.length, 65, 'one row per invoice, not per line');

  const wb = await workbookOf(detailSheet(rows));
  const ws = wb.getWorksheet('Complete Invoice Details');
  const bills = column(ws, 'Bill Number');

  assert.strictEqual(ws.rowCount, 66, '65 invoices plus the header');
  assert.deepStrictEqual(bills, expected, 'ascending, complete, in order');
  assert.strictEqual(new Set(bills).size, 65, 'nothing duplicated');
  assert.deepStrictEqual(column(ws, 'Sl.no.'),
    Array.from({ length: 65 }, (_, i) => i + 1), 'Sl.no. 1..65 with no gaps');

  const af = typeof ws.autoFilter === 'string' ? ws.autoFilter : JSON.stringify(ws.autoFilter);
  assert.strictEqual(af, 'A1:N66');

  // The multi-line invoices kept every HSN and every item name.
  const hsn = column(ws, 'HSN code')[0];
  const item = column(ws, 'Item')[0];
  assert.match(hsn, /08439000/); assert.match(hsn, /84139190/);
  assert.match(item, /Pump/); assert.match(item, /Seal Kit/);
});

test('N12 the toolbar offers a Bill Number direction, not a date one', () => {
  const html = require('fs').readFileSync(
    path.join(__dirname, '..', '..', 'reports.html'), 'utf8');
  const select = html.slice(html.indexOf('id="repDetailSort"'));
  const block = select.slice(0, select.indexOf('</select>'));
  // The control drives bill-number ordering now, so a label describing a
  // date sort would be telling the user something the sheet does not do.
  assert.match(block, /value="asc"[^>]*>[^<]*Ascending/);
  assert.match(block, /value="desc"[^>]*>[^<]*Descending/);
  assert.match(block, /Bill Number/);
  assert.equal(/Oldest|Newest/.test(block), false,
    'the old date wording must be gone');
});

test('N13 descending reverses the same natural order, numeric and alphanumeric', async () => {
  const nums = ['9', '10', '2', '100', '11'];
  const numeric = nums.map((n, i) => lineRow('n' + i, n, `2026-08-${String(20 - i).padStart(2, '0')}`, '18.00'));

  const asc = await workbookOf(detailSheet(buildDetail(numeric, 'asc')));
  const desc = await workbookOf(detailSheet(buildDetail(numeric, 'desc')));
  assert.deepStrictEqual(column(asc.getWorksheet('Complete Invoice Details'), 'Bill Number'),
    ['2', '9', '10', '11', '100']);
  assert.deepStrictEqual(column(desc.getWorksheet('Complete Invoice Details'), 'Bill Number'),
    ['100', '11', '10', '9', '2'],
    'reversing a TEXT sort would give 9, 2, 11, 100, 10');

  const alnum = ['INV-9', 'INV-10', 'INV-2', 'INV-100'].map((n, i) =>
    lineRow('a' + i, n, `2026-08-${String(20 - i).padStart(2, '0')}`, '18.00'));
  const aAsc = await workbookOf(detailSheet(buildDetail(alnum, 'asc')));
  const aDesc = await workbookOf(detailSheet(buildDetail(alnum, 'desc')));
  assert.deepStrictEqual(column(aAsc.getWorksheet('Complete Invoice Details'), 'Bill Number'),
    ['INV-2', 'INV-9', 'INV-10', 'INV-100']);
  assert.deepStrictEqual(column(aDesc.getWorksheet('Complete Invoice Details'), 'Bill Number'),
    ['INV-100', 'INV-10', 'INV-9', 'INV-2']);
});

test('N14 Sl.no. runs 1..N in whichever direction is chosen', async () => {
  const src = ['9', '10', '2', '100', '11'].map((n, i) =>
    lineRow('n' + i, n, `2026-08-1${i}`, '18.00'));
  for (const dir of ['asc', 'desc']) {
    const wb = await workbookOf(detailSheet(buildDetail(src, dir)));
    const ws = wb.getWorksheet('Complete Invoice Details');
    assert.deepStrictEqual(column(ws, 'Sl.no.'), [1, 2, 3, 4, 5],
      `Sl.no. is rebuilt for the ${dir} order, never carried over`);
    assert.ok(column(ws, 'Sl.no.').every(v => typeof v === 'number'));
  }
});

test('N15 direction changes only the order, never the membership or the figures', async () => {
  const src = [];
  for (let i = 0; i < 65; i++) {
    src.push(lineRow('b' + i, String(183 + i), `2026-08-${String(10 + (i % 18)).padStart(2, '0')}`, '18.00'));
  }
  src.push(lineRow('b0', '183', '2026-08-10', '5.00', { hsn_code: '84139190', product_name: 'Seal Kit' }));
  src.push(lineRow('b1', '184', '2026-08-11', '18.00', { hsn_code: '84139190', product_name: 'Seal Kit' }));
  src.push(lineRow('b2', '185', '2026-08-12', '18.00', { hsn_code: '84139190', product_name: 'Gasket' }));
  src.push(lineRow('b3', '186', '2026-08-13', '18.00', { hsn_code: '84139190', product_name: 'Gasket' }));

  const asc = buildDetail(src, 'asc');
  const desc = buildDetail(src, 'desc');
  assert.strictEqual(asc.length, 65);
  assert.strictEqual(desc.length, 65);

  // Same invoices, opposite order.
  assert.deepStrictEqual(desc.map(r => r['Bill Number']),
    asc.map(r => r['Bill Number']).slice().reverse());

  // Every figure of a given invoice survives the direction unchanged.
  const byNumber = rows => new Map(rows.map(r => [r['Bill Number'], r]));
  const a = byNumber(asc), d = byNumber(desc);
  for (const num of a.keys()) {
    const x = a.get(num), y = d.get(num);
    for (const f of ['Date', 'GST NUMBER', 'HSN code', 'State', 'Bill Address', 'Item',
      'Amount', 'GST%', 'SGST', 'CGST', 'IGST', 'Total Rs.']) {
      assert.deepStrictEqual(y[f], x[f], `${f} of invoice ${num} is unchanged by the direction`);
    }
  }

  const wb = await workbookOf(detailSheet(desc));
  const ws = wb.getWorksheet('Complete Invoice Details');
  assert.strictEqual(ws.rowCount, 66, '65 invoices plus the header, either way');
  const af = typeof ws.autoFilter === 'string' ? ws.autoFilter : JSON.stringify(ws.autoFilter);
  assert.strictEqual(af, 'A1:N66');
  assert.strictEqual(column(ws, 'Bill Number')[0], '247', 'descending starts at the largest');
  // The aggregation is untouched by the direction.
  const last = ws.rowCount;
  assert.match(String(ws.getRow(last).getCell(5).value), /08439000/);
  assert.match(String(ws.getRow(last).getCell(5).value), /84139190/);
  assert.strictEqual(ws.getRow(last).getCell(10).value, '5%, 18%', 'mixed rates survive');
});

test('N9 the sheet is still exactly the fourteen agreed columns', async () => {
  const rows = buildDetail([lineRow('i1', '183', '2026-08-14', '18.00')]);
  const wb = await workbookOf(detailSheet(rows));
  const headers = wb.getWorksheet('Complete Invoice Details').getRow(1).values.slice(1).map(String);
  assert.deepStrictEqual(headers, [
    'Sl.no.', 'Date', 'Bill Number', 'GST NUMBER', 'HSN code', 'State',
    'Bill Address', 'Item', 'Amount', 'GST%', 'SGST', 'CGST', 'IGST', 'Total Rs.'
  ]);
});

test('N10 a value that is not a number is kept, not silently zeroed', () => {
  // excelNumber turns "1700.00" into 1700, but anything it cannot read
  // must survive as itself rather than becoming a figure nobody entered.
  assert.strictEqual(ctx.__eval('excelNumber("1700.00")'), 1700);
  assert.strictEqual(ctx.__eval('excelNumber("0.00")'), 0);
  assert.strictEqual(ctx.__eval('excelNumber("")'), null);
  assert.strictEqual(ctx.__eval('excelNumber(null)'), null);
  assert.strictEqual(ctx.__eval('excelNumber("N/A")'), 'N/A');
});

test('N11 a number format is never applied to a text cell', async () => {
  // Asking for a format on an identifier column must not make it numeric.
  const rows = buildDetail([lineRow('i1', '00123', '2026-08-14', '18.00')]);
  const sheets = detailSheet(rows);
  sheets[0].numberFormats = Object.assign({ 'Bill Number': '0.00' }, DETAIL_FORMATS);
  const wb = await workbookOf(sheets);
  const ws = wb.getWorksheet('Complete Invoice Details');
  assert.strictEqual(column(ws, 'Bill Number')[0], '00123', 'still the identifier');
  assert.strictEqual(typeof column(ws, 'Bill Number')[0], 'string', 'and still text');
});
