// Stock Summary — current balances, and the two ways stock moves without a
// document behind it.
//
// Every number on this page is computed by the server from the ledger. The
// browser sorts nothing, sums nothing and pages nothing itself: a ledger
// runs to thousands of rows per product and belongs in SQL.
let stockPage = 0;
const STOCK_PAGE_SIZE = 50;
let stockDebounceTimer = null;
let stockProductsCache = null;

const STOCK_STATUS_LABEL = {
  IN_STOCK: { text: 'In Stock', cls: 'badge-success' },
  LOW_STOCK: { text: 'Low Stock', cls: 'badge-warning' },
  OUT_OF_STOCK: { text: 'Out of Stock', cls: 'badge-danger' }
};

function stockDebouncedReload() {
  clearTimeout(stockDebounceTimer);
  stockDebounceTimer = setTimeout(() => { stockPage = 0; loadStockSummary(); }, 300);
}

async function initStockSummary() {
  await loadStockStats();
  await loadStockSummary();
}

async function loadStockStats() {
  const el = document.getElementById('stockStats');
  if (!el) return;
  try {
    const s = await apiFetch('/stock/stats');
    const card = (icon, label, value, tone) => `
      <div class="stat-card${tone ? ' ' + tone : ''}">
        <div class="stat-icon"><i class="fas ${icon}"></i></div>
        <div class="stat-body">
          <div class="stat-value">${escStock(value)}</div>
          <div class="stat-label">${escStock(label)}</div>
        </div>
      </div>`;
    el.innerHTML =
      card('fa-box', 'Tracked Products', s.tracked_products)
      + card('fa-cubes', 'Total Quantity', formatStockQty(s.total_quantity))
      + card('fa-triangle-exclamation', 'Low Stock', s.low_stock, +s.low_stock > 0 ? 'stat-warning' : '')
      + card('fa-circle-xmark', 'Out of Stock', s.out_of_stock, +s.out_of_stock > 0 ? 'stat-danger' : '')
      + card('fa-arrow-down', 'Stock In Today', formatStockQty(s.in_today))
      + card('fa-arrow-up', 'Stock Out Today', formatStockQty(s.out_today));
  } catch (err) {
    handleApiError(err, 'loading stock totals');
  }
}

async function loadStockSummary() {
  const body = document.getElementById('stockTableBody');
  if (!body) return;
  const params = new URLSearchParams();
  const q = (document.getElementById('stkSearch') || {}).value || '';
  const status = (document.getElementById('stkStatus') || {}).value || '';
  const category = (document.getElementById('stkCategory') || {}).value || '';
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  if (category.trim()) params.set('category', category.trim());
  params.set('limit', String(STOCK_PAGE_SIZE));
  params.set('offset', String(stockPage * STOCK_PAGE_SIZE));

  try {
    const res = await apiFetch('/stock?' + params.toString());
    if (!res.rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="text-center text-muted">
        ${status || q || category ? 'No products match these filters.'
    : 'No stock-tracked products yet. Record an opening balance to start tracking one.'}
      </td></tr>`;
    } else {
      body.innerHTML = res.rows.map(r => {
        const s = STOCK_STATUS_LABEL[r.status] || { text: r.status, cls: '' };
        return `<tr>
          <td><b>${escStock(r.name)}</b></td>
          <td>${escStock(r.sku) || '—'}</td>
          <td>${escStock(r.hsn_code) || '—'}</td>
          <td class="text-right">${formatStockQty(r.stock)} ${escStock(r.unit) || ''}</td>
          <td class="text-right">${r.reorder_level === null ? '—' : formatStockQty(r.reorder_level)}</td>
          <td><span class="badge ${s.cls}">${s.text}</span></td>
          <td class="text-right">
            <a class="btn btn-secondary btn-sm" href="stock-ledger.html?product=${encodeURIComponent(r.id)}"
               title="Stock ledger"><i class="fas fa-clipboard-list"></i></a>
          </td>
        </tr>`;
      }).join('');
    }
    renderStockPagination(res);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Could not load stock.</td></tr>';
    handleApiError(err, 'loading stock');
  }
}

function renderStockPagination(res) {
  const el = document.getElementById('stockPagination');
  if (!el) return;
  const pages = Math.ceil(res.total / STOCK_PAGE_SIZE) || 1;
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm" ${stockPage === 0 ? 'disabled' : ''}
      onclick="stockGoTo(${stockPage - 1})"><i class="fas fa-chevron-left"></i></button>
    <span class="text-muted-sm">Page ${stockPage + 1} of ${pages} — ${res.total} products</span>
    <button type="button" class="btn btn-secondary btn-sm" ${stockPage + 1 >= pages ? 'disabled' : ''}
      onclick="stockGoTo(${stockPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
}
function stockGoTo(p) { stockPage = Math.max(0, p); loadStockSummary(); }

// ── Product pickers ───────────────────────────────────────────────────
// Cached for the life of the page: both modals need the same list, and it
// does not change while a modal is open.
async function stockProducts() {
  if (stockProductsCache) return stockProductsCache;
  const rows = await apiFetch('/products?select=id,name,sku,unit,stock&order=name.asc&limit=1000');
  stockProductsCache = rows;
  return rows;
}
async function fillProductSelect(id, onlyTracked) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    const rows = await stockProducts();
    const list = onlyTracked ? rows.filter(r => r.stock !== null) : rows.filter(r => r.stock === null);
    el.innerHTML = '<option value="">Select a product</option>' + list.map(r =>
      `<option value="${escStock(r.id)}">${escStock(r.name)}${r.sku ? ' (' + escStock(r.sku) + ')' : ''}${
        onlyTracked ? ' — ' + formatStockQty(r.stock) + ' ' + (escStock(r.unit) || '') : ''}</option>`).join('');
    if (!list.length) {
      el.innerHTML = `<option value="">${onlyTracked
        ? 'No stock-tracked products — record an opening balance first'
        : 'Every product is already tracked'}</option>`;
    }
  } catch (err) { handleApiError(err, 'loading products'); }
}

// ── Opening balance ───────────────────────────────────────────────────
function openOpeningStock() {
  stockProductsCache = null;                    // reflect any balance just recorded
  showStockError('opError', '');
  const q = document.getElementById('opQty'); if (q) q.value = '';
  const r = document.getElementById('opRate'); if (r) r.value = '';
  fillProductSelect('opProduct', false);        // only products not yet tracked
  document.getElementById('openingModal').classList.add('active');
}
function closeOpeningStock() { document.getElementById('openingModal').classList.remove('active'); }

async function saveOpeningStock() {
  const productId = (document.getElementById('opProduct') || {}).value;
  const quantity = (document.getElementById('opQty') || {}).value;
  const rate = (document.getElementById('opRate') || {}).value;
  if (!productId) return showStockError('opError', 'Pick a product.');
  if (!(+quantity > 0)) return showStockError('opError', 'Opening quantity must be more than zero.');

  const btn = document.getElementById('opSave');
  btn.disabled = true;
  try {
    await apiFetch('/stock/opening', {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, quantity: +quantity, rate: rate === '' ? null : +rate })
    });
    closeOpeningStock();
    showToast('Opening stock recorded.', 'success');
    stockProductsCache = null;
    await loadStockStats();
    await loadStockSummary();
  } catch (err) {
    showStockError('opError', err && err.message ? err.message : 'Could not record opening stock.');
  } finally { btn.disabled = false; }
}

// ── Adjustment and the other manual movements ─────────────────────────
function openAdjustment() {
  stockProductsCache = null;
  showStockError('adjError', '');
  const q = document.getElementById('adjQty'); if (q) q.value = '';
  const r = document.getElementById('adjReason'); if (r) r.value = '';
  fillProductSelect('adjProduct', true);        // only stock-tracked products
  document.getElementById('adjustModal').classList.add('active');
}
function closeAdjustment() { document.getElementById('adjustModal').classList.remove('active'); }

async function saveAdjustment() {
  const productId = (document.getElementById('adjProduct') || {}).value;
  const type = (document.getElementById('adjType') || {}).value;
  const quantity = (document.getElementById('adjQty') || {}).value;
  const reason = ((document.getElementById('adjReason') || {}).value || '').trim();
  if (!productId) return showStockError('adjError', 'Pick a product.');
  if (!(+quantity > 0)) return showStockError('adjError', 'Quantity must be more than zero.');
  if (!reason) return showStockError('adjError', 'A reason is required — it is the only record of why this moved.');

  const btn = document.getElementById('adjSave');
  btn.disabled = true;
  try {
    await apiFetch('/stock/adjustment', {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, movement_type: type, quantity: +quantity, reason })
    });
    closeAdjustment();
    showToast('Stock movement recorded.', 'success');
    stockProductsCache = null;
    await loadStockStats();
    await loadStockSummary();
  } catch (err) {
    // The server's Insufficient Stock message names the shortfall; show it
    // as it is rather than replacing it with something vaguer.
    showStockError('adjError', err && err.message ? err.message : 'Could not record the movement.');
  } finally { btn.disabled = false; }
}

function showStockError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!message) { el.classList.add('d-none'); el.textContent = ''; return; }
  el.classList.remove('d-none');
  el.textContent = message;
}

// Quantities are DECIMAL(15,3): trailing zeroes are noise on a screen, so
// 10.000 reads as 10 and 0.500 as 0.5, without rounding anything away.
function formatStockQty(v) {
  if (v === null || v === undefined || v === '') return '0';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 1000) / 1000);
}
function escStock(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
