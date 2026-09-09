// Purchase Orders list.
//
// Every figure in the Ordered / Received / Pending columns is aggregated by
// Postgres and arrives with the row. The browser sums nothing and pages
// nothing itself: a business with three thousand orders must not have to
// download three thousand orders to look at twenty.
let poPage = 0;
const PO_PAGE_SIZE = 25;
let poDebounceTimer = null;
let poReceiveOrder = null;

const PO_LIST_STATUS = {
  DRAFT: ['Draft', 'badge-secondary'],
  SENT: ['Sent', 'badge-info'],
  CONFIRMED: ['Confirmed', 'badge-green'],
  PARTIALLY_RECEIVED: ['Partially received', 'badge-warning'],
  FULLY_RECEIVED: ['Fully received', 'badge-success'],
  CANCELLED: ['Cancelled', 'badge-danger'],
  CLOSED: ['Closed', 'badge-secondary']
};

async function initPurchaseOrderList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  await loadPurchaseOrders();
}

function poDebouncedReload() {
  clearTimeout(poDebounceTimer);
  poDebounceTimer = setTimeout(() => { poPage = 0; loadPurchaseOrders(); }, 300);
}
function poReload() { poPage = 0; loadPurchaseOrders(); }
function poGoTo(p) { poPage = Math.max(0, p); loadPurchaseOrders(); }

async function loadPurchaseOrders() {
  const body = document.getElementById('poListBody');
  if (!body) return;
  const params = new URLSearchParams();
  const val = id => (document.getElementById(id) || {}).value || '';
  if (val('poSearch').trim()) params.set('q', val('poSearch').trim());
  if (val('poStatus')) params.set('status', val('poStatus'));
  if (val('poFrom')) params.set('from', val('poFrom'));
  if (val('poTo')) params.set('to', val('poTo'));
  if (val('poDeliveryFrom')) params.set('delivery_from', val('poDeliveryFrom'));
  if (val('poDeliveryTo')) params.set('delivery_to', val('poDeliveryTo'));
  if (val('poPending')) params.set('pending', '1');
  params.set('limit', String(PO_PAGE_SIZE));
  params.set('offset', String(poPage * PO_PAGE_SIZE));

  try {
    const res = await apiFetch('/purchase-orders?' + params.toString());
    body.innerHTML = res.rows.length
      ? res.rows.map(poRow).join('')
      : `<tr><td colspan="10" class="text-center text-muted">
           ${params.toString().includes('q=') || val('poStatus')
    ? 'No purchase orders match these filters.'
    : 'No purchase orders yet. Raise one to order goods from a vendor.'}
         </td></tr>`;
    renderPoPagination(res);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="10" class="text-center text-muted">Could not load purchase orders.</td></tr>';
    handleApiError(err, 'loading purchase orders');
  }
}

function poRow(r) {
  const [label, cls] = PO_LIST_STATUS[r.status] || [r.status, 'badge-secondary'];
  const qty = v => String(Math.round(Number(v) * 1000) / 1000);
  const pending = Number(r.pending_quantity);
  const canReceive = ['CONFIRMED', 'SENT', 'PARTIALLY_RECEIVED'].includes(r.status) && pending > 0;
  const canCancel = ['DRAFT', 'SENT', 'CONFIRMED'].includes(r.status);
  const id = escPoList(r.id);
  return `<tr>
    <td><b>${escPoList(r.document_number)}</b></td>
    <td>${escPoList(formatDate(r.document_date))}</td>
    <td>${escPoList(r.vendor_name)}</td>
    <td>${r.expected_delivery_date ? escPoList(formatDate(r.expected_delivery_date)) : '&mdash;'}</td>
    <td class="text-right">&#8377;${formatNum(r.total_amount)}</td>
    <td class="text-right">${qty(r.ordered_quantity)}</td>
    <td class="text-right">${qty(r.received_quantity)}</td>
    <td class="text-right${pending > 0 ? ' text-warning' : ''}"><b>${qty(pending)}</b></td>
    <td><span class="badge ${cls}">${label}</span></td>
    <td class="text-right">
      <a class="btn btn-secondary btn-sm btn-icon" href="purchase-order.html?id=${id}" title="View / Edit"><i class="fas fa-pen"></i></a>
      <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="poPdf('${id}')" title="PDF"><i class="fas fa-file-pdf"></i></button>
      <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="poPrint('${id}')" title="Print"><i class="fas fa-print"></i></button>
      ${canReceive ? `<button type="button" class="btn btn-primary btn-sm btn-icon" onclick="openPoReceive('${id}')" title="Receive goods"><i class="fas fa-truck-ramp-box"></i></button>` : ''}
      ${canCancel ? `<button type="button" class="btn btn-danger btn-sm btn-icon" onclick="poCancel('${id}')" title="Cancel"><i class="fas fa-ban"></i></button>` : ''}
    </td>
  </tr>`;
}

function renderPoPagination(res) {
  const el = document.getElementById('poPagination');
  if (!el) return;
  const pages = Math.ceil(res.total / PO_PAGE_SIZE) || 1;
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm" ${poPage === 0 ? 'disabled' : ''}
      onclick="poGoTo(${poPage - 1})"><i class="fas fa-chevron-left"></i></button>
    <span class="text-muted-sm">Page ${poPage + 1} of ${pages} &mdash; ${res.total} orders</span>
    <button type="button" class="btn btn-secondary btn-sm" ${poPage + 1 >= pages ? 'disabled' : ''}
      onclick="poGoTo(${poPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
}

// ── PDF / print ───────────────────────────────────────────────────────
async function poFetch(id) {
  try { return await apiFetch('/purchase-orders/' + encodeURIComponent(id)); }
  catch (err) { handleApiError(err, 'loading the purchase order'); return null; }
}
async function poPdf(id) {
  const r = await poFetch(id);
  if (r) generatePurchaseOrderPDF(r.order, r.items, 'save');
}
async function poPrint(id) {
  const r = await poFetch(id);
  if (r) generatePurchaseOrderPDF(r.order, r.items, 'print');
}

// ── cancel ────────────────────────────────────────────────────────────
async function poCancel(id) {
  const reason = window.prompt('Cancel this purchase order?\n\nReason (optional):');
  if (reason === null) return;
  try {
    await apiFetch(`/purchase-orders/${encodeURIComponent(id)}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'CANCELLED', reason })
    });
    showToast('Purchase order cancelled.', 'success');
    loadPurchaseOrders();
  } catch (err) {
    // The server refuses to cancel an order that has already received
    // goods; it says so, and that message is the useful one.
    handleApiError(err, 'cancelling the purchase order');
  }
}

// ── receive ───────────────────────────────────────────────────────────
async function openPoReceive(id) {
  const data = await poFetch(id);
  if (!data) return;
  poReceiveOrder = data;
  document.getElementById('poReceiveNumber').textContent = data.order.document_number;
  showPoReceiveError('');
  document.getElementById('poReceiveNum').value = '';
  document.getElementById('poReceiveDate').value = toISO(new Date());

  const qty = v => String(Math.round(Number(v) * 1000) / 1000);
  document.getElementById('poReceiveBody').innerHTML = data.items.map(i => {
    const pending = Number(i.pending_quantity);
    return `<tr>
      <td><b>${escPoList(i.product_name)}</b><div class="text-muted-sm">${escPoList(i.hsn_code) || ''}</div></td>
      <td class="text-right">${qty(i.quantity)}</td>
      <td class="text-right">${qty(i.received_quantity)}</td>
      <td class="text-right"><b>${qty(pending)}</b></td>
      <td class="text-right">
        <input type="number" class="form-control text-right" style="max-width:120px;margin-left:auto"
               id="poRecv_${escPoList(i.id)}" min="0" max="${pending}" step="0.001"
               value="${pending}" ${pending <= 0 ? 'disabled' : ''}>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('poReceiveModal').classList.add('active');
}
function closePoReceive() {
  document.getElementById('poReceiveModal').classList.remove('active');
  poReceiveOrder = null;
}
function showPoReceiveError(message) {
  const el = document.getElementById('poReceiveError');
  if (!el) return;
  if (!message) { el.classList.add('d-none'); el.textContent = ''; return; }
  el.classList.remove('d-none');
  el.textContent = message;
}

async function submitPoReceive() {
  if (!poReceiveOrder) return;
  const number = (document.getElementById('poReceiveNum').value || '').trim();
  const date = (document.getElementById('poReceiveDate').value || '').trim();
  if (!number) return showPoReceiveError('A purchase number is required.');
  if (!date) return showPoReceiveError('A purchase date is required.');

  const lines = [];
  for (const i of poReceiveOrder.items) {
    const el = document.getElementById('poRecv_' + i.id);
    const q = el ? Number(el.value) : 0;
    if (!(q > 0)) continue;
    if (q > Number(i.pending_quantity)) {
      return showPoReceiveError(`"${i.product_name}" has only ${i.pending_quantity} left to receive.`);
    }
    lines.push({ item_id: i.id, quantity: q });
  }
  if (!lines.length) return showPoReceiveError('Enter a quantity for at least one line.');

  const btn = document.getElementById('poReceiveSave');
  btn.disabled = true;
  try {
    const res = await apiFetch(`/purchase-orders/${encodeURIComponent(poReceiveOrder.order.id)}/receive`, {
      method: 'POST',
      body: JSON.stringify({ purchase_number: number, purchase_date: date, lines })
    });
    closePoReceive();
    showToast(`Goods received. Purchase ${number} created and stock updated.`, 'success');
    if (res.status === 'FULLY_RECEIVED') showToast('This order is now fully received.', 'info');
    loadPurchaseOrders();
  } catch (err) {
    // Over-receipt, a duplicate purchase number and a lost race all land
    // here with the server's own sentence, which is more useful than a
    // generic failure.
    showPoReceiveError(err && err.message ? err.message : 'Could not receive the goods.');
  } finally {
    btn.disabled = false;
  }
}

function escPoList(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', initPurchaseOrderList);
