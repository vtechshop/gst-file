// =============================================
// Vendor Ledger — per-purchase view of what's owed to each vendor,
// mirrors js/customer-ledger.js exactly, sourced from `purchases`
// instead of b2b_invoices/b2c_invoices. Read-only: payments are
// recorded/removed from Purchase List, this page is purely "what's
// the balance."
// =============================================

let vlAllData = [];
let vlPage = 1;
const VL_PAGE_SIZE = 15;

async function initVendorLedger() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  await loadVendLedgerData(user.id);
  setupVendLedgerSearch();
}

async function loadVendLedgerData(userId) {
  const { data } = await _supabase.from('purchases').select('*').eq('user_id', userId);
  vlAllData = (data || [])
    .map(r => ({
      id: r.id, purchase_number: r.purchase_number, purchase_date: r.purchase_date,
      vendor_name: r.vendor_name, total_amount: +r.total_amount || 0,
      payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
    }))
    .sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  vlPage = 1;
  populateVendLedgerFilter();
  renderVendLedgerTable(vlAllData);
}

function populateVendLedgerFilter() {
  const sel = document.getElementById('vlVendorFilter');
  if (!sel) return;
  const names = [...new Set(vlAllData.map(r => r.vendor_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">All Vendors</option>' + names.map(n => `<option value="${escBinHtml(n)}">${n}</option>`).join('');
}

function setupVendLedgerSearch() {
  document.getElementById('vlSearch')?.addEventListener('input', applyVendLedgerFilters);
}

function applyVendLedgerFilters() {
  const q = document.getElementById('vlSearch')?.value?.toLowerCase() || '';
  const vendor = document.getElementById('vlVendorFilter')?.value || '';

  let filtered = vlAllData;
  if (vendor) filtered = filtered.filter(r => r.vendor_name === vendor);
  if (q) {
    filtered = filtered.filter(r =>
      (r.purchase_number || '').toLowerCase().includes(q) ||
      (r.vendor_name || '').toLowerCase().includes(q));
  }

  vlPage = 1;
  renderVendLedgerTable(filtered);
}

function renderVendLedgerTable(data) {
  const tbody = document.getElementById('vlTableBody');
  const tfoot = document.getElementById('vlTableTotal');
  if (!tbody) return;

  const start = (vlPage - 1) * VL_PAGE_SIZE;
  const page = data.slice(start, start + VL_PAGE_SIZE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fas fa-book table-loading-icon"></i>No purchases found.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderVendLedgerPagination(0, 0, () => {});
    return;
  }

  const paymentBadge = { unpaid: 'badge-red', partial: 'badge-orange', paid: 'badge-green' };
  tbody.innerHTML = page.map((r, i) => {
    const balance = round2(Math.max(0, r.total_amount - r.amount_paid));
    return `
    <tr>
      <td>${start + i + 1}</td>
      <td class="fw-600">${r.purchase_number}</td>
      <td>${formatDate(r.purchase_date)}</td>
      <td>${r.vendor_name}</td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td class="text-right">₹${formatNum(r.amount_paid)}</td>
      <td class="text-right ${balance > 0 ? 'text-danger' : ''}">₹${formatNum(balance)}</td>
      <td><span class="badge ${paymentBadge[r.payment_status] || 'badge-red'}">${r.payment_status.toUpperCase()}</span></td>
    </tr>`;
  }).join('');

  const total = data.reduce((s, r) => s + r.total_amount, 0);
  const totalPaid = data.reduce((s, r) => s + r.amount_paid, 0);
  const totalBalance = round2(Math.max(0, total - totalPaid));
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="4" class="fw-700">TOTALS (${data.length} purchases)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td class="text-right fw-700">₹${formatNum(totalPaid)}</td><td class="text-right fw-700">₹${formatNum(totalBalance)}</td><td></td></tr>`;

  renderVendLedgerPagination(data.length, vlPage, (p) => { vlPage = p; renderVendLedgerTable(data); });
}

function renderVendLedgerPagination(total, current, onChange) {
  const container = document.getElementById('vlPagination');
  if (!container) return;
  const pages = Math.ceil(total / VL_PAGE_SIZE);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="(${onChange.toString()})(${current-1})" ${current===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===current?'active':''}" onclick="(${onChange.toString()})(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="(${onChange.toString()})(${current+1})" ${current===pages?'disabled':''}>&#8250;</button>`;
  container.innerHTML = html;
}

function escBinHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
