// =============================================
// Warranty Register - list, manual create, edit
// =============================================
// A master list in its own right. A warranty reaches it two ways, and both
// have to keep working:
//
//   A. automatically, when an invoice carrying cover is saved
//      (server/src/services/warranty-sync.js), and
//   B. by hand, from the + Add Warranty button on this page, without opening
//      Invoice Entry at all.
//
// Everything shown here comes from the warranties table on every load, never
// from localStorage or a cached array, which is what makes a row survive a
// refresh, a logout and a different browser.
//
// The create form reads b2b_invoices/b2c_invoices/invoice_items only to offer
// real choices. It is NOT what authorises the save: the server re-reads the
// invoice and the line under the caller's own user_id and copies the customer
// and product from those rows, so nothing this page sends can invent an
// invoice number or attach a product that was never sold on it. See
// server/src/routes/warranties.js.
//
// The list itself is read from GET /api/warranties/search - one endpoint for
// the searched and unsearched case alike, so there is a single place that
// decides what a search term matches and a single place that decides whose
// warranties these are. It scopes on the user_id in the verified JWT, never
// on anything this page could send, so one company's warranties are
// invisible to another.
let warrantyRows = [];
let warrantyPage = 1;
const WARRANTY_PAGE_SIZE = 15;

// 'loading' | 'ready' | 'error'. Kept as its own state because an empty array
// and a failed request are different facts about the register, and rendering
// "No warranties yet" for a failure would tell the user their records are
// gone when the truth is that we could not read them.
let warrantyListState = 'loading';

// Sources for the create form's cascade, loaded on first open rather than on
// page load: the list must render even for someone who never opens the form.
let wrInvoices = null;
let wrItems = [];
let wrEditing = null;
let wrSaving = false;

async function initWarrantyList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const filter = document.getElementById('wrStatusFilter');
  if (filter) {
    // Expired is offered even though it is never stored: it is derived per
    // row, and it is the thing a person most often comes here to look for.
    filter.innerHTML = '<option value="">All</option>'
      + WARRANTY_STATUSES.concat(['expired']).map(s =>
          `<option value="${escHtmlAttr(s)}">${escItemHtml(WARRANTY_STATUS_LABELS[s])}</option>`).join('');
  }
  // Arriving from an invoice's View action: show that invoice's warranties
  // rather than making the user search for them.
  const params = new URLSearchParams(window.location.search);
  const wanted = params.get('invoice');
  const box = document.getElementById('wrSearch');
  if (wanted && box) box.value = wanted;

  populateWarrantySelect('wrFormPeriod', '');

  await loadWarranties();

  // Deep link from the Warranty Details page's Edit button, so the one editor
  // lives here rather than being written a second time on that page.
  const editId = params.get('edit');
  if (editId) openEditWarranty(editId);
}

function warrantySearchTerm() {
  return (document.getElementById('wrSearch')?.value || '').trim();
}

// The one read this page performs, searched or not. The term goes to the
// server (GET /api/warranties/search), so a customer name or a mobile number
// is matched against every persisted row rather than only the rows this
// browser happens to be holding - and the answer is the same after a reload.
// Ownership is decided there from the verified JWT; nothing this page sends
// says who the caller is.
async function loadWarranties() {
  const q = warrantySearchTerm();
  warrantyListState = 'loading';
  renderWarrantyList();
  try {
    const rows = await apiFetch('/warranties/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
    // Already ordered by the server; the browser does not re-sort it.
    warrantyRows = rows || [];
    warrantyListState = 'ready';
  } catch (err) {
    // The rows already on screen are not replaced with an empty array: a
    // failed request must not look like a register that lost its records,
    // and must never be rendered as "no warranties".
    warrantyListState = 'error';
    handleApiError(err, 'Could not load Warranty List');
  }
  renderWarrantyList();
}

async function reloadWarranties() { await loadWarranties(); }

// Typing now costs a request, so the keystrokes are allowed to settle first.
// The Invoice List filters an already-loaded array and needs no such wait;
// this searches the database, which is what lets it find a row that was
// never loaded.
let wrSearchTimer = null;
const WARRANTY_SEARCH_DEBOUNCE_MS = 250;
function onWarrantySearchInput() {
  clearTimeout(wrSearchTimer);
  wrSearchTimer = setTimeout(() => {
    warrantyPage = 1;
    loadWarranties();
  }, WARRANTY_SEARCH_DEBOUNCE_MS);
}

// Status only. The search itself is the server's job (see loadWarranties), so
// there is exactly one place that decides what matches a search term; status
// stays here because 'expired' is derived from the date when the row is read
// rather than stored.
function warrantyMatchesFilters(row) {
  const want = document.getElementById('wrStatusFilter')?.value || '';
  if (want && warrantyEffectiveStatus(row) !== want) return false;
  return true;
}

function warrantyStatusBadge(row) {
  const st = warrantyEffectiveStatus(row);
  const cls = st === 'active' ? 'badge-green' : st === 'expired' ? 'badge-red' : 'badge-grey';
  return `<span class="badge ${cls}">${escItemHtml(WARRANTY_STATUS_LABELS[st])}</span>`;
}

// Where a record came from, derived rather than stored: the automatic path
// always records the invoice line it registered, and a hand-made record has
// no single line behind it. Shown because "who entered this" is the first
// question asked of a register, and never sent to the public endpoint.
function warrantySource(row) {
  return row.invoice_item_id ? 'invoice_auto' : 'manual';
}

function renderWarrantyList() {
  const body = document.getElementById('wrTableBody');
  if (!body) return;

  if (warrantyListState === 'loading') {
    body.innerHTML = '<tr><td colspan="10" class="text-center text-muted-sm">Loading warranties&hellip;</td></tr>';
    renderWarrantyPagination(0);
    return;
  }
  if (warrantyListState === 'error') {
    body.innerHTML = '<tr><td colspan="10" class="text-center">'
      + '<div class="mb-8">Could not load Warranty List. Please try again.</div>'
      + '<button type="button" class="btn btn-secondary btn-sm" onclick="reloadWarranties()">'
      + '<i class="fas fa-rotate-right"></i> Retry</button></td></tr>';
    renderWarrantyPagination(0);
    return;
  }

  const rows = warrantyRows.filter(warrantyMatchesFilters);
  const start = (warrantyPage - 1) * WARRANTY_PAGE_SIZE;
  const page = rows.slice(start, start + WARRANTY_PAGE_SIZE);

  if (!page.length) {
    // Only ever reached with a successful read behind it. "Nothing matched"
    // and "nothing exists" are told apart by whether anything was ASKED for,
    // not by the row count: the server now returns no rows for a search that
    // matched nothing, and calling that an empty register would be a lie.
    const asked = !!warrantySearchTerm() || !!document.getElementById('wrStatusFilter')?.value;
    body.innerHTML = '<tr><td colspan="10" class="text-center text-muted-sm">'
      + (asked
          ? 'No warranties match this search or status.'
          : 'No warranties yet. Use <b>+ Add Warranty</b> to register one, or save an '
            + 'invoice with a warranty period on a product line.')
      + '</td></tr>';
    renderWarrantyPagination(rows.length);
    return;
  }

  body.innerHTML = page.map((r, i) => {
    const until = r.extended_until || r.warranty_until;
    const left = warrantyDaysRemaining(r);
    const st = warrantyEffectiveStatus(r);
    return `<tr>
      <td>${start + i + 1}</td>
      <td><b>${escItemHtml(r.warranty_number || '')}</b>${warrantySource(r) === 'manual'
        ? '<div class="fs-11 text-muted-sm">Manual</div>' : ''}</td>
      <td>${escItemHtml(r.customer_name || '')}</td>
      <td>${escItemHtml(r.product_name || '')}${r.serial_number
        ? `<div class="fs-11 text-muted-sm">SN: ${escItemHtml(r.serial_number)}</div>` : ''}</td>
      <td>${escItemHtml(r.invoice_number || '')}</td>
      <td>${r.purchase_date ? escItemHtml(formatDate(r.purchase_date)) : '<span class="text-muted-sm">&mdash;</span>'}</td>
      <td>${escItemHtml(warrantyLabel(r.warranty_period_months) || '—')}</td>
      <td>${until ? escItemHtml(formatDate(until)) : '<span class="text-muted-sm">&mdash;</span>'}
        ${st === 'active' && left !== null && left <= 30
          ? `<div class="fs-11 text-muted-sm">${left} day${left === 1 ? '' : 's'} left</div>` : ''}</td>
      <td>${warrantyStatusBadge(r)}</td>
      <td>
        <div class="d-flex gap-8">
          <a class="btn btn-secondary btn-sm btn-icon" href="warranty.html?id=${encodeURIComponent(r.id)}" title="View"><i class="fas fa-eye"></i></a>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="openWarrantyQr('${r.id}')" title="QR code"><i class="fas fa-qrcode"></i></button>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="writeWarrantyNfcFor('${r.id}')" title="Write NFC"><i class="fas fa-wifi"></i></button>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="openEditWarranty('${r.id}')" title="Edit"><i class="fas fa-pen"></i></button>
          ${st !== 'cancelled'
            ? `<button type="button" class="btn btn-danger btn-sm btn-icon" onclick="cancelWarranty('${r.id}')" title="Cancel"><i class="fas fa-ban"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
  renderWarrantyPagination(rows.length);
}

function renderWarrantyPagination(total) {
  const el = document.getElementById('wrPagination');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / WARRANTY_PAGE_SIZE));
  if (pages === 1) { el.innerHTML = ''; return; }
  let out = '';
  for (let p = 1; p <= pages; p++) {
    out += `<button type="button" class="btn btn-sm ${p === warrantyPage ? 'btn-primary' : 'btn-secondary'}" onclick="gotoWarrantyPage(${p})">${p}</button>`;
  }
  el.innerHTML = out;
}

function gotoWarrantyPage(p) { warrantyPage = p; renderWarrantyList(); }

// ── Create / edit ──────────────────────────────────
// One form serves both. In edit mode the customer, the invoice and the
// product are shown but not changeable, because the server refuses to move a
// warranty onto different goods - the record would then describe a sale that
// never happened.

function wrForm(id) { return document.getElementById(id); }
// The app opens a .modal-overlay by adding 'open' (see css/style.css and
// core/search.js); there is no shared helper, so these are the local two.
function wrOpenModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
function wrCloseModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
function wrVal(id) { const el = wrForm(id); return el ? el.value : ''; }
function wrSet(id, v) { const el = wrForm(id); if (el) el.value = v == null ? '' : v; }

async function openAddWarranty() {
  wrEditing = null;
  const modal = wrForm('wrFormModal');
  if (!modal) return;
  wrForm('wrFormTitle').innerHTML = '<i class="fas fa-shield-halved"></i> Add Warranty';
  wrForm('wrFormLinked').classList.remove('d-none');
  wrForm('wrFormLockedNote').classList.add('d-none');
  ['wrFormSerial', 'wrFormQty', 'wrFormStart', 'wrFormUntil', 'wrFormTerms'].forEach(id => wrSet(id, ''));
  populateWarrantySelect('wrFormPeriod', '');
  wrSet('wrFormCustomer', '');
  wrForm('wrFormInvoice').innerHTML = '<option value="">Select a customer first</option>';
  wrForm('wrFormProduct').innerHTML = '<option value="">Select an invoice first</option>';
  wrItems = [];
  wrOpenModal('wrFormModal');
  await wrLoadInvoices();
}

async function openEditWarranty(id) {
  const r = warrantyRows.find(x => x.id === id);
  if (!r) { showToast('That warranty is no longer in the list.', 'error'); return; }
  wrEditing = r;
  wrForm('wrFormTitle').innerHTML = '<i class="fas fa-pen"></i> Edit ' + escItemHtml(r.warranty_number || 'Warranty');
  // The cascade is hidden entirely rather than disabled: an invoice picker
  // that cannot change anything is a control that lies about what it does.
  wrForm('wrFormLinked').classList.add('d-none');
  const note = wrForm('wrFormLockedNote');
  note.classList.remove('d-none');
  note.innerHTML = `<i class="fas fa-lock"></i> ${escItemHtml(r.customer_name || '')}
    &middot; ${escItemHtml(r.product_name || '')}
    &middot; Invoice ${escItemHtml(r.invoice_number || '—')}
    <div class="fs-11 text-muted-sm mt-8">Customer, invoice and product come from the saved
    invoice and cannot be changed here. The warranty number stays ${escItemHtml(r.warranty_number || '')}.</div>`;
  wrSet('wrFormSerial', r.serial_number || '');
  wrSet('wrFormQty', r.quantity == null ? '' : r.quantity);
  populateWarrantySelect('wrFormPeriod', r.warranty_period_months);
  wrSet('wrFormStart', r.warranty_start_date ? String(r.warranty_start_date).slice(0, 10) : '');
  wrSet('wrFormUntil', r.warranty_until ? String(r.warranty_until).slice(0, 10) : '');
  wrSet('wrFormTerms', r.warranty_terms || '');
  wrOpenModal('wrFormModal');
}

function closeWarrantyForm() { wrCloseModal('wrFormModal'); }

// Offers only invoices this user actually has. The server validates the
// choice again on save; this is convenience, not authorisation.
async function wrLoadInvoices() {
  const sel = wrForm('wrFormCustomer');
  if (!sel) return;
  if (wrInvoices) { wrRenderCustomers(); return; }
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const user = await getCurrentUser();
    if (!user) return;
    const [b2b, b2c] = await Promise.all([
      _supabase.from('b2b_invoices').select('*').eq('user_id', user.id),
      _supabase.from('b2c_invoices').select('*').eq('user_id', user.id)
    ]);
    if (b2b && b2b.error) throw b2b.error;
    if (b2c && b2c.error) throw b2c.error;
    wrInvoices = []
      .concat((b2b.data || []).map(r => ({ ...r, invoice_type: 'b2b' })))
      .concat((b2c.data || []).map(r => ({ ...r, invoice_type: 'b2c' })))
      .sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
    wrRenderCustomers();
  } catch (err) {
    wrInvoices = null;
    sel.innerHTML = '<option value="">Could not load invoices</option>';
    handleApiError(err, 'Could not load invoices');
  }
}

function wrRenderCustomers() {
  const sel = wrForm('wrFormCustomer');
  if (!sel) return;
  // Built from the invoices themselves, so every customer offered is
  // guaranteed to lead to at least one real invoice.
  const names = [...new Set((wrInvoices || [])
    .map(r => String(r.customer_name || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Select a customer</option>'
    + names.map(n => `<option value="${escHtmlAttr(n)}">${escItemHtml(n)}</option>`).join('');
  if (!names.length) sel.innerHTML = '<option value="">No invoices found</option>';
}

function wrOnCustomerChange() {
  const name = wrVal('wrFormCustomer');
  const sel = wrForm('wrFormInvoice');
  wrForm('wrFormProduct').innerHTML = '<option value="">Select an invoice first</option>';
  wrItems = [];
  if (!name) { sel.innerHTML = '<option value="">Select a customer first</option>'; return; }
  const mine = (wrInvoices || []).filter(r => String(r.customer_name || '').trim() === name);
  sel.innerHTML = '<option value="">Select an invoice</option>'
    + mine.map(r => `<option value="${escHtmlAttr(r.invoice_type + ':' + r.id)}">`
        + `${escItemHtml(r.invoice_number || '(no number)')} — ${escItemHtml(r.invoice_date ? formatDate(r.invoice_date) : '')}`
        + ` (${escItemHtml(String(r.invoice_type).toUpperCase())})</option>`).join('');
}

function wrSelectedInvoice() {
  const raw = wrVal('wrFormInvoice');
  if (!raw) return null;
  const [type, id] = raw.split(':');
  return (wrInvoices || []).find(r => r.invoice_type === type && r.id === id) || null;
}

async function wrOnInvoiceChange() {
  const inv = wrSelectedInvoice();
  const sel = wrForm('wrFormProduct');
  wrItems = [];
  if (!inv) { sel.innerHTML = '<option value="">Select an invoice first</option>'; return; }

  // The purchase date defaults to the invoice's own date, and stays editable.
  wrSet('wrFormStart', inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '');
  // An invoice-level period is the natural default for a line that has none.
  if (!wrVal('wrFormPeriod') && inv.warranty_period_months) {
    populateWarrantySelect('wrFormPeriod', inv.warranty_period_months);
  }
  if (!wrVal('wrFormTerms') && inv.warranty_terms) wrSet('wrFormTerms', inv.warranty_terms);

  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const res = await _supabase.from('invoice_items').select('*')
      .eq('invoice_id', inv.id).eq('invoice_type', inv.invoice_type);
    if (res && res.error) throw res.error;
    wrItems = res.data || [];
    sel.innerHTML = '<option value="">Select a product</option>'
      + wrItems.map(it => `<option value="${escHtmlAttr(it.id)}">`
          + `${escItemHtml(it.product_name || '(unnamed)')} — ${escItemHtml(formatNum(it.quantity))}`
          + `${it.warranty_period_months ? ' · ' + escItemHtml(warrantyLabel(it.warranty_period_months)) : ''}</option>`).join('');
    if (!wrItems.length) sel.innerHTML = '<option value="">This invoice has no product lines</option>';
  } catch (err) {
    sel.innerHTML = '<option value="">Could not load products</option>';
    handleApiError(err, 'Could not load the invoice products');
  }
  wrRecalcUntil();
}

function wrOnProductChange() {
  const it = wrItems.find(x => x.id === wrVal('wrFormProduct'));
  if (!it) return;
  if (!wrVal('wrFormQty')) wrSet('wrFormQty', it.quantity);
  // A line that already carries its own period is the better default.
  if (it.warranty_period_months) populateWarrantySelect('wrFormPeriod', it.warranty_period_months);
  wrRecalcUntil();
}

// Recomputed whenever the period or the start date moves, and always
// overwritable by hand afterwards.
function wrRecalcUntil() {
  const start = wrVal('wrFormStart');
  const months = wrVal('wrFormPeriod');
  if (!start || !months) return;
  wrSet('wrFormUntil', warrantyUntil(start, months));
}

async function saveWarrantyForm() {
  if (wrSaving) return;
  const btn = wrForm('wrFormSaveBtn');
  wrSaving = true;
  if (btn) btn.disabled = true;
  try {
    let saved;
    if (wrEditing) {
      // Edit updates the record in place. The number, the invoice and the
      // product are not sent at all, so the endpoint could not move them
      // even if this page asked it to.
      saved = await apiFetch('/warranties/' + encodeURIComponent(wrEditing.id), {
        method: 'PATCH',
        body: JSON.stringify({
          serial_number: wrVal('wrFormSerial'),
          quantity: wrVal('wrFormQty') || 1,
          warranty_period_months: wrVal('wrFormPeriod'),
          warranty_start_date: wrVal('wrFormStart'),
          warranty_until: wrVal('wrFormUntil'),
          warranty_terms: wrVal('wrFormTerms')
        })
      });
    } else {
      const inv = wrSelectedInvoice();
      if (!inv) { showToast('Choose an invoice.', 'error'); return; }
      if (!wrVal('wrFormProduct')) { showToast('Choose a product from that invoice.', 'error'); return; }
      saved = await apiFetch('/warranties/manual', {
        method: 'POST',
        body: JSON.stringify({
          invoice_type: inv.invoice_type,
          invoice_id: inv.id,
          invoice_item_id: wrVal('wrFormProduct'),
          serial_number: wrVal('wrFormSerial'),
          quantity: wrVal('wrFormQty') || 1,
          warranty_period_months: wrVal('wrFormPeriod'),
          warranty_start_date: wrVal('wrFormStart'),
          warranty_until: wrVal('wrFormUntil'),
          warranty_terms: wrVal('wrFormTerms')
        })
      });
    }
    closeWarrantyForm();
    showToast(wrEditing ? `${saved.warranty_number} updated.` : `${saved.warranty_number} registered.`, 'success');
    wrEditing = null;
    await reloadWarranties();
    // The row is the point of the save, so it is made visible rather than
    // left hidden behind whatever filter happened to be set.
    await wrRevealRow(saved);
  } catch (err) {
    handleApiError(err, 'Could not save the warranty');
  } finally {
    wrSaving = false;
    if (btn) btn.disabled = false;
  }
}

// The saved row is the point of the save, so it is made visible rather than
// left hidden behind whatever search or filter happened to be set. Clearing
// the box has to re-read, because the search now runs on the server and the
// rows in hand are only the ones that matched the old term.
async function wrRevealRow(row) {
  if (!row) return;
  const box = wrForm('wrSearch');
  const filter = wrForm('wrStatusFilter');
  const hidden = warrantySearchTerm() || (filter && filter.value);
  if (hidden) {
    if (box) box.value = '';
    if (filter) filter.value = '';
    warrantyPage = 1;
    await loadWarranties();
    return;
  }
  warrantyPage = 1;
  renderWarrantyList();
}

// ── QR and NFC ─────────────────────────────────────
// Both carry the SAME address the Warranty Details page uses and nothing
// else. Encoding the cover itself would make the tag the source of truth, and
// a cancelled warranty would keep verifying against its own copy.

async function openWarrantyQr(id) {
  const r = warrantyRows.find(x => x.id === id);
  if (!r) return;
  const url = warrantyVerifyUrl(r.id);
  const label = wrForm('wrQrLabel');
  const link = wrForm('wrQrLink');
  if (label) label.textContent = r.warranty_number || '';
  if (link) { link.textContent = url; link.href = url; }
  wrOpenModal('wrQrModal');
  const canvas = wrForm('wrQrCanvas');
  if (canvas && typeof QRCode !== 'undefined') {
    try { await QRCode.toCanvas(canvas, url, { width: 200, margin: 1 }); }
    catch (err) { showToast('Could not draw the QR code.', 'error'); }
  }
}

function closeWarrantyQr() { wrCloseModal('wrQrModal'); }

function copyWarrantyVerifyLink(id) {
  const url = warrantyVerifyUrl(id);
  if (!url) return;
  navigator.clipboard?.writeText(url)
    .then(() => showToast('Verification link copied.', 'success'))
    .catch(() => showToast(url, 'info'));
}

// Web NFC exists on Android Chrome and essentially nowhere else. Where it is
// missing the user is told so plainly rather than shown a button that does
// nothing.
function warrantyNfcSupported() {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

async function writeWarrantyNfcFor(id) {
  if (!warrantyNfcSupported()) {
    showToast('NFC writing is not supported on this device/browser. Use the QR code, '
      + 'or open this page on an NFC-capable Android device in Chrome.', 'info');
    return;
  }
  const url = warrantyVerifyUrl(id);
  if (!url) return;
  showToast('Writing… hold the tag against the device.', 'info');
  try {
    const ndef = new window.NDEFReader();
    await ndef.write({ records: [{ recordType: 'url', data: url }] });
    showToast('Written Successfully — tapping the tag opens this warranty.', 'success');
  } catch (err) {
    showToast('Write Failed — ' + (err && err.message ? err.message : 'the tag could not be written.'), 'error');
  }
}

async function cancelWarranty(id) {
  const r = warrantyRows.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Cancel warranty ${r.warranty_number}? It stays on this list as a record, and the QR/NFC will report it as cancelled.`)) return;
  try {
    // Cancelling is a status change, not a delete: the tag keeps working and
    // starts telling the truth about the cover immediately.
    await _supabase.from('warranties')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'Cancelled from Warranty Register' })
      .eq('id', id);
    showToast('Warranty cancelled.', 'success');
    await reloadWarranties();
  } catch (err) {
    handleApiError(err, 'Could not cancel the warranty');
  }
}
