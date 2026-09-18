// Proforma round-off: the saved quote is the tax invoice's own Grand Total.
//
// The defect: saveProforma() summed taxable + gst itself and stored that as
// total_amount, so the round-off - and the cess - never reached the stored
// quote. The Grand Total box (the invoice's computeInvoiceRollups) said one
// figure; Proforma List and the PDF said another.
//
// Every figure below comes from the REAL code: the grid prices each line
// (recalcAllRows -> applyLineTax), the Proforma page saves through its real
// saveProforma(), the PDF renders through its real buildProformaPDFDoc(), and
// the source of truth - the New Invoice page's own computeInvoiceRollups() -
// prices the same lines for comparison. Only the page's edges are stubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const UTILS = rd('client', 'js', 'utilities', 'utils.js');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const INV_PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');
const PF_PDF = rd('client', 'js', 'pages', 'proforma-pdf.js');
const PF_ENTRY = rd('client', 'js', 'pages', 'proforma-entry.js');
const PF_LIST = rd('client', 'js', 'pages', 'proforma-list.js');

const plain = (v) => JSON.parse(JSON.stringify(v));
const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const noop = () => {};
function mkEl(value) {
  return { value: value === undefined ? '' : value, textContent: '', innerHTML: '', disabled: false, checked: false,
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, setAttribute: noop };
}
const TOTALS_IDS = ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal', 'itemsIGST', 'itemsCGST', 'itemsSGST',
  'itemsCess', 'itemsCessRow', 'itemsAmountWords', 'itemsTransportCharge', 'itemsTransportGst', 'itemsTransportRate',
  'itemsTransportNoteRow', 'itemsTransportNote'];

function load({ supply = 'intrastate', formPrefix = 'proforma', withList = false } = {}) {
  const store = new Map();
  for (const id of [...TOTALS_IDS, 'pfSaveBtn', 'pfStatus', 'pfGstCategory']) store.set(id, mkEl());
  store.set('invSupply', mkEl(supply));
  const el = mkEl();
  const session = new Map();
  const sb = {
    console, setTimeout, clearTimeout, URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: k => session.delete(k) },
    document: { documentElement: el, body: el, head: el, getElementById: id => store.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: () => mkEl() },
    alert: noop, fetch: () => Promise.reject(new Error('no network in this test'))
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  const scripts = [['utils.js', UTILS], ['invoice-items.js', ITEMS], ['invoice-pdf.js', INV_PDF], ['proforma-pdf.js', PF_PDF], ['proforma-entry.js', PF_ENTRY]];
  if (withList) scripts.push(['proforma-list.js', PF_LIST]);
  for (const [name, src] of scripts) vm.runInContext(src, sb, { filename: name });
  vm.runInContext(`
    __toasts = []; __calls = [];
    __fields = { pfCustName: 'Round Off Traders', pfDate: '2026-09-18' };
    showToast = function (m, k) { __toasts.push({ m: m, k: k }); };
    getCurrentUser = async function () { return { id: 'u1' }; };
    handleApiError = function () {};
    getProformaText = function (id) { return __fields[id] || ''; };
    setProformaValue = function () {};
    buildProformaShipTo = function () { return {}; };
    buildProformaExport = function () { return {}; };
    if (typeof PROFORMA_STATUS_DEFAULT === 'undefined') PROFORMA_STATUS_DEFAULT = 'draft';
    if (typeof GST_CUSTOMER_CATEGORY_DEFAULT === 'undefined') GST_CUSTOMER_CATEGORY_DEFAULT = 'regular';
    apiFetch = async function (url, opts) {
      __calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (/reserve-number/.test(url)) return { documentNumber: 'PI-00001' };
      return { document: { id: 'pf1', document_number: 'PI-00001' }, items: [] };
    };
    itemsFormPrefix = ${JSON.stringify(formPrefix)};
  `, sb);
  sb.__el = id => store.get(id);
  sb.__run = code => vm.runInContext(code, sb);
  return sb;
}

// Lines as a person enters them; the grid prices them.
function priced(sb, lines, transport) {
  sb.__run('currentItems = ' + JSON.stringify(lines.map((l, i) => ({
    rowId: 'r' + i, product_id: 'p' + i, product_name: l.name || ('Machine ' + (i + 1)), hsn_code: '84388090', unit: 'PCS',
    quantity: l.qty, rate: l.rate, discount_percentage: l.disc || 0, gst_percentage: l.gst, gst_treatment: 'taxable',
    cess_rate: l.cess || 0, locked: false }))) + '; recalcAllRows();');
  if (transport !== undefined && transport !== null) { sb.__el('itemsTransportCharge').value = String(transport); sb.computeInvoiceRollups(); }
  return plain(sb.computeInvoiceRollups());
}
// The New Invoice page's own figures for the same lines: the source of truth.
function invoiceTruth(s) { return priced(load({ supply: s.supply, formPrefix: 'invoice' }), s.lines, s.transport); }

async function saveProformaFor(s) {
  const sb = load({ supply: s.supply });
  const screen = priced(sb, s.lines, s.transport);
  const shown = { roundOff: sb.__el('itemsRoundOff').value, grand: sb.__el('itemsGrandTotal').value };
  await sb.saveProforma();
  const call = plain(sb.__calls).find(c => /\/documents\/proforma_invoice\/save/.test(c.url));
  return { screen, shown, doc: call.body.document, items: call.body.items, lines: plain(sb.__run('currentItems')), sb };
}
// What Postgres hands back: DECIMAL(15,2) columns as two-decimal strings; the
// transport tax is the one figure the save route derives (routes/documents.js).
// GST as the invoice adds it up: the IGST/CGST/SGST split.
const splitGst = (d) => d.igst + d.cgst + d.sgst;
const dec = (v) => (v === null || v === undefined ? v : Number(v).toFixed(2));
function storedRow(doc, screen) {
  const row = { id: 'pf1', status: 'draft', ...doc };
  for (const k of ['taxable_amount', 'gst_amount', 'igst', 'cgst', 'sgst', 'total_amount', 'transport_charge']) row[k] = dec(row[k]);
  row.transport_gst_amount = doc.transport_charge === null || doc.transport_charge === undefined ? null : dec(screen.transport_gst_amount);
  return row;
}
const storedItems = (items) => items.map(it => ({ ...it, taxable_value: dec(it.taxable_value), gst_amount: dec(it.gst_amount),
  igst: dec(it.igst), cgst: dec(it.cgst), sgst: dec(it.sgst), total_amount: dec(it.total_amount), cess_amount: dec(it.cess_amount) }));

// The PDF, drawn by the real layout code into a recorder.
async function printed(row, items) {
  const sb = load();
  const texts = [];
  class FakeDoc {
    constructor() { this.internal = { pageSize: { width: 297, height: 210 }, getNumberOfPages: () => 1 }; this.lastAutoTable = { finalY: 0 }; }
    text(s, x, y) { texts.push({ s: Array.isArray(s) ? s.join('\n') : String(s), x, y }); return this; }
    splitTextToSize(s) { return String(s).split('\n'); }
    setFontSize() { return this; } setFont() { return this; } setTextColor() { return this; } setDrawColor() { return this; }
    setFillColor() { return this; } setLineWidth() { return this; } rect() { return this; } line() { return this; }
    addImage() { return this; } addPage() { return this; } setPage() { return this; } getNumberOfPages() { return 1; }
    getTextWidth(s) { return String(s).length * 1.8; }
    autoTable(o) { this.lastAutoTable = { finalY: (o.startY || 0) + 8 + (o.body || []).length * 8 }; return this; }
    save() {}
  }
  sb.jspdf = { jsPDF: FakeDoc };
  sb.__run(`getCachedProfile = function () { return { business_name: 'Scratch Co', header_color: '#00796b', state: 'Tamil Nadu' }; };
    imageUrlToDataUrl = async function () { return null; }; inkBoundsOf = async function () { return null; };`);
  await sb.buildProformaPDFDoc(row, items);
  const R_X = 283, BOX_X = 203;
  const block = texts.filter(t => t.x === BOX_X).map(t => {
    const v = texts.find(u => u.x === R_X && u.y === t.y && /^Rs\./.test(u.s));
    return [t.s, v ? v.s.replace(/^Rs\./, '') : null];
  });
  return { block, renderable: plain(sb.proformaToRenderable(row, items)) };
}
const money = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SCEN = {
  whole:      { lines: [{ qty: 1, rate: 2700, gst: 18 }], supply: 'intrastate' },
  positive:   { lines: [{ qty: 1, rate: 1234.57, gst: 18 }], supply: 'intrastate' },
  negative:   { lines: [{ qty: 1, rate: 1234.10, gst: 18 }], supply: 'intrastate' },
  intrastate: { lines: [{ qty: 3, rate: 8765.43, gst: 18 }, { qty: 2, rate: 1111.11, gst: 18 }], supply: 'intrastate' },
  interstate: { lines: [{ qty: 3, rate: 8765.43, gst: 18 }, { qty: 2, rate: 1111.11, gst: 18 }], supply: 'interstate' },
  transport:  { lines: [{ qty: 2, rate: 1234.57, gst: 18 }], supply: 'intrastate', transport: 99.99 },
  cess:       { lines: [{ qty: 1, rate: 25123.45, gst: 28, cess: 12 }], supply: 'intrastate' },
  cessInter:  { lines: [{ qty: 2, rate: 7654.32, gst: 28, cess: 1 }], supply: 'interstate' }
};

test('RS1 the saved quote is the New Invoice Grand Total - every scenario, figure for figure', async () => {
  for (const [name, s] of Object.entries(SCEN)) {
    const truth = invoiceTruth(s);
    const { screen, shown, doc } = await saveProformaFor(s);
    assert.deepStrictEqual(screen, truth, name + ': the proforma screen prices exactly as New Invoice does');
    assert.strictEqual(doc.total_amount, truth.total_amount, name + ': stored total = the invoice Grand Total');
    assert.strictEqual(Number.isInteger(doc.total_amount), true, name + ': a rupee figure');
    assert.strictEqual(shown.grand, money(truth.total_amount), name + ': the Grand Total box shows the same figure');
    assert.strictEqual(shown.roundOff, (truth.round_off >= 0 ? '+' : '') + money(truth.round_off), name + ': and the same Round Off');
  }
});

test('RS2 whole, positive and negative round-off: 0, up to the rupee, down to the rupee', async () => {
  const w = invoiceTruth(SCEN.whole), p = invoiceTruth(SCEN.positive), n = invoiceTruth(SCEN.negative);
  assert.deepStrictEqual([w.round_off, w.total_amount], [0, 3186]);
  assert.deepStrictEqual([p.round_off, p.total_amount], [0.21, 1457], '1456.79 rounds UP by +0.21');
  assert.deepStrictEqual([n.round_off, n.total_amount], [-0.24, 1456], '1456.24 rounds DOWN by -0.24');
  for (const [s, t] of [[SCEN.whole, w], [SCEN.positive, p], [SCEN.negative, n]]) {
    const { doc } = await saveProformaFor(s);
    assert.strictEqual(round2(doc.total_amount - round2(doc.taxable_amount + splitGst(doc))), t.round_off, 'the stored quote carries the round-off');
  }
});

test('RS3 cess is part of the quote, exactly as the invoice counts it - and the round-off is only the rounding', async () => {
  for (const name of ['cess', 'cessInter']) {
    const truth = invoiceTruth(SCEN[name]);
    const { doc, items } = await saveProformaFor(SCEN[name]);
    const cess = round2(items.reduce((a, it) => a + it.cess_amount, 0));
    assert.ok(cess > 0, name + ': the scenario has cess');
    assert.strictEqual(cess, truth.cess_amount);
    assert.strictEqual(doc.total_amount, Math.round(round2(doc.taxable_amount + splitGst(doc) + cess)), name + ': cess inside the quote');
    assert.strictEqual(round2(doc.total_amount - round2(doc.taxable_amount + splitGst(doc) + cess)), truth.round_off);
    assert.ok(Math.abs(truth.round_off) < 0.5, name + ': the round-off never absorbs the cess');
  }
});

test('RS4 transport and its tax sit inside the quote before rounding, as on the invoice', async () => {
  const truth = invoiceTruth(SCEN.transport);
  const { doc } = await saveProformaFor(SCEN.transport);
  assert.strictEqual(doc.transport_charge, 99.99);
  assert.strictEqual(doc.total_amount, truth.total_amount);
  assert.ok(truth.transport_gst_amount > 0);
  assert.strictEqual(round2(doc.total_amount - round2(doc.taxable_amount + splitGst(doc))), truth.round_off);
});

test('RS5 nothing else the save sends has changed: only the quoted total', async () => {
  for (const [name, s] of Object.entries(SCEN)) {
    const { doc, items, sb } = await saveProformaFor(s);
    const tcharge = s.transport === undefined ? null : s.transport;
    const tax = sb.invoiceTransportTax(tcharge);   // at the rate of the lines just priced
    // the formulas the save has always used for everything but the total
    assert.strictEqual(doc.taxable_amount, items.reduce((a, r) => a + r.taxable_value, 0) + (tcharge || 0), name + ': taxable');
    assert.strictEqual(doc.gst_amount, items.reduce((a, r) => a + r.gst_amount, 0) + tax.igst + tax.cgst + tax.sgst, name + ': gst');
    assert.strictEqual(doc.igst, items.reduce((a, r) => a + r.igst, 0) + tax.igst, name + ': igst');
    assert.strictEqual(doc.gst_percentage, items[0].gst_percentage, name + ': gst %');
    assert.strictEqual(doc.transport_charge, tcharge, name + ': charge');
  }
});

test('RS6 save, reopen: the same Round Off and the same total come back', async () => {
  for (const name of ['positive', 'negative', 'cess', 'transport']) {
    const s = SCEN[name];
    const { doc, items } = await saveProformaFor(s);
    const row = storedRow(doc, invoiceTruth(s));
    const sb = load({ supply: s.supply });
    sb.__run(`__rec = ${JSON.stringify(row)}; __rows = ${JSON.stringify(storedItems(items))};
      readAll = async function () { return [[__rec], __rows]; };
      (function () { var c = {}; c.select = c.eq = c.order = function () { return c; }; _supabase = { from: function () { return c; } }; })();
      populateGstCategorySelect = function () {}; restoreProformaExportFields = function () {}; onProformaGstCategoryChange = function () {};
      proformaStatus = function () { return 'draft'; }; populateDistrictList = function () {}; onProformaShipSameChange = function () {};
      renderProformaValidityNote = function () {};
      loadItemsIntoTable = function (r) { currentItems = r.map(function (x) { return Object.assign({}, x, { taxable_value: +x.taxable_value, gst_amount: +x.gst_amount, igst: +x.igst, cgst: +x.cgst, sgst: +x.sgst, total_amount: +x.total_amount, cess_amount: +x.cess_amount }); }); };`);
    await sb.loadProformaForEdit('pf1');
    const reopened = plain(sb.computeInvoiceRollups());
    assert.strictEqual(reopened.total_amount, Number(row.total_amount), name + ': the reopened Grand Total is the stored quote');
    assert.strictEqual(reopened.round_off, invoiceTruth(s).round_off, name + ': with the same Round Off');
  }
});

test('RS7 Proforma List shows the stored quote, which is now the rounded total', async () => {
  assert.match(PF_LIST, /<td class="text-right">&#8377;\$\{formatNum\(r\.total_amount\)\}<\/td>/, 'the list prints the stored total');
  const { doc } = await saveProformaFor(SCEN.positive);
  assert.strictEqual(money(storedRow(doc, invoiceTruth(SCEN.positive)).total_amount), '1,457.00');
});

test('RS8 the PDF prints the same Round Off and the same Quoted Total, and its column adds up', async () => {
  for (const [name, s] of Object.entries(SCEN)) {
    const truth = invoiceTruth(s);
    const { doc, items } = await saveProformaFor(s);
    const { block, renderable } = await printed(storedRow(doc, truth), storedItems(items));
    assert.strictEqual(renderable.total_amount, truth.total_amount, name);
    assert.strictEqual(renderable.round_off, truth.round_off, name);
    const quoted = block.find(r => r[0] === 'Quoted Total');
    assert.strictEqual(quoted[1], money(truth.total_amount), name + ': Quoted Total');
    const ro = block.find(r => r[0] === 'Round Off');
    if (Math.abs(truth.round_off) >= 0.005) assert.strictEqual(ro[1], (truth.round_off >= 0 ? '+' : '') + money(truth.round_off), name + ': Round Off row');
    else assert.strictEqual(ro, undefined, name + ': no Round Off row when there is nothing to round');
    const cessRow = block.find(r => r[0] === 'Cess');
    if (truth.cess_amount > 0) assert.strictEqual(cessRow[1], money(truth.cess_amount), name + ': Cess row');
    else assert.strictEqual(cessRow, undefined, name + ': no Cess row without cess');
    // subtotal + taxes + (transport) + cess + round-off = Quoted Total
    const num = (label) => { const r = block.find(x => x[0] === label || x[0].startsWith(label)); return r ? Number(r[1].replace(/[,+]/g, '')) : 0; };
    const sum = ['Subtotal', 'CGST', 'SGST', 'IGST', 'Transport Charge', 'Transport GST', 'Cess', 'Round Off'].reduce((a, l) => a + num(l), 0);
    assert.strictEqual(round2(sum), truth.total_amount, name + ': the totals column adds up to the Quoted Total');
  }
});

test('RS9 Proforma -> Invoice: the converted invoice totals exactly the stored quote', async () => {
  for (const name of Object.keys(SCEN)) {
    const s = SCEN[name];
    const { doc, items } = await saveProformaFor(s);
    const row = storedRow(doc, invoiceTruth(s));
    const list = load({ supply: s.supply, withList: true });
    list.__run('proformaRows = ' + JSON.stringify([row]) + '; proformaItemsByParent = ' + JSON.stringify({ pf1: storedItems(items) }) + ';');
    list.importProformaIntoInvoice('pf1');
    const draft = JSON.parse(list.sessionStorage.getItem('invoice_duplicate_draft'));
    const inv = load({ supply: draft.supply_type, formPrefix: 'invoice' });
    inv.__run('currentItems = ' + JSON.stringify(draft.items.map((it, i) => ({ ...it, rowId: 'd' + i, quantity: +it.quantity, rate: +it.rate,
      discount_percentage: +it.discount_percentage, gst_percentage: +it.gst_percentage, cess_rate: +it.cess_rate }))) + '; recalcAllRows();');
    inv.restoreInvoiceTransport(draft);
    const out = plain(inv.computeInvoiceRollups());
    assert.strictEqual(out.total_amount, Number(row.total_amount), name + ': invoice Grand Total = quoted total');
    assert.strictEqual(out.round_off, invoiceTruth(s).round_off, name + ': with the same Round Off');
  }
});

test('RS10 a proforma saved before this prints exactly as it always has', async () => {
  // As the old save wrote it: taxable + gst, unrounded, cess left out.
  const legacy = (taxable, gst, extra = {}) => ({ id: 'old', document_number: 'PI-00007', document_date: '2026-08-01', customer_name: 'Old Quote Co',
    status: 'sent', supply_type: 'intrastate', taxable_amount: dec(taxable), gst_percentage: 18, gst_amount: dec(gst), igst: '0.00',
    cgst: dec(gst / 2), sgst: dec(gst / 2), total_amount: dec(taxable + gst), transport_charge: null, transport_gst_amount: null, ...extra });
  const item = (cess) => ({ product_name: 'Old Machine', hsn_code: '84388090', unit: 'PCS', quantity: '1.000', rate: '1234.57', discount_percentage: '0.00',
    gst_percentage: '18.00', taxable_value: '1234.57', gst_amount: '222.22', igst: '0.00', cgst: '111.11', sgst: '111.11',
    total_amount: dec(1456.79 + cess), gst_treatment: 'taxable', cess_rate: '0.000', cess_amount: dec(cess), sort_order: 0 });
  const oldRule = (stored) => ({ total: Math.round(stored), ro: round2(Math.round(stored) - stored) });

  // paise in the stored total: rounded for print, exactly as before
  let { block, renderable } = await printed(legacy(1234.57, 222.22), [item(0)]);
  assert.deepStrictEqual([renderable.total_amount, renderable.round_off], [oldRule(1456.79).total, oldRule(1456.79).ro]);
  assert.deepStrictEqual(block.find(r => r[0] === 'Quoted Total'), ['Quoted Total', '1,457.00']);
  assert.deepStrictEqual(block.find(r => r[0] === 'Round Off'), ['Round Off', '+0.21']);
  // an old quote WITH cess, which it never counted: printed as it always was - no cess line appears
  ({ block, renderable } = await printed(legacy(1234.57, 222.22), [item(148.15)]));
  assert.strictEqual(renderable.total_amount, 1457, 'the old quote is not silently raised by its cess');
  assert.strictEqual(block.find(r => r[0] === 'Cess'), undefined);
  // a whole-rupee old quote: no round-off line, same total
  ({ block, renderable } = await printed(legacy(2700, 486), [item(0)]));
  assert.deepStrictEqual([renderable.total_amount, renderable.round_off], [3186, 0]);
  assert.strictEqual(block.find(r => r[0] === 'Round Off'), undefined);
});

test('RS11 only the proforma changed: the invoice rollup and the invoice PDF rule are untouched', () => {
  assert.match(ITEMS, /const rawTotal = taxable \+ gstAmt \+ cess;\s*const grandTotal = Math\.round\(rawTotal\);\s*const roundOff = round2\(grandTotal - rawTotal\);/);
  assert.match(INV_PDF, /round_off: round2\(\+data\.total_amount - \+data\.taxable_amount - \+data\.gst_amount\)/);
  assert.match(PF_ENTRY, /const quotedTotal = computeInvoiceRollups\(\)\.total_amount;/);
  assert.match(PF_ENTRY, /total_amount: quotedTotal,/);
  assert.equal(/total_amount: taxable \+ gst/.test(PF_ENTRY), false, 'the old sum is gone');
  const html = rd('proforma.html');
  assert.ok(html.includes('client/js/pages/proforma-entry.js?v=43') && html.includes('client/js/pages/proforma-pdf.js?v=43'));
  assert.ok(rd('proforma-list.html').includes('client/js/pages/proforma-pdf.js?v=43'));
});

test('RS12 known and left alone: the saved gst_amount can sit a paisa off the split - the quote follows the invoice', async () => {
  // A line's CGST and SGST are each rounded (calcGST), so on an odd-paisa line
  // they add up a paisa away from the line's GST. saveProforma has always
  // stored gst_amount as the sum of line GST; the invoice - and so the quote,
  // the PDF rows and a converted invoice - add up the split. Not a rounding
  // question, so not changed here; recorded so it is not mistaken for one.
  const s = SCEN.intrastate;
  const truth = invoiceTruth(s);
  const { doc, items } = await saveProformaFor(s);
  assert.strictEqual(Math.abs(round2(doc.gst_amount - round2(splitGst(doc)))), 0.01, 'the scenario has an odd-paisa line');
  assert.strictEqual(truth.gst_amount, round2(splitGst(doc)), 'the invoice counts the split');
  assert.strictEqual(doc.total_amount, truth.total_amount, 'the quote is still the invoice Grand Total');
  const { renderable } = await printed(storedRow(doc, truth), storedItems(items));
  assert.strictEqual(renderable.round_off, truth.round_off, 'and the PDF round-off is the screen round-off to the paisa');
});
