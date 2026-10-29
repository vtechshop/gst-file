// Advance amount quoted on a Proforma Invoice.
//
// A quotation may ask for part of the money up front: "₹25,000 advance,
// balance ₹75,000". That is a TERM of the quote. Nothing has necessarily
// been received, so this feature writes no receipt voucher (GSTR-1 11A), no
// advance adjustment (11B) and no payment, and it moves no tax column.
//
// Three things must hold throughout:
//
//   * the balance is Grand Total − advance, derived wherever it is shown and
//     stored nowhere, so the figures cannot disagree;
//   * a proforma quoted WITHOUT an advance — every proforma that exists
//     today — saves, opens and prints exactly as it did before;
//   * converting one into a tax invoice records no money.
//
// The calculation half always runs. The DB half is skipped unless
// STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
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
const PF_HTML = rd('proforma.html');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const GEN = rd('server', 'src', 'routes', 'generic.js');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const MIG_FILE = 'migration_proforma_advance.sql';
const MIG = rd('server', 'db', 'migrations', MIG_FILE);

const plain = (v) => JSON.parse(JSON.stringify(v));

// ── A browser-shaped sandbox: the scripts proforma.html loads ─────────
const noop = () => {};
function mkEl(value) {
  return {
    value: value === undefined ? '' : value, textContent: '', innerHTML: '',
    disabled: false, checked: false, style: {}, dataset: {},
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); },
      toggle(c, on) { if (on === undefined) { this._c.has(c) ? this._c.delete(c) : this._c.add(c); } else { on ? this._c.add(c) : this._c.delete(c); } }
    },
    addEventListener: noop, appendChild: noop, setAttribute: noop, focus: noop
  };
}
const TOTALS_IDS = ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
  'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsAmountWords',
  'itemsTransportCharge', 'itemsTransportGst', 'itemsTransportRate',
  'itemsTransportNoteRow', 'itemsTransportNote'];
// The block this feature adds.
const ADVANCE_IDS = ['pfAdvanceAmount', 'pfAdvanceError', 'pfAdvanceSummary',
  'pfSummaryTotal', 'pfSummaryAdvance', 'pfSummaryBalance'];

function load({ supply = 'intrastate' } = {}) {
  const store = new Map();
  for (const id of [...TOTALS_IDS, ...ADVANCE_IDS, 'pfSaveBtn', 'pfStatus', 'pfGstCategory']) {
    store.set(id, mkEl());
  }
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
    ['invoice-pdf.js', INV_PDF], ['proforma-pdf.js', PF_PDF], ['proforma-entry.js', PF_ENTRY]]) {
    vm.runInContext(src, sb, { filename: name });
  }
  vm.runInContext(`
    __toasts = []; __calls = [];
    __fields = { pfCustName: 'Advance Quote Co', pfDate: '2026-10-17' };
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
      // Nothing should reach this any more: the save issues the number. Left
      // as a tripwire rather than a working stub, so a reintroduced browser
      // reservation fails loudly instead of passing quietly.
      if (/reserve-number/.test(url)) throw new Error('saveProforma must not reserve a number');
      return { document: { id: 'pf1', document_number: 'PI-00001' }, items: [] };
    };
    itemsFormPrefix = 'proforma';
  `, sb);
  sb.__el = (id) => store.get(id);
  sb.__get = (expr) => vm.runInContext(expr, sb);
  sb.__setItems = (rows) => vm.runInContext('currentItems = ' + JSON.stringify(rows) + ';', sb);
  sb.__setAdvance = (v) => { store.get('pfAdvanceAmount').value = String(v); };
  return sb;
}

// One product line at 18%, so a 1,00,000 quote is easy to read.
function line(taxable) {
  const gst = taxable * 0.18;
  return {
    rowId: 'r' + taxable, product_id: 'p1', product_name: 'Machine', hsn_code: '84388090',
    unit: 'PCS', quantity: 1, rate: taxable, discount_percentage: 0, gst_percentage: 18,
    gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0,
    taxable_value: taxable, gst_amount: gst, igst: 0, cgst: gst / 2, sgst: gst / 2,
    total_amount: taxable + gst, locked: false
  };
}
// A quote whose Grand Total is exactly 1,00,000.
const QUOTE = [line(84745.76)];

function withAdvance(advance, items) {
  const sb = load();
  sb.__setItems(items || QUOTE);
  if (advance !== undefined) sb.__setAdvance(advance);
  sb.__get('renderProformaAdvanceSummary(proformaQuotedTotal())');
  return sb;
}
const shown = (sb) => ({
  total: sb.__el('pfSummaryTotal').value,
  advance: sb.__el('pfSummaryAdvance').value,
  balance: sb.__el('pfSummaryBalance').value,
  error: sb.__el('pfAdvanceError').textContent,
  errorHidden: sb.__el('pfAdvanceError').classList.contains('d-none')
});

async function saveWith(advance, items) {
  const sb = load();
  sb.__setItems(items || QUOTE);
  if (advance !== undefined) sb.__setAdvance(advance);
  await sb.saveProforma();
  const calls = plain(sb.__calls);
  const saveCall = calls.find(c => /\/documents\/proforma_invoice\/save/.test(c.url));
  return { calls, doc: saveCall ? saveCall.body.document : null, toasts: plain(sb.__toasts) };
}

// ═══ 1. The field, and what a new quotation starts at ═════════════════

// (required test 1)
test('PA1 a new proforma starts at zero advance, with the whole total as balance', () => {
  const sb = load();
  sb.__setItems(QUOTE);
  sb.__get('restoreProformaAdvance(null)');
  assert.strictEqual(sb.__el('pfAdvanceAmount').value, '0', 'the box starts at 0');
  assert.strictEqual(sb.__get('PROFORMA_ADVANCE_DEFAULT'), 0);
  const s = shown(sb);
  assert.strictEqual(s.total, '₹1,00,000.00');
  assert.strictEqual(s.advance, '₹0.00');
  assert.strictEqual(s.balance, '₹1,00,000.00', 'nothing up front means the whole total is due');
  assert.strictEqual(s.errorHidden, true);
});

test('PA2 the page offers the field, read-write, beside a derived balance', () => {
  const tag = /<input[^>]*\bid="pfAdvanceAmount"[^>]*>/.exec(PF_HTML);
  assert.ok(tag, 'the field is on the page');
  assert.match(tag[0], /type="number"/);
  assert.match(tag[0], /step="0\.01"/, 'two decimal places');
  assert.match(tag[0], /min="0"/);
  assert.match(tag[0], /oninput="onProformaAdvanceInput\(\)"/, 'the balance follows as it is typed');
  assert.equal(/\breadonly\b/.test(tag[0]), false, 'the advance itself is typed by the user');
  // The balance is shown, never typed: it is a read-only box with no name the
  // save could pick up.
  const bal = /<input[^>]*\bid="pfSummaryBalance"[^>]*>/.exec(PF_HTML);
  assert.ok(bal && /\breadonly\b/.test(bal[0]), 'the balance is read-only');
  for (const id of ['pfSummaryTotal', 'pfSummaryAdvance', 'pfSummaryBalance', 'pfAdvanceError']) {
    assert.ok(PF_HTML.includes('id="' + id + '"'), id + ' is on the page');
  }
});

// ═══ 2. The arithmetic ════════════════════════════════════════════════

// (required test 2)
test('PA3 the balance is the total less the advance, and follows both', () => {
  // The worked example from the brief.
  const s = shown(withAdvance(25000));
  assert.strictEqual(s.total, '₹1,00,000.00');
  assert.strictEqual(s.advance, '₹25,000.00');
  assert.strictEqual(s.balance, '₹75,000.00');

  // Paise, and the rounding the rest of the app uses.
  assert.strictEqual(shown(withAdvance(25000.555)).balance, '₹74,999.44');
  // Nothing up front, and everything up front.
  assert.strictEqual(shown(withAdvance(0)).balance, '₹1,00,000.00');
  assert.strictEqual(shown(withAdvance(100000)).balance, '₹0.00');
  // Blank is "none quoted", not an error.
  const blank = shown(withAdvance(''));
  assert.strictEqual(blank.advance, '₹0.00');
  assert.strictEqual(blank.balance, '₹1,00,000.00');
  assert.strictEqual(blank.errorHidden, true);
});

test('PA4 a changed line item moves the balance without the advance being retyped', () => {
  const sb = withAdvance(25000);
  assert.strictEqual(shown(sb).balance, '₹75,000.00');
  // The grid recomputes - exactly what editing a line does - and the summary
  // follows through the hook invoice-items.js calls.
  sb.__setItems([line(169491.53)]);           // a 2,00,000 quote
  sb.__get('computeInvoiceRollups()');
  const s = shown(sb);
  assert.strictEqual(s.total, '₹2,00,000.00');
  assert.strictEqual(s.advance, '₹25,000.00', 'the advance is untouched');
  assert.strictEqual(s.balance, '₹1,75,000.00', 'the balance followed the total');
  // The hook is the shared grid's, guarded so other pages are unaffected.
  assert.match(ITEMS, /if \(typeof renderProformaAdvanceSummary === 'function'\) \{/);
});

test('PA5 the GST and the Grand Total do not move because of an advance', () => {
  const before = plain(withAdvance(undefined).__get('computeInvoiceRollups()'));
  const after = plain(withAdvance(25000).__get('computeInvoiceRollups()'));
  assert.deepStrictEqual(after, before, 'an advance changes who pays when, never what is owed');
  assert.strictEqual(after.total_amount, 100000);
});

// ═══ 3. What is refused ═══════════════════════════════════════════════

// (required test 4)
test('PA6 a negative advance, and one above the total, are both refused', () => {
  const negative = shown(withAdvance(-1));
  assert.match(negative.error, /cannot be negative/i);
  assert.strictEqual(negative.errorHidden, false);
  assert.strictEqual(negative.balance, '—', 'no balance is implied by a figure that was refused');

  const over = shown(withAdvance(100000.01));
  assert.match(over.error, /cannot be more than the Grand Total/i);
  assert.strictEqual(over.errorHidden, false);

  const nonsense = shown(withAdvance('abc'));
  assert.match(nonsense.error, /must be a number/i);

  // Exactly the total is allowed: paid in full up front is a real quote.
  assert.strictEqual(shown(withAdvance(100000)).errorHidden, true);
});

test('PA7 Save refuses those values, before a number is reserved', async () => {
  for (const [bad, pattern] of [[-1, /negative/i], [100000.01, /more than the Grand Total/i]]) {
    const r = await saveWith(bad);
    assert.strictEqual(r.doc, null, bad + ' must not be saved');
    assert.ok(r.toasts.some(t => pattern.test(t.m)), 'the reason is said: ' + JSON.stringify(r.toasts));
    assert.equal(r.calls.some(c => /reserve-number/.test(c.url)), false,
      'a refused Save must not burn a proforma number');
  }
  // The gate sits after the total is known and before the save is SENT. It
  // used to read "before the number is reserved"; nothing is reserved before
  // the save any more - the save issues the number inside its own
  // transaction, so a refused write moves no counter either way.
  const fn = PF_ENTRY.slice(PF_ENTRY.indexOf('async function saveProforma()'));
  assert.ok(fn.indexOf('validateProformaAdvance(quotedTotal)') > fn.indexOf('const quotedTotal ='));
  assert.ok(fn.indexOf('validateProformaAdvance(quotedTotal)')
    < fn.indexOf('/documents/proforma_invoice/save'),
    'the advance is judged before the save is sent');
  assert.equal(/reserve-number/.test(fn), false, 'the browser reserves nothing');
});

// ═══ 4. What is stored ════════════════════════════════════════════════

test('PA8 the saved document carries the advance and nothing else moves', async () => {
  const quoted = await saveWith(25000);
  assert.strictEqual(quoted.doc.advance_amount, 25000);
  assert.strictEqual(quoted.doc.total_amount, 100000, 'the quoted total is untouched');
  assert.strictEqual(quoted.doc.taxable_amount, 84745.76);
  assert.ok(Math.abs(quoted.doc.gst_amount - 15254.2368) < 1e-6,
    'the tax is untouched: ' + quoted.doc.gst_amount);
  // No balance column: it is derived from the two figures above.
  assert.equal(Object.prototype.hasOwnProperty.call(quoted.doc, 'balance_amount'), false);
  assert.equal(/balance_amount/.test(SCHEMA), false, 'the schema stores no balance');

  // A typed 0 is a decision and is stored as 0.
  assert.strictEqual((await saveWith(0)).doc.advance_amount, 0);
  // Blank is "none quoted" and stores NULL, which is what every older
  // proforma already means.
  assert.strictEqual((await saveWith('')).doc.advance_amount, null);
});

// (required test 8 - the quotation without one is untouched)
test('PA9 a proforma quoted without an advance saves exactly as it did before', async () => {
  const withoutField = await saveWith('');
  const { advance_amount: _ignored, ...rest } = withoutField.doc;
  const baseline = await saveWith(undefined);
  const { advance_amount: _ignored2, ...restBaseline } = baseline.doc;
  assert.deepStrictEqual(rest, restBaseline);
  assert.strictEqual(withoutField.doc.advance_amount, null);
  assert.strictEqual(baseline.doc.advance_amount, null);
});

// (required test 5)
test('PA10 a proforma stored before this column opens, with no advance and the full balance', () => {
  const sb = load();
  sb.__setItems(QUOTE);
  // A row from before the migration: the key is simply absent.
  sb.__get('restoreProformaAdvance(' + JSON.stringify({
    id: 'pf-old', document_number: 'PI-00007', total_amount: 100000
  }) + ')');
  assert.strictEqual(sb.__el('pfAdvanceAmount').value, '', 'nothing is invented for it');
  const s = shown(sb);
  assert.strictEqual(s.advance, '₹0.00');
  assert.strictEqual(s.balance, '₹1,00,000.00');
  assert.strictEqual(s.errorHidden, true);

  // An explicit NULL reads the same way.
  sb.__get('restoreProformaAdvance(' + JSON.stringify({ id: 'pf2', advance_amount: null }) + ')');
  assert.strictEqual(sb.__el('pfAdvanceAmount').value, '');
});

// (required test 3 - the reopened value)
test('PA11 a saved advance comes back as it was stored', () => {
  const sb = load();
  sb.__setItems(QUOTE);
  sb.__get('restoreProformaAdvance(' + JSON.stringify({ id: 'pf3', advance_amount: '25000.00' }) + ')');
  assert.strictEqual(sb.__el('pfAdvanceAmount').value, '25000');
  assert.strictEqual(shown(sb).balance, '₹75,000.00');
  // And it is restored after the lines and the delivery charge, so the
  // balance is taken off the total they produce.
  const fn = PF_ENTRY.slice(PF_ENTRY.indexOf('async function loadProformaForEdit'));
  assert.ok(fn.indexOf('restoreProformaAdvance(rec)') > fn.indexOf('restoreInvoiceTransport(rec)'));
});

// ═══ 5. The document ══════════════════════════════════════════════════

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
const R_X = 283, BOX_X = 203;
const labelled = (texts, label) => {
  const l = texts.find(t => t.x === BOX_X && t.s === label);
  if (!l) return null;
  const v = texts.find(u => u.x === R_X && u.y === l.y && u.page === l.page && /^Rs\./.test(u.s));
  return { y: l.y, value: v ? v.s : null };
};
function pfRow(advance) {
  return {
    id: 'pf1', document_number: 'PI-00001', document_date: '2026-10-17',
    customer_name: 'Advance Quote Co', supply_type: 'intrastate',
    taxable_amount: 84745.76, gst_percentage: 18, gst_amount: 15254.24,
    igst: 0, cgst: 7627.12, sgst: 7627.12, total_amount: 100000,
    transport_charge: null, transport_gst_amount: null,
    ...(advance === undefined ? {} : { advance_amount: advance })
  };
}
const PF_ITEMS = [{
  product_name: 'Machine', hsn_code: '84388090', unit: 'PCS', quantity: 1, rate: 84745.76,
  discount_percentage: 0, gst_percentage: 18, taxable_value: 84745.76, gst_amount: 15254.24,
  igst: 0, cgst: 7627.12, sgst: 7627.12, total_amount: 100000, sort_order: 0
}];

// (required test 6)
test('PA12 the PDF prints the quoted total, the advance and the balance due', async () => {
  const { texts } = await printed(pfRow(25000), PF_ITEMS);
  const total = labelled(texts, 'Quoted Total');
  const advance = labelled(texts, 'Advance Amount');
  const balance = labelled(texts, 'Balance Amount Due');
  assert.ok(total && advance && balance, 'all three lines are printed');
  assert.strictEqual(total.value, 'Rs.1,00,000.00');
  assert.strictEqual(advance.value, 'Rs.25,000.00');
  assert.strictEqual(balance.value, 'Rs.75,000.00');
  // In that order, down the page, and not on top of one another.
  assert.ok(total.y < advance.y, 'the advance follows the total');
  assert.ok(advance.y < balance.y, 'the balance follows the advance');
  assert.ok(advance.y - total.y >= 5 && balance.y - advance.y >= 5, 'the rows are not overlapping');
  // Nothing else is printed on top of them: no other text shares those lines
  // in the left column.
  for (const row of [advance, balance]) {
    const collisions = texts.filter(t => t.x < BOX_X && Math.abs(t.y - row.y) < 3);
    assert.deepStrictEqual(collisions.map(c => c.s), [], 'the left column is clear of ' + row.y);
  }
});

test('PA13 a proforma with no advance prints no payment summary, and the page is unchanged', async () => {
  const withNone = await printed(pfRow(), PF_ITEMS);
  assert.strictEqual(labelled(withNone.texts, 'Advance Amount'), null);
  assert.strictEqual(labelled(withNone.texts, 'Balance Amount Due'), null);
  assert.ok(labelled(withNone.texts, 'Quoted Total'), 'the total still prints');

  // An explicit NULL is the same document.
  const withNull = await printed(pfRow(null), PF_ITEMS);
  assert.deepStrictEqual(withNull.texts.map(t => [t.s, t.x, t.y]),
    withNone.texts.map(t => [t.s, t.x, t.y]),
    'a NULL advance prints exactly what a missing one prints');

  // A zero advance says so rather than staying silent: it was a decision.
  const withZero = await printed(pfRow(0), PF_ITEMS);
  assert.strictEqual(labelled(withZero.texts, 'Advance Amount').value, 'Rs.0.00');
  assert.strictEqual(labelled(withZero.texts, 'Balance Amount Due').value, 'Rs.1,00,000.00');
});

test('PA14 the signature band moves below the new rows instead of under them', async () => {
  const none = await printed(pfRow(), PF_ITEMS);
  const some = await printed(pfRow(25000), PF_ITEMS);
  const sigOf = (texts) => texts.find(t => /Authorised Signatory|For /.test(t.s));
  const a = sigOf(none.texts), b = sigOf(some.texts);
  if (a && b) {
    assert.ok(b.y >= a.y, 'the band does not move up when rows are added above it');
    const balance = labelled(some.texts, 'Balance Amount Due');
    assert.ok(b.y > balance.y, 'and it sits below the balance line, not across it');
  }
  // With nothing quoted the layout is the one it has always been.
  assert.match(PF_PDF, /let sigY = Math\.max\(totalsBottom \+ 5, bandTop\);/);
  assert.match(PF_PDF, /let totalsBottom = ruleY \+ 7;/);
});

// ═══ 6. Becoming a tax invoice ════════════════════════════════════════

// (required test 7)
test('PA15 conversion carries the figure, and records no money for it', () => {
  // The quotation's advance travels with the draft...
  assert.match(PF_LIST, /advance_amount: r\.advance_amount,/);
  // ...and Invoice Entry reports it rather than acting on it.
  const draftFn = INV_ENTRY.slice(INV_ENTRY.indexOf('pendingProformaSourceId = draft.source_proforma_id'));
  const block = draftFn.slice(0, draftFn.indexOf('\n}'));
  assert.match(block, /quotedAdvance/, 'the figure is read');
  assert.match(block, /has not been recorded as received/, 'and the invoice says exactly that');
  // Nothing in that block touches a payment field, a status or the ledger.
  for (const forbidden of ['invPaymentStatus', 'invPaymentAmount', 'recordPayment',
                           'amount_paid', 'payment_status', 'receipt_voucher']) {
    assert.equal(block.includes(forbidden), false,
      'converting must not touch ' + forbidden);
  }
  // Nor does anything else written for this feature reach a receipt voucher
  // or an adjustment. documents.js is excluded as a whole on purpose: it is
  // the registry for every numbered document and has named receipt_vouchers
  // since long before this - what matters is the advance block inside it.
  for (const src of [PF_ENTRY, PF_LIST]) {
    assert.equal(/receipt_vouchers|advance_adjustments/.test(src), false,
      'the proforma pages must not reach the 11A/11B tables');
  }
  const advanceBlock = DOCS.slice(DOCS.indexOf('hasOwnProperty.call(document, \'advance_amount\')'));
  assert.equal(/receipt_vouchers|advance_adjustments|payments/.test(
    advanceBlock.slice(0, advanceBlock.indexOf('\n  }'))), false,
    'the save route handles the advance without touching any money table');
});

test('PA16 the advance cannot be double-counted, because it is applied nowhere', () => {
  // The only thing that records money against an invoice is the payments
  // ledger, and the only thing that writes to it on this path is the person
  // filling in the Payment section. There is no second route, so there is
  // nothing for a duplicate guard to guard.
  assert.equal(/advance_amount/.test(rd('server', 'src', 'routes', 'invoices.js')), false,
    'the invoice save path does not read a proforma advance');
  assert.equal(/advance_amount/.test(rd('client', 'js', 'pages', 'payments.js')), false,
    'the payments module does not either');
});

// ═══ 7. Schema and migration ══════════════════════════════════════════

test('PA17 the migration is additive, guarded, listed, and matches schema.sql', () => {
  assert.match(MIG, /ADD COLUMN IF NOT EXISTS advance_amount NUMERIC\(14,2\)/);
  assert.match(MIG, /proforma_invoices_advance_amount_nonneg/);
  assert.match(MIG, /CHECK \(advance_amount IS NULL OR advance_amount >= 0\)/);
  const MIG_SQL = MIG.replace(/--[^\n]*/g, '');
  assert.equal(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/.test(MIG_SQL), false, 'nothing destructive, no backfill');
  assert.equal(/DEFAULT/.test(MIG_SQL), false, 'no DEFAULT: NULL means none quoted');

  const manifest = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));
  const order = Array.isArray(manifest) ? manifest : (manifest.order || manifest.migrations);
  assert.ok(order.includes(MIG_FILE), 'the runner knows about it');

  // schema.sql declares the same column and the same CHECK.
  assert.match(SCHEMA, /advance_amount NUMERIC\(14,2\)/);
  assert.match(SCHEMA, /CONSTRAINT proforma_invoices_advance_amount_nonneg/);

  // The prestart check that applies it on a deploy, pinned to this file.
  const runner = rd('server', 'scripts', 'migrate-proforma-advance.js');
  assert.match(runner, new RegExp("FILENAME = '" + MIG_FILE + "'"));
  const pkg = JSON.parse(rd('server', 'package.json'));
  assert.match(pkg.scripts.prestart, /migrate-proforma-advance\.js/);
  assert.strictEqual(pkg.scripts['migrate:proforma-advance'], 'node scripts/migrate-proforma-advance.js');
});

test('PA18 the column is writable through the save path, and judged there', () => {
  assert.match(GEN, /'advance_amount',/, 'the proforma allowlist carries it');
  assert.match(DOCS, /validateAdvanceAmount\(document\.advance_amount, document\.total_amount\)/);
  // Judged before anything is written, like every other refusal on this route.
  const fn = DOCS.slice(DOCS.indexOf('validateAdvanceAmount(document.advance_amount'));
  assert.ok(fn.indexOf('e.status = 400') > -1 && fn.indexOf('e.status = 400') < fn.indexOf('BEGIN'),
    'a bad advance is refused before the transaction');

  const v = require(path.join(ROOT, 'server', 'src', 'utils', 'validation.js'));
  assert.deepStrictEqual(v.validateAdvanceAmount('', 100000), { valid: true, value: null });
  assert.deepStrictEqual(v.validateAdvanceAmount(0, 100000), { valid: true, value: 0 });
  assert.deepStrictEqual(v.validateAdvanceAmount(25000, 100000), { valid: true, value: 25000 });
  assert.deepStrictEqual(v.validateAdvanceAmount(25000.555, 100000), { valid: true, value: 25000.56 });
  assert.strictEqual(v.validateAdvanceAmount(-1, 100000).valid, false);
  assert.strictEqual(v.validateAdvanceAmount(100000.01, 100000).valid, false);
  assert.strictEqual(v.validateAdvanceAmount('abc', 100000).valid, false);
});

// ═══ 8. Against a real database ═══════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('proforma advance persistence (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-advance-secret';

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
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (c) => { clearTimeout(done); reject(new Error('server exited ' + c + ':\n' + out)); });
  });
}

let server = null;
let BASE = '';
let USER = '';
let TOKEN = '';
const db = new Client({ connectionString: SCRATCH });

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes answer no body */ }
  return { status: res.status, body: json };
}
let docSeq = 0;
const docPayload = (extra) => ({
  document: {
    document_number: (extra && extra.document_number) || 'PI-ADV-' + String(++docSeq).padStart(3, '0'),
    document_date: '2026-10-17', customer_name: 'Advance Quote Co',
    state: 'Tamil Nadu', district: 'Coimbatore', supply_type: 'intrastate',
    taxable_amount: 84745.76, gst_percentage: 18, gst_amount: 15254.24,
    igst: 0, cgst: 7627.12, sgst: 7627.12, total_amount: 100000,
    ...(extra || {})
  },
  items: [{
    product_name: 'Machine', hsn_code: '84388090', unit: 'PCS', quantity: 1, rate: 84745.76,
    discount_percentage: 0, gst_percentage: 18, taxable_value: 84745.76, gst_amount: 15254.24,
    igst: 0, cgst: 7627.12, sgst: 7627.12, total_amount: 100000, sort_order: 0
  }]
});
const saveDoc = (extra) => api('POST', '/api/documents/proforma_invoice/save', docPayload(extra));
const storedAdvance = async (id) => (await db.query(
  'SELECT advance_amount FROM proforma_invoices WHERE id = $1', [id])).rows[0].advance_amount;

test('database setup', async () => {
  await db.connect();
  // The project's own migration, which adds the column IF NOT EXISTS, so a
  // scratch database that already has it is unchanged.
  await db.query(MIG);
  await db.query('TRUNCATE users CASCADE');
  const { rows } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('advance@scratch.test','x') RETURNING id");
  USER = rows[0].id;
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
     VALUES ($1,'VTECH','VTECH Engineering Works','33AAGCV4521K1ZT','Tamil Nadu','Coimbatore','14, Avinashi Road')`,
    [USER]);
  TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;
});

// (required test 3)
test('PA19 an advance survives saving, reloading and editing', async () => {
  const created = await saveDoc({ advance_amount: 25000 });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const id = created.body.document.id;
  assert.strictEqual(Number(await storedAdvance(id)), 25000);

  // Read back the way the edit screen reads it: loadProformaForEdit() selects
  // the row through the generic table endpoint, not through /documents.
  const reloaded = await api('GET', '/api/proforma_invoices?id=eq.' + id);
  assert.strictEqual(reloaded.status, 200, JSON.stringify(reloaded.body));
  const row = Array.isArray(reloaded.body) ? reloaded.body[0] : reloaded.body;
  assert.strictEqual(Number(row.advance_amount), 25000, 'the edit screen reads it back');

  // Edited to a new figure, and to none at all.
  const number = created.body.document.document_number;
  const edited = await api('POST', '/api/documents/proforma_invoice/save',
    { editId: id, ...docPayload({ advance_amount: 40000, document_number: number }) });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
  assert.strictEqual(Number(await storedAdvance(id)), 40000);

  const cleared = await api('POST', '/api/documents/proforma_invoice/save',
    { editId: id, ...docPayload({ advance_amount: null, document_number: number }) });
  assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
  assert.strictEqual(await storedAdvance(id), null, 'cleared back to none quoted');
});

// (required test 4, at the server)
test('PA20 the server refuses a negative advance and one above the total', async () => {
  const negative = await saveDoc({ advance_amount: -1 });
  assert.strictEqual(negative.status, 400);
  assert.match(negative.body.error.message, /cannot be negative/i);

  const over = await saveDoc({ advance_amount: 100000.01 });
  assert.strictEqual(over.status, 400);
  assert.match(over.body.error.message, /more than the quoted total/i);

  // Neither wrote a row.
  const { rows } = await db.query(
    'SELECT count(*)::int n FROM proforma_invoices WHERE user_id = $1 AND customer_name = $2',
    [USER, 'Advance Quote Co']);
  assert.strictEqual(rows[0].n, 1, 'only the one valid proforma from PA19 exists');

  // And the database itself refuses a negative, whatever reaches it.
  await assert.rejects(
    db.query('UPDATE proforma_invoices SET advance_amount = -5 WHERE user_id = $1', [USER]),
    /advance_amount_nonneg/);
});

// (required test 5, at the server)
test('PA21 a proforma saved without the field is stored as none quoted', async () => {
  const silent = await saveDoc({});
  assert.strictEqual(silent.status, 200, JSON.stringify(silent.body));
  assert.strictEqual(await storedAdvance(silent.body.document.id), null);

  const zero = await saveDoc({ advance_amount: 0 });
  assert.strictEqual(Number(await storedAdvance(zero.body.document.id)), 0, 'a typed 0 is kept as 0');
});

// (required test 8, at the server)
test('PA22 the GST columns and the transport charge are untouched by an advance', async () => {
  const saved = await saveDoc({ advance_amount: 25000, transport_charge: 1000 });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const { rows } = await db.query(
    `SELECT taxable_amount, gst_amount, igst, cgst, sgst, total_amount,
            transport_charge, transport_gst_amount, advance_amount
       FROM proforma_invoices WHERE id = $1`, [saved.body.document.id]);
  const r = rows[0];
  assert.strictEqual(Number(r.taxable_amount), 84745.76);
  assert.strictEqual(Number(r.gst_amount), 15254.24);
  assert.strictEqual(Number(r.cgst), 7627.12);
  assert.strictEqual(Number(r.sgst), 7627.12);
  assert.strictEqual(Number(r.total_amount), 100000);
  assert.strictEqual(Number(r.transport_charge), 1000, 'the delivery charge still stores');
  assert.strictEqual(Number(r.transport_gst_amount), 180, 'and its tax is still derived');
  assert.strictEqual(Number(r.advance_amount), 25000);
});

test('PA23 nothing was written to the advance tax tables', async () => {
  for (const t of ['receipt_vouchers', 'advance_adjustments']) {
    const exists = (await db.query('SELECT to_regclass($1) t', ['public.' + t])).rows[0].t;
    if (!exists) continue;
    const { rows } = await db.query(`SELECT count(*)::int n FROM ${t} WHERE user_id = $1`, [USER]);
    assert.strictEqual(rows[0].n, 0, t + ' must stay empty: a quotation is not a receipt');
  }
});

test('teardown', async () => {
  if (server) { server.kill(); await new Promise(r => server.on('exit', r)); }
  await db.end();
});
