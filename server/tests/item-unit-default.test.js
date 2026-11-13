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
  // Where the master says nothing the row keeps the default rather than
  // emptying itself - the reported bug. The master is still authoritative
  // wherever it actually speaks, which is the line above.
  sb.__form('invoice');
  const noUnit = sb.blankRow();
  sb.applyProductToRow(noUnit, { id: 'p2', name: 'NoUnit', hsn_code: '84388090', unit: null, gst_percentage: 18, default_rate: 100 });
  assert.strictEqual(noUnit.unit, 'PCS', 'silence from the master keeps PCS, it does not blank the row');
  assert.match(ITEMS, /if \(!row\.unit_touched\) \{/);
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
  // The quotation is covered by the allow-list, which now also carries the
  // invoice (U14). Asserted as behaviour rather than as the old source line,
  // so adding a form to the list does not fail this test for a quotation.
  assert.strictEqual(sb.__get("itemsUnitFallsBackToDefault()"), true, 'a quotation falls back');
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

test('U14 the fallback covers the two forms this grid serves, and nothing else', () => {
  const sb = load();
  // The invoice screen now defaults too: a product whose master records no
  // unit keeps PCS instead of emptying the box. This REVERSES the earlier
  // Proforma-only rule, deliberately - see the comment on
  // itemsUnitFallsBackToDefault(). The trade-off is that a line can file as
  // PCS because nobody changed it.
  const row = sb.__pick('invoice', { id: 'p1', name: 'Idli Steamer', gst_percentage: 18 });
  assert.strictEqual(row.unit, 'PCS', 'an invoice line keeps the default it opened on');

  for (const prefix of ['invoice', 'proforma']) {
    sb.__form(prefix);
    assert.strictEqual(sb.__get('itemsUnitFallsBackToDefault()'), true, prefix + ' defaults');
  }
  // initInvoiceItems is only ever called with these two, but the guard is
  // written as an allow-list so a third form added later opts in on purpose
  // rather than inheriting a UQC by accident.
  for (const prefix of ['b2b', 'b2c', 'challan', null]) {
    sb.__form(prefix);
    assert.strictEqual(sb.__get('itemsUnitFallsBackToDefault()'), false,
      'not extended to ' + prefix + ' without a decision');
  }
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
    assert.ok(rd(p).includes('client/js/pages/invoice-items.js?v=49'),
      p + ' must reference invoice-items.js at v=49');
  }
  // and nothing unrelated moved with it
  // utils.js is shared; its key moved with the editable proforma counter
  // (proforma-sequence-edit.test.js SEQ25), not with anything here.
  assert.ok(rd('invoice.html').includes('client/js/utilities/utils.js?v=36'));
});

// ── The reported bug: the unit emptying itself on the invoice screen ──
//
// A row opened on PCS, a product was picked, focus left the Product box,
// and the unit was blank. Three separate places wrote '' into row.unit;
// a fourth problem was that picking a product overwrote a unit the person
// had chosen by hand. U16-U21 are the acceptance cases, one per scenario
// in the brief, run against the real functions.

test('U16 (A,E) every new row opens on PCS, not on "Select Unit"', () => {
  const sb = load();
  sb.__form('invoice');
  for (let i = 0; i < 3; i++) {
    const row = sb.blankRow();
    assert.strictEqual(row.unit, 'PCS', 'row ' + (i + 1) + ' defaults');
    assert.strictEqual(row.unit_touched, false, 'and is not yet hand-chosen');
  }
  // And the dropdown it draws really shows PCS as selected, rather than
  // falling through to the placeholder.
  const html = sb.unitSelectOptions('PCS');
  assert.match(html, /<option value="PCS" selected>/);
});

test('U17 (B) picking a product with no unit leaves PCS on an invoice line', () => {
  const sb = load();
  // Exactly the reported sequence: new row, pick a product, blur.
  const row = sb.__pick('invoice', { id: 'p1', name: 'Idli Steamer', hsn_code: '84388090', gst_percentage: 18, default_rate: 5000 });
  assert.strictEqual(row.unit, 'PCS', 'the unit must not go blank');
  assert.notStrictEqual(row.unit, '', 'and certainly not empty');
  // The product itself still landed.
  assert.strictEqual(row.product_id, 'p1');
  assert.strictEqual(row.hsn_code, '84388090');
  assert.strictEqual(row.gst_percentage, 18);
});

test('U18 (C,F) a hand-picked unit survives a later product change', () => {
  const sb = load();
  sb.__form('invoice');
  const row = sb.blankRow();
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  sb.onItemFieldChange(row.rowId, 'unit', 'BOX');
  const live = () => sb.__get('currentItems')[0];
  assert.strictEqual(live().unit, 'BOX');
  assert.strictEqual(live().unit_touched, true, 'the hand choice is recorded');

  // A product whose master says KGS must NOT overwrite the chosen BOX.
  sb.applyProductToRow(live(), { id: 'p9', name: 'Oil', unit: 'KGS', gst_percentage: 5, default_rate: 100 });
  assert.strictEqual(live().unit, 'BOX', 'the user outranks the Product Master here');
  // ...and switching to a second product does not either.
  sb.applyProductToRow(live(), { id: 'p10', name: 'Rice', unit: 'NOS', gst_percentage: 5, default_rate: 60 });
  assert.strictEqual(live().unit, 'BOX');
  assert.strictEqual(live().product_id, 'p10', 'while the product itself did change');
});

test('U19 (D) editing qty, rate, discount, GST and cess never touches the unit', () => {
  const sb = load();
  sb.__form('invoice');
  const row = sb.blankRow();
  row.product_name = 'Steamer';
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  sb.onItemFieldChange(row.rowId, 'unit', 'BOX');

  for (const [field, value] of [['quantity', '4'], ['rate', '250'],
    ['discount_percentage', '10'], ['gst_percentage', '12'], ['cess_rate', '1']]) {
    sb.onItemFieldChange(row.rowId, field, value);
    assert.strictEqual(sb.__get('currentItems')[0].unit, 'BOX', field + ' left the unit alone');
  }
  vm_run(sb, 'recalcAllRows();');
  assert.strictEqual(sb.__get('currentItems')[0].unit, 'BOX', 'and so did a full recalculation');
  assert.strictEqual(sb.__get('currentItems')[0].unit_touched, true, 'the flag survives too');
});

test('U20 clearing or abandoning the product name does not empty the unit', () => {
  // Both of the other two sites that used to write '' into row.unit.
  const body = ITEMS.slice(ITEMS.indexOf('async function onItemProductBlur'),
    ITEMS.indexOf('function applyProductToRow'));
  assert.ok(body.length > 200, 'found onItemProductBlur');
  assert.strictEqual(/\.unit = ''/.test(body), false,
    'neither the blank-name path nor the declined-product path blanks the unit');
  // Nothing anywhere in the file blanks it any more.
  assert.strictEqual(/\.unit = ''/.test(ITEMS), false, 'no site writes an empty unit');
  // The fields that SHOULD still be cleared when the name goes are.
  assert.match(body, /row\.hsn_code = ''; row\.gst_percentage = 0/);
});

test('U21 a unit never reaches the server as a flag, and PCS still files', () => {
  const sb = load();
  sb.__form('invoice');
  const row = sb.blankRow();
  // unit_touched is a screen concern; the save payload names its columns.
  const payloadSource = ITEMS.slice(ITEMS.indexOf('product_id: r.product_id, product_name: r.product_name'));
  assert.strictEqual(/unit_touched/.test(payloadSource.slice(0, 600)), false,
    'unit_touched is not sent to the server');
  assert.strictEqual(row.unit, 'PCS');
  // PCS is a real UQC, so a line left on the default still exports.
  assert.match(ITEMS, /const DEFAULT_ITEM_UNIT = 'PCS';/);
});

// ══════════════════════════════════════════════════════════════════════
//  Mandatory Unit (UQC) confirmation on the invoice
// ══════════════════════════════════════════════════════════════════════
//
// The PCS fallback keeps the box from ever being empty. That is a
// convenience, and on a tax invoice a convenience must not quietly decide
// a UQC - the unit goes on a GSTR-1 line. So the row shows PCS and Save
// refuses until somebody picks from the dropdown; picking PCS itself
// counts, because then it was chosen.
//
// U22-U30 are the acceptance cases A-I from the brief.

// A row as the grid would hold it once a product has been picked.
function billedRow(sb, product, overrides) {
  const row = sb.blankRow();
  sb.applyProductToRow(row, product);
  Object.assign(row, { quantity: 1, rate: 100 }, overrides || {});
  return row;
}
// Does validateInvoiceItems() let this set of rows through?
function saveAllowed(sb, rows) {
  vm_run(sb, 'currentItems = ' + JSON.stringify(rows) + ';');
  return sb.__get('validateInvoiceItems()');
}

const MASTER_WITH_UNIT = { id: 'p1', name: 'Widget', hsn_code: '84388090', unit: 'NOS', gst_percentage: 18, default_rate: 100 };
const MASTER_NO_UNIT   = { id: 'p2', name: 'Idli Steamer', hsn_code: '84198190', gst_percentage: 18, default_rate: 100 };

test('U22 (A) a product whose master names a unit saves straight away', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_WITH_UNIT);
  assert.strictEqual(row.unit, 'NOS', 'the master wins');
  assert.strictEqual(row.unit_confirmed, true, 'and counts as already chosen');
  assert.strictEqual(sb.unitError(row), '', 'so there is nothing to complain about');
  assert.strictEqual(saveAllowed(sb, [row]), true);
});

test('U23 (B) a product with no master unit shows PCS and blocks the save', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_NO_UNIT);
  assert.strictEqual(row.unit, 'PCS', 'the box is never empty');
  assert.strictEqual(row.unit_confirmed, false, 'but nobody chose it');
  assert.strictEqual(sb.unitError(row), 'Please select Unit (UQC)');
  assert.strictEqual(saveAllowed(sb, [row]), false, 'Save is refused');
});

test('U24 (C) explicitly choosing PCS is a decision, and unblocks the save', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_NO_UNIT);
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  sb.onItemFieldChange(row.rowId, 'unit', 'PCS');       // the same value, now chosen
  const live = sb.__get('currentItems')[0];
  assert.strictEqual(live.unit, 'PCS');
  assert.strictEqual(live.unit_confirmed, true, 'choosing PCS confirms it');
  assert.strictEqual(sb.unitError(live), '');
  assert.strictEqual(sb.__get('validateInvoiceItems()'), true);
});

test('U25 (D,E) a chosen BOX saves, and survives a later product change', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_NO_UNIT);
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  sb.onItemFieldChange(row.rowId, 'unit', 'BOX');
  const live = () => sb.__get('currentItems')[0];
  assert.strictEqual(sb.__get('validateInvoiceItems()'), true, 'BOX saves');

  // Switching product must not take the decision away again.
  sb.applyProductToRow(live(), MASTER_WITH_UNIT);
  assert.strictEqual(live().unit, 'BOX', 'still BOX, not the new master NOS');
  assert.strictEqual(live().unit_confirmed, true, 'and still confirmed');
  assert.strictEqual(sb.__get('validateInvoiceItems()'), true);
});

test('U26 (F) one unconfirmed row among good ones still blocks', () => {
  const sb = load();
  sb.__form('invoice');
  const ok1 = billedRow(sb, MASTER_WITH_UNIT);
  const bad = billedRow(sb, MASTER_NO_UNIT);
  const ok2 = billedRow(sb, MASTER_WITH_UNIT);
  assert.strictEqual(saveAllowed(sb, [ok1, bad, ok2]), false, 'the middle row blocks it');
  // ...and it is the offending row the person is sent to.
  assert.strictEqual(sb.__get('currentItems').find(r => sb.unitError(r)).rowId, bad.rowId);
  // With that one confirmed, the same three rows go through.
  bad.unit_confirmed = true;
  assert.strictEqual(saveAllowed(sb, [ok1, bad, ok2]), true);
});

test('U27 (G) a blank spare row never blocks anything', () => {
  const sb = load();
  sb.__form('invoice');
  const billed = billedRow(sb, MASTER_WITH_UNIT);
  const spare = sb.blankRow();                 // PCS, unconfirmed, no product
  assert.strictEqual(spare.unit_confirmed, false);
  assert.strictEqual(sb.unitError(spare), '', 'an unused row is not an error');
  assert.strictEqual(saveAllowed(sb, [billed, spare]), true, 'and does not block the save');
});

test('U28 (H) reopening a saved invoice does not ask again', () => {
  const sb = load();
  sb.__form('invoice');
  // A line as it comes back from the server.
  const reopened = { ...sb.blankRow(), product_name: 'Widget', unit: 'NOS',
    unit_touched: true, unit_confirmed: true, quantity: 2, rate: 100, gst_percentage: 18 };
  assert.strictEqual(sb.unitError(reopened), '', 'a filed unit is already a decision');
  assert.strictEqual(saveAllowed(sb, [reopened]), true);
  // The loader is what marks them, straight from the saved value.
  assert.match(ITEMS, /unit_touched: !!r\.unit, unit_confirmed: !!r\.unit,/);
  // Nothing here rewrites a stored unit on load.
  assert.match(ITEMS, /unit: r\.unit \|\| '',/);
});

test('U29 a quotation is untouched: the fallback stays pure convenience', () => {
  const sb = load();
  sb.__form('proforma');
  const row = billedRow(sb, MASTER_NO_UNIT);
  assert.strictEqual(row.unit, 'PCS');
  assert.strictEqual(row.unit_confirmed, false, 'the flag is still set honestly');
  assert.strictEqual(sb.unitError(row), '', 'but a quotation does not block on it');
  assert.strictEqual(sb.__get('itemsUnitMustBeConfirmed()'), false);
  sb.__form('invoice');
  assert.strictEqual(sb.__get('itemsUnitMustBeConfirmed()'), true);
});

test('U30 the first unconfirmed unit is what the person is sent to', () => {
  const sb = load();
  sb.__form('invoice');
  const ok = billedRow(sb, MASTER_WITH_UNIT);
  const bad1 = billedRow(sb, MASTER_NO_UNIT);
  const bad2 = billedRow(sb, MASTER_NO_UNIT);
  vm_run(sb, 'currentItems = ' + JSON.stringify([ok, bad1, bad2]) + ';');
  assert.strictEqual(sb.focusFirstUnconfirmedUnit(), bad1.rowId, 'the FIRST one, not the last');
  // The cell carries the same wrap and error element every other field uses,
  // so the message lands beside the dropdown rather than only in a toast.
  assert.match(ITEMS, /<div data-field-wrap="unit">/);
  assert.match(ITEMS, /<div class="item-field-error">\$\{unitError\(row\)\}<\/div>/);
  // Choosing a unit clears that message without a full re-render.
  assert.match(ITEMS, /updateItemFieldValidationUI\(rowId, 'unit', unitError\(row\)\);/);
});
