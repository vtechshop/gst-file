// =============================================
// Sales Return — combined entry + history page, same shape as
// js/purchase-returns.js (form + paginated history table with totals
// footer), but the entry portion always starts from an existing B2B/B2C
// invoice rather than free product entry: selecting an invoice loads
// its own line items into js/sales-return-items.js, capped per-product
// at whatever hasn't already been returned against that same invoice,
// so both partial and full returns — and returns entered across
// multiple separate visits — stay honest about what's actually left to
// return. b2b_invoices/b2c_invoices themselves are read-only here,
// never written to.
// =============================================

let srUserId = null;
let srEditId = null;
let srAllData = [];
let srPage = 1;
const SR_PAGE = 10;
let srAllInvoices = [];
let srSelectedInvoice = null; // { type, id, invoice_number, customer_name, gst_number, phone, address, state, supply_type }

async function initSalesReturns() {
  const user = await requireAuth();
  if (!user) return;
  srUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  initSalesReturnItems();
  await loadSrInvoicesList(user.id);
  setSrValue('srDate', toISO(new Date()));
  setupSrSearch();
  await loadSalesReturns(user.id);
}

function setSrValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }
function getSrText(id) { return document.getElementById(id)?.value?.trim() || ''; }

// ── Invoice selection ────────────────────────────────
async function loadSrInvoicesList(userId) {
  const [{ data: b2b }, { data: b2c }] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId)
  ]);
  const b2bRows = (b2b || []).map(r => ({
    type: 'b2b', id: r.id, invoice_number: r.invoice_number, customer_name: r.customer_name,
    gst_number: r.gst_number, phone: r.phone, address: r.address, state: r.state,
    supply_type: r.supply_type, invoice_date: r.invoice_date
  }));
  const b2cRows = (b2c || []).map(r => ({
    type: 'b2c', id: r.id, invoice_number: r.invoice_number || ('B2C-' + r.id.slice(0, 8).toUpperCase()),
    customer_name: r.customer_name || 'Walk-in Customer (B2C)', gst_number: r.gst_number,
    phone: r.phone, address: r.address, state: r.state, supply_type: r.supply_type, invoice_date: r.invoice_date
  }));
  srAllInvoices = [...b2bRows, ...b2cRows].sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  const dl = document.getElementById('srInvoiceDatalist');
  if (dl) {
    dl.innerHTML = srAllInvoices.map(r =>
      `<option value="${escItemHtml(r.invoice_number)}">${escItemHtml(r.customer_name)}</option>`
    ).join('');
  }
}

async function onSrInvoiceInput() {
  const num = getSrText('srInvoiceSearch');
  const match = srAllInvoices.find(r => r.invoice_number.toLowerCase() === num.toLowerCase());
  if (!match) { srSelectedInvoice = null; return; }
  await selectSrInvoice(match);
}

async function selectSrInvoice(match) {
  srSelectedInvoice = match;
  setSrValue('srCustName', match.customer_name);
  setSrValue('srCustGstin', match.gst_number || '');
  setSrValue('srPhone', match.phone || '');
  setSrValue('srAddress', match.address || '');
  setSrValue('srState', match.state || '');
  document.getElementById('srInvoiceDetailsBox')?.classList.remove('d-none');
  const supplyEl = document.getElementById('srSupply');
  if (supplyEl) supplyEl.value = match.supply_type || 'intrastate';
  const badge = document.getElementById('srSupplyBadge');
  if (badge) {
    badge.textContent = match.supply_type === 'interstate' ? 'Interstate' : 'Intrastate';
    badge.className = 'badge ' + (match.supply_type === 'interstate' ? 'badge-blue' : 'badge-green');
  }

  const { data: items } = await _supabase.from('invoice_items').select('*').eq('invoice_id', match.id).eq('invoice_type', match.type);
  const activeItems = (items || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const alreadyReturned = await computeAlreadyReturnedByProduct(match.id, match.type, srEditId);
  loadOriginalInvoiceItems(activeItems, alreadyReturned);

  if (srEditId) {
    const { data: savedItems } = await _supabase.from('sales_return_items').select('*').eq('return_id', srEditId);
    prefillSrReturnQuantities((savedItems || []));
  }
}

// Sums quantity already returned per product across every OTHER active
// sales return against this same invoice (excludeReturnId lets Edit
// mode not double-count the return being edited against itself).
async function computeAlreadyReturnedByProduct(invoiceId, invoiceType, excludeReturnId) {
  const { data: returns } = await _supabase.from('sales_returns').select('*')
    .eq('user_id', srUserId).eq('original_invoice_id', invoiceId).eq('original_invoice_type', invoiceType);
  const activeReturnIds = (returns || [])
    .filter(r => r.id !== excludeReturnId)
    .map(r => r.id);
  if (!activeReturnIds.length) return {};

  const { data: allItems } = await _supabase.from('sales_return_items').select('*').eq('user_id', srUserId);
  const byProduct = {};
  (allItems || []).forEach(it => {
    if (!it.product_id || !activeReturnIds.includes(it.return_id)) return;
    byProduct[it.product_id] = (byProduct[it.product_id] || 0) + (+it.quantity || 0);
  });
  return byProduct;
}

// ── Save ─────────────────────────────────────────────
async function saveSalesReturn() {
  const user = await getCurrentUser();
  if (!user) return;

  if (!srSelectedInvoice) { showToast('Select the original invoice first.', 'error'); return; }
  const returnNum = getSrText('srNum');
  const returnDate = getSrText('srDate');
  if (!returnNum)  { showToast('Please enter a return number.', 'error'); return; }
  if (!returnDate) { showToast('Please enter the return date.', 'error'); return; }

  if (!srEditId) {
    const { data: dup } = await _supabase.from('sales_returns').select('id').eq('user_id', user.id).eq('return_number', returnNum).single();
    if (dup?.id) { showToast('Return number already exists!', 'error'); return; }
  }

  const headerBase = {
    user_id: user.id,
    original_invoice_id: srSelectedInvoice.id,
    original_invoice_type: srSelectedInvoice.type,
    original_invoice_number: srSelectedInvoice.invoice_number,
    customer_name: srSelectedInvoice.customer_name,
    customer_gstin: srSelectedInvoice.gst_number || null,
    phone: srSelectedInvoice.phone || '',
    address: srSelectedInvoice.address || '',
    state: srSelectedInvoice.state || '',
    return_number: returnNum, return_date: returnDate,
    supply_type: document.getElementById('srSupply')?.value || 'intrastate',
    reason: getSrText('srReason') || null
  };

  const wasNew = !srEditId;
  const id = await saveSalesReturnWithItems(headerBase, srEditId);
  if (!id) return;

  showToast(wasNew ? 'Sales return saved successfully!' : 'Sales return updated successfully!');
  resetSalesReturn();
  await loadSalesReturns(user.id);
}

function resetSalesReturn() {
  ['srInvoiceSearch','srCustName','srCustGstin','srPhone','srAddress','srState','srNum','srReason'].forEach(id => setSrValue(id, ''));
  setSrValue('srDate', toISO(new Date()));
  srSelectedInvoice = null;
  srEditId = null;
  document.getElementById('srInvoiceDetailsBox')?.classList.add('d-none');
  resetSalesReturnItems();
  document.getElementById('srFormTitle').textContent = 'New Sales Return';
  document.getElementById('srSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Return';
}

// ── History list ──────────────────────────────────────
async function loadSalesReturns(userId) {
  const { data } = await _supabase.from('sales_returns').select('*').eq('user_id', userId).order('return_date', { ascending: false });
  srAllData = (data || []);
  srPage = 1;
  renderSrTable(srAllData);
}

function renderSrTable(data) {
  const tbody = document.getElementById('srTableBody');
  const tfoot = document.getElementById('srTableTotal');
  if (!tbody) return;

  const start = (srPage - 1) * SR_PAGE;
  const page  = data.slice(start, start + SR_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-rotate-left" style="display:block;font-size:40px;margin-bottom:10px;"></i>No sales returns found</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderSrPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td><b>${r.return_number}</b></td>
      <td>${formatDate(r.return_date)}</td>
      <td>${r.customer_name}</td>
      <td>${r.original_invoice_number || '&mdash;'} <span class="badge ${r.original_invoice_type === 'b2b' ? 'badge-blue' : 'badge-green'}" style="font-size:9px;">${r.original_invoice_type.toUpperCase()}</span></td>
      <td class="text-right fw-700">&#8377;${formatNum(r.total_amount)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editSalesReturn('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="downloadSalesReturnPDF('${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn btn-secondary btn-sm btn-icon" onclick="printSalesReturn('${r.id}')" title="Print"><i class="fas fa-print"></i></button>
          <button class="btn btn-success btn-sm btn-icon" onclick="shareSalesReturnWhatsApp('${r.id}')" title="Share via WhatsApp"><i class="fab fa-whatsapp"></i></button>
          <button class="btn btn-info btn-sm btn-icon btn-info-alt" onclick="emailSalesReturnPDF('${r.id}')" title="Email PDF"><i class="fas fa-envelope"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteSalesReturn('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const total = data.reduce((s, r) => s + (+r.total_amount || 0), 0);
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="5" class="fw-700">TOTALS (${data.length} returns)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td></td></tr>`;

  renderSrPagination(data.length);
}

function renderSrPagination(total) {
  const c = document.getElementById('srPagination');
  if (!c) return;
  const pages = Math.ceil(total / SR_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="srPage=${srPage-1};renderSrTable(srAllData)" ${srPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===srPage?'active':''}" onclick="srPage=${i};renderSrTable(srAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="srPage=${srPage+1};renderSrTable(srAllData)" ${srPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

async function editSalesReturn(id) {
  const { data: rec } = await _supabase.from('sales_returns').select('*').eq('id', id).single();
  if (!rec) return;

  srEditId = id;
  setSrValue('srNum', rec.return_number || '');
  setSrValue('srDate', rec.return_date || '');
  setSrValue('srReason', rec.reason || '');

  const invoiceMatch = srAllInvoices.find(inv => inv.id === rec.original_invoice_id && inv.type === rec.original_invoice_type) || {
    type: rec.original_invoice_type, id: rec.original_invoice_id, invoice_number: rec.original_invoice_number,
    customer_name: rec.customer_name, gst_number: rec.customer_gstin, phone: rec.phone, address: rec.address,
    state: rec.state, supply_type: rec.supply_type
  };
  setSrValue('srInvoiceSearch', invoiceMatch.invoice_number);
  await selectSrInvoice(invoiceMatch);

  document.getElementById('srFormTitle').textContent = 'Edit Sales Return';
  document.getElementById('srSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Return';
  document.getElementById('srInvoiceSearch')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteSalesReturn(id) {
  const ok = await showConfirm('Permanently delete this sales return? Stock added by it will be reversed. This cannot be undone.');
  if (!ok) return;
  await cascadeSalesReturnItemsDelete(id); // items + stock reversal first
  const { error } = await _supabase.from('sales_returns').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Sales return permanently deleted.', 'success');
  const user = await getCurrentUser();
  if (user) await loadSalesReturns(user.id);
}

function setupSrSearch() {
  document.getElementById('srHistorySearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? srAllData.filter(r =>
      r.return_number.toLowerCase().includes(q) ||
      r.customer_name.toLowerCase().includes(q) ||
      (r.original_invoice_number || '').toLowerCase().includes(q)
    ) : srAllData;
    srPage = 1;
    renderSrTable(filtered);
  });
}
