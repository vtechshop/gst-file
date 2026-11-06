// Shipping ahead of a migration, and the GST relief only where it applies.
//
// Two defects an audit found in the Receipt Voucher order work, and the rules
// that keep them fixed:
//
//   1. The form sends supply_nature, party_address and payment_date on every
//      receipt voucher. Those columns arrive with
//      migration_receipt_voucher_order.sql, which is applied deliberately and
//      had not been run - so every save failed with SQLSTATE 42703, which
//      reaches the browser as an opaque 500 and took the whole save with it,
//      including the fields that would have worked. The save now writes what
//      the table really has and REPORTS what it could not write.
//
//   2. Notification 66/2017-Central Tax reaches "a registered person who did
//      not opt for the composition levy". The goods relief was applied to
//      every goods advance without looking at the registration type. It is
//      now gated, and an ineligible or unconfigured profile keeps the
//      treatment that was in force before the feature existed rather than
//      being handed a relief it may not be entitled to.
//
// Plus the third: an inferred classification must never be written back onto
// a voucher that never carried one.
//
// The browser half always runs. The database half needs
// STOCK_TEST_DATABASE_URL and is skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const VJS = rd('client', 'js', 'pages', 'vouchers.js');
const HTML = rd('vouchers.html');
const PDF = rd('client', 'js', 'pages', 'receipt-pdf.js');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const NOTE = rd('GST-ADVANCE-REPORTING.md');

const nocomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');

// ── The page, driven over a fake form with a chosen profile ───────────
function sandbox(values, profile) {
  const vals = Object.assign({ vDocType: 'receipt_voucher' }, values || {});
  const made = {};
  const el = (id) => (made[id] || (made[id] = {
    value: vals[id] !== undefined ? String(vals[id]) : '',
    textContent: '', innerHTML: '', disabled: false, readOnly: false, title: '',
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    options: [], add() {}, setAttribute() {}, removeAttribute() { this.title = ''; }
  }));
  const sb = {
    console, Math, String, Number, parseInt, parseFloat, isNaN, isFinite, Date,
    JSON, RegExp, Object, Array, Set, Map, Error, Intl,
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => ({ style: {} }),
      body: {}, head: {}, documentElement: { style: {} }
    },
    navigator: { userAgent: 'node' },
    location: { hostname: 'localhost', href: '', search: '' },
    setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('shared', 'india-districts.js'), sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb);
  sb.__profile = Object.assign({ state: 'Tamil Nadu', registration_type: 'regular' }, profile || {});
  vm.runInContext('function getCachedProfile(){return globalThis.__profile;}'
    + 'function showToast(){} function escItemHtml(s){return String(s);}', sb);
  vm.runInContext(VJS, sb);
  sb.__el = el;
  sb.__set = (name, value) => { sb.__incoming = value; vm.runInContext(name + ' = globalThis.__incoming;', sb); };
  // The order used to be one description, one quantity and one rate. It is
  // a list of products now, so a fixture written as vOrderQty/vOrderRate is
  // translated into the one row it describes - the same order, entered the
  // way the form enters it. Every existing fixture therefore keeps meaning
  // exactly what it meant.
  const _q = String(values.vOrderQty == null ? '' : values.vOrderQty).trim();
  const _r = String(values.vOrderRate == null ? '' : values.vOrderRate).trim();
  if (_q || _r || values.vOrderDesc) {
    sb.__set('vOrderItems', [{
      name: values.vOrderDesc || 'Order', quantity: _q, rate: _r, amount: ''
    }]);
  }
  return sb;
}

const ORDER = { vOrderQty: '1', vOrderRate: '55000', vPackingCharge: '1500', vOrderGstRate: '18' };

// ═══ 1. Registration type gates the relief ═══════════════════════════

test('MS1 a regular taxpayer gets the goods relief', () => {
  const sb = sandbox(Object.assign({}, ORDER, { vAmount: '30000', vRate: '18', vCess: '0',
    vSupplyNature: 'goods', vPos: 'Tamil Nadu' }), { registration_type: 'regular' });
  assert.strictEqual(sb.voucherAdvanceReliefStatus(), 'eligible');
  const a = sb.voucherAmounts();
  assert.strictEqual(a.rate, 0, 'no tax on a goods advance');
  assert.strictEqual(a.igst + a.cgst + a.sgst + a.cess, 0);
  assert.strictEqual(a.total, 30000);
  // And the order's own rate is untouched by the relief.
  assert.strictEqual(sb.voucherOrderAmounts().rate, 18);
  assert.strictEqual(sb.voucherOrderAmounts().gst, 10170);
  assert.strictEqual(sb.voucherOrderAmounts().total, 66670);
});

test('MS2 a composition taxpayer is NOT given the relief, and nothing is guessed', () => {
  const sb = sandbox(Object.assign({}, ORDER, { vAmount: '30000', vRate: '18', vCess: '0',
    vSupplyNature: 'goods', vPos: 'Tamil Nadu' }), { registration_type: 'composition' });
  assert.strictEqual(sb.voucherAdvanceReliefStatus(), 'excluded');
  assert.strictEqual(sb.voucherAdvanceReliefApplies(), false);
  // The treatment that was in force before this feature existed: tax on
  // receipt. Deliberately NOT a composition-specific rule, which this code
  // has no business inventing.
  const a = sb.voucherAmounts();
  assert.strictEqual(a.rate, 18, 'the advance is taxed as it was before');
  assert.strictEqual(sb.round2(a.cgst + a.sgst), 5400);
  // The default for a new voucher is not 'goods' for them either.
  assert.strictEqual(sb.voucherSupplyNatureDefault(), 'services');
  // And the screen says why, naming composition and declining to decide.
  sb.onVoucherSupplyNatureChange();
  const note = sb.__el('vSupplyNatureNote').innerHTML;
  assert.match(note, /does not apply to you/);
  assert.match(note, /composition/i);
  assert.match(note, /confirm it with your practitioner/);
  assert.strictEqual(/CMP-08 treatment is|composition rate is/.test(note), false,
    'it must not state a composition treatment of its own');
});

test('MS3 an unset or unsupported registration type is handled, not assumed', () => {
  for (const [type, status] of [['', 'unknown'], ['isd', 'unsupported'],
    ['tds', 'unsupported'], ['tcs', 'unsupported']]) {
    const sb = sandbox(Object.assign({}, ORDER, { vAmount: '30000', vRate: '18',
      vSupplyNature: 'goods', vPos: 'Tamil Nadu' }), { registration_type: type });
    assert.strictEqual(sb.voucherAdvanceReliefStatus(), status, JSON.stringify(type));
    assert.strictEqual(sb.voucherAdvanceReliefApplies(), false);
    // Previous behaviour preserved: the advance is taxed.
    assert.strictEqual(sb.voucherAmounts().rate, 18, 'taxed as before for ' + status);
    sb.onVoucherSupplyNatureChange();
    assert.match(sb.__el('vSupplyNatureNote').innerHTML, /not applied automatically/);
  }
  // The other schemes that do file GSTR-1 are eligible.
  for (const type of ['regular', 'casual', 'sez_unit', 'sez_developer']) {
    const sb = sandbox({ vSupplyNature: 'goods' }, { registration_type: type });
    assert.strictEqual(sb.voucherAdvanceReliefStatus(), 'eligible', type);
  }
});

test('MS4 a services advance is unchanged whatever the registration type', () => {
  for (const type of ['regular', 'composition', 'isd', '']) {
    const sb = sandbox(Object.assign({}, ORDER, { vAmount: '30000', vRate: '18', vCess: '0',
      vSupplyNature: 'services', vPos: 'Tamil Nadu' }), { registration_type: type });
    const a = sb.voucherAmounts();
    assert.strictEqual(a.rate, 18, 'services taxed on receipt for ' + (type || 'unset'));
    assert.strictEqual(sb.round2(a.cgst + a.sgst), 5400);
    assert.strictEqual(a.total, 35400);
  }
});

test('MS5 the gate is in the figures, not only in the note', () => {
  const code = nocomment(VJS);
  assert.match(code, /const goodsAdvance = voucherIsReceipt\(\)\s*\n\s*&& voucherSupplyNature\(\) === 'goods'\s*\n\s*&& voucherAdvanceReliefApplies\(\);/,
    'voucherAmounts must check eligibility');
  assert.match(code, /VOUCHER_ADVANCE_RELIEF_EXCLUDED = new Set\(\['composition'\]\)/);
  assert.match(code, /registration_type/, 'the profile field is actually read');
});

// ═══ 2. No write-back onto a historical voucher ══════════════════════

test('MS6 an untouched historical voucher keeps its blank classification', () => {
  const code = nocomment(VJS);
  // The condition: a new voucher, one that already carried a nature, or one
  // the person deliberately reclassified. Nothing else writes the column.
  assert.match(code, /if \(!vEditId \|\| vEditSupplyNature \|\| vSupplyNatureTouched\) \{\s*\n\s*doc\.supply_nature = voucherSupplyNature\(\);/,
    'supply_nature is sent only when it is the voucher\'s own answer');
  // Editing records what ARRIVED, separately from what is displayed.
  assert.match(code, /vEditSupplyNature = r\.supply_nature \|\| null;/);
  assert.match(code, /vSupplyNatureTouched = false;/);
  // Only the user-facing handler marks a deliberate choice.
  assert.match(code, /function onVoucherSupplyNaturePicked\(\) \{\s*\n\s*vSupplyNatureTouched = true;/);
  assert.match(HTML, /onchange="onVoucherSupplyNaturePicked\(\)"/,
    'the control calls the handler that records a choice');
  // The programmatic refresh must NOT mark one, or every edit would count as
  // a deliberate reclassification.
  const refresh = code.slice(code.indexOf('function onVoucherSupplyNatureChange()'));
  const body = refresh.slice(0, refresh.indexOf('\n}'));
  assert.strictEqual(/vSupplyNatureTouched = true/.test(body), false,
    'the refresh must not record a user choice');
});

test('MS7 the displayed inference still reads the issued treatment', () => {
  // Unchanged from before: a voucher issued with tax reads as services, one
  // without reads as goods, and the rate it carries is restored either way.
  const code = nocomment(VJS);
  assert.match(code, /const nature = r\.supply_nature\s*\n\s*\|\| \(\(\+r\.gst_percentage \|\| 0\) > 0 \? 'services' : 'goods'\);/);
  assert.match(code, /setVoucherValue\('vRate', String\(\+r\.gst_percentage \|\| 0\)\)/);
  // Nothing rewrites an issued voucher's figures.
  for (const f of ['advance_amount', 'gst_percentage', 'igst', 'cgst', 'sgst',
    'document_number', 'document_date']) {
    assert.strictEqual(new RegExp('r\\.' + f + '\\s*=').test(code), false,
      f + ' must never be assigned onto a loaded row');
  }
});

// ═══ 3. Shipping ahead of the migration ══════════════════════════════

test('MS8 the save writes what the table has, and reports what it cannot', () => {
  const code = nocomment(DOCS);
  assert.match(code, /async function existingColumnsOn\(db, table\)/);
  assert.match(code, /FROM information_schema\.columns/);
  // Dropped from the write...
  assert.match(code, /const unsupported = presentColumns\.size\s*\n\s*\? allowed\.filter\(c => !presentColumns\.has\(c\)\)\s*\n\s*: \[\];/);
  // ...and reported, never silently.
  assert.match(code, /res\.json\(\{ document: row, items: savedItems, unsupported \}\)/);
  // A lookup that returned nothing falls back to the old behaviour rather
  // than refusing every column.
  assert.match(code, /if \(columns\.size\) tableColumnCache\.set/,
    'an empty lookup is not cached');
  // Everything unsupported is a plain 400, not an empty row.
  assert.match(code, /e\.code = 'migration_pending'/);
  // The TTL lets a freshly applied migration be noticed without a restart.
  assert.match(code, /TABLE_COLUMN_TTL_MS = 60000/);
});

test('MS9 the form says so before anything is typed', () => {
  const code = nocomment(VJS);
  assert.match(code, /async function loadVoucherFieldSupport\(\)/);
  assert.match(code, /apiFetch\('\/documents\/' \+ vType\(\) \+ '\/field-support'\)/);
  assert.match(DOCS, /router\.get\('\/:type\/field-support'/);
  assert.match(HTML, /id="vMigrationNotice"/);
  // The notice names the migration, so the fix is discoverable.
  assert.match(code, /migration_receipt_voucher_order\.sql/);
  // The boxes that cannot be stored are disabled rather than left inviting.
  assert.match(code, /function applyVoucherFieldSupport\(\)/);
  assert.match(code, /el\.disabled = true;/);
  // And a failed probe does not block the form.
  const fn = code.slice(code.indexOf('async function loadVoucherFieldSupport'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /catch \{/);
});

test('MS10 a save that lost a field says it lost it', () => {
  const code = nocomment(VJS);
  assert.match(code, /const dropped = \(saved && Array\.isArray\(saved\.unsupported\)\) \? saved\.unsupported : \[\];/);
  assert.match(code, /these fields were not stored \(migration pending\)/);
  // The plain success toast is the other branch, not both.
  assert.match(code, /\} else \{\s*\n\s*showToast\(vEditId \? 'Document updated\.' : 'Document saved\.'\);/);
});

// ═══ 4. Rule 50 on the printed receipt ═══════════════════════════════

test('MS11 the receipt carries the Rule 50 particulars that were missing', () => {
  // (d) the recipient's address, which was captured and never printed.
  assert.match(PDF, /voucher\.party_address/);
  assert.match(PDF, /doc\.splitTextToSize\(String\(voucher\.party_address\)/,
    'wrapped, because an address runs past one line');
  // (f) and (g) as two separate answers.
  assert.match(PDF, /\['Applicable GST Rate', formatNum\(fig\.applicableRate\) \+ '%'\]/);
  assert.match(PDF, /\['GST on this Advance', fig\.advanceTax > 0 \? formatNum\(fig\.advanceTax\) : 'Nil'\]/,
    'Nil is an answer, not an omission');
  // (h) reverse charge.
  assert.match(PDF, /Tax payable on reverse charge: No/);
  // Identity preserved.
  assert.match(PDF, /'ADVANCE RECEIPT'/);
  assert.strictEqual(/TAX INVOICE/.test(PDF), false, 'never a tax invoice');
  // Words still of the money received.
  assert.match(PDF, /numberToWordsINR\(fig\.now\)/);
});

test('MS12 the applicable rate is the supply rate, not the rate charged', () => {
  const sb = {
    console, Math, String, Number, parseInt, parseFloat, isNaN, isFinite, Date,
    JSON, RegExp, Object, Array, Set, Map, Error, Intl,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => ({ style: {} }),
      body: {}, head: {}, documentElement: { style: {} }
    },
    navigator: { userAgent: 'node' }, location: { hostname: 'localhost', href: '', search: '' },
    setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('shared', 'india-districts.js'), sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb);
  vm.runInContext(PDF + ';globalThis.__P = { receiptFigures };', sb);
  const f = sb.__P.receiptFigures;

  // A goods advance: no tax charged, but the supply has a rate and Rule 50
  // asks for it.
  const goods = f({ advance_amount: 30000, gst_percentage: 0, igst: 0, cgst: 0, sgst: 0,
    cess: 0, order_amount: 55000, packing_charge: 1500, order_gst_rate: 18,
    supply_nature: 'goods' }, null, 0);
  assert.strictEqual(goods.advanceTax, 0, 'nil tax on the advance');
  assert.strictEqual(goods.applicableRate, 18, 'and the rate that will apply');

  // A services advance: the rate charged IS the applicable rate.
  const services = f({ advance_amount: 30000, gst_percentage: 18, igst: 0, cgst: 2700,
    sgst: 2700, cess: 0, supply_nature: 'services' }, null, 0);
  assert.strictEqual(services.advanceTax, 5400);
  assert.strictEqual(services.applicableRate, 18);
});

// ═══ 5. The GSTR-1 note, and nothing changed in the returns ══════════

test('MS13 no return-generation logic was touched', () => {
  const g1 = rd('client', 'js', 'gst', 'gstr1-export.js');
  // Still the same builder, still reading only the stored tax.
  const adv = g1.slice(g1.indexOf('function gstr1BuildAdvanceSection'));
  const body = adv.slice(0, adv.indexOf('\n}'));
  assert.strictEqual(/supply_nature|66\/2017|registration_type/.test(body), false,
    '11A knows nothing about the new classification');
  assert.match(body, /b\.iamt = round2\(b\.iamt \+ round2\(r\.igst\)\)/);
  // And the registry entry is as it was.
  const utils = rd('client', 'js', 'utilities', 'utils.js');
  assert.match(utils, /key: 'receipt_voucher'[\s\S]{0,400}affectsLiability: true/);
});

test('MS14 the open question is written down, with its files and functions', () => {
  assert.match(NOTE, /Status: unresolved\. No reporting logic has been changed\./);
  assert.match(NOTE, /Notification 66\/2017/);
  assert.match(NOTE, /"rt":0/, 'it records the measured 0% output');
  assert.match(NOTE, /gstr1BuildAdvanceSection/);
  assert.match(NOTE, /advance_adjustments/, 'and the missing 11B path');
  assert.match(NOTE, /What needs confirming|needs confirming/i);
  assert.match(NOTE, /composition/i);
  // It must be explicit that the CBIC/portal check was not done.
  assert.match(NOTE, /have not been checked|not been checked/);
});

// ═══ 6. The migration is unchanged and still not wired to a deploy ═══

test('MS15 the migration and prestart are untouched', () => {
  const mig = rd('server', 'db', 'migrations', 'migration_receipt_voucher_order.sql');
  const sql = mig.replace(/--[^\n]*/g, '');
  assert.strictEqual((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 8);
  assert.strictEqual(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/.test(sql), false);
  assert.strictEqual(/DEFAULT|REFERENCES|NOT NULL/.test(sql), false);
  const pkg = JSON.parse(rd('server', 'package.json'));
  assert.strictEqual(/receipt.voucher.order/.test(pkg.scripts.prestart), false,
    'prestart must not run it');
  assert.strictEqual((pkg.scripts.prestart.match(/migrate-/g) || []).length, 5,
    'and must still run exactly the five it ran before');
});

// ═══ 7. Against a real database ══════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('receipt voucher save against a database (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
} else {
  process.env.DATABASE_URL = SCRATCH;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'rv-migration-secret';

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
      child.on('exit', (c) => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
    });
  }

  let server, base, db, USER, TOKEN;
  const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';

  async function req(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  }

  test.before(async () => {
    const port = await freePort();
    server = await startServer(port);
    base = 'http://127.0.0.1:' + port;
    db = new Client({ connectionString: SCRATCH });
    await db.connect();
    const u = await db.query(
      "INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id",
      ['rvmig-' + Date.now() + '@test.local']);
    USER = u.rows[0].id;
    await db.query('INSERT INTO profiles (id, name, state, registration_type) VALUES ($1,$2,$3,$4)',
      [USER, 'RV Mig', 'Tamil Nadu', 'regular']);
    TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });
  test.after(async () => {
    if (db) { await db.query('DELETE FROM receipt_vouchers WHERE user_id = $1', [USER]); await db.end(); }
    if (server) server.kill();
  });

  // Which of the new columns this database actually has. The suite does NOT
  // apply the migration - it reads the schema and asserts the right behaviour
  // for whichever state it finds, so it is correct before and after.
  async function pending() {
    const want = ['supply_nature', 'party_address', 'payment_date', 'order_quantity',
      'order_rate', 'order_amount', 'packing_charge', 'order_gst_rate'];
    const r = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='receipt_vouchers' AND column_name = ANY($1)",
      [want]);
    const have = new Set(r.rows.map(x => x.column_name));
    return want.filter(c => !have.has(c));
  }

  test('MS16 field-support reports exactly the columns this database lacks', async () => {
    const res = await req('GET', '/api/documents/receipt_voucher/field-support');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const missing = await pending();
    assert.deepStrictEqual(res.body.missing.slice().sort(), missing.slice().sort());
    assert.strictEqual(res.body.migrationPending, missing.length > 0);
  });

  test('MS17 a receipt voucher saves whatever the migration state, and says what it lost', async () => {
    const missing = await pending();
    const doc = {
      document_number: 'RV-90001', document_date: '2026-01-05',
      document_series: 'receipt_voucher', status: 'issued',
      party_name: 'Audit Customer', place_of_supply: 'Tamil Nadu',
      supply_type: 'intrastate', advance_amount: 30000,
      gst_percentage: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total_value: 30000,
      payment_method: 'upi', reference_number: 'UPI-1',
      // The fields that need the migration:
      supply_nature: 'goods', party_address: '1 Test Street', payment_date: '2026-01-05',
      order_amount: 55000, packing_charge: 1500, order_gst_rate: 18
    };
    const res = await req('POST', '/api/documents/receipt_voucher/save', { document: doc });

    // The point of the fix: this is a 200, not the 500 the audit found.
    assert.strictEqual(res.status, 200, 'the save must not fail: ' + JSON.stringify(res.body));
    assert.ok(res.body.document && res.body.document.id);

    // What always survives, whatever the schema state.
    const row = res.body.document;
    assert.strictEqual(row.document_number, 'RV-90001');
    assert.strictEqual(Number(row.advance_amount), 30000);
    assert.strictEqual(row.payment_method, 'upi');
    assert.strictEqual(row.reference_number, 'UPI-1');

    // And the honest part: anything not stored is named. Scoped to the fields
    // this request actually SENT - a column the caller never mentioned is not
    // something it needs telling about.
    const sent = Object.keys(doc);
    const expected = missing.filter(c => sent.includes(c));
    assert.deepStrictEqual((res.body.unsupported || []).slice().sort(), expected.slice().sort(),
      'the response must name every sent field it could not keep');
    // order_quantity and order_rate were not sent, so they are not reported.
    assert.strictEqual((res.body.unsupported || []).includes('order_quantity'), false,
      'a field that was never sent must not be reported as dropped');

    if (missing.length === 0) {
      // After the migration: the new fields really are persisted.
      assert.strictEqual(row.supply_nature, 'goods');
      assert.strictEqual(row.party_address, '1 Test Street');
      assert.strictEqual(Number(row.order_amount), 55000);
      assert.strictEqual(Number(row.packing_charge), 1500);
    } else {
      // Before it: the save still worked and nothing was invented.
      assert.strictEqual(row.supply_nature, undefined);
    }
  });

  test('MS18 an existing receipt voucher is unaffected by any of this', async () => {
    // Written straight to the table, as a voucher issued before this work.
    const ins = await db.query(
      `INSERT INTO receipt_vouchers
         (user_id, document_number, document_date, document_series, status,
          party_name, place_of_supply, supply_type, advance_amount,
          gst_percentage, igst, cgst, sgst, cess, total_value)
       VALUES ($1,'RV-80001','2025-06-01','receipt_voucher','issued',
               'Old Customer','Tamil Nadu','intrastate',10000,18,0,900,900,0,11800)
       RETURNING *`, [USER]);
    const before = ins.rows[0];

    // Reading the list must not change it.
    const after = (await db.query('SELECT * FROM receipt_vouchers WHERE id = $1', [before.id])).rows[0];
    assert.deepStrictEqual(after, before, 'a historical voucher is untouched');
    assert.strictEqual(Number(after.gst_percentage), 18, 'and keeps the tax it was issued with');
    assert.strictEqual(Number(after.advance_amount), 10000);
  });
}
