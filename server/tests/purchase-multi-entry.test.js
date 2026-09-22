// New Purchase - a bill of several product lines, entered line after line.
//
// A purchase bill is typed one product at a time, so the item grid has to
// take several lines without the mouse between them. Invoice Entry has done
// that since it was written; New Purchase shipped the pieces - arrow-key
// highlighting in the product dropdown and selectHighlightedPurchProductOption()
// - but nothing ever called them, so Enter did nothing at all: the product
// was never taken, no next row was started, and every further keystroke went
// on piling into the same Product box ("Coco4Chapathi" in a real browser).
//
// These run the real grid and the real page module: the rows, what Enter
// does in each field, and that a second, third and duplicate line all keep
// their own values through to what is saved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const GRID = rd('client', 'js', 'pages', 'purchase-items.js');
const ENTRY = rd('client', 'js', 'pages', 'purchase-entry.js');

const PRODUCTS = [
  { id: 'p1', name: 'Chapathi Press Machine 8 Inch', hsn_code: '84388090', unit: 'PCS', gst_percentage: 18, default_rate: 15000 },
  { id: 'p2', name: 'Coconut Scraper Machine', hsn_code: '85094010', unit: 'NOS', gst_percentage: 18, default_rate: 5200 },
  { id: 'p3', name: 'Stainless Steel Dough Kneader 25 Kg', hsn_code: '84381010', unit: 'KGS', gst_percentage: 12, default_rate: 38000 }
];

// A browser-shaped sandbox holding both files, with just enough DOM for the
// grid to render into and for the page's key handling to find its way about.
function load() {
  const noop = () => {};
  const els = {};
  const mk = id => ({ id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, querySelector: () => null, querySelectorAll: () => [] });
  const el = id => els[id] || (els[id] = mk(id));
  const focused = [];
  const keydownHandlers = [];
  const sent = [];

  // One stand-in per rendered row: enough to answer the row lookups the page
  // makes after a render. The ids are read out of the context itself - the
  // grid declares purchItems with let, so it is a lexical binding inside the
  // script, not a property of the sandbox object.
  const rowIds = () => JSON.parse(vm.runInContext('JSON.stringify(purchItems.map(r => r.rowId))', sb));
  const rowStubs = () => rowIds().map(rowId => ({
    getAttribute: name => (name === 'data-row' ? rowId : null),
    querySelector: sel => (sel === '.purch-product-input' || sel === '.purch-qty-input'
      ? { focus: () => focused.push({ sel, rowId }), select: () => focused.push({ sel: sel + ':select', rowId }) }
      : null)
  }));

  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, RegExp, Intl, Promise, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, URLSearchParams,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      addEventListener: (type, fn) => { if (type === 'keydown') keydownHandlers.push(fn); },
      getElementById: el,
      querySelector: sel => {
        const m = /tr\[data-row="([^"]+)"\]\s+\.purch-qty-input/.exec(sel);
        if (m) return rowStubs().find(r => r.getAttribute('data-row') === m[1])?.querySelector('.purch-qty-input') || null;
        return null;
      },
      querySelectorAll: sel => (sel === '#purchItemsTableBody tr' ? rowStubs() : []),
      createElement: () => mk('_new'), body: mk('_body'), head: mk('_head'), documentElement: mk('_doc')
    },
    showToast: noop, handleApiError: noop,
    // shared helpers the page loads beside these two files
    renderPaymentPreview: noop, syncDistrictField: noop, populateGstCategorySelect: noop,

    apiFetch: async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { id: 'pur1' }; },
    loadProductsList: async () => PRODUCTS,
    requireAuth: async () => null
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(GRID, sb, { filename: 'purchase-items.js' });
  vm.runInContext(ENTRY, sb, { filename: 'purchase-entry.js' });
  vm.runInContext('purchProductsList = ' + JSON.stringify(PRODUCTS) + '; purchUnitSelect = true;', sb);
  const run = code => vm.runInContext(code, sb);
  const state = () => JSON.parse(run('JSON.stringify(purchItems.map(r => ({ rowId: r.rowId, product_name: r.product_name, product_id: r.product_id, unit: r.unit, quantity: r.quantity, rate: r.rate, gst_percentage: r.gst_percentage, taxable_value: r.taxable_value, total_amount: r.total_amount })))'));
  return { sb, run, state, focused, sent, els, keydown: e => keydownHandlers.forEach(fn => fn(e)) };
}

// An event as the page sees it: a target that answers matches()/closest().
function keyEvent(key, opts = {}) {
  const prevented = { count: 0 };
  const selectors = opts.selectors || [];
  const target = {
    tagName: opts.tagName || 'INPUT',
    matches: sel => selectors.includes(sel),
    closest: sel => (sel === 'tr[data-row]' && opts.rowId
      ? { getAttribute: n => (n === 'data-row' ? opts.rowId : null) } : null)
  };
  return { key, target, preventDefault: () => { prevented.count++; }, prevented };
}

// Three lines, entered the way the page enters them.
function threeLines(g) {
  g.run('purchItems = []; addPurchItemRow();');
  const fill = (i, productId, qty, rate) => g.run(`
    (function () {
      const row = purchItems[${i}];
      applyProductToPurchRow(row, purchProductsList.find(p => p.id === '${productId}'));
      onPurchFieldChange(row.rowId, 'quantity', '${qty}');
      onPurchFieldChange(row.rowId, 'rate', '${rate}');
    })();`);
  fill(0, 'p1', 2, 15000);
  g.run('addPurchItemRow();');
  fill(1, 'p2', 5, 5200);
  g.run('addPurchItemRow();');
  fill(2, 'p3', 1, 38000);
}

test('ME1 every row is rendered with the markers the page keys off', () => {
  const g = load();
  threeLines(g);
  g.run('renderPurchItemsTable();');
  const html = g.els.purchItemsTableBody.innerHTML;
  assert.strictEqual((html.match(/class="form-control purch-product-input"/g) || []).length, 3,
    'each row has a marked Product field');
  assert.strictEqual((html.match(/purch-qty-input/g) || []).length, 3,
    'each row has a marked Quantity field');
  assert.strictEqual((html.match(/<tr data-row="/g) || []).length, 3);
  // The dropdown hands over to Quantity by that marker, not by matching the
  // text of another function's call - which goes stale silently on a rename.
  assert.match(GRID, /tr\[data-row="\$\{rowId\}"\] \.purch-qty-input`\)\?\.select\(\)/);
  assert.doesNotMatch(GRID, /oninput\*='quantity'|oninput\*="'quantity'"/);
});

test('ME2 Enter in the Product field takes the highlighted product', () => {
  const g = load();
  threeLines(g);
  const picked = [];
  g.run('selectHighlightedPurchProductOption = function (rowId) { __picked.push(rowId); return true; };');
  g.sb.__picked = picked;
  const rowId = g.state()[1].rowId;
  const e = keyEvent('Enter', { selectors: ['#purchItemsTableBody .purch-product-input'], rowId });
  g.keydown(e);
  assert.deepStrictEqual(picked, [rowId], 'the highlighted option of THAT row is taken');
  assert.strictEqual(e.prevented.count, 1, 'and the keystroke does not fall through');
});

test('ME3 Enter in Quantity starts the next line and puts the cursor in it', () => {
  const g = load();
  threeLines(g);
  const before = g.state();
  const e = keyEvent('Enter', { selectors: ['#purchItemsTableBody .purch-qty-input'], rowId: before[2].rowId });
  g.keydown(e);
  const after = g.state();
  assert.strictEqual(after.length, before.length + 1, 'a fourth row');
  assert.deepStrictEqual(after.slice(0, 3).map(r => [r.product_name, r.quantity, r.rate]),
    before.map(r => [r.product_name, r.quantity, r.rate]), 'the three already typed are untouched');
  assert.deepStrictEqual(g.focused.slice(-1), [{ sel: '.purch-product-input', rowId: after[3].rowId }],
    'typing continues in the new row\'s Product field');
  assert.strictEqual(e.prevented.count, 1);
});

test('ME4 Enter anywhere else on the page still does nothing', () => {
  const g = load();
  threeLines(g);
  const before = JSON.stringify(g.state());
  for (const sel of ['#purchItemsTableBody .purch-rate-input', '#purchVendorName', '#purchNum']) {
    const e = keyEvent('Enter', { selectors: [sel] });
    g.keydown(e);
    assert.strictEqual(e.prevented.count, 0, sel + ' keeps its own Enter');
  }
  // and a different key in the item grid is not intercepted either
  const tab = keyEvent('Tab', { selectors: ['#purchItemsTableBody .purch-qty-input'], rowId: g.state()[0].rowId });
  g.keydown(tab);
  assert.strictEqual(tab.prevented.count, 0);
  assert.strictEqual(JSON.stringify(g.state()), before, 'no row was added or changed');
});

test('ME5 three products are three lines, each keeping its own figures', () => {
  const g = load();
  threeLines(g);
  const rows = g.state();
  assert.deepStrictEqual(rows.map(r => [r.product_name, r.unit, r.quantity, r.rate, r.taxable_value]), [
    ['Chapathi Press Machine 8 Inch', 'PCS', 2, 15000, 30000],
    ['Coconut Scraper Machine', 'NOS', 5, 5200, 26000],
    ['Stainless Steel Dough Kneader 25 Kg', 'KGS', 1, 38000, 38000]
  ]);
  // GST is still each line's own rate, and the rollup is the sum of them
  const totals = JSON.parse(g.run('JSON.stringify(computePurchRollups())'));
  assert.deepStrictEqual([totals.taxable_amount, totals.gst_amount], [94000, 14640]);
  assert.strictEqual(totals.total_amount, Math.round(94000 + 14640));
  assert.deepStrictEqual([totals.cgst, totals.sgst, totals.igst], [7320, 7320, 0]);
});

test('ME6 all three lines reach the save, in the order they were typed', async () => {
  const g = load();
  threeLines(g);
  await g.run(`savePurchaseWithItems('purchase', { vendor_name: 'Sri Lakshmi Traders', purchase_number: 'PUR-1' }, null, 'u1')`);
  const body = g.sent[0].body;
  assert.deepStrictEqual(body.items.map(i => [i.product_name, i.quantity, i.rate, i.unit]), [
    ['Chapathi Press Machine 8 Inch', 2, 15000, 'PCS'],
    ['Coconut Scraper Machine', 5, 5200, 'NOS'],
    ['Stainless Steel Dough Kneader 25 Kg', 1, 38000, 'KGS']
  ]);
  assert.strictEqual(body.header.taxable_amount, 94000);
});

test('ME7 the same product on two lines stays two lines', async () => {
  const g = load();
  g.run('purchItems = []; addPurchItemRow();');
  const fill = (i, qty, rate) => g.run(`
    (function () {
      const row = purchItems[${i}];
      applyProductToPurchRow(row, purchProductsList.find(p => p.id === 'p2'));
      onPurchFieldChange(row.rowId, 'quantity', '${qty}');
      onPurchFieldChange(row.rowId, 'rate', '${rate}');
    })();`);
  fill(0, 2, 5000);
  g.run('addPurchItemRow();');
  fill(1, 3, 5100);
  await g.run(`savePurchaseWithItems('purchase', { vendor_name: 'Sri Lakshmi Traders', purchase_number: 'PUR-2' }, null, 'u1')`);
  // Two lines, not merged: the rates differ, and the server nets the stock
  // per product itself (server/src/routes/purchases.js).
  assert.deepStrictEqual(g.sent[0].body.items.map(i => [i.product_name, i.quantity, i.rate]), [
    ['Coconut Scraper Machine', 2, 5000],
    ['Coconut Scraper Machine', 3, 5100]
  ]);
});

test('ME8 removing one line leaves the others exactly as they were', () => {
  const g = load();
  threeLines(g);
  const before = g.state();
  g.run(`removePurchItemRow('${before[1].rowId}')`);
  const after = g.state();
  assert.deepStrictEqual(after.map(r => r.product_name), [before[0].product_name, before[2].product_name]);
  assert.deepStrictEqual(after.map(r => [r.quantity, r.rate, r.taxable_value]),
    [[before[0].quantity, before[0].rate, before[0].taxable_value],
      [before[2].quantity, before[2].rate, before[2].taxable_value]]);
  // and removing the last one leaves an empty row to type into, as before
  after.forEach(r => g.run(`removePurchItemRow('${r.rowId}')`));
  assert.deepStrictEqual(g.state().map(r => r.product_name), ['']);
});

test('ME9 an edited purchase loads all of its lines back', () => {
  const g = load();
  g.sb.__stored = [
    { product_id: 'p1', product_name: 'Chapathi Press Machine 8 Inch', hsn_code: '84388090', unit: 'PCS', quantity: 2, rate: 15000, discount_percentage: 0, gst_percentage: 18, taxable_value: 30000, gst_amount: 5400, cgst: 2700, sgst: 2700, igst: 0, total_amount: 35400 },
    { product_id: 'p2', product_name: 'Coconut Scraper Machine', hsn_code: '85094010', unit: 'NOS', quantity: 5, rate: 5200, discount_percentage: 0, gst_percentage: 18, taxable_value: 26000, gst_amount: 4680, cgst: 2340, sgst: 2340, igst: 0, total_amount: 30680 },
    { product_id: 'p3', product_name: 'Stainless Steel Dough Kneader 25 Kg', hsn_code: '84381010', unit: 'KGS', quantity: 1, rate: 38000, discount_percentage: 0, gst_percentage: 12, taxable_value: 38000, gst_amount: 4560, cgst: 2280, sgst: 2280, igst: 0, total_amount: 42560 }
  ];
  g.run('loadPurchItemsIntoTable(__stored);');
  assert.deepStrictEqual(g.state().map(r => [r.product_name, r.quantity, r.rate]), [
    ['Chapathi Press Machine 8 Inch', 2, 15000],
    ['Coconut Scraper Machine', 5, 5200],
    ['Stainless Steel Dough Kneader 25 Kg', 1, 38000]
  ]);
  // and Enter in the last row's Quantity still starts a fourth line
  const e = keyEvent('Enter', { selectors: ['#purchItemsTableBody .purch-qty-input'], rowId: g.state()[2].rowId });
  g.keydown(e);
  assert.strictEqual(g.state().length, 4);
});

test('ME10 the keyboard entry belongs to New Purchase alone', () => {
  // The shared grid registers no listener of its own, so Purchase Order
  // entry and Purchase Returns - which load it - are untouched.
  assert.doesNotMatch(GRID, /addEventListener\('keydown'/);
  assert.match(ENTRY, /document\.addEventListener\('keydown'/);
  const html = rd('purchases.html');
  for (const key of ['client/js/pages/purchase-items.js?v=32', 'client/js/pages/purchase-entry.js?v=32']) {
    assert.ok(html.includes(key), 'purchases.html loads ' + key);
  }
  assert.ok(!rd('purchase-order.html').includes('purchase-entry.js'));
  assert.ok(!rd('purchase-returns.html').includes('purchase-entry.js'));
});
