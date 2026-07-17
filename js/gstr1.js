// =============================================
// GSTR-1 B2B Invoice Logic
// =============================================
let b2bEditId = null;
let b2bAllData = [];
let b2bPage = 1;
const PAGE_SIZE = 10;
let customersList = [];
let b2bSelectedIds = new Set();

async function initB2B() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupB2BSearch();
  updateAutoToggleUI();
  await loadCustomersList(user.id);
  await initInvoiceItems(user.id, 'b2b');
  await loadB2B(user.id);
  applyIncomingSearchQuery('b2bSearch');
  generateInvoiceNo(user.id);

  const draftFields = ['b2bGstNum','b2bCustName','b2bInvNum','b2bInvDate','b2bSupply'];
  setupDraftAutosave('b2b_invoice', draftFields);
  if (!b2bEditId) checkForDraft('b2b_invoice', draftFields, 'b2bDraftBanner', 'restoreB2BDraftFull', 'discardB2BDraftFull');
  // Prefill from Customer Master redirect
  const pf = sessionStorage.getItem('prefill_customer');
  if (pf) {
    try {
      const c = JSON.parse(pf);
      if (c.name) document.getElementById('b2bCustName').value = c.name;
      if (c.gstin) document.getElementById('b2bGstNum').value = c.gstin;
    } catch {}
    sessionStorage.removeItem('prefill_customer');
  }
}

const B2B_DRAFT_FIELDS = ['b2bGstNum','b2bCustName','b2bInvNum','b2bInvDate','b2bSupply'];

function restoreB2BDraftFull(formKey) {
  restoreDraft(formKey, B2B_DRAFT_FIELDS);
  restoreItemsFromDraft(formKey);
  const banner = document.getElementById('b2bDraftBanner'); if (banner) banner.innerHTML = '';
}

function discardB2BDraftFull(formKey) {
  discardDraft(formKey, 'b2bDraftBanner');
  clearItemsDraft(formKey);
}

// ── Invoice Number Auto-generate ──────────────────
function isAutoInvoiceOn() {
  return localStorage.getItem('gst_auto_invoice') === 'true';
}

function updateAutoToggleUI() {
  const on  = isAutoInvoiceOn();
  const cb  = document.getElementById('autoInvToggle');
  const lbl = document.getElementById('autoInvLabel');
  if (cb)  cb.checked = on;
  if (lbl) { lbl.textContent = on ? 'ON' : 'OFF'; lbl.style.color = on ? 'var(--primary)' : '#9e9e9e'; }
}

function onAutoToggleChange() {
  const on = document.getElementById('autoInvToggle')?.checked;
  localStorage.setItem('gst_auto_invoice', on);
  updateAutoToggleUI();
  if (on) getCurrentUser().then(u => { if (u) generateInvoiceNo(u.id, true); });
}

async function generateInvoiceNo(userId, force) {
  if (b2bEditId) return;
  if (!force && !isAutoInvoiceOn()) return;
  const year = new Date().getFullYear();
  const { data } = await _supabase.from('b2b_invoices').select('invoice_number').eq('user_id', userId || 'local-demo-user-001');
  const nums = (data || []).map(r => {
    const m = r.invoice_number?.match(/(\d+)$/);
    return m ? parseInt(m[1]) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const invNum = `INV-${year}-${String(next).padStart(3, '0')}`;
  const el = document.getElementById('b2bInvNum');
  if (el) el.value = invNum;
}

// ── Customer Master helpers ───────────────────────
async function loadCustomersList(userId) {
  const { data } = await _supabase.from('customers').select('*').eq('user_id', userId);
  customersList = (data || []).filter(c => !c.is_deleted);
  const dl = document.getElementById('customerDatalist');
  if (dl) {
    dl.innerHTML = customersList.map(c => `<option value="${c.name}" data-gstin="${c.gstin}" data-id="${c.id}">${c.gstin ? '(' + c.gstin + ')' : ''}</option>`).join('');
  }
}

function onCustomerSelect() {
  const name = document.getElementById('b2bCustName')?.value?.trim();
  const cust = customersList.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (cust && cust.gstin) {
    const gstEl = document.getElementById('b2bGstNum');
    if (gstEl && !gstEl.value) gstEl.value = cust.gstin.toUpperCase();
  }
}

async function saveCustomerFromForm() {
  const user = await getCurrentUser();
  if (!user) return;
  const name  = getText('b2bCustName');
  const gstin = getText('b2bGstNum');
  if (!name) { showToast('Enter customer name first.', 'error'); return; }
  const exists = customersList.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) { showToast('Customer already saved!', 'warning'); return; }
  const { error } = await _supabase.from('customers').insert({ user_id: user.id, name, gstin });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Customer saved to master!', 'success');
  await loadCustomersList(user.id);
}

function setValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function getText(id)  { return document.getElementById(id)?.value?.trim() || ''; }

async function saveB2B() {
  const user = await getCurrentUser();
  if (!user) return;

  const gstNum   = getText('b2bGstNum');
  const custName = getText('b2bCustName');
  const invNum   = getText('b2bInvNum');
  const invDate  = getText('b2bInvDate');
  const supply   = getText('b2bSupply');

  if (!gstNum || !custName || !invNum || !invDate) { showToast('Please fill all required fields.', 'error'); return; }
  if (gstNum.length < 15) { showToast('GST Number must be 15 characters.', 'error'); return; }
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstNum)) {
    showToast('GST Number format warning — saving anyway.', 'warning');
  }

  if (!b2bEditId) {
    const dup = await _supabase.from('b2b_invoices').select('id').eq('user_id', user.id).eq('invoice_number', invNum).single();
    if (dup.data) { showToast('Invoice number already exists!', 'error'); return; }
  }

  const headerBase = {
    user_id: user.id, gst_number: gstNum, customer_name: custName,
    invoice_number: invNum, invoice_date: invDate, supply_type: supply
  };

  const result = await saveInvoiceWithItems('b2b', headerBase, b2bEditId, user.id);
  if (!result) return;

  showToast(b2bEditId ? 'Invoice updated successfully!' : 'Invoice saved successfully!');
  b2bEditId = null;
  resetB2B();
  clearDraft('b2b_invoice');
  clearItemsDraft('b2b_invoice');
  const banner = document.getElementById('b2bDraftBanner'); if (banner) banner.innerHTML = '';
  await loadB2B(user.id);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function resetB2B() {
  ['b2bGstNum','b2bCustName','b2bInvNum'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('b2bInvDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('b2bSupply').value = 'intrastate';
  resetInvoiceItems();
  b2bEditId = null;
  document.getElementById('formTitle').textContent = 'B2B Invoice Entry';
  document.getElementById('saveBtn').innerHTML = '<i class="fas fa-save"></i> Save Invoice';
  getCurrentUser().then(u => { if (u) generateInvoiceNo(u.id); });
}

async function loadB2B(userId) {
  const { data } = await _supabase.from('b2b_invoices').select('*').eq('user_id', userId).order('invoice_date', { ascending: false });
  b2bAllData = (data || []).filter(r => !r.is_deleted);
  b2bPage = 1;
  renderB2BTable(b2bAllData);
}

function renderB2BTable(data) {
  const tbody = document.getElementById('b2bTableBody');
  const total = document.getElementById('b2bTableTotal');
  if (!tbody) return;

  const start = (b2bPage - 1) * PAGE_SIZE;
  const page  = data.slice(start, start + PAGE_SIZE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty-state"><i class="fas fa-file-invoice table-loading-icon"></i>No B2B invoices found</td></tr>';
    if (total) total.innerHTML = '';
    renderPagination('b2bPagination', 0, 0, () => {});
    updateB2BBulkBar();
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td><input type="checkbox" class="b2b-row-check" data-id="${r.id}" ${b2bSelectedIds.has(r.id) ? 'checked' : ''} onchange="toggleSelectB2B('${r.id}', this.checked)" aria-label="Select row ${start + i + 1}"></td>
      <td>${start + i + 1}</td>
      <td><span class="fw-600">${r.gst_number}</span></td>
      <td>${r.customer_name}</td>
      <td>${r.invoice_number}</td>
      <td>${formatDate(r.invoice_date)}</td>
      <td><span class="badge ${r.supply_type==='interstate'?'badge-blue':'badge-green'}">${r.supply_type}</span></td>
      <td class="text-right">₹${formatNum(r.taxable_amount)}</td>
      <td class="text-center">${r.gst_percentage}%</td>
      <td class="text-right">₹${formatNum(r.igst)}<br><small class="text-muted">C:${formatNum(r.cgst)} S:${formatNum(r.sgst)}</small></td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td>
        <div class="action-btns">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="editB2B('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon"    onclick="deleteB2B('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
          <button type="button" class="btn btn-success btn-sm btn-icon"   onclick="shareWhatsApp('${r.id}')" title="Share via WhatsApp"><i class="fab fa-whatsapp"></i></button>
          <button type="button" class="btn btn-info btn-sm btn-icon"      onclick="exportSingleInvoiceJSON('${r.id}')" title="Download as JSON"><i class="fas fa-code"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const totals = { taxable: data.reduce((s,r)=>s+ +r.taxable_amount,0), gst: data.reduce((s,r)=>s+ +r.gst_amount,0), igst: data.reduce((s,r)=>s+ +r.igst,0), cgst: data.reduce((s,r)=>s+ +r.cgst,0), sgst: data.reduce((s,r)=>s+ +r.sgst,0), total: data.reduce((s,r)=>s+ +r.total_amount,0) };

  if (total) total.innerHTML = `
    <tr>
      <td></td>
      <td colspan="6" class="fw-700">TOTALS (${data.length} invoices)</td>
      <td class="text-right fw-700">₹${formatNum(totals.taxable)}</td>
      <td></td>
      <td class="text-right fw-700">₹${formatNum(totals.igst)}</td>
      <td class="text-right fw-700">₹${formatNum(totals.total)}</td>
      <td></td>
    </tr>`;

  renderPagination('b2bPagination', data.length, b2bPage, (p) => { b2bPage = p; renderB2BTable(data); });
  updateB2BBulkBar();
}

// ── Bulk operations ────────────────────────────────
function toggleSelectAllB2B(checked) {
  document.querySelectorAll('.b2b-row-check').forEach(cb => {
    cb.checked = checked;
    if (checked) b2bSelectedIds.add(cb.dataset.id);
    else b2bSelectedIds.delete(cb.dataset.id);
  });
  updateB2BBulkBar();
}

function toggleSelectB2B(id, checked) {
  if (checked) b2bSelectedIds.add(id);
  else b2bSelectedIds.delete(id);
  updateB2BBulkBar();
}

function clearB2BSelection() {
  b2bSelectedIds.clear();
  document.querySelectorAll('.b2b-row-check').forEach(cb => cb.checked = false);
  const all = document.getElementById('b2bSelectAll'); if (all) all.checked = false;
  updateB2BBulkBar();
}

function updateB2BBulkBar() {
  const bar = document.getElementById('b2bBulkBar');
  const countEl = document.getElementById('b2bSelectedCount');
  if (countEl) countEl.textContent = b2bSelectedIds.size;
  if (bar) bar.classList.toggle('d-none', b2bSelectedIds.size === 0);
}

function getSelectedB2BRecords() {
  return b2bAllData.filter(r => b2bSelectedIds.has(r.id));
}

async function bulkDeleteB2B() {
  if (!b2bSelectedIds.size) return;
  const ok = await showConfirm(`Move ${b2bSelectedIds.size} selected invoice(s) to Recycle Bin?`);
  if (!ok) return;
  const ids = [...b2bSelectedIds];
  for (const id of ids) {
    await _supabase.from('b2b_invoices').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
    await cascadeInvoiceItemsDelete('b2b', id);
  }
  showToast(`Moved ${ids.length} invoice(s) to Recycle Bin.`);
  b2bSelectedIds.clear();
  const user = await getCurrentUser();
  if (user) await loadB2B(user.id);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function bulkExportB2BExcel() {
  const rows = getSelectedB2BRecords();
  if (!rows.length) { showToast('No rows selected.', 'warning'); return; }
  exportB2BExcel(rows);
}

async function editB2B(id) {
  const rec = b2bAllData.find(r => r.id === id);
  if (!rec) return;
  b2bEditId = id;
  document.getElementById('b2bGstNum').value   = rec.gst_number;
  document.getElementById('b2bCustName').value  = rec.customer_name;
  document.getElementById('b2bInvNum').value    = rec.invoice_number;
  document.getElementById('b2bInvDate').value   = rec.invoice_date;
  document.getElementById('b2bSupply').value    = rec.supply_type;

  const { data: items } = await _supabase.from('invoice_items').select('*').eq('invoice_id', id).eq('invoice_type', 'b2b');
  const activeItems = (items || []).filter(r => !r.is_deleted).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) loadItemsIntoTable(activeItems);
  else synthesizeLegacyItemRow(rec);

  document.getElementById('formTitle').textContent = 'Edit B2B Invoice';
  document.getElementById('saveBtn').innerHTML = '<i class="fas fa-save"></i> Update Invoice';
  document.getElementById('b2bGstNum').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteB2B(id) {
  const ok = await showConfirm('Move this invoice to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const { error } = await _supabase.from('b2b_invoices').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  await cascadeInvoiceItemsDelete('b2b', id);
  showToast('Invoice moved to Recycle Bin.');
  b2bAllData = b2bAllData.filter(r => r.id !== id);
  renderB2BTable(b2bAllData);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function setupB2BSearch() {
  document.getElementById('b2bSearch')?.addEventListener('input', applyB2BFilters);
}

function applyB2BFilters() {
  const q = document.getElementById('b2bSearch')?.value?.toLowerCase() || '';
  const rate = document.getElementById('b2bRateFilter')?.value || '';
  let filtered = b2bAllData;
  if (q) {
    filtered = filtered.filter(r =>
      r.gst_number.toLowerCase().includes(q) ||
      r.customer_name.toLowerCase().includes(q) ||
      r.invoice_number.toLowerCase().includes(q));
  }
  if (rate !== '') {
    filtered = filtered.filter(r => String(r.gst_percentage) === rate);
  }
  b2bPage = 1;
  renderB2BTable(filtered);
}

// ── Export JSON (single or all) ──────────────────
function toInvoiceJSON(r) {
  return {
    gstNo:         r.gst_number,
    customerName:  r.customer_name,
    invoiceDate:   r.invoice_date,
    invoiceNumber: r.invoice_number,
    percentage:    r.gst_percentage,
    taxableBefore: r.taxable_amount,
    gstAmount:     r.gst_amount,
    taxableAfter:  r.total_amount
  };
}

function exportSingleInvoiceJSON(id) {
  const rec = b2bAllData.find(r => r.id === id);
  if (!rec) return;
  const blob = new Blob([JSON.stringify(toInvoiceJSON(rec), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `invoice_${rec.invoice_number}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Invoice JSON downloaded!', 'success');
}

function exportAllInvoicesJSON() {
  if (!b2bAllData.length) { showToast('No invoices to export!', 'warning'); return; }
  const blob = new Blob([JSON.stringify(b2bAllData.map(toInvoiceJSON), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `B2B_Invoices_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Exported ${b2bAllData.length} invoices as JSON!`, 'success');
}

// ── Import JSON Invoices ──────────────────────────
function importB2BFromJSON(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      let raw = JSON.parse(e.target.result);
      // Support single object or array
      const items = Array.isArray(raw) ? raw : [raw];

      const user = await getCurrentUser();
      if (!user) return;

      let imported = 0, skipped = 0;
      for (const inv of items) {
        // Map fields — support both their format and our format
        const gstNum   = inv.gstNo       || inv.gst_number     || '';
        const custName = inv.customerName|| inv.customer_name   || '';
        const invNum   = String(inv.invoiceNumber || inv.invoice_number || '');
        const invDate  = inv.invoiceDate  || inv.invoice_date   || new Date().toISOString().split('T')[0];
        const taxable  = parseFloat(inv.taxableBefore || inv.taxable_amount || 0);
        const gstPct   = parseFloat(inv.percentage    || inv.gst_percentage || 18);
        const supply   = inv.supply_type || inv.supplyType || 'intrastate';

        if (!gstNum || !custName || !invNum || taxable <= 0) { skipped++; continue; }

        // Check duplicate
        const dup = await _supabase.from('b2b_invoices').select('id')
          .eq('user_id', user.id).eq('invoice_number', invNum).single();
        if (dup.data) { skipped++; continue; }

        const r = calcGST(taxable, gstPct, supply);
        await _supabase.from('b2b_invoices').insert({
          user_id: user.id,
          gst_number: gstNum.toUpperCase(),
          customer_name: custName,
          invoice_number: invNum,
          invoice_date: invDate,
          taxable_amount: taxable,
          gst_percentage: gstPct,
          gst_amount: r.gstAmount,
          total_amount: r.totalAmount,
          supply_type: supply,
          igst: r.igst,
          cgst: r.cgst,
          sgst: r.sgst
        });
        imported++;
      }

      showToast(`Imported ${imported} invoice${imported !== 1 ? 's' : ''}${skipped ? ' (' + skipped + ' skipped — duplicate/invalid)' : ''}!`, imported > 0 ? 'success' : 'warning');
      await loadB2B(user.id);
      if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
    } catch {
      showToast('Invalid JSON file!', 'error');
    }
  };
  reader.readAsText(file);
}

// ── WhatsApp Share ────────────────────────────────
function shareWhatsApp(id) {
  const rec = b2bAllData.find(r => r.id === id);
  if (!rec) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const biz = p ? p.business_name || 'GST Invoice' : 'GST Invoice';
  const msg = `*${biz} — Tax Invoice*\n\n` +
    `Invoice No : ${rec.invoice_number}\n` +
    `Date       : ${formatDate(rec.invoice_date)}\n` +
    `Customer   : ${rec.customer_name}\n` +
    `GSTIN      : ${rec.gst_number}\n` +
    `Supply     : ${rec.supply_type}\n\n` +
    `Taxable Amt: ₹${formatNum(rec.taxable_amount)}\n` +
    `GST (${rec.gst_percentage}%)  : ₹${formatNum(rec.gst_amount)}\n` +
    (rec.igst > 0 ? `IGST       : ₹${formatNum(rec.igst)}\n` : `CGST       : ₹${formatNum(rec.cgst)}\nSGST       : ₹${formatNum(rec.sgst)}\n`) +
    `*Total Amt : ₹${formatNum(rec.total_amount)}*\n\n` +
    `_Generated by GST Invoice Management System_`;
  const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
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
