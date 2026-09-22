// =============================================
// Purchase Bill Scanner — Bill → Gemini → Purchase Entry
//
// Uploads a supplier bill to our own backend (/api/bill-scan), which
// asks Gemini to read it and returns structured JSON.
//
// One file is one bill is one Purchase Entry. Several files can be picked
// in one go: each is scanned separately, in turn, through the same
// one-document endpoint, and each is imported and saved on its own, so
// four bills become four purchases and the lines of one never land on
// another. A bill printed across several PAGES is still a single file, so
// it is still a single scan and a single purchase — the pages of one bill
// are not separate bills. The Gemini API key
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

let scanExtracted = null;      // the bill being reviewed right now
let scanAppliedValues = {};    // what Import wrote, per field id — basis of "never overwrite user edits"

// ── The upload queue ─────────────────────────────────
// One entry per file the user picked. Each file is a bill in its own
// right: its own scan, its own review, its own Save Purchase. Files are
// never combined — a page of one bill and a page of another have nothing
// to do with each other — while a bill that runs to several PAGES is one
// file, goes up in one request, and stays one purchase exactly as before.
//
//   status: 'waiting' | 'scanning' | 'ready' | 'imported' | 'failed'
let billQueue = [];
let billSelectedId = null;     // the bill whose details are on screen
let billScanRunning = false;   // one scan at a time - see runBillQueue()
let billSeq = 0;
// The bill whose values are sitting in the form, unsaved. Set on Import,
// and only cleared once the form has been emptied (Save Purchase clears
// it) - it is what stops a second bill's lines landing on top of a first
// bill's, which would silently merge two suppliers' goods into one entry.
let billInForm = null;

// ── Entry point ──────────────────────────────────────
// Takes the input's whole FileList. A single File is still accepted, so
// any existing one-file caller keeps working unchanged.
async function handlePurchaseBillUpload(selection) {
  const files = selection && typeof selection.length === 'number'
    ? Array.from(selection)
    : (selection ? [selection] : []);
  if (!files.length) return;

  // Each file is judged on its own: one unusable file among four does not
  // throw away the other three, it simply is not queued.
  const good = [];
  const rejected = [];
  for (const f of files) {
    const problem = billFileProblem(f);
    if (problem) rejected.push({ name: f.name, problem });
    else good.push(f);
  }
  if (rejected.length) {
    showToast(files.length === 1
      ? rejected[0].problem
      : `${rejected.length} file(s) skipped — ${rejected[0].name}: ${rejected[0].problem}`, 'error');
  }
  if (!good.length) return;

  // A new upload replaces whatever the previous one left behind, the same
  // way the customer-invoice scanner treats a fresh selection.
  billPanelScrolled = false;    // a fresh selection deserves to be shown
  billQueue = good.map(f => ({
    id: 'bill' + (++billSeq), file: f, name: f.name, size: f.size,
    status: 'waiting', result: null, error: ''
  }));
  billSelectedId = null;
  scanExtracted = null;
  renderBillQueue();
  await runBillQueue();
}

// The same two rules the scanner has always applied, per file, worded as
// they always were so a single bad file reads exactly as it used to.
function billFileProblem(file) {
  if (!file) return 'No file.';
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) return 'Upload a PDF, JPG, JPEG or PNG bill.';
  if (file.size > 10 * 1024 * 1024) return 'That file is over 10 MB — try a smaller scan.';
  return '';
}

// Works through the queue ONE BILL AT A TIME. Deliberately sequential:
// every file is a separate document to read, and firing all of them at
// once would multiply the upload, the server's work and the rate limit by
// however many files someone happened to select. A failure stops that
// bill only — the queue carries on, and the failed one can be retried.
async function runBillQueue() {
  if (billScanRunning) return;
  billScanRunning = true;
  const input = document.getElementById('purchBillInput');
  if (input) input.disabled = true;
  try {
    for (;;) {
      const job = billQueue.find(j => j.status === 'waiting');
      if (!job) break;
      job.status = 'scanning';
      const position = billQueue.indexOf(job) + 1;
      showScanProgress(billQueue.length === 1
        ? 'Analysing bill…'
        : `Analysing bill ${position} of ${billQueue.length}: ${job.name}`);
      renderBillQueue();

      const started = Date.now();
      try {
        const data = await sendBillForScan(job.file);
        console.log(`[bill-scan] ${Date.now() - started}ms model=${data.model || 'unknown'} OK products=${data.products.length} file=${job.name}`);
        if (!data.products.length && !data.vendor.vendor_name) {
          job.status = 'failed';
          job.error = 'Nothing could be read from that bill. Please enter it manually.';
          if (billQueue.length === 1) showToast(job.error, 'warning');
        } else {
          job.status = 'ready';
          job.result = data;
          if (!billSelectedId) { billSelectedId = job.id; scanExtracted = data; }
        }
      } catch (err) {
        job.status = 'failed';
        job.error = (err && err.message) || 'Could not read that bill.';
        console.log(`[bill-scan] ${Date.now() - started}ms FAIL ${job.error} file=${job.name}`);
        handleApiError(err, billQueue.length === 1 ? 'Could not read that bill' : `Could not read ${job.name}`);
      }
      renderBillQueue();
    }
  } finally {
    hideScanProgress();
    billScanRunning = false;
    // Re-enabled and emptied so the very same files can be picked again -
    // a retry after a failure, or a deliberate second import.
    if (input) { input.disabled = false; input.value = ''; }
  }
}

// A bill that could not be read is put back in the queue and scanned
// again. Nothing else in the queue is disturbed.
function retryScannedBill(id) {
  const job = billQueue.find(j => j.id === id);
  if (!job || job.status !== 'failed') return;
  job.status = 'waiting';
  job.error = '';
  renderBillQueue();
  runBillQueue();
}

function selectScannedBill(id) {
  const job = billQueue.find(j => j.id === id);
  if (!job || job.status !== 'ready') return;
  billSelectedId = id;
  scanExtracted = job.result;
  renderBillQueue();
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
    throw { message: 'Could not reach the server — check your connection and try again.', code: 'network', status: 0, networkError: true };
  }

  const body = await res.json().catch(() => null);
  // apiErrorFrom() (js/apiClient.js) rather than a bare Error, so the
  // status survives to the toast: bill scanning answers 503 when
  // GEMINI_API_KEY isn't set, 502 when the upstream analysis fails and
  // 401 on an expired session — three completely different things to
  // tell the user, all previously flattened into one red message.
  if (!res.ok) throw apiErrorFrom(res, body);
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
  for (const f of ['vendor_name', 'gstin', 'address', 'state', 'phone', 'email']) {
    if (typeof b.vendor[f] !== 'string') bad(`vendor.${f}`);
  }
  if (!b.totals || typeof b.totals !== 'object') bad('missing totals');
  if (!Array.isArray(b.warnings)) bad('warnings is not a list');
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
//
// One file is shown exactly as it always was. Several files are shown as
// a list - file name, what was read from it, and where it has got to -
// with the selected bill's details underneath. The list is the only way
// to tell four bills apart, and keeping one detail panel means the rows
// of one bill can never appear under the heading of another.
let billPanelScrolled = false;

function billStatusBadge(job) {
  const map = {
    waiting:  ['badge', 'Waiting'],
    scanning: ['badge badge-blue', 'Scanning…'],
    ready:    ['badge badge-green', 'Review ready'],
    imported: ['badge badge-green', 'Imported'],
    failed:   ['badge badge-red', 'Failed']
  };
  const [cls, text] = map[job.status] || ['badge', job.status];
  return `<span class="${cls}">${text}</span>`;
}

function billQueueRow(job) {
  const d = job.result;
  const selectable = job.status === 'ready';
  const isSel = job.id === billSelectedId;
  return `
    <tr${selectable ? ` style="cursor:pointer;" onclick="selectScannedBill('${job.id}')"` : ''}>
      <td>${selectable
        ? `<input type="radio" name="purchBillPick" ${isSel ? 'checked' : ''} onclick="event.stopPropagation();selectScannedBill('${job.id}')" aria-label="Review ${escScan(job.name)}">`
        : ''}</td>
      <td class="fs-12${isSel ? ' fw-600' : ''}">${escScan(job.name)}</td>
      <td>${d ? (escScan(d.purchase.purchase_number) || '<span class="text-muted-sm">no number</span>') : '&mdash;'}</td>
      <td>${d ? (escScan(d.purchase.purchase_date) || '&mdash;') : '&mdash;'}</td>
      <td>${d ? (escScan(d.vendor.vendor_name) || '&mdash;') : '&mdash;'}</td>
      <td class="text-center">${d ? d.products.length : '&mdash;'}</td>
      <td>${billStatusBadge(job)}${job.error ? `<div class="fs-11 text-muted-sm">${escScan(job.error)}</div>` : ''}</td>
      <td class="text-right">${job.status === 'failed'
        ? `<button type="button" class="btn btn-secondary btn-sm" onclick="event.stopPropagation();retryScannedBill('${job.id}')"><i class="fas fa-rotate-right"></i> Retry</button>`
        : ''}</td>
    </tr>`;
}

// The details of ONE bill - the panel this scanner has always shown.
function billDetailMarkup(d) {
  const line = (label, value) => `<div class="calc-row"><span class="label">${label}</span>
    <span class="value">${escScan(value) || '<span class="text-muted-sm">not found</span>'}</span></div>`;

  const itemRows = d.products.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escScan(it.product_name)}</td>
      <td>${escScan(it.hsn_code) || '&mdash;'} ${it.hsn_code && !isHsnOk(it.hsn_code) ? '<span class="badge badge-red" style="font-size:9px;">HSN?</span>' : ''}</td>
      <td class="text-center">${it.quantity ?? '<span class="badge badge-red" style="font-size:9px;">not read</span>'}</td>
      <td class="text-right">${it.rate ?? '<span class="badge badge-red" style="font-size:9px;">not read</span>'}</td>
      <td class="text-center">${it.discount_percentage ?? 0}%</td>
      <td class="text-center">${it.gst_percentage ?? 0}%</td>
      <td class="text-center">${productMatchBadge(it.product_name)}</td>
    </tr>`).join('');

  return `
      <div class="card-body">
        <div class="banner-warning mb-16">
          <div><i class="fas fa-circle-info"></i>Nothing is saved yet. Check the values below, press <b>Import</b> to fill the form, edit anything you like, then press <b>Save Purchase</b>.</div>
        </div>
        <div id="purchOcrDupWarn" class="fs-12 mb-10"></div>
        ${renderScanWarnings(d.warnings)}
        <div class="calc-box mb-16">
          ${line('Vendor Name', d.vendor.vendor_name)}
          ${line('GSTIN', d.vendor.gstin)}
          ${line('Phone', d.vendor.phone)}
          ${line('Email', d.vendor.email)}
          ${line('Address', d.vendor.address)}
          ${line('State', d.vendor.state)}
          ${line('Purchase Number', d.purchase.purchase_number)}
          ${line('Purchase Date', d.purchase.purchase_date)}
        </div>
        ${renderBillTotals(d.totals)}
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
      </div>`;
}

// Draws whatever the queue currently is. Called after every state change:
// a scan starting, a scan finishing, an import, a retry.
function renderBillQueue() {
  const panel = document.getElementById('purchOcrReview');
  if (!panel) return;

  const single = billQueue.length === 1;
  const selected = billQueue.find(j => j.id === billSelectedId && j.status === 'ready');

  // A single bill behaves exactly as before: the panel appears when the
  // scan has something to show, and not while it is running or if it
  // failed - those are a progress banner and a toast, as they always were.
  if (single) {
    const job = billQueue[0];
    if (job.status !== 'ready') { hideBillPanel(panel); return; }
    panel.innerHTML = `
    <div class="card mb-20" id="purchOcrCard">
      <div class="card-header">
        <span class="card-title"><i class="fas fa-file-invoice"></i> Review Scanned Bill</span>
        <span class="fs-12 text-muted-sm">${job.result.products.length} product row(s) read</span>
      </div>
      ${billDetailMarkup(job.result)}
    </div>`;
    showBillPanel(panel, job.result.purchase.purchase_number);
    return;
  }

  if (!billQueue.length) { hideBillPanel(panel); return; }

  const imported = billQueue.filter(j => j.status === 'imported').length;
  const detail = selected
    ? billDetailMarkup(selected.result)
    : `<div class="card-body"><div class="empty-state">${billQueue.some(j => j.status === 'waiting' || j.status === 'scanning')
        ? 'Reading the bills — each one is scanned in turn.'
        : (imported === billQueue.length
          ? 'Every scanned bill has been imported.'
          : 'Pick a bill above to review it.')}</div></div>`;

  panel.innerHTML = `
    <div class="card mb-20" id="purchOcrCard">
      <div class="card-header">
        <span class="card-title"><i class="fas fa-file-invoice"></i> Review Scanned Bills</span>
        <span class="fs-12 text-muted-sm">${billQueue.length} file(s) &middot; ${imported} imported</span>
      </div>
      <div class="card-body pb-0">
        <div class="banner-warning mb-16">
          <div><i class="fas fa-circle-info"></i>Each file is a separate bill and becomes its own purchase.
          Import one, press <b>Save Purchase</b>, then come back for the next. Nothing is saved yet.</div>
        </div>
        <div class="table-wrapper mb-16"><table class="data-table">
          <thead><tr><th style="width:36px;"></th><th>File</th><th>Bill No</th><th>Date</th><th>Vendor</th>
            <th class="text-center">Items</th><th>Status</th><th></th></tr></thead>
          <tbody>${billQueue.map(billQueueRow).join('')}</tbody></table></div>
      </div>
      ${detail}
    </div>`;
  showBillPanel(panel, selected ? selected.result.purchase.purchase_number : '');
}

function showBillPanel(panel, purchaseNumber) {
  panel.classList.remove('d-none');
  if (!billPanelScrolled) {
    billPanelScrolled = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (purchaseNumber) warnIfPurchaseNumberExists(purchaseNumber);
}

function hideBillPanel(panel) {
  panel.innerHTML = '';
  panel.classList.add('d-none');
}

// Things the scan is not confident about. Shown before the values
// themselves, because they change how the rest of the panel should be
// read: a figure left blank on a handwritten bill was not missing, it
// was unreadable, and someone has to look at the paper to settle it.
function renderScanWarnings(warnings) {
  if (!warnings || !warnings.length) return '';
  return `<div class="banner-warning mb-16"><div>
    <i class="fas fa-triangle-exclamation"></i>
    ${warnings.map(escScan).join('<br>')}
  </div></div>`;
}

// What the BILL printed, shown for cross-checking only. None of it is
// imported: the form recomputes every figure from quantity, rate,
// discount and GST % via calcGST(), exactly as for a typed purchase.
// Seeing the two side by side is what makes a misread line obvious
// before the user presses Save Purchase.
function renderBillTotals(t) {
  if (!t) return '';
  const rows = [
    ['Taxable Value', t.reported_taxable_value ?? t.reported_subtotal],
    ['CGST', t.reported_cgst_amount],
    ['SGST', t.reported_sgst_amount],
    ['IGST', t.reported_igst_amount],
    ['CESS', t.reported_cess_amount],
    ['Round Off', t.reported_round_off],
    ['Grand Total', t.reported_grand_total]
  ].filter(([, v]) => v !== null && v !== undefined);
  if (!rows.length) return '';

  return `<div class="calc-box mb-16">
    <div class="fs-11 text-muted-sm mb-10">Totals printed on the bill &mdash; for checking only. This app recalculates its own figures from the rows below.</div>
    ${rows.map(([label, v]) => `<div class="calc-row"><span class="label">${label}</span>
      <span class="value">${formatNum(v)}</span></div>`).join('')}
  </div>`;
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
  billQueue = [];
  billSelectedId = null;
  billPanelScrolled = false;
  const panel = document.getElementById('purchOcrReview');
  if (panel) { panel.innerHTML = ''; panel.classList.add('d-none'); }
}

// ── Import into the form ─────────────────────────────
// Every write goes through the form's own handlers, and every field the
// user has already touched is left alone.
function importScanIntoForm() {
  const job = billQueue.find(j => j.id === billSelectedId && j.status === 'ready')
    || billQueue.find(j => j.status === 'ready');
  const d = job ? job.result : scanExtracted;
  if (!d) return;

  // One bill at a time reaches the form. A bill already imported and not
  // yet saved still owns the vendor, the number and the item rows, and
  // importing a second one on top of it would merge two suppliers' goods
  // into a single purchase - the one thing this whole queue exists to
  // prevent. Save Purchase empties the form, which releases the hold.
  if (job && billInForm && billInForm !== job.id && formHoldsImportedBill()) {
    showToast('Save the bill already in the form first — then import the next one.', 'warning');
    return;
  }
  // Each import starts its own record of what it wrote, so "never
  // overwrite what the user typed" is judged against THIS bill.
  scanAppliedValues = {};

  setIfUntouched('purchVendorName', d.vendor.vendor_name);
  if (typeof onPurchVendorInput === 'function') onPurchVendorInput();   // vendor auto-fill + Save Vendor / Skip panel

  setIfUntouched('purchGstin', d.vendor.gstin);
  if (typeof onPurchGstinInput === 'function') onPurchGstinInput(document.getElementById('purchGstin'));
  if (typeof onPurchGstinBlur === 'function') onPurchGstinBlur();       // GSTIN validation + vendor-by-GSTIN lookup

  setIfUntouched('purchPhone', d.vendor.phone);
  setIfUntouched('purchAddress', d.vendor.address);
  setIfUntouched('purchState', matchStateOption(d.vendor.state));
  setIfUntouched('purchNum', d.purchase.purchase_number);
  setIfUntouched('purchDate', d.purchase.purchase_date);
  // Supply type stays derived. Gemini reports what the bill charged
  // (reported_supply_type), but detectPurchSupplyType() decides it from
  // the business/vendor state pair — the same authority as typed entry.
  if (typeof detectPurchSupplyType === 'function') detectPurchSupplyType();

  if (d.products.length) importScanItems(d.products);

  if (!job) {                       // nothing queued - the old direct path
    dismissScanReview();
    showToast(`Imported ${d.products.length} product row(s). Review, then press Save Purchase.`, 'success');
    return;
  }

  job.status = 'imported';
  billInForm = job.id;
  // Take ONLY this bill off the list of things to import; the rest stay
  // exactly as they were, scanned and waiting, so the user can save this
  // purchase and come straight back for the next without re-uploading.
  const remaining = billQueue.filter(j => j.status === 'ready');
  billSelectedId = remaining.length ? remaining[0].id : null;
  scanExtracted = remaining.length ? remaining[0].result : null;

  if (!billQueue.some(j => j.status !== 'imported')) {
    dismissScanReview();            // everything from this upload is in
    showToast(billQueue.length > 1
      ? `Imported ${d.products.length} product row(s) from ${job.name}. That was the last scanned bill — press Save Purchase to finish.`
      : `Imported ${d.products.length} product row(s). Review, then press Save Purchase.`, 'success');
    return;
  }

  renderBillQueue();
  showToast(`Imported ${d.products.length} product row(s) from ${job.name}. Press Save Purchase, then import the next of ${remaining.length} remaining.`, 'success');
}

// Is an imported bill still sitting in the form, unsaved? Judged by the
// item grid, because Save Purchase empties it (clearPurchaseFormFields()
// in js/purchase-entry.js) and nothing else does.
function formHoldsImportedBill() {
  const rows = (typeof purchItems !== 'undefined' && Array.isArray(purchItems)) ? purchItems : [];
  if (rows.some(r => r.product_name)) return true;
  const num = document.getElementById('purchNum');
  return !!(num && num.value.trim());
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
