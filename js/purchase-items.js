// =============================================
// Purchase Line Items — Product Master driven.
// A close structural copy of js/invoice-items.js (same product
// autocomplete, GST calc, row add/remove, Quick Add Product modal),
// parameterized by `kind` ('purchase' | 'return') so BOTH Purchase
// Entry and Purchase Returns reuse this one module — the direction of
// stock adjustment is decided server-side by which kind the backend
// endpoint receives (server/routes/purchases.js's KIND_CONFIG), not by
// anything in this file.
// =============================================

let purchItems = [];
let purchProductsList = [];
let purchKind = null;         // 'purchase' | 'return'
let purchUserId = null;
let purchRowSeq = 0;
let purchQuickAddTargetRowId = null;

// ── Init ──────────────────────────────────────────
async function initPurchaseItems(userId, kind) {
  purchUserId = userId;
  purchKind = kind;
  purchProductsList = await loadProductsList(userId);
  renderPurchItemsSectionShell('purchItemsSection');
  ensurePurchQuickAddProductModal();
  populatePurchProductDatalist();
  if (!purchItems.length) addPurchItemRow();
}

function getPurchSupplyType() {
  return document.getElementById('purchSupply')?.value || 'intrastate';
}

// ── Shell markup ──────────────────────────────────
function renderPurchItemsSectionShell(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="section-title mb-14">Products</div>
    <div class="table-wrapper mb-16">
      <table class="data-table" id="purchItemsTable">
        <thead>
          <tr>
            <th class="min-w-280">Product <span class="text-required">*</span></th>
            <th style="min-width:90px;">HSN</th>
            <th style="min-width:80px;">Unit</th>
            <th class="text-center" style="min-width:85px;">Qty</th>
            <th class="text-right" style="min-width:100px;">Rate (&#8377;)</th>
            <th class="text-center" style="min-width:90px;">Discount %</th>
            <th class="text-center" style="min-width:85px;">GST %</th>
            <th class="text-right" style="min-width:110px;">Taxable Value</th>
            <th class="text-right" style="min-width:110px;">Total</th>
            <th style="min-width:44px;"></th>
          </tr>
        </thead>
        <tbody id="purchItemsTableBody"></tbody>
      </table>
    </div>
    <button type="button" class="btn btn-secondary btn-sm mb-20" onclick="addPurchItemRow()"><i class="fas fa-plus"></i> Add Row</button>

    <div class="calc-box mb-20">
      <div class="calc-row">
        <span class="label">Subtotal (Taxable Value)</span>
        <span class="value"><input type="text" id="purchItemsSubtotal" class="form-control calc-input-sm" readonly aria-label="Subtotal"></span>
      </div>
      <div class="calc-row">
        <span class="label">GST Amount</span>
        <div class="calc-tax-row">
          <span class="text-muted-sm">IGST: <b id="purchItemsIGST">0.00</b></span>
          <span class="text-muted-sm">CGST: <b id="purchItemsCGST">0.00</b></span>
          <span class="text-muted-sm">SGST: <b id="purchItemsSGST">0.00</b></span>
        </div>
        <span class="value"><input type="text" id="purchItemsGstAmt" class="form-control calc-input-sm" readonly aria-label="GST Amount"></span>
      </div>
      <div class="calc-row">
        <span class="label">Round Off</span>
        <span class="value"><input type="text" id="purchItemsRoundOff" class="form-control calc-input-sm" readonly aria-label="Round Off"></span>
      </div>
      <div class="calc-row total">
        <span class="label">Grand Total</span>
        <span class="value"><input type="text" id="purchItemsGrandTotal" class="form-control calc-input-total" readonly aria-label="Grand Total"></span>
      </div>
      <div class="calc-row">
        <span class="label">Amount in Words</span>
        <span class="value fs-12 text-muted-sm text-right" id="purchItemsAmountWords"></span>
      </div>
    </div>

    <datalist id="purchItemsProductDatalist"></datalist>
  `;
  document.getElementById('purchSupply')?.addEventListener('change', recalcAllPurchRows);
}

function populatePurchProductDatalist() {
  const dl = document.getElementById('purchItemsProductDatalist');
  if (dl) dl.innerHTML = purchProductsList.map(p => `<option value="${escItemHtml(p.name)}"></option>`).join('');
}

// ── Row lifecycle ─────────────────────────────────
function purchBlankRow() {
  purchRowSeq++;
  return {
    rowId: 'prow' + purchRowSeq, product_id: null, product_name: '', hsn_code: '', unit: '',
    quantity: 1, rate: 0, discount_percentage: 0, gst_percentage: 0,
    taxable_value: 0, gst_amount: 0, igst: 0, cgst: 0, sgst: 0, total_amount: 0, locked: false
  };
}

function addPurchItemRow() {
  purchItems.push(purchBlankRow());
  renderPurchItemsTable();
}

function removePurchItemRow(rowId) {
  purchItems = purchItems.filter(r => r.rowId !== rowId);
  if (!purchItems.length) purchItems.push(purchBlankRow());
  renderPurchItemsTable();
  computePurchRollups();
}

function resetPurchaseItems() {
  purchItems = [purchBlankRow()];
  renderPurchItemsTable();
  computePurchRollups();
}

function loadPurchItemsIntoTable(rows) {
  purchItems = rows.map(r => {
    purchRowSeq++;
    return {
      rowId: 'prow' + purchRowSeq, product_id: r.product_id || null, product_name: r.product_name || '',
      hsn_code: r.hsn_code || '', unit: r.unit || '', quantity: +r.quantity || 1, rate: +r.rate || 0,
      discount_percentage: +r.discount_percentage || 0, gst_percentage: +r.gst_percentage || 0,
      taxable_value: +r.taxable_value || 0, gst_amount: +r.gst_amount || 0, igst: +r.igst || 0,
      cgst: +r.cgst || 0, sgst: +r.sgst || 0, total_amount: +r.total_amount || 0,
      locked: !!(r.product_id || (r.hsn_code && findProductByName(purchProductsList, r.product_name)))
    };
  });
  if (!purchItems.length) purchItems.push(purchBlankRow());
  renderPurchItemsTable();
  computePurchRollups();
}

// ── Render ────────────────────────────────────────
function renderPurchItemsTable() {
  const tbody = document.getElementById('purchItemsTableBody');
  if (!tbody) return;
  tbody.innerHTML = purchItems.map(row => `
    <tr data-row="${row.rowId}">
      <td>
        <input type="text" class="form-control" autocomplete="off"
          value="${escItemHtml(row.product_name)}"
          oninput="onPurchProductInput('${row.rowId}', this.value); showPurchProductDropdown('${row.rowId}', this, this.value)"
          onfocus="showPurchProductDropdown('${row.rowId}', this, this.value)"
          onblur="onPurchProductBlur('${row.rowId}', this.value)"
          onkeydown="onPurchProductKeydown(event, '${row.rowId}')">
      </td>
      <td><input type="text" class="form-control" value="${escItemHtml(row.hsn_code)}" ${row.locked ? 'readonly' : ''}
          onchange="onPurchFieldChange('${row.rowId}','hsn_code',this.value)"></td>
      <td><input type="text" class="form-control" value="${escItemHtml(row.unit)}" ${row.locked ? 'readonly' : ''}
          onchange="onPurchFieldChange('${row.rowId}','unit',this.value)"></td>
      <td><input type="number" class="form-control text-center" min="0.001" step="0.001" value="${row.quantity}"
          oninput="onPurchFieldChange('${row.rowId}','quantity',this.value)"></td>
      <td><input type="number" class="form-control text-right" min="0" step="0.01" value="${row.rate}"
          oninput="onPurchFieldChange('${row.rowId}','rate',this.value)"></td>
      <td><input type="number" class="form-control text-center" min="0" max="100" step="0.01" value="${row.discount_percentage}"
          oninput="onPurchFieldChange('${row.rowId}','discount_percentage',this.value)"></td>
      <td><input type="number" class="form-control text-center" min="0" max="100" step="0.01" value="${row.gst_percentage}"
          oninput="onPurchFieldChange('${row.rowId}','gst_percentage',this.value)"
          onblur="onPurchGstBlur('${row.rowId}', this)"
          title="Auto-filled from Product Master — editable for this line only"></td>
      <td class="text-right fw-600 purch-taxable-cell">&#8377;${formatNum(row.taxable_value)}</td>
      <td class="text-right fw-700 purch-total-cell">&#8377;${formatNum(row.total_amount)}</td>
      <td><button type="button" class="btn btn-danger btn-sm btn-icon" onclick="removePurchItemRow('${row.rowId}')" title="Remove row"><i class="fas fa-trash"></i></button></td>
    </tr>`).join('');
}

// ── Product autocomplete / autofill / lock ─────────
let purchJustSelectedFromDropdown = null;

function onPurchProductInput(rowId, name) {
  const row = purchItems.find(r => r.rowId === rowId);
  if (!row) return;
  row.product_name = name;
  const match = findProductByName(purchProductsList, name);
  if (match) { applyProductToPurchRow(row, match); recalcPurchItemRow(rowId); }
}

let purchActiveDropdownRowId = null;
let purchActiveDropdownIndex = -1;
let purchActiveDropdownInputEl = null;

function ensurePurchProductDropdownElement() {
  if (document.getElementById('purchItemProductDropdown')) return;
  const dd = document.createElement('div');
  dd.id = 'purchItemProductDropdown';
  dd.className = 'item-product-dropdown';
  document.body.appendChild(dd);
  window.addEventListener('scroll', (e) => {
    if (e.target === dd) return;
    if (dd.classList.contains('open') && purchActiveDropdownInputEl) positionPurchProductDropdown(purchActiveDropdownInputEl);
  }, true);
  window.addEventListener('resize', () => {
    if (dd.classList.contains('open') && purchActiveDropdownInputEl) positionPurchProductDropdown(purchActiveDropdownInputEl);
  });
}

function positionPurchProductDropdown(inputEl) {
  const dd = document.getElementById('purchItemProductDropdown');
  if (!dd) return;
  const rect = inputEl.getBoundingClientRect();
  const maxDropdownHeight = 280;
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openBelow = spaceBelow >= 150 || spaceBelow >= spaceAbove;
  const height = Math.max(80, Math.min(maxDropdownHeight, (openBelow ? spaceBelow : spaceAbove) - 10));

  dd.style.left = rect.left + 'px';
  dd.style.width = rect.width + 'px';
  dd.style.maxHeight = height + 'px';
  dd.style.top = openBelow ? (rect.bottom + 2) + 'px' : (rect.top - height - 2) + 'px';
}

function showPurchProductDropdown(rowId, inputEl, query) {
  ensurePurchProductDropdownElement();
  purchActiveDropdownRowId = rowId;
  purchActiveDropdownInputEl = inputEl;
  const dd = document.getElementById('purchItemProductDropdown');
  const q = (query || '').trim().toLowerCase();
  const matches = (q
    ? purchProductsList.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.hsn_code || '').toLowerCase().includes(q))
    : purchProductsList
  ).slice(0, 30);

  if (!matches.length) { dd.classList.remove('open'); purchActiveDropdownIndex = -1; return; }

  purchActiveDropdownIndex = 0;
  dd.innerHTML = matches.map((p, i) => `
    <div class="item-product-option${i === 0 ? ' highlighted' : ''}" onmousedown="selectPurchProductFromDropdown('${rowId}', '${escItemHtml(String(p.id))}')" onmouseenter="setPurchProductDropdownHighlight(${i})">
      <div class="fw-600 fs-13">${escItemHtml(p.name)}</div>
      <div class="fs-11 text-muted-sm">${[p.sku ? 'SKU: ' + escItemHtml(p.sku) : '', p.hsn_code ? 'HSN: ' + escItemHtml(p.hsn_code) : ''].filter(Boolean).join(' &middot; ') || '&mdash;'}</div>
    </div>`).join('');

  positionPurchProductDropdown(inputEl);
  dd.classList.add('open');
}

function hidePurchProductDropdown() {
  const dd = document.getElementById('purchItemProductDropdown');
  if (dd) dd.classList.remove('open');
  purchActiveDropdownRowId = null;
  purchActiveDropdownIndex = -1;
  purchActiveDropdownInputEl = null;
}

function setPurchProductDropdownHighlight(index) {
  const dd = document.getElementById('purchItemProductDropdown');
  if (!dd) return;
  const options = dd.querySelectorAll('.item-product-option');
  if (!options.length) return;
  if (index < 0) index = 0;
  if (index >= options.length) index = options.length - 1;
  purchActiveDropdownIndex = index;
  options.forEach((opt, i) => opt.classList.toggle('highlighted', i === index));
  options[index].scrollIntoView({ block: 'nearest' });
}

function movePurchProductDropdownHighlight(delta) {
  const dd = document.getElementById('purchItemProductDropdown');
  if (!dd || !dd.classList.contains('open')) return;
  setPurchProductDropdownHighlight((purchActiveDropdownIndex < 0 ? 0 : purchActiveDropdownIndex) + delta);
}

function selectHighlightedPurchProductOption(rowId) {
  const dd = document.getElementById('purchItemProductDropdown');
  if (!dd || !dd.classList.contains('open')) return false;
  const options = dd.querySelectorAll('.item-product-option');
  if (!options.length) return false;
  const idx = purchActiveDropdownIndex >= 0 && purchActiveDropdownIndex < options.length ? purchActiveDropdownIndex : 0;
  options[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return true;
}

function onPurchProductKeydown(event, rowId) {
  if (event.key === 'Escape') { hidePurchProductDropdown(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); movePurchProductDropdownHighlight(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); movePurchProductDropdownHighlight(-1); return; }
}

function selectPurchProductFromDropdown(rowId, productId) {
  const row = purchItems.find(r => r.rowId === rowId);
  const product = purchProductsList.find(p => String(p.id) === String(productId));
  if (!row || !product) return;
  purchJustSelectedFromDropdown = rowId;
  applyProductToPurchRow(row, product);
  recalcPurchItemRow(rowId);
  hidePurchProductDropdown();
  document.querySelector(`#purchItemsTableBody tr[data-row="${rowId}"] input[oninput*="'quantity'"]`)?.select();
}

async function onPurchProductBlur(rowId, name) {
  hidePurchProductDropdown();
  if (purchJustSelectedFromDropdown === rowId) { purchJustSelectedFromDropdown = null; return; }
  const row = purchItems.find(r => r.rowId === rowId);
  if (!row) return;
  const trimmed = (name || '').trim();
  row.product_name = trimmed;

  if (!trimmed) {
    row.product_id = null; row.hsn_code = ''; row.unit = ''; row.gst_percentage = 0; row.locked = false;
    recalcPurchItemRow(rowId);
    return;
  }

  const match = findProductByName(purchProductsList, trimmed);
  if (match) {
    applyProductToPurchRow(row, match);
    recalcPurchItemRow(rowId);
    return;
  }

  row.product_id = null; row.locked = false;
  renderPurchItemsTable();

  const ok = await showYesNo(`"${escItemHtml(trimmed)}" does not exist in Product Master. Would you like to add it?`, 'Product Not Found');
  const stillThere = purchItems.find(r => r.rowId === rowId);
  if (!stillThere) return;

  if (ok) {
    openPurchQuickAddProductModal(rowId, trimmed);
  } else {
    stillThere.product_name = '';
    stillThere.hsn_code = ''; stillThere.unit = ''; stillThere.gst_percentage = 0; stillThere.locked = false;
    renderPurchItemsTable();
    recalcPurchItemRow(rowId);
  }
}

function applyProductToPurchRow(row, product) {
  row.product_id = product.id;
  row.product_name = product.name;
  row.hsn_code = product.hsn_code || '';
  row.unit = product.unit || '';
  row.gst_percentage = +product.gst_percentage || 0;
  // Purchases enter what the vendor charges, not the selling price —
  // default_rate (the Product Master's SELLING price) would be actively
  // wrong to pre-fill here, so this always starts at 0 and the user
  // types the actual purchase cost, unlike Invoice Entry's equivalent.
  row.rate = 0;
  row.locked = true;
  renderPurchItemsTable();
}

function onPurchFieldChange(rowId, field, value) {
  const row = purchItems.find(r => r.rowId === rowId);
  if (!row) return;
  if (field === 'hsn_code' || field === 'unit') {
    row[field] = value;
  } else if (field === 'discount_percentage' || field === 'gst_percentage') {
    row[field] = Math.min(100, Math.max(0, parseFloat(value) || 0));
  } else {
    row[field] = Math.max(0, parseFloat(value) || 0);
  }
  recalcPurchItemRowLive(rowId);
}

function onPurchGstBlur(rowId, el) {
  const row = purchItems.find(r => r.rowId === rowId);
  if (!row) return;
  const raw = el.value.trim();
  const parsed = parseFloat(raw);
  const wasInvalid = raw !== '' && (isNaN(parsed) || parsed < 0 || parsed > 100);
  if (wasInvalid) showToast('GST % must be a number between 0 and 100 — corrected to ' + row.gst_percentage + '%.', 'error');
  el.value = row.gst_percentage;
}

// ── Quick Add Product modal (separate DOM id from Invoice Entry's own,
// so both can theoretically be loaded without id collisions — writes to
// the same shared products table either way) ──────
function ensurePurchQuickAddProductModal() {
  if (document.getElementById('purchQuickAddProductModal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'purchQuickAddProductModal';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title"><i class="fas fa-box"></i> Quick Add Product</span>
        <button type="button" class="modal-close" onclick="closePurchQuickAddProductModal()" aria-label="Close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-muted-sm mb-16">This is added to your Product Master and selected on this purchase automatically.</p>
        <div class="form-grid cols-2 mb-16">
          <div class="form-group">
            <label for="pqapName">Product Name <span class="text-required">*</span></label>
            <input type="text" id="pqapName" class="form-control">
          </div>
          <div class="form-group">
            <label for="pqapHSN">HSN Code</label>
            <input type="text" id="pqapHSN" class="form-control">
          </div>
        </div>
        <div class="form-grid cols-3 mb-16">
          <div class="form-group">
            <label for="pqapGstPct">GST Percentage</label>
            <select id="pqapGstPct" class="form-control">
              <option value="0">0%</option>
              <option value="5">5%</option>
              <option value="12">12%</option>
              <option value="18" selected>18%</option>
              <option value="28">28%</option>
            </select>
          </div>
          <div class="form-group">
            <label for="pqapUnit">Unit</label>
            <input type="text" id="pqapUnit" class="form-control" list="pqapUnitDatalist">
            <datalist id="pqapUnitDatalist">${COMMON_UNITS.map(u => `<option value="${u}">`).join('')}</datalist>
          </div>
          <div class="form-group">
            <label for="pqapRate">Selling Price (&#8377;)</label>
            <input type="number" id="pqapRate" class="form-control" min="0" step="0.01">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closePurchQuickAddProductModal()">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="savePurchQuickAddProduct()"><i class="fas fa-save"></i> Save &amp; Use</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function openPurchQuickAddProductModal(rowId, prefillName) {
  ensurePurchQuickAddProductModal();
  purchQuickAddTargetRowId = rowId;
  document.getElementById('pqapName').value = prefillName || '';
  document.getElementById('pqapHSN').value = '';
  document.getElementById('pqapGstPct').value = '18';
  document.getElementById('pqapUnit').value = '';
  document.getElementById('pqapRate').value = '';
  document.getElementById('purchQuickAddProductModal')?.classList.add('open');
}

function closePurchQuickAddProductModal() {
  document.getElementById('purchQuickAddProductModal')?.classList.remove('open');
  purchQuickAddTargetRowId = null;
}

async function savePurchQuickAddProduct() {
  const name = document.getElementById('pqapName')?.value?.trim();
  if (!name) { showToast('Product name is required.', 'error'); return; }
  const dup = purchProductsList.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (dup) { showToast('Product already exists — select it from the list instead.', 'warning'); return; }

  const hsn = document.getElementById('pqapHSN')?.value?.trim();
  const gstPct = parseFloat(document.getElementById('pqapGstPct')?.value) || 0;
  const unit = document.getElementById('pqapUnit')?.value?.trim() || '';
  const rate = parseFloat(document.getElementById('pqapRate')?.value) || 0;

  const { error } = await _supabase.from('products').insert({
    user_id: purchUserId, name, hsn_code: hsn, type: 'goods',
    gst_percentage: gstPct, default_rate: rate, unit, source: 'local'
  });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }

  purchProductsList = await loadProductsList(purchUserId);
  populatePurchProductDatalist();
  if (typeof loadProducts === 'function' && document.getElementById('prodTableBody')) {
    loadProducts(purchUserId);
  }
  showToast('Product added to Product Master!', 'success');

  const rowId = purchQuickAddTargetRowId;
  closePurchQuickAddProductModal();
  if (rowId) {
    const row = purchItems.find(r => r.rowId === rowId);
    if (row) {
      const newProd = findProductByName(purchProductsList, name);
      if (newProd) applyProductToPurchRow(row, newProd);
      recalcPurchItemRow(rowId);
    }
  }
}

// ── Recalc / rollups ────────────────────────────────
function recalcPurchItemRow(rowId) {
  const row = purchItems.find(r => r.rowId === rowId);
  if (!row) return;
  const gross = (row.quantity || 0) * (row.rate || 0);
  row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
  const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getPurchSupplyType());
  row.gst_amount = calc.gstAmount;
  row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
  row.total_amount = round2(row.taxable_value + calc.gstAmount);
  renderPurchItemsTable();
  computePurchRollups();
}

function recalcPurchItemRowLive(rowId) {
  const row = purchItems.find(r => r.rowId === rowId);
  if (!row) return;
  const gross = (row.quantity || 0) * (row.rate || 0);
  row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
  const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getPurchSupplyType());
  row.gst_amount = calc.gstAmount;
  row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
  row.total_amount = round2(row.taxable_value + calc.gstAmount);
  updatePurchRowComputedCells(row);
  computePurchRollups();
}

function updatePurchRowComputedCells(row) {
  const tr = document.querySelector(`#purchItemsTableBody tr[data-row="${row.rowId}"]`);
  if (!tr) return;
  const taxableCell = tr.querySelector('.purch-taxable-cell');
  const totalCell = tr.querySelector('.purch-total-cell');
  if (taxableCell) taxableCell.textContent = '₹' + formatNum(row.taxable_value);
  if (totalCell) totalCell.textContent = '₹' + formatNum(row.total_amount);
}

function recalcAllPurchRows() {
  purchItems.forEach(row => {
    const gross = (row.quantity || 0) * (row.rate || 0);
    row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
    const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getPurchSupplyType());
    row.gst_amount = calc.gstAmount;
    row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
    row.total_amount = round2(row.taxable_value + calc.gstAmount);
  });
  renderPurchItemsTable();
  computePurchRollups();
}

function computePurchRollups() {
  const rows = purchItems.filter(r => r.product_name && r.taxable_value > 0);
  const taxable = round2(rows.reduce((s, r) => s + r.taxable_value, 0));
  const igst    = round2(rows.reduce((s, r) => s + r.igst, 0));
  const cgst    = round2(rows.reduce((s, r) => s + r.cgst, 0));
  const sgst    = round2(rows.reduce((s, r) => s + r.sgst, 0));
  const gstAmt  = round2(igst + cgst + sgst);
  const rawTotal = taxable + gstAmt;
  const grandTotal = Math.round(rawTotal);
  const roundOff = round2(grandTotal - rawTotal);
  const gstPercentage = taxable > 0 ? round2(gstAmt / taxable * 100) : 0;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('purchItemsSubtotal', formatNum(taxable));
  set('purchItemsGstAmt', formatNum(gstAmt));
  set('purchItemsRoundOff', (roundOff >= 0 ? '+' : '') + formatNum(roundOff));
  set('purchItemsGrandTotal', formatNum(grandTotal));
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('purchItemsIGST', formatNum(igst));
  setTxt('purchItemsCGST', formatNum(cgst));
  setTxt('purchItemsSGST', formatNum(sgst));
  const wordsEl = document.getElementById('purchItemsAmountWords');
  if (wordsEl) wordsEl.textContent = numberToWordsINR(grandTotal);

  return { taxable_amount: taxable, gst_percentage: gstPercentage, gst_amount: gstAmt, igst, cgst, sgst, total_amount: grandTotal, round_off: roundOff };
}

function validatePurchaseItems() {
  const rows = purchItems.filter(r => r.product_name && r.quantity > 0 && r.rate >= 0);
  if (!rows.length) { showToast('Add at least one product with a quantity and rate.', 'error'); return false; }
  return true;
}

// ── Save orchestration ───────────────────────────────
// Header upsert + line-item replace + stock delta, one Postgres
// transaction (server/routes/purchases.js) — same shape as
// js/invoice-items.js's saveInvoiceWithItems(), generalized over `kind`.
async function savePurchaseWithItems(kind, headerBase, editId, userId) {
  if (!validatePurchaseItems()) return false;

  const header = { ...headerBase, ...computePurchRollups() };
  const items = purchItems
    .filter(r => r.product_name && r.taxable_value >= 0)
    .map(r => ({
      product_id: r.product_id, product_name: r.product_name, hsn_code: r.hsn_code, unit: r.unit,
      quantity: r.quantity, rate: r.rate, discount_percentage: r.discount_percentage, gst_percentage: r.gst_percentage,
      taxable_value: r.taxable_value, gst_amount: r.gst_amount, igst: r.igst, cgst: r.cgst, sgst: r.sgst,
      total_amount: r.total_amount
    }));

  try {
    const { id } = await apiFetch(`/purchases/${kind}/save-with-items`, {
      method: 'POST',
      body: JSON.stringify({ editId, header, items })
    });
    return id;
  } catch (error) {
    showToast('Error: ' + (error.message || 'save failed'), 'error');
    return false;
  }
}

// ── Cascade delete / restore (invoked from purchase-list.js,
// purchase-returns.js, recycle-bin.js) ──────────────
async function cascadePurchaseItemsDelete(kind, id) {
  try {
    await apiFetch(`/purchases/${kind}/${id}/cascade-delete`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade delete failed'), 'error');
  }
}

async function cascadePurchaseItemsRestore(kind, id) {
  try {
    await apiFetch(`/purchases/${kind}/${id}/cascade-restore`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade restore failed'), 'error');
  }
}

async function cascadePurchaseItemsHardDelete(kind, id) {
  try {
    await apiFetch(`/purchases/${kind}/${id}/cascade-hard-delete`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade hard-delete failed'), 'error');
  }
}
