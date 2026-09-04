// The Tax Invoice PDF's page geometry.
//
// It was A4 landscape, which bought width for the twelve columns and spent it
// on the wrong axis: a sideways A4 sheet has only 210mm of HEIGHT, and the
// item table is the thing that needs height. Portrait gives 297mm.
//
// These tests guard the geometry and the invariants a layout change must not
// break. The behaviour itself (page counts, no clipping) is proved by
// generating real PDFs; what is asserted here is that the settings which
// produce it cannot drift back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const PDF = strip(rd('client', 'js', 'pages', 'invoice-pdf.js'));
const PAGES = ['invoice-list.html', 'invoice.html', 'proforma-list.html',
  'proforma.html', 'sales-returns.html'];

test('P1 the document is A4 portrait', () => {
  assert.match(PDF, /new jsPDF\(\{ unit: 'mm', format: 'a4', orientation: 'portrait' \}\)/);
  assert.equal(/orientation: 'landscape'/.test(PDF), false, 'landscape must be gone');
});

test('P2 margins give the table its width back', () => {
  // 8mm each side is 194mm of table on a 210mm sheet; 14mm gave 182mm.
  assert.match(PDF, /const L = 8, R = pw - 8;/);
});

test('P3 rows are compact enough to be worth the portrait switch', () => {
  // Padding was the larger half of a row's height: 2.5mm top AND bottom added
  // 5mm to every line.
  assert.match(PDF, /cellPadding: \{ top: 1\.1, right: 1\.4, bottom: 1\.1, left: 1\.4 \}/);
  assert.match(PDF, /bodyStyles: \{ fontSize: 7,/);
  assert.match(PDF, /fontSize: 6\.8, lineColor/);
  // still readable — nothing below 6pt
  const sizes = [...PDF.matchAll(/fontSize: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  assert.ok(sizes.every(v => v >= 6), 'no text may drop below 6pt: ' + Math.min(...sizes));
});

test('P4 the footer reserve is measured, not guessed', () => {
  // A constant reserve could disagree with the footer actually drawn, and did:
  // 18mm assumed against 22.6mm real put the band below what the page could
  // hold, so the closing block took a second sheet on EVERY invoice.
  assert.match(PDF, /const bandTop = PAGE_BOTTOM - footerH - bandH;/);
  assert.equal(/const FOOTER_RESERVE = \d+/.test(PDF), false,
    'the constant reserve must not come back');
  // measured before it is used
  assert.ok(PDF.indexOf('const footerH =') < PDF.indexOf('const bandTop ='),
    'the footer must be measured before the band is placed');
});

test('P5 the party band fits a portrait sheet', () => {
  // Two rows of two, not one row of four: four 45mm columns wrap an ordinary
  // address into six lines and cost more height than the second row saves.
  assert.match(PDF, /const partColW = \(R - L - PART_GAP\) \/ 2;/);
  assert.match(PDF, /const partX = \[L, L \+ partColW \+ PART_GAP\];/);
  assert.match(PDF, /heads\('SOLD BY', 'ORDER & INVOICE DETAILS'\)/);
  assert.match(PDF, /heads\('BILL TO', 'SHIP TO'\)/);
});

test('P6 the three copies are untouched', () => {
  assert.match(PDF, /const INVOICE_COPY_LABELS = \[/);
  for (const label of ['Original for Recipient', 'Duplicate for File Copy',
                       'Duplicate for Transporter']) {
    assert.ok(PDF.includes(label), label + ' must remain');
  }
  assert.match(PDF, /for \(let copyIndex = 0; copyIndex < INVOICE_COPY_LABELS\.length; copyIndex\+\+\)/);
  assert.match(PDF, /Page \$\{i - copyFirstPage \+ 1\} of \$\{copyPageCount\}/);
});

test('P7 every continuation page still repeats the header and the column head', () => {
  assert.match(PDF, /showHead: 'everyPage'/);
  assert.match(PDF, /didDrawPage: \(d\) => \{ if \(d\.pageNumber > 1\) drawInvoiceHeader\(\); \}/);
  assert.match(PDF, /margin: \{ left: L, right: L, top: HEADER_BOTTOM \}/);
});

test('P8 no calculation was touched', () => {
  // Every figure is still read straight off the record.
  for (const re of [/formatNum\(it\.quantity\)/, /formatNum\(it\.rate\)/,
                    /it\.gst_percentage \+ '%'/, /formatNum\(it\.total_amount\)/,
                    /formatNum\(inv\.taxable_amount\)/, /formatNum\(inv\.cgst\)/,
                    /formatNum\(inv\.sgst\)/, /formatNum\(inv\.igst\)/,
                    /formatNum\(inv\.total_amount\)/]) {
    assert.match(PDF, re);
  }
  // round_off is still derived the way it always was
  assert.match(PDF, /round_off: round2\(\+data\.total_amount - \+data\.taxable_amount - \+data\.gst_amount\)/);
  assert.match(PDF, /Math\.abs\(inv\.round_off\) >= 0\.005/);
  // the PDF layer still writes nothing
  assert.equal(/\.update\(|\.insert\(|\.delete\(/.test(PDF), false);
});

test('P9 warranty, QR, bank and signature all survive', () => {
  assert.match(PDF, /const INVOICE_WARRANTY_COLUMN_WEIGHT = \d+/);
  assert.match(PDF, /warrantyLabel\(it\.warranty_period_months\)/);
  assert.match(PDF, /doc\.text\('WARRANTY', L, wy\)/);
  assert.match(PDF, /invoiceVerifyUrl\(inv\.type, inv\.id\)/);
  assert.match(PDF, /Bank Details for Payment/);
  assert.match(PDF, /Authorized Signatory/);
  assert.match(PDF, /Amount in Words:/);
});

test('P10 all ten columns are still carried', () => {
  assert.match(PDF, /'#', 'Product Name', 'HSN', 'Qty', 'Rate', 'GST%', 'CGST', 'SGST', 'IGST', 'Total'/);
  const weights = PDF.match(/const INVOICE_ITEM_COLUMN_WEIGHTS = \[([\s\S]*?)\];/);
  assert.ok(weights, 'weights must exist');
  const nums = weights[1].split('\n').filter(l => /^\s*\d/.test(l)).length;
  assert.strictEqual(nums, 10, 'ten columns, got ' + nums);
});

test('P11 the changed asset carries one new cache key on every page that loads it', () => {
  for (const p of PAGES) {
    assert.ok(rd(p).includes('client/js/pages/invoice-pdf.js?v=42'),
      p + ' must reference invoice-pdf.js at v=42');
  }
  // and nothing unrelated moved with it
  assert.ok(rd('invoice.html').includes('client/js/utilities/utils.js?v=33'));
  assert.ok(rd('proforma.html').includes('client/js/pages/proforma-pdf.js?v=41'));
  assert.ok(rd('proforma.html').includes('client/js/pages/proforma-entry.js?v=40'));
});

test('P12 the Proforma PDF was not dragged into this', () => {
  const PF = strip(rd('client', 'js', 'pages', 'proforma-pdf.js'));
  // Proforma has its own page setup and is explicitly out of scope here, so
  // it must STILL be landscape. The two documents therefore differ in
  // orientation for now, deliberately: converting Proforma is a separate
  // decision, not a side effect of this one.
  assert.match(PF, /orientation: 'landscape'/,
    'proforma-pdf.js must be left on its own orientation');
  assert.match(PF, /round_off: round2\(rounded - calculated\)/, 'its round-off must survive');
});
