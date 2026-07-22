// =============================================
// Reports Logic
// =============================================
let repB2B = [], repB2C = [], repB2BHSN = [], repB2CHSN = [];
let repItemsByInvoice = {};
let repPurchases = [], repPurchaseItems = [];
let repExpenses = [], repExpensesAllTime = [];
let repSalesReturns = [], repSalesReturnItems = [];
let currentUser = null;

async function initReports() {
  currentUser = await requireAuth();
  if (!currentUser) return;
  initNavUser(currentUser);
  setupLogoutBtn();
  loadUserProfile(currentUser.id);
  setupMobileMenu();
  populateMonthFilter();
  await loadReports('current');
}

function populateMonthFilter() {
  const sel = document.getElementById('reportMonth');
  if (!sel) return;
  sel.innerHTML = '<option value="current">Current Month</option><option value="fy">Financial Year</option>'
    + '<option value="q1">Q1 (Apr-Jun)</option><option value="q2">Q2 (Jul-Sep)</option>'
    + '<option value="q3">Q3 (Oct-Dec)</option><option value="q4">Q4 (Jan-Mar)</option>';
  monthYearOptions().forEach(o => {
    sel.innerHTML += `<option value="${o.value}">${o.label}</option>`;
  });
}

async function loadReports(filter) {
  showRepLoader(true);
  const { start, end } = getReportDateRange(filter);

  const [b2bRes, b2cRes, hsnB2BRes, hsnB2CRes, itemsRes, purchRes, purchItemsRes, expRes, expAllRes, srRes, srItemsRes] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', currentUser.id).gte('invoice_date', start).lte('invoice_date', end).order('invoice_date', { ascending: false }),
    _supabase.from('b2c_invoices').select('*').eq('user_id', currentUser.id).gte('invoice_date', start).lte('invoice_date', end).order('invoice_date', { ascending: false }),
    _supabase.from('b2b_hsn').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }),
    _supabase.from('b2c_hsn').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }),
    _supabase.from('invoice_items').select('*').eq('user_id', currentUser.id),
    _supabase.from('purchases').select('*').eq('user_id', currentUser.id).gte('purchase_date', start).lte('purchase_date', end).order('purchase_date', { ascending: false }),
    _supabase.from('purchase_items').select('*').eq('user_id', currentUser.id),
    _supabase.from('expenses').select('*').eq('user_id', currentUser.id).gte('expense_date', start).lte('expense_date', end).order('expense_date', { ascending: false }),
    _supabase.from('expenses').select('*').eq('user_id', currentUser.id),
    _supabase.from('sales_returns').select('*').eq('user_id', currentUser.id).gte('return_date', start).lte('return_date', end).order('return_date', { ascending: false }),
    _supabase.from('sales_return_items').select('*').eq('user_id', currentUser.id)
  ]);

  repB2B = (b2bRes.data || []);
  repB2C = (b2cRes.data || []);

  // HSN/Product reports are driven by invoice line items now — the
  // invoice is the only source of truth. 'source' !== 'auto' historical
  // rows (manual entries / Excel imports from before this was a live
  // report) are kept alongside so no past data disappears.
  const allItems = (itemsRes.data || []);
  const toHSNRow = it => ({
    hsn_code: it.hsn_code, product_name: it.product_name, type: 'goods',
    quantity: it.quantity, taxable_value: +it.taxable_value, gst_percentage: it.gst_percentage,
    igst: +it.igst, cgst: +it.cgst, sgst: +it.sgst, total_gst: +it.gst_amount, total_invoice_value: +it.total_amount
  });
  const legacyB2BHSN = (hsnB2BRes.data || []).filter(r => r.source !== 'auto');
  const legacyB2CHSN = (hsnB2CRes.data || []).filter(r => r.source !== 'auto');
  repB2BHSN = [...allItems.filter(it => it.invoice_type === 'b2b' && it.hsn_code).map(toHSNRow), ...legacyB2BHSN];
  repB2CHSN = [...allItems.filter(it => it.invoice_type === 'b2c' && it.hsn_code).map(toHSNRow), ...legacyB2CHSN];

  repItemsByInvoice = {};
  allItems.forEach(r => {
    const key = r.invoice_type + ':' + r.invoice_id;
    (repItemsByInvoice[key] = repItemsByInvoice[key] || []).push(r);
  });

  repPurchases = (purchRes.data || []);
  repPurchaseItems = (purchItemsRes.data || []);
  repExpenses = (expRes.data || []);
  repExpensesAllTime = (expAllRes.data || []);
  repSalesReturns = (srRes.data || []);
  repSalesReturnItems = (srItemsRes.data || []);

  renderSummaryCards();
  renderGSTR1Summary();
  renderMonthlyTable();
  renderHSNReport();
  renderCustomerWiseReport();
  renderProductWiseReport();
  renderVendorWiseReport();
  renderPurchProductWiseReport();
  renderSrCustomerWiseReport();
  renderSrProductWiseReport();
  renderExpenseByCategoryReport();
  renderExpenseByMonthReport();
  renderHSNWiseSummary();
  renderGSTRateWiseReport();
  showRepLoader(false);
}

// ── Customer-wise (Sales Returns) ───────────────────────────
function renderSrCustomerWiseReport() {
  const tbody = document.getElementById('srCustomerWiseBody');
  if (!tbody) return;
  const byCustomer = {};
  repSalesReturns.forEach(r => {
    const key = r.customer_name;
    if (!byCustomer[key]) byCustomer[key] = { name: key, gstin: r.customer_gstin || '', count: 0, taxable: 0, gst: 0, total: 0 };
    byCustomer[key].count++;
    byCustomer[key].taxable += +r.taxable_amount;
    byCustomer[key].gst += +r.gst_amount;
    byCustomer[key].total += +r.total_amount;
  });
  const rows = Object.values(byCustomer).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td>${r.gstin || '&mdash;'}</td><td class="text-center">${r.count}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No sales return data for this period</td></tr>';
}

// ── Product-wise (Sales Returns, from sales_return_items, all-time) ──
function renderSrProductWiseReport() {
  const tbody = document.getElementById('srProductWiseBody');
  if (!tbody) return;
  const byProduct = {};
  repSalesReturnItems.forEach(r => {
    const key = r.product_name;
    if (!byProduct[key]) byProduct[key] = { name: key, hsn: r.hsn_code || '', qty: 0, taxable: 0, gst: 0, total: 0 };
    byProduct[key].qty += +r.quantity || 0;
    byProduct[key].taxable += +r.taxable_value;
    byProduct[key].gst += +r.gst_amount;
    byProduct[key].total += +r.total_amount;
  });
  const rows = Object.values(byProduct).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td>${r.hsn || '&mdash;'}</td><td class="text-center">${r.qty || '&mdash;'}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No sales return line items yet</td></tr>';
}

// ── Expense Report — by Category (respects the selected period) ──
function renderExpenseByCategoryReport() {
  const tbody = document.getElementById('expByCategoryBody');
  if (!tbody) return;
  const byCategory = {};
  repExpenses.forEach(r => {
    const key = r.category_name || 'Uncategorized';
    if (!byCategory[key]) byCategory[key] = { name: key, count: 0, total: 0 };
    byCategory[key].count++;
    byCategory[key].total += +r.amount || 0;
  });
  const rows = Object.values(byCategory).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td class="text-center">${r.count}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty-state">No expenses for this period</td></tr>';
}

// ── Expense Report — by Month (trailing 12 months, all-time —
// same independent-of-period-filter shape as renderMonthlyTable()) ──
function renderExpenseByMonthReport() {
  const tbody = document.getElementById('expByMonthBody');
  if (!tbody) return;
  const months = monthYearOptions().slice(0, 12).reverse();
  const rows = months.map(m => {
    const mo = repExpensesAllTime.filter(r => r.expense_date?.startsWith(m.value));
    if (!mo.length) return null;
    const total = mo.reduce((s, r) => s + (+r.amount || 0), 0);
    return { month: m.label, count: mo.length, total };
  }).filter(Boolean);

  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.month}</b></td><td class="text-center">${r.count}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty-state">No expense data yet</td></tr>';
}

// ── Vendor-wise (Purchases) ───────────────────────────
function renderVendorWiseReport() {
  const tbody = document.getElementById('vendorWiseBody');
  if (!tbody) return;
  const byVendor = {};
  repPurchases.forEach(r => {
    const key = r.vendor_name;
    if (!byVendor[key]) byVendor[key] = { name: key, gstin: r.vendor_gstin || '', count: 0, taxable: 0, gst: 0, total: 0 };
    byVendor[key].count++;
    byVendor[key].taxable += +r.taxable_amount;
    byVendor[key].gst += +r.gst_amount;
    byVendor[key].total += +r.total_amount;
  });
  const rows = Object.values(byVendor).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td>${r.gstin || '&mdash;'}</td><td class="text-center">${r.count}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No purchase data for this period</td></tr>';
}

// ── Product-wise (Purchases, from purchase_items, all-time) ──
function renderPurchProductWiseReport() {
  const tbody = document.getElementById('purchProductWiseBody');
  if (!tbody) return;
  const byProduct = {};
  repPurchaseItems.forEach(r => {
    const key = r.product_name;
    if (!byProduct[key]) byProduct[key] = { name: key, hsn: r.hsn_code || '', qty: 0, taxable: 0, gst: 0, total: 0 };
    byProduct[key].qty += +r.quantity || 0;
    byProduct[key].taxable += +r.taxable_value;
    byProduct[key].gst += +r.gst_amount;
    byProduct[key].total += +r.total_amount;
  });
  const rows = Object.values(byProduct).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td>${r.hsn || '&mdash;'}</td><td class="text-center">${r.qty || '&mdash;'}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No purchase line items yet</td></tr>';
}

// ── Customer-wise (B2B only — B2C has no customer identity) ──
function renderCustomerWiseReport() {
  const tbody = document.getElementById('customerWiseBody');
  if (!tbody) return;
  const byCustomer = {};
  repB2B.forEach(r => {
    const key = r.customer_name;
    if (!byCustomer[key]) byCustomer[key] = { name: key, gstin: r.gst_number, count: 0, taxable: 0, gst: 0, total: 0 };
    byCustomer[key].count++;
    byCustomer[key].taxable += +r.taxable_amount;
    byCustomer[key].gst += +r.gst_amount;
    byCustomer[key].total += +r.total_amount;
  });
  const rows = Object.values(byCustomer).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td>${r.gstin}</td><td class="text-center">${r.count}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No B2B customer data for this period</td></tr>';
}

// ── Product-wise (from HSN Summary entries, all-time) ──
function renderProductWiseReport() {
  const tbody = document.getElementById('productWiseBody');
  if (!tbody) return;
  const byProduct = {};
  [...repB2BHSN, ...repB2CHSN].forEach(r => {
    const key = r.product_name;
    if (!byProduct[key]) byProduct[key] = { name: key, hsn: r.hsn_code, qty: 0, taxable: 0, gst: 0, total: 0 };
    byProduct[key].qty += +r.quantity || 0;
    byProduct[key].taxable += +r.taxable_value;
    byProduct[key].gst += +r.total_gst;
    byProduct[key].total += +r.total_invoice_value;
  });
  const rows = Object.values(byProduct).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.name}</b></td><td>${r.hsn}</td><td class="text-center">${r.qty || '&mdash;'}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No HSN entries yet</td></tr>';
}

// ── HSN-wise (aggregated by HSN code, all-time) ──
function renderHSNWiseSummary() {
  const tbody = document.getElementById('hsnWiseBody');
  if (!tbody) return;
  const byHSN = {};
  [...repB2BHSN, ...repB2CHSN].forEach(r => {
    const key = r.hsn_code;
    if (!byHSN[key]) byHSN[key] = { hsn: key, products: new Set(), qty: 0, taxable: 0, gst: 0, total: 0 };
    byHSN[key].products.add(r.product_name);
    byHSN[key].qty += +r.quantity || 0;
    byHSN[key].taxable += +r.taxable_value;
    byHSN[key].gst += +r.total_gst;
    byHSN[key].total += +r.total_invoice_value;
  });
  const rows = Object.values(byHSN).sort((a, b) => b.total - a.total);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td><b>${r.hsn}</b></td><td>${[...r.products].join(', ')}</td><td class="text-center">${r.qty || '&mdash;'}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No HSN entries yet</td></tr>';
}

// ── GST rate-wise (across B2B + B2C invoices in the selected period) ──
// Itemized invoices are broken down by each line's own rate (an invoice
// can legitimately contain more than one rate); legacy invoices with no
// line items fall back to their single header rate exactly as before.
function renderGSTRateWiseReport() {
  const tbody = document.getElementById('gstRateWiseBody');
  if (!tbody) return;
  const byRate = {};
  const bump = (rate, taxable, gst, total) => {
    if (!byRate[rate]) byRate[rate] = { rate, count: 0, taxable: 0, gst: 0, total: 0 };
    byRate[rate].count++;
    byRate[rate].taxable += taxable;
    byRate[rate].gst += gst;
    byRate[rate].total += total;
  };
  [['b2b', repB2B], ['b2c', repB2C]].forEach(([type, list]) => {
    list.forEach(r => {
      const items = repItemsByInvoice[type + ':' + r.id];
      if (items && items.length) {
        items.forEach(it => bump(+it.gst_percentage, +it.taxable_value, +it.gst_amount, +it.total_amount));
      } else {
        bump(+r.gst_percentage, +r.taxable_amount, +r.gst_amount, +r.total_amount);
      }
    });
  });
  const rows = Object.values(byRate).sort((a, b) => a.rate - b.rate);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr><td class="text-center"><span class="badge badge-blue">${r.rate}%</span></td><td class="text-center">${r.count}</td><td class="text-right">₹${formatNum(r.taxable)}</td><td class="text-right">₹${formatNum(r.gst)}</td><td class="text-right fw-700">₹${formatNum(r.total)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty-state">No invoices for this period</td></tr>';
}

function getReportDateRange(filter) {
  const now = new Date();
  const m = now.getMonth(), y = now.getFullYear();
  if (filter === 'current') return { start: toISO(new Date(y,m,1)), end: toISO(new Date(y,m+1,0)) };
  if (filter === 'fy') {
    const fyStart = m >= 3 ? new Date(y,3,1) : new Date(y-1,3,1);
    const fyEnd   = m >= 3 ? new Date(y+1,2,31) : new Date(y,2,31);
    return { start: toISO(fyStart), end: toISO(fyEnd) };
  }
  if (filter && /^q[1-4]$/.test(filter)) {
    const fyStartYear = m >= 3 ? y : y - 1;
    const quarterStartMonth = { q1: 3, q2: 6, q3: 9, q4: 0 }[filter];
    const quarterYear = filter === 'q4' ? fyStartYear + 1 : fyStartYear;
    return { start: toISO(new Date(quarterYear, quarterStartMonth, 1)), end: toISO(new Date(quarterYear, quarterStartMonth + 3, 0)) };
  }
  if (filter && filter.includes('-')) {
    const [yr,mo] = filter.split('-').map(Number);
    return { start: toISO(new Date(yr,mo-1,1)), end: toISO(new Date(yr,mo,0)) };
  }
  return { start: toISO(new Date(y,m,1)), end: toISO(new Date(y,m+1,0)) };
}

function renderSummaryCards() {
  const allInv = [...repB2B, ...repB2C];
  const totals = {
    b2bTaxable: repB2B.reduce((s,r)=>s+ +r.taxable_amount,0),
    b2cTaxable: repB2C.reduce((s,r)=>s+ +r.taxable_amount,0),
    igst:  allInv.reduce((s,r)=>s+ +r.igst,0),
    cgst:  allInv.reduce((s,r)=>s+ +r.cgst,0),
    sgst:  allInv.reduce((s,r)=>s+ +r.sgst,0),
    total: allInv.reduce((s,r)=>s+ +r.total_amount,0),
    gst:   allInv.reduce((s,r)=>s+ +r.gst_amount,0)
  };
  const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  set('repB2BCount',    repB2B.length);
  set('repB2CCount',    repB2C.length);
  set('repB2BTaxable',  formatCurrency(totals.b2bTaxable));
  set('repB2CTaxable',  formatCurrency(totals.b2cTaxable));
  set('repTotalGST',    formatCurrency(totals.gst));
  set('repIGST',        formatCurrency(totals.igst));
  set('repCGST',        formatCurrency(totals.cgst));
  set('repSGST',        formatCurrency(totals.sgst));
  set('repGrandTotal',  formatCurrency(totals.total));
  set('repTotalCount',  repB2B.length + repB2C.length);
}

function renderGSTR1Summary() {
  const el = document.getElementById('gstr1SummaryBody');
  if (!el) return;

  const b2bTax   = repB2B.reduce((s,r)=>s+ +r.taxable_amount,0);
  const b2bGst   = repB2B.reduce((s,r)=>s+ +r.gst_amount,0);
  const b2bTotal = repB2B.reduce((s,r)=>s+ +r.total_amount,0);
  const b2cTax   = repB2C.reduce((s,r)=>s+ +r.taxable_amount,0);
  const b2cGst   = repB2C.reduce((s,r)=>s+ +r.gst_amount,0);
  const b2cTotal = repB2C.reduce((s,r)=>s+ +r.total_amount,0);

  el.innerHTML = `
    <tr><td><b>B2B Transactions</b></td><td style="text-align:center;">${repB2B.length}</td><td style="text-align:right;">₹${formatNum(b2bTax)}</td><td style="text-align:right;">₹${formatNum(b2bGst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(b2bTotal)}</td></tr>
    <tr><td><b>B2C Transactions</b></td><td style="text-align:center;">${repB2C.length}</td><td style="text-align:right;">₹${formatNum(b2cTax)}</td><td style="text-align:right;">₹${formatNum(b2cGst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(b2cTotal)}</td></tr>
    <tr style="background:var(--primary-xlight);font-weight:700;"><td>GRAND TOTAL</td><td style="text-align:center;">${repB2B.length+repB2C.length}</td><td style="text-align:right;">₹${formatNum(b2bTax+b2cTax)}</td><td style="text-align:right;">₹${formatNum(b2bGst+b2cGst)}</td><td style="text-align:right;font-size:15px;color:var(--primary-dark);">₹${formatNum(b2bTotal+b2cTotal)}</td></tr>`;

  const b2bD = document.getElementById('gstr1B2BBody');
  if (b2bD) {
    if (!repB2B.length) { b2bD.innerHTML = '<tr><td colspan="8" class="empty-state">No B2B data</td></tr>'; }
    else b2bD.innerHTML = repB2B.map((r,i) => `<tr><td>${i+1}</td><td>${r.gst_number}</td><td>${r.customer_name}</td><td>${r.invoice_number}</td><td>${formatDate(r.invoice_date)}</td><td style="text-align:right;">₹${formatNum(r.taxable_amount)}</td><td style="text-align:center;">${r.gst_percentage}%</td><td style="text-align:right;font-weight:700;">₹${formatNum(r.total_amount)}</td></tr>`).join('');
  }

  const b2cD = document.getElementById('gstr1B2CBody');
  if (b2cD) {
    if (!repB2C.length) { b2cD.innerHTML = '<tr><td colspan="7" class="empty-state">No B2C data</td></tr>'; }
    else b2cD.innerHTML = repB2C.map((r,i) => `<tr><td>${i+1}</td><td>${r.state}</td><td><span class="badge ${r.supply_type==='interstate'?'badge-blue':'badge-green'}">${r.supply_type}</span></td><td>${formatDate(r.invoice_date)}</td><td style="text-align:right;">₹${formatNum(r.taxable_amount)}</td><td style="text-align:center;">${r.gst_percentage}%</td><td style="text-align:right;font-weight:700;">₹${formatNum(r.total_amount)}</td></tr>`).join('');
  }
}

function renderMonthlyTable() {
  const tbody = document.getElementById('monthlyTableBody');
  if (!tbody) return;
  const months = monthYearOptions().slice(0, 12).reverse();
  const allInv = [...repB2B, ...repB2C];
  const rows = months.map(m => {
    const mo = allInv.filter(r => r.invoice_date?.startsWith(m.value));
    if (!mo.length) return null;
    const tax = mo.reduce((s,r)=>s+ +r.taxable_amount,0);
    const igst = mo.reduce((s,r)=>s+ +r.igst,0);
    const cgst = mo.reduce((s,r)=>s+ +r.cgst,0);
    const sgst = mo.reduce((s,r)=>s+ +r.sgst,0);
    const gst  = mo.reduce((s,r)=>s+ +r.gst_amount,0);
    const tot  = mo.reduce((s,r)=>s+ +r.total_amount,0);
    return { month: m.label, count: mo.length, tax, igst, cgst, sgst, gst, tot };
  }).filter(Boolean);

  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No data for selected period</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `
    <tr><td><b>${r.month}</b></td><td style="text-align:center;">${r.count}</td>
    <td style="text-align:right;">₹${formatNum(r.tax)}</td>
    <td style="text-align:right;">₹${formatNum(r.igst)}</td>
    <td style="text-align:right;">₹${formatNum(r.cgst)}</td>
    <td style="text-align:right;">₹${formatNum(r.sgst)}</td>
    <td style="text-align:right;">₹${formatNum(r.gst)}</td>
    <td style="text-align:right;font-weight:700;color:var(--primary-dark);">₹${formatNum(r.tot)}</td>
    </tr>`).join('');
}

function renderHSNReport() {
  const tbody = document.getElementById('hsnReportBody');
  if (!tbody) return;
  const combined = [
    ...repB2BHSN.map(r => ({ ...r, category: 'B2B' })),
    ...repB2CHSN.map(r => ({ ...r, category: 'B2C', quantity: '-' }))
  ];
  if (!combined.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No HSN data</td></tr>'; return; }
  tbody.innerHTML = combined.map((r,i) => `
    <tr><td>${i+1}</td><td><b>${r.hsn_code}</b></td><td>${r.product_name}</td>
    <td><span class="badge badge-green">${r.category}</span></td>
    <td style="text-align:center;">${r.quantity||'-'}</td>
    <td style="text-align:right;">₹${formatNum(r.taxable_value)}</td>
    <td style="text-align:right;">₹${formatNum(r.igst)} / ${formatNum(r.cgst)} / ${formatNum(r.sgst)}</td>
    <td style="text-align:right;">₹${formatNum(r.total_gst)}</td>
    <td style="text-align:right;font-weight:700;">₹${formatNum(r.total_invoice_value)}</td>
    </tr>`).join('');
}

function exportFullGSTR1() {
  const sheets = [
    {
      name: 'B2B Invoices',
      data: repB2B.map((r,i) => ({ 'S.No': i+1, 'GST No': r.gst_number, 'Customer': r.customer_name, 'Invoice No': r.invoice_number, 'Date': formatDate(r.invoice_date), 'Supply': r.supply_type, 'Taxable': r.taxable_amount, 'GST%': r.gst_percentage, 'IGST': r.igst, 'CGST': r.cgst, 'SGST': r.sgst, 'Total': r.total_amount }))
    },
    {
      name: 'B2C Invoices',
      data: repB2C.map((r,i) => ({ 'S.No': i+1, 'State': r.state, 'Supply': r.supply_type, 'Date': formatDate(r.invoice_date), 'Taxable': r.taxable_amount, 'GST%': r.gst_percentage, 'IGST': r.igst, 'CGST': r.cgst, 'SGST': r.sgst, 'Total': r.total_amount }))
    },
    {
      name: 'B2B HSN',
      data: repB2BHSN.map((r,i) => ({ 'S.No': i+1, 'HSN': r.hsn_code, 'Product': r.product_name, 'Type': r.type, 'Qty': r.quantity, 'Taxable': r.taxable_value, 'GST%': r.gst_percentage, 'IGST': r.igst, 'CGST': r.cgst, 'SGST': r.sgst, 'Total GST': r.total_gst, 'Total Inv': r.total_invoice_value }))
    },
    {
      name: 'B2C HSN',
      data: repB2CHSN.map((r,i) => ({ 'S.No': i+1, 'HSN': r.hsn_code, 'Product': r.product_name, 'Type': r.type, 'Taxable': r.taxable_value, 'GST%': r.gst_percentage, 'IGST': r.igst, 'CGST': r.cgst, 'SGST': r.sgst, 'Total GST': r.total_gst, 'Total Inv': r.total_invoice_value }))
    }
  ];
  exportMultiSheetExcel(sheets, 'GSTR1_Complete_Report');
}

function exportSummaryPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait' });
  const pw = doc.internal.pageSize.width;

  // Business letterhead via profile.js
  let y = 10;
  if (typeof getBusinessPDFHeader === 'function') {
    y = getBusinessPDFHeader(doc, 'GSTR-1 Summary Report', document.getElementById('reportMonth')?.options[document.getElementById('reportMonth')?.selectedIndex]?.text || '');
  } else {
    doc.setFillColor(0, 77, 64);
    doc.rect(0, 0, pw, 22, 'F');
    doc.setTextColor(255,255,255);
    doc.setFontSize(14); doc.setFont('helvetica','bold');
    doc.text('GSTR-1 Summary Report', pw/2, 10, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.text('Generated: ' + new Date().toLocaleString('en-IN'), pw/2, 18, { align: 'center' });
    y = 30;
  }

  // Report title band
  doc.setFillColor(224, 242, 241);
  doc.rect(0, y, pw, 10, 'F');
  doc.setTextColor(0, 77, 64); doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('GSTR-1 SUMMARY REPORT', pw/2, y + 7, { align: 'center' });
  y += 16;
  doc.setTextColor(0,77,64); doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('Summary Overview', 14, y); y += 8;

  const allInv = [...repB2B, ...repB2C];
  const totTax  = allInv.reduce((s,r)=>s+ +r.taxable_amount,0);
  const totGST  = allInv.reduce((s,r)=>s+ +r.gst_amount,0);
  const totIGST = allInv.reduce((s,r)=>s+ +r.igst,0);
  const totCGST = allInv.reduce((s,r)=>s+ +r.cgst,0);
  const totSGST = allInv.reduce((s,r)=>s+ +r.sgst,0);
  const totAmt  = allInv.reduce((s,r)=>s+ +r.total_amount,0);

  doc.autoTable({
    startY: y,
    head: [['Particulars', 'Count', 'Taxable Amount', 'GST Amount', 'Total']],
    body: [
      ['B2B Invoices', repB2B.length, '₹'+formatNum(repB2B.reduce((s,r)=>s+ +r.taxable_amount,0)), '₹'+formatNum(repB2B.reduce((s,r)=>s+ +r.gst_amount,0)), '₹'+formatNum(repB2B.reduce((s,r)=>s+ +r.total_amount,0))],
      ['B2C Invoices', repB2C.length, '₹'+formatNum(repB2C.reduce((s,r)=>s+ +r.taxable_amount,0)), '₹'+formatNum(repB2C.reduce((s,r)=>s+ +r.gst_amount,0)), '₹'+formatNum(repB2C.reduce((s,r)=>s+ +r.total_amount,0))],
      ['TOTAL', allInv.length, '₹'+formatNum(totTax), '₹'+formatNum(totGST), '₹'+formatNum(totAmt)]
    ],
    theme: 'striped',
    headStyles: { fillColor: [0,121,107] },
    foot: [['','','IGST: ₹'+formatNum(totIGST),'CGST: ₹'+formatNum(totCGST),'SGST: ₹'+formatNum(totSGST)]],
    footStyles: { fillColor: [224,242,241], textColor: [0,77,64], fontStyle: 'bold' }
  });

  y = doc.lastAutoTable.finalY + 14;
  doc.setTextColor(0,77,64); doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('B2B Invoice Details', 14, y); y += 4;

  doc.autoTable({
    startY: y,
    head: [['#','GST No','Customer','Invoice No','Date','Taxable','GST%','Total']],
    body: repB2B.map((r,i) => [i+1, r.gst_number, r.customer_name, r.invoice_number, formatDate(r.invoice_date), '₹'+formatNum(r.taxable_amount), r.gst_percentage+'%', '₹'+formatNum(r.total_amount)]),
    theme: 'striped', headStyles: { fillColor: [0,121,107] }, styles: { fontSize: 8 }
  });

  // Page numbers & footer
  const pageCount = doc.internal.getNumberOfPages();
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const ph = doc.internal.pageSize.height;
    doc.setFillColor(0, 77, 64);
    doc.rect(0, ph - 10, pw, 10, 'F');
    doc.setTextColor(255,255,255); doc.setFontSize(7.5); doc.setFont('helvetica','normal');
    doc.text(p?.business_name ? p.business_name + '  |  GSTIN: ' + (p.gstin||'') : 'GST Invoice & GSTR-1 Management System', 14, ph - 3.5);
    doc.text(`Page ${i} of ${pageCount}  |  Generated: ${new Date().toLocaleDateString('en-IN')}`, pw - 14, ph - 3.5, { align: 'right' });
  }

  doc.save('GSTR1_Summary_Report.pdf');
  showToast('PDF Report exported successfully!');
}

function showRepLoader(show) {
  const el = document.getElementById('repLoader');
  if (el) el.style.display = show ? 'flex' : 'none';
}
