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
  setupB2CCalc();
  setupB2CSearch();
  await loadB2C(user.id);
  applyIncomingSearchQuery('b2cSearch');

  const draftFields = ['b2cState','b2cTaxable','b2cGstPct','b2cSupply','b2cInvDate'];
  setupDraftAutosave('b2c_invoice', draftFields);
  if (!b2cEditId) checkForDraft('b2c_invoice', draftFields, 'b2cDraftBanner');
}

function populateStateOptions() {
  const sel = document.getElementById('b2cState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

function setupB2CCalc() {
  ['b2cTaxable','b2cGstPct','b2cSupply'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', recalcB2C);
    document.getElementById(id)?.addEventListener('input',  recalcB2C);
  });
}

function recalcB2C() {
  const amt  = parseFloat(document.getElementById('b2cTaxable')?.value) || 0;
  const pct  = parseFloat(document.getElementById('b2cGstPct')?.value)  || 0;
  const type = document.getElementById('b2cSupply')?.value || 'intrastate';
  const r    = calcGST(amt, pct, type);
  const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setV('b2cGstAmt',   formatNum(r.gstAmount));
  setV('b2cTotalAmt', formatNum(r.totalAmount));
  setV('b2cIGST',     formatNum(r.igst));
  setV('b2cCGST',     formatNum(r.cgst));
  setV('b2cSGST',     formatNum(r.sgst));
}

async function saveB2C() {
  const user = await getCurrentUser();
  if (!user) return;
  const state   = document.getElementById('b2cState')?.value;
  const taxable = parseFloat(document.getElementById('b2cTaxable')?.value) || 0;
  const gstPct  = parseFloat(document.getElementById('b2cGstPct')?.value)  || 0;
  const supply  = document.getElementById('b2cSupply')?.value;
  const invDate = document.getElementById('b2cInvDate')?.value;
  if (!state) { showToast('Please select a state.', 'error'); return; }
  if (taxable <= 0) { showToast('Taxable amount must be positive.', 'error'); return; }
  if (!invDate) { showToast('Please enter invoice date.', 'error'); return; }

  const r = calcGST(taxable, gstPct, supply);
  const payload = {
    user_id: user.id, state, taxable_amount: taxable,
    gst_percentage: gstPct, gst_amount: r.gstAmount,
    total_amount: r.totalAmount, supply_type: supply,
    igst: r.igst, cgst: r.cgst, sgst: r.sgst, invoice_date: invDate
  };

  let error;
  if (b2cEditId) {
    ({ error } = await _supabase.from('b2c_invoices').update(payload).eq('id', b2cEditId));
  } else {
    ({ error } = await _supabase.from('b2c_invoices').insert(payload));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(b2cEditId ? 'Invoice updated successfully!' : 'Invoice saved successfully!');
  b2cEditId = null;
  resetB2C();
  clearDraft('b2c_invoice');
  const banner = document.getElementById('b2cDraftBanner'); if (banner) banner.innerHTML = '';
  await loadB2C(user.id);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function resetB2C() {
  document.getElementById('b2cState').value   = '';
  document.getElementById('b2cTaxable').value = '';
  document.getElementById('b2cGstPct').value  = getDefaultGstPct();
  document.getElementById('b2cSupply').value  = 'intrastate';
  document.getElementById('b2cInvDate').value = new Date().toISOString().split('T')[0];
  recalcB2C();
  b2cEditId = null;
  document.getElementById('b2cFormTitle').textContent = 'B2C Invoice Entry';
  document.getElementById('b2cSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Invoice';
}

async function loadB2C(userId) {
  const { data } = await _supabase.from('b2c_invoices').select('*').eq('user_id', userId).order('invoice_date', { ascending: false });
  b2cAllData = data || [];
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
  document.getElementById('b2cTaxable').value = rec.taxable_amount;
  document.getElementById('b2cGstPct').value  = rec.gst_percentage;
  document.getElementById('b2cSupply').value  = rec.supply_type;
  document.getElementById('b2cInvDate').value = rec.invoice_date;
  recalcB2C();
  document.getElementById('b2cFormTitle').textContent = 'Edit B2C Invoice';
  document.getElementById('b2cSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Invoice';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteB2C(id) {
  const ok = await showConfirm('Delete this B2C invoice?');
  if (!ok) return;
  const { error } = await _supabase.from('b2c_invoices').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Invoice deleted!');
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
