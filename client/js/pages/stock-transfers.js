// Stock Transfers — move stock between locations.
//
// Every transfer carries a reference this page generates. If a click is
// repeated, or a slow response tempts someone to press again, the server
// recognises the reference and refuses the second one rather than moving
// the stock twice. The disabled button is a courtesy; the reference is the
// actual guarantee.
let trLocations = [];
let trTransferId = null;
let transfersPage = 0;
const TRANSFERS_PAGE_SIZE = 25;

async function initStockTransfers() {
  await Promise.all([loadTransferLocations(), loadTransferProducts()]);
  newTransferReference();
  await loadTransfers();
}

// One reference per attempt. Regenerated only after a transfer succeeds, so
// a retry after a failure reuses it and cannot double-apply.
function newTransferReference() {
  trTransferId = (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

async function loadTransferLocations() {
  try {
    const res = await apiFetch('/stock/locations');
    trLocations = res.rows.filter(r => r.active);
    const opts = '<option value="">Select a location</option>'
      + trLocations.map(r => `<option value="${escTr(r.id)}">${escTr(r.name)}${r.is_default ? ' (default)' : ''}</option>`).join('');
    for (const id of ['trFrom', 'trTo']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = trLocations.length ? opts
        : '<option value="">No active locations — add one first</option>';
    }
  } catch (err) { handleApiError(err, 'loading locations'); }
}

async function loadTransferProducts() {
  const el = document.getElementById('trProduct');
  if (!el) return;
  try {
    const rows = await apiFetch('/products?select=id,name,sku,unit,stock&order=name.asc&limit=1000');
    const tracked = rows.filter(r => r.stock !== null);
    el.innerHTML = '<option value="">Select a product</option>' + tracked.map(r =>
      `<option value="${escTr(r.id)}">${escTr(r.name)}${r.sku ? ' (' + escTr(r.sku) + ')' : ''}</option>`).join('');
    if (!tracked.length) el.innerHTML = '<option value="">No stock-tracked products yet</option>';
  } catch (err) { handleApiError(err, 'loading products'); }
}

// Show where the product actually is, so a transfer is chosen against real
// balances rather than guessed at.
async function loadTransferBalances() {
  const productId = (document.getElementById('trProduct') || {}).value;
  const box = document.getElementById('trBalances');
  if (!box) return;
  if (!productId) { box.innerHTML = ''; onTransferFromChange(); return; }
  try {
    const d = await apiFetch('/stock/' + encodeURIComponent(productId));
    const rows = d.by_location || [];
    box.innerHTML = rows.length
      ? `<div class="mb-16"><b>Currently held:</b> ` + rows.map(r =>
        `<span class="badge badge-secondary">${escTr(r.location)}: ${fmtTr(r.quantity)}</span>`).join(' ')
        + ` &nbsp;<span class="text-muted-sm">Company total ${fmtTr(d.product.stock)}</span></div>`
      : `<div class="alert alert-warning mb-16"><i class="fas fa-info-circle"></i>
           This product has no location balances yet &mdash; its ${fmtTr(d.product.stock)} in stock
           has not been placed. Record an opening balance at a location first.</div>`;
    window._trBalances = rows;
  } catch (err) { box.innerHTML = ''; handleApiError(err, 'loading balances'); }
  onTransferFromChange();
}

function onTransferFromChange() {
  const from = (document.getElementById('trFrom') || {}).value;
  const hint = document.getElementById('trAvailable');
  if (!hint) return;
  const row = (window._trBalances || []).find(r => r.location_id === from);
  hint.textContent = from
    ? (row ? `Available here: ${fmtTr(row.quantity)}` : 'Nothing held at this location')
    : '';
}

async function submitTransfer() {
  const productId = (document.getElementById('trProduct') || {}).value;
  const from = (document.getElementById('trFrom') || {}).value;
  const to = (document.getElementById('trTo') || {}).value;
  const qty = (document.getElementById('trQty') || {}).value;
  const reason = ((document.getElementById('trReason') || {}).value || '').trim();

  if (!productId) return showTrError('Pick a product.');
  if (!from || !to) return showTrError('Pick both a source and a destination.');
  if (from === to) return showTrError('Source and destination must be different locations.');
  if (!(+qty > 0)) return showTrError('Quantity must be more than zero.');

  const btn = document.getElementById('trSave');
  btn.disabled = true;
  showTrError('');
  try {
    await apiFetch('/stock/transfer', {
      method: 'POST',
      body: JSON.stringify({
        product_id: productId, from_location_id: from, to_location_id: to,
        quantity: +qty, reason: reason || null, transfer_id: trTransferId
      })
    });
    showToast('Stock transferred.', 'success');
    // Only now is the reference spent: a failed attempt keeps its reference
    // so a retry is recognised as the same transfer.
    newTransferReference();
    document.getElementById('trQty').value = '';
    document.getElementById('trReason').value = '';
    await Promise.all([loadTransferBalances(), loadTransfers()]);
  } catch (err) {
    showTrError(err && err.message ? err.message : 'Could not transfer the stock.');
  } finally { btn.disabled = false; }
}

async function loadTransfers() {
  const body = document.getElementById('transfersBody');
  if (!body) return;
  try {
    // Only the OUT half is listed: the pair describes one movement of goods,
    // and showing both would read as two transfers.
    const res = await apiFetch('/stock/movements?movement_type=TRANSFER_OUT&limit='
      + TRANSFERS_PAGE_SIZE + '&offset=' + (transfersPage * TRANSFERS_PAGE_SIZE));
    body.innerHTML = res.rows.length
      ? res.rows.map(r => `<tr>
          <td>${escTr(fmtTrDate(r.created_at))}</td>
          <td><b>${escTr(r.product_name)}</b></td>
          <td>${escTr(r.location_name) || '—'}</td>
          <td>${escTr(r.to_location_name) || '—'}</td>
          <td class="text-right">${fmtTr(r.quantity)} ${escTr(r.unit) || ''}</td>
          <td class="text-muted-sm">${escTr(r.reason) || '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-center text-muted">No transfers yet.</td></tr>';

    const el = document.getElementById('transfersPagination');
    const pages = Math.ceil(res.total / TRANSFERS_PAGE_SIZE) || 1;
    el.innerHTML = pages <= 1 ? '' : `
      <button type="button" class="btn btn-secondary btn-sm" ${transfersPage === 0 ? 'disabled' : ''}
        onclick="transfersGoTo(${transfersPage - 1})"><i class="fas fa-chevron-left"></i></button>
      <span class="text-muted-sm">Page ${transfersPage + 1} of ${pages} — ${res.total} transfers</span>
      <button type="button" class="btn btn-secondary btn-sm" ${transfersPage + 1 >= pages ? 'disabled' : ''}
        onclick="transfersGoTo(${transfersPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Could not load transfers.</td></tr>';
    handleApiError(err, 'loading transfers');
  }
}
function transfersGoTo(p) { transfersPage = Math.max(0, p); loadTransfers(); }

function showTrError(message) {
  const el = document.getElementById('trError');
  if (!el) return;
  if (!message) { el.classList.add('d-none'); el.textContent = ''; return; }
  el.classList.remove('d-none');
  el.textContent = message;
}
function fmtTr(v) {
  if (v === null || v === undefined || v === '') return '0';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
}
function fmtTrDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escTr(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
