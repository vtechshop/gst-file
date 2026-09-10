// Serial Numbers — every individually tracked unit, and what has happened
// to it.
//
// Every number on this page is computed by the server. The browser filters
// nothing and counts nothing itself: a serial register runs to one row per
// unit ever bought, and the classification of a unit is the server's to
// make so the list, the detail panel and the stock module cannot disagree.
let snPage = 0;
const SN_PAGE_SIZE = 50;
let snDebounceTimer = null;
let snProductsCache = null;

const SN_STATUS_LABEL = {
  AVAILABLE: { text: 'Available', cls: 'badge-success' },
  SOLD: { text: 'Sold', cls: 'badge-secondary' },
  RETURNED: { text: 'Returned', cls: 'badge-warning' },
  RETURNED_TO_SUPPLIER: { text: 'Returned to supplier', cls: 'badge-secondary' },
  DAMAGED: { text: 'Damaged', cls: 'badge-danger' },
  SCRAPPED: { text: 'Scrapped', cls: 'badge-dark' }
};

// What a person may do to a unit in each state. The server decides the
// same thing from its own transition table; this only decides which
// buttons to draw, so nobody is offered an action that will be refused.
const SN_ACTIONS = {
  AVAILABLE: [{ to: 'DAMAGED', label: 'Mark damaged', cls: 'btn-danger' }],
  SOLD: [],
  RETURNED: [
    { to: 'AVAILABLE', label: 'Inspected — back to stock', cls: 'btn-success' },
    { to: 'DAMAGED', label: 'Inspected — damaged', cls: 'btn-danger' }
  ],
  DAMAGED: [
    { to: 'AVAILABLE', label: 'Repaired', cls: 'btn-success' },
    { to: 'SCRAPPED', label: 'Scrap', cls: 'btn-danger' }
  ],
  SCRAPPED: [],
  // Gone back to where it was bought. Not ours to sell, move or scrap.
  RETURNED_TO_SUPPLIER: []
};

function escSn(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function snQty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0';
}
function snDate(v) {
  return v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
}
function snDebouncedReload() {
  clearTimeout(snDebounceTimer);
  snDebounceTimer = setTimeout(() => { snPage = 0; loadSerials(); }, 300);
}

async function initStockSerials() {
  await snLoadFilters();
  await loadSerials();
}

// The product filter lists only products that are actually serial-tracked,
// because filtering by one that never has serials would always be empty.
async function snLoadFilters() {
  const sel = document.getElementById('snProduct');
  if (!sel) return;
  try {
    const rows = await apiFetch('/products?select=id,name,serial_tracking&order=name.asc');
    snProductsCache = (rows || []).filter(r => r.serial_tracking);
    sel.innerHTML = '<option value="">All products</option>'
      + snProductsCache.map(r => `<option value="${escSn(r.id)}">${escSn(r.name)}</option>`).join('');
  } catch (err) {
    handleApiError(err, 'loading the product list');
  }
  const loc = document.getElementById('snLocation');
  if (!loc) return;
  try {
    const { rows } = await apiFetch('/stock/locations');
    loc.innerHTML = '<option value="">All locations</option>'
      + (rows || []).map(r => `<option value="${escSn(r.id)}">${escSn(r.name)}</option>`).join('');
  } catch (err) {
    handleApiError(err, 'loading locations');
  }
}

async function loadSerials() {
  const body = document.getElementById('snTableBody');
  if (!body) return;
  const params = new URLSearchParams();
  const q = (document.getElementById('snSearch') || {}).value || '';
  const status = (document.getElementById('snStatus') || {}).value || '';
  const product = (document.getElementById('snProduct') || {}).value || '';
  const location = (document.getElementById('snLocation') || {}).value || '';
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  if (product) params.set('product_id', product);
  if (location) params.set('location_id', location);
  params.set('limit', String(SN_PAGE_SIZE));
  params.set('offset', String(snPage * SN_PAGE_SIZE));

  body.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Loading&hellip;</td></tr>';
  try {
    const res = await apiFetch('/stock/serials?' + params.toString());
    const rows = res.rows || [];
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty-state">
        <i class="fas fa-barcode" style="display:block;font-size:34px;margin-bottom:8px;"></i>
        No serial numbers yet. Turn on Serial Tracking for a product, then record a purchase
        for it &mdash; the units appear here.</td></tr>`;
    } else {
      body.innerHTML = rows.map(r => {
        const badge = SN_STATUS_LABEL[r.status] || { text: r.status, cls: 'badge-secondary' };
        return `<tr>
          <td><button type="button" class="btn-link fw-600" onclick="openSerial('${escSn(r.id)}')">${escSn(r.serial_no)}</button></td>
          <td>${escSn(r.product_name)}${r.product_sku ? `<div class="fs-11 text-muted-sm">${escSn(r.product_sku)}</div>` : ''}</td>
          <td><span class="badge ${badge.cls}">${badge.text}</span></td>
          <td>${escSn(r.location_name || '&mdash;')}</td>
          <td>${escSn(r.source_type === 'purchase' ? 'Purchase' : (r.source_type || '&mdash;'))}</td>
          <td>${r.sold_source_type ? escSn(r.sold_source_type.toUpperCase()) : '&mdash;'}</td>
          <td>${snDate(r.created_at)}</td>
        </tr>`;
      }).join('');
    }
    snRenderPaging(res.total || 0);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-danger">Could not load serial numbers.</td></tr>';
    handleApiError(err, 'loading serial numbers');
  }
}

function snRenderPaging(total) {
  const el = document.getElementById('snPagination');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / SN_PAGE_SIZE));
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm" ${snPage === 0 ? 'disabled' : ''}
      onclick="snGoTo(${snPage - 1})">Previous</button>
    <span class="fs-13">Page ${snPage + 1} of ${pages} &mdash; ${total} serial${total === 1 ? '' : 's'}</span>
    <button type="button" class="btn btn-secondary btn-sm" ${snPage + 1 >= pages ? 'disabled' : ''}
      onclick="snGoTo(${snPage + 1})">Next</button>`;
}
function snGoTo(page) { snPage = Math.max(0, page); loadSerials(); }

// ── One unit ──────────────────────────────────────────────────────────
let snCurrent = null;

async function openSerial(id) {
  try {
    const res = await apiFetch('/stock/serials/' + encodeURIComponent(id));
    snCurrent = res;
    const s = res.serial;
    const badge = SN_STATUS_LABEL[s.status] || { text: s.status, cls: 'badge-secondary' };
    const row = (label, value) => value
      ? `<div class="detail-row"><span class="detail-label">${label}</span><span>${value}</span></div>` : '';

    document.getElementById('snDetailTitle').innerHTML =
      `${escSn(s.serial_no)} <span class="badge ${badge.cls}">${badge.text}</span>`;
    document.getElementById('snDetailBody').innerHTML =
      row('Product', escSn(s.product_name))
      + row('SKU', escSn(s.product_sku))
      + row('Location', escSn(s.location_name))
      + row('Received on', snDate(s.created_at))
      + row('Warranty', res.warranty
        ? `${escSn(res.warranty.warranty_number)} (${escSn(res.warranty.status)})` : '')
      + row('Notes', escSn(s.notes))
      + (res.timeline.length
        ? `<div class="mt-16"><div class="fw-600 mb-8">Timeline</div>${res.timeline.map(m => `
            <div class="mini-list-row">
              <span>${escSn(m.movement_type.replace(/_/g, ' '))}${m.location_name
                ? ` &mdash; ${escSn(m.location_name)}` : ''}${m.reason ? `<div class="fs-11 text-muted-sm">${escSn(m.reason)}</div>` : ''}</span>
              <b>${snDate(m.created_at)}</b>
            </div>`).join('')}</div>`
        : '<p class="text-muted-sm mt-16">No stock movements recorded against this unit yet.</p>');

    // Only the transitions this unit can actually make.
    const actions = (SN_ACTIONS[s.status] || []).filter(
      a => (res.allowed_transitions || []).includes(a.to));
    const canMove = ['AVAILABLE', 'RETURNED', 'DAMAGED'].includes(s.status) && s.location_id;
    document.getElementById('snDetailActions').innerHTML =
      actions.map(a => `<button type="button" class="btn ${a.cls} btn-sm"
        onclick="snSetStatus('${escSn(s.id)}','${a.to}')">${a.label}</button>`).join('')
      + (canMove ? `<button type="button" class="btn btn-secondary btn-sm"
          onclick="snOpenTransfer()"><i class="fas fa-right-left"></i> Move</button>` : '')
      + (actions.length || canMove ? '' : '<span class="text-muted-sm">No further action for this unit.</span>');

    document.getElementById('snDetailModal')?.classList.add('open');
    lockBodyScroll();
  } catch (err) {
    handleApiError(err, 'loading the serial');
  }
}

function closeSerialDetail() {
  document.getElementById('snDetailModal')?.classList.remove('open');
  unlockBodyScroll();
  snCurrent = null;
}

async function snSetStatus(id, status) {
  const reason = status === 'SCRAPPED' || status === 'DAMAGED'
    ? prompt(status === 'SCRAPPED' ? 'Why is this unit being scrapped?' : 'What is wrong with it?') : null;
  if ((status === 'SCRAPPED' || status === 'DAMAGED') && reason === null) return;
  try {
    await apiFetch('/stock/serials/' + encodeURIComponent(id) + '/status', {
      method: 'POST', body: JSON.stringify({ status, reason })
    });
    showToast('Serial updated.', 'success');
    closeSerialDetail();
    await loadSerials();
  } catch (err) {
    handleApiError(err, 'updating the serial');
  }
}

async function snOpenTransfer() {
  if (!snCurrent) return;
  try {
    const { rows } = await apiFetch('/stock/locations');
    const options = (rows || []).filter(r => r.id !== snCurrent.serial.location_id && r.active);
    if (!options.length) { showToast('There is nowhere else to move it to.', 'warning'); return; }
    const list = options.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
    const pick = prompt(`Move ${snCurrent.serial.serial_no} to:\n\n${list}\n\nEnter a number:`);
    if (pick === null) return;
    const chosen = options[parseInt(pick, 10) - 1];
    if (!chosen) { showToast('That is not one of the locations.', 'error'); return; }
    await apiFetch('/stock/serials/' + encodeURIComponent(snCurrent.serial.id) + '/transfer', {
      method: 'POST', body: JSON.stringify({ to_location_id: chosen.id })
    });
    showToast(`Moved to ${chosen.name}.`, 'success');
    closeSerialDetail();
    await loadSerials();
  } catch (err) {
    handleApiError(err, 'moving the serial');
  }
}

// ── Reconciliation ────────────────────────────────────────────────────
// Reports a disagreement between the two accounts; never corrects one.
async function snReconcile() {
  try {
    const res = await apiFetch('/stock/serials/reconcile');
    const off = (res.rows || []).filter(r => !r.balanced);
    if (!off.length) {
      showToast('Every serialised product agrees with its stock balance.', 'success');
      return;
    }
    const lines = off.map(r =>
      `${r.product_name}: stock ${snQty(r.balance_quantity)}, units held ${r.held_serials}`).join('\n');
    alert('These products do not reconcile:\n\n' + lines
      + '\n\nNothing has been changed. A difference means something happened that neither '
      + 'account explains, and correcting one to match the other would hide it.');
  } catch (err) {
    handleApiError(err, 'reconciling serials');
  }
}
