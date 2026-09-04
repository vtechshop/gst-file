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
  assert.match(PDF, /margin: \{ left: L, right: L, top: HEADER_BOTTOM, bottom: TABLE_BOTTOM_RESERVE \}/);
});

// ── the seal / signature block on every page ──
test('P13 the signature block is a renderer, not an inline one-off', () => {
  // Same architecture as drawInvoiceHeader(): one function, called per page,
  // so the copies and pages cannot drift apart.
  assert.match(PDF, /const drawSignatureBlock = \(topY\) => \{/);
  // and it is defined ONCE
  assert.strictEqual((PDF.match(/const drawSignatureBlock =/g) || []).length, 1);
  // the images are decoded once for the whole document, not per draw
  assert.match(PDF, /const \[sealInk, sigInk\] = await Promise\.all\(\[inkBoundsOf\(sealData\), inkBoundsOf\(signatureData\)\]\)/);
  assert.strictEqual((PDF.match(/inkBoundsOf\(sealData\)/g) || []).length, 1);
});

test('P14 every page of every copy is signed', () => {
  // The page loop that numbers the pages now signs them too, skipping only
  // the page the closing block already signed in flow.
  assert.match(PDF, /if \(!signedPages\.has\(i\)\) drawSignatureBlock\(bandTop\);/);
  assert.match(PDF, /const signedPages = new Set\(\);/);
  assert.match(PDF, /signedPages\.add\(doc\.internal\.getNumberOfPages\(\)\);/);
  // signedPages is declared INSIDE the copy loop, so each copy tracks its own
  const loop = PDF.slice(PDF.indexOf('for (let copyIndex = 0;'));
  assert.ok(loop.indexOf('const signedPages') < loop.indexOf('drawSignatureBlock(bandTop)'),
    'each copy must have its own signed-page set');
  // the final page keeps its in-flow block
  assert.match(PDF, /const signBlockBottom = drawSignatureBlock\(sigBlockY\);/);
});

test('P15 the table reserves the band it must not run into', () => {
  assert.match(PDF, /const TABLE_BOTTOM_RESERVE = doc\.internal\.pageSize\.height - bandTop \+ 2;/);
  // Measured from the sheet edge, which is the datum autoTable uses. Reserving
  // bandH + footerH instead under-reserved by the 12mm PAGE_BOTTOM excludes,
  // and rows landed 2mm inside the block.
  assert.equal(/bottom: bandH \+ footerH/.test(PDF), false,
    'the reserve must not be measured from PAGE_BOTTOM');
  // and it is computed before the table uses it
  assert.ok(PDF.indexOf('const TABLE_BOTTOM_RESERVE') < PDF.indexOf('bottom: TABLE_BOTTOM_RESERVE'));
});

test('P16 an unconfigured seal or signature draws no image', () => {
  const fn = PDF.slice(PDF.indexOf('const drawSignatureBlock'), PDF.indexOf('// ── Three copies'));
  assert.match(fn, /if \(sealData\) \{/, 'the seal is drawn only when configured');
  assert.match(fn, /if \(signatureData\) \{/, 'the signature is drawn only when configured');
  // the caption and rule are unconditional, as before
  assert.match(fn, /doc\.text\('Authorized Signatory', sealCx, authY, \{ align: 'center' \}\)/);
  assert.match(fn, /doc\.text\('For ' \+ \(p\?\.business_name \|\| 'Us'\)/);
  // the reserve still shrinks when there is no stamp
  assert.match(PDF, /const sealReserveH = sealData \? SEAL : \(signatureData \? 18 : 14\);/);
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

test('P10 the product table carries the reference\'s seven columns', () => {
  assert.match(PDF, /'SrNo', 'Product Name', 'HSN\/SAC', 'Qty', 'Rate',\s*\n?\s*\(inv\.igst > 0 \? 'IGST %' : 'GST %'\), 'Amount'/);
  const weights = PDF.match(/const INVOICE_ITEM_COLUMN_WEIGHTS = \[([\s\S]*?)\];/);
  assert.ok(weights, 'weights must exist');
  const nums = weights[1].split('\n').filter(l => /^\s*\d/.test(l)).length;
  assert.strictEqual(nums, 7, 'seven columns, got ' + nums);
});

test('P10b the three GST AMOUNT columns are gone from the table', () => {
  const rows = PDF.slice(PDF.indexOf('const pdfItemRows'), PDF.indexOf('doc.autoTable({'));
  // On any invoice two of the three were "-" on every row, so they spent a
  // third of the table saying nothing. The per-line tax is still derivable
  // from the rate and amount printed on the row.
  for (const gone of ['it.cgst', 'it.sgst', 'it.igst']) {
    assert.equal(rows.includes(gone), false, gone + ' must not be a table cell');
  }
  // ...and the table head names none of them as a column
  const head = PDF.slice(PDF.indexOf('head: [withWarranty('), PDF.indexOf('body: pdfItemRows'));
  assert.equal(/'CGST'|'SGST'|'IGST'/.test(head), false, 'no GST amount column may remain');
});

test('P10c every GST figure still appears in the totals', () => {
  // Removing the columns must not remove the information.
  assert.match(PDF, /totalsRows = \[\['Subtotal', formatNum\(inv\.taxable_amount\)\]\]/);
  assert.match(PDF, /if \(inv\.cgst > 0\) totalsRows\.push\(\['CGST', formatNum\(inv\.cgst\)\]\)/);
  assert.match(PDF, /if \(inv\.sgst > 0\) totalsRows\.push\(\['SGST', formatNum\(inv\.sgst\)\]\)/);
  assert.match(PDF, /if \(inv\.igst > 0\) totalsRows\.push\(\[`IGST \(\$\{inv\.gst_percentage\}%\)`, formatNum\(inv\.igst\)\]\)/);
  assert.match(PDF, /totalsRows\.push\(\['Round Off'/);
  assert.match(PDF, /doc\.text\('Grand Total', boxX, ruleY \+ 7\)/);
});

test('P10d figures are right-aligned and the heading fits', () => {
  assert.match(PDF, /styles\[0\]\.halign = 'right'/);
  assert.match(PDF, /styles\[2\]\.halign = 'center'/);
  assert.match(PDF, /for \(let i = 3; i < weights\.length; i\+\+\) styles\[i\]\.halign = 'right'/);
  // "SrNo" at 6.8pt needs ~8.4mm; 7 units gave 7.1mm and split the heading
  // across two lines, which made the whole header row taller.
  const weights = PDF.match(/const INVOICE_ITEM_COLUMN_WEIGHTS = \[([\s\S]*?)\];/)[1];
  const first = parseInt(weights.split('\n').find(l => /^\s*\d/.test(l)).trim(), 10);
  assert.ok(first >= 10, 'the SrNo column must be wide enough not to wrap, got ' + first);
});

test('P11 the changed asset carries one new cache key on every page that loads it', () => {
  for (const p of PAGES) {
    assert.ok(rd(p).includes('client/js/pages/invoice-pdf.js?v=44'),
      p + ' must reference invoice-pdf.js at v=44');
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
