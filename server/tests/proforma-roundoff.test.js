// Round-off on the Proforma PDF.
//
// The bug this locks down: numberToWordsINR() already rounds
// (Math.round(Math.abs(n))), so a quotation totalling 138900.16 printed
// "...Nine Hundred Rupees Only" in words beside "1,38,900.16" as a figure.
// The words and the numeral disagreed on the same document.
//
// The fix is display-side only. proforma_invoices still stores the calculated
// total; nothing here may change a taxable value, a tax column or an item
// total, and no column was added to the database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const PDF = strip(rd('client', 'js', 'pages', 'proforma-pdf.js'));
const INV_PDF = strip(rd('client', 'js', 'pages', 'invoice-pdf.js'));
const UTILS = strip(rd('client', 'js', 'utilities', 'utils.js'));

// The exact arithmetic the renderable performs, restated so the cases below
// assert a rule rather than a copy of the implementation.
const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const quoted = (calculated) => {
  const rounded = Math.round(calculated);
  return { total: rounded, roundOff: round2(rounded - calculated) };
};

test('R1 nearest-rupee rounding, on the cases that matter', () => {
  for (const [given, wantTotal, wantRound] of [
    [138900.16, 138900, -0.16],
    [138900.49, 138900, -0.49],
    [138900.50, 138901, 0.50],
    [138900.99, 138901, 0.01],
    [138900.00, 138900, 0.00],
    [0, 0, 0]
  ]) {
    const r = quoted(given);
    assert.strictEqual(r.total, wantTotal, given + ' must quote ' + wantTotal);
    assert.strictEqual(r.roundOff, wantRound, given + ' round-off must be ' + wantRound);
  }
});

test('R2 binary floating point never reaches the page', () => {
  // 138900 - 138900.16 is -0.15999999999417923 in IEEE 754. Printed raw that
  // is what a customer would read on a quotation.
  assert.strictEqual(138900 - 138900.16 === -0.16, false, 'the raw subtraction IS imprecise');
  assert.strictEqual(quoted(138900.16).roundOff, -0.16);
  // and the printed form is fixed at two decimals by formatNum
  assert.match(UTILS, /function formatNum\(n\)/);
  assert.match(UTILS, /minimumFractionDigits: 2, maximumFractionDigits: 2/);
});

test('R3 the PDF derives the round-off instead of hardcoding zero', () => {
  assert.equal(/round_off:\s*0\s*,/.test(PDF), false,
    'round_off must no longer be stubbed to 0');
  assert.match(PDF, /const rounded = Math\.round\(calculated\)/);
  assert.match(PDF, /round_off: round2\(rounded - calculated\)/);
  assert.match(PDF, /total_amount: rounded/);
});

test('R4 the Round Off row uses the tax invoice\'s own rule and format', () => {
  assert.match(PDF, /Math\.abs\(inv\.round_off\) >= 0\.005/);
  assert.match(PDF, /totalsRows\.push\(\['Round Off', \(inv\.round_off >= 0 \? '\+' : ''\) \+ formatNum\(inv\.round_off\)\]\)/);
  // the same threshold and sign convention the invoice already prints
  assert.match(INV_PDF, /Math\.abs\(inv\.round_off\) >= 0\.005/);
  assert.match(INV_PDF, /\(inv\.round_off >= 0 \? '\+' : ''\) \+ formatNum\(inv\.round_off\)/);
});

test('R5 amount in words comes from the quoted total', () => {
  // inv.total_amount IS the rounded figure by the time it is printed, so the
  // words and the numeral are drawn from one value.
  assert.match(PDF, /numberToWordsINR\(inv\.total_amount\)/);
  assert.match(UTILS, /function numberToWordsINR\(n\)[\s\S]{0,80}Math\.round\(Math\.abs/);
});

test('R6 no tax, item or stored value was touched', () => {
  const fn = PDF.slice(PDF.indexOf('function proformaToRenderable'),
                       PDF.indexOf('async function buildProformaPDFDoc'));
  // every tax field is still a straight pass-through of the stored row
  for (const f of ['taxable_amount', 'gst_amount', 'igst', 'cgst', 'sgst']) {
    assert.ok(new RegExp(f + ': \\+row\\.' + f + ' \\|\\| 0').test(fn),
      f + ' must pass through the stored value unchanged');
  }
  // the items are passed through untouched apart from ordering
  assert.match(fn, /items: \(items \|\| \[\]\)\.slice\(\)\.sort/);
  // and nothing writes back to the database from the PDF layer
  assert.equal(/\.update\(|\.insert\(|apiFetch\(/.test(PDF), false,
    'the PDF must not write anything');
});

test('R7 the Proforma layout is otherwise unchanged', () => {
  for (const marker of ['PROFORMA INVOICE', 'Not a Tax Invoice', 'Bank Details for Payment',
                        'Quoted Total', 'Amount in Words:', 'Authorized Signatory']) {
    assert.ok(PDF.includes(marker), marker + ' must still be printed');
  }
  // the page-break guard sizes itself from the row count, so the extra row
  // cannot push the totals off the page silently
  assert.match(PDF, /y \+ totalsRows\.length \* 5\.5 \+ 60 > doc\.internal\.pageSize\.height - 12/);
});

test('R8 the tax invoice PDF is untouched', () => {
  // Its round-off is derived the other way round - from a total that was
  // already rounded at save time - and this change must not have altered it.
  assert.match(INV_PDF, /round_off: round2\(\+data\.total_amount - \+data\.taxable_amount - \+data\.gst_amount\)/);
});

test('R9 the changed asset carries a new cache key on every page that loads it', () => {
  const pages = ['proforma.html', 'proforma-list.html'];
  for (const p of pages) {
    const html = rd(p);
    assert.ok(html.includes('client/js/pages/proforma-pdf.js?v=41'),
      p + ' must reference proforma-pdf.js at v=41');
  }
  // and nothing unrelated moved with it
  assert.ok(rd('proforma.html').includes('client/js/pages/proforma-entry.js?v=40'));
  assert.ok(rd('proforma.html').includes('client/js/utilities/utils.js?v=33'));
});
