// =============================================
// Global Search — searches invoices, customers,
// products and HSN entries across the whole app.
// Results navigate to the relevant page with ?q=
// which the destination page's own local search
// picks up via applyIncomingSearchQuery().
// =============================================

function openGlobalSearch() {
  const overlay = document.getElementById('globalSearchModal');
  if (!overlay) return;
  overlay.classList.add('open');
  const input = document.getElementById('globalSearchInput');
  if (input) { input.value = ''; input.focus(); }
  const results = document.getElementById('globalSearchResults');
  if (results) results.innerHTML = '<p class="text-muted-sm">Type at least 2 characters&hellip;</p>';
}

function closeGlobalSearch() {
  document.getElementById('globalSearchModal')?.classList.remove('open');
}

let globalSearchTimer = null;
function onGlobalSearchInput(value) {
  clearTimeout(globalSearchTimer);
  const q = value.trim();
  if (q.length < 2) {
    const results = document.getElementById('globalSearchResults');
    if (results) results.innerHTML = '<p class="text-muted-sm">Type at least 2 characters&hellip;</p>';
    return;
  }
  globalSearchTimer = setTimeout(() => runGlobalSearch(q), 250);
}

async function runGlobalSearch(q) {
  const results = document.getElementById('globalSearchResults');
  if (!results) return;
  results.innerHTML = '<p class="text-muted-sm"><i class="fas fa-spinner fa-spin"></i> Searching...</p>';

  const user = await getCurrentUser();
  if (!user) return;
  const needle = q.toLowerCase();

  const [b2b, b2c, customers, products, b2bHsn, b2cHsn, cdn, vendors, purchases, purchReturns, expenses, salesReturns] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', user.id),
    _supabase.from('b2c_invoices').select('*').eq('user_id', user.id),
    _supabase.from('customers').select('*').eq('user_id', user.id),
    _supabase.from('products').select('*').eq('user_id', user.id),
    _supabase.from('b2b_hsn').select('*').eq('user_id', user.id),
    _supabase.from('b2c_hsn').select('*').eq('user_id', user.id),
    _supabase.from('cdn_notes').select('*').eq('user_id', user.id),
    _supabase.from('vendors').select('*').eq('user_id', user.id),
    _supabase.from('purchases').select('*').eq('user_id', user.id),
    _supabase.from('purchase_returns').select('*').eq('user_id', user.id),
    _supabase.from('expenses').select('*').eq('user_id', user.id),
    _supabase.from('sales_returns').select('*').eq('user_id', user.id)
  ]);

  const groups = [];

  const b2bMatches = (b2b.data || []).filter(r => !r.is_deleted &&
    (r.gst_number?.toLowerCase().includes(needle) ||
    r.customer_name?.toLowerCase().includes(needle) ||
    r.invoice_number?.toLowerCase().includes(needle))).slice(0, 5);
  if (b2bMatches.length) groups.push({ label: 'B2B Invoices', icon: 'fa-file-alt', page: 'invoice-list.html', items: b2bMatches.map(r => `${r.invoice_number} &mdash; ${r.customer_name} (${r.gst_number})`) });

  const b2cMatches = (b2c.data || []).filter(r => !r.is_deleted &&
    (r.state?.toLowerCase().includes(needle) ||
    r.customer_name?.toLowerCase().includes(needle) ||
    r.invoice_number?.toLowerCase().includes(needle))).slice(0, 5);
  if (b2cMatches.length) groups.push({ label: 'B2C Invoices', icon: 'fa-users', page: 'invoice-list.html', items: b2cMatches.map(r => `${r.invoice_number || r.state} &mdash; &#8377;${formatNum(r.total_amount)} (${formatDate(r.invoice_date)})`) });

  const custMatches = (customers.data || []).filter(r => !r.is_deleted &&
    (r.name?.toLowerCase().includes(needle) || (r.gstin || '').toLowerCase().includes(needle))).slice(0, 5);
  if (custMatches.length) groups.push({ label: 'Customers', icon: 'fa-address-book', page: 'customers.html', items: custMatches.map(r => `${r.name}${r.gstin ? ' (' + r.gstin + ')' : ''}`) });

  const prodMatches = (products.data || []).filter(r => !r.is_deleted &&
    (r.name?.toLowerCase().includes(needle) || (r.hsn_code || '').toLowerCase().includes(needle))).slice(0, 5);
  if (prodMatches.length) groups.push({ label: 'Products', icon: 'fa-box', page: 'products.html', items: prodMatches.map(r => `${r.name}${r.hsn_code ? ' (HSN ' + r.hsn_code + ')' : ''}`) });

  const hsnMatches = [...(b2bHsn.data || []), ...(b2cHsn.data || [])].filter(r => !r.is_deleted &&
    (r.hsn_code?.toLowerCase().includes(needle) || r.product_name?.toLowerCase().includes(needle))).slice(0, 5);
  if (hsnMatches.length) groups.push({ label: 'HSN Summary', icon: 'fa-barcode', page: 'hsn.html', items: hsnMatches.map(r => `${r.hsn_code} &mdash; ${r.product_name}`) });

  const cdnMatches = (cdn.data || []).filter(r => !r.is_deleted &&
    (r.note_number?.toLowerCase().includes(needle) ||
    r.customer_name?.toLowerCase().includes(needle) ||
    r.original_invoice?.toLowerCase().includes(needle))).slice(0, 5);
  if (cdnMatches.length) groups.push({ label: 'Credit/Debit Notes', icon: 'fa-file-minus', page: 'cdnotes.html', items: cdnMatches.map(r => `${r.note_number} &mdash; ${r.customer_name}`) });

  const vendorMatches = (vendors.data || []).filter(r => !r.is_deleted &&
    (r.name?.toLowerCase().includes(needle) || (r.gstin || '').toLowerCase().includes(needle))).slice(0, 5);
  if (vendorMatches.length) groups.push({ label: 'Vendors', icon: 'fa-truck', page: 'vendors.html', items: vendorMatches.map(r => `${r.name}${r.gstin ? ' (' + r.gstin + ')' : ''}`) });

  const purchMatches = (purchases.data || []).filter(r => !r.is_deleted &&
    (r.purchase_number?.toLowerCase().includes(needle) ||
    r.vendor_name?.toLowerCase().includes(needle) ||
    (r.vendor_gstin || '').toLowerCase().includes(needle))).slice(0, 5);
  if (purchMatches.length) groups.push({ label: 'Purchases', icon: 'fa-cart-plus', page: 'purchase-list.html', items: purchMatches.map(r => `${r.purchase_number} &mdash; ${r.vendor_name} (&#8377;${formatNum(r.total_amount)})`) });

  const purchRetMatches = (purchReturns.data || []).filter(r => !r.is_deleted &&
    (r.return_number?.toLowerCase().includes(needle) ||
    r.vendor_name?.toLowerCase().includes(needle) ||
    (r.original_purchase_number || '').toLowerCase().includes(needle))).slice(0, 5);
  if (purchRetMatches.length) groups.push({ label: 'Purchase Returns', icon: 'fa-undo', page: 'purchase-returns.html', items: purchRetMatches.map(r => `${r.return_number} &mdash; ${r.vendor_name}`) });

  const expMatches = (expenses.data || []).filter(r => !r.is_deleted &&
    ((r.category_name || '').toLowerCase().includes(needle) ||
    (r.payee || '').toLowerCase().includes(needle) ||
    (r.description || '').toLowerCase().includes(needle))).slice(0, 5);
  if (expMatches.length) groups.push({ label: 'Expenses', icon: 'fa-receipt', page: 'expenses.html', items: expMatches.map(r => `${r.category_name || 'Expense'} &mdash; &#8377;${formatNum(r.amount)}${r.payee ? ' (' + r.payee + ')' : ''}`) });

  const srMatches = (salesReturns.data || []).filter(r => !r.is_deleted &&
    (r.return_number?.toLowerCase().includes(needle) ||
    r.customer_name?.toLowerCase().includes(needle) ||
    (r.original_invoice_number || '').toLowerCase().includes(needle))).slice(0, 5);
  if (srMatches.length) groups.push({ label: 'Sales Returns', icon: 'fa-rotate-left', page: 'sales-returns.html', items: srMatches.map(r => `${r.return_number} &mdash; ${r.customer_name}`) });

  if (!groups.length) {
    results.innerHTML = `<p class="text-muted-sm">No matches for "${q}".</p>`;
    return;
  }

  results.innerHTML = groups.map(g => `
    <div class="section-title mb-8"><i class="fas ${g.icon}"></i> ${g.label}</div>
    <div class="mb-16">
      ${g.items.map(text => `<div class="mini-list-row cursor-pointer" onclick="goToSearchResult('${g.page}','${q.replace(/'/g, "\\'")}')">${text}</div>`).join('')}
    </div>`).join('');
}

function goToSearchResult(page, q) {
  window.location.href = `${page}?q=${encodeURIComponent(q)}`;
}

// Called by each page's init function so a global-search click lands
// with the term already applied to that page's own local search box.
function applyIncomingSearchQuery(inputId) {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  if (!q) return;
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = q;
  input.dispatchEvent(new Event('input'));
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape') closeGlobalSearch();
});
