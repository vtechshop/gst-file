// The Unit a new invoice line opens on.
//
// Typing an invoice is the common case and almost every line is counted in
// pieces, so a fresh row opens on PCS rather than on "Select Unit". The whole
// risk of a default like this is that it leaks: onto a row loaded from a saved
// invoice, or over a product whose master record says something else. These
// tests pin the one place it applies and the three places it must not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const PAGES = ['invoice.html', 'invoice-list.html', 'proforma.html', 'proforma-list.html'];

// Both scripts share one global scope in the browser; the same arrangement
// here. const/let at a script's top level are lexical, so they are read back
// through the context rather than off the sandbox object.
const noop = () => {};
function load() {
  const el = new Proxy({ value: '', innerHTML: '', textContent: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, contains: () => false } },
    { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: el, body: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: noop, createElement: () => el, head: el },
    showToast: noop, alert: noop, fetch: () => Promise.reject(new Error('no net')),
    URL, Math, Date, JSON, Promise, Error, RegExp,
    _supabase: { from: () => ({}) }, readMaybeOne: async () => null, readAll: async () => [[]]
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(ITEMS, sb, { filename: 'invoice-items.js' });
  sb.__get = (expr) => vm.runInContext(expr, sb);
  // Which form the shared grid is serving. The browser sets this in
  // initInvoiceItems(); the tests set it directly so each case is explicit
  // about whether it is an invoice line or a quotation line.
  sb.__form = (prefix) => vm.runInContext('itemsFormPrefix = ' + JSON.stringify(prefix) + ';', sb);
  // A row as the page would have it before a product is picked.
  sb.__pick = (prefix, product) => {
    sb.__form(prefix);
    const row = sb.blankRow();
    sb.applyProductToRow(row, product);
    return row;
  };
  return sb;
}

test('U1 a new blank row opens on PCS', () => {
  const sb = load();
  const rows = [sb.blankRow(), sb.blankRow(), sb.blankRow()];
  for (const r of rows) assert.strictEqual(r.unit, 'PCS');
  assert.match(ITEMS, /const DEFAULT_ITEM_UNIT = 'PCS';/);
  assert.match(ITEMS, /hsn_code: '', unit: DEFAULT_ITEM_UNIT,/);
});

test('U2 PCS is a real UQC the GSTR-1 export can emit', () => {
  const sb = load();
  assert.ok(sb.__get('GST_UQC_MASTER').some(u => u.code === 'PCS'),
    'PCS must be in the GST UQC master');
  // ...and the export maps it, so a line left on the default still files.
  assert.match(rd('client', 'js', 'gst', 'gstr1-export.js'), /'PCS': 'PCS'/);
});

test('U3 the default changes nothing else about a blank row', () => {
  const r = load().blankRow();
  assert.strictEqual(r.quantity, 1);
  assert.strictEqual(r.rate, 0);
  assert.strictEqual(r.gst_percentage, 0);
  assert.strictEqual(r.hsn_code, '');
  assert.strictEqual(r.product_name, '');
  assert.strictEqual(r.product_id, null);
  assert.strictEqual(r.gst_treatment, 'taxable');
});

test('U4 every unit option is still offered, and any of them can be chosen', () => {
  const sb = load();
  const all = sb.__get('GST_UQC_MASTER');
  const html = sb.unitSelectOptions('PCS');
  const codes = [...html.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  assert.strictEqual(codes.length, all.length + 1, 'blank option plus every UQC');
  assert.strictEqual(codes[0], '', 'the "Select Unit" option must survive');
  assert.match(html, /<option value="PCS" selected>PCS - PIECES<\/option>/);
  assert.strictEqual((html.match(/ selected>/g) || []).length, 1, 'exactly one selection');
  // the user changes it and that choice is what renders
  const other = sb.unitSelectOptions('KGS');
  assert.match(other, / value="KGS" selected>/);
  assert.equal(/ value="PCS" selected>/.test(other), false);
  assert.strictEqual([...other.matchAll(/<option value="([^"]*)"/g)].length, codes.length);
});

test('U5 a saved row keeps the unit it was saved with', () => {
  const sb = load();
  sb.loadItemsIntoTable([
    { product_name: 'A', unit: 'BOX', quantity: 2, rate: 100 },
    { product_name: 'B', unit: '', quantity: 1, rate: 50 },
    { product_name: 'C', unit: 'LEGACYUNIT', quantity: 1, rate: 10 }
  ]);
  const rows = sb.__get('currentItems');
  assert.strictEqual(rows[0].unit, 'BOX');
  // The one that matters: a line saved with NO unit must not acquire one on
  // open, or editing an old invoice would silently change what it reports.
  assert.strictEqual(rows[1].unit, '');
  assert.strictEqual(rows[2].unit, 'LEGACYUNIT');
  assert.match(ITEMS, /unit: r\.unit \|\| '',/);
});

test('U6 an invoice with no lines still opens one row, and it defaults', () => {
  const sb = load();
  sb.loadItemsIntoTable([]);
  const rows = sb.__get('currentItems');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].unit, 'PCS');
});

test('U7 the Product Master stays authoritative for a picked product', () => {
  const sb = load();
  const withUnit = sb.blankRow();
  sb.applyProductToRow(withUnit, { id: 'p1', name: 'Widget', hsn_code: '84388090', unit: 'NOS', gst_percentage: 18, default_rate: 100 });
  assert.strictEqual(withUnit.unit, 'NOS', 'the product overwrites the default');
  // A product the master records no unit for must NOT inherit PCS: defaulting
  // over the master's silence would put a unit on a GSTR-1 line nobody chose.
  // (On a QUOTATION that silence falls back to PCS instead - U11 - because a
  // proforma reaches no return. Everywhere else, including here, it stays
  // empty.)
  const noUnit = sb.blankRow();
  sb.applyProductToRow(noUnit, { id: 'p2', name: 'NoUnit', hsn_code: '84388090', unit: null, gst_percentage: 18, default_rate: 100 });
  assert.strictEqual(noUnit.unit, '');
  assert.match(ITEMS, /row\.unit = p\.unit \|\| \(itemsUnitFallsBackToDefault\(\) \? DEFAULT_ITEM_UNIT : ''\);/);
});

test('U8 the legacy synthesizer and unit validation are untouched', () => {
  assert.match(ITEMS, /hsn_code: '', unit: '', quantity: 1, rate: \+rec\.taxable_amount/);
  assert.match(ITEMS, /is not a valid GST unit — pick one from the Unit list/);
});

// Runs a statement inside the sandbox - used where a test needs the grid's
// own state rather than a return value.
function vm_run(sb, code) { return sb.__get(code); }
// ── Proforma: the default also survives picking a product ────────────
//
// A quotation is priced per piece far more often than not. A product whose
// master record names no unit used to blank the row on selection, throwing
// away the PCS it opened on and making the person choose again on every
// line. These pin the fallback, and the four places it must not reach.

test('U10 a quotation row that opens blank is on PCS, every time', () => {
  const sb = load();
  sb.__form('proforma');
  for (const r of [sb.blankRow(), sb.blankRow(), sb.blankRow()]) {
    assert.strictEqual(r.unit, 'PCS', 'every new row, not just the first');
  }
  // The page opens one row for a quotation with no lines, the same way the
  // invoice page does.
  assert.match(ITEMS, /if \(!currentItems\.length\) addItemRow\(\);/);
  assert.match(ITEMS, /function itemsUnitFallsBackToDefault\(\) \{\s*\n\s*return itemsFormPrefix === 'proforma';/);
});

test('U11 picking a product with no unit keeps PCS on a quotation', () => {
  const sb = load();
  const row = sb.__pick('proforma', { id: 'p1', name: 'Idli Steamer', hsn_code: '84198190',
    gst_percentage: 18, default_rate: 1000 });           // no unit on the master
  assert.strictEqual(row.unit, 'PCS', 'the default is kept rather than blanked');
  // Everything else the product says still lands.
  assert.strictEqual(row.product_id, 'p1');
  assert.strictEqual(row.hsn_code, '84198190');
  assert.strictEqual(row.gst_percentage, 18);
  assert.strictEqual(row.rate, 1000);
});

test('U12 the Product Master still wins wherever it says anything', () => {
  const sb = load();
  for (const unit of ['KGS', 'NOS', 'MTR', 'LTR']) {
    const row = sb.__pick('proforma', { id: 'p2', name: 'Oil', unit, gst_percentage: 5 });
    assert.strictEqual(row.unit, unit, 'a master unit is never overwritten with PCS');
  }
});

test('U13 a chosen unit is not reset by anything that re-renders the row', () => {
  const sb = load();
  sb.__form('proforma');
  const row = sb.blankRow();
  row.product_name = 'Oil';
  row.unit = 'KGS';                                   // the user's own choice
  row.quantity = 2; row.rate = 100; row.gst_percentage = 5;
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + '; recalcAllRows();');
  assert.strictEqual(sb.__get('currentItems')[0].unit, 'KGS', 'recalculation leaves it alone');
  // ...and the dropdown it draws shows that unit as the selected one.
  const html = sb.unitSelectOptions('KGS');
  assert.match(html, /<option value="KGS" selected>KGS - /);
  assert.equal(/<option value="PCS" selected>/.test(html), false, 'PCS is not re-selected under it');
});

test('U14 the invoice screen is untouched by any of this', () => {
  const sb = load();
  // Same product, same silence about its unit - and on an invoice the row
  // still clears, because a UQC nobody chose must not reach a return.
  const row = sb.__pick('invoice', { id: 'p1', name: 'Idli Steamer', gst_percentage: 18 });
  assert.strictEqual(row.unit, '', 'an invoice line is left for the user to fill in');
  for (const prefix of ['invoice', 'b2b', 'b2c', 'challan', null]) {
    sb.__form(prefix);
    assert.strictEqual(sb.__get('itemsUnitFallsBackToDefault()'), false,
      'the fallback is Proforma-only, not ' + prefix);
  }
  sb.__form('proforma');
  assert.strictEqual(sb.__get('itemsUnitFallsBackToDefault()'), true);
});

test('U15 a saved quotation reopens on the units it was saved with', () => {
  const sb = load();
  sb.__form('proforma');
  // Rows as they come back from proforma_invoice_items, including one saved
  // long before any of this with a unit that is not PCS, and one saved with
  // no unit at all - which must stay empty rather than being invented.
  const stored = [
    { product_name: 'Oil', unit: 'KGS', quantity: 2, rate: 100, gst_percentage: 5 },
    { product_name: 'Wire', unit: 'MTR', quantity: 10, rate: 20, gst_percentage: 18 },
    { product_name: 'Old line', unit: '', quantity: 1, rate: 50, gst_percentage: 18 }
  ];
  sb.loadItemsIntoTable(stored);
  const back = sb.__get('currentItems');
  assert.deepStrictEqual(back.map(r => r.unit), ['KGS', 'MTR', ''],
    'what was saved is what comes back');
});

test('U9 the changed asset carries a new cache key on every page that loads it', () => {
  for (const p of PAGES) {
    assert.ok(rd(p).includes('client/js/pages/invoice-items.js?v=47'),
      p + ' must reference invoice-items.js at v=46');
  }
  // and nothing unrelated moved with it
  assert.ok(rd('invoice.html').includes('client/js/utilities/utils.js?v=34'));
});
