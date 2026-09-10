// =============================================
// Product Sales Report — how many of each product sold in a month
// =============================================
//
// Every figure on this page comes from GET /api/reports/product-sales,
// which aggregates in Postgres. The browser never downloads invoice lines
// and never adds anything up: it asks for a period and draws what comes
// back. That is what keeps the page the same speed on a tenant with two
// hundred invoices and one with two hundred thousand.
//
// It also means the sheet and the screen cannot disagree — the export
// writes the same rows the table is drawn from, not a second query.

let psRows = [];        // the rows currently on screen
let psSummary = null;   // the totals that came with them
let psPeriod = null;    // what was actually asked for, as the API understood it

const PS_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Quantities are counts of things, not money: 18 reads as "18", and 2.5
// reads as "2.5" for the businesses that sell by weight. Trailing zeros
// would only add noise.
function psQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

// Product names and SKUs are user text and reach the table through
// innerHTML. Escaped here, page-locally, the same way every other list
// page in this application does it.
function escPs(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function psEl(id) { return document.getElementById(id); }
function psVal(id) { const el = psEl(id); return el ? el.value : ''; }

async function initProductSales() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  // Years on offer: this year and the nine before it. A business filing
  // for a year outside that range can still reach it by URL, and the
  // server validates the range either way.
  const now = new Date();
  const thisYear = now.getFullYear();
  const yearSel = psEl('psYear');
  if (yearSel) {
    yearSel.innerHTML = '';
    for (let y = thisYear; y >= thisYear - 9; y--) {
      yearSel.innerHTML += `<option value="${y}">${y}</option>`;
    }
    yearSel.value = String(thisYear);
  }
  // Opens on the month the user is most likely to want: this one.
  const monthSel = psEl('psMonth');
  if (monthSel) monthSel.value = String(now.getMonth() + 1);

  // Enter in the search box applies, rather than needing the mouse.
  psEl('psSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); psApply(); }
  });
  // The three selects re-run on their own: changing a period and then
  // having to press Apply reads as the page ignoring you.
  ['psYear', 'psMonth', 'psCategory', 'psSort'].forEach(id =>
    psEl(id)?.addEventListener('change', psApply));

  await psApply();
}

function psQuery() {
  const params = new URLSearchParams();
  params.set('year', psVal('psYear') || String(new Date().getFullYear()));
  params.set('month', psVal('psMonth') || 'all');
  params.set('category', psVal('psCategory') || 'all');
  params.set('sort', psVal('psSort') || 'qty_desc');
  const search = (psVal('psSearch') || '').trim();
  if (search) params.set('search', search);
  return params.toString();
}

async function psApply() {
  const body = psEl('psTableBody');
  if (body) body.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Loading&hellip;</td></tr>';
  try {
    const res = await apiFetch('/reports/product-sales?' + psQuery());
    psRows = Array.isArray(res.products) ? res.products : [];
    psSummary = res.summary || null;
    psPeriod = res.period || null;
    psRender();
  } catch (err) {
    psRows = []; psSummary = null;
    if (body) body.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Could not load the report.</td></tr>';
    handleApiError(err, 'Could not load the product sales report');
  }
}

function psReset() {
  const now = new Date();
  const yearSel = psEl('psYear');
  if (yearSel) yearSel.value = String(now.getFullYear());
  const monthSel = psEl('psMonth');
  if (monthSel) monthSel.value = String(now.getMonth() + 1);
  const cat = psEl('psCategory'); if (cat) cat.value = 'all';
  const sort = psEl('psSort'); if (sort) sort.value = 'qty_desc';
  const search = psEl('psSearch'); if (search) search.value = '';
  psApply();
}

function psPeriodText() {
  if (!psPeriod) return 'Product sales';
  const month = psPeriod.month === 'all'
    ? 'All months' : (PS_MONTHS[Number(psPeriod.month) - 1] || '');
  const cat = { all: '', b2b: ' — B2B only', b2c: ' — B2C only' }[psVal('psCategory')] || '';
  return `${month} ${psPeriod.year}${cat}`;
}

function psRender() {
  const body = psEl('psTableBody');
  if (!body) return;

  const set = (id, v) => { const el = psEl(id); if (el) el.textContent = v; };
  set('psStatProducts', psSummary ? String(psSummary.products) : '0');
  set('psStatSold', psSummary ? psQty(psSummary.sold_qty) : '0');
  set('psStatReturned', psSummary ? psQty(psSummary.return_qty) : '0');
  set('psStatNet', psSummary ? psQty(psSummary.net_qty) : '0');
  set('psPeriodLabel', psPeriodText());
  set('psRowCount', psRows.length
    ? `${psRows.length} product${psRows.length === 1 ? '' : 's'}`
    : '');

  // More returned than sold in the period is not clamped away — it is
  // either a return against an earlier month or a data problem, and both
  // are things the reader needs to see. Named, so it can be looked into.
  const odd = psRows.filter(r => r.negative_net);
  const alert = psEl('psAnomaly');
  if (alert) {
    alert.classList.toggle('d-none', !odd.length);
    alert.innerHTML = odd.length
      ? `<i class="fas fa-triangle-exclamation"></i> ${odd.length} product`
        + `${odd.length === 1 ? ' has' : 's have'} more returned than sold in this period: `
        + odd.map(r => escPs(r.product_name)).join(', ')
        + '. That is usually a return against a sale from an earlier month.'
      : '';
  }

  if (!psRows.length) {
    body.innerHTML = '<tr><td colspan="8" class="text-center text-muted">'
      + 'No sales in this period.</td></tr>';
    return;
  }

  body.innerHTML = psRows.map(r => `
    <tr${r.negative_net ? ' class="row-warning"' : ''}>
      <td class="text-center">${r.sl_no}</td>
      <td><b>${escPs(r.product_name)}</b></td>
      <td>${escPs(r.sku)}</td>
      <td>${escPs(r.unit)}</td>
      <td class="text-right">${psQty(r.sold_qty)}</td>
      <td class="text-right">${r.return_qty ? psQty(r.return_qty) : '-'}</td>
      <td class="text-right"><b>${psQty(r.net_qty)}</b></td>
      <td class="text-right text-muted-sm">${r.invoice_count}</td>
    </tr>`).join('');
}

// ── Excel ─────────────────────────────────────────────────────────────
//
// Written from psRows, which is every product the API returned for the
// period — there is no pagination to be on the wrong page of. The server
// writes the file (client/js/utilities/export.js -> /reports/workbook),
// which is what gives it a bold header row and a frozen first row.
//
// Quantities go up as JSON numbers and arrive as Excel numbers, so the
// sheet can sum and sort them. Product, SKU and Unit are text, including
// a SKU like "0012" that would otherwise lose its leading zeros.
async function psExportExcel() {
  if (!psRows.length) {
    showToast('There is nothing to export for this period.', 'warning');
    return;
  }

  const data = psRows.map(r => ({
    'Sl.no.': r.sl_no,
    'Product Name': String(r.product_name || ''),
    'SKU': String(r.sku || ''),
    'Unit': String(r.unit || ''),
    'Quantity Sold': r.sold_qty,
    'Sales Return Qty': r.return_qty,
    'Net Sold Qty': r.net_qty,
    'Invoices': r.invoice_count
  }));

  // What the API counted, against what is about to be written. One row
  // short means a product was dropped on the way here.
  if (psSummary && data.length !== psSummary.products) {
    showToast(`Export mismatch: the report has ${psSummary.products} products `
      + `but the sheet has ${data.length} rows. Nothing was exported.`, 'error');
    return;
  }

  const label = psPeriodText().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  try {
    await downloadExcelWorkbook([{
      name: 'Product Sales',
      data,
      widths: [{ wch: 8 }, { wch: 38 }, { wch: 14 }, { wch: 8 },
        { wch: 15 }, { wch: 18 }, { wch: 15 }, { wch: 11 }],
      autofilter: true
    }], 'Product_Sales_' + (label || 'Report'));
  } catch (err) {
    handleApiError(err, 'building the product sales workbook');
  }
}
