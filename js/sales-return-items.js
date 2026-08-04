// =============================================
// Sales Return Line Items — unlike Purchase Items (free product entry),
// Sales Return items are always sourced FROM an existing invoice's own
// line items: the table shows every product that was actually sold on
// the selected invoice, each row capped at how many units are left to
// return (originally sold minus whatever this same edit session has
// already returned elsewhere — see loadOriginalInvoiceItems()). A
// return quantity of 0 excludes that line entirely, so "full return"
// is just every row left at its max and "partial return" is any mix of
// lower quantities — the same table drives both. Fresh module, no
// existing file touched.
// =============================================

let srItems = [];
let srRowSeq = 0;

function initSalesReturnItems() {
  renderSrItemsSectionShell('srItemsSection');
}

function getSrSupplyType() {
  return document.getElementById('srSupply')?.value || 'intrastate';
}

// ── Shell markup ──────────────────────────────────
function renderSrItemsSectionShell(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="d-flex align-center gap-10 mb-14">
      <div class="section-title" style="margin:0;">Products</div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="setAllSrReturnQty(true)"><i class="fas fa-check-double"></i> Full Return (all items)</button>
      <button type="button" class="btn btn-secondary btn-sm" onclick="setAllSrReturnQty(false)"><i class="fas fa-times"></i> Clear All</button>
    </div>
    <div class="table-wrapper mb-16">
      <table class="data-table" id="srItemsTable">
        <thead>
          <tr>
            <th class="text-center" style="min-width:64px;">Return</th>
            <th class="min-w-280">Product</th>
            <th style="min-width:90px;">HSN</th>
            <th style="min-width:70px;">Unit</th>
            <th class="text-center" style="min-width:80px;">Sold Qty</th>
            <th class="text-right" style="min-width:90px;">Rate (&#8377;)</th>
            <th class="text-center" style="min-width:100px;">Return Qty</th>
            <th class="text-right" style="min-width:110px;">Taxable Value</th>
            <th class="text-right" style="min-width:110px;">Total</th>
          </tr>
        </thead>
        <tbody id="srItemsTableBody"></tbody>
      </table>
    </div>

    <div class="calc-box mb-20">
      <div class="calc-row">
        <span class="label">Subtotal (Taxable Value)</span>
        <span class="value"><input type="text" id="srItemsSubtotal" class="form-control calc-input-sm" readonly aria-label="Subtotal"></span>
      </div>
      <div class="calc-row">
        <span class="label">GST Amount</span>
        <div class="calc-tax-row">
          <span class="text-muted-sm">IGST: <b id="srItemsIGST">0.00</b></span>
          <span class="text-muted-sm">CGST: <b id="srItemsCGST">0.00</b></span>
          <span class="text-muted-sm">SGST: <b id="srItemsSGST">0.00</b></span>
        </div>
        <span class="value"><input type="text" id="srItemsGstAmt" class="form-control calc-input-sm" readonly aria-label="GST Amount"></span>
      </div>
      <div class="calc-row total">
        <span class="label">Grand Total (Return Amount)</span>
        <span class="value"><input type="text" id="srItemsGrandTotal" class="form-control calc-input-total" readonly aria-label="Grand Total"></span>
      </div>
      <div class="calc-row">
        <span class="label">Amount in Words</span>
        <span class="value fs-12 text-muted-sm text-right" id="srItemsAmountWords"></span>
      </div>
    </div>
  `;
}

// invoiceItems: active line items from the selected original invoice.
// alreadyReturnedByProduct: { [product_id]: qty } already returned by
// OTHER non-deleted sales returns against this same invoice, so this
// session can't return more than what's genuinely still outstanding.
function loadOriginalInvoiceItems(invoiceItems, alreadyReturnedByProduct) {
  alreadyReturnedByProduct = alreadyReturnedByProduct || {};
  srItems = (invoiceItems || []).map(it => {
    srRowSeq++;
    const alreadyReturned = it.product_id ? (+alreadyReturnedByProduct[it.product_id] || 0) : 0;
    const maxQty = Math.max(0, round2((+it.quantity || 0) - alreadyReturned));
    return {
      rowId: 'srow' + srRowSeq,
      product_id: it.product_id || null,
      product_name: it.product_name,
      hsn_code: it.hsn_code || '',
      unit: it.unit || '',
      original_qty: +it.quantity || 0,
      max_qty: maxQty,
      rate: +it.rate || 0,
      discount_percentage: +it.discount_percentage || 0,
      gst_percentage: +it.gst_percentage || 0,
      // Nothing is returned until the user says so. Previously every row
      // sat there with an editable Return Qty box and no indication of
      // which products were actually part of the return; the checkbox
      // makes that choice explicit, and `selected` is what decides
      // whether a row counts towards the totals or the save.
      selected: false,
      return_qty: 0,
      taxable_value: 0, gst_amount: 0, igst: 0, cgst: 0, sgst: 0, total_amount: 0
    };
  });
  renderSrItemsTable();
  computeSrRollups();
}

// Pre-fills return_qty on each row from an existing sales return's own
// saved items (Edit mode) — capped at max_qty + whatever this specific
// return already accounts for, since editing a return shouldn't be
// blocked by its own prior quantities.
function prefillSrReturnQuantities(savedItems) {
  (savedItems || []).forEach(saved => {
    const row = srItems.find(r => r.product_id === saved.product_id && r.product_name === saved.product_name);
    if (row) {
      row.max_qty = round2(row.max_qty + (+saved.quantity || 0));
      row.return_qty = Math.min(row.max_qty, +saved.quantity || 0);
      // Editing an existing return: a line that was returned is already
      // part of this return, so it loads ticked. Without this the whole
      // table would reopen unchecked and the user would appear to have
      // lost their return.
      row.selected = row.return_qty > 0;
    }
  });
  renderSrItemsTable();
  computeSrRollups();
}

function resetSalesReturnItems() {
  srItems = [];
  renderSrItemsSectionShell('srItemsSection');
}

// ── Render ────────────────────────────────────────
function renderSrItemsTable() {
  const tbody = document.getElementById('srItemsTableBody');
  if (!tbody) return;
  if (!srItems.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Select an invoice above to load its items.</td></tr>';
    return;
  }
  tbody.innerHTML = srItems.map(row => {
    // Nothing left to return on this line — there is no quantity the
    // user could legitimately choose, so the row cannot be selected.
    const exhausted = row.max_qty <= 0;
    const title = exhausted
      ? 'Already fully returned on an earlier sales return'
      : (row.max_qty < row.original_qty ? 'Max returnable: ' + formatNum(row.max_qty) + ' (some already returned)' : '');
    return `
    <tr data-row="${row.rowId}" class="${row.selected ? 'sr-row-selected' : ''}">
      <td class="text-center">
        <input type="checkbox" class="sr-return-check" ${row.selected ? 'checked' : ''} ${exhausted ? 'disabled' : ''}
          onchange="onSrRowToggle('${row.rowId}', this.checked)"
          title="${title}"
          aria-label="Return ${escItemHtml(row.product_name)}">
      </td>
      <td><b>${escItemHtml(row.product_name)}</b></td>
      <td>${escItemHtml(row.hsn_code) || '&mdash;'}</td>
      <td>${escItemHtml(row.unit) || '&mdash;'}</td>
      <td class="text-center">${formatNum(row.original_qty)}</td>
      <td class="text-right">&#8377;${formatNum(row.rate)}</td>
      <td>
        <input type="number" class="form-control text-center sr-return-qty" min="0" max="${row.max_qty}" step="0.001"
          value="${row.return_qty}" ${row.selected ? '' : 'disabled'}
          oninput="onSrReturnQtyChange('${row.rowId}', this.value)"
          aria-label="Return quantity for ${escItemHtml(row.product_name)}"
          title="${title}">
      </td>
      <td class="text-right fw-600 sr-taxable-cell">&#8377;${formatNum(row.taxable_value)}</td>
      <td class="text-right fw-700 sr-total-cell">&#8377;${formatNum(row.total_amount)}</td>
    </tr>`;
  }).join('');
}

// Ticking a row opens it for return and seeds a sensible quantity;
// unticking takes it out of the return entirely.
function onSrRowToggle(rowId, checked) {
  const row = srItems.find(r => r.rowId === rowId);
  if (!row) return;

  if (checked && row.max_qty > 0) {
    row.selected = true;
    // Default to one unit whether one or many were sold — returning a
    // single item is much the commonest case, and with only one sold
    // there is nothing else it could be. Capped for the fractional-unit
    // case (0.5 kg sold), where 1 would exceed what is returnable.
    row.return_qty = Math.min(1, row.max_qty);
  } else {
    row.selected = false;
    row.return_qty = 0;
  }
  recalcSrRow(row);
  renderSrItemsTable();
  computeSrRollups();
}

function onSrReturnQtyChange(rowId, value) {
  const row = srItems.find(r => r.rowId === rowId);
  if (!row || !row.selected) return;   // a disabled input cannot contribute
  let qty = parseFloat(value);
  if (isNaN(qty) || qty < 0) qty = 0;
  if (qty > row.max_qty) qty = row.max_qty;
  row.return_qty = qty;
  recalcSrRow(row);
  computeSrRollups();
}

// Full Return ticks every returnable row and fills each to its maximum;
// Clear All unticks everything and empties the quantities.
function setAllSrReturnQty(full) {
  srItems.forEach(row => {
    const selectable = full && row.max_qty > 0;
    row.selected = selectable;
    row.return_qty = selectable ? row.max_qty : 0;
    recalcSrRow(row);
  });
  renderSrItemsTable();
  computeSrRollups();
}

function recalcSrRow(row) {
  const gross = row.return_qty * row.rate;
  row.taxable_value = round2(gross * (1 - (row.discount_percentage || 0) / 100));
  const calc = calcGST(row.taxable_value, row.gst_percentage || 0, getSrSupplyType());
  row.gst_amount = calc.gstAmount;
  row.igst = calc.igst; row.cgst = calc.cgst; row.sgst = calc.sgst;
  row.total_amount = round2(row.taxable_value + calc.gstAmount);
  updateSrRowComputedCells(row);
}

function updateSrRowComputedCells(row) {
  const tr = document.querySelector(`#srItemsTableBody tr[data-row="${row.rowId}"]`);
  if (!tr) return;
  const taxableCell = tr.querySelector('.sr-taxable-cell');
  const totalCell = tr.querySelector('.sr-total-cell');
  if (taxableCell) taxableCell.textContent = '₹' + formatNum(row.taxable_value);
  if (totalCell) totalCell.textContent = '₹' + formatNum(row.total_amount);
}

// The one definition of "rows in this return": ticked, with a quantity.
// Totals, validation and the save all read from this, so what the user
// sees added up is exactly what gets stored.
function selectedSrRows() {
  return srItems.filter(r => r.selected && r.return_qty > 0);
}

function computeSrRollups() {
  const rows = selectedSrRows();
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
  set('srItemsSubtotal', formatNum(taxable));
  set('srItemsGstAmt', formatNum(gstAmt));
  set('srItemsGrandTotal', formatNum(grandTotal));
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('srItemsIGST', formatNum(igst));
  setTxt('srItemsCGST', formatNum(cgst));
  setTxt('srItemsSGST', formatNum(sgst));
  const wordsEl = document.getElementById('srItemsAmountWords');
  if (wordsEl) wordsEl.textContent = numberToWordsINR(grandTotal);

  return { taxable_amount: taxable, gst_percentage: gstPercentage, gst_amount: gstAmt, igst, cgst, sgst, total_amount: grandTotal, round_off: roundOff };
}

function validateSalesReturnItems() {
  if (!srItems.length) { showToast('Select an invoice to load its items first.', 'error'); return false; }
  if (!selectedSrRows().length) {
    // Names the checkbox, since that is now the action being asked for.
    showToast('Tick the Return checkbox on at least one product.', 'error');
    return false;
  }
  return true;
}

function getSrItemsForSave() {
  return selectedSrRows().map(r => ({
    product_id: r.product_id, product_name: r.product_name, hsn_code: r.hsn_code, unit: r.unit,
    quantity: r.return_qty, rate: r.rate, discount_percentage: r.discount_percentage, gst_percentage: r.gst_percentage,
    taxable_value: r.taxable_value, gst_amount: r.gst_amount, igst: r.igst, cgst: r.cgst, sgst: r.sgst,
    total_amount: r.total_amount
  }));
}

// ── Save orchestration ───────────────────────────────
async function saveSalesReturnWithItems(headerBase, editId) {
  if (!validateSalesReturnItems()) return false;
  const header = { ...headerBase, ...computeSrRollups() };
  const items = getSrItemsForSave();
  try {
    const { id } = await apiFetch('/sales_returns/save-with-items', {
      method: 'POST',
      body: JSON.stringify({ editId, header, items })
    });
    return id;
  } catch (error) {
    showToast('Error: ' + (error.message || 'save failed'), 'error');
    return false;
  }
}

// ── Cascade permanent delete (invoked from sales-returns.js) ──
async function cascadeSalesReturnItemsDelete(id) {
  try {
    await apiFetch(`/sales_returns/${id}/cascade-delete`, { method: 'POST' });
  } catch (error) {
    showToast('Error: ' + (error.message || 'cascade delete failed'), 'error');
  }
}
