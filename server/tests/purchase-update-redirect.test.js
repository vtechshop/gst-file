// Purchase List -> Edit -> Update Purchase -> back to Purchase List.
//
// savePurchase() (purchase-entry.js) is run for real in a sandbox; only its
// collaborators are stubbed: the save call, the toast, timers and location.
// Pinned: a successful UPDATE returns to Purchase List (after the toast has
// had a moment, via replace()); a failed or refused update stays on the edit
// page; a NEW purchase keeps clearing the form in place; and the save call -
// arguments and header - is exactly what it was.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ENTRY = rd('client', 'js', 'pages', 'purchase-entry.js');

function page({ editId = null, saveResult = 'p-saved', fields = {} } = {}) {
  const els = {};
  const el = id => els[id] || (els[id] = { id, value: '', innerHTML: '', textContent: '', disabled: false, focus() { this.focused = true; } });
  const values = { purchVendorName: 'Sri Lakshmi Traders', purchGstin: '', purchPhone: '9876543210', purchAddress: 'Gandhipuram, Coimbatore',
    purchState: 'Tamil Nadu', purchNum: 'PUR-001', purchDate: '2026-09-12', purchSupply: 'intrastate', purchGstCategory: 'regular',
    purchPaymentStatus: 'unpaid', ...fields };
  for (const [id, v] of Object.entries(values)) el(id).value = v;
  el('purchSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Purchase';
  el('purchPageTitle').textContent = 'New Purchase';

  const log = { toasts: [], saves: [], timers: [], replaced: [], hrefSet: [], cleared: 0, errors: [] };
  const location = { search: editId ? '?id=' + editId : '', replace: url => log.replaced.push(url) };
  Object.defineProperty(location, 'href', { get: () => '', set: v => log.hrefSet.push(v) });
  const chain = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => chain) });
  const sb = {
    console, JSON, Math, Date, Object, Array, String, Number, Promise, Error, URLSearchParams,
    document: { getElementById: el, querySelector: () => null, addEventListener() {} },
    location,
    setTimeout: (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; },
    getCurrentUser: async () => ({ id: 'u1' }),
    validateGstin: () => ({ valid: true }),
    validatePaymentPreviewAmount: () => true,
    renderPaymentPreview: () => {},
    readMaybeOne: async () => null,
    _supabase: { from: () => chain },
    GST_CUSTOMER_CATEGORY_DEFAULT: 'regular',
    savePurchaseWithItems: async (...args) => { log.saves.push(JSON.parse(JSON.stringify(args))); return saveResult; },
    recordPayment: async () => ({ ok: true }),
    computePurchRollups: () => ({ total_amount: 0 }),
    showToast: (msg, type = 'success') => log.toasts.push([type, msg]),
    handleApiError: (e, msg) => log.errors.push(msg)
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(ENTRY, sb, { filename: 'purchase-entry.js' });
  sb.clearPurchaseFormFields = () => { log.cleared++; };
  if (editId) vm.runInContext(`purchEditId = ${JSON.stringify(editId)};`, sb);
  const runTimers = () => { const t = log.timers.splice(0); t.forEach(x => x.fn()); };
  return { sb, els, log, runTimers, save: () => vm.runInContext('savePurchase()', sb) };
}

test('PR1 a successful update shows its toast, then returns to Purchase List', async () => {
  const p = page({ editId: 'p-edit', saveResult: 'p-edit' });
  await p.save();
  assert.deepStrictEqual(p.log.toasts, [['success', 'Purchase updated successfully!']], 'the existing message, unchanged');
  assert.strictEqual(p.log.replaced.length, 0, 'not before the toast has had a moment');
  assert.strictEqual(p.els.purchSaveBtn.disabled, true, 'the same update cannot be sent twice while leaving');
  assert.deepStrictEqual(p.log.timers.map(t => t.ms), [1000]);
  p.runTimers();
  assert.deepStrictEqual(p.log.replaced, ['purchase-list.html'], 'replace(), to the list Edit was opened from');
  assert.deepStrictEqual(p.log.hrefSet, [], 'no extra history entry');
  assert.strictEqual(p.log.cleared, 0, 'an update does not clear the form');
});

test('PR2 a failed update stays on the edit page', async () => {
  const p = page({ editId: 'p-edit', saveResult: false });   // savePurchaseWithItems reports its own error
  await p.save();
  assert.deepStrictEqual(p.log.toasts, [], 'no success message');
  assert.deepStrictEqual(p.log.timers, []);
  assert.deepStrictEqual(p.log.replaced, []);
  assert.strictEqual(p.els.purchSaveBtn.disabled, false, 'Save stays usable to try again');
  assert.strictEqual(p.els.purchPageTitle.textContent, 'New Purchase', 'the page is left exactly as it was');
});

test('PR3 an update refused before saving stays on the edit page with its error', async () => {
  const p = page({ editId: 'p-edit', fields: { purchVendorName: '' } });
  await p.save();
  assert.deepStrictEqual(p.log.toasts, [['error', 'Please enter the vendor name.']]);
  assert.deepStrictEqual(p.log.saves, [], 'nothing sent');
  assert.deepStrictEqual(p.log.timers, []);
  assert.deepStrictEqual(p.log.replaced, []);
});

test('PR4 a new purchase keeps its behaviour: saved, form cleared, no navigation', async () => {
  const p = page({ editId: null, saveResult: 'p-new' });
  await p.save();
  assert.deepStrictEqual(p.log.toasts, [['success', 'Purchase saved successfully!']]);
  assert.strictEqual(p.log.cleared, 1);
  assert.deepStrictEqual(p.log.timers, []);
  assert.deepStrictEqual(p.log.replaced, []);
  assert.deepStrictEqual(p.log.hrefSet, []);
  assert.strictEqual(p.els.purchSaveBtn.disabled, false);
  // and a failed new save goes nowhere either
  const f = page({ editId: null, saveResult: false });
  await f.save();
  assert.deepStrictEqual([f.log.toasts, f.log.timers, f.log.replaced], [[], [], []]);
});

test('PR5 the save call is exactly what it was, for an update and for a new purchase', async () => {
  const header = { user_id: 'u1', vendor_id: null, vendor_name: 'Sri Lakshmi Traders', vendor_gstin: null, phone: '9876543210',
    address: 'Gandhipuram, Coimbatore', state: 'Tamil Nadu', gst_category: 'regular', purchase_number: 'PUR-001',
    purchase_date: '2026-09-12', supply_type: 'intrastate' };
  const u = page({ editId: 'p-edit', saveResult: 'p-edit' });
  await u.save();
  assert.deepStrictEqual(u.log.saves, [['purchase', header, 'p-edit', 'u1']], 'an update leaves payment fields out, as before');
  const n = page({ editId: null, saveResult: 'p-new' });
  await n.save();
  assert.deepStrictEqual(n.log.saves, [['purchase', { ...header, payment_status: 'unpaid', amount_paid: 0 }, null, 'u1']]);
});

test('PR6 the list returned to is the one Edit is opened from, and the page loads the change', () => {
  assert.match(rd('client', 'js', 'pages', 'purchase-list.js'), /href="purchases\.html\?id=\$\{r\.id\}" title="Edit"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'purchase-list.html')));
  assert.match(ENTRY, /const PURCHASE_LIST_PAGE = 'purchase-list\.html';/);
  assert.ok(rd('purchases.html').includes('client/js/pages/purchase-entry.js?v=31'));
});
