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
  // vDocs is the receipt_vouchers table whenever this form is open, and it is
  // the only ledger consulted - the quotation's own advance_amount is not.
  assert.match(body, /vDocs/, 'what is already received comes from receipt vouchers');
  assert.match(body, /voucherIsReceipt\(\)/, 'and only when this form is the receipt');
  assert.match(body, /proforma_invoice_id === proformaId/);
  assert.equal(/advance_amount \|\| 0\)\), 0\)\);[\s\S]*total_amount/.test(body), false,
    'it never reaches for the quotation total');
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

// ═══════════════════════════════════════════════════════════════════════
//  4. The quotation shown on the form: its lines, its party, its arithmetic
// ═══════════════════════════════════════════════════════════════════════

// vouchers.js only declares - it has no top-level side effects - so it can be
// loaded into a context and its functions called one at a time. The DOM stub
// keeps one element per id so a write by the code under test is readable back.
function vouchersSandbox(opts) {
  const o = opts || {};
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      const node = {
        id, value: '', innerHTML: '', textContent: '', options: [],
        classList: {
          _s: new Set(),
          add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
          contains(c) { return this._s.has(c); },
          toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); }
        },
        add(opt) { this.options.push(opt); }
      };
      els[id] = node;
    }
    return els[id];
  };
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, RegExp, Intl,
    parseInt, parseFloat, isFinite, isNaN, Promise, Set, Map,
    Option: function (text, value) { return { text, value }; },
    document: {
      getElementById: (id) => (o.missing && o.missing.includes(id) ? null : el(id)),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => ({ style: {} })
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hostname: 'x', href: '', origin: 'http://x' },
    navigator: { userAgent: 'node' },
    // Not loaded: apiClient.js and the rest of the page's stack. Only the few
    // names vouchers.js reaches for are provided, so a test failure points at
    // vouchers.js rather than at someone else's module.
    readAll: async () => [(o.items || [])],
    _supabase: { from: () => ({ select: () => ({ eq: () => ({}) }) }) },
    showToast: noop, handleApiError: noop, apiFetch: async () => ({}),
    getCachedProfile: () => ({ state: 'Tamil Nadu' }),
    recalcVoucher: noop, validateVoucherForm: () => ({}),
    gstDocumentTypeSpec: () => ({ series: 'RV', portalName: '11A' }),
    gstDocumentTypeLabel: (k) => k, gstDocumentTypeEnabled: () => true,
    INDIAN_STATES: ['Tamil Nadu', 'Kerala'], GST_RATE_SLABS: [0, 5, 12, 18, 28],
    compareInvoiceNumbers: (a, b) => String(a).localeCompare(String(b))
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(VOUCHERS_JS, sb, { filename: 'vouchers.js' });
  sb.evalIn = (expr) => vm.runInContext(expr, sb);
  sb.el = el;
  // This page edits three document types; everything here is the receipt.
  el('vDocType').value = 'receipt_voucher';
  return sb;
}

const FORM_QUOTE = {
  id: 'pf-1', document_number: 'PI/2026/004', document_date: '2026-10-20',
  customer_name: 'Ravi & Co <Chennai>', gst_number: '33AAAAA0000A1Z5',
  state: 'Tamil Nadu', taxable_amount: 1483.05, gst_amount: 266.95,
  total_amount: 1750, status: 'issued'
};

const FORM_FORM_QUOTE_LINES = [
  { sort_order: 2, product_name: 'Mixer Grinder', hsn_code: '8509', quantity: 1,
    unit: 'PCS', rate: 1200, gst_percentage: 18, total_amount: 1416 },
  { sort_order: 1, product_name: 'Wall Bracket', hsn_code: '7308', quantity: 2,
    unit: 'PCS', rate: 141.53, gst_percentage: 18, total_amount: 334 }
];

test('AR17 picking a quotation fills the party but never the amount', () => {
  const sb = vouchersSandbox();
  sb.evalIn('vProformas = ' + JSON.stringify([FORM_QUOTE]));
  sb.el('vProforma').value = FORM_QUOTE.id;
  sb.el('vAmount').value = '500';

  sb.applyQuotationParty(sb.voucherProformaById(FORM_QUOTE.id));
  assert.strictEqual(sb.el('vPartyName').value, FORM_QUOTE.customer_name);
  assert.strictEqual(sb.el('vPartyGstin').value, FORM_QUOTE.gst_number);
  // proforma_invoices has no place_of_supply column; the quotation's state is
  // the place of supply, which is what the voucher's own field holds.
  assert.strictEqual(sb.el('vPos').value, 'Tamil Nadu');
  // (required test 6) The quoted advance is a TERM. Money received is typed.
  assert.strictEqual(sb.el('vAmount').value, '500', 'the amount is left alone');
});

test('AR18 the quotation lines render read-only, with every column and a grand total', async () => {
  const sb = vouchersSandbox({ items: FORM_FORM_QUOTE_LINES });
  sb.evalIn('vProformas = ' + JSON.stringify([FORM_QUOTE]));
  sb.el('vProforma').value = FORM_QUOTE.id;

  await sb.renderVoucherQuotePanel();

  assert.strictEqual(sb.el('vQuotePanel').classList.contains('d-none'), false, 'the panel is shown');
  const body = sb.el('vQuoteItemsBody').innerHTML;
  // Sorted by sort_order, so the bracket (1) precedes the grinder (2).
  assert.ok(body.indexOf('Wall Bracket') < body.indexOf('Mixer Grinder'), 'sort_order is honoured');
  for (const v of ['8509', 'PCS', '1,200.00', '18%', '1,416.00']) {
    assert.match(body, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'shows ' + v);
  }
  // A customer name containing markup is shown as text, not injected.
  const summary = sb.el('vQuoteSummary').innerHTML;
  // escItemHtml escapes & " and <, which is what stops a tag forming; a lone
  // > is harmless and is left as itself.
  assert.equal(/<Chennai/.test(summary), false, 'the party name cannot open a tag');
  assert.match(summary, /&lt;Chennai>/);
  assert.match(summary, /Ravi &amp; Co/);
  // (required test 3) The grand total of the quotation, not of the receipt.
  assert.match(sb.el('vQuoteItemsTotal').innerHTML, /GRAND TOTAL \(2 items\)/);
  assert.match(sb.el('vQuoteItemsTotal').innerHTML, /1,750\.00/);
  // Nothing in the panel is an input: it is reference data on a receipt, and
  // a receipt is not a tax invoice.
  assert.equal(/<input|<select|contenteditable/.test(body + summary), false);

  // Choosing "no quotation" puts it away again - standalone receipts stay
  // possible, which is the flow that existed before any of this.
  sb.el('vProforma').value = '';
  await sb.renderVoucherQuotePanel();
  assert.strictEqual(sb.el('vQuotePanel').classList.contains('d-none'), true);
});

test('AR19 what was received earlier comes from the receipts actually loaded', () => {
  const sb = vouchersSandbox();
  sb.evalIn('vProformas = ' + JSON.stringify([FORM_QUOTE]));

  // The regression this guards: the figure used to be read from the refund
  // voucher's picker list, which a receipt form never fills, so the screen
  // showed nothing received however many receipts existed. vDocs IS the
  // receipt_vouchers table whenever this form is open.
  sb.evalIn('vDocs = ' + JSON.stringify([
    { id: 'r1', proforma_invoice_id: 'pf-1', advance_amount: 500, status: 'issued' },
    { id: 'r2', proforma_invoice_id: 'pf-1', advance_amount: 250, status: 'issued' },
    { id: 'r3', proforma_invoice_id: 'pf-other', advance_amount: 999, status: 'issued' }
  ]));
  assert.strictEqual(sb.voucherReceivedAgainst('pf-1', null), 750,
    'both receipts against this quotation, and nothing from another');
  assert.strictEqual(sb.voucherReceivedAgainst('pf-1', 'r2'), 500,
    'the receipt being edited is not its own competitor');

  // (required test 10) And the balance that follows from it.
  sb.el('vProforma').value = 'pf-1';
  sb.el('vAmount').value = '1000';
  sb.renderVoucherBalance();
  assert.match(sb.el('vQuoteTotal').textContent, /1,750\.00/);
  assert.match(sb.el('vQuotePrev').textContent, /750\.00/);
  // 1750 - 750 - 1000 settles the quotation exactly, which is a balance.
  assert.match(sb.el('vQuoteBalance').textContent, /0\.00/);
  assert.strictEqual(sb.el('vBalanceError').classList.contains('d-none'), true);

  // One rupee more than is due is refused, not quietly absorbed.
  sb.el('vAmount').value = '1200';
  sb.renderVoucherBalance();
  assert.strictEqual(sb.el('vQuoteBalance').textContent, '\u2014',
    'a negative balance is not shown as one');
  assert.strictEqual(sb.el('vBalanceError').classList.contains('d-none'), false);

  // The worked example, with nothing received before it.
  sb.evalIn('vDocs = []');
  sb.el('vAmount').value = '500';
  sb.renderVoucherBalance();
  assert.match(sb.el('vQuoteBalance').textContent, /1,250\.00/, '1750 - 0 - 500');
  assert.strictEqual(sb.el('vBalanceError').classList.contains('d-none'), true);
});

test('AR20 a cancelled receipt releases the room it held', () => {
  const sb = vouchersSandbox();
  sb.evalIn('vProformas = ' + JSON.stringify([FORM_QUOTE]));
  sb.evalIn('vDocs = ' + JSON.stringify([
    { id: 'r1', proforma_invoice_id: 'pf-1', advance_amount: 500, status: 'issued' },
    { id: 'r2', proforma_invoice_id: 'pf-1', advance_amount: 250, status: 'cancelled' }
  ]));
  assert.strictEqual(sb.voucherReceivedAgainst('pf-1', null), 500,
    'only the receipt still standing is held against the quotation');

  // (requirement 3) And so the balance on screen offers that room back.
  sb.el('vProforma').value = 'pf-1';
  sb.el('vAmount').value = '1250';
  sb.renderVoucherBalance();
  assert.match(sb.el('vQuotePrev').textContent, /500\.00/, 'not 750');
  assert.match(sb.el('vQuoteBalance').textContent, /0\.00/, '1750 - 500 - 1250');
  assert.strictEqual(sb.el('vBalanceError').classList.contains('d-none'), true,
    'a receipt that fits the freed room is not flagged');

  // The screen and the enforcer must read the same condition, or one of them
  // promises room the other refuses.
  assert.match(DOCS, /AND status <> 'cancelled'/,
    'the server leaves cancelled receipts out of the sum too');
  const fn = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('function voucherReceivedAgainst'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /!== 'cancelled'/);
});

test('AR21 the payment facts do not outlive their receipt, and come back on edit', () => {
  const reset = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('function resetVoucherForm'));
  const resetBody = reset.slice(0, reset.indexOf('\n}'));
  for (const id of ['vPaymentMethod', 'vReference', 'vProforma']) {
    assert.match(resetBody, new RegExp(id), 'a new form clears ' + id);
  }
  assert.match(resetBody, /vQuotePanel/, 'and puts the quotation panel away');

  // Opening a saved receipt must show what it recorded; without this the
  // fields came up empty and the next save wrote the blanks back.
  assert.match(VOUCHERS_JS, /setVoucherValue\('vPaymentMethod', r\.payment_method/);
  assert.match(VOUCHERS_JS, /setVoucherValue\('vReference', r\.reference_number/);
  assert.match(VOUCHERS_JS, /setVoucherValue\('vProforma', r\.proforma_invoice_id/);
  // The selector lists open quotations only, so a receipt taken against one
  // since cancelled needs its option put back or the link is lost on save.
  assert.match(VOUCHERS_JS, /Quotation no longer listed/);
});

test('AR22 the printed table shows the quoted rate and GST, and no false receipt', () => {
  // (required test 9) The quotation's figures are printed as the quotation's.
  assert.match(RECEIPT_PDF, /'#', 'Description', 'HSN', 'Qty', 'Unit', 'Rate', 'GST %', 'Amount'/);
  assert.match(RECEIPT_PDF, /\(\+it\.gst_percentage \|\| 0\) \+ '%'/);
  // Money received is the voucher's own amount, and the only figure the words
  // are written from. The quotation total is labelled as the quotation's.
  assert.match(RECEIPT_PDF, /\['Advance Received Now', formatNum\(fig\.now\)\]/);
  assert.match(RECEIPT_PDF, /\['Quotation Total', formatNum\(fig\.total\)\]/);
  assert.match(RECEIPT_PDF, /numberToWordsINR\(fig\.now\)/);

  // And the figures themselves, from the real function.
  const sb = pdfSandbox();
  const f = sb.receiptFigures({ advance_amount: 500 }, FORM_QUOTE, 0);
  assert.strictEqual(f.now, 500, 'received');
  assert.strictEqual(f.total, 1750, 'quoted');
  assert.notStrictEqual(f.now, f.total, 'the quotation total is never the amount received');
});

test('AR23 cancelling an advance hands its room back, and the record is kept', async () => {
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name,
       state, district, supply_type, total_amount)
     VALUES ($1,'PI-T0005','2026-10-23','Anand Caterers','Tamil Nadu','Coimbatore','intrastate',1750)
     RETURNING id`, [USER]);
  const q = pf[0].id;
  // What is actually held against the quotation, which is the figure the cap
  // is computed from - as opposed to receiptsFor(), which counts every row
  // ever written and so also proves nothing was deleted.
  const heldAgainst = async () => Number((await db.query(
    `SELECT COALESCE(SUM(advance_amount),0)::numeric s FROM receipt_vouchers
      WHERE proforma_invoice_id = $1 AND status <> 'cancelled'`, [q])).rows[0].s);

  const first = await saveReceipt({ proforma_invoice_id: q, advance_amount: 1750, total_value: 1750 });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  const firstId = first.body.document.id;
  assert.strictEqual(await heldAgainst(), 1750, 'the quotation is fully received against');

  // With nothing left, a further receipt is refused.
  const blocked = await saveReceipt({ proforma_invoice_id: q, advance_amount: 100, total_value: 100 });
  assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
  assert.strictEqual(blocked.body.error.code, 'receipt_exceeds_quotation');

  // Cancel it.
  const cancelled = await api('POST', '/api/documents/receipt_voucher/' + firstId + '/cancel', { reason: '' });
  assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));

  // (requirement 5) The receipt is still there, with its number and amount.
  const { rows: kept } = await db.query('SELECT * FROM receipt_vouchers WHERE id = $1', [firstId]);
  assert.strictEqual(kept.length, 1, 'the row was kept, not deleted');
  assert.strictEqual(kept[0].status, 'cancelled');
  assert.strictEqual(Number(kept[0].advance_amount), 1750, 'and it still records what was received');
  assert.strictEqual(kept[0].document_number, first.body.document.document_number,
    'a cancelled document keeps its number');
  assert.strictEqual(Number(await receiptsFor(q)), 1750, 'the history is intact');

  // (requirements 1 and 2) But it no longer occupies room.
  assert.strictEqual(await heldAgainst(), 0);
  const again = await saveReceipt({ proforma_invoice_id: q, advance_amount: 1750, total_value: 1750 });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(await heldAgainst(), 1750, 'the freed room was taken by the new receipt');

  // (requirement 4) And a genuine overpayment is still refused afterwards.
  const over = await saveReceipt({ proforma_invoice_id: q, advance_amount: 0.01, total_value: 0.01 });
  assert.strictEqual(over.status, 409, JSON.stringify(over.body));
  assert.strictEqual(await heldAgainst(), 1750, 'and nothing was written');

  // The cancelled receipt is not resurrected by any of this.
  const { rows: still } = await db.query(
    "SELECT status FROM receipt_vouchers WHERE id = $1", [firstId]);
  assert.strictEqual(still[0].status, 'cancelled');
});

test('AR24 the five figures a customer asks about, and they follow the typing', () => {
  const sb = vouchersSandbox();
  sb.evalIn('vProformas = ' + JSON.stringify([FORM_QUOTE]));
  sb.evalIn('vDocs = ' + JSON.stringify([
    { id: 'r1', proforma_invoice_id: 'pf-1', advance_amount: 500, status: 'issued' },
    { id: 'r2', proforma_invoice_id: 'pf-1', advance_amount: 300, status: 'cancelled' }
  ]));
  sb.el('vProforma').value = 'pf-1';

  // The worked example, continued: 1,750 quoted, 500 already received, 250
  // being received now. The cancelled 300 is not money held.
  sb.el('vAmount').value = '250';
  sb.renderVoucherBalance();
  const shown = (id) => sb.el(id).textContent;
  assert.match(shown('vQuoteTotal'), /1,750\.00/, 'Quotation Total');
  assert.match(shown('vQuotePrev'), /500\.00/, 'Advance Received Earlier');
  assert.match(shown('vQuoteNow'), /250\.00/, 'Current Advance Received');
  assert.match(shown('vQuotePaid'), /750\.00/, 'Total Advance Paid = 500 + 250');
  assert.match(shown('vQuoteBalance'), /1,000\.00/, 'Balance Payable = 1750 - 750');

  // Typing a different amount moves the three figures that depend on it, and
  // leaves the two that do not.
  sb.el('vAmount').value = '1250';
  sb.renderVoucherBalance();
  assert.match(shown('vQuoteTotal'), /1,750\.00/, 'the quotation did not change');
  assert.match(shown('vQuotePrev'), /500\.00/, 'nor what was received before');
  assert.match(shown('vQuoteNow'), /1,250\.00/);
  assert.match(shown('vQuotePaid'), /1,750\.00/);
  assert.match(shown('vQuoteBalance'), /0\.00/, 'the quotation is settled exactly');
  assert.strictEqual(sb.el('vBalanceError').classList.contains('d-none'), true);

  // An empty amount box is nothing received, not NaN.
  sb.el('vAmount').value = '';
  sb.renderVoucherBalance();
  assert.match(shown('vQuoteNow'), /^\u20B90\.00$/);
  assert.match(shown('vQuotePaid'), /500\.00/);
  assert.match(shown('vQuoteBalance'), /1,250\.00/);

  // And the labels are the ones the customer was promised.
  assert.match(VOUCHERS_HTML, /Current Advance Received/);
  assert.match(VOUCHERS_HTML, /Total Advance Paid/);
  assert.match(VOUCHERS_HTML, /Balance Payable/);
});

test('AR25 cancelling or deleting a receipt refreshes the figure on screen', () => {
  // Both paths reload the rows; without recomputing, the box kept showing the
  // old arithmetic while a quotation was still selected.
  for (const name of ['cancelVoucher', 'deleteVoucher']) {
    const fn = VOUCHERS_JS.slice(VOUCHERS_JS.indexOf('async function ' + name));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /await loadVouchers\(\);/, name + ' reloads the receipts');
    assert.match(body, /renderVoucherBalance\(\);/, name + ' then recomputes the balance');
  }
});

test('AR26 a receipt with no quotation saves, and is capped by nothing', async () => {
  // Every other test here links a quotation. This is the flow that existed
  // before any of it: money received against no particular quotation.
  const saved = await saveReceipt({ payment_method: 'cash', advance_amount: 2500, total_value: 2500 });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const doc = saved.body.document;
  assert.strictEqual(doc.proforma_invoice_id, null, 'no quotation, and no invented one');
  assert.strictEqual(Number(doc.advance_amount), 2500);
  assert.ok(doc.document_number, 'and it is numbered like any other receipt');

  // An explicit empty string is the same thing as none - that is what the
  // form sends when the selector is on "no quotation".
  const blank = await saveReceipt({ proforma_invoice_id: '', advance_amount: 10, total_value: 10 });
  assert.strictEqual(blank.status, 200, JSON.stringify(blank.body));
  assert.strictEqual(blank.body.document.proforma_invoice_id, null);

  // The amount still has to be real money, quotation or no quotation.
  const zero = await saveReceipt({ advance_amount: 0, total_value: 0 });
  assert.strictEqual(zero.status, 400, JSON.stringify(zero.body));
  assert.strictEqual(zero.body.error.code, 'receipt_amount_invalid');
});

test('AR27 the quotation link survives a save and an edit', async () => {
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name,
       state, district, supply_type, total_amount)
     VALUES ($1,'PI-T0006','2026-10-23','Anand Caterers','Tamil Nadu','Coimbatore','intrastate',900)
     RETURNING id`, [USER]);
  const q = pf[0].id;

  const saved = await saveReceipt({ proforma_invoice_id: q, payment_method: 'upi',
    reference_number: 'UPI-99', advance_amount: 400, total_value: 400 });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.document.id;
  assert.strictEqual(saved.body.document.proforma_invoice_id, q, 'stored on save');

  // Editing only the amount must leave the link, method and reference alone.
  const edited = await api('POST', '/api/documents/receipt_voucher/save', {
    editId: id,
    document: { ...receipt().document, document_number: saved.body.document.document_number,
      proforma_invoice_id: q, payment_method: 'upi', reference_number: 'UPI-99',
      advance_amount: 600, total_value: 600 }
  });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
  const after = edited.body.document;
  assert.strictEqual(after.proforma_invoice_id, q, 'and still stored after the edit');
  assert.strictEqual(after.payment_method, 'upi');
  assert.strictEqual(after.reference_number, 'UPI-99');
  assert.strictEqual(Number(after.advance_amount), 600);

  // Read back from the table rather than the response, so this is what a
  // later edit would actually load into the form.
  const { rows } = await db.query('SELECT * FROM receipt_vouchers WHERE id = $1', [id]);
  assert.strictEqual(rows[0].proforma_invoice_id, q);
  assert.strictEqual(rows[0].payment_method, 'upi');
  assert.strictEqual(rows[0].reference_number, 'UPI-99');
});

test('teardown', async () => {
  if (server) { server.kill(); await new Promise(r => server.on('exit', r)); }
  await db.end();
});
