// =============================================
// Invoice Line Items — Product Master driven
// Shared by B2B (gstr1.html) and B2C (b2c.html) invoice entry.
// Also safe to include (function-only, no DOM) on invoice-list.html
// and recycle-bin.html for the delete/restore cascade helpers.
// =============================================

let currentItems = [];
let itemsProductsList = [];
let itemsFormPrefix = null;   // 'b2b' | 'b2c'
let itemsUserId = null;
let itemsRowSeq = 0;
let quickAddTargetRowId = null;

// ── Init ──────────────────────────────────────────
async function initInvoiceItems(userId, formPrefix) {
  itemsUserId = userId;
  itemsFormPrefix = formPrefix;
  // Reading the product list is a local DB read (or a local-storage
  // read in demo mode) — never a network call, so this always succeeds
  // instantly even if the website/internet is down (requirement 7).
  itemsProductsList = await loadProductsList(userId);
  renderItemsSectionShell('itemsSection');
  ensureQuickAddProductModal();
  populateItemsProductDatalist();
  if (!currentItems.length) addItemRow();
  setupItemsDraftAutosave(formPrefix + '_invoice');
  renderProductSyncNotice();
  window.addEventListener('productSyncUpdated', async () => {
    itemsProductsList = await loadProductsList(itemsUserId);
    populateItemsProductDatalist();
    renderProductSyncNotice();
  });
}

// A calm, always-present line — never an error toast — telling the
// user where their product list came from. Purely informational and
// computed from what's already in localStorage; never waits on or is
// affected by whether a background sync is in flight or has failed
// (requirements 2, 4, 6).
function renderProductSyncNotice() {
  const el = document.getElementById('productSyncNotice');
  if (!el) return;
  if (typeof getProductSyncMeta !== 'function') { el.innerHTML = ''; return; }

  const meta = getProductSyncMeta();
  const rel = typeof formatRelativeTime === 'function' ? formatRelativeTime(meta.lastSyncAt) : '';
  const stale = typeof isProductSyncStale === 'function' ? isProductSyncStale(meta) : false;
  const whenText = meta.lastSyncAt ? `last synced ${rel}` : 'not yet synced';

  const usingCached = meta.status === 'error' || meta.status === 'not_configured' || stale;
  const text = usingCached ? `Using cached products (${whenText})` : `Products ${whenText}`;

  el.innerHTML = `<i class="fas fa-${usingCached ? 'database' : 'check-circle'}"></i> ${text}`;
}

function getInvoiceSupplyType() {
  // invoice.html's unified form uses one #invSupply select regardless of
  // B2B/B2C classification; gstr1.html/b2c.html (kept as redirect stubs)
  // still use their original per-page ids.
  const generic = document.getElementById('invSupply');
  if (generic) return generic.value || 'intrastate';
  const id = itemsFormPrefix === 'b2b' ? 'b2bSupply' : 'b2cSupply';
  return document.getElementById(id)?.value || 'intrastate';
}

// ── Shell markup ──────────────────────────────────
function renderItemsSectionShell(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="section-title mb-14">Products</div>
    <div id="productSyncNotice" class="fs-12 text-muted-sm mb-10"></div>
    <div class="table-wrapper mb-16">
      <table class="data-table" id="itemsTable">
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
        <tbody id="itemsTableBody"></tbody>
      </table>
    </div>
    <button type="button" class="btn btn-secondary btn-sm mb-20" onclick="addItemRow()"><i class="fas fa-plus"></i> Add Row</button>

    <div class="calc-box mb-20">
      <div class="calc-row">
        <span class="label">Subtotal (Taxable Value)</span>
        <span class="value"><input type="text" id="itemsSubtotal" class="form-control calc-input-sm" readonly aria-label="Subtotal"></span>
      </div>
      <div class="calc-row">
        <span class="label">GST Amount</span>
        <div class="calc-tax-row">
          <span class="text-muted-sm">IGST: <b id="itemsIGST">0.00</b></span>
          <span class="text-muted-sm">CGST: <b id="itemsCGST">0.00</b></span>
          <span class="text-muted-sm">SGST: <b id="itemsSGST">0.00</b></span>
        </div>
        <span class="value"><input type="text" id="itemsGstAmt" class="form-control calc-input-sm" readonly aria-label="GST Amount"></span>
      </div>
      <div class="calc-row">
        <span class="label">Round Off</span>
        <span class="value"><input type="text" id="itemsRoundOff" class="form-control calc-input-sm" readonly aria-label="Round Off"></span>
      </div>
      <div class="calc-row total">
        <span class="label">Grand Total</span>
        <span class="value"><input type="text" id="itemsGrandTotal" class="form-control calc-input-total" readonly aria-label="Grand Total"></span>
      </div>
      <div class="calc-row">
        <span class="label">Amount in Words</span>
        <span class="value fs-12 text-muted-sm text-right" id="itemsAmountWords"></span>
      </div>
    </div>

    <datalist id="itemsProductDatalist"></datalist>
  `;
  ['b2bSupply','b2cSupply','invSupply'].forEach(id => document.getElementById(id)?.addEventListener('change', recalcAllRows));
}

function populateItemsProductDatalist() {
  const dl = document.getElementById('itemsProductDatalist');
  if (dl) dl.innerHTML = itemsProductsList.map(p => `<option value="${escItemHtml(p.name)}"></option>`).join('');
}

// ── Row lifecycle ─────────────────────────────────
function blankRow() {
  itemsRowSeq++;
  return {
    rowId: 'row' + itemsRowSeq, product_id: null, product_name: '', hsn_code: '', unit: '',
    quantity: 1, rate: 0, discount_percentage: 0, gst_percentage: 0,
    taxable_value: 0, gst_amount: 0, igst: 0, cgst: 0, sgst: 0, total_amount: 0, locked: false
  };
}

function addItemRow() {
  currentItems.push(blankRow());
  renderItemsTable();
  persistItemsDraft();
}

function removeItemRow(rowId) {
  currentItems = currentItems.filter(r => r.rowId !== rowId);
  if (!currentItems.length) currentItems.push(blankRow());
  renderItemsTable();
  computeInvoiceRollups();
  persistItemsDraft();
}

function resetInvoiceItems() {
  currentItems = [blankRow()];
  renderItemsTable();
  computeInvoiceRollups();
}

function loadItemsIntoTable(rows) {
  currentItems = rows.map(r => {
    itemsRowSeq++;
    return {
      rowId: 'row' + itemsRowSeq, product_id: r.product_id || null, product_name: r.product_name || '',
      hsn_code: r.hsn_code || '', unit: r.unit || '', quantity: +r.quantity || 1, rate: +r.rate || 0,
      discount_percentage: +r.discount_percentage || 0, gst_percentage: +r.gst_percentage || 0,
      taxable_value: +r.taxable_value || 0, gst_amount: +r.gst_amount || 0, igst: +r.igst || 0,
      cgst: +r.cgst || 0, sgst: +r.sgst || 0, total_amount: +r.total_amount || 0,
      locked: !!(r.product_id || (r.hsn_code && findProductByName(itemsProductsList, r.product_name)))
    };
  });
  if (!currentItems.length) currentItems.push(blankRow());
  renderItemsTable();
  computeInvoiceRollups();
}

// Legacy invoices (pre-existing single flat-amount rows, no line items):
// synthesize one in-memory, fully-editable row from the old header fields.
// Nothing is written until the user hits Save — opening Edit alone never
// touches the database.
function synthesizeLegacyItemRow(rec) {
  itemsRowSeq++;
  currentItems = [{
    rowId: 'row' + itemsRowSeq, product_id: null, product_name: 'Legacy Entry',
    hsn_code: '', unit: '', quantity: 1, rate: +rec.taxable_amount || 0,
    discount_percentage: 0, gst_percentage: +rec.gst_percentage || 0,
    taxable_value: +rec.taxable_amount || 0, gst_amount: +rec.gst_amount || 0,
    igst: +rec.igst || 0, cgst: +rec.cgst || 0, sgst: +rec.sgst || 0,
    total_amount: +rec.total_amount || 0, locked: false
  }];
  renderItemsTable();
  computeInvoiceRollups();
}

// ── Render ────────────────────────────────────────
function renderItemsTable() {
  const tbody = document.getElementById('itemsTableBody');
  if (!tbody) return;
  tbody.innerHTML = currentItems.map(row => `
    <tr data-row="${row.rowId}">
      <td>
        <input type="text" class="form-control" placeholder="Type or select product" autocomplete="off"
          value="${escItemHtml(row.product_name)}"
          oninput="onItemProductInput('${row.rowId}', this.value); showProductDropdown('${row.rowId}', this, this.value)"
          onfocus="showProductDropdown('${row.rowId}', this, this.value)"
          onblur="onItemProductBlur('${row.rowId}', this.value)"
          onkeydown="onItemProductKeydown(event, '${row.rowId}')">
      </td>
      <td><input type="text" class="form-control" value="${escItemHtml(row.hsn_code)}" ${row.locked ? 'readonly' : ''}
          onchange="onItemFieldChange('${row.rowId}','hsn_code',this.value)"></td>
      <td><input type="text" class="form-control" value="${escItemHtml(row.unit)}" ${row.locked ? 'readonly' : ''}
          onchange="onItemFieldChange('${row.rowId}','unit',this.value)"></td>
      <td><input type="number" class="form-control text-center" min="0.001" step="0.001" value="${row.quantity}"
          oninput="onItemFieldChange('${row.rowId}','quantity',this.value)"></td>
      <td><input type="number" class="form-control text-right" min="0" step="0.01" value="${row.rate}"
          oninput="onItemFieldChange('${row.rowId}','rate',this.value)"></td>
      <td><input type="number" class="form-control text-center" min="0" max="100" step="0.01" value="${row.discount_percentage}"
          oninput="onItemFieldChange('${row.rowId}','discount_percentage',this.value)"></td>
      <td><input type="number" class="form-control text-center" min="0" max="100" step="0.01" value="${row.gst_percentage}"
          oninput="onItemFieldChange('${row.rowId}','gst_percentage',this.value)"
          onblur="onItemGstBlur('${row.rowId}', this)"
          title="Auto-filled from Product Master — editable for this invoice line only"></td>
      <td class="text-right fw-600 item-taxable-cell">&#8377;${formatNum(row.taxable_value)}</td>
      <td class="text-right fw-700 item-total-cell">&#8377;${formatNum(row.total_amount)}</td>
      <td><button type="button" class="btn btn-danger btn-sm btn-icon" onclick="removeItemRow('${row.rowId}')" title="Remove row"><i class="fas fa-trash"></i></button></td>
    </tr>`).join('');
}

// ── Product autocomplete / autofill / lock ─────────
// Set briefly by selectProductFromDropdown() so the blur event that
// inevitably follows a dropdown click (fired on the now-replaced OLD
// input, carrying its stale in-progress search text like "Vegetable"
// rather than the just-selected full product name) doesn't misfire the
// "product not found" flow right after a valid selection was made.
let justSelectedFromDropdown = null;

function onItemProductInput(rowId, name) {
  const row = currentItems.find(r => r.rowId === rowId);
  if (!row) return;
  row.product_name = name;
  const match = findProductByName(itemsProductsList, name);
  // An exact-name match while typing is still "a product was selected" —
  // same as a dropdown click or blur match, it must refresh every
  // auto-filled field (Rate included) and recalculate immediately.
  if (match) { applyProductToRow(row, match); recalcItemRow(rowId); }
}

// ── Product search dropdown (name + SKU + HSN) ─────
// A native <datalist> can only match against its <option value>, which
// only ever holds the product name — there's no way for it to match on
// SKU or HSN. This is a small custom dropdown searching all three, and
// is rendered on document.body (position:fixed) rather than nested
// inside the <td> so it's never clipped/misplaced by the item table's
// own horizontal-scroll wrapper.
let activeDropdownRowId = null;
let activeDropdownIndex = -1; // which option Arrow keys have highlighted; Enter selects this one
let activeDropdownInputEl = null;

function ensureProductDropdownElement() {
  if (document.getElementById('itemProductDropdown')) return;
  const dd = document.createElement('div');
  dd.id = 'itemProductDropdown';
  dd.className = 'item-product-dropdown';
  document.body.appendChild(dd);
  // Reposition — not close — on scroll, so the dropdown keeps tracking
  // its input's on-screen position instead of going stale. This used to
  // close on any scroll, but that included the browser's OWN
  // scroll-into-view firing right as the input gains focus, which raced
  // with opening the dropdown and could close it an instant after it
  // opened. Capture-phase so ancestor scroll containers are heard too;
  // scroll events on the dropdown's own list (wheel/scrollbar) are
  // excluded so scrolling the results doesn't fight itself.
  window.addEventListener('scroll', (e) => {
    if (e.target === dd) return;
    if (dd.classList.contains('open') && activeDropdownInputEl) positionProductDropdown(activeDropdownInputEl);
  }, true);
  window.addEventListener('resize', () => {
    if (dd.classList.contains('open') && activeDropdownInputEl) positionProductDropdown(activeDropdownInputEl);
  });
}

// Flip above the input when there isn't room below (the Products section
// can sit well down the page, especially on shorter screens) — otherwise
// the dropdown renders past the viewport and becomes unreachable.
function positionProductDropdown(inputEl) {
  const dd = document.getElementById('itemProductDropdown');
  if (!dd) return;
  const rect = inputEl.getBoundingClientRect();
  const maxDropdownHeight = 280; // keep in sync with .item-product-dropdown max-height
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openBelow = spaceBelow >= 150 || spaceBelow >= spaceAbove;
  const height = Math.max(80, Math.min(maxDropdownHeight, (openBelow ? spaceBelow : spaceAbove) - 10));

  dd.style.left = rect.left + 'px';
  dd.style.width = rect.width + 'px';
  dd.style.maxHeight = height + 'px';
  dd.style.top = openBelow ? (rect.bottom + 2) + 'px' : (rect.top - height - 2) + 'px';
}

function showProductDropdown(rowId, inputEl, query) {
  ensureProductDropdownElement();
  activeDropdownRowId = rowId;
  activeDropdownInputEl = inputEl;
  const dd = document.getElementById('itemProductDropdown');
  const q = (query || '').trim().toLowerCase();
  const matches = (q
    ? itemsProductsList.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.hsn_code || '').toLowerCase().includes(q))
    : itemsProductsList
  ).slice(0, 30);

  if (!matches.length) { dd.classList.remove('open'); activeDropdownIndex = -1; return; }

  activeDropdownIndex = 0; // highlight the top match by default — Enter with no arrow-key use still picks it
  dd.innerHTML = matches.map((p, i) => `
    <div class="item-product-option${i === 0 ? ' highlighted' : ''}" onmousedown="selectProductFromDropdown('${rowId}', '${escItemHtml(String(p.id))}')" onmouseenter="setProductDropdownHighlight(${i})">
      <div class="fw-600 fs-13">${escItemHtml(p.name)}</div>
      <div class="fs-11 text-muted-sm">${[p.sku ? 'SKU: ' + escItemHtml(p.sku) : '', p.hsn_code ? 'HSN: ' + escItemHtml(p.hsn_code) : ''].filter(Boolean).join(' &middot; ') || '&mdash;'}</div>
    </div>`).join('');

  positionProductDropdown(inputEl);
  dd.classList.add('open');
}

function hideProductDropdown() {
  const dd = document.getElementById('itemProductDropdown');
  if (dd) dd.classList.remove('open');
  activeDropdownRowId = null;
  activeDropdownIndex = -1;
  activeDropdownInputEl = null;
}

// Arrow-key navigation, and hover keeping the keyboard highlight in
// sync with the mouse so the two never disagree about which option
// Enter/click would pick.
function setProductDropdownHighlight(index) {
  const dd = document.getElementById('itemProductDropdown');
  if (!dd) return;
  const options = dd.querySelectorAll('.item-product-option');
  if (!options.length) return;
  if (index < 0) index = 0;
  if (index >= options.length) index = options.length - 1;
  activeDropdownIndex = index;
  options.forEach((opt, i) => opt.classList.toggle('highlighted', i === index));
  options[index].scrollIntoView({ block: 'nearest' });
}

function moveProductDropdownHighlight(delta) {
  const dd = document.getElementById('itemProductDropdown');
  if (!dd || !dd.classList.contains('open')) return;
  setProductDropdownHighlight((activeDropdownIndex < 0 ? 0 : activeDropdownIndex) + delta);
}

// Invoked by Enter (see js/invoice-entry.js's document keydown handler)
// — picks whichever option Arrow keys (or mouse hover) last highlighted,
// defaulting to the top match if the user never touched Arrow/hover.
function selectHighlightedProductOption(rowId) {
  const dd = document.getElementById('itemProductDropdown');
  if (!dd || !dd.classList.contains('open')) return false;
  const options = dd.querySelectorAll('.item-product-option');
  if (!options.length) return false;
  const idx = activeDropdownIndex >= 0 && activeDropdownIndex < options.length ? activeDropdownIndex : 0;
  options[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return true;
}

function onItemProductKeydown(event, rowId) {
  if (event.key === 'Escape') { hideProductDropdown(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveProductDropdownHighlight(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveProductDropdownHighlight(-1); return; }
  // Enter is handled by the document-level keydown listener in
  // js/invoice-entry.js, which calls selectHighlightedProductOption().
}

function selectProductFromDropdown(rowId, productId) {
  const row = currentItems.find(r => r.rowId === rowId);
  const product = itemsProductsList.find(p => String(p.id) === String(productId));
  if (!row || !product) return;
  justSelectedFromDropdown = rowId;
  applyProductToRow(row, product);
  recalcItemRow(rowId);
  hideProductDropdown();
  // Both calls above re-render the row (fresh DOM nodes), so the
  // Quantity input has to be looked up fresh rather than reused from
  // before selection — keyboard-friendly entry: product chosen -> focus
  // jumps straight to Qty without touching the mouse.
  // .select() so the default "1" is fully selected, not just focused —
  // otherwise the next digit typed inserts at whatever cursor position
  // the browser happens to place it (often position 0), silently
  // corrupting the quantity (e.g. typing "3" over "1" becoming "31").
  document.querySelector(`#itemsTableBody tr[data-row="${rowId}"] input[oninput*="'quantity'"]`)?.select();
}

async function onItemProductBlur(rowId, name) {
  hideProductDropdown();
  if (justSelectedFromDropdown === rowId) { justSelectedFromDropdown = null; return; }
  const row = currentItems.find(r => r.rowId === rowId);
  if (!row) return;
  const trimmed = (name || '').trim();
  row.product_name = trimmed;

  if (!trimmed) {
    row.product_id = null; row.hsn_code = ''; row.unit = ''; row.gst_percentage = 0; row.locked = false;
    recalcItemRow(rowId);
    return;
  }

  const match = findProductByName(itemsProductsList, trimmed);
  if (match) {
    applyProductToRow(row, match);
    recalcItemRow(rowId);
    return;
  }

  // No match — never silently accept a hand-typed HSN for an unknown name.
  row.product_id = null; row.locked = false;
  renderItemsTable();

  const ok = await showYesNo(`"${escItemHtml(trimmed)}" does not exist in Product Master. Would you like to add it?`, 'Product Not Found');
  const stillThere = currentItems.find(r => r.rowId === rowId);
  if (!stillThere) return; // row was removed while the popup was open

  if (ok) {
    openQuickAddProductModal(rowId, trimmed);
  } else {
    stillThere.product_name = '';
    stillThere.hsn_code = ''; stillThere.unit = ''; stillThere.gst_percentage = 0; stillThere.locked = false;
    renderItemsTable();
    recalcItemRow(rowId);
  }
}

// Every field here must fully replace whatever the row previously held —
// including Rate, which used to only fill in if the row's rate was still
// 0 (`if (!row.rate) row.rate = ...`). That left a manually-edited or
// previously-selected-product's Rate stuck in place when switching to a
// different product on the same row, since the row's rate was already
// non-zero by then. Rate must always come from the newly selected
// product's own Product Master value, same as HSN/Unit/GST % already do.
function applyProductToRow(row, product) {
  row.product_id = product.id;
  row.product_name = product.name;
  row.hsn_code = product.hsn_code || '';
  row.unit = product.unit || '';
  row.gst_percentage = +product.gst_percentage || 0;
  row.rate = +product.default_rate || 0;
  row.locked = true;
  renderItemsTable();
}

function onItemFieldChange(rowId, field, value) {
  const row = currentItems.find(r => r.rowId === rowId);
  if (!row) return;
  if (field === 'hsn_code' || field === 'unit') {
    row[field] = value;
  } else if (field === 'discount_percentage' || field === 'gst_percentage') {
    // Same 0-100 clamp as Discount — a manually overridden GST % never
    // breaks the math, it just can't go negative or above 100. This is
    // an in-memory edit on this one row only: it never touches
    // itemsProductsList or the products table, so Product Master (and
    // every other row/invoice) is untouched, per requirement.
    row[field] = Math.min(100, Math.max(0, parseFloat(value) || 0));
  } else {
    row[field] = Math.max(0, parseFloat(value) || 0);
  }
  // Field edits fire on every keystroke (oninput) — recalculate and patch
  // only the read-only computed cells in place. Never call renderItemsTable()
  // here: that replaces every <input> in the row with a fresh DOM node,
  // which drops focus and cursor position mid-keystroke (the input being
  // typed into isn't even the one losing value — it's destroyed outright).
  recalcItemRowLive(rowId);
}

// GST % accepts free typing (including a transient "-" or a value briefly
// above 100 mid-keystroke) without interrupting the user with a toast on
// every character — onItemFieldChange above already clamps it for
// calculation purposes on every keystroke. Once the user leaves the
// field, this reconciles what's displayed with what was actually clamped
// and stored, and surfaces one validation message if a correction happened.
function onItemGstBlur(rowId, el) {
  const row = currentItems.find(r => r.rowId === rowId);
  if (!row) return;
  const raw = el.value.trim();
  const parsed = parseFloat(raw);
  const wasInvalid = raw !== '' && (isNaN(parsed) || parsed < 0 || parsed > 100);
  if (wasInvalid) showToast('GST % must be a number between 0 and 100 — corrected to ' + row.gst_percentage + '%.', 'error');
  el.value = row.gst_percentage;
}

// ── Quick Add Product modal ─────────────────────────
function ensureQuickAddProductModal() {
  if (document.getElementById('quickAddProductModal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'quickAddProductModal';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title"><i class="fas fa-box"></i> Quick Add Product</span>
        <button type="button" class="modal-close" onclick="closeQuickAddProductModal()" aria-label="Close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-muted-sm mb-16">This is added to your Product Master and selected on this invoice automatically — your other entries here are kept exactly as they are.</p>
        <div class="form-grid cols-2 mb-16">
          <div class="form-group">
            <label for="qapName">Product Name <span class="text-required">*</span></label>
            <input type="text" id="qapName" class="form-control" placeholder="Enter product or service name">
          </div>
          <div class="form-group">
            <label for="qapHSN">HSN Code</label>
            <input type="text" id="qapHSN" class="form-control" placeholder="e.g. 8471">
          </div>
        </div>
        <div class="form-grid cols-3 mb-16">
          <div class="form-group">
            <label for="qapGstPct">GST Percentage</label>
            <select id="qapGstPct" class="form-control">
              <option value="0">0%</option>
              <option value="5">5%</option>
              <option value="12">12%</option>
              <option value="18" selected>18%</option>
              <option value="28">28%</option>
            </select>
          </div>
          <div class="form-group">
            <label for="qapUnit">Unit</label>
            <input type="text" id="qapUnit" class="form-control" list="qapUnitDatalist" placeholder="e.g. PCS">
            <datalist id="qapUnitDatalist">${COMMON_UNITS.map(u => `<option value="${u}">`).join('')}</datalist>
          </div>
          <div class="form-group">
            <label for="qapRate">Selling Price (&#8377;)</label>
            <input type="number" id="qapRate" class="form-control" placeholder="0.00" min="0" step="0.01">
          </div>
        </div>
        <div class="form-group">
          <label for="qapDescription">Description <span class="text-muted-sm">(optional)</span></label>
          <input type="text" id="qapDescription" class="form-control" placeholder="Optional notes">
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeQuickAddProductModal()">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="saveQuickAddProduct()"><i class="fas fa-save"></i> Save &amp; Use</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function openQuickAddProductModal(rowId, prefillName) {
  ensureQuickAddProductModal();
  quickAddTargetRowId = rowId;
  document.getElementById('qapName').value = prefillName || '';
  document.getElementById('qapHSN').value = '';
  document.getElementById('qapGstPct').value = '18';
  document.getElementById('qapUnit').value = '';
  document.getElementById('qapRate').value = '';
  document.getElementById('qapDescription').value = '';
  document.getElementById('quickAddProductModal')?.classList.add('open');
}

function closeQuickAddProductModal() {
  document.getElementById('quickAddProductModal')?.classList.remove('open');
  // The row itself (product name cleared) is left as-is — user can retry or type a different name.
  quickAddTargetRowId = null;
}

async function saveQuickAddProduct() {
  const name = document.getElementById('qapName')?.value?.trim();
  if (!name) { showToast('Product name is required.', 'error'); return; }
  const dup = itemsProductsList.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (dup) { showToast('Product already exists — select it from the list instead.', 'warning'); return; }

  const hsn = document.getElementById('qapHSN')?.value?.trim();
  const gstPct = parseFloat(document.getElementById('qapGstPct')?.value) || 0;
  const unit = document.getElementById('qapUnit')?.value?.trim() || '';
  const rate = parseFloat(document.getElementById('qapRate')?.value) || 0;
  const description = document.getElementById('qapDescription')?.value?.trim() || '';

  const { error } = await _supabase.from('products').insert({
    user_id: itemsUserId, name, hsn_code: hsn, type: 'goods',
    gst_percentage: gstPct, default_rate: rate, unit, description,
    source: 'local'
  });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }

  itemsProductsList = await loadProductsList(itemsUserId);
  populateItemsProductDatalist();
  if (typeof loadProducts === 'function' && document.getElementById('prodTableBody')) {
    // Product Master page itself is open in this tab — keep its own list in sync too.
    loadProducts(itemsUserId);
  }
  showToast('Product added to Product Master!', 'success');

  const rowId = quickAddTargetRowId;
  closeQuickAddProductModal();
  if (rowId) {
    const row = currentItems.find(r => r.rowId === rowId);
    if (row) {
      const newProd = findProductByName(itemsProductsList, name);
      if (newProd) applyProductToRow(row, newProd);
      recalcItemRow(rowId);
    }
  }
}

// ── Recalc / rollups ────────────────────────────────
function recalcItemRow(rowId) {
  const row = currentItems.find(r => r.rowId === rowId);
  if (!row) return;
  const gross = (row.quantity || 0) * (row.rate || 0);
  row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
  const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getInvoiceSupplyType());
  row.gst_amount = calc.gstAmount;
  row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
  row.total_amount = round2(row.taxable_value + calc.gstAmount);
  renderItemsTable();
  computeInvoiceRollups();
  persistItemsDraft();
}

// Same math as recalcItemRow(), but patches only the two computed cells
// (Taxable Value / Total) via textContent instead of calling
// renderItemsTable() — keeps every <input> element (and the user's focus,
// cursor position, and in-progress keystroke) untouched.
function recalcItemRowLive(rowId) {
  const row = currentItems.find(r => r.rowId === rowId);
  if (!row) return;
  const gross = (row.quantity || 0) * (row.rate || 0);
  row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
  const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getInvoiceSupplyType());
  row.gst_amount = calc.gstAmount;
  row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
  row.total_amount = round2(row.taxable_value + calc.gstAmount);
  updateRowComputedCells(row);
  computeInvoiceRollups();
  persistItemsDraft();
}

function updateRowComputedCells(row) {
  const tr = document.querySelector(`#itemsTableBody tr[data-row="${row.rowId}"]`);
  if (!tr) return;
  const taxableCell = tr.querySelector('.item-taxable-cell');
  const totalCell = tr.querySelector('.item-total-cell');
  if (taxableCell) taxableCell.textContent = '₹' + formatNum(row.taxable_value);
  if (totalCell) totalCell.textContent = '₹' + formatNum(row.total_amount);
}

function recalcAllRows() {
  currentItems.forEach(row => {
    const gross = (row.quantity || 0) * (row.rate || 0);
    row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
    const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getInvoiceSupplyType());
    row.gst_amount = calc.gstAmount;
    row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
    row.total_amount = round2(row.taxable_value + calc.gstAmount);
  });
  renderItemsTable();
  computeInvoiceRollups();
  persistItemsDraft();
}

function computeInvoiceRollups() {
  const rows = currentItems.filter(r => r.product_name && r.taxable_value > 0);
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
  set('itemsSubtotal', formatNum(taxable));
  set('itemsGstAmt', formatNum(gstAmt));
  set('itemsRoundOff', (roundOff >= 0 ? '+' : '') + formatNum(roundOff));
  set('itemsGrandTotal', formatNum(grandTotal));
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('itemsIGST', formatNum(igst));
  setTxt('itemsCGST', formatNum(cgst));
  setTxt('itemsSGST', formatNum(sgst));
  const wordsEl = document.getElementById('itemsAmountWords');
  if (wordsEl) wordsEl.textContent = numberToWordsINR(grandTotal);

  return { taxable_amount: taxable, gst_percentage: gstPercentage, gst_amount: gstAmt, igst, cgst, sgst, total_amount: grandTotal, round_off: roundOff };
}

function validateInvoiceItems() {
  const rows = currentItems.filter(r => r.product_name && r.quantity > 0 && r.rate >= 0);
  if (!rows.length) { showToast('Add at least one product with a quantity and rate.', 'error'); return false; }
  return true;
}

// ── Draft persistence (parallel to js/drafts.js — dynamic rows
// can't be captured by its fixed-field-id snapshot) ──────────
function itemsDraftKey(formKey) { return 'gst_draft_items_' + formKey; }

function setupItemsDraftAutosave(formKey) {
  // Row-level handlers already call persistItemsDraft() on every change;
  // this just remembers which key to use for the lifetime of the page.
  itemsDraftFormKey = formKey;
}
let itemsDraftFormKey = null;
let itemsDraftTimer = null;

function persistItemsDraft() {
  if (!itemsDraftFormKey) return;
  clearTimeout(itemsDraftTimer);
  itemsDraftTimer = setTimeout(() => {
    try { localStorage.setItem(itemsDraftKey(itemsDraftFormKey), JSON.stringify(currentItems)); } catch {}
  }, 500);
}

function hasItemsDraft(formKey) {
  try {
    const raw = localStorage.getItem(itemsDraftKey(formKey));
    if (!raw) return false;
    const rows = JSON.parse(raw);
    return Array.isArray(rows) && rows.some(r => r.product_name);
  } catch { return false; }
}

function restoreItemsFromDraft(formKey) {
  try {
    const raw = localStorage.getItem(itemsDraftKey(formKey));
    if (!raw) return;
    const rows = JSON.parse(raw);
    if (Array.isArray(rows) && rows.length) {
      currentItems = rows.map(r => ({ ...r, rowId: 'row' + (++itemsRowSeq) }));
      renderItemsTable();
      computeInvoiceRollups();
    }
  } catch {}
}

function clearItemsDraft(formKey) {
  localStorage.removeItem(itemsDraftKey(formKey));
}

// ── Save orchestration ───────────────────────────────
// Header upsert + line-item replace + stock delta all happen in ONE
// Postgres transaction server-side now (server/routes/invoices.js),
// with the touched products row-locked (SELECT ... FOR UPDATE) for real
// race-safety — the in-memory read-then-write loop this used to be
// couldn't offer that. Signature and return value (invoiceId on
// success, false on failure) are unchanged, so every caller
// (js/invoice-entry.js, js/b2c.js, js/gstr1.js) needs no changes.
async function saveInvoiceWithItems(type, headerBase, editId, userId) {
  if (!validateInvoiceItems()) return false;

  const header = { ...headerBase, ...computeInvoiceRollups() };
  const items = currentItems
    .filter(r => r.product_name && r.taxable_value >= 0)
    .map(r => ({
      product_id: r.product_id, product_name: r.product_name, hsn_code: r.hsn_code, unit: r.unit,
      quantity: r.quantity, rate: r.rate, discount_percentage: r.discount_percentage, gst_percentage: r.gst_percentage,
      taxable_value: r.taxable_value, gst_amount: r.gst_amount, igst: r.igst, cgst: r.cgst, sgst: r.sgst,
      total_amount: r.total_amount
    }));

  try {
    const { invoiceId } = await apiFetch(`/invoices/${type}/save-with-items`, {
      method: 'POST',
      body: JSON.stringify({ editId, header, items })
    });
    return invoiceId;
  } catch (error) {
    showToast('Error: ' + (error.message || 'save failed'), 'error');
    return false;
  }
}

// ── Cascade delete / restore (invoked from gstr1.js, b2c.js,
// invoice-list.js, recycle-bin.js on delete/restore of a header row) ──
// Stock adjustment + invoice_items + HSN soft/hard-delete-or-restore all
// happen in one Postgres transaction server-side now — same signatures,
// same call sites, no changes needed there.
async function cascadeInvoiceItemsDelete(type, invoiceId) {
  try {
    await apiFetch(`/invoices/${type}/${invoiceId}/cascade-delete`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade delete failed'), 'error');
  }
}

async function cascadeInvoiceItemsRestore(type, invoiceId) {
  try {
    await apiFetch(`/invoices/${type}/${invoiceId}/cascade-restore`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade restore failed'), 'error');
  }
}

async function cascadeInvoiceItemsHardDelete(type, invoiceId) {
  try {
    await apiFetch(`/invoices/${type}/${invoiceId}/cascade-hard-delete`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade hard-delete failed'), 'error');
  }
}
