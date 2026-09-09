// Stock Ledger — one product's history, and the movement feed across all of
// them.
//
// Both are paged and filtered server-side. The running balance shown in the
// Balance column is the one recorded on each movement at the time it was
// applied, not a figure this page adds up — so what you read is what the
// stock actually was, even if a later movement was reversed.
let ledgerPage = 0;
let movementsPage = 0;
const LEDGER_PAGE_SIZE = 50;

const MOVEMENT_LABEL = {
  OPENING: 'Opening', PURCHASE: 'Purchase', PURCHASE_RETURN: 'Purchase Return',
  SALE: 'Sale', SALES_RETURN: 'Sales Return',
  ADJUSTMENT_IN: 'Adjustment In', ADJUSTMENT_OUT: 'Adjustment Out',
  DAMAGE: 'Damage', SCRAP: 'Scrap', CONSUMPTION: 'Consumption',
  SAMPLE: 'Sample', FREE_ISSUE: 'Free Issue',
  TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out'
};
// Where a movement's source document lives, so the ledger can link back to
// the thing that caused it.
const SOURCE_PAGE = {
  b2b: 'invoice-list.html', b2c: 'invoice-list.html',
  purchase: 'purchase-list.html', purchase_return: 'purchase-returns.html',
  sales_return: 'sales-returns.html'
};

async function initStockLedgerPage() {
  await Promise.all([fillLedgerProducts(), fillLedgerLocations()]);
  // Deep link from the Stock Summary's ledger button.
  const wanted = new URLSearchParams(location.search).get('product');
  if (wanted) {
    const sel = document.getElementById('ledProduct');
    if (sel && [...sel.options].some(o => o.value === wanted)) {
      sel.value = wanted;
      await loadProductLedger();
    }
  }
  await loadMovements();
}

async function fillLedgerProducts() {
  const el = document.getElementById('ledProduct');
  if (!el) return;
  try {
    const rows = await apiFetch('/products?select=id,name,sku,stock&order=name.asc&limit=1000');
    const tracked = rows.filter(r => r.stock !== null);
    el.innerHTML = '<option value="">Select a product</option>' + tracked.map(r =>
      `<option value="${escLed(r.id)}">${escLed(r.name)}${r.sku ? ' (' + escLed(r.sku) + ')' : ''}</option>`).join('');
    if (!tracked.length) el.innerHTML = '<option value="">No stock-tracked products yet</option>';
  } catch (err) { handleApiError(err, 'loading products'); }
}

// The location filter on the movements feed. Inactive locations are still
// listed: a movement that happened at one is still history worth finding.
async function fillLedgerLocations() {
  const el = document.getElementById('mvLocation');
  if (!el) return;
  try {
    const res = await apiFetch('/stock/locations');
    el.innerHTML = '<option value="">All locations</option>' + res.rows.map(r =>
      `<option value="${escLed(r.id)}">${escLed(r.name)}${r.active ? '' : ' (inactive)'}</option>`).join('');
  } catch (err) {
    // The feed still works without the filter; a missing location list is
    // not a reason to fail the page.
  }
}

// ── One product ───────────────────────────────────────────────────────
async function loadProductLedger() {
  const productId = (document.getElementById('ledProduct') || {}).value;
  const body = document.getElementById('ledgerBody');
  const recon = document.getElementById('ledReconcile');
  if (!body) return;
  if (!productId) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Pick a product to see its ledger.</td></tr>';
    if (recon) recon.innerHTML = '';
    return;
  }
  try {
    const [detail, page] = await Promise.all([
      apiFetch('/stock/' + encodeURIComponent(productId)),
      apiFetch('/stock/' + encodeURIComponent(productId) + '/ledger?limit=' + LEDGER_PAGE_SIZE
        + '&offset=' + (ledgerPage * LEDGER_PAGE_SIZE))
    ]);
    if (recon) recon.innerHTML = reconciliationNote(detail);
    body.innerHTML = page.rows.length
      ? page.rows.map(r => ledgerRow(r, false)).join('')
      : `<tr><td colspan="6" class="text-center text-muted">
           No movements recorded for this product yet.</td></tr>`;
    renderPager('ledgerPagination', page, ledgerPage, 'ledgerGoTo', 'movements');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Could not load the ledger.</td></tr>';
    handleApiError(err, 'loading the stock ledger');
  }
}
function ledgerGoTo(p) { ledgerPage = Math.max(0, p); loadProductLedger(); }

// Says plainly whether the balance and the ledger agree — and, when they do
// not, which of the two situations it is. A product carrying stock from
// before the ledger existed has no history to sum; that is not the same
// fault as a genuine mismatch, and it is not hidden by pretending it is.
function reconciliationNote(detail) {
  const r = detail.reconciliation;
  const qty = (v) => v === null ? '—' : String(Math.round(Number(v) * 1000) / 1000);
  if (r.status === 'NOT_TRACKED') {
    return `<div class="alert alert-info mb-16"><i class="fas fa-info-circle"></i>
      This product is not stock-tracked.</div>`;
  }
  if (r.status === 'RECONCILED') {
    return `<div class="alert alert-success mb-16"><i class="fas fa-circle-check"></i>
      <b>Reconciled.</b> Current stock ${qty(r.cached_stock)} matches the sum of
      ${r.movement_count} ledger movement${r.movement_count === 1 ? '' : 's'}.</div>`;
  }
  if (r.status === 'NO_LEDGER_HISTORY') {
    return `<div class="alert alert-warning mb-16"><i class="fas fa-clock-rotate-left"></i>
      <b>No ledger history.</b> This product carries ${qty(r.cached_stock)} in stock from
      before movements were recorded, so there is nothing to reconcile against yet.
      Recording an opening balance is not possible once movements exist — from the next
      purchase or sale onward, every change will appear here.</div>`;
  }
  return `<div class="alert alert-danger mb-16"><i class="fas fa-triangle-exclamation"></i>
    <b>Does not reconcile.</b> Current stock is ${qty(r.cached_stock)} but the ledger
    sums to ${qty(r.ledger_balance)} — a difference of ${qty(r.difference)}.</div>`;
}

// ── All movements ─────────────────────────────────────────────────────
async function loadMovements() {
  const body = document.getElementById('movementsBody');
  if (!body) return;
  const params = new URLSearchParams();
  const type = (document.getElementById('mvType') || {}).value || '';
  const dir = (document.getElementById('mvDirection') || {}).value || '';
  const loc = (document.getElementById('mvLocation') || {}).value || '';
  const from = (document.getElementById('mvFrom') || {}).value || '';
  const to = (document.getElementById('mvTo') || {}).value || '';
  if (type) params.set('movement_type', type);
  if (dir) params.set('direction', dir);
  if (loc) params.set('location_id', loc);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limit', String(LEDGER_PAGE_SIZE));
  params.set('offset', String(movementsPage * LEDGER_PAGE_SIZE));

  try {
    const page = await apiFetch('/stock/movements?' + params.toString());
    body.innerHTML = page.rows.length
      ? page.rows.map(r => ledgerRow(r, true)).join('')
      : '<tr><td colspan="7" class="text-center text-muted">No movements match these filters.</td></tr>';
    renderPager('movementsPagination', page, movementsPage, 'movementsGoTo', 'movements');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Could not load movements.</td></tr>';
    handleApiError(err, 'loading stock movements');
  }
}
function movementsGoTo(p) { movementsPage = Math.max(0, p); loadMovements(); }

function ledgerRow(r, withProduct) {
  const isIn = r.direction === 'IN';
  const qty = String(Math.round(Number(r.quantity) * 1000) / 1000);
  const bal = String(Math.round(Number(r.balance_after) * 1000) / 1000);
  const label = MOVEMENT_LABEL[r.movement_type] || r.movement_type;
  const page = SOURCE_PAGE[r.source_type];
  // A transfer says where it went, which is the one thing its reason cannot.
  const where = r.movement_type === 'TRANSFER_OUT'
    ? escLed(r.location_name) + ' &rarr; ' + escLed(r.to_location_name)
    : r.movement_type === 'TRANSFER_IN'
      ? escLed(r.to_location_name) + ' &rarr; ' + escLed(r.location_name)
      : (escLed(r.location_name) || '&mdash;');
  const source = r.source_id && page
    ? `<a href="${page}">${escLed(label)} document</a>`
    : escLed(r.reason || '') || '—';
  return `<tr>
    <td>${escLed(formatLedgerDate(r.created_at))}</td>
    ${withProduct ? `<td><b>${escLed(r.product_name)}</b></td>` : ''}
    <td><span class="badge ${isIn ? 'badge-success' : 'badge-danger'}">${escLed(label)}</span></td>
    <td class="text-muted-sm">${where}</td>
    <td class="text-muted-sm">${source}</td>
    <td class="text-right">${isIn ? qty : ''}</td>
    <td class="text-right">${isIn ? '' : qty}</td>
    <td class="text-right"><b>${bal}</b> ${escLed(r.unit) || ''}</td>
  </tr>`;
}

function renderPager(elId, page, current, goFn, noun) {
  const el = document.getElementById(elId);
  if (!el) return;
  const pages = Math.ceil(page.total / LEDGER_PAGE_SIZE) || 1;
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm" ${current === 0 ? 'disabled' : ''}
      onclick="${goFn}(${current - 1})"><i class="fas fa-chevron-left"></i></button>
    <span class="text-muted-sm">Page ${current + 1} of ${pages} — ${page.total} ${noun}</span>
    <button type="button" class="btn btn-secondary btn-sm" ${current + 1 >= pages ? 'disabled' : ''}
      onclick="${goFn}(${current + 1})"><i class="fas fa-chevron-right"></i></button>`;
}

function formatLedgerDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escLed(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
