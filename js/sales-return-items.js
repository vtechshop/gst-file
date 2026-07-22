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
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Select an invoice above to load its items.</td></tr>';
    return;
  }
  tbody.innerHTML = srItems.map(row => `
    <tr data-row="${row.rowId}">
      <td><b>${escItemHtml(row.product_name)}</b></td>
      <td>${escItemHtml(row.hsn_code) || '&mdash;'}</td>
      <td>${escItemHtml(row.unit) || '&mdash;'}</td>
      <td class="text-center">${formatNum(row.original_qty)}</td>
      <td class="text-right">&#8377;${formatNum(row.rate)}</td>
      <td>
        <input type="number" class="form-control text-center" min="0" max="${row.max_qty}" step="0.001" value="${row.return_qty}"
          oninput="onSrReturnQtyChange('${row.rowId}', this.value)"
          title="${row.max_qty < row.original_qty ? 'Max returnable: ' + formatNum(row.max_qty) + ' (some already returned)' : ''}">
      </td>
      <td class="text-right fw-600 sr-taxable-cell">&#8377;${formatNum(row.taxable_value)}</td>
      <td class="text-right fw-700 sr-total-cell">&#8377;${formatNum(row.total_amount)}</td>
    </tr>`).join('');
}

function onSrReturnQtyChange(rowId, value) {
  const row = srItems.find(r => r.rowId === rowId);
  if (!row) return;
  let qty = parseFloat(value);
  if (isNaN(qty) || qty < 0) qty = 0;
  if (qty > row.max_qty) qty = row.max_qty;
  row.return_qty = qty;
  recalcSrRow(row);
  computeSrRollups();
}

function setAllSrReturnQty(full) {
  srItems.forEach(row => { row.return_qty = full ? row.max_qty : 0; recalcSrRow(row); });
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

function computeSrRollups() {
  const rows = srItems.filter(r => r.return_qty > 0);
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
  const rows = srItems.filter(r => r.return_qty > 0);
  if (!rows.length) { showToast('Enter a return quantity for at least one product.', 'error'); return false; }
  return true;
}

function getSrItemsForSave() {
  return srItems.filter(r => r.return_qty > 0).map(r => ({
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
