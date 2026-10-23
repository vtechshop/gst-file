// An advance a customer has actually paid, and the receipt for it.
//
// The distinction this whole feature rests on: a proforma's advance_amount
// is a TERM of a quotation ("pay 500 up front"), while a receipt voucher is
// money that has actually arrived. The first is a promise, the second is a
// fact, and GSTR-1 reports only the second (Table 11A). Nothing here may
// blur them.
//
// What is new is not the recording - a receipt voucher could always be
// written - but what it can now say: how the money arrived, which quotation
// it was received against, and therefore what is left to pay. Plus the
// receipt itself, which no voucher in this application could previously
// print.
//
// The calculation half always runs. The DB half is skipped unless
// STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RECEIPT_PDF = rd('client', 'js', 'pages', 'receipt-pdf.js');
const VOUCHERS_JS = rd('client', 'js', 'pages', 'vouchers.js');
const VOUCHERS_HTML = rd('vouchers.html');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const GEN = rd('server', 'src', 'routes', 'generic.js');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const MIG_FILE = 'migration_receipt_voucher_payment.sql';
const MIG = rd('server', 'db', 'migrations', MIG_FILE);

// ═══════════════════════════════════════════════════════════════════════
//  1. The figures, computed by the real function
// ═══════════════════════════════════════════════════════════════════════

const noop = () => {};
function pdfSandbox() {
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, RegExp, Intl,
    parseInt, parseFloat, isFinite, isNaN, Promise,
    window: {}, document: { getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: noop, createElement: () => ({ style: {} }) },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hostname: 'x', href: '', origin: 'http://x' },
    navigator: { userAgent: 'node' }
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(RECEIPT_PDF, sb, { filename: 'receipt-pdf.js' });
  // A top-level `const` in a script is a lexical binding of the context, not
  // a property of the sandbox object, so the tables these modules declare are
  // reachable only by evaluating their names in the same context.
  sb.evalIn = expr => vm.runInContext(expr, sb);
  return sb;
}

// (required test 4)
test('AR1 the worked example: 1,750 quoted, 500 received, 1,250 due', () => {
  const sb = pdfSandbox();
  const f = sb.receiptFigures({ advance_amount: 500 }, { id: 'pf1', total_amount: 1750 }, 0);
  assert.strictEqual(f.linked, true);
  assert.strictEqual(f.total, 1750);
  assert.strictEqual(f.previous, 0);
  assert.strictEqual(f.now, 500);
  assert.strictEqual(f.balance, 1250);
});

// (required test 5)
test('AR2 a second receipt counts what was received before it', () => {
  const sb = pdfSandbox();
  const f = sb.receiptFigures({ advance_amount: 750 }, { id: 'pf1', total_amount: 1750 }, 500);
  assert.strictEqual(f.previous, 500);
  assert.strictEqual(f.now, 750);
  assert.strictEqual(f.balance, 500, '1750 - 500 - 750');

  // And one that settles the quotation leaves nothing.
  const settled = sb.receiptFigures({ advance_amount: 500 }, { id: 'pf1', total_amount: 1750 }, 1250);
  assert.strictEqual(settled.balance, 0);
});

test('AR3 with no quotation the receipt claims no total and no balance', () => {
  const sb = pdfSandbox();
  const f = sb.receiptFigures({ advance_amount: 500 }, null, 0);
  assert.strictEqual(f.linked, false);
  assert.strictEqual(f.total, null, 'it does not invent a total it was never told');
  assert.strictEqual(f.balance, null);
  assert.strictEqual(f.now, 500, 'what it does know is the money received');
});

test('AR4 the receipt is titled as a receipt, and says it is not an invoice', () => {
  assert.match(RECEIPT_PDF, /ADVANCE RECEIPT/);
  assert.match(RECEIPT_PDF, /This is a receipt for an advance payment\. It is not a Tax Invoice\./);
  // Amount in words is of the money received, never of the balance.
  assert.match(RECEIPT_PDF, /Amount Received in Words:/);
  assert.match(RECEIPT_PDF, /numberToWordsINR\(fig\.now\)/);
  // The six methods the payments ledger allows, and no seventh.
  const sb = pdfSandbox();
  assert.deepStrictEqual(Object.keys(sb.evalIn('RECEIPT_METHOD_LABELS')),
    ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other']);
  assert.strictEqual(sb.receiptMethodLabel('bank_transfer'), 'Bank Transfer');
  assert.strictEqual(sb.receiptMethodLabel(null), '');
});

// (required test 9)
test('AR5 a quotation advance term is never read as money received', () => {
  // The receipt's figures come from the voucher and from receipts already
  // recorded - never from proforma_invoices.advance_amount, which is a term.
  assert.equal(/advance_amount/.test(RECEIPT_PDF.replace(/voucher\.advance_amount/g, '')), false,
    'the receipt reads only the voucher amount');
  const fn = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('function voucherReceivedAgainst'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /vReceiptVouchers/, 'what is already received comes from receipt vouchers');
  assert.match(body, /proforma_invoice_id === proformaId/);
});

// ═══════════════════════════════════════════════════════════════════════
//  2. The page
// ═══════════════════════════════════════════════════════════════════════

test('AR6 the form records how the money arrived, for a receipt only', () => {
  for (const id of ['vPaymentMethod', 'vReference', 'vProforma', 'vBalanceBox',
                    'vQuoteTotal', 'vQuotePrev', 'vQuoteBalance', 'vPrintBtn', 'vPdfBtn']) {
    assert.ok(VOUCHERS_HTML.includes('id="' + id + '"'), id + ' is on the page');
  }
  // The six, as option values, matching the ledger's vocabulary.
  for (const m of ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other']) {
    assert.ok(VOUCHERS_HTML.includes('value="' + m + '"'), m + ' is offered');
  }
  // Hidden for a payment or refund voucher: they are different documents.
  assert.match(VOUCHERS_JS, /pay\.classList\.toggle\('d-none', !voucherIsReceipt\(\)\)/);
  assert.match(VOUCHERS_JS, /function voucherIsReceipt\(\) \{ return vType\(\) === 'receipt_voucher'; \}/);
  // The three facts travel only on a receipt voucher.
  const save = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('if (voucherIsReceipt()) {'));
  const block = save.slice(0, save.indexOf('\n  }'));
  for (const f of ['payment_method', 'reference_number', 'proforma_invoice_id']) {
    assert.ok(block.includes('doc.' + f), f + ' is sent');
  }
});

test('AR7 the balance on screen follows the amount being typed', () => {
  assert.match(VOUCHERS_JS, /function recalcVoucher\(\) \{\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*renderVoucherBalance\(\);/);
  // An overpayment is refused on screen before Save, and no balance is
  // implied for it.
  const fn = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('function renderVoucherBalance'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /const over = balance < 0;/);
  assert.match(body, /over \? '\\u2014'/);
});

test('AR8 the receipt prints from what was saved, not from the form', () => {
  assert.match(VOUCHERS_JS, /if \(wasReceipt && saved && saved\.document\) showReceiptActions\(saved\.document\);/);
  const fn = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('async function receiptPdfArgs'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /voucherReceivedAgainst\(quote\.id, vLastSaved\.id\)/,
    'the receipt shows what was received BEFORE it, excluding itself');
});

// ═══════════════════════════════════════════════════════════════════════
//  3. Schema and the save route
// ═══════════════════════════════════════════════════════════════════════

test('AR9 the migration is additive, guarded, listed and matches schema.sql', () => {
  const sql = MIG.replace(/--[^\n]*/g, '');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS payment_method TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reference_number TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS proforma_invoice_id UUID/);
  assert.match(sql, /receipt_vouchers_payment_method_known/);
  assert.equal(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/.test(sql), false, 'nothing destructive, no backfill');
  assert.equal(/DEFAULT/.test(sql), false, 'no DEFAULT: NULL means not recorded');
  assert.equal(/REFERENCES/.test(sql), false, 'no FK: a receipt outlives the quotation');

  const manifest = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));
  const order = Array.isArray(manifest) ? manifest : (manifest.order || manifest.migrations);
  assert.ok(order.includes(MIG_FILE), 'the runner knows about it');

  assert.match(SCHEMA, /payment_method TEXT,\s*\n\s*reference_number TEXT,\s*\n\s*proforma_invoice_id UUID,/);
  const pkg = JSON.parse(rd('server', 'package.json'));
  assert.match(pkg.scripts.prestart, /migrate-receipt-voucher-payment\.js/);
  // The columns are writable through the save path.
  assert.match(GEN, /'payment_method','reference_number','proforma_invoice_id',/);
});

test('AR10 the server judges the payment, under the quotation row lock', () => {
  const fn = DOCS.slice(DOCS.indexOf('async function proformaRoomLeftOn'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /FOR UPDATE/, 'the quotation is locked first');
  assert.ok(body.indexOf('FOR UPDATE') < body.indexOf('SUM(advance_amount)'),
    'and only then are the receipts against it summed');
  // Judged inside the save transaction, before any column is written.
  const save = DOCS.slice(DOCS.indexOf("router.post('/:type/save'"));
  const at = save.indexOf('await validateReceiptPayment(client');
  assert.ok(save.indexOf("client.query('BEGIN')") < at,
    'it runs inside the transaction, where the client is connected and a throw rolls back');
  assert.ok(at < save.indexOf('INSERT INTO'), 'and before anything is written');
  // Nothing here writes to the money tables that already exist.
  const rules = DOCS.slice(DOCS.indexOf('async function validateReceiptPayment'));
  const rulesBody = rules.slice(0, rules.indexOf('\n}\n'));
  for (const t of ['payments', 'advance_adjustments', 'b2b_invoices', 'b2c_invoices']) {
    assert.equal(new RegExp('INSERT INTO ' + t + '|UPDATE ' + t).test(rulesBody), false,
      'recording a receipt must not touch ' + t);
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  4. Against a real database
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('advance receipt persistence (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'advance-receipt-secret';

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
    child.on('exit', (c) => { clearTimeout(done); reject(new Error('server exited ' + c + ':\n' + out)); });
  });
}

let server = null, BASE = '', USER = '', TOKEN = '', OTHER_TOKEN = '', QUOTE = null;
const db = new Client({ connectionString: SCRATCH });

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || TOKEN) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes answer no body */ }
  return { status: res.status, body: json };
}

let rvSeq = 0;
const receipt = (extra) => ({
  document: {
    document_number: 'RV-T' + String(++rvSeq).padStart(4, '0'),
    document_date: '2026-10-23',
    party_name: 'Anand Caterers',
    place_of_supply: 'Tamil Nadu',
    supply_type: 'intrastate',
    description: 'Advance against quotation',
    advance_amount: 500,
    gst_percentage: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total_value: 500,
    ...(extra || {})
  }
});
const saveReceipt = (extra, token) => api('POST', '/api/documents/receipt_voucher/save', receipt(extra), token);
const receiptsFor = async (proformaId) => (await db.query(
  'SELECT COALESCE(SUM(advance_amount),0)::numeric s FROM receipt_vouchers WHERE proforma_invoice_id = $1',
  [proformaId])).rows[0].s;

test('database setup', async () => {
  await db.connect();
  await db.query(MIG);                       // additive; a no-op where applied
  await db.query('TRUNCATE users CASCADE');
  const { rows } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('receipt@scratch.test','x') RETURNING id");
  USER = rows[0].id;
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
     VALUES ($1,'VTECH','VTECH Engineering Works','33AAGCV4521K1ZT','Tamil Nadu','Coimbatore','14, Avinashi Road')`,
    [USER]);
  const { rows: other } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('other-receipt@scratch.test','x') RETURNING id");
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
     VALUES ($1,'Other','Other Traders','33AACCO1234M1ZR','Tamil Nadu','Coimbatore','1 Street')`,
    [other[0].id]);
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '2h' });
  OTHER_TOKEN = jwt.sign({ sub: other[0].id }, process.env.JWT_SECRET, { expiresIn: '2h' });

  // The quotation from the brief: 1,750 total, advance TERM of 500.
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name,
       state, district, supply_type, taxable_amount, gst_percentage, gst_amount,
       cgst, sgst, total_amount, advance_amount)
     VALUES ($1,'PI-T0001','2026-10-23','Anand Caterers','Tamil Nadu','Coimbatore','intrastate',
             1483.05,18,266.95,133.48,133.47,1750,500) RETURNING id, total_amount, advance_amount`,
    [USER]);
  QUOTE = pf.rows ? pf.rows[0] : pf[0];

  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;
});

// (required tests 1, 2, 4)
test('AR11 a receipt saves, is numbered, and leaves 1,250 due', async () => {
  const saved = await saveReceipt({ proforma_invoice_id: QUOTE.id, payment_method: 'upi',
    reference_number: 'UPI-77231', advance_amount: 500, total_value: 500 });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const doc = saved.body.document;
  assert.ok(doc.document_number, 'it carries a number');
  assert.strictEqual(doc.payment_method, 'upi');
  assert.strictEqual(doc.reference_number, 'UPI-77231');
  assert.strictEqual(doc.proforma_invoice_id, QUOTE.id);
  assert.strictEqual(Number(doc.advance_amount), 500);

  assert.strictEqual(Number(await receiptsFor(QUOTE.id)), 500);
  const left = Number(QUOTE.total_amount) - Number(await receiptsFor(QUOTE.id));
  assert.strictEqual(left, 1250, 'the worked example, from stored rows');
});

// (required test 5)
test('AR12 a second receipt is measured against what is left', async () => {
  const second = await saveReceipt({ proforma_invoice_id: QUOTE.id, payment_method: 'cash',
    advance_amount: 1250, total_value: 1250 });
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  assert.strictEqual(Number(await receiptsFor(QUOTE.id)), 1750, 'the quotation is now settled');

  // ...and a third has nothing left to take.
  const third = await saveReceipt({ proforma_invoice_id: QUOTE.id, advance_amount: 1, total_value: 1 });
  assert.strictEqual(third.status, 409, JSON.stringify(third.body));
  assert.match(third.body.error.message, /has 0\.00 left to receive/i);
  assert.strictEqual(third.body.error.code, 'receipt_exceeds_quotation');
  assert.strictEqual(Number(await receiptsFor(QUOTE.id)), 1750, 'and nothing was written');
});

// (required tests 6, 7)
test('AR13 invalid amounts, unknown methods and overpayment are refused', async () => {
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name,
       state, district, supply_type, total_amount)
     VALUES ($1,'PI-T0002','2026-10-23','Anand Caterers','Tamil Nadu','Coimbatore','intrastate',1000)
     RETURNING id`, [USER]);
  const q = pf[0].id;

  for (const [amount, pattern] of [[0, /more than zero/i], [-5, /more than zero/i], ['abc', /more than zero/i]]) {
    const r = await saveReceipt({ proforma_invoice_id: q, advance_amount: amount, total_value: 0 });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(String(r.body && r.body.error && r.body.error.message), pattern, JSON.stringify(r.body));
  }
  const method = await saveReceipt({ proforma_invoice_id: q, payment_method: 'bitcoin' });
  assert.strictEqual(method.status, 400);
  assert.match(method.body.error.message, /Payment method must be one of/);

  const over = await saveReceipt({ proforma_invoice_id: q, advance_amount: 1000.01, total_value: 1000.01 });
  assert.strictEqual(over.status, 409);

  assert.strictEqual(Number(await receiptsFor(q)), 0, 'not one refusal wrote a row');
});

// (required test 11)
test('AR14 a quotation belonging to someone else cannot be received against', async () => {
  const theirs = await saveReceipt({ proforma_invoice_id: QUOTE.id, advance_amount: 10, total_value: 10 },
    OTHER_TOKEN);
  assert.strictEqual(theirs.status, 404, JSON.stringify(theirs.body));
  assert.strictEqual(theirs.body.error.code, 'proforma_not_found');

  const anon = await fetch(BASE + '/api/documents/receipt_voucher/save',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt()) });
  assert.strictEqual(anon.status, 401, 'and an unauthenticated caller gets nowhere');
});

// (required tests 8, 10)
test('AR15 receipts are their own ledger: nothing else is touched', async () => {
  const before = await db.query(
    `SELECT (SELECT count(*)::int FROM payments WHERE user_id = $1) p,
            (SELECT count(*)::int FROM advance_adjustments WHERE user_id = $1) a,
            (SELECT count(*)::int FROM b2c_invoices WHERE user_id = $1) i`, [USER]);
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name,
       state, district, supply_type, total_amount, advance_amount)
     VALUES ($1,'PI-T0003','2026-10-23','Anand Caterers','Tamil Nadu','Coimbatore','intrastate',2000,750)
     RETURNING id, advance_amount`, [USER]);

  const r = await saveReceipt({ proforma_invoice_id: pf[0].id, advance_amount: 300, total_value: 300 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await db.query(
    `SELECT (SELECT count(*)::int FROM payments WHERE user_id = $1) p,
            (SELECT count(*)::int FROM advance_adjustments WHERE user_id = $1) a,
            (SELECT count(*)::int FROM b2c_invoices WHERE user_id = $1) i`, [USER]);
  assert.deepStrictEqual(after.rows[0], before.rows[0],
    'no payment, no 11B adjustment and no invoice was created by receiving money');

  // (required test 9) the quotation's own advance TERM is untouched by the
  // money that actually arrived - they are different facts.
  const { rows: quote } = await db.query(
    'SELECT advance_amount, total_amount FROM proforma_invoices WHERE id = $1', [pf[0].id]);
  assert.strictEqual(Number(quote[0].advance_amount), 750, 'the quoted term did not move');
  assert.strictEqual(Number(quote[0].total_amount), 2000, 'nor did the quotation total');
});

test('AR16 editing a receipt does not count it against itself', async () => {
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name,
       state, district, supply_type, total_amount)
     VALUES ($1,'PI-T0004','2026-10-23','Anand Caterers','Tamil Nadu','Coimbatore','intrastate',1000)
     RETURNING id`, [USER]);
  const q = pf[0].id;

  const first = await saveReceipt({ proforma_invoice_id: q, advance_amount: 1000, total_value: 1000 });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  const id = first.body.document.id;

  // Re-saving the same receipt with the same amount must be accepted: it is
  // not a second receipt competing with the first for the same room.
  const again = await api('POST', '/api/documents/receipt_voucher/save', {
    editId: id,
    document: { ...receipt().document, document_number: first.body.document.document_number,
      proforma_invoice_id: q, advance_amount: 1000, total_value: 1000, payment_method: 'cheque' }
  });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(again.body.document.payment_method, 'cheque', 'the edit landed');
  assert.strictEqual(Number(await receiptsFor(q)), 1000, 'and it is still one receipt');
});

test('teardown', async () => {
  if (server) { server.kill(); await new Promise(r => server.on('exit', r)); }
  await db.end();
});
