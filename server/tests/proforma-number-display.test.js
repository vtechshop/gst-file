// Showing existing Proforma numbers under the configured format, and sorting
// the list by the number rather than by the date.
//
// A document_number is free text in the database: it holds whatever was
// issued or typed at the time. One book can therefore hold several shapes at
// once - PI-00165 issued under today's format, a bare 165 typed by hand or
// issued when the format was a plain number, and the occasional free-form
// one. The list, the PDF and the print view want them to read consistently
// under the format configured now.
//
// Two things make that safe rather than destructive, and they are what this
// file is really about:
//
//   1. It is a DRAWING change. No stored document_number is rewritten, and
//      the one input that round-trips to the database - the Proforma Entry
//      number box - is deliberately left holding the stored value.
//   2. The sequence is read out of the number FIRST and the format applied to
//      that, so passing an already-formatted number through cannot add a
//      second prefix.
//
// Everything here runs with no database and no browser: the rules are pure,
// and the wiring is read out of the source the pages actually load.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const UTILS = rd('client', 'js', 'utilities', 'utils.js');
const PROFILE = rd('client', 'js', 'pages', 'profile.js');
const LIST = rd('client', 'js', 'pages', 'proforma-list.js');
const PDF = rd('client', 'js', 'pages', 'proforma-pdf.js');
const ENTRY = rd('client', 'js', 'pages', 'proforma-entry.js');
const LIST_HTML = rd('proforma-list.html');
const PF_HTML = rd('proforma.html');

const srv = require('../src/utils/invoiceNumberFormat');

// Comments stripped, for assertions that must see CODE rather than the prose
// explaining it - several of these files document what they deliberately do
// NOT do.
const nocomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');

// ── The browser copy of the rules ─────────────────────────────────────
function clientApi() {
  const noop = () => {};
  const sb = {
    console, Math, String, Number, parseInt, parseFloat, isNaN, isFinite, Date,
    JSON, RegExp, Object, Array, Intl, Set, Map, Error,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => ({ style: {} }),
      body: {}, head: {}, documentElement: { style: {} }
    },
    navigator: { userAgent: 'node' },
    location: { hostname: 'localhost', href: '', search: '' },
    setTimeout, clearTimeout
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('shared', 'india-districts.js'), sb);
  vm.runInContext(UTILS + ';globalThis.__F = { formatDocumentNumberForDisplay,'
    + ' documentNumberSequence, compareDocumentNumberDesc, sequenceFromInvoiceNumber,'
    + ' applyInvoiceNumberFormat, numberFormatProblem };', sb);
  return sb.__F;
}
const C = clientApi();
const shown = (stored, fmt) => C.formatDocumentNumberForDisplay(stored, fmt);

// ═══ 1. Existing numbers under the saved format ═══════════════════════

test('D1 existing bare numbers read under the configured format', () => {
  // The worked example from the request, through the same formatter that
  // issues a real number rather than a second implementation of it.
  const cases = [['165', 'PI-00165'], ['166', 'PI-00166'], ['167', 'PI-00167'],
                 ['168', 'PI-00168'], ['169', 'PI-00169'], ['256', 'PI-00256']];
  for (const [stored, want] of cases) {
    assert.strictEqual(shown(stored, 'PI-#####'), want, stored + ' must read as ' + want);
  }
  // Nothing about PI- is baked in: the saved format decides.
  assert.strictEqual(shown('165', 'QT/2026/###'), 'QT/2026/165');
  assert.strictEqual(shown('165', 'Q-####'), 'Q-0165');
  assert.strictEqual(shown('7', 'PI-#####'), 'PI-00007');
});

test('D2 a plain numeric format shows the number plainly', () => {
  // applyInvoiceNumberFormat's documented bare-number branch: a format that
  // is itself digits prints the sequence alone, so a shop issuing 138, 139
  // keeps seeing exactly that.
  for (const stored of ['138', '139', '256']) {
    assert.strictEqual(shown(stored, '25'), stored);
  }
  // And a format with no # at all appends, as that branch documents.
  assert.strictEqual(shown('165', 'INV'), 'INV-165');
  assert.strictEqual(shown('165', 'QT/2026'), 'QT/2026-165');
});

test('D3 formatting happens exactly once - no double prefix', () => {
  // The guarantee that makes this safe to apply to a mixed book: the sequence
  // is read out first, so a number already in the format is unchanged.
  assert.strictEqual(shown('PI-00165', 'PI-#####'), 'PI-00165');
  // Twice, three times - same answer. Idempotent by construction.
  let v = '165';
  for (let i = 0; i < 5; i++) v = shown(v, 'PI-#####');
  assert.strictEqual(v, 'PI-00165', 'repeated drawing must not accumulate prefixes');
  assert.strictEqual(/PI-PI|PI-00PI/.test(v), false, 'and must never double the prefix');
  // Padding is normalised rather than doubled: PI-165 is the same number.
  assert.strictEqual(shown('PI-165', 'PI-#####'), 'PI-00165');
  // Changing the format re-draws from the STORED value, which is the only
  // thing any caller ever passes: the list and the PDF both draw from
  // row.document_number, never from a string they drew earlier.
  assert.strictEqual(shown('165', 'QT/###'), 'QT/165');

  // And handed a number belonging to some OTHER format, it leaves it alone
  // rather than guessing a sequence out of it. That is why chaining cannot
  // accumulate text even if a caller ever did it by mistake.
  assert.strictEqual(shown('PI-00165', 'QT/###'), 'PI-00165');
  assert.strictEqual(/QT\/PI|PI-QT/.test(shown('PI-00165', 'QT/###')), false,
    'two formats must never be stacked on one number');
});

test('D4 an unusable format changes nothing and is reported', () => {
  // Invalid formats, each refused by numberFormatProblem. The stored value is
  // shown exactly as it is - substituting a default would put numbers on
  // screen that the book never issued.
  for (const bad of ['', '   ', 'PI-###/###', 'x'.repeat(41), 'PI-\n###']) {
    assert.ok(C.numberFormatProblem(bad), JSON.stringify(bad) + ' precondition: invalid');
    assert.strictEqual(shown('165', bad), '165',
      'an invalid format must leave the stored number alone');
    assert.strictEqual(shown('PI-00165', bad), 'PI-00165');
  }
  // A format with NO # is deliberately valid in this codebase - the formatter
  // has a documented branch for it - so it is not reported as broken.
  assert.strictEqual(C.numberFormatProblem('INV'), null);

  // The list says so once, above the rows, and says the numbers are the
  // stored ones. It does not correct or overwrite the saved format.
  assert.match(LIST, /function renderProformaFormatNotice\(\)/);
  assert.match(LIST, /cannot be used/);
  assert.match(LIST, /shown exactly as they are stored/);
  assert.match(LIST_HTML, /id="pfFormatNotice"/);
  const notice = LIST.slice(LIST.indexOf('function renderProformaFormatNotice'));
  const body = notice.slice(0, notice.indexOf('\nfunction renderProformaPagination'));
  assert.strictEqual(/saveUserProfile|document_series_formats\s*=/.test(body), false,
    'the notice must not write the format it is complaining about');
});

test('D5 a number no rule can read is shown exactly as stored', () => {
  // Only two shapes are read: the configured format, and a bare number. A
  // legacy number with more than one run of digits is ambiguous - PI/2026/165
  // could mean 2026 or 165 - so it is drawn as it is rather than guessed at.
  for (const stored of ['SPECIAL/2026', 'PI/2026/165', 'QT-12-34', 'abc', '0', '-5', '1.5']) {
    assert.strictEqual(shown(stored, 'PI-#####'), stored,
      stored + ' must be shown as stored');
  }
  assert.strictEqual(shown('', 'PI-#####'), '');
  assert.strictEqual(shown(null, 'PI-#####'), '');
  assert.strictEqual(shown(undefined, 'PI-#####'), '');
  // Whitespace is trimmed for display, not interpreted.
  assert.strictEqual(shown('  165  ', 'PI-#####'), 'PI-00165');
});

test('D6 the browser and the server read a number out of a format identically', () => {
  // sequenceFromInvoiceNumber is the inverse the whole feature rests on, and
  // it now exists in both runtimes. A test over the same cases, so the copy
  // the browser draws with cannot drift from the server's.
  const cases = [];
  for (const fmt of ['PI-#####', 'QT/2026/###', '25', 'INV', 'PI-###']) {
    for (const num of ['165', 'PI-00165', 'PI-165', 'QT/2026/165', 'INV-165',
      'SPECIAL/2026', '', '0', 'pi-00165']) {
      cases.push([fmt, num]);
    }
  }
  for (const [fmt, num] of cases) {
    assert.strictEqual(C.sequenceFromInvoiceNumber(fmt, num), srv.sequenceFromInvoiceNumber(fmt, num),
      'the two copies disagree about ' + JSON.stringify([fmt, num]));
  }
});

// ═══ 2. Number-wise sorting ═══════════════════════════════════════════

const row = (n, date) => ({ document_number: n, document_date: date || '2026-01-01' });
const order = (nums, fmt) => nums.map(n => row(n))
  .sort((a, b) => C.compareDocumentNumberDesc(a, b, fmt || 'PI-#####'))
  .map(r => r.document_number);

test('D7 the list sorts by the number, numerically, highest first', () => {
  assert.deepStrictEqual(order(['165', '169', '256', '166', '167', '168']),
    ['256', '169', '168', '167', '166', '165'], 'the order the request asks for');
});

test('D8 numeric, not lexicographic - 9, 10, 99, 100, 256', () => {
  // The case that tells the two apart: as strings, "99" sorts above "256"
  // and "9" above "10". As numbers it is the other way round.
  assert.deepStrictEqual(order(['9', '10', '99', '100', '256']),
    ['256', '100', '99', '10', '9']);
  // A string sort would have produced this, so the test is not vacuous.
  assert.deepStrictEqual(['9', '10', '99', '100', '256'].slice()
    .sort((a, b) => b.localeCompare(a)), ['99', '9', '256', '100', '10']);
  // Mixed shapes sort on the sequence each one yields, not on its text.
  assert.deepStrictEqual(order(['PI-00009', '10', 'PI-00256', '99']),
    ['PI-00256', '99', '10', 'PI-00009']);
});

test('D9 a number that cannot be read sorts last, never first', () => {
  // A legacy or free-form number must not be silently promoted to the top of
  // a list whose whole point is "the newest offer first".
  assert.deepStrictEqual(order(['165', 'SPECIAL/2026', '256', 'PI/2026/7']),
    ['256', '165', 'SPECIAL/2026', 'PI/2026/7']);
  // Among themselves: newest first.
  const rows = [row('SPECIAL/A', '2026-01-01'), row('SPECIAL/B', '2026-06-01')];
  assert.deepStrictEqual(
    rows.slice().sort((a, b) => C.compareDocumentNumberDesc(a, b, 'PI-#####'))
      .map(r => r.document_number), ['SPECIAL/B', 'SPECIAL/A']);
});

test('D10 equal numbers fall back to the date, then to the stored text', () => {
  // Deterministic rather than dependent on the order the rows arrived in.
  const rows = [row('165', '2026-01-01'), row('PI-00165', '2026-09-01')];
  assert.deepStrictEqual(
    rows.slice().sort((a, b) => C.compareDocumentNumberDesc(a, b, 'PI-#####'))
      .map(r => r.document_date), ['2026-09-01', '2026-01-01']);
  // Stable: sorting an already-sorted list does not reshuffle it.
  const many = ['256', '169', '168', '167', '166', '165'];
  assert.deepStrictEqual(order(order(many)), order(many));
});

test('D11 with an unusable format the list still sorts, by date', () => {
  // No sequence can be read from anything, so nothing is parseable and the
  // date tiebreak carries the whole order. The list must not throw or come
  // back empty because the format is wrong.
  const rows = [row('165', '2026-01-01'), row('256', '2026-09-01'), row('169', '2026-05-01')];
  const out = rows.slice().sort((a, b) => C.compareDocumentNumberDesc(a, b, 'PI-###/###'))
    .map(r => r.document_date);
  assert.deepStrictEqual(out, ['2026-09-01', '2026-05-01', '2026-01-01']);
});

test('D12 the list is wired to that comparator, and no longer to the date alone', () => {
  assert.match(LIST, /compareDocumentNumberDesc\(a, b, proformaDisplayFormat\(\)\)/,
    'the rows must be ordered by the number');
  assert.strictEqual(
    /sort\(\(a, b\) => String\(b\.document_date\)\.localeCompare\(String\(a\.document_date\)\)\)/.test(LIST),
    false, 'the old date-only sort must be gone');
  // The format is loaded before the first row is drawn, or the first render
  // would sort and draw with nothing.
  const init = LIST.slice(LIST.indexOf('async function initProformaList'));
  const body = init.slice(0, init.indexOf('\nasync function loadProformas'));
  const ensureAt = body.indexOf('ensureProformaDisplayFormat()');
  const loadAt = body.indexOf('loadProformas(user.id)');
  assert.ok(ensureAt > 0 && loadAt > ensureAt, 'the format is loaded before the rows');
});

// ═══ 3. Search, filters and pagination ════════════════════════════════

test('D13 search matches the number as shown and as stored', () => {
  // A row stored as a bare 165 is on screen as PI-00165, so both have to
  // find it - otherwise the list would show a number that cannot be searched.
  const fn = LIST.slice(LIST.indexOf('function proformaMatchesFilters'));
  const body = fn.slice(0, fn.indexOf('\nfunction proformaStatusBadge'));
  assert.match(body, /String\(row\.document_number \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/,
    'the stored number still matches');
  assert.match(body, /proformaDisplayNumber\(row\.document_number\)\.toLowerCase\(\)\.includes\(q\)/,
    'and so does the number on screen');
  assert.match(body, /customer_name/, 'customer search is untouched');
  // The status filter is untouched.
  assert.match(body, /proformaEffectiveStatus\(row\) !== want/);
});

test('D14 filtering and pagination still run over the sorted rows', () => {
  // Order of operations: sort once on load, then filter, then slice the page.
  // A filter must not reorder, and a page must not be cut before sorting.
  const fn = LIST.slice(LIST.indexOf('function renderProformaList'));
  const body = fn.slice(0, fn.indexOf('\n// Said once, above the list'));
  const filterAt = body.indexOf('proformaRows.filter(proformaMatchesFilters)');
  const sliceAt = body.indexOf('rows.slice(start, start + PROFORMA_PAGE_SIZE)');
  assert.ok(filterAt > 0 && sliceAt > filterAt, 'filter, then page');
  assert.match(body, /renderProformaPagination\(rows\.length\)/,
    'pagination still counts the filtered rows');
  assert.strictEqual(/\.sort\(/.test(body), false,
    'rendering must not re-sort - the order is set once on load');
});

// ═══ 4. The PDF and print view ════════════════════════════════════════

test('D15 the PDF draws the number the same way the list does', () => {
  const code = nocomment(PDF);
  assert.match(code, /invoice_number: typeof proformaDisplayNumber === 'function'/,
    'the renderable number goes through the shared helper');
  assert.match(code, /proformaDisplayNumber\(row\.document_number\)/);
  assert.match(code, /\(row\.document_number \|\| ''\)/,
    'and falls back to the stored value if the helper is not loaded');
  // The filename carries the same number, so a saved file matches the list.
  assert.match(code, /const shownNumber = typeof proformaDisplayNumber === 'function'/);
  assert.match(code, /Proforma_\$\{shownNumber \|\| row\.id\.slice\(0, 8\)\}\.pdf/);
  // A PDF can be asked for before any list has been drawn, so the format is
  // made sure of rather than assumed.
  assert.match(code, /await ensureProformaDisplayFormat\(\)/);
  // Both pages that can produce this PDF load the helper that supplies it.
  for (const page of ['proforma.html', 'proforma-list.html']) {
    const html = rd(page);
    assert.match(html, /client\/js\/pages\/profile\.js\?v=\d+/, page + ' must load profile.js');
    assert.match(html, /client\/js\/utilities\/utils\.js\?v=\d+/, page + ' must load utils.js');
  }
});

// ═══ 5. Nothing is rewritten ══════════════════════════════════════════

test('D16 the Entry number box keeps the STORED value, because it is saved', () => {
  // The one place a drawn number would become a written one. In Manual mode
  // the save sends this box, so a reformatted value here would rewrite a
  // number already issued - the thing this whole change must not do.
  const code = nocomment(ENTRY);
  assert.match(code, /setProformaValue\('pfNumber', rec\.document_number\);/,
    'the box must be filled from the stored column, unformatted');
  assert.strictEqual(/setProformaValue\('pfNumber', proformaDisplayNumber/.test(code), false,
    'the box must never be filled with a drawn number');
  assert.strictEqual(/proformaEditNumber = proformaDisplayNumber/.test(code), false,
    'nor the remembered number');
  assert.match(code, /proformaEditNumber = rec\.document_number \|\| '';/);

  // The save still sends the box itself, and only in Manual mode.
  assert.match(code, /proformaNumberingIsManual\(\) \? \{ document_number: getProformaText\('pfNumber'\) \} : \{\}/,
    'the save payload is unchanged');

  // The formatted reading lives in its own note, beside the box.
  assert.match(code, /function showProformaNumberFormatted\(/);
  assert.match(PF_HTML, /id="pfNumFormatted"/);
  const note = code.slice(code.indexOf('async function showProformaNumberFormatted'));
  const body = note.slice(0, note.indexOf('\n}') + 2);
  assert.match(body, /el\.textContent = 'Shown elsewhere as '/);
  assert.strictEqual(/setProformaValue|pfNumber/.test(body), false,
    'the note must not touch the number box');
});

test('D17 no display path writes a document number anywhere', () => {
  // The whole feature is a drawing change. Nothing in it may update, insert
  // or save a document_number.
  for (const [name, src] of [['proforma-list.js', LIST], ['proforma-pdf.js', PDF],
    ['utils.js display helpers', UTILS]]) {
    const code = nocomment(src);
    assert.strictEqual(/document_number:\s*(proformaDisplayNumber|formatDocumentNumberForDisplay|shownNumber)/.test(code),
      false, name + ' must never write a drawn number');
  }
  // The list reads and draws; it does not update rows.
  assert.strictEqual(/from\('proforma_invoices'\)[\s\S]{0,80}\.update\(/.test(LIST), false,
    'the list must not update proforma rows');
  // The pure helpers take a value and return a string - they hold no state
  // and reach nothing.
  for (const fn of ['formatDocumentNumberForDisplay', 'documentNumberSequence']) {
    const at = UTILS.indexOf('function ' + fn + '(');
    assert.ok(at > 0, fn + ' must exist');
    const body = UTILS.slice(at, UTILS.indexOf('\n}', at));
    assert.strictEqual(/_supabase|apiFetch|fetch\(|localStorage|document\./.test(body), false,
      fn + ' must be pure');
  }
});

test('D18 the tax invoice series is not touched', () => {
  // A proforma drawing change must not reach invoice numbering, and importing
  // a quotation into an invoice must not carry the quotation's number across.
  for (const col of ['invoice_number_format', 'invoice_current_sequence',
    'invoice_series_formats', 'invoice_series_sequences']) {
    assert.strictEqual(LIST.includes(col), false, 'proforma-list.js must not mention ' + col);
    assert.strictEqual(PDF.includes(col), false, 'proforma-pdf.js must not mention ' + col);
  }
  const imp = LIST.slice(LIST.indexOf('function importProformaIntoInvoice'));
  const body = imp.slice(0, imp.indexOf('\nasync function cancelProforma'));
  assert.strictEqual(/document_number|invoice_number/.test(body), false,
    'importing into an invoice must not carry the proforma number');
});

test('D19 the drawing format is read, never written', () => {
  // profile.js caches the configured format for the renderers. That path must
  // read the book and nothing more - no save, and no counter movement.
  const at = PROFILE.indexOf('let _proformaDisplayFormat = null;');
  assert.ok(at > 0, 'the cache must exist');
  const body = PROFILE.slice(at, PROFILE.indexOf('// The live example', at));
  const code = nocomment(body);
  assert.match(code, /await fetchProformaNumbering\(\)/,
    'it reads the same non-consuming endpoint the Settings card reads');
  assert.strictEqual(/saveUserProfile|number-settings|method: 'POST'/.test(code), false,
    'and writes nothing');
  // A format that could not be loaded leaves every number drawn as stored.
  assert.match(code, /book\.unavailable \? null/);
  assert.match(code, /if \(!fmt\) return String\(stored == null \? '' : stored\)\.trim\(\)/);
});

// ═══ 6. Cache keys and mirrors ════════════════════════════════════════

test('D20 every changed asset carries a new cache key', () => {
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  // utils.js and profile.js are shared and must move together: profile.js now
  // calls formatDocumentNumberForDisplay() from utils.js, and proforma-list.js
  // calls compareDocumentNumberDesc() from it.
  const withProfile = pages.filter(f => rd(f).includes('client/js/pages/profile.js'));
  assert.ok(withProfile.length >= 38, 'expected the shared pair on many pages');
  for (const f of withProfile) {
    const html = rd(f);
    assert.ok(html.includes('client/js/utilities/utils.js?v=36'), f + ' must load utils.js at v=36');
    assert.ok(html.includes('client/js/pages/profile.js?v=43'), f + ' must load profile.js at v=43');
    assert.strictEqual(html.includes('utils.js?v=35'), false, f + ' still has the old utils key');
    assert.strictEqual(html.includes('profile.js?v=42'), false, f + ' still has the old profile key');
  }
  // The three proforma scripts, on the pages that load each.
  for (const [file, want] of [['client/js/pages/proforma-list.js', 32],
                              ['client/js/pages/proforma-pdf.js', 45],
                              ['client/js/pages/proforma-entry.js', 46]]) {
    const loaders = pages.filter(f => rd(f).includes(file));
    assert.ok(loaders.length >= 1, file + ' must be loaded somewhere');
    for (const f of loaders) {
      assert.ok(rd(f).includes(file + '?v=' + want), f + ' must load ' + file + ' at v=' + want);
    }
  }
  // The functions those keys exist for really are in the files served.
  assert.match(UTILS, /function formatDocumentNumberForDisplay\(/);
  assert.match(UTILS, /function compareDocumentNumberDesc\(/);
  assert.match(PROFILE, /async function ensureProformaDisplayFormat\(/);
});

test('D21 server/public mirrors every changed file byte for byte', () => {
  for (const rel of [
    ['client', 'js', 'utilities', 'utils.js'],
    ['client', 'js', 'pages', 'profile.js'],
    ['client', 'js', 'pages', 'proforma-list.js'],
    ['client', 'js', 'pages', 'proforma-pdf.js'],
    ['client', 'js', 'pages', 'proforma-entry.js'],
    ['proforma.html'],
    ['proforma-list.html']
  ]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel));
    const pub = fs.readFileSync(path.join(ROOT, 'server', 'public', ...rel));
    assert.ok(src.equals(pub), rel.join('/') + ' differs from its server/public mirror');
  }
});
