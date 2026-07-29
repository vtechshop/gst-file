// =============================================
// Purchase List — read-only view over the `purchases` table (same
// records entered via Purchase Entry), mirroring js/invoice-list.js's
// list/filter/paginate/Edit/Delete/Record-Payment shape. No PDF/Print/
// WhatsApp/Email share (never asked for on the Purchase side), but the
// payment ledger IS shared with Invoice List's — see js/payments.js's
// generalized recordPayment()/deletePayment().
// =============================================

let purchListAllData = [];
let purchListPage = 1;
const PURCH_LIST_PAGE_SIZE = 10;

async function initPurchaseList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populatePurchListFilters();
  setupPurchListSearch();
  await loadPurchaseList(user.id);
}

async function loadPurchaseList(userId) {
  const { data } = await _supabase.from('purchases').select('*').eq('user_id', userId);
  purchListAllData = (data || [])
    .sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  purchListPage = 1;
  renderPurchListTable(purchListAllData);
}

function populatePurchListFilters() {
  const monthSel = document.getElementById('purchListMonthFilter');
  const yearSel  = document.getElementById('purchListYearFilter');
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

function setupPurchListSearch() {
  document.getElementById('purchListSearch')?.addEventListener('input', applyPurchListFilters);
}

function applyPurchListFilters() {
  const q = document.getElementById('purchListSearch')?.value?.toLowerCase() || '';
  const month = document.getElementById('purchListMonthFilter')?.value || '';
  const year  = document.getElementById('purchListYearFilter')?.value || '';

  let filtered = purchListAllData;
  if (q) {
    filtered = filtered.filter(r =>
      (r.purchase_number || '').toLowerCase().includes(q) ||
      (r.vendor_name || '').toLowerCase().includes(q) ||
      (r.vendor_gstin || '').toLowerCase().includes(q));
  }
  if (month) filtered = filtered.filter(r => r.purchase_date && (new Date(r.purchase_date).getMonth() + 1) === +month);
  if (year)  filtered = filtered.filter(r => r.purchase_date && new Date(r.purchase_date).getFullYear() === +year);

  purchListPage = 1;
  renderPurchListTable(filtered);
}

function renderPurchListTable(data) {
  const tbody = document.getElementById('purchListTableBody');
  const tfoot = document.getElementById('purchListTableTotal');
  if (!tbody) return;

  const start = (purchListPage - 1) * PURCH_LIST_PAGE_SIZE;
  const page  = data.slice(start, start + PURCH_LIST_PAGE_SIZE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fas fa-cart-plus table-loading-icon"></i>No purchases found. Click New Purchase to create one.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderPurchListPagination(0, 0, () => {});
    return;
  }

  const paymentBadge = { unpaid: 'badge-red', partial: 'badge-orange', paid: 'badge-green' };
  tbody.innerHTML = page.map((r, i) => {
    const balance = round2(Math.max(0, (+r.total_amount || 0) - (+r.amount_paid || 0)));
    return `
    <tr>
      <td>${start + i + 1}</td>
      <td class="fw-600">${r.purchase_number}</td>
      <td>${formatDate(r.purchase_date)}</td>
      <td>${r.vendor_name}</td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td class="text-right">₹${formatNum(r.amount_paid)}</td>
      <td class="text-right ${balance > 0 ? 'text-danger' : ''}">₹${formatNum(balance)}</td>
      <td><span class="badge ${paymentBadge[r.payment_status] || 'badge-red'} clickable" onclick="openMarkPurchPaymentModal('${r.id}')" title="Click to record payment">${(r.payment_status || 'unpaid').toUpperCase()}</span></td>
      <td>
        <div class="action-btns">
          <a class="btn btn-secondary btn-sm btn-icon" href="purchases.html?id=${r.id}" title="Edit"><i class="fas fa-edit"></i></a>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="deletePurchaseFromList('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const total = data.reduce((s, r) => s + (+r.total_amount || 0), 0);
  const totalPaid = data.reduce((s, r) => s + (+r.amount_paid || 0), 0);
  const totalBalance = round2(Math.max(0, total - totalPaid));
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="4" class="fw-700">TOTALS (${data.length} purchases)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td class="text-right fw-700">₹${formatNum(totalPaid)}</td><td class="text-right fw-700">₹${formatNum(totalBalance)}</td><td></td><td></td></tr>`;

  renderPurchListPagination(data.length, purchListPage, (p) => { purchListPage = p; renderPurchListTable(data); });
}

// ── Payment: Record Payment + Payment History ──────
// Mirrors js/invoice-list.js's openMarkPaymentModal/refreshPaymentModal/
// submitReceivePayment/removePayment exactly, calling the same
// (now purchase-aware) js/payments.js helpers with type='purchase'.
let mppTarget = null; // purchase id

async function openMarkPurchPaymentModal(id) {
  const rec = purchListAllData.find(r => r.id === id);
  if (!rec) return;
  mppTarget = id;
  document.getElementById('mppPurchaseLabel').textContent = rec.purchase_number;
  setPurchListValue('mppAmount', '');
  setPurchListValue('mppMethod', 'cash');
  setPurchListValue('mppDate', toISO(new Date()));
  setPurchListValue('mppReference', '');
  setPurchListValue('mppNote', '');
  document.getElementById('markPurchPaymentModal')?.classList.add('open');
  await refreshPurchPaymentModal();
}

function closeMarkPurchPaymentModal() {
  document.getElementById('markPurchPaymentModal')?.classList.remove('open');
  mppTarget = null;
}

function setPurchListValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

async function refreshPurchPaymentModal() {
  if (!mppTarget) return;
  const rec = purchListAllData.find(r => r.id === mppTarget);
  if (!rec) return;

  const history = await loadPaymentsForInvoice('purchase', mppTarget);
  const paidSoFar = round2(history.reduce((s, p) => s + (+p.amount || 0), 0));
  const outstanding = round2(Math.max(0, (+rec.total_amount || 0) - paidSoFar));

  document.getElementById('mppPurchaseTotal').textContent = '₹' + formatNum(rec.total_amount);
  document.getElementById('mppPaidSoFar').textContent = '₹' + formatNum(paidSoFar);
  document.getElementById('mppOutstanding').textContent = '₹' + formatNum(outstanding);

  const listEl = document.getElementById('mppHistoryList');
  if (listEl) {
    listEl.innerHTML = history.length
      ? history.map(p => `
        <div class="mini-list-row">
          <span>${formatDate(p.payment_date)} &middot; ${PAYMENT_METHOD_LABELS[p.method] || p.method}${p.reference_number ? ' &middot; Ref: ' + escBinHtml(p.reference_number) : ''}${p.note ? ' &middot; ' + escBinHtml(p.note) : ''}</span>
          <span class="d-flex align-center gap-10">
            <b>₹${formatNum(p.amount)}</b>
            <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="removePurchPayment('${p.id}')" title="Remove this payment"><i class="fas fa-times"></i></button>
          </span>
        </div>`).join('')
      : '<p class="text-muted-sm">No payments recorded yet.</p>';
  }
}

function escBinHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

async function submitPurchPayment() {
  if (!mppTarget) return;
  const user = await getCurrentUser();
  if (!user) return;
  const amount = parseFloat(document.getElementById('mppAmount')?.value);
  const method = document.getElementById('mppMethod')?.value;
  const date = document.getElementById('mppDate')?.value;
  const referenceNumber = document.getElementById('mppReference')?.value;
  const note = document.getElementById('mppNote')?.value;

  const result = await recordPayment('purchase', mppTarget, user.id, { amount, method, date, referenceNumber, note });
  if (!result.ok) { showToast(result.reason || 'Could not record payment.', 'error'); return; }

  showToast('Payment recorded.', 'success');
  setPurchListValue('mppAmount', '');
  setPurchListValue('mppReference', '');
  setPurchListValue('mppNote', '');
  await loadPurchaseList(user.id);
  await refreshPurchPaymentModal();
}

async function removePurchPayment(paymentId) {
  if (!mppTarget) return;
  const user = await getCurrentUser();
  if (!user) return;
  const ok = await showConfirm('Remove this payment record? The purchase balance will be recalculated.');
  if (!ok) return;
  const result = await deletePayment(paymentId, 'purchase', mppTarget, user.id);
  if (!result.ok) { showToast(result.reason || 'Could not remove payment.', 'error'); return; }
  showToast('Payment removed.', 'success');
  await loadPurchaseList(user.id);
  await refreshPurchPaymentModal();
}

async function deletePurchaseFromList(id) {
  const ok = await showConfirm('Permanently delete this purchase? Stock added by it will be reversed. This cannot be undone.');
  if (!ok) return;
  await cascadePurchaseItemsDelete('purchase', id); // items + stock reversal first
  const { error } = await _supabase.from('purchases').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Purchase permanently deleted.', 'success');
  const user = await getCurrentUser();
  if (user) await loadPurchaseList(user.id);
}

function renderPurchListPagination(total, current, onChange) {
  const container = document.getElementById('purchListPagination');
  if (!container) return;
  const pages = Math.ceil(total / PURCH_LIST_PAGE_SIZE);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="(${onChange.toString()})(${current-1})" ${current===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===current?'active':''}" onclick="(${onChange.toString()})(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="(${onChange.toString()})(${current+1})" ${current===pages?'disabled':''}>&#8250;</button>`;
  container.innerHTML = html;
}
