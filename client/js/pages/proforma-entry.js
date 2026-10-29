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

  // A new quotation asks for nothing up front: the box starts at 0 and the
  // summary shows the whole total as the balance.
  restoreProformaAdvance(null);

  const id = new URLSearchParams(window.location.search).get('id');
  if (id) {
    await loadProformaForEdit(id);
  } else {
    // Automatic by default on every new quotation, which also draws the
    // preview. Only on the new-proforma branch: one being edited gets its
    // own number from loadProformaForEdit(), and a preview fetch here would
    // be a wasted request whose answer is immediately discarded.
    setProformaNumberMode(PF_NUMBER_MODE_DEFAULT);
  }
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

// ── Automatic or manual numbering, for this quotation only ──────────
//
// The same arrangement Invoice Entry uses, deliberately: Automatic is the
// default and is what nearly every quotation uses, with the server issuing
// the number inside the transaction that writes the row. Manual exists for
// the case Automatic cannot serve - taking over a book that started
// elsewhere, or correcting where the sequence sits - and it is a decision
// about THIS quotation. It is not stored on the profile: the next new
// proforma opens on Automatic again, so nobody is left in a mode they chose
// once.
//
// What a typed number still does is move the book: save PI-00001 by hand and
// the next automatic number walks past it. That happens on the server, in
// the same transaction (reserveDocumentNumberOn scans the numbers already
// issued), not here.
let proformaNumberMode = 'auto';
// The number a proforma being edited arrived with. Automatic means "keep
// this" on an existing quotation - it must never fetch a fresh number and
// quietly renumber an offer the customer may already be holding.
let proformaEditNumber = null;
const PF_NUMBER_MODE_DEFAULT = 'auto';

const PF_NUMBER_NOTE = 'Issued automatically when you save.';
const PF_NUMBER_NOTE_MANUAL = 'Typed by you. The next proforma continues from it.';
const PF_NUMBER_NOTE_EDIT = 'Keeping the number this proforma was issued.';
const PF_NUMBER_NOTE_EDIT_MANUAL = 'Change it if you need to \u2014 it must stay unique in this book.';

function proformaNumberingIsManual() { return proformaNumberMode === 'manual'; }

function setProformaNumberMode(mode) {
  // Both modes are offered on an existing quotation too. What changes is what
  // Automatic MEANS: on a new proforma it is the next number from the server,
  // and on one that already exists it is "keep the number it has" - never a
  // fresh one.
  const editing = !!proformaEditId;
  proformaNumberMode = mode === 'manual' ? 'manual' : 'auto';
  const manual = proformaNumberingIsManual();

  const auto = document.getElementById('pfNumAuto');
  const man = document.getElementById('pfNumManual');
  if (auto) {
    auto.classList.toggle('active', !manual);
    auto.setAttribute('aria-pressed', String(!manual));
  }
  if (man) {
    man.classList.toggle('active', manual);
    man.setAttribute('aria-pressed', String(manual));
  }

  // Manual is the only mode that lets the box be typed in, new or not.
  const numEl = document.getElementById('pfNumber');
  if (numEl) {
    numEl.readOnly = !manual;
    if (manual) { numEl.removeAttribute('aria-readonly'); numEl.removeAttribute('tabindex'); }
    else { numEl.setAttribute('aria-readonly', 'true'); numEl.setAttribute('tabindex', '-1'); }
  }

  const note = document.getElementById('pfNumNote');
  if (note) {
    if (editing) note.textContent = manual ? PF_NUMBER_NOTE_EDIT_MANUAL : PF_NUMBER_NOTE_EDIT;
    else note.textContent = manual ? PF_NUMBER_NOTE_MANUAL : PF_NUMBER_NOTE;
  }

  if (manual) {
    // Whatever is in the box stays there as the starting point - the number
    // this proforma already has, or the preview a new one was offered - so a
    // correction is an edit rather than a retype. Nothing is overwritten.
    if (numEl) numEl.focus();
    return;
  }
  // Back to automatic. An existing quotation is given its own number back,
  // discarding an edit in progress; a new one asks the server what is next.
  if (editing) { if (numEl) numEl.value = proformaEditNumber || ''; return; }
  generateProformaNo();
}

// Fills the read-only Proforma Number box with what the next quotation in
// the book will be.
//
// Asked of the server, not computed here, and GET
// /documents/proforma_invoice/next-number consumes nothing: an abandoned
// draft, a reload or ten switches of the mode cannot burn a number. The
// number that is actually stored is issued by the save itself, from the same
// arithmetic, inside the transaction that writes the proforma.
async function generateProformaNo() {
  // A proforma that already exists keeps the number it was issued.
  if (proformaEditId) return;
  // Nor does a preview overwrite a number being typed by hand.
  if (proformaNumberingIsManual()) return;
  const note = document.getElementById('pfNumNote');
  try {
    const res = await apiFetch('/documents/proforma_invoice/next-number');
    setProformaValue('pfNumber', (res && res.documentNumber) || '');
    if (note) note.textContent = PF_NUMBER_NOTE;
  } catch (error) {
    // The preview is a courtesy and blocks nothing: the save issues the real
    // number whether or not this succeeded. Saying so is better than leaving
    // a stale or invented number in the box.
    setProformaValue('pfNumber', '');
    if (note) note.textContent = 'Preview unavailable \u2014 the number is issued when you save.';
  }
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

// ── Advance asked for up front, and the balance left ────────────────
//
// A term of the quotation, not a payment. Nothing here records money as
// received: no receipt voucher (GSTR-1 11A), no advance adjustment (11B)
// and no payments-ledger row. It also does not touch the GST or the Grand
// Total - an advance changes who pays when, never what is owed.
//
// The balance is never typed and never stored. It is Grand Total minus the
// advance, computed wherever it is shown, so the two figures on the screen
// cannot disagree with the one in the database.
const PROFORMA_ADVANCE_DEFAULT = 0;

// What is in the box: null for blank (no advance quoted - what every
// proforma raised before this field existed means), NaN for something that
// is not a number, otherwise the rounded amount.
function proformaAdvanceAmount() {
  const raw = (document.getElementById('pfAdvanceAmount')?.value || '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(n) : NaN;
}

// The quoted total, from the same rollup the invoice uses, so the balance is
// taken off exactly the figure the Grand Total box shows.
function proformaQuotedTotal() {
  return typeof computeInvoiceRollups === 'function'
    ? (computeInvoiceRollups().total_amount || 0) : 0;
}

// Why this value cannot be quoted, in words a person can act on - or '' when
// it can. The same two rules the save route enforces (utils/validation.js's
// validateAdvanceAmount), so the form and the server never disagree about
// what is acceptable.
function proformaAdvanceProblem(total) {
  const advance = proformaAdvanceAmount();
  if (advance === null) return '';
  if (Number.isNaN(advance)) return 'Advance amount must be a number, or left blank for none.';
  if (advance < 0) return 'Advance amount cannot be negative.';
  if (advance > round2(total)) {
    return 'Advance amount cannot be more than the Grand Total of \u20B9' + formatNum(total) + '.';
  }
  return '';
}

// Paints the three figures and the inline message. Called by the grid every
// time the totals move (invoice-items.js) and by the field's own oninput, so
// the balance follows a changed line item as readily as a changed advance.
function renderProformaAdvanceSummary(grandTotal) {
  if (!document.getElementById('pfAdvanceSummary')) return; // not this page
  const total = typeof grandTotal === 'number' ? grandTotal : proformaQuotedTotal();
  const advance = proformaAdvanceAmount();
  const quoted = Number.isNaN(advance) ? 0 : (advance || 0);
  const problem = proformaAdvanceProblem(total);

  const money = (id, v) => { const el = document.getElementById(id); if (el) el.value = '\u20B9' + formatNum(v); };
  money('pfSummaryTotal', total);
  money('pfSummaryAdvance', quoted);

  // A balance below zero would be a nonsense to print, and showing 0.00
  // would read as "nothing left to pay" - the opposite of the error raised.
  const balanceEl = document.getElementById('pfSummaryBalance');
  if (balanceEl) {
    balanceEl.value = problem ? '\u2014' : '\u20B9' + formatNum(round2(total - quoted));
  }

  // The message does not block typing: the field keeps what was entered so
  // it can be corrected, and Save refuses it - validateProformaAdvance().
  const errEl = document.getElementById('pfAdvanceError');
  if (errEl) {
    errEl.textContent = problem;
    errEl.classList.toggle('d-none', !problem);
  }
}

function onProformaAdvanceInput() {
  renderProformaAdvanceSummary(proformaQuotedTotal());
}

// The gate on Save. Returns false (having said why) rather than quietly
// storing something the server would refuse anyway.
function validateProformaAdvance(total) {
  const problem = proformaAdvanceProblem(
    typeof total === 'number' ? total : proformaQuotedTotal());
  if (!problem) return true;
  renderProformaAdvanceSummary(total);
  showToast(problem, 'error');
  document.getElementById('pfAdvanceAmount')?.focus();
  return false;
}

// Opening a saved proforma, or starting a new one. A row older than the
// column has no advance_amount at all, which is the same as none quoted, so
// it opens showing the default and prints exactly as it always did.
function restoreProformaAdvance(row) {
  const el = document.getElementById('pfAdvanceAmount');
  if (!el) return;
  const stored = row && row.advance_amount !== null && row.advance_amount !== undefined
    ? Number(row.advance_amount) : null;
  el.value = stored === null || Number.isNaN(stored)
    ? (row ? '' : String(PROFORMA_ADVANCE_DEFAULT))
    : String(round2(stored));
  renderProformaAdvanceSummary(proformaQuotedTotal());
}

async function saveProforma() {
  const user = await getCurrentUser();
  if (!user) return;

  const custName = getProformaText('pfCustName');
  if (!custName) { showToast('Customer name is required.', 'error'); return; }
  const date = getProformaText('pfDate');
  if (!date) { showToast('Proforma date is required.', 'error'); return; }

  // On automatic there is deliberately nothing to check: the box holds a
  // preview on a new quotation and its own number on an existing one, and the
  // server issues or keeps the real number. On manual the number IS the
  // user's, so an empty box is a question to ask now rather than a refusal
  // from the server later.
  if (proformaNumberingIsManual() && !getProformaText('pfNumber')) {
    showToast('Enter a proforma number, or switch back to Auto.', 'error');
    document.getElementById('pfNumber')?.focus();
    return;
  }

  const items = collectProformaItems();
  if (!items.length) { showToast('Add at least one product with a quantity and rate.', 'error'); return; }

  // The delivery charge, refused by the tax invoice's own rule
  // (validateInvoiceTransport in invoice-items.js). A Save this turns away
  // burns no number from the proforma book - nothing is reserved before the
  // save any more, and the save issues the number inside its own transaction.
  if (!validateInvoiceTransport()) return;

  const validUntil = getProformaText('pfValidUntil') || null;
  if (validUntil && validUntil < date) {
    showToast('Valid Until cannot be before the proforma date.', 'error');
    return;
  }

  // Totals come from the grid, which is the same code the invoice totals use.
  //
  // Transport joins them ONCE, here, through the same two calls the invoice
  // rollup makes (computeInvoiceRollups in invoice-items.js): the charge into
  // the taxable base, and its tax - at the principal supply's rate, split by
  // this proforma's supply type - into the tax and into IGST/CGST/SGST, added
  // as its split exactly as the invoice rollup adds it. Blank is null, so a
  // proforma quoted without delivery stores exactly the figures it always did.
  const transportCharge = invoiceTransportCharge();
  const transportTax = invoiceTransportTax(transportCharge);
  const taxable = items.reduce((a, r) => a + r.taxable_value, 0) + (transportCharge || 0);
  const gst = items.reduce((a, r) => a + r.gst_amount, 0)
    + transportTax.igst + transportTax.cgst + transportTax.sgst;
  // The quoted total is the tax invoice's own Grand Total, from the tax
  // invoice's own rollup: taxable value + GST + cess (delivery and its tax
  // included), rounded to the rupee - the figure the Grand Total box shows
  // and the figure an invoice converted from this proforma will total. It
  // used to be taxable + gst summed here, which dropped the round-off AND the
  // cess, so the list and the PDF quoted a different amount from the screen.
  const quotedTotal = computeInvoiceRollups().total_amount;

  // The advance is judged against that total before anything is sent, so a
  // Save this turns away never reaches the server at all - and could not burn
  // a number even if it did, since the number is issued inside the save's own
  // transaction and rolls back with it.
  if (!validateProformaAdvance(quotedTotal)) return;
  const advanceAmount = proformaAdvanceAmount();

  const document_ = {
    // Sent only on manual, exactly as Invoice Entry sends invoice_number.
    //
    // On automatic the key is absent, and that single fact carries both
    // meanings correctly: on a NEW quotation the save sees no number and
    // issues one inside its own transaction, and on an existing one the
    // column is simply not part of the UPDATE, so the number it was issued
    // cannot be touched. Sending the box instead would send a preview that
    // may already be stale, turning a courtesy into a claim on a number.
    ...(proformaNumberingIsManual() ? { document_number: getProformaText('pfNumber') } : {}),
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
    igst: items.reduce((a, r) => a + r.igst, 0) + transportTax.igst,
    cgst: items.reduce((a, r) => a + r.cgst, 0) + transportTax.cgst,
    sgst: items.reduce((a, r) => a + r.sgst, 0) + transportTax.sgst,
    total_amount: quotedTotal,
    // The charge only. Its tax is derived by the save route from this charge
    // and the line items, and nothing the browser sends for it is stored.
    transport_charge: transportCharge,
    // What is asked for up front. null when nothing is, which is what a
    // blank box means and what every older proforma already means. No tax
    // column above moves because of it, and no payment is recorded.
    advance_amount: advanceAmount,
    notes: getProformaText('pfNotes') || null,
    terms: getProformaText('pfTerms') || null,
    ...buildProformaExport()
  };

  // No reservation here any more. The number used to be drawn by the browser
  // from the documents reservation endpoint, which committed the counter
  // BEFORE the save was attempted - so a save the server then refused left a
  // hole in the book. The save now issues it instead, under the same
  // profile-row lock and in the very transaction that writes the row, so it
  // commits or rolls back with the quotation and two simultaneous saves still
  // cannot collide.
  //
  // Tests assert that the token for that endpoint no longer appears anywhere
  // in this file, which is why it is described rather than named here.
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
    // The route answers { document, items }. This read the fields off the
    // envelope instead of off the document, so both were undefined: after
    // saving a NEW proforma the page never learned its id, and pressing
    // Save again wrote a second row instead of updating the first.
    const saved = res && res.document;
    if (saved && saved.id) proformaEditId = saved.id;
    if (saved && saved.document_number) {
      // Whatever the server actually issued - which on automatic is the real
      // number, not the preview the box was showing.
      setProformaValue('pfNumber', saved.document_number);
      proformaEditNumber = saved.document_number;
      // The page is now editing an existing quotation, so the switch repaints
      // with the edit wording and Automatic from here on means "keep this".
      // Without this, switching Manual then back to Auto after a first save
      // would restore a proformaEditNumber that was still null and blank the
      // box.
      setProformaNumberMode(proformaNumberMode);
    }
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
  // The number it arrived with, recorded BEFORE the mode is applied below:
  // on an existing quotation Automatic means "keep this", and switching back
  // from Manual restores it, so a half-typed correction can be abandoned.
  proformaEditNumber = rec.document_number || '';
  setProformaNumberMode(PF_NUMBER_MODE_DEFAULT);
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
  // The delivery charge this proforma was quoted with. AFTER the lines are
  // in, exactly as Invoice Entry restores it on Edit: it re-runs the rollups,
  // and its tax follows the rate of those lines. A proforma saved without one,
  // which is every proforma saved before this, restores an empty box and the
  // totals it was saved with.
  restoreInvoiceTransport(rec);
  // What this proforma asked for up front. AFTER the lines and the delivery
  // charge, so the balance is taken off the total they add up to. A proforma
  // saved before this column existed has no advance_amount at all, which is
  // the same as none quoted: the box opens empty and the balance is the whole
  // total, exactly as that proforma has always printed.
  restoreProformaAdvance(rec);
  populateDistrictList('pfDistrictList', rec.state || '');
  renderProformaValidityNote();

  // The number stays editable. It used to be locked here on the grounds
  // that it is "issued once", but a proforma is an offer, not a filed tax
  // document: correcting PI-00002 to PI-00025 is an ordinary edit of the
  // same offer. The server keeps it honest — it refuses a blank number and
  // refuses one another proforma in this book already has.
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
// Is this quotation an export? TWO controls can say so, and either is
// enough:
//
//   * the GST Category set to "Export (overseas)", which is the single signal
//     Invoice Entry uses (onInvGstCategoryChange), and
//   * this page's Export Invoice toggle.
//
// Invoice Entry has only the first because a tax invoice's place of supply is
// settled by the category by the time it is raised. A proforma is quoted
// earlier, when the toggle is the plainer statement of intent - so a user who
// switches Export on must see State and District go Not Applicable there too,
// without having to also know to change the category.
function proformaIsExportMode() {
  const category = document.getElementById('pfGstCategory')?.value || GST_CUSTOMER_CATEGORY_DEFAULT;
  const toggled = !!document.getElementById('pfExportToggle')?.checked;
  return toggled || gstIsExportCategory(category);
}

// One place decides what State and District look like, so the toggle and the
// category can never leave them in disagreeing states. The work itself is
// syncExportStateDistrict() - the same helper Invoice Entry and Customer
// Master already share, not a second implementation.
//
// clearState is true, exactly as Invoice Entry passes it: State is optional on
// this form, and an Indian state left over from a domestic category has no
// meaning on an export, so it is emptied rather than silently saved against
// one. The cost is real - flipping the toggle on and off again does not bring
// a typed State back - and it is the established Invoice behaviour rather than
// something new introduced here.
function syncProformaExportStateDistrict() {
  syncExportStateDistrict(proformaIsExportMode(),
    'pfState', 'pfDistrict', 'pfDistrictList', 'pfDistrictError', true);
}

function onProformaGstCategoryChange() {
  syncProformaExportStateDistrict();
}

function onProformaExportToggleChange() {
  const on = !!document.getElementById('pfExportToggle')?.checked;
  document.getElementById('pfExportFields')?.classList.toggle('d-none', !on);
  const lbl = document.getElementById('pfExportToggleLabel');
  if (lbl) {
    lbl.textContent = on ? 'Yes' : 'No';
    lbl.classList.toggle('text-gray-mid', !on);
  }
  // The toggle is half of what decides export mode, so State and District
  // follow it. This is where Proforma deliberately differs from Invoice Entry,
  // whose toggle reveals the fields and nothing else.
  syncProformaExportStateDistrict();
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
