// =============================================
// Purchase Bill Scanner — Bill → Gemini → Purchase Entry
//
// Uploads a supplier bill to our own backend (/api/bill-scan), which
// asks Gemini to read it and returns structured JSON. The Gemini API key
// lives only on the server — this file never sees it and never talks to
// Google directly.
//
// It is a typist, never a saver: this file contains no insert/update of
// any kind and never calls savePurchase(). The only way a purchase
// reaches the database is the user pressing the existing Save Purchase
// button, exactly as with manual entry.
//
// Population goes exclusively through the form's own handlers
// (onPurchVendorInput, onPurchGstinBlur, loadPurchItemsIntoTable,
// recalcPurchItemRowLive, computePurchRollups), so vendor auto-fill, the
// Save Vendor / Skip panel, Product Master lookup and locking, HSN
// validation, GST computation and totals all behave precisely as they do
// when typed. Nothing here parses a bill or computes money.
// =============================================

let scanExtracted = null;      // last scan, awaiting the user's Import click
let scanAppliedValues = {};    // what Import wrote, per field id — basis of "never overwrite user edits"

// ── Entry point ──────────────────────────────────────
async function handlePurchaseBillUpload(file) {
  if (!file) return;
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) {
    showToast('Upload a PDF, JPG, JPEG or PNG bill.', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('That file is over 10 MB — try a smaller scan.', 'error');
    return;
  }

  const input = document.getElementById('purchBillInput');
  if (input) input.disabled = true;
  showScanProgress('Analysing bill…');

  const started = Date.now();
  try {
    scanExtracted = await sendBillForScan(file);
    hideScanProgress();
    console.log(`[bill-scan] ${Date.now() - started}ms model=${scanExtracted.model || 'unknown'} OK products=${scanExtracted.products.length}`);
    if (!scanExtracted.products.length && !scanExtracted.vendor.vendor_name) {
      showToast('Nothing could be read from that bill. Please enter it manually.', 'warning');
      return;
    }
    renderScanReview(scanExtracted);
  } catch (err) {
    hideScanProgress();
    console.log(`[bill-scan] ${Date.now() - started}ms FAIL ${err.message || 'unknown'}`);
    showToast(err.message || 'Could not read that bill.', 'error');
  } finally {
    if (input) { input.disabled = false; input.value = ''; }   // let the same file be picked again
  }
}

// Plain fetch rather than apiFetch(): this is multipart, and apiFetch
// forces Content-Type: application/json, which would stop the browser
// from setting the multipart boundary. Same approach js/profile.js uses
// for image uploads.
async function sendBillForScan(file) {
  const form = new FormData();
  form.append('bill', file);
  const token = localStorage.getItem('gst_jwt');

  let res;
  try {
    res = await fetch(API_BASE_URL + '/bill-scan', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: form
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error && body.error.message) || `Bill analysis failed (${res.status}).`);
  assertScanShape(body);
  return body;
}

// The server already validates Gemini's reply against BILL_SCHEMA, so
// this is the second gate rather than the first: it guards the form
// against a response that isn't the one this page expects at all — a
// stale cached reply, a proxy returning something else, a backend that
// has moved on to a different shape. Cheap, and it fails loudly here
// instead of throwing halfway through populating the form.
function assertScanShape(b) {
  const bad = msg => { throw new Error(`Unexpected response from the bill scanner (${msg}). Please enter this bill manually.`); };
  if (!b || typeof b !== 'object') bad('not an object');
  for (const key of ['vendor', 'purchase']) {
    if (!b[key] || typeof b[key] !== 'object') bad(`missing ${key}`);
  }
  for (const f of ['vendor_name', 'gstin', 'address', 'state']) {
    if (typeof b.vendor[f] !== 'string') bad(`vendor.${f}`);
  }
  for (const f of ['purchase_number', 'purchase_date', 'reported_supply_type']) {
    if (typeof b.purchase[f] !== 'string') bad(`purchase.${f}`);
  }
  if (!Array.isArray(b.products)) bad('products is not a list');
  b.products.forEach((p, i) => {
    if (!p || typeof p.product_name !== 'string') bad(`products[${i}].product_name`);
    // Numbers are nullable throughout — null is how the scanner says
    // "could not read this", which must stay distinguishable from zero.
    for (const f of ['quantity', 'rate', 'discount_percentage', 'gst_percentage']) {
      if (p[f] !== null && typeof p[f] !== 'number') bad(`products[${i}].${f}`);
    }
  });
}

// ── Review panel ─────────────────────────────────────
// Nothing reaches the form until the user presses Import here.
function renderScanReview(d) {
  const panel = document.getElementById('purchOcrReview');
  if (!panel) return;

  const line = (label, value) => `<div class="calc-row"><span class="label">${label}</span>
    <span class="value">${escScan(value) || '<span class="text-muted-sm">not found</span>'}</span></div>`;

  const itemRows = d.products.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escScan(it.product_name)}</td>
      <td>${escScan(it.hsn_code) || '&mdash;'} ${it.hsn_code && !isHsnOk(it.hsn_code) ? '<span class="badge badge-red" style="font-size:9px;">HSN?</span>' : ''}</td>
      <td class="text-center">${it.quantity ?? '&mdash;'}</td>
      <td class="text-right">${it.rate ?? '&mdash;'}</td>
      <td class="text-center">${it.discount_percentage ?? 0}%</td>
      <td class="text-center">${it.gst_percentage ?? 0}%</td>
      <td class="text-center">${productMatchBadge(it.product_name)}</td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="card mb-20" id="purchOcrCard">
      <div class="card-header">
        <span class="card-title"><i class="fas fa-file-invoice"></i> Review Scanned Bill</span>
        <span class="fs-12 text-muted-sm">${d.products.length} product row(s) read</span>
      </div>
      <div class="card-body">
        <div class="banner-warning mb-16">
          <div><i class="fas fa-circle-info"></i>Nothing is saved yet. Check the values below, press <b>Import</b> to fill the form, edit anything you like, then press <b>Save Purchase</b>.</div>
        </div>
        <div id="purchOcrDupWarn" class="fs-12 mb-10"></div>
        <div class="calc-box mb-16">
          ${line('Vendor Name', d.vendor.vendor_name)}
          ${line('GSTIN', d.vendor.gstin)}
          ${line('Address', d.vendor.address)}
          ${line('State', d.vendor.state)}
          ${line('Purchase Number', d.purchase.purchase_number)}
          ${line('Purchase Date', d.purchase.purchase_date)}
        </div>
        ${d.products.length ? `<div class="table-wrapper mb-16"><table class="data-table">
          <thead><tr><th>#</th><th>Product</th><th>HSN</th><th class="text-center">Qty</th>
            <th class="text-right">Rate</th><th class="text-center">Disc</th><th class="text-center">GST</th><th class="text-center">Master</th></tr></thead>
          <tbody>${itemRows}</tbody></table></div>`
          : '<div class="empty-state mb-16">No product rows were read — you can still import the header and add rows by hand.</div>'}
        <div class="fs-11 text-muted-sm mb-16">Blank fields are ones the bill reader could not read with confidence. Amounts are recalculated by this app from quantity, rate, discount and GST %, not taken from the bill.</div>
        <div class="d-flex gap-10">
          <button type="button" class="btn btn-primary" onclick="importScanIntoForm()"><i class="fas fa-file-import"></i> Import into Form</button>
          <button type="button" class="btn btn-secondary" onclick="dismissScanReview()">Cancel</button>
        </div>
      </div>
    </div>`;
  panel.classList.remove('d-none');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  warnIfPurchaseNumberExists(d.purchase.purchase_number);
}

function isHsnOk(hsn) {
  return typeof isValidHsnFormat !== 'function' || isValidHsnFormat(hsn);
}

function productMatchBadge(name) {
  const list = typeof purchProductsList !== 'undefined' ? purchProductsList : [];
  const match = typeof findProductByName === 'function' ? findProductByName(list, name) : null;
  return match
    ? '<span class="badge badge-green" style="font-size:9px;">matched</span>'
    : '<span class="badge" style="font-size:9px;background:#eceff1;color:#546e7a;">new</span>';
}

// Read-only check, mirroring the duplicate test savePurchase() already runs.
async function warnIfPurchaseNumberExists(num) {
  const slot = document.getElementById('purchOcrDupWarn');
  if (!slot || !num) return;
  try {
    const user = await getCurrentUser();
    if (!user) return;
    const { data } = await _supabase.from('purchases').select('id')
      .eq('user_id', user.id).eq('purchase_number', num).single();
    if (data?.id) {
      slot.innerHTML = `<div class="banner-warning"><div><i class="fas fa-triangle-exclamation"></i>
        Purchase number <b>${escScan(num)}</b> already exists. Saving with this number will be rejected — change it after importing.</div></div>`;
    }
  } catch { /* no match, or offline — the save-time check remains authoritative */ }
}

function dismissScanReview() {
  scanExtracted = null;
  const panel = document.getElementById('purchOcrReview');
  if (panel) { panel.innerHTML = ''; panel.classList.add('d-none'); }
}

// ── Import into the form ─────────────────────────────
// Every write goes through the form's own handlers, and every field the
// user has already touched is left alone.
function importScanIntoForm() {
  const d = scanExtracted;
  if (!d) return;

  setIfUntouched('purchVendorName', d.vendor.vendor_name);
  if (typeof onPurchVendorInput === 'function') onPurchVendorInput();   // vendor auto-fill + Save Vendor / Skip panel

  setIfUntouched('purchGstin', d.vendor.gstin);
  if (typeof onPurchGstinInput === 'function') onPurchGstinInput(document.getElementById('purchGstin'));
  if (typeof onPurchGstinBlur === 'function') onPurchGstinBlur();       // GSTIN validation + vendor-by-GSTIN lookup

  setIfUntouched('purchAddress', d.vendor.address);
  setIfUntouched('purchState', matchStateOption(d.vendor.state));
  setIfUntouched('purchNum', d.purchase.purchase_number);
  setIfUntouched('purchDate', d.purchase.purchase_date);
  // Supply type stays derived. Gemini reports what the bill charged
  // (reported_supply_type), but detectPurchSupplyType() decides it from
  // the business/vendor state pair — the same authority as typed entry.
  if (typeof detectPurchSupplyType === 'function') detectPurchSupplyType();

  if (d.products.length) importScanItems(d.products);

  dismissScanReview();
  showToast(`Imported ${d.products.length} product row(s). Review, then press Save Purchase.`, 'success');
}

// purchState is a <select>, so a value that isn't one of its options
// silently leaves the field blank. Resolve against the app's own state
// list first, tolerating case and spacing differences.
function matchStateOption(state) {
  if (!state) return '';
  const list = typeof INDIAN_STATES !== 'undefined' ? INDIAN_STATES : [];
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');
  return list.find(s => norm(s) === norm(state)) || '';
}

// Rows go in through loadPurchItemsIntoTable() — the same bulk path the
// Edit-purchase flow uses. One render for any number of rows, and it
// sets each row's Product Master match (and lock) itself. Values are
// then computed by recalcPurchItemRowLive(), so GST/taxable/total come
// from the app's own calcGST(), never from the bill.
function importScanItems(items) {
  const existing = (typeof purchItems !== 'undefined' ? purchItems : [])
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
    // recalcPurchItemRowLive() derives them below.
  })));

  loadPurchItemsIntoTable(rows);
  purchItems.forEach(r => { if (typeof recalcPurchItemRowLive === 'function') recalcPurchItemRowLive(r.rowId); });
  if (typeof renderPurchItemsTable === 'function') renderPurchItemsTable();
  if (typeof computePurchRollups === 'function') computePurchRollups();

  const unmatched = items.filter(it => !(typeof findProductByName === 'function'
    && findProductByName(purchProductsList || [], it.product_name)));
  if (unmatched.length) {
    showToast(`${unmatched.length} product(s) are not in Product Master — use Quick Add on the row to save them.`, 'info');
  }
}

// Some fields arrive pre-populated by the form itself rather than by the
// user: initPurchaseEntry() stamps purchDate with today on every New
// Purchase. Nobody typed that, so it must not block the bill's own date
// the way a real edit does. Every other field the scanner writes starts
// empty, or is filled from an explicit vendor prefill / an edited
// purchase — all genuine choices worth protecting.
function isFormDefault(id, current) {
  return id === 'purchDate' && typeof toISO === 'function' && current === toISO(new Date());
}

// A field is written only if it is still empty, still holds the form's
// own default, or still holds exactly what a previous import put there.
// Anything the user has typed or corrected wins.
function setIfUntouched(id, value) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  const current = (el.value || '').trim();
  // user edited it — leave alone
  if (current && current !== (scanAppliedValues[id] || '') && !isFormDefault(id, current)) return;
  el.value = value;
  scanAppliedValues[id] = value;
  el.classList.add('scan-filled');
  el.addEventListener('input', () => {
    el.classList.remove('scan-filled');
    delete scanAppliedValues[id];
  }, { once: true });
}

// ── Progress ─────────────────────────────────────────
function showScanProgress(msg) {
  const el = document.getElementById('purchOcrProgress');
  if (!el) return;
  el.innerHTML = `<div class="banner-warning"><div><i class="fas fa-spinner fa-spin"></i> ${escScan(msg)} This can take a few seconds.</div></div>`;
  el.classList.remove('d-none');
}
function hideScanProgress() {
  const el = document.getElementById('purchOcrProgress');
  if (el) { el.innerHTML = ''; el.classList.add('d-none'); }
}

function escScan(v) { return (v || '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
