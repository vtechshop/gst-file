// =============================================
// Customer Master Logic
// =============================================
let custEditId = null;
let custAllData = [];
let custPage = 1;
const CUST_PAGE = 15;

async function initCustomers() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupCustSearch();
  await loadCustomers(user.id);
  await loadCustomerOutstanding(user.id);
  applyIncomingSearchQuery('custSearch');
}

async function loadCustomerOutstanding(userId) {
  const tbody = document.getElementById('custOutstandingBody');
  if (!tbody) return;
  const rows = await loadCustomerOutstandingSummary(userId);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td class="fw-600">${r.name}</td>
        <td class="text-center">${r.invoiceCount}</td>
        <td class="text-right">&#8377;${formatNum(r.totalBilled)}</td>
        <td class="text-right">&#8377;${formatNum(r.totalPaid)}</td>
        <td class="text-right">${r.totalReturned > 0 ? '&#8377;' + formatNum(r.totalReturned) : '&mdash;'}</td>
        <td class="text-right fw-700 ${r.outstanding > 0 ? 'text-danger' : ''}">&#8377;${formatNum(r.outstanding)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No invoices yet.</td></tr>';
}

async function saveCustomer() {
  const user = await getCurrentUser();
  if (!user) return;

  const name  = document.getElementById('custName')?.value?.trim();
  const gstin = document.getElementById('custGSTIN')?.value?.trim().toUpperCase();
  const phone = document.getElementById('custPhone')?.value?.trim();
  const email = document.getElementById('custEmail')?.value?.trim();
  const addr  = document.getElementById('custAddr')?.value?.trim();
  const state = document.getElementById('custState')?.value;

  if (!name) { showToast('Customer name is required.', 'error'); return; }
  if (gstin && gstin.length !== 15) { showToast('GSTIN must be 15 characters.', 'error'); return; }

  const payload = { user_id: user.id, name, gstin, phone, email, address: addr, state };

  let error;
  if (custEditId) {
    ({ error } = await _supabase.from('customers').update(payload).eq('id', custEditId));
  } else {
    const dup = custAllData.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (dup) { showToast('Customer already exists!', 'warning'); return; }
    ({ error } = await _supabase.from('customers').insert(payload));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(custEditId ? 'Customer updated!' : 'Customer saved!');
  custEditId = null;
  resetCustomer();
  await loadCustomers(user.id);
}

function resetCustomer() {
  ['custName','custGSTIN','custPhone','custEmail','custAddr'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const st = document.getElementById('custState'); if (st) st.value = '';
  custEditId = null;
  const title = document.getElementById('custFormTitle');
  if (title) title.textContent = 'Add Customer';
  const btn = document.getElementById('custSaveBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> Save Customer';
}

async function loadCustomers(userId) {
  const { data } = await _supabase.from('customers').select('*').eq('user_id', userId).order('name', { ascending: true });
  custAllData = (data || []).filter(r => !r.is_deleted);
  custPage = 1;
  renderCustTable(custAllData);
}

function renderCustTable(data) {
  const tbody = document.getElementById('custTableBody');
  if (!tbody) return;

  const start = (custPage - 1) * CUST_PAGE;
  const page  = data.slice(start, start + CUST_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-address-book" style="display:block;font-size:40px;margin-bottom:10px;"></i>No customers found. Add your first customer!</td></tr>';
    renderCustPagination(0);
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
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editCustomer('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCustomer('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
          <button class="btn btn-success btn-sm btn-icon" onclick="useInB2B('${r.id}')" title="Create Invoice for this Customer" style="background:#00796b;border-color:#00796b;"><i class="fas fa-file-invoice"></i></button>
        </div>
      </td>
    </tr>`).join('');

  renderCustPagination(data.length);
}

function renderCustPagination(total) {
  const c = document.getElementById('custPagination');
  if (!c) return;
  const pages = Math.ceil(total / CUST_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="custPage=${custPage-1};renderCustTable(custAllData)" ${custPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===custPage?'active':''}" onclick="custPage=${i};renderCustTable(custAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="custPage=${custPage+1};renderCustTable(custAllData)" ${custPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

function editCustomer(id) {
  const rec = custAllData.find(r => r.id === id);
  if (!rec) return;
  custEditId = id;
  document.getElementById('custName').value  = rec.name || '';
  document.getElementById('custGSTIN').value = rec.gstin || '';
  document.getElementById('custPhone').value = rec.phone || '';
  document.getElementById('custEmail').value = rec.email || '';
  document.getElementById('custAddr').value  = rec.address || '';
  document.getElementById('custState').value = rec.state || '';
  document.getElementById('custFormTitle').textContent = 'Edit Customer';
  document.getElementById('custSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Customer';
  document.getElementById('custName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteCustomer(id) {
  const ok = await showConfirm('Move this customer to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const { error } = await _supabase.from('customers').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Customer moved to Recycle Bin.');
  custAllData = custAllData.filter(r => r.id !== id);
  renderCustTable(custAllData);
}

function useInB2B(id) {
  const rec = custAllData.find(r => r.id === id);
  if (!rec) return;
  sessionStorage.setItem('prefill_customer', JSON.stringify({
    name: rec.name, gstin: rec.gstin || '', phone: rec.phone || '', address: rec.address || '', state: rec.state || ''
  }));
  window.location.href = 'invoice.html';
}

function setupCustSearch() {
  document.getElementById('custSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? custAllData.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q) ||
      (r.phone || '').includes(q)
    ) : custAllData;
    custPage = 1;
    renderCustTable(filtered);
  });
}
