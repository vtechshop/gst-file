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
  const noUnit = sb.blankRow();
  sb.applyProductToRow(noUnit, { id: 'p2', name: 'NoUnit', hsn_code: '84388090', unit: null, gst_percentage: 18, default_rate: 100 });
  assert.strictEqual(noUnit.unit, '');
  assert.match(ITEMS, /row\.unit = p\.unit \|\| '';/);
});

test('U8 the legacy synthesizer and unit validation are untouched', () => {
  assert.match(ITEMS, /hsn_code: '', unit: '', quantity: 1, rate: \+rec\.taxable_amount/);
  assert.match(ITEMS, /is not a valid GST unit — pick one from the Unit list/);
});

test('U9 the changed asset carries a new cache key on every page that loads it', () => {
  for (const p of PAGES) {
    assert.ok(rd(p).includes('client/js/pages/invoice-items.js?v=36'),
      p + ' must reference invoice-items.js at v=36');
  }
  // and nothing unrelated moved with it
  assert.ok(rd('invoice.html').includes('client/js/utilities/utils.js?v=33'));
});
