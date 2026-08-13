// =============================================
// Purchase Entry (purchases.html) — mirrors js/invoice-entry.js's
// structure (vendor autocomplete, GST Verification, supply-type
// auto-detect, save orchestration) with the differences called out in
// the approved plan: no B2B/B2C split (a purchase always has exactly
// one vendor), Purchase Number is manual-only (no dual Auto Generate
// system), no Transport section (that's an outbound-dispatch concept),
// and no PDF/Print/WhatsApp/Email share panel (not requested — that
// stays a Sales-invoice-only feature).
// =============================================

let purchEditId = null;
let purchVendorsList = [];

async function initPurchaseEntry() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populatePurchStateOptions();
  await loadPurchVendorsList(user.id);
  await initPurchaseItems(user.id, 'purchase');
  setPurchValue('purchDate', toISO(new Date()));

  const params = new URLSearchParams(window.location.search);
  const editId = params.get('id');

  if (editId) {
    await loadPurchaseForEdit(editId);
  } else {
    const pf = sessionStorage.getItem('prefill_vendor');
    if (pf) {
      try {
        const v = JSON.parse(pf);
        if (v.id) purchSelectedVendorId = v.id;
        if (v.name) setPurchValue('purchVendorName', v.name);
        if (v.gstin) setPurchValue('purchGstin', v.gstin);
        if (v.phone) setPurchValue('purchPhone', v.phone);
        if (v.address) setPurchValue('purchAddress', v.address);
        if (v.state) setPurchValue('purchState', v.state);
      } catch {}
      sessionStorage.removeItem('prefill_vendor');
    }
    document.getElementById('purchVendorName')?.focus();
  }

  detectPurchSupplyType();
  updatePurchGstinValidationStatus();
}

function getPurchText(id) { return document.getElementById(id)?.value?.trim() || ''; }
function setPurchValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }

function updatePurchGstinValidationStatus() {
  renderGstinStatusInto('purchGstinStatus', getPurchText('purchGstin'));
}

function onPurchGstinInput(el) {
  el.value = el.value.toUpperCase();
  detectPurchSupplyType();
  updatePurchGstinValidationStatus();
}

// Same math as Invoice Entry's detectSupplyType() — Intrastate/
// Interstate only ever depends on comparing two state codes/names, it
// doesn't matter which side is "the business" vs "the other party".
function detectPurchSupplyType() {
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const businessGstin = (profile?.gstin || '').toUpperCase();
  const businessState = profile?.state || '';
  const vendorGstin = getPurchText('purchGstin').toUpperCase();
  const vendorState = document.getElementById('purchState')?.value || '';

  // State (the actual "place of supply" field) takes priority whenever
  // it's filled in — see Invoice Entry's detectSupplyType() for why: a
  // vendor GSTIN left over from before the State dropdown was changed
  // can't be allowed to silently outrank the state just explicitly
  // picked. Same fix applied here and to Purchase Return's
  // detectRetSupplyType() during the release audit.
  let supply = 'intrastate';
  if (businessState && vendorState) {
    supply = businessState === vendorState ? 'intrastate' : 'interstate';
  } else if (businessGstin.length >= 2 && vendorGstin.length >= 2) {
    supply = businessGstin.slice(0, 2) === vendorGstin.slice(0, 2) ? 'intrastate' : 'interstate';
  }

  const hidden = document.getElementById('purchSupply');
  if (hidden) {
    const changed = hidden.value !== supply;
    hidden.value = supply;
    if (changed) hidden.dispatchEvent(new Event('change'));
  }
  const badge = document.getElementById('purchSupplyBadge');
  if (badge) {
    badge.textContent = supply === 'interstate' ? 'Interstate' : 'Intrastate';
    badge.className = 'badge ' + (supply === 'interstate' ? 'badge-blue' : 'badge-green');
  }
}

function populatePurchStateOptions() {
  const sel = document.getElementById('purchState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

// ── Vendor Master helpers ────────────────────────────
let purchSelectedVendorId = null;

async function loadPurchVendorsList(userId) {
  const { data, error } = await _supabase.from('vendors').select('*').eq('user_id', userId);
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load Vendor Master'); return; }
  purchVendorsList = (data || []);
  const dl = document.getElementById('purchVendorDatalist');
  if (dl) {
    dl.innerHTML = purchVendorsList.map(v =>
      `<option value="${escItemHtml(v.name)}">${v.gstin ? '(' + v.gstin + ')' : ''}</option>`
    ).join('');
  }
}

// Which vendor fields this page auto-filled, and the exact value written to
// each. Kept so that switching to a vendor who isn't in Vendor Master can
// undo precisely those fields — and nothing the user typed themselves.
let purchAutoFilled = {};

// Fills a field only when it's empty (the long-standing rule: never clobber
// something already entered) and records what was written.
function autoFillVendorField(id, value) {
  const el = document.getElementById(id);
  if (!el || el.value || !value) return;
  el.value = value;
  purchAutoFilled[id] = value;
}

// Undoes the auto-fill when the vendor name stops matching Vendor Master.
// A field is only cleared if it still holds exactly what was auto-filled —
// if the user edited it afterwards, that edit is theirs and is left alone.
// Fields they filled in before picking a vendor were never auto-filled, so
// they aren't in the record and are never touched.
function clearAutoFilledVendorFields() {
  Object.entries(purchAutoFilled).forEach(([id, filled]) => {
    const el = document.getElementById(id);
    if (el && el.value === filled) el.value = '';
  });
  purchAutoFilled = {};
}

function onPurchVendorInput() {
  const name = getPurchText('purchVendorName');
  const vendor = purchVendorsList.find(v => v.name.toLowerCase() === name.toLowerCase());
  purchSelectedVendorId = vendor ? vendor.id : null;
  // Known -> unknown: drop the previous vendor's details so a new vendor is
  // never saved carrying them, and so a stale GSTIN can't fail validation on
  // a name it has nothing to do with. A no-op when nothing was auto-filled.
  if (!vendor) clearAutoFilledVendorFields();
  updatePurchVendorPrompt();
  if (!vendor) { detectPurchSupplyType(); updatePurchGstinValidationStatus(); return; }
  autoFillVendorField('purchGstin',   vendor.gstin ? vendor.gstin.toUpperCase() : '');
  autoFillVendorField('purchPhone',   vendor.phone);
  autoFillVendorField('purchAddress', vendor.address);
  autoFillVendorField('purchState',   vendor.state);
  detectPurchSupplyType();
  updatePurchGstinValidationStatus();
}

function onPurchGstinBlur() {
  const value = getPurchText('purchGstin').toUpperCase();
  if (!value || !isValidGstinFormat(value)) return;
  const match = purchVendorsList.find(v => (v.gstin || '').toUpperCase() === value);
  if (!match) return;
  purchSelectedVendorId = match.id;
  if (!getPurchText('purchVendorName')) setPurchValue('purchVendorName', match.name);
  // Recorded the same way as the name-driven auto-fill, so these are undone
  // too if the vendor name is later changed to one not in Vendor Master.
  autoFillVendorField('purchPhone',   match.phone);
  autoFillVendorField('purchAddress', match.address);
  autoFillVendorField('purchState',   match.state);
  detectPurchSupplyType();
  updatePurchVendorPrompt();   // name just resolved to a known vendor — nothing to offer
}

// ── "New vendor?" inline prompt ──────────────────────
// Offers to add an unrecognised vendor to Vendor Master, inline under the
// Vendor Details fields — never a popup, so it can't interrupt data entry.
// Purely additive: whichever button is pressed (or neither), the purchase
// saves exactly as it did before.

// Remembers the name the user last chose to Skip, so the panel stays hidden
// for that vendor but comes back if they type a different new one.
let purchVendorPromptSkippedFor = null;

function updatePurchVendorPrompt() {
  const panel = document.getElementById('purchNewVendorPanel');
  if (!panel) return;
  const name = getPurchText('purchVendorName');
  const known = !!purchVendorsList.find(v => v.name.toLowerCase() === name.toLowerCase());
  const skipped = purchVendorPromptSkippedFor === name.toLowerCase();
  // Nothing typed, already in Vendor Master, or dismissed for this name.
  panel.classList.toggle('d-none', !name || known || skipped);
}

function skipNewVendorPrompt() {
  purchVendorPromptSkippedFor = getPurchText('purchVendorName').toLowerCase();
  updatePurchVendorPrompt();
}

// Reuses saveVendorFromPurchaseForm() rather than repeating the insert and
// its GSTIN check. On success the vendor list is already refreshed, so
// re-running the lookup both hides the panel and links this purchase to the
// newly created vendor exactly as picking an existing one would.
async function saveNewVendorFromPrompt() {
  const btn = document.getElementById('purchSaveVendorBtn');
  if (btn) btn.disabled = true;                    // no double-insert on a double click
  try {
    if (await saveVendorFromPurchaseForm()) onPurchVendorInput();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Returns true only when a vendor row was actually created. The existing
// header button ignores the value, so its behaviour is unchanged.
async function saveVendorFromPurchaseForm() {
  const user = await getCurrentUser();
  if (!user) return false;
  const name = getPurchText('purchVendorName');
  if (!name) { showToast('Enter vendor name first.', 'error'); return false; }
  const exists = purchVendorsList.find(v => v.name.toLowerCase() === name.toLowerCase());
  if (exists) { showToast('Vendor already saved!', 'warning'); return false; }
  const gstin = getPurchText('purchGstin');
  if (gstin && !validateGstin(gstin).valid) { showToast('GSTIN is invalid — correct it (or clear it) before saving to Vendor Master.', 'error'); return false; }
  const { error } = await _supabase.from('vendors').insert({
    user_id: user.id, name, gstin, phone: getPurchText('purchPhone'),
    address: getPurchText('purchAddress'), state: document.getElementById('purchState')?.value || ''
  });
  if (error) { handleApiError(error, 'Could not save the vendor'); return false; }
  showToast('Vendor saved to master!', 'success');
  await loadPurchVendorsList(user.id);
  return true;
}

// ── Payment (to vendor) section — new-purchase only, mirrors Invoice
// Entry's Payment section exactly; editing an existing purchase's
// payments happens on Purchase List (see loadPurchaseForEdit() below) ──
function onPurchPaymentStatusChange() {
  const status = document.getElementById('purchPaymentStatus')?.value;
  const show = status === 'partial';
  document.getElementById('purchPaymentAmountGroup')?.classList.toggle('collapsed', !show);
  document.getElementById('purchPaymentDetailGroup')?.classList.toggle('collapsed', !show);
  ['purchPaymentAmount','purchPaymentDate','purchPaymentMode','purchPaymentReference','purchPaymentNote'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = !show;
  });
  if (!show) {
    ['purchPaymentAmount','purchPaymentReference','purchPaymentNote'].forEach(id => setPurchValue(id, ''));
    setPurchValue('purchPaymentDate', '');
    setPurchValue('purchPaymentMode', 'cash');
  } else {
    if (!getPurchText('purchPaymentDate')) setPurchValue('purchPaymentDate', toISO(new Date()));
  }
  renderPurchPaymentPreview();
}

// ── Live payment preview (display only) ─────────────
// Element map + thin wrappers over the shared helpers in js/payments.js —
// the same ones Invoice Entry uses, so both pages behave identically by
// construction rather than by two copies being kept in step by hand.
const PURCHASE_PAYMENT_PREVIEW = {
  box: 'purchPaymentPreview',
  total: 'purchPreviewTotal',
  received: 'purchPreviewReceived',
  balance: 'purchPreviewBalance',
  status: 'purchPreviewStatus',
  error: 'purchPaymentAmountError',
  statusField: 'purchPaymentStatus',
  amountField: 'purchPaymentAmount',
  amountLabel: 'Amount Paid',
  getTotal: () => +computePurchRollups().total_amount || 0
};

function renderPurchPaymentPreview(grandTotal) {
  renderPaymentPreview(PURCHASE_PAYMENT_PREVIEW, grandTotal);
}

function validatePurchPaymentAmount() {
  return validatePaymentPreviewAmount(PURCHASE_PAYMENT_PREVIEW);
}

function setPurchPaymentSectionMode(editable, statusLabel) {
  document.getElementById('purchPaymentEditableFields')?.classList.toggle('d-none', !editable);
  document.getElementById('purchPaymentDetailGroup')?.classList.toggle('d-none', !editable);
  // Same reasoning as Invoice Entry's: the preview is a before-Save aid, and
  // editing an existing purchase manages payments from Purchase List (which
  // has the real ledger), so it hides alongside the editable fields.
  document.getElementById('purchPaymentPreview')?.classList.toggle('d-none', !editable);
  document.getElementById('purchPaymentEditNote')?.classList.toggle('d-none', editable);
  if (editable) renderPurchPaymentPreview();
  if (!editable) {
    const label = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid in Full' }[statusLabel] || 'Unpaid';
    const el = document.getElementById('purchPaymentEditStatusText');
    if (el) el.textContent = label;
  }
}

// ── Edit mode ────────────────────────────────────────
async function loadPurchaseForEdit(id) {
  // Header and line items are both read before the form is touched, and a
  // failed read stops the edit rather than opening a form that looks like
  // the record has fewer lines than it has — saving that back would
  // overwrite the real ones. Same reasoning as loadInvoiceForEdit() in
  // js/invoice-entry.js.
  const rec = await readMaybeOne(
    _supabase.from('purchases').select('*').eq('id', id).single(),
    'Could not open the purchase'
  );
  if (rec === undefined) return;
  if (!rec) { showToast('That purchase no longer exists.', 'warning'); return; }

  const itemRead = await readAll([
    _supabase.from('purchase_items').select('*').eq('purchase_id', id)
  ], 'Could not open the purchase');
  if (!itemRead) return;
  const items = itemRead[0];

  purchEditId = id;
  purchSelectedVendorId = rec.vendor_id || null;

  setPurchValue('purchVendorName', rec.vendor_name || '');
  setPurchValue('purchGstin', rec.vendor_gstin || '');
  setPurchValue('purchPhone', rec.phone || '');
  setPurchValue('purchAddress', rec.address || '');
  setPurchValue('purchState', rec.state || '');
  setPurchValue('purchNum', rec.purchase_number || '');
  setPurchValue('purchDate', rec.purchase_date || '');
  setPurchValue('purchSupply', rec.supply_type || 'intrastate');
  setPurchPaymentSectionMode(false, rec.payment_status);

  // Read at the top of this function — see the note there.
  const activeItems = items.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) loadPurchItemsIntoTable(activeItems);

  document.getElementById('purchPageTitle').textContent = 'Edit Purchase';
  document.getElementById('purchSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Purchase';
  detectPurchSupplyType();
  updatePurchGstinValidationStatus();
}

// ── Save ─────────────────────────────────────────────
async function savePurchase() {
  const user = await getCurrentUser();
  if (!user) return;

  const vendorName = getPurchText('purchVendorName');
  const gstin      = getPurchText('purchGstin').toUpperCase();
  const phone      = getPurchText('purchPhone');
  const address    = getPurchText('purchAddress');
  const state      = document.getElementById('purchState')?.value || '';
  const purchNum   = getPurchText('purchNum');
  const purchDate  = getPurchText('purchDate');
  const supply     = document.getElementById('purchSupply')?.value || 'intrastate';
  const wasNew     = !purchEditId;

  if (!vendorName) { showToast('Please enter the vendor name.', 'error'); return; }
  if (!purchNum)   { showToast('Please enter a purchase number.', 'error'); return; }
  if (!purchDate)  { showToast('Please enter the purchase date.', 'error'); return; }
  if (gstin && !validateGstin(gstin).valid) {
    showToast('Vendor GSTIN is invalid — correct it (or clear it) before saving.', 'error');
    return;
  }
  // Amount Paid can't exceed the Grand Total. The inline error under the
  // field is the live version of this same check. Only a brand-new
  // purchase's form records a payment (see the wasNew block below), so
  // that's the only case to gate — same as Invoice Entry.
  if (wasNew && !validatePurchPaymentAmount()) return;

  if (!purchEditId) {
    // readMaybeOne(), not a bare destructure of `.data`. A `.single()`
    // that finds nothing and a `.single()` whose REQUEST failed both
    // arrive with no data, and reading them the same way meant a failed
    // duplicate check was taken as "no duplicate" and the save went
    // ahead — putting two documents on one number into a filing, which
    // the Portal rejects and which has to be unpicked by hand. undefined
    // means the check itself failed, so nothing is saved.
    const dup = await readMaybeOne(
      _supabase.from('purchases').select('id').eq('user_id', user.id).eq('purchase_number', purchNum).single(),
      'Could not check whether that purchase number is already used'
    );
    if (dup === undefined) return;
    if (dup?.id) { showToast('Purchase number already exists!', 'warning'); return; }
  }

  const headerBase = {
    user_id: user.id,
    vendor_id: purchSelectedVendorId,
    vendor_name: vendorName, vendor_gstin: gstin || null, phone, address, state,
    purchase_number: purchNum, purchase_date: purchDate, supply_type: supply
  };
  // payment_status/amount_paid are ledger-derived (server/routes/payments.js
  // recomputes them from the `payments` table) — never written here directly.
  // On a brand-new purchase they start at unpaid/0; any initial payment goes
  // through recordPayment() below, same as Invoice Entry. On edit, they're
  // simply left out of headerBase so save-with-items doesn't touch them —
  // editing an existing purchase's payments happens on Purchase List instead.
  if (wasNew) { headerBase.payment_status = 'unpaid'; headerBase.amount_paid = 0; }

  const id = await savePurchaseWithItems('purchase', headerBase, purchEditId, user.id);
  if (!id) return;

  // Initial payment, if the user marked one on the creation form — goes
  // through the real payments ledger (same as Invoice Entry) so it shows
  // up in Payment History rather than being a number with no record
  // behind it. Only for a brand-new purchase; editing manages payments
  // from Purchase List instead (see loadPurchaseForEdit()).
  if (wasNew) {
    const payStatus = document.getElementById('purchPaymentStatus')?.value || 'unpaid';
    if (payStatus !== 'unpaid') {
      const rollups = computePurchRollups();
      const amount = payStatus === 'paid' ? rollups.total_amount : (parseFloat(getPurchText('purchPaymentAmount')) || 0);
      if (amount > 0) {
        const method = payStatus === 'paid' ? 'cash' : (document.getElementById('purchPaymentMode')?.value || 'cash');
        const payDate = payStatus === 'paid' ? purchDate : (getPurchText('purchPaymentDate') || purchDate);
        const referenceNumber = payStatus === 'paid' ? '' : getPurchText('purchPaymentReference');
        const note = payStatus === 'paid' ? 'Recorded at purchase creation' : (getPurchText('purchPaymentNote') || 'Recorded at purchase creation');
        const payResult = await recordPayment('purchase', id, user.id, { amount, method, date: payDate, referenceNumber, note });
        if (!payResult.ok) handleApiError(payResult.error, 'Purchase saved, but the payment could not be recorded');
      }
    }
  }

  showToast(wasNew ? 'Purchase saved successfully!' : 'Purchase updated successfully!');

  if (wasNew) {
    clearPurchaseFormFields();
    document.getElementById('purchVendorName')?.focus();
  } else {
    purchEditId = id;
    document.getElementById('purchSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Purchase';
    document.getElementById('purchPageTitle').textContent = 'Edit Purchase';
  }
}

function clearPurchaseFormFields() {
  ['purchGstin','purchPhone','purchAddress','purchNum'].forEach(id => setPurchValue(id, ''));
  setPurchValue('purchVendorName', '');
  setPurchValue('purchState', '');
  setPurchValue('purchDate', toISO(new Date()));
  setPurchValue('purchSupply', 'intrastate');
  setPurchValue('purchPaymentStatus', 'unpaid');
  ['purchPaymentAmount','purchPaymentDate','purchPaymentReference','purchPaymentNote'].forEach(id => setPurchValue(id, ''));
  setPurchValue('purchPaymentMode', 'cash');
  onPurchPaymentStatusChange();
  setPurchPaymentSectionMode(true);
  purchSelectedVendorId = null;
  purchEditId = null;
  purchVendorPromptSkippedFor = null;   // a blank form should offer again
  purchAutoFilled = {};
  updatePurchVendorPrompt();
  updatePurchGstinValidationStatus();
  resetPurchaseItems();
  document.getElementById('purchPageTitle').textContent = 'New Purchase';
  document.getElementById('purchSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Purchase';
  detectPurchSupplyType();
}

function resetPurchaseForm() {
  clearPurchaseFormFields();
  document.getElementById('purchVendorName')?.focus();
}
