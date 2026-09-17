// New Purchase - Unit is a real <select> of the application's unit list.
//
// The shared purchase grid (purchase-items.js) rendered Unit as a free-text
// box. New Purchase now asks it for a <select> of GST_UQC_MASTER; Purchase
// Order entry and Purchase Returns share the grid and keep the text box.
// These pin: the opt-in, the options (exactly the app's list), the Product
// Master lock, legacy values surviving untouched, and that choosing a unit
// changes nothing but the unit that is saved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const GRID = rd('client', 'js', 'pages', 'purchase-items.js');

function load(unitSelect) {
  const noop = () => {};
  const els = {};
  const el = id => els[id] || (els[id] = { id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, querySelector: () => null, querySelectorAll: () => [] });
  const sent = [];
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, RegExp, Intl, Promise, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, URLSearchParams,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { addEventListener: noop, getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => el('_new'), body: el('_body'), head: el('_head'), documentElement: el('_doc') },
    showToast: noop,
    apiFetch: async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { id: 'p1' }; },
    loadProductsList: async () => [],
    findProductByName: () => null   // none of these lines is in the Product Master
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(GRID, sb, { filename: 'purchase-items.js' });
  vm.runInContext(`purchUnitSelect = ${!!unitSelect};`, sb);
  const unitCell = row => vm.runInContext('purchUnitCell', sb)(row);
  return { sb, els, sent, unitCell, run: code => vm.runInContext(code, sb) };
}
const UQC = () => JSON.parse(load(true).run('JSON.stringify(GST_UQC_MASTER.map(u => [u.code, u.label]))'));
// [value, text, selected, title]
const optionsOf = html => [...html.matchAll(/<option value="([^"]*)"(?: title="([^"]*)")?( selected)?>([^<]*)<\/option>/g)]
  .map(m => [m[1], m[4], !!m[3], m[2] || null]);

test('PU1 New Purchase opts in; Purchase Order entry and Purchase Returns do not', () => {
  assert.match(rd('client', 'js', 'pages', 'purchase-entry.js'), /await initPurchaseItems\(user\.id, 'purchase', \{ unitSelect: true \}\);/);
  assert.match(rd('client', 'js', 'pages', 'purchase-order-entry.js'), /await initPurchaseItems\(poUser\.id, 'purchase'\);/);
  assert.match(rd('client', 'js', 'pages', 'purchase-returns.js'), /await initPurchaseItems\(user\.id, 'return'\);/);
  assert.match(GRID, /purchUnitSelect = !!\(options && options\.unitSelect\);/);
  const html = rd('purchases.html');
  for (const key of ['client/js/pages/purchase-items.js?v=31', 'client/js/pages/purchase-entry.js?v=30', 'client/css/style.css?v=39']) {
    assert.ok(html.includes(key), 'purchases.html loads ' + key);
  }
});

test('PU2 the select offers exactly the application unit list: each option its code, its full name as the title', () => {
  const g = load(true);
  const html = g.unitCell({ rowId: 'prow1', unit: 'PCS', locked: false });
  assert.match(html, /^<select class="form-control purch-unit-select" aria-label="Unit"\s+onchange="onPurchFieldChange\('prow1','unit',this\.value\)">/);
  const opts = optionsOf(html);
  assert.deepStrictEqual(opts.map(o => o[0]), ['', ...UQC().map(u => u[0])], 'blank + every GST_UQC_MASTER code, in order - nothing invented');
  assert.deepStrictEqual(opts.slice(1).map(o => [o[1], o[3]]), UQC(), 'each option reads as its code; the full name is its title');
  assert.strictEqual(opts[0][1], 'Select Unit');
  assert.deepStrictEqual(opts.filter(o => o[2]).map(o => o[0]), ['PCS'], 'the row\'s unit is the one selected');
  // an unfilled row selects the placeholder
  assert.deepStrictEqual(optionsOf(g.unitCell({ rowId: 'prow2', unit: '', locked: false })).filter(o => o[2]).map(o => o[0]), ['']);
});

test('PU3 a Product Master row stays locked; a free row stays editable', () => {
  const g = load(true);
  assert.match(g.unitCell({ rowId: 'prow1', unit: 'KGS', locked: true }), /<select [^>]*\bdisabled title="Filled from the Product Master for this product"/);
  assert.doesNotMatch(g.unitCell({ rowId: 'prow1', unit: 'KGS', locked: false }), /\bdisabled\b/);
});

test('PU4 a stored unit is never rewritten by being shown', () => {
  const g = load(true);
  // a code in another case is shown as that code...
  const nos = optionsOf(g.unitCell({ rowId: 'prow1', unit: 'Nos', locked: true }));
  assert.deepStrictEqual(nos.filter(o => o[2]).map(o => o[0]), ['NOS']);
  assert.strictEqual(nos.length, UQC().length + 1, 'and adds no option');
  // ...and a non-standard one stays selected with its exact value
  const legacy = optionsOf(g.unitCell({ rowId: 'prow1', unit: 'Box of 10', locked: false }));
  assert.deepStrictEqual(legacy[legacy.length - 1], ['Box of 10', 'Box of 10 (not a standard GST unit)', true, null]);
  assert.deepStrictEqual(legacy.filter(o => o[2]).length, 1);
  // escaped, not injected
  assert.ok(g.unitCell({ rowId: 'prow1', unit: '"><b', locked: false }).includes('value="&quot;>&lt;b"'));
});

test('PU5 without the option the grid keeps its text box, exactly', () => {
  const g = load(false);
  assert.strictEqual(g.unitCell({ rowId: 'prow1', unit: 'PCS', locked: true }),
    `<input type="text" class="form-control" value="PCS" readonly\n          onchange="onPurchFieldChange('prow1','unit',this.value)">`);
  assert.strictEqual(g.unitCell({ rowId: 'prow1', unit: 'Box', locked: false }),
    `<input type="text" class="form-control" value="Box" \n          onchange="onPurchFieldChange('prow1','unit',this.value)">`);
});

test('PU6 choosing a unit changes the saved unit and nothing else', async () => {
  const lines = [
    { product_name: 'Corrugated Packing Boxes', hsn_code: '48191010', unit: 'BOX', quantity: 20, rate: 45, discount_percentage: 0, gst_percentage: 12 },
    { product_name: 'Loading Charges Kit', hsn_code: '', unit: 'Box of 10', quantity: 2, rate: 350, discount_percentage: 0, gst_percentage: 18 }
  ];
  const saveWith = async change => {
    const g = load(true);
    g.sb.__lines = lines;
    g.run('loadPurchItemsIntoTable(__lines); recalcAllPurchRows();');
    if (change) g.run(`onPurchFieldChange(purchItems[0].rowId, 'unit', 'CTN')`);
    await g.run(`savePurchaseWithItems('purchase', { vendor_name: 'Sri Lakshmi Traders', purchase_number: 'P1' }, null, 'u1')`);
    return g.sent[0].body;
  };
  const before = await saveWith(false);
  const after = await saveWith(true);
  assert.deepStrictEqual(before.items.map(i => i.unit), ['BOX', 'Box of 10'], 'untouched units are saved exactly as stored');
  assert.deepStrictEqual(after.items.map(i => i.unit), ['CTN', 'Box of 10']);
  // every other figure, header and line, is identical
  const strip = b => JSON.parse(JSON.stringify(b, (k, v) => (k === 'unit' ? undefined : v)));
  assert.deepStrictEqual(strip(after), strip(before));
});

test('PU7 the arrow is drawn, the height follows the inputs, and a locked row reads as readonly', () => {
  const css = rd('client', 'css', 'style.css');
  const start = css.indexOf('New Purchase - Unit select (purchase-items.js, purchUnitCell)');
  const end = css.indexOf('/* end New Purchase - Unit select */');
  assert.ok(start > -1 && end > start, 'one delimited section');
  const block = css.slice(css.lastIndexOf('/*', start), end);
  assert.match(block, /#purchItemsTable \.purch-unit-select \{[^}]*appearance: none;[^}]*background-image: url\("data:image\/svg\+xml/);
  assert.match(block, /#purchItemsTable \.purch-unit-select:disabled \{[^}]*background-color: var\(--bg\);[^}]*color: var\(--text-muted\);/);
  for (const sel of [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map(m => m[1].trim())) {
    assert.ok(sel.startsWith('#purchItemsTable .purch-unit-select'), 'scoped to the purchase grid select: ' + sel);
  }
  assert.equal(/!important|height\s*:/.test(block), false, 'no !important and no fixed height');
});
