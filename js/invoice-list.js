// =============================================
// Invoice List — unified read-only view over the existing
// b2b_invoices + b2c_invoices tables (the single source of truth,
// same records entered via B2B Invoice Entry / B2C Invoice Entry).
// Purely a display + actions page: no invoice entry happens here.
// =============================================

let invListAllData = [];
let invListPage = 1;
const INV_LIST_PAGE_SIZE = 10;

async function initInvoiceList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populateInvoiceListFilters();
  setupInvoiceListSearch();
  await loadInvoiceList(user.id);
}

async function loadInvoiceList(userId) {
  const [{ data: b2b }, { data: b2c }] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId)
  ]);

  const b2bRows = (b2b || []).filter(r => !r.is_deleted).map(r => ({
    type: 'b2b', id: r.id, invoice_number: r.invoice_number, invoice_date: r.invoice_date,
    customer_name: r.customer_name, gstin: r.gst_number, total_amount: +r.total_amount,
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));
  const b2cRows = (b2c || []).filter(r => !r.is_deleted).map(r => ({
    type: 'b2c', id: r.id, invoice_number: r.invoice_number || ('B2C-' + r.id.slice(0, 8).toUpperCase()), invoice_date: r.invoice_date,
    customer_name: r.customer_name || 'Walk-in Customer (B2C)', gstin: '', total_amount: +r.total_amount,
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));

  invListAllData = [...b2bRows, ...b2cRows].sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  invListPage = 1;
  renderInvoiceListTable(invListAllData);
}

function populateInvoiceListFilters() {
  const monthSel = document.getElementById('invListMonthFilter');
  const yearSel  = document.getElementById('invListYearFilter');
  if (monthSel) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthSel.innerHTML = '<option value="">All Months</option>' + months.map((m,i) => `<option value="${i+1}">${m}</option>`).join('');
  }
  if (yearSel) {
    const y = new Date().getFullYear();
    let opts = '<option value="">All Years</option>';
    for (let i = y; i >= y - 4; i--) opts += `<option value="${i}">${i}</option>`;
    yearSel.innerHTML = opts;
  }
}

function setupInvoiceListSearch() {
  document.getElementById('invListSearch')?.addEventListener('input', applyInvoiceListFilters);
}

function applyInvoiceListFilters() {
  const q = document.getElementById('invListSearch')?.value?.toLowerCase() || '';
  const month = document.getElementById('invListMonthFilter')?.value || '';
  const year  = document.getElementById('invListYearFilter')?.value || '';
  const type  = document.getElementById('invListTypeFilter')?.value || '';

  let filtered = invListAllData;
  if (q) {
    filtered = filtered.filter(r =>
      (r.invoice_number || '').toLowerCase().includes(q) ||
      (r.customer_name  || '').toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q));
  }
  if (month) filtered = filtered.filter(r => r.invoice_date && (new Date(r.invoice_date).getMonth() + 1) === +month);
  if (year)  filtered = filtered.filter(r => r.invoice_date && new Date(r.invoice_date).getFullYear() === +year);
  if (type)  filtered = filtered.filter(r => r.type === type);

  invListPage = 1;
  renderInvoiceListTable(filtered);
}

function renderInvoiceListTable(data) {
  const tbody = document.getElementById('invListTableBody');
  const tfoot = document.getElementById('invListTableTotal');
  if (!tbody) return;

  const start = (invListPage - 1) * INV_LIST_PAGE_SIZE;
  const page  = data.slice(start, start + INV_LIST_PAGE_SIZE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fas fa-file-invoice table-loading-icon"></i>No invoices found. Click New Invoice to create one.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderInvListPagination(0, 0, () => {});
    return;
  }

  const paymentBadge = { unpaid: 'badge-red', partial: 'badge-orange', paid: 'badge-green' };
  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td class="fw-600">${r.invoice_number}</td>
      <td>${formatDate(r.invoice_date)}</td>
      <td>${r.customer_name}</td>
      <td><span class="badge ${r.type === 'b2b' ? 'badge-blue' : 'badge-green'}">${r.type.toUpperCase()}</span></td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td>
        <span class="badge ${paymentBadge[r.payment_status] || 'badge-red'} clickable" onclick="openMarkPaymentModal('${r.type}','${r.id}')" title="Click to record payment">${r.payment_status.toUpperCase()}</span>
      </td>
      <td>
        <div class="action-btns">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="viewInvoiceFromList('${r.type}','${r.id}')" title="View"><i class="fas fa-eye"></i></button>
          <a class="btn btn-secondary btn-sm btn-icon" href="invoice.html?type=${r.type}&id=${r.id}" title="Edit"><i class="fas fa-edit"></i></a>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="duplicateInvoiceFromList('${r.type}','${r.id}')" title="Duplicate"><i class="fas fa-copy"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="downloadInvoicePDF('${r.type}','${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="printInvoice('${r.type}','${r.id}')" title="Print"><i class="fas fa-print"></i></button>
          <button type="button" class="btn btn-success btn-sm btn-icon" onclick="shareInvoiceWhatsApp('${r.type}','${r.id}')" title="Share via WhatsApp"><i class="fab fa-whatsapp"></i></button>
          <button type="button" class="btn btn-info btn-sm btn-icon btn-info-alt" onclick="emailInvoicePDF('${r.type}','${r.id}')" title="Email PDF"><i class="fas fa-envelope"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="deleteInvoiceFromList('${r.type}','${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const total = data.reduce((s, r) => s + (r.total_amount || 0), 0);
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="5" class="fw-700">TOTALS (${data.length} invoices)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td></td><td></td></tr>`;

  renderInvListPagination(data.length, invListPage, (p) => { invListPage = p; renderInvoiceListTable(data); });
}

// ── View (read-only preview, reusing the exact same markup printInvoice()
// generates — see buildInvoiceHTML() in js/invoice-pdf.js) ──────────
async function viewInvoiceFromList(type, id) {
  const html = await viewInvoiceHTML(type, id);
  if (!html) return;
  const frame = document.getElementById('viewInvoiceFrame');
  if (frame) frame.srcdoc = html;
  document.getElementById('viewInvoiceModal')?.classList.add('open');
}

function closeViewInvoiceModal() {
  document.getElementById('viewInvoiceModal')?.classList.remove('open');
}

// ── Duplicate (stashes the source invoice for invoice.html?duplicate=1
// to prefill — nothing is written to the DB until Save is clicked there) ──
async function duplicateInvoiceFromList(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  sessionStorage.setItem('invoice_duplicate_draft', JSON.stringify({
    customer_name: inv.customer_name, gst_number: inv.gstin, phone: inv.phone, address: inv.address, state: inv.state,
    supply_type: inv.supply_type,
    transport_required: inv.transport_required, vehicle_number: inv.vehicle_number, transporter_name: inv.transporter_name,
    transport_mode: inv.transport_mode, transport_distance_km: inv.transport_distance_km, lr_number: inv.lr_number, lr_date: inv.lr_date,
    items: inv.items || []
  }));
  window.location.href = 'invoice.html?duplicate=1';
}

// ── Payment: Receive Payment + Payment History ──────
let mpTarget = null; // { type, id }

async function openMarkPaymentModal(type, id) {
  const rec = invListAllData.find(r => r.type === type && r.id === id);
  if (!rec) return;
  mpTarget = { type, id };
  document.getElementById('mpInvoiceLabel').textContent = rec.invoice_number;
  setInvListValue('mpAmount', '');
  setInvListValue('mpMethod', 'cash');
  setInvListValue('mpDate', toISO(new Date()));
  setInvListValue('mpNote', '');
  document.getElementById('markPaymentModal')?.classList.add('open');
  await refreshPaymentModal();
}

function closeMarkPaymentModal() {
  document.getElementById('markPaymentModal')?.classList.remove('open');
  mpTarget = null;
}

function setInvListValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

async function refreshPaymentModal() {
  if (!mpTarget) return;
  const rec = invListAllData.find(r => r.type === mpTarget.type && r.id === mpTarget.id);
  if (!rec) return;

  const history = await loadPaymentsForInvoice(mpTarget.type, mpTarget.id);
  const receivedSoFar = round2(history.reduce((s, p) => s + (+p.amount || 0), 0));
  const outstanding = round2(Math.max(0, (rec.total_amount || 0) - receivedSoFar));

  document.getElementById('mpInvoiceTotal').textContent = '₹' + formatNum(rec.total_amount);
  document.getElementById('mpReceivedSoFar').textContent = '₹' + formatNum(receivedSoFar);
  document.getElementById('mpOutstanding').textContent = '₹' + formatNum(outstanding);

  const listEl = document.getElementById('mpHistoryList');
  if (listEl) {
    listEl.innerHTML = history.length
      ? history.map(p => `
        <div class="mini-list-row">
          <span>${formatDate(p.payment_date)} &middot; ${PAYMENT_METHOD_LABELS[p.method] || p.method}${p.note ? ' &middot; ' + escBinHtml(p.note) : ''}</span>
          <span class="d-flex align-center gap-10">
            <b>₹${formatNum(p.amount)}</b>
            <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="removePayment('${p.id}')" title="Remove this payment"><i class="fas fa-times"></i></button>
          </span>
        </div>`).join('')
      : '<p class="text-muted-sm">No payments recorded yet.</p>';
  }
}

function escBinHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

async function submitReceivePayment() {
  if (!mpTarget) return;
  const user = await getCurrentUser();
  if (!user) return;
  const amount = parseFloat(document.getElementById('mpAmount')?.value);
  const method = document.getElementById('mpMethod')?.value;
  const date = document.getElementById('mpDate')?.value;
  const note = document.getElementById('mpNote')?.value;

  const result = await recordPayment(mpTarget.type, mpTarget.id, user.id, { amount, method, date, note });
  if (!result.ok) { showToast(result.reason || 'Could not record payment.', 'error'); return; }

  showToast('Payment recorded.', 'success');
  setInvListValue('mpAmount', '');
  setInvListValue('mpNote', '');
  await loadInvoiceList(user.id);
  await refreshPaymentModal();
}

async function removePayment(paymentId) {
  if (!mpTarget) return;
  const user = await getCurrentUser();
  if (!user) return;
  const ok = await showConfirm('Remove this payment record? The invoice balance will be recalculated.');
  if (!ok) return;
  const result = await deletePayment(paymentId, mpTarget.type, mpTarget.id, user.id);
  if (!result.ok) { showToast(result.reason || 'Could not remove payment.', 'error'); return; }
  showToast('Payment removed.', 'success');
  await loadInvoiceList(user.id);
  await refreshPaymentModal();
}

async function deleteInvoiceFromList(type, id) {
  const ok = await showConfirm('Move this invoice to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const { error } = await _supabase.from(table).update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  await cascadeInvoiceItemsDelete(type, id);
  showToast('Invoice moved to Recycle Bin.', 'success');
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
  const user = await getCurrentUser();
  if (user) await loadInvoiceList(user.id);
}

function renderInvListPagination(total, current, onChange) {
  const container = document.getElementById('invListPagination');
  if (!container) return;
  const pages = Math.ceil(total / INV_LIST_PAGE_SIZE);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="(${onChange.toString()})(${current-1})" ${current===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===current?'active':''}" onclick="(${onChange.toString()})(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="(${onChange.toString()})(${current+1})" ${current===pages?'disabled':''}>&#8250;</button>`;
  container.innerHTML = html;
}
