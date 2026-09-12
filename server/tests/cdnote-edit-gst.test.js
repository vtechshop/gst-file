// Editing a Credit / Debit Note must not change its GST rate.
//
// The bug: the API returns NUMERIC as a string ("18.00"), and a <select>
// accepts only a value one of its options actually carries ("18"). The raw
// string left the select blank, and saveCDNote() reads it back as
// parseFloat('') || 0 - so opening a note and pressing Update rewrote an
// 18% note to 0% and zeroed its CGST/SGST and total.
//
// These run the real editCDNote() against a <select> that behaves like the
// browser's: assigning a value no option carries leaves it empty. That is
// the whole mechanism, so a test written this way fails if the fix is
// reverted, and passes only when the stored rate survives.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CDPAGE = rd('client', 'js', 'pages', 'cdnotes.js');
const CDHTML = rd('cdnotes.html');

// The rates the form offers, read from the page itself so the test cannot
// drift from the markup it is about.
const OPTION_VALUES = (() => {
  const block = CDHTML.slice(CDHTML.indexOf('id="cdGstPct"'));
  const end = block.indexOf('</select>');
  return [...block.slice(0, end).matchAll(/value="([^"]*)"/g)].map(m => m[1]);
})();

const noop = () => {};
function mkInput() {
  return { value: '', checked: false, textContent: '', innerHTML: '', style: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, scrollIntoView: noop, focus: noop, querySelector: () => null,
    querySelectorAll: () => [], appendChild: noop, remove: noop };
}
// A <select> as the browser implements it: the value sticks only when an
// option carries it, otherwise the element reports ''.
function mkSelect(options) {
  const el = mkInput();
  const allowed = options.map(String);
  let current = '';
  Object.defineProperty(el, 'value', {
    get() { return current; },
    set(v) { current = allowed.includes(String(v)) ? String(v) : ''; },
    enumerable: true, configurable: true
  });
  el.options = allowed.map(v => ({ value: v }));
  return el;
}

function load() {
  const els = {
    cdGstPct: mkSelect(OPTION_VALUES),
    cdNoteType: mkSelect(['credit', 'debit']),
    cdSupply: mkSelect(['intrastate', 'interstate']),
    cdState: mkSelect(['', 'Tamil Nadu', 'Karnataka']),
    cdSupplyNature: mkSelect(['regular', 'sez', 'export', 'deemed'])
  };
  for (const id of ['cdNoteNum', 'cdNoteDate', 'cdOrigInv', 'cdCustName', 'cdGSTIN', 'cdReason',
    'cdTaxable', 'cdIGST', 'cdCGST', 'cdSGST', 'cdGstAmt', 'cdTotalAmt', 'cdFormTitle', 'cdSaveBtn',
    'cdReverseCharge', 'cdEcomGstin', 'cdDifferential65', 'cdItemsSection', 'cdItemsSummary',
    'cdUseItemsTotal', 'cdInvoicePick', 'cdSearch', 'cdTable', 'cdNotesBody']) {
    els[id] = mkInput();
  }
  const sb = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    document: {
      getElementById: id => els[id] || null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
      createElement: () => mkInput(), body: mkInput()
    },
    window: null, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { href: '', search: '', hostname: 'x' },
    __els: els, __toasts: []
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(CDPAGE, sb, { filename: 'cdnotes.js' });
  vm.runInContext(`
    showToast = function (m) { __toasts.push(m); };
    handleApiError = function () {};
    apiFetch = function () { return Promise.resolve({}); };
    readAll = function () { return Promise.resolve([[]]); };      // the note has no items
    readMaybeOne = function () { return Promise.resolve(null); };
    getCurrentUser = function () { return Promise.resolve({ id: 'u1' }); };
    populateDistrictList = function () {};
    formatDate = function (d) { return String(d); };
    _supabase = { from: function () { return { select: function () { return this; },
      eq: function () { return this; }, order: function () { return this; },
      delete: function () { return this; } }; } };
    cdInvoices = [];
  `, sb);
  return sb;
}

// Opens a stored note for editing and reports what the form then holds, and
// what saveCDNote() would read back out of it.
async function openForEdit(rec) {
  const sb = load();
  vm.runInContext(`cdAllData = [${JSON.stringify(rec)}];`, sb);
  await vm.runInContext(`editCDNote(${JSON.stringify(rec.id)})`, sb);
  const sel = sb.__els.cdGstPct;
  return {
    selectValue: sel.value,
    // exactly how saveCDNote() reads the field
    wouldSaveAs: parseFloat(sel.value) || 0,
    taxable: sb.__els.cdTaxable.value,
    igst: sb.__els.cdIGST.value, cgst: sb.__els.cdCGST.value,
    sgst: sb.__els.cdSGST.value, gstAmt: sb.__els.cdGstAmt.value,
    total: sb.__els.cdTotalAmt.value
  };
}

const note = (rate, cgst, sgst, total, extra) => Object.assign({
  id: 'n-' + rate, note_type: 'credit', note_number: 'CN-' + rate, note_date: '2026-09-12',
  original_invoice: 'INV-1', original_invoice_id: null, original_invoice_table: null,
  customer_name: 'Scratch Customer', gstin: '33AAAAA0000A1Z5', state: 'Tamil Nadu',
  reason: 'Rate check', taxable_amount: '5000.00', gst_percentage: rate,
  supply_type: 'intrastate', igst: '0.00', cgst: cgst, sgst: sgst,
  gst_amount: (Number(cgst) + Number(sgst)).toFixed(2), total_amount: total,
  supply_nature: 'regular', reverse_charge: false, ecom_gstin: null, differential_65: false
}, extra || {});

// ── the four rates the form offers ────────────────────────────────────
const CASES = [
  { stored: '18.00', expect: '18', cgst: '450.00', sgst: '450.00', total: '5900.00' },
  { stored: '12.00', expect: '12', cgst: '300.00', sgst: '300.00', total: '5600.00' },
  { stored: '5.00', expect: '5', cgst: '125.00', sgst: '125.00', total: '5250.00' },
  { stored: '28.00', expect: '28', cgst: '700.00', sgst: '700.00', total: '6400.00' }
];

for (const c of CASES) {
  test(`G${c.expect} a note stored at ${c.stored} opens with ${c.expect}% selected and would save ${c.expect}`, async () => {
    const form = await openForEdit(note(c.stored, c.cgst, c.sgst, c.total));
    assert.strictEqual(form.selectValue, c.expect,
      `the select must hold ${c.expect}, not ${JSON.stringify(form.selectValue)}`);
    assert.strictEqual(form.wouldSaveAs, Number(c.expect),
      'saveCDNote() must read back the stored rate, never 0');
  });
}

test('G1 the rate is normalised, not assigned raw - the bug itself', () => {
  assert.match(CDPAGE, /cdGstPct'\)\.value\s*=\s*String\(Number\(rec\.gst_percentage\)\)/,
    'editCDNote must normalise the NUMERIC string before the select sees it');
  assert.equal(/cdGstPct'\)\.value\s*=\s*rec\.gst_percentage\s*;/.test(CDPAGE), false,
    'the raw assignment must be gone');
});

test('G2 every rate the form offers survives a PostgreSQL NUMERIC string', async () => {
  for (const v of OPTION_VALUES) {
    const stored = Number(v).toFixed(2);            // what the API actually returns
    const form = await openForEdit(note(stored, '0.00', '0.00', '5000.00'));
    assert.strictEqual(form.selectValue, String(Number(v)),
      `"${stored}" must select ${v}`);
    assert.strictEqual(form.wouldSaveAs, Number(v), `"${stored}" must save as ${v}`);
  }
});

test('G3 the taxes and the total are untouched by opening the form', async () => {
  const rec = note('18.00', '450.00', '450.00', '5900.00');
  const form = await openForEdit(rec);
  // recalcCD() redraws the tax display from the amount and the rate. With
  // the rate preserved, what it shows is what was stored.
  assert.strictEqual(form.taxable, '5000.00');
  assert.strictEqual(form.cgst, '450.00');
  assert.strictEqual(form.sgst, '450.00');
  assert.strictEqual(form.igst, '0.00');
  assert.strictEqual(form.gstAmt, '900.00');
  assert.strictEqual(form.total, '5,900.00');
});

test('G4 an inter-state note keeps its IGST', async () => {
  const rec = note('18.00', '0.00', '0.00', '5900.00',
    { supply_type: 'interstate', igst: '900.00', gst_amount: '900.00' });
  const form = await openForEdit(rec);
  assert.strictEqual(form.selectValue, '18');
  assert.strictEqual(form.igst, '900.00');
  assert.strictEqual(form.cgst, '0.00');
  assert.strictEqual(form.sgst, '0.00');
});

test('G5 a legacy note with no items and no invoice link still opens at its rate', async () => {
  const rec = note('18.00', '450.00', '450.00', '5900.00',
    { original_invoice: 'SCR-DUP-9', original_invoice_id: null, original_invoice_table: null, reason: null });
  const form = await openForEdit(rec);
  assert.strictEqual(form.selectValue, '18');
  assert.strictEqual(form.wouldSaveAs, 18);
});

test('G6 an itemised note keeps the rate its items are checked against', async () => {
  // The client refuses to save when a ticked line's rate differs from the
  // note's. That guard reads the same select, so a blanked rate turned a
  // valid note into "this note is at 0%". With the rate preserved the
  // comparison is against the real 18 again.
  const rec = note('18.00', '540.00', '540.00', '7080.00',
    { taxable_amount: '6000.00', original_invoice_id: 'inv1', original_invoice_table: 'b2b_invoices' });
  const form = await openForEdit(rec);
  assert.strictEqual(form.selectValue, '18');
  assert.strictEqual(form.wouldSaveAs, 18);
  assert.match(CDPAGE, /cdSameRate\(l\.gst_percentage, gstPct\)/, 'the item guard still compares the two rates');
});

test('G7 the page ships with a new cache key so browsers take the fix', () => {
  assert.match(CDHTML, /client\/js\/pages\/cdnotes\.js\?v=32/);
});
