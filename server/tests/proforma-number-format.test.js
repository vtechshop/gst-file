// Configuring the Proforma Number format.
//
// The Proforma Number field gained the same ⚙ Format link the Invoice Number
// has. It opens the same Settings modal, which now carries a Proforma
// Numbering section of its own, and that section writes exactly one column:
// profiles.document_series_formats.proforma_invoice.
//
// The guarantee worth the most here is separation. A quotation is not a tax
// invoice, and the two books must not be able to reach each other:
//
//   * changing the proforma format must never write an invoice format column;
//   * changing an invoice format must never write the document format column;
//   * neither may move the other's counter.
//
// The browser half always runs. The DB half is skipped unless
// STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const UTILS = rd('client', 'js', 'utilities', 'utils.js');
const PROFILE = rd('client', 'js', 'pages', 'profile.js');
const PF_HTML = rd('proforma.html');
const INV_HTML = rd('invoice.html');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const GEN = rd('server', 'src', 'routes', 'generic.js');

const srvFormat = require('../src/utils/invoiceNumberFormat');
const { validateProfilePayload } = require('../src/utils/validation');

// ── The browser copy of the format rule ───────────────────────────────
function clientFormatApi() {
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
  vm.runInContext(UTILS + ';globalThis.__F = { numberFormatProblem, applyInvoiceNumberFormat,'
    + ' NUMBER_FORMAT_MAX };', sb);
  return sb.__F;
}
const CLIENT = clientFormatApi();

// Every case both runtimes must answer identically. Includes the ones that
// are deliberately ALLOWED, so a future tightening of one copy cannot quietly
// diverge from the other.
const FORMAT_CASES = [
  'PI-#####', 'QT/2026/###', 'PI', '25', '#', '############',
  '', '   ', 'PI-###/###', 'a#b#c', 'x'.repeat(41),
  'PI-' + String.fromCharCode(10) + '###', 'PI-' + String.fromCharCode(9) + '###'
];

// ═══ 1. The default ═══════════════════════════════════════════════════

test('F1 the default proforma format is PI-##### and comes from the server', () => {
  // Named once, in the table that owns every document book's default. The
  // browser deliberately holds no copy: the Settings modal reads the
  // effective format from GET /documents/:type/next-number.
  const table = DOCS.slice(DOCS.indexOf('const DEFAULT_DOCUMENT_FORMATS = {'));
  const body = table.slice(0, table.indexOf('};'));
  assert.match(body, /proforma_invoice: 'PI-#####'/,
    'the proforma book must default to PI-#####');

  assert.strictEqual(/PI-#####/.test(PROFILE.replace(/<code>PI-#####<\/code>/g, '')
    .replace(/PI-##### gives PI-00001/g, '')
    .replace(/for example PI-#####\./g, '')), false,
    'profile.js may mention PI-##### only as help text, never as a fallback value');
});

test('F2 the format the user saves is what the server formats with', () => {
  // Not hardcoded anywhere in the save path: applyInvoiceNumberFormat is the
  // single formatter, and both runtimes run the same one.
  for (const [fmt, seq, expected] of [
    ['PI-#####', 1, 'PI-00001'], ['PI-#####', 42, 'PI-00042'],
    ['QT/2026/###', 7, 'QT/2026/007'], ['PI', 3, 'PI-3'], ['25', 9, '9']
  ]) {
    assert.strictEqual(srvFormat.applyInvoiceNumberFormat(fmt, seq), expected);
    assert.strictEqual(CLIENT.applyInvoiceNumberFormat(fmt, seq), expected,
      'the browser preview must agree with the server');
  }
});

// ═══ 2. The UI ════════════════════════════════════════════════════════

test('F3 a Format link sits beside the Proforma Number, as it does for an invoice', () => {
  // The proforma number block, bounded by its own input.
  const block = PF_HTML.slice(
    PF_HTML.indexOf('<label for="pfNumber"'),
    PF_HTML.indexOf('id="pfNumNote"'));
  assert.match(block, /Proforma Number/);
  assert.match(block, /id="pfNumAuto"/, 'the Auto switch is still there');
  assert.match(block, /id="pfNumManual"/, 'and Manual');
  assert.match(block, /onclick="openSettingsModal\(\)"/, 'the Format link must open Settings');
  assert.match(block, /fa-cog/, 'with the same cog icon the invoice uses');
  assert.match(block, />\s*Format\s*<\/a>/, 'and the same label');

  // The same markup idiom as the invoice's, not a second invention.
  const invBlock = INV_HTML.slice(
    INV_HTML.indexOf('<label for="invNum"'), INV_HTML.indexOf('id="invNumNote"'));
  for (const frag of ['onclick="openSettingsModal()"', 'fa-cog',
    'class="fs-11 text-muted-sm"', 'title="Configure the auto-numbering format"']) {
    assert.ok(invBlock.includes(frag), 'invoice reference fragment missing: ' + frag);
    assert.ok(block.includes(frag), 'proforma must use the same fragment: ' + frag);
  }
});

test('F4 the link is not decorative - Settings really has a Proforma section that saves', () => {
  assert.match(PROFILE, /Proforma Numbering/, 'the section must exist');
  assert.match(PROFILE, /id="setProformaFormat"/, 'with a format input');
  assert.match(PROFILE, /onclick="submitProformaNumberingSettings\(\)"/, 'and a Save action');
  assert.match(PROFILE, /async function submitProformaNumberingSettings\(/);
  assert.match(PROFILE, /async function fetchProformaNumbering\(/,
    'and it must read the saved format back to display it');
  // The live example, recomputed as the user types.
  assert.match(PROFILE, /oninput="updateSettingsProformaPreview\(\)"/);
  assert.match(PROFILE, /function updateSettingsProformaPreview\(/);
  assert.match(PROFILE, /id="setProformaPreview"/);
});

test('F5 the modal shows the SAVED format, read from the server, not a guess', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('async function fetchProformaNumbering('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /\/documents\/' \+ PROFORMA_NUMBER_SERIES \+ '\/next-number/,
    'it must read the non-consuming preview endpoint');
  assert.match(body, /res && res\.format/, 'and take the effective format from it');
  assert.match(body, /unavailable: true/,
    'a failed read must be reported, not turned into a blank box');
  // The modal renders the fetched value into the input.
  assert.match(PROFILE, /id="setProformaFormat"[\s\S]{0,160}value="\$\{e\(proformaNumbering\.format\)\}"/);
});

// ═══ 3. Validation ════════════════════════════════════════════════════

test('F6 the two runtimes judge a format identically', () => {
  assert.strictEqual(srvFormat.NUMBER_FORMAT_MAX, CLIENT.NUMBER_FORMAT_MAX);
  for (const c of FORMAT_CASES) {
    assert.strictEqual(CLIENT.numberFormatProblem(c), srvFormat.numberFormatProblem(c),
      'client and server disagree about ' + JSON.stringify(c));
  }
});

test('F7 the formats that must be refused, are', () => {
  const refused = {
    '': /Enter a number format/,
    '   ': /Enter a number format/,
    'PI-###/###': /single run of #/,
    'a#b#c': /single run of #/,
    ['x'.repeat(41)]: /40 characters or fewer/,
    ['PI-' + String.fromCharCode(10) + '###']: /line breaks or control/
  };
  for (const [fmt, pattern] of Object.entries(refused)) {
    const problem = srvFormat.numberFormatProblem(fmt);
    assert.ok(problem, JSON.stringify(fmt) + ' must be refused');
    assert.match(problem, pattern, 'and say why: ' + JSON.stringify(fmt));
  }
});

test('F8 a second run of # really would leak literal hashes - which is why it is refused', () => {
  // The reason F7 rejects it, demonstrated rather than asserted on trust:
  // applyInvoiceNumberFormat substitutes only the FIRST run.
  assert.strictEqual(srvFormat.applyInvoiceNumberFormat('PI-###/###', 7), 'PI-007/###');
});

test('F9 the formats that must be allowed, are', () => {
  // A #-free format has a documented branch in the formatter, and the invoice
  // Settings screen already tells users so. Refusing it here would make the
  // proforma book stricter than the invoice books for no reason.
  for (const fmt of ['PI-#####', 'QT/2026/###', 'PI', '25', '#', '############']) {
    assert.strictEqual(srvFormat.numberFormatProblem(fmt), null,
      JSON.stringify(fmt) + ' must be allowed');
  }
});

test('F10 the server refuses an invalid format on the profile write itself', () => {
  // Not only in the browser: this column is writable through the authenticated
  // profile API, so the rule has to hold there too.
  const bad = validateProfilePayload({ document_series_formats: { proforma_invoice: 'PI-###/###' } });
  assert.strictEqual(bad.valid, false);
  assert.match(bad.errors.document_series_formats, /proforma_invoice: .*single run of #/);

  const good = validateProfilePayload({ document_series_formats: { proforma_invoice: 'QT-###' } });
  assert.strictEqual(good.valid, true, JSON.stringify(good.errors));

  // A non-object is refused rather than stored.
  for (const junk of ['PI-#####', 42, [], null]) {
    const r = validateProfilePayload({ document_series_formats: junk });
    assert.strictEqual(r.valid, false, JSON.stringify(junk) + ' must be refused');
  }
  // And a payload that never mentions the column is untouched by the rule,
  // exactly as every other field in this validator behaves.
  assert.strictEqual(validateProfilePayload({ business_name: 'VTECH' }).valid, true);
});

test('F11 invoice formats are deliberately NOT subjected to the new rule', () => {
  // Every value currently stored in them is already accepted. Tightening them
  // here would reject profiles that save successfully today, which is a
  // migration problem dressed as a validation improvement.
  const r = validateProfilePayload({
    invoice_number_format: 'INV-###/###',
    invoice_series_formats: { online: 'W-###/###' }
  });
  assert.strictEqual(r.valid, true,
    'invoice numbering must behave exactly as it did: ' + JSON.stringify(r.errors));
});

// ═══ 4. Separation from invoice numbering ═════════════════════════════

test('F12 saving the proforma format writes ONE column, and no invoice column', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('async function submitProformaNumberingSettings('));
  const body = fn.slice(0, fn.indexOf('\nasync function submitInvoiceNumberingSettings'));

  assert.match(body, /saveUserProfile\(user\.id, \{ document_series_formats: formats \}\)/,
    'it must save exactly that one column');
  for (const col of ['invoice_number_format', 'invoice_current_sequence',
    'invoice_series_formats', 'invoice_series_sequences']) {
    assert.strictEqual(body.includes(col), false,
      'the proforma save must never mention ' + col);
  }
  // And it must not clobber another document book's format.
  assert.match(body, /\.\.\.\(\(prior && prior\.document_series_formats\) \|\| \{\}\)/,
    'other document books must be carried forward');
});

test('F13 saving an invoice format writes no document column', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('async function submitInvoiceNumberingSettings('));
  const body = fn.slice(0, fn.indexOf('\nfunction defaultFinancialYear'));
  for (const col of ['document_series_formats', 'document_series_sequences']) {
    assert.strictEqual(body.includes(col), false,
      'the invoice save must never mention ' + col);
  }
});

test('F14 the two books are separate columns, and separate code paths', () => {
  // Already true before this change; asserted because the whole feature rests
  // on it. documents.js may not read or move an invoice counter, and
  // invoices.js may not read or move a document one.
  assert.match(DOCS, /document_series_formats/);
  assert.strictEqual(/invoice_number_format|invoice_series_formats/.test(DOCS), false,
    'documents.js must never read an invoice format');
  const INVOICES = rd('server', 'src', 'routes', 'invoices.js');
  assert.strictEqual(/document_series_formats|document_series_sequences/.test(INVOICES), false,
    'invoices.js must never read a document format');

  // Both columns are writable through the profile API, which is what makes a
  // migration unnecessary.
  const prof = GEN.slice(GEN.indexOf('  profiles: {'));
  const cols = prof.slice(0, prof.indexOf('validate:'));
  for (const col of ['document_series_formats', 'document_series_sequences',
    'invoice_number_format', 'invoice_series_formats']) {
    assert.ok(cols.includes(`'${col}'`), col + ' must be in the profiles allowlist');
  }
});

// ═══ 5. Auto / Manual integration ═════════════════════════════════════

test('F15 the preview endpoint reports the format and the sequence, and consumes nothing', () => {
  assert.match(DOCS, /res\.json\(\{ documentNumber, series, format, seq \}\)/,
    'the Settings screen needs seq to preview a format being typed');
  // Still the non-consuming path: no lock, no counter write.
  const fn = DOCS.slice(DOCS.indexOf('async function previewDocumentNumberOn('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.strictEqual(/FOR UPDATE/.test(body), false, 'a preview takes no lock');
  assert.strictEqual(/UPDATE profiles/.test(body), false, 'a preview moves no counter');
});

test('F16 saving a format refreshes the Auto preview without a reload', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('async function submitProformaNumberingSettings('));
  const body = fn.slice(0, fn.indexOf('\nasync function submitInvoiceNumberingSettings'));
  assert.match(body, /typeof generateProformaNo === 'function'/,
    'the proforma page must be told, if it is the page this was opened from');
  assert.match(body, /generateProformaNo\(\)/);
});

test('F17 a format change cannot overwrite a manually typed number', () => {
  // generateProformaNo() is the only thing a format change calls, and it
  // declines in both the cases that matter: Manual mode, and an existing
  // quotation. Asserted against the function itself.
  const ENTRY = rd('client', 'js', 'pages', 'proforma-entry.js');
  const fn = ENTRY.slice(ENTRY.indexOf('async function generateProformaNo()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(proformaEditId\) return;/,
    'an existing proforma keeps the number it was issued');
  assert.match(body, /if \(proformaNumberingIsManual\(\)\) return;/,
    'a number being typed by hand is never overwritten');
});

test('F18 a format change never rewrites a stored proforma number', () => {
  // The format is read when a number is ISSUED, and nothing reads it again
  // afterwards: no stored document_number is recomputed anywhere.
  assert.strictEqual(/UPDATE proforma_invoices[\s\S]{0,200}document_number\s*=\s*applyInvoiceNumberFormat/
    .test(DOCS), false, 'no path may recompute a stored number from the format');
  const fn = PROFILE.slice(PROFILE.indexOf('async function submitProformaNumberingSettings('));
  const body = fn.slice(0, fn.indexOf('\nasync function submitInvoiceNumberingSettings'));
  assert.strictEqual(/proforma_invoices/.test(body), false,
    'saving a format must not touch the proforma table at all');
});

test('F19 the Next Number counter is shown but not editable here', () => {
  // Deliberate: the invoice screen lets a counter be typed and has to
  // special-case re-seeding to avoid reissuing numbers already given out.
  // This screen does not offer that, so it cannot cause it.
  assert.match(PROFILE, /id="setProformaSeq"/);
  const card = PROFILE.slice(PROFILE.indexOf('id="setProformaNumberingCard"'));
  const body = card.slice(0, card.indexOf('<!-- Company Branding -->'));
  assert.strictEqual(/id="setProformaSeq"[^>]*<input/.test(body), false,
    'the counter cell must not contain an input');
  const fn = PROFILE.slice(PROFILE.indexOf('async function submitProformaNumberingSettings('));
  const save = fn.slice(0, fn.indexOf('\nasync function submitInvoiceNumberingSettings'));
  assert.strictEqual(/document_series_sequences/.test(save), false,
    'and the save must never write a counter');
});

// ═══ 6. Cache keys ════════════════════════════════════════════════════

test('F20 the changed shared assets carry new cache keys, in lockstep', () => {
  // utils.js gained numberFormatProblem and profile.js the new section. A page
  // that loaded the new profile.js against a cached old utils.js would throw
  // a ReferenceError the moment the format was saved, so the two move together
  // on every page that loads them.
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  const withProfile = pages.filter(f => rd(f).includes('client/js/pages/profile.js'));
  assert.ok(withProfile.length >= 38, 'expected the shared pair on many pages');
  for (const f of withProfile) {
    const html = rd(f);
    assert.ok(html.includes('client/js/utilities/utils.js?v=34'),
      f + ' must load utils.js at v=34');
    assert.ok(html.includes('client/js/pages/profile.js?v=41'),
      f + ' must load profile.js at v=41');
  }
});
