// Proforma on A4 PORTRAIT: one continuous product table, and the whole
// quotation on one sheet for the sizes a quotation usually is.
//
// The requirement, stated as the cases below check it:
//
//   - ONE table. 1 product is one row in it, 10 products are ten rows in the
//     SAME table. Never a table per product, never a product card.
//   - One shared heading: #, Product Name, HSN, Qty, Unit, Rate, Disc %,
//     GST %, CGST, SGST, IGST, Total - with Disc % dropped only when no line
//     carries a discount.
//   - For 1, 5 and 10 products the close (bank details, GST summary, Quoted
//     Total, advance, words, terms, signature) stays on the SAME page as the
//     table. It is not pushed to a second sheet while the first has room.
//   - For a quotation that genuinely exceeds a readable page, the SAME table
//     continues with its heading repeated, and the close stays together on
//     the final page.
//
// The page-count cases below render with the REAL jsPDF and count the pages
// in the real output, because that is the only thing that answers the
// question. A source assertion cannot tell you whether ten products fit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const PDF = rd('client', 'js', 'pages', 'proforma-pdf.js');
const PDF_CODE = strip(PDF);
const INV_PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');

// The same availability rule the other render cases use: the application
// loads jsPDF from a CDN, so the server has no dependency on it and these
// cases skip with a reason rather than failing over a missing library.
const JSPDF_FILE = (() => {
  const candidates = [
    process.env.JSPDF_PATH,
    path.join(__dirname, 'vendor', 'jspdf.umd.min.js'),
    path.join(__dirname, '..', 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js')
  ].filter(Boolean);
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
})();
const AUTOTABLE_FILE = (() => {
  const candidates = [
    process.env.JSPDF_AUTOTABLE_PATH,
    path.join(__dirname, 'vendor', 'jspdf.plugin.autotable.min.js'),
    path.join(__dirname, '..', 'node_modules', 'jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js')
  ].filter(Boolean);
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
})();
const CAN_RENDER = !!(JSPDF_FILE && AUTOTABLE_FILE);
const NO_JSPDF = { skip: 'jsPDF/autoTable not available - set JSPDF_PATH and JSPDF_AUTOTABLE_PATH to the umd builds' };
const renderTest = (name, fn) => (CAN_RENDER ? test(name, fn) : test(name, NO_JSPDF, () => {}));

// ── A real document, rendered by the real library ───────
function realCtx() {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Intl, Date, Math, JSON, parseFloat, parseInt, isNaN, isFinite,
    atob, btoa, Buffer, TextEncoder, TextDecoder, URL,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
    ArrayBuffer, DataView, Array, Object, String, Number, Boolean, Error,
    RegExp, Map, Set, WeakMap, Promise, Symbol, Function,
    encodeURIComponent, decodeURIComponent, escape, unescape, process
  };
  ctx.window = ctx; ctx.self = ctx; ctx.global = ctx; ctx.globalThis = ctx;
  ctx.navigator = { userAgent: 'node' };
  ctx.document = {
    createElement: () => ({ getContext: () => null, style: {}, setAttribute() {}, appendChild() {} }),
    createElementNS: () => ({ style: {}, setAttribute() {} }),
    body: { appendChild() {} }, head: { appendChild() {} }, documentElement: { style: {} }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), ctx, { filename: 'jspdf.umd.min.js' });
  vm.runInContext(fs.readFileSync(AUTOTABLE_FILE, 'utf8'), ctx, { filename: 'autotable.js' });
  for (const f of [['client', 'js', 'utilities', 'utils.js'],
                   ['client', 'js', 'pages', 'invoice-pdf.js'],
                   ['client', 'js', 'pages', 'proforma-pdf.js']]) {
    try {
      vm.runInContext(rd(...f), ctx, { filename: f[f.length - 1] });
    } catch { /* these files touch the DOM at load; only their functions are wanted */ }
  }
  vm.runInContext(`
    getCachedProfile = function () { return {
      business_name: 'VTECH', website: 'https://example.test/',
      address: '9/83 E, 4TH STREET EXT, T BALAN NAGAR, Ganapathy Pudur, Coimbatore, 641006',
      state: 'Tamil Nadu', gstin: '33AARFV8415B1Z4',
      email: 'sales@example.test', phone: '9944556683', header_color: '#00796b',
      bank_name: 'Bank of Baroda', bank_account_no: '35540200001588',
      bank_ifsc: 'BARB0GANAPA', bank_branch: 'Ganapathy', upi_id: 'vtech@barodampay',
      terms_conditions: [
        'Payment Term: 100% Advance Payment / As per Order',
        'Delivery Schedule: Bank Transfer Confirmation',
        'Taxes & Duties: Extra as applicable',
        'Freight Payment: As applicable',
        'Installation: Customer Scope / As Applicable',
        'Shipment Date: As per Production & Dispatch Schedule'
      ].join('\\n')
    }; };
    imageUrlToDataUrl = async function () { return null; };
    inkBoundsOf = async function () { return null; };
    proformaDisplayNumber = function (n) { return n; };
    ensureProformaDisplayFormat = async function () {};
  `, ctx);
  return ctx;
}

const CATALOGUE = [
  ['Sugarcane Juice Machine Petrol', '84351000', 'NOS', 62000],
  ['Vtech Sugar Cane Peeler', '84386000', 'PCS', 22000],
  ['ICE BOX', '39241010', 'NOS', 4500],
  ['Commercial Tilting Wet Grinder with timer 10 Litre', '85094000', 'NOS', 35000],
  ['Stainless Steel Sink Workstation 48 inch', '73241000', 'NOS', 18500]
];

function lines(n, over) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const [name, hsn, unit, rate] = CATALOGUE[i % CATALOGUE.length];
    const qty = 1 + (i % 3);
    const taxable = rate * qty;
    const gst = Math.round(taxable * 18) / 100;
    out.push(Object.assign({
      product_name: name + (i >= CATALOGUE.length ? ' #' + (i + 1) : ''),
      hsn_code: hsn, unit, quantity: qty, rate, discount_percentage: 0,
      gst_percentage: 18, taxable_value: taxable, gst_amount: gst,
      cgst: Math.round(gst * 50) / 100, sgst: Math.round(gst * 50) / 100, igst: 0,
      cess_amount: 0, total_amount: taxable + gst, sort_order: i
    }, over || {}));
  }
  return out;
}

// A quotation carrying delivery, an advance, notes and its own terms - the
// fullest shape, so these page counts are the worst case rather than a
// flattering one.
function rowFor(items) {
  const taxable = items.reduce((s, it) => s + it.taxable_value, 0);
  const cgst = items.reduce((s, it) => s + it.cgst, 0);
  const sgst = items.reduce((s, it) => s + it.sgst, 0);
  const T = 2500, TG = 450;
  const row = {
    id: 'pf-178', document_number: 'PI-00178', document_date: '2026-10-16',
    valid_until: '2026-11-15', status: 'draft', customer_name: 'Praveen C',
    gst_number: '', phone: '9876543210',
    address: '139, South Street, Pattur, Pothiramangalam Po, Cuddalore-606111.',
    state: 'Tamil Nadu', supply_type: 'intrastate', gst_category: 'regular',
    taxable_amount: taxable + T, gst_percentage: 18, gst_amount: cgst + sgst + TG,
    igst: 0, cgst: cgst + TG / 2, sgst: sgst + TG / 2,
    transport_charge: T, transport_gst_amount: TG, advance_amount: 50000,
    notes: 'Delivery within three weeks of a confirmed order.',
    terms: 'Prices quoted are ex-works Coimbatore.', total_amount: 0
  };
  row.total_amount = Math.round(row.taxable_amount + row.cgst + row.sgst);
  return row;
}

// Read the text back out of the rendered PDF, per page. jsPDF writes its
// content streams uncompressed, so the text operators can be read directly -
// which is how these cases know WHICH page a line landed on.
function textByPage(buf) {
  const un = (s) => s.replace(/\\\(/g, '(').replace(/\\\)/g, ')')
    .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8) & 0xFF));
  const raw = buf.toString('latin1');
  const pages = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw))) {
    const body = m[1];
    if (!/\)\s*Tj/.test(body)) continue;          // a font or image stream
    const runs = [];
    const tre = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let t;
    while ((t = tre.exec(body))) runs.push(un(t[1]));
    if (runs.length) pages.push(runs);
  }
  // jsPDF can emit a page's stream more than once; identical neighbours are
  // the same page, not a duplicate page.
  return pages.filter((p, i) => i === 0 || p.join('\u0000') !== pages[i - 1].join('\u0000'));
}

async function render(n, over) {
  const ctx = realCtx();
  const items = lines(n, over);
  const doc = await ctx.buildProformaPDFDoc(rowFor(items), items);
  const buf = Buffer.from(doc.output('arraybuffer'));
  return { pages: doc.internal.getNumberOfPages(), text: textByPage(buf), items, ctx };
}

// ═══ The table itself ═════════════════════════════════

test('PP1 the page is A4 portrait and the columns are sized for its width', () => {
  assert.match(PDF_CODE, /orientation: 'portrait'/);
  assert.equal(/orientation: 'landscape'/.test(PDF_CODE), false);
  assert.match(PDF_CODE, /const L = 10, R = pw - 10;/);
  // Both column sets must come to exactly the usable 190mm, so the declared
  // widths are millimetres rather than ratios that happen to be scaled.
  const blk = PDF.slice(PDF.indexOf('const PROFORMA_ITEM_COLUMNS'),
                        PDF.indexOf('function proformaHasDiscount'));
  const ws = [...blk.matchAll(/head: '([^']+)',\s*w: (\d+)/g)].map(m => [m[1], +m[2]]);
  const slack = +(/slack: (\d+)/.exec(blk) || [0, 0])[1];
  const disc = ws.find(w => w[0] === 'Disc %')[1];
  const all = ws.reduce((a, w) => a + w[1], 0);
  assert.strictEqual(all, 190, 'twelve columns must come to 190mm, got ' + all);
  assert.strictEqual(all - disc + slack, 190,
    'eleven columns must also come to 190mm - the dropped width goes to the name');
});

test('PP2 there is ONE table for every product, never one per product', () => {
  const fn = PDF_CODE.slice(PDF_CODE.indexOf('async function buildProformaPDFDoc'),
                            PDF_CODE.indexOf('async function downloadProformaDocument'));
  // Exactly one item table is drawn, with the whole item list as its body.
  const itemTables = (fn.match(/head: \[itemCols\.map\(c => c\.head\)\]/g) || []).length;
  assert.strictEqual(itemTables, 1, 'exactly one item table may be built');
  assert.match(fn, /body: rows,/);
  assert.match(fn, /const rows = inv\.items\.map\(\(it, i\) => itemCols\.map\(c => c\.val\(it, i\)\)\)/);
  // Nothing per-item: no table, no card, no box drawn inside a loop over items.
  assert.equal(/inv\.items\.(forEach|map)\([^)]*\)\s*=>\s*\{[^}]*autoTable/.test(fn), false,
    'no table may be drawn per product');
  // The only other autoTable in the file is the standing terms schedule.
  const tables = (fn.match(/doc\.autoTable\(/g) || []).length;
  assert.ok(tables <= 2, 'the item table and at most the terms schedule, got ' + tables);
});

test('PP3 one shared heading, in the required order, with Disc % conditional', () => {
  const ctx = { formatNum: (n) => String(n), round2: (n) => n };
  vm.createContext(ctx);
  vm.runInContext(PDF, ctx, { filename: 'proforma-pdf.js' });

  // Joined rather than deep-compared: the array comes back from the vm
  // context, so its prototype is that realm's Array and deepStrictEqual
  // fails on identity even when the headings match.
  const heads = (show) => Array.from(ctx.proformaItemColumns(show)).map(c => c.head).join(' | ');
  assert.strictEqual(heads(true),
    '# | Product Name | HSN | Qty | Unit | Rate | Disc % | GST % | CGST | SGST | IGST | Total');
  assert.strictEqual(heads(false),
    '# | Product Name | HSN | Qty | Unit | Rate | GST % | CGST | SGST | IGST | Total');
});

test('PP4 a continuation repeats the heading and never splits a row', () => {
  assert.match(PDF_CODE, /showHead: 'everyPage'/);
  assert.match(PDF_CODE, /rowPageBreak: 'avoid'/);
});

test('PP5 the rows are compact but not shrunken', () => {
  const at = PDF_CODE.indexOf('doc.autoTable({');
  const tbl = PDF_CODE.slice(at, PDF_CODE.indexOf('});', at));
  const body = +/bodyStyles: \{ fontSize: ([\d.]+)/.exec(tbl)[1];
  const head = +/headStyles: \{ fillColor: accent, textColor: 255, fontSize: ([\d.]+)/.exec(tbl)[1];
  const pad = +/cellPadding: ([\d.]+)/.exec(tbl)[1];
  // 7pt is the size the reference tax invoice sets its own item table at, so
  // this is the same reading size - not a smaller one bought to force a page.
  assert.ok(body >= 7, 'body text must stay at 7pt or more, got ' + body);
  assert.ok(head >= 6.5, 'the heading must stay at 6.5pt or more, got ' + head);
  assert.ok(pad >= 1.2, 'rows need padding to stay readable, got ' + pad);
  assert.match(tbl, /overflow: 'linebreak'/, 'a long name wraps inside its column');
});

// ═══ What actually fits, measured on real output ══════

renderTest('PP6 one product: one page, with the close on it', async () => {
  const r = await render(1);
  assert.strictEqual(r.pages, 1, 'one product must not need a second page');
  const p1 = r.text[0].join(' | ').toUpperCase();
  for (const must of ['PROFORMA INVOICE', 'NOT A TAX INVOICE', 'PRODUCT NAME',
                      'BANK DETAILS FOR PAYMENT', 'QUOTED TOTAL', 'PAYMENT TERMS',
                      'AMOUNT IN WORDS:', 'AUTHORIZED SIGNATORY']) {
    assert.ok(p1.includes(must), 'page 1 must carry: ' + must);
  }
});

renderTest('PP7 five and ten products: still one page, close included', async () => {
  for (const n of [5, 10]) {
    const r = await render(n);
    assert.strictEqual(r.pages, 1, n + ' products must fit on one page, got ' + r.pages);
    const p1 = r.text[0].join(' | ').toUpperCase();
    // Every product is in the table on that page.
    for (let i = 1; i <= n; i++) {
      assert.ok(r.text[0].includes(String(i)), n + ' products: row ' + i + ' must be on the page');
    }
    // And the close is on the same page, not pushed off it.
    for (const must of ['BANK DETAILS FOR PAYMENT', 'QUOTED TOTAL', 'PAYMENT TERMS',
                        'BALANCE AMOUNT DUE', 'AMOUNT IN WORDS:', 'AUTHORIZED SIGNATORY']) {
      assert.ok(p1.includes(must), n + ' products: page 1 must carry ' + must);
    }
    // One heading, one table: the column heading appears once on the page.
    const heads = r.text[0].filter(s => s === 'Product Name').length;
    assert.strictEqual(heads, 1, n + ' products: one table heading, got ' + heads);
  }
});

renderTest('PP8 a long quotation continues the SAME table and keeps the close together', async () => {
  const r = await render(40);
  assert.ok(r.pages >= 2, '40 products must paginate');
  const last = r.text[r.text.length - 1].join(' | ').toUpperCase();

  // Every row number appears exactly once across the document - nothing is
  // dropped at a page boundary and nothing is drawn twice.
  const all = r.text.flat();
  for (let i = 1; i <= 40; i++) {
    const seen = all.filter(s => s === String(i)).length;
    assert.ok(seen >= 1, 'row ' + i + ' is missing from the document');
  }
  // The heading is repeated on the page the table continues onto.
  const pagesWithRows = r.text.filter(p => p.includes('Product Name'));
  assert.ok(pagesWithRows.length >= 2, 'the heading must repeat on the continuation page');

  // The closing block is together, on the final page.
  for (const must of ['BANK DETAILS FOR PAYMENT', 'QUOTED TOTAL', 'PAYMENT TERMS',
                      'AMOUNT IN WORDS:', 'AUTHORIZED SIGNATORY']) {
    assert.ok(last.includes(must), 'the final page must carry ' + must);
  }
  // And it is not spread across pages: the Quoted Total appears once.
  assert.strictEqual(all.filter(s => s === 'Quoted Total').length, 1,
    'the close must be drawn once, on one page');
});

renderTest('PP9 a discounted quotation prints twelve columns and still fits', async () => {
  const r = await render(10, { discount_percentage: 7.5 });
  assert.strictEqual(r.pages, 1, 'ten discounted products must still fit on one page');
  const p1 = r.text[0];
  assert.ok(p1.includes('Disc %'), 'the discount column must be printed');
  assert.ok(p1.some(s => s === '7.50%'), 'and the discount itself');
  assert.ok(p1.join(' | ').includes('Quoted Total'), 'the close stays on the page');
});

renderTest('PP10 the quotation facts and the figures are unchanged by the new page', async () => {
  const r = await render(5);
  const p1 = r.text[0].join(' | ');
  assert.ok(p1.includes('PI-00178'), 'the number as stored');
  assert.ok(p1.includes('16/10/2026'), 'the date');
  assert.ok(p1.includes('15/11/2026'), 'valid until');
  assert.ok(p1.includes('30 Days'), 'the validity');
  // The GST summary and the delivery rows the quotation carries.
  for (const must of ['Subtotal', 'Taxable Amount', 'CGST', 'SGST',
                      'Machine / Product Total', 'Transport Charge', 'Transport GST',
                      'Advance Amount', 'Balance Amount Due']) {
    assert.ok(p1.includes(must), 'the close must carry ' + must);
  }
  // Nothing tax-invoice-only came with the portrait page.
  for (const banned of ['Original for Recipient', 'Duplicate for File Copy', 'IRN']) {
    assert.equal(p1.includes(banned), false, 'must not print ' + banned);
  }
});

// ═══ The preview follows the page ═════════════════════

test('PP11 the HTML preview is portrait too, and uses the one table', () => {
  assert.match(PDF_CODE, /@page \{ size: A4 portrait/);
  assert.equal(/@page \{ size: A4 landscape/.test(PDF_CODE), false);
  assert.match(PDF_CODE, /max-width: 190mm/);
  // One <table class="items"> with one thead and the whole body.
  const html = PDF_CODE.slice(PDF_CODE.indexOf('return `<!DOCTYPE html>'));
  assert.strictEqual((html.match(/<table class="items">/g) || []).length, 1);
  assert.strictEqual((html.match(/<tbody>\$\{rowsHtml\}<\/tbody>/g) || []).length, 1);
  // Built from the same descriptors as the PDF, so the two cannot differ.
  assert.match(PDF_CODE, /const cols = proformaItemColumns\(showDiscount\)/);
  assert.match(PDF_CODE, /table\.items thead \{ display: table-header-group/);
});

test('PP12 the shared helpers are still the invoice\'s, not copies', () => {
  for (const name of ['invoicePartyLines', 'bankDetailLines', 'parseTermsTable',
                      'invoiceTransportParts', 'invoiceMachineTotal']) {
    assert.ok(INV_PDF.includes('function ' + name + '('), 'invoice-pdf.js defines ' + name);
    assert.equal(PDF_CODE.includes('function ' + name + '('), false,
      name + ' must be reused, not copied into the proforma');
    assert.ok(PDF_CODE.includes(name + '('), name + ' must actually be used');
  }
});
