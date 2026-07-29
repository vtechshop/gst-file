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
  const { data } = await _supabase.from('vendors').select('*').eq('user_id', userId);
  purchVendorsList = (data || []);
  const dl = document.getElementById('purchVendorDatalist');
  if (dl) {
    dl.innerHTML = purchVendorsList.map(v =>
      `<option value="${escItemHtml(v.name)}">${v.gstin ? '(' + v.gstin + ')' : ''}</option>`
    ).join('');
  }
}

function onPurchVendorInput() {
  const name = getPurchText('purchVendorName');
  const vendor = purchVendorsList.find(v => v.name.toLowerCase() === name.toLowerCase());
  purchSelectedVendorId = vendor ? vendor.id : null;
  if (!vendor) return;
  const gstEl = document.getElementById('purchGstin');   if (gstEl && !gstEl.value && vendor.gstin)   gstEl.value = vendor.gstin.toUpperCase();
  const phEl  = document.getElementById('purchPhone');   if (phEl  && !phEl.value  && vendor.phone)   phEl.value  = vendor.phone;
  const adEl  = document.getElementById('purchAddress'); if (adEl  && !adEl.value  && vendor.address) adEl.value  = vendor.address;
  const stEl  = document.getElementById('purchState');   if (stEl  && !stEl.value  && vendor.state)   stEl.value  = vendor.state;
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
  const phEl = document.getElementById('purchPhone');   if (phEl && !phEl.value && match.phone)   phEl.value = match.phone;
  const adEl = document.getElementById('purchAddress'); if (adEl && !adEl.value && match.address) adEl.value = match.address;
  const stEl = document.getElementById('purchState');   if (stEl && !stEl.value && match.state)   stEl.value = match.state;
  detectPurchSupplyType();
}

async function saveVendorFromPurchaseForm() {
  const user = await getCurrentUser();
  if (!user) return;
  const name = getPurchText('purchVendorName');
  if (!name) { showToast('Enter vendor name first.', 'error'); return; }
  const exists = purchVendorsList.find(v => v.name.toLowerCase() === name.toLowerCase());
  if (exists) { showToast('Vendor already saved!', 'warning'); return; }
  const gstin = getPurchText('purchGstin');
  if (gstin && !validateGstin(gstin).valid) { showToast('GSTIN is invalid — correct it (or clear it) before saving to Vendor Master.', 'error'); return; }
  const { error } = await _supabase.from('vendors').insert({
    user_id: user.id, name, gstin, phone: getPurchText('purchPhone'),
    address: getPurchText('purchAddress'), state: document.getElementById('purchState')?.value || ''
  });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Vendor saved to master!', 'success');
  await loadPurchVendorsList(user.id);
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
}

function setPurchPaymentSectionMode(editable, statusLabel) {
  document.getElementById('purchPaymentEditableFields')?.classList.toggle('d-none', !editable);
  document.getElementById('purchPaymentDetailGroup')?.classList.toggle('d-none', !editable);
  document.getElementById('purchPaymentEditNote')?.classList.toggle('d-none', editable);
  if (!editable) {
    const label = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid in Full' }[statusLabel] || 'Unpaid';
    const el = document.getElementById('purchPaymentEditStatusText');
    if (el) el.textContent = label;
  }
}

// ── Edit mode ────────────────────────────────────────
async function loadPurchaseForEdit(id) {
  const { data: rec } = await _supabase.from('purchases').select('*').eq('id', id).single();
  if (!rec) { showToast('Purchase not found.', 'error'); return; }

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

  const { data: items } = await _supabase.from('purchase_items').select('*').eq('purchase_id', id);
  const activeItems = (items || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
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

  if (!purchEditId) {
    const { data: dup } = await _supabase.from('purchases').select('id').eq('user_id', user.id).eq('purchase_number', purchNum).single();
    if (dup?.id) { showToast('Purchase number already exists!', 'error'); return; }
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
        if (!payResult.ok) showToast('Purchase saved, but the payment could not be recorded: ' + (payResult.reason || 'unknown error'), 'error');
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
