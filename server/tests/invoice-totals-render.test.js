// The totals boxes must be DRAWN, not merely computed.
//
// Every figure on the invoice summary lives in an <input> or <span> that
// carries no value in the markup: Subtotal, GST Amount, Round Off, Grand
// Total, and the payment preview's Grand Total / Amount Received /
// Remaining Balance / Status. They are filled in by computeInvoiceRollups()
// and nothing else.
//
// The bug these pin: initInvoiceItems() opens a new invoice with one blank
// row via addItemRow(), which rendered the table but never ran the rollup —
// so on a brand-new invoice every one of those boxes stayed literally
// empty until the user happened to type into a line. removeItemRow() had
// always recomputed; addItemRow() never did.
//
// Nothing here checks the arithmetic — invoice-transport-charge.test.js
// does that. These check that the numbers reach the screen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');

const noop = () => {};
const mkEl = (value) => ({
  value: value === undefined ? '' : value,
  textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop
});

// Every id the two boxes are made of. All start empty, exactly as the
// markup leaves them.
const TOTALS_IDS = ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
  'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsAmountWords',
  'itemsTransportCharge', 'itemsTransportGst', 'itemsTableBody', 'itemsSection',
  'productSyncNotice', 'itemsProductDatalist'];
const PREVIEW_IDS = ['invPaymentPreview', 'invPreviewTotal', 'invPreviewReceived',
  'invPreviewBalance', 'invPreviewStatus', 'invPaymentAmountError',
  'invPaymentStatus', 'invPaymentAmount'];

function load({ supply = 'intrastate' } = {}) {
  const store = new Map();
  for (const id of [...TOTALS_IDS, ...PREVIEW_IDS]) store.set(id, mkEl());
  store.set('invSupply', mkEl(supply));
  store.set('invPaymentStatus', mkEl('unpaid'));

  const el = mkEl();
  const sb = {
    console: { log: noop, warn: noop, error: noop }, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
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
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    _supabase: { from: () => ({}) }, readMaybeOne: async () => null, readAll: async () => [[]]
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(rd('client', 'js', 'pages', 'payments.js'), sb, { filename: 'payments.js' });
  vm.runInContext(ITEMS, sb, { filename: 'invoice-items.js' });
  // The two pieces invoice-entry.js contributes to this flow, copied as
  // they are declared there: the preview's field map, and the one-line
  // wrapper computeInvoiceRollups() calls by name.
  vm.runInContext(`
    itemsFormPrefix = 'invoice';
    showToast = function () {};
    const INVOICE_PAYMENT_PREVIEW = {
      box: 'invPaymentPreview', total: 'invPreviewTotal', received: 'invPreviewReceived',
      balance: 'invPreviewBalance', status: 'invPreviewStatus', error: 'invPaymentAmountError',
      statusField: 'invPaymentStatus', amountField: 'invPaymentAmount',
      amountLabel: 'Amount Received',
      getTotal: () => +computeInvoiceRollups().total_amount || 0
    };
    function renderInvPaymentPreview(grandTotal) {
      renderPaymentPreview(INVOICE_PAYMENT_PREVIEW, grandTotal);
    }
  `, sb);
  sb.__el = (id) => store.get(id);
  sb.__setTransport = (v) => { store.get('itemsTransportCharge').value = v; };
  sb.__setItems = (rows) => vm.runInContext('currentItems = ' + JSON.stringify(rows) + ';', sb);
  sb.__reset = () => vm.runInContext('currentItems = [];', sb);
  return sb;
}

// What a fresh page load does: initInvoiceItems() renders the shell and
// opens one blank row. Everything else it does (product list, datalist,
// draft autosave) is unrelated to the totals.
function freshLoad(opts) {
  const sb = load(opts);
  sb.__reset();
  sb.renderItemsSectionShell('itemsSection');
  sb.addItemRow();
  return sb;
}

const drawn = (sb, id) => String(sb.__el(id).value || sb.__el(id).textContent || sb.__el(id).innerHTML || '');

function assertAllDrawn(sb, where) {
  for (const id of ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal']) {
    assert.notStrictEqual(drawn(sb, id), '', `${where}: #${id} must not be blank`);
  }
  for (const id of ['invPreviewTotal', 'invPreviewReceived', 'invPreviewBalance']) {
    assert.notStrictEqual(drawn(sb, id), '', `${where}: #${id} must not be blank`);
    assert.match(drawn(sb, id), /₹|—/, `${where}: #${id} must show a money value`);
  }
  assert.match(drawn(sb, 'invPreviewStatus'), /badge/,
    `${where}: the Status badge must be rendered`);
}

const MACHINE = {
  rowId: 'r1', product_id: 'p1', product_name: 'Machine', hsn_code: '84388090', unit: 'PCS',
  quantity: 1, rate: 2700, discount_percentage: 0, gst_percentage: 18,
  gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0,
  taxable_value: 2700, gst_amount: 486, igst: 0, cgst: 243, sgst: 243,
  total_amount: 3186, locked: false
};

// ═══ 1: a brand-new invoice ═══════════════════════════════════════════

test('D1 a brand-new invoice draws every total, before anything is typed', () => {
  const sb = freshLoad();
  assertAllDrawn(sb, 'new invoice');
  // An empty invoice is worth zero — and says so, rather than saying nothing.
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '0.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹0.00');
  assert.strictEqual(drawn(sb, 'invPreviewBalance'), '₹0.00');
});

test('D1b addItemRow recomputes, exactly as removeItemRow always has', () => {
  const add = ITEMS.slice(ITEMS.indexOf('function addItemRow'), ITEMS.indexOf('function removeItemRow'));
  const remove = ITEMS.slice(ITEMS.indexOf('function removeItemRow'));
  assert.match(add, /computeInvoiceRollups\(\);/, 'adding a row must draw the totals');
  assert.match(remove.slice(0, remove.indexOf('\n}')), /computeInvoiceRollups\(\);/);
  // ...and it is not a SECOND calculation, just the one that already exists.
  assert.strictEqual((add.match(/computeInvoiceRollups\(\)/g) || []).length, 1);
});

// ═══ 2, 6, 7: with a transport charge, both supply types ══════════════

test('D2 a new invoice with transport 1000 draws 4366 in both boxes (intra)', () => {
  const sb = freshLoad({ supply: 'intrastate' });
  sb.__setItems([MACHINE]);
  sb.__setTransport('1000');
  sb.computeInvoiceRollups();
  assertAllDrawn(sb, 'intra + transport');
  assert.strictEqual(drawn(sb, 'itemsSubtotal'), '3,700.00');
  assert.strictEqual(drawn(sb, 'itemsGstAmt'), '666.00');
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '4,366.00');
  assert.strictEqual(drawn(sb, 'itemsTransportGst'), '180.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹4,366.00');
  assert.strictEqual(drawn(sb, 'invPreviewBalance'), '₹4,366.00', 'nothing received yet');
});

test('D7 inter-state draws the same grand total, through IGST', () => {
  const inter = { ...MACHINE, igst: 486, cgst: 0, sgst: 0 };
  const sb = freshLoad({ supply: 'interstate' });
  sb.__setItems([inter]);
  sb.__setTransport('1000');
  sb.computeInvoiceRollups();
  assertAllDrawn(sb, 'inter + transport');
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '4,366.00');
  assert.strictEqual(drawn(sb, 'itemsIGST'), '666.00');
  assert.strictEqual(drawn(sb, 'itemsCGST'), '0.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹4,366.00');
});

// ═══ 1 (no transport) — the regression that matters most ══════════════

test('D3 with no transport the boxes read exactly what they always did', () => {
  const sb = freshLoad();
  sb.__setItems([MACHINE]);
  sb.computeInvoiceRollups();
  assertAllDrawn(sb, 'no transport');
  assert.strictEqual(drawn(sb, 'itemsSubtotal'), '2,700.00');
  assert.strictEqual(drawn(sb, 'itemsGstAmt'), '486.00');
  assert.strictEqual(drawn(sb, 'itemsRoundOff'), '+0.00');
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '3,186.00');
  assert.strictEqual(drawn(sb, 'itemsTransportGst'), '0.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹3,186.00');
});

// ═══ 4, 5: edit and clear keep drawing ════════════════════════════════

test('D4/D5 editing then clearing the charge keeps every box populated', () => {
  const sb = freshLoad();
  sb.__setItems([MACHINE]);

  sb.__setTransport('1000');
  sb.computeInvoiceRollups();
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '4,366.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹4,366.00');

  sb.__setTransport('1500');
  sb.computeInvoiceRollups();
  assertAllDrawn(sb, 'after edit');
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '4,956.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹4,956.00');

  sb.__setTransport('');
  sb.computeInvoiceRollups();
  assertAllDrawn(sb, 'after clear');
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '3,186.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹3,186.00');
  assert.strictEqual(drawn(sb, 'itemsTransportGst'), '0.00');
});

// ═══ 3: reopening a saved invoice ═════════════════════════════════════

test('D6 reopening a saved invoice draws its totals', () => {
  // loadInvoiceForEdit fills the lines and then restores the charge, which
  // re-runs the rollup — the same path a fresh load takes.
  const sb = freshLoad();
  sb.__setItems([MACHINE]);
  sb.restoreInvoiceTransport({ transport_charge: 1000 });
  assertAllDrawn(sb, 'reopened');
  assert.strictEqual(drawn(sb, 'itemsGrandTotal'), '4,366.00');
  assert.strictEqual(drawn(sb, 'invPreviewTotal'), '₹4,366.00');

  // ...and one saved with none reopens at its own total.
  const plain = freshLoad();
  plain.__setItems([MACHINE]);
  plain.restoreInvoiceTransport({ transport_charge: null });
  assertAllDrawn(plain, 'reopened, no transport');
  assert.strictEqual(drawn(plain, 'itemsGrandTotal'), '3,186.00');
});

// ═══ The panel that was permanently on screen ═════════════════════════

test('D8 every modal is hidden until it is opened', () => {
  // .modal-overlay is the hidden-by-default container (display:none, and
  // .modal-overlay.open makes it flex). .modal is the white card INSIDE
  // it and has no hidden state of its own — so a panel whose outer element
  // is .modal renders permanently, and the class its JS toggles does
  // nothing. That is what put a floating panel on the invoice page.
  const CSS = rd('client', 'css', 'style.css');
  assert.match(CSS, /\.modal-overlay\s*\{[^}]*display:\s*none/,
    'the overlay is what hides a modal');
  assert.match(CSS, /\.modal-overlay\.open\s*\{\s*display:\s*flex/);
  assert.ok(!/\.modal\.open\s*\{/.test(CSS),
    'there is no .modal.open rule, so .modal must never be the toggled element');

  // The pages whose panels have been corrected. products.html,
  // purchases.html, purchase-returns.html and stock-serials.html carry the
  // same defect on their serial panel and are NOT here yet — that fix is a
  // separate change. Move each one into this list as it lands, rather than
  // asserting a state the repository has not reached.
  const PAGES = ['invoice.html', 'sales-returns.html', 'purchase-orders.html'];

  for (const page of PAGES) {
    const html = rd(page);
    // Anything carrying an id that JS toggles must be an overlay.
    const bad = [...html.matchAll(/<div class="modal"\s+id="([^"]+)"/g)].map(m => m[1]);
    assert.deepStrictEqual(bad, [],
      page + ': these panels would be permanently visible: ' + bad.join(', '));
    // ...and the class the JS toggles is the one the CSS acts on.
    if (/id="serialPanel"/.test(html)) {
      assert.match(html, /<div class="modal-overlay" id="serialPanel">/,
        page + ': the serial panel must be an overlay');
    }
    // The stale wrapper class the CSS never defined.
    assert.ok(!/class="modal-content/.test(html),
      page + ': .modal-content is not a class this stylesheet defines');
  }

  // The other half of the same bug: a panel can be a correct overlay and
  // still never open, if its JS toggles a class the stylesheet has no rule
  // for. 'open' is the only one that does anything.
  for (const js of ['purchase-order-list.js', 'serial-entry.js', 'stock-serials.js']) {
    const src = rd('client', 'js', 'pages', js);
    const toggles = [...src.matchAll(/classList\.(?:add|remove)\('([^']+)'\)/g)].map(m => m[1]);
    for (const cls of toggles) {
      if (cls === 'open') continue;
      assert.ok(new RegExp('\\.' + cls + '\\b').test(CSS),
        js + ": toggles '" + cls + "', which this stylesheet never defines");
    }
  }
});
