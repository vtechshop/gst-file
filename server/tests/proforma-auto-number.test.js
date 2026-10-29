// Automatic / Manual numbering on a Proforma Invoice.
//
// The same two-mode control a tax invoice has, and for the same reasons:
// Automatic is what nearly every quotation uses and the server issues the
// number; Manual exists for taking over a book that started elsewhere, and is
// a decision about THIS quotation rather than a mode the business is left in.
//
// Three guarantees are worth more than the rest, so they are asserted from
// both ends - the browser's and the database's:
//
//   * a number the user typed is stored EXACTLY as typed, and a duplicate is
//     refused with a message rather than a 500;
//   * switching modes never silently overwrites a number being typed;
//   * a save that fails burns no number, because the number is issued inside
//     the transaction that writes the row.
//
// The browser half always runs. The DB half lives in
// proforma-auto-number-api.test.js, which needs a disposable database.
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
const INV_ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');
const PF_HTML = rd('proforma.html');
const INV_HTML = rd('invoice.html');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const INVOICES = rd('server', 'src', 'routes', 'invoices.js');
const CSS = rd('client', 'css', 'style.css');

// ── A browser-shaped sandbox ──────────────────────────────────────────
//
// Richer than the one in proforma-advance.test.js in one respect that matters
// here: it records attributes, because the mode switch sets and removes
// aria-readonly and tabindex and those are half of what it does.
const noop = () => {};
function mkEl(value) {
  return {
    value: value === undefined ? '' : value, textContent: '', innerHTML: '',
    disabled: false, checked: false, readOnly: false, style: {}, dataset: {},
    _attrs: {}, _focused: 0,
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); },
      toggle(c, on) {
        if (on === undefined) { this._c.has(c) ? this._c.delete(c) : this._c.add(c); }
        else { on ? this._c.add(c) : this._c.delete(c); }
      }
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    },
    addEventListener: noop, appendChild: noop,
    focus() { this._focused++; }
  };
}

const TOTALS_IDS = ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
  'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsAmountWords',
  'itemsTransportCharge', 'itemsTransportGst', 'itemsTransportRate',
  'itemsTransportNoteRow', 'itemsTransportNote'];
// The numbering block this feature adds.
const NUM_IDS = ['pfNumber', 'pfNumAuto', 'pfNumManual', 'pfNumNote'];
// Everything else the save path reads.
const OTHER_IDS = ['pfSaveBtn', 'pfStatus', 'pfGstCategory', 'pfAdvanceAmount',
  'pfAdvanceError', 'pfAdvanceSummary', 'pfSummaryTotal', 'pfSummaryAdvance',
  'pfSummaryBalance', 'pfCustName', 'pfDate', 'pfValidUntil'];

function load(opts) {
  const o = opts || {};
  const nextNumber = o.nextNumber === undefined ? 'PI-00007' : o.nextNumber;
  const store = new Map();
  for (const id of TOTALS_IDS.concat(NUM_IDS, OTHER_IDS)) store.set(id, mkEl());
  store.set('invSupply', mkEl('intrastate'));
  const el = mkEl();
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
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
  for (const pair of [['utils.js', UTILS], ['invoice-items.js', ITEMS],
    ['invoice-pdf.js', INV_PDF], ['proforma-pdf.js', PF_PDF], ['proforma-entry.js', PF_ENTRY]]) {
    vm.runInContext(pair[1], sb, { filename: pair[0] });
  }
  // Only the edges are stubbed. getProformaText and setProformaValue are
  // deliberately the page's own, so the DOM stub above is genuinely exercised
  // rather than bypassed.
  sb.__nextNumber = nextNumber;
  sb.__previewFails = !!o.previewFails;
  vm.runInContext([
    '__toasts = []; __calls = [];',
    'showToast = function (m, k) { __toasts.push({ m: m, k: k }); };',
    'getCurrentUser = async function () { return { id: "u1" }; };',
    'handleApiError = function (e, m) { __toasts.push({ m: m, k: "error" }); };',
    'buildProformaShipTo = function () { return {}; };',
    'buildProformaExport = function () { return {}; };',
    'if (typeof PROFORMA_STATUS_DEFAULT === "undefined") PROFORMA_STATUS_DEFAULT = "draft";',
    'if (typeof GST_CUSTOMER_CATEGORY_DEFAULT === "undefined") GST_CUSTOMER_CATEGORY_DEFAULT = "regular";',
    'apiFetch = async function (url, opts) {',
    '  __calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });',
    '  if (/next-number/.test(url)) {',
    '    if (__previewFails) throw new Error("preview down");',
    '    return { documentNumber: __nextNumber, series: "proforma_invoice", format: "PI-#####" };',
    '  }',
    // Nothing should reach this: the save issues the number now. A tripwire
    // rather than a working stub, so a reintroduced browser reservation fails
    // loudly instead of passing quietly.
    '  if (/reserve-number/.test(url)) throw new Error("saveProforma must not reserve a number");',
    '  var sent = opts && opts.body ? JSON.parse(opts.body) : {};',
    '  var num = (sent.document && sent.document.document_number) || "PI-ISSUED-BY-SERVER";',
    '  return { document: { id: "pf1", document_number: num }, items: [] };',
    '};',
    'itemsFormPrefix = "proforma";'
  ].join('\n'), sb);
  sb.__el = (id) => store.get(id);
  sb.__get = (expr) => vm.runInContext(expr, sb);
  sb.__run = (code) => vm.runInContext(code, sb);
  sb.__setItems = (rows) => vm.runInContext('currentItems = ' + JSON.stringify(rows) + ';', sb);
  return sb;
}

// setProformaNumberMode kicks the preview off without awaiting it, so a test
// that wants the result yields once.
const tick = () => new Promise((r) => setTimeout(r, 0));

function line(taxable) {
  const gst = taxable * 0.18;
  return {
    rowId: 'r' + taxable, product_id: 'p1', product_name: 'Machine', hsn_code: '84388090',
    unit: 'PCS', quantity: 1, rate: taxable, discount_percentage: 0, gst_percentage: 18,
    gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0,
    taxable_value: taxable, gst_amount: gst, igst: 0, cgst: gst / 2, sgst: gst / 2,
    total_amount: taxable + gst, sort_order: 0
  };
}

// ═══ 1. Automatic is the default ══════════════════════════════════════

test('N1 a new proforma opens on Automatic, with the number read-only', () => {
  const sb = load();
  sb.__get("setProformaNumberMode('auto')");
  assert.strictEqual(sb.__get('proformaNumberMode'), 'auto');
  assert.strictEqual(sb.__get('proformaNumberingIsManual()'), false);

  const auto = sb.__el('pfNumAuto');
  const man = sb.__el('pfNumManual');
  assert.ok(auto.classList.contains('active'), 'Auto is the selected button');
  assert.strictEqual(man.classList.contains('active'), false);
  assert.strictEqual(auto.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(man.getAttribute('aria-pressed'), 'false');

  const num = sb.__el('pfNumber');
  assert.strictEqual(num.readOnly, true, 'the preview must not be typed into');
  assert.strictEqual(num.getAttribute('aria-readonly'), 'true');
  assert.strictEqual(num.getAttribute('tabindex'), '-1', 'and is skipped by the Tab order');
});

test('N2 the markup ships on Automatic, so it is the default before any script runs', () => {
  assert.match(PF_HTML, /id="pfNumAuto"[^>]*class="active"[^>]*aria-pressed="true"/);
  assert.match(PF_HTML, /id="pfNumManual"[^>]*aria-pressed="false"/);
  const input = PF_HTML.match(/<input[^>]*id="pfNumber"[^>]*>/)[0];
  assert.match(input, /readonly/i);
  assert.match(input, /autocomplete="off"/,
    'a browser suggestion must never become a proforma number');
  // The old placeholder said "Auto". The switch says it now, and the note
  // below the box says what will happen.
  assert.match(PF_HTML, /id="pfNumNote"/);
  assert.strictEqual(/placeholder="Auto"/.test(input), false);
});

test('N3 the default is a constant, and the mode is never remembered', () => {
  assert.match(PF_ENTRY, /const PF_NUMBER_MODE_DEFAULT = 'auto';/);
  assert.match(PF_ENTRY, /let proformaNumberMode = 'auto';/);
  // Chosen per quotation, never stored on the profile, so nobody is left in a
  // mode they picked once.
  assert.strictEqual(/proforma_number_mode|numberModePreference/.test(PF_ENTRY), false,
    'the mode must not be persisted - the next new proforma opens on Auto');
});

// ═══ 2. The preview ═══════════════════════════════════════════════════

test('N4 Automatic shows the number the server says is next', async () => {
  const sb = load({ nextNumber: 'PI-00042' });
  await sb.__get('generateProformaNo()');
  assert.strictEqual(sb.__el('pfNumber').value, 'PI-00042');
  assert.strictEqual(sb.__el('pfNumNote').textContent, 'Issued automatically when you save.');
  const calls = sb.__get('__calls');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /\/documents\/proforma_invoice\/next-number/,
    'from the proforma book, named explicitly');
});

test('N5 the preview sends no body, so it cannot consume a number', async () => {
  const sb = load();
  await sb.__get('generateProformaNo()');
  assert.strictEqual(sb.__get('__calls')[0].body, null, 'a preview sends nothing');
  // And the consuming endpoint is not referenced by this page at all.
  assert.strictEqual(/reserve-number/.test(PF_ENTRY), false);
});

test('N6 a preview that fails blocks nothing and says so', async () => {
  const sb = load({ previewFails: true });
  await sb.__get('generateProformaNo()');
  assert.strictEqual(sb.__el('pfNumber').value, '',
    'better empty than a stale or invented number');
  assert.match(sb.__el('pfNumNote').textContent, /issued when you save/i);
});

// ═══ 3. Switching modes ═══════════════════════════════════════════════

test('N7 switching to Manual unlocks the box and keeps what is in it', async () => {
  const sb = load({ nextNumber: 'PI-00007' });
  await sb.__get('generateProformaNo()');
  assert.strictEqual(sb.__el('pfNumber').value, 'PI-00007');

  sb.__get("setProformaNumberMode('manual')");
  const num = sb.__el('pfNumber');
  assert.strictEqual(sb.__get('proformaNumberingIsManual()'), true);
  assert.strictEqual(num.readOnly, false, 'Manual is the only typeable mode');
  assert.strictEqual(num.getAttribute('aria-readonly'), null);
  assert.strictEqual(num.getAttribute('tabindex'), null, 'and it rejoins the Tab order');
  assert.strictEqual(num.value, 'PI-00007',
    'the preview is the starting point, so a correction is an edit not a retype');
  assert.ok(num._focused > 0, 'the cursor is put in the box');
  assert.match(sb.__el('pfNumNote').textContent, /Typed by you/);
});

test('N8 switching to Manual never fetches, and a preview never overwrites a typed number',
  async () => {
    const sb = load();
    sb.__get("setProformaNumberMode('manual')");
    sb.__el('pfNumber').value = 'LEGACY/2026/0918';

    // Each of these must leave the typed number alone.
    sb.__get("setProformaNumberMode('manual')");
    await sb.__get('generateProformaNo()');
    await tick();

    assert.strictEqual(sb.__el('pfNumber').value, 'LEGACY/2026/0918',
      'a preview must never overwrite a number being typed by hand');
    assert.strictEqual(sb.__get('__calls').length, 0,
      'and must not even ask, so nothing is consumed either');
  });

test('N9 switching back to Automatic on a NEW proforma re-previews', async () => {
  const sb = load({ nextNumber: 'PI-00007' });
  sb.__get("setProformaNumberMode('manual')");
  sb.__el('pfNumber').value = 'TYPED-1';
  sb.__get("setProformaNumberMode('auto')");
  await tick();
  assert.strictEqual(sb.__el('pfNumber').value, 'PI-00007',
    'Automatic means "the next one from the server" on a new quotation');
  assert.strictEqual(sb.__el('pfNumber').readOnly, true);
});

test('N10 switching back to Automatic on a SAVED proforma restores its own number', async () => {
  const sb = load();
  sb.__run("proformaEditId = 'pf1'; proformaEditNumber = 'PI-00003';");
  sb.__get("setProformaNumberMode('manual')");
  sb.__el('pfNumber').value = 'PI-00003-HALF-TYPED';
  sb.__get("setProformaNumberMode('auto')");
  await tick();

  assert.strictEqual(sb.__el('pfNumber').value, 'PI-00003',
    'an abandoned correction returns the number it was issued');
  assert.strictEqual(sb.__get('__calls').length, 0,
    'and NEVER fetches a fresh one - that would renumber an offer already sent');
  assert.match(sb.__el('pfNumNote').textContent, /Keeping the number/);
});

test('N11 the note tells the truth in all four states', () => {
  const sb = load();
  const note = () => sb.__el('pfNumNote').textContent;

  sb.__run('proformaEditId = null;');
  sb.__get("setProformaNumberMode('auto')");
  assert.match(note(), /Issued automatically/);
  sb.__get("setProformaNumberMode('manual')");
  assert.match(note(), /Typed by you/);

  sb.__run("proformaEditId = 'pf1'; proformaEditNumber = 'PI-9';");
  sb.__get("setProformaNumberMode('auto')");
  assert.match(note(), /Keeping the number/);
  sb.__get("setProformaNumberMode('manual')");
  assert.match(note(), /must stay unique/);
});

// ═══ 4. What the save sends ═══════════════════════════════════════════

async function saveWith(sb, opts) {
  const o = opts || {};
  sb.__setItems([line(10000)]);
  sb.__el('pfCustName').value = 'Numbering Quote Co';
  sb.__el('pfDate').value = '2026-10-29';
  if (o.editId) sb.__run('proformaEditId = ' + JSON.stringify(o.editId) + ';');
  if (o.editNumber !== undefined) {
    sb.__run('proformaEditNumber = ' + JSON.stringify(o.editNumber) + ';');
  }
  sb.__get("setProformaNumberMode('" + (o.mode || 'auto') + "')");
  await tick();
  if (o.typed !== undefined) sb.__el('pfNumber').value = o.typed;
  await sb.__get('saveProforma()');
  const saves = sb.__get('__calls').filter((c) => /\/save$/.test(c.url));
  return {
    sent: saves.length ? saves[0].body : null,
    toasts: sb.__get('__toasts'),
    number: sb.__el('pfNumber').value
  };
}

test('N12 on Automatic the number is not sent at all', async () => {
  const sb = load();
  const r = await saveWith(sb, { mode: 'auto' });
  assert.ok(r.sent, 'the save was sent');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(r.sent.document, 'document_number'), false,
    'the preview may be stale, so sending it would turn a courtesy into a claim');
});

test('N13 on Manual the typed number is sent exactly as typed', async () => {
  for (const typed of ['PI-00123', 'LEGACY/2026/0918', 'pi-lower-99', 'PI 00007']) {
    const sb = load();
    const r = await saveWith(sb, { mode: 'manual', typed });
    assert.strictEqual(r.sent.document.document_number, typed,
      'the exact valid custom number must be preserved: ' + typed);
  }
});

test('N14 a blank Manual number is refused on the page, and nothing is sent', async () => {
  for (const blank of ['', '   ']) {
    const sb = load();
    const r = await saveWith(sb, { mode: 'manual', typed: blank });
    assert.strictEqual(r.sent, null, 'no save request at all');
    assert.ok(r.toasts.some((t) => /Enter a proforma number/i.test(t.m)),
      'the reason is said: ' + JSON.stringify(r.toasts));
    assert.ok(sb.__el('pfNumber')._focused > 0, 'and the cursor goes to the box');
  }
});

test('N15 editing on Automatic sends no number, so the stored one cannot be touched', async () => {
  const sb = load();
  const r = await saveWith(sb, { mode: 'auto', editId: 'pf1', editNumber: 'PI-00003' });
  assert.ok(r.sent, 'the save was sent');
  assert.strictEqual(r.sent.editId, 'pf1');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(r.sent.document, 'document_number'), false,
    'absent from the payload means absent from the UPDATE');
});

test('N16 editing on Manual sends the correction', async () => {
  const sb = load();
  const r = await saveWith(sb, {
    mode: 'manual', typed: 'PI-00025', editId: 'pf1', editNumber: 'PI-00003'
  });
  assert.strictEqual(r.sent.editId, 'pf1');
  assert.strictEqual(r.sent.document.document_number, 'PI-00025');
});

test('N17 after a first save the page is editing, and Automatic now means "keep this"', async () => {
  const sb = load();
  const r = await saveWith(sb, { mode: 'manual', typed: 'PI-00077' });
  assert.strictEqual(r.sent.document.document_number, 'PI-00077');

  assert.strictEqual(sb.__get('proformaEditId'), 'pf1', 'the page learned the id');
  assert.strictEqual(sb.__get('proformaEditNumber'), 'PI-00077',
    'and the number it now holds, so Auto can mean "keep this"');

  // The bug this pins: without recording it, switching to Auto would restore
  // a proformaEditNumber that was still null and blank the box.
  sb.__get("setProformaNumberMode('auto')");
  await tick();
  assert.strictEqual(sb.__el('pfNumber').value, 'PI-00077');
  assert.strictEqual(sb.__get('__calls').filter((c) => /next-number/.test(c.url)).length, 0,
    'and must not fetch a fresh number for a quotation that now exists');
});

// ═══ 5. Reusing the invoice's own pattern ═════════════════════════════

test('N18 the control is the invoice control, not a second one', () => {
  for (const html of [INV_HTML, PF_HTML]) {
    assert.match(html, /class="iv-typeswitch" role="group"/);
  }
  assert.match(PF_HTML, /aria-label="Proforma numbering"/);
  assert.match(INV_HTML, /aria-label="Invoice numbering"/);

  // The same CSS, by selector extension rather than a copied block.
  assert.match(CSS, /\.inv-page \.iv-typeswitch,\s*\r?\n\.pf-page \.iv-typeswitch \{/);
  assert.match(PF_HTML, /class="content pf-page"/,
    'the proforma page needs the scope those rules are written for');
  // The declarations exist once. Two copies would drift.
  assert.strictEqual((CSS.match(/\n\.pf-page \.iv-typeswitch \{/g) || []).length, 1);
});

test('N18b the switch lives outside the invoice-only section, and its tokens agree', () => {
  // The New Invoice section is scoped to .inv-page and invoice-page-ui.test.js
  // (IP4) holds it to that, which is what stops the invoice page's styles
  // leaking. A genuinely shared control therefore cannot live inside it.
  const invStart = CSS.indexOf('New Invoice page (invoice.html)');
  const invEnd = CSS.indexOf('/* end New Invoice page */');
  assert.ok(invStart > -1 && invEnd > invStart);
  assert.strictEqual(CSS.slice(invStart, invEnd).includes('pf-page'), false,
    'the invoice-only section must contain no .pf-page selector');
  assert.ok(CSS.indexOf('.pf-page .iv-typeswitch {') > invEnd,
    'the shared switch belongs after that section');

  // .pf-page carries its own copy of the four tokens the switch reads, so the
  // two copies must not drift. Compared value by value rather than trusted.
  const blockOf = (selector) => {
    const at = CSS.indexOf('\n' + selector + ' {');
    assert.ok(at > -1, 'no block for ' + selector);
    return CSS.slice(at, CSS.indexOf('\n}', at));
  };
  const tokenIn = (block, name) => {
    const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(block);
    assert.ok(m, name + ' missing');
    return m[1].trim();
  };
  const SHARED = ['iv-card-border', 'iv-panel', 'iv-muted', 'iv-ink'];
  for (const [inv, pf] of [
    ['.inv-page', '.pf-page'],
    [':root[data-theme="dark"] .inv-page', ':root[data-theme="dark"] .pf-page']
  ]) {
    const a = blockOf(inv);
    const b = blockOf(pf);
    for (const t of SHARED) {
      assert.strictEqual(tokenIn(b, t), tokenIn(a, t),
        '--' + t + ' must match between ' + inv + ' and ' + pf);
    }
  }
});

test('N19 the proforma mode functions mirror the invoice ones', () => {
  const mirrored = [
    [INV_ENTRY, ['setInvoiceNumberMode', 'invoiceNumberingIsManual', 'generateInvoiceNo']],
    [PF_ENTRY, ['setProformaNumberMode', 'proformaNumberingIsManual', 'generateProformaNo']]
  ];
  for (const [src, fns] of mirrored) {
    for (const fn of fns) assert.ok(src.includes(fn), fn + ' must exist');
  }
});

// ═══ 6. Invoice numbering is untouched ════════════════════════════════

test('N20 nothing here touches the tax invoice numbering', () => {
  // The proforma book is a document series; an invoice counts per
  // invoice_source. Separate columns, separate functions, separate routes.
  assert.match(DOCS, /document_series_sequences/);
  assert.strictEqual(/invoice_current_sequence|invoice_series_sequences/.test(DOCS), false,
    'documents.js must never read or move an invoice counter');
  assert.match(INVOICES, /invoice_current_sequence/);
  assert.strictEqual(/document_series_sequences/.test(INVOICES), false,
    'invoices.js must never read or move a document counter');

  // And the proforma page cannot reach the invoice numbering endpoints.
  assert.strictEqual(/\/invoices\/next-number|\/invoices\/reserve-number/.test(PF_ENTRY), false,
    'a proforma must not consume a tax invoice number');
});

test('N21 only the proforma type opts in to automatic numbering', () => {
  // A blank number still means "a mistake" for every other book, each of
  // which is written by a page that reserves its number first. E16/E17 in
  // proforma-number-edit-api.test.js hold that line for bill_of_supply and
  // the challans; this asserts the opt-in itself is narrow.
  const map = DOCS.slice(DOCS.indexOf('const DOCUMENT_TABLES = {'));
  const body = map.slice(0, map.indexOf('\n};'));
  assert.strictEqual((body.match(/autoNumber: true/g) || []).length, 1,
    'exactly one document type may number itself automatically today');
  const pf = body.slice(body.indexOf('proforma_invoice: {'));
  assert.match(pf.slice(0, pf.indexOf('},')), /autoNumber: true/,
    'and it is the proforma');
});
