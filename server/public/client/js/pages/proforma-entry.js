// =============================================
// Proforma Invoice Entry
// =============================================
// A proforma is an offer, not a supply. Nothing here reaches GSTR-1, the
// Dashboard, the ledgers or the Invoice List - it writes to its own tables
// and draws its number from its own book, so there is nothing to exclude it
// from those places later.
//
// The party block, the Ship To rule and the whole product grid are the same
// components Invoice Entry uses. That is the point: a quotation has to price
// a line exactly the way the invoice will, or the customer is quoted one
// figure and billed another.
let proformaEditId = null;
let proformaCustomersList = [];
let proformaAutoFilled = {};

async function initProformaEntry() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  populateProformaStateOptions();
  populateGstCategorySelect('pfGstCategory', GST_CUSTOMER_CATEGORY_DEFAULT);
  // A fresh proforma is not an export: the toggle starts off, the fields
  // start hidden and carry the same defaults Invoice Entry uses.
  restoreProformaExportFields(null);
  onProformaGstCategoryChange();
  populateProformaStatusOptions();
  onProformaShipSameChange();          // start disabled + mirroring, the default

  await initInvoiceItems(user.id, 'proforma');
  await loadProformaCustomers(user.id);

  const today = toISO(new Date());
  setProformaValue('pfDate', today);
  setProformaValue('pfValidUntil', proformaDefaultValidUntil(today));
  renderProformaValidityNote();

  const id = new URLSearchParams(window.location.search).get('id');
  if (id) await loadProformaForEdit(id);
}

// ── Small helpers ──────────────────────────────────
function getProformaText(id) {
  return document.getElementById(id)?.value?.trim() || '';
}
function setProformaValue(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v == null ? '' : v;
}
function goToProformaList() {
  window.location.href = 'proforma-list.html';
}

function populateProformaStateOptions() {
  const options = '<option value="">Select State</option>' +
    INDIAN_STATES.map(s => `<option value="${escHtmlAttr(s)}">${escItemHtml(s)}</option>`).join('');
  ['pfState', 'pfShipState'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = options;
  });
}

// Expired is never offered as a choice - it is what the calendar says, not
// something a person sets. See proformaEffectiveStatus() in utils.js.
function populateProformaStatusOptions() {
  const el = document.getElementById('pfStatus');
  if (!el) return;
  el.innerHTML = PROFORMA_STATUSES.map(s =>
    `<option value="${escHtmlAttr(s)}">${escItemHtml(PROFORMA_STATUS_LABELS[s])}</option>`).join('');
  el.value = PROFORMA_STATUS_DEFAULT;
}

// ── Validity ───────────────────────────────────────
// Changing the proforma date moves Valid Until with it only while the user
// has not set one himself, so the 30-day default follows the date around
// during entry but never overwrites a deliberate 7- or 90-day window.
function onProformaDateChange() {
  const date = getProformaText('pfDate');
  const el = document.getElementById('pfValidUntil');
  if (!el || !date) return;
  const untouched = !el.value || el.value === proformaAutoFilled.pfValidUntil;
  if (untouched) {
    el.value = proformaDefaultValidUntil(date);
    proformaAutoFilled.pfValidUntil = el.value;
  }
  renderProformaValidityNote();
}

function renderProformaValidityNote() {
  const note = document.getElementById('pfValidityNote');
  if (!note) return;
  const until = getProformaText('pfValidUntil');
  note.textContent = until
    ? `Offer open until ${formatDate(until)} (${PROFORMA_VALIDITY_DAYS} days by default).`
    : 'No expiry set.';
}

// ── Shipped To ─────────────────────────────────────
// Same rule as the invoice: ticked stores NULL rather than a copy, so there
// is one address on the row and correcting the billing address later cannot
// leave a stale Ship To beside it.
function proformaShipSameChecked() {
  const el = document.getElementById('pfShipSame');
  return el ? el.checked : true;
}

function mirrorProformaShipFromBilling() {
  if (!proformaShipSameChecked()) return;
  setProformaValue('pfShipAddress', getProformaText('pfAddress'));
  setProformaValue('pfShipState', document.getElementById('pfState')?.value || '');
  setProformaValue('pfShipDistrict', document.getElementById('pfDistrict')?.value || '');
  populateDistrictList('pfShipDistrictList', document.getElementById('pfShipState')?.value || '');
}

function onProformaShipSameChange() {
  const same = proformaShipSameChecked();
  ['pfShipAddress', 'pfShipState', 'pfShipDistrict'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = same;
  });
  const note = document.getElementById('pfShipNote');
  if (note) {
    note.textContent = same
      ? 'Goods are delivered to the billing address.'
      : 'Changing this does NOT change the Billing Address.';
  }
  if (same) {
    mirrorProformaShipFromBilling();
    const err = document.getElementById('pfShipDistrictError');
    if (err) { err.textContent = ''; err.classList.add('d-none'); }
  }
}

function buildProformaShipTo() {
  if (proformaShipSameChecked()) {
    return { shipping_address: null, shipping_state: null, shipping_district: null };
  }
  return {
    shipping_address: getProformaText('pfShipAddress') || null,
    shipping_state: document.getElementById('pfShipState')?.value || null,
    shipping_district: getProformaText('pfShipDistrict') || null
  };
}

function onProformaStateChange() {
  syncDistrictField('pfState', 'pfDistrict', 'pfDistrictList', 'pfDistrictError');
  detectProformaSupplyType();
  mirrorProformaShipFromBilling();
}
function onProformaDistrictChange() {
  syncDistrictField('pfState', 'pfDistrict', 'pfDistrictList', 'pfDistrictError');
  mirrorProformaShipFromBilling();
}
function onProformaShipStateChange() {
  syncDistrictField('pfShipState', 'pfShipDistrict', 'pfShipDistrictList', 'pfShipDistrictError');
}
function onProformaShipDistrictChange() {
  syncDistrictField('pfShipState', 'pfShipDistrict', 'pfShipDistrictList', 'pfShipDistrictError');
}

// The item grid reads #invSupply for the intrastate/interstate split, so the
// quotation prices a line exactly as the invoice will.
function detectProformaSupplyType() {
  const businessState = (typeof getCachedProfile === 'function' ? getCachedProfile()?.state : '') || '';
  const partyState = document.getElementById('pfState')?.value || '';
  const hidden = document.getElementById('invSupply');
  if (!hidden) return;
  const next = (businessState && partyState)
    ? (businessState === partyState ? 'intrastate' : 'interstate')
    : 'intrastate';
  if (hidden.value !== next) {
    hidden.value = next;
    if (typeof computeInvoiceRollups === 'function') computeInvoiceRollups();
  }
}

// ── Customer ───────────────────────────────────────
async function loadProformaCustomers(userId) {
  const read = await readAll([_supabase.from('customers').select('*').eq('user_id', userId)],
    'Could not load customers');
  proformaCustomersList = read ? read[0] : [];
  const dl = document.getElementById('pfCustomerList');
  if (dl) {
    dl.innerHTML = proformaCustomersList
      .map(c => `<option value="${escHtmlAttr(c.name)}"></option>`).join('');
  }
}

// Only fills what is empty, the same rule Invoice Entry follows: a value the
// user typed is his, not something to be overwritten by a name match.
function onProformaCustomerInput() {
  const name = getProformaText('pfCustName');
  const cust = proformaCustomersList.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
  if (!cust) return;
  const fill = (id, v) => {
    const el = document.getElementById(id);
    if (el && !el.value && v) el.value = v;
  };
  fill('pfGstin', (cust.gstin || '').toUpperCase());
  fill('pfPhone', cust.phone);
  fill('pfAddress', cust.address);
  fill('pfState', cust.state);
  fill('pfDistrict', cust.district);
  populateGstCategorySelect('pfGstCategory', cust.gst_category);
  syncDistrictField('pfState', 'pfDistrict', 'pfDistrictList', 'pfDistrictError');
  detectProformaSupplyType();
  mirrorProformaShipFromBilling();
}

// ── Save ───────────────────────────────────────────
function collectProformaItems() {
  return (currentItems || [])
    .filter(r => (r.product_name || '').trim() && (+r.quantity > 0))
    .map((r, i) => ({
      product_id: r.product_id || null, product_name: r.product_name, hsn_code: r.hsn_code || '',
      unit: r.unit || '', quantity: +r.quantity || 0, rate: +r.rate || 0,
      discount_percentage: +r.discount_percentage || 0, gst_percentage: +r.gst_percentage || 0,
      taxable_value: +r.taxable_value || 0, gst_amount: +r.gst_amount || 0,
      igst: +r.igst || 0, cgst: +r.cgst || 0, sgst: +r.sgst || 0,
      total_amount: +r.total_amount || 0, gst_treatment: r.gst_treatment || 'taxable',
      cess_rate: +r.cess_rate || 0, cess_amount: +r.cess_amount || 0, sort_order: i
    }));
}

async function saveProforma() {
  const user = await getCurrentUser();
  if (!user) return;

  const custName = getProformaText('pfCustName');
  if (!custName) { showToast('Customer name is required.', 'error'); return; }
  const date = getProformaText('pfDate');
  if (!date) { showToast('Proforma date is required.', 'error'); return; }

  const items = collectProformaItems();
  if (!items.length) { showToast('Add at least one product with a quantity and rate.', 'error'); return; }

  const validUntil = getProformaText('pfValidUntil') || null;
  if (validUntil && validUntil < date) {
    showToast('Valid Until cannot be before the proforma date.', 'error');
    return;
  }

  // Totals come from the grid, which is the same code the invoice totals use.
  const taxable = items.reduce((a, r) => a + r.taxable_value, 0);
  const gst = items.reduce((a, r) => a + r.gst_amount, 0);
  const document_ = {
    document_number: getProformaText('pfNumber') || '',
    document_date: date,
    valid_until: validUntil,
    status: document.getElementById('pfStatus')?.value || PROFORMA_STATUS_DEFAULT,
    customer_name: custName,
    gst_number: getProformaText('pfGstin').toUpperCase() || null,
    phone: getProformaText('pfPhone') || null,
    address: getProformaText('pfAddress') || null,
    state: document.getElementById('pfState')?.value || null,
    district: getProformaText('pfDistrict') || null,
    ...buildProformaShipTo(),
    supply_type: document.getElementById('invSupply')?.value || 'intrastate',
    gst_category: document.getElementById('pfGstCategory')?.value || GST_CUSTOMER_CATEGORY_DEFAULT,
    taxable_amount: taxable,
    gst_percentage: items.length ? items[0].gst_percentage : 0,
    gst_amount: gst,
    igst: items.reduce((a, r) => a + r.igst, 0),
    cgst: items.reduce((a, r) => a + r.cgst, 0),
    sgst: items.reduce((a, r) => a + r.sgst, 0),
    total_amount: taxable + gst,
    notes: getProformaText('pfNotes') || null,
    terms: getProformaText('pfTerms') || null,
    ...buildProformaExport()
  };

  // document_number is NOT NULL, and the save route does not invent one -
  // numbering is a separate, locked step so two saves cannot take the same
  // number. Left blank on the form means auto, so reserve from the proforma
  // book here, exactly as Delivery Challans and Vouchers do.
  if (!document_.document_number) {
    try {
      const res = await apiFetch('/documents/reserve-number', {
        method: 'POST', body: JSON.stringify({ documentType: 'proforma_invoice' })
      });
      if (res && res.documentNumber) document_.document_number = res.documentNumber;
    } catch (err) {
      handleApiError(err, 'Could not issue a proforma number');
      return;
    }
  }
  if (!document_.document_number) {
    showToast('Could not issue a proforma number.', 'error');
    return;
  }

  const btn = document.getElementById('pfSaveBtn');
  if (btn) btn.disabled = true;
  try {
    // The generic document route: it writes the header and replaces the
    // items in one transaction, against the number reserved above.
    const res = await apiFetch('/documents/proforma_invoice/save', {
      method: 'POST',
      body: JSON.stringify({ editId: proformaEditId || undefined, document: document_, items })
    });
    showToast(proformaEditId ? 'Proforma updated.' : 'Proforma saved.', 'success');
    if (res && res.id) proformaEditId = res.id;
    if (res && res.document_number) setProformaValue('pfNumber', res.document_number);
  } catch (err) {
    handleApiError(err, 'Could not save the proforma');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Edit ───────────────────────────────────────────
async function loadProformaForEdit(id) {
  const read = await readAll([
    _supabase.from('proforma_invoices').select('*').eq('id', id),
    _supabase.from('proforma_invoice_items').select('*').eq('proforma_invoice_id', id)
  ], 'Could not load the proforma');
  if (!read) return;
  const rec = read[0][0];
  if (!rec) { showToast('Proforma not found.', 'error'); return; }
  proformaEditId = rec.id;

  setProformaValue('pfNumber', rec.document_number);
  setProformaValue('pfDate', rec.document_date);
  setProformaValue('pfValidUntil', rec.valid_until);
  setProformaValue('pfCustName', rec.customer_name);
  setProformaValue('pfGstin', rec.gst_number);
  setProformaValue('pfPhone', rec.phone);
  setProformaValue('pfAddress', rec.address);
  setProformaValue('pfState', rec.state);
  setProformaValue('pfDistrict', rec.district);
  setProformaValue('pfNotes', rec.notes);
  setProformaValue('pfTerms', rec.terms);
  populateGstCategorySelect('pfGstCategory', rec.gst_category);
  // Before the category sync below, so a restored export does not have its
  // State cleared by a sync that ran against the previous category.
  restoreProformaExportFields(rec);
  onProformaGstCategoryChange();
  const st = document.getElementById('pfStatus');
  if (st) st.value = proformaStatus(rec);

  // A stored Ship To means the box was unticked when it was saved; NULL
  // means the goods went to the billing address.
  setProformaValue('pfShipAddress', rec.shipping_address);
  setProformaValue('pfShipState', rec.shipping_state);
  setProformaValue('pfShipDistrict', rec.shipping_district);
  const same = document.getElementById('pfShipSame');
  if (same) same.checked = !rec.shipping_address;
  populateDistrictList('pfShipDistrictList', rec.shipping_state || '');
  onProformaShipSameChange();

  const hidden = document.getElementById('invSupply');
  if (hidden) hidden.value = rec.supply_type || 'intrastate';

  const rows = (read[1] || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (rows.length) loadItemsIntoTable(rows);
  populateDistrictList('pfDistrictList', rec.state || '');
  renderProformaValidityNote();

  const title = document.getElementById('pfNumber');
  if (title) title.readOnly = true;   // the number is issued once
}


// ── Export (mirrors invoice-entry.js) ───────────────────────
// Two independent things, exactly as on New Invoice:
//
//   1. the GST Category. Choosing "Export (overseas)" is what switches State
//      and District to "Not Applicable" - not the toggle below. This is the
//      behaviour syncExportStateDistrict() already implements for Invoice
//      Entry and Customer Master, reused here rather than rewritten.
//
//   2. the Export Invoice toggle, which reveals the shipping-bill fields.
//
// They are deliberately not wired to each other, because the invoice does not
// wire them either: an SEZ supply is domestic-but-zero-rated and needs the
// fields without the export category, and an overseas service export needs
// the category without a shipping bill.
function onProformaGstCategoryChange() {
  const value = document.getElementById('pfGstCategory')?.value || GST_CUSTOMER_CATEGORY_DEFAULT;
  // clearState is true, the same as Invoice Entry: State is optional on this
  // form, so an Indian state left over from a domestic category is cleared
  // outright rather than silently submitted with an export.
  syncExportStateDistrict(gstIsExportCategory(value),
    'pfState', 'pfDistrict', 'pfDistrictList', 'pfDistrictError', true);
}

function onProformaExportToggleChange() {
  const on = !!document.getElementById('pfExportToggle')?.checked;
  document.getElementById('pfExportFields')?.classList.toggle('d-none', !on);
  const lbl = document.getElementById('pfExportToggleLabel');
  if (lbl) {
    lbl.textContent = on ? 'Yes' : 'No';
    lbl.classList.toggle('text-gray-mid', !on);
  }
}

// Called when an existing proforma is opened, so an export stays an export.
// Passing null resets the form to its not-an-export defaults.
function restoreProformaExportFields(rec) {
  const t = document.getElementById('pfExportToggle');
  if (!t) return;
  // A stored export_type IS the record of "the toggle was on", the same test
  // invoice-entry.js makes. There is no separate boolean to drift from it.
  t.checked = !!(rec && rec.export_type);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v == null ? '' : v; };
  set('pfExportType', (rec && rec.export_type) || 'WPAY');
  set('pfPortCode', rec && rec.port_code);
  set('pfShippingBillNo', rec && rec.shipping_bill_number);
  set('pfShippingBillDate', rec && rec.shipping_bill_date);
  set('pfExportOf', (rec && rec.export_of) || 'goods');
  set('pfSezRecipient', (rec && rec.sez_recipient_type) || '');
  const d65 = document.getElementById('pfDifferential65');
  if (d65) d65.checked = !!(rec && rec.differential_65);
  onProformaExportToggleChange();
}

// The columns written on save. Every rule here is invoice-entry.js's rule:
// the shipping-bill group is nulled when the toggle is off, while
// sez_recipient_type and differential_65 are NOT gated on it - an SEZ supply
// and a 65% leased vehicle are both domestic, and the invoice records them
// whether or not the export toggle is on.
function buildProformaExport() {
  const isExport = !!document.getElementById('pfExportToggle')?.checked;
  return {
    export_type: isExport ? (document.getElementById('pfExportType')?.value || 'WPAY') : null,
    port_code: isExport ? (getProformaText('pfPortCode').toUpperCase() || null) : null,
    shipping_bill_number: isExport ? (getProformaText('pfShippingBillNo') || null) : null,
    shipping_bill_date: isExport ? (getProformaText('pfShippingBillDate') || null) : null,
    export_of: isExport ? (document.getElementById('pfExportOf')?.value || 'goods') : null,
    sez_recipient_type: document.getElementById('pfSezRecipient')?.value || null,
    differential_65: !!document.getElementById('pfDifferential65')?.checked,
    // The LUT in force when this proforma was raised, copied onto it. The
    // profile's LUT can be replaced next year; a quotation already sent must
    // not change because of that. Same source as the invoice - the cached
    // profile, never anything the browser typed.
    lut_number: (typeof getCachedProfile === 'function' ? (getCachedProfile()?.lut_number || null) : null)
  };
}
