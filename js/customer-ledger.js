// =============================================
// Customer Ledger — per-invoice view of what's owed by each customer,
// across both b2b_invoices and b2c_invoices (same union js/invoice-
// list.js already builds). Read-only: payments are recorded/removed
// from Invoice List, this page is purely "what's the balance."
// =============================================

let clAllData = [];
let clPage = 1;
const CL_PAGE_SIZE = 15;

async function initCustomerLedger() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  await loadCustLedgerData(user.id);
  setupCustLedgerSearch();
}

async function loadCustLedgerData(userId) {
  const [{ data: b2b }, { data: b2c }] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId)
  ]);

  const b2bRows = (b2b || []).map(r => ({
    type: 'b2b', id: r.id, invoice_number: r.invoice_number, invoice_date: r.invoice_date,
    customer_name: r.customer_name, total_amount: +r.total_amount || 0,
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));
  const b2cRows = (b2c || []).map(r => ({
    type: 'b2c', id: r.id, invoice_number: r.invoice_number || ('B2C-' + r.id.slice(0, 8).toUpperCase()), invoice_date: r.invoice_date,
    customer_name: r.customer_name || 'Walk-in Customer (B2C)', total_amount: +r.total_amount || 0,
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));

  clAllData = [...b2bRows, ...b2cRows].sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  clPage = 1;
  populateCustLedgerFilter();
  renderCustLedgerTable(clAllData);
}

function populateCustLedgerFilter() {
  const sel = document.getElementById('clCustomerFilter');
  if (!sel) return;
  const names = [...new Set(clAllData.map(r => r.customer_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">All Customers</option>' + names.map(n => `<option value="${escBinHtml(n)}">${n}</option>`).join('');
}

function setupCustLedgerSearch() {
  document.getElementById('clSearch')?.addEventListener('input', applyCustLedgerFilters);
}

function applyCustLedgerFilters() {
  const q = document.getElementById('clSearch')?.value?.toLowerCase() || '';
  const customer = document.getElementById('clCustomerFilter')?.value || '';

  let filtered = clAllData;
  if (customer) filtered = filtered.filter(r => r.customer_name === customer);
  if (q) {
    filtered = filtered.filter(r =>
      (r.invoice_number || '').toLowerCase().includes(q) ||
      (r.customer_name || '').toLowerCase().includes(q));
  }

  clPage = 1;
  renderCustLedgerTable(filtered);
}

function renderCustLedgerTable(data) {
  const tbody = document.getElementById('clTableBody');
  const tfoot = document.getElementById('clTableTotal');
  if (!tbody) return;

  const start = (clPage - 1) * CL_PAGE_SIZE;
  const page = data.slice(start, start + CL_PAGE_SIZE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fas fa-book table-loading-icon"></i>No invoices found.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderCustLedgerPagination(0, 0, () => {});
    return;
  }
  tbody.innerHTML = page.map((r, i) => {
    const balance = round2(Math.max(0, r.total_amount - r.amount_paid));
    return `
    <tr>
      <td>${start + i + 1}</td>
      <td class="fw-600">${r.invoice_number}</td>
      <td>${formatDate(r.invoice_date)}</td>
      <td>${r.customer_name}</td>
      <td><span class="badge ${r.type === 'b2b' ? 'badge-blue' : 'badge-green'}">${r.type.toUpperCase()}</span></td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td class="text-right">₹${formatNum(r.amount_paid)}</td>
      <td class="text-right ${balance > 0 ? 'text-danger' : ''}">₹${formatNum(balance)}</td>
      <td><span class="badge ${paymentStatusBadge(r.payment_status)}">${paymentStatusLabel(r.payment_status)}</span></td>
    </tr>`;
  }).join('');

  const total = data.reduce((s, r) => s + r.total_amount, 0);
  const totalPaid = data.reduce((s, r) => s + r.amount_paid, 0);
  const totalBalance = round2(Math.max(0, total - totalPaid));
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="5" class="fw-700">TOTALS (${data.length} invoices)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td class="text-right fw-700">₹${formatNum(totalPaid)}</td><td class="text-right fw-700">₹${formatNum(totalBalance)}</td><td></td></tr>`;

  renderCustLedgerPagination(data.length, clPage, (p) => { clPage = p; renderCustLedgerTable(data); });
}

function renderCustLedgerPagination(total, current, onChange) {
  const container = document.getElementById('clPagination');
  if (!container) return;
  const pages = Math.ceil(total / CL_PAGE_SIZE);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="(${onChange.toString()})(${current-1})" ${current===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===current?'active':''}" onclick="(${onChange.toString()})(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="(${onChange.toString()})(${current+1})" ${current===pages?'disabled':''}>&#8250;</button>`;
  container.innerHTML = html;
}

function escBinHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
