// =============================================
// Vouchers and Self Invoices (Phase 2, Module 4B-impl)
// =============================================
// One page for four documents that are not sales invoices: Receipt
// Voucher, Payment Voucher, Refund Voucher and Self Invoice.
//
// The page is driven by the document registry in js/utils.js rather than
// by four hand-written forms. Which fields show, which master the party
// comes from, whether tax is computed at all, whether a number can be
// auto-issued, whether the document can be cancelled — each is read from
// the registry entry for the chosen type. A fifth document type added to
// the registry would render here without this file changing, except for
// the field-shape entry below that says what its form looks like.
//
// Nothing here touches an invoice, a product, a customer record or a
// return. Each document is written to its own domain table.

let vDocs = [];             // documents of the currently selected type
let vSuppliers = [];        // unregistered supplier master
let vCustomers = [];
let vReceiptVouchers = [];  // for the refund voucher's original-document picker
let vSelfInvoices = [];     // for the payment voucher's
let vEditId = null;
let vUserId = null;

// The four types this page edits, and the shape of each one's form.
//
// This is presentation, not GST: the registry already says what each
// document MEANS. What it cannot say is which master the party comes
// from or what the amount field is called, because those are questions
// about a screen. Everything else below is read from the registry.
const VOUCHER_FORMS = {
  receipt_voucher: {
    party: 'customer', partyLabel: 'Customer Name', amountLabel: 'Advance Received',
    table: 'receipt_vouchers', taxed: true, needsPos: true, original: null,
    amountField: 'advance_amount',
    blurb: 'An advance received against a supply not yet made. Tax is due on receipt; the turnover arrives later with the invoice.'
  },
  payment_voucher: {
    party: 'supplier', partyLabel: 'Supplier Name', amountLabel: 'Amount Paid',
    table: 'payment_vouchers', taxed: false, needsPos: false, original: 'self_invoice',
    amountField: 'amount_paid',
    blurb: 'Records paying a supplier under reverse charge. It creates no liability — the self invoice already did, and counting both would double it.'
  },
  refund_voucher: {
    party: 'customer', partyLabel: 'Customer Name', amountLabel: 'Amount Refunded',
    table: 'refund_vouchers', taxed: true, needsPos: true, original: 'receipt_voucher',
    amountField: 'refund_amount',
    blurb: 'Issued when an advance is returned without a supply being made. It reverses the liability the receipt voucher created — which is why it is not a credit note.'
  },
  self_invoice: {
    party: 'supplier', partyLabel: 'Supplier Name', amountLabel: 'Taxable Value',
    table: 'self_invoices', taxed: true, needsPos: true, original: null,
    amountField: 'taxable_value',
    blurb: 'Raised on yourself for an inward supply under reverse charge. It is not an outward supply, so it appears in no GSTR-1 supply table — only in Documents Issued.'
  }
};

function vType() {
  const v = document.getElementById('vDocType')?.value || 'receipt_voucher';
  return VOUCHER_FORMS[v] ? v : 'receipt_voucher';
}
function vForm() { return VOUCHER_FORMS[vType()]; }
function vSpec() { return gstDocumentTypeSpec(vType()); }

async function initVouchers() {
  const user = await requireAuth();
  if (!user) return;
  vUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  // Only the types this page edits, taken from the registry so a type
  // that is not enabled cannot be selected.
  const sel = document.getElementById('vDocType');
  if (sel) sel.innerHTML = Object.keys(VOUCHER_FORMS)
    .filter(k => gstDocumentTypeEnabled(k))
    .map(k => `<option value="${escHtmlAttr(k)}">${escItemHtml(gstDocumentTypeLabel(k))}</option>`).join('');

  const pos = document.getElementById('vPos');
  if (pos) pos.innerHTML = '<option value="">Select state</option>' +
    INDIAN_STATES.map(s => `<option value="${escHtmlAttr(s)}">${escItemHtml(s)}</option>`).join('');
  const rate = document.getElementById('vRate');
  if (rate) rate.innerHTML = GST_RATE_SLABS.map(r => `<option value="${r}"${r === 18 ? ' selected' : ''}>${r}%</option>`).join('');

  await loadVoucherMasters();
  await onVoucherTypeChange();
}

async function loadVoucherMasters() {
  const [sup, cust] = await Promise.all([
    _supabase.from('unregistered_suppliers').select('*').eq('user_id', vUserId),
    _supabase.from('customers').select('*').eq('user_id', vUserId)
  ]);
  vSuppliers = sup.data || [];
  vCustomers = cust.data || [];
}

// ── Type switch ─────────────────────────────────────
async function onVoucherTypeChange() {
  const f = vForm(), spec = vSpec();
  resetVoucherForm(true);

  document.getElementById('vDocTitle').textContent = 'New ' + spec.label;
  document.getElementById('vListTitle').textContent = spec.label + 's';
  document.getElementById('vPartyTitle').textContent = f.party === 'supplier' ? 'Supplier' : 'Customer';
  document.getElementById('vPartyLabel').textContent = f.partyLabel;
  document.getElementById('vAmountLabel').textContent = f.amountLabel;

  // What the registry says about this document, on screen. The user
  // asked for behaviour to follow the registry rather than be re-decided,
  // so the registry's own answers are shown rather than paraphrased.
  const sections = gstDocumentSections(vType()).map(s => `${s.ret} ${s.table}`).join(' &middot; ');
  document.getElementById('vRegistryNote').innerHTML = `
    <div class="calc-row"><span class="label">${escItemHtml(f.blurb)}</span></div>
    <div class="calc-row"><span class="label">Filed in</span><span class="value">${sections || '&mdash;'}</span></div>
    <div class="calc-row"><span class="label">Documents Issued row</span><span class="value">${spec.docNum ?? '&mdash;'} &mdash; ${escItemHtml(spec.portalName)}</span></div>
    <div class="calc-row"><span class="label">Creates a tax liability</span><span class="value">${spec.affectsLiability ? 'Yes' : 'No'}</span></div>
    <div class="calc-row"><span class="label">Counts toward turnover</span><span class="value">${spec.affectsTurnover ? 'Yes' : 'No'}</span></div>
    <div class="calc-row"><span class="label">Feeds the HSN summary</span><span class="value">${spec.affectsHsn ? 'Yes' : 'No'}</span></div>`;

  // Numbering, per the registry rather than per this file.
  const modes = gstDocumentNumberingModes(vType());
  document.getElementById('vNumberModes').textContent =
    modes.length === 2 ? '(auto or typed)' : modes[0] === 'auto' ? '(auto)' : '(typed)';
  const autoBtn = document.getElementById('vAutoNumBtn');
  if (autoBtn) autoBtn.classList.toggle('d-none', !gstDocumentSupportsAutoNumbering(vType()));
  const numEl = document.getElementById('vDocNumber');
  if (numEl) numEl.readOnly = !gstDocumentSupportsManualNumbering(vType());

  // A payment voucher carries no tax at all — the registry says it
  // creates no liability, so the tax fields have nothing to show.
  document.getElementById('vRateGroup').classList.toggle('d-none', !f.taxed);
  document.getElementById('vCessGroup').classList.toggle('d-none', !f.taxed);
  document.getElementById('vTaxBox').classList.toggle('d-none', !f.taxed);
  document.getElementById('vPosGroup').classList.toggle('d-none', !f.needsPos);
  document.getElementById('vGstinHint').textContent =
    f.party === 'supplier' ? '(blank if unregistered — which is why this document exists)' : '(optional)';

  await loadVoucherOriginals();
  document.getElementById('vOriginalGroup').classList.toggle('d-none', !f.original);
  if (f.original) {
    document.getElementById('vOriginalLabel').textContent =
      gstDocumentTypeLabel(f.original);
  }

  fillVoucherPartyList();
  await loadVouchers();
}

function fillVoucherPartyList() {
  const list = document.getElementById('vPartyList');
  if (!list) return;
  const rows = vForm().party === 'supplier' ? vSuppliers : vCustomers;
  list.innerHTML = rows.map(r => `<option value="${escHtmlAttr(r.name)}"></option>`).join('');
}

// The party's stored details, filled in without overwriting anything
// already typed — the same only-fill-what-is-empty rule the invoice form
// follows.
function onVoucherPartyInput() {
  const name = (document.getElementById('vPartyName')?.value || '').trim().toLowerCase();
  const rows = vForm().party === 'supplier' ? vSuppliers : vCustomers;
  const match = rows.find(r => (r.name || '').toLowerCase() === name);
  if (match) {
    const g = document.getElementById('vPartyGstin');
    if (g && !g.value && match.gstin) g.value = match.gstin;
    const p = document.getElementById('vPos');
    if (p && !p.value && match.state) p.value = match.state;
    onVoucherPosChange();
  }
  validateVoucherForm();
}

// Place of supply against the business's own state decides whether the
// tax is IGST or CGST+SGST — the same rule invoices follow, read from
// the same helper.
function onVoucherPosChange() { recalcVoucher(); }

async function loadVoucherOriginals() {
  const f = vForm();
  const selEl = document.getElementById('vOriginalRef');
  if (!f.original || !selEl) return;
  if (f.original === 'receipt_voucher') {
    const { data } = await _supabase.from('receipt_vouchers').select('*').eq('user_id', vUserId);
    vReceiptVouchers = (data || []).filter(r => r.status !== 'cancelled');
    selEl.innerHTML = '<option value="">Select the advance being returned</option>' +
      vReceiptVouchers.map(r => `<option value="${escHtmlAttr(r.id)}">${escItemHtml(r.document_number)} — ${escItemHtml(r.party_name)} — ₹${formatNum(r.advance_amount)}</option>`).join('');
  } else if (f.original === 'self_invoice') {
    const { data } = await _supabase.from('self_invoices').select('*').eq('user_id', vUserId);
    vSelfInvoices = (data || []).filter(r => r.status !== 'cancelled');
    selEl.innerHTML = '<option value="">Select the self invoice being settled</option>' +
      vSelfInvoices.map(r => `<option value="${escHtmlAttr(r.id)}">${escItemHtml(r.document_number)} — ${escItemHtml(r.supplier_name)} — ₹${formatNum(r.total_value)}</option>`).join('');
  }
}

function onVoucherOriginalChange() {
  const f = vForm();
  const id = document.getElementById('vOriginalRef')?.value;
  const rows = f.original === 'receipt_voucher' ? vReceiptVouchers : vSelfInvoices;
  const row = rows.find(r => r.id === id);
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = v || ''; };
  set('vOriginalNumber', row?.document_number);
  set('vOriginalDate', row ? String(row.document_date).slice(0, 10) : '');
  if (row) {
    // Carry the party and the rate across: a refund reverses the advance
    // it names, so it reverses it at the rate the advance was taxed at.
    const p = document.getElementById('vPartyName');
    if (p && !p.value) p.value = row.party_name || row.supplier_name || '';
    const pos = document.getElementById('vPos');
    if (pos && !pos.value) pos.value = row.place_of_supply || '';
    const rate = document.getElementById('vRate');
    if (rate && row.gst_percentage != null) rate.value = String(+row.gst_percentage);
  }
  recalcVoucher();
}

// ── Tax ─────────────────────────────────────────────
// One calculation, from the shared calcGST() every other page uses, so a
// voucher's tax cannot drift from an invoice's.
function voucherAmounts() {
  const f = vForm();
  const amount = +(document.getElementById('vAmount')?.value) || 0;
  if (!f.taxed) return { taxable: amount, rate: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: amount };
  const rate = +(document.getElementById('vRate')?.value) || 0;
  const cess = +(document.getElementById('vCess')?.value) || 0;
  const myState = getCachedProfile()?.state || '';
  const pos = document.getElementById('vPos')?.value || '';
  const supply = pos && myState && pos !== myState ? 'interstate' : 'intrastate';
  const calc = calcGST(amount, rate, supply);
  return { taxable: amount, rate, supply, igst: calc.igst, cgst: calc.cgst, sgst: calc.sgst,
           cess, total: round2(amount + calc.gstAmount + cess) };
}

function recalcVoucher() {
  const a = voucherAmounts();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = '₹' + formatNum(v); };
  set('vTaxable', a.taxable); set('vIgst', a.igst); set('vCgst', a.cgst);
  set('vSgst', a.sgst); set('vCessOut', a.cess); set('vTotal', a.total);
  validateVoucherForm();
}

// ── Validation ──────────────────────────────────────
// Returns { field: message }. The rules a document of this type must
// satisfy, taken from what the registry says it requires.
function voucherFormErrors() {
  const f = vForm(), errors = {};
  const val = id => (document.getElementById(id)?.value || '').trim();
  const number = val('vDocNumber'), date = val('vDocDate'), party = val('vPartyName');
  const gstin = val('vPartyGstin').toUpperCase();
  const amount = +(document.getElementById('vAmount')?.value) || 0;

  if (!number) errors.document_number = 'A document number is required.';
  else if (number.length > 16) errors.document_number = 'A document number cannot exceed 16 characters.';
  if (!date) errors.document_date = 'A document date is required.';
  else if (date > toISO(new Date())) errors.document_date = 'A document cannot be dated in the future.';
  if (!party) errors.party_name = f.partyLabel + ' is required.';
  // A GSTIN is optional on all four, but a wrong one is never acceptable.
  if (gstin && !validateGstin(gstin).valid) errors.party_gstin = 'That GSTIN is not valid.';
  if (f.needsPos && !val('vPos')) errors.place_of_supply = 'Place of supply is required.';
  if (amount <= 0) errors.amount = 'The amount must be greater than zero.';

  if (f.original) {
    const ref = val('vOriginalRef');
    if (!ref) {
      errors.original = `A ${gstDocumentTypeLabel(f.original).toLowerCase()} must be named.`;
    } else if (f.original === 'receipt_voucher') {
      // A refund cannot return more than the advance still held.
      const rv = vReceiptVouchers.find(r => r.id === ref);
      if (rv) {
        const available = round2(+rv.advance_amount - (+rv.adjusted_amount || 0));
        if (amount > available) {
          errors.amount = `That advance has ₹${formatNum(available)} left — a refund cannot exceed it.`;
        }
        if (date && String(rv.document_date).slice(0, 10) > date) {
          errors.document_date = 'A refund cannot be dated before the advance it returns.';
        }
      }
    } else if (f.original === 'self_invoice') {
      const si = vSelfInvoices.find(r => r.id === ref);
      if (si && date && String(si.document_date).slice(0, 10) > date) {
        errors.document_date = 'A payment cannot be dated before the self invoice it settles.';
      }
    }
  }
  return errors;
}

function validateVoucherForm() {
  const errors = voucherFormErrors();
  const show = (field, elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (errors[field]) { el.textContent = errors[field]; el.classList.add('show'); }
    else { el.textContent = ''; el.classList.remove('show'); }
  };
  show('document_number', 'vDocNumberError');
  show('document_date', 'vDocDateError');
  show('party_name', 'vPartyNameError');
  show('party_gstin', 'vPartyGstinError');
  show('place_of_supply', 'vPosError');
  show('amount', 'vAmountError');
  show('original', 'vOriginalRefError');
  const btn = document.getElementById('vSaveBtn');
  if (btn) btn.disabled = Object.keys(errors).length > 0;
  return errors;
}

// ── Numbering ───────────────────────────────────────
// From this document type's own book, never from an invoice counter.
async function reserveVoucherNumber() {
  if (!gstDocumentSupportsAutoNumbering(vType())) return;
  try {
    const res = await apiFetch('/documents/reserve-number', {
      method: 'POST', body: JSON.stringify({ documentType: vType() })
    });
    setVoucherValue('vDocNumber', res.documentNumber);
    validateVoucherForm();
  } catch (e) {
    showToast('Could not issue a number: ' + (e.message || 'unknown error'), 'error');
  }
}

function setVoucherValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }

// ── Save ────────────────────────────────────────────
async function saveVoucher() {
  if (Object.keys(validateVoucherForm()).length) { showToast('Fix the highlighted fields first.', 'error'); return; }
  const f = vForm(), a = voucherAmounts();
  const val = id => (document.getElementById(id)?.value || '').trim();

  // Only the columns this document's own table has. A payment voucher
  // has no tax columns at all, so none are sent.
  const doc = {
    document_number: val('vDocNumber'),
    document_date: val('vDocDate'),
    document_series: vSpec().series,
    status: 'issued',
    description: val('vDescription'),
    notes: val('vNotes')
  };
  doc[f.amountField] = a.taxable;

  if (f.party === 'supplier') {
    doc.supplier_name = val('vPartyName');
    doc.supplier_gstin = val('vPartyGstin').toUpperCase();
    const s = vSuppliers.find(x => (x.name || '').toLowerCase() === doc.supplier_name.toLowerCase());
    if (s) doc.supplier_id = s.id;
  } else {
    doc.party_name = val('vPartyName');
    doc.party_gstin = val('vPartyGstin').toUpperCase();
    const c = vCustomers.find(x => (x.name || '').toLowerCase() === doc.party_name.toLowerCase());
    if (c) doc.customer_id = c.id;
  }
  if (f.needsPos) { doc.place_of_supply = val('vPos'); doc.supply_type = a.supply || 'intrastate'; }
  if (vType() === 'self_invoice') doc.supplier_state = val('vPos');
  if (f.taxed) {
    doc.gst_percentage = a.rate; doc.igst = a.igst; doc.cgst = a.cgst;
    doc.sgst = a.sgst; doc.cess = a.cess; doc.total_value = a.total;
  }
  if (f.original) {
    const ref = val('vOriginalRef');
    if (f.original === 'receipt_voucher') doc.receipt_voucher_id = ref;
    else doc.self_invoice_id = ref;
    doc.original_document_number = val('vOriginalNumber');
    doc.original_document_date = val('vOriginalDate') || null;
  }

  try {
    await apiFetch(`/documents/${vType()}/save`, {
      method: 'POST', body: JSON.stringify({ editId: vEditId, document: doc })
    });
    showToast(vEditId ? 'Document updated.' : 'Document saved.');
    resetVoucherForm();
    await loadVouchers();
    await loadVoucherOriginals();
  } catch (e) {
    showToast('Could not save: ' + (e.message || 'unknown error'), 'error');
  }
}

function resetVoucherForm(keepType) {
  vEditId = null;
  ['vDocNumber', 'vPartyName', 'vPartyGstin', 'vDescription', 'vNotes',
   'vOriginalNumber', 'vOriginalDate'].forEach(id => setVoucherValue(id, ''));
  setVoucherValue('vDocDate', toISO(new Date()));
  setVoucherValue('vAmount', 0);
  setVoucherValue('vCess', 0);
  const pos = document.getElementById('vPos'); if (pos) pos.value = getCachedProfile()?.state || '';
  const ref = document.getElementById('vOriginalRef'); if (ref) ref.value = '';
  const badge = document.getElementById('vStatusBadge');
  if (badge) { badge.textContent = 'Issued'; badge.className = 'badge badge-green'; }
  const title = document.getElementById('vDocTitle');
  if (title && !keepType) title.textContent = 'New ' + vSpec().label;
  const btn = document.getElementById('vSaveBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> Save Document';
  recalcVoucher();
}

// ── List, edit, cancel, delete ──────────────────────
async function loadVouchers() {
  const { data } = await _supabase.from(vForm().table).select('*').eq('user_id', vUserId);
  vDocs = (data || []).sort((a, b) => compareInvoiceNumbers(b.document_number, a.document_number));
  renderVoucherList();
}

function voucherRowAmounts(r) {
  const f = vForm();
  const taxable = +(r[f.amountField]) || 0;
  const tax = round2((+r.igst || 0) + (+r.cgst || 0) + (+r.sgst || 0) + (+r.cess || 0));
  return { taxable, tax, total: +(r.total_value) || taxable };
}

function renderVoucherList() {
  const tbody = document.getElementById('vListBody');
  if (!tbody) return;
  const q = (document.getElementById('vSearch')?.value || '').toLowerCase();
  const status = document.getElementById('vStatusFilter')?.value || '';
  const f = vForm();
  let rows = vDocs;
  if (q) rows = rows.filter(r =>
    (r.document_number || '').toLowerCase().includes(q) ||
    ((r.party_name || r.supplier_name || '')).toLowerCase().includes(q));
  if (status) rows = rows.filter(r => (r.status || 'issued') === status);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No ${escItemHtml(vSpec().label.toLowerCase())}s yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const a = voucherRowAmounts(r);
    const cancelled = (r.status || 'issued') === 'cancelled';
    return `<tr>
      <td>${i + 1}</td>
      <td class="fw-600">${escItemHtml(r.document_number)}</td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.party_name || r.supplier_name || '')}</td>
      <td class="text-right">₹${formatNum(a.taxable)}</td>
      <td class="text-right">${f.taxed ? '₹' + formatNum(a.tax) : '&mdash;'}</td>
      <td class="text-right fw-700">₹${formatNum(a.total)}</td>
      <td>${cancelled
        ? '<span class="badge badge-red">Cancelled</span>'
        : '<span class="badge badge-green">Issued</span>'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editVoucher('${r.id}')" title="Edit"${cancelled ? ' disabled' : ''}><i class="fas fa-edit"></i></button>
          <button class="btn btn-secondary btn-sm btn-icon" onclick="cancelVoucher('${r.id}')" title="Cancel — keeps the number and reports it as cancelled"${cancelled ? ' disabled' : ''}><i class="fas fa-ban"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteVoucher('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function editVoucher(id) {
  const r = vDocs.find(x => x.id === id);
  if (!r) return;
  const f = vForm();
  vEditId = id;
  setVoucherValue('vDocNumber', r.document_number);
  setVoucherValue('vDocDate', String(r.document_date).slice(0, 10));
  setVoucherValue('vPartyName', r.party_name || r.supplier_name || '');
  setVoucherValue('vPartyGstin', r.party_gstin || r.supplier_gstin || '');
  setVoucherValue('vPos', r.place_of_supply || r.supplier_state || '');
  setVoucherValue('vAmount', +(r[f.amountField]) || 0);
  setVoucherValue('vRate', String(+r.gst_percentage || 0));
  setVoucherValue('vCess', +r.cess || 0);
  setVoucherValue('vDescription', r.description || '');
  setVoucherValue('vNotes', r.notes || '');
  if (f.original) {
    setVoucherValue('vOriginalRef', r.receipt_voucher_id || r.self_invoice_id || '');
    setVoucherValue('vOriginalNumber', r.original_document_number || '');
    setVoucherValue('vOriginalDate', r.original_document_date ? String(r.original_document_date).slice(0, 10) : '');
  }
  const badge = document.getElementById('vStatusBadge');
  if (badge) {
    const cancelled = (r.status || 'issued') === 'cancelled';
    badge.textContent = cancelled ? 'Cancelled' : 'Issued';
    badge.className = 'badge ' + (cancelled ? 'badge-red' : 'badge-green');
  }
  document.getElementById('vDocTitle').textContent = 'Edit ' + vSpec().label;
  document.getElementById('vSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Document';
  recalcVoucher();
  document.getElementById('vDocNumber')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Cancelling, not deleting. Table 13 reports how many documents a series
// issued AND how many were cancelled, and a deleted document can be
// counted in neither — so the row and its number stay.
async function cancelVoucher(id) {
  if (!gstDocumentSupportsCancellation(vType())) {
    showToast(`A ${vSpec().label.toLowerCase()} cannot be cancelled.`, 'error');
    return;
  }
  const r = vDocs.find(x => x.id === id);
  if (!r) return;
  const ok = await showYesNo(
    `Cancel <b>${escItemHtml(r.document_number)}</b>?<br><br>` +
    'It keeps its number and stays on the books. Documents Issued will report it as cancelled, ' +
    'which is what a cancelled document is for &mdash; deleting it would report nothing at all.' +
    '<br><br>Continue?', 'Cancel Document');
  if (!ok) return;
  try {
    await apiFetch(`/documents/${vType()}/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: '' }) });
    showToast('Document cancelled.');
    await loadVouchers();
    await loadVoucherOriginals();
  } catch (e) {
    showToast('Could not cancel: ' + (e.message || 'unknown error'), 'error');
  }
}

// Deletion is for a mistake caught immediately. The server refuses it
// where another document points at this one.
async function deleteVoucher(id) {
  const r = vDocs.find(x => x.id === id);
  if (!r) return;
  const ok = await showYesNo(
    `Permanently delete <b>${escItemHtml(r.document_number)}</b>?<br><br>` +
    'Nothing will record that this number was ever issued. If the document was issued and is being ' +
    'withdrawn, <b>cancel</b> it instead so Documents Issued can report it.<br><br>Delete anyway?',
    'Delete Document');
  if (!ok) return;
  try {
    await apiFetch(`/documents/${vType()}/${id}`, { method: 'DELETE' });
    showToast('Document deleted.');
    if (vEditId === id) resetVoucherForm();
    await loadVouchers();
    await loadVoucherOriginals();
  } catch (e) {
    showToast('Could not delete: ' + (e.message || 'unknown error'), 'error');
  }
}
