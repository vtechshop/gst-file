// Export invoices billed in a foreign currency.
//
// The rule the whole feature turns on:
//
//   the fx_* columns hold what the BUYER was billed
//   the rupee columns hold what the RETURN reports - foreign x exchange rate
//   neither is ever derived from the other twice, and neither overwrites it
//
// A domestic invoice is not touched by any of it: no currency is asked for,
// no fx_* key is sent, and every figure is the one this page has always
// written. These run the real grid, the real entry module and the real PDF.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');
const PDF_SRC = rd('client', 'js', 'pages', 'invoice-pdf.js');
const HTML = rd('invoice.html');
const MIG = rd('server', 'db', 'migrations', 'migration_invoice_export_currency.sql');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const GENERIC = rd('server', 'src', 'routes', 'generic.js');

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

// ── the page, in miniature ──────────────────────────────────────────────
const PAGE_IDS = ['itemsTableBody', 'itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
  'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsTransportGst',
  'itemsTransportRate', 'itemsTransportNoteRow', 'itemsTransportNote', 'itemsAmountWords',
  'itemsTransportCharge', 'transportToggle',
  'invFxSummary', 'invFxTotalLabel', 'invFxTotal', 'invFxRate', 'invFxInr',
  'exportToggle', 'exportToggleLabel', 'exportFields', 'invTypeDomestic', 'invTypeExport',
  'invCurrency', 'invCurrencyOther', 'invCurrencyOtherWrap', 'invExchangeRate',
  'invExchangeRateHint', 'invDestinationCountry', 'invExportType', 'invPortCode',
  'invShippingBillNo', 'invShippingBillDate', 'invExportOf', 'invSezRecipient', 'invDifferential65'];

function load() {
  const noop = () => {};
  const els = {};
  const mk = id => ({ id, value: '', textContent: '', innerHTML: '', checked: false,
    classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); }, toggle(c, on) { on === undefined ? (this._c.has(c) ? this._c.delete(c) : this._c.add(c)) : (on ? this._c.add(c) : this._c.delete(c)); } },
    setAttribute: noop, getAttribute: () => null, addEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [], focus: noop, select: noop });
  PAGE_IDS.forEach(id => { els[id] = mk(id); });
  const el = id => els[id] || (els[id] = mk(id));
  const sent = [];
  const toasts = [];

  const sb = {
    console: { log: noop, warn: noop, error: noop },
    Math, Date, JSON, Number, String, Array, Object, RegExp, Intl, Promise, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, URLSearchParams, setTimeout, clearTimeout,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x' },
    localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mk('_new'), body: mk('_body') },
    showToast: (m, t) => toasts.push({ message: m, type: t }),
    handleApiError: noop,
    apiFetch: async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { invoiceId: 'inv1' }; },
    loadProductsList: async () => [], findProductByName: () => null,
    getCurrentUser: async () => ({ id: 'u1' }), requireAuth: async () => null,
    renderInvPaymentPreview: noop, renderPaymentPreview: noop, uppercaseKeepCursor: noop,
    INVOICE_PAYMENT_PREVIEW: {}, formatDate: v => String(v || ''),
    _supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) }
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(ITEMS, sb, { filename: 'invoice-items.js' });
  vm.runInContext(ENTRY, sb, { filename: 'invoice-entry.js' });
  // utils.js brings the real showToast, which wants a live DOM - so the
  // recorder goes in after the sources, not before them.
  sb.__toasts = toasts;
  vm.runInContext('showToast = function (m, t) { __toasts.push({ message: m, type: t }); };', sb);

  const run = code => vm.runInContext(code, sb);
  const api = {
    sb, els, sent, toasts, run,
    // Lines as the grid holds them: the figures are in whatever currency the
    // invoice is billed in.
    setLines: lines => run('currentItems = ' + JSON.stringify(lines) + '; recalcAllRows();'),
    state: () => JSON.parse(run('JSON.stringify(currentItems)')),
    rollups: () => JSON.parse(run('JSON.stringify(computeInvoiceRollups())')),
    inr: () => JSON.parse(run('JSON.stringify(invoiceHeaderInInr())')),
    grid: () => els.itemsTableBody.innerHTML,
    summary: () => ({ hidden: els.invFxSummary.classList.contains('d-none'),
      label: els.invFxTotalLabel.textContent, total: els.invFxTotal.textContent,
      rate: els.invFxRate.textContent, inr: els.invFxInr.textContent,
      words: els.itemsAmountWords.textContent }),
    // Operate the page the way a person does.
    chooseExport: (code, rate) => {
      run("setInvoiceType('export')");
      els.invCurrency.value = code;
      els.invExchangeRate.value = String(rate);
      run('onInvoiceCurrencyChange(); onInvoiceExchangeRateInput();');
    },
    chooseDomestic: () => run("setInvoiceType('domestic')"),
    save: async (headerBase = {}) => {
      await run('saveInvoiceWithItems("b2b", ' + JSON.stringify(headerBase) + ', null, "u1")');
      return sent[sent.length - 1] ? sent[sent.length - 1].body : null;
    },
    validate: () => run('validateInvoiceCurrency()'),
    restore: inv => run('restoreExportFields(' + JSON.stringify(inv) + ')')
  };
  return api;
}

// Two lines, one taxed and one not, so a conversion that drops tax is caught.
const LINES = [
  { rowId: 'r1', product_id: null, product_name: 'Idli Steamer 12 Tray', hsn_code: '84198190',
    unit: 'PCS', quantity: 2, rate: 1000, discount_percentage: 0, gst_percentage: 18,
    gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0 },
  { rowId: 'r2', product_id: null, product_name: 'Wet Grinder 10L', hsn_code: '85094090',
    unit: 'NOS', quantity: 1, rate: 800, discount_percentage: 0, gst_percentage: 18,
    gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0 }
];
const r2 = n => Math.round(n * 100) / 100;

// ══════════════════════════════════════════════════════════════════════
//  The grid and the totals
// ══════════════════════════════════════════════════════════════════════

test('EX1 a domestic invoice is rupees, start to finish', async () => {
  const g = load();
  g.setLines(LINES);
  assert.ok(g.grid().includes('₹'), 'the grid shows rupees');
  assert.ok(!g.grid().includes('$'));
  assert.ok(g.summary().hidden, 'no second currency is shown');

  const roll = g.rollups();
  assert.deepStrictEqual([roll.taxable_amount, roll.gst_amount, roll.total_amount], [2800, 504, 3304]);

  const body = await g.save({ invoice_number: 'D-1' });
  assert.strictEqual(body.header.total_amount, 3304);
  for (const key of ['currency_code', 'exchange_rate', 'fx_taxable_amount', 'fx_gst_amount', 'fx_total_amount']) {
    assert.ok(!(key in body.header), 'a domestic invoice sends no ' + key);
  }
  for (const item of body.items) {
    for (const key of ['fx_rate', 'fx_taxable_value', 'fx_total_amount']) {
      assert.ok(!(key in item), 'a domestic line sends no ' + key);
    }
  }
});

test('EX1b the Rate column is captioned in the currency the column is in', () => {
  // Reported from the page: the cells changed to dollars but the heading
  // still read "Rate (Rs.)", because the heading is written once when the
  // section is built and the cells are written on every render.
  const g = load();
  g.run("renderItemsSectionShell('itemsSection');");
  const header = () => g.els.itemsRateHeader.textContent;
  assert.strictEqual(header(), 'Rate (₹)', 'a rupee invoice says rupees');

  g.setLines(LINES);
  g.chooseExport('USD', 83.25);
  assert.strictEqual(header(), 'Rate ($)', 'an export in dollars says dollars');
  assert.ok(g.grid().includes('$'), 'and so do the figures under it');

  g.chooseExport('EUR', 90.5);
  assert.strictEqual(header(), 'Rate (€)');

  g.chooseDomestic();
  assert.strictEqual(header(), 'Rate (₹)', 'and it goes back');
  // The two captions that are NOT the invoice's currency stay put: Quick
  // Add's Selling Price is the Product Master's rupee price, and Amount
  // Received is the rupee ledger.
  assert.match(ITEMS, /<label for="qapRate">Selling Price \(&#8377;\)<\/label>/);
  assert.match(rd('invoice.html'), /Amount Received \(&#8377;\)/);
});

test('EX2 an export in USD bills the buyer in USD and reports rupees', async () => {
  const g = load();
  g.setLines(LINES);
  g.chooseExport('USD', 83.25);

  // What the buyer sees
  assert.ok(g.grid().includes('$'), 'the grid shows the buyer\'s currency');
  assert.ok(!g.grid().includes('₹'));
  const roll = g.rollups();
  assert.deepStrictEqual([roll.taxable_amount, roll.gst_amount, roll.total_amount], [2800, 504, 3304]);

  // What the return reports
  const inr = g.inr();
  assert.strictEqual(inr.taxable_amount, r2(2800 * 83.25));
  assert.strictEqual(inr.gst_amount, r2(504 * 83.25));
  assert.strictEqual(inr.total_amount, Math.round(2800 * 83.25 + 504 * 83.25));

  const s = g.summary();
  assert.strictEqual(s.hidden, false);
  assert.strictEqual(s.label, 'Invoice Total (USD)');
  assert.strictEqual(s.total, '$3,304.00');
  assert.strictEqual(s.rate, '1 USD = ₹83.25');
  assert.strictEqual(s.inr, '₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(inr.total_amount));
  assert.match(s.words, /Rupees|Lakh|Thousand/, 'the words are the rupee amount, because they say Rupees');

  const body = await g.save({ invoice_number: 'EXP-1' });
  assert.strictEqual(body.header.currency_code, 'USD');
  assert.strictEqual(body.header.exchange_rate, 83.25);
  assert.deepStrictEqual([body.header.fx_taxable_amount, body.header.fx_gst_amount, body.header.fx_total_amount],
    [2800, 504, 3304], 'the fx_* columns are what the buyer was billed');
  assert.strictEqual(body.header.taxable_amount, inr.taxable_amount, 'the rupee columns are the converted value');
  assert.strictEqual(body.header.total_amount, inr.total_amount);
});

test('EX3 each line carries both its figures, and the rupee header is the sum of them', async () => {
  const g = load();
  g.setLines(LINES);
  g.chooseExport('USD', 83.25);
  const body = await g.save({ invoice_number: 'EXP-2' });

  assert.deepStrictEqual(body.items.map(i => i.fx_rate), [1000, 800]);
  assert.deepStrictEqual(body.items.map(i => i.fx_taxable_value), [2000, 800]);
  assert.deepStrictEqual(body.items.map(i => i.rate), [r2(1000 * 83.25), r2(800 * 83.25)]);
  assert.deepStrictEqual(body.items.map(i => i.taxable_value), [r2(2000 * 83.25), r2(800 * 83.25)]);

  // Each line adds up in rupees...
  for (const i of body.items) {
    assert.strictEqual(i.total_amount, r2(i.taxable_value + i.gst_amount + (i.cess_amount || 0)));
  }
  // ...and the header is those lines, not a separate conversion.
  const lineTaxable = r2(body.items.reduce((s, i) => s + i.taxable_value, 0));
  assert.strictEqual(body.header.taxable_amount, lineTaxable);
});

test('EX4 EUR, and a rate with six decimals, convert exactly', async () => {
  const g = load();
  g.setLines(LINES);
  g.chooseExport('EUR', 90.123456);
  assert.ok(g.grid().includes('€'), 'the grid shows euros');
  const inr = g.inr();
  // Converted line by line and then added, so the header equals the lines it
  // stores - 2000 and 800 each rounded to the paise, not 2800 rounded once.
  assert.strictEqual(inr.taxable_amount, r2(r2(2000 * 90.123456) + r2(800 * 90.123456)));
  const body = await g.save({ invoice_number: 'EXP-3' });
  assert.strictEqual(body.header.currency_code, 'EUR');
  assert.strictEqual(body.header.exchange_rate, 90.123456);
  assert.strictEqual(body.header.fx_total_amount, 3304);
});

test('EX5 Domestic to Export and back leaves the lines exactly as typed', async () => {
  const g = load();
  g.setLines(LINES);
  const before = g.state();
  const domesticRoll = g.rollups();

  g.chooseExport('USD', 83.25);
  assert.deepStrictEqual(g.state(), before, 'switching currency changes no line');

  g.chooseDomestic();
  assert.deepStrictEqual(g.state(), before, 'and switching back changes none either');
  assert.deepStrictEqual(g.rollups(), domesticRoll, 'the totals are the rupee ones again');
  assert.ok(g.grid().includes('₹') && !g.grid().includes('$'));
  assert.ok(g.summary().hidden, 'the second-currency block is gone');

  const body = await g.save({ invoice_number: 'D-2' });
  assert.ok(!('currency_code' in body.header), 'and nothing foreign is saved');
});

test('EX6 an export billed abroad must say what in, and at what rate', () => {
  const g = load();
  g.setLines(LINES);

  // Domestic is never asked.
  assert.strictEqual(g.validate(), true);

  g.run("setInvoiceType('export')");
  assert.strictEqual(g.validate(), true, 'an export billed in rupees is still fine');

  g.els.invCurrency.value = 'USD';
  assert.strictEqual(g.validate(), false, 'a currency with no rate is refused');
  assert.match(g.toasts.pop().message, /exchange rate/i);

  g.els.invExchangeRate.value = 'abc';
  assert.strictEqual(g.validate(), false, 'a rate that is not a number is refused');
  assert.match(g.toasts.pop().message, /must be a number/i);

  g.els.invExchangeRate.value = '0';
  assert.strictEqual(g.validate(), false, 'zero is refused');
  assert.match(g.toasts.pop().message, /greater than zero/i);

  g.els.invExchangeRate.value = '-5';
  assert.strictEqual(g.validate(), false, 'negative is refused');

  g.els.invExchangeRate.value = '83.25';
  assert.strictEqual(g.validate(), true);

  g.els.invCurrency.value = '';
  g.els.invExchangeRate.value = '83.25';
  assert.strictEqual(g.validate(), false, 'a rate with no currency is refused');
  assert.match(g.toasts.pop().message, /currency/i);
});

test('EX7 a saved export reopens billed in its own currency', () => {
  const g = load();
  g.setLines(LINES);
  g.restore({ export_type: 'WOPAY', currency_code: 'USD', exchange_rate: '83.250000',
    destination_country: 'United States', port_code: 'INMAA1' });

  assert.strictEqual(g.els.exportToggle.checked, true);
  assert.strictEqual(g.els.invCurrency.value, 'USD');
  assert.strictEqual(g.els.invExchangeRate.value, '83.25');
  assert.strictEqual(g.els.invDestinationCountry.value, 'United States');
  assert.ok(g.grid().includes('$'), 'the grid is back in the buyer\'s currency');
  assert.strictEqual(g.summary().total, '$3,304.00');

  // A currency outside the list comes back through "Other" with its code.
  g.restore({ export_type: 'WPAY', currency_code: 'JPY', exchange_rate: '0.56' });
  assert.strictEqual(g.els.invCurrency.value, 'OTHER');
  assert.strictEqual(g.els.invCurrencyOther.value, 'JPY');

  // And a domestic invoice comes back as rupees.
  g.restore(null);
  assert.strictEqual(g.els.exportToggle.checked, false);
  assert.strictEqual(g.els.invCurrency.value, '');
  assert.ok(g.grid().includes('₹'));
});

test('EX8 the Invoice Type buttons and the export setting are one thing', () => {
  const g = load();
  g.run("setInvoiceType('export')");
  assert.strictEqual(g.els.exportToggle.checked, true);
  assert.strictEqual(g.els.exportFields.classList.contains('d-none'), false);
  assert.ok(g.els.invTypeExport.classList.contains('active'));
  assert.ok(!g.els.invTypeDomestic.classList.contains('active'));

  g.run("setInvoiceType('domestic')");
  assert.strictEqual(g.els.exportToggle.checked, false);
  assert.strictEqual(g.els.exportFields.classList.contains('d-none'), true);
  assert.ok(g.els.invTypeDomestic.classList.contains('active'));
});

// ══════════════════════════════════════════════════════════════════════
//  The document
// ══════════════════════════════════════════════════════════════════════

function pdfSandbox() {
  const noop = () => {};
  const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop,
    getContext: () => null, toDataURL: () => '' });
  const sb = { console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl, ArrayBuffer,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array, DataView,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    Buffer, TextEncoder, TextDecoder, btoa, atob, navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: mkEl(), body: mkEl(), head: mkEl(),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl() },
    alert: noop, fetch: () => Promise.reject(new Error('no net')), __docs: [], __texts: [] };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), sb, { filename: 'jspdf.js' });
  vm.runInContext(fs.readFileSync(AUTOTABLE_FILE, 'utf8'), sb, { filename: 'autotable.js' });
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(PDF_SRC, sb, { filename: 'invoice-pdf.js' });
  vm.runInContext(`
    getCachedProfile = function () { return { business_name: 'VTECH KITCHEN EQUIPMENTS',
      address: '9/83 E, Ganapathy Pudur', state: 'Tamil Nadu', gstin: '33AAAAA0000A1Z5',
      phone: '98400 00000', email: 'x@y.test' }; };
    imageUrlToDataUrl = async function () { return null; };
    generateQRDataUrl = async function () { return null; };
    invoiceVerifyUrl = function () { return 'https://verify.test/i/1'; };
    (function () {
      const Orig = window.jspdf.jsPDF;
      function Wrapped(o) {
        const d = new Orig(o); const tx = d.text;
        d.text = function (s, x, y) { __texts.push(Array.isArray(s) ? s.join(' ') : String(s)); return tx.apply(d, arguments); };
        d.save = function () { return d; };
        __docs.push(d); return d;
      }
      Wrapped.API = Orig.API; window.jspdf.jsPDF = Wrapped;
    })();
  `, sb);
  return sb;
}

// The invoice as the database holds it: rupees, with the buyer's figures beside.
const storedExport = (extra = {}) => ({
  id: 'i1', type: 'b2b', invoice_number: 'EXP-001', invoice_date: '2026-09-30',
  customer_name: 'Global Foods LLC', gst_number: '', phone: '', address: '1 Market St, San Francisco',
  state: 'Tamil Nadu', district: '', supply_type: 'interstate', gst_percentage: 0,
  taxable_amount: 233100, gst_amount: 0, igst: 0, cgst: 0, sgst: 0, cess_amount: 0,
  total_amount: 233100, round_off: 0, export_type: 'WOPAY', export_of: 'goods',
  currency_code: 'USD', exchange_rate: 83.25,
  fx_taxable_amount: 2800, fx_gst_amount: 0, fx_total_amount: 2800,
  destination_country: 'United States',
  items: [{ product_name: 'Idli Steamer 12 Tray', hsn_code: '84198190', unit: 'PCS', quantity: 2,
    rate: 116550, discount_percentage: 0, gst_percentage: 0, taxable_value: 233100, gst_amount: 0,
    igst: 0, cgst: 0, sgst: 0, cess_amount: 0, total_amount: 233100,
    fx_rate: 1400, fx_taxable_value: 2800, fx_total_amount: 2800 }],
  ...extra
});
const storedDomestic = () => ({
  id: 'i2', type: 'b2b', invoice_number: 'INV-001', invoice_date: '2026-09-30',
  customer_name: 'Anand Caterers', gst_number: '33AAACK1234C1Z9', phone: '', address: 'Coimbatore',
  state: 'Tamil Nadu', district: 'Coimbatore', supply_type: 'intrastate', gst_percentage: 18,
  taxable_amount: 2800, gst_amount: 504, igst: 0, cgst: 252, sgst: 252, cess_amount: 0,
  total_amount: 3304, round_off: 0,
  items: [{ product_name: 'Idli Steamer 12 Tray', hsn_code: '84198190', unit: 'PCS', quantity: 2,
    rate: 1000, discount_percentage: 0, gst_percentage: 18, taxable_value: 2000, gst_amount: 360,
    igst: 0, cgst: 180, sgst: 180, cess_amount: 0, total_amount: 2360 }]
});

renderTest('EX9 the buyer\'s copy is in the buyer\'s currency, endorsed, with the rupee equivalent', async () => {
  const sb = pdfSandbox();
  await vm.runInContext('buildInvoicePDFDoc(' + JSON.stringify(storedExport()) + ')', sb);
  const texts = sb.__texts;
  const has = needle => texts.some(t => t.includes(needle));

  assert.ok(has('$2,800.00'), 'the grand total is the dollar figure the buyer was billed');
  assert.ok(texts.some(t => t.includes('1,400.00')), 'the line rate is the dollar rate, 1400 and not 116550');
  assert.ok(!texts.some(t => t.includes('1,16,550.00')), 'the rupee line rate is not printed');
  // The rupee total appears exactly once, in the equivalent note - never as
  // the invoice total, which is the buyer's figure.
  // (Three copies are printed - Original, Duplicate, Transporter - so every
  // line appears three times; what matters is that each mention is the note.)
  const rupeeMentions = texts.filter(t => t.includes('2,33,100.00'));
  assert.ok(rupeeMentions.length > 0, 'the rupee total is stated');
  for (const m of rupeeMentions) assert.match(m, /^INR equivalent/);
  assert.ok(has('SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX'),
    'the LUT / bond endorsement');
  assert.ok(has('Billed in USD. Exchange rate: 1 USD = Rs.83.25'), 'the rate it was converted at');
  assert.ok(has('INR equivalent of the invoice total: Rs.2,33,100.00'), 'and what that came to');
  // The words say "Rupees", so they must be the rupee figure.
  assert.ok(texts.some(t => /Rupees/i.test(t) && /Lakh|Thousand/i.test(t)));
});

renderTest('EX10 an export on payment of IGST carries the other endorsement', async () => {
  const sb = pdfSandbox();
  const inv = storedExport({ export_type: 'WPAY', gst_amount: 41958, igst: 41958,
    fx_gst_amount: 504, fx_total_amount: 3304, total_amount: 275058 });
  await vm.runInContext('buildInvoicePDFDoc(' + JSON.stringify(inv) + ')', sb);
  const texts = sb.__texts;
  assert.ok(texts.some(t => t.includes('SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX')));
  assert.ok(!texts.some(t => t.includes('UNDER BOND OR LETTER OF UNDERTAKING')));
  assert.ok(texts.some(t => t.includes('$3,304.00')), 'the buyer is billed the dollar total');
});

renderTest('EX11 a domestic invoice prints exactly as it always has', async () => {
  const sb = pdfSandbox();
  await vm.runInContext('buildInvoicePDFDoc(' + JSON.stringify(storedDomestic()) + ')', sb);
  const texts = sb.__texts;
  assert.ok(texts.some(t => t.includes('Rs.3,304.00')), 'rupees, with the Rs. prefix');
  assert.ok(!texts.some(t => t.includes('$')), 'no foreign symbol');
  assert.ok(!texts.some(t => /Exchange rate|INR equivalent|SUPPLY MEANT FOR EXPORT/.test(t)),
    'and none of the export notes');
});

renderTest('EX12 the print view says the same things', async () => {
  const sb = pdfSandbox();
  const html = await vm.runInContext('buildInvoiceHTML(' + JSON.stringify(storedExport()) + ', {})', sb);
  assert.ok(html.includes('$2,800.00'), 'the buyer\'s total');
  assert.ok(html.includes('Exchange rate: 1 USD = Rs.83.25'));
  assert.ok(html.includes('INR equivalent of the invoice total: Rs.2,33,100.00'));
  assert.ok(html.includes('SUPPLY MEANT FOR EXPORT UNDER BOND'));

  const domestic = await vm.runInContext('buildInvoiceHTML(' + JSON.stringify(storedDomestic()) + ', {})', sb);
  assert.ok(domestic.includes('Rs.3,304.00'));
  assert.ok(!domestic.includes('Exchange rate'), 'a domestic print view is unchanged');
});

test('EX13 a stored export needs no conversion to be printed, and a missing rate prints rupees', () => {
  // Pure enough to call directly: this is what turns the stored row back into
  // the buyer's invoice.
  const sb = { Math, Number, String, Object, Array, JSON, formatNum: v => String(v) };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(PDF_SRC.slice(PDF_SRC.indexOf('const INVOICE_PDF_CURRENCY_SYMBOLS'),
    PDF_SRC.indexOf('function invoiceTransportParts')), sb);

  const fx = vm.runInContext('invoiceBillingFx(' + JSON.stringify(storedExport()) + ')', sb);
  assert.strictEqual(fx.code, 'USD');
  assert.strictEqual(fx.symbol, '$');
  assert.strictEqual(fx.inrTotal, 233100, 'the rupee total is kept for the equivalent line');
  assert.strictEqual(fx.invoice.total_amount, 2800, 'the printed total is the stored fx one');
  assert.strictEqual(fx.invoice.items[0].taxable_value, 2800, 'as is the line value');
  assert.strictEqual(fx.invoice.items[0].rate, 1400, 'and the line rate is the stored fx one');

  // No currency, or no rate: nothing to convert, so nothing changes.
  assert.strictEqual(vm.runInContext('invoiceBillingFx(' + JSON.stringify(storedDomestic()) + ')', sb), null);
  assert.strictEqual(vm.runInContext('invoiceBillingFx({ currency_code: "USD", exchange_rate: 0 })', sb), null);
  assert.strictEqual(vm.runInContext('invoiceBillingFx({ currency_code: "INR", exchange_rate: 1 })', sb), null);
});

// ══════════════════════════════════════════════════════════════════════
//  Where it is stored
// ══════════════════════════════════════════════════════════════════════

test('EX14 the migration is additive, listed, and matches what schema.sql declares', () => {
  const code = MIG.replace(/--[^\n]*/g, '');
  for (const kw of ['UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'INSERT']) {
    assert.strictEqual(new RegExp('\\b' + kw + '\\b', 'i').test(code), false, 'no ' + kw + ': nothing existing is read or written');
  }
  const tables = [...code.matchAll(/ALTER TABLE\s+([a-z0-9_]+)/gi)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(tables)].sort(), ['b2b_invoices', 'b2c_invoices', 'invoice_items']);

  const headerCols = ['currency_code', 'exchange_rate', 'fx_taxable_amount', 'fx_gst_amount',
    'fx_total_amount', 'destination_country'];
  for (const t of ['b2b_invoices', 'b2c_invoices']) {
    for (const c of headerCols) {
      assert.match(code, new RegExp('ADD COLUMN IF NOT EXISTS ' + c), t + ' gains ' + c);
    }
  }
  for (const c of ['fx_rate', 'fx_taxable_value', 'fx_total_amount']) {
    assert.match(code, new RegExp('ADD COLUMN IF NOT EXISTS ' + c));
  }
  // Every column is nullable and defaulted to nothing: an invoice raised
  // before this is untouched. (The CHECK constraints say IS NOT NULL about
  // the pair, which is a different claim from a NOT NULL column.)
  assert.strictEqual(/ADD COLUMN[^;]*?NOT NULL/.test(code), false, 'no column is NOT NULL');
  assert.strictEqual(/DEFAULT/.test(code), false, 'and none carries a DEFAULT');

  const order = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json')).order;
  assert.ok(order.includes('migration_invoice_export_currency.sql'), 'the runner knows about it');
  assert.strictEqual(order[order.length - 1], 'migration_invoice_export_currency.sql', 'and runs it last');

  // schema.sql is the current shape, so it declares the same columns.
  for (const c of headerCols.concat(['fx_rate', 'fx_taxable_value'])) {
    assert.ok(SCHEMA.includes(c), 'schema.sql declares ' + c);
  }
  assert.match(SCHEMA, /currency_code IS NULL AND exchange_rate IS NULL/, 'half a conversion is not a valid row');
});

test('EX15 the save route accepts the new columns, and the page is served fresh', () => {
  for (const c of ['currency_code', 'exchange_rate', 'fx_taxable_amount', 'fx_gst_amount',
    'fx_total_amount', 'destination_country']) {
    assert.ok(GENERIC.includes(`'${c}'`), 'the header allowlist carries ' + c);
  }
  for (const c of ['fx_rate', 'fx_taxable_value']) {
    assert.ok(GENERIC.includes(`'${c}'`), 'the item allowlist carries ' + c);
  }
  for (const key of ['client/js/pages/invoice-items.js?v=43', 'client/js/pages/invoice-entry.js?v=39',
    'client/js/pages/invoice-pdf.js?v=52', 'client/css/style.css?v=40']) {
    assert.ok(HTML.includes(key), 'invoice.html loads ' + key);
  }
  // The rupee grid is shared with Proforma Entry, which never calls
  // setInvoiceCurrency() - so a quotation is untouched by all of this.
  assert.strictEqual(/setInvoiceCurrency\(/.test(rd('client', 'js', 'pages', 'proforma-entry.js')), false);
});
