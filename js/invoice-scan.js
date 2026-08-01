// =============================================
// Customer Invoice Scanner — Document → Gemini → Invoice Entry
//
// Uploads PDFs, images, CSVs or Excel workbooks to our own backend
// (/api/invoice-scan), which asks Gemini to read them and returns a LIST
// of structured invoices. The Gemini API key lives only on the server —
// this file never sees it and never talks to Google directly. No OCR
// library is loaded here or anywhere else in the frontend.
//
// It is a typist, never a saver: this file contains no insert/update of
// any kind and never calls saveInvoice(). The only way an invoice
// reaches the database is the user pressing the existing Save Invoice
// button, exactly as with manual entry.
//
// One upload can hold many invoices — a spreadsheet with a row-group per
// invoice, a multi-page PDF, a batch of photos. They are listed
// separately and NEVER merged; the user picks one to import.
//
// Population goes exclusively through the form's own handlers
// (onInvoiceCustomerInput, onInvoiceGstinBlur, detectSupplyType,
// loadItemsIntoTable, recalcItemRowLive, computeInvoiceRollups), so
// customer auto-fill, product lookup, GST computation, round-off and
// totals all behave precisely as they do when typed. Nothing here parses
// a document or computes money, and nothing it imports is locked — an
// imported invoice is edited exactly like a hand-typed one.
// =============================================

let invScanResults = [];      // every invoice from the last scan
let invScanSelectedId = null; // which one the user is looking at
let invScanApplied = {};      // what Import wrote, per field id — basis of "never overwrite user edits"

// ── Entry point ──────────────────────────────────────
async function handleInvoiceScanUpload(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const ok = /\.(pdf|jpe?g|png|csv|xlsx|xls)$/i;
  const bad = files.filter(f => !ok.test(f.name));
  if (bad.length) {
    showToast(`Unsupported file: ${bad[0].name}. Use PDF, JPG, PNG, CSV or Excel.`, 'error');
    return;
  }
  const tooBig = files.find(f => f.size > 10 * 1024 * 1024);
  if (tooBig) { showToast(`"${tooBig.name}" is over 10 MB — try a smaller file.`, 'error'); return; }

  const input = document.getElementById('invScanInput');
  if (input) input.disabled = true;
  showInvScanProgress(files.length === 1
    ? 'Analysing document…'
    : `Analysing ${files.length} documents…`);

  const started = Date.now();
  try {
    const body = await sendInvoicesForScan(files);
    hideInvScanProgress();
    console.log(`[invoice-scan] ${Date.now() - started}ms model=${body.model || 'unknown'} OK invoices=${body.invoices.length}`);
    invScanResults = body.invoices;
    invScanSelectedId = invScanResults.length ? invScanResults[0].id : null;
    if (!invScanResults.length) {
      showToast('No invoices could be read from that file. Please enter it manually.', 'warning');
      return;
    }
    renderInvScanReview();
  } catch (err) {
    hideInvScanProgress();
    console.log(`[invoice-scan] ${Date.now() - started}ms FAIL ${err.message || 'unknown'}`);
    showToast(err.message || 'Could not read that file.', 'error');
  } finally {
    if (input) { input.disabled = false; input.value = ''; }   // let the same file be picked again
  }
}

// Plain fetch rather than apiFetch(): this is multipart, and apiFetch
// forces Content-Type: application/json, which would stop the browser
// from setting the multipart boundary.
async function sendInvoicesForScan(files) {
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const token = localStorage.getItem('gst_jwt');

  let res;
  try {
    res = await fetch(API_BASE_URL + '/invoice-scan', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: form
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error && body.error.message) || `Invoice analysis failed (${res.status}).`);
  assertInvScanShape(body);
  return body;
}

// The server already validates Gemini's reply against INVOICE_SCHEMA, so
// this is the second gate rather than the first: it guards the form
// against a response that isn't the one this page expects at all — a
// stale cached reply, a proxy returning something else, a backend that
// has moved on to a different shape.
function assertInvScanShape(b) {
  const bad = msg => { throw new Error(`Unexpected response from the invoice scanner (${msg}). Please enter this invoice manually.`); };
  if (!b || typeof b !== 'object') bad('not an object');
  if (!Array.isArray(b.invoices)) bad('invoices is not a list');
  b.invoices.forEach((inv, i) => {
    if (!inv || typeof inv !== 'object') bad(`invoices[${i}]`);
    for (const f of ['id', 'invoice_number', 'invoice_date']) {
      if (typeof inv[f] !== 'string') bad(`invoices[${i}].${f}`);
    }
    for (const grp of ['customer', 'transport']) {
      if (!inv[grp] || typeof inv[grp] !== 'object') bad(`invoices[${i}].${grp}`);
    }
    if (!Array.isArray(inv.products)) bad(`invoices[${i}].products`);
    inv.products.forEach((p, j) => {
      if (!p || typeof p.product_name !== 'string') bad(`invoices[${i}].products[${j}].product_name`);
      // Numbers are nullable throughout — null is how the scanner says
      // "could not read this", which must stay distinguishable from zero.
      for (const f of ['quantity', 'rate', 'discount_percentage', 'gst_percentage']) {
        if (p[f] !== null && typeof p[f] !== 'number') bad(`invoices[${i}].products[${j}].${f}`);
      }
    });
  });
}

// ── Review screen ────────────────────────────────────
// Every extracted invoice is listed; one is selected at a time and shown
// in full. Nothing reaches the form until the user presses Import.
function renderInvScanReview() {
  const panel = document.getElementById('invScanReview');
  if (!panel) return;

  const selected = invScanResults.find(i => i.id === invScanSelectedId) || invScanResults[0];

  const rows = invScanResults.map(inv => {
    const isSel = inv.id === selected.id;
    return `
      <tr class="${isSel ? 'inv-scan-selected' : ''}" style="cursor:pointer;" onclick="selectScannedInvoice('${inv.id}')">
        <td><input type="radio" name="invScanPick" ${isSel ? 'checked' : ''} onclick="event.stopPropagation();selectScannedInvoice('${inv.id}')" aria-label="Select invoice ${escInvScan(inv.invoice_number)}"></td>
        <td>${escInvScan(inv.invoice_number) || '<span class="text-muted-sm">no number</span>'}</td>
        <td>${escInvScan(inv.invoice_date) || '&mdash;'}</td>
        <td>${escInvScan(inv.customer.customer_name) || '&mdash;'}</td>
        <td class="text-center">${inv.products.length}</td>
        <td class="fs-11 text-muted-sm">${escInvScan(inv.source) || '&mdash;'}</td>
      </tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="card mb-20" id="invScanCard">
      <div class="card-header">
        <span class="card-title"><i class="fas fa-file-invoice-dollar"></i> Scanned Invoices</span>
        <span class="fs-12 text-muted-sm">${invScanResults.length} invoice(s) found</span>
      </div>
      <div class="card-body">
        <div class="banner-warning mb-16">
          <div><i class="fas fa-circle-info"></i>Nothing is saved yet. Pick an invoice, check the details below, press <b>Import</b> to fill the form, edit anything you like, then press <b>Save Invoice</b>.</div>
        </div>
        <div class="table-wrapper mb-16"><table class="data-table">
          <thead><tr><th style="width:36px;"></th><th>Invoice No</th><th>Date</th><th>Customer</th><th class="text-center">Items</th><th>From</th></tr></thead>
          <tbody id="invScanList">${rows}</tbody></table></div>
        <div id="invScanDetail">${renderInvScanDetail(selected)}</div>
      </div>
    </div>`;
  panel.classList.remove('d-none');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  warnIfInvoiceNumberExists(selected.invoice_number);
}

function renderInvScanDetail(inv) {
  if (!inv) return '';
  const line = (label, value) => `<div class="calc-row"><span class="label">${label}</span>
    <span class="value">${escInvScan(value) || '<span class="text-muted-sm">not found</span>'}</span></div>`;

  const items = inv.products.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escInvScan(p.product_name)}</td>
      <td>${escInvScan(p.hsn_code) || '&mdash;'} ${p.hsn_code && !invScanHsnOk(p.hsn_code) ? '<span class="badge badge-red" style="font-size:9px;">HSN?</span>' : ''}</td>
      <td class="text-center">${p.quantity ?? '&mdash;'}</td>
      <td class="text-right">${p.rate ?? '&mdash;'}</td>
      <td class="text-center">${p.discount_percentage ?? 0}%</td>
      <td class="text-center">${p.gst_percentage ?? 0}%</td>
      <td class="text-center">${invScanProductBadge(p.product_name)}</td>
    </tr>`).join('');

  const t = inv.transport;
  const hasTransport = t.vehicle_number || t.lr_number || t.transporter_name;

  return `
    <div id="invScanDupWarn" class="fs-12 mb-10"></div>
    <div class="calc-box mb-16">
      ${line('Invoice Number', inv.invoice_number)}
      ${line('Invoice Date', inv.invoice_date)}
      ${line('Customer Name', inv.customer.customer_name)}
      ${line('Customer GSTIN', inv.customer.gstin)}
      ${line('Phone', inv.customer.phone)}
      ${line('Address', inv.customer.address)}
      ${line('State', inv.customer.state)}
      ${line('Place of Supply', inv.customer.place_of_supply)}
    </div>
    ${hasTransport ? `<div class="calc-box mb-16">
      ${line('Vehicle Number', t.vehicle_number)}
      ${line('LR Number', t.lr_number)}
      ${line('Transporter', t.transporter_name)}
    </div>` : ''}
    ${inv.products.length ? `<div class="table-wrapper mb-16"><table class="data-table">
      <thead><tr><th>#</th><th>Product</th><th>HSN</th><th class="text-center">Qty</th>
        <th class="text-right">Rate</th><th class="text-center">Disc</th><th class="text-center">GST</th><th class="text-center">Master</th></tr></thead>
      <tbody>${items}</tbody></table></div>`
      : '<div class="empty-state mb-16">No product rows were read for this invoice — you can still import the header and add rows by hand.</div>'}
    <div class="fs-11 text-muted-sm mb-16">Blank fields are ones the reader could not read with confidence. Amounts are recalculated by this app from quantity, rate, discount and GST %, not taken from the document.</div>
    <div class="d-flex gap-10">
      <button type="button" class="btn btn-primary" onclick="importScannedInvoice()"><i class="fas fa-file-import"></i> Import into Form</button>
      <button type="button" class="btn btn-secondary" onclick="dismissInvScanReview()">Cancel</button>
    </div>`;
}

function selectScannedInvoice(id) {
  invScanSelectedId = id;
  renderInvScanReview();
}

function invScanHsnOk(hsn) {
  return typeof isValidHsnFormat !== 'function' || isValidHsnFormat(hsn);
}

function invScanProductBadge(name) {
  const list = typeof itemsProductsList !== 'undefined' ? itemsProductsList : [];
  const match = typeof findProductByName === 'function' ? findProductByName(list, name) : null;
  return match
    ? '<span class="badge badge-green" style="font-size:9px;">matched</span>'
    : '<span class="badge" style="font-size:9px;background:#eceff1;color:#546e7a;">new</span>';
}

// Read-only check, mirroring the duplicate test saveInvoice() already runs.
async function warnIfInvoiceNumberExists(num) {
  const slot = document.getElementById('invScanDupWarn');
  if (!slot || !num) return;
  try {
    const user = await getCurrentUser();
    if (!user) return;
    // Same two tables saveInvoice() checks — see js/invoice-entry.js.
    for (const table of ['b2b_invoices', 'b2c_invoices']) {
      const { data } = await _supabase.from(table).select('id')
        .eq('user_id', user.id).eq('invoice_number', num).single();
      if (data?.id) {
        slot.innerHTML = `<div class="banner-warning"><div><i class="fas fa-triangle-exclamation"></i>
          Invoice number <b>${escInvScan(num)}</b> already exists. Saving with this number will be rejected — change it after importing.</div></div>`;
        return;
      }
    }
  } catch { /* no match, or offline — the save-time check remains authoritative */ }
}

function dismissInvScanReview() {
  invScanResults = [];
  invScanSelectedId = null;
  const panel = document.getElementById('invScanReview');
  if (panel) { panel.innerHTML = ''; panel.classList.add('d-none'); }
}

// ── Import into the form ─────────────────────────────
// Every write goes through the form's own handlers, and every field the
// user has already typed into is left alone.
function importScannedInvoice() {
  const inv = invScanResults.find(i => i.id === invScanSelectedId);
  if (!inv) return;

  // A customer GSTIN means this is a B2B invoice. Set the toggle the
  // same way loadInvoiceForEdit() does when opening a saved invoice —
  // it only ever adds information, and never flips B2B back to B2C.
  if (inv.customer.gstin && typeof setInvoiceTypeToggle === 'function') setInvoiceTypeToggle('b2b');

  setInvIfUntouched('invCustName', inv.customer.customer_name);
  if (typeof onInvoiceCustomerInput === 'function') onInvoiceCustomerInput();   // customer auto-fill from master

  setInvIfUntouched('invGstin', inv.customer.gstin);
  const gstEl = document.getElementById('invGstin');
  if (gstEl && typeof onInvoiceGstinInput === 'function') onInvoiceGstinInput(gstEl);
  if (gstEl && typeof onInvoiceGstinBlur === 'function') onInvoiceGstinBlur(gstEl);   // GSTIN validation + customer-by-GSTIN lookup

  setInvIfUntouched('invPhone', inv.customer.phone);
  setInvIfUntouched('invAddress', inv.customer.address);
  // invState IS the place-of-supply field the GST engine reads (see
  // detectSupplyType()), so an explicit Place of Supply outranks the
  // customer's own state when the document prints both.
  setInvIfUntouched('invState', matchInvStateOption(inv.customer.place_of_supply || inv.customer.state));
  setInvIfUntouched('invNum', inv.invoice_number);
  setInvIfUntouched('invDate', inv.invoice_date);
  // Supply type stays derived — detectSupplyType() decides it from the
  // business/customer state pair, exactly as for typed entry.
  if (typeof detectSupplyType === 'function') detectSupplyType();
  if (typeof updateGstinValidationStatus === 'function') updateGstinValidationStatus();

  applyScannedTransport(inv.transport);
  if (inv.products.length) importScannedItems(inv.products);

  dismissInvScanReview();
  showToast(`Imported invoice ${inv.invoice_number || ''} with ${inv.products.length} item(s). Review, then press Save Invoice.`, 'success');
}

// Only opens the transport section when the document actually carried
// transport details — an invoice without them looks exactly as it does
// on a manual entry.
function applyScannedTransport(t) {
  if (!t.vehicle_number && !t.lr_number && !t.transporter_name) return;
  const toggle = document.getElementById('transportToggle');
  if (toggle && !toggle.checked) {
    toggle.checked = true;
    if (typeof onTransportToggleChange === 'function') onTransportToggleChange();
  }
  setInvIfUntouched('invVehicleNo', t.vehicle_number);
  setInvIfUntouched('invLrNumber', t.lr_number);
  setInvIfUntouched('invTransporter', t.transporter_name);
}

// invState is a <select>, so a value that isn't one of its options
// silently leaves the field blank. Resolve against the app's own state
// list first, tolerating case and spacing differences.
function matchInvStateOption(state) {
  if (!state) return '';
  const list = typeof INDIAN_STATES !== 'undefined' ? INDIAN_STATES : [];
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');
  return list.find(s => norm(s) === norm(state)) || '';
}

// Rows go in through loadItemsIntoTable() — the same bulk path the
// Edit-invoice flow uses. One render for any number of rows. Values are
// then computed by recalcItemRowLive(), so GST/taxable/total come from
// the app's own calcGST(), never from the document.
function importScannedItems(items) {
  const existing = (typeof currentItems !== 'undefined' ? currentItems : [])
    .filter(r => r.product_name || r.rate || r.hsn_code);          // keep anything already typed
  const rows = existing.concat(items.map(it => ({
    product_name: it.product_name,
    hsn_code: it.hsn_code,
    unit: it.unit,
    quantity: it.quantity !== null ? it.quantity : 1,
    rate: it.rate !== null ? it.rate : 0,
    discount_percentage: it.discount_percentage !== null ? it.discount_percentage : 0,
    gst_percentage: it.gst_percentage !== null ? it.gst_percentage : 0
    // taxable_value / gst_amount / total_amount deliberately omitted —
    // recalcItemRowLive() derives them below.
  })));

  loadItemsIntoTable(rows);
  currentItems.forEach(r => { if (typeof recalcItemRowLive === 'function') recalcItemRowLive(r.rowId); });
  if (typeof renderItemsTable === 'function') renderItemsTable();
  if (typeof computeInvoiceRollups === 'function') computeInvoiceRollups();

  const unmatched = items.filter(it => !(typeof findProductByName === 'function'
    && findProductByName(itemsProductsList || [], it.product_name)));
  if (unmatched.length) {
    showToast(`${unmatched.length} product(s) are not in Product Master — use Quick Add on the row to save them.`, 'info');
  }
}

// Some fields arrive pre-populated by the form itself rather than by the
// user: initInvoiceEntry() stamps invDate with today, invCustName with
// "Walk-in Customer", and invNum with a generated number whenever
// auto-numbering is on. Nobody typed those, so they must not block the
// scanned document's own values the way a real edit does.
//
// The customer-name rule is not restated here — isCustNameUntouched() in
// js/invoice-entry.js is the form's own definition of "nobody has
// entered a customer yet", and onInvoiceGstinBlur() already relies on
// it. Duplicating it would mean two places to fix when the placeholder
// text changes.
function isInvFormDefault(id, current) {
  if (id === 'invDate') return typeof toISO === 'function' && current === toISO(new Date());
  if (id === 'invNum') return typeof isAutoInvoiceOn === 'function' && isAutoInvoiceOn();
  if (id === 'invCustName') return typeof isCustNameUntouched === 'function' && isCustNameUntouched();
  return false;
}

// A field is written only if it is still empty, still holds the form's
// own default, or still holds exactly what a previous import put there.
// Anything the user has typed or corrected wins.
function setInvIfUntouched(id, value) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  const current = (el.value || '').trim();
  if (current && current !== (invScanApplied[id] || '') && !isInvFormDefault(id, current)) return;
  el.value = value;
  invScanApplied[id] = value;
  el.classList.add('scan-filled');
  el.addEventListener('input', () => {
    el.classList.remove('scan-filled');
    delete invScanApplied[id];
  }, { once: true });
}

// ── Progress ─────────────────────────────────────────
function showInvScanProgress(msg) {
  const el = document.getElementById('invScanProgress');
  if (!el) return;
  el.innerHTML = `<div class="banner-warning"><div><i class="fas fa-spinner fa-spin"></i> ${escInvScan(msg)} This can take a few seconds.</div></div>`;
  el.classList.remove('d-none');
}
function hideInvScanProgress() {
  const el = document.getElementById('invScanProgress');
  if (el) { el.innerHTML = ''; el.classList.add('d-none'); }
}

function escInvScan(v) { return (v || '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
