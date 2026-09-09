// Purchase Order entry.
//
// The item grid is the SAME component New Purchase uses - purchase-items.js
// renders itself into #purchItemsSection, reads the supply type from
// #purchSupply and computes the rollups. Nothing about pricing or tax is
// written here; a purchase order is priced exactly as a purchase is.
//
// What this page adds is the order's own head: who it goes to, when the
// goods are expected, how they travel, on what terms, and where they are to
// be delivered.
let poEditId = null;
let poVendors = [];
let poUser = null;
let poStatus = 'DRAFT';

const PO_STATUS_LABEL = {
  DRAFT: ['Draft', 'badge-secondary'],
  SENT: ['Sent', 'badge-info'],
  CONFIRMED: ['Confirmed', 'badge-green'],
  PARTIALLY_RECEIVED: ['Partially received', 'badge-warning'],
  FULLY_RECEIVED: ['Fully received', 'badge-success'],
  CANCELLED: ['Cancelled', 'badge-danger'],
  CLOSED: ['Closed', 'badge-secondary']
};

async function initPurchaseOrderEntry() {
  poUser = await requireAuth();
  if (!poUser) return;
  initNavUser(poUser);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(poUser.id);

  populatePoStates('poVendorState');
  populatePoStates('poDeliveryState');
  await initPurchaseItems(poUser.id, 'purchase');
  await loadPoVendors();

  poSet('poDate', toISO(new Date()));
  // The company's saved terms are a starting point, not a rule - every
  // order can say something different, and what is saved is what prints.
  const profileTerms = (typeof businessProfile === 'object' && businessProfile)
    ? (businessProfile.terms_conditions || '') : '';
  poSet('poTerms', profileTerms);
  onPoDeliverSameChange();

  const id = new URLSearchParams(window.location.search).get('id');
  if (id) await loadPurchaseOrderForEdit(id);
}

// ── small helpers ─────────────────────────────────────────────────────
function poText(id) { return document.getElementById(id)?.value?.trim() || ''; }
function poSet(id, v) { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; }

function populatePoStates(selectId) {
  const el = document.getElementById(selectId);
  if (!el || typeof INDIAN_STATES === 'undefined') return;
  el.innerHTML = '<option value="">Select state</option>'
    + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

function renderPoStatus(status) {
  poStatus = status || 'DRAFT';
  const [label, cls] = PO_STATUS_LABEL[poStatus] || [poStatus, 'badge-secondary'];
  const el = document.getElementById('poStatusBadge');
  if (el) { el.textContent = label; el.className = 'badge ' + cls + ' ml-auto'; }
  // An order that has already been cancelled is history, not a draft.
  const confirmBtn = document.getElementById('poConfirmBtn');
  if (confirmBtn) confirmBtn.style.display = (poStatus === 'DRAFT' || poStatus === 'SENT') ? '' : 'none';
  const saveBtn = document.getElementById('poSaveBtn');
  if (saveBtn) saveBtn.disabled = (poStatus === 'CANCELLED');
}

// ── vendor ────────────────────────────────────────────────────────────
async function loadPoVendors() {
  try {
    poVendors = await apiFetch('/vendors?select=id,name,gstin,phone,address,state,district,gst_category'
      + '&order=name.asc&limit=1000');
  } catch (err) {
    handleApiError(err, 'loading vendors');
    poVendors = [];
  }
  const list = document.getElementById('poVendorList');
  if (list) list.innerHTML = poVendors.map(v => `<option value="${escPo(v.name)}"></option>`).join('');
}

function onPoVendorInput() {
  const name = poText('poVendor');
  const v = poVendors.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  if (!v) return;
  poSet('poVendorGstin', v.gstin || '');
  poSet('poVendorPhone', v.phone || '');
  poSet('poVendorAddress', v.address || '');
  poSet('poVendorState', v.state || '');
  populateDistrictList('poDistrictList', v.state || '');
  poSet('poVendorDistrict', v.district || '');
  onPoStateChange();
}
function poSelectedVendor() {
  const name = poText('poVendor');
  return poVendors.find(x => (x.name || '').toLowerCase() === name.toLowerCase()) || null;
}

// Interstate or not, decided the same way the purchase form decides it:
// the vendor's state against our own. The grid reads #purchSupply.
function onPoStateChange() {
  populateDistrictList('poDistrictList', document.getElementById('poVendorState')?.value || '');
  const ours = (typeof businessProfile === 'object' && businessProfile && businessProfile.state) || '';
  const theirs = document.getElementById('poVendorState')?.value || '';
  const interstate = ours && theirs && ours !== theirs;
  const hidden = document.getElementById('purchSupply');
  if (hidden) hidden.value = interstate ? 'interstate' : 'intrastate';
  const badge = document.getElementById('poSupplyBadge');
  if (badge) {
    badge.textContent = interstate ? 'Interstate' : 'Intrastate';
    badge.className = 'badge ' + (interstate ? 'badge-warning' : 'badge-green');
  }
  if (typeof renderPurchItemsTable === 'function') renderPurchItemsTable();
}
function onPoGstinChange() { /* GSTIN is informational on an order */ }

// ── delivery ──────────────────────────────────────────────────────────
function onPoDeliverSameChange() {
  const same = document.getElementById('poDeliverSame')?.checked;
  ['poDeliveryState', 'poDeliveryDistrict', 'poDeliveryAddress'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !!same;
  });
  if (same && typeof businessProfile === 'object' && businessProfile) {
    poSet('poDeliveryState', businessProfile.state || '');
    populateDistrictList('poDeliveryDistrictList', businessProfile.state || '');
    poSet('poDeliveryDistrict', businessProfile.district || '');
    poSet('poDeliveryAddress', businessProfile.address || '');
  }
}
function onPoDeliveryStateChange() {
  populateDistrictList('poDeliveryDistrictList', document.getElementById('poDeliveryState')?.value || '');
}

// ── save ──────────────────────────────────────────────────────────────
function collectPurchaseOrder() {
  const vendor = poSelectedVendor();
  const rollups = computePurchRollups();
  return {
    // Absent rather than blank when it has never been numbered: the server
    // issues one. On an edit the field always holds the current number.
    ...(poText('poNumber') || poEditId ? { document_number: poText('poNumber') } : {}),
    document_date: poText('poDate'),
    expected_delivery_date: poText('poExpected') || null,
    purchase_representative: poText('poRep') || null,
    logistics_mode: document.getElementById('poLogistics')?.value || null,
    payment_terms: poText('poPaymentTerms') || null,
    vendor_id: vendor ? vendor.id : null,
    vendor_name: poText('poVendor'),
    vendor_gstin: poText('poVendorGstin') || null,
    phone: poText('poVendorPhone') || null,
    address: poText('poVendorAddress') || null,
    state: document.getElementById('poVendorState')?.value || null,
    district: poText('poVendorDistrict') || null,
    gst_category: vendor && vendor.gst_category ? vendor.gst_category : 'regular',
    delivery_address: poText('poDeliveryAddress') || null,
    delivery_state: document.getElementById('poDeliveryState')?.value || null,
    delivery_district: poText('poDeliveryDistrict') || null,
    supply_type: document.getElementById('purchSupply')?.value || 'intrastate',
    taxable_amount: rollups.taxable_amount,
    gst_percentage: rollups.gst_percentage,
    gst_amount: rollups.gst_amount,
    igst: rollups.igst, cgst: rollups.cgst, sgst: rollups.sgst,
    total_amount: rollups.total_amount,
    terms: poText('poTerms') || null
  };
}

// Line rows carry their own id on an edit, which is what lets the server
// update them in place and keep the received quantity against each.
function collectPurchaseOrderItems() {
  return purchItems
    .filter(r => r.product_name && r.quantity > 0)
    .map(r => ({
      ...(r.po_item_id ? { id: r.po_item_id } : {}),
      product_id: r.product_id, product_name: r.product_name, hsn_code: r.hsn_code, unit: r.unit,
      quantity: r.quantity, rate: r.rate, discount_percentage: r.discount_percentage,
      gst_percentage: r.gst_percentage, taxable_value: r.taxable_value, gst_amount: r.gst_amount,
      igst: r.igst, cgst: r.cgst, sgst: r.sgst, total_amount: r.total_amount
    }));
}

async function savePurchaseOrder(silent) {
  if (!poText('poVendor')) { showToast('Pick a vendor for this order.', 'error'); return false; }
  if (!poText('poDate')) { showToast('A purchase order date is required.', 'error'); return false; }
  if (poEditId && !poText('poNumber')) {
    showToast('A purchase order number is required.', 'error'); return false;
  }
  if (!validatePurchaseItems()) return false;

  const btn = document.getElementById('poSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('/purchase-orders/save', {
      method: 'POST',
      body: JSON.stringify({
        editId: poEditId || undefined,
        order: collectPurchaseOrder(),
        items: collectPurchaseOrderItems()
      })
    });
    poEditId = res.id;
    poSet('poNumber', res.order.document_number);
    renderPoStatus(res.order.status);
    // Re-key the grid rows to the saved lines, so the next save updates
    // them rather than replacing them.
    applyPoItemIds(res.items);
    if (!silent) showToast('Purchase order saved.', 'success');
    return res.id;
  } catch (err) {
    handleApiError(err, 'Could not save the purchase order');
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Matches saved lines back onto the grid rows by position, which is the
// order both sides use.
function applyPoItemIds(savedItems) {
  const rows = purchItems.filter(r => r.product_name && r.quantity > 0);
  savedItems.forEach((s, i) => { if (rows[i]) rows[i].po_item_id = s.id; });
}

async function confirmPurchaseOrder() {
  const id = poEditId || await savePurchaseOrder(true);
  if (!id) return;
  try {
    const res = await apiFetch(`/purchase-orders/${id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'CONFIRMED' })
    });
    renderPoStatus(res.status);
    showToast('Purchase order confirmed. It can now receive goods.', 'success');
  } catch (err) {
    handleApiError(err, 'Could not confirm the purchase order');
  }
}

// ── edit ──────────────────────────────────────────────────────────────
async function loadPurchaseOrderForEdit(id) {
  let data;
  try {
    data = await apiFetch('/purchase-orders/' + encodeURIComponent(id));
  } catch (err) {
    handleApiError(err, 'loading the purchase order');
    return;
  }
  const o = data.order;
  poEditId = o.id;

  poSet('poNumber', o.document_number);
  poSet('poDate', String(o.document_date || '').slice(0, 10));
  poSet('poExpected', String(o.expected_delivery_date || '').slice(0, 10));
  poSet('poRep', o.purchase_representative);
  poSet('poPaymentTerms', o.payment_terms);
  poSet('poTerms', o.terms);
  const log = document.getElementById('poLogistics');
  if (log) log.value = o.logistics_mode || '';

  poSet('poVendor', o.vendor_name);
  poSet('poVendorGstin', o.vendor_gstin);
  poSet('poVendorPhone', o.phone);
  poSet('poVendorAddress', o.address);
  poSet('poVendorState', o.state);
  populateDistrictList('poDistrictList', o.state || '');
  poSet('poVendorDistrict', o.district);

  const same = document.getElementById('poDeliverSame');
  if (same) same.checked = false;
  onPoDeliverSameChange();
  poSet('poDeliveryState', o.delivery_state);
  populateDistrictList('poDeliveryDistrictList', o.delivery_state || '');
  poSet('poDeliveryDistrict', o.delivery_district);
  poSet('poDeliveryAddress', o.delivery_address);

  const hidden = document.getElementById('purchSupply');
  if (hidden) hidden.value = o.supply_type || 'intrastate';
  onPoStateChange();

  loadPurchItemsIntoTable(data.items);
  // Keep each grid row pointed at the line it came from.
  purchItems.forEach((r, i) => { if (data.items[i]) r.po_item_id = data.items[i].id; });

  renderPoStatus(o.status);
  const title = document.querySelector('.page-title');
  if (title) title.innerHTML = '<i class="fas fa-file-signature"></i>Purchase Order ' + escPo(o.document_number);
}

// ── PDF / print ───────────────────────────────────────────────────────
async function poCurrentRecord() {
  if (!poEditId) {
    const id = await savePurchaseOrder(true);
    if (!id) return null;
  }
  // Always printed from what is STORED, never from the form, so the paper
  // and the database cannot disagree.
  return apiFetch('/purchase-orders/' + encodeURIComponent(poEditId));
}
async function downloadPurchaseOrderPDF() {
  const rec = await poCurrentRecord();
  if (rec) generatePurchaseOrderPDF(rec.order, rec.items, 'save');
}
async function printPurchaseOrder() {
  const rec = await poCurrentRecord();
  if (rec) generatePurchaseOrderPDF(rec.order, rec.items, 'print');
}

function escPo(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', initPurchaseOrderEntry);
