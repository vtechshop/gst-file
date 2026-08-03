// =============================================
// Invoice List — unified read-only view over the existing
// b2b_invoices + b2c_invoices tables (the single source of truth,
// same records entered via B2B Invoice Entry / B2C Invoice Entry).
// Purely a display + actions page: no invoice entry happens here.
// =============================================

let invListAllData = [];
let invListPage = 1;
const INV_LIST_PAGE_SIZE = 10;

// The rows currently on screen, after filtering and sorting.
//
// This exists because renderInvListPagination() serialises its callback
// with Function.toString() into an inline onclick=, which then runs in
// global scope. Any variable the callback closed over is gone by then —
// the previous `renderInvoiceListTable(data)` threw "data is not
// defined" on every page click, so paging simply did not work. Holding
// the view in a module-level variable gives the revived function
// something it can actually reach.
let invListView = [];

// ── Invoice number ordering ─────────────────────────
// 'desc' = highest number first, which is the default: the newest
// invoice is the one people look for.
let invListSort = 'desc';

// Invoice numbers must order numerically, not as text — plain string
// comparison puts "142" after "1419" and, once a prefix is involved,
// scatters a sequence entirely. This splits each number into digit and
// non-digit runs and compares run by run, digits as numbers. That gives
// 138 < 139 < 142 < 149 for bare numbers, and keeps prefixed formats
// like INV-2026-00124 in sequence too, without assuming either shape.
function compareInvoiceNumbersAsc(a, b) {
  const chunks = v => String(v ?? '').match(/\d+|\D+/g) || [];
  const A = chunks(a), B = chunks(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1;      // shorter run sorts first
    if (y === undefined) return 1;
    const bothNumeric = /^\d/.test(x) && /^\d/.test(y);
    const d = bothNumeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return d;
  }
  return 0;
}

// Sorts a COPY, so callers can re-sort the same source list repeatedly
// without the order of a previous pass leaking into the next.
function sortInvoicesByNumber(rows, direction = invListSort) {
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const byNumber = compareInvoiceNumbersAsc(a.invoice_number, b.invoice_number);
    if (byNumber) return byNumber * dir;
    // Same number on both a B2B and a B2C invoice: fall back to date and
    // then id purely so the order is stable between renders.
    const byDate = (a.invoice_date || '').localeCompare(b.invoice_date || '');
    return byDate ? byDate * dir : String(a.id).localeCompare(String(b.id));
  });
}

function onInvoiceListSortChange() {
  invListSort = document.getElementById('invListSortOrder')?.value === 'asc' ? 'asc' : 'desc';
  // Re-sort the master list so every downstream view — filtering and
  // pagination alike — inherits the new order rather than each applying
  // its own.
  invListAllData = sortInvoicesByNumber(invListAllData);
  applyInvoiceListFilters();
}

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

  // `state` comes from the rows already fetched above — the select('*')
  // has always returned it, it just wasn't carried into the view model.
  // No extra request is made for the State column or its filter.
  const b2bRows = (b2b || []).map(r => ({
    type: 'b2b', id: r.id, invoice_number: r.invoice_number, invoice_date: r.invoice_date,
    customer_name: r.customer_name, gstin: r.gst_number, total_amount: +r.total_amount,
    state: r.state || '',
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));
  const b2cRows = (b2c || []).map(r => ({
    type: 'b2c', id: r.id, invoice_number: r.invoice_number || ('B2C-' + r.id.slice(0, 8).toUpperCase()), invoice_date: r.invoice_date,
    customer_name: r.customer_name || 'Walk-in Customer (B2C)', gstin: r.gst_number || '', total_amount: +r.total_amount,
    state: r.state || '',
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));

  // Ordered by invoice number the moment it is loaded, so filtering and
  // pagination both operate on an already-sorted list.
  invListAllData = sortInvoicesByNumber([...b2bRows, ...b2cRows]);
  invListPage = 1;
  // Populated here rather than in populateInvoiceListFilters(): the option
  // list is derived from the loaded records, which don't exist until now.
  populateInvoiceListStateFilter();
  renderInvoiceListTable(invListAllData);
}

// Rebuilt from whatever is in memory, preserving the current selection so
// a refresh after recording a payment doesn't silently reset the filter.
function populateInvoiceListStateFilter() {
  const sel = document.getElementById('invListStateFilter');
  if (!sel) return;
  sel.innerHTML = buildStateFilterOptions(invListAllData, r => r.state, sel.value);
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
  const state = document.getElementById('invListStateFilter')?.value || '';
  const month = document.getElementById('invListMonthFilter')?.value || '';
  const year  = document.getElementById('invListYearFilter')?.value || '';
  const type  = document.getElementById('invListTypeFilter')?.value || '';

  // Every filter narrows the same list in turn, so they combine rather
  // than override — State works alongside Search/Month/Year/Type.
  let filtered = invListAllData;
  if (q) {
    filtered = filtered.filter(r =>
      (r.invoice_number || '').toLowerCase().includes(q) ||
      (r.customer_name  || '').toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q));
  }
  if (state) filtered = filtered.filter(r => r.state === state);
  if (month) filtered = filtered.filter(r => r.invoice_date && (new Date(r.invoice_date).getMonth() + 1) === +month);
  if (year)  filtered = filtered.filter(r => r.invoice_date && new Date(r.invoice_date).getFullYear() === +year);
  if (type)  filtered = filtered.filter(r => r.type === type);

  invListPage = 1;
  // invListAllData is already in invoice-number order, and filtering
  // preserves order — sorting again here is belt-and-braces so the table
  // is ordered no matter which path reached it.
  renderInvoiceListTable(sortInvoicesByNumber(filtered));
}

function renderInvoiceListTable(data) {
  const tbody = document.getElementById('invListTableBody');
  const tfoot = document.getElementById('invListTableTotal');
  if (!tbody) return;

  // Kept for the pagination callback, which cannot see local scope.
  invListView = data;

  const start = (invListPage - 1) * INV_LIST_PAGE_SIZE;
  const page  = data.slice(start, start + INV_LIST_PAGE_SIZE);

  if (!data.length) {
    // Naming the filter that emptied the table is more useful than the
    // generic "create one" prompt, which is wrong advice mid-filter.
    const stateName = document.getElementById('invListStateFilter')?.value || '';
    const message = stateName
      ? 'No invoices found for the selected state.'
      : 'No invoices found. Click New Invoice to create one.';
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state"><i class="fas fa-file-invoice table-loading-icon"></i>${message}</td></tr>`;
    if (tfoot) tfoot.innerHTML = '';
    renderInvListPagination(0, 0, () => {});
    return;
  }
  tbody.innerHTML = page.map((r, i) => {
    const balance = round2(Math.max(0, (r.total_amount || 0) - (r.amount_paid || 0)));
    return `
    <tr>
      <td>${start + i + 1}</td>
      <td class="fw-600">${r.invoice_number}</td>
      <td>${formatDate(r.invoice_date)}</td>
      <td>${r.customer_name}</td>
      <td><span class="badge ${r.type === 'b2b' ? 'badge-blue' : 'badge-green'}">${r.type.toUpperCase()}</span></td>
      <td>${stateCellHtml(r.state)}</td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td class="text-right">₹${formatNum(r.amount_paid)}</td>
      <td class="text-right ${balance > 0 ? 'text-danger' : ''}">₹${formatNum(balance)}</td>
      <td>
        <span class="badge ${paymentStatusBadge(r.payment_status)} clickable" onclick="openMarkPaymentModal('${r.type}','${r.id}')" title="Click to record payment">${paymentStatusLabel(r.payment_status)}</span>
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
    </tr>`;
  }).join('');

  const total = data.reduce((s, r) => s + (r.total_amount || 0), 0);
  const totalPaid = data.reduce((s, r) => s + (r.amount_paid || 0), 0);
  const totalBalance = round2(Math.max(0, total - totalPaid));
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="6" class="fw-700">TOTALS (${data.length} invoices)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td class="text-right fw-700">₹${formatNum(totalPaid)}</td><td class="text-right fw-700">₹${formatNum(totalBalance)}</td><td></td><td></td></tr>`;

  // References invListView, not `data`: this function is stringified and
  // re-parsed in global scope, where a closed-over `data` does not exist.
  renderInvListPagination(data.length, invListPage, (p) => { invListPage = p; renderInvoiceListTable(invListView); });
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
    type, customer_name: inv.customer_name, gst_number: inv.gstin, phone: inv.phone, address: inv.address, state: inv.state,
    supply_type: inv.supply_type,
    transport_required: inv.transport_required, vehicle_number: inv.vehicle_number, transporter_name: inv.transporter_name,
    transport_mode: inv.transport_mode, transport_distance_km: inv.transport_distance_km, lr_number: inv.lr_number, lr_date: inv.lr_date,
    transporter_gstin: inv.transporter_gstin, vehicle_type: inv.vehicle_type, dispatch_from: inv.dispatch_from, dispatch_to: inv.dispatch_to,
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
  setInvListValue('mpReference', '');
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
          <span>${formatDate(p.payment_date)} &middot; ${PAYMENT_METHOD_LABELS[p.method] || p.method}${p.reference_number ? ' &middot; Ref: ' + escBinHtml(p.reference_number) : ''}${p.note ? ' &middot; ' + escBinHtml(p.note) : ''}</span>
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
  const referenceNumber = document.getElementById('mpReference')?.value;
  const note = document.getElementById('mpNote')?.value;

  const result = await recordPayment(mpTarget.type, mpTarget.id, user.id, { amount, method, date, referenceNumber, note });
  if (!result.ok) { showToast(result.reason || 'Could not record payment.', 'error'); return; }

  showToast('Payment recorded.', 'success');
  setInvListValue('mpAmount', '');
  setInvListValue('mpReference', '');
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
  const ok = await showConfirm('Permanently delete this invoice? This cannot be undone.');
  if (!ok) return;
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  await cascadeInvoiceItemsDelete(type, id); // items + HSN + stock reversal first
  const { error } = await _supabase.from(table).delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Invoice permanently deleted.', 'success');
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
