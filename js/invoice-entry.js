// =============================================
// One-Page Invoice Entry (invoice.html)
// Replaces separate B2B (gstr1.html) / B2C (b2c.html) entry forms.
// Classification is purely manual — the B2B/B2C segmented toggle — and
// is independent of whether GST Number/State are filled in: both fields
// are always visible in either mode, just optional in B2C and required
// in B2B. b2b_invoices/b2c_invoices remain two separate tables under the
// hood (every downstream consumer — Reports, Dashboard, HSN, GSTR-3B,
// Recycle Bin, PDF/WhatsApp/Email — already keys off that 'b2b'/'b2c'
// type discriminator); this form just decides which one to write to
// instead of the user picking a page.
// =============================================

let invoiceEditId = null;
let invoiceEditType = null;
let invoiceCustomersList = [];
const INVOICE_FORM_KEY = 'invoice_invoice';
const INVOICE_DRAFT_FIELDS = ['invGstin','invCustName','invPhone','invAddress','invState','invNum','invDate','invSupply'];

async function initInvoiceEntry() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  populateInvoiceStateOptions();
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

  let supply = 'intrastate';
  if (businessGstin.length >= 2 && customerGstin.length >= 2) {
    supply = businessGstin.slice(0, 2) === customerGstin.slice(0, 2) ? 'intrastate' : 'interstate';
  } else if (businessState && customerState) {
    supply = businessState === customerState ? 'intrastate' : 'interstate';
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
  const sel = document.getElementById('invState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
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
  const format = profile?.invoice_number_format || 'INV-###';
  const seq = profile?.invoice_current_sequence || 1;
  setInvValue('invNum', applyInvoiceNumberFormat(format, seq));
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
async function reserveNextInvoiceNumber(userId) {
  try {
    const { invoiceNumber } = await apiFetch('/invoices/reserve-number', { method: 'POST' });
    return invoiceNumber;
  } catch (error) {
    showToast('Could not reserve an invoice number: ' + (error.message || 'unknown error'), 'error');
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
  const amountEl = document.getElementById('invPaymentAmount');
  if (amountEl) amountEl.disabled = !show; // keep collapsed field out of Tab order, see syncInvoiceTypeUI()
  if (!show) setInvValue('invPaymentAmount', '');
}

function setPaymentSectionMode(editable, statusLabel) {
  document.getElementById('invPaymentEditableFields')?.classList.toggle('d-none', !editable);
  document.getElementById('invPaymentEditNote')?.classList.toggle('d-none', editable);
  if (!editable) {
    const label = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid in Full' }[statusLabel] || 'Unpaid';
    const el = document.getElementById('invPaymentEditStatusText');
    if (el) el.textContent = label;
  }
}

// ── Customer Master helpers ─────────────────────────
async function loadInvoiceCustomersList(userId) {
  const { data } = await _supabase.from('customers').select('*').eq('user_id', userId);
  invoiceCustomersList = (data || []).filter(c => !c.is_deleted);
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
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
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
  const { data: rec } = await _supabase.from(table).select('*').eq('id', id).single();
  if (!rec) { showToast('Invoice not found.', 'error'); return; }

  invoiceEditId = id;
  invoiceEditType = type;

  setInvValue('invGstin', rec.gst_number || '');
  setInvValue('invCustName', rec.customer_name || '');
  setInvValue('invPhone', rec.phone || '');
  setInvValue('invAddress', rec.address || '');
  setInvValue('invState', rec.state || '');
  setInvValue('invNum', rec.invoice_number || '');
  setInvValue('invDate', rec.invoice_date || '');
  setInvValue('invSupply', rec.supply_type || 'intrastate');
  setInvoiceTypeToggle(type);
  setPaymentSectionMode(false, rec.payment_status);

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = !!rec.transport_required;
  onTransportToggleChange();
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

  const { data: items } = await _supabase.from('invoice_items').select('*').eq('invoice_id', id).eq('invoice_type', type);
  const activeItems = (items || []).filter(r => !r.is_deleted).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
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
  // The original invoice's own type is authoritative — a B2C source
  // invoice may well have an optional GST Number on it too, so presence
  // of gst_number alone can no longer be used to infer B2B/B2C.
  setInvoiceTypeToggle(draft.type || (draft.gst_number ? 'b2b' : 'b2c'));
  // A duplicate is a brand-new sale, not a copy of the old one's
  // payment state — starts fresh at Unpaid, editable, same as any new invoice.
  setInvValue('invPaymentStatus', 'unpaid');
  onInvPaymentStatusChange();
  setPaymentSectionMode(true);

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = !!draft.transport_required;
  onTransportToggleChange();
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

  // Auto Generate: reserve the authoritative number now, right before
  // the duplicate check — never trust the on-screen preview alone since
  // another tab/session could have consumed it since it was shown. Never
  // applies to editing/duplicating-in-place an existing invoice (that
  // always keeps its own number); only a genuinely new invoice.
  if (autoMode && wasNewInvoice) {
    invNum = await reserveNextInvoiceNumber(user.id);
    if (!invNum) return; // reserveNextInvoiceNumber() already showed an error toast
    setInvValue('invNum', invNum);
  }

  const isTypeChange = invoiceEditId && invoiceEditType && invoiceEditType !== type;

  if (!invoiceEditId || isTypeChange) {
    const [dupB2B, dupB2C] = await Promise.all([
      _supabase.from('b2b_invoices').select('id').eq('user_id', user.id).eq('invoice_number', invNum).single(),
      _supabase.from('b2c_invoices').select('id').eq('user_id', user.id).eq('invoice_number', invNum).single()
    ]);
    const dupId = dupB2B.data?.id || dupB2C.data?.id;
    // On a type change, the invoice being edited still has this exact
    // number on its OLD table row (not deleted yet) — that's not a real
    // duplicate, it's the record we're about to migrate off of.
    if (dupId && dupId !== invoiceEditId) { showToast('Invoice number already exists!', 'error'); return; }
  }

  const transportRequired = !!document.getElementById('transportToggle')?.checked;
  const headerBase = {
    user_id: user.id,
    customer_name: custName, phone, address, state,
    invoice_number: invNum, invoice_date: invDate, supply_type: supply,
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
    // the table it's given, so a classification
    // change is handled as insert-into-new-table + soft-delete-old
    // (recoverable via Recycle Bin, same as any other delete).
    invoiceId = await saveInvoiceWithItems(type, headerBase, null, user.id);
    if (invoiceId) {
      const oldTable = invoiceEditType === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
      await _supabase.from(oldTable).update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', invoiceEditId);
      await cascadeInvoiceItemsDelete(invoiceEditType, invoiceEditId);
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
      if (amount > 0) await recordPayment(type, invoiceId, user.id, { amount, method: 'cash', date: invDate, note: 'Recorded at invoice creation' });
    }
  }

  showToast(wasNewInvoice ? 'Invoice saved successfully!' : 'Invoice updated successfully!');
  clearDraft(INVOICE_FORM_KEY);
  clearItemsDraft(INVOICE_FORM_KEY);
  const banner = document.getElementById('invDraftBanner'); if (banner) banner.innerHTML = '';
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
  showInvoiceSavedPanel(type, invoiceId, custName);

  if (wasNewInvoice) {
    // Workflow speed: don't make the user click "New Invoice" for every
    // sale — the form is instantly ready for the next one, with the
    // just-saved invoice's Print/WhatsApp/Email actions still available
    // in the panel above (clearInvoiceFormFields() never touches it).
    clearInvoiceFormFields();
    document.getElementById('invCustName')?.focus();
  } else {
    // Editing an existing invoice: stay on it rather than jumping to a
    // blank form — the user likely wants to review what they just saved.
    invoiceEditId = invoiceId;
    invoiceEditType = type;
    document.getElementById('invSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Invoice';
    document.getElementById('invPageTitle').textContent = 'Edit Invoice';
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
  setInvValue('invDate', toISO(new Date()));
  setInvValue('invSupply', 'intrastate');
  setInvoiceTypeToggle('b2c');
  updateGstinValidationStatus();

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = false;
  onTransportToggleChange();
  ['invVehicleNo','invTransporter','invLrNumber','invTransportMode','invDistance','invLrDate',
   'invTransporterGstin','invVehicleType','invDispatchFrom','invDispatchTo'].forEach(id => setInvValue(id, ''));

  setInvValue('invPaymentStatus', 'unpaid');
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
  lastRow?.querySelector('input[oninput*="onItemProductInput"]')?.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveInvoice(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); triggerInvoicePrint(); return; }

  if (e.key !== 'Enter') return;
  const el = e.target;
  if (!el || !['INPUT', 'SELECT'].includes(el.tagName) || !el.closest('.main-content')) return;

  // Quantity field: Enter = add a new row and jump straight to its
  // Product field, so a full row can be entered without touching the mouse.
  if (el.matches('#itemsTableBody input[oninput*="\'quantity\'"]')) {
    e.preventDefault();
    addItemRow();
    focusNewItemRowProduct();
    return;
  }
  // Product field: Enter = pick whichever option Arrow keys highlighted
  // (top match by default) — selectProductFromDropdown() itself focuses
  // Qty next. See js/invoice-items.js for the Arrow-key highlight logic.
  if (el.matches('#itemsTableBody input[oninput*="onItemProductInput"]')) {
    e.preventDefault();
    const tr = el.closest('tr[data-row]');
    if (tr) selectHighlightedProductOption(tr.getAttribute('data-row'));
    return;
  }
  // Every other text input: Enter = move to the next field.
  e.preventDefault();
  focusNextFormField(el);
});
