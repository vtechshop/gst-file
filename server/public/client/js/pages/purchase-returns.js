// =============================================
// Purchase Returns — combined entry + history page, same shape as
// js/cdnotes.js (form + paginated history table with totals footer),
// but the entry portion uses the multi-item js/purchase-items.js
// component (kind='return') instead of a flat single-amount form —
// per the confirmed decision that a return can include several
// products from the same purchase in one transaction, mirroring
// Purchase Entry's own multi-line-item structure.
// =============================================

let retEditId = null;
let retAllData = [];
let retPage = 1;
const RET_PAGE = 10;
let retVendorsList = [];
let retSelectedVendorId = null;

async function initPurchaseReturns() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populateRetStateOptions();
  await loadRetVendorsList(user.id);
  await initPurchaseItems(user.id, 'return');
  setRetValue('retDate', toISO(new Date()));
  setupRetSearch();
  await loadPurchaseReturns(user.id);
  detectRetSupplyType();
}

function getRetText(id) { return document.getElementById(id)?.value?.trim() || ''; }
function setRetValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }

function populateRetStateOptions() {
  const sel = document.getElementById('retState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

function updateRetGstinValidationStatus() {
  renderGstinStatusInto('retGstinStatus', getRetText('retGstin'));
}

function onRetGstinInput(el) {
  el.value = el.value.toUpperCase();
  detectRetSupplyType();
  updateRetGstinValidationStatus();
}

function detectRetSupplyType() {
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const businessGstin = (profile?.gstin || '').toUpperCase();
  const businessState = profile?.state || '';
  const vendorGstin = getRetText('retGstin').toUpperCase();
  const vendorState = document.getElementById('retState')?.value || '';

  // State (the actual "place of supply" field) takes priority whenever
  // it's filled in — see the identical fix on Invoice Entry's
  // detectSupplyType() for why: a vendor GSTIN left over from before the
  // user changed the State dropdown can't be allowed to silently
  // outrank the state they just explicitly picked.
  let supply = 'intrastate';
  if (businessState && vendorState) {
    supply = businessState === vendorState ? 'intrastate' : 'interstate';
  } else if (businessGstin.length >= 2 && vendorGstin.length >= 2) {
    supply = businessGstin.slice(0, 2) === vendorGstin.slice(0, 2) ? 'intrastate' : 'interstate';
  }

  // Was reading/writing 'purchSupply' — an id that only exists on
  // purchases.html, not this page — so the computed value here was
  // never actually saved anywhere; savePurchaseReturn() always fell
  // back to hardcoded 'intrastate' regardless of what this function (or
  // the badge) correctly showed. Found via a real save/edit cycle
  // during the release audit, not by inspection.
  const hidden = document.getElementById('retSupply');
  if (hidden) {
    const changed = hidden.value !== supply;
    hidden.value = supply;
    if (changed) hidden.dispatchEvent(new Event('change'));
  }
  const badge = document.getElementById('retSupplyBadge');
  if (badge) {
    badge.textContent = supply === 'interstate' ? 'Interstate' : 'Intrastate';
    badge.className = 'badge ' + (supply === 'interstate' ? 'badge-blue' : 'badge-green');
  }
}

// ── Vendor Master helpers ────────────────────────────
async function loadRetVendorsList(userId) {
  const { data, error } = await _supabase.from('vendors').select('*').eq('user_id', userId);
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load Vendor Master'); return; }
  retVendorsList = (data || []);
  const dl = document.getElementById('retVendorDatalist');
  if (dl) {
    dl.innerHTML = retVendorsList.map(v =>
      `<option value="${escItemHtml(v.name)}">${v.gstin ? '(' + v.gstin + ')' : ''}</option>`
    ).join('');
  }
}

function onRetVendorInput() {
  const name = getRetText('retVendorName');
  const vendor = retVendorsList.find(v => v.name.toLowerCase() === name.toLowerCase());
  retSelectedVendorId = vendor ? vendor.id : null;
  if (!vendor) return;
  const gstEl = document.getElementById('retGstin'); if (gstEl && !gstEl.value && vendor.gstin) gstEl.value = vendor.gstin.toUpperCase();
  const stEl  = document.getElementById('retState'); if (stEl  && !stEl.value  && vendor.state) stEl.value = vendor.state;
  detectRetSupplyType();
  updateRetGstinValidationStatus();
}

// ── Save ─────────────────────────────────────────────
async function savePurchaseReturn() {
  const user = await getCurrentUser();
  if (!user) return;

  const vendorName = getRetText('retVendorName');
  const gstin       = getRetText('retGstin').toUpperCase();
  const returnNum   = getRetText('retNum');
  const returnDate  = getRetText('retDate');
  const reason      = getRetText('retReason');
  const origNum     = getRetText('retOrigPurchase');
  const state       = document.getElementById('retState')?.value || '';
  const supply      = document.getElementById('retSupply')?.value || 'intrastate';
  const wasNew      = !retEditId;

  if (!vendorName) { showToast('Please enter the vendor name.', 'error'); return; }
  if (!returnNum)  { showToast('Please enter a return number.', 'error'); return; }
  if (!returnDate) { showToast('Please enter the return date.', 'error'); return; }
  if (gstin && !validateGstin(gstin).valid) {
    showToast('Vendor GSTIN is invalid — correct it (or clear it) before saving.', 'error');
    return;
  }

  if (!retEditId) {
    // readMaybeOne(), not a bare destructure of `.data`. A `.single()`
    // that finds nothing and a `.single()` whose REQUEST failed both
    // arrive with no data, and reading them the same way meant a failed
    // duplicate check was taken as "no duplicate" and the save went
    // ahead — putting two documents on one number into a filing, which
    // the Portal rejects and which has to be unpicked by hand. undefined
    // means the check itself failed, so nothing is saved.
    const dup = await readMaybeOne(
      _supabase.from('purchase_returns').select('id').eq('user_id', user.id).eq('return_number', returnNum).single(),
      'Could not check whether that return number is already used'
    );
    if (dup === undefined) return;
    if (dup?.id) { showToast('Return number already exists!', 'warning'); return; }
  }

  const headerBase = {
    user_id: user.id,
    vendor_id: retSelectedVendorId,
    vendor_name: vendorName, vendor_gstin: gstin || null, state: state || null,
    return_number: returnNum, return_date: returnDate, supply_type: supply,
    original_purchase_number: origNum || null,
    reason: reason || null
  };

  const id = await savePurchaseWithItems('return', headerBase, retEditId, user.id);
  if (!id) return;

  showToast(wasNew ? 'Purchase return saved successfully!' : 'Purchase return updated successfully!');
  resetPurchaseReturn();
  await loadPurchaseReturns(user.id);
}

function resetPurchaseReturn() {
  ['retGstin','retNum','retReason','retOrigPurchase'].forEach(id => setRetValue(id, ''));
  setRetValue('retVendorName', '');
  setRetValue('retState', '');
  setRetValue('retDate', toISO(new Date()));
  retSelectedVendorId = null;
  retEditId = null;
  updateRetGstinValidationStatus();
  resetPurchaseItems();
  document.getElementById('retFormTitle').textContent = 'New Purchase Return';
  document.getElementById('retSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Return';
  detectRetSupplyType();
}

// ── History list ──────────────────────────────────────
async function loadPurchaseReturns(userId) {
  const { data, error } = await _supabase.from('purchase_returns').select('*').eq('user_id', userId).order('return_date', { ascending: false });
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the purchase returns'); return; }
  retAllData = (data || []);
  retPage = 1;
  renderRetTable(retAllData);
}

function renderRetTable(data) {
  const tbody = document.getElementById('retTableBody');
  const tfoot = document.getElementById('retTableTotal');
  if (!tbody) return;

  const start = (retPage - 1) * RET_PAGE;
  const page  = data.slice(start, start + RET_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-undo" style="display:block;font-size:40px;margin-bottom:10px;"></i>No purchase returns found</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderRetPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td><b>${r.return_number}</b></td>
      <td>${formatDate(r.return_date)}</td>
      <td>${r.vendor_name}</td>
      <td>${r.original_purchase_number || '&mdash;'}</td>
      <td class="text-right fw-700">&#8377;${formatNum(r.total_amount)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editPurchaseReturn('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deletePurchaseReturn('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const total = data.reduce((s, r) => s + (+r.total_amount || 0), 0);
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="5" class="fw-700">TOTALS (${data.length} returns)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td></td></tr>`;

  renderRetPagination(data.length);
}

function renderRetPagination(total) {
  const c = document.getElementById('retPagination');
  if (!c) return;
  const pages = Math.ceil(total / RET_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="retPage=${retPage-1};renderRetTable(retAllData)" ${retPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===retPage?'active':''}" onclick="retPage=${i};renderRetTable(retAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="retPage=${retPage+1};renderRetTable(retAllData)" ${retPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

async function editPurchaseReturn(id) {
  // Header and line items are both read before the form is touched, and a
  // failed read stops the edit rather than opening a form that looks like
  // the record has fewer lines than it has — saving that back would
  // overwrite the real ones. Same reasoning as loadInvoiceForEdit() in
  // js/invoice-entry.js.
  const rec = await readMaybeOne(
    _supabase.from('purchase_returns').select('*').eq('id', id).single(),
    'Could not open the purchase return'
  );
  if (rec === undefined) return;
  if (!rec) { showToast('That purchase return no longer exists.', 'warning'); return; }

  retEditId = id;
  retSelectedVendorId = rec.vendor_id || null;
  setRetValue('retVendorName', rec.vendor_name || '');
  setRetValue('retGstin', rec.vendor_gstin || '');
  setRetValue('retState', rec.state || '');
  setRetValue('retNum', rec.return_number || '');
  setRetValue('retDate', rec.return_date || '');
  setRetValue('retReason', rec.reason || '');
  setRetValue('retOrigPurchase', rec.original_purchase_number || '');

  // A failed read here would open the edit form showing no lines, and
  // saving that back would wipe the ones the return actually has.
  const itemRead = await readAll([
    _supabase.from('purchase_return_items').select('*').eq('return_id', id)
  ], 'Could not open the purchase return');
  if (!itemRead) return;
  const activeItems = itemRead[0].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) loadPurchItemsIntoTable(activeItems);

  document.getElementById('retFormTitle').textContent = 'Edit Purchase Return';
  document.getElementById('retSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Return';
  document.getElementById('retVendorName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  detectRetSupplyType();
  updateRetGstinValidationStatus();
}

async function deletePurchaseReturn(id) {
  const ok = await showConfirm('Permanently delete this return? Stock removed by it will be given back. This cannot be undone.');
  if (!ok) return;
  await cascadePurchaseItemsDelete('return', id); // items + stock reversal first
  const { error } = await _supabase.from('purchase_returns').delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the purchase return'); return; }
  showToast('Purchase return permanently deleted.', 'success');
  const user = await getCurrentUser();
  if (user) await loadPurchaseReturns(user.id);
}

function setupRetSearch() {
  document.getElementById('retSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? retAllData.filter(r =>
      r.return_number.toLowerCase().includes(q) ||
      r.vendor_name.toLowerCase().includes(q) ||
      (r.original_purchase_number || '').toLowerCase().includes(q)
    ) : retAllData;
    retPage = 1;
    renderRetTable(filtered);
  });
}
