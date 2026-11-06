// The Receipt Voucher's order details, and what tax an advance carries.
//
// A receipt voucher records money a customer paid in advance. Two things it
// could not say before: what ORDER that advance belongs to when there is no
// quotation to read it from, and whether any GST is payable on the advance at
// all. The second is the one that matters:
//
//   Section 31(3)(d) requires a receipt voucher for every advance and Rule 50
//   says what it must contain - but Notification 66/2017-Central Tax,
//   15 November 2017, relieved every registered person other than a
//   composition taxpayer from PAYING tax on an advance for a supply of
//   GOODS. Tax falls due when the invoice is issued. For services it is due
//   on receipt (Section 13(2)).
//
// The form charged GST on every advance, which is right for services and
// wrong for goods. A goods advance is now the default and carries none.
//
// What this change must NOT do, and most of this file is about:
//
//   * restate the tax on a voucher already issued. Reopening one must read
//     the treatment it was issued with, never impose today's default.
//   * change what the GSTR-1 export does. The export is untouched; what
//     reaches Table 11A changes only because a new goods advance carries no
//     tax to report, which is the point.
//   * make the order a second copy of a linked quotation's figures.
//
// No database and no browser: the arithmetic is run in a sandbox over the
// real page scripts, and the wiring is read out of the files the page loads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = rd('vouchers.html');
const VJS = rd('client', 'js', 'pages', 'vouchers.js');
const PDF = rd('client', 'js', 'pages', 'receipt-pdf.js');
const GEN = rd('server', 'src', 'routes', 'generic.js');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const MIG_FILE = 'migration_receipt_voucher_order.sql';
const MIG = rd('server', 'db', 'migrations', MIG_FILE);
const UTILS = rd('client', 'js', 'utilities', 'utils.js');

const nocomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');

// ── The page's own functions, driven over a fake form ─────────────────
//
// The real vouchers.js, run against a document whose fields are whatever the
// test puts in them. That way the figures under test are the ones the page
// computes, not a restatement of them.
function voucherSandbox(values) {
  const vals = Object.assign({ vDocType: 'receipt_voucher' }, values || {});
  const made = {};
  const el = (id) => (made[id] || (made[id] = {
    value: vals[id] !== undefined ? String(vals[id]) : '',
    textContent: '', innerHTML: '', disabled: false, readOnly: false,
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    options: [], add() {}, setAttribute() {}, removeAttribute() {}
  }));
  const sb = {
    console, Math, String, Number, parseInt, parseFloat, isNaN, isFinite, Date,
    JSON, RegExp, Object, Array, Set, Map, Error, Intl,
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => ({ style: {} }),
      body: {}, head: {}, documentElement: { style: {} }
    },
    navigator: { userAgent: 'node' },
    location: { hostname: 'localhost', href: '', search: '' },
    setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('shared', 'india-districts.js'), sb);
  vm.runInContext(UTILS, sb);
  // The two helpers vouchers.js reaches for that live on other pages.
  vm.runInContext('function getCachedProfile(){return {state:"Tamil Nadu", registration_type:"regular"};}'
    + 'function showToast(){} function escItemHtml(s){return String(s);}', sb);
  vm.runInContext(VJS + ';globalThis.__V = this;', sb);
  sb.__el = el;
  // vProformas and vDocs are declared with `let` in vouchers.js, so they
  // live in the context's lexical scope rather than on globalThis and
  // cannot be set as properties. Assigning them through a script in the
  // same context reaches the same bindings the page's functions read.
  sb.__set = (name, value) => {
    sb.__incoming = value;
    vm.runInContext(name + ' = globalThis.__incoming;', sb);
  };
  // The order used to be one description, one quantity and one rate. It is
  // a list of products now, so a fixture written as vOrderQty/vOrderRate is
  // translated into the one row it describes - the same order, entered the
  // way the form enters it. Every existing fixture therefore keeps meaning
  // exactly what it meant.
  const _q = String(values.vOrderQty == null ? '' : values.vOrderQty).trim();
  const _r = String(values.vOrderRate == null ? '' : values.vOrderRate).trim();
  if (_q || _r || values.vOrderDesc) {
    sb.__set('vOrderItems', [{
      name: values.vOrderDesc || 'Order', quantity: _q, rate: _r, amount: ''
    }]);
  }
  return sb;
}

// The quotation shape the page reads, matching proforma_invoices.
const QUOTE = {
  id: 'q1', document_number: 'PI-00007', customer_name: 'A Customer',
  document_date: '2026-01-01',
  taxable_amount: 56500, transport_charge: 1500, gst_percentage: 18,
  gst_amount: 10170, total_amount: 66670, status: 'issued'
};

// ═══ 1. The worked example ════════════════════════════════════════════

test('RV1 55,000 + 1,500 = 56,500, 18% = 10,170, order total 66,670', () => {
  const sb = voucherSandbox({
    vOrderQty: '1', vOrderRate: '55000', vPackingCharge: '1500', vOrderGstRate: '18'
  });
  const o = sb.voucherOrderAmounts();
  assert.strictEqual(o.source, 'manual');
  assert.strictEqual(o.amount, 55000, 'product amount');
  assert.strictEqual(o.packing, 1500, 'packing charge');
  assert.strictEqual(o.taxable, 56500, 'taxable amount');
  assert.strictEqual(o.rate, 18, 'rate');
  assert.strictEqual(o.gst, 10170, 'GST amount');
  assert.strictEqual(o.total, 66670, 'total order value');
});

test('RV2 the advance records 30,000 and the balance is 36,670', () => {
  const sb = voucherSandbox({
    vOrderQty: '1', vOrderRate: '55000', vPackingCharge: '1500', vOrderGstRate: '18',
    vAmount: '30000', vSupplyNature: 'goods', vPos: 'Tamil Nadu'
  });
  const o = sb.voucherOrderAmounts();
  const a = sb.voucherAmounts();
  assert.strictEqual(a.taxable, 30000, 'only the money actually received');
  assert.strictEqual(sb.round2(o.total - a.taxable), 36670, 'balance payable');
  // The full order value must never be recorded as received.
  assert.notStrictEqual(a.taxable, o.total, 'the order total is not money received');
});

test('RV3 a quantity above one multiplies the rate', () => {
  const sb = voucherSandbox({ vOrderQty: '2', vOrderRate: '55000', vPackingCharge: '1500',
    vOrderGstRate: '18' });
  const o = sb.voucherOrderAmounts();
  assert.strictEqual(o.amount, 110000);
  assert.strictEqual(o.taxable, 111500);
  assert.strictEqual(o.gst, 20070);
  assert.strictEqual(o.total, 131570);
});

test('RV4 every figure is rounded to two decimal places', () => {
  const sb = voucherSandbox({ vOrderQty: '3', vOrderRate: '333.33', vPackingCharge: '0.005',
    vOrderGstRate: '18' });
  const o = sb.voucherOrderAmounts();
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'number') continue;
    assert.strictEqual(v, Math.round(v * 100) / 100, k + ' must be rounded to paise');
  }
});

// ═══ 2. The GST question ══════════════════════════════════════════════

test('RV5 a goods advance carries no GST at all', () => {
  const sb = voucherSandbox({ vAmount: '30000', vRate: '18', vCess: '500',
    vSupplyNature: 'goods', vPos: 'Tamil Nadu' });
  const a = sb.voucherAmounts();
  assert.strictEqual(a.rate, 0, 'no rate');
  assert.strictEqual(a.igst + a.cgst + a.sgst, 0, 'no GST');
  assert.strictEqual(a.cess, 0, 'and no cess');
  assert.strictEqual(a.total, 30000, 'the total is the money received');
  // Forced in the figures, not only in the UI, so a disabled box still
  // holding 18 cannot be saved as 18.
  assert.match(nocomment(VJS), /const goodsAdvance = voucherIsReceipt\(\)/);
  // Gated on the registration type: the relief is not available to everyone
  // (see receipt-voucher-migration-safety.test.js MS1-MS5).
  assert.match(nocomment(VJS), /&& voucherAdvanceReliefApplies\(\);/);
});

test('RV6 a services advance is taxed on receipt, exactly as before', () => {
  const sb = voucherSandbox({ vAmount: '30000', vRate: '18', vCess: '0',
    vSupplyNature: 'services', vPos: 'Tamil Nadu' });
  const a = sb.voucherAmounts();
  assert.strictEqual(a.rate, 18);
  assert.strictEqual(sb.round2(a.cgst + a.sgst), 5400, 'intrastate, split');
  assert.strictEqual(a.igst, 0);
  assert.strictEqual(a.total, 35400);
});

test('RV7 goods is the default for a new receipt', () => {
  assert.match(VJS, /const VOUCHER_SUPPLY_NATURE_DEFAULT = 'goods';/);
  // The reset path returns to it, so a new voucher never inherits the
  // previous one's treatment.
  const reset = VJS.slice(VJS.indexOf('function resetVoucherForm'));
  const body = reset.slice(0, reset.indexOf('\n}'));
  assert.match(body, /setVoucherValue\('vSupplyNature', voucherSupplyNatureDefault\(\)\)/);
  // Which is 'goods' only where the relief applies, so an ineligible
  // business is never defaulted onto a relief it cannot claim.
  assert.match(VJS, /return voucherAdvanceReliefApplies\(\) \? VOUCHER_SUPPLY_NATURE_DEFAULT : 'services';/);
  // And the control offers exactly the two lawful answers.
  assert.match(HTML, /<option value="goods">/);
  assert.match(HTML, /<option value="services">/);
  const sel = HTML.slice(HTML.indexOf('id="vSupplyNature"'));
  const block = sel.slice(0, sel.indexOf('</select>'));
  assert.strictEqual((block.match(/<option/g) || []).length, 2, 'two options, no third');
});

test('RV8 an issued voucher keeps the treatment it was issued with', () => {
  // The rule that stops this change rewriting history: a voucher raised
  // before supply_nature existed has none recorded, and reopening it must
  // read the tax it actually carries rather than today's default. Without
  // this, opening an old taxed receipt would read as goods, zero its GST and
  // change an issued document on the next save.
  const edit = VJS.slice(VJS.indexOf('function editVoucher'));
  const body = edit.slice(0, edit.indexOf('\n}'));
  assert.match(body, /const nature = r\.supply_nature\s*\n\s*\|\| \(\(\+r\.gst_percentage \|\| 0\) > 0 \? 'services' : 'goods'\)/,
    'the nature is inferred from the GST the voucher carries');
  assert.match(body, /setVoucherValue\('vRate', String\(\+r\.gst_percentage \|\| 0\)\)/,
    'and the stored rate is put back');
  // The same inference on the printed side, for the same reason.
  assert.match(nocomment(PDF), /supplyNature: \(voucher && voucher\.supply_nature\)\s*\n\s*\|\| \(\(Number\(voucher && voucher\.gst_percentage\) \|\| 0\) > 0 \? 'services' : 'goods'\)/);
});

test('RV9 no return or registry logic was changed', () => {
  // The whole point of section 4 of the brief. GSTR-1 builds Table 11A from
  // the GST stored on each voucher; this change alters what a NEW goods
  // advance stores, and nothing about how the export reads it.
  const g1 = rd('client', 'js', 'gst', 'gstr1-export.js');
  assert.match(g1, /function gstr1BuildAdvanceSection\(rows, amountOf, posOf, supplyTypeOf, errors, context\)/,
    'the 11A builder is untouched');
  // supply_nature appears in this file for cdn_notes, which is a different
  // column on a different table - so the check is aimed at the advance
  // builder, which is the part this change could have touched.
  const adv = g1.slice(g1.indexOf('function gstr1BuildAdvanceSection'));
  const advBody = adv.slice(0, adv.indexOf('\n}'));
  assert.strictEqual(/supply_nature|66\/2017|order_amount|packing_charge/.test(advBody), false,
    '11A still just reads the tax stored on the voucher');
  assert.match(advBody, /b\.iamt = round2\(b\.iamt \+ round2\(r\.igst\)\)/,
    'unchanged: it sums the stored tax');
  // The registry entry keeps its own wording and flags; changing those would
  // change every document type's reported treatment.
  assert.match(UTILS, /key: 'receipt_voucher'[\s\S]{0,400}affectsLiability: true/,
    'the registry entry is unchanged');
  assert.strictEqual(/supply_nature/.test(UTILS), false,
    'the registry does not read the new column');
  // No voucher path writes a tax figure onto an existing row.
  assert.strictEqual(/UPDATE receipt_vouchers|\.update\(\{[^}]*gst_percentage/.test(VJS), false,
    'nothing rewrites the tax on an existing voucher');
});

// ═══ 3. Linked quotation vs typed order ═══════════════════════════════

test('RV10 a linked quotation is the order, and is read not copied', () => {
  const sb = voucherSandbox({ vProforma: 'q1', vOrderRate: '999', vPackingCharge: '999' });
  sb.__set('vProformas', [QUOTE]);
  const o = sb.voucherOrderAmounts();
  assert.strictEqual(o.source, 'quotation');
  assert.strictEqual(o.taxable, 56500);
  assert.strictEqual(o.packing, 1500, 'the quotation transport charge is its packing line');
  assert.strictEqual(o.amount, 55000, 'and the product amount is the rest');
  assert.strictEqual(o.gst, 10170);
  assert.strictEqual(o.total, 66670);
  // The typed boxes are ignored entirely while a quotation is linked, so the
  // two cannot contradict each other.
  assert.notStrictEqual(o.amount, 999);

  // And nothing of the quotation's is written onto the voucher.
  const save = VJS.slice(VJS.indexOf('async function saveVoucher'));
  const body = save.slice(0, save.indexOf('\n}'));
  assert.match(body, /if \(o\.source === 'manual'\) \{/,
    'the order columns are written only for a typed order');
  assert.strictEqual(/from\('proforma_invoices'\)[\s\S]{0,120}\.update\(/.test(VJS), false,
    'and the quotation itself is never written to');
});

test('RV11 a typed order needs no quotation', () => {
  const sb = voucherSandbox({ vOrderRate: '55000', vPackingCharge: '1500',
    vOrderGstRate: '18', vAmount: '30000' });
  const o = sb.voucherOrderAmounts();
  assert.strictEqual(o.source, 'manual');
  assert.strictEqual(o.total, 66670);
  // The manual boxes exist, and are put out of reach when a quotation is
  // linked rather than left to disagree with it.
  for (const id of ['vPackingCharge', 'vOrderGstRate']) {
    assert.ok(HTML.includes('id="' + id + '"'), id + ' must exist on the form');
  }
  // The reset empties the product rows, then the two boxes that remain.
  assert.match(nocomment(VJS), /vOrderItems = \[\];/);
  assert.match(nocomment(VJS), /renderVoucherOrderItems\(\);/);
  assert.match(nocomment(VJS), /\['vPackingCharge', 'vOrderGstRate'\]\.forEach/);
});

// ═══ 4. Advance aggregation and excess protection ═════════════════════

test('RV12 previous and current advances aggregate, and the balance follows', () => {
  const sb = voucherSandbox({ vProforma: 'q1', vAmount: '20000' });
  sb.__set('vProformas', [QUOTE]);
  // Two receipts already recorded against this quotation.
  sb.__set('vDocs', [
    { id: 'r1', proforma_invoice_id: 'q1', advance_amount: 30000, status: 'issued' },
    { id: 'r2', proforma_invoice_id: 'q1', advance_amount: 10000, status: 'issued' }
  ]);
  const previous = sb.voucherReceivedAgainst('q1', null);
  assert.strictEqual(previous, 40000, 'previous advance received');
  const o = sb.voucherOrderAmounts();
  assert.strictEqual(sb.round2(previous + 20000), 60000, 'total advance paid');
  assert.strictEqual(sb.round2(o.total - previous - 20000), 6670, 'balance payable');
});

test('RV13 a cancelled receipt is not money received', () => {
  const sb = voucherSandbox({ vProforma: 'q1' });
  sb.__set('vProformas', [QUOTE]);
  sb.__set('vDocs', [
    { id: 'r1', proforma_invoice_id: 'q1', advance_amount: 30000, status: 'issued' },
    { id: 'r2', proforma_invoice_id: 'q1', advance_amount: 10000, status: 'cancelled' }
  ]);
  assert.strictEqual(sb.voucherReceivedAgainst('q1', null), 30000,
    'a cancelled advance is no longer held');
});

test('RV14 an advance beyond the order is refused, and says why', () => {
  // More than the order value, with nothing received before.
  let sb = voucherSandbox({ vDocNumber: 'RV-00001', vDocDate: '2026-01-02',
    vPartyName: 'A Customer', vPos: 'Tamil Nadu',
    vOrderRate: '55000', vPackingCharge: '1500', vOrderGstRate: '18', vAmount: '70000' });
  let e = sb.voucherFormErrors();
  assert.ok(e.amount, 'refused');
  assert.match(e.amount, /more than the .*66,670\.00 order value/);

  // And beyond what is LEFT, when some was received before.
  sb = voucherSandbox({ vDocNumber: 'RV-00002', vDocDate: '2026-01-02',
    vPartyName: 'A Customer', vPos: 'Tamil Nadu', vProforma: 'q1', vAmount: '40000' });
  sb.__set('vProformas', [QUOTE]);
  sb.__set('vDocs', [{ id: 'r1', proforma_invoice_id: 'q1', advance_amount: 30000, status: 'issued' }]);
  e = sb.voucherFormErrors();
  assert.ok(e.amount, 'refused');
  assert.match(e.amount, /Only .*36,670\.00 is still due/);
  assert.match(e.amount, /30,000\.00 has already been received/);

  // Exactly the outstanding amount is allowed - it is the final payment.
  sb = voucherSandbox({ vDocNumber: 'RV-00003', vDocDate: '2026-01-02',
    vPartyName: 'A Customer', vPos: 'Tamil Nadu', vProforma: 'q1', vAmount: '36670' });
  sb.__set('vProformas', [QUOTE]);
  sb.__set('vDocs', [{ id: 'r1', proforma_invoice_id: 'q1', advance_amount: 30000, status: 'issued' }]);
  assert.strictEqual(sb.voucherFormErrors().amount, undefined, 'the last rupee is allowed');
});

test('RV15 the same refusal is enforced on the server, under a row lock', () => {
  // The browser's check is a courtesy; this is the one that holds when two
  // receipts arrive together. Unchanged by this work, and asserted because
  // the form's new validation must not be mistaken for the guarantee.
  const docs = rd('server', 'src', 'routes', 'documents.js');
  const fn = docs.slice(docs.indexOf('async function proformaRoomLeftOn'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /FOR UPDATE/, 'the quotation is locked first');
  assert.ok(body.indexOf('FOR UPDATE') < body.indexOf('SUM(advance_amount)'),
    'and only then are the receipts against it summed');
  assert.match(docs, /receipt_exceeds_quotation/);
});

test('RV16 order inputs are validated', () => {
  const base = { vDocNumber: 'RV-1', vDocDate: '2026-01-02', vPartyName: 'A', vPos: 'Tamil Nadu',
    vAmount: '100' };
  let e = voucherSandbox(Object.assign({}, base, { vOrderRate: '-5' })).voucherFormErrors();
  assert.match(e.order_rate, /cannot be negative/);
  e = voucherSandbox(Object.assign({}, base, { vPackingCharge: '-1' })).voucherFormErrors();
  assert.match(e.packing_charge, /cannot be negative/);
  e = voucherSandbox(Object.assign({}, base, { vOrderRate: '10.005' })).voucherFormErrors();
  assert.match(e.order_rate, /two decimal places/);
  e = voucherSandbox(Object.assign({}, base, { vPackingCharge: '1.2345' })).voucherFormErrors();
  assert.match(e.packing_charge, /two decimal places/);
  // Required customer and document details are unchanged.
  e = voucherSandbox({ vAmount: '100' }).voucherFormErrors();
  assert.ok(e.document_number && e.document_date && e.party_name && e.place_of_supply);
  // An amount is still required.
  assert.match(voucherSandbox(Object.assign({}, base, { vAmount: '0' })).voucherFormErrors().amount,
    /greater than zero/);
});

test('RV17 a payment date cannot be in the future or precede the quotation', () => {
  const base = { vDocNumber: 'RV-1', vDocDate: '2026-01-02', vPartyName: 'A', vPos: 'Tamil Nadu',
    vAmount: '100', vOrderRate: '55000', vOrderGstRate: '18' };
  let e = voucherSandbox(Object.assign({}, base, { vPaymentDate: '2099-01-01' })).voucherFormErrors();
  assert.match(e.payment_date, /future/);
  const sb = voucherSandbox(Object.assign({}, base, { vProforma: 'q1', vPaymentDate: '2025-12-31' }));
  sb.__set('vProformas', [QUOTE]);  // quoted 2026-01-01
  assert.match(sb.voucherFormErrors().payment_date, /before the quotation/);
  // A blank payment date is allowed: it simply was not recorded.
  assert.strictEqual(voucherSandbox(base).voucherFormErrors().payment_date, undefined);
});

// ═══ 5. The printed receipt ═══════════════════════════════════════════

function pdfFigures(voucher, quotation, previous) {
  const sb = {
    console, Math, String, Number, parseInt, parseFloat, isNaN, isFinite, Date,
    JSON, RegExp, Object, Array, Set, Map, Error, Intl,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => ({ style: {} }),
      body: {}, head: {}, documentElement: { style: {} }
    },
    navigator: { userAgent: 'node' }, location: { hostname: 'localhost', href: '', search: '' },
    setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('shared', 'india-districts.js'), sb);
  vm.runInContext(UTILS, sb);
  vm.runInContext(PDF + ';globalThis.__P = { receiptFigures };', sb);
  return sb.__P.receiptFigures(voucher, quotation, previous);
}

test('RV18 the receipt prints the order, the advances and the balance', () => {
  const f = pdfFigures({ advance_amount: 30000, supply_nature: 'goods' }, QUOTE, 0);
  assert.strictEqual(f.total, 66670, 'order value');
  assert.strictEqual(f.now, 30000, 'received now');
  assert.strictEqual(f.previous, 0);
  assert.strictEqual(f.paid, 30000);
  assert.strictEqual(f.balance, 36670, 'balance payable');
  assert.strictEqual(f.order.taxable, 56500);
  assert.strictEqual(f.order.gstAmount, 10170);
  assert.strictEqual(f.order.packing, 1500);

  // With a previous advance, both are printed and the total says something
  // the two figures do not.
  const g = pdfFigures({ advance_amount: 20000 }, QUOTE, 30000);
  assert.strictEqual(g.previous, 30000);
  assert.strictEqual(g.paid, 50000);
  assert.strictEqual(g.balance, 16670);

  // The rows themselves.
  // Renamed to match the form and the specification: one figure, one name.
  for (const label of ['Product Amount', 'Packing Charge', 'Total before GST',
    'Advance Received Earlier', 'Advance Received Now', 'Total Advance Paid', 'Balance Payable']) {
    assert.ok(PDF.includes(label), 'the receipt must print ' + label);
  }
  assert.match(PDF, /GST on Order @ \$\{formatNum\(fig\.order\.gstRate\)\}%/);
});

test('RV19 a typed order prints from the voucher, with no quotation', () => {
  const f = pdfFigures({
    advance_amount: 30000, order_amount: 55000, packing_charge: 1500, order_gst_rate: 18,
    supply_nature: 'goods'
  }, null, 0);
  assert.strictEqual(f.linked, false);
  assert.strictEqual(f.order.source, 'voucher');
  assert.strictEqual(f.order.taxable, 56500);
  assert.strictEqual(f.order.gstAmount, 10170);
  assert.strictEqual(f.total, 66670);
  assert.strictEqual(f.balance, 36670, 'a balance is printed without a quotation too');
});

test('RV20 the receipt says which tax rule was applied, and is not an invoice', () => {
  assert.match(PDF, /'ADVANCE RECEIPT'/, 'labelled as a receipt');
  assert.strictEqual(/TAX INVOICE/.test(PDF), false, 'and never as a tax invoice');
  assert.match(PDF, /Notification 66\/2017-Central Tax/);
  assert.match(PDF, /Advance for goods: no GST is charged on this advance/);
  assert.match(PDF, /Advance for services: GST is due on receipt \(Section 13\(2\)\)/);
  // Payment mode, reference and the date the money arrived.
  assert.match(PDF, /'Payment Mode'/);
  assert.match(PDF, /'Reference: ' \+ voucher\.reference_number/);
  assert.match(PDF, /'Paid on: ' \+ formatDate/);
  // The words are of the money received, never of the order or the balance.
  assert.match(PDF, /numberToWordsINR\(fig\.now\)/);
});

// ═══ 6. The data model ════════════════════════════════════════════════

test('RV21 the migration is additive, guarded, listed - and not in prestart', () => {
  const sql = MIG.replace(/--[^\n]*/g, '');
  for (const col of ['supply_nature TEXT', 'party_address TEXT', 'payment_date DATE',
    'order_quantity NUMERIC(14,3)', 'order_rate NUMERIC(14,2)', 'order_amount NUMERIC(14,2)',
    'packing_charge NUMERIC(14,2)', 'order_gst_rate NUMERIC(5,2)']) {
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS ' + col), col + ' must be added guarded');
  }
  assert.equal(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/.test(sql), false, 'nothing destructive, no backfill');
  assert.equal(/DEFAULT/.test(sql), false, 'no DEFAULT: NULL means not recorded');
  assert.equal(/REFERENCES/.test(sql), false, 'no foreign key');
  assert.match(sql, /receipt_vouchers_supply_nature_known/);
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/, 'each CHECK is guarded');

  const manifest = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));
  const order = Array.isArray(manifest) ? manifest : (manifest.order || manifest.migrations);
  assert.ok(order.includes(MIG_FILE), 'the migrator knows about it');

  // Deliberately NOT wired into prestart: this migration is written for
  // review and is not run by a deploy.
  const pkg = JSON.parse(rd('server', 'package.json'));
  assert.strictEqual(/receipt.voucher.order/.test(pkg.scripts.prestart), false,
    'prestart must not run it');
});

test('RV22 schema.sql matches the migration, and the columns are writable', () => {
  const tbl = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS receipt_vouchers'));
  const body = tbl.slice(0, tbl.indexOf('\n);'));
  for (const col of ['supply_nature TEXT', 'party_address TEXT', 'payment_date DATE',
    'order_quantity NUMERIC(14,3)', 'order_rate NUMERIC(14,2)', 'order_amount NUMERIC(14,2)',
    'packing_charge NUMERIC(14,2)', 'order_gst_rate NUMERIC(5,2)']) {
    assert.ok(body.includes(col), 'schema.sql must declare ' + col);
  }
  assert.match(body, /receipt_vouchers_supply_nature_known/);
  assert.match(GEN, /'supply_nature','party_address','payment_date',/);
  assert.match(GEN, /'order_quantity','order_rate','order_amount','packing_charge','order_gst_rate',/);
});

test('RV23 nothing derived is stored', () => {
  // The taxable value, the order GST and the order total are computed
  // wherever they are shown, so they cannot disagree with the inputs.
  const sql = MIG.replace(/--[^\n]*/g, '');
  for (const col of ['order_taxable', 'order_gst_amount', 'order_total', 'balance']) {
    assert.strictEqual(sql.includes(col), false, col + ' must not be a column');
  }
  const save = VJS.slice(VJS.indexOf('async function saveVoucher'));
  const body = save.slice(0, save.indexOf('\n}'));
  for (const f of ['order_taxable', 'order_gst_amount', 'order_total']) {
    assert.strictEqual(body.includes('doc.' + f), false, f + ' must not be saved');
  }
});

// ═══ 7. The form, and what it leaves alone ════════════════════════════

test('RV24 the form is in the five sections the receipt needs', () => {
  for (const title of ['Voucher Information', 'Order / Proforma Details',
    'Advance Receipt Details', 'Summary']) {
    assert.ok(HTML.includes('>' + title + '<') || HTML.includes(title),
      'the form must have a ' + title + ' section');
  }
  // Customer Details is set from the registry, because the same form serves
  // a supplier-side voucher too.
  assert.match(VJS, /f\.party === 'supplier' \? 'Supplier Details' : 'Customer Details'/);
  for (const id of ['vDocNumber', 'vDocDate', 'vDocType', 'vStatusBadge',
    'vPartyName', 'vPartyGstin', 'vPartyAddress', 'vPos',
    // The order is a table now: a row per product, with Add and Remove.
    'vProforma', 'vOrderItemsTable', 'vOrderItemsBody', 'vOrderAddRow',
    'vOrderItemsTotal', 'vPackingCharge', 'vOrderGstRate',
    'vOrderTaxable', 'vOrderGstAmount', 'vOrderTotal',
    'vQuotePrev', 'vQuoteNow', 'vQuotePaid', 'vQuoteBalance',
    'vPaymentMethod', 'vReference', 'vPaymentDate', 'vSupplyNature', 'vReceivedNote']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'the form must carry ' + id);
  }
});

test('RV25 the summary separates the order from the money received', () => {
  assert.match(HTML, />Order Value</, 'the order is labelled as the order');
  assert.match(HTML, />Current Advance Received</);
  assert.match(HTML, />Balance Payable</);
  // Said in words as well as figures, because that is the distinction a
  // receipt is most easily misread on.
  const fn = VJS.slice(VJS.indexOf('function renderVoucherBalance'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /actually received/);
  assert.match(body, /is not money received/);
});

test('RV26 the receipt-only sections stay hidden on the other three vouchers', () => {
  const fn = VJS.slice(VJS.indexOf('async function onVoucherTypeChange'));
  const body = fn.slice(0, fn.indexOf('\nfunction fillVoucherPartyList'));
  assert.match(body, /addrGroup\.classList\.toggle\('d-none', !voucherIsReceipt\(\)\)/);
  assert.match(body, /natureGroup\.classList\.toggle\('d-none', !voucherIsReceipt\(\)\)/);
  // And the supply-nature rule never touches a payment or refund voucher.
  const sb = voucherSandbox({ vDocType: 'refund_voucher', vAmount: '100', vRate: '18',
    vPos: 'Tamil Nadu' });
  const a = sb.voucherAmounts();
  assert.strictEqual(a.rate, 18, 'a refund voucher is taxed as it always was');
  assert.strictEqual(sb.round2(a.cgst + a.sgst), 18, '9 + 9');
});

test('RV27 numbering and cancellation are untouched', () => {
  assert.match(VJS, /async function reserveVoucherNumber/);
  assert.match(VJS, /\/documents\/\$\{vType\(\)\}\/reserve-number|reserve-number/);
  assert.match(VJS, /async function cancelVoucher/);
  // No invoice counter is within reach of this page.
  for (const col of ['invoice_number_format', 'invoice_current_sequence',
    'invoice_series_formats', 'invoice_series_sequences']) {
    assert.strictEqual(VJS.includes(col), false, 'vouchers.js must not mention ' + col);
  }
});

test('RV28 the changed assets carry new cache keys, and the mirrors match', () => {
  // Floors, not pins. Both files changed again when the order became a
  // table of products, and pinning an exact number makes every later edit
  // of an unrelated change fail here - which says nothing about whether
  // THIS change bumped the key.
  const vKey = HTML.match(/client\/js\/pages\/vouchers\.js\?v=(\d+)/);
  const pKey = HTML.match(/client\/js\/pages\/receipt-pdf\.js\?v=(\d+)/);
  assert.ok(vKey && pKey, 'both assets are referenced with a cache key');
  assert.ok(Number(vKey[1]) >= 35, `vouchers.js must be v35 or later, found v${vKey[1]}`);
  assert.ok(Number(pKey[1]) >= 5, `receipt-pdf.js must be v5 or later, found v${pKey[1]}`);
  assert.strictEqual(/vouchers\.js\?v=33"/.test(HTML), false, 'the pre-feature voucher key is gone');
  assert.strictEqual(/receipt-pdf\.js\?v=3"/.test(HTML), false, 'and the pre-feature receipt key');
  for (const rel of [['vouchers.html'], ['client', 'js', 'pages', 'vouchers.js'],
    ['client', 'js', 'pages', 'receipt-pdf.js']]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel));
    const pub = fs.readFileSync(path.join(ROOT, 'server', 'public', ...rel));
    assert.ok(src.equals(pub), rel.join('/') + ' differs from its server/public mirror');
  }
});
