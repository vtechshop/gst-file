// Credit / Debit Note item details: which products a note applies to.
//
// Three halves. The migration and the wiring are checked from the source.
// The document is checked by building REAL PDFs with jsPDF and reading
// their text and drawing calls back. And the save path is checked against
// the real API on a DISPOSABLE database - skipped unless
// STOCK_TEST_DATABASE_URL names one - because the rules that matter (the
// invoice and its lines are this tenant's, the items add up to the note,
// one rate per note, an edit replaces the items, a delete takes them with
// it) are enforced by the server, not by the page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CDPDF = rd('client', 'js', 'pages', 'cdnote-pdf.js');
const CDPAGE = rd('client', 'js', 'pages', 'cdnotes.js');
const CDHTML = rd('cdnotes.html');
const ROUTE = rd('server', 'src', 'routes', 'cdn-notes.js');
const GENERIC = rd('server', 'src', 'routes', 'generic.js');
const APP = rd('server', 'src', 'app.js');
const MIGRATION = rd('server', 'db', 'migrations', 'migration_cdn_note_items.sql');
const SCHEMA = rd('server', 'db', 'schema', 'schema.sql');
const MANIFEST = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));

const code = s => s.replace(/\/\/[^\n]*/g, '');
const sqlCode = s => s.replace(/--[^\n]*/g, '');
const round2 = n => Number(Math.round(Number(Number(n) + 'e2')) + 'e-2');

// ── A browser-shaped sandbox with the real jsPDF in it ────────────────
const noop = () => {};
const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop,
  getContext: () => null, toDataURL: () => '' });

const JSPDF_FILE = (() => {
  const candidates = [
    process.env.JSPDF_PATH,
    path.join(__dirname, '..', 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js')
  ].filter(Boolean);
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
})();
const NO_JSPDF = { skip: 'jsPDF is not available — set JSPDF_PATH to the umd build to run the render cases' };
const renderTest = (name, fn) => (JSPDF_FILE ? test(name, fn) : test(name, NO_JSPDF, () => {}));

// Two different, valid 1x1 PNGs, so the seal and the signature can be told
// apart in the call log, with measured ink so placement does real work.
const SEAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function load(profile) {
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
    __calls: [], __SEAL: SEAL_PNG, __SIG: SIG_PNG
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), sb, { filename: 'jspdf.umd.min.js' });
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(rd('client', 'js', 'pages', 'invoice-pdf.js'), sb, { filename: 'invoice-pdf.js' });
  vm.runInContext(CDPDF, sb, { filename: 'cdnote-pdf.js' });
  vm.runInContext(`
    showToast = function () {}; handleApiError = function () {};
    getCachedProfile = function () { return ${JSON.stringify(profile)}; };
    generateQRDataUrl = async function () { return null; };
    imageUrlToDataUrl = async function (u) { return u === 'SEAL' ? __SEAL : u === 'SIG' ? __SIG : null; };
    inkBoundsOf = async function (d) {
      return d === __SEAL ? { x: 0.2, y: 0.2, w: 0.6, h: 0.6, imgW: 400, imgH: 400 }
           : d === __SIG ? { x: 0.1, y: 0.3, w: 0.8, h: 0.4, imgW: 600, imgH: 200 } : null;
    };
    (function () {
      const Orig = window.jspdf.jsPDF;
      function Wrapped(o) {
        const d = new Orig(o);
        const pg = () => d.internal.getCurrentPageInfo().pageNumber;
        const t = d.text, ai = d.addImage, ln = d.line;
        d.text = function (s, x, y, opt) {
          __calls.push({ k: 'text', s: Array.isArray(s) ? s.join(' ') : String(s), x, y, align: opt && opt.align, page: pg() });
          return t.apply(d, arguments);
        };
        d.addImage = function (img, f, x, y, w, h) {
          __calls.push({ k: 'img', tag: img === __SEAL ? 'seal' : img === __SIG ? 'sig' : 'other', x, y, w, h, page: pg() });
          return ai.apply(d, arguments);
        };
        d.line = function (x1, y1, x2, y2) {
          __calls.push({ k: 'line', x1, y1, x2, y2, page: pg() });
          return ln.apply(d, arguments);
        };
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

async function render(note, items, profile) {
  const sb = load(profile || PROFILE);
  const doc = await sb.buildCDNotePDFDoc(note, items);
  const buf = Buffer.from(doc.output('arraybuffer'));
  return { sb, doc, buf, text: pdfText(buf), calls: sb.__calls, pages: doc.internal.getNumberOfPages() };
}

// The seal / signature / footer block of one page, as coordinates.
function blockOf(calls, page) {
  const on = calls.filter(c => c.page === page);
  const pick = pred => on.filter(pred).pop();
  const forT = pick(c => c.k === 'text' && /^For VTECH/.test(c.s));
  const auth = pick(c => c.k === 'text' && c.s === 'Authorized Signatory');
  const seal = pick(c => c.k === 'img' && c.tag === 'seal');
  const sig = pick(c => c.k === 'img' && c.tag === 'sig');
  const gen = pick(c => c.k === 'text' && /computer-generated/.test(c.s));
  const contact = pick(c => c.k === 'text' && c.s.includes('  |  '));
  const pageNo = pick(c => c.k === 'text' && /^Page \d+ of \d+$/.test(c.s));
  const divider = gen && pick(c => c.k === 'line' && c.y1 === c.y2 && Math.abs(c.y1 - (gen.y - 6)) < 1e-6);
  const rule = auth && pick(c => c.k === 'line' && c.y1 === c.y2 && Math.abs(c.y1 - (auth.y - 3.5)) < 1e-6);
  return {
    forT: forT && [forT.x, forT.y], auth: auth && [auth.x, auth.y],
    seal: seal && [seal.x, seal.y, seal.w, seal.h], sig: sig && [sig.x, sig.y, sig.w, sig.h],
    rule: rule && [rule.x1, rule.x2, rule.y1], divider: divider && divider.y1,
    gen: gen && gen.y, contact: contact && contact.y, pageNo: pageNo && pageNo.y
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────
// The heaviest ordinary profile: five bank lines, a seal and a signature.
const PROFILE = {
  business_name: 'VTECH KITCHEN EQUIPMENTS', address: '12 Anna Salai, Chennai',
  state: 'Tamil Nadu', gstin: '33AABCU9603R1ZX', pan: 'AABCU9603R',
  email: 'sales@vtech.test', phone: '9840000000', header_color: '#004D40',
  bank_name: 'Test Bank', bank_account_no: '000011112222', bank_ifsc: 'TEST0000001',
  bank_branch: 'Anna Salai', upi_id: 'vtech@testupi',
  seal_base64: 'SEAL', signature_base64: 'SIG'
};

const CUSTOMER = { customer_name: 'Mega Kitchen System Pvt Ltd', gstin: '33AAACI1681G1ZP', state: 'Tamil Nadu' };
const NOTE_BASE = { note_date: '2026-09-11', original_invoice: 'INV-A1', original_invoice_date: '2026-09-01',
  ...CUSTOMER, reason: 'Price correction', gst_percentage: '18.00', supply_type: 'intrastate',
  igst: '0.00', cess_amount: '0.00' };

const CREDIT_B = { ...NOTE_BASE, note_type: 'credit', note_number: 'CN-101',
  taxable_amount: '6000.00', cgst: '540.00', sgst: '540.00', gst_amount: '1080.00', total_amount: '7080.00' };
const DEBIT_A = { ...NOTE_BASE, note_type: 'debit', note_number: 'DN-7',
  taxable_amount: '27000.00', cgst: '2430.00', sgst: '2430.00', gst_amount: '4860.00', total_amount: '31860.00' };
const CREDIT_AB = { ...NOTE_BASE, note_type: 'credit', note_number: 'CN-102',
  taxable_amount: '33000.00', cgst: '2970.00', sgst: '2970.00', gst_amount: '5940.00', total_amount: '38940.00' };
const DEBIT_AB = { ...CREDIT_AB, note_type: 'debit', note_number: 'DN-8' };

// As the API returns them: NUMERIC columns arrive as strings.
const ITEM_A = { product_name: 'Chapathi Press Machine 8 Inch', hsn_code: '84388090', unit: 'PCS',
  quantity: '1.000', rate: '27000.00', taxable_value: '27000.00', sort_order: 0 };
const ITEM_B = { product_name: 'Coconut Scraper Machine', hsn_code: '85094010', unit: 'PCS',
  quantity: '2.000', rate: '3000.00', taxable_value: '6000.00', sort_order: 1 };

const count = (text, s) => text.split(s).length - 1;

// ═══════════════════════════════════════════════════════════════════════
//  1. The migration and the schema
// ═══════════════════════════════════════════════════════════════════════

test('M1 the migration creates cdn_note_items with the approved columns, key and index', () => {
  const sql = sqlCode(MIGRATION);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cdn_note_items \(/);
  for (const col of [
    /id UUID DEFAULT uuid_generate_v4\(\) PRIMARY KEY/,
    /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    /note_id UUID NOT NULL,/,
    /product_id UUID REFERENCES products\(id\) ON DELETE SET NULL,/,
    /product_name TEXT NOT NULL,/,
    /hsn_code TEXT,/, /unit TEXT,/,
    /quantity DECIMAL\(15,3\),/, /rate DECIMAL\(15,2\),/, /taxable_value DECIMAL\(15,2\),/,
    /sort_order INTEGER NOT NULL DEFAULT 0,/,
    /created_at TIMESTAMPTZ DEFAULT NOW\(\),/, /updated_at TIMESTAMPTZ DEFAULT NOW\(\),/
  ]) assert.match(sql, col);
  // The approved composite key: an item can only belong to its own tenant's note.
  assert.match(sql, /FOREIGN KEY \(note_id, user_id\)\s+REFERENCES cdn_notes \(id, user_id\) ON DELETE CASCADE/);
  assert.match(sql, /conname = 'cdn_notes_id_user_key'/);
  assert.match(sql, /ALTER TABLE cdn_notes ADD CONSTRAINT cdn_notes_id_user_key UNIQUE \(id, user_id\);/);
  assert.match(sql, /IF NOT EXISTS \(/, 'the constraint is added only once, so the file re-runs');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_cdn_note_items_note ON cdn_note_items \(note_id, sort_order\);/);
});

test('M2 the migration is additive, runs in the runner\'s transaction, and is ordered in the manifest', () => {
  const sql = sqlCode(MIGRATION);
  for (const bad of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bINSERT\s+INTO\b/i]) {
    assert.ok(!bad.test(sql), 'the migration must not change data: ' + bad);
  }
  assert.ok(!/^\s*BEGIN\s*;/mi.test(sql), 'it must not open its own transaction');
  const order = MANIFEST.order;
  assert.strictEqual(order.filter(f => f === 'migration_cdn_note_items.sql').length, 1, 'listed once');
  assert.ok(order.includes('migration_cdn_note_items.sql'), 'listed in the execution order');
  // Deliberately NOT "it is the last entry". That held only while this was
  // the newest migration; the project has since added others, and the
  // manifest is an append-only ordering, not a claim about which change came
  // last. Nothing creates cdn_notes in a migration - it comes from the base
  // schema - so there is no predecessor here to order this one against.
  assert.ok(!order.some(f => /backfill/i.test(f)), 'no backfill');
  assert.strictEqual(order.length, new Set(order).size, 'no migration is listed twice');
  // The manifest is the execution order, so it and the directory must agree
  // exactly: a listed file that is absent stops a run part-way through, and
  // a file on disk that is unlisted never runs at all.
  const migrationDir = path.join(ROOT, 'server', 'db', 'migrations');
  const onDisk = fs.readdirSync(migrationDir).filter(f => /\.sql$/.test(f)).sort();
  assert.deepStrictEqual([...order].sort(), onDisk,
    'the manifest and the directory must agree - no missing or unlisted migration');
});

test('M3 schema.sql declares the same table, after the tables its keys point at', () => {
  const notes = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS cdn_notes ('));
  const notesBody = notes.slice(0, notes.indexOf(');'));
  assert.match(notesBody, /CONSTRAINT cdn_notes_id_user_key UNIQUE \(id, user_id\)/);
  const at = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS cdn_note_items (');
  assert.ok(at > 0, 'schema.sql creates cdn_note_items');
  assert.ok(at > SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS products ('), 'after products');
  assert.ok(at > SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS cdn_notes ('), 'after cdn_notes');
  const body = SCHEMA.slice(at, SCHEMA.indexOf(');', at));
  assert.match(body, /FOREIGN KEY \(note_id, user_id\)\s+REFERENCES cdn_notes \(id, user_id\) ON DELETE CASCADE/);
  assert.match(SCHEMA, /CREATE INDEX IF NOT EXISTS idx_cdn_note_items_note ON cdn_note_items \(note_id, sort_order\);/);
});

// ═══════════════════════════════════════════════════════════════════════
//  2. The wiring
// ═══════════════════════════════════════════════════════════════════════

test('W1 the save route is mounted, authenticated, and the item rows are read-only elsewhere', () => {
  assert.match(APP, /const cdnNoteRoutes = require\('\.\/routes\/cdn-notes'\);/);
  assert.match(APP, /app\.use\('\/api\/cdn_notes', cdnNoteRoutes\);/);
  assert.ok(APP.indexOf("app.use('/api/cdn_notes', cdnNoteRoutes)") < APP.indexOf('mountGenericRoutes(app);'));
  assert.match(ROUTE, /router\.use\(requireAuth\);/);
  assert.match(ROUTE, /router\.post\('\/save-with-items'/);

  const items = GENERIC.slice(GENERIC.indexOf('  cdn_note_items: {'));
  assert.match(items.slice(0, items.indexOf('}')), /readOnly: true/, 'items are written only by the save route');
  const notes = GENERIC.slice(GENERIC.indexOf('  cdn_notes: {'), GENERIC.indexOf('  products: {'));
  assert.match(notes, /immutable: \['original_invoice_id', 'original_invoice_table'\]/,
    'the invoice link is set only from a verified invoice');
  assert.match(notes, /\['taxable_amount', 'gst_percentage', 'original_invoice'\]/,
    'an itemised note\'s amount, rate and invoice are guarded on the generic path');
});

test('W2 the snapshot is built on the server from the stored invoice line, never from the request', () => {
  const src = code(ROUTE);
  assert.match(src, /FROM invoice_items\s+WHERE user_id = \$1 AND invoice_id = \$2 AND invoice_type = \$3 AND id = ANY\(\$4::uuid\[\]\)/);
  assert.match(src, /SELECT id FROM products WHERE user_id = \$1 AND id = ANY/);
  // The browser's line supplies which line and how many - nothing else.
  assert.ok(!/line\.(product_name|product_id|hsn_code|unit|rate|taxable_value)/.test(src),
    'no printed value may come from the browser');
  assert.match(src, /\[req\.userId, noteId, it\.product_id, it\.product_name, it\.hsn_code, it\.unit,\s*it\.quantity, it\.rate, it\.taxable_value, i\]/);
  // Replaced, never merged, inside the transaction that writes the note.
  assert.match(src, /DELETE FROM cdn_note_items WHERE note_id = \$1 AND user_id = \$2/);
  assert.ok(src.indexOf("'BEGIN'") < src.indexOf('DELETE FROM cdn_note_items')
    && src.indexOf('DELETE FROM cdn_note_items') < src.indexOf("'COMMIT'"));
  // No stock, no serial lifecycle: a Sales Return is the document for goods.
  assert.ok(!/stock|serial|applyStockDelta/i.test(src), 'the note route must not move stock or serials');
});

test('W3 the page picks an invoice by table and id, and saves only the ticked lines', () => {
  const src = code(CDPAGE);
  assert.match(src, /function cdInvoiceKey\(r\) \{ return r\.table \+ ':' \+ r\.id; \}/);
  assert.match(src, /apiFetch\('\/cdn_notes\/save-with-items'/);
  assert.match(src, /items: picked\.map\(l => \(\{ invoice_item_id: l\.id, quantity: Number\(cdSelected\.get\(l\.id\)\) \}\)\)/);
  assert.match(src, /const picked = cdSelectedLines\(\);/);
  // Picking an invoice ticks nothing: the user chooses the affected items.
  const pick = src.slice(src.indexOf('async function pickCDInvoice'), src.indexOf('function preselectCDItems'));
  assert.ok(!/cdSelected\.set\(/.test(pick), 'picking an invoice must not select its products');
  assert.ok(!/cdInvoiceLines\.forEach\([^)]*\)\s*=>\s*cdSelected\.set/.test(src));
  // The form carries the picker, the checklist and the running total.
  for (const id of ['cdInvoicePick', 'cdItemsSection', 'cdItemsSummary', 'cdUseItemsTotal']) {
    assert.ok(CDHTML.includes(`id="${id}"`), 'cdnotes.html must have #' + id);
  }
  assert.match(CDHTML, /cdnote-pdf\.js\?v=5/);
  assert.match(CDHTML, /cdnotes\.js\?v=34/);
});

test('W4 the PDF lists only the stored snapshot, re-read with the note on every download', () => {
  const src = code(CDPDF);
  assert.match(src, /_supabase\.from\('cdn_note_items'\)\.select\('\*'\)\.eq\('note_id', id\)\.order\('sort_order', \{ ascending: true \}\)/);
  assert.ok(!/from\('invoice_items'\)/.test(src), 'never the invoice\'s current lines');
  assert.ok(!/from\('products'\)/.test(src), 'never the Product Master\'s current names');
  const dl = src.slice(src.indexOf('async function downloadCDNotePDF'), src.indexOf('async function buildCDNotePDFDoc'));
  assert.match(dl, /await fetchCDNoteRecord\(id\)/);
  assert.match(dl, /const items = await fetchCDNoteItems\(id\);\s*if \(!items\) return;/);
  assert.match(dl, /buildCDNotePDFDoc\(note, items\)/);
});

test('W5 Sales Return and the other PDF modules are untouched', () => {
  const { execSync } = require('child_process');
  const changed = execSync('git status --porcelain -- server/src/routes/sales-returns.js '
    + 'client/js/pages/sales-returns.js client/js/pages/sales-return-pdf.js '
    + 'client/js/pages/invoice-pdf.js client/js/pages/proforma-pdf.js '
    + 'client/js/gst/gstr1-export.js',
  { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', 'these files must be unchanged');

  // The Purchase Order PDF was redesigned under its own approved change, so
  // it is pinned by content rather than by "not modified": this still fails
  // if Credit/Debit Note work edits it, and if anyone changes it again
  // without approving the new revision here.
  const APPROVED_PO_PDF_SHA256 = '331ae4705c81539d9178f3f5657ab00b6ff67c581e82077d666c34456f4f408a';
  const poSrc = fs.readFileSync(path.join(ROOT, 'client', 'js', 'pages', 'purchase-order-pdf.js'), 'utf8');
  const po = require('crypto').createHash('sha256').update(poSrc.replace(/\r\n/g, '\n')).digest('hex');
  assert.strictEqual(po, APPROVED_PO_PDF_SHA256,
    'purchase-order-pdf.js is not the approved Purchase Order redesign');
});

// ═══════════════════════════════════════════════════════════════════════
//  3. The document
// ═══════════════════════════════════════════════════════════════════════

renderTest('I1 a single-product Credit Note lists that product, and only that product', async () => {
  const { text, pages } = await render(CREDIT_B, [ITEM_B]);
  for (const s of ['ITEM DETAILS', 'Product / Item', 'HSN/SAC', 'Unit', 'Qty', 'Rate', 'GST %',
    'Taxable Amount', 'Coconut Scraper Machine', '85094010', 'PCS', '3,000.00', '6,000.00']) {
    assert.ok(text.includes(s), 'missing: ' + s);
  }
  // The unit has a column of its own: a reader should not have to pick it
  // out of the quantity.
  assert.ok(!text.includes('2 PCS'), 'the quantity and the unit must not share a cell');
  // The note's rate is printed against the product it applies to - once in
  // the tax breakup, and once on the line itself.
  assert.ok(count(text, '18%') >= 2, 'the line must carry its GST rate, not only the breakup');
  assert.ok(!text.includes('Chapathi'), 'a product the note is not for must not appear');
  assert.strictEqual(count(text, 'Coconut Scraper Machine'), 1, 'one row, not a duplicate');
  // Credit wording throughout, and the note's own totals.
  for (const s of ['CREDIT NOTE', 'CREDITED TO', 'Total Credit Amount', 'Rs.6,000.00', 'Rs.1,080.00', 'Rs.7,080.00']) {
    assert.ok(text.includes(s), 'missing: ' + s);
  }
  assert.ok(!/DEBIT/.test(text), 'no debit wording on a credit note');
  assert.strictEqual(pages, 1);
});

renderTest('I2 a single-product Debit Note lists that product with debit wording', async () => {
  const { text, pages } = await render(DEBIT_A, [ITEM_A]);
  for (const s of ['ITEM DETAILS', 'Chapathi Press Machine 8 Inch', '84388090', 'PCS', '27,000.00',
    'DEBIT NOTE', 'DEBITED TO', 'Total Debit Amount', 'Rs.31,860.00']) {
    assert.ok(text.includes(s), 'missing: ' + s);
  }
  assert.ok(!text.includes('1 PCS'), 'the quantity and the unit must not share a cell');
  assert.ok(!text.includes('Coconut'));
  assert.ok(!/CREDIT/.test(text), 'no credit wording on a debit note');
  assert.strictEqual(pages, 1);
});

for (const [label, note] of [['Credit', CREDIT_AB], ['Debit', DEBIT_AB]]) {
  renderTest(`I3 a multi-product ${label} Note lists each product as its own row, in order`, async () => {
    const { text, calls, pages } = await render(note, [ITEM_A, ITEM_B]);
    assert.strictEqual(count(text, 'Chapathi Press Machine 8 Inch'), 1);
    assert.strictEqual(count(text, 'Coconut Scraper Machine'), 1);
    assert.ok(text.indexOf('Chapathi') < text.indexOf('Coconut'), 'in the order saved');
    // Separate rows: the two names are separate draws at different heights.
    const a = calls.find(c => c.s === 'Chapathi Press Machine 8 Inch');
    const b = calls.find(c => c.s === 'Coconut Scraper Machine');
    assert.ok(a && b && b.y > a.y, 'two rows, not one cell');
    for (const s of ['84388090', '85094010', 'PCS', '27,000.00', '6,000.00', 'Rs.33,000.00', 'Rs.38,940.00']) {
      assert.ok(text.includes(s), 'missing: ' + s);
    }
    // Cell by cell: the unit has a column of its own, the quantity is a
    // number on its own, and the note's one GST rate is printed against the
    // product it applies to.
    const rowOf = name => calls
      .filter(c => c.k === 'text' && Math.abs(c.y - calls.find(x => x.s === name).y) < 1e-6)
      .map(c => c.s);
    assert.deepStrictEqual(rowOf('Chapathi Press Machine 8 Inch'),
      ['Chapathi Press Machine 8 Inch', '84388090', 'PCS', '1', '27,000.00', '18%', '27,000.00']);
    assert.deepStrictEqual(rowOf('Coconut Scraper Machine'),
      ['Coconut Scraper Machine', '85094010', 'PCS', '2', '3,000.00', '18%', '6,000.00']);
    assert.ok(!text.includes('1 PCS') && !text.includes('2 PCS'),
      'the quantity and the unit must not share a cell');
    assert.ok(text.includes(label === 'Credit' ? 'Total Credit Amount' : 'Total Debit Amount'));
    assert.strictEqual(pages, 1, 'a two-product note with five bank lines stays on one page');
  });
}

renderTest('I4 a note without items has no ITEM DETAILS section and its old layout', async () => {
  const old = await render(CREDIT_B, []);
  assert.ok(!old.text.includes('ITEM DETAILS'));
  assert.ok(!old.text.includes('Product / Item'));
  assert.ok(!old.text.includes('Coconut'));
  // Called the old way, with no items argument at all, it is the same document.
  const legacy = await render(CREDIT_B);
  const strip = cs => cs.map(c => JSON.stringify(c));
  assert.deepStrictEqual(strip(legacy.calls), strip(old.calls));
  // Bank details stay below the amount in words, where they always were...
  const words = old.calls.find(c => c.s === 'Amount in Words:');
  const bank = old.calls.find(c => c.s === 'Bank Details');
  assert.ok(bank.y > words.y, 'an old note keeps its bank details below');
  // ...while an itemised note carries them beside the tax breakup.
  const withItems = await render(CREDIT_B, [ITEM_B]);
  const w2 = withItems.calls.find(c => c.s === 'Amount in Words:');
  const b2 = withItems.calls.find(c => c.s === 'Bank Details');
  const taxTitle = withItems.calls.find(c => c.s === 'TAX BREAKUP');
  assert.ok(b2.y < w2.y && b2.y > taxTitle.y, 'beside the breakup, above the words');
  assert.ok(b2.x < 100, 'in the left half, clear of the breakup');
});

renderTest('I5 the seal, signature, Authorized Signatory and footer do not move', async () => {
  const old = await render(CREDIT_B, []);
  const ref = blockOf(old.calls, 1);
  assert.ok(ref.forT && ref.seal && ref.sig && ref.auth && ref.rule && ref.divider, 'reference block captured');
  // Exactly where the Tax Invoice puts them.
  // jsPDF's A4 is 297.0000833mm tall, so heights are compared to 0.001mm.
  assert.strictEqual(Math.round(ref.forT[1] * 1000) / 1000, 235.2);
  assert.strictEqual(Math.round(ref.divider * 1000) / 1000, 271);
  for (const [note, items] of [[CREDIT_B, [ITEM_B]], [DEBIT_A, [ITEM_A]], [CREDIT_AB, [ITEM_A, ITEM_B]]]) {
    const r = await render(note, items);
    assert.strictEqual(r.pages, 1);
    const blk = blockOf(r.calls, 1);
    assert.deepStrictEqual({ ...blk, pageNo: blk.pageNo }, { ...ref, pageNo: ref.pageNo },
      `${note.note_number}: the signature block must be exactly where it was`);
  }
});

renderTest('I6 many items continue onto the next page, head repeated, never under the signature', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({
    product_name: `Commercial Kitchen Item ${String(i + 1).padStart(2, '0')}`, hsn_code: '84388090',
    unit: 'PCS', quantity: '1.000', rate: '1000.00', taxable_value: '1000.00', sort_order: i }));
  const note = { ...CREDIT_B, taxable_amount: '45000.00', cgst: '4050.00', sgst: '4050.00',
    gst_amount: '8100.00', total_amount: '53100.00' };
  const { text, calls, doc, pages } = await render(note, many);
  const pageH = doc.internal.pageSize.height;
  assert.ok(pages >= 2, 'forty-five rows need more than one page');

  // Every item once, no row below the foot of its page.
  for (const it of many) assert.strictEqual(count(text, it.product_name), 1, it.product_name);
  const rows = calls.filter(c => c.k === 'text' && /^Commercial Kitchen Item/.test(c.s));
  assert.ok(rows.every(c => c.y <= pageH - 20), 'a row ran past the foot of the page');

  // The column heads start every page the table is on, above its rows.
  const tablePages = [...new Set(rows.map(c => c.page))];
  assert.ok(tablePages.length >= 2, 'the table itself spans pages');
  for (const pg of tablePages) {
    const heads = calls.filter(c => c.page === pg && c.s === 'Product / Item');
    assert.strictEqual(heads.length, 1, 'one head on page ' + pg);
    const first = Math.min(...rows.filter(c => c.page === pg).map(c => c.y));
    assert.ok(heads[0].y < first, 'the head sits above the rows on page ' + pg);
  }

  // The band is on the last page, at the Tax Invoice's height, and nothing
  // of the note's content runs into it.
  const blk = blockOf(calls, pages);
  assert.ok(blk.forT && blk.auth && Math.round(blk.divider * 1000) / 1000 === 271,
    'the signature and footer are on the last page');
  const bandTop = blk.forT[1] + 1.8 - 6;
  const band = s => /^For VTECH/.test(s) || s === 'Authorized Signatory' || /computer-generated/.test(s)
    || s.includes('  |  ') || /^Page \d+ of \d+$/.test(s);
  const intruder = calls.find(c => c.k === 'text' && c.page === pages && !band(c.s) && c.y > bandTop);
  assert.ok(!intruder, `"${intruder && intruder.s}" runs into the signature band`);
  assert.ok(calls.every(c => (c.y === undefined || c.y < pageH) && (c.y1 === undefined || c.y1 < pageH)),
    'nothing drawn past the page');
  // The totals are the note's own, not the rows added up.
  assert.ok(text.includes('Rs.53,100.00'));
});

renderTest('I7 the PDF prints the saved snapshot, not the Product Master', async () => {
  // The name stored when the note was saved; the product has since been
  // renamed, but the document is drawn only from what was stored.
  const { text } = await render(DEBIT_A, [ITEM_A]);
  assert.ok(text.includes('Chapathi Press Machine 8 Inch'));
  assert.ok(!text.includes('Chapathi Press Commercial'));
});

renderTest('I8 missing snapshot values print as a dash, never as an invented figure', async () => {
  const bare = { product_name: 'Service Visit', hsn_code: null, unit: null,
    quantity: null, rate: null, taxable_value: '6000.00', sort_order: 0 };
  const { calls } = await render(CREDIT_B, [bare]);
  const row = calls.filter(c => c.k === 'text' && Math.abs(c.y - calls.find(x => x.s === 'Service Visit').y) < 1e-6);
  const cells = row.map(c => c.s);
  // hsn, unit, quantity and rate are all absent, so all four are dashes. The
  // GST cell is the NOTE's own rate, which is a stored figure, not one
  // invented for the line.
  assert.deepStrictEqual(cells, ['Service Visit', '-', '-', '-', '-', '18%', '6,000.00']);
});

// ═══════════════════════════════════════════════════════════════════════
//  4. The save path, against a disposable database
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('cdnote items API (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cdnote-items-test-secret';

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
let PROD_A, PROD_B, INV_A1, INV_A2, INV_SOLO, INV_OTHER, INV_B1;
let L_A, L_B, L_C, L_X, L_B1;
let A1_BEFORE;

async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const save = (body, token = TOKEN_A) => api('POST', '/api/cdn_notes/save-with-items', { token, body });
const errOf = r => (r.body && r.body.error && r.body.error.message) || '';

// A note header as the page sends it: the customer of INV-A1, 18%, intra-state.
function header(type, number, taxable, extra = {}) {
  const gst = round2(taxable * 18 / 100);
  return { note_type: type, note_number: number, note_date: '2026-09-11',
    customer_name: 'Mega Kitchen System Pvt Ltd', gstin: '33AAACI1681G1ZP', state: 'Tamil Nadu',
    reason: 'Price correction', taxable_amount: taxable, gst_percentage: 18, supply_type: 'intrastate',
    igst: 0, cgst: round2(gst / 2), sgst: round2(gst / 2), gst_amount: gst, total_amount: round2(taxable + gst),
    ...extra };
}
const A1 = () => ({ id: INV_A1, table: 'b2b_invoices' });
const itemsOf = async noteId => (await db.query(
  'SELECT * FROM cdn_note_items WHERE note_id = $1 ORDER BY sort_order', [noteId])).rows;
const noteRow = async noteId => (await db.query('SELECT * FROM cdn_notes WHERE id = $1', [noteId])).rows[0];

async function mkInvoice(userId, table, { number, customer, gst, lines }) {
  const taxable = lines.reduce((t, l) => t + l.taxable, 0);
  const { rows } = await db.query(
    `INSERT INTO ${table} (user_id, customer_name, gst_number, invoice_number, invoice_date,
       supply_type, taxable_amount, gst_percentage, gst_amount, cgst, sgst, igst, total_amount)
     VALUES ($1,$2,$3,$4,'2026-09-01','intrastate',$5,18,$6,$7,$7,0,$8) RETURNING id`,
    [userId, customer, gst, number, taxable, round2(taxable * 0.18), round2(taxable * 0.09), round2(taxable * 1.18)]);
  const id = rows[0].id;
  const ids = [];
  for (const [i, l] of lines.entries()) {
    const r = await db.query(
      `INSERT INTO invoice_items (user_id, invoice_id, invoice_type, product_id, product_name,
         hsn_code, unit, quantity, rate, gst_percentage, taxable_value, gst_amount, total_amount, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,'PCS',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [userId, id, table === 'b2b_invoices' ? 'b2b' : 'b2c', l.product || null, l.name, l.hsn,
        l.qty, l.rate, l.pct || 18, l.taxable, round2(l.taxable * (l.pct || 18) / 100),
        round2(l.taxable * (1 + (l.pct || 18) / 100)), i]);
    ids.push(r.rows[0].id);
  }
  return { id, lines: ids };
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(`INSERT INTO users (email,password_hash) VALUES ('cdi-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(`INSERT INTO users (email,password_hash) VALUES ('cdi-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const prod = async (name, hsn) => (await db.query(
    `INSERT INTO products (user_id, name, hsn_code, unit, gst_percentage, stock)
     VALUES ($1,$2,$3,'PCS',18,0) RETURNING id`, [USER_A, name, hsn])).rows[0].id;
  PROD_A = await prod('Chapathi Press Machine 8 Inch', '84388090');
  PROD_B = await prod('Coconut Scraper Machine', '85094010');

  // The mandatory invoice: Product A x1 at 27000 and Product B x2 at 6000,
  // plus a 12% line to prove one note cannot mix rates.
  const a1 = await mkInvoice(USER_A, 'b2b_invoices', { number: 'INV-A1',
    customer: 'Mega Kitchen System Pvt Ltd', gst: '33AAACI1681G1ZP', lines: [
      { product: PROD_A, name: 'Chapathi Press Machine 8 Inch', hsn: '84388090', qty: 1, rate: 27000, taxable: 27000 },
      { product: PROD_B, name: 'Coconut Scraper Machine', hsn: '85094010', qty: 2, rate: 3000, taxable: 6000 },
      { name: 'Idli Grinder', hsn: '84381010', qty: 1, rate: 1000, taxable: 1000, pct: 12 }] });
  INV_A1 = a1.id; [L_A, L_B, L_C] = a1.lines;
  const a2 = await mkInvoice(USER_A, 'b2b_invoices', { number: 'INV-A2',
    customer: 'Mega Kitchen System Pvt Ltd', gst: '33AAACI1681G1ZP', lines: [
      { name: 'Wet Grinder', hsn: '85094090', qty: 1, rate: 5000, taxable: 5000 }] });
  INV_A2 = a2.id; [L_X] = a2.lines;
  // One number on two invoices - legitimately, one per table.
  await mkInvoice(USER_A, 'b2b_invoices', { number: 'DUP-1', customer: 'Mega Kitchen System Pvt Ltd',
    gst: '33AAACI1681G1ZP', lines: [{ name: 'X', hsn: '1', qty: 1, rate: 1, taxable: 1 }] });
  await mkInvoice(USER_A, 'b2c_invoices', { number: 'DUP-1', customer: 'Cash Sale', gst: null,
    lines: [{ name: 'Y', hsn: '1', qty: 1, rate: 1, taxable: 1 }] });
  INV_SOLO = (await mkInvoice(USER_A, 'b2b_invoices', { number: 'SOLO-1', customer: 'Mega Kitchen System Pvt Ltd',
    gst: '33AAACI1681G1ZP', lines: [{ name: 'Z', hsn: '1', qty: 1, rate: 1, taxable: 1 }] })).id;
  INV_OTHER = (await mkInvoice(USER_A, 'b2b_invoices', { number: 'OTHER-1', customer: 'Someone Else Traders',
    gst: '29AABCU9603R1ZJ', lines: [{ name: 'Z', hsn: '1', qty: 1, rate: 1, taxable: 1 }] })).id;
  const b1 = await mkInvoice(USER_B, 'b2b_invoices', { number: 'INV-B1', customer: 'B Customer',
    gst: '29AAACB1234C1Z5', lines: [{ name: 'B Product', hsn: '84388090', qty: 1, rate: 500, taxable: 500 }] });
  INV_B1 = b1.id; [L_B1] = b1.lines;

  A1_BEFORE = JSON.stringify((await db.query(
    `SELECT i.id, i.product_id, i.product_name, i.quantity, i.rate, i.taxable_value, i.gst_percentage
       FROM invoice_items i WHERE i.invoice_id = $1 ORDER BY sort_order`, [INV_A1])).rows)
    + JSON.stringify((await db.query('SELECT taxable_amount, total_amount FROM b2b_invoices WHERE id = $1', [INV_A1])).rows);

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('D1 the migration is applied: table, composite key, cascade and index', async () => {
  const cols = (await db.query(`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cdn_note_items'`)).rows;
  const nullable = Object.fromEntries(cols.map(c => [c.column_name, c.is_nullable === 'YES']));
  assert.deepStrictEqual(Object.keys(nullable).sort(), ['created_at', 'hsn_code', 'id', 'note_id', 'product_id',
    'product_name', 'quantity', 'rate', 'sort_order', 'taxable_value', 'unit', 'updated_at', 'user_id']);
  for (const c of ['product_id', 'hsn_code', 'unit', 'quantity', 'rate', 'taxable_value']) assert.ok(nullable[c], c + ' nullable');
  for (const c of ['id', 'user_id', 'note_id', 'product_name', 'sort_order']) assert.ok(!nullable[c], c + ' required');
  const def = name => (db.query('SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1', [name]))
    .then(r => (r.rows[0] || {}).d || '');
  assert.match(await def('cdn_note_items_note_fk'),
    /FOREIGN KEY \(note_id, user_id\) REFERENCES cdn_notes\(id, user_id\) ON DELETE CASCADE/);
  assert.match(await def('cdn_notes_id_user_key'), /UNIQUE \(id, user_id\)/);
  const idx = (await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_cdn_note_items_note'`)).rows[0];
  assert.ok(idx && /\(note_id, sort_order\)/.test(idx.indexdef));
  const applied = (await db.query(`SELECT 1 FROM schema_migrations WHERE id = 'migration_cdn_note_items'`)).rows;
  assert.strictEqual(applied.length, 1, 'recorded by the migration runner');
});

test('D2 MANDATORY a Credit Note for Product B stores only Product B, from the invoice', async () => {
  const r = await save({ header: header('credit', 'CN-B', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const rows = await itemsOf(r.body.id);
  assert.strictEqual(rows.length, 1, 'Product A must not be stored');
  const it = rows[0];
  assert.strictEqual(it.product_name, 'Coconut Scraper Machine');
  assert.strictEqual(it.product_id, PROD_B);
  assert.strictEqual(it.hsn_code, '85094010');
  assert.strictEqual(it.unit, 'PCS');
  assert.strictEqual(Number(it.quantity), 2);
  assert.strictEqual(Number(it.rate), 3000);
  assert.strictEqual(Number(it.taxable_value), 6000);
  assert.strictEqual(it.user_id, USER_A);
  const n = await noteRow(r.body.id);
  assert.strictEqual(n.original_invoice_id, INV_A1, 'linked by id');
  assert.strictEqual(n.original_invoice_table, 'b2b_invoices');
  assert.strictEqual(n.original_invoice, 'INV-A1');
  assert.strictEqual(Number(n.taxable_amount), 6000, 'the note keeps its own figures');
  assert.strictEqual(Number(n.cgst), 540);

  if (JSPDF_FILE) {
    const apiNote = (await api('GET', `/api/cdn_notes?eq_id=${r.body.id}`, { token: TOKEN_A })).body[0];
    const apiItems = (await api('GET', `/api/cdn_note_items?eq_note_id=${r.body.id}`, { token: TOKEN_A })).body;
    const { text } = await render(apiNote, apiItems);
    assert.ok(text.includes('ITEM DETAILS') && text.includes('Coconut Scraper Machine'));
    assert.ok(!text.includes('Chapathi'), 'Product A must not appear on the PDF');
  }
});

test('D3 MANDATORY the same note at 7000 is refused, and nothing is written', async () => {
  const before = (await db.query('SELECT COUNT(*)::int n FROM cdn_notes')).rows[0].n;
  const r = await save({ header: header('credit', 'CN-B-7000', 7000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /add up to Rs\.6000\.00, but the note's taxable amount is Rs\.7000\.00/);
  assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM cdn_notes')).rows[0].n, before);
  assert.strictEqual((await db.query(`SELECT COUNT(*)::int n FROM cdn_notes WHERE note_number = 'CN-B-7000'`)).rows[0].n, 0);
});

test('D4 a single-product Debit Note', async () => {
  const r = await save({ header: header('debit', 'DN-A', 27000), invoice: A1(),
    items: [{ invoice_item_id: L_A, quantity: 1 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  const rows = await itemsOf(r.body.id);
  assert.deepStrictEqual(rows.map(x => [x.product_name, x.hsn_code, Number(x.quantity), Number(x.rate), Number(x.taxable_value)]),
    [['Chapathi Press Machine 8 Inch', '84388090', 1, 27000, 27000]]);
  assert.strictEqual((await noteRow(r.body.id)).note_type, 'debit');
});

for (const type of ['credit', 'debit']) {
  test(`D5 a multi-product ${type} note stores both products, as separate rows in order`, async () => {
    const r = await save({ header: header(type, `${type}-AB`, 33000), invoice: A1(),
      items: [{ invoice_item_id: L_A, quantity: 1 }, { invoice_item_id: L_B, quantity: 2 }] });
    assert.strictEqual(r.status, 200, errOf(r));
    const rows = await itemsOf(r.body.id);
    assert.deepStrictEqual(rows.map(x => [x.sort_order, x.product_name, Number(x.taxable_value)]),
      [[0, 'Chapathi Press Machine 8 Inch', 27000], [1, 'Coconut Scraper Machine', 6000]]);
    if (JSPDF_FILE) {
      const { text } = await render(await noteRow(r.body.id), rows);
      assert.strictEqual(count(text, 'Chapathi Press Machine 8 Inch'), 1);
      assert.strictEqual(count(text, 'Coconut Scraper Machine'), 1);
      assert.ok(text.includes(type === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE'));
    }
  });
}

test('D6 a line from a different invoice is refused', async () => {
  const r = await save({ header: header('credit', 'CN-X', 5000), invoice: A1(),
    items: [{ invoice_item_id: L_X, quantity: 1 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /not a line of the selected invoice/);
  const junk = await save({ header: header('credit', 'CN-X2', 5000), invoice: A1(),
    items: [{ invoice_item_id: 'not-a-uuid', quantity: 1 }] });
  assert.strictEqual(junk.status, 400);
});

test('D7 MANDATORY another tenant can use none of it', async () => {
  const mine = await save({ header: header('credit', 'CN-TEN', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(mine.status, 200, errOf(mine));
  const noteId = mine.body.id;
  const bHeader = (n, t) => header('credit', n, t, { customer_name: 'B Customer', gstin: '29AAACB1234C1Z5' });

  // A's invoice, from B: not found, whatever the header says.
  let r = await save({ header: header('credit', 'B-1', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] }, TOKEN_B);
  assert.strictEqual(r.status, 404);
  // B's own invoice, with A's line on it: not a line of that invoice.
  r = await save({ header: bHeader('B-2', 6000), invoice: { id: INV_B1, table: 'b2b_invoices' },
    items: [{ invoice_item_id: L_B, quantity: 2 }] }, TOKEN_B);
  assert.strictEqual(r.status, 400);
  // A's note, edited by B: not found, and A's note and items are untouched.
  r = await save({ editId: noteId, header: bHeader('B-3', 500), invoice: { id: INV_B1, table: 'b2b_invoices' },
    items: [{ invoice_item_id: L_B1, quantity: 1 }] }, TOKEN_B);
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await noteRow(noteId)).note_number, 'CN-TEN');
  assert.strictEqual((await itemsOf(noteId)).length, 1);
  assert.strictEqual((await itemsOf(noteId))[0].product_name, 'Coconut Scraper Machine');
  // B reads none of A's items, and cannot widen the read.
  const bRead = await api('GET', `/api/cdn_note_items?eq_note_id=${noteId}`, { token: TOKEN_B });
  assert.strictEqual(bRead.status, 200);
  assert.strictEqual(bRead.body.length, 0);
  const spoof = await api('GET', `/api/cdn_note_items?eq_note_id=${noteId}&user_id=${USER_A}`, { token: TOKEN_B });
  assert.strictEqual(spoof.body.length, 0);
  // B's own itemised note works, on B's own invoice.
  r = await save({ header: bHeader('B-4', 500), invoice: { id: INV_B1, table: 'b2b_invoices' },
    items: [{ invoice_item_id: L_B1, quantity: 1 }] }, TOKEN_B);
  assert.strictEqual(r.status, 200, errOf(r));
  assert.strictEqual((await itemsOf(r.body.id))[0].user_id, USER_B);
});

test('D8 an item at another GST rate is refused - no averaging, no choosing', async () => {
  let r = await save({ header: header('credit', 'CN-RATE', 1000), invoice: A1(),
    items: [{ invoice_item_id: L_C, quantity: 1 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /12% GST on the invoice, but this note is at 18%\. A note has one GST rate/);
  r = await save({ header: header('credit', 'CN-RATE2', 7000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }, { invoice_item_id: L_C, quantity: 1 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /one GST rate/);
  // At 12% the same line is accepted: the rule is equality, nothing else.
  r = await save({ header: header('credit', 'CN-RATE3', 1000, { gst_percentage: 12, cgst: 60, sgst: 60, gst_amount: 120, total_amount: 1120 }),
    invoice: A1(), items: [{ invoice_item_id: L_C, quantity: 1 }] });
  assert.strictEqual(r.status, 200, errOf(r));
});

test('D9 the invoice must be the note\'s customer\'s, and the quantity within the invoice', async () => {
  let r = await save({ header: header('credit', 'CN-CUST', 1), invoice: { id: INV_OTHER, table: 'b2b_invoices' },
    items: [] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /was issued to Someone Else Traders/);
  r = await save({ header: header('credit', 'CN-QTY', 9000), invoice: A1(), items: [{ invoice_item_id: L_B, quantity: 3 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /the invoice has 2, so the note cannot cover 3/);
  r = await save({ header: header('credit', 'CN-QTY0', 6000), invoice: A1(), items: [{ invoice_item_id: L_B, quantity: 0 }] });
  assert.strictEqual(r.status, 400);
  r = await save({ header: header('credit', 'CN-TWICE', 12000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }, { invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /selected twice/);
  r = await save({ header: header('credit', 'CN-NOINV', 6000), items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /Select the original invoice/);
});

test('D10 MANDATORY an edit replaces the items atomically: Qty 2 / 6000 becomes Qty 1 / 3000', async () => {
  const made = await save({ header: header('credit', 'CN-EDIT', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(made.status, 200, errOf(made));
  const id = made.body.id;

  let r = await save({ editId: id, header: header('credit', 'CN-EDIT', 3000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 1 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  let rows = await itemsOf(id);
  assert.strictEqual(rows.length, 1, 'the old row is gone, not kept beside the new one');
  assert.strictEqual(Number(rows[0].quantity), 1);
  assert.strictEqual(Number(rows[0].taxable_value), 3000);
  assert.strictEqual(Number(rows[0].rate), 3000);
  assert.strictEqual(Number((await noteRow(id)).taxable_amount), 3000);

  // A rejected edit changes nothing at all.
  r = await save({ editId: id, header: header('credit', 'CN-EDIT', 7000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 400);
  rows = await itemsOf(id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].quantity), 1, 'the rejected edit left the items as they were');
  assert.strictEqual(Number((await noteRow(id)).taxable_amount), 3000);

  // Two products, then back to one: never an orphan row.
  r = await save({ editId: id, header: header('credit', 'CN-EDIT', 33000), invoice: A1(),
    items: [{ invoice_item_id: L_A, quantity: 1 }, { invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  assert.strictEqual((await itemsOf(id)).length, 2);
  r = await save({ editId: id, header: header('credit', 'CN-EDIT', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(r.status, 200, errOf(r));
  assert.deepStrictEqual((await itemsOf(id)).map(x => x.product_name), ['Coconut Scraper Machine']);
  // A note still on its invoice must keep saying which products it covers,
  // so emptying the selection is refused and the items it had survive.
  r = await save({ editId: id, header: header('credit', 'CN-EDIT', 6000), invoice: A1(), items: [] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /must say which items it covers/);
  assert.deepStrictEqual((await itemsOf(id)).map(x => x.product_name), ['Coconut Scraper Machine']);
  // Taking it off the invoice is how it becomes a note without items again.
  r = await save({ editId: id, header: header('credit', 'CN-EDIT', 6000, { original_invoice: 'PAPER-ONLY' }), items: [] });
  assert.strictEqual(r.status, 200, errOf(r));
  assert.strictEqual((await itemsOf(id)).length, 0);
  const orphans = (await db.query(
    'SELECT COUNT(*)::int n FROM cdn_note_items i WHERE NOT EXISTS (SELECT 1 FROM cdn_notes n WHERE n.id = i.note_id)')).rows[0].n;
  assert.strictEqual(orphans, 0);
});

test('D11 MANDATORY deleting a note deletes its items, and not the invoice', async () => {
  const made = await save({ header: header('credit', 'CN-DEL', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(made.status, 200, errOf(made));
  const id = made.body.id;
  assert.strictEqual((await itemsOf(id)).length, 1);
  const del = await api('DELETE', `/api/cdn_notes?eq_id=${id}`, { token: TOKEN_A });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.deletedCount, 1);
  assert.strictEqual((await itemsOf(id)).length, 0, 'the items went with the note');
  // A deleted note cannot be downloaded: neither it nor its items read back.
  assert.strictEqual((await api('GET', `/api/cdn_notes?eq_id=${id}`, { token: TOKEN_A })).body.length, 0);
  assert.strictEqual((await api('GET', `/api/cdn_note_items?eq_note_id=${id}`, { token: TOKEN_A })).body.length, 0);
  assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM invoice_items WHERE invoice_id = $1', [INV_A1])).rows[0].n, 3);
});

test('D12 MANDATORY renaming the product later does not change a saved note', async () => {
  const made = await save({ header: header('debit', 'DN-RENAME', 27000), invoice: A1(),
    items: [{ invoice_item_id: L_A, quantity: 1 }] });
  assert.strictEqual(made.status, 200, errOf(made));
  await db.query(`UPDATE products SET name = 'Chapathi Press Commercial' WHERE id = $1`, [PROD_A]);
  try {
    const rows = await itemsOf(made.body.id);
    assert.strictEqual(rows[0].product_name, 'Chapathi Press Machine 8 Inch');
    assert.strictEqual(rows[0].product_id, PROD_A, 'still the same product');
    if (JSPDF_FILE) {
      const apiItems = (await api('GET', `/api/cdn_note_items?eq_note_id=${made.body.id}`, { token: TOKEN_A })).body;
      const { text } = await render(await noteRow(made.body.id), apiItems);
      assert.ok(text.includes('Chapathi Press Machine 8 Inch'));
      assert.ok(!text.includes('Chapathi Press Commercial'));
    }
  } finally {
    await db.query(`UPDATE products SET name = 'Chapathi Press Machine 8 Inch' WHERE id = $1`, [PROD_A]);
  }
});

test('D13 the generic API cannot write items, re-point a note, or unbalance an itemised one', async () => {
  const made = await save({ header: header('credit', 'CN-GEN', 6000), invoice: A1(),
    items: [{ invoice_item_id: L_B, quantity: 2 }] });
  assert.strictEqual(made.status, 200, errOf(made));
  const id = made.body.id;

  assert.strictEqual((await api('POST', '/api/cdn_note_items', { token: TOKEN_A,
    body: { note_id: id, product_name: 'Forged', taxable_value: 6000 } })).status, 405);
  assert.strictEqual((await api('PATCH', `/api/cdn_note_items?eq_note_id=${id}`, { token: TOKEN_A,
    body: { product_name: 'Forged' } })).status, 405);
  assert.strictEqual((await api('DELETE', `/api/cdn_note_items?eq_note_id=${id}`, { token: TOKEN_A })).status, 405);
  assert.strictEqual((await itemsOf(id))[0].product_name, 'Coconut Scraper Machine');

  let r = await api('PATCH', `/api/cdn_notes?eq_id=${id}`, { token: TOKEN_A, body: { taxable_amount: 1 } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(Number((await noteRow(id)).taxable_amount), 6000);
  r = await api('PATCH', `/api/cdn_notes?eq_id=${id}`, { token: TOKEN_A, body: { original_invoice_id: INV_A2 } });
  assert.strictEqual(r.status, 400, 'the link is not writable here');
  r = await api('PATCH', `/api/cdn_notes?eq_id=${id}`, { token: TOKEN_A, body: { reason: 'Updated reason' } });
  assert.strictEqual(r.status, 200, 'everything else stays editable');
  assert.strictEqual((await noteRow(id)).reason, 'Updated reason');

  r = await api('POST', '/api/cdn_notes', { token: TOKEN_A, body: { ...header('credit', 'CN-FORGE', 100),
    original_invoice_id: INV_A1, original_invoice_table: 'b2b_invoices' } });
  assert.strictEqual(r.status, 400);
  // A note without items is as editable as it always was.
  const plain = await save({ header: header('credit', 'CN-PLAIN', 500) });
  assert.strictEqual(plain.status, 200, errOf(plain));
  r = await api('PATCH', `/api/cdn_notes?eq_id=${plain.body.id}`, { token: TOKEN_A, body: { taxable_amount: 600 } });
  assert.strictEqual(r.status, 200);
});

test('D14 a typed invoice number: linked when it names one invoice, refused when it names two', async () => {
  let r = await save({ header: header('credit', 'CN-DUP', 500, { original_invoice: 'DUP-1' }) });
  assert.strictEqual(r.status, 409);
  assert.match(errOf(r), /More than one invoice is numbered "DUP-1"\. Select the invoice/);

  r = await save({ header: header('credit', 'CN-SOLO', 500, { original_invoice: 'solo-1' }) });
  assert.strictEqual(r.status, 200, errOf(r));
  let n = await noteRow(r.body.id);
  assert.strictEqual(n.original_invoice_id, INV_SOLO, 'one match, same customer: linked');
  assert.strictEqual(n.original_invoice, 'SOLO-1', 'written as the invoice is numbered');

  r = await save({ header: header('credit', 'CN-OTHER', 500, { original_invoice: 'OTHER-1' }) });
  assert.strictEqual(r.status, 200, errOf(r));
  n = await noteRow(r.body.id);
  assert.strictEqual(n.original_invoice_id, null, 'another customer\'s invoice is never linked');
  assert.strictEqual(n.original_invoice, 'OTHER-1', 'the typed number is kept');

  r = await save({ header: header('credit', 'CN-EXT', 500, { original_invoice: 'PAPER-99' }) });
  assert.strictEqual(r.status, 200, errOf(r));
  n = await noteRow(r.body.id);
  assert.strictEqual(n.original_invoice_id, null);
  assert.strictEqual(n.original_invoice, 'PAPER-99', 'an invoice outside the system stays as text');
});

test('D15 a note saved without items has no ITEM DETAILS', async () => {
  const r = await save({ header: header('debit', 'DN-OLD', 1000, { original_invoice: 'PAPER-1' }) });
  assert.strictEqual(r.status, 200, errOf(r));
  assert.strictEqual((await itemsOf(r.body.id)).length, 0);
  if (JSPDF_FILE) {
    const items = (await api('GET', `/api/cdn_note_items?eq_note_id=${r.body.id}`, { token: TOKEN_A })).body;
    const { text } = await render(await noteRow(r.body.id), items);
    assert.ok(!text.includes('ITEM DETAILS'));
    assert.ok(text.includes('DEBIT NOTE') && text.includes('Rs.1,180.00'));
  }
});

test('D18 MANDATORY a note on a chosen invoice cannot be saved without naming its products', async () => {
  // An invoice was chosen and no line was ticked: refused, nothing written.
  const r = await save({ header: header('credit', 'CN-NOITEMS', 6000), invoice: A1(), items: [] });
  assert.strictEqual(r.status, 400);
  assert.match(errOf(r), /must say which items it covers/);
  const written = (await db.query('SELECT COUNT(*)::int n FROM cdn_notes WHERE user_id = $1 AND note_number = $2',
    [USER_A, 'CN-NOITEMS'])).rows[0].n;
  assert.strictEqual(written, 0, 'the note must not exist');
  // Leaving the items key out entirely is the same thing.
  const none = await save({ header: header('credit', 'CN-NOITEMS2', 6000), invoice: A1() });
  assert.strictEqual(none.status, 400);
  assert.match(errOf(none), /must say which items it covers/);
  // A note that names no invoice may still carry no products, exactly as
  // every note written before item details existed does.
  const free = await save({ header: header('credit', 'CN-FREE', 6000, { original_invoice: 'PAPER-ONLY' }), items: [] });
  assert.strictEqual(free.status, 200, errOf(free));
  assert.strictEqual((await itemsOf(free.body.id)).length, 0);
});

test('D19 the page shows the affected products prominently and refuses an empty selection', () => {
  assert.match(CDHTML, /AFFECTED PRODUCTS \/ ITEMS/, 'the section must be titled for the products');
  assert.match(CDHTML, /Selected Items:/, 'the count is shown');
  assert.match(CDHTML, /Items Total:/, 'the total is shown');
  const page = code(CDPAGE);
  // The invoice's own figures, then the note's - enough to see exactly which
  // product the note is being raised against.
  for (const head of ['Product', 'HSN/SAC', 'Unit', 'Invoice Qty', 'Invoice Rate', 'Invoice Amount',
    'Note Qty', 'Note Rate', 'Discount %', 'GST %', 'Cess %', 'Note Taxable Amount']) {
    assert.ok(page.includes(head), 'the item table must carry the column ' + head);
  }
  // Only the quantity may be typed into. The invoice's values and the note's
  // rate are shown, never edited - a second editable rate would be a second
  // way to value a line.
  const rows = page.slice(page.indexOf('function renderCDItems()'),
    page.indexOf('function toggleCDItem'));
  assert.strictEqual((rows.match(/type="number"/g) || []).length, 1,
    'Note Qty is the only editable figure - Note Rate and the invoice values are display-only');
  assert.match(rows, /cdLineTaxable\(l, qty\)/,
    'the row total must come from the existing helper, not a second calculation');
  // Told before the round trip, and the server still has the final word.
  assert.match(page, /if \(cdPicked && !picked\.length\)/);
  assert.match(page, /must say which items it covers/);
});

test('D16 the save route and the item read are authenticated', async () => {
  assert.strictEqual((await api('POST', '/api/cdn_notes/save-with-items', { token: null,
    body: { header: header('credit', 'ANON', 1) } })).status, 401);
  assert.strictEqual((await api('POST', '/api/cdn_notes/save-with-items', { token: 'not-a-token',
    body: { header: header('credit', 'ANON', 1) } })).status, 401);
  assert.strictEqual((await api('GET', '/api/cdn_note_items', { token: null })).status, 401);
});

test('D17 the original invoice is never changed by any of it', async () => {
  const now = JSON.stringify((await db.query(
    `SELECT i.id, i.product_id, i.product_name, i.quantity, i.rate, i.taxable_value, i.gst_percentage
       FROM invoice_items i WHERE i.invoice_id = $1 ORDER BY sort_order`, [INV_A1])).rows)
    + JSON.stringify((await db.query('SELECT taxable_amount, total_amount FROM b2b_invoices WHERE id = $1', [INV_A1])).rows);
  assert.strictEqual(now, A1_BEFORE);
});
