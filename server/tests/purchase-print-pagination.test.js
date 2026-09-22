// The printed purchase documents, page by page.
//
// Both documents a purchase produces on paper - the Purchase Order sent to a
// supplier and the Purchase Debit/Credit Note raised against a bill - were
// spending a second sheet on almost nothing, and the order was printing part
// of its approval block off the paper altogether:
//
//   * poPdfSignatures() worked out the rule and the "Authorized Signatory"
//     caption from the y the block WOULD have had, then moved the block to a
//     new page. On a ten-line order the caption was drawn at 306.9mm of a
//     297mm page: gone, with the panel left unlabelled.
//   * the note decided "if (y > 210) start a new page" - a number with no
//     relation to the height of what was about to be printed. A five-line
//     note went to a second page that carried the stamp and the footer and
//     nothing else, with 60mm of the first page blank.
//
// Every case below builds a REAL PDF with jsPDF and reads back where the ink
// actually landed. Nothing is asserted from the source alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PAGE_H = 297;

const findLib = (envVar, ...rel) => {
  const candidates = [process.env[envVar], path.join(__dirname, '..', 'node_modules', ...rel)].filter(Boolean);
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
};
const JSPDF_FILE = findLib('JSPDF_PATH', 'jspdf', 'dist', 'jspdf.umd.min.js');
const AUTOTABLE_FILE = findLib('JSPDF_AUTOTABLE_PATH', 'jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js')
  || (JSPDF_FILE ? path.join(path.dirname(JSPDF_FILE), 'jspdf.plugin.autotable.min.js') : null);
const HAVE_LIBS = !!(JSPDF_FILE && AUTOTABLE_FILE && fs.existsSync(AUTOTABLE_FILE));
const NO_LIBS = { skip: 'jsPDF / autoTable are not available - set JSPDF_PATH (and JSPDF_AUTOTABLE_PATH) to run the render cases' };
const renderTest = (name, fn) => (HAVE_LIBS ? test(name, fn) : test(name, NO_LIBS, () => {}));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// A business with a stamp and a signature on file: the layout it produces is
// the one the two-page reports came from.
const PROFILE = {
  business_name: 'VTECH KITCHEN EQUIPMENTS',
  address: '9/83 E, 4th Street Extension, T Balan Nagar, Ganapathy Pudur',
  district: 'Coimbatore', state: 'Tamil Nadu',
  gstin: '33AAAAA0000A1Z5', pan: 'AAAAA0000A',
  phone: '98400 00000', email: 'orders@vtech.test', website: 'www.vtech.test',
  bank_name: 'Bank of Baroda', bank_account_no: '1234567890123',
  bank_ifsc: 'BARB0GANAPA', bank_branch: 'Ganapathy Pudur',
  logo_base64: PNG, seal_base64: PNG, signature_base64: PNG, terms_conditions: ''
};

// ── a browser-shaped sandbox that records where every mark was made ──────
function load(files) {
  const noop = () => {};
  const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop,
    getContext: () => null, toDataURL: () => '' });
  const el = mkEl();
  const sb = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl, ArrayBuffer,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array, DataView,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    Buffer, TextEncoder, TextDecoder, btoa, atob,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: el, body: el, head: el,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl() },
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    __docs: [], __texts: [], __marks: []
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), sb, { filename: 'jspdf.umd.min.js' });
  vm.runInContext(fs.readFileSync(AUTOTABLE_FILE, 'utf8'), sb, { filename: 'jspdf.plugin.autotable.min.js' });
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  // Both renderers use invoice-pdf.js's stamp helpers, exactly as the pages
  // load them: reused, never copied.
  vm.runInContext(rd('client', 'js', 'pages', 'invoice-pdf.js'), sb, { filename: 'invoice-pdf.js' });
  for (const f of files) vm.runInContext(rd('client', 'js', 'pages', f), sb, { filename: f });
  vm.runInContext(`
    showToast = function () {};
    handleApiError = function () {};
    getCachedProfile = function () { return ${JSON.stringify(PROFILE)}; };
    generateQRDataUrl = async function () { return ${JSON.stringify(PNG)}; };
    imageUrlToDataUrl = async function (u) { return u || null; };
    (function () {
      const Orig = window.jspdf.jsPDF;
      function Wrapped(o) {
        const d = new Orig(o);
        const pg = function () { return d.internal.getCurrentPageInfo().pageNumber; };
        const tx = d.text, rc = d.rect, ln = d.line, ai = d.addImage;
        d.text = function (s, x, y) {
          const str = Array.isArray(s) ? s.join(' ') : String(s);
          __texts.push({ s: str, x: x, y: y, page: pg() });
          __marks.push({ kind: 'text', y: y, bottom: y, page: pg() });
          return tx.apply(d, arguments);
        };
        d.rect = function (x, y, w, h) { __marks.push({ kind: 'rect', y: y, bottom: y + (h || 0), page: pg() }); return rc.apply(d, arguments); };
        d.line = function (x1, y1, x2, y2) { __marks.push({ kind: 'line', y: Math.min(y1, y2), bottom: Math.max(y1, y2), page: pg() }); return ln.apply(d, arguments); };
        d.addImage = function (i, f, x, y, w, h) { __marks.push({ kind: 'image', y: y, bottom: y + (h || 0), page: pg() }); return ai.apply(d, arguments); };
        d.save = function () { return d; };
        __docs.push(d);
        return d;
      }
      Wrapped.API = Orig.API;
      window.jspdf.jsPDF = Wrapped;
    })();
  `, sb);
  return sb;
}

const r2 = n => Number(Math.round(Number(n + 'e2')) + 'e-2');

// ── the records, as the API returns them ────────────────────────────────
const orderLine = (n) => {
  const qty = 2, rate = 12500, pct = 18;
  const taxable = r2(qty * rate), tax = r2(taxable * pct / 100);
  return { id: 'i' + n, product_name: 'Steamer ' + n + ' tray with timer - Electrical',
    hsn_code: '84198190', unit: 'PCS', quantity: qty + '.000', rate: rate + '.00',
    gst_percentage: pct + '.00', taxable_value: taxable.toFixed(2), gst_amount: tax.toFixed(2),
    total_amount: r2(taxable + tax).toFixed(2), discount_percentage: '0.00' };
};
const mkOrder = items => {
  const taxable = r2(items.reduce((s, i) => s + Number(i.taxable_value), 0));
  const tax = r2(items.reduce((s, i) => s + Number(i.gst_amount), 0));
  return { id: 'po1', document_number: 'PO/2026/09/0005', document_date: '2026-09-09',
    status: 'CONFIRMED', vendor_name: 'Kookmate India', vendor_gstin: '33AAACK1234C1Z9',
    phone: '99990 00011', address: '9/83 E, 4th Street, Ganapathy Pudur, Coimbatore - 641006',
    state: 'Tamil Nadu', district: 'Coimbatore', purchase_representative: 'Jegatheswar',
    logistics_mode: 'By Transport', payment_terms: '100% Advance',
    expected_delivery_date: '2026-09-16', delivery_address: 'VTECH Warehouse, Ganapathy Pudur',
    delivery_state: 'Tamil Nadu', delivery_district: 'Coimbatore', supply_type: 'intrastate',
    taxable_amount: taxable.toFixed(2), gst_percentage: '18.00', gst_amount: tax.toFixed(2),
    igst: '0.00', cgst: r2(tax / 2).toFixed(2), sgst: r2(tax / 2).toFixed(2),
    cess_amount: '0.00', total_amount: r2(taxable + tax).toFixed(2), terms: null };
};
const noteLine = n => ({ product_name: 'Chapathi Press Machine ' + n, hsn_code: '84388090',
  unit: 'NOS', quantity: '1.000', rate: '27000.00', discount_percentage: '0.00',
  gst_percentage: '18.00', cess_rate: '0.000', taxable_value: '27000.00', sort_order: n });
const mkNote = items => ({ note_type: 'debit', note_number: 'PN-1', note_date: '2026-09-12',
  original_purchase_number: 'PUR-001', original_purchase_date: '2026-09-01',
  vendor_name: 'Kookmate India', vendor_gstin: '33AAACK1234C1Z9', state: 'Tamil Nadu',
  reason: 'Rate difference', supply_type: 'intrastate',
  taxable_amount: 27000 * items.length, gst_percentage: 18, igst: 0,
  cgst: 2430 * items.length, sgst: 2430 * items.length, gst_amount: 4860 * items.length,
  total_amount: 31860 * items.length });

async function renderOrder(n) {
  const items = Array.from({ length: n }, (_, i) => orderLine(i + 1));
  const sb = load(['purchase-order-pdf.js']);
  await vm.runInContext('generatePurchaseOrderPDF(' + JSON.stringify(mkOrder(items)) + ','
    + JSON.stringify(items) + ', "save")', sb);
  const doc = sb.__docs[sb.__docs.length - 1];
  return { doc, pages: doc.internal.getNumberOfPages(), texts: sb.__texts.slice(), marks: sb.__marks.slice() };
}
async function renderNote(n) {
  const items = Array.from({ length: n }, (_, i) => noteLine(i));
  const sb = load(['purchase-note-pdf.js']);
  await vm.runInContext('buildPurchaseNotePDFDoc(' + JSON.stringify(mkNote(items)) + ','
    + JSON.stringify(items) + ')', sb);
  const doc = sb.__docs[sb.__docs.length - 1];
  return { doc, pages: doc.internal.getNumberOfPages(), texts: sb.__texts.slice(), marks: sb.__marks.slice() };
}
const on = (texts, page) => texts.filter(t => t.page === page);
const says = (texts, needle) => texts.filter(t => t.s.includes(needle));

// ══════════════════════════════════════════════════════════════════════
//  The Purchase Order
// ══════════════════════════════════════════════════════════════════════

renderTest('PG1 a one-line order is one page, whole', async () => {
  const { pages, texts } = await renderOrder(1);
  assert.strictEqual(pages, 1);
  for (const s of ['PURCHASE ORDER', 'Steamer 1 tray with timer - Electrical', 'TOTAL PO VALUE',
    'TERMS & CONDITIONS', "SUPPLIER'S AUTHORIZED SIGNATORY", 'Authorized Signatory', 'Page 1 of 1']) {
    assert.ok(says(texts, s).length, s + ' is printed');
  }
});

renderTest('PG2 an order of six lines still prints on one page', async () => {
  // The size it was reported at. It used to miss by a fraction of a
  // millimetre and spend a whole sheet on the approval block.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const { pages } = await renderOrder(n);
    assert.strictEqual(pages, 1, n + ' line(s) must print on one page');
  }
});

renderTest('PG3 the approval block and its caption are never split', async () => {
  for (const n of [1, 5, 6, 7, 8, 10, 15]) {
    const { texts } = await renderOrder(n);
    const panel = says(texts, 'APPROVED BY')[0];
    const caption = says(texts, 'Authorized Signatory')[0];
    const forUs = says(texts, 'For VTECH KITCHEN EQUIPMENTS')[0];
    assert.ok(panel && caption && forUs, n + ': the block is printed');
    assert.strictEqual(caption.page, panel.page, n + ': the caption is on the panel\'s page');
    assert.strictEqual(forUs.page, panel.page, n + ': so is the company line');
    assert.ok(caption.y > forUs.y, n + ': the caption sits below the stamp, not above it');
    // the whole block inside the 38mm panel it belongs to
    assert.ok(caption.y - panel.y < 40, n + ': the caption belongs to that panel, not to a y left over from another page');
  }
});

renderTest('PG4 nothing is ever drawn past the edge of the paper', async () => {
  for (const n of [1, 3, 5, 6, 8, 10, 15, 25]) {
    const { marks } = await renderOrder(n);
    const over = marks.filter(m => m.bottom > PAGE_H - 1);
    assert.deepStrictEqual(over, [], n + ' line(s): every mark is on the page');
  }
});

renderTest('PG5 an order that genuinely overflows continues cleanly', async () => {
  const { pages, texts } = await renderOrder(25);
  assert.ok(pages > 1, '25 lines need more than one page');
  // the item head is repeated on every page the table runs onto
  const headPages = new Set(says(texts, 'DESCRIPTION').map(t => t.page));
  const rowPages = new Set(says(texts, 'Steamer ').map(t => t.page));
  for (const p of rowPages) assert.ok(headPages.has(p), 'page ' + p + ' repeats the column heads');
  // and every page says which one it is
  for (let p = 1; p <= pages; p++) {
    assert.ok(on(texts, p).some(t => t.s === `Page ${p} of ${pages}`), 'page ' + p + ' is numbered');
    assert.ok(on(texts, p).some(t => t.s.includes('Purchase Order No.')), 'page ' + p + ' carries the order number');
  }
  // nothing is repeated that should appear once
  assert.strictEqual(says(texts, 'TOTAL PO VALUE').length, 1);
  assert.strictEqual(says(texts, 'Authorized Signatory').length, 1);
});

// ══════════════════════════════════════════════════════════════════════
//  The Purchase Debit / Credit Note
// ══════════════════════════════════════════════════════════════════════

renderTest('PG6 a note of up to six affected lines prints on one page', async () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const { pages } = await renderNote(n);
    assert.strictEqual(pages, 1, n + ' affected line(s) must print on one page');
  }
});

renderTest('PG7 the closing half of a note travels as one piece', async () => {
  // Never again a page carrying nothing but the stamp and the footer: the
  // tax breakup, the total, the amount in words and the signature belong
  // together, wherever they land.
  for (const n of [1, 5, 7, 10, 20]) {
    const { texts, pages } = await renderNote(n);
    const where = s => says(texts, s)[0];
    const breakup = where('TAX BREAKUP');
    const total = where('Total Debit Amount');
    const words = where('Amount in Words:');
    const sign = where('Authorized Signatory');
    assert.ok(breakup && total && words && sign, n + ': the closing blocks are printed');
    assert.strictEqual(total.page, breakup.page, n + ': the total stays with the breakup');
    assert.strictEqual(words.page, breakup.page, n + ': so does the amount in words');
    assert.strictEqual(sign.page, breakup.page, n + ': and the signature');
    // the last page is never just a stamp on an empty sheet
    assert.ok(on(texts, pages).length > 10, n + ': the last page carries real content');
  }
});

renderTest('PG8 a note that overflows repeats its item heads and clips nothing', async () => {
  const { pages, texts, marks } = await renderNote(20);
  assert.ok(pages > 1, '20 affected lines need more than one page');
  const headPages = new Set(says(texts, 'Product / Item').map(t => t.page));
  const rowPages = new Set(says(texts, 'Chapathi Press Machine').map(t => t.page));
  for (const p of rowPages) assert.ok(headPages.has(p), 'page ' + p + ' repeats the column heads');
  assert.deepStrictEqual(marks.filter(m => m.bottom > PAGE_H - 1), [], 'every mark is on the page');
  for (let p = 1; p <= pages; p++) {
    assert.ok(on(texts, p).some(t => t.s.includes('computer-generated')), 'page ' + p + ' carries the footer');
  }
});

renderTest('PG9 nothing is drawn past the edge of a note either', async () => {
  for (const n of [1, 3, 5, 6, 7, 10, 15, 25]) {
    const { marks } = await renderNote(n);
    assert.deepStrictEqual(marks.filter(m => m.bottom > PAGE_H - 1), [],
      n + ' affected line(s): every mark is on the page');
  }
});

test('PG10 both documents are served fresh', () => {
  for (const [page, key] of [
    ['purchase-orders.html', 'client/js/pages/purchase-order-pdf.js?v=4'],
    ['purchase-order.html', 'client/js/pages/purchase-order-pdf.js?v=4'],
    ['purchase-notes.html', 'client/js/pages/purchase-note-pdf.js?v=2']
  ]) {
    assert.ok(rd(page).includes(key), page + ' loads ' + key);
  }
});

test('PG11 the page breaks are measured, never guessed', () => {
  // read as code: the comments explain what the fixed numbers used to be
  const code = src => src.split(/\r?\n/).map(l => l.replace(/\/\/.*/, '')).join('\n');
  const note = code(rd('client', 'js', 'pages', 'purchase-note-pdf.js'));
  assert.doesNotMatch(note, /if \(y > 210\)/, 'the fixed 210mm break is gone');
  assert.doesNotMatch(note, /if \(y > 250\)/, 'and the fixed 250mm one');
  assert.match(note, /if \(y \+ closingH > sigBlockY\)/, 'the closing half is measured against the signature floor');
  const po = code(rd('client', 'js', 'pages', 'purchase-order-pdf.js'));
  // the room check comes first; the rule is measured from what it returns
  const space = po.indexOf('y = poPdfSpace(doc, y, blockH);');
  const rule = po.indexOf('const ruleY = y + blockH - 5.5;');
  assert.ok(space > 0 && rule > space, 'ruleY is worked out after the page decision, not before it');
});
