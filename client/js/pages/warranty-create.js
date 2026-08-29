// =============================================
// Create warranties from an invoice
// =============================================
// One record per warranted LINE, never one per invoice: an invoice selling
// three items with three different periods produces three records with three
// different expiry dates, and a single generic record would hide exactly the
// date the customer needs.
//
// Lines sold without cover produce nothing at all - a warranty is only ever
// created because someone chose to create it, so opening this dialog and
// closing it leaves the database untouched.
//
// Nothing here writes to the invoice. The register is downstream of the sale:
// no total, tax figure, ledger entry or invoice number moves.
let wcInvoice = null;
let wcType = null;
let wcLines = [];
let wcExisting = [];

function ensureCreateWarrantyModal() {
  if (document.getElementById('createWarrantyModal')) return;
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'createWarrantyModal';
  el.innerHTML = `
    <div class="modal modal-lg">
      <div class="modal-header">
        <span class="modal-title"><i class="fas fa-shield-halved"></i> Create Warranty</span>
        <button type="button" class="modal-close" onclick="closeCreateWarranty()" aria-label="Close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div id="wcBody"></div>
      </div>
      <div class="modal-footer d-flex gap-10">
        <button type="button" class="btn btn-secondary" onclick="closeCreateWarranty()">Cancel</button>
        <button type="button" class="btn btn-primary" id="wcSaveBtn" onclick="saveWarrantiesFromInvoice()">
          <i class="fas fa-shield-halved"></i> Create warranties</button>
      </div>
    </div>`;
  document.body.appendChild(el);
}

function closeCreateWarranty() {
  const el = document.getElementById('createWarrantyModal');
  if (el) el.classList.remove('active');
}

async function openCreateWarranty(type, invoiceId) {
  const user = await getCurrentUser();
  if (!user) return;
  ensureCreateWarrantyModal();
  wcType = type;

  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const read = await readAll([
    _supabase.from(table).select('*').eq('id', invoiceId),
    _supabase.from('invoice_items').select('*').eq('invoice_id', invoiceId),
    _supabase.from('warranties').select('*').eq('invoice_id', invoiceId)
  ], 'Could not load the invoice');
  if (!read) return;

  wcInvoice = (read[0] || [])[0] || null;
  if (!wcInvoice) { showToast('Invoice not found.', 'error'); return; }
  wcExisting = read[2] || [];

  // Only lines that actually carry cover. A line with no warranty is not
  // offered, because there is nothing to promise about it.
  const items = (read[1] || []).filter(it => String(it.invoice_type || type) === type);
  wcLines = items
    .filter(it => parseInt(it.warranty_period_months, 10) > 0)
    .map(it => {
      const already = wcExisting.find(w => w.invoice_item_id === it.id);
      const start = wcInvoice.invoice_date ? String(wcInvoice.invoice_date).slice(0, 10) : '';
      const months = parseInt(it.warranty_period_months, 10);
      return {
        item: it,
        already: already || null,
        selected: !already,
        serial: already ? (already.serial_number || '') : '',
        months,
        start: already ? String(already.warranty_start_date || start).slice(0, 10) : start,
        until: already ? String(already.warranty_until || '').slice(0, 10) : warrantyUntil(start, months),
        terms: already ? (already.warranty_terms || '') : (wcInvoice.warranty_terms || '')
      };
    });

  renderCreateWarrantyBody();
  document.getElementById('createWarrantyModal').classList.add('active');
}

function renderCreateWarrantyBody() {
  const body = document.getElementById('wcBody');
  const saveBtn = document.getElementById('wcSaveBtn');
  if (!wcLines.length) {
    body.innerHTML = '<p class="text-muted-sm">No product on this invoice has a warranty period, '
      + 'so there is nothing to register. Set a warranty on the product line in Invoice Entry first.</p>';
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  if (saveBtn) saveBtn.disabled = false;

  body.innerHTML = `
    <p class="text-muted-sm">Invoice <b>${escItemHtml(wcInvoice.invoice_number || '')}</b>
      &middot; ${escItemHtml(wcInvoice.customer_name || '')}</p>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr><th style="width:36px;"></th><th>Product</th><th class="text-center">Qty</th>
            <th>Warranty</th><th>Start</th><th>Valid Until</th><th>Serial Number</th></tr>
        </thead>
        <tbody>
          ${wcLines.map((l, i) => `
            <tr>
              <td>${l.already
                ? '<i class="fas fa-check text-success" title="Already registered"></i>'
                : `<input type="checkbox" ${l.selected ? 'checked' : ''} onchange="wcToggle(${i}, this.checked)">`}</td>
              <td><b>${escItemHtml(l.item.product_name || '')}</b>
                ${l.already ? `<div class="fs-11 text-muted-sm">Already registered as ${escItemHtml(l.already.warranty_number)}</div>` : ''}</td>
              <td class="text-center">${formatNum(l.item.quantity)}</td>
              <td>${escItemHtml(warrantyLabel(l.months))}</td>
              <td><input type="date" class="form-control" value="${escHtmlAttr(l.start)}"
                    ${l.already ? 'disabled' : ''} onchange="wcSetStart(${i}, this.value)"></td>
              <td><input type="date" class="form-control" value="${escHtmlAttr(l.until)}"
                    ${l.already ? 'disabled' : ''} onchange="wcSetUntil(${i}, this.value)"></td>
              <td><input type="text" class="form-control" value="${escHtmlAttr(l.serial)}"
                    ${l.already ? 'disabled' : ''} placeholder="optional"
                    onchange="wcSetSerial(${i}, this.value)"></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="form-group mt-20">
      <label for="wcTerms">Warranty Terms (applied to the records created now)</label>
      <textarea id="wcTerms" class="form-control" rows="2"
        onchange="wcSetTerms(this.value)">${escItemHtml(wcLines[0].terms || '')}</textarea>
    </div>
    ${wcLines.some(l => l.already)
      ? '<p class="fs-11 text-muted-sm">Lines already registered are shown for reference and cannot be created twice.</p>'
      : ''}`;
}

function wcToggle(i, on) { wcLines[i].selected = !!on; }
function wcSetSerial(i, v) { wcLines[i].serial = v.trim(); }
function wcSetTerms(v) { wcLines.forEach(l => { if (!l.already) l.terms = v; }); }
function wcSetStart(i, v) {
  wcLines[i].start = v;
  // Re-derive the end date from the period, the same rule the invoice uses.
  wcLines[i].until = warrantyUntil(v, wcLines[i].months);
  renderCreateWarrantyBody();
}
function wcSetUntil(i, v) { wcLines[i].until = v; }   // typed by hand: kept as given

async function saveWarrantiesFromInvoice() {
  const user = await getCurrentUser();
  if (!user) return;
  const chosen = wcLines.filter(l => l.selected && !l.already);
  if (!chosen.length) { showToast('Select at least one product.', 'error'); return; }

  const bad = chosen.find(l => l.start && l.until && l.until < l.start);
  if (bad) { showToast('Valid Until cannot be before the start date.', 'error'); return; }

  const btn = document.getElementById('wcSaveBtn');
  if (btn) btn.disabled = true;
  const made = [];
  try {
    for (const l of chosen) {
      // One number per record, drawn from the warranty book - never from the
      // invoice series, which must not be consumed by a warranty.
      const res = await apiFetch('/documents/reserve-number', {
        method: 'POST', body: JSON.stringify({ documentType: 'warranty' })
      });
      const number = res && res.documentNumber;
      if (!number) throw new Error('Could not issue a warranty number.');

      await _supabase.from('warranties').insert({
        warranty_number: number,
        document_series: 'warranty',
        invoice_id: wcInvoice.id,
        invoice_type: wcType,
        invoice_item_id: l.item.id,
        invoice_number: wcInvoice.invoice_number || null,
        invoice_date: wcInvoice.invoice_date || null,
        customer_id: wcInvoice.customer_id || null,
        customer_name: wcInvoice.customer_name || '',
        customer_phone: wcInvoice.phone || null,
        product_id: l.item.product_id || null,
        product_name: l.item.product_name || '',
        product_sku: l.item.hsn_code || null,
        serial_number: l.serial || null,
        quantity: +l.item.quantity || 1,
        rate: +l.item.rate || 0,
        purchase_amount: +l.item.total_amount || 0,
        purchase_date: wcInvoice.invoice_date || null,
        warranty_period_months: l.months,
        warranty_start_date: l.start || null,
        warranty_until: l.until || null,
        warranty_terms: l.terms || null,
        status: 'active'
      });
      made.push(number);
    }
    closeCreateWarranty();
    showToast(made.length === 1
      ? `Warranty ${made[0]} created.`
      : `${made.length} warranties created (${made[0]} – ${made[made.length - 1]}).`, 'success');
  } catch (err) {
    handleApiError(err, 'Could not create the warranty');
  } finally {
    if (btn) btn.disabled = false;
  }
}
