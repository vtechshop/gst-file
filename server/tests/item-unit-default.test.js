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
    assert.ok(rd(p).includes('client/js/pages/invoice-items.js?v=50'),
      p + ' must reference invoice-items.js at v=50');
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
//  A billed invoice line must NAME a unit (UQC)
// ══════════════════════════════════════════════════════════════════════
//
// The rule is the value in the dropdown, and only that: a non-empty unit is
// a named unit, whether it got there from the PCS default, from the Product
// Master or from the person's own hand. Empty - or the placeholder, which
// carries value="" - is the one case the invoice refuses to save.
//
// This replaces an earlier arrangement where the row also had to carry a
// separate unit_confirmed flag, so a row showing PCS was still refused with
// "Please select Unit (UQC)" until somebody re-picked the same value. The
// box said PCS and the screen said it was unset; whatever the intent, that
// is a bug from every seat in the room. U22-U30 are the acceptance cases
// A-G from the brief, run against the real functions.

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

test('U22 (A) a new row on the default PCS is not an error', () => {
  const sb = load();
  sb.__form('invoice');
  // The row the reported bug was about: PCS in the box, nobody having
  // touched it, a product named - and no complaint.
  const row = sb.blankRow();
  row.product_name = 'Steamer';
  row.quantity = 1; row.rate = 100;
  assert.strictEqual(row.unit, 'PCS');
  assert.strictEqual(row.unit_touched, false, 'nobody has picked anything');
  assert.strictEqual(sb.unitError(row), '', 'and that is not an error any more');
  assert.strictEqual(saveAllowed(sb, [row]), true, 'the invoice saves');
});

test('U23 (B) a product whose master names NOS saves straight away', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_WITH_UNIT);
  assert.strictEqual(row.unit, 'NOS', 'the master wins');
  assert.strictEqual(sb.unitError(row), '');
  assert.strictEqual(saveAllowed(sb, [row]), true);
});

test('U24 (C) a product with no master unit falls back to PCS and still saves', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_NO_UNIT);
  assert.strictEqual(row.unit, 'PCS', 'the box is never empty');
  assert.strictEqual(sb.unitError(row), '', 'the fallback is a unit like any other');
  assert.strictEqual(saveAllowed(sb, [row]), true, 'Save is allowed');
});

test('U25 (D) a hand-picked BOX saves, and survives a later product change', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_NO_UNIT);
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  sb.onItemFieldChange(row.rowId, 'unit', 'BOX');
  const live = () => sb.__get('currentItems')[0];
  assert.strictEqual(live().unit, 'BOX');
  assert.strictEqual(sb.unitError(live()), '');
  assert.strictEqual(sb.__get('validateInvoiceItems()'), true, 'BOX saves');

  // Switching product must not take the hand-made choice away again.
  sb.applyProductToRow(live(), MASTER_WITH_UNIT);
  assert.strictEqual(live().unit, 'BOX', 'still BOX, not the new master NOS');
  assert.strictEqual(live().unit_touched, true, 'and still the person\'s own');
  assert.strictEqual(sb.__get('validateInvoiceItems()'), true);
});

test('U26 (E) clearing the unit back to the placeholder blocks the save', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_WITH_UNIT);
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  // The placeholder option's VALUE, which is what the select reports.
  sb.onItemFieldChange(row.rowId, 'unit', '');
  const live = () => sb.__get('currentItems')[0];
  assert.strictEqual(live().unit, '', 'the row really is empty now');
  assert.strictEqual(sb.unitError(live()), 'Please select Unit (UQC)');
  assert.strictEqual(sb.__get('validateInvoiceItems()'), false, 'Save is refused');

  // The placeholder is recognised by its empty value, never by its label -
  // and the label arriving AS a value is not a unit either.
  assert.strictEqual(sb.itemsUnitIsChosen(''), false);
  assert.strictEqual(sb.itemsUnitIsChosen('   '), false, 'nor is whitespace');
  assert.strictEqual(sb.itemsUnitIsChosen('Select Unit'), false, 'nor the label itself');
  assert.strictEqual(sb.itemsUnitIsChosen('PCS'), true);
  assert.strictEqual(sb.itemsUnitIsChosen('BOX'), true);
  // The dropdown really does give the placeholder an empty value.
  assert.match(sb.unitSelectOptions(''), /<option value="">Select Unit<\/option>/);
});

test('U27 (F) picking PCS again clears the error and lets the save through', () => {
  const sb = load();
  sb.__form('invoice');
  const row = billedRow(sb, MASTER_WITH_UNIT);
  vm_run(sb, 'currentItems = ' + JSON.stringify([row]) + ';');
  const live = () => sb.__get('currentItems')[0];
  sb.onItemFieldChange(row.rowId, 'unit', '');
  assert.strictEqual(sb.unitError(live()), 'Please select Unit (UQC)', 'blocked first');
  sb.onItemFieldChange(row.rowId, 'unit', 'PCS');
  assert.strictEqual(live().unit, 'PCS');
  assert.strictEqual(sb.unitError(live()), '', 'the message is gone');
  assert.strictEqual(sb.__get('validateInvoiceItems()'), true, 'and the save is allowed');
  // Cleared in place, without a full re-render - the row keeps focus and
  // whatever else the person was mid-way through typing.
  assert.match(ITEMS, /updateItemFieldValidationUI\(rowId, 'unit', unitError\(row\)\);/);
  // ...and the red border clears with it. Unit is a <select>, so the
  // toggle has to look for one: an 'input'-only lookup found nothing and
  // left the border on whatever the last full re-render had decided, which
  // showed up in a browser as a box marked invalid while the message under
  // it had already gone (and unmarked while it was showing).
  assert.match(ITEMS, /wrap\.querySelector\('input, select, textarea'\)\?\.classList\.toggle\('error', !!errorMsg\)/);
});

test('U28 (G) only the rows with an empty unit are the ones complained about', () => {
  const sb = load();
  sb.__form('invoice');
  const ok1 = billedRow(sb, MASTER_WITH_UNIT);            // NOS
  const bad = billedRow(sb, MASTER_WITH_UNIT, { unit: '' });
  const ok2 = billedRow(sb, MASTER_NO_UNIT);              // PCS by fallback
  const ok3 = billedRow(sb, MASTER_NO_UNIT, { unit: 'BOX', unit_touched: true });
  assert.strictEqual(saveAllowed(sb, [ok1, bad, ok2, ok3]), false, 'the empty row blocks it');

  const flagged = sb.__get('currentItems').filter(r => sb.unitError(r));
  assert.strictEqual(flagged.length, 1, 'exactly one row is flagged');
  assert.strictEqual(flagged[0].rowId, bad.rowId, 'and it is the empty one');
  // The first offending row is what the person is sent to.
  assert.strictEqual(sb.focusFirstMissingUnit(), bad.rowId);

  // Give that row a unit and the same four go through.
  bad.unit = 'KGS';
  assert.strictEqual(saveAllowed(sb, [ok1, bad, ok2, ok3]), true);
});

test('U29 a blank spare row never blocks anything', () => {
  const sb = load();
  sb.__form('invoice');
  const billed = billedRow(sb, MASTER_WITH_UNIT);
  const spare = sb.blankRow();                 // no product on it at all
  assert.strictEqual(sb.unitError(spare), '', 'an unused row is not an error');
  // Not even an empty one, which is the state a spare row can be left in.
  spare.unit = '';
  assert.strictEqual(sb.unitError(spare), '', 'still not, with no product named');
  assert.strictEqual(saveAllowed(sb, [billed, spare]), true, 'and does not block the save');
});

test('U30 reopening a saved invoice does not ask again, and a quotation never does', () => {
  const sb = load();
  sb.__form('invoice');
  // A line as it comes back from the server.
  const reopened = { ...sb.blankRow(), product_name: 'Widget', unit: 'NOS',
    unit_touched: true, quantity: 2, rate: 100, gst_percentage: 18 };
  assert.strictEqual(sb.unitError(reopened), '');
  assert.strictEqual(saveAllowed(sb, [reopened]), true);
  // The loader marks it hand-chosen straight from the saved value, so a
  // later product change cannot overwrite what the invoice was filed with.
  assert.match(ITEMS, /unit_touched: !!r\.unit,/);
  assert.strictEqual(/unit_confirmed/.test(ITEMS.replace(/\/\/[^\n]*/g, '')), false,
    'the confirmed flag is gone from the code, not just from the rule');
  // Nothing here rewrites a stored unit on load.
  assert.match(ITEMS, /unit: r\.unit \|\| '',/);

  // An old invoice line saved with NO unit is the one case re-saving asks
  // about - the same single rule, not a second one.
  const legacy = { ...reopened, unit: '', unit_touched: false };
  assert.strictEqual(sb.unitError(legacy), 'Please select Unit (UQC)');

  // A quotation is untouched: it reaches no GSTR-1 return, so an empty unit
  // there is not an error and never was.
  sb.__form('proforma');
  assert.strictEqual(sb.unitError(legacy), '', 'a quotation does not block on it');
  assert.strictEqual(sb.__get('itemsUnitIsRequired()'), false);
  sb.__form('invoice');
  assert.strictEqual(sb.__get('itemsUnitIsRequired()'), true);
});

test('U31 a unit that is not a real UQC is a different complaint, still refused', () => {
  const sb = load();
  sb.__form('invoice');
  // Legacy free-typed units exist on old invoices. They are present, so the
  // "please select" message does not apply - but they cannot be filed as a
  // UQC either, and Save says which one it is.
  const odd = billedRow(sb, MASTER_WITH_UNIT, { unit: 'pieces' });
  assert.strictEqual(sb.unitError(odd), '', 'not the empty-unit message');
  assert.strictEqual(saveAllowed(sb, [odd]), false, 'but Save still refuses it');
  assert.strictEqual(sb.itemsUnitIsValidUqc('pieces'), false);
  assert.strictEqual(sb.itemsUnitIsValidUqc('PCS'), true);
  // Exact: a lower-case code is not quietly accepted as the upper-case one,
  // because nothing normalises it on the way to the database.
  assert.strictEqual(sb.itemsUnitIsValidUqc('pcs'), false);
});

test('U32 the server keeps the same rule, on the value alone', () => {
  const route = rd('server', 'src', 'routes', 'invoices.js');
  const block = route.slice(route.indexOf('Every billed line names a unit'));
  assert.ok(block.length > 400, 'found the server-side check');
  // Blank is the whole test there too - trimmed, and the browser's screen
  // state is not consulted (it never was, and there is none left to send).
  assert.match(block, /if \(!String\(it\.unit == null \? '' : it\.unit\)\.trim\(\)\) \{/);
  assert.match(block, /item_unit_required/);
  // A row with no product name is a spare row on the server as well.
  assert.match(block, /if \(!named\) continue;/);
  // Nothing about confirmation reaches or is required by the API.
  assert.strictEqual(/unit_confirmed/.test(route), false);
});
