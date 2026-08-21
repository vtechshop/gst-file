// =============================================
// Invoice List — unified read-only view over the existing
// b2b_invoices + b2c_invoices tables (the single source of truth,
// same records entered via B2B Invoice Entry / B2C Invoice Entry).
// Purely a display + actions page: no invoice entry happens here.
// =============================================

let invListAllData = [];
let invListPage = 1;
const INV_LIST_PAGE_SIZE = 10;

// The rows to page through: the full list after filtering, searching and
// sorting have all been applied. Pagination only ever slices THIS — it
// never filters or sorts, so the order of operations is fixed by
// construction rather than by convention:
//
//   invListAllData -> filters -> search -> sort -> invListView -> slice
//
// invListPage above is the single source of truth for which page is
// showing; nothing else tracks it.
let invListView = [];

// ── Invoice number ordering ─────────────────────────
// 'desc' = highest number first, which is the default: the newest
// invoice is the one people look for.
let invListSort = 'desc';

// How long a just-changed row stays marked. Long enough to catch the eye
// on a full page of rows, short enough not to linger. Matches the
// rowJustUpdated animation in css/style.css.
const ROW_HIGHLIGHT_MS = 3000;

// Invoice numbers must order numerically, not as text. The rule lives in
// js/utils.js, shared with the GSTR-1 exporter and the series migration
// tool so the list and a filing cannot disagree about the order.
function compareInvoiceNumbersAsc(a, b) {
  return compareInvoiceNumbers(a, b);
}

// Sorts a COPY, so callers can re-sort the same source list repeatedly
// without the order of a previous pass leaking into the next.
function sortInvoicesByNumber(rows, direction = invListSort) {
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const byNumber = compareInvoiceNumbersAsc(a.invoice_number, b.invoice_number);
    if (byNumber) return byNumber * dir;
    // Same number on both a B2B and a B2C invoice: fall back to date and
    // then id purely so the order is stable between renders.
    const byDate = (a.invoice_date || '').localeCompare(b.invoice_date || '');
    return byDate ? byDate * dir : String(a.id).localeCompare(String(b.id));
  });
}

function onInvoiceListSortChange() {
  invListSort = document.getElementById('invListSortOrder')?.value === 'asc' ? 'asc' : 'desc';
  // Re-sort the master list so every downstream view — filtering and
  // pagination alike — inherits the new order rather than each applying
  // its own.
  invListAllData = sortInvoicesByNumber(invListAllData);
  applyInvoiceListFilters();
}

async function initInvoiceList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populateInvoiceListFilters();
  setupInvoiceListSearch();
  await loadInvoiceList(user.id);
  // After the data and the State filter's options exist — restoring a
  // filter value before its <option> is rendered would silently select
  // nothing.
  restoreInvListState();
}

// ── Remembering where the user was ───────────────────
// Captured the instant Edit is clicked, while the list is still on
// screen and every control still holds what the user chose. Editing an
// invoice from page 4 of a filtered, searched, re-sorted list used to
// dump them back at an unfiltered page 1, which on a long list meant
// hunting for their place again.
function rememberInvListState(type, id, extra) {
  setListReturnState(INVOICE_LIST_RETURN_KEY, {
    ...extra,
    page: invListPage,
    search: document.getElementById('invListSearch')?.value || '',
    filters: {
      state: document.getElementById('invListStateFilter')?.value || '',
      month: document.getElementById('invListMonthFilter')?.value || '',
      year:  document.getElementById('invListYearFilter')?.value || '',
      type:  document.getElementById('invListTypeFilter')?.value || '',
      source: document.getElementById('invListSourceFilter')?.value || ''
    },
    sort: document.getElementById('invListSortOrder')?.value || 'desc',
    // Both, because which element scrolls depends on the viewport: the
    // window on desktop, the .content pane once the layout stacks.
    scrollY: window.scrollY || 0,
    contentScroll: document.querySelector('.content')?.scrollTop || 0,
    selected: { type, id }
  });
}

// Puts the list back exactly as it was, then makes sure the row the user
// went off to edit is on screen and briefly marked, so the invoice they
// just changed is the one they are looking at.
function restoreInvListState() {
  const state = takeListReturnState(INVOICE_LIST_RETURN_KEY);
  if (!state) return;

  const set = (elId, v) => { const el = document.getElementById(elId); if (el && v !== undefined) el.value = v; };
  set('invListSearch', state.search);
  set('invListStateFilter', state.filters?.state);
  set('invListMonthFilter', state.filters?.month);
  set('invListYearFilter', state.filters?.year);
  set('invListTypeFilter', state.filters?.type);
  set('invListSourceFilter', state.filters?.source);
  set('invListSortOrder', state.sort);
  invListSort = state.sort === 'asc' ? 'asc' : 'desc';

  // Re-runs the whole pipeline (filters -> search -> sort) against the
  // freshly loaded data, so the restored view reflects the edit that was
  // just saved rather than a stale snapshot.
  invListAllData = sortInvoicesByNumber(invListAllData);
  applyInvoiceListFilters();          // resets to page 1...
  goToInvoiceListPage(state.page);    // ...then back to where they were

  if (state.flash) showToast(state.flash, 'success');

  // Scroll last, once the rows for this page exist.
  requestAnimationFrame(() => {
    const row = state.selected?.id
      ? document.querySelector(`#invListTableBody tr[data-invoice-id="${state.selected.id}"]`)
      : null;
    if (row) {
      row.classList.add('row-just-updated');
      row.scrollIntoView({ block: 'center' });
      setTimeout(() => row.classList.remove('row-just-updated'), ROW_HIGHLIGHT_MS);
    } else {
      // The edited invoice fell outside the restored filter (its number
      // or customer changed, say) — put the user back where they were
      // rather than at the top.
      window.scrollTo(0, state.scrollY || 0);
      const content = document.querySelector('.content');
      if (content && state.contentScroll) content.scrollTop = state.contentScroll;
    }
  });
}

// Reads both invoice tables and returns them as one list of view rows.
// Split out from loadInvoiceList() so the data can be re-read without
// also resetting the view — see refreshInvoiceListInPlace().
async function fetchInvoiceListRows(userId) {
  // Returns null rather than a half-list. One table failing would drop
  // every B2B or every B2C invoice out of the list silently, and this
  // page is where people go to check whether an invoice was saved.
  const rows = await readAll([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId)
  ], 'Could not load the invoices');
  if (!rows) return null;
  const [b2b, b2c] = rows;

  // `state` comes from the rows already fetched above — the select('*')
  // has always returned it, it just wasn't carried into the view model.
  // No extra request is made for the State column or its filter.
  const b2bRows = (b2b || []).map(r => ({
    type: 'b2b', id: r.id, invoice_number: r.invoice_number, invoice_date: r.invoice_date,
    customer_name: r.customer_name, gstin: r.gst_number, total_amount: +r.total_amount,
    state: r.state || '',
    // Which numbering book the invoice belongs to — the Source column,
    // the Source filter, and the Series Migration tool's before/after
    // all read this one field.
    invoice_source: r.invoice_source || INVOICE_SOURCE_DEFAULT,
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));
  const b2cRows = (b2c || []).map(r => ({
    type: 'b2c', id: r.id, invoice_number: r.invoice_number || ('B2C-' + r.id.slice(0, 8).toUpperCase()), invoice_date: r.invoice_date,
    customer_name: r.customer_name || 'Walk-in Customer (B2C)', gstin: r.gst_number || '', total_amount: +r.total_amount,
    state: r.state || '',
    // Which numbering book the invoice belongs to — the Source column,
    // the Source filter, and the Series Migration tool's before/after
    // all read this one field.
    invoice_source: r.invoice_source || INVOICE_SOURCE_DEFAULT,
    payment_status: r.payment_status || 'unpaid', amount_paid: +r.amount_paid || 0
  }));

  return [...b2bRows, ...b2cRows];
}

async function loadInvoiceList(userId) {
  // Ordered by invoice number the moment it is loaded, so filtering and
  // pagination both operate on an already-sorted list.
  const fetched = await fetchInvoiceListRows(userId);
  if (!fetched) return;                       // read failed, already reported
  invListAllData = sortInvoicesByNumber(fetched);
  invListPage = 1;
  // Populated here rather than in populateInvoiceListFilters(): the option
  // list is derived from the loaded records, which don't exist until now.
  populateInvoiceListStateFilter();
  populateInvoiceListSourceFilter();
  renderInvoiceListTable(invListAllData);
}

// Re-reads the invoices and redraws where the user already is.
//
// THIS IS THE ONLY WAY THE LIST SHOULD BE REFRESHED after an action that
// changes invoice data while staying on this page. loadInvoiceList() is for
// the initial load alone: it hands renderInvoiceListTable() the whole
// unfiltered master list and resets to page 1, so using it as a refresh
// dropped the user from page 4 of a filtered, searched list back to an
// unfiltered page 1 with their place lost. This re-runs the same pipeline
// the view was built from (filters -> search -> sort) against the fresh
// data, then returns to the page they were on, leaving every control
// untouched. Pass the affected invoice's id to mark it briefly; omit it
// when the row is gone, as after a delete.
async function refreshInvoiceListInPlace(userId, highlightId) {
  const page = invListPage;
  // Both, because which element scrolls depends on the viewport.
  const scrollY = window.scrollY || 0;
  const content = document.querySelector('.content');
  const contentScroll = content?.scrollTop || 0;

  const fetched = await fetchInvoiceListRows(userId);
  // Leaves the list showing what it already had rather than emptying it —
  // this runs after a save or delete, where blanking the page would look
  // like the records themselves had gone.
  if (!fetched) return;
  invListAllData = sortInvoicesByNumber(fetched);
  populateInvoiceListStateFilter();    // rebuilt from the data, selection kept
  applyInvoiceListFilters();           // resets to page 1...
  // ...then back to where they were. Clamped to the last page that still
  // has rows, so deleting the only invoice on the last page steps back a
  // page instead of showing an empty one.
  goToInvoiceListPage(page);

  requestAnimationFrame(() => {
    window.scrollTo(0, scrollY);
    if (content) content.scrollTop = contentScroll;
    const row = highlightId
      ? document.querySelector(`#invListTableBody tr[data-invoice-id="${highlightId}"]`)
      : null;
    if (row) {
      row.classList.add('row-just-updated');
      setTimeout(() => row.classList.remove('row-just-updated'), ROW_HIGHLIGHT_MS);
    }
  });
}

// Rebuilt from whatever is in memory, preserving the current selection so
// a refresh after recording a payment doesn't silently reset the filter.
function populateInvoiceListStateFilter() {
  const sel = document.getElementById('invListStateFilter');
  if (!sel) return;
  sel.innerHTML = buildStateFilterOptions(invListAllData, r => r.state, sel.value);
}

// Built from the series the invoices are actually in, never a fixed list
// — a business that starts selling through another channel can filter by
// it the day the first such invoice is saved. The shop series is always
// offered, so the filter is usable before any other series exists.
// Rebuilt on every refresh, keeping whatever was selected.
function populateInvoiceListSourceFilter() {
  const sel = document.getElementById('invListSourceFilter');
  if (!sel) return;
  const inUse = [...new Set([INVOICE_SOURCE_DEFAULT, ...invListAllData.map(invoiceSourceOf)])].sort();
  const selected = sel.value;
  sel.innerHTML = '<option value="">All Sources</option>' + inUse.map(s =>
    `<option value="${escHtmlAttr(s)}"${s === selected ? ' selected' : ''}>${escItemHtml(invoiceSourceLabel(s))}</option>`
  ).join('');
}

function populateInvoiceListFilters() {
  const monthSel = document.getElementById('invListMonthFilter');
  const yearSel  = document.getElementById('invListYearFilter');
  if (monthSel) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthSel.innerHTML = '<option value="">All Months</option>' + months.map((m,i) => `<option value="${i+1}">${m}</option>`).join('');
  }
  if (yearSel) {
    const y = new Date().getFullYear();
    let opts = '<option value="">All Years</option>';
    for (let i = y; i >= y - 4; i--) opts += `<option value="${i}">${i}</option>`;
    yearSel.innerHTML = opts;
  }
}

function setupInvoiceListSearch() {
  document.getElementById('invListSearch')?.addEventListener('input', applyInvoiceListFilters);
}

function applyInvoiceListFilters() {
  const q = document.getElementById('invListSearch')?.value?.toLowerCase() || '';
  const state = document.getElementById('invListStateFilter')?.value || '';
  const month = document.getElementById('invListMonthFilter')?.value || '';
  const year  = document.getElementById('invListYearFilter')?.value || '';
  const type  = document.getElementById('invListTypeFilter')?.value || '';
  const source = document.getElementById('invListSourceFilter')?.value || '';

  // Every filter narrows the same list in turn, so they combine rather
  // than override — State works alongside Search/Month/Year/Type/Source.
  let filtered = invListAllData;
  if (q) {
    filtered = filtered.filter(r =>
      (r.invoice_number || '').toLowerCase().includes(q) ||
      (r.customer_name  || '').toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q) ||
      // Both the stored name and the label shown in the column, so
      // typing "online" and typing "website" both find the same rows.
      invoiceSourceOf(r).includes(q) ||
      invoiceSourceLabel(invoiceSourceOf(r)).toLowerCase().includes(q));
  }
  if (source) filtered = filtered.filter(r => invoiceSourceOf(r) === source);
  if (state) filtered = filtered.filter(r => r.state === state);
  if (month) filtered = filtered.filter(r => r.invoice_date && (new Date(r.invoice_date).getMonth() + 1) === +month);
  if (year)  filtered = filtered.filter(r => r.invoice_date && new Date(r.invoice_date).getFullYear() === +year);
  if (type)  filtered = filtered.filter(r => r.type === type);

  // The pipeline, in order: full list -> filters -> search -> sort, and
  // only then hand the result over to be paginated. Pagination slices
  // whatever it is given and never reorders, so this is the one place
  // the order is decided. renderInvoiceListTable() resets to page 1.
  renderInvoiceListTable(sortInvoicesByNumber(filtered));
}

// Entry point: hand it the filtered+sorted rows and it becomes the view.
// Page always resets to 1 here, because a new filter/sort/search means
// the old page number refers to a set that no longer exists.
function renderInvoiceListTable(data) {
  invListView = Array.isArray(data) ? data : [];
  invListPage = 1;
  renderInvoiceListPage();
}

// Moves to a page and redraws. The ONLY way the page number changes.
function goToInvoiceListPage(page) {
  const pages = Math.max(1, Math.ceil(invListView.length / INV_LIST_PAGE_SIZE));
  const next = Math.min(Math.max(1, Number(page) || 1), pages);
  if (next === invListPage) return;
  invListPage = next;
  renderInvoiceListPage();
}

// Draws the rows for the current page, the totals, and the pager.
// Re-reads invListView and invListPage every time, so it is safe to call
// from anywhere without passing state around.
function renderInvoiceListPage() {
  const data = invListView;
  const tbody = document.getElementById('invListTableBody');
  const tfoot = document.getElementById('invListTableTotal');
  if (!tbody) return;

  const start = (invListPage - 1) * INV_LIST_PAGE_SIZE;
  const page  = data.slice(start, start + INV_LIST_PAGE_SIZE);

  if (!data.length) {
    // Naming the filter that emptied the table is more useful than the
    // generic "create one" prompt, which is wrong advice mid-filter.
    const stateName = document.getElementById('invListStateFilter')?.value || '';
    const message = stateName
      ? 'No invoices found for the selected state.'
      : 'No invoices found. Click New Invoice to create one.';
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state"><i class="fas fa-file-invoice table-loading-icon"></i>${message}</td></tr>`;
    if (tfoot) tfoot.innerHTML = '';
    renderInvListPagination();
    return;
  }
  tbody.innerHTML = page.map((r, i) => {
    const balance = round2(Math.max(0, (r.total_amount || 0) - (r.amount_paid || 0)));
    return `
    <tr data-invoice-id="${r.id}" data-invoice-type="${r.type}">
      <td>${start + i + 1}</td>
      <td class="fw-600">${r.invoice_number}</td>
      <td>${invoiceSourceCellHtml(r.invoice_source)}</td>
      <td>${formatDate(r.invoice_date)}</td>
      <td>${r.customer_name}</td>
      <td><span class="badge ${r.type === 'b2b' ? 'badge-blue' : 'badge-green'}">${r.type.toUpperCase()}</span></td>
      <td>${stateCellHtml(r.state)}</td>
      <td class="text-right fw-700 text-primary-dark">₹${formatNum(r.total_amount)}</td>
      <td class="text-right">₹${formatNum(r.amount_paid)}</td>
      <td class="text-right ${balance > 0 ? 'text-danger' : ''}">₹${formatNum(balance)}</td>
      <td>
        <span class="badge ${paymentStatusBadge(r.payment_status)} clickable" onclick="openMarkPaymentModal('${r.type}','${r.id}')" title="Click to record payment">${paymentStatusLabel(r.payment_status)}</span>
      </td>
      <td>
        <div class="action-btns">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="viewInvoiceFromList('${r.type}','${r.id}')" title="View"><i class="fas fa-eye"></i></button>
          <a class="btn btn-secondary btn-sm btn-icon" href="invoice.html?type=${r.type}&id=${r.id}" title="Edit" onclick="rememberInvListState('${r.type}','${r.id}')"><i class="fas fa-edit"></i></a>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="duplicateInvoiceFromList('${r.type}','${r.id}')" title="Duplicate"><i class="fas fa-copy"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="downloadInvoicePDF('${r.type}','${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="printInvoice('${r.type}','${r.id}')" title="Print"><i class="fas fa-print"></i></button>
          <button type="button" class="btn btn-success btn-sm btn-icon" onclick="shareInvoiceWhatsApp('${r.type}','${r.id}')" title="Share via WhatsApp"><i class="fab fa-whatsapp"></i></button>
          <button type="button" class="btn btn-info btn-sm btn-icon btn-info-alt" onclick="emailInvoicePDF('${r.type}','${r.id}')" title="Email PDF"><i class="fas fa-envelope"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="deleteInvoiceFromList('${r.type}','${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const total = data.reduce((s, r) => s + (r.total_amount || 0), 0);
  const totalPaid = data.reduce((s, r) => s + (r.amount_paid || 0), 0);
  const totalBalance = round2(Math.max(0, total - totalPaid));
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="7" class="fw-700">TOTALS (${data.length} invoices)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td class="text-right fw-700">₹${formatNum(totalPaid)}</td><td class="text-right fw-700">₹${formatNum(totalBalance)}</td><td></td><td></td></tr>`;

  renderInvListPagination();
}

// ── View (read-only preview, reusing the exact same markup printInvoice()
// generates — see buildInvoiceHTML() in js/invoice-pdf.js) ──────────
async function viewInvoiceFromList(type, id) {
  const html = await viewInvoiceHTML(type, id);
  if (!html) return;
  const frame = document.getElementById('viewInvoiceFrame');
  if (frame) frame.srcdoc = html;
  document.getElementById('viewInvoiceModal')?.classList.add('open');
}

function closeViewInvoiceModal() {
  document.getElementById('viewInvoiceModal')?.classList.remove('open');
}

// ── Duplicate (stashes the source invoice for invoice.html?duplicate=1
// to prefill — nothing is written to the DB until Save is clicked there) ──
//
// The editor step stays: a copy needs its date and quantities checked
// before it becomes a real invoice. What the user does NOT lose is their
// place — the list is remembered here, exactly as it is for Edit, and
// saving the copy brings them back to this page with the new invoice
// marked in whatever sort order is active (see saveInvoice()).
async function duplicateInvoiceFromList(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  rememberInvListState(type, id, { returnAfterCreate: true });
  sessionStorage.setItem('invoice_duplicate_draft', JSON.stringify({
    type, customer_name: inv.customer_name, gst_number: inv.gstin, phone: inv.phone, address: inv.address, state: inv.state,
    supply_type: inv.supply_type,
    // A copy of a website order is another website order. Without this
    // the copy would quietly land in the shop's numbering book.
    invoice_source: inv.invoice_source,
    gst_category: inv.gst_category,
    reverse_charge: inv.reverse_charge,
    transport_required: inv.transport_required, vehicle_number: inv.vehicle_number, transporter_name: inv.transporter_name,
    transport_mode: inv.transport_mode, transport_distance_km: inv.transport_distance_km, lr_number: inv.lr_number, lr_date: inv.lr_date,
    transporter_gstin: inv.transporter_gstin, vehicle_type: inv.vehicle_type, dispatch_from: inv.dispatch_from, dispatch_to: inv.dispatch_to,
    items: inv.items || []
  }));
  window.location.href = 'invoice.html?duplicate=1';
}

// ── Payment: Receive Payment + Payment History ──────
let mpTarget = null; // { type, id }

async function openMarkPaymentModal(type, id) {
  const rec = invListAllData.find(r => r.type === type && r.id === id);
  if (!rec) return;
  mpTarget = { type, id };
  document.getElementById('mpInvoiceLabel').textContent = rec.invoice_number;
  setInvListValue('mpAmount', '');
  setInvListValue('mpMethod', 'cash');
  setInvListValue('mpDate', toISO(new Date()));
  setInvListValue('mpReference', '');
  setInvListValue('mpNote', '');
  setPaymentModalError();
  document.getElementById('markPaymentModal')?.classList.add('open');
  await refreshPaymentModal();
}

function closeMarkPaymentModal() {
  document.getElementById('markPaymentModal')?.classList.remove('open');
  mpTarget = null;
}

function setInvListValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

async function refreshPaymentModal() {
  if (!mpTarget) return;
  const rec = invListAllData.find(r => r.type === mpTarget.type && r.id === mpTarget.id);
  if (!rec) return;

  const history = await loadPaymentsForInvoice(mpTarget.type, mpTarget.id);
  // null means the ledger could not be READ (loadPaymentsForInvoice()),
  // which is not the same as an invoice with no payments yet. Opening the
  // dialog anyway would show "₹0 received" against a possibly part-paid
  // invoice and invite the user to record a payment twice, so it does not
  // open at all — handleApiError() has already said why.
  if (!history) { closeMarkPaymentModal?.(); return; }
  const receivedSoFar = round2(history.reduce((s, p) => s + (+p.amount || 0), 0));
  const outstanding = round2(Math.max(0, (rec.total_amount || 0) - receivedSoFar));

  document.getElementById('mpInvoiceTotal').textContent = '₹' + formatNum(rec.total_amount);
  document.getElementById('mpReceivedSoFar').textContent = '₹' + formatNum(receivedSoFar);
  document.getElementById('mpOutstanding').textContent = '₹' + formatNum(outstanding);

  const listEl = document.getElementById('mpHistoryList');
  if (listEl) {
    listEl.innerHTML = history.length
      ? history.map(p => `
        <div class="mini-list-row">
          <span>${formatDate(p.payment_date)} &middot; ${PAYMENT_METHOD_LABELS[p.method] || p.method}${p.reference_number ? ' &middot; Ref: ' + escBinHtml(p.reference_number) : ''}${p.note ? ' &middot; ' + escBinHtml(p.note) : ''}</span>
          <span class="d-flex align-center gap-10">
            <b>₹${formatNum(p.amount)}</b>
            <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="removePayment('${p.id}')" title="Remove this payment"><i class="fas fa-times"></i></button>
          </span>
        </div>`).join('')
      : '<p class="text-muted-sm">No payments recorded yet.</p>';
  }
}

function escBinHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

async function submitReceivePayment() {
  if (!mpTarget) return;
  const user = await getCurrentUser();
  if (!user) return;
  const amount = parseFloat(document.getElementById('mpAmount')?.value);
  const method = document.getElementById('mpMethod')?.value;
  const date = document.getElementById('mpDate')?.value;
  const referenceNumber = document.getElementById('mpReference')?.value;
  const note = document.getElementById('mpNote')?.value;

  // Held before the modal closes below, which clears mpTarget.
  const target = mpTarget;

  const result = await recordPayment(target.type, target.id, user.id, { amount, method, date, referenceNumber, note });
  // A failure leaves the modal exactly as it is — the amount the user typed
  // is still there to correct and retry — with the reason shown against the
  // button rather than only in a toast that fades.
  if (!result.ok) { setPaymentModalError(result.error, 'Could not record the payment'); return; }

  showToast('Payment recorded.', 'success');
  closeMarkPaymentModal();
  // Paid, Balance and Status come back from the invoice rows themselves,
  // re-read here; nothing about the amounts is recalculated on this page.
  await refreshInvoiceListInPlace(user.id, target.id);
}

// The inline error line inside the payment modal. Cleared whenever the
// modal opens and whenever a save succeeds — call with no arguments.
//
// Takes the failed request itself rather than a pre-built string, so the
// line in the modal carries the same status-aware wording as the toast
// (including the code and log reference on a 5xx) and an expired session
// is handled here too instead of being reported as a payment problem.
function setPaymentModalError(error, context) {
  const el = document.getElementById('mpError');
  const message = error ? describeApiError(error, context) : '';
  if (el) {
    el.textContent = message;
    el.classList.toggle('show', !!message);   // .form-error is hidden until 'show'
  }
  if (error) handleApiError(error, context);
}

async function removePayment(paymentId) {
  if (!mpTarget) return;
  const user = await getCurrentUser();
  if (!user) return;
  const ok = await showConfirm('Remove this payment record? The invoice balance will be recalculated.');
  if (!ok) return;
  const result = await deletePayment(paymentId, mpTarget.type, mpTarget.id, user.id);
  if (!result.ok) { setPaymentModalError(result.error, 'Could not remove the payment'); return; }
  showToast('Payment removed.', 'success');
  setPaymentModalError();
  // Same in-place refresh, but the modal stays open: removing a payment is
  // an action taken inside the history list the user is still looking at.
  await refreshInvoiceListInPlace(user.id, mpTarget.id);
  await refreshPaymentModal();
}

async function deleteInvoiceFromList(type, id) {
  const ok = await showConfirm('Permanently delete this invoice? This cannot be undone.');
  if (!ok) return;
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  await cascadeInvoiceItemsDelete(type, id); // items + HSN + stock reversal first
  const { error } = await _supabase.from(table).delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the invoice'); return; }
  showToast('Invoice permanently deleted.', 'success');
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
  const user = await getCurrentUser();
  // No id to highlight — the row it would have marked is the one just
  // removed. Everything else about the view is kept, footer totals included.
  if (user) await refreshInvoiceListInPlace(user.id);
}

// Built from real DOM nodes with real listeners.
//
// The previous version wrote the handler into an inline onclick= by
// running Function.toString() over the callback. That silently loses
// everything the callback closed over, because the reconstructed
// function is parsed fresh in global scope — so the click threw and the
// table never changed. A listener holds an actual reference to the
// function, which is why this works and string reconstruction cannot.
function renderInvListPagination() {
  const container = document.getElementById('invListPagination');
  if (!container) return;

  const pages = Math.ceil(invListView.length / INV_LIST_PAGE_SIZE);
  container.replaceChildren();                 // drops old nodes and their listeners
  if (pages <= 1) return;

  const button = (label, targetPage, { disabled = false, active = false } = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'page-btn' + (active ? ' active' : '');
    b.textContent = label;
    b.disabled = disabled;
    if (active) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => goToInvoiceListPage(targetPage));
    return b;
  };

  container.appendChild(button('‹', invListPage - 1, { disabled: invListPage === 1 }));
  for (let i = 1; i <= pages; i++) {
    container.appendChild(button(String(i), i, { active: i === invListPage }));
  }
  container.appendChild(button('›', invListPage + 1, { disabled: invListPage === pages }));
}
