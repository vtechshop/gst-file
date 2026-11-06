// The product rows' LIFECYCLE, which is what the existing tests did not
// cover and what let three defects through 1655 passing assertions.
//
// The old tests proved the arithmetic: given rows, the totals are right.
// They never asked what happens TO the rows - when the form recalculates,
// when it resets, or when it is saved against a database that cannot store
// them. All three defects lived in exactly that gap. So:
//
//   L1-L9   the rows survive every rendering and recalculation, are added
//           and removed on demand, are cleared only by a genuine reset, and
//           are not lost by loading a voucher for edit
//   L10-L13 a save against a database WITHOUT receipt_voucher_items keeps
//           the voucher and reports the items as unstorable
//   L14-L17 against a migrated database: rows save, replace on edit, clear
//           on an explicit empty array, and survive when `items` is omitted
//
// The database half uses two databases of its own, created here from
// schema.sql and dropped at the end - one with the items table removed, one
// as built. The shared scratch database is never altered: dropping a table
// from it to simulate a pending migration would leave every other test file
// guessing which schema it was running against.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VJS = read('client/js/pages/vouchers.js');

// ═══════════════════════════════════════════════════════════════════════
//  L1-L9  The row lifecycle, with the page's real functions
// ═══════════════════════════════════════════════════════════════════════
//
// Not source-string checks: the defect these cover was invisible to source
// matching, because the offending line read perfectly sensibly - it was
// simply in a function that runs on every keystroke.
const noop = () => {};
// A function's body with its comments removed. An assertion that a function
// does not CLEAR the rows must not be satisfied - or defeated - by a comment
// that merely mentions clearing them.
function bodyOf(name, endsAt) {
  const from = VJS.indexOf(name);
  assert.ok(from > 0, name + ' exists');
  const to = endsAt ? VJS.indexOf(endsAt, from) : VJS.indexOf('\n}', from);
  assert.ok(to > from, name + ' has an end');
  return VJS.slice(from, to).replace(/^[ \t]*\/\/.*$/gm, '');
}

function formSandbox(rows, options) {
  const opts = options || {};
  const els = {};
  const el = (id, value) => {
    if (!els[id]) {
      const node = {
        textContent: '', innerHTML: '', disabled: false, title: '',
        dataset: {}, style: {}, className: '',
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        scrollIntoView: noop, focus: noop,
        querySelectorAll: () => [], querySelector: () => null
      };
      // A real input coerces whatever is assigned to a string, and the page
      // relies on that: setVoucherValue() assigns numbers, and the code that
      // reads them back calls .trim(). A plain property would hand back the
      // number and the page would behave differently here than in a browser.
      let v = '';
      Object.defineProperty(node, 'value', {
        get: () => v,
        set: (x) => { v = x == null ? '' : String(x); },
        enumerable: true
      });
      els[id] = node;
    }
    if (value !== undefined) els[id].value = value;
    return els[id];
  };
  // Only the boxes the form actually reads. Anything else answers null, and
  // every one of these functions is written to cope with that.
  el('vPackingCharge', '1500');
  el('vOrderGstRate', '18');
  el('vAmount', '30000');
  el('vSupplyNature', 'goods');
  el('vProforma', '');
  el('vPos', 'Tamil Nadu');
  el('vDocNumber', 'RV-00001');
  el('vDocDate', '2026-11-06');
  el('vPartyName', 'Anand Caterers');
  el('vPartyGstin', '');
  el('vPaymentDate', '');
  el('vOrderItemsBody');
  el('vOrderItemsTotal');
  el('vOrderItemsWrap');
  el('vOrderAddRow');
  el('vOrderManualGrid');
  // editVoucher() reaches for these two without a null guard.
  el('vDocTitle');
  el('vSaveBtn');

  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add: noop }, appendChild: noop }),
      addEventListener: noop,
      readyState: 'complete',
      activeElement: null
    },
    window: {}, console, Math, Date, JSON, Number, String, Array, Object, RegExp,
    parseInt, parseFloat, isFinite, isNaN, Promise,
    round2: (n) => Math.round((+n + Number.EPSILON) * 100) / 100,
    formatCurrency: (n) => '₹' + Number(n).toFixed(2),
    formatNum: (n) => Number(n || 0).toFixed(2),
    escItemHtml: (s) => String(s == null ? '' : s),
    toISO: () => '2026-11-06',
    getCachedProfile: () => ({ state: 'Tamil Nadu', registration_type: 'regular' }),
    validateGstin: () => ({ valid: true }),
    gstDocumentTypeSpec: () => ({ label: 'Receipt Voucher' }),
    gstDocumentTypeLabel: () => 'Receipt Voucher',
    gstDocumentSupportsAutoNumbering: () => false,
    // The real shape from utils.js, key for key - an approximation here
    // would let a missing key read as NaN and still satisfy an assertion.
    calcGST: (taxable, pct, supplyType) => {
      const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
      const gst = (taxable * pct) / 100;
      const inter = supplyType === 'interstate';
      return {
        gstAmount: r2(gst), igst: r2(inter ? gst : 0),
        cgst: r2(inter ? 0 : gst / 2), sgst: r2(inter ? 0 : gst / 2),
        totalGst: r2(gst), totalAmount: r2(taxable + gst)
      };
    },
    showToast: noop, apiFetch: async () => ({}), handleApiError: noop,
    requireAuth: async () => ({}), initNavUser: noop, setupLogoutBtn: noop,
    formatDate: (d) => String(d),
    // The stored item rows, as the browser's data layer would hand them
    // back - or a failure, which is what a missing items table looks like
    // from here.
    _supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: async () => {
              if (opts.itemsFail) throw new Error('relation "receipt_voucher_items" does not exist');
              return { data: opts.storedItems || [] };
            }
          })
        })
      })
    }
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(VJS + '\n;globalThis.__set = (k, v) => { eval(k + " = v"); };', ctx,
    { filename: 'vouchers.js' });
  // vOrderItems is let-bound, so it is reachable only by evaluating its
  // name in the same context.
  vm.runInContext('__set("vOrderItems", ' + JSON.stringify(rows || []) + ')', ctx);
  if (opts.docs) vm.runInContext('__set("vDocs", ' + JSON.stringify(opts.docs) + ')', ctx);
  if (opts.proformas) {
    vm.runInContext('__set("vProformas", ' + JSON.stringify(opts.proformas) + ')', ctx);
  }
  if (opts.itemsSupported === false) vm.runInContext('__set("vItemsSupported", false)', ctx);
  return { ctx, els, run: (code) => vm.runInContext(code, ctx) };
}

// Three products, including the shapes the amount helper has to cope with:
// quantity x rate, and a line with nothing filled in yet.
const THREE = [
  { name: 'Steamer 8 Tray with Idly Tray', quantity: 1, rate: 40000, amount: '' },
  { name: 'Idly Tray Set', quantity: 3, rate: 5000, amount: '' },
  { name: 'Installation', quantity: '', rate: '', amount: '' }
];

test('L1 recalcVoucher() does not destroy the product rows', () => {
  const s = formSandbox(THREE);
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'three rows to begin with');

  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'all three survive one recalculation');

  // The original defect fired on EVERY keystroke, so once is not enough.
  for (let i = 0; i < 5; i++) s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'and five more');
  assert.strictEqual(s.run('JSON.stringify(vOrderItems.map(r => r.name))'),
    JSON.stringify(['Steamer 8 Tray with Idly Tray', 'Idly Tray Set', 'Installation']),
    'in the same order, with the same names');
  assert.strictEqual(s.run('voucherOrderAmounts().amount'), 55000,
    '40,000 + 15,000 still adds up after six recalculations');
});

test('L2 renderVoucherOrderBox() does not destroy the product rows', () => {
  const s = formSandbox(THREE);
  s.run('renderVoucherOrderBox()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'the box that used to clear them');
  s.run('renderVoucherOrderItems()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'nor does drawing the table');

  // And it must not regrow the habit: this function runs on every keystroke.
  assert.strictEqual(/vOrderItems\s*=\s*\[\]/.test(bodyOf('function renderVoucherOrderBox()')), false,
    'renderVoucherOrderBox must not reset the rows');
});

test('L3 typing a quantity, a rate, a packing charge or a GST rate keeps the rows', () => {
  const s = formSandbox(THREE);

  s.els.vPackingCharge.value = '1600';
  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'packing charge');

  s.els.vOrderGstRate.value = '12';
  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'GST rate');
  assert.strictEqual(s.run('voucherOrderAmounts().rate'), 12, 'and the new rate is read');

  // A row edit goes through onVoucherOrderItemInput, which recalculates.
  s.run('onVoucherOrderItemInput({ target: { value: "6000", '
    + 'getAttribute: (a) => (a === "data-vi" ? "rate" : "1") } })');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'editing a row');
  assert.strictEqual(s.run('vOrderItems[1].rate'), '6000', 'and the edit landed');
  assert.strictEqual(s.run('voucherOrderAmounts().amount'), 58000, '40,000 + 3 x 6,000');
});

test('L4 addVoucherOrderItem() adds a row, removeVoucherOrderItem() removes one', () => {
  const s = formSandbox([]);
  s.run('addVoucherOrderItem()');
  assert.strictEqual(s.run('vOrderItems.length'), 1, 'added to an empty table');

  // The original defect made this impossible: add pushed a row, and the
  // recalculation inside the same function then wiped it.
  s.run('addVoucherOrderItem()');
  s.run('addVoucherOrderItem()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'three clicks, three rows');
  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'and they survive a recalculation');

  s.run('__set("vOrderItems", ' + JSON.stringify(THREE) + ')');
  s.run('removeVoucherOrderItem(0)');
  assert.strictEqual(s.run('vOrderItems.length'), 2);
  assert.strictEqual(s.run('JSON.stringify(vOrderItems.map(r => r.name))'),
    JSON.stringify(['Idly Tray Set', 'Installation']), 'the right row is removed');
});

test('L5 resetVoucherForm() clears the rows, and nothing else does', () => {
  const s = formSandbox(THREE);
  s.run('resetVoucherForm()');
  assert.strictEqual(s.run('vOrderItems.length'), 0, 'a genuine reset clears them');

  // And no function that runs while the person is typing may clear them or
  // reset the form. Comments are stripped first: this file's own explanation
  // of where the rows ARE cleared names resetVoucherForm, and an assertion
  // that tripped on prose would be measuring the wrong thing.
  for (const name of ['function recalcVoucher', 'function renderVoucherOrderBox',
    'function renderVoucherOrderItems', 'function voucherOrderAmounts']) {
    const body = bodyOf(name);
    assert.strictEqual(/resetVoucherForm\(/.test(body), false, name + ' must not reset the form');
    assert.strictEqual(/vOrderItems\s*=\s*\[\]/.test(body), false, name + ' must not clear the rows');
  }

  // Exactly six places assign the array, and every one of them is accounted
  // for: the declaration, the reset, and four inside editVoucher - which is
  // the LOAD path, where replacing the rows is the whole point. A seventh
  // appearing anywhere else is the defect coming back.
  const assignments = [...VJS.matchAll(/vOrderItems\s*=\s*(?!=)/g)].length;
  const inEdit = [...bodyOf('async function editVoucher', '\nasync function cancelVoucher')
    .matchAll(/vOrderItems\s*=\s*(?!=)/g)].length;
  const inReset = [...bodyOf('function resetVoucherForm').matchAll(/vOrderItems\s*=\s*(?!=)/g)].length;
  const declared = [...VJS.matchAll(/let vOrderItems\s*=/g)].length;
  assert.strictEqual(declared, 1, 'declared once');
  assert.strictEqual(inReset, 1, 'cleared once, in resetVoucherForm');
  assert.strictEqual(inEdit, 4, 'four in editVoucher: the load, its failure path and the fallback row');
  assert.strictEqual(assignments, declared + inReset + inEdit,
    'and nowhere else in the file');
});

// The voucher being opened for edit, and the two rows stored against it.
const SAVED = {
  id: 'rv-1', document_number: 'RV-00007', document_date: '2026-11-06',
  party_name: 'Anand Caterers', place_of_supply: 'Tamil Nadu',
  advance_amount: 30000, gst_percentage: 0, cess: 0, supply_nature: 'goods',
  description: 'Steamer 8 Tray with Idly Tray', packing_charge: 1500,
  order_gst_rate: 18, status: 'issued'
};
const SAVED_ROWS = [
  { product_name: 'Steamer 8 Tray with Idly Tray', quantity: 1, rate: 40000, taxable_value: 40000, sort_order: 0 },
  { product_name: 'Idly Tray Set', quantity: 3, rate: 5000, taxable_value: 15000, sort_order: 1 }
];

test('L6 opening a voucher for edit loads ITS rows and does not lose them', async () => {
  const s = formSandbox([], { docs: [SAVED], storedItems: SAVED_ROWS });
  await s.run('editVoucher("rv-1")');

  // editVoucher ends with recalcVoucher(), which is where the rows used to
  // disappear - so this asserts the state AFTER the whole edit path ran.
  assert.strictEqual(s.run('vOrderItems.length'), 2, 'both stored rows are on the form');
  assert.strictEqual(s.run('JSON.stringify(vOrderItems.map(r => r.name))'),
    JSON.stringify(['Steamer 8 Tray with Idly Tray', 'Idly Tray Set']),
    'with their own names, in their stored order');
  assert.strictEqual(s.run('vOrderItems[0].amount'), 40000, 'and their own amounts');
  assert.strictEqual(s.run('voucherOrderAmounts().amount'), 55000, 'adding to the stored 55,000');

  // Typing afterwards must not cost the loaded rows either.
  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 2, 'and they survive the next keystroke');
});

test('L7 a voucher saved before line items existed opens as one row', async () => {
  // Nothing stored: the voucher's own description and amount become a single
  // row, so an old voucher opens showing what it always showed rather than
  // an empty table.
  const old = { ...SAVED, id: 'rv-2', order_amount: 55000, order_rate: 55000 };
  const s = formSandbox([], { docs: [old], storedItems: [] });
  await s.run('editVoucher("rv-2")');

  assert.strictEqual(s.run('vOrderItems.length'), 1, 'exactly one row');
  assert.strictEqual(s.run('vOrderItems[0].name'), 'Steamer 8 Tray with Idly Tray',
    'carrying the voucher\'s own description');
  assert.strictEqual(s.run('voucherOrderAmounts().amount'), 55000, 'and its own amount');

  // And the same when the items table does not exist at all: the read fails,
  // the voucher still opens.
  const noTable = formSandbox([], { docs: [old], storedItems: [], itemsFail: true });
  await noTable.run('editVoucher("rv-2")');
  assert.strictEqual(noTable.run('vOrderItems.length'), 1,
    'a missing items table does not break opening a voucher');
  assert.strictEqual(noTable.run('voucherOrderAmounts().total'), 66670,
    'and the order still totals 66,670');
});

test('L8 linking a quotation hides the typed rows without destroying them', async () => {
  // A receipt raised against a quotation reads the QUOTATION's order, so
  // the typed table is put out of reach. Out of reach is not deleted:
  // unlinking the quotation has to bring the rows back, because a person
  // who linked the wrong quotation did not ask to lose what they typed.
  const quote = {
    id: 'pf-1', document_number: 'PI-00002', document_date: '2026-11-01',
    customer_name: 'Anand Caterers', state: 'Tamil Nadu',
    taxable_amount: 56500, gst_amount: 10170, cgst: 5085, sgst: 5085,
    total_amount: 66670, advance_amount: 30000
  };
  const s = formSandbox(THREE, { proformas: [quote] });

  s.els.vProforma.value = 'pf-1';
  await s.run('onVoucherProformaChange()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'the typed rows are still held');
  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'and survive the recalculation');

  // The order now comes from the quotation, not from the hidden rows.
  assert.strictEqual(s.run('voucherOrderAmounts().source'), 'quotation');
  assert.strictEqual(s.run('voucherOrderAmounts().total'), 66670,
    'the quotation\'s own total, read and never rewritten');

  // Unlink it: the typed order is back, to the rupee.
  s.els.vProforma.value = '';
  await s.run('onVoucherProformaChange()');
  s.run('recalcVoucher()');
  assert.strictEqual(s.run('vOrderItems.length'), 3, 'every row came back');
  assert.strictEqual(s.run('JSON.stringify(vOrderItems.map(r => r.name))'),
    JSON.stringify(['Steamer 8 Tray with Idly Tray', 'Idly Tray Set', 'Installation']));
  assert.strictEqual(s.run('voucherOrderAmounts().amount'), 55000, 'with their own 55,000');
});

test('L9 with no items table the page sends no items property, and never claims a save', () => {
  // An empty array would ask the server to clear rows that cannot exist, so
  // the property is dropped and the voucher saves as it always did.
  const save = bodyOf('async function saveVoucher');
  assert.match(save, /if \(!vItemsSupported && orderItems && !orderItems\.length\) orderItems = null;/,
    'an empty payload is dropped while the migration is pending');
  assert.match(save, /\.\.\.\(orderItems \? \{ items: orderItems \} : \{\}\)/,
    'and a null payload omits the property entirely, rather than sending []');

  // Rows that DO carry data are still sent - the server refuses the whole
  // save - so nothing on this page can produce a voucher that quietly lost
  // its products.
  assert.strictEqual(/orderItems = \[\]/.test(save), false,
    'the page never substitutes an empty list for rows the person typed');

  // And the table is disabled, so that state is not reachable by typing.
  const applied = bodyOf('function applyVoucherFieldSupport');
  assert.match(applied, /addBtn\.disabled = !vItemsSupported/, 'Add is disabled');
  assert.match(applied, /el\.disabled = !vItemsSupported/, 'and so are the row inputs');
  // Redrawing the table must not quietly re-enable them.
  const redraw = bodyOf('function renderVoucherOrderItems');
  assert.match(redraw, /if \(!vItemsSupported\)/,
    'a redraw puts the disabled state back');

  // A refused save throws, so the success toast and the form reset are both
  // past the throw and unreachable - the rows stay on the form, to be saved
  // once the migration runs.
  const trySave = save.slice(save.indexOf('try {'));
  const success = trySave.indexOf("showToast(vEditId ? 'Document updated.' : 'Document saved.')");
  const reset = trySave.indexOf('resetVoucherForm();');
  const caught = trySave.indexOf('} catch (e) {');
  assert.ok(success > 0 && reset > 0 && caught > 0, 'the save path has all three');
  assert.ok(success < caught, 'the success message is inside the try, past the failing call');
  assert.ok(reset < caught, 'and so is the reset, so a refusal keeps the typed rows');
  assert.match(save, /e\.status === 409 && e\.code === 'migration_pending'/,
    'and a 409 migration_pending is recognised');
  assert.match(save, /if \(refused\) await loadVoucherFieldSupport\(\);/,
    'which re-probes support, so the notice and the disabled table appear');
});

// ═══════════════════════════════════════════════════════════════════════
//  L10-L17  The save path, against real databases
// ═══════════════════════════════════════════════════════════════════════
const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('receipt voucher items save path (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

// The two disposable databases are created beside the scratch one, on the
// same server, with the same credentials - so the guard that protects the
// scratch database has to cover them too.
{
  const u = new URL(SCRATCH);
  if (!['localhost', '127.0.0.1', '::1', ''].includes(u.hostname)) {
    throw new Error('receipt-voucher-items-lifecycle.test.js refuses to run: '
      + 'STOCK_TEST_DATABASE_URL is not a local server, and this file CREATES and DROPS databases.');
  }
  if (!/scratch|test|probe/i.test(decodeURIComponent(u.pathname).replace(/^\//, ''))) {
    throw new Error('receipt-voucher-items-lifecycle.test.js refuses to run: '
      + 'STOCK_TEST_DATABASE_URL does not name a scratch database.');
  }
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rv-items-lifecycle-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

const SCHEMA_SQL = read('server/db/schema/schema.sql');
const DB_ABSENT = 'gst_rvitems_absent_probe';
const DB_PRESENT = 'gst_rvitems_present_probe';

const urlFor = (dbName) => {
  const u = new URL(SCRATCH);
  u.pathname = '/' + dbName;
  return u.toString();
};
const adminClient = () => new Client({ connectionString: urlFor('postgres') });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function startServer(port, dbUrl) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, NODE_ENV: 'test' },
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

// One disposable database, built from schema.sql, with a user and a profile
// so the save route has a business to serialise document numbers against.
async function makeDatabase(name, { dropItems }) {
  const admin = adminClient();
  await admin.connect();
  // Nothing here reads an existing database: it is recreated every run.
  await admin.query('DROP DATABASE IF EXISTS ' + name);
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();

  const db = new Client({ connectionString: urlFor(name) });
  await db.connect();
  const live = (await db.query('SELECT current_database() AS d')).rows[0].d;
  assert.strictEqual(live, name, 'working in the disposable database, not the shared one');
  await db.query(SCHEMA_SQL);

  if (dropItems) {
    // schema.sql now declares the items table, so this is how the
    // pre-migration state is reached: in a database created seconds ago and
    // dropped at the end, never the shared scratch one.
    await db.query('DROP TABLE IF EXISTS receipt_voucher_items');
  }
  const { rows: t } = await db.query("SELECT to_regclass('public.receipt_voucher_items') AS t");
  assert.strictEqual(!!t[0].t, !dropItems,
    dropItems ? 'the items table is absent' : 'the items table is present');

  const { rows: u } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('rvitems@scratch.test','x') RETURNING id");
  const userId = u[0].id;
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
     VALUES ($1,'VTECH','VTECH Engineering Works','33AAGCV4521K1ZT','Tamil Nadu','Coimbatore','14, Avinashi Road')`,
    [userId]);

  const port = await freePort();
  const server = await startServer(port, urlFor(name));
  return {
    name, db, server, userId,
    base: 'http://127.0.0.1:' + port,
    token: jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '2h' })
  };
}
async function dropDatabase(env) {
  if (!env) return;
  if (env.server) env.server.kill();
  if (env.db) await env.db.end().catch(() => {});
  const admin = adminClient();
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ' + env.name);
  await admin.end();
}

async function api(env, method, url, body) {
  const res = await fetch(env.base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes answer no body */ }
  return { status: res.status, body: json };
}
const errText = (r) => JSON.stringify(r && r.body);

let rvSeq = 0;
const voucher = (extra) => ({
  document_number: 'RVL-' + String(++rvSeq).padStart(4, '0'),
  document_date: '2026-11-06',
  document_series: 'receipt_voucher',
  party_name: 'Anand Caterers',
  place_of_supply: 'Tamil Nadu',
  supply_type: 'intrastate',
  description: 'Advance against order',
  advance_amount: 30000,
  ...(extra || {})
});
// The acceptance example's products, as the page's payload builder emits them.
const ITEMS = [
  { product_name: 'Steamer 8 Tray with Idly Tray', quantity: 1, rate: 40000, taxable_value: 40000, sort_order: 0 },
  { product_name: 'Idly Tray Set', quantity: 3, rate: 5000, taxable_value: 15000, sort_order: 1 }
];

// ── L10-L13: the items table is ABSENT ──
let absent = null;

test('setup: a disposable database WITHOUT receipt_voucher_items', async () => {
  absent = await makeDatabase(DB_ABSENT, { dropItems: true });
});

test('L10 the ordinary save still works with the items table absent', async () => {
  // `items` omitted: exactly the save this route always made. A pending
  // migration for a feature this caller is not using must not cost it.
  const plain = await api(absent, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher() });
  assert.strictEqual(plain.status, 200,
    'no items, no 500, no 42P01: ' + errText(plain));
  assert.ok(plain.body.document && plain.body.document.id, 'the voucher exists');
  assert.strictEqual(Number(plain.body.document.advance_amount), 30000, 'with its money intact');
  assert.deepStrictEqual(plain.body.items, [], 'and nothing is claimed as stored');

  // `items: []` - nothing to clear, so nothing to refuse either.
  const empty = await api(absent, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher(), items: [] });
  assert.strictEqual(empty.status, 200, 'an empty array saves too: ' + errText(empty));
  assert.deepStrictEqual(empty.body.items, []);

  // Both are committed, not rolled back: the whole point of the guard.
  const { rows } = await absent.db.query(
    'SELECT id FROM receipt_vouchers WHERE id = ANY($1::uuid[])',
    [[plain.body.document.id, empty.body.document.id]]);
  assert.strictEqual(rows.length, 2, 'both rows are in the database');
});

test('L11 non-empty items against a missing table are refused, and nothing is written', async () => {
  const before = await absent.db.query('SELECT count(*)::int n FROM receipt_vouchers');
  const number = 'RVL-REFUSED';

  const r = await api(absent, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher({ document_number: number }), items: ITEMS });
  assert.strictEqual(r.status, 409, 'refused, not saved-without-products: ' + errText(r));
  assert.strictEqual(r.body.error.code, 'migration_pending', errText(r));
  assert.match(r.body.error.message, /migration/i, 'and it says why');

  // No partial document. A voucher saved without the products it was given
  // would be a voucher claiming an order it does not carry.
  const after = await absent.db.query('SELECT count(*)::int n FROM receipt_vouchers');
  assert.strictEqual(after.rows[0].n, before.rows[0].n, 'not one row was written');
  const { rows } = await absent.db.query(
    'SELECT id FROM receipt_vouchers WHERE document_number = $1', [number]);
  assert.strictEqual(rows.length, 0, 'and the refused voucher does not exist');

  // The message has to be actionable: it names the migration, so nobody
  // has to go looking for which one.
  assert.match(r.body.error.message, /migration_receipt_voucher_items\.sql/,
    'the refusal names the migration to apply: ' + r.body.error.message);
  assert.match(r.body.error.message, /nothing was saved/i,
    'and says plainly that nothing was kept');

  // The refusal comes before the transaction, so the number it asked for is
  // still free: correcting the migration and saving again is not blocked by
  // a half-finished attempt.
  const retry = await api(absent, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher({ document_number: number }) });
  assert.strictEqual(retry.status, 200, 'the same number saves once the items are dropped');
});

test('L12 an EDIT with unstorable items is refused and changes nothing', async () => {
  // The dangerous case. A new voucher that is refused leaves nothing
  // behind; an edit that is half-applied corrupts a document that already
  // existed - and this one carries money.
  const original = await api(absent, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher({ description: 'Original description', advance_amount: 30000 }) });
  assert.strictEqual(original.status, 200, errText(original));
  const id = original.body.document.id;
  const number = original.body.document.document_number;

  const before = await absent.db.query(
    'SELECT document_number, description, advance_amount, updated_at FROM receipt_vouchers WHERE id = $1',
    [id]);

  const edited = await api(absent, 'POST', '/api/documents/receipt_voucher/save', {
    editId: id,
    document: voucher({ document_number: number, description: 'Changed description', advance_amount: 45000 }),
    items: ITEMS
  });
  assert.strictEqual(edited.status, 409, 'the edit is refused: ' + errText(edited));
  assert.strictEqual(edited.body.error.code, 'migration_pending');

  // Not one field of the stored voucher moved - not the description the
  // edit tried to change, and not the money.
  const after = await absent.db.query(
    'SELECT document_number, description, advance_amount, updated_at FROM receipt_vouchers WHERE id = $1',
    [id]);
  assert.strictEqual(after.rows.length, 1, 'the voucher still exists');
  assert.deepStrictEqual(
    { ...after.rows[0], updated_at: String(after.rows[0].updated_at) },
    { ...before.rows[0], updated_at: String(before.rows[0].updated_at) },
    'the original voucher is byte-for-byte what it was');
  assert.strictEqual(after.rows[0].description, 'Original description',
    'the refused description was not written');
  assert.strictEqual(Number(after.rows[0].advance_amount), 30000,
    'and neither was the refused amount');
});

test('L13 field-support tells the browser before anyone types', async () => {
  const r = await api(absent, 'GET', '/api/documents/receipt_voucher/field-support');
  assert.strictEqual(r.status, 200, errText(r));
  assert.strictEqual(r.body.itemsTable, 'receipt_voucher_items');
  assert.strictEqual(r.body.itemsSupported, false, 'the table is missing');
  assert.strictEqual(r.body.migrationPending, true, 'so a migration is pending');
});

test('teardown: drop the database without the items table', async () => {
  await dropDatabase(absent);
  absent = null;
});

// ── L14-L17: the items table is PRESENT ──
let present = null;
const storedItems = (id) => present.db.query(
  `SELECT product_name, quantity, rate, taxable_value, sort_order
     FROM receipt_voucher_items WHERE receipt_voucher_id = $1 ORDER BY sort_order`, [id])
  .then((r) => r.rows);

test('setup: a disposable database WITH receipt_voucher_items', async () => {
  present = await makeDatabase(DB_PRESENT, { dropItems: false });
  const r = await api(present, 'GET', '/api/documents/receipt_voucher/field-support');
  assert.strictEqual(r.body.itemsSupported, true, 'and the server can see it');
  assert.strictEqual(r.body.migrationPending, false);
});

test('L14 non-empty rows are saved', async () => {
  const r = await api(present, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher(), items: ITEMS });
  assert.strictEqual(r.status, 200, errText(r));
  assert.deepStrictEqual(r.body.unsupported, [], 'nothing unsupported now');
  assert.strictEqual(r.body.items.length, 2, 'both rows come back');

  const rows = await storedItems(r.body.document.id);
  assert.strictEqual(rows.length, 2, 'and both are in the database');
  assert.strictEqual(rows[0].product_name, 'Steamer 8 Tray with Idly Tray');
  assert.strictEqual(Number(rows[0].taxable_value), 40000);
  assert.strictEqual(Number(rows[1].quantity), 3);
  assert.strictEqual(Number(rows[1].taxable_value), 15000);
  assert.strictEqual(Number(rows[0].sort_order), 0, 'in the order they were sent');
  // 40,000 + 15,000 = the 55,000 of the acceptance example.
  assert.strictEqual(rows.reduce((n, x) => n + Number(x.taxable_value), 0), 55000);
});

test('L15 editing REPLACES the stored rows', async () => {
  const made = await api(present, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher(), items: ITEMS });
  assert.strictEqual(made.status, 200, errText(made));
  const id = made.body.document.id;
  const number = made.body.document.document_number;
  assert.strictEqual((await storedItems(id)).length, 2);

  const edited = await api(present, 'POST', '/api/documents/receipt_voucher/save', {
    editId: id,
    document: voucher({ document_number: number }),
    items: [{ product_name: 'One Combined Line', quantity: 1, rate: 55000, taxable_value: 55000, sort_order: 0 }]
  });
  assert.strictEqual(edited.status, 200, errText(edited));
  const rows = await storedItems(id);
  assert.strictEqual(rows.length, 1, 'replaced, not appended');
  assert.strictEqual(rows[0].product_name, 'One Combined Line');
  assert.strictEqual(Number(rows[0].taxable_value), 55000);
});

test('L16 an explicit empty array CLEARS the stored rows', async () => {
  const made = await api(present, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher(), items: ITEMS });
  assert.strictEqual(made.status, 200, errText(made));
  const id = made.body.document.id;
  const number = made.body.document.document_number;
  assert.strictEqual((await storedItems(id)).length, 2);

  // Removing every product from a voucher has to work - which is why an
  // empty array is not the same as no array, and must never be discarded
  // as "nothing to do".
  const cleared = await api(present, 'POST', '/api/documents/receipt_voucher/save',
    { editId: id, document: voucher({ document_number: number }), items: [] });
  assert.strictEqual(cleared.status, 200, errText(cleared));
  assert.strictEqual((await storedItems(id)).length, 0, 'the rows are gone');
  assert.deepStrictEqual(cleared.body.items, []);
});

test('L17 omitting items leaves the stored rows untouched', async () => {
  const made = await api(present, 'POST', '/api/documents/receipt_voucher/save',
    { document: voucher(), items: ITEMS });
  assert.strictEqual(made.status, 200, errText(made));
  const id = made.body.document.id;
  const number = made.body.document.document_number;
  assert.strictEqual((await storedItems(id)).length, 2);

  // No `items` key at all. A caller editing something else about the
  // voucher must not silently delete its products.
  const other = await api(present, 'POST', '/api/documents/receipt_voucher/save',
    { editId: id, document: voucher({ document_number: number, description: 'Renamed' }) });
  assert.strictEqual(other.status, 200, errText(other));

  const rows = await storedItems(id);
  assert.strictEqual(rows.length, 2, 'both rows are still there');
  assert.strictEqual(rows[0].product_name, 'Steamer 8 Tray with Idly Tray');
  assert.strictEqual(Number(rows[1].taxable_value), 15000);
  const { rows: doc } = await present.db.query(
    'SELECT description FROM receipt_vouchers WHERE id = $1', [id]);
  assert.strictEqual(doc[0].description, 'Renamed', 'while the document itself did change');
});

test('teardown: drop the database with the items table', async () => {
  await dropDatabase(present);
  present = null;
});
