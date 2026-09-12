// Purchase Credit / Debit Notes.
//
// The document under test is a FINANCIAL adjustment against a completed
// purchase. The thing it must never become is a Purchase Return: a return
// sends goods back and moves stock and serials, this moves money only. That
// distinction is the first thing checked here (P6), because it is the one
// mistake that would quietly corrupt inventory.
//
// Layout mirrors cdnote-items.test.js: static wiring first, then rendered
// PDFs, then the save path against a disposable database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PNPDF = rd('client', 'js', 'pages', 'purchase-note-pdf.js');
const PNPAGE = rd('client', 'js', 'pages', 'purchase-notes.js');
const PNHTML = rd('purchase-notes.html');
const ROUTE = rd('server', 'src', 'routes', 'purchase-notes.js');
const GENERIC = rd('server', 'src', 'routes', 'generic.js');
const APP = rd('server', 'src', 'app.js');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const MIGRATION = rd('server', 'db', 'migrations', 'migration_purchase_notes.sql');
const MANIFEST = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));

// Comments describe intent; they must not satisfy a check about code.
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function findLib(envVar, ...rel) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];
  const guess = path.join(ROOT, 'server', 'node_modules', ...rel);
  return fs.existsSync(guess) ? guess : null;
}
const JSPDF_FILE = findLib('JSPDF_PATH', 'jspdf', 'dist', 'jspdf.umd.min.js');
const AUTOTABLE_FILE = findLib('JSPDF_AUTOTABLE_PATH', 'jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js')
  || (JSPDF_FILE ? path.join(path.dirname(JSPDF_FILE), 'jspdf.plugin.autotable.min.js') : null);
const HAVE_LIBS = !!(JSPDF_FILE && AUTOTABLE_FILE && fs.existsSync(AUTOTABLE_FILE));
const NO_LIBS = { skip: 'jsPDF / autoTable are not available - set JSPDF_PATH (and JSPDF_AUTOTABLE_PATH) to run the render cases' };
const renderTest = (name, fn) => (HAVE_LIBS ? test(name, fn) : test(name, NO_LIBS, () => {}));

const round2 = n => Number(Math.round(Number(n + 'e2')) + 'e-2');

// ═══════════════════════════════════════════════════════════════════════
//  1. The migration and the schema
// ═══════════════════════════════════════════════════════════════════════

test('P1 the migration creates both tables with the approved columns and keys', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS purchase_notes/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS purchase_note_items/);
  // The link to the purchase is a real foreign key - one table, unlike the
  // sales note - and never cascades: a financial document must survive the
  // deletion of the purchase it refers to.
  assert.match(MIGRATION, /original_purchase_id UUID REFERENCES purchases\(id\) ON DELETE SET NULL/);
  assert.match(MIGRATION, /CONSTRAINT purchase_notes_id_user_key UNIQUE \(id, user_id\)/);
  assert.match(MIGRATION, /FOREIGN KEY \(note_id, user_id\)\s*\n?\s*REFERENCES purchase_notes \(id, user_id\) ON DELETE CASCADE/);
  for (const c of ['discount_percentage', 'gst_percentage', 'cess_rate', 'taxable_value', 'unit', 'hsn_code']) {
    assert.ok(MIGRATION.includes(c), 'the item snapshot must carry ' + c);
  }
});

test('P2 the migration is additive, opens no transaction of its own, and is ordered after its dependencies', () => {
  assert.ok(!/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(MIGRATION), 'the runner owns the transaction');
  assert.ok(!/\bDROP\b|\bTRUNCATE\b/i.test(MIGRATION), 'nothing is dropped');
  // It must not touch a table that already holds data.
  assert.ok(!/ALTER TABLE (purchases|purchase_items|purchase_returns|cdn_notes|stock_movements)/i.test(MIGRATION),
    'no existing table is altered');
  const order = MANIFEST.order;
  assert.strictEqual(order.filter(f => f === 'migration_purchase_notes.sql').length, 1, 'listed once');
  // What matters is that it runs after the migration that creates the tables
  // its foreign keys point at - purchases and vendors both come from
  // migration_purchases.sql - NOT that it happens to be the newest entry.
  // "Is last" is true of exactly one migration at a time and breaks the next
  // time anyone adds one.
  assert.ok(order.indexOf('migration_purchase_notes.sql') > order.indexOf('migration_purchases.sql'),
    'it must run after the migration that creates purchases and vendors');
  assert.strictEqual(order.length, new Set(order).size, 'no migration is listed twice');
  // The prose block is documentation, not the order.
  assert.ok(!MANIFEST._comment.includes('migration_purchase_notes.sql'));
});

test('P3 schema.sql declares the same tables, after the tables their keys point at', () => {
  assert.ok(SCHEMA.includes('CREATE TABLE IF NOT EXISTS purchase_notes'));
  assert.ok(SCHEMA.includes('CREATE TABLE IF NOT EXISTS purchase_note_items'));
  const purchases = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS purchases (');
  const products = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS products (');
  const notes = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS purchase_notes');
  const items = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS purchase_note_items');
  assert.ok(purchases > -1 && products > -1);
  assert.ok(notes > purchases, 'purchase_notes must follow purchases');
  assert.ok(items > notes, 'the items must follow their note');
  assert.ok(items > products, 'the items reference products');
});

// ═══════════════════════════════════════════════════════════════════════
//  2. Wiring
// ═══════════════════════════════════════════════════════════════════════

test('P4 the save route is mounted and authenticated, before the generic routers', () => {
  assert.match(APP, /require\('\.\/routes\/purchase-notes'\)/);
  assert.match(APP, /app\.use\('\/api\/purchase_notes', purchaseNoteRoutes\)/);
  // Mounted first, or the generic CRUD router would answer save-with-items.
  assert.ok(APP.indexOf("app.use('/api/purchase_notes'") < APP.indexOf('mountGenericRoutes(app)'),
    'the dedicated route must be mounted before the generic ones');
  assert.match(code(ROUTE), /router\.use\(requireAuth\)/);
  assert.match(code(ROUTE), /router\.post\('\/save-with-items'/);
});

test('P5 the item rows are read-only through the generic API, and the link is immutable', () => {
  const g = code(GENERIC);
  assert.match(g, /purchase_note_items: \{[\s\S]*?readOnly: true/);
  assert.match(g, /purchase_notes: \{[\s\S]*?immutable: \['original_purchase_id'\]/);
  // Amount and rate are checked against the items, so they change through the
  // note form only once a note carries items.
  assert.match(g, /purchase_notes: \{[\s\S]*?taxable_amount', 'gst_percentage'/);
});

test('P6 MANDATORY a purchase note moves no stock, no serial and no purchase', () => {
  const r = code(ROUTE);
  for (const forbidden of [/stock_movements/, /applyStockDelta/, /stock_serials/, /movement_type/,
    /PURCHASE_RETURN/, /UPDATE\s+purchases\b/, /UPDATE\s+stock/, /INSERT INTO stock/]) {
    assert.ok(!forbidden.test(r), 'the route must not touch stock or the purchase: ' + forbidden);
  }
  // It writes exactly two tables, and reads the purchase only to copy it.
  const writes = r.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g) || [];
  const tables = [...new Set(writes.map(w => w.split(/\s+/).pop()))].sort();
  assert.deepStrictEqual(tables, ['purchase_note_items', 'purchase_notes']);
  // And the page says so, so the user is not left to guess.
  assert.match(PNHTML, /Purchase Return/);
  assert.ok(!/stock/i.test(code(PNPAGE)), 'the page must not speak of stock either');
});

test('P7 tenancy comes from the token, never from the request', () => {
  const r = code(ROUTE);
  assert.ok(!/body\.user_id|header\.user_id|req\.body\.userId/.test(r), 'no client-supplied owner');
  assert.match(r, /WHERE id = \$1 AND user_id = \$2/, 'the purchase is fetched scoped to the tenant');
  assert.match(r, /user_id = \$1 AND purchase_id = \$2/, 'its lines too');
  assert.match(r, /DELETE FROM purchase_note_items WHERE note_id = \$1 AND user_id = \$2/);
  assert.match(r, /SERVER_OWNED = \['id', 'user_id'/);
});

test('P8 the snapshot is built on the server from the stored purchase, never from the request', () => {
  const r = code(ROUTE);
  assert.match(r, /FROM purchase_items/);
  // The browser sends only which line and how many.
  assert.match(code(PNPAGE), /purchase_item_id: l\.id, quantity: Number\(pnSelected\.get\(l\.id\)\)/);
  for (const printable of ['product_name:', 'hsn_code:', 'unit:', 'rate:']) {
    assert.ok(!code(PNPAGE).includes('items: picked.map(l => ({ ' + printable),
      'the page must not send ' + printable);
  }
  assert.match(r, /qty > full \+ 1e-9/, 'note qty is bounded by the purchase qty');
});

test('P9 the page carries the approved columns, and only the quantity is editable', () => {
  const page = code(PNPAGE);
  for (const head of ['Product', 'HSN/SAC', 'Unit', 'Invoice Qty', 'Invoice Rate', 'Invoice Amount',
    'Note Qty', 'Note Rate', 'Discount %', 'GST %', 'Cess %', 'Note Taxable Amount']) {
    assert.ok(page.includes(head), 'the item table must carry the column ' + head);
  }
  const rows = page.slice(page.indexOf('function renderPNItems()'), page.indexOf('function togglePNItem'));
  assert.strictEqual((rows.match(/type="number"/g) || []).length, 1,
    'Note Qty is the only editable figure - Note Rate and the purchase values are display-only');
  assert.match(rows, /pnLineTaxable\(l, qty\)/, 'the row total comes from the existing helper');
  // One calculator, the app's own.
  assert.match(page, /calcGST\(/);
  assert.ok(!/function calcGST/.test(page), 'no second calculation engine');
});

test('P10 the page is reachable and loads what the PDF needs', () => {
  assert.match(PNHTML, /client\/js\/pages\/invoice-pdf\.js/);
  assert.match(PNHTML, /client\/js\/pages\/purchase-note-pdf\.js\?v=1/);
  assert.match(PNHTML, /client\/js\/pages\/purchase-notes\.js\?v=1/);
  assert.match(PNHTML, /AFFECTED PRODUCTS \/ ITEMS/);
  for (const id of ['pnPurchasePick', 'pnItemsSection', 'pnItemsSummary', 'pnUseItemsTotal']) {
    assert.ok(PNHTML.includes(`id="${id}"`), 'purchase-notes.html must have #' + id);
  }
  // Every page that carries the sidebar offers it, in the Purchases section.
  const pages = fs.readdirSync(ROOT).filter(f => /\.html$/.test(f)
    && fs.readFileSync(path.join(ROOT, f), 'utf8').includes('menu-section'));
  const missing = pages.filter(f => !fs.readFileSync(path.join(ROOT, f), 'utf8').includes('purchase-notes.html'));
  assert.deepStrictEqual(missing, [], 'these pages have a sidebar without the new entry');
  assert.match(PNHTML, /purchase-returns\.html" class="menu-item"><i[^>]*><\/i> Purchase Returns<\/a>\s*\n\s*<a href="purchase-notes\.html"/,
    'it belongs directly after Purchase Returns, under Purchases');
});

test('P11 the PDF prints only the stored snapshot, re-read with the note', () => {
  const src = code(PNPDF);
  assert.match(src, /_supabase\.from\('purchase_note_items'\)\.select\('\*'\)\.eq\('note_id', id\)/);
  assert.ok(!/from\('purchase_items'\)/.test(src), 'never the purchase\'s current lines');
  assert.ok(!/from\('products'\)/.test(src), 'never the Product Master\'s current names');
  const dl = src.slice(src.indexOf('async function downloadPurchaseNotePDF'),
    src.indexOf('async function buildPurchaseNotePDFDoc'));
  assert.match(dl, /await fetchPurchaseNoteRecord\(id\)/);
  assert.match(dl, /const items = await fetchPurchaseNoteItems\(id\);\s*if \(!items\) return;/);
});

test('P12 the Sales note and the Purchase Return are untouched', () => {
  const { execSync } = require('child_process');
  const changed = execSync('git status --porcelain -- client/js/pages/cdnotes.js '
    + 'client/js/pages/cdnote-pdf.js server/src/routes/cdn-notes.js '
    + 'server/src/routes/purchases.js client/js/pages/purchase-returns.js '
    + 'client/js/pages/purchase-items.js client/js/gst/gstr3b.js',
  { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', 'these modules must be unchanged by purchase-note work');
});

// ═══════════════════════════════════════════════════════════════════════
//  3. The document
// ═══════════════════════════════════════════════════════════════════════

function load() {
  const noop = () => {};
  const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop,
    getContext: () => null, toDataURL: () => '' });
  const el = mkEl();
  const sb = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl, ArrayBuffer,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array, DataView,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    Buffer, TextEncoder, TextDecoder, btoa, atob,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: el, body: el, head: el,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl() },
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    __docs: [], __calls: []
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), sb, { filename: 'jspdf.umd.min.js' });
  vm.runInContext(fs.readFileSync(AUTOTABLE_FILE, 'utf8'), sb, { filename: 'autotable.js' });
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  // invoice-pdf.js supplies the shared helpers, exactly as the page loads it.
  vm.runInContext(rd('client', 'js', 'pages', 'invoice-pdf.js'), sb, { filename: 'invoice-pdf.js' });
  vm.runInContext(PNPDF, sb, { filename: 'purchase-note-pdf.js' });
  vm.runInContext(`
    showToast = function () {};
    handleApiError = function () {};
    getCachedProfile = function () { return { business_name: 'VTECH KITCHEN EQUIPMENTS',
      address: '9/83 E, Ganapathy Pudur', state: 'Tamil Nadu', gstin: '33AAAAA0000A1Z5' }; };
    generateQRDataUrl = async function () { return null; };
    imageUrlToDataUrl = async function () { return null; };
    (function () {
      const Orig = window.jspdf.jsPDF;
      function Wrapped(o) {
        const d = new Orig(o);
        const tx = d.text;
        d.text = function (s, x, y) {
          __calls.push({ k: 'text', s: Array.isArray(s) ? s.join(' ') : String(s), x: x, y: y });
          return tx.apply(d, arguments);
        };
        d.save = function () { return d; };
        __docs.push(d);
        return d;
      }
      Wrapped.API = Orig.API;
      window.jspdf.jsPDF = Wrapped;
    })();
  `, sb);
  return sb;
}

function pdfText(buf) {
  const raw = buf.toString('latin1');
  const shown = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1], 'latin1');
    let s;
    try { s = zlib.inflateSync(chunk).toString('latin1'); }
    catch { try { s = zlib.inflateRawSync(chunk).toString('latin1'); } catch { s = chunk.toString('latin1'); } }
    const tr = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let t;
    while ((t = tr.exec(s)) !== null) shown.push(t[1].replace(/\\([()\\])/g, '$1'));
  }
  return shown.join('\n');
}

async function render(note, items) {
  const sb = load();
  sb.__docs.length = 0; sb.__calls.length = 0;
  await vm.runInContext('buildPurchaseNotePDFDoc(' + JSON.stringify(note) + ','
    + JSON.stringify(items || []) + ')', sb);
  const doc = sb.__docs[sb.__docs.length - 1];
  const buf = Buffer.from(doc.output('arraybuffer'));
  return { text: pdfText(buf), pages: doc.internal.getNumberOfPages(), calls: sb.__calls.slice() };
}

const NOTE = (type, extra = {}) => ({
  note_type: type, note_number: 'PN-1', note_date: '2026-09-12',
  original_purchase_number: 'PUR-001', original_purchase_date: '2026-09-01',
  vendor_name: 'Kookmate India', vendor_gstin: '33AAACK1234C1Z9', state: 'Tamil Nadu',
  reason: 'Rate difference', taxable_amount: 27000, gst_percentage: 18, supply_type: 'intrastate',
  igst: 0, cgst: 2430, sgst: 2430, gst_amount: 4860, total_amount: 31860, ...extra });
const ITEM_A = { product_name: 'Chapathi Press Machine 8 Inch', hsn_code: '84388090', unit: 'NOS',
  quantity: '1.000', rate: '27000.00', discount_percentage: '0.00', gst_percentage: '18.00',
  cess_rate: '0.000', taxable_value: '27000.00', sort_order: 0 };
const ITEM_B = { product_name: 'Coconut Scraper Machine', hsn_code: '85094010', unit: 'NOS',
  quantity: '2.000', rate: '3000.00', discount_percentage: '0.00', gst_percentage: '18.00',
  cess_rate: '0.000', taxable_value: '6000.00', sort_order: 1 };

renderTest('P13 a single-product note prints that product, and only that product', async () => {
  const { text, pages } = await render(NOTE('credit'), [ITEM_A]);
  for (const s of ['PURCHASE CREDIT NOTE', 'AFFECTED ITEMS', 'Product / Item', 'HSN/SAC', 'Unit',
    'Qty', 'Rate', 'GST %', 'Taxable Amount', 'SUPPLIER', 'Kookmate India',
    'Chapathi Press Machine 8 Inch', '84388090', 'NOS', '27,000.00', 'PUR-001']) {
    assert.ok(text.includes(s), 'missing: ' + s);
  }
  assert.ok(!text.includes('Coconut'), 'a product the note is not for must not appear');
  // Unit has a column of its own: a reader must not have to pick it out of
  // the quantity.
  assert.ok(!text.includes('1 NOS'), 'the quantity and the unit must not share a cell');
  assert.strictEqual(pages, 1);
});

// The mirror of P13: whichever single product was chosen is the only one
// printed, so "only the selected products appear" is proved in both
// directions rather than once.
renderTest('P13b a note for the other product prints only that one', async () => {
  const { text } = await render(NOTE('credit', { taxable_amount: 6000, cgst: 540, sgst: 540,
    gst_amount: 1080, total_amount: 7080 }), [ITEM_B]);
  assert.ok(text.includes('Coconut Scraper Machine'), 'the chosen product must appear');
  assert.ok(text.includes('85094010'));
  assert.ok(!text.includes('Chapathi'), 'the product the note is not for must not appear');
  assert.ok(!text.includes('2 NOS'), 'the quantity and the unit must not share a cell');
});

renderTest('P14 a debit note prints debit wording and the supplier side', async () => {
  const { text } = await render(NOTE('debit'), [ITEM_A]);
  assert.ok(text.includes('PURCHASE DEBIT NOTE'));
  assert.ok(text.includes('Total Debit Amount'));
  assert.ok(!/CREDIT/.test(text), 'no credit wording on a debit note');
  // The document says what it is, so it is never mistaken for a return.
  assert.ok(text.includes('Purchase Return'), 'the note must say a return is the stock document');
});

renderTest('P15 a multi-product note prints each as its own row, cell by cell', async () => {
  const { text, calls, pages } = await render(NOTE('credit', { taxable_amount: 33000 }), [ITEM_A, ITEM_B]);
  const rowOf = name => calls
    .filter(c => c.k === 'text' && Math.abs(c.y - calls.find(x => x.s === name).y) < 1e-6)
    .map(c => c.s);
  assert.deepStrictEqual(rowOf('Chapathi Press Machine 8 Inch'),
    ['Chapathi Press Machine 8 Inch', '84388090', 'NOS', '1', '27,000.00', '18%', '27,000.00']);
  assert.deepStrictEqual(rowOf('Coconut Scraper Machine'),
    ['Coconut Scraper Machine', '85094010', 'NOS', '2', '3,000.00', '18%', '6,000.00']);
  assert.ok(!text.includes('1 NOS') && !text.includes('2 NOS'));
  assert.strictEqual(pages, 1);
});

renderTest('P16 a note with no items prints no AFFECTED ITEMS section', async () => {
  const { text } = await render(NOTE('credit'), []);
  assert.ok(!text.includes('AFFECTED ITEMS'));
  assert.ok(!text.includes('Chapathi'));
  assert.ok(text.includes('PURCHASE CREDIT NOTE'), 'the rest of the document still prints');
});

renderTest('P17 missing snapshot values print as a dash, never as an invented figure', async () => {
  const bare = { product_name: 'Freight adjustment', hsn_code: null, unit: null,
    quantity: null, rate: null, taxable_value: '27000.00', sort_order: 0 };
  const { calls } = await render(NOTE('credit'), [bare]);
  const row = calls.filter(c => c.k === 'text'
    && Math.abs(c.y - calls.find(x => x.s === 'Freight adjustment').y) < 1e-6).map(c => c.s);
  assert.deepStrictEqual(row, ['Freight adjustment', '-', '-', '-', '-', '18%', '27,000.00']);
});

// ═══════════════════════════════════════════════════════════════════════
//  4. The save path, against a disposable database
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('purchase notes API (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'purchase-notes-test-secret';

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
    child.stdout.on('data', d => { out += d; if (out.includes('listening on')) { clearTimeout(done); resolve(child); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

let server, base, db, USER_A, TOKEN_A, USER_B, TOKEN_B;
let PROD_A, PROD_B, PUR_A, PUR_INTER, PUR_OTHER, PUR_B;
let LA, LB, LC, LINTER, LB1;
let PUR_A_BEFORE;

async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const save = (body, token = TOKEN_A) => api('POST', '/api/purchase_notes/save-with-items', { token, body });
const errOf = r => (r.body && r.body.error && r.body.error.message) || '';
const itemsOf = async noteId => (await db.query(
  'SELECT * FROM purchase_note_items WHERE note_id = $1 ORDER BY sort_order', [noteId])).rows;
const noteRow = async noteId => (await db.query('SELECT * FROM purchase_notes WHERE id = $1', [noteId])).rows[0];
const movements = async () => (await db.query('SELECT count(*)::int n FROM stock_movements')).rows[0].n;

// A note header as the page sends it: the supplier of PUR-A, 18%, intra-state.
function header(type, number, taxable, extra = {}) {
  const gst = round2(taxable * 18 / 100);
  return { note_type: type, note_number: number, note_date: '2026-09-12',
    vendor_name: 'Kookmate India', vendor_gstin: '33AAACK1234C1Z9', state: 'Tamil Nadu',
    reason: 'Rate difference', taxable_amount: taxable, gst_percentage: 18, supply_type: 'intrastate',
    igst: 0, cgst: round2(gst / 2), sgst: round2(gst / 2), gst_amount: gst,
    total_amount: round2(taxable + gst), ...extra };
}

async function mkPurchase(userId, { number, vendor, gstin, supply, lines }) {
  const taxable = lines.reduce((t, l) => t + l.taxable, 0);
  const gst = round2(taxable * 0.18);
  const inter = supply === 'interstate';
  const { rows } = await db.query(
    `INSERT INTO purchases (user_id, vendor_name, vendor_gstin, state, purchase_number, purchase_date,
       taxable_amount, gst_percentage, gst_amount, total_amount, supply_type, igst, cgst, sgst)
     VALUES ($1,$2,$3,'Tamil Nadu',$4,'2026-09-01',$5,18,$6,$7,$8,$9,$10,$10) RETURNING id`,
    [userId, vendor, gstin, number, taxable, gst, round2(taxable + gst), supply || 'intrastate',
      inter ? gst : 0, inter ? 0 : round2(gst / 2)]);
  const id = rows[0].id;
  const ids = [];
  for (const [i, l] of lines.entries()) {
    const r = await db.query(
      `INSERT INTO purchase_items (user_id, purchase_id, product_id, product_name, hsn_code, unit,
         quantity, rate, discount_percentage, gst_percentage, taxable_value, gst_amount, total_amount, sort_order)
       VALUES ($1,$2,$3,$4,$5,'NOS',$6,$7,0,$8,$9,$10,$11,$12) RETURNING id`,
      [userId, id, l.product || null, l.name, l.hsn, l.qty, l.rate, l.pct || 18, l.taxable,
        round2(l.taxable * (l.pct || 18) / 100), round2(l.taxable * (1 + (l.pct || 18) / 100)), i]);
    ids.push(r.rows[0].id);
  }
  return { id, lines: ids };
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(`INSERT INTO users (email,password_hash) VALUES ('pn-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(`INSERT INTO users (email,password_hash) VALUES ('pn-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const prod = async (name, hsn) => (await db.query(
    `INSERT INTO products (user_id, name, hsn_code, unit, gst_percentage, stock)
     VALUES ($1,$2,$3,'NOS',18,0) RETURNING id`, [USER_A, name, hsn])).rows[0].id;
  PROD_A = await prod('Chapathi Press Machine 8 Inch', '84388090');
  PROD_B = await prod('Coconut Scraper Machine', '85094010');

  // The mandatory purchase: Product A x1 at 27000 and Product B x2 at 6000,
  // plus a 12% line to prove one note cannot mix rates.
  const a = await mkPurchase(USER_A, { number: 'PUR-A', vendor: 'Kookmate India',
    gstin: '33AAACK1234C1Z9', lines: [
      { product: PROD_A, name: 'Chapathi Press Machine 8 Inch', hsn: '84388090', qty: 1, rate: 27000, taxable: 27000 },
      { product: PROD_B, name: 'Coconut Scraper Machine', hsn: '85094010', qty: 2, rate: 3000, taxable: 6000 },
      { name: 'Idli Grinder', hsn: '84381010', qty: 1, rate: 1000, taxable: 1000, pct: 12 }] });
  PUR_A = a.id; [LA, LB, LC] = a.lines;

  const inter = await mkPurchase(USER_A, { number: 'PUR-INTER', vendor: 'Kookmate India',
    gstin: '33AAACK1234C1Z9', supply: 'interstate',
    lines: [{ name: 'Dough Kneader', hsn: '84381010', qty: 1, rate: 10000, taxable: 10000 }] });
  PUR_INTER = inter.id; [LINTER] = inter.lines;

  PUR_OTHER = (await mkPurchase(USER_A, { number: 'PUR-OTHER', vendor: 'Someone Else Traders',
    gstin: '29AABCU9603R1ZJ', lines: [{ name: 'Z', hsn: '1', qty: 1, rate: 1, taxable: 1 }] })).id;

  const b = await mkPurchase(USER_B, { number: 'PUR-B', vendor: 'B Supplier', gstin: '29AAACB1234C1Z5',
    lines: [{ name: 'B Product', hsn: '84388090', qty: 1, rate: 500, taxable: 500 }] });
  PUR_B = b.id; [LB1] = b.lines;

  PUR_A_BEFORE = JSON.stringify((await db.query(
    `SELECT id, product_id, product_name, quantity, rate, taxable_value, gst_percentage
       FROM purchase_items WHERE purchase_id = $1 ORDER BY sort_order`, [PUR_A])).rows)
    + JSON.stringify((await db.query('SELECT taxable_amount, total_amount FROM purchases WHERE id = $1', [PUR_A])).rows);

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('P18 the migration is applied: tables, composite key, cascade and index', async () => {
  const cols = (await db.query(`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='purchase_note_items'`)).rows;
  const nullable = Object.fromEntries(cols.map(c => [c.column_name, c.is_nullable === 'YES']));
  for (const c of ['product_id', 'hsn_code', 'unit', 'quantity', 'rate', 'taxable_value']) {
    assert.ok(nullable[c], c + ' nullable');
  }
  for (const c of ['id', 'user_id', 'note_id', 'product_name', 'sort_order', 'cess_rate']) {
    assert.ok(!nullable[c], c + ' required');
  }
  const def = name => db.query('SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1', [name])
    .then(r => (r.rows[0] || {}).d || '');
  assert.match(await def('purchase_note_items_note_fk'),
    /FOREIGN KEY \(note_id, user_id\) REFERENCES purchase_notes\(id, user_id\) ON DELETE CASCADE/);
  assert.match(await def('purchase_notes_id_user_key'), /UNIQUE \(id, user_id\)/);
  const applied = (await db.query(`SELECT 1 FROM schema_migrations WHERE id = 'migration_purchase_notes'`)).rows;
  assert.strictEqual(applied.length, 1, 'recorded by the migration runner');
});

test('P19 MANDATORY a note for Product B stores only Product B, from the purchase', async () => {
  const before = await movements();
  const r = await save({ header: header('credit', 'PN-B', 6000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const rows = await itemsOf(r.body.id);
  assert.strictEqual(rows.length, 1, 'Product A must not be stored');
  const it = rows[0];
  assert.strictEqual(it.product_name, 'Coconut Scraper Machine');
  assert.strictEqual(it.product_id, PROD_B);
  assert.strictEqual(it.hsn_code, '85094010');
  assert.strictEqual(it.unit, 'NOS');
  assert.strictEqual(Number(it.quantity), 2);
  assert.strictEqual(Number(it.rate), 3000);
  assert.strictEqual(Number(it.taxable_value), 6000);
  assert.strictEqual(Number(it.gst_percentage), 18);
  assert.strictEqual(it.user_id, USER_A);
  const n = await noteRow(r.body.id);
  assert.strictEqual(n.original_purchase_id, PUR_A, 'linked by id');
  assert.strictEqual(n.original_purchase_number, 'PUR-A');
  assert.strictEqual(Number(n.taxable_amount), 6000, 'the note keeps its own figures');
  assert.strictEqual(Number(n.cgst), 540);
  assert.strictEqual(Number(n.sgst), 540);
  assert.strictEqual(Number(n.igst), 0);
  // MANDATORY: money only.
  assert.strictEqual(await movements(), before, 'a purchase note must move no stock');
});

test('P20 a multi-product note stores both, as separate rows in order', async () => {
  const r = await save({ header: header('credit', 'PN-AB', 33000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LA, quantity: 1 }, { purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const rows = await itemsOf(r.body.id);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(x => x.product_name),
    ['Chapathi Press Machine 8 Inch', 'Coconut Scraper Machine']);
  assert.deepStrictEqual(rows.map(x => Number(x.sort_order)), [0, 1]);
});

test('P21 a partial quantity is allowed, and valued in proportion', async () => {
  const r = await save({ header: header('credit', 'PN-HALF', 3000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 1 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const [it] = await itemsOf(r.body.id);
  assert.strictEqual(Number(it.quantity), 1);
  assert.strictEqual(Number(it.taxable_value), 3000, 'half of 6000');
});

test('P22 MANDATORY a quantity beyond the purchase is refused, and nothing is written', async () => {
  const before = (await db.query('SELECT count(*)::int n FROM purchase_notes')).rows[0].n;
  const r = await save({ header: header('credit', 'PN-OVER', 9000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 3 }] });
  assert.strictEqual(r.status, 400, errOf(r));
  assert.match(errOf(r), /cannot cover/);
  assert.strictEqual((await db.query('SELECT count(*)::int n FROM purchase_notes')).rows[0].n, before);
  for (const q of [0, -1]) {
    const bad = await save({ header: header('credit', 'PN-Q' + q, 6000), purchase: { id: PUR_A },
      items: [{ purchase_item_id: LB, quantity: q }] });
    assert.strictEqual(bad.status, 400, 'quantity ' + q + ' must be refused');
  }
});

test('P23 the items must add up to the note, and one note keeps one GST rate', async () => {
  const wrong = await save({ header: header('credit', 'PN-SUM', 7000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(wrong.status, 400, errOf(wrong));
  assert.match(errOf(wrong), /add up to/);
  // The 12% line cannot join an 18% note.
  const mixed = await save({ header: header('credit', 'PN-MIX', 1000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LC, quantity: 1 }] });
  assert.strictEqual(mixed.status, 400, errOf(mixed));
  assert.match(errOf(mixed), /12% GST on the purchase/);
  // At its own rate it is accepted.
  const ok = await save({ header: header('credit', 'PN-12', 1000,
    { gst_percentage: 12, cgst: 60, sgst: 60, gst_amount: 120, total_amount: 1120 }),
  purchase: { id: PUR_A }, items: [{ purchase_item_id: LC, quantity: 1 }] });
  assert.strictEqual(ok.status, 200, errOf(ok));
});

test('P24 an inter-state purchase note carries IGST and no CGST/SGST', async () => {
  const r = await save({ header: header('debit', 'PN-IGST', 10000,
    { supply_type: 'interstate', igst: 1800, cgst: 0, sgst: 0, gst_amount: 1800, total_amount: 11800 }),
  purchase: { id: PUR_INTER }, items: [{ purchase_item_id: LINTER, quantity: 1 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const n = await noteRow(r.body.id);
  assert.strictEqual(Number(n.igst), 1800);
  assert.strictEqual(Number(n.cgst), 0);
  assert.strictEqual(Number(n.sgst), 0);
  assert.strictEqual(n.supply_type, 'interstate');
});

test('P25 MANDATORY an edit replaces the items atomically', async () => {
  const first = await save({ header: header('credit', 'PN-EDIT', 6000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(first.status, 200, errOf(first));
  const id = first.body.id;

  const edited = await save({ editId: id, header: header('credit', 'PN-EDIT', 27000),
    purchase: { id: PUR_A }, items: [{ purchase_item_id: LA, quantity: 1 }] });
  assert.strictEqual(edited.status, 200, errOf(edited));
  const rows = await itemsOf(id);
  assert.strictEqual(rows.length, 1, 'the old item is gone, not merged');
  assert.strictEqual(rows[0].product_name, 'Chapathi Press Machine 8 Inch');

  // A rejected edit changes nothing at all.
  const bad = await save({ editId: id, header: header('credit', 'PN-EDIT', 99999),
    purchase: { id: PUR_A }, items: [{ purchase_item_id: LA, quantity: 1 }] });
  assert.strictEqual(bad.status, 400, errOf(bad));
  const after = await itemsOf(id);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].product_name, 'Chapathi Press Machine 8 Inch');
  assert.strictEqual(Number((await noteRow(id)).taxable_amount), 27000);

  // Emptying the selection on a linked note is refused.
  const empty = await save({ editId: id, header: header('credit', 'PN-EDIT', 27000),
    purchase: { id: PUR_A }, items: [] });
  assert.strictEqual(empty.status, 400, errOf(empty));
  assert.match(errOf(empty), /which items it covers/);
});

test('P26 deleting a note deletes its items, and never the purchase', async () => {
  const r = await save({ header: header('credit', 'PN-DEL', 6000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const del = await api('DELETE', `/api/purchase_notes?eq_id=${r.body.id}`, { token: TOKEN_A });
  assert.ok(del.status === 200 || del.status === 204, 'delete ' + del.status);
  assert.strictEqual((await itemsOf(r.body.id)).length, 0, 'items cascade with the note');
  const lines = (await db.query('SELECT count(*)::int n FROM purchase_items WHERE purchase_id = $1', [PUR_A])).rows[0].n;
  assert.strictEqual(lines, 3, 'the purchase keeps all of its lines');
});

test('P27 MANDATORY another tenant can use none of it', async () => {
  // B cannot raise a note on A's purchase.
  const cross = await save({ header: header('credit', 'PN-X1', 6000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] }, TOKEN_B);
  assert.strictEqual(cross.status, 404, errOf(cross));
  // Nor use A's line under B's own purchase.
  const line = await save({ header: header('credit', 'PN-X2', 6000,
    { vendor_name: 'B Supplier', vendor_gstin: '29AAACB1234C1Z5' }),
  purchase: { id: PUR_B }, items: [{ purchase_item_id: LB, quantity: 2 }] }, TOKEN_B);
  assert.strictEqual(line.status, 400, errOf(line));
  // A's note is invisible to B.
  const mine = await save({ header: header('credit', 'PN-X3', 6000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(mine.status, 200, errOf(mine));
  const edit = await save({ editId: mine.body.id, header: header('credit', 'PN-X3', 6000) }, TOKEN_B);
  assert.strictEqual(edit.status, 404, 'editing another tenant\'s note');
  const read = await api('GET', `/api/purchase_note_items?eq_note_id=${mine.body.id}`, { token: TOKEN_B });
  assert.strictEqual((read.body || []).length, 0, 'and reading its items');
  // A spoofed owner in the body is ignored.
  const spoof = await save({ header: header('credit', 'PN-X4', 6000, { user_id: USER_A }),
    purchase: { id: PUR_B }, items: [{ purchase_item_id: LB1, quantity: 1 }] }, TOKEN_B);
  if (spoof.status === 200) {
    assert.strictEqual((await noteRow(spoof.body.id)).user_id, USER_B, 'ownership comes from the token');
  }
});

test('P28 the purchase must be the note supplier\'s, and must exist', async () => {
  const wrongVendor = await save({ header: header('credit', 'PN-V', 1), purchase: { id: PUR_OTHER },
    items: [{ purchase_item_id: LA, quantity: 1 }] });
  assert.strictEqual(wrongVendor.status, 400, errOf(wrongVendor));
  assert.match(errOf(wrongVendor), /not by the supplier on this note|is not a line/);
  const missing = await save({ header: header('credit', 'PN-M', 6000),
    purchase: { id: '11111111-1111-1111-1111-111111111111' },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(missing.status, 404, errOf(missing));
  const rubbish = await save({ header: header('credit', 'PN-R', 6000), purchase: { id: 'not-a-uuid' },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(rubbish.status, 400, errOf(rubbish));
});

test('P29 the save route and the item read are authenticated', async () => {
  assert.strictEqual((await api('POST', '/api/purchase_notes/save-with-items',
    { token: null, body: { header: header('credit', 'ANON', 1) } })).status, 401);
  assert.strictEqual((await api('POST', '/api/purchase_notes/save-with-items',
    { token: 'not-a-token', body: { header: header('credit', 'ANON', 1) } })).status, 401);
  assert.strictEqual((await api('GET', '/api/purchase_note_items', { token: null })).status, 401);
});

test('P30 the item rows cannot be written through the generic API', async () => {
  const r = await save({ header: header('credit', 'PN-RO', 6000), purchase: { id: PUR_A },
    items: [{ purchase_item_id: LB, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  for (const [method, url] of [['POST', '/api/purchase_note_items'],
    ['PATCH', `/api/purchase_note_items?eq_note_id=${r.body.id}`],
    ['DELETE', `/api/purchase_note_items?eq_note_id=${r.body.id}`]]) {
    const res = await api(method, url, { token: TOKEN_A, body: { product_name: 'Hacked' } });
    assert.strictEqual(res.status, 405, method + ' ' + url);
  }
  // And an itemised note cannot be unbalanced through the generic PATCH.
  const patch = await api('PATCH', `/api/purchase_notes?eq_id=${r.body.id}`,
    { token: TOKEN_A, body: { taxable_amount: 1 } });
  assert.strictEqual(patch.status, 409, errOf(patch));
  const relink = await api('PATCH', `/api/purchase_notes?eq_id=${r.body.id}`,
    { token: TOKEN_A, body: { original_purchase_id: PUR_INTER } });
  assert.strictEqual(relink.status, 400, errOf(relink));
});

test('P31 MANDATORY the purchase, its lines and stock are never changed by any of it', async () => {
  const after = JSON.stringify((await db.query(
    `SELECT id, product_id, product_name, quantity, rate, taxable_value, gst_percentage
       FROM purchase_items WHERE purchase_id = $1 ORDER BY sort_order`, [PUR_A])).rows)
    + JSON.stringify((await db.query('SELECT taxable_amount, total_amount FROM purchases WHERE id = $1', [PUR_A])).rows);
  assert.strictEqual(after, PUR_A_BEFORE, 'the original purchase is byte-identical');
  assert.strictEqual(await movements(), 0, 'no stock movement was ever written');
  const returns = (await db.query('SELECT count(*)::int n FROM purchase_returns')).rows[0].n;
  assert.strictEqual(returns, 0, 'no purchase return was created either');
});
