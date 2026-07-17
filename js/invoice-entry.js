// =============================================
// One-Page Invoice Entry (invoice.html)
// Replaces separate B2B (gstr1.html) / B2C (b2c.html) entry forms.
// Classification is automatic: GST Number filled in -> B2B invoice,
// left blank -> B2C invoice. b2b_invoices/b2c_invoices remain two
// separate tables under the hood (every downstream consumer — Reports,
// Dashboard, HSN, GSTR-3B, Recycle Bin, PDF/WhatsApp/Email — already
// keys off that 'b2b'/'b2c' type discriminator); this form just decides
// which one to write to instead of the user picking a page.
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

// ── B2B / B2C — visible, always-both-shown segmented toggle. GST Number
// drives it automatically (entered -> B2B, cleared -> B2C) on every
// edit to that field, but the user can click the toggle directly at any
// other time to override it (e.g. treat a walk-in sale as B2C even
// though a GSTIN happens to be on the form). Whichever the toggle says
// at Save time is authoritative — see saveInvoice()'s validation.
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
// mode banner, and which fields are even visible all in sync with
// whichever radio is actually checked — called after both automatic
// (GSTIN-driven) and manual (user click) changes, and on every load
// path (init/edit/duplicate/reset) so the two modes are never a mix of
// stale field visibility from whatever the previous mode showed.
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

  // GST Number + State only exist in B2B's form — a completely
  // different-looking page for the two modes, not the same fields with
  // one relabeled hint, per the redesign. The collapse animation is
  // max-height/opacity, not display:none, so the inputs must also be
  // explicitly disabled here — otherwise they're invisible but still
  // reachable by Tab (and by Enter's field-to-field advance), which
  // breaks keyboard navigation and doesn't really "hide" them.
  document.getElementById('invB2BFields')?.classList.toggle('collapsed', !isB2B);
  const gstInputEl = document.getElementById('invGstin');
  const stateInputEl = document.getElementById('invState');
  if (gstInputEl) gstInputEl.disabled = !isB2B;
  if (stateInputEl) stateInputEl.disabled = !isB2B;

  if (!isB2B) {
    // State is hidden in B2C, but b2c_invoices.state and supply-type
    // detection both still need a real value — silently use the
    // business's own registered state, matching the overwhelmingly
    // common case for a walk-in sale (same state -> Intrastate). Only
    // fills an EMPTY field: loading an existing B2C invoice for edit
    // sets its real saved state before this runs, and that must win,
    // not get silently overwritten by today's business profile default.
    const stEl = document.getElementById('invState');
    if (stEl && !stEl.value) {
      const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
      if (profile?.state) stEl.value = profile.state;
    }
  }
}

// Kept as an alias — several call sites already say "update the badge"
// after changing GSTIN/state/etc.; it now just means "resync the toggle."
function updateClassifyBadge() { syncInvoiceTypeUI(); }

function onInvoiceTypeToggle() {
  // Manually switching to B2C means "this isn't a GST sale" — clear
  // whatever GST Number and State were there so they don't linger,
  // hidden, behind the collapsed B2B fields (a leftover B2B customer's
  // state would otherwise silently carry over instead of resetting to
  // the business's own default). syncInvoiceTypeUI() below re-fills
  // State from the business profile since it's now genuinely empty.
  if (getSelectedInvoiceType() === 'b2c') {
    setInvValue('invGstin', '');
    setInvValue('invState', '');
  }
  syncInvoiceTypeUI();
  detectSupplyType();
}

function onInvoiceGstinInput(el) {
  el.value = el.value.toUpperCase();
  // Reverting to B2C is the "safe" direction — clearing the field while
  // B2B is selected switches back silently, same as before. Switching
  // TO B2B is the consequential direction, so that one asks first (see
  // onInvoiceGstinBlur) instead of flipping on every keystroke.
  if (!el.value.trim() && getSelectedInvoiceType() === 'b2b') setInvoiceTypeToggle('b2c');
  detectSupplyType();
}

function isValidGstinFormat(value) {
  return value.length === 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(value);
}

// "Untouched" covers both a genuinely empty field and the default
// "Walk-in Customer" placeholder value — either way, auto-fill is safe
// to overwrite because the user hasn't typed a real name of their own.
function isCustNameUntouched() {
  const v = getInvText('invCustName');
  return !v || v === 'Walk-in Customer';
}

// GST Number only exists in the B2B form now (hidden entirely in B2C),
// so by construction this can only fire while already on B2B — no
// confirmation dialog needed for "should this become B2B?" the way it
// did when the field was visible-but-optional in a single shared form.
// What's still genuinely useful: recognizing a GSTIN that matches an
// existing customer and pulling in their details automatically.
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
function isAutoInvoiceOn() { return localStorage.getItem('gst_auto_invoice') === 'true'; }

function updateAutoToggleUI() {
  const on = isAutoInvoiceOn();
  const cb = document.getElementById('autoInvToggle');
  const lbl = document.getElementById('autoInvLabel');
  if (cb) cb.checked = on;
  if (lbl) { lbl.textContent = on ? 'ON' : 'OFF'; lbl.style.color = on ? 'var(--primary)' : '#9e9e9e'; }
}

function onAutoToggleChange() {
  const on = document.getElementById('autoInvToggle')?.checked;
  localStorage.setItem('gst_auto_invoice', on);
  updateAutoToggleUI();
  if (on) getCurrentUser().then(u => { if (u) generateInvoiceNo(u.id, true); });
}

async function generateInvoiceNo(userId, force) {
  if (invoiceEditId) return;
  if (!force && !isAutoInvoiceOn()) return;
  const uid = userId || (await getCurrentUser())?.id;
  const year = new Date().getFullYear();
  const [{ data: b2b }, { data: b2c }] = await Promise.all([
    _supabase.from('b2b_invoices').select('invoice_number').eq('user_id', uid),
    _supabase.from('b2c_invoices').select('invoice_number').eq('user_id', uid)
  ]);
  const nums = [...(b2b || []), ...(b2c || [])].map(r => {
    const m = r.invoice_number?.match(/(\d+)$/);
    return m ? parseInt(m[1]) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  setInvValue('invNum', `INV-${year}-${String(next).padStart(3, '0')}`);
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
  // A matched customer with a GSTIN on file is a B2B customer — switch
  // modes (revealing the GST Number field) before filling it in, so the
  // reveal animates in with the value already there instead of an
  // empty field popping in first.
  if (cust.gstin && getSelectedInvoiceType() !== 'b2b') setInvoiceTypeToggle('b2b');
  const gstEl = document.getElementById('invGstin');   if (gstEl && !gstEl.value && cust.gstin)   gstEl.value = cust.gstin.toUpperCase();
  const phEl  = document.getElementById('invPhone');   if (phEl  && !phEl.value  && cust.phone)   phEl.value  = cust.phone;
  const adEl  = document.getElementById('invAddress'); if (adEl  && !adEl.value  && cust.address) adEl.value  = cust.address;
  const stEl  = document.getElementById('invState');   if (stEl  && !stEl.value  && cust.state)   stEl.value  = cust.state;
  detectSupplyType();
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

  setInvValue('invGstin', type === 'b2b' ? (rec.gst_number || '') : '');
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
  setInvValue('invVehicleNo', rec.vehicle_number || '');
  setInvValue('invTransporter', rec.transporter_name || '');
  setInvValue('invTransportMode', rec.transport_mode || '');
  setInvValue('invDistance', rec.transport_distance_km || '');
  setInvValue('invLrNumber', rec.lr_number || '');
  setInvValue('invLrDate', rec.lr_date || '');

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
  setInvoiceTypeToggle(draft.gst_number ? 'b2b' : 'b2c');
  // A duplicate is a brand-new sale, not a copy of the old one's
  // payment state — starts fresh at Unpaid, editable, same as any new invoice.
  setInvValue('invPaymentStatus', 'unpaid');
  onInvPaymentStatusChange();
  setPaymentSectionMode(true);

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = !!draft.transport_required;
  onTransportToggleChange();
  setInvValue('invVehicleNo', draft.vehicle_number || '');
  setInvValue('invTransporter', draft.transporter_name || '');
  setInvValue('invTransportMode', draft.transport_mode || '');
  setInvValue('invDistance', draft.transport_distance_km || '');
  setInvValue('invLrNumber', draft.lr_number || '');
  setInvValue('invLrDate', draft.lr_date || '');

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
  const invNum   = getInvText('invNum');
  const invDate  = getInvText('invDate');
  const supply   = document.getElementById('invSupply')?.value || 'intrastate';

  const type = getSelectedInvoiceType();
  const wasNewInvoice = !invoiceEditId;

  if (!custName) { showToast('Please enter the customer name.', 'error'); return; }
  // State is only user-facing (and required) in B2B's form — B2C's is
  // hidden and auto-filled from the business profile by syncInvoiceTypeUI().
  if (type === 'b2b' && !state) { showToast('Please select a state.', 'error'); return; }
  if (!invNum)   { showToast('Please enter an invoice number.', 'error'); return; }
  if (!invDate)  { showToast('Please enter the invoice date.', 'error'); return; }
  if (type === 'b2b' && !gstin) { showToast('B2B is selected — enter the customer\'s GST Number, or switch to B2C.', 'error'); return; }
  if (gstin) {
    if (gstin.length < 15) { showToast('GST Number must be 15 characters.', 'error'); return; }
    if (!isValidGstinFormat(gstin)) {
      showToast('GST Number format warning — saving anyway.', 'warning');
    }
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
    vehicle_number: transportRequired ? getInvText('invVehicleNo') : '',
    transporter_name: transportRequired ? getInvText('invTransporter') : '',
    transport_mode: transportRequired ? (document.getElementById('invTransportMode')?.value || '') : '',
    transport_distance_km: transportRequired ? (parseFloat(getInvText('invDistance')) || null) : null,
    lr_number: transportRequired ? getInvText('invLrNumber') : '',
    lr_date: transportRequired ? (getInvText('invLrDate') || null) : null
  };
  if (type === 'b2b') headerBase.gst_number = gstin;

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

  const toggle = document.getElementById('transportToggle');
  if (toggle) toggle.checked = false;
  onTransportToggleChange();
  ['invVehicleNo','invTransporter','invLrNumber','invTransportMode','invDistance','invLrDate'].forEach(id => setInvValue(id, ''));

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
