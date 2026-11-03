// Making the Proforma "Next Number" counter editable.
//
// The counter used to be display-only, and proforma-number-format.test.js's
// F19 asserted exactly that: the screen offered no way to type one, so it
// could not reissue a number. It is editable now, which means the rule F19
// was standing in for has to be ENFORCED rather than avoided.
//
// That rule is the only thing here that really matters:
//
//     a counter must never cause an already-issued Proforma Number to be
//     issued a second time.
//
// A counter is just an integer, so it cannot be judged from the payload - it
// has to be judged against the numbers the book has already given out. Which
// means the decision belongs on the server, under the same profile-row lock
// that issuing a number takes, and the browser's copy of the rule is a
// courtesy rather than the guarantee.
//
// This file is the half that needs no database: the pure rules, the two
// runtimes agreeing on them, and the wiring that puts them in the path of a
// save. The behaviour against real stored proformas - lowering a counter onto
// an issued number, skipping occupied numbers, concurrent saves, invoice
// counters left alone - is in proforma-sequence-edit-api.test.js, which needs
// STOCK_TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const UTILS = rd('client', 'js', 'utilities', 'utils.js');
const PROFILE = rd('client', 'js', 'pages', 'profile.js');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const GEN = rd('server', 'src', 'routes', 'generic.js');

const srv = require('../src/utils/invoiceNumberFormat');

// The Settings card, and the one function that saves it. Sliced once here so
// every test below is talking about the same text.
const CARD = (() => {
  const at = PROFILE.indexOf('id="setProformaNumberingCard"');
  assert.ok(at > 0, 'the Proforma Numbering card must exist');
  return PROFILE.slice(at, PROFILE.indexOf('<!-- Company Branding -->', at));
})();

const SAVE_FN = (() => {
  const at = PROFILE.indexOf('async function submitProformaNumberingSettings(');
  assert.ok(at > 0, 'the proforma save must exist');
  return PROFILE.slice(at, PROFILE.indexOf('\nasync function submitInvoiceNumberingSettings', at));
})();

// The new endpoint's handler, likewise.
const ROUTE = (() => {
  const at = DOCS.indexOf("router.post('/:type/number-settings'");
  assert.ok(at > 0, 'the number-settings route must exist');
  return DOCS.slice(at, DOCS.indexOf('\n}));', at));
})();

// Comments stripped, for the assertions that must see CODE rather than the
// prose explaining it. Both of these files document what they deliberately do
// NOT do, and a test that read that as the thing it forbids would fail on the
// documentation.
const nocomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');

// ── The browser copy of the counter rule ──────────────────────────────
// Same sandbox shape proforma-number-format.test.js uses: utils.js is a
// plain script, so it is run in a context and the functions lifted out.
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
  vm.runInContext(UTILS + ';globalThis.__F = { sequenceProblem, applyInvoiceNumberFormat,'
    + ' SEQUENCE_MAX };', sb);
  return sb.__F;
}
const CLIENT = clientApi();

// ═══ 1. What a counter may be ═════════════════════════════════════════

// Every case both runtimes must answer identically, the allowed ones included
// so a future tightening of one copy cannot quietly diverge from the other.
const SEQ_CASES = [
  // accepted
  '1', '2', '169', '00169', '99999999', 1, 169, 99999999,
  // refused
  '', '   ', '0', '-1', '-169', '+169', '1.5', '169.0', '0.5', '1e3', '1,000',
  '12 34', '169abc', 'abc', '#169', 'NaN', 'Infinity', '100000000', '1000000000',
  null, undefined, true, false, {}, [],
  // boundaries
  '99999999', '100000000'
];

test('SEQ1 a counter must be a positive whole number', () => {
  // Accepted.
  for (const ok of ['1', '169', '00169', 169, '99999999']) {
    assert.strictEqual(srv.sequenceProblem(ok), null, String(ok) + ' must be accepted');
  }
  // Refused, and each for a reason a person can act on.
  for (const bad of ['', '   ', null, undefined]) {
    assert.match(String(srv.sequenceProblem(bad)), /Enter the next number/,
      JSON.stringify(bad) + ' must be refused as missing');
  }
  for (const bad of ['0', '-1', '-169']) {
    assert.ok(srv.sequenceProblem(bad), JSON.stringify(bad) + ' must be refused');
  }
  for (const bad of ['1.5', '169.0', '0.5', '1e3', '1,000', '12 34', '169abc', 'abc', 'NaN']) {
    assert.match(String(srv.sequenceProblem(bad)), /whole number/,
      JSON.stringify(bad) + ' must be refused as not a whole number');
  }
  // 100000000 is one past the ceiling.
  assert.strictEqual(srv.sequenceProblem(srv.SEQUENCE_MAX), null);
  assert.ok(srv.sequenceProblem(srv.SEQUENCE_MAX + 1), 'the ceiling must hold');
});

test('SEQ2 parseInt alone would have accepted values this refuses', () => {
  // The reason the rule is a regex and not a parseInt: these all parse to a
  // plausible integer and mean something else entirely to whoever typed them.
  for (const sneaky of ['1.9', '169abc', '12 34', '0x10']) {
    assert.ok(Number.isFinite(parseInt(sneaky, 10)),
      sneaky + ': precondition - parseInt does yield a number');
    assert.ok(srv.sequenceProblem(sneaky), sneaky + ' must still be refused');
  }
});

test('SEQ3 the browser and the server judge a counter identically', () => {
  for (const c of SEQ_CASES) {
    assert.strictEqual(CLIENT.sequenceProblem(c), srv.sequenceProblem(c),
      'the two copies disagree about ' + JSON.stringify(c));
  }
  assert.strictEqual(CLIENT.SEQUENCE_MAX, srv.SEQUENCE_MAX, 'the ceiling must match');
});

// ═══ 2. The preview ═══════════════════════════════════════════════════

test('SEQ4 format PI-##### with counter 169 previews PI-00169', () => {
  // The example from the brief, through the formatter that issues the real
  // number - not a second implementation that could drift from it.
  assert.strictEqual(srv.applyInvoiceNumberFormat('PI-#####', 169), 'PI-00169');
  assert.strictEqual(CLIENT.applyInvoiceNumberFormat('PI-#####', 169), 'PI-00169');
  // And the counter moving is the only thing that changed.
  assert.strictEqual(srv.applyInvoiceNumberFormat('PI-#####', 5), 'PI-00005');
});

test('SEQ5 the counter is an input, and typing in it redraws the preview', () => {
  assert.match(CARD, /<input type="number" id="setProformaSeq"/,
    'Next Number must be a numeric input, not a display cell');
  assert.match(CARD, /id="setProformaSeq"[\s\S]{0,200}min="1"/, 'and refuse 0 or less in the browser');
  assert.match(CARD, /id="setProformaSeq"[\s\S]{0,200}step="1"/, 'and step in whole numbers');
  assert.match(CARD, /id="setProformaSeq"[\s\S]{0,240}oninput="updateSettingsProformaPreview\(\)"/,
    'and redraw the preview as it is typed');
  // The format field and its own live preview are untouched by all this.
  assert.match(CARD, /id="setProformaFormat"[\s\S]{0,240}oninput="updateSettingsProformaPreview\(\)"/);
  assert.match(CARD, /id="setProformaPreview"/);
});

test('SEQ6 the preview reads the typed counter, and shows nothing for a bad one', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('function updateSettingsProformaPreview('));
  const body = fn.slice(0, fn.indexOf('\nasync function submitProformaNumberingSettings'));
  // It used to read .textContent off a display cell; it must read the input.
  assert.strictEqual(/setProformaSeq'\)\?\.textContent/.test(body), false,
    'the preview must not still be reading a display cell');
  assert.match(body, /seqEl\s*\?\s*seqEl\.value\s*:\s*''/, 'it reads the input value');
  // Both fields are judged, and a bad one suppresses the example rather than
  // inventing a number that would not be issued.
  assert.match(body, /numberFormatProblem\([^)]*\)\s*\|\|\s*sequenceProblem\(/,
    'both the format and the counter are judged');
  assert.match(body, /problem\s*$/m, 'and the example is withheld when either complains');
});

// ═══ 3. Duplicate protection - the rule itself ════════════════════════

test('SEQ7 a counter landing on an issued number is a conflict', () => {
  const issued = ['PI-00001', 'PI-00002', 'PI-00003'];

  // 2 is already PI-00002: refused, and told what would work.
  const bad = srv.sequenceConflict('PI-#####', 2, issued);
  assert.strictEqual(bad.conflict, true);
  assert.strictEqual(bad.candidate, 'PI-00002');
  assert.strictEqual(bad.nextFree, 4);
  assert.strictEqual(bad.nextFreeNumber, 'PI-00004');

  // 4 is free: accepted, and left exactly where it was put.
  const good = srv.sequenceConflict('PI-#####', 4, issued);
  assert.strictEqual(good.conflict, false);
  assert.strictEqual(good.candidate, 'PI-00004');
  assert.strictEqual(good.nextFree, 4, 'an accepted counter is not moved');
});

test('SEQ8 a LOWER counter is fine as long as its number is unused', () => {
  // The case that must not be refused on the grounds of being lower: the book
  // is at 500, but 120 was never issued, so continuing from 120 is legitimate
  // and the business may well have reasons for it.
  const issued = ['PI-00498', 'PI-00499', 'PI-00500'];
  const v = srv.sequenceConflict('PI-#####', 120, issued);
  assert.strictEqual(v.conflict, false, 'a lower unused counter must be allowed');
  assert.strictEqual(v.candidate, 'PI-00120');
});

test('SEQ9 case and padding do not let a duplicate through', () => {
  // The book is scanned upper-cased, exactly as the save's duplicate check
  // scans it, so a format whose letters differ in case is still a collision.
  assert.strictEqual(srv.sequenceConflict('pi-#####', 2, ['PI-00002']).conflict, true);
  assert.strictEqual(srv.sequenceConflict('PI-#####', 2, ['pi-00002']).conflict, true);
  // Padding is the formatter's business: 2 under PI-##### is PI-00002 and not
  // PI-2, so an unpadded number in the book is a different number.
  assert.strictEqual(srv.sequenceConflict('PI-#####', 2, ['PI-2']).conflict, false);
});

test('SEQ10 issuing skips occupied numbers, by the same walk', () => {
  // Requirement: if the next candidate is occupied, advance to the next
  // available one rather than colliding. This is the function the issue path
  // now calls, so the walk under test is the walk that runs.
  const used = new Set(['PI-00005', 'PI-00006', 'PI-00007']);
  assert.deepStrictEqual(srv.firstFreeSequence('PI-#####', 5, used),
    { seq: 8, documentNumber: 'PI-00008' });
  // Nothing in the way: it does not move at all.
  assert.deepStrictEqual(srv.firstFreeSequence('PI-#####', 9, used),
    { seq: 9, documentNumber: 'PI-00009' });
  // A counter that has fallen behind heals itself rather than colliding.
  assert.deepStrictEqual(srv.firstFreeSequence('PI-#####', 1, new Set(['PI-00001'])),
    { seq: 2, documentNumber: 'PI-00002' });
  // The suggestion a conflict offers is this same walk, so it can never
  // suggest a counter that would itself be refused.
  const v = srv.sequenceConflict('PI-#####', 5, used);
  assert.strictEqual(v.nextFree, 8);
  assert.strictEqual(srv.sequenceConflict('PI-#####', v.nextFree, used).conflict, false);
});

test('SEQ11 the walk is bounded, so a pathological book cannot hang a request', () => {
  const guard = srv.SEQUENCE_SCAN_GUARD;
  assert.strictEqual(guard, 100000, 'the documented ceiling');
  // A run long enough to exhaust the guard stops rather than spinning, and
  // returns a number the caller's duplicate check then refuses.
  const used = new Set();
  for (let i = 1; i <= guard + 10; i++) used.add('PI-' + String(i).padStart(5, '0'));
  const out = srv.firstFreeSequence('PI-#####', 1, used);
  assert.strictEqual(out.seq, 1 + guard, 'it stops at the guard');
  assert.ok(used.has(out.documentNumber.toUpperCase()),
    'and the number it stopped on is still taken, so the caller refuses it');
});

test('SEQ12 the issue path and the settings path share one walk', () => {
  // The guarantee behind SEQ10: there is no second copy of the walk to drift.
  const code = nocomment(DOCS);
  assert.match(code, /const free = firstFreeSequence\(format, seq, used\);/,
    'nextDocumentNumberOn must use the shared walk');
  assert.strictEqual(/while \(used\.has\(candidate\.toUpperCase\(\)\)/.test(code), false,
    'and must not keep its own inline copy of it');
  assert.match(nocomment(ROUTE), /sequenceConflict\(effFormat, effSeq, used\)/,
    'and the settings endpoint must judge against the same book');
});

// ═══ 4. Duplicate protection - where it is enforced ═══════════════════

test('SEQ13 the counter is refused server-side, not only in the browser', () => {
  const code = nocomment(ROUTE);
  // Shape first, so a payload that cannot be right never reaches the lock.
  assert.match(code, /sequenceProblem\(body\.seq\)/, 'the value is judged on the server');
  assert.match(code, /e\.status = 400;[\s\S]{0,80}'sequence_invalid'/,
    'and refused with 400 when it is not a whole number');
  // Then the book.
  assert.match(code, /e\.status = 409;[\s\S]{0,80}'sequence_already_issued'/,
    'and 409 when it would reissue a number');
  // The browser checks too, but as a courtesy - the same sentence, sooner.
  assert.match(nocomment(SAVE_FN), /sequenceProblem\(rawSeq\)/);
});

test('SEQ14 the refusal says which number is in the way, and what would work', () => {
  // A bare "invalid" would leave the only way forward as guessing.
  assert.match(ROUTE, /verdict\.candidate/, 'the number already issued');
  assert.match(ROUTE, /verdict\.nextFree/, 'and the counter that would be accepted');
  assert.match(ROUTE, /already been issued/);
  assert.match(ROUTE, /e\.expose = true/, 'and the sentence must reach the browser');
  // Which it does: the client shows the server's message rather than a
  // generic one of its own.
  assert.match(SAVE_FN, /handleApiError\(err, 'Could not save your proforma numbering'\)/);
});

test('SEQ15 the book is read under the same lock that issuing a number takes', () => {
  const code = nocomment(ROUTE);
  // The lock, taken before the scan: without it two settings saves - or a
  // settings save and a document save - could each decide a number was free.
  assert.match(code, /FROM profiles WHERE id = \$1 FOR UPDATE/,
    'the profile row must be locked');
  const lockAt = code.indexOf('FOR UPDATE');
  const scanAt = code.search(/FROM \$\{table\}|SELECT \$\{numberCol\}/);
  assert.ok(lockAt > 0 && scanAt > lockAt,
    'and locked BEFORE the taken-numbers scan, not after');
  // Scoped to this tenant and this book, so neither another tenant's numbers
  // nor another book's are mistaken for a conflict.
  assert.match(code, /WHERE user_id = \$1 AND document_series = \$2/);
  // And it is a real transaction, so a refusal leaves nothing behind.
  assert.match(code, /await client\.query\('BEGIN'\)/);
  assert.match(code, /await client\.query\('ROLLBACK'\)/);
});

test('SEQ16 a refused save writes nothing at all', () => {
  const code = nocomment(ROUTE);
  // Both validations happen before the connection is even taken, so an
  // invalid payload cannot sit on a lock while it is refused.
  const beginAt = code.indexOf("client.query('BEGIN')");
  for (const check of ['numberFormatProblem(format)', 'sequenceProblem(body.seq)']) {
    const at = code.indexOf(check);
    assert.ok(at > 0 && at < beginAt, check + ' must be judged before BEGIN');
  }
  // And the conflict - which can only be judged inside - throws before the
  // UPDATE rather than after it.
  const conflictAt = code.indexOf('if (verdict.conflict)');
  const updateAt = code.indexOf('UPDATE profiles SET');
  assert.ok(conflictAt > 0 && updateAt > conflictAt,
    'the conflict must be decided before the write');
  assert.ok(code.indexOf('COMMIT') > updateAt, 'and committed only after it');
});

test('SEQ17 the counter cannot be written around the check', () => {
  // A validated endpoint beside an unvalidated one writing the same column is
  // not validation. document_series_sequences is immutable through the
  // generic profiles router, so this endpoint is the only door.
  const entry = GEN.slice(GEN.indexOf('profiles: {'), GEN.indexOf('customers: {'));
  assert.match(entry, /immutable:\s*\[[^\]]*'document_series_sequences'/,
    'the counter must be immutable through PATCH /profiles');
  // Still readable, or the Settings screen could not show it.
  assert.match(entry, /'document_series_sequences','document_series_formats'/,
    'and still selectable');
  // refuseImmutable() is what makes that mean something, on both write verbs.
  const refusal = GEN.slice(GEN.indexOf('function refuseImmutable('));
  assert.match(refusal, /e\.status = 400/);
  assert.strictEqual((GEN.match(/refuseImmutable\(req\.body, immutable, table\)/g) || []).length, 2,
    'POST and PATCH must both refuse an immutable column');
});

// ═══ 5. Independence ══════════════════════════════════════════════════

test('SEQ18 nothing here can touch an invoice format or counter', () => {
  for (const col of ['invoice_number_format', 'invoice_current_sequence',
    'invoice_series_formats', 'invoice_series_sequences']) {
    assert.strictEqual(ROUTE.includes(col), false, 'the endpoint must not mention ' + col);
    assert.strictEqual(SAVE_FN.includes(col), false, 'the proforma save must not mention ' + col);
    assert.strictEqual(DOCS.includes(col), false, 'documents.js must not mention ' + col);
  }
  // And the invoice screen keeps its own save, writing its own columns.
  const inv = PROFILE.slice(PROFILE.indexOf('async function submitInvoiceNumberingSettings('));
  const invBody = inv.slice(0, inv.indexOf('\nfunction defaultFinancialYear'));
  assert.match(invBody, /invoice_series_sequences/, 'the invoice save still writes its counters');
  for (const col of ['document_series_formats', 'document_series_sequences']) {
    assert.strictEqual(invBody.includes(col), false, 'and must not mention ' + col);
  }
  assert.strictEqual(/number-settings/.test(invBody), false,
    'the invoice save must not route through the proforma endpoint');
});

test('SEQ19 only this book is written, and only what was sent', () => {
  const code = nocomment(ROUTE);
  // Merged under one key, so another document book's format or counter is
  // carried forward rather than dropped.
  for (const col of ['document_series_formats', 'document_series_sequences']) {
    assert.ok(code.includes(col + " = COALESCE(" + col + ", '{}'::jsonb) "),
      col + ' must be merged, not replaced');
  }
  assert.match(code, /jsonb_build_object\(\$1::text/, 'under this series key alone');
  // Each column is written only when its field was actually sent: that is
  // what makes "change the counter" leave the format alone, and vice versa.
  assert.match(code, /if \(format !== null\) \{/);
  assert.match(code, /if \(seq !== null\) \{/);
  assert.match(code, /const sets = \[\]/, 'the SET clause is assembled from what was sent');
});

test('SEQ20 the type comes from the fixed registry, never from the request', () => {
  const code = nocomment(ROUTE);
  // The table and series name are interpolated into SQL, so they must come
  // from docSpec() - which throws for anything not in DOCUMENT_TABLES - and
  // never from the body.
  assert.match(code, /const spec = docSpec\(type\)/);
  assert.match(code, /const \{ table, series \} = spec/);
  assert.match(code, /spec\.numberCol \|\| 'document_number'/,
    'the number column comes from the spec too');
  assert.strictEqual(/body\.(table|series|numberCol)/.test(code), false,
    'no part of the SQL identifier may come from the request');
  // Only the two values are parameterised into the UPDATE, plus the user.
  assert.match(code, /params\.push\(req\.userId\)/);
});

// ═══ 6. The screen ════════════════════════════════════════════════════

test('SEQ21 one button saves both settings, in one request', () => {
  assert.match(CARD, /Save Proforma Numbering<\/button>/,
    'the button must say it saves more than the format');
  assert.strictEqual(/Save Proforma Format<\/button>/.test(CARD), false,
    'the old label must be gone');
  const code = nocomment(SAVE_FN);
  // One request carrying both, so a counter the server refuses leaves the
  // format unwritten too and the screen never shows half a save.
  assert.match(code, /JSON\.stringify\(\{ format, seq: parseInt\(rawSeq, 10\) \}\)/);
  assert.strictEqual((code.match(/apiFetch\(/g) || []).length, 1,
    'and exactly one write request');
  assert.match(code, /method: 'POST'/);
});

test('SEQ22 after saving, the card shows what the server says', () => {
  const code = nocomment(SAVE_FN);
  // Re-read rather than assumed: the server may have accepted a different
  // counter from the one typed, and the screen must not claim otherwise.
  assert.match(code, /const fresh = await fetchProformaNumbering\(\)/);
  assert.match(code, /seqEl\.value = String\(fresh\.seq\)/,
    'the counter input is refilled from the server');
  assert.match(code, /el\.value = fresh\.format/);
  // The endpoint returns enough for that to be possible without a reload.
  assert.match(ROUTE, /res\.json\(\{ series, format: effFormat, seq: effSeq, documentNumber/);
  // And the proforma page's own Auto preview is refreshed if it is loaded.
  assert.match(code, /if \(typeof generateProformaNo === 'function'\) generateProformaNo\(\)/);
});

test('SEQ23 a failed save leaves the screen and the cache honest', () => {
  const code = nocomment(SAVE_FN);
  // It returns on failure rather than falling through to the success path.
  const catchAt = code.indexOf('} catch (err) {');
  const toastAt = code.indexOf("showToast('Saved!', 'success')");
  assert.ok(catchAt > 0 && toastAt > catchAt, 'the success toast is after the catch');
  const returnAt = code.indexOf('return;', catchAt);
  assert.ok(returnAt > catchAt && returnAt < toastAt,
    'a failed save must return before claiming success');
  // The cached profile is only updated after a success, and only for this key.
  const cacheAt = code.indexOf('cached.document_series_formats');
  assert.ok(cacheAt > toastAt, 'the cache is refreshed only on success');
  assert.match(code, /\[PROFORMA_NUMBER_SERIES\]:/, 'and only this book is touched in it');
});

test('SEQ24 the card explains the rule rather than the old refusal', () => {
  // The paragraph used to say the counter was not editable "because lowering
  // it would reissue numbers already given out". It is editable now, so the
  // text has to explain what happens instead.
  assert.strictEqual(/it is not edited here/.test(CARD), false,
    'the old explanation must be gone');
  assert.match(CARD, /refused when you save/,
    'and the card must say an unsafe counter is refused');
  assert.match(CARD, /skips anything already taken/,
    'and that issuing skips what is taken');
});

// ═══ 7. Cache keys ════════════════════════════════════════════════════

test('SEQ25 profile.js and utils.js move together, on every page', () => {
  // profile.js now calls sequenceProblem() from utils.js. A page that loaded
  // the new profile.js against a cached old utils.js would throw a
  // ReferenceError the moment the counter was typed, so the two keys move
  // together - the same lockstep F20 asserts, at the next pair of versions.
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  const withProfile = pages.filter(f => rd(f).includes('client/js/pages/profile.js'));
  assert.ok(withProfile.length >= 38, 'expected the shared pair on many pages');
  for (const f of withProfile) {
    const html = rd(f);
    assert.ok(html.includes('client/js/pages/profile.js?v=42'), f + ' must load profile.js at v=42');
    assert.ok(html.includes('client/js/utilities/utils.js?v=35'), f + ' must load utils.js at v=35');
    assert.strictEqual(html.includes('profile.js?v=41'), false, f + ' still has the old profile key');
    assert.strictEqual(html.includes('utils.js?v=34'), false, f + ' still has the old utils key');
  }
  // sequenceProblem really is in the file those pages now load.
  assert.match(UTILS, /function sequenceProblem\(/);
});

// ═══ 8. The mirrors ═══════════════════════════════════════════════════

test('SEQ26 server/public mirrors the changed files byte for byte', () => {
  for (const rel of [
    ['client', 'js', 'pages', 'profile.js'],
    ['client', 'js', 'utilities', 'utils.js'],
    ['proforma.html']
  ]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel));
    const pub = fs.readFileSync(path.join(ROOT, 'server', 'public', ...rel));
    assert.ok(src.equals(pub), rel.join('/') + ' differs from its server/public mirror');
  }
});
