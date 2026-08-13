// =============================================
// Product Master — the catalogue is a synced mirror of the company
// website (js/product-sync.js is the writer for those fields), and the
// GST fields are this application's own.
//
// Sync rewrites name, hsn_code, unit, gst_percentage, type, price and
// stock on every run. That is right for a catalogue and wrong for GST:
// a unit corrected here used to survive only until the next sync, which
// is why products stayed without one long enough for the Portal to
// reject their invoice lines (RET191353). GST corrections are therefore
// written to products.gst_overrides, which sync does not touch, and
// everything reads a product through productEffective().
//
// Products can be created, edited and deleted here. A synced product's
// catalogue fields still belong to the website; its GST fields belong
// here.
// =============================================
let prodAllData = [];
let prodPage = 1;
const PROD_PAGE = 15;
let prodCurrentUserId = null;

async function initProducts() {
  const user = await requireAuth();
  if (!user) return;
  prodCurrentUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupProdSearch();
  await loadProducts(user.id);
  applyIncomingSearchQuery('prodSearch');
  renderSyncStatusBar();
  window.addEventListener('productSyncUpdated', async () => {
    await loadProducts(user.id);
    renderSyncStatusBar();
  });
}

// ── Sync status bar ────────────────────────────
function renderSyncStatusBar() {
  const meta = getProductSyncMeta();
  const dot = document.getElementById('syncDot');
  const lastTime = document.getElementById('syncLastTime');
  const statusText = document.getElementById('syncStatusText');
  const totalCount = document.getElementById('syncTotalCount');
  if (lastTime) {
    lastTime.textContent = formatRelativeTime(meta.lastSyncAt);
    lastTime.title = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('en-IN') : '';
  }
  if (totalCount) totalCount.textContent = prodAllData.filter(p => p.source === 'synced').length;

  const stale = isProductSyncStale(meta);
  const labels = {
    success: { text: (meta.message || 'Synced') + (stale ? ' — due for refresh' : ''), color: stale ? '#f57c00' : '#2e7d32' },
    error: { text: `Using cached products (${meta.message || 'sync failed'})`, color: '#f57c00' },
    not_configured: { text: 'Not Configured — add your Product API URL in Business Profile', color: '#9e9e9e' },
    never: { text: 'Never Synced', color: '#9e9e9e' }
  };
  const s = labels[meta.status] || labels.never;
  if (statusText) { statusText.textContent = s.text; }
  if (dot) dot.style.background = s.color;
}

async function runManualSync() {
  const btn = document.getElementById('syncNowBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...'; }
  const statusText = document.getElementById('syncStatusText');
  if (statusText) statusText.textContent = 'Syncing…';

  const result = await syncProducts(prodCurrentUserId);
  await loadProducts(prodCurrentUserId);
  renderSyncStatusBar();

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync"></i> Sync Now'; }
  if (result.ok) showToast(`Product sync complete — ${result.inserted} new, ${result.updated} updated.`, 'success');
  else if (result.reason === 'not_configured') showToast('Product Sync is not set up yet — add your Product API URL in Business Profile > Settings.', 'warning');
  else handleApiError(result.error || { message: result.reason || 'Product sync failed.', status: 500 }, 'Product sync failed');
}

async function loadProducts(userId) {
  const { data, error } = await _supabase.from('products').select('*').eq('user_id', userId).order('name', { ascending: true });
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the products'); return; }
  prodAllData = (data || []);
  prodPage = 1;
  renderProdTable(prodAllData);
}

function renderProdTable(data) {
  const tbody = document.getElementById('prodTableBody');
  if (!tbody) return;

  const start = (prodPage - 1) * PROD_PAGE;
  const page  = data.slice(start, start + PROD_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state"><i class="fas fa-box table-loading-icon"></i>No products yet. Run a product sync, or add one from an invoice via Quick Add.</td></tr>';
    renderProdPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td>
        ${r.image_url ? `<img src="${escProdHtml(r.image_url)}" alt="" style="width:24px;height:24px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;" onerror="this.style.display='none'">` : ''}
        <b>${escProdHtml(r.name)}</b>
      </td>
      <td>${escProdHtml(r.sku) || '&mdash;'}</td>
      <td>${escProdHtml(r.category) || '&mdash;'}</td>
      <td>${prodFieldCell(r, 'hsn_code')}</td>
      <td>${prodFieldCell(r, 'unit')}</td>
      <td class="text-center">${eff(r).gst_percentage}%</td>
      <td>${prodTreatmentCell(r)}</td>
      <td class="text-right">&#8377;${formatNum(r.default_rate)}</td>
      <td>${escProdHtml(r.warranty) || '&mdash;'}</td>
      <td>${r.source === 'synced'
        ? '<span class="badge badge-blue" title="Managed on the company website — updates automatically on sync"><i class="fas fa-sync"></i> Synced</span>'
        : '<span class="badge badge-orange" title="Created via Quick Add on an invoice — not on the website yet">Local Draft</span>'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openProductModal('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteProduct('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  renderProdPagination(data.length);
}

function escProdHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function renderProdPagination(total) {
  const c = document.getElementById('prodPagination');
  if (!c) return;
  const pages = Math.ceil(total / PROD_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="prodPage=${prodPage-1};renderProdTable(prodAllData)" ${prodPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===prodPage?'active':''}" onclick="prodPage=${i};renderProdTable(prodAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="prodPage=${prodPage+1};renderProdTable(prodAllData)" ${prodPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

// Only local-draft products (Quick Add) can be deleted from here —
// synced products are removed by removing them on the website, which
// the next sync reflects automatically.
// Safe delete.
//
// Three things have to be true before a product goes, and each of them
// has bitten somewhere before:
//
//   A product used on an invoice stays. invoice_items.product_id is
//   ON DELETE SET NULL, so deleting would not remove history — the line
//   keeps its own copy of the name, HSN, unit and figures — but it would
//   silently cut the link a return's product audit walks to check the
//   HSN and UQC. A filed period must stay explicable.
//
//   A synced product cannot be deleted here in any useful sense: the
//   next sync reinstates it from the website. Saying so beats appearing
//   to work and then undoing itself.
//
//   Anything else is confirmed, and the confirmation says what is going.
async function deleteProduct(id) {
  const rec = prodAllData.find(r => r.id === id);
  if (!rec) return;
  const user = await getCurrentUser();
  if (!user) return;

  if (rec.source === 'synced') {
    showToast('This product is managed on the company website — delete it there. Deleting it here would only last until the next sync.', 'error');
    return;
  }

  // This read IS the safety check. Reading a failure as an empty list
  // meant "not used on any invoice", which is exactly the answer that
  // lets the delete proceed — so a dropped request could remove a product
  // that a filed invoice's audit trail points at.
  const usedRead = await readAll([
    _supabase.from('invoice_items').select('id').eq('user_id', user.id).eq('product_id', id)
  ], 'Could not check whether this product is used on an invoice');
  if (!usedRead) return;
  const used = usedRead[0];
  if (used.length) {
    showToast(`Used on ${used.length} invoice line${used.length === 1 ? '' : 's'} — a product on a filed invoice cannot be deleted. Edit it instead.`, 'error');
    return;
  }

  const ok = await showYesNo(
    `Permanently delete "${rec.name}"?\n\nIt is not used on any invoice. This cannot be undone.`,
    'Delete Product');
  if (!ok) return;
  const { error } = await _supabase.from('products').delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the product'); return; }
  showToast('Product deleted.');
  prodAllData = prodAllData.filter(r => r.id !== id);
  applyProdFilters();
}

function setupProdSearch() {
  document.getElementById('prodSearch')?.addEventListener('input', () => applyProdFilters());
}

// Search and the GST-readiness filter narrow the same list in turn, so
// they combine rather than override — "goods with no unit" AND a search
// term is the query someone actually wants when fixing a catalogue.
function prodFilteredRows() {
  const q = (document.getElementById('prodSearch')?.value || '').toLowerCase();
  const gate = document.getElementById('prodGstFilter')?.value || '';
  let rows = prodAllData;
  if (q) rows = rows.filter(r =>
    (r.name || '').toLowerCase().includes(q) ||
    (eff(r).hsn_code || '').toLowerCase().includes(q) ||
    (r.sku || '').toLowerCase().includes(q) ||
    (r.category || '').toLowerCase().includes(q));
  if (gate === 'issues')   rows = rows.filter(r => Object.keys(validateProductGst(r)).length > 0);
  if (gate === 'nounit')   rows = rows.filter(r => eff(r).type !== 'service' && !String(eff(r).unit || '').trim());
  if (gate === 'nohsn')    rows = rows.filter(r => !String(eff(r).hsn_code || '').trim());
  if (gate === 'override') rows = rows.filter(r => productOverriddenFields(r).length > 0);
  return rows;
}

function applyProdFilters() {
  prodPage = 1;
  renderProdTable(prodFilteredRows());
}

// Exposed for other pages (B2B/B2C invoice entry auto-fill, HSN
// display, Excel import auto-classification)
async function loadProductsList(userId) {
  // null on failure, never an empty array. Callers use this list to decide
  // whether a typed product name already exists — an empty list answers
  // "no such product" to every name, which is what prompts Quick Add to
  // offer creating one that is already in the master.
  const rows = await readAll([
    _supabase.from('products').select('*').eq('user_id', userId)
  ], 'Could not load the product list');
  return rows ? rows[0] : null;
}

function findProductByName(list, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return list.find(p => p.name.toLowerCase() === n) || null;
}

// ── Product Master completion (Phase 2, Module 3A) ──────────
// Create, edit, delete, and the GST fields a return depends on.

// Every read of a product for GST purposes goes through the effective
// view, so a correction stored in gst_overrides wins over the synced
// value everywhere at once.
function eff(product) { return productEffective(product); }

let prodEditId = null;

// A corrected field is marked, so it is never a mystery why a product
// differs from the website.
function prodFieldCell(r, field) {
  const value = eff(r)[field];
  const corrected = productOverriddenFields(r).includes(field);
  const text = escProdHtml(value) || '<span class="text-danger">not set</span>';
  return corrected
    ? `<span title="Corrected here — a sync will not overwrite it">${text} <i class="fas fa-pen fs-11 text-primary-dark"></i></span>`
    : text;
}

function prodTreatmentCell(r) {
  const issues = Object.keys(validateProductGst(r)).length;
  const t = gstTreatmentOf(r);
  const badge = t === 'taxable'
    ? '<span class="badge badge-green">Taxable</span>'
    : `<span class="badge badge-orange">${escProdHtml(gstTreatmentLabel(t))}</span>`;
  return issues
    ? `${badge} <span class="badge badge-red" title="This product cannot be reported as it stands">${issues} issue${issues === 1 ? '' : 's'}</span>`
    : badge;
}

// ── Add / Edit ──────────────────────────────────────
function openProductModal(id) {
  prodEditId = id || null;
  const r = id ? prodAllData.find(x => x.id === id) : null;
  const e = r ? eff(r) : {};

  populateProdSelects();
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = v ?? ''; };
  set('prodName', r?.name);
  set('prodType', e.type || 'goods');
  set('prodHsn', e.hsn_code);
  set('prodUnit', e.unit || '');
  // The API returns DECIMAL columns as strings ("18.00"), which would
  // match no option and silently leave the select empty — reading back
  // as 0%. Normalised to the number the options are built from.
  set('prodGstRate', String(+(e.gst_percentage ?? getDefaultGstPct())));
  set('prodTreatment', gstTreatmentOf(r));
  set('prodCess', +(r?.cess_rate ?? 0));
  set('prodBundle', gstSupplyBundle(r));
  set('prodPrincipalRate', r?.principal_gst_rate == null ? '' : +r.principal_gst_rate);
  set('prodRate', +(r?.default_rate ?? 0));
  set('prodSku', r?.sku);
  set('prodCategory', r?.category);
  set('prodDescription', r?.description);
  const rc = document.getElementById('prodReverseCharge');
  if (rc) rc.checked = !!r?.reverse_charge;

  document.getElementById('prodModalTitle').textContent = r ? 'Edit Product' : 'New Product';
  // The catalogue fields belong to the website for a synced product.
  const synced = r?.source === 'synced';
  document.getElementById('prodSyncedNote')?.classList.toggle('d-none', !synced);
  document.getElementById('prodCatalogueNote').textContent = synced
    ? '(managed on the website — changes here are overwritten on the next sync)' : '';
  ['prodRate', 'prodSku', 'prodCategory', 'prodDescription', 'prodName'].forEach(f => {
    const n = document.getElementById(f); if (n) n.readOnly = synced;
  });

  const corrected = r ? productOverriddenFields(r) : [];
  document.getElementById('prodOverrideNote').innerHTML = corrected.length
    ? `<i class="fas fa-pen"></i> Corrected here and protected from sync: <b>${escProdHtml(corrected.join(', '))}</b>.`
    : '';

  onProdTypeChange();
  onProdTreatmentChange();
  onProdBundleChange();
  document.getElementById('productModal')?.classList.add('open');
  lockBodyScroll();
}

function closeProductModal() {
  document.getElementById('productModal')?.classList.remove('open');
  prodEditId = null;
  unlockBodyScrollIfNoModalsOpen();
}

function populateProdSelects() {
  const unit = document.getElementById('prodUnit');
  if (unit) unit.innerHTML = '<option value="">Not set</option>' +
    GST_UQC_MASTER.map(u => `<option value="${escHtmlAttr(u.code)}">${escItemHtml(u.code)} — ${escItemHtml(u.label)}</option>`).join('');
  const rate = document.getElementById('prodGstRate');
  if (rate) rate.innerHTML = GST_RATE_SLABS.map(v => `<option value="${v}">${v}%</option>`).join('');
  const treat = document.getElementById('prodTreatment');
  if (treat) treat.innerHTML = GST_TREATMENTS.map(t =>
    `<option value="${escHtmlAttr(t.value)}">${escItemHtml(t.label)}</option>`).join('');
  const bundle = document.getElementById('prodBundle');
  if (bundle) bundle.innerHTML = GST_SUPPLY_BUNDLES.map(b =>
    `<option value="${escHtmlAttr(b.value)}">${escItemHtml(b.label)}</option>`).join('');
  const bulk = document.getElementById('bulkUnitValue');
  if (bulk) bulk.innerHTML = GST_UQC_MASTER.map(u =>
    `<option value="${escHtmlAttr(u.code)}"${u.code === 'NOS' ? ' selected' : ''}>${escItemHtml(u.code)} — ${escItemHtml(u.label)}</option>`).join('');
}

// Services are coded with a SAC and carry no unit — the Portal's UQC for
// a service is NA, which the exporter supplies. Saying so here stops
// someone hunting for a unit that should not exist.
function onProdTypeChange() {
  const service = document.getElementById('prodType')?.value === 'service';
  const label = document.getElementById('prodHsnLabel');
  if (label) label.textContent = service ? 'SAC Code' : 'HSN Code';
  const unit = document.getElementById('prodUnit');
  if (unit) unit.disabled = service;
  document.getElementById('prodUnitReq')?.classList.toggle('d-none', service);
  validateProductForm();
}

function onProdTreatmentChange() {
  const v = document.getElementById('prodTreatment')?.value || 'taxable';
  const note = document.getElementById('prodTreatmentNote');
  if (note) note.textContent = gstTreatmentSpec(v).note;
  // A supply that is not taxable cannot carry a rate.
  if (!gstIsTaxableTreatment(v)) {
    const rate = document.getElementById('prodGstRate');
    if (rate) rate.value = '0';
  }
  validateProductForm();
}

function onProdBundleChange() {
  const v = document.getElementById('prodBundle')?.value || 'none';
  const spec = GST_SUPPLY_BUNDLES.find(b => b.value === v);
  const note = document.getElementById('prodBundleNote');
  if (note) note.textContent = spec ? spec.note : '';
  // The principal rate only means anything for a composite supply.
  document.getElementById('prodPrincipalGroup')?.classList.toggle('d-none', v !== 'composite');
  validateProductForm();
}

// Reads the form into the shape validateProductGst() checks, so the
// screen and the GSTR-1 export apply one rule rather than two.
function productFormValues() {
  const val = id => document.getElementById(id)?.value ?? '';
  return {
    name: val('prodName').trim(),
    type: val('prodType') || 'goods',
    hsn_code: val('prodHsn').trim(),
    unit: val('prodUnit'),
    gst_percentage: +val('prodGstRate') || 0,
    gst_treatment: val('prodTreatment') || 'taxable',
    cess_rate: +val('prodCess') || 0,
    supply_bundle: val('prodBundle') || 'none',
    principal_gst_rate: val('prodPrincipalRate') === '' ? null : +val('prodPrincipalRate'),
    reverse_charge: !!document.getElementById('prodReverseCharge')?.checked,
    default_rate: +val('prodRate') || 0,
    sku: val('prodSku').trim(),
    category: val('prodCategory').trim(),
    description: val('prodDescription').trim()
  };
}

function validateProductForm() {
  const errors = validateProductGst(productFormValues());
  const show = (field, elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (errors[field]) { el.textContent = errors[field]; el.classList.add('show'); }
    else { el.textContent = ''; el.classList.remove('show'); }
  };
  show('name', 'prodNameError');
  show('hsn_code', 'prodHsnError');
  show('unit', 'prodUnitError');
  show('gst_percentage', 'prodGstRateError');
  show('cess_rate', 'prodCessError');
  show('principal_gst_rate', 'prodPrincipalRateError');
  const btn = document.getElementById('prodSaveBtn');
  if (btn) btn.disabled = Object.keys(errors).length > 0;
  return errors;
}

async function saveProduct() {
  const user = await getCurrentUser();
  if (!user) return;
  const errors = validateProductForm();
  if (Object.keys(errors).length) { showToast('Fix the highlighted fields first.', 'error'); return; }

  const v = productFormValues();
  const existing = prodEditId ? prodAllData.find(x => x.id === prodEditId) : null;
  const synced = existing?.source === 'synced';

  // The four fields sync rewrites are stored as corrections so they
  // survive it. Everything else is an ordinary column.
  const overrides = { ...(existing?.gst_overrides || {}) };
  PRODUCT_GST_OVERRIDABLE.forEach(f => { overrides[f] = v[f]; });

  const payload = {
    user_id: user.id,
    gst_treatment: v.gst_treatment, cess_rate: v.cess_rate, reverse_charge: v.reverse_charge,
    supply_bundle: v.supply_bundle, principal_gst_rate: v.principal_gst_rate,
    gst_overrides: overrides
  };
  // A synced product's catalogue belongs to the website; a local one's
  // belongs here.
  if (!synced) {
    Object.assign(payload, {
      name: v.name, type: v.type, hsn_code: v.hsn_code, unit: v.unit,
      gst_percentage: v.gst_percentage, default_rate: v.default_rate,
      sku: v.sku, category: v.category, description: v.description
    });
  }

  let error;
  if (prodEditId) ({ error } = await _supabase.from('products').update(payload).eq('id', prodEditId));
  else ({ error } = await _supabase.from('products').insert({ ...payload, source: 'local' }));

  if (error) { handleApiError(error, 'Could not save the product'); return; }
  showToast(prodEditId ? 'Product updated.' : 'Product added.', 'success');
  closeProductModal();
  await loadProducts(user.id);
  applyProdFilters();
}

// ── Bulk unit ───────────────────────────────────────
// 3,380 goods had no unit when this was written. Fixing that one product
// at a time is not a plan, so the unit can be set across everything the
// current filter has narrowed the list to.
function openBulkUnitModal() {
  populateProdSelects();
  const ow = document.getElementById('bulkUnitOverwrite');
  if (ow) ow.checked = false;
  updateBulkUnitCount();
  document.getElementById('bulkUnitValue').onchange = updateBulkUnitCount;
  if (ow) ow.onchange = updateBulkUnitCount;
  document.getElementById('bulkUnitModal')?.classList.add('open');
  lockBodyScroll();
}

function closeBulkUnitModal() {
  document.getElementById('bulkUnitModal')?.classList.remove('open');
  unlockBodyScrollIfNoModalsOpen();
}

function bulkUnitTargets() {
  const overwrite = !!document.getElementById('bulkUnitOverwrite')?.checked;
  return prodFilteredRows().filter(r => {
    const e = eff(r);
    if (e.type === 'service') return false;              // services carry NA
    return overwrite || !String(e.unit || '').trim();
  });
}

function updateBulkUnitCount() {
  const el = document.getElementById('bulkUnitCount');
  if (el) el.textContent = bulkUnitTargets().length;
}

async function applyBulkUnit() {
  const user = await getCurrentUser();
  if (!user) return;
  const unit = document.getElementById('bulkUnitValue')?.value || '';
  const targets = bulkUnitTargets();
  if (!unit || !targets.length) { showToast('Nothing to change.', 'error'); return; }

  const ok = await showYesNo(
    `Set the unit to "${unit}" on ${targets.length} product${targets.length === 1 ? '' : 's'}.\n\n` +
    'This is stored as a GST correction, so the next product sync will not overwrite it. ' +
    'No price, name or stock is touched.\n\nContinue?', 'Set Unit in Bulk');
  if (!ok) return;

  const btn = document.getElementById('bulkUnitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying...'; }
  let done = 0, failed = 0;
  for (const r of targets) {
    const overrides = { ...(r.gst_overrides || {}), unit };
    const { error } = await _supabase.from('products').update({ gst_overrides: overrides }).eq('id', r.id);
    if (error) failed++; else done++;
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Apply'; }
  showToast(`${done} product${done === 1 ? '' : 's'} updated${failed ? `, ${failed} failed` : ''}.`,
    failed ? 'error' : 'success');
  closeBulkUnitModal();
  await loadProducts(user.id);
  applyProdFilters();
}
