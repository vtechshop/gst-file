// =============================================
// Revised Invoices (Phase 2, Module 4C)
// =============================================
// Rule 53(1). When registration is granted, the certificate is dated from
// the effective date but arrives later. Invoices raised in that gap were
// issued by someone who was not yet registered, so a revised invoice is
// issued against each of them — within one month of the certificate.
//
// A revised invoice is NOT a new sale and NOT an edit of the original. It
// is its own document, in its own series, pointing at the invoice it
// revises. That is why it has its own Table 13 row (3) and why this page
// insists on the original invoice's number and date.
//
// It is also not a credit note: a credit note reduces a supply that stays
// on the books, whereas a revised invoice replaces the tax document for a
// supply that was always taxable.

let riRows = [];
let riInvoices = [];      // original invoices available to revise
let riCustomers = [];
let riItems = [];
let riEditId = null;
let riUserId = null;

const RI_TYPE = 'revised_invoice';

function riEl(id) { return document.getElementById(id); }
function riVal(id) { return (riEl(id)?.value || '').trim(); }
function riNum(id) { const n = parseFloat(riEl(id)?.value); return Number.isFinite(n) ? n : 0; }
function riRound(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

async function initRevisedInvoices() {
  const user = await requireAuth();
  if (!user) return;
  riUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const [b2b, b2c, cust] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', riUserId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', riUserId),
    _supabase.from('customers').select('*').eq('user_id', riUserId)
  ]);
  // Both invoice books can be revised; each keeps a note of which table it
  // came from so the revised invoice can point back precisely.
  riInvoices = [
    ...(b2b.data || []).map(r => ({ ...r, __table: 'b2b_invoices' })),
    ...(b2c.data || []).map(r => ({ ...r, __table: 'b2c_invoices' }))
  ];
  riCustomers = cust.data || [];

  const sel = riEl('riOriginal');
  if (sel) {
    sel.innerHTML = '<option value="">— pick the invoice being revised —</option>' +
      riInvoices
        .sort((a, b) => compareInvoiceNumbers(b.invoice_number, a.invoice_number))
        .map(r => `<option value="${escHtmlAttr(r.__table + ':' + r.id)}">${escItemHtml(r.invoice_number)} · ${escItemHtml(formatDate(r.invoice_date))} · ${escItemHtml(r.customer_name || '')}</option>`)
        .join('');
  }

  const d = riEl('riDate');
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);

  renderRiRegistryPanel();
  await loadRevisedInvoices();
}

function renderRiRegistryPanel() {
  const box = riEl('riRegistryBox');
  if (!box) return;
  const s = gstDocumentTypeSpec(RI_TYPE);
  if (!s) return;
  const row = typeof gstTable13RowFor === 'function' ? gstTable13RowFor(RI_TYPE) : null;
  const yn = v => v ? '<span class="text-danger fw-600">Yes</span>' : '<span class="text-success fw-600">No</span>';
  box.innerHTML = `
    <div class="d-flex gap-16 flex-wrap fs-12">
      <div><span class="text-muted">Rule</span> <b>${escItemHtml(s.rule || '—')}</b></div>
      <div><span class="text-muted">Filed in</span> <b>${escItemHtml(gstDocumentSections(RI_TYPE).map(x => `${x.ret} ${x.table}`).join(' · ') || '—')}</b></div>
      <div><span class="text-muted">Table 13 row</span> <b>${row ? row.docNum : '—'}</b></div>
      <div><span class="text-muted">Taxable supply</span> ${yn(s.taxable)}</div>
      <div><span class="text-muted">Feeds amendments</span> ${yn(s.affectsAmendments)}</div>
      <div><span class="text-muted">May itself be amended</span> ${yn(s.supportsAmendment)}</div>
    </div>`;
}

// Picking the original fills in everything that must match it. The
// customer, the place of supply and the return period all come from the
// invoice being revised — a revised invoice that disagreed with its
// original about who was billed would not be a revision of anything.
async function onRiOriginalChange() {
  const raw = riVal('riOriginal');
  if (!raw) return;
  const [table, id] = raw.split(':');
  const inv = riInvoices.find(r => r.id === id && r.__table === table);
  if (!inv) return;

  const set = (el, v) => { const e = riEl(el); if (e) e.value = v == null ? '' : v; };
  set('riOriginalNumber', inv.invoice_number);
  set('riOriginalDate', inv.invoice_date);
  set('riPartyName', inv.customer_name);
  set('riPartyGstin', inv.gst_number || '');
  set('riPlaceOfSupply', inv.state || '');
  set('riSupplyType', inv.supply_type || 'intrastate');
  set('riTaxable', inv.taxable_amount);
  set('riGstPct', inv.gst_percentage);

  // The period the original was reported in — the amendment sections need
  // it, and it is derived from the original's date, never from today's.
  if (typeof gstr1FilingPeriodOf === 'function') {
    set('riOriginalPeriod', gstr1FilingPeriodOf(inv.invoice_date));
  } else if (inv.invoice_date) {
    const [y, m] = String(inv.invoice_date).split('-');
    set('riOriginalPeriod', `${m}${y}`);
  }

  const { data } = await _supabase.from('invoice_items').select('*').eq('invoice_id', id);
  riItems = (data || []).map((it, i) => ({
    product_name: it.product_name, hsn_code: it.hsn_code, unit: it.unit,
    quantity: it.quantity, rate: it.rate, discount_percentage: it.discount_percentage,
    gst_percentage: it.gst_percentage, taxable_value: it.taxable_value,
    gst_amount: it.gst_amount, igst: it.igst, cgst: it.cgst, sgst: it.sgst,
    cess_rate: it.cess_rate, cess_amount: it.cess_amount, total_amount: it.total_amount,
    gst_treatment: it.gst_treatment, sort_order: i
  }));
  renderRiItems();
  recalcRi();
}

function renderRiItems() {
  const body = riEl('riItemsBody');
  if (!body) return;
  if (!riItems.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-center text-muted p-16">Pick the original invoice to bring its lines across.</td></tr>`;
    return;
  }
  body.innerHTML = riItems.map((it, i) => `
    <tr>
      <td>${escItemHtml(it.product_name || '')}</td>
      <td>${escItemHtml(it.hsn_code || '')}</td>
      <td class="text-right">${it.quantity}</td>
      <td class="text-right">${formatCurrency(it.rate || 0)}</td>
      <td class="text-right">${it.gst_percentage}%</td>
      <td class="text-right fw-600">${formatCurrency(it.total_amount || 0)}</td>
    </tr>`).join('');
}

// The revised invoice carries its own figures, but they start from the
// original's. Nothing here changes the original invoice.
function recalcRi() {
  const taxable = riNum('riTaxable');
  const pct = riNum('riGstPct');
  const gst = riRound(taxable * pct / 100);
  const inter = riVal('riSupplyType') === 'interstate';
  const set = (id, v) => { const e = riEl(id); if (e) e.textContent = formatCurrency(v); };
  set('riIgstOut', inter ? gst : 0);
  set('riCgstOut', inter ? 0 : riRound(gst / 2));
  set('riSgstOut', inter ? 0 : riRound(gst / 2));
  set('riCessOut', riNum('riCess'));
  set('riTotalOut', riRound(taxable + gst + riNum('riCess')));
}

async function riAutoNumber() {
  if (!gstDocumentSupportsAutoNumbering(RI_TYPE)) return;
  try {
    const res = await apiFetch('/documents/reserve-number', {
      method: 'POST', body: JSON.stringify({ documentType: RI_TYPE })
    });
    if (res && res.documentNumber) riEl('riNumber').value = res.documentNumber;
  } catch (e) { riShowError('riNumberError', e.message || String(e)); }
}

function riShowError(id, msg) {
  const el = riEl(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}

function validateRevisedInvoice() {
  const errors = {};
  if (!riVal('riNumber')) errors.riNumberError = 'A revised invoice number is required.';
  if (!riVal('riDate')) errors.riDateError = 'A revised invoice date is required.';
  if (!riVal('riOriginalNumber')) errors.riOriginalError = 'A revised invoice must name the invoice it revises.';
  if (!riVal('riOriginalDate')) errors.riOriginalError = 'The original invoice date is required.';
  if (!riVal('riPartyName')) errors.riPartyError = 'The customer is required.';

  // A revised invoice replaces a document issued BEFORE it. The other way
  // round is not a revision.
  const od = riVal('riOriginalDate'), rd = riVal('riDate');
  if (od && rd && od > rd) {
    errors.riDateError = 'The revised invoice cannot be dated before the invoice it revises.';
  }
  if (riNum('riTaxable') <= 0) errors.riTaxableError = 'A taxable value is required.';
  return errors;
}

async function saveRevisedInvoice() {
  ['riNumberError', 'riDateError', 'riOriginalError', 'riPartyError', 'riTaxableError']
    .forEach(id => riShowError(id, ''));
  const errors = validateRevisedInvoice();
  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([id, m]) => riShowError(id, m));
    return;
  }

  const raw = riVal('riOriginal');
  const [origTable, origId] = raw ? raw.split(':') : [null, null];
  const taxable = riNum('riTaxable');
  const pct = riNum('riGstPct');
  const gst = riRound(taxable * pct / 100);
  const inter = riVal('riSupplyType') === 'interstate';
  const cess = riNum('riCess');

  const doc = {
    document_number: riVal('riNumber'),
    document_date: riVal('riDate'),
    document_series: 'revised_invoice',
    status: 'issued',
    original_invoice_number: riVal('riOriginalNumber'),
    original_invoice_date: riVal('riOriginalDate'),
    original_invoice_id: origId || null,
    original_invoice_table: origTable || null,
    original_period: riVal('riOriginalPeriod') || null,
    customer_id: riVal('riCustomerId') || null,
    party_name: riVal('riPartyName'),
    party_gstin: riVal('riPartyGstin') || null,
    place_of_supply: riVal('riPlaceOfSupply') || '',
    supply_type: riVal('riSupplyType') || 'intrastate',
    inv_typ: 'R',
    taxable_amount: taxable,
    gst_percentage: pct,
    gst_amount: gst,
    igst: inter ? gst : 0,
    cgst: inter ? 0 : riRound(gst / 2),
    sgst: inter ? 0 : riRound(gst / 2),
    cess: cess,
    total_amount: riRound(taxable + gst + cess),
    reason: riVal('riReason') || null,
    notes: riVal('riNotes') || null
  };

  try {
    await apiFetch(`/documents/${RI_TYPE}/save`, {
      method: 'POST',
      body: JSON.stringify({ editId: riEditId, document: doc, items: riItems })
    });
    resetRevisedInvoiceForm();
    await loadRevisedInvoices();
    if (typeof showToast === 'function') showToast('Revised invoice saved.', 'success');
  } catch (e) { riShowError('riNumberError', e.message || String(e)); }
}

function resetRevisedInvoiceForm() {
  riEditId = null;
  ['riNumber', 'riOriginal', 'riOriginalNumber', 'riOriginalDate', 'riOriginalPeriod',
   'riPartyName', 'riPartyGstin', 'riPlaceOfSupply', 'riTaxable', 'riGstPct', 'riCess',
   'riReason', 'riNotes'].forEach(id => { const e = riEl(id); if (e) e.value = ''; });
  const d = riEl('riDate'); if (d) d.value = new Date().toISOString().slice(0, 10);
  riItems = [];
  renderRiItems();
  recalcRi();
}

async function loadRevisedInvoices() {
  if (!riUserId) return;
  const { data } = await _supabase.from('revised_invoices').select('*').eq('user_id', riUserId);
  riRows = (data || []).sort((a, b) => compareInvoiceNumbers(b.document_number, a.document_number));
  renderRevisedInvoices();
}

function renderRevisedInvoices() {
  const body = riEl('riListBody');
  if (!body) return;
  if (!riRows.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-16">No revised invoices yet.</td></tr>`;
    return;
  }
  body.innerHTML = riRows.map(r => {
    const cancelled = String(r.status).toLowerCase() === 'cancelled';
    return `<tr class="${cancelled ? 'text-muted' : ''}">
      <td class="fw-600">${escItemHtml(r.document_number)}</td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.original_invoice_number)}<small class="d-block text-muted">${escItemHtml(formatDate(r.original_invoice_date))}</small></td>
      <td>${escItemHtml(r.party_name || '')}</td>
      <td class="text-right">${formatCurrency(r.total_amount || 0)}</td>
      <td><span class="badge ${cancelled ? 'badge-danger' : 'badge-success'}">${cancelled ? 'Cancelled' : 'Issued'}</span></td>
      <td class="text-center">
        <button class="btn btn-sm btn-warning" onclick="cancelRevisedInvoice('${escHtmlAttr(r.id)}')" ${cancelled ? 'disabled' : ''}><i class="fas fa-ban"></i></button>
      </td></tr>`;
  }).join('');
}

async function cancelRevisedInvoice(id) {
  if (!gstDocumentSupportsCancellation(RI_TYPE)) return;
  const reason = prompt('Why is this revised invoice being cancelled?');
  if (reason === null) return;
  try {
    await apiFetch(`/documents/${RI_TYPE}/${id}/cancel`, {
      method: 'POST', body: JSON.stringify({ reason })
    });
    await loadRevisedInvoices();
  } catch (e) { alert(e.message || String(e)); }
}

