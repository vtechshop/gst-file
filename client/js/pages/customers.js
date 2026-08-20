// =============================================
// Customer Master Logic
// =============================================
let custEditId = null;
let custAllData = [];
let custPage = 1;
const CUST_PAGE = 15;

// The 36 India State/UT names live in exactly one place — INDIAN_STATES
// (js/utils.js) — every state dropdown app-wide (Invoice Entry, Purchase
// Entry, Purchase Returns, Business Profile, and this one) is populated
// from it, so there's no separate hardcoded copy to fall out of sync or
// drift incomplete over time.
function populateCustStateOptions() {
  const sel = document.getElementById('custState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

// ── District, one per address ───────────────────────
// Changing the State refills the district list and drops a district that
// belonged to the previous state, so Tiruppur cannot survive a switch to
// Kerala. Both addresses behave identically; Ship-To simply has its own
// pair of fields.
function onCustStateChange() {
  syncDistrictField('custState', 'custDistrict', 'custDistrictList', 'custDistrictError');
  validateCustomerForm();
}
function onCustDistrictChange() {
  syncDistrictField('custState', 'custDistrict', 'custDistrictList', 'custDistrictError');
}
function onCustShipStateChange() {
  syncDistrictField('custShipState', 'custShipDistrict', 'custShipDistrictList', 'custShipDistrictError');
}
function onCustShipDistrictChange() {
  syncDistrictField('custShipState', 'custShipDistrict', 'custShipDistrictList', 'custShipDistrictError');
}

async function initCustomers() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  populateCustStateOptions();
  populateCustGstCategoryOptions();
  loadUserProfile(user.id);
  setupCustSearch();
  await loadCustomers(user.id);
  await loadCustomerOutstanding(user.id);
  applyIncomingSearchQuery('custSearch');
  validateCustomerForm(); // Save starts disabled — the blank form has no required fields filled yet
}

async function loadCustomerOutstanding(userId) {
  const tbody = document.getElementById('custOutstandingBody');
  if (!tbody) return;
  const rows = await loadCustomerOutstandingSummary(userId);
  tbody.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td class="fw-600">${r.name}</td>
        <td class="text-center">${r.invoiceCount}</td>
        <td class="text-right">&#8377;${formatNum(r.totalBilled)}</td>
        <td class="text-right">&#8377;${formatNum(r.totalPaid)}</td>
        <td class="text-right">${r.totalReturned > 0 ? '&#8377;' + formatNum(r.totalReturned) : '&mdash;'}</td>
        <td class="text-right fw-700 ${r.outstanding > 0 ? 'text-danger' : ''}">&#8377;${formatNum(r.outstanding)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No invoices yet.</td></tr>';
}

// ── Validation ──────────────────────────────────────────
// Mirrors server/utils/validation.js's validateCustomerPayload()
// exactly (same required fields, same phone/GSTIN/email rules) so a
// submission that passes here is guaranteed to pass there too — the
// backend check is a defense-in-depth backstop, not a second opinion.
// validateGstin() itself (checksum, state code, PAN format) is the
// same shared helper Invoice Entry and Vendor Master already use
// (js/utils.js), not reimplemented here.
function getCustomerFormErrors() {
  const name  = document.getElementById('custName')?.value?.trim() || '';
  const gstin = document.getElementById('custGSTIN')?.value?.trim().toUpperCase() || '';
  const phone = document.getElementById('custPhone')?.value?.trim() || '';
  const email = document.getElementById('custEmail')?.value?.trim() || '';
  const state = document.getElementById('custState')?.value || '';

  const errors = {};
  if (!name) errors.name = 'Customer name is required.';
  if (!phone) errors.phone = 'Phone number is required.';
  else if (!/^\d{10}$/.test(phone)) errors.phone = 'Phone number must be exactly 10 digits.';
  if (!state) errors.state = 'State is required.';
  if (gstin && !validateGstin(gstin).valid) errors.gstin = 'Invalid GSTIN.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email address.';
  return errors;
}

// Re-run on every relevant field's input/change — writes each error
// message under its own field (never alert()) and keeps the Save
// button disabled until every required field is valid. Returns the
// error map so saveCustomer() can reuse the same result.
function validateCustomerForm() {
  const errors = getCustomerFormErrors();
  const showFieldError = (field, errId) => {
    const el = document.getElementById(errId);
    if (!el) return;
    if (errors[field]) { el.textContent = errors[field]; el.classList.remove('d-none'); }
    else { el.textContent = ''; el.classList.add('d-none'); }
  };
  showFieldError('name', 'custNameError');
  showFieldError('phone', 'custPhoneError');
  showFieldError('state', 'custStateError');
  showFieldError('gstin', 'custGSTINError');
  showFieldError('email', 'custEmailError');

  const btn = document.getElementById('custSaveBtn');
  if (btn) btn.disabled = Object.keys(errors).length > 0;

  return errors;
}

async function saveCustomer() {
  const user = await getCurrentUser();
  if (!user) return;

  // Re-validate (not just trust the disabled-button state) — the
  // button's disabled attribute is the UX guard, this is the real gate.
  const errors = validateCustomerForm();
  if (Object.keys(errors).length > 0) return;

  // District against its own State, for both addresses. Checked here as
  // well as on change because a district can be typed straight into the
  // field without the change handler ever firing.
  const billingOk = validateStateDistrict('custState', 'custDistrict', 'custDistrictError');
  const shipOk    = validateStateDistrict('custShipState', 'custShipDistrict', 'custShipDistrictError');
  if (!billingOk || !shipOk) {
    showToast('Select a district that belongs to the chosen state.', 'error');
    document.getElementById(billingOk ? 'custShipDistrict' : 'custDistrict')?.focus();
    return;
  }

  const name  = document.getElementById('custName')?.value?.trim();
  const gstin = document.getElementById('custGSTIN')?.value?.trim().toUpperCase();
  const phone = document.getElementById('custPhone')?.value?.trim();
  const email = document.getElementById('custEmail')?.value?.trim();
  const addr  = document.getElementById('custAddr')?.value?.trim();
  const state = document.getElementById('custState')?.value;

  const payload = { user_id: user.id, name, gstin, phone, email, address: addr, state,
    district:         document.getElementById('custDistrict')?.value?.trim() || '',
    shipping_district: document.getElementById('custShipDistrict')?.value?.trim() || '',
    // GST classification (Phase 2, Module 2). Every field optional; a
    // customer saved without touching them is Registered — Regular,
    // which is exactly what every existing customer already is.
    gst_category:     document.getElementById('custGstCategory')?.value || GST_CUSTOMER_CATEGORY_DEFAULT,
    pan:              document.getElementById('custPan')?.value?.trim().toUpperCase() || '',
    country:          document.getElementById('custCountry')?.value?.trim() || '',
    place_of_supply:  document.getElementById('custPos')?.value || '',
    shipping_state:   document.getElementById('custShipState')?.value || '',
    shipping_address: document.getElementById('custShipAddr')?.value?.trim() || '' };

  let error;
  if (custEditId) {
    ({ error } = await _supabase.from('customers').update(payload).eq('id', custEditId));
  } else {
    const dup = custAllData.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (dup) { showToast('Customer already exists!', 'warning'); return; }
    ({ error } = await _supabase.from('customers').insert(payload));
  }

  // The backend runs the exact same checks — this only fires if the
  // request reached the API some other way than this validated form.
  if (error) { handleApiError(error, 'Could not save the customer'); return; }
  showToast(custEditId ? 'Customer updated!' : 'Customer saved!');
  custEditId = null;
  resetCustomer();
  await loadCustomers(user.id);
}

function resetCustomer() {
  ['custName','custGSTIN','custPhone','custEmail','custAddr',
   'custPan','custCountry','custShipAddr','custDistrict','custShipDistrict'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const st = document.getElementById('custState'); if (st) st.value = '';
  ['custPos','custShipState'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  populateDistrictList('custDistrictList', '');
  populateDistrictList('custShipDistrictList', '');
  setCustGstCategory(GST_CUSTOMER_CATEGORY_DEFAULT);
  custEditId = null;
  const title = document.getElementById('custFormTitle');
  if (title) title.textContent = 'Add Customer';
  const btn = document.getElementById('custSaveBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> Save Customer';
  validateCustomerForm();
}

async function loadCustomers(userId) {
  const { data, error } = await _supabase.from('customers').select('*').eq('user_id', userId).order('name', { ascending: true });
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the customers'); return; }
  custAllData = (data || []);
  custPage = 1;
  renderCustTable(custAllData);
}

function renderCustTable(data) {
  const tbody = document.getElementById('custTableBody');
  if (!tbody) return;

  const start = (custPage - 1) * CUST_PAGE;
  const page  = data.slice(start, start + CUST_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-address-book" style="display:block;font-size:40px;margin-bottom:10px;"></i>No customers found. Add your first customer!</td></tr>';
    renderCustPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td><b>${r.name}</b></td>
      <td><span class="badge badge-green" style="font-family:monospace;font-size:11px;">${r.gstin || '&mdash;'}</span></td>
      <td>${r.phone || '&mdash;'}</td>
      <td>${r.email || '&mdash;'}</td>
      <td>${r.state || '&mdash;'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editCustomer('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCustomer('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
          <button class="btn btn-success btn-sm btn-icon" onclick="useInB2B('${r.id}')" title="Create Invoice for this Customer" style="background:#00796b;border-color:#00796b;"><i class="fas fa-file-invoice"></i></button>
        </div>
      </td>
    </tr>`).join('');

  renderCustPagination(data.length);
}

function renderCustPagination(total) {
  const c = document.getElementById('custPagination');
  if (!c) return;
  const pages = Math.ceil(total / CUST_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="custPage=${custPage-1};renderCustTable(custAllData)" ${custPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===custPage?'active':''}" onclick="custPage=${i};renderCustTable(custAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="custPage=${custPage+1};renderCustTable(custAllData)" ${custPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

function editCustomer(id) {
  const rec = custAllData.find(r => r.id === id);
  if (!rec) return;
  custEditId = id;
  document.getElementById('custName').value  = rec.name || '';
  document.getElementById('custGSTIN').value = rec.gstin || '';
  document.getElementById('custPhone').value = rec.phone || '';
  document.getElementById('custEmail').value = rec.email || '';
  document.getElementById('custAddr').value  = rec.address || '';
  document.getElementById('custState').value = rec.state || '';
  setCustGstCategory(rec.gst_category);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('custPan', rec.pan); set('custCountry', rec.country);
  set('custPos', rec.place_of_supply); set('custShipState', rec.shipping_state);
  set('custShipAddr', rec.shipping_address);
  // District after State, so the list is the right state's before the
  // value lands in it. A record saved before District existed simply has
  // none — the field stays blank and the record still saves.
  set('custDistrict', rec.district); set('custShipDistrict', rec.shipping_district);
  populateDistrictList('custDistrictList', rec.state || '');
  populateDistrictList('custShipDistrictList', rec.shipping_state || '');
  document.getElementById('custFormTitle').textContent = 'Edit Customer';
  document.getElementById('custSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Customer';
  document.getElementById('custName').scrollIntoView({ behavior: 'smooth', block: 'center' });
  // A legacy record saved before this validation existed (e.g. name
  // only, matching the exact bug this fixes) will correctly show as
  // invalid here — Save stays disabled until the missing required
  // fields are filled in, same as a brand new customer.
  validateCustomerForm();
}

async function deleteCustomer(id) {
  const ok = await showConfirm('Permanently delete this customer? This cannot be undone.');
  if (!ok) return;
  const { error } = await _supabase.from('customers').delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the customer'); return; }
  showToast('Customer permanently deleted.');
  custAllData = custAllData.filter(r => r.id !== id);
  renderCustTable(custAllData);
}

function useInB2B(id) {
  const rec = custAllData.find(r => r.id === id);
  if (!rec) return;
  sessionStorage.setItem('prefill_customer', JSON.stringify({
    name: rec.name, gstin: rec.gstin || '', phone: rec.phone || '', address: rec.address || '', state: rec.state || ''
  }));
  window.location.href = 'invoice.html';
}

function setupCustSearch() {
  document.getElementById('custSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? custAllData.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q) ||
      (r.phone || '').includes(q)
    ) : custAllData;
    custPage = 1;
    renderCustTable(filtered);
  });
}

// ── GST classification (Phase 2, Module 2) ──────────
// Which GSTR-1 table a supply to this customer is filed in. Populated
// from the one definition in js/utils.js so the customer master, the
// invoice form and the exporter cannot disagree about the categories.
function populateCustGstCategoryOptions() {
  const el = document.getElementById('custGstCategory');
  if (el) {
    el.innerHTML = GST_CUSTOMER_CATEGORIES.map(c =>
      `<option value="${escHtmlAttr(c.value)}">${escItemHtml(c.label)}</option>`).join('');
    el.value = GST_CUSTOMER_CATEGORY_DEFAULT;
  }
  // Both state pickers offer the same list the rest of the app uses.
  ['custPos', 'custShipState'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const keep = sel.querySelector('option')?.outerHTML || '';
    sel.innerHTML = keep + INDIAN_STATES.map(st =>
      `<option value="${escHtmlAttr(st)}">${escItemHtml(st)}</option>`).join('');
  });
  onCustGstCategoryChange();
}

function setCustGstCategory(value) {
  const el = document.getElementById('custGstCategory');
  if (el) el.value = gstCustomerCategory({ gst_category: value });
  onCustGstCategoryChange();
}

// Says which table this customer's supplies are filed in, and calls out
// the SEZ rule, which is the one that surprises people: a supply to an
// SEZ is inter-state even when the SEZ is down the road.
function onCustGstCategoryChange() {
  const note = document.getElementById('custGstCategoryNote');
  if (!note) return;
  const value = document.getElementById('custGstCategory')?.value || GST_CUSTOMER_CATEGORY_DEFAULT;
  const spec = gstCustomerCategorySpec(value);
  let text = `GSTR-1 table ${spec.table}`;
  if (!spec.registered) text += ' — no GSTIN required';
  if (gstIsSezCategory(value)) text += ' — supplies are inter-state and carry IGST';
  note.textContent = text;
  // Country only means anything for an overseas recipient.
  document.getElementById('custCountryGroup')?.classList.toggle('d-none', value !== 'export');
  // Indian states stop being selectable for an export recipient. The stored
  // State is NOT emptied here: Customer Master requires a State to save
  // (client getCustomerFormErrors() and server validateCustomerPayload()),
  // so clearing it would make an export customer impossible to save.
  syncExportStateDistrict(gstIsExportCategory(value),
    'custState', 'custDistrict', 'custDistrictList', 'custDistrictError', false);
}
