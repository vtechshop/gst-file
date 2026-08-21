// =============================================
// One-Page Invoice Entry (invoice.html)
// Replaces separate B2B (gstr1.html) / B2C (b2c.html) entry forms.
// Classification is purely manual — the B2B/B2C segmented toggle — and
// is independent of whether GST Number/State are filled in: both fields
// are always visible in either mode, just optional in B2C and required
// in B2B. b2b_invoices/b2c_invoices remain two separate tables under the
// hood (every downstream consumer — Reports, Dashboard, HSN, GSTR-3B,
// PDF/WhatsApp/Email — already keys off that 'b2b'/'b2c' type
// discriminator); this form just decides which one to write to instead
// of the user picking a page.
// =============================================

let invoiceEditId = null;
let invoiceEditType = null;
let invoiceCustomersList = [];
const INVOICE_FORM_KEY = 'invoice_invoice';
const INVOICE_DRAFT_FIELDS = ['invGstin','invCustName','invPhone','invAddress','invState','invNum','invDate','invSupply','invSource','invGstCategory'];

async function initInvoiceEntry() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populateInvoiceStateOptions();
  onInvShipSameChange();   // start disabled + mirroring, the default
  populateInvoiceSourceOptions();
  populateInvGstCategoryOptions();
  // The business-wide default recorded in Business Profile.
  const rcInit = document.getElementById('invReverseCharge');
  if (rcInit) rcInit.checked = !!getCachedProfile()?.reverse_charge_default;
  updateAutoToggleUI();
  await loadInvoiceCustomersList(user.id);
  await initInvoiceItems(user.id, 'invoice');
  setInvValue('invDate', toISO(new Date()));

  const params = new URLSearchParams(window.location.search);
  const editType = params.get('type');
  const editId = params.get('id');

  if (editType && editId) {
    await loadInvoiceForEdit(editType, editId);
  } else if (params.get('duplicate') === '1') {
    await loadInvoiceDuplicateDraft();
  } else {
    // A genuinely fresh invoice, not a duplicate: if the user reached
    // Duplicate and then came here instead of saving the copy, that
    // pending "go back to the list afterwards" no longer applies. Where
    // they were in the list is still remembered, so returning to it still
    // lands in the right place.
    if (peekListReturnState(INVOICE_LIST_RETURN_KEY)?.returnAfterCreate) {
      setListReturnState(INVOICE_LIST_RETURN_KEY, { returnAfterCreate: false });
    }
    setInvValue('invCustName', 'Walk-in Customer');
    generateInvoiceNo(user.id);
    setupDraftAutosave(INVOICE_FORM_KEY, INVOICE_DRAFT_FIELDS);
    checkForDraft(INVOICE_FORM_KEY, INVOICE_DRAFT_FIELDS, 'invDraftBanner', 'restoreInvoiceDraftFull', 'discardInvoiceDraftFull');

    // Prefill from Customer Master's "Create Invoice" redirect
    const pf = sessionStorage.getItem('prefill_customer');
    if (pf) {
      try {
        const c = JSON.parse(pf);
        if (c.name) setInvValue('invCustName', c.name);
        if (c.gstin) setInvValue('invGstin', c.gstin);
        if (c.phone) setInvValue('invPhone', c.phone);
        if (c.address) setInvValue('invAddress', c.address);
        if (c.state) setInvValue('invState', c.state);
        setInvoiceTypeToggle(c.gstin ? 'b2b' : 'b2c');
      } catch {}
      sessionStorage.removeItem('prefill_customer');
    }

    // Keyboard-only billing starts here: land ready to type immediately,
    // default name pre-selected so the very first keystroke replaces it.
    document.getElementById('invCustName')?.focus();
  }

  updateClassifyBadge();
  detectSupplyType();
  // Covers every load path in one place — fresh invoice (with or
  // without a Customer Master prefill), Edit load, and Duplicate load
  // all funnel through here regardless of which branch above ran.
  updateGstinValidationStatus();
}

function getInvText(id) { return document.getElementById(id)?.value?.trim() || ''; }
function setInvValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }

// Re-selects the default "Walk-in Customer" text on every (re)focus —
// covers Tab/programmatic focus, where there's no click to fight with.
// Never re-selects once the user has typed a real name of their own.
function onInvCustNameFocus(el) {
  if (el.value === 'Walk-in Customer') el.select();
}

// A plain onfocus select() isn't enough for a mouse click specifically:
// the browser's own native "position the cursor at the click point"
// behavior for that same click runs AFTER the focus event, silently
// collapsing whatever selection was just made — so a click-then-type
// was inserting into "Walk-in Customer" instead of replacing it.
// Pre-empting it on mousedown (before the browser's default action
// fires) and taking over focus+select ourselves fixes this at the root,
// rather than racing it with a delayed re-select.
function onInvCustNameMouseDown(event, el) {
  if (el.value === 'Walk-in Customer') {
    event.preventDefault();
    el.focus();
    el.select();
  }
}

// ── B2B / B2C — a purely manual segmented toggle. GST Number/State no
// longer drive classification at all (a B2C sale can legitimately carry
// an optional GST Number and still save as B2C) — the toggle alone
// decides, and it only changes whether those two fields are required,
// never whether they're visible. Whichever the toggle says at Save time
// is authoritative — see saveInvoice()'s validation.
function getSelectedInvoiceType() {
  return document.querySelector('input[name="invType"]:checked')?.value || 'b2c';
}

function setInvoiceTypeToggle(type) {
  const b2b = document.getElementById('invTypeB2B');
  const b2c = document.getElementById('invTypeB2C');
  if (b2b) b2b.checked = type === 'b2b';
  if (b2c) b2c.checked = type === 'b2c';
  syncInvoiceTypeUI();
}

// Keeps the segmented toggle's active styling, the top-bar badge, the
// mode banner, and the GST Number/State required-vs-optional markers all
// in sync with whichever radio is actually checked — called after every
// manual toggle click and on every load path (init/edit/duplicate/reset).
// B2B = green throughout, B2C = blue — one color language, everywhere.
function syncInvoiceTypeUI() {
  const isB2B = getSelectedInvoiceType() === 'b2b';

  document.getElementById('invTypeB2BOption')?.classList.toggle('active', isB2B);
  document.getElementById('invTypeB2COption')?.classList.toggle('active', !isB2B);

  const badge = document.getElementById('invClassifyBadge');
  if (badge) {
    badge.textContent = isB2B ? 'B2B' : 'B2C';
    badge.className = 'badge ' + (isB2B ? 'badge-green' : 'badge-blue');
  }

  const header = document.getElementById('invModeHeader');
  if (header) {
    header.classList.toggle('inv-mode-b2b', isB2B);
    header.classList.toggle('inv-mode-b2c', !isB2B);
  }
  const headerText = document.getElementById('invModeHeaderText');
  if (headerText) headerText.textContent = isB2B ? 'B2B — Business Invoice (GST Number Required)' : 'B2C — Walk-in / Retail Sale';
  const headerIcon = document.getElementById('invModeHeaderIcon');
  if (headerIcon) headerIcon.className = isB2B ? 'fas fa-building' : 'fas fa-users';

  // GST Number + State are always visible in both modes — only whether
  // they're required changes. Swap the "*" / "(Optional)" marker next to
  // each label rather than showing/hiding the fields themselves.
  const gstReqMark = document.getElementById('invGstinReqMark');
  if (gstReqMark) {
    gstReqMark.textContent = isB2B ? '*' : '(Optional)';
    gstReqMark.className = isB2B ? 'text-required' : 'fs-11 text-muted-sm';
  }
  const stateReqMark = document.getElementById('invStateReqMark');
  if (stateReqMark) {
    stateReqMark.textContent = isB2B ? '*' : '(Optional)';
    stateReqMark.className = isB2B ? 'text-required' : 'fs-11 text-muted-sm';
  }
}

// Kept as an alias — several call sites already say "update the badge"
// after changing GSTIN/state/etc.; it now just means "resync the toggle."
function updateClassifyBadge() { syncInvoiceTypeUI(); }

function onInvoiceTypeToggle() {
  // Fields are always visible in both modes now, so switching modes no
  // longer needs to clear or refill anything — GST Number/State (and
  // whatever else is on the form) simply carry over, and only their
  // required-ness changes.
  syncInvoiceTypeUI();
  detectSupplyType();
}

function onInvoiceGstinInput(el) {
  el.value = el.value.toUpperCase();
  // GST Number no longer drives B2B/B2C classification at all — a B2C
  // sale can carry an optional GST Number and still save as B2C. Only
  // the segmented toggle decides the type.
  detectSupplyType();
  updateGstinValidationStatus();
}

// isValidGstinFormat() lives in js/utils.js now (loaded before this file
// on every page that needs it) — see the comment there.
// GST Verification (validateGstin, openGstPortalVerify, renderGstinStatusInto)
// lives in js/utils.js now, shared with Vendor Master. Thin page-specific
// wrapper only — knows which element/field belongs to Invoice Entry.
function updateGstinValidationStatus() {
  renderGstinStatusInto('invGstinStatus', getInvText('invGstin'));
}

// "Untouched" covers both a genuinely empty field and the default
// "Walk-in Customer" placeholder value — either way, auto-fill is safe
// to overwrite because the user hasn't typed a real name of their own.
function isCustNameUntouched() {
  const v = getInvText('invCustName');
  return !v || v === 'Walk-in Customer';
}

// GST Number is optional in both modes and never switches the type by
// itself — no confirmation dialog needed. What's still genuinely
// useful: recognizing a GSTIN that matches an existing customer and
// pulling in their details automatically.
function onInvoiceGstinBlur(el) {
  const value = el.value.trim();
  if (!value) return;

  // A half-typed or malformed GSTIN shouldn't silently pull in the
  // wrong customer — only act once it's a complete, correctly-formatted
  // 15-character GSTIN.
  if (!isValidGstinFormat(value)) return;

  const match = invoiceCustomersList.find(c => (c.gstin || '').toUpperCase() === value);
  if (!match) return;
  if (isCustNameUntouched()) setInvValue('invCustName', match.name);
  const phEl = document.getElementById('invPhone');   if (phEl && !phEl.value && match.phone)   phEl.value = match.phone;
  const adEl = document.getElementById('invAddress'); if (adEl && !adEl.value && match.address) adEl.value = match.address;
  const stEl = document.getElementById('invState');   if (stEl && !stEl.value && match.state)   stEl.value = match.state;
  applyCustomerGstCategory(match);
  detectSupplyType();
}

// ── Auto Supply Type detection (replaces the old manual dropdown) ──
// GST law determines Intrastate/Interstate by comparing the place of
// supply's state code to the seller's — the first two digits of a
// GSTIN are exactly that state code, so a B2B invoice (both GSTINs
// known) is decided purely by string-comparing those two digits. A B2C
// invoice has no customer GSTIN to compare, so it falls back to the
// state names already collected (Business Profile's state vs. the
// customer State field on this form).
function detectSupplyType() {
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const businessGstin = (profile?.gstin || '').toUpperCase();
  const businessState = profile?.state || '';
  const customerGstin = getInvText('invGstin').toUpperCase();
  const customerState = document.getElementById('invState')?.value || '';

  // State (the actual "place of supply" field) takes priority whenever
  // it's filled in — GSTIN comparison is only a fallback for when no
  // State has been chosen yet. State must win when both are present:
  // GST Number is auto-filled from a selected customer only if it was
  // empty (see onInvoiceCustomerInput/onInvoiceGstinBlur) and is never
  // cleared on customer switch, so it can carry a stale value from a
  // previously-selected customer after the user manually changes the
  // State dropdown — checking GSTIN first was silently trusting that
  // stale value over the state the user just explicitly picked.
  let supply = 'intrastate';
  if (businessState && customerState) {
    supply = businessState === customerState ? 'intrastate' : 'interstate';
  } else if (businessGstin.length >= 2 && customerGstin.length >= 2) {
    supply = businessGstin.slice(0, 2) === customerGstin.slice(0, 2) ? 'intrastate' : 'interstate';
  }

  const hidden = document.getElementById('invSupply');
  if (hidden) {
    const changed = hidden.value !== supply;
    hidden.value = supply;
    if (changed) hidden.dispatchEvent(new Event('change'));
  }
  const badge = document.getElementById('invSupplyBadge');
  if (badge) {
    badge.textContent = supply === 'interstate' ? 'Interstate' : 'Intrastate';
    badge.className = 'badge ' + (supply === 'interstate' ? 'badge-blue' : 'badge-green');
  }
}

// ── State options ──────────────────────────────────
function populateInvoiceStateOptions() {
  const options = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
  // Ship To reads from the same list as Billing - one source for the 36
  // State/UT names, exactly as every other state dropdown in the app.
  ['invState', 'invShipState'].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = options;
  });
}

// ── Invoice Number Auto-generate (shared sequence across B2B + B2C —
// the one-page form has a single Invoice Number field regardless of
// classification) ──────────────────────────────────
// Both the ON/OFF flag and the format+sequence used to generate a
// number live on the business's own profile row (invoice_auto_number /
// invoice_number_format / invoice_current_sequence — see Settings'
// Invoice Numbering section, js/profile.js), not a raw localStorage
// flag, so they're synced through the same profiles table every other
// business setting already uses (backed by the Node.js + Postgres API
// — see js/apiClient.js).
function isAutoInvoiceOn() { return !!getCachedProfile()?.invoice_auto_number; }

function updateAutoToggleUI() {
  const on = isAutoInvoiceOn();
  const cb = document.getElementById('autoInvToggle');
  const lbl = document.getElementById('autoInvLabel');
  const numEl = document.getElementById('invNum');
  if (cb) cb.checked = on;
  if (lbl) { lbl.textContent = on ? 'ON' : 'OFF'; lbl.style.color = on ? 'var(--primary)' : '#9e9e9e'; }
  // Auto Generate = the field is machine-managed, not user-typed —
  // read-only makes that visually unambiguous (Manual mode's field
  // stays freely editable).
  if (numEl) numEl.readOnly = on;
}

async function onAutoToggleChange() {
  const on = !!document.getElementById('autoInvToggle')?.checked;
  const user = await getCurrentUser();
  if (user) await saveUserProfile(user.id, { invoice_auto_number: on }, true);
  updateAutoToggleUI();
  if (on && user) generateInvoiceNo(user.id, true);
}

// ── Customer GST category ───────────────────────────
// Which GSTR-1 table this supply belongs in. Stored on the invoice, not
// looked up from the customer master at export time: a return that has
// been filed must not change because a master record was edited
// afterwards. An invoice raised in July to a customer who becomes an SEZ
// unit in September was not an SEZ supply.
function populateInvGstCategoryOptions() {
  const el = document.getElementById('invGstCategory');
  if (!el) return;
  const current = el.value;
  el.innerHTML = GST_CUSTOMER_CATEGORIES.map(c =>
    `<option value="${escHtmlAttr(c.value)}">${escItemHtml(c.label)}</option>`).join('');
  el.value = GST_CUSTOMER_CATEGORIES.some(c => c.value === current) ? current : GST_CUSTOMER_CATEGORY_DEFAULT;
  onInvGstCategoryChange();
}

function getInvGstCategory() {
  return gstCustomerCategory({ gst_category: document.getElementById('invGstCategory')?.value });
}

function setInvGstCategory(value) {
  const el = document.getElementById('invGstCategory');
  if (!el) return;
  el.value = gstCustomerCategory({ gst_category: value });
  onInvGstCategoryChange();
}

// Says which table the invoice will be filed in, and — for SEZ — that
// the supply is inter-state whatever the two states are, because that
// is the part people get wrong.
function onInvGstCategoryChange() {
  const note = document.getElementById('invGstCategoryNote');
  if (!note) return;
  const value = getInvGstCategory();
  const spec = gstCustomerCategorySpec(value);
  let text = `GSTR-1 table ${spec.table}`;
  if (gstIsSezCategory(value)) {
    text += ' — an SEZ supply is inter-state and carries IGST, whatever state the SEZ is in';
  }
  note.textContent = text;
  note.style.color = gstIsSezCategory(value) ? 'var(--primary)' : '';
  // State here is optional, so an Indian state left over from a domestic
  // category is cleared outright when the category becomes an export.
  syncExportStateDistrict(gstIsExportCategory(value),
    'invState', 'invDistrict', 'invDistrictList', 'invDistrictError', true);
}

// Carries the category across from a customer the user picked. Never
// overwrites a category already chosen on this invoice — the same
// only-fill-what-is-empty rule the other customer fields follow.
function applyCustomerGstCategory(customer) {
  if (!customer) return;
  const el = document.getElementById('invGstCategory');
  if (!el || el.value !== GST_CUSTOMER_CATEGORY_DEFAULT) return;
  setInvGstCategory(customer.gst_category);
}

// ── Invoice series ──────────────────────────────────
// Which numbering book this invoice comes out of. The series names and
// their labels live in js/utils.js, shared with the Invoice List's
// Source column and the Series Migration tool, so all three name the
// same series the same way.
function getInvoiceSource() {
  const v = (document.getElementById('invSource')?.value || '').trim().toLowerCase();
  return v || INVOICE_SOURCE_DEFAULT;
}

// The two series this app ships with, plus every other one the business
// already numbers invoices in. Without this a shop running an "amazon"
// book could see that series on its existing invoices but never pick it
// for a new one. The extra names come from the per-series formats and
// counters on the profile, which is already loaded — no extra request.
function populateInvoiceSourceOptions() {
  const el = document.getElementById('invSource');
  if (!el) return;
  const known = knownInvoiceSeries(getCachedProfile());
  const current = el.value;
  el.innerHTML = known.map(s =>
    `<option value="${escHtmlAttr(s)}">${escItemHtml(invoiceSourceLabel(s))}</option>`).join('');
  el.value = known.includes(current) ? current : INVOICE_SOURCE_DEFAULT;
}

// Selecting a value the dropdown does not list would silently blank the
// select, and the invoice would be saved back into a series it never
// belonged to. So an unlisted series is added rather than dropped — the
// stored value wins over the fixed list of options.
function setInvoiceSourceValue(series) {
  const el = document.getElementById('invSource');
  if (!el) return;
  const want = String(series || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  if (![...el.options].some(o => o.value === want)) {
    el.add(new Option(want, want));
  }
  el.value = want;
}

// Changing the series changes which counter the next number comes from,
// so the preview is redrawn. Editing an existing invoice keeps its
// number — generateInvoiceNo() returns early there.
function onInvoiceSourceChange() {
  getCurrentUser().then(u => generateInvoiceNo(u?.id));
}

// Preview-only: shows what the NEXT number would be, using the
// persisted sequence counter and format, without consuming/advancing
// the counter — that only happens once an invoice is actually saved,
// via reserveNextInvoiceNumber() below. This keeps abandoned drafts
// (page reload, never saved) from burning through numbers.
async function generateInvoiceNo(userId, force) {
  if (invoiceEditId) return;
  if (!force && !isAutoInvoiceOn()) return;
  const uid = userId || (await getCurrentUser())?.id;
  const profile = getCachedProfile() || (uid ? await loadUserProfile(uid) : null);
  // Each series has its own format AND its own counter, so switching the
  // Invoice Source switches both: Offline previews 171, Online previews
  // W-00006. The offline series keeps reading the format and counter
  // that existed before series did, so a business already on Auto
  // Generate sees the same number it would have seen before. A series
  // that has never issued an invoice starts at 1 in its own format.
  //
  // Both come from js/utils.js, whose twin on the server hands out the
  // number that actually gets saved — so this preview is the same
  // arithmetic, not a lookalike.
  const series = getInvoiceSource();
  setInvValue('invNum', applyInvoiceNumberFormat(
    invoiceSeriesFormat(profile, series), invoiceSeriesSequence(profile, series)));
}

// The authoritative generator — called only right before an actual new
// invoice is saved. Runs entirely inside one Postgres transaction
// server-side now (server/routes/invoices.js's POST /reserve-number,
// which locks the profile row before scanning both invoice tables —
// INCLUDING soft-deleted rows, since a deleted invoice's number must
// never be reissued — so two concurrent saves can never both land on
// the same number, unlike the old client-side read-then-write version).
// Returns null (after showing an error toast) if the reservation call
// itself fails, e.g. the backend being unreachable.
// The series is sent, because the number reserved must come from that
// series' counter and must only avoid numbers already taken in that same
// series — the shop's 138 does not block the website from issuing 138.
async function reserveNextInvoiceNumber(userId, source) {
  try {
    const { invoiceNumber } = await apiFetch('/invoices/reserve-number', {
      method: 'POST',
      body: JSON.stringify({ source: source || INVOICE_SOURCE_DEFAULT })
    });
    return invoiceNumber;
  } catch (error) {
    handleApiError(error, 'Could not reserve an invoice number');
    return null;
  }
}

// ── Transport toggle ────────────────────────────────
function onTransportToggleChange() {
  const on = !!document.getElementById('transportToggle')?.checked;
  document.getElementById('transportFields')?.classList.toggle('d-none', !on);
  const lbl = document.getElementById('transportToggleLabel');
  if (lbl) { lbl.textContent = on ? 'Required' : 'Not Required'; lbl.style.color = on ? 'var(--primary)' : '#9e9e9e'; }
}

// ── Payment section (new-invoice only — editing an existing invoice's
// payments happens on Invoice List, see loadInvoiceForEdit() below) ──
function onInvPaymentStatusChange() {
  const status = document.getElementById('invPaymentStatus')?.value;
  const show = status === 'partial';
  document.getElementById('invPaymentAmountGroup')?.classList.toggle('collapsed', !show);
  document.getElementById('invPaymentDetailGroup')?.classList.toggle('collapsed', !show);
  // Keep collapsed fields out of Tab order, see syncInvoiceTypeUI()
  ['invPaymentAmount','invPaymentDate','invPaymentMode','invPaymentReference','invPaymentNote'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = !show;
  });
  if (!show) {
    ['invPaymentAmount','invPaymentReference','invPaymentNote'].forEach(id => setInvValue(id, ''));
    setInvValue('invPaymentDate', '');
    setInvValue('invPaymentMode', 'cash');
  } else {
    if (!getInvText('invPaymentDate')) setInvValue('invPaymentDate', toISO(new Date()));
  }
  renderInvPaymentPreview();
}

// ── Live payment preview (display only) ─────────────
// All the behaviour lives in js/payments.js (computePaymentPreview() and
// friends), shared with Purchase Entry so the two pages can't drift
// apart. This is just the element map plus thin named wrappers, which
// keep the inline oninput= handler and the call sites below readable.
const INVOICE_PAYMENT_PREVIEW = {
  box: 'invPaymentPreview',
  total: 'invPreviewTotal',
  received: 'invPreviewReceived',
  balance: 'invPreviewBalance',
  status: 'invPreviewStatus',
  error: 'invPaymentAmountError',
  statusField: 'invPaymentStatus',
  amountField: 'invPaymentAmount',
  amountLabel: 'Amount Received',
  getTotal: () => +computeInvoiceRollups().total_amount || 0
};

function renderInvPaymentPreview(grandTotal) {
  renderPaymentPreview(INVOICE_PAYMENT_PREVIEW, grandTotal);
}

function validateInvPaymentAmount() {
  return validatePaymentPreviewAmount(INVOICE_PAYMENT_PREVIEW);
}

function setPaymentSectionMode(editable, statusLabel) {
  document.getElementById('invPaymentEditableFields')?.classList.toggle('d-none', !editable);
  document.getElementById('invPaymentDetailGroup')?.classList.toggle('d-none', !editable);
  // The preview is a before-Save aid only: editing an existing invoice
  // manages payments from Invoice List (which has the real ledger), so
  // it hides alongside the editable fields rather than previewing a
  // payment this form won't record.
  document.getElementById('invPaymentPreview')?.classList.toggle('d-none', !editable);
  document.getElementById('invPaymentEditNote')?.classList.toggle('d-none', editable);
  if (editable) renderInvPaymentPreview();
  if (!editable) {
    const label = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid in Full' }[statusLabel] || 'Unpaid';
    const el = document.getElementById('invPaymentEditStatusText');
    if (el) el.textContent = label;
  }
}

// ── Customer Master helpers ─────────────────────────
async function loadInvoiceCustomersList(userId) {
  const { data, error } = await _supabase.from('customers').select('*').eq('user_id', userId);
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load Customer Master'); return; }
  invoiceCustomersList = (data || []);
  const dl = document.getElementById('customerDatalist');
  if (dl) {
    dl.innerHTML = invoiceCustomersList.map(c =>
      `<option value="${escItemHtml(c.name)}" data-gstin="${escItemHtml(c.gstin)}" data-id="${c.id}">${c.gstin ? '(' + c.gstin + ')' : ''}</option>`
    ).join('');
  }
}

function onInvoiceCustomerInput() {
  const name = getInvText('invCustName');
  const cust = invoiceCustomersList.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!cust) return;
  // Fill in whatever's on file — GST Number included — without forcing
  // a mode switch; the toggle is the user's own explicit choice now,
  // independent of whether the matched customer happens to have a GSTIN.
  const gstEl = document.getElementById('invGstin');   if (gstEl && !gstEl.value && cust.gstin)   gstEl.value = cust.gstin.toUpperCase();
  const phEl  = document.getElementById('invPhone');   if (phEl  && !phEl.value  && cust.phone)   phEl.value  = cust.phone;
  const adEl  = document.getElementById('invAddress'); if (adEl  && !adEl.value  && cust.address) adEl.value  = cust.address;
  const stEl  = document.getElementById('invState');   if (stEl  && !stEl.value  && cust.state)   stEl.value  = cust.state;
  // A customer with a Ship To on file is one that habitually ships
  // elsewhere, so the invoice starts unticked and prefilled. The same
  // only-fill-what-is-empty rule as the fields above: a Ship To already
  // typed on this invoice is never overwritten.
  const shipSameEl = document.getElementById('invShipSame');
  const shipAdEl = document.getElementById('invShipAddress');
  if (cust.shipping_address && shipSameEl && shipAdEl && !shipAdEl.value) {
    shipSameEl.checked = false;
    onInvShipSameChange();
    shipAdEl.value = cust.shipping_address;
    const shipStEl = document.getElementById('invShipState');
    if (shipStEl) shipStEl.value = cust.shipping_state || '';
    const shipDiEl = document.getElementById('invShipDistrict');
    if (shipDiEl) shipDiEl.value = cust.shipping_district || '';
    populateDistrictList('invShipDistrictList', cust.shipping_state || '');
  } else {
    mirrorInvShipFromBilling();
  }
  applyCustomerGstCategory(cust);
  detectSupplyType();
  updateGstinValidationStatus();
}

async function saveCustomerFromInvoiceForm() {
  const user = await getCurrentUser();
  if (!user) return;
  const name = getInvText('invCustName');
  if (!name) { showToast('Enter customer name first.', 'error'); return; }
  const exists = invoiceCustomersList.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) { showToast('Customer already saved!', 'warning'); return; }
  const { error } = await _supabase.from('customers').insert({
    user_id: user.id, name, gstin: getInvText('invGstin'), phone: getInvText('invPhone'),
    address: getInvText('invAddress'), state: document.getElementById('invState')?.value || ''
  });
  if (error) { handleApiError(error, 'Could not save the customer to master'); return; }
  showToast('Customer saved to master!', 'success');
  await loadInvoiceCustomersList(user.id);
}

// ── Draft restore/discard (header fields; line items are handled
// separately by js/invoice-items.js's own draft mechanism, keyed to
// the same INVOICE_FORM_KEY) ────────────────────────
function restoreInvoiceDraftFull(formKey) {
  restoreDraft(formKey, INVOICE_DRAFT_FIELDS);
  restoreItemsFromDraft(formKey);
  updateClassifyBadge();
  detectSupplyType();
  const banner = document.getElementById('invDraftBanner'); if (banner) banner.innerHTML = '';
}

function discardInvoiceDraftFull(formKey) {
  discardDraft(formKey, 'invDraftBanner');
  clearItemsDraft(formKey);
}

// ── Edit mode ────────────────────────────────────────
async function loadInvoiceForEdit(type, id) {
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';

  // BOTH reads happen up front, before a single field is filled in, and
  // the form is only populated once both have genuinely succeeded.
  //
  // The line items used to be read at the bottom of this function, after
  // the header had already been written into the form, and a failed read
  // there was indistinguishable from an invoice that has no item rows —
  // so it fell through to synthesizeLegacyItemRow(), which builds ONE
  // summary line out of the header. The user then pressed Update and that
  // single synthetic line replaced every real line on the invoice. A
  // failed read has to stop the edit before it can start.
  const rec = await readMaybeOne(
    _supabase.from(table).select('*').eq('id', id).single(),
    'Could not open the invoice'
  );
  if (rec === undefined) return;                                   // read failed, already reported
  if (!rec) { showToast('That invoice no longer exists.', 'warning'); return; }

  const itemRows = await readAll([
    _supabase.from('invoice_items').select('*').eq('invoice_id', id).eq('invoice_type', type)
  ], 'Could not open the invoice');
  if (!itemRows) return;
  const items = itemRows[0];

  invoiceEditId = id;
  invoiceEditType = type;

  setInvValue('invGstin', rec.gst_number || '');
  setInvValue('invCustName', rec.customer_name || '');
  setInvValue('invPhone', rec.phone || '');
  setInvValue('invAddress', rec.address || '');
  setInvValue('invState', rec.state || '');
  // A stored Ship To means the box was unticked when this invoice was
  // saved; NULL means it went to the billing address. Legacy invoices
  // predate the columns entirely and read as NULL, which is what they
  // always meant, so they reopen ticked and unchanged.
  setInvValue('invShipAddress', rec.shipping_address || '');
  setInvValue('invShipState', rec.shipping_state || '');
  setInvValue('invShipDistrict', rec.shipping_district || '');
  const shipSame = document.getElementById('invShipSame');
  if (shipSame) shipSame.checked = !rec.shipping_address;
  populateDistrictList('invShipDistrictList', rec.shipping_state || '');
  onInvShipSameChange();
  setInvValue('invNum', rec.invoice_number || '');
  setInvValue('invDate', rec.invoice_date || '');
  setInvValue('invSupply', rec.supply_type || 'intrastate');
  // An invoice saved before series existed has no source stored — it
  // came off the shop counter, which is the default.
  setInvoiceSourceValue(rec.invoice_source || INVOICE_SOURCE_DEFAULT);
  setInvGstCategory(rec.gst_category);
  const rcEl = document.getElementById('invReverseCharge');
  if (rcEl) rcEl.checked = !!rec.reverse_charge;
  setInvoiceTypeToggle(type);
  setPaymentSectionMode(false, rec.payment_status);

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = !!rec.transport_required;
  onTransportToggleChange();
  restoreExportFields(rec);
  restoreEcomFields(rec);
  setInvValue('invVehicleNo', (rec.vehicle_number || '').toUpperCase());
  setInvValue('invTransporter', rec.transporter_name || '');
  setInvValue('invTransportMode', rec.transport_mode || '');
  setInvValue('invDistance', rec.transport_distance_km || '');
  setInvValue('invLrNumber', rec.lr_number || '');
  setInvValue('invLrDate', rec.lr_date || '');
  setInvValue('invTransporterGstin', rec.transporter_gstin || '');
  setInvValue('invVehicleType', rec.vehicle_type || '');
  setInvValue('invDispatchFrom', rec.dispatch_from || '');
  setInvValue('invDispatchTo', rec.dispatch_to || '');

  // Read at the top of this function — see the note there. An empty list
  // here now means only what it says: an older invoice saved before line
  // items existed, which synthesizeLegacyItemRow() is for.
  const activeItems = items.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) loadItemsIntoTable(activeItems);
  else synthesizeLegacyItemRow(rec);

  document.getElementById('invPageTitle').textContent = 'Edit Invoice';
  document.getElementById('invSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Invoice';
}

// ── Duplicate mode (js/invoice-list.js's Duplicate action stashes the
// source invoice here before navigating — nothing is written to the DB
// until Save is clicked) ────────────────────────────
async function loadInvoiceDuplicateDraft() {
  const raw = sessionStorage.getItem('invoice_duplicate_draft');
  sessionStorage.removeItem('invoice_duplicate_draft');
  if (!raw) return;
  let draft;
  try { draft = JSON.parse(raw); } catch { return; }

  setInvValue('invGstin', draft.gst_number || '');
  setInvValue('invCustName', draft.customer_name || '');
  setInvValue('invPhone', draft.phone || '');
  setInvValue('invAddress', draft.address || '');
  setInvValue('invState', draft.state || '');
  setInvValue('invNum', ''); // must be unique — left blank for auto-generate or manual entry
  setInvValue('invDate', toISO(new Date()));
  setInvValue('invSupply', draft.supply_type || 'intrastate');
  // A duplicate of a website order is another website order — it keeps
  // the series, and gets the next number out of that series' book.
  setInvoiceSourceValue(draft.invoice_source || INVOICE_SOURCE_DEFAULT);
  setInvGstCategory(draft.gst_category);
  const rcDup = document.getElementById('invReverseCharge');
  if (rcDup) rcDup.checked = !!draft.reverse_charge;
  // The original invoice's own type is authoritative — a B2C source
  // invoice may well have an optional GST Number on it too, so presence
  // of gst_number alone can no longer be used to infer B2B/B2C.
  setInvoiceTypeToggle(draft.type || (draft.gst_number ? 'b2b' : 'b2c'));
  // A duplicate is a brand-new sale, not a copy of the old one's
  // payment state — it starts fresh and editable, at the same default as
  // any other new invoice (Paid in Full). The source invoice's own
  // payment status is deliberately not carried over.
  setInvValue('invPaymentStatus', 'paid');
  ['invPaymentAmount','invPaymentDate','invPaymentReference','invPaymentNote'].forEach(id => setInvValue(id, ''));
  setInvValue('invPaymentMode', 'cash');
  onInvPaymentStatusChange();
  setPaymentSectionMode(true);

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = !!draft.transport_required;
  onTransportToggleChange();
  restoreExportFields(draft);
  restoreEcomFields(draft);
  setInvValue('invVehicleNo', (draft.vehicle_number || '').toUpperCase());
  setInvValue('invTransporter', draft.transporter_name || '');
  setInvValue('invTransportMode', draft.transport_mode || '');
  setInvValue('invDistance', draft.transport_distance_km || '');
  setInvValue('invLrNumber', draft.lr_number || '');
  setInvValue('invLrDate', draft.lr_date || '');
  setInvValue('invTransporterGstin', draft.transporter_gstin || '');
  setInvValue('invVehicleType', draft.vehicle_type || '');
  setInvValue('invDispatchFrom', draft.dispatch_from || '');
  setInvValue('invDispatchTo', draft.dispatch_to || '');

  if (Array.isArray(draft.items) && draft.items.length) loadItemsIntoTable(draft.items);

  document.getElementById('invPageTitle').textContent = 'New Invoice (Duplicated)';
  showToast('Duplicated — review and Save to create a new invoice.', 'success');
  const user = await getCurrentUser();
  if (user) generateInvoiceNo(user.id, true);
}

// ── Save ─────────────────────────────────────────────
async function saveInvoice() {
  const user = await getCurrentUser();
  if (!user) return;

  const gstin    = getInvText('invGstin').toUpperCase();
  const custName = getInvText('invCustName');
  const phone    = getInvText('invPhone');
  const address  = getInvText('invAddress');
  const state    = document.getElementById('invState')?.value || '';
  let   invNum   = getInvText('invNum');
  const invDate  = getInvText('invDate');
  const supply   = document.getElementById('invSupply')?.value || 'intrastate';
  const source   = getInvoiceSource();
  const gstCategory = getInvGstCategory();
  const reverseCharge = !!document.getElementById('invReverseCharge')?.checked;

  const type = getSelectedInvoiceType();
  const wasNewInvoice = !invoiceEditId;
  const autoMode = isAutoInvoiceOn();

  if (!custName) { showToast('Please enter the customer name.', 'error'); return; }
  // State is only user-facing (and required) in B2B's form — B2C's is
  // hidden and auto-filled from the business profile by syncInvoiceTypeUI().
  if (type === 'b2b' && !state) { showToast('Please select a state.', 'error'); return; }
  // In Auto Generate mode a brand-new invoice's number hasn't been
  // reserved yet at this point (see below) — the field just shows a
  // non-binding preview, which is allowed to be blank if e.g. the
  // profile hasn't loaded yet. Manual mode (or editing/duplicating an
  // existing invoice) still requires it up front as before.
  if (!invNum && !(autoMode && wasNewInvoice)) { showToast('Please enter an invoice number.', 'error'); return; }
  if (!invDate)  { showToast('Please enter the invoice date.', 'error'); return; }
  if (type === 'b2b' && !gstin) { showToast('B2B is selected — enter the customer\'s GST Number, or switch to B2C.', 'error'); return; }
  // GST Number is optional on B2C, but if one is entered — either type —
  // it must be a genuinely valid GSTIN (format + state code + PAN +
  // checksum, see validateGstin()) before Save is allowed; the 🔴
  // Invalid GST Number indicator under the field is the live version of
  // this same check.
  if (gstin && !validateGstin(gstin).valid) {
    showToast('GST Number is invalid — correct it (or clear it) before saving.', 'error');
    return;
  }
  // Amount Received can't exceed the Grand Total. The inline error under
  // the field is the live version of this same check. Only a brand-new
  // invoice's form records a payment (see the wasNewInvoice block below),
  // so that's the only case to gate. The server enforces this too
  // (routes/payments.js checks against the ledger sum); catching it here
  // just avoids saving an invoice and then failing its payment.
  if (wasNewInvoice && !validateInvPaymentAmount()) return;

  // Auto Generate: reserve the authoritative number now, right before
  // the duplicate check — never trust the on-screen preview alone since
  // another tab/session could have consumed it since it was shown. Never
  // applies to editing/duplicating-in-place an existing invoice (that
  // always keeps its own number); only a genuinely new invoice.
  if (autoMode && wasNewInvoice) {
    invNum = await reserveNextInvoiceNumber(user.id, source);
    if (!invNum) return; // reserveNextInvoiceNumber() already showed an error toast
    setInvValue('invNum', invNum);
  }

  const isTypeChange = invoiceEditId && invoiceEditType && invoiceEditType !== type;

  if (!invoiceEditId || isTypeChange) {
    // Only within the same series. Two series may legitimately both hold
    // a 5 — they are different documents in different books, and GSTR-1
    // reports them as such.
    // readMaybeOne(), not a bare destructure of `.data`. A `.single()`
    // that finds nothing and a `.single()` whose REQUEST failed both
    // arrive with no data, and reading them the same way meant a failed
    // duplicate check was taken as "no duplicate" and the save went
    // ahead — putting two documents on one number into a filing, which
    // the Portal rejects and which has to be unpicked by hand. undefined
    // means the check itself failed, so nothing is saved.
    const [dupB2B, dupB2C] = await Promise.all([
      readMaybeOne(_supabase.from('b2b_invoices').select('id').eq('user_id', user.id).eq('invoice_number', invNum).eq('invoice_source', source).single(),
        'Could not check whether that invoice number is already used'),
      readMaybeOne(_supabase.from('b2c_invoices').select('id').eq('user_id', user.id).eq('invoice_number', invNum).eq('invoice_source', source).single(),
        'Could not check whether that invoice number is already used')
    ]);
    if (dupB2B === undefined || dupB2C === undefined) return;
    const dupId = dupB2B?.id || dupB2C?.id;
    // On a type change, the invoice being edited still has this exact
    // number on its OLD table row (not deleted yet) — that's not a real
    // duplicate, it's the record we're about to migrate off of.
    if (dupId && dupId !== invoiceEditId) { showToast('Invoice number already exists!', 'error'); return; }
  }

  const transportRequired = !!document.getElementById('transportToggle')?.checked;
  // An export is an invoice with a shipping bill against it. When the
  // toggle is off every one of these is null, and the row is byte-for-byte
  // the row this page has always written.
  const isExport = !!document.getElementById('exportToggle')?.checked;
  const isEcom = !!document.getElementById('ecomToggle')?.checked;
  const headerBase = {
    user_id: user.id,
    customer_name: custName, phone, address, state,
    ...buildInvShipTo(),
    invoice_number: invNum, invoice_date: invDate, supply_type: supply,
    invoice_source: source,
    gst_category: gstCategory,
    reverse_charge: reverseCharge,
    export_type: isExport ? (document.getElementById('invExportType')?.value || 'WPAY') : null,
    port_code: isExport ? getInvText('invPortCode').toUpperCase() : null,
    shipping_bill_number: isExport ? getInvText('invShippingBillNo') : null,
    shipping_bill_date: isExport ? (getInvText('invShippingBillDate') || null) : null,
    ecom_gstin: isEcom ? getInvText('invEcomGstin').toUpperCase() : null,
    ecom_supply_type: isEcom ? (document.getElementById('invEcomSupplyType')?.value || 'through_operator') : null,
    export_of: isExport ? (document.getElementById('invExportOf')?.value || 'goods') : null,
    sez_recipient_type: document.getElementById('invSezRecipient')?.value || null,
    differential_65: !!document.getElementById('invDifferential65')?.checked,
    // The LUT in force when this invoice was raised, copied onto it. The
    // profile's LUT can be replaced next year; a filed return must not
    // change because of that.
    lut_number: (typeof getCachedProfile === 'function' ? (getCachedProfile()?.lut_number || null) : null),
    transport_required: transportRequired,
    vehicle_number: transportRequired ? getInvText('invVehicleNo').toUpperCase() : '',
    transporter_name: transportRequired ? getInvText('invTransporter') : '',
    transport_mode: transportRequired ? (document.getElementById('invTransportMode')?.value || '') : '',
    transport_distance_km: transportRequired ? (parseFloat(getInvText('invDistance')) || null) : null,
    lr_number: transportRequired ? getInvText('invLrNumber') : '',
    lr_date: transportRequired ? (getInvText('invLrDate') || null) : null,
    transporter_gstin: transportRequired ? getInvText('invTransporterGstin') : '',
    vehicle_type: transportRequired ? (document.getElementById('invVehicleType')?.value || '') : '',
    dispatch_from: transportRequired ? getInvText('invDispatchFrom') : '',
    dispatch_to: transportRequired ? getInvText('invDispatchTo') : ''
  };
  // GST Number is optional on B2C too now, so it's always persisted —
  // b2b_invoices.gst_number is NOT NULL (validated above), b2c_invoices'
  // is nullable.
  headerBase.gst_number = gstin || null;

  let invoiceId;
  if (isTypeChange) {
    // The B2B/B2C toggle (auto-driven by GSTIN, or manually switched)
    // now points at the OTHER table than this invoice was originally
    // saved under. saveInvoiceWithItems() only ever updates in place on
    // the table it's given, so a classification change is handled as
    // insert-into-new-table + permanently delete the old row (same as
    // any other delete — items+HSN+stock reversal, then the header).
    invoiceId = await saveInvoiceWithItems(type, headerBase, null, user.id);
    if (invoiceId) {
      const oldTable = invoiceEditType === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
      await cascadeInvoiceItemsDelete(invoiceEditType, invoiceEditId);
      await _supabase.from(oldTable).delete().eq('id', invoiceEditId);
    }
  } else {
    if (!invoiceEditId) { headerBase.payment_status = 'unpaid'; headerBase.amount_paid = 0; }
    invoiceId = await saveInvoiceWithItems(type, headerBase, invoiceEditId, user.id);
  }
  if (!invoiceId) return;

  // Initial payment, if the user marked one on the creation form — goes
  // through the same payments ledger Invoice List's Receive Payment
  // uses (js/payments.js), so it shows up in Payment History too rather
  // than being a number with no record behind it. Only for a brand-new
  // invoice — editing an existing one manages payments from Invoice
  // List instead (see loadInvoiceForEdit()).
  if (wasNewInvoice && !isTypeChange) {
    const payStatus = document.getElementById('invPaymentStatus')?.value || 'unpaid';
    if (payStatus !== 'unpaid') {
      const rollups = computeInvoiceRollups();
      const amount = payStatus === 'paid' ? rollups.total_amount : (parseFloat(getInvText('invPaymentAmount')) || 0);
      if (amount > 0) {
        const method = payStatus === 'paid' ? 'cash' : (document.getElementById('invPaymentMode')?.value || 'cash');
        const payDate = payStatus === 'paid' ? invDate : (getInvText('invPaymentDate') || invDate);
        const referenceNumber = payStatus === 'paid' ? '' : getInvText('invPaymentReference');
        const note = payStatus === 'paid' ? 'Recorded at invoice creation' : (getInvText('invPaymentNote') || 'Recorded at invoice creation');
        const payResult = await recordPayment(type, invoiceId, user.id, { amount, method, date: payDate, referenceNumber, note });
        if (!payResult.ok) handleApiError(payResult.error, 'Invoice saved, but the payment could not be recorded');
      }
    }
  }

  showToast(wasNewInvoice ? 'Invoice saved successfully!' : 'Invoice updated successfully!');
  clearDraft(INVOICE_FORM_KEY);
  clearItemsDraft(INVOICE_FORM_KEY);
  const banner = document.getElementById('invDraftBanner'); if (banner) banner.innerHTML = '';
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
  showInvoiceSavedPanel(type, invoiceId, custName);

  if (wasNewInvoice) {
    // A duplicate started life as an Invoice List action, so it ends there
    // too: the list remembered where the user was before sending them here,
    // and now that the copy exists they go back to that exact page with it
    // marked. Every OTHER new invoice keeps the old behaviour below.
    const pending = peekListReturnState(INVOICE_LIST_RETURN_KEY);
    if (pending?.returnAfterCreate) {
      setListReturnState(INVOICE_LIST_RETURN_KEY, {
        flash: 'Invoice saved successfully!',
        returnAfterCreate: false,
        selected: { type, id: invoiceId }     // the copy, not the original
      });
      location.replace('invoice-list.html');
      return;
    }
    // Workflow speed: don't make the user click "New Invoice" for every
    // sale — the form is instantly ready for the next one, with the
    // just-saved invoice's Print/WhatsApp/Email actions still available
    // in the panel above (clearInvoiceFormFields() never touches it).
    clearInvoiceFormFields();
    document.getElementById('invCustName')?.focus();
  } else {
    invoiceEditId = invoiceId;
    invoiceEditType = type;
    document.getElementById('invSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Invoice';
    document.getElementById('invPageTitle').textContent = 'Edit Invoice';

    // An update succeeded: hand the user back to the list they came
    // from. Only ever on this branch — a brand-new invoice still clears
    // the form for the next sale, and a FAILED save returns early well
    // above this point, so a failure keeps the user here with the error
    // and their edits intact.
    //
    // replace() rather than assign(): the editor is finished with, and
    // leaving it in history would mean Back reopens a form for an
    // invoice that has already been saved.
    setListReturnState(INVOICE_LIST_RETURN_KEY, {
      flash: 'Invoice updated successfully!',
      selected: { type, id: invoiceId }
    });
    location.replace('invoice-list.html');
  }
}

// ── Post-save: Print/PDF/WhatsApp/Email right here, no navigation ──
function showInvoiceSavedPanel(type, id, custName) {
  const panel = document.getElementById('invSavedPanel');
  if (!panel) return;
  panel.classList.remove('d-none');
  const summary = document.getElementById('invSavedSummary');
  if (summary) summary.textContent = `${type === 'b2b' ? 'B2B' : 'B2C'} invoice for ${custName || 'customer'} is ready to share.`;
  document.getElementById('invActionPdf').onclick      = () => downloadInvoicePDF(type, id);
  document.getElementById('invActionPrint').onclick    = () => printInvoice(type, id);
  document.getElementById('invActionWhatsApp').onclick = () => shareInvoiceWhatsApp(type, id);
  document.getElementById('invActionEmail').onclick    = () => emailInvoicePDF(type, id);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Reset ────────────────────────────────────────────
// Clears every field back to a ready-for-the-next-invoice state —
// shared by the explicit Reset button and the automatic clear that
// happens right after saving a new invoice. Callers decide separately
// whether to hide the just-saved invoice's share panel (the explicit
// Reset button does; the auto-clear-after-save path deliberately
// doesn't, so Print/WhatsApp/Email stay reachable for what was just saved).
function clearInvoiceFormFields() {
  ['invGstin','invPhone','invAddress','invNum'].forEach(id => setInvValue(id, ''));
  setInvValue('invCustName', 'Walk-in Customer');
  setInvValue('invState', '');
  setInvValue('invShipAddress', '');
  setInvValue('invShipState', '');
  setInvValue('invShipDistrict', '');
  const shipSameReset = document.getElementById('invShipSame');
  if (shipSameReset) shipSameReset.checked = true;   // default is same as billing
  onInvShipSameChange();
  setInvValue('invDate', toISO(new Date()));
  setInvValue('invSupply', 'intrastate');
  // Back to the default series, same as every other field here returns
  // to its default. generateInvoiceNo() below then previews the offline
  // counter, not whichever series was just used.
  setInvoiceSourceValue(INVOICE_SOURCE_DEFAULT);
  setInvGstCategory(GST_CUSTOMER_CATEGORY_DEFAULT);
  const rcReset = document.getElementById('invReverseCharge');
  if (rcReset) rcReset.checked = !!getCachedProfile()?.reverse_charge_default;
  setInvoiceTypeToggle('b2c');
  updateGstinValidationStatus();

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = false;
  onTransportToggleChange();
  restoreExportFields(null);
  restoreEcomFields(null);
  ['invVehicleNo','invTransporter','invLrNumber','invTransportMode','invDistance','invLrDate',
   'invTransporterGstin','invVehicleType','invDispatchFrom','invDispatchTo'].forEach(id => setInvValue(id, ''));

  // Same default as the markup: a new invoice starts at Paid in Full.
  setInvValue('invPaymentStatus', 'paid');
  ['invPaymentAmount','invPaymentDate','invPaymentReference','invPaymentNote'].forEach(id => setInvValue(id, ''));
  setInvValue('invPaymentMode', 'cash');
  onInvPaymentStatusChange();
  setPaymentSectionMode(true);

  resetInvoiceItems();
  invoiceEditId = null;
  invoiceEditType = null;
  document.getElementById('invPageTitle').textContent = 'New Invoice';
  document.getElementById('invSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Invoice';
  updateClassifyBadge();
  detectSupplyType();

  clearDraft(INVOICE_FORM_KEY);
  clearItemsDraft(INVOICE_FORM_KEY);
  const banner = document.getElementById('invDraftBanner'); if (banner) banner.innerHTML = '';

  getCurrentUser().then(u => { if (u) generateInvoiceNo(u.id); });
}

function resetInvoiceForm() {
  clearInvoiceFormFields();
  document.getElementById('invSavedPanel')?.classList.add('d-none');
  document.getElementById('invCustName')?.focus();
}

// ── Keyboard-friendly invoice entry ─────────────────
// Ctrl/Cmd+S = Save, Ctrl/Cmd+P = Print the saved invoice, Enter on a
// text field moves to the next field instead of doing nothing. The
// Product field and Quantity field have their own special Enter
// behavior (select the match / start the next row) — see
// js/invoice-items.js's onkeydown handlers on those two inputs, which
// call back into ensureNextItemRowFocused() below.
function triggerInvoicePrint() {
  if (invoiceEditId && invoiceEditType) printInvoice(invoiceEditType, invoiceEditId);
  else showToast('Save the invoice before printing.', 'warning');
}

function focusNextFormField(current) {
  const focusables = Array.from(document.querySelectorAll(
    '.main-content input:not([type=hidden]):not([disabled]), .main-content select:not([disabled])'
  )).filter(el => el.offsetParent !== null);
  const idx = focusables.indexOf(current);
  if (idx >= 0 && idx < focusables.length - 1) focusables[idx + 1].focus();
}

function focusNewItemRowProduct() {
  const rows = document.querySelectorAll('#itemsTableBody tr');
  const lastRow = rows[rows.length - 1];
  lastRow?.querySelector('.item-product-input')?.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveInvoice(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); triggerInvoicePrint(); return; }

  if (e.key !== 'Enter') return;
  const el = e.target;
  if (!el || !['INPUT', 'SELECT'].includes(el.tagName) || !el.closest('.main-content')) return;

  // Quantity field: Enter = add a new row and jump straight to its
  // Product field, so a full row can be entered without touching the mouse.
  // Matched by data-field-wrap (a stable marker) rather than the old
  // "does the oninput attribute's text contain 'quantity'" substring
  // check — that broke silently the moment the handler it was matching
  // against got renamed (onItemFieldChange -> onItemQtyInput), which is
  // exactly what happened here; a semantic attribute can't go stale the
  // same way a copy of another function's call text can.
  if (el.matches('#itemsTableBody [data-field-wrap="qty"] input')) {
    e.preventDefault();
    addItemRow();
    focusNewItemRowProduct();
    return;
  }
  // Product field: Enter = pick whichever option Arrow keys highlighted
  // (top match by default) — selectProductFromDropdown() itself focuses
  // Qty next. See js/invoice-items.js for the Arrow-key highlight logic.
  if (el.matches('#itemsTableBody .item-product-input')) {
    e.preventDefault();
    const tr = el.closest('tr[data-row]');
    if (tr) selectHighlightedProductOption(tr.getAttribute('data-row'));
    return;
  }
  // Every other text input: Enter = move to the next field.
  e.preventDefault();
  focusNextFormField(el);
});


// ── Export invoice (Batch 5) ────────────────────────────────
// An export is reported in GSTR-1 Table 6A rather than B2B, B2CL or
// B2CS, because it is not a domestic supply. It still counts in the HSN
// summary and its number is still reported in Table 13.
function onExportToggleChange() {
  const on = !!document.getElementById('exportToggle')?.checked;
  document.getElementById('exportFields')?.classList.toggle('d-none', !on);
  const lbl = document.getElementById('exportToggleLabel');
  if (lbl) {
    lbl.textContent = on ? 'Yes' : 'No';
    lbl.classList.toggle('text-gray-mid', !on);
  }
}

// Called when an existing invoice is opened, so an export stays an export.
function restoreExportFields(inv) {
  const t = document.getElementById('exportToggle');
  if (!t) return;
  t.checked = !!(inv && inv.export_type);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v == null ? '' : v; };
  set('invExportType', (inv && inv.export_type) || 'WPAY');
  set('invPortCode', inv && inv.port_code);
  set('invShippingBillNo', inv && inv.shipping_bill_number);
  set('invShippingBillDate', inv && inv.shipping_bill_date);
  set('invExportOf', (inv && inv.export_of) || 'goods');
  set('invSezRecipient', (inv && inv.sez_recipient_type) || '');
  const d65i = document.getElementById('invDifferential65');
  if (d65i) d65i.checked = !!(inv && inv.differential_65);
  onExportToggleChange();
}


// ── Supplied through an e-commerce operator (Batch 6) ───────
// Two different things: a supply MADE THROUGH an operator, where the
// supplier still pays the tax and the operator's GSTIN is reported as
// etin; and a section 9(5) supply, where the operator pays instead. Both
// are recorded; only the first is written to the JSON today.
function onEcomToggleChange() {
  const on = !!document.getElementById('ecomToggle')?.checked;
  document.getElementById('ecomFields')?.classList.toggle('d-none', !on);
  const lbl = document.getElementById('ecomToggleLabel');
  if (lbl) {
    lbl.textContent = on ? 'Yes' : 'No';
    lbl.classList.toggle('text-gray-mid', !on);
  }
}

function restoreEcomFields(inv) {
  const t = document.getElementById('ecomToggle');
  if (!t) return;
  t.checked = !!(inv && inv.ecom_gstin);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v == null ? '' : v; };
  set('invEcomGstin', inv && inv.ecom_gstin);
  set('invEcomSupplyType', (inv && inv.ecom_supply_type) || 'through_operator');
  onEcomToggleChange();
}

// ── Address District ────────────────────────────────
// Changing the State refills the district list and drops a district that
// belonged to the previous state. The State handler these are chained
// after (supply-type detection) is untouched — District never feeds the
// GST place-of-supply decision.
function onInvStateChange() {
  syncDistrictField('invState', 'invDistrict', 'invDistrictList', 'invDistrictError');
  mirrorInvShipFromBilling();
}
function onInvDistrictChange() {
  syncDistrictField('invState', 'invDistrict', 'invDistrictList', 'invDistrictError');
  mirrorInvShipFromBilling();
}

// ── Shipped To ─────────────────────────────────────
// Ticked means the goods went to the billing address. That is stored as
// NULL, never as a copy: one address on the invoice, so correcting the
// billing address later cannot leave a stale Ship To behind it. Unticked,
// the invoice carries its own.
//
// While ticked the fields are disabled and mirror Billing live, so editing
// Billing moves Ship To with it and the user never types the address twice.
function invShipSameChecked() {
  const el = document.getElementById('invShipSame');
  return el ? el.checked : true;   // absent checkbox = the old behaviour
}

// Copies Billing into the Ship To fields for display only. Nothing here
// reaches the save payload - see buildInvShipTo() for what is stored.
function mirrorInvShipFromBilling() {
  if (!invShipSameChecked()) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('invShipAddress', getInvText('invAddress'));
  set('invShipState', document.getElementById('invState')?.value || '');
  set('invShipDistrict', document.getElementById('invDistrict')?.value || '');
  populateDistrictList('invShipDistrictList', document.getElementById('invShipState')?.value || '');
}

function onInvShipSameChange() {
  const same = invShipSameChecked();
  ['invShipAddress', 'invShipState', 'invShipDistrict'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = same;
  });
  const note = document.getElementById('invShipNote');
  if (note) {
    note.textContent = same
      ? 'Goods are delivered to the billing address.'
      : 'Changing this does NOT change the Billing Address.';
  }
  if (same) {
    mirrorInvShipFromBilling();
    // A ticked box cannot be holding an invalid district, so clear any
    // message the user left behind while it was unticked.
    const err = document.getElementById('invShipDistrictError');
    if (err) { err.textContent = ''; err.classList.add('d-none'); }
  }
}

function onInvShipStateChange() {
  syncDistrictField('invShipState', 'invShipDistrict', 'invShipDistrictList', 'invShipDistrictError');
}
function onInvShipDistrictChange() {
  syncDistrictField('invShipState', 'invShipDistrict', 'invShipDistrictList', 'invShipDistrictError');
}

// What actually goes on the invoice row. NULL for all three when ticked -
// the whole point of the feature.
function buildInvShipTo() {
  if (invShipSameChecked()) {
    return { shipping_address: null, shipping_state: null, shipping_district: null };
  }
  return {
    shipping_address: getInvText('invShipAddress') || null,
    shipping_state: document.getElementById('invShipState')?.value || null,
    shipping_district: getInvText('invShipDistrict') || null
  };
}

// ── GSTIN lookup against the public taxpayer register ──────────────────
// The Appyflow call is made by our own backend (server/routes/gst-verify.js),
// which holds the account secret. Nothing here knows or could learn it.
//
// This fills in what the register says; it does not decide anything. Supply
// type is still worked out by detectSupplyType() from the two GSTINs, and
// the State/District pair still goes through the same validation as a
// hand-typed one — a fetched district is not trusted more than a typed one.
let _invGstLookupInFlight = false;

function setInvGstVerifyMsg(text, kind) {
  const el = document.getElementById('invGstVerifyMsg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('d-none', !text);
  el.classList.toggle('text-danger', kind === 'error');
  el.classList.toggle('text-muted', kind !== 'error');
}

// Matches a Portal state name to the one this application stores. The
// Portal writes the same names INDIAN_STATES does, but case and spacing
// have been seen to differ, so the comparison is loosened just enough to
// absorb that without accepting a different state.
function matchIndianState(name) {
  const want = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!want) return '';
  return INDIAN_STATES.find(s => s.toLowerCase() === want)
      || INDIAN_STATES.find(s => s.toLowerCase().replace(/\s+/g, '') === want.replace(/\s+/g, ''))
      || '';
}

async function verifyInvoiceGstin() {
  // One lookup at a time. Each one is a paid call, and a double-click
  // must not become two.
  if (_invGstLookupInFlight) return;

  const el = document.getElementById('invGstin');
  const gstin = (el?.value || '').trim().toUpperCase();
  if (!validateGstin(gstin).valid) {
    setInvGstVerifyMsg('Enter a valid 15-character GSTIN first.', 'error');
    el?.focus();
    return;
  }

  const btn = document.getElementById('invGstVerifyBtn');
  const originalHtml = btn ? btn.innerHTML : '';
  _invGstLookupInFlight = true;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Fetching…'; }
  setInvGstVerifyMsg('Looking up the GST register…', 'info');

  try {
    const res = await fetch(`${API_BASE_URL}/gst/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('gst_jwt') },
      body: JSON.stringify({ gstin })
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      // Nothing already on the form is touched when the lookup fails —
      // the user's own typing is worth more than a failed request.
      handleApiError(apiErrorFrom(res, body), 'GST verification failed');
      setInvGstVerifyMsg(body?.error?.message || 'Could not verify that GSTIN.', 'error');
      return;
    }

    const t = body && body.taxpayer;
    if (!t) { setInvGstVerifyMsg('No details returned for that GSTIN.', 'error'); return; }

    // Trade name is what a business is invoiced as; legal name is the
    // fallback, because a proprietorship often has no separate trade name.
    const name = (t.tradeName || t.legalName || '').trim();
    if (name) setInvValue('invCustName', name);
    setInvValue('invGstin', t.gstin || gstin);
    if (t.address) { const a = document.getElementById('invAddress'); if (a) a.value = t.address; }

    // State first, then District — the district list is filtered by the
    // state, so setting them the other way round would offer the wrong
    // list. Both then go through the ordinary validation.
    const state = matchIndianState(t.state);
    const stateEl = document.getElementById('invState');
    if (state && stateEl) stateEl.value = state;
    populateDistrictList('invDistrictList', state);
    const distEl = document.getElementById('invDistrict');
    if (distEl) {
      const canonical = state ? canonicalDistrictFor(state, t.district) : '';
      distEl.value = canonical || '';
    }
    syncDistrictField('invState', 'invDistrict', 'invDistrictList', 'invDistrictError');

    // Untouched: supply type is still derived, never set from the lookup.
    detectSupplyType();
    updateGstinValidationStatus();

    const cancelled = /cancel|suspend|inactive/i.test(t.status || '');
    setInvGstVerifyMsg(
      cancelled
        ? `Fetched — but the GST portal reports this registration as "${t.status}".`
        : `Fetched from the GST register${t.status ? ` — status: ${t.status}` : ''}.`,
      cancelled ? 'error' : 'info');
  } catch (err) {
    handleApiError(err, 'GST verification failed');
    setInvGstVerifyMsg('Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    _invGstLookupInFlight = false;
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

// Thin wrapper so the lookup does not need to know how the district
// register is exposed on the page.
function canonicalDistrictFor(state, district) {
  if (typeof IndiaDistricts === 'undefined') return String(district || '').trim();
  return IndiaDistricts.canonicalDistrict(state, district) || '';
}
