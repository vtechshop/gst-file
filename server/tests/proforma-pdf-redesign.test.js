// Proforma Invoice PDF: the redesign that brought it up to the tax invoice's
// structure without turning it into a tax invoice.
//
// What this locks down, and why each one matters:
//
//   - Unit is printed. A quoted quantity with no unit is not something a
//     customer can check, and the column existed in the database all along.
//   - Unit is printed AS STORED. The Invoice grid's mandatory-unit rule
//     (item-unit-default.test.js U22-U30) is deliberately invoice-only, so a
//     quotation line can legitimately have no unit and the PDF must show that
//     rather than assert PCS on the company's behalf.
//   - Discount earns its column from the lines. A column of dashes down a
//     quotation that gave no discount is noise.
//   - Heading, width and value come from ONE list. They used to live in three
//     places; any one left behind puts every figure under the wrong heading.
//   - "NOT A TAX INVOICE" is prominent and on every page. It is the whole
//     difference between this document and a bill.
//   - Nothing tax-invoice-only arrived with the redesign: no IRN, no
//     verification QR, no Original/Duplicate copy labels.
//   - The quotation's own facts - number, date, validity, status, conversion,
//     GST columns - are untouched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const PDF = rd('client', 'js', 'pages', 'proforma-pdf.js');
const INV_PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');

// The same comment-stripper the sibling proforma tests use. "This rule must
// not appear" has to be asked of the CODE: this file explains in a comment
// why the Invoice's mandatory-unit rule is deliberately absent, and a plain
// text search would read that explanation as the rule itself.
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const PDF_CODE = strip(PDF);

// ── The column functions, actually executed ─────────────
//
// They are pure, so these cases run the real code instead of reading it. Only
// formatNum is needed, and it is the application's own.
function loadColumns() {
  const ctx = {
    formatNum: (n) => new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(parseFloat(n) || 0),
    round2: (n) => Math.round((parseFloat(n) || 0) * 100) / 100
  };
  vm.createContext(ctx);
  // Only the declarations are wanted; nothing here is called at load time.
  vm.runInContext(PDF, ctx, { filename: 'proforma-pdf.js' });
  return ctx;
}

const line = (over) => Object.assign({
  product_name: 'Sugarcane Juice Machine', hsn_code: '84351000', unit: 'NOS',
  quantity: 2, rate: 62000, discount_percentage: 0, gst_percentage: 18,
  cgst: 5580, sgst: 5580, igst: 0, total_amount: 73160
}, over || {});

const headsOf = (ctx, show) => ctx.proformaItemColumns(show).map(c => c.head);
const rowOf = (ctx, it, i, show) =>
  ctx.proformaItemColumns(show).map(c => c.val(it, i == null ? 0 : i));
const cell = (ctx, it, head, show) => {
  const cols = ctx.proformaItemColumns(show);
  const at = cols.findIndex(c => c.head === head);
  assert.ok(at > -1, 'no such column: ' + head);
  return cols[at].val(it, 0);
};

test('PR1 Unit is a column, and it prints what the line stored', () => {
  const ctx = loadColumns();
  const heads = headsOf(ctx, false);
  assert.ok(heads.includes('Unit'), 'the item table must have a Unit column');
  // Beside the quantity it belongs to, not off at the end of the row.
  assert.strictEqual(heads[heads.indexOf('Qty') + 1], 'Unit',
    'Unit must sit immediately after Qty');
  assert.strictEqual(cell(ctx, line({ unit: 'NOS' }), 'Unit', false), 'NOS');
  assert.strictEqual(cell(ctx, line({ unit: 'BOX' }), 'Unit', false), 'BOX');
});

test('PR2 a quotation line with no unit shows none - the Invoice rule does not leak', () => {
  const ctx = loadColumns();
  for (const missing of [{ unit: '' }, { unit: null }, { unit: undefined }]) {
    assert.strictEqual(cell(ctx, line(missing), 'Unit', false), '-',
      'a blank unit prints a dash, never an invented one');
  }
  // The specific failure guarded against: the PDF must not reach for the
  // Invoice grid's default and print PCS on a quotation that has no unit.
  assert.equal(/DEFAULT_ITEM_UNIT|'PCS'|"PCS"/.test(PDF_CODE), false,
    'the proforma PDF must not default a unit to PCS');
  assert.equal(/itemsUnitMustBeConfirmed|unit_confirmed|unitError/.test(PDF_CODE), false,
    'the invoice-only mandatory-unit rule must not appear in the proforma PDF');
});

test('PR3 Discount is a column only when a line actually carries one', () => {
  const ctx = loadColumns();
  assert.equal(headsOf(ctx, false).includes('Disc %'), false,
    'no discount on the quotation means no discount column');
  assert.ok(headsOf(ctx, true).includes('Disc %'),
    'a discounted line must get the column');

  // And the decision is read from the items, not from a setting.
  assert.strictEqual(ctx.proformaHasDiscount([line(), line()]), false);
  assert.strictEqual(ctx.proformaHasDiscount([line(), line({ discount_percentage: 5 })]), true);
  assert.strictEqual(ctx.proformaHasDiscount([line({ discount_percentage: '7.5' })]), true,
    'a discount arriving as a string still counts');
  assert.strictEqual(ctx.proformaHasDiscount([]), false);
  assert.strictEqual(ctx.proformaHasDiscount(null), false,
    'no items at all must not throw');
  assert.strictEqual(ctx.proformaHasDiscount([null, undefined]), false,
    'a hole in the items array must not throw');

  assert.strictEqual(cell(ctx, line({ discount_percentage: 7.5 }), 'Disc %', true), '7.50%');
  assert.strictEqual(cell(ctx, line({ discount_percentage: 0 }), 'Disc %', true), '-',
    'an undiscounted line in a discounted quotation shows a dash');
});

test('PR4 heading, width and value cannot drift apart', () => {
  const ctx = loadColumns();
  for (const show of [false, true]) {
    const cols = ctx.proformaItemColumns(show);
    const row = rowOf(ctx, line(), 0, show);
    const styles = ctx.PROFORMA_ITEM_COLUMN_STYLES(269, show);

    assert.strictEqual(row.length, cols.length,
      'every column must produce exactly one cell');
    assert.strictEqual(Object.keys(styles).length, cols.length,
      'every column must be given a width');
    // Each column carries its own value function, so a heading can never be
    // left pointing at the previous column's figure.
    for (const c of cols) assert.strictEqual(typeof c.val, 'function', c.head + ' has no value');
    // The widths are a share of the table, so they always add up to it.
    const sum = Object.values(styles).reduce((a, s) => a + s.cellWidth, 0);
    assert.ok(Math.abs(sum - 269) < 0.01, 'widths must fill the table exactly, got ' + sum);
  }
});

test('PR5 figures are right-aligned, the product name is not', () => {
  const ctx = loadColumns();
  const cols = ctx.proformaItemColumns(true);
  const styles = ctx.PROFORMA_ITEM_COLUMN_STYLES(269, true);
  const alignOf = (head) => styles[cols.findIndex(c => c.head === head)].halign;

  for (const money of ['Qty', 'Rate', 'Disc %', 'GST%', 'CGST', 'SGST', 'IGST', 'Total']) {
    assert.strictEqual(alignOf(money), 'right', money + ' must be right-aligned');
  }
  assert.strictEqual(alignOf('Product Name'), 'left');
  assert.strictEqual(alignOf('Unit'), 'center');
  assert.strictEqual(alignOf('HSN'), 'center');
  // The name and the total are the two the eye goes to.
  assert.strictEqual(styles[cols.findIndex(c => c.head === 'Product Name')].fontStyle, 'bold');
  assert.strictEqual(styles[cols.findIndex(c => c.head === 'Total')].fontStyle, 'bold');
});

test('PR6 a row of product figures is never cut by a page break', () => {
  assert.match(PDF, /rowPageBreak: 'avoid'/);
  // and the heading comes back on the page the rows continue on
  assert.match(PDF, /showHead: 'everyPage'/);
});

test('PR7 NOT A TAX INVOICE is a badge, drawn on every page', () => {
  assert.match(PDF, /const BADGE = 'NOT A TAX INVOICE'/);
  // Boxed and on the accent, not 8.5pt grey as it was.
  const head = PDF.slice(PDF.indexOf('const drawHeader'), PDF.indexOf('let y = drawHeader()'));
  assert.ok(head.indexOf('NOT A TAX INVOICE') > -1,
    'the badge must be inside drawHeader, which runs on every page');
  assert.match(head, /doc\.rect\(badgeX, badgeY, badgeW, badgeH\)/);
  assert.match(head, /doc\.setTextColor\(\.\.\.accent\)/);
  // The title still says what the document is.
  assert.match(PDF, /doc\.text\('PROFORMA INVOICE'/);
});

test('PR8 the standing terms schedule is the invoice\'s, and is never split', () => {
  // Same source and same parser as the tax invoice, so the two documents
  // cannot show a customer two different sets of terms.
  assert.match(PDF, /parseTermsTable\(p\?\.terms_conditions\)/);
  assert.match(INV_PDF, /function parseTermsTable\(/);
  assert.equal(/function parseTermsTable\(/.test(PDF_CODE), false,
    'the parser must be reused, not copied');

  // Measured, then moved as one block if it will not fit.
  const block = PDF.slice(PDF.indexOf('const termsPairs'), PDF.indexOf('// ── Signature'));
  assert.match(block, /const termsH =/, 'the block must be measured before it is drawn');
  assert.match(block, /if \(ly \+ termsH > CONTENT_FLOOR\)/);
  assert.match(block, /doc\.addPage\(\);\s*\r?\n\s*ly = drawHeader\(\);/,
    'a schedule that does not fit moves to a new page under a full header');
  // The quotation's OWN terms still print - they are a different fact.
  assert.match(PDF, /'Terms: ' \+ inv\.terms/);
});

test('PR9 the quotation carries Taxable Amount only when it differs from Subtotal', () => {
  const block = PDF.slice(PDF.indexOf('const totalsRows'), PDF.indexOf('if (tp.has)'));
  assert.match(block, /\['Subtotal', formatNum\(tp\.productTaxable\)\]/);
  assert.match(block, /round2\(inv\.taxable_amount\) !== round2\(tp\.productTaxable\)/,
    'the row must be conditional, so the same figure is not printed twice');
  assert.match(block, /\['Taxable Amount', formatNum\(inv\.taxable_amount\)\]/);
});

test('PR10 the footer says how to reach the company', () => {
  assert.match(PDF, /\[p\?\.email, p\?\.phone, p\?\.website\]\.filter\(Boolean\)/);
  assert.match(PDF, /This is a computer-generated proforma invoice\./);
  assert.match(PDF, /Page \$\{i\} of \$\{pageCount\}/);
});

test('PR11 the redesign introduced nothing that belongs only to a tax invoice', () => {
  for (const banned of ['Original for Recipient', 'Duplicate for File Copy',
    'Duplicate for Transporter', 'IRN', 'e-invoice', 'Scan to verify', 'generateQRDataUrl']) {
    assert.equal(PDF_CODE.includes(banned), false, 'the proforma must not carry: ' + banned);
  }
  assert.equal(/(?:await\s+|=\s*)buildInvoicePDFDoc\s*\(/.test(PDF_CODE), false,
    'the proforma must not call the tax invoice builder');
  // It still says plainly what it is.
  assert.match(PDF, /It is not a Tax Invoice and no GST is payable on it/);
});

test('PR12 the quotation\'s own facts are untouched by the redesign', () => {
  // Number, date, validity and status are read from the row, never recomputed.
  assert.match(PDF, /invoice_number: typeof proformaDisplayNumber === 'function'/);
  assert.match(PDF, /invoice_date: row\.document_date/);
  assert.match(PDF, /valid_until: row\.valid_until \|\| null/);
  assert.match(PDF, /status: row\.status/);
  assert.match(PDF, /function proformaValidityDays\(/);
  // The GST columns are passed through, not re-derived.
  for (const col of ['taxable_amount', 'gst_amount', 'igst', 'cgst', 'sgst']) {
    assert.ok(new RegExp(col + ': \\+row\\.' + col).test(PDF),
      col + ' must be passed through from the stored row');
  }
  // Nothing here writes anything.
  assert.equal(/\.update\(|\.insert\(|save-with-items|\/save\b/.test(PDF), false,
    'printing a quotation must not write to anything');
  // The filename still carries the number as shown.
  assert.match(PDF, /doc\.save\(`Proforma_\$\{shownNumber \|\| row\.id\.slice\(0, 8\)\}\.pdf`\)/);
});

test('PR14 the page-fit decision measures the close, in the two columns it occupies', () => {
  const from = PDF.indexOf('const leftW = boxX');
  const block = PDF.slice(from, PDF.indexOf('totalsRows.forEach(', from));

  // The constant is gone. "+ 60" could not know what a given quotation has to
  // print, and it was wrong in both directions - see the comment in the file.
  assert.equal(/\+ 60 > doc\.internal\.pageSize\.height/.test(PDF_CODE), false,
    'the flat 60mm reserve must be gone');

  // Right column: the totals rows, then the signature stacked under them.
  assert.match(block, /const rightH = totalsRows\.length \* 5\.5 \+ 8;/);
  // The advance and balance are NOT charged to this column any more - they
  // print in the left one, so they cannot push the stamp onto a new page.
  assert.match(block, /paymentRows\.length \? 4\.5 \+ paymentRows\.length \* 4\.5 \+ LEFT_GAP : 0/);
  assert.match(block, /signatureStackH = 13 \+ sealReserveH/);
  // Left column: bank, words, the two notices, notes, the quotation's terms.
  assert.match(block, /bankLines\.length \? 4\.5 \+ bankLines\.length \* 4 \+ LEFT_GAP : 0/);
  // One gap between the blocks in this column, shared by the measurement and
  // the drawing, so the two cannot disagree about it.
  assert.match(block, /const LEFT_GAP = 1\.5;/);
  assert.match(block, /notesWrapped\.length \? LEFT_GAP \+ notesWrapped\.length \* 4 : 0/);

  // The point of the fix: the stamp's height is added to the TOTALS column
  // only. The left column runs from the margin to short of the totals box and
  // never passes under the stamp, so adding the stamp to it reserved room
  // that was not needed - which is what pushed a one-page quotation onto two.
  assert.match(block, /const closeH = Math\.max\(rightH \+ signatureStackH, leftH\)/);
  // Measured down to the footer RULE, not the bottom of the page: the rule is
  // 10mm above the footer text and the stamp has to finish above it.
  assert.match(block, /CONTENT_FLOOR = doc\.internal\.pageSize\.height - 12 - 10 - 2/);
  assert.match(block, /if \(y \+ closeH > CONTENT_FLOOR\)/);
  assert.equal(/Math\.max\(rightH, leftH\) \+ signature/.test(block), false,
    'the stamp must not be charged against the left column as well');

  // Measured at the size it is drawn at, or the wrap count would be wrong.
  assert.match(block, /doc\.setFontSize\(8\.5\);\s*\r?\n\s*const notesWrapped/);
  // And what was measured is what gets drawn - the same arrays, not a second
  // call to splitTextToSize that could disagree with the decision.
  const draw = PDF.slice(PDF.indexOf('if (notesWrapped.length)'));
  assert.match(draw, /doc\.text\(notesWrapped, L, ly \+ LEFT_GAP \+ 1\.5\)/);
  assert.match(draw, /doc\.text\(docTermsWrapped, L, ly \+ LEFT_GAP \+ 1\.5\)/);
});

test('PR13 both proforma pages ask for the redesigned script', () => {
  for (const page of ['proforma.html', 'proforma-list.html']) {
    assert.ok(rd(page).includes('client/js/pages/proforma-pdf.js?v=47'),
      page + ' must reference proforma-pdf.js at v=47');
    // and the mirror the server actually serves must agree
    assert.ok(rd('server', 'public', page).includes('client/js/pages/proforma-pdf.js?v=47'),
      'server/public/' + page + ' must match');
  }
});
