// =============================================
// Vendor Master Logic — mirrors js/customers.js exactly (list, inline
// add/edit form, search, pagination, soft delete), plus one addition:
// GSTIN gets the same offline-validated 🟢/🔴 status Invoice Entry's
// customer GSTIN already has (renderGstinStatusInto(), js/utils.js).
// =============================================
let vendEditId = null;
let vendAllData = [];
let vendPage = 1;
const VEND_PAGE = 15;

async function initVendors() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupVendSearch();
  await loadVendors(user.id);
  applyIncomingSearchQuery('vendSearch');
}

function onVendGstinInput(el) {
  el.value = el.value.toUpperCase();
  renderGstinStatusInto('vendGstinStatus', el.value.trim());
}

async function saveVendor() {
  const user = await getCurrentUser();
  if (!user) return;

  const name  = document.getElementById('vendName')?.value?.trim();
  const gstin = document.getElementById('vendGstin')?.value?.trim().toUpperCase();
  const phone = document.getElementById('vendPhone')?.value?.trim();
  const email = document.getElementById('vendEmail')?.value?.trim();
  const addr  = document.getElementById('vendAddr')?.value?.trim();
  const state = document.getElementById('vendState')?.value;

  if (!name) { showToast('Vendor name is required.', 'error'); return; }
  if (gstin && !validateGstin(gstin).valid) { showToast('GSTIN is invalid — correct it (or clear it) before saving.', 'error'); return; }

  const payload = { user_id: user.id, name, gstin, phone, email, address: addr, state };

  let error;
  if (vendEditId) {
    ({ error } = await _supabase.from('vendors').update(payload).eq('id', vendEditId));
  } else {
    const dup = vendAllData.find(v => v.name.toLowerCase() === name.toLowerCase());
    if (dup) { showToast('Vendor already exists!', 'warning'); return; }
    ({ error } = await _supabase.from('vendors').insert(payload));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(vendEditId ? 'Vendor updated!' : 'Vendor saved!');
  vendEditId = null;
  resetVendor();
  await loadVendors(user.id);
}

function resetVendor() {
  ['vendName','vendGstin','vendPhone','vendEmail','vendAddr'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const st = document.getElementById('vendState'); if (st) st.value = '';
  vendEditId = null;
  renderGstinStatusInto('vendGstinStatus', '');
  const title = document.getElementById('vendFormTitle');
  if (title) title.textContent = 'Add Vendor';
  const btn = document.getElementById('vendSaveBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> Save Vendor';
}

async function loadVendors(userId) {
  const { data } = await _supabase.from('vendors').select('*').eq('user_id', userId).order('name', { ascending: true });
  vendAllData = (data || []).filter(r => !r.is_deleted);
  vendPage = 1;
  renderVendTable(vendAllData);
}

function renderVendTable(data) {
  const tbody = document.getElementById('vendTableBody');
  if (!tbody) return;

  const start = (vendPage - 1) * VEND_PAGE;
  const page  = data.slice(start, start + VEND_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-truck-loading" style="display:block;font-size:40px;margin-bottom:10px;"></i>No vendors found. Add your first vendor!</td></tr>';
    renderVendPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td><b>${r.name}</b></td>
      <td><span class="badge badge-green" style="font-family:monospace;font-size:11px;">${r.gstin || '&mdash;'}</span></td>
      <td>${r.phone || '&mdash;'}</td>
      <td>${r.email || '&mdash;'}</td>
      <td>${r.state || '&mdash;'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editVendor('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteVendor('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
          <button class="btn btn-success btn-sm btn-icon" onclick="useInPurchase('${r.id}')" title="Create Purchase for this Vendor" style="background:#00796b;border-color:#00796b;"><i class="fas fa-cart-plus"></i></button>
        </div>
      </td>
    </tr>`).join('');

  renderVendPagination(data.length);
}

function renderVendPagination(total) {
  const c = document.getElementById('vendPagination');
  if (!c) return;
  const pages = Math.ceil(total / VEND_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="vendPage=${vendPage-1};renderVendTable(vendAllData)" ${vendPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===vendPage?'active':''}" onclick="vendPage=${i};renderVendTable(vendAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="vendPage=${vendPage+1};renderVendTable(vendAllData)" ${vendPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

function editVendor(id) {
  const rec = vendAllData.find(r => r.id === id);
  if (!rec) return;
  vendEditId = id;
  document.getElementById('vendName').value  = rec.name || '';
  document.getElementById('vendGstin').value = rec.gstin || '';
  document.getElementById('vendPhone').value = rec.phone || '';
  document.getElementById('vendEmail').value = rec.email || '';
  document.getElementById('vendAddr').value  = rec.address || '';
  document.getElementById('vendState').value = rec.state || '';
  renderGstinStatusInto('vendGstinStatus', rec.gstin || '');
  document.getElementById('vendFormTitle').textContent = 'Edit Vendor';
  document.getElementById('vendSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Vendor';
  document.getElementById('vendName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteVendor(id) {
  const ok = await showConfirm('Move this vendor to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const { error } = await _supabase.from('vendors').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Vendor moved to Recycle Bin.');
  vendAllData = vendAllData.filter(r => r.id !== id);
  renderVendTable(vendAllData);
}

function useInPurchase(id) {
  const rec = vendAllData.find(r => r.id === id);
  if (!rec) return;
  sessionStorage.setItem('prefill_vendor', JSON.stringify({
    id: rec.id, name: rec.name, gstin: rec.gstin || '', phone: rec.phone || '', address: rec.address || '', state: rec.state || ''
  }));
  window.location.href = 'purchases.html';
}

function setupVendSearch() {
  document.getElementById('vendSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? vendAllData.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q) ||
      (r.phone || '').includes(q)
    ) : vendAllData;
    vendPage = 1;
    renderVendTable(filtered);
  });
}
