// =============================================
// Delivery Challans (Phase 2, Module 4C)
// =============================================
// One page for the four delivery challan variants: job work, supply on
// approval, liquid gas, and movement other than by way of supply.
//
// A delivery challan moves goods WITHOUT supplying them. That single fact
// decides most of this file: there is no customer GSTIN requirement, no
// tax to charge, no invoice total, and nothing here reaches B2B, B2CS,
// B2CL, the HSN summary or any liability. The declared value exists
// because Rule 55 asks for it, not because anything is owed on it.
//
// As with the vouchers page, the registry decides behaviour: which
// numbering modes are offered, whether the document may be cancelled,
// which Table 13 row it lands in. The four variants differ from each
// other only in the extra field each one needs, which is the table below.

let dcRows = [];          // challans of the currently selected variant
let dcJobWorkers = [];
let dcCustomers = [];
let dcProducts = [];
let dcItems = [];         // line items being edited
let dcEditId = null;
let dcUserId = null;

// Presentation only. What each variant MEANS is in the registry; what it
// cannot say is which extra question the form has to ask.
const DC_FORMS = {
  dc_job_work: {
    party: 'job_worker',
    partyLabel: 'Job Worker',
    // Rule 45: inputs back within a year, capital goods within three.
    extra: 'expected_return_date',
    extraLabel: 'Expected return date',
    hint: 'Goods sent to a job worker under Rule 45. The job worker is not a customer and nothing is sold.'
  },
  dc_approval: {
    party: 'customer',
    partyLabel: 'Sent to',
    // Section 31(7): invoice by acceptance or six months, whichever first.
    extra: 'approval_due_date',
    extraLabel: 'Invoice due by (6 months)',
    hint: 'Goods sent on approval. An invoice follows only if and when they are accepted.'
  },
  dc_liquid_gas: {
    party: 'customer',
    partyLabel: 'Sent to',
    extra: 'quantity_known_at_dispatch',
    extraLabel: 'Quantity known at dispatch',
    hint: 'Rule 55(1)(a): where the quantity is not known when the gas leaves, the challan records what was dispatched.'
  },
  dc_other: {
    party: 'customer',
    partyLabel: 'Sent to',
    extra: null,
    hint: 'Movement that is not a supply — stock transfer, exhibition, repair, and the like.'
  }
};

function dcType() { return document.getElementById('dcType')?.value || 'dc_job_work'; }
function dcForm() { return DC_FORMS[dcType()] || DC_FORMS.dc_other; }
function dcSpec() { return gstDocumentTypeSpec(dcType()); }

function dcEl(id) { return document.getElementById(id); }
function dcVal(id) { return (dcEl(id)?.value || '').trim(); }
function dcNum(id) { const n = parseFloat(dcEl(id)?.value); return Number.isFinite(n) ? n : 0; }

// ── Boot ────────────────────────────────────────────────────
async function initChallans() {
  const user = await requireAuth();
  if (!user) return;
  dcUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const sel = dcEl('dcType');
  if (sel) {
    // The list comes from the registry, so a fifth challan variant would
    // appear here without this file changing.
    sel.innerHTML = Object.keys(DC_FORMS)
      .filter(k => gstDocumentTypeEnabled(k))
      .map(k => `<option value="${escHtmlAttr(k)}">${escItemHtml(gstDocumentTypeLabel(k))}</option>`)
      .join('');
  }

  const [jw, cust, prod] = await Promise.all([
    _supabase.from('job_workers').select('*').eq('user_id', dcUserId),
    _supabase.from('customers').select('*').eq('user_id', dcUserId),
    _supabase.from('products').select('*').eq('user_id', dcUserId)
  ]);
  dcJobWorkers = jw.data || [];
  dcCustomers = cust.data || [];
  dcProducts = prod.data || [];

  const d = dcEl('dcDate');
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);

  onChallanTypeChange();
  await loadChallans();
  renderJobWorkers();
}

// ── The registry, shown rather than hidden ──────────────────
// The same panel the vouchers page carries. Someone entering a challan
// should be able to see why it will not appear in their sales figures.
function renderDcRegistryPanel() {
  const box = dcEl('dcRegistryBox');
  if (!box) return;
  const s = dcSpec();
  if (!s) { box.innerHTML = ''; return; }
  const row = typeof gstTable13RowFor === 'function' ? gstTable13RowFor(dcType()) : null;
  const yn = v => v ? '<span class="text-danger fw-600">Yes</span>' : '<span class="text-success fw-600">No</span>';
  box.innerHTML = `
    <div class="d-flex gap-16 flex-wrap fs-12">
      <div><span class="text-muted">Rule</span> <b>${escItemHtml(s.rule || '—')}</b></div>
      <div><span class="text-muted">Filed in</span> <b>${escItemHtml(gstDocumentSections(dcType()).map(x => `${x.ret} ${x.table}`).join(' · ') || '—')}</b></div>
      <div><span class="text-muted">Table 13 row</span> <b>${row ? row.docNum : '—'}</b></div>
      <div><span class="text-muted">Taxable supply</span> ${yn(s.taxable)}</div>
      <div><span class="text-muted">Counts in turnover</span> ${yn(s.affectsTurnover)}</div>
      <div><span class="text-muted">Feeds HSN summary</span> ${yn(s.affectsHsn)}</div>
      <div><span class="text-muted">Creates liability</span> ${yn(s.affectsLiability)}</div>
    </div>`;
}

function onChallanTypeChange() {
  const f = dcForm();
  const hint = dcEl('dcHint');
  if (hint) hint.textContent = f.hint || '';

  // Which party master applies is a registry question — job work names a
  // job worker, the rest name a customer.
  const jwWrap = dcEl('dcJobWorkerWrap'), custWrap = dcEl('dcCustomerWrap');
  if (jwWrap) jwWrap.classList.toggle('d-none', f.party !== 'job_worker');
  if (custWrap) custWrap.classList.toggle('d-none', f.party === 'job_worker');
  const partyLbl = dcEl('dcPartyLabel');
  if (partyLbl) partyLbl.textContent = f.partyLabel;

  if (jwWrap) {
    dcEl('dcJobWorker').innerHTML = '<option value="">— select job worker —</option>' +
      dcJobWorkers.map(j => `<option value="${escHtmlAttr(j.id)}">${escItemHtml(j.name)}${j.gstin ? ' · ' + escItemHtml(j.gstin) : ''}</option>`).join('');
  }
  if (custWrap) {
    dcEl('dcCustomer').innerHTML = '<option value="">— select or type below —</option>' +
      dcCustomers.map(c => `<option value="${escHtmlAttr(c.id)}">${escItemHtml(c.customer_name || c.name || '')}</option>`).join('');
  }

  // The variant's own extra question.
  const extraWrap = dcEl('dcExtraWrap');
  if (extraWrap) {
    if (!f.extra) extraWrap.classList.add('d-none');
    else {
      extraWrap.classList.remove('d-none');
      dcEl('dcExtraLabel').textContent = f.extraLabel;
      const isBool = f.extra === 'quantity_known_at_dispatch';
      dcEl('dcExtraDate').classList.toggle('d-none', isBool);
      dcEl('dcExtraBoolWrap').classList.toggle('d-none', !isBool);
    }
  }

  // Numbering and cancellation follow the registry, not this page.
  const autoBtn = dcEl('dcAutoNumberBtn');
  if (autoBtn) autoBtn.classList.toggle('d-none', !gstDocumentSupportsAutoNumbering(dcType()));
  const numEl = dcEl('dcNumber');
  if (numEl) numEl.readOnly = !gstDocumentSupportsManualNumbering(dcType());

  renderDcRegistryPanel();
  loadChallans();
}

// ── Line items ──────────────────────────────────────────────
function dcAddItem(item) {
  dcItems.push(Object.assign({
    product_name: '', hsn_code: '', unit: '', quantity: 1, rate: 0, taxable_value: 0
  }, item || {}));
  renderDcItems();
}
function dcRemoveItem(i) { dcItems.splice(i, 1); renderDcItems(); }

function dcOnItemChange(i, field, value) {
  const it = dcItems[i];
  if (!it) return;
  it[field] = value;
  if (field === 'product_name') {
    // Pulling HSN and unit from the product master rather than asking
    // twice. `productEffective` applies the per-product GST overrides, so
    // a corrected unit shows here too.
    const p = dcProducts.find(x => (x.product_name || '').toLowerCase() === String(value).toLowerCase());
    if (p) {
      const eff = typeof productEffective === 'function' ? productEffective(p) : p;
      it.hsn_code = eff.hsn_code || '';
      it.unit = eff.unit || '';
      if (!it.rate) it.rate = eff.selling_price || 0;
    }
  }
  it.taxable_value = round2((parseFloat(it.quantity) || 0) * (parseFloat(it.rate) || 0));
  renderDcItems();
}

function renderDcItems() {
  const body = dcEl('dcItemsBody');
  if (!body) return;
  if (!dcItems.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-16">No items yet — add the goods being moved.</td></tr>`;
  } else {
    body.innerHTML = dcItems.map((it, i) => `
      <tr>
        <td><input class="form-control form-control-sm" list="dcProductList" value="${escHtmlAttr(it.product_name)}"
             onchange="dcOnItemChange(${i},'product_name',this.value)"></td>
        <td><input class="form-control form-control-sm w-110" value="${escHtmlAttr(it.hsn_code || '')}"
             onchange="dcOnItemChange(${i},'hsn_code',this.value)"></td>
        <td><input class="form-control form-control-sm w-90" value="${escHtmlAttr(it.unit || '')}"
             onchange="dcOnItemChange(${i},'unit',this.value)" list="dcUqcList"></td>
        <td><input type="number" step="0.001" class="form-control form-control-sm w-100 text-right" value="${it.quantity}"
             onchange="dcOnItemChange(${i},'quantity',this.value)"></td>
        <td><input type="number" step="0.01" class="form-control form-control-sm w-110 text-right" value="${it.rate}"
             onchange="dcOnItemChange(${i},'rate',this.value)"></td>
        <td class="text-right fw-600">${formatCurrency(it.taxable_value || 0)}</td>
        <td class="text-center"><button type="button" class="btn btn-sm btn-danger" onclick="dcRemoveItem(${i})"><i class="fas fa-times"></i></button></td>
      </tr>`).join('');
  }
  const total = dcItems.reduce((s, it) => s + (parseFloat(it.taxable_value) || 0), 0);
  const tv = dcEl('dcTotalValue');
  if (tv) tv.textContent = formatCurrency(round2(total));
  const hidden = dcEl('dcTaxableValue');
  if (hidden) hidden.value = round2(total);
}

// ── Numbering ───────────────────────────────────────────────
// All four variants draw on ONE numbering book, which is what the
// registry says and what Rule 55 describes. The server issues the number;
// this only asks for it.
async function dcAutoNumber() {
  if (!gstDocumentSupportsAutoNumbering(dcType())) return;
  try {
    const res = await apiFetch('/documents/reserve-number', {
      method: 'POST', body: JSON.stringify({ documentType: dcType() })
    });
    if (res && res.documentNumber) dcEl('dcNumber').value = res.documentNumber;
  } catch (e) {
    showFormError('dcNumberError', 'Could not issue a number: ' + (e.message || e));
  }
}

// ── Validation ──────────────────────────────────────────────
function validateChallan() {
  const errors = {};
  const f = dcForm();
  if (!dcVal('dcNumber')) errors.dcNumberError = 'A challan number is required.';
  if (!dcVal('dcDate')) errors.dcDateError = 'A challan date is required.';

  if (f.party === 'job_worker') {
    if (!dcVal('dcJobWorker') && !dcVal('dcPartyName')) {
      errors.dcPartyNameError = 'A job worker must be named — Rule 45 requires the place the goods went to.';
    }
  } else if (!dcVal('dcCustomer') && !dcVal('dcPartyName')) {
    errors.dcPartyNameError = 'Name who the goods were sent to.';
  }

  if (!dcItems.length) errors.dcItemsError = 'A challan must list the goods being moved.';
  if (dcItems.some(it => !String(it.product_name || '').trim())) {
    errors.dcItemsError = 'Every line needs a description of the goods.';
  }
  // Rule 55 wants the quantity; for liquid gas the dispatched quantity is
  // still recorded even though the delivered one is not yet known.
  if (dcItems.some(it => !(parseFloat(it.quantity) > 0))) {
    errors.dcItemsError = 'Every line needs a quantity.';
  }

  const dt = dcVal('dcDate');
  if (dt && typeof GST_COMMENCEMENT === 'string' && dt < GST_COMMENCEMENT) {
    errors.dcDateError = `GST began on ${GST_COMMENCEMENT}; a challan cannot be dated before it.`;
  }
  return errors;
}

function showFormError(id, msg) {
  const el = dcEl(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}
function clearDcErrors() {
  ['dcNumberError', 'dcDateError', 'dcPartyNameError', 'dcItemsError'].forEach(id => showFormError(id, ''));
}

// ── Save ────────────────────────────────────────────────────
async function saveChallan() {
  clearDcErrors();
  const errors = validateChallan();
  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([id, msg]) => showFormError(id, msg));
    return;
  }

  const f = dcForm();
  const jwId = f.party === 'job_worker' ? (dcVal('dcJobWorker') || null) : null;
  const custId = f.party === 'job_worker' ? null : (dcVal('dcCustomer') || null);
  const jw = dcJobWorkers.find(x => x.id === jwId);
  const cust = dcCustomers.find(x => x.id === custId);
  const partyName = dcVal('dcPartyName')
    || (jw && jw.name) || (cust && (cust.customer_name || cust.name)) || '';

  const doc = {
    // document_series and document_type are stamped by the server from
    // the registry — the page does not get to choose either.
    document_number: dcVal('dcNumber'),
    document_date: dcVal('dcDate'),
    status: 'issued',
    job_worker_id: jwId,
    customer_id: custId,
    party_name: partyName,
    party_gstin: (jw && jw.gstin) || (cust && cust.gst_number) || dcVal('dcPartyGstin') || null,
    from_address: dcVal('dcFromAddress') || null,
    from_state: dcVal('dcFromState') || null,
    to_address: dcVal('dcToAddress') || null,
    to_state: dcVal('dcToState') || null,
    place_of_supply: dcVal('dcPlaceOfSupply') || null,
    purpose: dcVal('dcPurpose') || null,
    reason: dcVal('dcReason') || null,
    transporter_name: dcVal('dcTransporter') || null,
    transporter_id: dcVal('dcTransporterId') || null,
    vehicle_number: dcVal('dcVehicle') || null,
    transport_mode: dcVal('dcTransportMode') || null,
    transport_distance: dcNum('dcDistance') || null,
    lr_number: dcVal('dcLrNumber') || null,
    eway_bill_number: dcVal('dcEwayBill') || null,
    taxable_value: round2(dcItems.reduce((s, it) => s + (parseFloat(it.taxable_value) || 0), 0)),
    total_value: round2(dcItems.reduce((s, it) => s + (parseFloat(it.taxable_value) || 0), 0)),
    notes: dcVal('dcNotes') || null
  };

  // The variant's own field.
  if (f.extra === 'expected_return_date') doc.expected_return_date = dcVal('dcExtraDate') || null;
  if (f.extra === 'approval_due_date') doc.approval_due_date = dcVal('dcExtraDate') || null;
  if (f.extra === 'quantity_known_at_dispatch') doc.quantity_known_at_dispatch = !!dcEl('dcExtraBool')?.checked;

  const items = dcItems.map((it, i) => ({
    product_name: String(it.product_name || '').trim(),
    hsn_code: it.hsn_code || null,
    unit: it.unit || null,
    quantity: parseFloat(it.quantity) || 0,
    rate: parseFloat(it.rate) || 0,
    taxable_value: round2(parseFloat(it.taxable_value) || 0),
    total_value: round2(parseFloat(it.taxable_value) || 0),
    sort_order: i
  }));

  try {
    await apiFetch(`/documents/${dcType()}/save`, {
      method: 'POST',
      body: JSON.stringify({ editId: dcEditId, document: doc, items })
    });
    resetChallanForm();
    await loadChallans();
    if (typeof showToast === 'function') showToast('Delivery challan saved.', 'success');
  } catch (e) {
    showFormError('dcNumberError', e.message || String(e));
  }
}

function resetChallanForm() {
  dcEditId = null;
  ['dcNumber', 'dcPartyName', 'dcPartyGstin', 'dcFromAddress', 'dcFromState', 'dcToAddress',
   'dcToState', 'dcPlaceOfSupply', 'dcPurpose', 'dcReason', 'dcTransporter', 'dcTransporterId',
   'dcVehicle', 'dcDistance', 'dcLrNumber', 'dcEwayBill', 'dcNotes', 'dcExtraDate']
    .forEach(id => { const el = dcEl(id); if (el) el.value = ''; });
  const jw = dcEl('dcJobWorker'); if (jw) jw.value = '';
  const cu = dcEl('dcCustomer'); if (cu) cu.value = '';
  const b = dcEl('dcExtraBool'); if (b) b.checked = true;
  const d = dcEl('dcDate'); if (d) d.value = new Date().toISOString().slice(0, 10);
  dcItems = [];
  renderDcItems();
  clearDcErrors();
  const t = dcEl('dcFormTitle'); if (t) t.textContent = 'New Delivery Challan';
}

// ── List ────────────────────────────────────────────────────
async function loadChallans() {
  if (!dcUserId) return;
  const { data, error } = await _supabase.from('delivery_challans').select('*').eq('user_id', dcUserId);
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the challans'); return; }
  // The table holds all four variants; this page shows one at a time.
  dcRows = (data || []).filter(r => r.document_type === dcType());
  dcRows.sort((a, b) => compareInvoiceNumbers(b.document_number, a.document_number));
  renderChallans();
}

function renderChallans() {
  const body = dcEl('dcListBody');
  if (!body) return;
  if (!dcRows.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-16">No ${escItemHtml(gstDocumentTypeLabel(dcType()).toLowerCase())} yet.</td></tr>`;
    return;
  }
  body.innerHTML = dcRows.map(r => {
    const cancelled = String(r.status).toLowerCase() === 'cancelled';
    return `<tr class="${cancelled ? 'text-muted' : ''}">
      <td class="fw-600">${escItemHtml(r.document_number)}</td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.party_name || '')}</td>
      <td class="text-right">${formatCurrency(r.total_value || 0)}</td>
      <td><span class="badge ${cancelled ? 'badge-danger' : 'badge-success'}">${cancelled ? 'Cancelled' : 'Issued'}</span></td>
      <td>${escItemHtml(r.eway_bill_number || '—')}</td>
      <td class="text-center">
        <button class="btn btn-sm btn-secondary" onclick="editChallan('${escHtmlAttr(r.id)}')" ${cancelled ? 'disabled' : ''}><i class="fas fa-pen"></i></button>
        <button class="btn btn-sm btn-warning" onclick="cancelChallan('${escHtmlAttr(r.id)}')" ${cancelled ? 'disabled' : ''}><i class="fas fa-ban"></i></button>
        <button class="btn btn-sm btn-danger" onclick="deleteChallan('${escHtmlAttr(r.id)}')"><i class="fas fa-trash"></i></button>
      </td></tr>`;
  }).join('');
}

async function editChallan(id) {
  const r = dcRows.find(x => x.id === id);
  if (!r) return;
  dcEditId = id;
  const set = (el, v) => { const e = dcEl(el); if (e) e.value = v == null ? '' : v; };
  set('dcNumber', r.document_number); set('dcDate', r.document_date);
  set('dcJobWorker', r.job_worker_id); set('dcCustomer', r.customer_id);
  set('dcPartyName', r.party_name); set('dcPartyGstin', r.party_gstin);
  set('dcFromAddress', r.from_address); set('dcFromState', r.from_state);
  set('dcToAddress', r.to_address); set('dcToState', r.to_state);
  set('dcPlaceOfSupply', r.place_of_supply); set('dcPurpose', r.purpose); set('dcReason', r.reason);
  set('dcTransporter', r.transporter_name); set('dcTransporterId', r.transporter_id);
  set('dcVehicle', r.vehicle_number); set('dcTransportMode', r.transport_mode);
  set('dcDistance', r.transport_distance); set('dcLrNumber', r.lr_number);
  set('dcEwayBill', r.eway_bill_number); set('dcNotes', r.notes);
  const f = dcForm();
  if (f.extra === 'expected_return_date') set('dcExtraDate', r.expected_return_date);
  if (f.extra === 'approval_due_date') set('dcExtraDate', r.approval_due_date);
  if (f.extra === 'quantity_known_at_dispatch') {
    const b = dcEl('dcExtraBool'); if (b) b.checked = !!r.quantity_known_at_dispatch;
  }
  // A failed read would open the challan for editing with no lines on it,
  // and saving would write that back over the real ones.
  const itemRead = await readAll([
    _supabase.from('delivery_challan_items').select('*').eq('challan_id', id)
  ], 'Could not open the challan');
  if (!itemRead) return;
  dcItems = itemRead[0].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  renderDcItems();
  const t = dcEl('dcFormTitle'); if (t) t.textContent = 'Edit ' + gstDocumentTypeLabel(dcType());
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Cancelling keeps the number. Table 13 counts cancelled documents, and a
// number that quietly disappears is a number that gets reissued.
async function cancelChallan(id) {
  if (!gstDocumentSupportsCancellation(dcType())) {
    alert(`A ${gstDocumentTypeLabel(dcType()).toLowerCase()} cannot be cancelled.`);
    return;
  }
  const reason = prompt('Why is this challan being cancelled?');
  if (reason === null) return;
  try {
    await apiFetch(`/documents/${dcType()}/${id}/cancel`, {
      method: 'POST', body: JSON.stringify({ reason })
    });
    await loadChallans();
  } catch (e) { alert(e.message || String(e)); }
}

async function deleteChallan(id) {
  const r = dcRows.find(x => x.id === id);
  if (!confirm(`Delete challan ${r ? r.document_number : ''}?\n\nCancelling is usually right — a cancelled challan is still counted in Table 13, a deleted one is not.`)) return;
  try {
    await apiFetch(`/documents/${dcType()}/${id}`, { method: 'DELETE' });
    await loadChallans();
  } catch (e) { alert(e.message || String(e)); }
}

// ── Job worker master ───────────────────────────────────────
// Kept apart from customers on purpose: nothing is sold to a job worker,
// and putting them in the customer master would surface them in invoice
// pickers, the customer ledger and B2B party lists. Where the same legal
// person is both, `customer_id` records that rather than copying the row.
function renderJobWorkers() {
  const body = dcEl('jwListBody');
  if (!body) return;
  if (!dcJobWorkers.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-muted p-16">No job workers yet.</td></tr>`;
    return;
  }
  body.innerHTML = dcJobWorkers.map(j => `<tr>
    <td class="fw-600">${escItemHtml(j.name)}</td>
    <td>${escItemHtml(j.gstin || '—')}</td>
    <td>${escItemHtml(j.state || '—')}</td>
    <td>${escItemHtml(j.nature_of_work || '—')}</td>
    <td class="text-center">
      <button class="btn btn-sm btn-danger" onclick="deleteJobWorker('${escHtmlAttr(j.id)}')"><i class="fas fa-trash"></i></button>
    </td></tr>`).join('');
}

async function saveJobWorker() {
  const name = dcVal('jwName');
  const err = dcEl('jwError');
  const fail = m => { if (err) { err.textContent = m; err.classList.add('show'); } };
  if (err) { err.textContent = ''; err.classList.remove('show'); }
  if (!name) return fail('A job worker needs a name.');

  const gstin = dcVal('jwGstin').toUpperCase();
  // A job worker may be unregistered — Rule 45 still allows the challan.
  // But a GSTIN that IS given has to be a real one.
  if (gstin && typeof validateGstin === 'function' && !validateGstin(gstin).valid) {
    return fail('That GSTIN is not valid. Leave it blank if the job worker is unregistered.');
  }

  const state = dcVal('jwState');
  try {
    const { data, error } = await _supabase.from('job_workers').insert({
      user_id: dcUserId, name, gstin: gstin || null, is_registered: !!gstin,
      address: dcVal('jwAddress') || null, state: state || null,
      state_code: state && typeof gstStateCode === 'function' ? gstStateCode(state) : null,
      phone: dcVal('jwPhone') || null, nature_of_work: dcVal('jwNature') || null,
      customer_id: dcVal('jwCustomer') || null, status: 'active'
    });
    if (error) throw new Error(error.message);
    ['jwName', 'jwGstin', 'jwAddress', 'jwPhone', 'jwNature'].forEach(id => { const e = dcEl(id); if (e) e.value = ''; });
    const refreshed = await _supabase.from('job_workers').select('*').eq('user_id', dcUserId);
    dcJobWorkers = refreshed.data || [];
    renderJobWorkers();
    onChallanTypeChange();
  } catch (e) { fail(e.message || String(e)); }
}

async function deleteJobWorker(id) {
  // A job worker named on a challan cannot be removed: the challan would
  // stop saying where the goods went.
  // Same shape of hazard as deleteProduct() in js/products.js: an empty
  // list is the answer that PERMITS the delete, so a failed read must not
  // produce one.
  const usedRead = await readAll([
    _supabase.from('delivery_challans').select('id').eq('job_worker_id', id)
  ], 'Could not check whether this job worker is named on a challan');
  if (!usedRead) return;
  const used = usedRead[0];
  if (used.length) {
    alert(`${used.length} challan${used.length === 1 ? '' : 's'} name this job worker. Remove or reassign them first.`);
    return;
  }
  if (!confirm('Delete this job worker?')) return;
  await _supabase.from('job_workers').delete().eq('id', id);
  const refreshed = await _supabase.from('job_workers').select('*').eq('user_id', dcUserId);
  dcJobWorkers = refreshed.data || [];
  renderJobWorkers();
  onChallanTypeChange();
}

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

