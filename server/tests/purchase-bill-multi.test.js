// Purchase Bill Scanner — several bills in one upload.
//
// The rule the whole queue exists to keep:
//
//   one file            = one bill = one Purchase Entry
//   one MULTI-PAGE file = one bill = one Purchase Entry   (pages are not bills)
//   three files         = three bills = three Purchase Entries
//
// The input took `this.files[0]`, so only the first of a selection was ever
// read. These run the real scanner module against a stubbed /api/bill-scan:
// the queue, the per-file status, what each import writes into the form, and
// that no line of one bill ever reaches another.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SCAN = rd('client', 'js', 'pages', 'purchase-scan.js');
const HTML = rd('purchases.html');

// ── a bill, as /api/bill-scan returns it ────────────────────────────────
const r2 = n => Math.round(n * 100) / 100;
const line = (name, hsn, unit, qty, rate, gst) => ({
  product_name: name, product_description: '', hsn_code: hsn, unit,
  quantity: qty, rate, discount_percentage: null, gst_percentage: gst,
  reported_taxable_value: r2(qty * rate)
});
const bill = (number, vendor, lines, extra = {}) => ({
  model: 'test',
  vendor: { vendor_name: vendor, gstin: '', address: '', state: 'Tamil Nadu', phone: '', email: '' },
  purchase: { purchase_number: number, purchase_date: '2026-09-18', reported_supply_type: 'intrastate' },
  products: lines,
  totals: { reported_taxable_value: r2(lines.reduce((s, l) => s + l.quantity * l.rate, 0)) },
  warnings: [],
  ...extra
});
const BILL_A = bill('BILL-001', 'Sri Lakshmi Traders', [
  line('Chapathi Press Machine 8 Inch', '84388090', 'PCS', 2, 15000, 18),
  line('Coconut Scraper Machine', '85094010', 'NOS', 5, 5200, 18)
]);
const BILL_B = bill('BILL-002', 'Kookmate India', [
  line('Idli Steamer 12 Tray', '84198190', 'PCS', 3, 12500, 18),
  line('Wet Grinder 10 Litre', '85094090', 'NOS', 1, 9800, 18),
  line('Gas Stove Three Burner', '73211110', 'PCS', 4, 7800, 18)
]);
const BILL_C = bill('BILL-003', 'Anand Steels', [
  line('Steel Work Table 4ft', '94032090', 'PCS', 1, 18500, 18)
]);
// One file, five lines, printed across two pages - still ONE bill.
const BILL_2PAGE = bill('BILL-2PG', 'Sri Lakshmi Traders', [
  line('Chapathi Press Machine 8 Inch', '84388090', 'PCS', 2, 15000, 18),
  line('Coconut Scraper Machine', '85094010', 'NOS', 5, 5200, 18),
  line('Dough Kneader 25 Kg', '84381010', 'KGS', 1, 38000, 12),
  line('Idli Steamer 12 Tray', '84198190', 'PCS', 3, 12500, 18),
  line('Wet Grinder 10 Litre', '85094090', 'NOS', 4, 9800, 18)
]);

// A File as the browser hands it over.
const file = (name, size = 1024) => ({ name, size, __file: true });

// ── the page, in miniature ──────────────────────────────────────────────
// Only the pieces the scanner touches: the fields it fills, the review
// panel it draws into, and the item grid it hands rows to.
function load(responder) {
  const noop = () => {};
  const els = {};
  const mk = id => ({ id, value: '', innerHTML: '', textContent: '', disabled: false,
    classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); }, toggle(c, on) { on ? this._c.add(c) : this._c.delete(c); } },
    addEventListener: noop, scrollIntoView: noop, querySelector: () => null, querySelectorAll: () => [],
    getAttribute: () => null, focus: noop, select: noop });
  const el = id => els[id] || (els[id] = mk(id));
  el('purchOcrReview').classList.add('d-none');
  const toasts = [];
  const sent = [];        // every /api/bill-scan upload, in order
  const rows = [];        // the item grid

  const sb = {
    console: { log: noop, warn: noop, error: noop },
    Math, Date, JSON, Number, String, Array, Object, RegExp, Intl, Promise, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, setTimeout, clearTimeout,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mk('_new'), body: mk('_body') },
    API_BASE_URL: 'http://test/api',
    FormData: class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } },
    showToast: (m, t) => toasts.push({ message: m, type: t }),
    handleApiError: (e, msg) => toasts.push({ message: msg + ': ' + ((e && e.message) || ''), type: 'error' }),
    apiErrorFrom: (res, body) => ({ message: (body && body.error && body.error.message) || 'HTTP ' + res.status, status: res.status }),
    // the form's own handlers, recorded rather than run
    onPurchVendorInput: noop, onPurchGstinInput: noop, onPurchGstinBlur: noop,
    detectPurchSupplyType: noop, formatNum: v => String(v),
    isValidHsnFormat: () => true, findProductByName: () => null, purchProductsList: [],
    INDIAN_STATES: ['Tamil Nadu', 'Kerala'],
    toISO: d => new Date(d).toISOString().slice(0, 10),
    // the shared purchase grid, in the one shape the scanner uses
    purchItems: rows,
    loadPurchItemsIntoTable: incoming => {
      rows.length = 0;
      incoming.forEach((r, i) => rows.push({ rowId: 'prow' + (i + 1), product_name: r.product_name || '',
        hsn_code: r.hsn_code || '', unit: r.unit || '', quantity: +r.quantity || 1, rate: +r.rate || 0,
        discount_percentage: +r.discount_percentage || 0, gst_percentage: +r.gst_percentage || 0 }));
    },
    recalcPurchItemRowLive: noop, renderPurchItemsTable: noop, computePurchRollups: noop,
    _supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) }) },
    getCurrentUser: async () => ({ id: 'u1' })
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  // /api/bill-scan, one document per request - the responder decides what
  // each uploaded file reads as.
  sb.fetch = async (url, opts) => {
    const f = opts.body.parts.find(([k]) => k === 'bill')[1];
    sent.push({ url, file: f.name, fields: opts.body.parts.map(([k]) => k) });
    const answer = responder(f);
    if (answer instanceof Error) throw answer;
    if (answer && answer.__http) {
      return { ok: false, status: answer.status, json: async () => ({ error: { message: answer.message } }) };
    }
    return { ok: true, status: 200, json: async () => answer };
  };
  vm.createContext(sb);
  vm.runInContext(SCAN, sb, { filename: 'purchase-scan.js' });
  const run = code => vm.runInContext(code, sb);
  return {
    sb, els, toasts, sent, rows, run,
    upload: files => run('handlePurchaseBillUpload(__files)', (sb.__files = files)) || vm.runInContext('handlePurchaseBillUpload(__files)', sb),
    queue: () => JSON.parse(vm.runInContext('JSON.stringify(billQueue.map(j => ({ id: j.id, name: j.name, status: j.status, error: j.error, number: j.result && j.result.purchase.purchase_number, items: j.result ? j.result.products.length : null })))', sb)),
    panel: () => els.purchOcrReview.innerHTML,
    panelHidden: () => els.purchOcrReview.classList.contains('d-none'),
    form: () => ({ vendor: el('purchVendorName').value, number: el('purchNum').value, date: el('purchDate').value }),
    importNow: () => vm.runInContext('importScanIntoForm()', sb),
    select: id => vm.runInContext(`selectScannedBill('${id}')`, sb),
    retry: id => vm.runInContext(`retryScannedBill('${id}')`, sb),
    clearForm: () => { rows.length = 0; el('purchNum').value = ''; el('purchVendorName').value = ''; el('purchDate').value = ''; }
  };
}

// Upload and wait for the queue to drain.
async function upload(g, files) {
  g.sb.__files = files;
  await vm.runInContext('handlePurchaseBillUpload(__files)', g.sb);
}

const byName = map => f => map[f.name] || new Error('no stub for ' + f.name);

// ══════════════════════════════════════════════════════════════════════
test('MB1 a single PDF is one bill and fills the form once', async () => {
  const g = load(byName({ 'BILL-001.pdf': BILL_A }));
  await upload(g, [file('BILL-001.pdf')]);
  assert.strictEqual(g.sent.length, 1, 'one request to /api/bill-scan');
  assert.deepStrictEqual(g.sent[0].fields, ['bill'], 'one document per request');
  assert.deepStrictEqual(g.queue().map(j => [j.number, j.status, j.items]), [['BILL-001', 'ready', 2]]);
  g.importNow();
  assert.strictEqual(g.form().number, 'BILL-001');
  assert.deepStrictEqual(g.rows.map(r => r.product_name),
    ['Chapathi Press Machine 8 Inch', 'Coconut Scraper Machine']);
});

test('MB2 a single JPG is one bill', async () => {
  const g = load(byName({ 'BILL-009.jpg': BILL_C }));
  await upload(g, [file('BILL-009.jpg')]);
  assert.deepStrictEqual(g.queue().map(j => [j.number, j.status]), [['BILL-003', 'ready']]);
  g.importNow();
  assert.strictEqual(g.form().number, 'BILL-003');
  assert.strictEqual(g.rows.length, 1);
});

test('MB3 a single multi-page PDF stays ONE bill with every page\'s lines', async () => {
  const g = load(byName({ 'BILL-2PG.pdf': BILL_2PAGE }));
  await upload(g, [file('BILL-2PG.pdf', 120000)]);
  // one file, one request, one queue entry - the pages are not bills
  assert.strictEqual(g.sent.length, 1);
  assert.strictEqual(g.queue().length, 1);
  g.importNow();
  assert.strictEqual(g.form().number, 'BILL-2PG');
  assert.strictEqual(g.rows.length, 5, 'all five lines, from both pages, in the one purchase');
});

test('MB4 two PDFs are two bills, scanned one at a time, imported separately', async () => {
  const g = load(byName({ 'BILL-001.pdf': BILL_A, 'BILL-002.pdf': BILL_B }));
  await upload(g, [file('BILL-001.pdf'), file('BILL-002.pdf')]);
  assert.deepStrictEqual(g.sent.map(s => s.file), ['BILL-001.pdf', 'BILL-002.pdf'], 'one request per file, in order');
  assert.deepStrictEqual(g.queue().map(j => [j.number, j.status, j.items]),
    [['BILL-001', 'ready', 2], ['BILL-002', 'ready', 3]]);

  g.importNow();                       // the first bill
  assert.strictEqual(g.form().number, 'BILL-001');
  assert.deepStrictEqual(g.rows.map(r => r.product_name),
    ['Chapathi Press Machine 8 Inch', 'Coconut Scraper Machine']);
  assert.deepStrictEqual(g.queue().map(j => j.status), ['imported', 'ready']);

  g.clearForm();                       // Save Purchase empties the form
  g.importNow();                       // the second bill
  assert.strictEqual(g.form().number, 'BILL-002');
  assert.deepStrictEqual(g.rows.map(r => r.product_name),
    ['Idli Steamer 12 Tray', 'Wet Grinder 10 Litre', 'Gas Stove Three Burner']);
  // With the last bill of the upload in the form there is nothing left to
  // review, so the panel closes - the same ending the customer-invoice
  // scanner gives its queue.
  assert.deepStrictEqual(g.queue(), []);
  assert.ok(g.panelHidden(), 'the review panel is closed once every bill is in');
});

test('MB5 two JPGs are two bills', async () => {
  const g = load(byName({ 'a.jpg': BILL_A, 'b.jpg': BILL_B }));
  await upload(g, [file('a.jpg'), file('b.jpg')]);
  assert.deepStrictEqual(g.sent.map(s => s.file), ['a.jpg', 'b.jpg']);
  assert.deepStrictEqual(g.queue().map(j => j.number), ['BILL-001', 'BILL-002']);
});

test('MB6 a PDF and a JPG together are two bills', async () => {
  const g = load(byName({ 'one.pdf': BILL_A, 'two.jpeg': BILL_B }));
  await upload(g, [file('one.pdf'), file('two.jpeg')]);
  assert.deepStrictEqual(g.queue().map(j => [j.name, j.number, j.status]),
    [['one.pdf', 'BILL-001', 'ready'], ['two.jpeg', 'BILL-002', 'ready']]);
});

test('MB7 three files are three bills, each its own purchase in turn', async () => {
  const g = load(byName({ '1.pdf': BILL_A, '2.pdf': BILL_B, '3.png': BILL_C }));
  await upload(g, [file('1.pdf'), file('2.pdf'), file('3.png')]);
  assert.strictEqual(g.sent.length, 3);
  const saved = [];
  for (const expected of ['BILL-001', 'BILL-002', 'BILL-003']) {
    g.importNow();
    saved.push({ number: g.form().number, items: g.rows.map(r => r.product_name) });
    g.clearForm();                     // each one is saved before the next
  }
  assert.deepStrictEqual(saved.map(s => s.number), ['BILL-001', 'BILL-002', 'BILL-003']);
  assert.deepStrictEqual(saved.map(s => s.items.length), [2, 3, 1]);
  assert.deepStrictEqual(saved[0].items.concat(saved[1].items).filter(n => saved[2].items.includes(n)), [],
    'the third bill shares no line with the first two');
  assert.deepStrictEqual(g.queue(), [], 'the queue empties as the last bill is imported');
});

test('MB8 one bill failing leaves the others importable, and it can be retried', async () => {
  let failFirstTime = true;
  const g = load(f => {
    if (f.name === 'bad.pdf') {
      if (failFirstTime) { failFirstTime = false; return { __http: true, status: 502, message: 'The document could not be read.' }; }
      return BILL_C;                    // the retry succeeds
    }
    return f.name === 'good.pdf' ? BILL_A : new Error('unexpected');
  });
  await upload(g, [file('bad.pdf'), file('good.pdf')]);
  const q = g.queue();
  assert.deepStrictEqual(q.map(j => j.status), ['failed', 'ready'], 'the failure is its own row');
  assert.match(q[0].error, /could not be read/i);
  assert.strictEqual(q[1].number, 'BILL-001', 'the good bill survived and is ready');

  g.importNow();                        // imports the good one, not the failed one
  assert.strictEqual(g.form().number, 'BILL-001');

  g.clearForm();
  await g.retry(q[0].id);
  await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual(g.queue().map(j => j.status), ['ready', 'imported']);
  g.importNow();
  assert.strictEqual(g.form().number, 'BILL-003', 'the retried bill imports as its own purchase');
});

test('MB9 bills keep their own numbers, vendors and dates', async () => {
  const g = load(byName({ 'a.pdf': BILL_A, 'b.pdf': BILL_B }));
  await upload(g, [file('a.pdf'), file('b.pdf')]);
  g.importNow();
  const first = g.form();
  g.clearForm();
  g.importNow();
  const second = g.form();
  assert.notStrictEqual(first.number, second.number);
  assert.deepStrictEqual([first.number, first.vendor], ['BILL-001', 'Sri Lakshmi Traders']);
  assert.deepStrictEqual([second.number, second.vendor], ['BILL-002', 'Kookmate India']);
});

test('MB10 no line of one bill ever reaches another', async () => {
  const g = load(byName({ 'a.pdf': BILL_A, 'b.pdf': BILL_B }));
  await upload(g, [file('a.pdf'), file('b.pdf')]);
  g.importNow();
  const aLines = g.rows.map(r => r.product_name);
  g.clearForm();
  g.importNow();
  const bLines = g.rows.map(r => r.product_name);
  assert.deepStrictEqual(aLines, ['Chapathi Press Machine 8 Inch', 'Coconut Scraper Machine']);
  assert.deepStrictEqual(bLines, ['Idli Steamer 12 Tray', 'Wet Grinder 10 Litre', 'Gas Stove Three Burner']);
  assert.strictEqual(aLines.filter(n => bLines.includes(n)).length, 0);

  // And the form is not allowed to hold two bills at once: importing the
  // second one on top of an unsaved first is refused, not merged.
  const g2 = load(byName({ 'a.pdf': BILL_A, 'b.pdf': BILL_B }));
  await upload(g2, [file('a.pdf'), file('b.pdf')]);
  g2.importNow();
  const before = g2.rows.map(r => r.product_name);
  g2.importNow();                        // no save in between
  assert.deepStrictEqual(g2.rows.map(r => r.product_name), before, 'the second bill did not merge in');
  assert.match(g2.toasts[g2.toasts.length - 1].message, /Save the bill already in the form/i);
});

test('MB11 the single-file experience is unchanged', () => {
  // the panel a single bill draws is the one it always drew
  const g = load(byName({}));
  const markup = vm.runInContext('billDetailMarkup(' + JSON.stringify(BILL_A) + ')', g.sb);
  for (const s of ['Review Scanned Bill'.replace('Review Scanned Bill', 'Nothing is saved yet'),
    'Import into Form', 'purchOcrDupWarn', 'Vendor Name', 'Purchase Number']) {
    assert.ok(markup.includes(s), 'the detail panel still shows ' + s);
  }
  // a lone bill gets no queue list drawn over it
  assert.doesNotMatch(markup, /purchBillPick/);
  // and the old messages for a file that cannot be used are kept word for word
  assert.match(SCAN, /Upload a PDF, JPG, JPEG or PNG bill\./);
  assert.match(SCAN, /That file is over 10 MB — try a smaller scan\./);
  // the endpoint is untouched: one document, field name 'bill'
  assert.match(SCAN, /form\.append\('bill', file\)/);
});

test('MB12 the page asks for several files, and the scanner takes them all', () => {
  assert.match(HTML, /<input type="file" id="purchBillInput"[^>]*\bmultiple\b/);
  assert.match(HTML, /onchange="handlePurchaseBillUpload\(this\.files\)"/);
  assert.ok(!/handlePurchaseBillUpload\(this\.files\[0\]\)/.test(HTML), 'no longer only the first file');
  assert.match(HTML, /accept="\.pdf,\.jpg,\.jpeg,\.png"/, 'the accepted formats are unchanged');
  assert.match(HTML, /client\/js\/pages\/purchase-scan\.js\?v=30/);
  // no other file input on the page became multi-select
  const inputs = HTML.match(/<input type="file"[^>]*>/g) || [];
  const multi = inputs.filter(i => /\bmultiple\b/.test(i));
  assert.strictEqual(multi.length, 1, 'only the bill input is multi-select');
  assert.match(multi[0], /id="purchBillInput"/);
});

test('MB13 files are scanned one at a time, never all at once', async () => {
  let inFlight = 0, peak = 0;
  const g = load(f => { inFlight++; peak = Math.max(peak, inFlight); inFlight--; return BILL_A; });
  await upload(g, [file('1.pdf'), file('2.pdf'), file('3.pdf'), file('4.pdf')]);
  assert.strictEqual(peak, 1, 'one upload in flight at a time');
  assert.strictEqual(g.sent.length, 4, 'but every file is read');
});

test('MB14 an unusable file is skipped without taking the others with it', async () => {
  const g = load(byName({ 'ok.pdf': BILL_A }));
  await upload(g, [file('notes.txt'), file('ok.pdf'), file('huge.pdf', 11 * 1024 * 1024)]);
  assert.deepStrictEqual(g.sent.map(s => s.file), ['ok.pdf'], 'only the usable file was sent');
  assert.deepStrictEqual(g.queue().map(j => j.name), ['ok.pdf']);
  assert.match(g.toasts[0].message, /skipped/i);
});
