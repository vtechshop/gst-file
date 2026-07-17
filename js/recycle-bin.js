// =============================================
// Recycle Bin — soft-deleted records across every module
// (B2B/B2C Invoices, HSN, Customers, Products, Credit/Debit Notes).
// Deleting a record anywhere in the app now sets is_deleted=true
// instead of removing the row, so it lands here and can be
// restored. "Delete Forever" is the only truly permanent action.
// =============================================

const RECYCLE_TABLES = [
  { table: 'b2b_invoices', label: 'B2B Invoice',        icon: 'fa-file-alt',
    title: r => r.invoice_number, subtitle: r => `${r.customer_name} &middot; ${r.gst_number}`, amount: r => r.total_amount },
  { table: 'b2c_invoices', label: 'B2C Invoice',        icon: 'fa-users',
    title: r => 'B2C-' + r.id.slice(0, 8).toUpperCase(), subtitle: r => r.state, amount: r => r.total_amount },
  { table: 'b2b_hsn',      label: 'B2B HSN Entry',      icon: 'fa-barcode',
    title: r => r.hsn_code, subtitle: r => r.product_name, amount: r => r.total_invoice_value },
  { table: 'b2c_hsn',      label: 'B2C HSN Entry',      icon: 'fa-tags',
    title: r => r.hsn_code, subtitle: r => r.product_name, amount: r => r.total_invoice_value },
  { table: 'customers',    label: 'Customer',           icon: 'fa-address-book',
    title: r => r.name, subtitle: r => r.gstin || r.phone || r.email || '', amount: null },
  { table: 'products',     label: 'Product',            icon: 'fa-box',
    title: r => r.name, subtitle: r => r.hsn_code || '', amount: r => r.default_rate },
  { table: 'cdn_notes',    label: 'Credit/Debit Note',  icon: 'fa-file-minus',
    title: r => r.note_number, subtitle: r => r.customer_name, amount: r => r.total_amount }
];

let binAllItems = [];

async function initRecycleBin() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  setupBinSearch();
  await loadRecycleBin(user.id);
}

async function loadRecycleBin(userId) {
  const results = await Promise.all(
    RECYCLE_TABLES.map(cfg => _supabase.from(cfg.table).select('*').eq('user_id', userId))
  );

  binAllItems = [];
  results.forEach((res, i) => {
    const cfg = RECYCLE_TABLES[i];
    (res.data || []).filter(r => r.is_deleted).forEach(r => {
      binAllItems.push({
        table: cfg.table, label: cfg.label, icon: cfg.icon,
        id: r.id, title: cfg.title(r) || '(untitled)', subtitle: cfg.subtitle(r) || '',
        amount: cfg.amount ? +cfg.amount(r) || 0 : null,
        deleted_at: r.deleted_at
      });
    });
  });
  binAllItems.sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));

  renderRecycleBin(binAllItems);
}

function setupBinSearch() {
  document.getElementById('binSearch')?.addEventListener('input', applyBinFilters);
  document.getElementById('binTypeFilter')?.addEventListener('change', applyBinFilters);
}

function applyBinFilters() {
  const q = document.getElementById('binSearch')?.value?.toLowerCase() || '';
  const type = document.getElementById('binTypeFilter')?.value || '';
  let filtered = binAllItems;
  if (type) filtered = filtered.filter(i => i.table === type);
  if (q) filtered = filtered.filter(i => i.title.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q));
  renderRecycleBin(filtered);
}

function renderRecycleBin(items) {
  const tbody = document.getElementById('binTableBody');
  const countEl = document.getElementById('binCount');
  if (countEl) countEl.textContent = binAllItems.length;
  if (!tbody) return;

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><i class="fas fa-trash-restore table-loading-icon"></i>Recycle Bin is empty</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(it => `
    <tr>
      <td><span class="badge badge-blue"><i class="fas ${it.icon}"></i> ${it.label}</span></td>
      <td class="fw-600">${escBin(it.title)}</td>
      <td class="text-muted-sm">${escBin(it.subtitle)}</td>
      <td class="text-right">${it.amount !== null ? '₹' + formatNum(it.amount) : '&mdash;'}</td>
      <td class="text-muted-sm">${it.deleted_at ? formatDate(it.deleted_at) : '&mdash;'}</td>
      <td>
        <div class="action-btns">
          <button type="button" class="btn btn-success btn-sm" onclick="restoreBinItem('${it.table}','${it.id}')" title="Restore"><i class="fas fa-trash-restore"></i> Restore</button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="deleteBinItemForever('${it.table}','${it.id}')" title="Delete Forever"><i class="fas fa-times"></i></button>
        </div>
      </td>
    </tr>`).join('');
}

function escBin(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function invoiceTypeForTable(table) {
  if (table === 'b2b_invoices') return 'b2b';
  if (table === 'b2c_invoices') return 'b2c';
  return null;
}

async function restoreBinItem(table, id) {
  const { error } = await _supabase.from(table).update({ is_deleted: false, deleted_at: null }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  const invType = invoiceTypeForTable(table);
  if (invType) await cascadeInvoiceItemsRestore(invType, id);
  showToast('Restored!', 'success');
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
  const user = await getCurrentUser();
  if (user) await loadRecycleBin(user.id);
}

async function deleteBinItemForever(table, id) {
  const ok = await showConfirm('Permanently delete this item? This CANNOT be undone.');
  if (!ok) return;
  const { error } = await _supabase.from(table).delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  const invType = invoiceTypeForTable(table);
  if (invType) await cascadeInvoiceItemsHardDelete(invType, id);
  showToast('Permanently deleted.', 'success');
  const user = await getCurrentUser();
  if (user) await loadRecycleBin(user.id);
}

async function emptyRecycleBin() {
  if (!binAllItems.length) return;
  const ok = await showConfirm(`Permanently delete all ${binAllItems.length} item(s) in the Recycle Bin? This CANNOT be undone.`);
  if (!ok) return;
  for (const it of binAllItems) {
    await _supabase.from(it.table).delete().eq('id', it.id);
    const invType = invoiceTypeForTable(it.table);
    if (invType) await cascadeInvoiceItemsHardDelete(invType, it.id);
  }
  showToast('Recycle Bin emptied.', 'success');
  const user = await getCurrentUser();
  if (user) await loadRecycleBin(user.id);
}
