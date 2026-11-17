// What Payment Status a NEW purchase opens on, and what follows from it.
//
// A purchase from a supplier is usually settled when it is entered, so the
// form opens on Paid in Full rather than Unpaid. The point of these tests is
// that nothing was duplicated to make that work: 'paid' already MEANS the
// whole Grand Total, in the preview and in what Save records, so the Amount
// Paid is derived from the total every time it is read and cannot fall out of
// step with it. PP1-PP6 are the acceptance cases A-F from the brief.
//
// The real functions run here: purchase-entry.js over the real payments.js
// derivation and the real utils.js formatting, against a DOM stub that holds
// values the way elements do.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ENTRY = rd('client', 'js', 'pages', 'purchase-entry.js');
const PAGE = rd('purchases.html');
const MIRROR = rd('server', 'public', 'purchases.html');

// The payment fields and the preview boxes, as elements: a value, a
// textContent, and a class list that records what was toggled.
function page({ total = 0 } = {}) {
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, value: '', innerHTML: '', textContent: '', disabled: false,
    _cls: new Set(),
    classList: {
      add: (c) => els[id]._cls.add(c),
      remove: (c) => els[id]._cls.delete(c),
      contains: (c) => els[id]._cls.has(c),
      toggle: (c, on) => { if (on) els[id]._cls.add(c); else els[id]._cls.delete(c); }
    },
    focus() { this.focused = true; }
  });

  const log = { toasts: [], reads: [], loadedItems: [], saves: [], payments: [], errors: [] };
  let grandTotal = total;
  const chain = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => chain) });

  const sb = {
    console, JSON, Math, Date, Object, Array, String, Number, Promise, Error, URLSearchParams, parseFloat, isNaN,
    document: { getElementById: (id) => (id in els ? els[id] : el(id)), querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {},
      // utils.js applies the stored theme the moment it loads.
      documentElement: { setAttribute() {}, removeAttribute() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' },
    setTimeout: (fn) => fn,
    showToast: (m, t = 'success') => log.toasts.push([t, m]),
    // The grid's total, which is the only thing 'paid' depends on.
    computePurchRollups: () => ({ total_amount: grandTotal }),
    // Collaborators this file does not exercise.
    getCurrentUser: async () => ({ id: 'u1' }),
    requireAuth: async () => ({ id: 'u1' }),
    initNavUser() {}, setupLogoutBtn() {}, setupMobileMenu() {},
    loadUserProfile: async () => {}, populatePurchStateOptions() {},
    populateGstCategorySelect() {}, loadPurchVendorsList: async () => {},
    initPurchaseItems: async () => {}, resetPurchaseItems() {},
    loadPurchItemsIntoTable: (rows) => log.loadedItems.push(rows),
    detectPurchSupplyType() {}, updatePurchGstinValidationStatus() {},
    renderGstinStatusInto() {}, updatePurchVendorPrompt() {},
    validateGstin: () => ({ valid: true }),
    // The edit tests put the record being opened here. A save test
    // leaves it unset, which is the duplicate-number check finding
    // nothing - null, not undefined, which would mean the check failed.
    readMaybeOne: async () => { log.reads.push('one'); return sb.__record ?? null; },
    readAll: async () => { log.reads.push('all'); return [sb.__items || []]; },
    sessionStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    // Chainable like the query builder it stands in for: .select().eq()
    // .single() all return it, and readMaybeOne/readAll below are what
    // actually answer. `then` is undefined so it is never await-ed as a
    // promise by mistake.
    _supabase: { from: () => chain },
    GST_CUSTOMER_CATEGORY_DEFAULT: 'regular',
    toISO: () => '2026-11-17',
    // Save's collaborators: the row write and the payments ledger.
    savePurchaseWithItems: async (...a) => { log.saves.push(JSON.parse(JSON.stringify(a))); return 'p-new'; },
    recordPayment: async (...a) => { log.payments.push(JSON.parse(JSON.stringify(a))); return { ok: true }; },
    handleApiError: (e, m) => log.errors.push(m)
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  // The real helpers, not stand-ins: formatNum/round2 from utils.js and the
  // whole payment derivation from payments.js.
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(rd('client', 'js', 'pages', 'payments.js'), sb, { filename: 'payments.js' });
  vm.runInContext(ENTRY, sb, { filename: 'purchase-entry.js' });
  // Two of the stubs above are replaced by real declarations as the scripts
  // load - showToast by utils.js (and the real one wants a live
  // document.body) and recordPayment by payments.js (the real one posts to
  // the server). Put the recorders back now that everything is evaluated,
  // or the save tests below would be measuring the real functions.
  sb.showToast = (m, t = 'success') => log.toasts.push([t, m]);
  sb.recordPayment = async (...a) => { log.payments.push(JSON.parse(JSON.stringify(a))); return { ok: true }; };

  return {
    sb, els, log,
    get: (id) => (id in els ? els[id] : el(id)),
    status: () => el('purchPaymentStatus').value,
    // What the preview box actually shows.
    preview: () => ({
      total: el('purchPreviewTotal').value,
      paid: el('purchPreviewReceived').value,
      balance: el('purchPreviewBalance').value,
      status: el('purchPreviewStatus').innerHTML
    }),
    setTotal: (t) => { grandTotal = t; },
    run: (code) => vm.runInContext(code, sb)
  };
}

// ══════════════════════════════════════════════════════════════════════
test('PP1 (A) a new purchase opens on Paid in Full', () => {
  // The markup the browser parses, on the page and in the mirror it serves.
  for (const [where, html] of [['purchases.html', PAGE], ['server/public/purchases.html', MIRROR]]) {
    assert.match(html, /<option value="paid" selected>Paid in Full<\/option>/,
      where + ' must open on Paid in Full');
    assert.match(html, /<option value="unpaid">Unpaid<\/option>/,
      where + ": Unpaid must no longer be the selected option");
  }
  // And the script sets it too, so the page and Reset cannot disagree.
  const p = page({ total: 10000 });
  // A top-level const is lexical, so it is read back through the context
  // rather than off the sandbox object.
  assert.strictEqual(p.run('PURCHASE_NEW_PAYMENT_STATUS'), 'paid');
  assert.match(ENTRY, /setPurchValue\('purchPaymentStatus', PURCHASE_NEW_PAYMENT_STATUS\);/);
});

test('PP2 (B) Paid in Full pays the Grand Total and leaves no balance', () => {
  const p = page({ total: 10000 });
  p.get('purchPaymentStatus').value = 'paid';
  p.run('renderPurchPaymentPreview()');
  const v = p.preview();
  assert.strictEqual(v.total, '₹10,000.00');
  assert.strictEqual(v.paid, '₹10,000.00', 'Amount Paid is the Grand Total');
  assert.strictEqual(v.balance, '₹0.00', 'nothing remaining');
  assert.match(v.status, /badge-green/);
  assert.match(v.status, /Paid/);
});

test('PP3 (B) the Amount Paid follows the Grand Total as the items change', () => {
  // The requirement that the figure never goes stale. Nothing is stored:
  // 'paid' is re-derived from the rollup on every render, so adding a
  // product or editing a quantity, rate, GST or transport charge moves it.
  const p = page({ total: 10000 });
  p.get('purchPaymentStatus').value = 'paid';
  for (const t of [10000, 11800, 23600, 24100.5, 0]) {
    p.setTotal(t);
    p.run('renderPurchPaymentPreview()');
    const v = p.preview();
    assert.strictEqual(v.paid, v.total, 'Amount Paid tracks the Grand Total at ' + t);
    assert.strictEqual(v.balance, '₹0.00', 'and the balance stays nil at ' + t);
  }
  // A typed figure is NOT what 'paid' reads, so a stale number left in the
  // box by an earlier 'partial' cannot leak into a Paid in Full purchase.
  p.setTotal(5000);
  p.get('purchPaymentAmount').value = '123.45';
  p.run('renderPurchPaymentPreview()');
  assert.strictEqual(p.preview().paid, '₹5,000.00');
});

test('PP4 (C) Unpaid pays nothing and leaves the whole total outstanding', () => {
  const p = page({ total: 10000 });
  p.get('purchPaymentStatus').value = 'unpaid';
  p.run('onPurchPaymentStatusChange()');
  const v = p.preview();
  assert.strictEqual(v.paid, '₹0.00');
  assert.strictEqual(v.balance, '₹10,000.00');
  assert.match(v.status, /Unpaid/);
  // The amount box is put away again, and emptied.
  assert.strictEqual(p.get('purchPaymentAmount').disabled, true);
  assert.strictEqual(p.get('purchPaymentAmount').value, '');
  assert.strictEqual(p.get('purchPaymentAmountGroup').classList.contains('collapsed'), true);
});

test('PP5 (D) Partially Paid takes a typed amount and works out the balance', () => {
  const p = page({ total: 10000 });
  p.get('purchPaymentStatus').value = 'partial';
  p.run('onPurchPaymentStatusChange()');
  // The fields open up for entry.
  assert.strictEqual(p.get('purchPaymentAmount').disabled, false);
  assert.strictEqual(p.get('purchPaymentAmountGroup').classList.contains('collapsed'), false);
  assert.match(p.get('purchPaymentDate').value, /^\d{4}-\d{2}-\d{2}$/, 'dated today unless changed');

  p.get('purchPaymentAmount').value = '4000';
  p.run('renderPurchPaymentPreview()');
  let v = p.preview();
  assert.strictEqual(v.paid, '₹4,000.00');
  assert.strictEqual(v.balance, '₹6,000.00');
  assert.match(v.status, /Partially Paid/);

  // The balance follows a changed total here too.
  p.setTotal(12000);
  p.run('renderPurchPaymentPreview()');
  assert.strictEqual(p.preview().balance, '₹8,000.00');

  // More than the total is refused by Save, with the figure left in place
  // to be corrected rather than silently rewritten.
  p.get('purchPaymentAmount').value = '20000';
  p.run('renderPurchPaymentPreview()');
  assert.strictEqual(p.run('validatePurchPaymentAmount()'), false, 'Save refuses an over-payment');
  assert.strictEqual(p.get('purchPaymentAmount').value, '20000', 'and keeps what was typed');
});

test('PP6 (E) editing an existing purchase shows what it recorded, and changes nothing', async () => {
  const p = page({ total: 0 });
  p.sb.__record = {
    id: 'p-1', vendor_name: 'Sri Lakshmi Traders', purchase_number: 'PUR-014',
    purchase_date: '2026-10-02', supply_type: 'intrastate',
    payment_status: 'partial', amount_paid: 4000, total_amount: 10000
  };
  p.sb.__items = [{ id: 'i1', product_name: 'Mixer', quantity: 1, sort_order: 1 }];
  await p.run("loadPurchaseForEdit('p-1')");

  // The saved status, named in full - not the new-purchase default.
  assert.strictEqual(p.get('purchPaymentEditStatusText').textContent, 'Partially Paid');
  // ...with its own figures beside it.
  assert.strictEqual(p.get('purchPaymentEditAmounts').textContent,
    ' Amount Paid ₹4,000.00, Remaining Balance ₹6,000.00.');
  // The editable fields are not on screen at all, so the default cannot be
  // applied to a historical purchase by any route.
  assert.strictEqual(p.get('purchPaymentEditableFields').classList.contains('d-none'), true);
  assert.strictEqual(p.get('purchPaymentPreview').classList.contains('d-none'), true);
  assert.strictEqual(p.get('purchPaymentEditNote').classList.contains('d-none'), false);
  assert.strictEqual(p.get('purchPageTitle').textContent, 'Edit Purchase');

  // And Save still leaves payment_status/amount_paid out of an update: the
  // ledger owns them, so editing a purchase cannot rewrite its history.
  const save = ENTRY.slice(ENTRY.indexOf('const headerBase = {'));
  assert.match(save, /if \(wasNew\) \{ headerBase\.payment_status = 'unpaid'; headerBase\.amount_paid = 0; \}/);
  assert.strictEqual(/headerBase\.payment_status = PURCHASE_NEW_PAYMENT_STATUS/.test(ENTRY), false,
    'the opening status is a screen default, never written straight onto the row');
});

test('PP7 (E) a purchase saved as fully paid reads back as fully paid', async () => {
  const p = page({ total: 0 });
  p.sb.__record = { id: 'p-2', payment_status: 'paid', amount_paid: 7500, total_amount: 7500 };
  p.sb.__items = [];
  await p.run("loadPurchaseForEdit('p-2')");
  assert.strictEqual(p.get('purchPaymentEditStatusText').textContent, 'Paid in Full');
  assert.strictEqual(p.get('purchPaymentEditAmounts').textContent,
    ' Amount Paid ₹7,500.00, Remaining Balance ₹0.00.');
});

test('PP8 (F) Reset returns a new purchase to Paid in Full', () => {
  const p = page({ total: 10000 });
  // Somebody changes it, types an amount, then resets.
  p.get('purchPaymentStatus').value = 'partial';
  p.run('onPurchPaymentStatusChange()');
  p.get('purchPaymentAmount').value = '2500';
  p.run('clearPurchaseFormFields()');

  assert.strictEqual(p.status(), 'paid', 'back to the new-purchase default');
  assert.strictEqual(p.get('purchPaymentAmount').value, '', 'the typed amount is gone');
  assert.strictEqual(p.get('purchPaymentReference').value, '');
  assert.strictEqual(p.get('purchPaymentNote').value, '');
  assert.strictEqual(p.get('purchPaymentMode').value, 'cash');
  assert.strictEqual(p.get('purchPageTitle').textContent, 'New Purchase');
  // The fields are editable again, which is what a new purchase needs.
  assert.strictEqual(p.get('purchPaymentEditableFields').classList.contains('d-none'), false);
});

test('PP9 what Save records for each status is unchanged', () => {
  // The three branches of savePurchase()'s initial payment, pinned as they
  // are: 'paid' records the whole total, 'partial' the typed figure, and
  // 'unpaid' records nothing at all. The new default changes which of them
  // a fresh form starts on, not what any of them does.
  const save = ENTRY.slice(ENTRY.indexOf('if (wasNew) {', ENTRY.indexOf('savePurchaseWithItems')));
  assert.match(save, /if \(payStatus !== 'unpaid'\)/, 'unpaid still records no payment');
  assert.match(save, /payStatus === 'paid' \? rollups\.total_amount : \(parseFloat\(getPurchText\('purchPaymentAmount'\)\) \|\| 0\)/,
    'paid is the rollup total; partial is what was typed');
  assert.match(save, /if \(amount > 0\)/, 'a zero amount still records nothing');
  // The money goes through the real ledger, not onto the row.
  assert.match(save, /await recordPayment\('purchase', id, user\.id, \{ amount, method, date: payDate, referenceNumber, note \}\)/);
});

test('PP10 the changed asset carries a new cache key', () => {
  assert.ok(PAGE.includes('client/js/pages/purchase-entry.js?v=33'),
    'purchases.html must reference purchase-entry.js at v=33');
  assert.ok(MIRROR.includes('client/js/pages/purchase-entry.js?v=33'),
    'and so must the mirror it serves');
  // payments.js is untouched by this change, so its key does not move.
  assert.ok(PAGE.includes('client/js/pages/payments.js?v=29'));
});

// ══════════════════════════════════════════════════════════════════════
//  What reaches the vendor ledger
// ══════════════════════════════════════════════════════════════════════
//
// The default decides what a fresh form offers; these decide what Save
// actually records. recordPayment() is the real ledger call (it posts to
// server/routes/payments.js, which recomputes payment_status/amount_paid
// from the payments table), so "exactly once, right amount, right date" is
// a statement about the log of calls to it.

// A new purchase, filled in and ready to save.
function readyToSave(p, { status, typed = '', payDate = '' } = {}) {
  p.get('purchVendorName').value = 'Sri Lakshmi Traders';
  p.get('purchNum').value = 'PUR-050';
  p.get('purchDate').value = '2026-11-10';
  p.get('purchState').value = 'Tamil Nadu';
  p.get('purchSupply').value = 'intrastate';
  p.get('purchPaymentStatus').value = status;
  p.get('purchPaymentAmount').value = typed;
  p.get('purchPaymentDate').value = payDate;
  return p;
}

test('PP11 Paid in Full records the full payment exactly once, dated the purchase', async () => {
  const p = page({ total: 23600 });
  readyToSave(p, { status: 'paid' });
  await p.run('savePurchase()');

  assert.strictEqual(p.log.payments.length, 1, 'exactly one ledger entry — not none, not two');
  const [kind, id, userId, body] = p.log.payments[0];
  assert.strictEqual(kind, 'purchase');
  assert.strictEqual(id, 'p-new', 'against the purchase that was just written');
  assert.strictEqual(userId, 'u1');
  assert.strictEqual(body.amount, 23600, 'the whole Grand Total');
  assert.strictEqual(body.date, '2026-11-10', 'the PURCHASE date, not today');
  assert.strictEqual(body.method, 'cash');
  assert.strictEqual(body.note, 'Recorded at purchase creation');
  // One row write, one payment. The row itself is still written unpaid/0:
  // the ledger is what decides the status, and it is read back from there.
  assert.strictEqual(p.log.saves.length, 1);
  assert.strictEqual(p.log.saves[0][1].payment_status, 'unpaid');
  assert.strictEqual(p.log.saves[0][1].amount_paid, 0);
  assert.deepStrictEqual(p.log.toasts, [['success', 'Purchase saved successfully!']]);
});

test('PP12 Unpaid records no payment at all', async () => {
  const p = page({ total: 23600 });
  readyToSave(p, { status: 'unpaid' });
  await p.run('savePurchase()');
  assert.strictEqual(p.log.payments.length, 0, 'nothing reaches the vendor ledger');
  assert.strictEqual(p.log.saves.length, 1, 'the purchase itself is still saved');
});

test('PP13 Partially Paid records only the amount entered, on its own date', async () => {
  const p = page({ total: 23600 });
  readyToSave(p, { status: 'partial', typed: '10000', payDate: '2026-11-12' });
  await p.run('savePurchase()');
  assert.strictEqual(p.log.payments.length, 1);
  const body = p.log.payments[0][3];
  assert.strictEqual(body.amount, 10000, 'the entered amount, never the total');
  assert.strictEqual(body.date, '2026-11-12', 'its own payment date');
});

test('PP14 updating an existing purchase records no payment, so none can double up', async () => {
  const p = page({ total: 23600 });
  p.sb.__record = { id: 'p-9', payment_status: 'paid', amount_paid: 23600, total_amount: 23600 };
  p.sb.__items = [];
  await p.run("loadPurchaseForEdit('p-9')");
  // Re-saving the purchase that is open for edit.
  p.get('purchNum').value = 'PUR-009';
  p.get('purchDate').value = '2026-11-10';
  p.get('purchVendorName').value = 'Sri Lakshmi Traders';
  await p.run('savePurchase()');

  assert.strictEqual(p.log.payments.length, 0,
    'an update never records a payment — that is why editing cannot duplicate one');
  assert.strictEqual(p.log.saves.length, 1, 'the update itself went through');
  const header = p.log.saves[0][1];
  assert.strictEqual('payment_status' in header, false, 'and leaves the saved status alone');
  assert.strictEqual('amount_paid' in header, false, 'and the saved amount alone');
  assert.deepStrictEqual(p.log.toasts, [['success', 'Purchase updated successfully!']]);
});
