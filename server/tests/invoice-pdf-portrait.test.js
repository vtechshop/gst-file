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
  assert.match(PDF, /const bandTop = ROW_D_Y;/);
  assert.equal(/const FOOTER_RESERVE = \d+/.test(PDF), false,
    'the constant reserve must not come back');
  // measured before it is used
  assert.ok(PDF.indexOf('const footerH =') < PDF.indexOf('const ROW_A_Y ='),
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
  assert.match(PDF, /const TABLE_BOTTOM_RESERVE = doc\.internal\.pageSize\.height - TABLE_FIXED_BOTTOM;/);
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
  // The per-line warranty COLUMN is gone by instruction, but the invoice-level
  // warranty block below the table is a different thing and stays.
  assert.match(PDF, /doc\.text\('WARRANTY', L \+ 2, bankY \+ 1\)/);
  assert.match(PDF, /invoiceVerifyUrl\(inv\.type, inv\.id\)/);
  assert.match(PDF, /Bank Details for Payment/);
  assert.match(PDF, /Authorized Signatory/);
  assert.match(PDF, /doc\.text\('Bill Amount :', L \+ 2, ROW_C_Y \+ 5\.8\)/);
  assert.match(PDF, /numberToWordsINR\(inv\.total_amount\)/);
});

test('P10 the GST columns are generated from the invoice, not fixed', () => {
  // Two column sets, one per regime. An invoice carries one or the other, so
  // the columns of the other regime are never built at all.
  const igst = PDF.match(/const INVOICE_ITEM_COLUMNS_IGST = \[([\s\S]*?)\];/);
  const dom = PDF.match(/const INVOICE_ITEM_COLUMNS_CGST_SGST = \[([\s\S]*?)\];/);
  assert.ok(igst, 'the IGST column set must exist');
  assert.ok(dom, 'the CGST+SGST column set must exist');
  const heads = (b) => [...b.matchAll(/head: '([^']+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(heads(igst[1]),
    ['SrNo', 'Product Name', 'HSN/SAC', 'Qty', 'Rate', 'IGST %', 'Amount']);
  assert.deepStrictEqual(heads(dom[1]),
    ['SrNo', 'Product Name', 'HSN/SAC', 'Qty', 'Rate', 'GST %', 'CGST', 'SGST', 'Amount']);
  // The head is the column set itself, so a column cannot be headed here and
  // missing from the rows below.
  assert.match(PDF, /head: \[itemColumns\.map\(c => c\.head\)\]/);
  assert.equal(/withWarranty/.test(PDF), false, 'the warranty column must be gone');
});

test('P10b the non-applicable GST columns are absent, not blank', () => {
  const igst = PDF.match(/const INVOICE_ITEM_COLUMNS_IGST = \[([\s\S]*?)\];/)[1];
  const dom = PDF.match(/const INVOICE_ITEM_COLUMNS_CGST_SGST = \[([\s\S]*?)\];/)[1];
  assert.equal(/'CGST'|'SGST'/.test(igst), false, 'an IGST invoice must not carry CGST/SGST columns');
  assert.equal(/'IGST/.test(dom), false, 'a domestic invoice must not carry an IGST column');
  // The row builder branches on the same flag as the head, so head and body
  // can never disagree about the column count.
  assert.match(PDF, /const isIgstInvoice = inv\.igst > 0;/);
  assert.match(PDF, /const itemColumns = invoiceItemColumns\(isIgstInvoice\);/);
  assert.match(PDF, /isIgstInvoice\s*\n?\s*\? \[sr, name, hsn, qty, rate, pct, amount\]\s*\n?\s*: \[sr, name, hsn, qty, rate, pct, cgst, sgst, amount\]/);
  assert.match(PDF, /columnStyles: INVOICE_ITEM_COLUMN_STYLES\(R - L, isIgstInvoice\)/);
  // Neither Unit nor Warranty is a column in either set.
  assert.equal(/'Unit'|'Warranty'/.test(igst + dom), false);
});

test('P10c every GST figure still appears in the totals', () => {
  // Removing the columns must not remove the information.
  assert.match(PDF, /totalsRows = \[\['Subtotal', formatNum\(inv\.taxable_amount\)\]\]/);
  assert.match(PDF, /if \(inv\.cgst > 0\) totalsRows\.push\(\['CGST', formatNum\(inv\.cgst\)\]\)/);
  assert.match(PDF, /if \(inv\.sgst > 0\) totalsRows\.push\(\['SGST', formatNum\(inv\.sgst\)\]\)/);
  assert.match(PDF, /if \(inv\.igst > 0\) totalsRows\.push\(\[`IGST \(\$\{inv\.gst_percentage\}%\)`, formatNum\(inv\.igst\)\]\)/);
  assert.match(PDF, /totalsRows\.push\(\['Round Off'/);
  assert.match(PDF, /doc\.text\('Grand Total', SPLIT \+ 2, ROW_C_Y \+ 6\.4\)/);
});

test('P10d per-line tax is read, never recomputed', () => {
  const rows = PDF.slice(PDF.indexOf('const itemCells'), PDF.indexOf('const SPLIT ='));
  // The CGST and SGST cells print the STORED per-line figures. No arithmetic
  // appears in the row builder at all: no rate x taxable, no halving.
  assert.match(rows, /it\.cgst > 0 \? formatNum\(it\.cgst\) : '-'/);
  assert.match(rows, /it\.sgst > 0 \? formatNum\(it\.sgst\) : '-'/);
  assert.match(rows, /it\.gst_percentage \+ '%'/);
  assert.equal(/\/\s*2|\*\s*0\.|rate\s*\*/.test(rows), false, 'the row builder must not compute tax');
});

test('P10e alignment and widths come from the column descriptors', () => {
  assert.match(PDF, /if \(c\.halign\) styles\[i\]\.halign = c\.halign;/);
  assert.match(PDF, /if \(c\.bold\) styles\[i\]\.fontStyle = 'bold';/);
  assert.match(PDF, /cellWidth: tableWidth \* c\.weight \/ total/);
  // "SrNo" at 6.8pt needs ~8.4mm; 7 units gave 7.1mm and split the heading
  // across two lines, which made the whole header row taller.
  for (const set of ['INVOICE_ITEM_COLUMNS_IGST', 'INVOICE_ITEM_COLUMNS_CGST_SGST']) {
    const body = PDF.match(new RegExp('const ' + set + ' = \\[([\\s\\S]*?)\\];'))[1];
    const srno = parseInt(body.match(/head: 'SrNo',\s*weight: (\d+)/)[1], 10);
    assert.ok(srno >= 10, set + ': SrNo must be wide enough not to wrap, got ' + srno);
  }
});

test('P10f the HTML print view follows the same rule', () => {
  const H = PDF.slice(PDF.indexOf('async function buildInvoiceHTML'));
  assert.match(H, /const isIgstInvoice = \(\+inv\.igst \|\| 0\) > 0;/);
  assert.match(H, /\? ''\s*\n?\s*: `<td class="r">\$\{amt\(row\.cgst\)\}<\/td><td class="r">\$\{amt\(row\.sgst\)\}<\/td>`/);
  assert.match(H, /\? `<th>IGST %<\/th>`\s*\n?\s*: `<th>GST %<\/th><th>CGST<\/th><th>SGST<\/th>`/);
  // Unit and the per-column tax RATES are gone from the print view too.
  assert.equal(/<th>Unit<\/th>|<th>CGST %<\/th>|<th>SGST %<\/th>/.test(H), false);
  assert.equal(/splitOf/.test(H), false, 'the per-row rate split is no longer rendered');
  // ...and its totals block is untouched.
  assert.match(H, /<td>CGST<\/td>/);
  assert.match(H, /<td>SGST<\/td>/);
  assert.match(H, /<td>IGST<\/td>/);
});

test('P11 the changed asset carries one new cache key on every page that loads it', () => {
  for (const p of PAGES) {
    assert.ok(rd(p).includes('client/js/pages/invoice-pdf.js?v=48'),
      p + ' must reference invoice-pdf.js at v=48');
  }
  // and nothing unrelated moved with it
  assert.ok(rd('invoice.html').includes('client/js/utilities/utils.js?v=33'));
  assert.ok(rd('proforma.html').includes('client/js/pages/proforma-pdf.js?v=41'));
  assert.ok(rd('proforma.html').includes('client/js/pages/proforma-entry.js?v=40'));
});

test('P17 the closing block is a bordered grid, bottom-anchored', () => {
  // A billing machine prints the close as ruled cells, not free text. Four
  // rows, one divider, and the whole block held against the footer so every
  // figure lands in the same place on every invoice.
  assert.match(PDF, /const SPLIT = L \+ 122;/);
  assert.match(PDF, /const ROW_A_Y = PAGE_BOTTOM - footerH - CLOSE_H;/);
  assert.match(PDF, /const ROW_B_Y = ROW_A_Y \+ ROW_A_H;/);
  assert.match(PDF, /const ROW_C_Y = ROW_B_Y \+ ROW_B_H;/);
  assert.match(PDF, /const ROW_D_Y = ROW_C_Y \+ ROW_C_H;/);
  assert.match(PDF, /const CLOSE_H = ROW_A_H \+ ROW_B_H \+ ROW_C_H \+ ROW_D_H;/);
  // the borders themselves
  assert.match(PDF, /doc\.setLineWidth\(0\.5\);/);
  assert.match(PDF, /doc\.rect\(L, ROW_A_Y, R - L, CLOSE_END - ROW_A_Y\)/);
  assert.match(PDF, /doc\.line\(SPLIT, ROW_A_Y, SPLIT, CLOSE_END\)/);
  for (const rule of ['ROW_B_Y', 'ROW_C_Y', 'ROW_D_Y']) {
    assert.match(PDF, new RegExp('doc\\.line\\(L, ' + rule + ', R, ' + rule + '\\)'));
  }
  // the table above shares the grid's top edge
  assert.match(PDF, /const TABLE_FIXED_BOTTOM = Math\.max\(ROW_A_Y, HEADER_BOTTOM \+ 30\);/);
});

test('P17b each cell carries the figure the reference puts there', () => {
  // Row A: GSTIN left, Sub Total right.
  assert.match(PDF, /doc\.text\('GSTIN No\.: ' \+ \(p\?\.gstin \|\| '-'\), L \+ 2, ROW_A_Y \+ 4\.9\)/);
  assert.match(PDF, /doc\.text\(totalsRows\[0\]\[0\], SPLIT \+ 2, ROW_A_Y \+ 4\.9\)/);
  assert.match(PDF, /doc\.text\(cellMoney\(totalsRows\[0\]\[1\]\), R - 2, ROW_A_Y \+ 4\.9, \{ align: 'right' \}\)/);
  // Row B: bank + QR left, tax summary right.
  assert.match(PDF, /doc\.text\('Bank Details for Payment', L \+ 2, bankY\)/);
  assert.match(PDF, /doc\.addImage\(qrSource, 'PNG', qrX, qrY, 22, 22\)/);
  assert.match(PDF, /doc\.text\('Taxable Amount', SPLIT \+ 2, ROW_B_Y \+ 5\.5\)/);
  // Row C: words left, Grand Total right.
  assert.match(PDF, /doc\.text\('Bill Amount :', L \+ 2, ROW_C_Y \+ 5\.8\)/);
  assert.match(PDF, /doc\.text\('Grand Total', SPLIT \+ 2, ROW_C_Y \+ 6\.4\)/);
  assert.match(PDF, /doc\.text\(cellMoney\(formatNum\(inv\.total_amount\)\), R - 2, ROW_C_Y \+ 6\.4/);
  // Row D: terms left, signature right.
  assert.match(PDF, /doc\.text\('Terms & Condition :', L \+ 2, termsY\)/);
  assert.match(PDF, /const signBlockBottom = drawSignatureBlock\(sigBlockY\);/);
});

test('P17c the tax summary is READ from totalsRows, never rebuilt', () => {
  // totalsRows[0] is the Subtotal and has its own strip; everything after it
  // is the tax summary, printed in the order the list was built.
  assert.match(PDF, /const taxLines = totalsRows\.slice\(1\);/);
  assert.match(PDF, /taxLines\.forEach\(\(r, i\) => \{/);
  assert.match(PDF, /doc\.text\(r\[0\], SPLIT \+ 2, ROW_B_Y \+ 10\.5 \+ i \* 4\.6\)/);
  assert.match(PDF, /doc\.text\(cellMoney\(r\[1\]\), R - 2, ROW_B_Y \+ 10\.5 \+ i \* 4\.6/);
  // No tax is recomputed for the grid - the only arithmetic is layout.
  const grid = PDF.slice(PDF.indexOf('const cellMoney'), PDF.indexOf('y = CLOSE_END'));
  assert.equal(/inv\.cgst \*|inv\.sgst \*|inv\.igst \*|gst_percentage \*/.test(grid), false,
    'the grid must not compute tax');
});

test('P17d the unused part of the table is ruled, not left blank', () => {
  assert.match(PDF, /function invoiceItemColumnEdges\(tableWidth, isIgst, left\)/);
  assert.match(PDF, /invoiceItemColumnEdges\(R - L, isIgstInvoice, L\)\s*\n?\s*\.forEach\(\(x\) => doc\.line\(x, tableFoot, x, TABLE_FIXED_BOTTOM\)\)/);
  assert.match(PDF, /doc\.line\(L, TABLE_FIXED_BOTTOM, R, TABLE_FIXED_BOTTOM\)/);
  assert.match(PDF, /if \(tableFoot < TABLE_FIXED_BOTTOM - 0\.2\)/);
});

test('P18 everything is wrapped to the cell it is drawn in', () => {
  // Wrapping to one width and drawing at another re-wraps at draw time and
  // overflows the row that was reserved for it.
  assert.match(PDF, /const CELL_TEXT_W = SPLIT - 32 - L;/);
  assert.match(PDF, /doc\.splitTextToSize\(line, CELL_TEXT_W\)/);
  assert.match(PDF, /const TC_WIDTH = SPLIT - 4 - L;/);
  assert.match(PDF, /doc\.splitTextToSize\(p\.terms_conditions, TC_WIDTH\)/);
  assert.match(PDF, /\{ maxWidth: CELL_TEXT_W \}/);
  // ...and measured before the grid whose height depends on them
  assert.ok(PDF.indexOf('const termsProse =') < PDF.indexOf('const ROW_D_H ='));
  assert.ok(PDF.indexOf('const warrantyLines =') < PDF.indexOf('const ROW_B_H ='));
});

test('P19 a schedule of terms stays inside the grid', () => {
  // The grid is bottom-anchored against the footer, so anything drawn under
  // it would land in the footer.
  assert.match(PDF, /startY: ROW_D_Y \+ 2,/);
  assert.match(PDF, /margin: \{ left: L, right: pw - \(SPLIT - 2\) \}/);
  assert.match(PDF, /cellWidth: \(SPLIT - 2 - L\) \* 0\.25/);
  assert.match(PDF, /const termsTableH = termsPairs \? 6 \+ Math\.ceil\(termsPairs\.length \/ 2\) \* 4\.6 : 0;/);
});

test('P20 the seal band sits at the signature row on every page', () => {
  assert.match(PDF, /const bandTop = ROW_D_Y;/);
  assert.match(PDF, /const sigBlockY = ROW_D_Y;/);
  assert.match(PDF, /if \(!signedPages\.has\(i\)\) drawSignatureBlock\(bandTop\)/);
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
