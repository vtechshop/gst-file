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
  // Awaited. This page exports a GST return, and the return's own GSTIN
  // and state come from this profile — starting the load and moving on
  // left a window in which Export read an empty profile and produced a
  // file with no GSTIN and place of supply 99.
  await loadUserProfile(currentUser.id);
  setupMobileMenu();
  // populateMonthFilter decides which period the page opens on and returns
  // it, so the dropdown and the data on screen cannot disagree. The
  // promise is kept so anything reading the selector can wait for it —
  // see reportPeriodsReady below.
  reportPeriodsReady = populateMonthFilter(currentUser.id);
  const openingPeriod = await reportPeriodsReady;
  await loadReports(openingPeriod);
}

// Resolves once the period dropdown holds its options.
//
// The control ships empty in reports.html and is filled from the database
// after the page loads. Anything that reads it before then sees a select
// with no options at all — selectedIndex -1, value "" — which the export
// reported as "(nothing selected)" while the user, looking a moment
// later, saw July 2026 sitting in the same control. On a cold backend
// that window is seconds long, not milliseconds.
let reportPeriodsReady = null;

// Month names written out rather than taken from toLocaleString, so the
// label reads "July 2026" on every machine. A locale that formats months
// differently would otherwise change what this dropdown says.
const REPORT_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-07" -> "July 2026". Pure string work: a Date built from a
// date-only string parses as UTC and reads back a day earlier west of
// UTC, which is the same trap that had GSTR-1 filing the wrong month.
function reportMonthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${REPORT_MONTH_NAMES[+m - 1]} ${y}`;
}

// Every month the user actually has something recorded in, newest first.
//
// This used to be a fixed 24-month window counted back from today, so the
// list was mostly months with nothing in them while anything older than
// two years was unreachable. Now it comes from the stored dates.
//
// Sales invoices are what a GSTR-1 filing is made of, but this page also
// reports purchases, expenses, sales returns and credit/debit notes — a
// month holding only those has to stay selectable or that data becomes
// unviewable. Only the date column is read from each table.
async function collectReportMonths(userId) {
  const sources = [
    ['b2b_invoices', 'invoice_date'], ['b2c_invoices', 'invoice_date'],
    ['purchases', 'purchase_date'], ['expenses', 'expense_date'],
    ['sales_returns', 'return_date'], ['cdn_notes', 'note_date']
  ];
  // Throws on a failed read rather than skipping that table: swallowing it
  // silently removed months from the dropdown, and a month that cannot be
  // selected is a month that cannot be filed. populateMonthFilter()
  // catches this and says so instead of quietly offering a short list.
  const results = await readAll(
    sources.map(([table, col]) => _supabase.from(table).select(col).eq('user_id', userId)),
    'Could not read the months you have data for'
  );
  if (!results) throw new Error('report-months-read-failed');

  const months = new Set();
  results.forEach((rows, i) => {
    const col = sources[i][1];
    rows.forEach(row => {
      const d = String(row[col] || '');
      if (/^\d{4}-(0[1-9]|1[0-2])/.test(d)) months.add(d.slice(0, 7));
    });
  });
  // Lexicographic sort is chronological for YYYY-MM; reversed for newest
  // first, which is the month someone is most likely to be filing.
  return [...months].sort().reverse();
}

// The months this page found, published for anything that needs to say
// what the user could have picked. GSTR-1's validator reads it, so its
// message stays truthful even if the dropdown failed to render — reading
// the dropdown to describe the dropdown tells you nothing when the
// dropdown is the thing that went wrong.
let reportAvailableMonths = [];

// The options that need no data to draw. Rendered before anything is
// awaited so the control is never empty, and reused for the final render
// so the two cannot drift.
function reportStaticPeriodOptions() {
  return '<option value="current">Current Month</option>'
    + '<optgroup label="Ranges (not valid for a GSTR-1 filing)">'
    + '<option value="fy">Financial Year</option>'
    + '<option value="q1">Q1 (Apr-Jun)</option><option value="q2">Q2 (Jul-Sep)</option>'
    + '<option value="q3">Q3 (Oct-Dec)</option><option value="q4">Q4 (Jan-Mar)</option>'
    + '</optgroup>';
}

async function populateMonthFilter(userId) {
  const sel = document.getElementById('reportMonth');
  if (!sel) return 'current';

  // Draw first, fetch second. A select with no options reports its value
  // as "" and its selectedIndex as -1, which is indistinguishable from a
  // deliberate empty choice to anything reading it.
  sel.innerHTML = reportStaticPeriodOptions();

  let months = [];
  let monthsFailed = false;
  try { months = await collectReportMonths(userId); }
  catch (e) {
    // readAll() has already reported the reason; this only records that
    // the list on offer is incomplete, so a short dropdown is never
    // presented as the full set of months that have data.
    monthsFailed = true;
    console.error('Could not read the months you have data for:', e);
  }
  reportAvailableMonths = months.map(m => ({ value: m, label: reportMonthLabel(m) }));

  // Current Month drives the dashboard view and stays first. The named
  // months follow, because those are the ones a return is filed for —
  // GSTR-1 export accepts nothing else (see gstr1FilingPeriod in
  // js/gstr1-export.js). The multi-month ranges sit at the end.
  const monthOptions = months.length
    ? `<optgroup label="Filing months">${months
        .map(m => `<option value="${m}">${reportMonthLabel(m)}</option>`).join('')}</optgroup>`
    : monthsFailed
      // Labelled rather than left empty. An empty "Filing months" group is
      // indistinguishable from a business with no data at all, and someone
      // who cannot find last month in this list needs to know the list
      // failed to load — not conclude the month has nothing in it.
      ? '<optgroup label="Filing months (could not be loaded — reload)"></optgroup>'
      : '';

  // Redrawn now that the months are known, from the same static options.
  sel.innerHTML = reportStaticPeriodOptions()
    .replace('</option><optgroup', '</option>' + monthOptions + '<optgroup');

  const opening = defaultFilingMonth(months) || 'current';
  sel.value = opening;
  return opening;
}

// The month before the one we are in, as "YYYY-MM".
//
// Built from local date components, never by parsing a date string: a
// date-only string parses as UTC and reads back a day earlier west of
// UTC, which at a month boundary would name the wrong month entirely.
// `today` is a parameter so the boundaries can be tested at any date
// rather than only on the day the tests happen to run.
function latestClosedMonth(today = new Date()) {
  let y = today.getFullYear(), m = today.getMonth();   // getMonth() is 0-based
  if (m === 0) { y -= 1; m = 11; } else { m -= 1; }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

// Which month the Reports page should open on.
//
// A GSTR-1 is filed for a month that has ended, so the default is the
// latest closed month — never the one in progress, whose invoices are
// still being written. In August that is July; in January it is the
// previous December.
//
// If that month has nothing in it the nearest earlier month that does is
// used instead, so the page still opens on something worth looking at.
// `months` arrives newest-first, so the first entry at or before the
// closed month is that nearest one. YYYY-MM strings compare
// chronologically, so this is a string comparison and not a date one.
//
// Returns null when every month with data is the current open month or
// later — there is then no closed month to file, and the caller falls
// back to Current Month so the page still shows something. The export
// refuses that selection on its own and says which months exist.
function defaultFilingMonth(months, today = new Date()) {
  const closed = latestClosedMonth(today);
  return (months || []).find(m => m <= closed) || null;
}

// Puts the page into an explicit "no figures" state after a failed read.
//
// The in-memory arrays are emptied and every table and stat tile is
// blanked, because the alternative is worse than an error: the previously
// loaded period's rows would still be on screen under the newly chosen
// period's label, and every export button on this page reads those same
// arrays. A report that could not be loaded must look nothing like a
// report that loaded and found little.
function reportsUnavailable() {
  repB2B = []; repB2C = []; repB2BHSN = []; repB2CHSN = [];
  repItemsByInvoice = {};
  repPurchases = []; repPurchaseItems = [];
  repExpenses = []; repExpensesAllTime = [];
  repSalesReturns = []; repSalesReturnItems = [];

  document.querySelectorAll('#reportPrintArea tbody').forEach(tb => {
    const cols = tb.closest('table')?.querySelectorAll('thead th').length || 6;
    tb.innerHTML = `<tr><td colspan="${cols}" class="empty-state">`
      + '<i class="fas fa-triangle-exclamation table-loading-icon-sm"></i>'
      + 'Could not be loaded. Nothing is shown rather than part of the picture &mdash; reload to try again.'
      + '</td></tr>';
  });
  ['repB2BCount', 'repB2CCount', 'repTotalCount'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '—';
  });
  ['repB2BTaxable', 'repB2CTaxable', 'repTotalGST', 'repIGST', 'repCGST', 'repSGST', 'repGrandTotal'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '—';
  });
  showRepLoader(false);
}

async function loadReports(filter) {
  showRepLoader(true);
  const { start, end } = getReportDateRange(filter);

  // readAll() rather than Promise.all: eleven reads feed this page, and
  // `(res.data || [])` on each turned any one of them failing into an
  // empty table — a report showing less sales, less purchase credit or
  // fewer returns than the business actually had, with nothing on screen
  // saying so. These figures are what a filing gets prepared from, so a
  // partial read now renders nothing at all.
  const repRows = await readAll([
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
  ], 'Could not load the reports');
  if (!repRows) { reportsUnavailable(); return; }
  const [b2bRows, b2cRows, hsnB2BRows, hsnB2CRows, itemRows, purchRows, purchItemRows, expRows, expAllRows, srRows, srItemRows] = repRows;

  repB2B = b2bRows;
  repB2C = b2cRows;

  // HSN/Product reports are driven by invoice line items now — the
  // invoice is the only source of truth. 'source' !== 'auto' historical
  // rows (manual entries / Excel imports from before this was a live
  // report) are kept alongside so no past data disappears.
  const allItems = itemRows;
  const toHSNRow = it => ({
    hsn_code: it.hsn_code, product_name: it.product_name, type: 'goods',
    quantity: it.quantity, taxable_value: +it.taxable_value, gst_percentage: it.gst_percentage,
    igst: +it.igst, cgst: +it.cgst, sgst: +it.sgst, total_gst: +it.gst_amount, total_invoice_value: +it.total_amount
  });
  const legacyB2BHSN = hsnB2BRows.filter(r => r.source !== 'auto');
  const legacyB2CHSN = hsnB2CRows.filter(r => r.source !== 'auto');
  repB2BHSN = [...allItems.filter(it => it.invoice_type === 'b2b' && it.hsn_code).map(toHSNRow), ...legacyB2BHSN];
  repB2CHSN = [...allItems.filter(it => it.invoice_type === 'b2c' && it.hsn_code).map(toHSNRow), ...legacyB2CHSN];

  repItemsByInvoice = {};
  allItems.forEach(r => {
    const key = r.invoice_type + ':' + r.invoice_id;
    (repItemsByInvoice[key] = repItemsByInvoice[key] || []).push(r);
  });

  repPurchases = purchRows;
  repPurchaseItems = purchItemRows;
  repExpenses = expRows;
  repExpensesAllTime = expAllRows;
  repSalesReturns = srRows;
  repSalesReturnItems = srItemRows;

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

// ── Complete Invoice Details (sheet 5) ──────────────────────────────
//
// One row per invoice LINE, B2B and B2C together, for the selected
// period. The rows come from GET /api/reports/invoice-details, which does
// the join in Postgres — not from repB2B/repB2C, and not from anything
// the page happens to be displaying. That is the whole point: this sheet
// must contain every matching invoice whether or not the browser ever
// loaded it, so it cannot be built from the four existing arrays.
//
// Place of Supply and Round Off are DERIVED here using the definitions
// that already exist in this codebase, rather than second copies:
//   POS       gstr1PosRegistered / getStateCode — the filing's own rule.
//   Round Off total - (taxable + gst). There is no round_off column; see
//             the note above gstr1TotalMatches() in gstr1-export.js.
// One width per column, in column order. Qty is 10 rather than the 9 it
// reads best at: ExcelJS treats a width of exactly 9 as Excel's own default
// and omits it, so that one column would arrive unsized while every other
// carried the width asked for.
const COMPLETE_DETAIL_WIDTHS = [
  // Sl.no., Date, Bill Number, GST NUMBER, HSN code, State, Bill Address,
  // Item, Amount, GST%, SGST, CGST, IGST, Total Rs.
  //
  // HSN code and Item are wider than a single value needs: both can hold
  // every distinct value on a multi-product invoice.
  7, 12, 16, 18, 22, 16, 34, 34, 14, 14, 12, 12, 12, 14
].map(wch => ({ wch }));

// A stored figure as a real Excel number.
//
// Money, quantities and rates are NUMERIC in Postgres, and node-postgres
// hands NUMERIC back as a STRING so that no paise are lost to a float on
// the way out. res.json() then sends "1700.00", and a workbook built
// straight from that gets a cell of TEXT that happens to look like money:
// it will not sum, will not chart, and sorts 9 after 100.
//
// This converts that string to the number it already was. It is not a
// calculation and changes no value — 1700.00 becomes 1700, which Excel
// renders as "1700.00" once the column carries the format. Anything that
// is not a finite number is passed through untouched rather than being
// forced to 0, so a value this does not understand is still visible in the
// sheet instead of silently becoming a figure nobody entered.
function excelNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// Excel number formats, by what the column holds. Kept together so every
// sheet says "money" the same way.
//
// MONEY and RATE both show two decimals; QTY shows up to three and none
// when there are none, so a quantity of 3 reads "3" and one of 2.5 reads
// "2.5" rather than "2.500". DATE_SLASH matches what these four sheets
// have always displayed, so making the cells real dates does not change
// how they look.
const XL_MONEY = '0.00';
const XL_RATE = '0.00';
const XL_QTY = '0.###';
const XL_INT = '0';
const XL_DATE_SLASH = 'dd/mm/yyyy';

function completeInvoicePlaceOfSupply(row) {
  const gstin = (row.gst_number || '').trim();
  // Registered customer: the customer's own GSTIN decides POS. Only fall
  // back to the state for a genuinely unregistered one.
  if (gstin) return gstin.toUpperCase().slice(0, 2);
  const code = getStateCode(row.state);
  return code === '99' ? '' : code;
}

// The distinct rates on an invoice, ascending, as "5%, 18%".
//
// Rates are DECIMAL(5,2) in the database, so 18.00 must read as 18 and
// 2.50 as 2.5 - a column of "18.00%" would be noise. Sorted numerically,
// not as text, or 5 would follow 18.
function formatGstRateList(rates) {
  return [...rates]
    .sort((a, b) => a - b)
    .map(v => String(Math.round(v * 100) / 100) + '%')
    .join(', ');
}

// GST% for one invoice: a NUMBER when the invoice carries a single rate,
// and text only when it genuinely carries more than one.
//
// An invoice at one rate has a rate — 18 — and there is no reason to hand
// Excel a string for it. An invoice whose lines are at 5% and 18% has no
// single number to give, and forcing one would mean either inventing an
// average or dropping a rate. That cell says "5%, 18%" and stays text,
// which is the price of stating two facts in one cell.
//
// Either way this is a description of rates already stored on the lines.
// No GST is recalculated and no amount is derived from it.
function completeInvoiceGstRate(rates) {
  const list = [...rates];
  if (list.length === 1) return list[0];
  return formatGstRateList(list);
}

// One row per INVOICE, in the fourteen columns the finished sheet shows.
//
// The endpoint returns one row per invoice LINE, because that is what the
// join produces and what its counts are checked against. This sheet is an
// invoice-level document, so the lines of an invoice collapse into the one
// row they all describe.
//
// Grouped by invoice id, not by invoice number: numbers are unique per
// (user, invoice_source, number), so two invoices raised under different
// sources may legitimately share one, and grouping on the number would
// merge two real invoices into a single row.
//
// Where a value belongs to the invoice it is taken from the invoice
// (Amount, GST%, SGST, CGST, IGST, Total Rs. are the stored header
// figures, not a line's, and not recomputed here). Where a value belongs
// to the lines, every distinct one is listed so nothing is dropped:
//
//   HSN code  every distinct HSN on the invoice, comma separated
//   Item      every distinct product name, separated by " | " because a
//             product name may itself contain a comma
//
// GST% is a DISPLAY SUMMARY of the rates actually on the invoice's lines,
// not the invoice header's single gst_percentage. An invoice really can
// carry products at 5% and 18% at once, and one number cannot say so: it
// reads "5%, 18%". A single-rate invoice reads "18%".
//
// That makes the cell text rather than a number, which is the price of
// being able to state two rates in one cell. It is a label only - no GST
// amount is derived from it. SGST, CGST, IGST, Amount and Total Rs. remain
// the stored invoice figures, untouched and unrecalculated.
// `direction` is the Bill Number order the toolbar asks for, 'asc' or
// 'desc'. It changes nothing but the order of the rows and the Sl.no.
// that follows from it: the same invoices, the same aggregation, the same
// figures, read from the other end.
function buildCompleteInvoiceRows(rows, direction) {
  const byInvoice = new Map();
  for (const r of rows) {
    const key = r.invoice_id || (r.category + ':' + r.invoice_number);
    let g = byInvoice.get(key);
    // Insertion order only groups the lines; the finished rows are ordered
    // by bill number below, whatever order the server returned them in.
    if (!g) { g = { first: r, hsn: [], items: [], rates: new Set() }; byInvoice.set(key, g); }
    const hsn = String(r.hsn_code == null ? '' : r.hsn_code).trim();
    if (hsn && !g.hsn.includes(hsn)) g.hsn.push(hsn);
    const item = String(r.product_name == null ? '' : r.product_name).trim();
    if (item && !g.items.includes(item)) g.items.push(item);
    // Read from the LINE, never from the invoice header: the header cannot
    // describe an invoice whose lines differ.
    if (r.gst_percentage != null && r.gst_percentage !== '' && Number.isFinite(+r.gst_percentage)) {
      g.rates.add(+r.gst_percentage);
    }
  }

  const out = [...byInvoice.values()].map(g => {
    const r = g.first;

    // Kept as the plain YYYY-MM-DD the API sends, and turned into a real
    // Excel date by the writer. A JS Date here would be serialised to UTC
    // on its way to the server and could land the invoice on the previous
    // day; the string cannot drift, and 'Date' is declared in dateColumns
    // so the cell is still a date, not text.
    const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(r.invoice_date || ''))
      ? String(r.invoice_date) : '';

    return {
      'Sl.no.': 0,                       // assigned below, once the order is final
      'Date': invoiceDate,
      'Bill Number': r.invoice_number || '',
      'GST NUMBER': r.gst_number || '',
      'HSN code': g.hsn.join(', '),
      'State': r.state || '',
      'Bill Address': r.address || '',
      'Item': g.items.join(' | '),
      'Amount': +r.inv_taxable_amount || 0,
      'GST%': completeInvoiceGstRate(g.rates),
      'SGST': +r.inv_sgst || 0,
      'CGST': +r.inv_cgst || 0,
      'IGST': +r.inv_igst || 0,
      'Total Rs.': +r.inv_total_amount || 0
    };
  });

  // Ordered by the bill number, because that is how this sheet is read:
  // someone looking for invoice 187 wants it between 186 and 188, not
  // wherever its date happens to put it.
  //
  // compareInvoiceNumbers is the same rule the invoice list and the filing
  // use, so all three agree on which invoice comes first. It compares the
  // digit runs inside a number as numbers, which is what makes 9 sort
  // before 10 and INV-9 before INV-10 — plain text sorting puts 100 before
  // 9. The stored number itself is never altered or converted; only the
  // order of the rows changes.
  //
  // Descending is that same ordering read backwards, not a different rule:
  // negating the one comparison keeps 100 above 11 above 9, where reversing
  // a text sort would not.
  const descending = String(direction || 'asc').toLowerCase() === 'desc';
  out.sort((a, b) => {
    const d = compareInvoiceNumbers(a['Bill Number'], b['Bill Number']);
    return descending ? -d : d;
  });

  // Numbered AFTER sorting, so Sl.no. counts the sheet as it is actually
  // read: 1 to n down the page, with no gaps and no leftover numbers from
  // the order the rows arrived in.
  out.forEach((row, i) => { row['Sl.no.'] = i + 1; });

  return out;
}

// Fetches the detail rows for the period currently selected on the page,
// plus the Category and Sort controls beside the export button.
async function fetchCompleteInvoiceDetails() {
  const period = document.getElementById('reportMonth')?.value || 'current';
  const { start, end } = getReportDateRange(period);
  const category = document.getElementById('repDetailCategory')?.value || 'all';
  const sort = document.getElementById('repDetailSort')?.value || 'asc';
  const qs = new URLSearchParams({ start, end, category, sort });
  return apiFetch('/reports/invoice-details?' + qs.toString());
}

async function exportFullGSTR1() {
  // The four existing sheets keep exactly the rows, columns, headers and
  // values they have always had. What changes is the CELL TYPE: the
  // figures reach the sheet as numbers rather than as strings that look
  // like numbers, and the date columns as real dates. GST No, Invoice No,
  // HSN, Customer, Product, State, Supply and Type stay text — every one
  // of them is an identifier or a label, and an HSN of 08439000 would lose
  // its leading zero the moment anything treated it as a quantity.
  const MONEY_FMT = {
    'Taxable': XL_MONEY, 'GST%': XL_RATE, 'IGST': XL_MONEY, 'CGST': XL_MONEY,
    'SGST': XL_MONEY, 'Total': XL_MONEY, 'Total GST': XL_MONEY, 'Total Inv': XL_MONEY,
    'S.No': XL_INT, 'Date': XL_DATE_SLASH
  };
  const sheets = [
    {
      name: 'B2B Invoices',
      data: repB2B.map((r,i) => ({ 'S.No': i+1, 'GST No': r.gst_number, 'Customer': r.customer_name, 'Invoice No': r.invoice_number, 'Date': r.invoice_date, 'Supply': r.supply_type, 'Taxable': excelNumber(r.taxable_amount), 'GST%': excelNumber(r.gst_percentage), 'IGST': excelNumber(r.igst), 'CGST': excelNumber(r.cgst), 'SGST': excelNumber(r.sgst), 'Total': excelNumber(r.total_amount) })),
      dateColumns: ['Date'], numberFormats: MONEY_FMT
    },
    {
      name: 'B2C Invoices',
      data: repB2C.map((r,i) => ({ 'S.No': i+1, 'State': r.state, 'Supply': r.supply_type, 'Date': r.invoice_date, 'Taxable': excelNumber(r.taxable_amount), 'GST%': excelNumber(r.gst_percentage), 'IGST': excelNumber(r.igst), 'CGST': excelNumber(r.cgst), 'SGST': excelNumber(r.sgst), 'Total': excelNumber(r.total_amount) })),
      dateColumns: ['Date'], numberFormats: MONEY_FMT
    },
    {
      name: 'B2B HSN',
      data: repB2BHSN.map((r,i) => ({ 'S.No': i+1, 'HSN': r.hsn_code, 'Product': r.product_name, 'Type': r.type, 'Qty': excelNumber(r.quantity), 'Taxable': excelNumber(r.taxable_value), 'GST%': excelNumber(r.gst_percentage), 'IGST': excelNumber(r.igst), 'CGST': excelNumber(r.cgst), 'SGST': excelNumber(r.sgst), 'Total GST': excelNumber(r.total_gst), 'Total Inv': excelNumber(r.total_invoice_value) })),
      numberFormats: Object.assign({ 'Qty': XL_QTY }, MONEY_FMT)
    },
    {
      name: 'B2C HSN',
      data: repB2CHSN.map((r,i) => ({ 'S.No': i+1, 'HSN': r.hsn_code, 'Product': r.product_name, 'Type': r.type, 'Taxable': excelNumber(r.taxable_value), 'GST%': excelNumber(r.gst_percentage), 'IGST': excelNumber(r.igst), 'CGST': excelNumber(r.cgst), 'SGST': excelNumber(r.sgst), 'Total GST': excelNumber(r.total_gst), 'Total Inv': excelNumber(r.total_invoice_value) })),
      numberFormats: MONEY_FMT
    }
  ];

  // Sheet 5 is the only one that needs the server. If that read fails the
  // workbook is not written at all: a GSTR-1 export that quietly came back
  // with four sheets instead of five looks exactly like a period with no
  // invoices, and the person filing cannot tell the difference.
  let detail;
  try {
    detail = await fetchCompleteInvoiceDetails();
  } catch (err) {
    handleApiError(err, 'loading the complete invoice details');
    return;
  }

  // The direction the SERVER echoes back, not the control read a second
  // time: that is the value actually applied to this response, so the sheet
  // cannot end up ordered by a choice made after the request went out.
  const detailRows = buildCompleteInvoiceRows(detail.rows, detail.sort);

  if (!detailRows.length) {
    showToast('No invoices found for the selected period/category.', 'warning');
    return;
  }

  // What the database counted, against what is about to be written. The
  // sheet is one row per invoice now, so the row count must equal the
  // invoice count exactly — one short means an invoice was dropped on the
  // way here, one over means one was written twice. Either is worth
  // refusing to export rather than shipping a workbook nobody can trust.
  if (detailRows.length !== detail.invoice_count) {
    showToast(`Export mismatch: the database has ${detail.invoice_count} invoices `
      + `for this period but the sheet has ${detailRows.length} rows. `
      + 'Nothing was exported.', 'error');
    return;
  }

  sheets.push({
    name: 'Complete Invoice Details',
    data: detailRows,
    widths: COMPLETE_DETAIL_WIDTHS,
    autofilter: true,
    dateColumns: ['Date'],
    // Bill Number, GST NUMBER, HSN code, State, Bill Address and Item are
    // deliberately absent: they are identifiers and labels, and a format
    // is only applied to a cell that is already a number.
    numberFormats: {
      'Sl.no.': XL_INT, 'Amount': XL_MONEY, 'GST%': XL_RATE,
      'SGST': XL_MONEY, 'CGST': XL_MONEY, 'IGST': XL_MONEY, 'Total Rs.': XL_MONEY
    }
  });

  // Written on the server with ExcelJS: a bold header row and a frozen
  // first row are the two things the browser's SheetJS build cannot do.
  // The rows above are unchanged — the server formats them, nothing else.
  try {
    await downloadExcelWorkbook(sheets, 'GSTR1_Complete_Report');
  } catch (err) {
    handleApiError(err, 'building the GSTR-1 workbook');
  }
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
