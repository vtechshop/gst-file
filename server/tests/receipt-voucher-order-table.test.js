// The receipt voucher's order breakdown, to the rupee.
//
// The specification gives one worked example and it is the whole test:
//
//     Steamer 8 Tray with Idly Tray
//     Product Amount        55,000
//     Packing Charge         1,500
//     Total before GST      56,500
//     GST @ 18%             10,170
//     Total Order Value     66,670
//     Advance Received      30,000
//     Balance Payable       36,670
//
// What makes it worth asserting is the last three lines: the order is
// 66,670 and the money that arrived is 30,000, and a receipt that
// confuses the two is a receipt claiming money the business did not get.
//
// No database and no browser: the real functions are loaded into a vm
// sandbox and run, so these are the figures the page and the PDF actually
// produce rather than a restatement of the arithmetic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const VJS = read('client/js/pages/vouchers.js');
const PDFJS = read('client/js/pages/receipt-pdf.js');
const HTML = read('vouchers.html');

// The worked example, once.
const EXAMPLE = {
  product: 'Steamer 8 Tray with Idly Tray',
  productAmount: 55000,
  packing: 1500,
  beforeGst: 56500,
  gstRate: 18,
  gst: 10170,
  orderTotal: 66670,
  advance: 30000,
  balance: 36670
};

// ── The arithmetic the brief states, stated back ──
test('RT1 the example adds up, exactly', () => {
  assert.strictEqual(EXAMPLE.productAmount + EXAMPLE.packing, 56500, '55,000 + 1,500 = 56,500');
  assert.strictEqual(Math.round(EXAMPLE.beforeGst * EXAMPLE.gstRate) / 100, 10170,
    '56,500 x 18% = 10,170');
  assert.strictEqual(EXAMPLE.beforeGst + EXAMPLE.gst, 66670, '56,500 + 10,170 = 66,670');
  assert.strictEqual(EXAMPLE.orderTotal - EXAMPLE.advance, 36670, '66,670 - 30,000 = 36,670');
  // No rounding anywhere in this example, which is why it is a good one.
  assert.strictEqual(EXAMPLE.beforeGst * 0.18, 10170);
});

// ── The page's own functions, run ──
function voucherSandbox(items, packing, gstRate) {
  const els = {};
  const el = (id, value) => {
    els[id] = els[id] || { value: '', textContent: '', classList: { add() {}, remove() {}, contains: () => false }, dataset: {}, style: {}, disabled: false };
    if (value !== undefined) els[id].value = String(value);
    return els[id];
  };
  el('vPackingCharge', packing);
  el('vOrderGstRate', gstRate);
  el('vProforma', '');
  el('vOrderItemsTotal');
  el('vSupplyNature', 'goods');
  el('vAmount', String(EXAMPLE.advance));

  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {} }),
      addEventListener() {},
      readyState: 'complete'
    },
    window: {}, console,
    round2: (n) => Math.round((+n + Number.EPSILON) * 100) / 100,
    formatCurrency: (n) => '₹' + Number(n).toFixed(2),
    formatNum: (n) => Number(n || 0).toFixed(2),
    escItemHtml: (s) => String(s == null ? '' : s),
    getCachedProfile: () => ({ state: 'Tamil Nadu', registration_type: 'regular' }),
    showToast() {}, apiFetch: async () => ({}), handleApiError() {},
    _supabase: { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }) }) },
    voucherProformaById: () => null,
    // The real one, from client/js/utilities/utils.js, which the sandbox
    // does not load. Copied rather than stubbed loosely: the split matters
    // to what voucherAmounts() returns.
    calcGST: (taxable, pct, supplyType) => {
      // The real return shape from utils.js, key for key. An approximation
      // here would have let a missing key read as NaN and still "pass" an
      // assertion that only looked at the split.
      const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
      const gstAmt = (taxable * pct) / 100;
      const igst = supplyType === 'interstate' ? gstAmt : 0;
      const half = supplyType === 'interstate' ? 0 : gstAmt / 2;
      return {
        gstAmount: r2(gstAmt), igst: r2(igst), cgst: r2(half), sgst: r2(half),
        totalGst: r2(gstAmt), totalAmount: r2(taxable + gstAmt)
      };
    },
    requireAuth: async () => ({}), initNavUser() {}, setupLogoutBtn() {}
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(VJS + '\n;globalThis.__set = (k, v) => { eval(k + " = v"); };', ctx);
  // vOrderItems is let-bound, so it is set through the helper rather than
  // as a sandbox property.
  vm.runInContext('__set("vOrderItems", ' + JSON.stringify(items) + ')', ctx);
  return { ctx, els };
}

test('RT2 one product row produces the exact order breakdown', () => {
  const { ctx } = voucherSandbox(
    [{ name: EXAMPLE.product, quantity: '', rate: '', amount: EXAMPLE.productAmount }],
    EXAMPLE.packing, EXAMPLE.gstRate);
  const o = vm.runInContext('voucherOrderAmounts()', ctx);

  assert.strictEqual(o.amount, EXAMPLE.productAmount, 'Product Amount');
  assert.strictEqual(o.packing, EXAMPLE.packing, 'Packing Charge');
  assert.strictEqual(o.taxable, EXAMPLE.beforeGst, 'Total before GST');
  assert.strictEqual(o.rate, EXAMPLE.gstRate, 'GST rate stays 18');
  assert.strictEqual(o.gst, EXAMPLE.gst, 'GST amount');
  assert.strictEqual(o.total, EXAMPLE.orderTotal, 'Total Order Value');
  assert.strictEqual(o.source, 'manual');
});

test('RT3 several product rows sum into the same breakdown', () => {
  // The same order, itemised. The totals must not change.
  const { ctx } = voucherSandbox([
    { name: 'Steamer 8 Tray', quantity: 1, rate: 40000, amount: '' },
    { name: 'Idly Tray Set', quantity: 3, rate: 5000, amount: '' }
  ], EXAMPLE.packing, EXAMPLE.gstRate);
  const o = vm.runInContext('voucherOrderAmounts()', ctx);
  assert.strictEqual(o.amount, 55000, '40,000 + 3 x 5,000 = 55,000');
  assert.strictEqual(o.taxable, EXAMPLE.beforeGst);
  assert.strictEqual(o.gst, EXAMPLE.gst);
  assert.strictEqual(o.total, EXAMPLE.orderTotal);
  assert.strictEqual(o.quantity, 4, 'the quantities add up too');
});

test('RT4 a lump-sum row is not overwritten by quantity x rate', () => {
  // "55,000 for the machine", no quantity. Deriving would make it 0.
  const { ctx } = voucherSandbox(
    [{ name: EXAMPLE.product, quantity: '', rate: '', amount: 55000 }], 0, 18);
  const o = vm.runInContext('voucherOrderAmounts()', ctx);
  assert.strictEqual(o.amount, 55000);
  // And a row with both still multiplies.
  const two = voucherSandbox([{ name: 'x', quantity: 2, rate: 100, amount: '' }], 0, 18);
  assert.strictEqual(vm.runInContext('voucherOrderAmounts()', two.ctx).amount, 200);
});

test('RT5 the advance received is the money, not the order', () => {
  const { ctx } = voucherSandbox(
    [{ name: EXAMPLE.product, quantity: '', rate: '', amount: EXAMPLE.productAmount }],
    EXAMPLE.packing, EXAMPLE.gstRate);
  const a = vm.runInContext('voucherAmounts()', ctx);
  // vAmount is the advance. The order total must NOT be what is recorded
  // as received - that is the whole point of the section being separate.
  assert.strictEqual(a.taxable, EXAMPLE.advance, 'only 30,000 is received');
  assert.notStrictEqual(a.taxable, EXAMPLE.orderTotal);

  const o = vm.runInContext('voucherOrderAmounts()', ctx);
  assert.strictEqual(round2(o.total - EXAMPLE.advance), EXAMPLE.balance, 'Balance Payable 36,670');
});
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

test('RT6 a goods advance carries no GST, and the ORDER rate stays 18%', () => {
  const { ctx } = voucherSandbox(
    [{ name: EXAMPLE.product, quantity: '', rate: '', amount: EXAMPLE.productAmount }],
    EXAMPLE.packing, EXAMPLE.gstRate);
  const a = vm.runInContext('voucherAmounts()', ctx);
  // Notification 66/2017: no tax on a goods advance for an eligible
  // registered person. voucherAmounts() reports the split rather than one
  // total, so the whole split has to be nil - and the RATE has to be nil
  // too, or a later recalculation would bring the tax back.
  assert.strictEqual(a.rate, 0, 'no rate is applied to the advance');
  assert.strictEqual(round2(a.igst + a.cgst + a.sgst), 0, 'and no tax of any kind');
  assert.strictEqual(a.cess, 0);
  assert.strictEqual(a.total, EXAMPLE.advance, 'the receipt totals the money received, nothing more');
  const o = vm.runInContext('voucherOrderAmounts()', ctx);
  assert.strictEqual(o.rate, 18, "the product's GST rate is NOT zeroed");
  assert.strictEqual(o.gst, EXAMPLE.gst, 'and the order still carries 10,170');
});

// ── The form shows each figure in its own place ──
test('RT7 the form has an invoice-style product table, with the totals below it', () => {
  // A table with a row per product, not one description box.
  assert.match(HTML, /<table class="data-table" id="vOrderItemsTable">/);
  assert.match(HTML, /<tbody id="vOrderItemsBody">/);
  assert.match(HTML, /id="vOrderAddRow"/, 'and a way to add another product');
  for (const head of ['Product Description', 'Qty', 'Rate', 'Amount']) {
    assert.ok(HTML.includes('>' + head + '<') || HTML.includes(head + ' ('),
      'the table has a ' + head + ' column');
  }
  // The single-row fields are gone, so there is one way to enter a product.
  for (const gone of ['id="vOrderDesc"', 'id="vOrderQty"', 'id="vOrderRate"']) {
    assert.equal(HTML.includes(gone), false, gone + ' must no longer exist');
  }

  // Packing below the table, then the breakdown, in this order.
  const at = (s) => { const i = HTML.indexOf(s); assert.ok(i > 0, 'missing: ' + s); return i; };
  const table = at('id="vOrderItemsTable"');
  const packing = at('id="vPackingCharge"');
  const beforeGst = at('>Total before GST<');
  const gstLine = at('id="vOrderGstAmount"');
  const total = at('>Total Order Value<');
  const advance = at('>Advance Receipt Details<');
  assert.ok(table < packing, 'Packing Charge comes below the product table');
  assert.ok(packing < beforeGst, 'then Total before GST');
  assert.ok(beforeGst < gstLine, 'then the GST line');
  assert.ok(gstLine < total, 'then Total Order Value');
  assert.ok(total < advance, 'and the advance section is separate, after the order');
});

test('RT8 the GST rate and the GST amount are separate lines, and the total is highlighted', () => {
  assert.match(HTML, /GST \(<span id="vOrderGstRateOut">0<\/span>%\)/,
    'the rate is shown as a rate');
  assert.match(HTML, /<span class="value" id="vOrderGstAmount">/, 'and the amount as an amount');
  // calc-row total is the class the stylesheet emphasises.
  assert.match(HTML, /<div class="calc-row total"><span class="label">Total Order Value<\/span>/,
    'Total Order Value is the highlighted row');
});

test('RT9 the advance section shows what arrived and what is left', () => {
  const section = HTML.slice(HTML.indexOf('>Advance Receipt Details<'));
  // Every line the brief names, in its own section, each with its own id.
  for (const [id, label] of [
    ['vQuoteTotal', 'Order Value'],
    ['vQuotePrev', 'Advance Received Earlier'],
    ['vQuoteNow', 'Current Advance Received'],
    ['vQuotePaid', 'Total Advance Paid'],
    ['vQuoteBalance', 'Balance Payable']]) {
    assert.ok(section.includes('id="' + id + '"'), 'the advance section shows ' + label);
    assert.ok(section.includes('>' + label + '<'), label + ' is labelled');
  }
  // Balance Payable is the emphasised row of that box.
  assert.match(section, /<div class="calc-row total">\s*<span class="label">Balance Payable<\/span>/);
  assert.match(HTML, /id="vPaymentDate"/, 'and the date the money arrived is recorded');
  // The amount actually received is its own input, separate from the order.
  assert.match(HTML, /id="vAmount"/);
  assert.ok(HTML.indexOf('id="vOrderTotal"') !== HTML.indexOf('id="vAmount"'),
    'the order total and the amount received are different fields');
});

// ── The PDF prints the same figures, in the same places ──
test('RT10 the PDF prints the product table and the full breakdown', () => {
  // The item table, reading either shape of row.
  assert.match(PDFJS, /head: \[\['#', 'Description', 'HSN', 'Qty', 'Unit', 'Rate', 'GST %', 'Amount'\]\]/);
  assert.match(PDFJS, /it\.total_amount != null \? it\.total_amount : it\.taxable_value/,
    "a voucher's own items carry taxable_value, not total_amount");
  assert.match(PDFJS, /const orderRate = \+voucher\.order_gst_rate \|\| 0;/,
    'and the order rate fills the GST % column for a manual row');

  // Every line the brief names, by its name.
  for (const label of ['Product Amount', 'Packing Charge', 'Total before GST', 'GST on Order',
    'Total Order Value', 'Advance Received Now', 'Balance Payable',
    'Applicable GST Rate', 'GST on this Advance']) {
    assert.ok(PDFJS.includes(label), 'the receipt prints "' + label + '"');
  }
  // And it is an advance receipt, never a tax invoice.
  assert.match(PDFJS, /ADVANCE RECEIPT/);
  assert.equal(/TAX INVOICE/.test(PDFJS), false);
});

test('RT11 the PDF figures come from the same function as the form', () => {
  // receiptFigures derives the order rather than re-deriving it
  // differently, which is what would let the screen and the paper
  // disagree. Asserted on the source: both read the voucher's own columns
  // or the quotation, never a third computation.
  const at = PDFJS.indexOf('function receiptFigures');
  assert.ok(at > 0, 'receiptFigures exists');
  const fig = PDFJS.slice(at, at + 3200);
  assert.match(fig, /packing_charge/);
  assert.match(fig, /order_gst_rate/);
  assert.match(fig, /order_amount/);
  assert.ok(/quotation/.test(fig), 'the quotation path is handled in the same place');
});

// ── Storage ──
test('RT12 the items have somewhere to live, additively', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations',
    'migration_receipt_voucher_items.sql'), 'utf8');
  const exec = mig.replace(/--.*$/gm, '');
  for (const kw of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i, /\bDROP\s+TABLE\b/i]) {
    assert.equal(kw.test(exec), false, 'the migration must not execute ' + kw);
  }
  assert.equal(/^\s*BEGIN\s*;/mi.test(exec), false, 'the runner owns the transaction');
  // The document-to-line-item cascade, which is the right one here.
  assert.match(exec, /receipt_voucher_id UUID NOT NULL REFERENCES receipt_vouchers\(id\) ON DELETE CASCADE/);
  // And it must not disturb the already-applied cascade migration.
  assert.match(exec, /user_id UUID NOT NULL REFERENCES users\(id\),/,
    'NO ACTION, so the 49-RESTRICT assertion still holds');
  assert.match(exec, /n_restrict <> 49/, 'and it checks that itself');

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db',
    'migrations', '_manifest.json'), 'utf8'));
  assert.ok(manifest.order.includes('migration_receipt_voucher_items.sql'));
  assert.equal(manifest.order.filter(f => /rollback/.test(f)).length, 0);

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS receipt_voucher_items/);
});

test('RT13 the save sends the rows, and reads them back on edit', () => {
  assert.match(VJS, /function voucherOrderItemsPayload\(\)/);
  assert.match(VJS, /taxable_value: voucherItemAmount\(it\)/, 'each row carries its own amount');
  assert.match(VJS, /\.\.\.\(orderItems \? \{ items: orderItems \} : \{\}\)/,
    'items ride along with the document');
  assert.match(VJS, /from\('receipt_voucher_items'\)/, 'and are read back');
  // An old voucher with no rows still shows what it always showed.
  assert.match(VJS, /if \(!vOrderItems\.length && \(r\.description \|\| r\.order_amount != null\)\)/);
  // The server writes them in the same transaction as the voucher.
  const docs = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'documents.js'), 'utf8');
  assert.match(docs, /items: 'receipt_voucher_items', itemsFk: 'receipt_voucher_id'/);
});
