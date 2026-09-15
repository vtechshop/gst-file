// Transport Charge and Transport GST on a Proforma Invoice.
//
// A proforma now quotes delivery exactly the way the tax invoice bills it,
// and it does that by using the invoice's own machinery rather than a copy:
//
//   screen   the shared grid (invoice-items.js) opens its transport rows for
//            the proforma, so the rollup is literally the same function
//   save     saveProforma() adds the charge and its split tax through the
//            same two calls that rollup makes, and runs the invoice's own
//            validateInvoiceTransport() BEFORE a number is reserved
//   server   routes/documents.js checks the charge and DERIVES its tax with
//            the three functions routes/invoices.js uses
//   print    proforma-pdf.js backs the stored transport off the subtotal
//            with the invoice's own invoiceTransportParts()
//   convert  importing a proforma into an invoice carries the quoted charge
//
// Two things must hold throughout. A proforma quoted WITHOUT delivery - every
// proforma that exists today - must save, reload and print exactly as it did.
// And transport must be counted exactly once: into the base once, its tax into
// the tax once, and never mistaken for rounding.
//
// The calculation half always runs. The DB half is skipped unless
// STOCK_TEST_DATABASE_URL names a DISPOSABLE database that has had
// migration_proforma_transport_charge.sql applied.
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
const INV_ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');
const INV_LIST = rd('client', 'js', 'pages', 'invoice-list.js');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const GEN = rd('server', 'src', 'routes', 'generic.js');
const MIG_FILE = 'migration_proforma_transport_charge.sql';
const MIG = rd('server', 'db', 'migrations', MIG_FILE);

// Values from a sandbox live in another realm; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
// A function's source, from its declaration to its closing brace at column 0.
function fnSource(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at > -1, decl + ' not found');
  const rest = src.slice(at);
  return rest.slice(0, rest.search(/\r?\n\}/) + 2);
}

// ── A browser-shaped sandbox: the scripts proforma.html loads ─────────
const noop = () => {};
function mkEl(value) {
  return {
    value: value === undefined ? '' : value, textContent: '', innerHTML: '',
    disabled: false, checked: false, style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, setAttribute: noop
  };
}
const TOTALS_IDS = ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
  'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsAmountWords',
  'itemsTransportCharge', 'itemsTransportGst', 'itemsTransportRate',
  'itemsTransportNoteRow', 'itemsTransportNote'];

function load({ supply = 'intrastate', formPrefix = 'proforma', extra = [] } = {}) {
  const store = new Map();
  for (const id of [...TOTALS_IDS, 'pfSaveBtn', 'pfStatus', 'pfGstCategory']) store.set(id, mkEl());
  store.set('invSupply', mkEl(supply));
  const el = mkEl();
  const session = new Map();
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k)
    },
    document: {
      documentElement: el, body: el, head: el,
      getElementById: (id) => store.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl()
    },
    alert: noop, fetch: () => Promise.reject(new Error('no network in this test'))
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  for (const [name, src] of [['utils.js', UTILS], ['invoice-items.js', ITEMS],
    ['invoice-pdf.js', INV_PDF], ['proforma-pdf.js', PF_PDF], ['proforma-entry.js', PF_ENTRY], ...extra]) {
    vm.runInContext(src, sb, { filename: name });
  }
  // Only the edges of the page are stubbed - the network, the session, and the
  // form fields that are not what is under test. Every function that decides a
  // figure is the real one.
  vm.runInContext(`
    __toasts = []; __calls = []; __errors = [];
    __fields = { pfCustName: 'Transport Quote Co', pfDate: '2026-09-15' };
    showToast = function (m, k) { __toasts.push({ m: m, k: k }); };
    getCurrentUser = async function () { return { id: 'u1' }; };
    handleApiError = function (e) { __errors.push(String((e && e.message) || e)); };
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
  sb.__el = (id) => store.get(id);
  sb.__get = (expr) => vm.runInContext(expr, sb);
  sb.__setItems = (rows) => vm.runInContext('currentItems = ' + JSON.stringify(rows) + ';', sb);
  sb.__setTransport = (v) => { store.get('itemsTransportCharge').value = v; };
  return sb;
}

// One product line, taxed the way the grid taxes it.
function line({ rate = 18, taxable = 2700, supply = 'intrastate', name } = {}) {
  const inter = supply === 'interstate';
  const gst = taxable * rate / 100;
  return {
    rowId: 'r' + rate + '-' + taxable + '-' + (name || ''), product_id: 'p' + rate,
    product_name: name || ('Machine ' + rate + '%'), hsn_code: '84388090', unit: 'PCS',
    quantity: 1, rate: taxable, discount_percentage: 0, gst_percentage: rate,
    gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0,
    taxable_value: taxable, gst_amount: gst,
    igst: inter ? gst : 0, cgst: inter ? 0 : gst / 2, sgst: inter ? 0 : gst / 2,
    total_amount: taxable + gst, locked: false
  };
}
function rollup(transport, { supply = 'intrastate', formPrefix = 'proforma', items } = {}) {
  const sb = load({ supply, formPrefix });
  sb.__setItems(items || [line({ supply })]);
  if (transport !== undefined) sb.__setTransport(transport);
  return plain(sb.computeInvoiceRollups());
}
async function saveWith(transport, { supply = 'intrastate', items } = {}) {
  const sb = load({ supply });
  sb.__setItems(items || [line({ supply })]);
  if (transport !== undefined) sb.__setTransport(transport);
  await sb.saveProforma();
  const calls = plain(sb.__calls);
  const saveCall = calls.find(c => /\/documents\/proforma_invoice\/save/.test(c.url));
  return { calls, doc: saveCall ? saveCall.body.document : null, toasts: plain(sb.__toasts) };
}

// ═══ Screen: the same rollup the invoice uses ═════════════════════════

test('PT1 the proforma totals box carries the transport rows, in the invoice order', () => {
  assert.strictEqual(load({ formPrefix: 'proforma' }).__get('itemsTransportEnabled()'), true);
  assert.strictEqual(load({ formPrefix: 'invoice' }).__get('itemsTransportEnabled()'), true);
  assert.strictEqual(load({ formPrefix: 'challan' }).__get('itemsTransportEnabled()'), false,
    'no other form sharing the grid may grow the box');

  const order = ['Subtotal (Taxable Value)', 'GST Amount', 'Transport Charge', 'Transport GST',
    'Round Off', 'Grand Total', 'Amount in Words'].map(l => ITEMS.indexOf(`<span class="label">${l}</span>`));
  assert.ok(order.every(i => i > -1), 'every totals label is in the shared markup');
  assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order, 'in New Invoice order');
});

test('PT2 blank and zero leave the proforma exactly as it was without the feature', () => {
  const none = rollup(undefined);
  assert.strictEqual(none.transport_charge, null);
  assert.strictEqual(none.total_amount, 3186);
  const blank = rollup('');
  assert.deepStrictEqual(blank, none, 'a blank box is no transport');
  const zero = rollup('0');
  assert.strictEqual(zero.transport_charge, 0, 'zero is a real, stored decision - free delivery');
  assert.strictEqual(zero.taxable_amount, 2700);
  assert.strictEqual(zero.total_amount, 3186);
});

test('PT3 intra state: 2700 + 1000 at 18% gives 4366, split CGST/SGST', () => {
  const out = rollup('1000');
  assert.strictEqual(out.transport_charge, 1000);
  assert.strictEqual(out.transport_gst_amount, 180);
  assert.strictEqual(out.taxable_amount, 3700);
  assert.strictEqual(out.gst_amount, 666);
  assert.strictEqual(out.cgst, 333);
  assert.strictEqual(out.sgst, 333);
  assert.strictEqual(out.igst, 0);
  assert.strictEqual(out.total_amount, 4366);
});

test('PT4 inter state: the whole transport tax is IGST', () => {
  const out = rollup('1000', { supply: 'interstate' });
  assert.strictEqual(out.igst, 666);
  assert.strictEqual(out.cgst, 0);
  assert.strictEqual(out.sgst, 0);
  assert.strictEqual(out.total_amount, 4366);
});

test('PT5 the proforma figures ARE the New Invoice figures, case for case', () => {
  for (const supply of ['intrastate', 'interstate']) {
    for (const t of [undefined, '', '0', '1000', '1500', '1001', '1003', '999.99', '1000.40']) {
      const pf = rollup(t, { supply, formPrefix: 'proforma' });
      const inv = rollup(t, { supply, formPrefix: 'invoice' });
      assert.deepStrictEqual(pf, inv, `${supply} / transport ${JSON.stringify(t)}`);
    }
  }
});

test('PT6 round off stays the rounding, in both directions, and never absorbs transport', () => {
  const down = rollup('1001');          // 3701 + 666.18 = 4367.18
  assert.strictEqual(down.round_off, -0.18);
  assert.strictEqual(down.total_amount, 4367);
  const up = rollup('1003');            // 3703 + 666.54 = 4369.54
  assert.strictEqual(up.round_off, 0.46);
  assert.strictEqual(up.total_amount, 4370);
  for (const out of [down, up]) {
    assert.strictEqual(out.total_amount, Math.round(out.taxable_amount + out.gst_amount + out.cess_amount));
  }
});

test('PT7 transport follows the principal supply\'s rate, not a fixed 18%', () => {
  const out = rollup('1000', { items: [line({ rate: 5, taxable: 2000 })] });
  assert.strictEqual(out.transport_gst_amount, 50);
  assert.strictEqual(out.gst_amount, 150);
});

// ═══ Save: the payload the proforma route receives ════════════════════

test('PT8 a proforma saved without delivery sends exactly the figures it always did', async () => {
  const { doc } = await saveWith(undefined);
  assert.strictEqual(doc.transport_charge, null);
  assert.strictEqual(doc.taxable_amount, 2700);
  assert.strictEqual(doc.gst_amount, 486);
  assert.strictEqual(doc.cgst, 243);
  assert.strictEqual(doc.sgst, 243);
  assert.strictEqual(doc.igst, 0);
  assert.strictEqual(doc.total_amount, 3186);
});

test('PT9 a charge joins the saved totals once, as the invoice rollup adds it', async () => {
  const { doc } = await saveWith('1000');
  assert.strictEqual(doc.transport_charge, 1000);
  assert.strictEqual(doc.taxable_amount, 3700);
  assert.strictEqual(doc.gst_amount, 666);
  assert.strictEqual(doc.cgst, 333);
  assert.strictEqual(doc.sgst, 333);
  assert.strictEqual(doc.igst, 0);
  assert.strictEqual(doc.total_amount, 4366);
  assert.ok(!('transport_gst_amount' in doc), 'the tax is derived by the server, so it is never sent');

  const inv = rollup('1000', { formPrefix: 'invoice' });
  for (const f of ['taxable_amount', 'gst_amount', 'igst', 'cgst', 'sgst']) {
    assert.strictEqual(doc[f], inv[f], f + ' must match New Invoice');
  }
});

test('PT10 inter state saves the transport tax as IGST', async () => {
  const { doc } = await saveWith('1000', { supply: 'interstate' });
  assert.strictEqual(doc.igst, 666);
  assert.strictEqual(doc.cgst, 0);
  assert.strictEqual(doc.sgst, 0);
});

test('PT11 zero saves as 0 and moves no total', async () => {
  const { doc } = await saveWith('0');
  assert.strictEqual(doc.transport_charge, 0);
  assert.strictEqual(doc.total_amount, 3186);
});

test('PT12 a bad entry is refused BEFORE a proforma number is reserved', async () => {
  for (const [bad, wanted] of [['-1', /negative/i], ['abc', /number/i], ['Infinity', /number/i]]) {
    const { calls, toasts } = await saveWith(bad);
    assert.strictEqual(calls.length, 0, `"${bad}" must not reserve a number or save`);
    assert.match(toasts.at(-1).m, wanted);
  }
});

test('PT13 mixed rates block a charge - and only a charge', async () => {
  const items = [line({ rate: 18 }), line({ rate: 5, taxable: 1000 })];
  const blocked = await saveWith('1000', { items });
  assert.strictEqual(blocked.calls.length, 0, 'no number may be burned on a refused save');
  assert.match(blocked.toasts.at(-1).m, /more than one GST rate/);

  const fine = await saveWith(undefined, { items });
  assert.strictEqual(fine.calls.length, 2, 'without delivery, mixed rates save as they always have');
});

test('PT14 the save uses the invoice engine once, validates first, and never sends the tax', () => {
  const fn = fnSource(PF_ENTRY, 'async function saveProforma');
  assert.strictEqual((fn.match(/invoiceTransportCharge\(\)/g) || []).length, 1);
  assert.strictEqual((fn.match(/invoiceTransportTax\(/g) || []).length, 1);
  assert.strictEqual((fn.match(/transportCharge \|\| 0/g) || []).length, 1, 'into the base exactly once');
  assert.ok(fn.indexOf('validateInvoiceTransport()') > -1);
  assert.ok(fn.indexOf('validateInvoiceTransport()') < fn.indexOf('reserve-number'),
    'the charge is checked before a number is reserved');
  assert.equal(/transport_gst_amount/.test(fn), false, 'the derived tax is never sent');
});

// ═══ Load: reopening a saved proforma ═════════════════════════════════

async function loadWith(rec, rows, { supply = 'intrastate' } = {}) {
  const sb = load({ supply });
  vm.runInContext(`
    __rec = ${JSON.stringify(rec)}; __rows = ${JSON.stringify(rows)};
    readAll = async function () { return [[__rec], __rows]; };
    (function () { var c = {}; c.select = c.eq = c.order = function () { return c; };
      _supabase = { from: function () { return c; } }; })();
    populateGstCategorySelect = function () {}; restoreProformaExportFields = function () {};
    onProformaGstCategoryChange = function () {}; proformaStatus = function () { return 'draft'; };
    populateDistrictList = function () {}; onProformaShipSameChange = function () {};
    renderProformaValidityNote = function () {};
    loadItemsIntoTable = function (r) { currentItems = r.map(function (x) { return Object.assign({}, x); }); };
  `, sb);
  await sb.loadProformaForEdit(rec.id);
  return sb;
}
const savedRec = (charge) => ({ id: 'pf1', document_number: 'PI-00001', document_date: '2026-09-15',
  customer_name: 'Transport Quote Co', supply_type: 'intrastate', status: 'draft',
  transport_charge: charge, transport_gst_amount: charge === null ? null : '180.00' });

test('PT15 reopening restores the charge after the lines, and the totals it was saved with', async () => {
  const withCharge = await loadWith(savedRec('1000.00'), [line()]);
  assert.strictEqual(withCharge.__el('itemsTransportCharge').value, '1000',
    'the raw number, which an <input type="number"> accepts');
  assert.strictEqual(plain(withCharge.computeInvoiceRollups()).total_amount, 4366);

  const legacy = await loadWith(savedRec(null), [line()]);
  assert.strictEqual(legacy.__el('itemsTransportCharge').value, '', 'a proforma saved before this: empty box');
  assert.strictEqual(plain(legacy.computeInvoiceRollups()).total_amount, 3186);

  const fn = fnSource(PF_ENTRY, 'async function loadProformaForEdit');
  assert.ok(fn.indexOf('restoreInvoiceTransport(rec)') > fn.indexOf('loadItemsIntoTable(rows)'),
    'restored AFTER the lines, exactly as Invoice Entry does');
});

// ═══ Print: the totals block on the PDF ═══════════════════════════════

// A recording stand-in for jsPDF. Every coordinate below is the one the real
// layout code computed; only the drawing is not done.
function recorder() {
  const texts = [];
  let pages = 1;
  class FakeDoc {
    constructor() {
      this.internal = { pageSize: { width: 297, height: 210 }, getNumberOfPages: () => pages };
      this.lastAutoTable = { finalY: 0 };
    }
    text(s, x, y, o) {
      texts.push({ s: Array.isArray(s) ? s.join('\n') : String(s), x, y, page: pages, align: o && o.align });
      return this;
    }
    splitTextToSize(s) { return String(s).split('\n'); }
    setFontSize() { return this; } setFont() { return this; } setTextColor() { return this; }
    setDrawColor() { return this; } setFillColor() { return this; } setLineWidth() { return this; }
    rect() { return this; } line() { return this; } addImage() { return this; }
    addPage() { pages++; return this; } setPage() { return this; }
    getNumberOfPages() { return pages; } getTextWidth(s) { return String(s).length * 1.8; }
    autoTable(o) { this.lastAutoTable = { finalY: (o.startY || 0) + 8 + (o.body || []).length * 8 }; return this; }
    save() {}
  }
  return { FakeDoc, texts };
}
async function printed(row, items) {
  const sb = load();
  const { FakeDoc, texts } = recorder();
  sb.jspdf = { jsPDF: FakeDoc };
  vm.runInContext(`
    getCachedProfile = function () { return { business_name: 'Scratch Co', header_color: '#00796b', state: 'Tamil Nadu' }; };
    imageUrlToDataUrl = async function () { return null; };
    inkBoundsOf = async function () { return null; };
    if (typeof hexToRgb !== 'function') hexToRgb = function () { return [0, 121, 107]; };
  `, sb);
  await sb.buildProformaPDFDoc(row, items);
  return { sb, texts };
}
// Landscape A4: R = 297 - 14, and the totals box starts 80mm left of it.
const R_X = 283, BOX_X = 203;
function totalsBlock(texts) {
  return texts.filter(t => t.x === BOX_X).map(t => {
    const v = texts.find(u => u.x === R_X && u.y === t.y && u.page === t.page && /^Rs\./.test(u.s));
    return { label: t.s, value: v ? v.s : null, y: t.y, page: t.page };
  });
}
// A stored proforma row, as saveProforma writes it and the server derives it.
function pfRow(charge, { supply = 'intrastate' } = {}) {
  const inter = supply === 'interstate';
  const tg = charge === null ? null : Math.round(charge * 18) / 100;
  const tax = 2700 + (charge || 0);
  const gst = 486 + (tg || 0);
  return {
    id: 'pf1', document_number: 'PI-00001', document_date: '2026-09-15', customer_name: 'Transport Quote Co',
    supply_type: supply, taxable_amount: tax, gst_percentage: 18, gst_amount: gst,
    igst: inter ? gst : 0, cgst: inter ? 0 : gst / 2, sgst: inter ? 0 : gst / 2,
    total_amount: tax + gst, transport_charge: charge, transport_gst_amount: tg, status: 'draft'
  };
}
const pfItems = (supply = 'intrastate', n = 1) => Array.from({ length: n }, (_, i) =>
  ({ ...line({ supply, name: 'Machine ' + (i + 1) }), sort_order: i }));

test('PT16 the renderable carries transport, and NULL stays null', () => {
  const sb = load();
  const r = (c, g) => plain(sb.proformaToRenderable({ ...pfRow(null), transport_charge: c, transport_gst_amount: g }, []));
  assert.strictEqual(r(null, null).transport_charge, null);
  assert.strictEqual(r(null, null).transport_gst_amount, null);
  assert.strictEqual(r('1000.00', '180.00').transport_charge, 1000);
  assert.strictEqual(r('1000.00', '180.00').transport_gst_amount, 180);
  assert.strictEqual(r(0, 0).transport_charge, 0);
});

test('PT17 intra state prints goods, their total, then delivery, then the quoted total', async () => {
  const { sb, texts } = await printed(pfRow(1000), pfItems());
  const f = (n) => 'Rs.' + sb.formatNum(n);
  assert.deepStrictEqual(totalsBlock(texts).map(r => [r.label, r.value]), [
    ['Subtotal', f(2700)], ['CGST', f(243)], ['SGST', f(243)],
    ['Machine / Product Total', f(3186)],
    ['Transport Charge', f(1000)], ['Transport GST', f(180)],
    ['Quoted Total', f(4366)]
  ]);
  // The goods total is the tax invoice's own helper, not a second copy of it.
  assert.match(PF_PDF, /\['Machine \/ Product Total', formatNum\(invoiceMachineTotal\(inv, tp\)\)\]/);
});

test('PT18 inter state prints the goods tax as IGST', async () => {
  const { sb, texts } = await printed(pfRow(1000, { supply: 'interstate' }), pfItems('interstate'));
  const f = (n) => 'Rs.' + sb.formatNum(n);
  assert.deepStrictEqual(totalsBlock(texts).map(r => [r.label, r.value]), [
    ['Subtotal', f(2700)], ['IGST', f(486)],
    ['Machine / Product Total', f(3186)],
    ['Transport Charge', f(1000)], ['Transport GST', f(180)],
    ['Quoted Total', f(4366)]
  ]);
});

test('PT19 a proforma quoted without delivery prints exactly the block it always did', async () => {
  const row = pfRow(null);
  const { sb, texts } = await printed(row, pfItems());
  const f = (n) => 'Rs.' + sb.formatNum(n);
  // The pre-transport rule, restated: stored subtotal, then each tax over zero.
  const expected = [['Subtotal', f(row.taxable_amount)]];
  if (row.cgst > 0) expected.push(['CGST', f(row.cgst)]);
  if (row.sgst > 0) expected.push(['SGST', f(row.sgst)]);
  if (row.igst > 0) expected.push(['IGST', f(row.igst)]);
  expected.push(['Quoted Total', f(3186)]);
  assert.deepStrictEqual(totalsBlock(texts).map(r => [r.label, r.value]), expected);
  // Matched on the two row labels exactly: the word alone also appears in
  // ordinary text, such as this fixture's customer name.
  assert.equal(texts.some(t => t.s === 'Transport Charge' || t.s === 'Transport GST'
    || t.s === 'Machine / Product Total'), false,
    'no transport line - and no goods-total line - on an old proforma, exactly as on the invoice');
});

test('PT20 the printed round off is the rounding in both directions, and the words follow the total', async () => {
  for (const [charge, roundOff, total] of [[1001, '-0.18', 4367], [1003, '+0.46', 4370]]) {
    const { sb, texts } = await printed(pfRow(charge), pfItems());
    const rows = totalsBlock(texts);
    const labels = rows.map(r => r.label);
    assert.deepStrictEqual(labels.slice(-3), ['Transport GST', 'Round Off', 'Quoted Total']);
    assert.strictEqual(rows.find(r => r.label === 'Round Off').value, 'Rs.' + roundOff);
    assert.strictEqual(rows.find(r => r.label === 'Quoted Total').value, 'Rs.' + sb.formatNum(total));
    // The column adds up two ways, as the tax invoice's does: line by line
    // (goods, their tax, delivery, its tax, rounding), and down the block
    // (goods total, delivery, its tax, rounding). The goods total is itself a
    // subtotal of the lines above it, so it is left out of the first sum.
    const n = (s) => Number(s.replace(/^Rs\./, '').replace(/,/g, ''));
    const r2 = (x) => Math.round(x * 100) / 100;
    const lines = rows.filter(r => r.label !== 'Quoted Total' && r.label !== 'Machine / Product Total');
    assert.strictEqual(r2(lines.reduce((a, r) => a + n(r.value), 0)), total,
      'the printed lines must add up to the total');
    const v = (label) => n(rows.find(r => r.label === label).value);
    assert.strictEqual(r2(v('Machine / Product Total') + v('Transport Charge') + v('Transport GST') + v('Round Off')),
      total, 'goods total + delivery + its tax + rounding must be the total');
    assert.ok(texts.some(t => t.s === sb.numberToWordsINR(total)), 'words from the same total');
  }
});

test('PT21 layout: rows never overlap, the signature sits below the total, pagination holds', async () => {
  for (const charge of [null, 1000]) {
    for (let n = 1; n <= 14; n++) {
      const { texts } = await printed(pfRow(charge), pfItems('intrastate', n));
      const rows = totalsBlock(texts);
      const quoted = rows.find(r => r.label === 'Quoted Total');
      const body = rows.filter(r => r !== quoted);
      const where = `${charge === null ? 'no transport' : 'transport'}, ${n} line(s)`;
      assert.ok(body.every(r => r.page === quoted.page), where + ': the totals stay on one page');
      for (let i = 1; i < body.length; i++) {
        assert.strictEqual(Math.round((body[i].y - body[i - 1].y) * 100) / 100, 5.5, where + ': rows 5.5mm apart');
      }
      assert.ok(body[0].y + body.length * 5.5 + 60 <= 210 - 12, where + ': the page-break guard held');
      assert.ok(quoted.y > body.at(-1).y, where + ': the total is below every row');
      const sig = texts.find(t => t.s === 'Authorized Signatory');
      assert.ok(sig && sig.page === quoted.page, where + ': the signature is on the page of the total');
      assert.ok(sig.y > quoted.y, where + ': the signature is below the total');
      assert.ok(sig.y < 210 - 12 - 10, where + ': the signature clears the footer rule');
    }
  }
});

// ═══ Convert: proforma into a tax invoice ═════════════════════════════

test('PT22 importing a proforma carries the quoted charge - and only the charge', () => {
  const fn = fnSource(PF_LIST, 'function importProformaIntoInvoice');
  assert.match(fn, /transport_charge: r\.transport_charge,/);
  assert.equal(/transport_gst_amount/.test(fn), false, 'the invoice derives its own tax');
});

test('PT22b a converted proforma bills the same transport charge AND the same transport GST', () => {
  for (const supply of ['intrastate', 'interstate']) {
    // Proforma List: the stored row and its items, then Import into Invoice.
    const list = load({ supply, extra: [['proforma-list.js', PF_LIST]] });
    const row = pfRow(1000, { supply });
    vm.runInContext('proformaRows = ' + JSON.stringify([row]) + ';'
      + ' proformaItemsByParent = ' + JSON.stringify({ pf1: pfItems(supply) }) + ';', list);
    list.importProformaIntoInvoice('pf1');
    const draft = JSON.parse(list.sessionStorage.getItem('invoice_duplicate_draft'));
    assert.strictEqual(Number(draft.transport_charge), 1000, supply + ': the quoted charge travels');

    // New Invoice: the draft's lines, then the charge restored exactly as the
    // duplicate path restores it. Its tax is derived there by the same rule,
    // so it must land on the figure the proforma stored.
    const inv = load({ supply: draft.supply_type, formPrefix: 'invoice' });
    inv.__setItems(draft.items);
    inv.restoreInvoiceTransport(draft);
    const out = plain(inv.computeInvoiceRollups());
    assert.strictEqual(out.transport_charge, 1000);
    assert.strictEqual(out.transport_gst_amount, row.transport_gst_amount,
      supply + ': the invoice arrives at the same Transport GST the proforma stored');
    assert.strictEqual(out.taxable_amount, row.taxable_amount);
    assert.strictEqual(out.gst_amount, row.gst_amount);
    assert.strictEqual(out.total_amount, Math.round(row.total_amount), supply + ': billed total = quoted total');
  }
});

test('PT23 the invoice restores it after the lines, and an invoice Duplicate is unchanged', () => {
  const fn = fnSource(INV_ENTRY, 'async function loadInvoiceDuplicateDraft');
  const lines = fn.indexOf('loadItemsIntoTable(draft.items)');
  const restore = fn.indexOf('restoreInvoiceTransport(draft)');
  assert.ok(lines > -1 && restore > lines, 'restored AFTER the lines are in');
  // An invoice's own Duplicate never carried a charge, so for it the restore
  // leaves an empty box - exactly what the duplicate showed before.
  assert.equal(/transport_charge/.test(fnSource(INV_LIST, 'async function duplicateInvoiceFromList')), false);
});

// ═══ Server and schema, by inspection ═════════════════════════════════

test('PT24 the save route derives the tax with the invoice\'s own three rules, for proforma only', () => {
  assert.strictEqual((DOCS.match(/transport: true/g) || []).length, 1, 'exactly one document type carries it');
  const entry = DOCS.slice(DOCS.indexOf('proforma_invoice: {'), DOCS.indexOf('purchase_order:  {'));
  assert.match(entry, /transport: true/, 'and that type is the proforma');
  assert.match(DOCS, /validateTransportCharge\(document\.transport_charge\)/);
  assert.match(DOCS, /transportGstAmount\(check\.value, principalGstRate\(items\)\)/);
  assert.ok(DOCS.indexOf("allowed.push('transport_gst_amount')") > DOCS.indexOf('!immutable.has(c)'),
    'the derived tax is written past the immutable filter - this route is its one writer');

  const cfg = GEN.slice(GEN.indexOf('  proforma_invoices: {'), GEN.indexOf('  proforma_invoice_items: {'));
  assert.match(cfg, /'transport_charge','transport_gst_amount'/);
  assert.match(cfg, /immutable: \['transport_gst_amount'\]/);
});

test('PT25 the migration is additive, re-runnable, runner-managed, and touches only proforma_invoices', () => {
  const order = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json')).order;
  assert.deepStrictEqual(order.slice(-2), ['migration_purchase_notes.sql', MIG_FILE]);

  const code = MIG.replace(/--[^\n]*/g, '');
  for (const kw of ['UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'INSERT']) {
    assert.equal(new RegExp('\\b' + kw + '\\b', 'i').test(code), false, 'no ' + kw);
  }
  const altered = [...code.matchAll(/ALTER TABLE\s+([a-z_]+)/gi)].map(m => m[1]);
  assert.ok(altered.length > 0 && altered.every(t => t === 'proforma_invoices'), 'only proforma_invoices');
  assert.match(code, /ADD COLUMN IF NOT EXISTS transport_charge NUMERIC\(14,2\)/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS transport_gst_amount NUMERIC\(14,2\)/);
  assert.strictEqual((code.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) || []).length, 2,
    'each CHECK is added only when absent');
  const { managesOwnTransaction } = require('../src/db/migrator');
  assert.strictEqual(managesOwnTransaction(MIG), false, 'the runner wraps it, so the change and its record are atomic');
});

// ═══════════════════════════════════════════════════════════════════════
//  DB-backed half: persistence, edit, clear, derivation, one writer
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('proforma transport persistence (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-transport-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function startServer(port) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: SCRATCH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', d => { out += d; if (out.includes('listening on')) { clearTimeout(done); resolve(child); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

let server, base, db, USER_A, USER_B, TOKEN_A, TOKEN_B;
async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const msg = r => (r && r.body && r.body.error && r.body.error.message) || JSON.stringify(r && r.body);

let seq = 0;
const dbLine = (rate = 18, taxable = 2700) => ({
  product_name: 'Machine ' + rate + '%', quantity: 1, rate: taxable, taxable_value: taxable,
  gst_percentage: rate, gst_amount: taxable * rate / 100, igst: 0,
  cgst: taxable * rate / 200, sgst: taxable * rate / 200,
  total_amount: taxable + taxable * rate / 100, gst_treatment: 'taxable', sort_order: 0
});
// What saveProforma sends. `charge === undefined` omits the key altogether -
// the shape of every save made before this feature existed.
function pdoc(charge, extra = {}) {
  const tGst = charge ? charge * 0.18 : 0;
  const taxable = 2700 + (charge || 0);
  const gst = 486 + tGst;
  const d = {
    document_number: 'PT-' + (++seq), document_date: '2026-09-15', customer_name: 'Transport Quote Co',
    status: 'draft', supply_type: 'intrastate', taxable_amount: taxable, gst_percentage: 18,
    gst_amount: gst, igst: 0, cgst: gst / 2, sgst: gst / 2, total_amount: taxable + gst, ...extra
  };
  if (charge !== undefined) d.transport_charge = charge;
  return d;
}
const save = (body, token = TOKEN_A) => api('POST', '/documents/proforma_invoice/save', { token, body });
const stored = async (id) => (await db.query(
  `SELECT transport_charge, transport_gst_amount, taxable_amount, gst_amount, total_amount
     FROM proforma_invoices WHERE id = $1`, [id])).rows[0];
const n = (v) => (v === null ? null : Number(v));
const rowCount = async () => (await db.query('SELECT count(*)::int AS c FROM proforma_invoices')).rows[0].c;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'proforma_invoices' AND column_name IN ('transport_charge', 'transport_gst_amount')`)).rows;
  if (cols.length !== 2) {
    throw new Error('the scratch database lacks proforma_invoices.transport_*: apply ' + MIG_FILE
      + ' to it first (npm run migrate with DATABASE_URL set to the scratch database)');
  }
  await db.query('TRUNCATE users CASCADE');
  const mkUser = async (email) => {
    const id = (await db.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email])).rows[0].id;
    await db.query(`INSERT INTO profiles (id, name) VALUES ($1, 'Scratch Co')`, [id]);
    return id;
  };
  USER_A = await mkUser('pf-transport-a@scratch.test');
  USER_B = await mkUser('pf-transport-b@scratch.test');
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}/api`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('PD1 the charge saves, and its tax is DERIVED - a client-supplied tax is ignored', async () => {
  const r = await save({ document: pdoc(1000, { transport_gst_amount: 9999 }), items: [dbLine()] });
  assert.strictEqual(r.status, 200, msg(r));
  const s = await stored(r.body.document.id);
  assert.strictEqual(n(s.transport_charge), 1000);
  assert.strictEqual(n(s.transport_gst_amount), 180, 'derived from the charge and the principal rate');
  assert.strictEqual(n(s.taxable_amount), 3700);
  assert.strictEqual(n(s.total_amount), 4366);
});

test('PD2 blank stores NULL, zero stores 0, and an old-shaped save stores NULL', async () => {
  const blank = await save({ document: pdoc(null), items: [dbLine()] });
  assert.strictEqual(blank.status, 200, msg(blank));
  let s = await stored(blank.body.document.id);
  assert.strictEqual(s.transport_charge, null);
  assert.strictEqual(s.transport_gst_amount, null);
  assert.strictEqual(n(s.total_amount), 3186, 'no transport: the total it always had');

  const zero = await save({ document: pdoc(0), items: [dbLine()] });
  s = await stored(zero.body.document.id);
  assert.strictEqual(n(s.transport_charge), 0, 'free delivery is a stored decision, not NULL');
  assert.strictEqual(n(s.transport_gst_amount), 0);

  const legacy = await save({ document: pdoc(undefined), items: [dbLine()] });
  assert.strictEqual(legacy.status, 200, msg(legacy));
  s = await stored(legacy.body.document.id);
  assert.strictEqual(s.transport_charge, null, 'a payload without the key is untouched by the feature');
  assert.strictEqual(n(s.total_amount), 3186);
});

test('PD3 a malformed charge is refused, and nothing is saved', async () => {
  for (const [bad, wanted] of [[-1, /negative/i], ['abc', /number/i]]) {
    const before = await rowCount();
    const r = await save({ document: pdoc(undefined, { transport_charge: bad }), items: [dbLine()] });
    assert.strictEqual(r.status, 400, msg(r));
    assert.match(msg(r), wanted);
    assert.strictEqual(await rowCount(), before, 'no row may be written');
  }
});

test('PD4 mixed rates refuse a charge, save without one, and a 5% supply taxes delivery at 5%', async () => {
  const mixed = [dbLine(18), { ...dbLine(5, 1000), sort_order: 1 }];
  const before = await rowCount();
  const refused = await save({ document: pdoc(1000), items: mixed });
  assert.strictEqual(refused.status, 400, msg(refused));
  assert.match(msg(refused), /principal supply/);
  assert.strictEqual(await rowCount(), before);

  const noCharge = await save({ document: pdoc(undefined), items: mixed });
  assert.strictEqual(noCharge.status, 200, msg(noCharge));

  const five = await save({ document: pdoc(1000), items: [dbLine(5, 2000)] });
  assert.strictEqual(five.status, 200, msg(five));
  assert.strictEqual(n((await stored(five.body.document.id)).transport_gst_amount), 50);
});

test('PD5 edit replaces the charge, clearing it stores NULL, and an edit that omits it keeps it', async () => {
  const first = await save({ document: pdoc(1000), items: [dbLine()] });
  const id = first.body.document.id;
  const number = first.body.document.document_number;

  const changed = await save({ editId: id, document: { ...pdoc(500), document_number: number }, items: [dbLine()] });
  assert.strictEqual(changed.status, 200, msg(changed));
  let s = await stored(id);
  assert.strictEqual(n(s.transport_charge), 500);
  assert.strictEqual(n(s.transport_gst_amount), 90);

  const untouched = await save({ editId: id, document: { ...pdoc(undefined), document_number: number, notes: 'edited' }, items: [dbLine()] });
  assert.strictEqual(untouched.status, 200, msg(untouched));
  s = await stored(id);
  assert.strictEqual(n(s.transport_charge), 500, 'absent is not the same as cleared');

  const cleared = await save({ editId: id, document: { ...pdoc(null), document_number: number }, items: [dbLine()] });
  assert.strictEqual(cleared.status, 200, msg(cleared));
  s = await stored(id);
  assert.strictEqual(s.transport_charge, null);
  assert.strictEqual(s.transport_gst_amount, null);
  assert.strictEqual(n(s.total_amount), 3186);
});

test('PD6 the reopening form reads both fields back through the API', async () => {
  const r = await save({ document: pdoc(1000), items: [dbLine()] });
  const read = await api('GET', '/proforma_invoices?eq_id=' + r.body.document.id, { token: TOKEN_A });
  assert.strictEqual(read.status, 200, msg(read));
  assert.strictEqual(n(read.body[0].transport_charge), 1000);
  assert.strictEqual(n(read.body[0].transport_gst_amount), 180);
});

test('PD7 the derived tax has one writer - the generic route refuses it outright', async () => {
  const r = await save({ document: pdoc(1000), items: [dbLine()] });
  const id = r.body.document.id;
  const patched = await api('PATCH', '/proforma_invoices?eq_id=' + id,
    { token: TOKEN_A, body: { transport_gst_amount: 9999 } });
  assert.strictEqual(patched.status, 400, msg(patched));
  assert.match(msg(patched), /transport_gst_amount/);
  assert.strictEqual(n((await stored(id)).transport_gst_amount), 180, 'the derived tax stands');
});

test('PD8 one tenant can neither read nor change another\'s charge', async () => {
  const mine = await save({ document: pdoc(1000), items: [dbLine()] });
  const id = mine.body.document.id;
  const read = await api('GET', '/proforma_invoices?eq_id=' + id, { token: TOKEN_B });
  assert.deepStrictEqual(read.body, [], 'another tenant reads nothing');
  const edit = await save({ editId: id, document: { ...pdoc(5), document_number: 'PT-B-' + seq }, items: [dbLine()] }, TOKEN_B);
  assert.strictEqual(edit.status, 404, msg(edit));
  assert.strictEqual(n((await stored(id)).transport_charge), 1000, 'the owner\'s charge is untouched');
});

test('PD9 the migration re-runs cleanly on a database that already has it', async () => {
  await db.query('BEGIN');
  try {
    await db.query(MIG);
  } finally {
    await db.query('ROLLBACK');
  }
});
