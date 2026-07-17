// =============================================
// B2C Invoice Logic
// =============================================
let b2cEditId = null;
let b2cAllData = [];
let b2cPage = 1;
const PAGE_SIZE = 10;

async function initB2C() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  loadUserProfile(user.id);
  setupMobileMenu();
  populateStateOptions();
  setupB2CSearch();
  await initInvoiceItems(user.id, 'b2c');
  await loadB2C(user.id);
  applyIncomingSearchQuery('b2cSearch');

  const draftFields = ['b2cState','b2cSupply','b2cInvDate'];
  setupDraftAutosave('b2c_invoice', draftFields);
  if (!b2cEditId) checkForDraft('b2c_invoice', draftFields, 'b2cDraftBanner', 'restoreB2CDraftFull', 'discardB2CDraftFull');
}

const B2C_DRAFT_FIELDS = ['b2cState','b2cSupply','b2cInvDate'];

function restoreB2CDraftFull(formKey) {
  restoreDraft(formKey, B2C_DRAFT_FIELDS);
  restoreItemsFromDraft(formKey);
  const banner = document.getElementById('b2cDraftBanner'); if (banner) banner.innerHTML = '';
}

function discardB2CDraftFull(formKey) {
  discardDraft(formKey, 'b2cDraftBanner');
  clearItemsDraft(formKey);
}

function populateStateOptions() {
  const sel = document.getElementById('b2cState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function saveB2C() {
  const user = await getCurrentUser();
  if (!user) return;
  const state   = document.getElementById('b2cState')?.value;
  const supply  = document.getElementById('b2cSupply')?.value;
  const invDate = document.getElementById('b2cInvDate')?.value;
  if (!state) { showToast('Please select a state.', 'error'); return; }
  if (!invDate) { showToast('Please enter invoice date.', 'error'); return; }

  const headerBase = { user_id: user.id, state, supply_type: supply, invoice_date: invDate };

  const result = await saveInvoiceWithItems('b2c', headerBase, b2cEditId, user.id);
  if (!result) return;

  showToast(b2cEditId ? 'Invoice updated successfully!' : 'Invoice saved successfully!');
  b2cEditId = null;
  resetB2C();
  clearDraft('b2c_invoice');
  clearItemsDraft('b2c_invoice');
  const banner = document.getElementById('b2cDraftBanner'); if (banner) banner.innerHTML = '';
  await loadB2C(user.id);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function resetB2C() {
  document.getElementById('b2cState').value   = '';
  document.getElementById('b2cSupply').value  = 'intrastate';
  document.getElementById('b2cInvDate').value = new Date().toISOString().split('T')[0];
  resetInvoiceItems();
  b2cEditId = null;
  document.getElementById('b2cFormTitle').textContent = 'B2C Invoice Entry';
  document.getElementById('b2cSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Invoice';
}

async function loadB2C(userId) {
  const { data } = await _supabase.from('b2c_invoices').select('*').eq('user_id', userId).order('invoice_date', { ascending: false });
  b2cAllData = (data || []).filter(r => !r.is_deleted);
  b2cPage = 1;
  renderB2CTable(b2cAllData);
}

function renderB2CTable(data) {
  const tbody = document.getElementById('b2cTableBody');
  const tfoot = document.getElementById('b2cTableTotal');
  if (!tbody) return;
  const start = (b2cPage - 1) * PAGE_SIZE;
  const page  = data.slice(start, start + PAGE_SIZE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><i class="fas fa-users" style="display:block;font-size:40px;margin-bottom:10px;"></i>No B2C invoices found</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td>${r.state}</td>
      <td><span class="badge ${r.supply_type==='interstate'?'badge-blue':'badge-green'}">${r.supply_type}</span></td>
      <td>${formatDate(r.invoice_date)}</td>
      <td style="text-align:right;">₹${formatNum(r.taxable_amount)}</td>
      <td style="text-align:center;">${r.gst_percentage}%</td>
      <td style="text-align:right;">₹${formatNum(r.igst)}</td>
      <td style="text-align:right;">₹${formatNum(r.cgst)} / ₹${formatNum(r.sgst)}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary-dark);">₹${formatNum(r.total_amount)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editB2C('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon"    onclick="deleteB2C('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const totals = { taxable: data.reduce((s,r)=>s+ +r.taxable_amount,0), igst: data.reduce((s,r)=>s+ +r.igst,0), cgst: data.reduce((s,r)=>s+ +r.cgst,0), sgst: data.reduce((s,r)=>s+ +r.sgst,0), total: data.reduce((s,r)=>s+ +r.total_amount,0) };
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="4" style="font-weight:700;">TOTALS (${data.length} records)</td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.taxable)}</td><td></td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.igst)}</td><td style="text-align:right;font-weight:700;">C:${formatNum(totals.cgst)} S:${formatNum(totals.sgst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.total)}</td><td></td></tr>`;

  renderPagination('b2cPagination', data.length, b2cPage, (p) => { b2cPage = p; renderB2CTable(data); });
}

function renderPagination(containerId, total, current, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="(${onChange.toString()})(${current-1})" ${current===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===current?'active':''}" onclick="(${onChange.toString()})(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="(${onChange.toString()})(${current+1})" ${current===pages?'disabled':''}>&#8250;</button>`;
  container.innerHTML = html;
}

async function editB2C(id) {
  const rec = b2cAllData.find(r => r.id === id);
  if (!rec) return;
  b2cEditId = id;
  document.getElementById('b2cState').value   = rec.state;
  document.getElementById('b2cSupply').value  = rec.supply_type;
  document.getElementById('b2cInvDate').value = rec.invoice_date;

  const { data: items } = await _supabase.from('invoice_items').select('*').eq('invoice_id', id).eq('invoice_type', 'b2c');
  const activeItems = (items || []).filter(r => !r.is_deleted).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) loadItemsIntoTable(activeItems);
  else synthesizeLegacyItemRow(rec);

  document.getElementById('b2cFormTitle').textContent = 'Edit B2C Invoice';
  document.getElementById('b2cSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Invoice';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteB2C(id) {
  const ok = await showConfirm('Move this B2C invoice to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const { error } = await _supabase.from('b2c_invoices').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  await cascadeInvoiceItemsDelete('b2c', id);
  showToast('Invoice moved to Recycle Bin.');
  b2cAllData = b2cAllData.filter(r => r.id !== id);
  renderB2CTable(b2cAllData);
}

function setupB2CSearch() {
  document.getElementById('b2cSearch')?.addEventListener('input', applyB2CFilters);
}

function applyB2CFilters() {
  const q = document.getElementById('b2cSearch')?.value?.toLowerCase() || '';
  const rate = document.getElementById('b2cRateFilter')?.value || '';
  let filtered = b2cAllData;
  if (q) filtered = filtered.filter(r => r.state.toLowerCase().includes(q) || r.supply_type.includes(q));
  if (rate !== '') filtered = filtered.filter(r => String(r.gst_percentage) === rate);
  b2cPage = 1;
  renderB2CTable(filtered);
}
