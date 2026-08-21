// =============================================
// E-Way Bills — internal transport documents
//
// One record per transport movement, linked to the invoice being shipped.
// The user picks an invoice; everything commercial (customer, GSTIN,
// address, line items, taxes, totals) is read from that invoice and shown
// read-only. The only thing entered here is transport detail.
//
// Deliberately NOT an official E-Way Bill. Nothing in this module contacts
// the NIC portal, and the printed document says so on its face. The
// ewb_number / ewb_date / valid_until / status columns exist from day one
// so a future NIC integration updates this same row in place — the print
// layout already reads them and shows "Not Generated" while they are empty.
//
// The invoice's own transport_* columns are left completely alone, as is
// the invoice PDF (js/invoice-pdf.js is not touched or used here).
// =============================================

let ewbUserId = null;
let ewbInvoices = [];        // b2b + b2c, for the invoice picker
let ewbSelectedInvoice = null;
let ewbSelectedItems = [];
let ewbAllData = [];
let ewbPage = 1;
const EWB_PAGE_SIZE = 15;

async function initEwayBills() {
  const user = await requireAuth();
  if (!user) return;
  ewbUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);
  await Promise.all([loadEwbInvoicesList(user.id), loadEwayBills(user.id)]);

  // Deep link from elsewhere in the app: ?invoice=<id>&type=<b2b|b2c>
  const params = new URLSearchParams(location.search);
  const invId = params.get('invoice'), invType = params.get('type');
  if (invId && invType) {
    const match = ewbInvoices.find(i => i.id === invId && i.type === invType);
    if (match) { setEwbValue('ewbInvoiceSearch', match.invoice_number); await selectEwbInvoice(match); }
  }
}

function setEwbValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }
function getEwbText(id) { return document.getElementById(id)?.value?.trim() || ''; }
function escEwb(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── Invoice picker ───────────────────────────────────
// Both invoice tables, unioned the same way Invoice List does it, so a
// number from either can be selected.
async function loadEwbInvoicesList(userId) {
  // Half a picker is worse than none: the invoice someone is looking for
  // would simply not be listed, reading as "that invoice doesn't exist".
  const rows = await readAll([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId)
  ], 'Could not load the invoice list');
  if (!rows) return;
  const [b2b, b2c] = rows;
  ewbInvoices = [
    ...b2b.map(r => ({ ...r, type: 'b2b' })),
    ...b2c.map(r => ({ ...r, type: 'b2c', invoice_number: r.invoice_number || ('B2C-' + r.id.slice(0, 8).toUpperCase()) }))
  ].sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));

  const dl = document.getElementById('ewbInvoiceDatalist');
  if (dl) dl.innerHTML = ewbInvoices.map(i =>
    `<option value="${escEwb(i.invoice_number)}">${escEwb(i.customer_name)} &middot; ${formatDate(i.invoice_date)}</option>`).join('');
}

async function onEwbInvoiceInput() {
  const num = getEwbText('ewbInvoiceSearch');
  const match = ewbInvoices.find(i => (i.invoice_number || '').toLowerCase() === num.toLowerCase());
  if (match) await selectEwbInvoice(match);
  else clearEwbInvoiceSelection();
}

function clearEwbInvoiceSelection() {
  ewbSelectedInvoice = null;
  ewbSelectedItems = [];
  document.getElementById('ewbInvoicePanel')?.classList.add('d-none');
  const badge = document.getElementById('ewbStatusBadge');
  if (badge) badge.innerHTML = '<span class="badge" style="background:#eceff1;color:#546e7a;">No invoice selected</span>';
}

// Loads the invoice's commercial data. All of it is display-only here —
// nothing on the invoice is ever written back by this module.
async function selectEwbInvoice(inv) {
  ewbSelectedInvoice = inv;
  const itemRead = await readAll([
    _supabase.from('invoice_items').select('*').eq('invoice_id', inv.id).eq('invoice_type', inv.type)
  ], 'Could not load the invoice line items');
  if (!itemRead) return;
  ewbSelectedItems = itemRead[0].sort((a, b) => (+a.sort_order || 0) - (+b.sort_order || 0));

  document.getElementById('ewbInvoicePanel')?.classList.remove('d-none');
  const badge = document.getElementById('ewbStatusBadge');
  if (badge) badge.innerHTML = '<span class="badge badge-orange">Not Generated</span>' +
    ' <span class="fs-11 text-muted-sm">no official EWB number yet</span>';

  // Invoices carry a single address; there is no separate shipping address
  // column, so Dispatch From / Dispatch To below are the transport route
  // and are entered by the user.
  const row = (k, v) => `<div class="calc-row"><span class="label">${k}</span><span class="value">${v}</span></div>`;
  const summary = document.getElementById('ewbInvoiceSummary');
  if (summary) summary.innerHTML =
    row('Invoice Number', escEwb(inv.invoice_number)) +
    row('Invoice Date', formatDate(inv.invoice_date)) +
    row('Type', `<span class="badge ${inv.type === 'b2b' ? 'badge-blue' : 'badge-green'}">${inv.type.toUpperCase()}</span>`) +
    row('Customer', escEwb(inv.customer_name)) +
    row('Customer GSTIN', escEwb(inv.gst_number) || '&mdash;') +
    row('Billing Address', escEwb([inv.address, inv.state].filter(Boolean).join(', ')) || '&mdash;') +
    row('Taxable Value', '₹' + formatNum(inv.taxable_amount)) +
    row('GST', '₹' + formatNum(inv.gst_amount)) +
    `<div class="calc-row total"><span class="label">Grand Total</span><span class="value">₹${formatNum(inv.total_amount)}</span></div>`;

  const tbody = document.getElementById('ewbItemsBody');
  if (tbody) tbody.innerHTML = ewbSelectedItems.length
    ? ewbSelectedItems.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escEwb(it.product_name)}</td>
        <td>${escEwb(it.hsn_code) || '&mdash;'}</td>
        <td style="text-align:center;">${formatNum(it.quantity)}</td>
        <td style="text-align:right;">₹${formatNum(it.taxable_value)}</td>
        <td style="text-align:right;">₹${formatNum(it.gst_amount)}</td>
        <td style="text-align:right;font-weight:700;">₹${formatNum(it.total_amount)}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty-state">This invoice has no line items.</td></tr>';

  const tfoot = document.getElementById('ewbItemsTotal');
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="4" style="font-weight:700;">TOTALS (${ewbSelectedItems.length})</td>
    <td style="text-align:right;font-weight:700;">₹${formatNum(inv.taxable_amount)}</td>
    <td style="text-align:right;font-weight:700;">₹${formatNum(inv.gst_amount)}</td>
    <td style="text-align:right;font-weight:700;">₹${formatNum(inv.total_amount)}</td></tr>`;
}

// ── Save ─────────────────────────────────────────────
async function saveEwayBill() {
  if (!ewbSelectedInvoice) { showToast('Select an invoice first.', 'error'); return; }
  const gstin = getEwbText('ewbTransporterGstin');
  // Same GSTIN rule the rest of the app applies — optional, but if entered
  // it must be genuinely valid.
  if (gstin && !validateGstin(gstin).valid) {
    showToast('Transporter GSTIN is invalid — correct it (or clear it) before saving.', 'error'); return;
  }

  const btn = document.getElementById('ewbSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const payload = {
      user_id: ewbUserId,
      invoice_id: ewbSelectedInvoice.id,
      invoice_type: ewbSelectedInvoice.type,
      invoice_number: ewbSelectedInvoice.invoice_number,
      invoice_date: ewbSelectedInvoice.invoice_date || null,
      vehicle_number: getEwbText('ewbVehicleNo').toUpperCase(),
      transporter_name: getEwbText('ewbTransporter'),
      transport_mode: document.getElementById('ewbTransportMode')?.value || '',
      transport_distance_km: parseFloat(getEwbText('ewbDistance')) || null,
      lr_number: getEwbText('ewbLrNumber'),
      lr_date: getEwbText('ewbLrDate') || null,
      transporter_gstin: gstin,
      vehicle_type: document.getElementById('ewbVehicleType')?.value || '',
      dispatch_from: getEwbText('ewbDispatchFrom'),
      dispatch_to: getEwbText('ewbDispatchTo')
      // ewb_number / ewb_date / valid_until / status are deliberately not
      // sent: status defaults to 'not_generated' and only a future NIC
      // integration should ever set them.
    };
    const { error } = await _supabase.from('eway_bills').insert(payload);
    if (error) { handleApiError(error, 'Could not save the transport document'); return; }
    showToast('Transport document saved.', 'success');
    resetEwayBillForm();
    await loadEwayBills(ewbUserId);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetEwayBillForm() {
  ['ewbInvoiceSearch','ewbVehicleNo','ewbTransporter','ewbTransporterGstin','ewbDistance',
   'ewbLrNumber','ewbLrDate','ewbDispatchFrom','ewbDispatchTo'].forEach(id => setEwbValue(id, ''));
  setEwbValue('ewbTransportMode', '');
  setEwbValue('ewbVehicleType', '');
  clearEwbInvoiceSelection();
}

// ── List ─────────────────────────────────────────────
async function loadEwayBills(userId) {
  const { data, error } = await _supabase.from('eway_bills').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false });
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the transport documents'); return; }
  ewbAllData = data || [];
  ewbPage = 1;
  renderEwbTable();
}

const EWB_STATUS_LABEL = { not_generated: 'Not Generated', generated: 'Generated', cancelled: 'Cancelled', expired: 'Expired' };
const EWB_STATUS_BADGE = { not_generated: 'badge-orange', generated: 'badge-green', cancelled: 'badge-red', expired: 'badge-red' };
function ewbStatusKey(s) { return EWB_STATUS_LABEL[s] ? s : 'not_generated'; }

function renderEwbTable() {
  const tbody = document.getElementById('ewbTableBody');
  if (!tbody) return;
  if (!ewbAllData.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><i class="fas fa-truck-fast" style="display:block;font-size:36px;margin-bottom:10px;"></i>No transport documents yet — select an invoice above to create one.</td></tr>';
    renderEwbPagination(0);
    return;
  }
  const start = (ewbPage - 1) * EWB_PAGE_SIZE;
  const page = ewbAllData.slice(start, start + EWB_PAGE_SIZE);
  tbody.innerHTML = page.map((r, i) => {
    const k = ewbStatusKey(r.status);
    return `
    <tr>
      <td>${start + i + 1}</td>
      <td class="fw-600">${escEwb(r.invoice_number)} <span class="badge ${r.invoice_type === 'b2b' ? 'badge-blue' : 'badge-green'}" style="font-size:9px;">${(r.invoice_type || '').toUpperCase()}</span></td>
      <td>${formatDate(r.invoice_date)}</td>
      <td>${escEwb(r.vehicle_number) || '&mdash;'}</td>
      <td>${escEwb(r.transporter_name) || '&mdash;'}</td>
      <td>${escEwb(r.lr_number) || '&mdash;'}</td>
      <td style="text-align:right;">${r.transport_distance_km ? formatNum(r.transport_distance_km) + ' KM' : '&mdash;'}</td>
      <td>${escEwb(r.ewb_number) || '<span class="text-muted-sm">Not Generated</span>'}</td>
      <td><span class="badge ${EWB_STATUS_BADGE[k]}">${EWB_STATUS_LABEL[k]}</span></td>
      <td>
        <div class="action-btns">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="printTransportDocument('${r.id}')" title="Print Transport Document"><i class="fas fa-print"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="deleteEwayBill('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
  renderEwbPagination(ewbAllData.length);
}

function renderEwbPagination(total) {
  const container = document.getElementById('ewbPagination');
  if (!container) return;
  const pages = Math.ceil(total / EWB_PAGE_SIZE);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="gotoEwbPage(${ewbPage - 1})" ${ewbPage === 1 ? 'disabled' : ''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) html += `<button class="page-btn ${i === ewbPage ? 'active' : ''}" onclick="gotoEwbPage(${i})">${i}</button>`;
  html += `<button class="page-btn" onclick="gotoEwbPage(${ewbPage + 1})" ${ewbPage === pages ? 'disabled' : ''}>&#8250;</button>`;
  container.innerHTML = html;
}
function gotoEwbPage(p) { ewbPage = p; renderEwbTable(); }

async function deleteEwayBill(id) {
  const ok = await showConfirm('Delete this transport document? The invoice itself is not affected.');
  if (!ok) return;
  const { error } = await _supabase.from('eway_bills').delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the transport document'); return; }
  showToast('Transport document deleted.');
  await loadEwayBills(ewbUserId);
}

// ── Printable Internal Transport Document ────────────
// Own layout and branding — deliberately NOT a copy of the NIC form. The
// disclaimer and the "Not Generated" placeholders are load-bearing: they
// are what keep this from reading as a statutory document. When a NIC
// integration later fills ewb_number/ewb_date/valid_until/status on this
// same row, the values below render automatically with no change here.
async function printTransportDocument(id) {
  const rec = ewbAllData.find(r => r.id === id);
  if (!rec) { showToast('Transport document not found.', 'error'); return; }

  const inv = ewbInvoices.find(i => i.id === rec.invoice_id && i.type === rec.invoice_type);
  // Printed onto the transport document that travels with the goods —
  // printing it with no lines on it is worse than not printing it.
  const itemRead = await readAll([
    _supabase.from('invoice_items').select('*').eq('invoice_id', rec.invoice_id).eq('invoice_type', rec.invoice_type)
  ], 'Could not load the invoice line items');
  if (!itemRead) return;
  const lines = itemRead[0].sort((a, b) => (+a.sort_order || 0) - (+b.sort_order || 0));
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;

  const notGen = '<span style="color:#b26a00;">Not Generated</span>';
  const k = ewbStatusKey(rec.status);
  const w = window.open('', '_blank');
  w.document.write(buildTransportDocHTML({ rec, inv, lines, profile, notGen, statusLabel: EWB_STATUS_LABEL[k] }));
  w.document.close();
  showToast('Print dialog opened!');
}

function buildTransportDocHTML({ rec, inv, lines, profile, notGen, statusLabel }) {
  const cell = (k, v) => `<tr><td class="k">${k}</td><td class="v">${v || '&mdash;'}</td></tr>`;
  const totals = lines.reduce((a, it) => ({
    taxable: a.taxable + (+it.taxable_value || 0),
    gst: a.gst + (+it.gst_amount || 0),
    total: a.total + (+it.total_amount || 0)
  }), { taxable: 0, gst: 0, total: 0 });

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Internal Transport Document — ${escEwb(rec.invoice_number)}</title>
<style>
  *{box-sizing:border-box;} body{font-family:Segoe UI,Arial,sans-serif;color:#212121;margin:0;padding:28px;font-size:12px;}
  .doc{max-width:820px;margin:0 auto;border:1px solid #cfd8dc;border-radius:8px;overflow:hidden;}
  .hd{background:#00695c;color:#fff;padding:18px 22px;}
  .hd h1{margin:0;font-size:19px;letter-spacing:.3px;}
  .hd .sub{font-size:12px;opacity:.9;margin-top:3px;}
  .biz{padding:14px 22px;border-bottom:1px solid #eceff1;font-size:12px;}
  .biz b{font-size:14px;}
  .warn{background:#fff8e1;border-top:1px solid #ffe082;border-bottom:1px solid #ffe082;
        color:#6d4c00;padding:11px 22px;font-size:11.5px;line-height:1.5;}
  .sec{padding:14px 22px;} .sec h2{font-size:12.5px;margin:0 0 8px;color:#00695c;
        text-transform:uppercase;letter-spacing:.6px;border-bottom:1px solid #eceff1;padding-bottom:5px;}
  table{width:100%;border-collapse:collapse;}
  .kv td{padding:4px 0;vertical-align:top;} .kv .k{color:#607d8b;width:42%;}
  .kv .v{font-weight:600;}
  .grid{display:flex;gap:26px;} .grid>div{flex:1;}
  .items th{background:#f5f7f8;text-align:left;padding:7px 8px;font-size:11px;border-bottom:1px solid #e0e0e0;}
  .items td{padding:7px 8px;border-bottom:1px solid #f0f0f0;}
  .r{text-align:right;} .c{text-align:center;}
  .tot td{font-weight:700;border-top:2px solid #00695c;}
  .ft{padding:14px 22px;border-top:1px solid #eceff1;color:#78909c;font-size:10.5px;display:flex;justify-content:space-between;gap:18px;}
  .sign{margin-top:26px;text-align:right;font-size:11px;}
  @media print{body{padding:0;} .doc{border:none;}}
</style></head><body>
<div class="doc">

  <div class="hd">
    <h1>Internal Transport Document</h1>
    <div class="sub">Prepared from Invoice Data for Transport Reference</div>
  </div>

  <div class="biz">
    <b>${escEwb(profile?.business_name || profile?.name || 'Business')}</b><br>
    ${escEwb(profile?.address || '')}${profile?.state ? ', ' + escEwb(profile.state) : ''}<br>
    ${profile?.gstin ? 'GSTIN: ' + escEwb(profile.gstin) : ''}
  </div>

  <div class="warn">
    <b>This document is generated for internal transport reference only.
    It is not an official NIC E-Way Bill.</b>
  </div>

  <div class="sec">
    <h2>E-Way Bill Reference</h2>
    <div class="grid">
      <div><table class="kv">
        ${cell('EWB Number', rec.ewb_number ? escEwb(rec.ewb_number) : notGen)}
        ${cell('EWB Date', rec.ewb_date ? formatDate(rec.ewb_date) : notGen)}
      </table></div>
      <div><table class="kv">
        ${cell('Valid Until', rec.valid_until ? formatDate(rec.valid_until) : notGen)}
        ${cell('Status', escEwb(statusLabel))}
      </table></div>
    </div>
  </div>

  <div class="sec">
    <h2>Invoice &amp; Customer</h2>
    <div class="grid">
      <div><table class="kv">
        ${cell('Invoice Number', escEwb(rec.invoice_number))}
        ${cell('Invoice Date', formatDate(rec.invoice_date))}
        ${cell('Invoice Type', (rec.invoice_type || '').toUpperCase())}
      </table></div>
      <div><table class="kv">
        ${cell('Customer', escEwb(inv?.customer_name))}
        ${cell('Customer GSTIN', escEwb(inv?.gst_number))}
        ${cell('Billing Address', escEwb([inv?.address, inv?.state].filter(Boolean).join(', ')))}
      </table></div>
    </div>
  </div>

  <div class="sec">
    <h2>Transport Details</h2>
    <div class="grid">
      <div><table class="kv">
        ${cell('Vehicle Number', escEwb(rec.vehicle_number))}
        ${cell('Vehicle Type', escEwb(rec.vehicle_type))}
        ${cell('Transporter', escEwb(rec.transporter_name))}
        ${cell('Transporter GSTIN', escEwb(rec.transporter_gstin))}
        ${cell('Transport Mode', escEwb(rec.transport_mode))}
      </table></div>
      <div><table class="kv">
        ${cell('Distance', rec.transport_distance_km ? formatNum(rec.transport_distance_km) + ' KM' : '')}
        ${cell('LR Number', escEwb(rec.lr_number))}
        ${cell('LR Date', rec.lr_date ? formatDate(rec.lr_date) : '')}
        ${cell('Dispatch From', escEwb(rec.dispatch_from))}
        ${cell('Dispatch To', escEwb(rec.dispatch_to))}
      </table></div>
    </div>
  </div>

  <div class="sec">
    <h2>Goods</h2>
    <table class="items">
      <thead><tr><th>#</th><th>Product</th><th>HSN</th><th class="c">Qty</th>
                 <th class="r">Taxable</th><th class="r">GST</th><th class="r">Total</th></tr></thead>
      <tbody>
        ${lines.map((it, i) => `<tr>
          <td>${i + 1}</td><td>${escEwb(it.product_name)}</td><td>${escEwb(it.hsn_code)}</td>
          <td class="c">${formatNum(it.quantity)}</td>
          <td class="r">₹${formatNum(it.taxable_value)}</td>
          <td class="r">₹${formatNum(it.gst_amount)}</td>
          <td class="r">₹${formatNum(it.total_amount)}</td></tr>`).join('')}
        <tr class="tot"><td colspan="4">TOTAL</td>
          <td class="r">₹${formatNum(totals.taxable)}</td>
          <td class="r">₹${formatNum(totals.gst)}</td>
          <td class="r">₹${formatNum(totals.total)}</td></tr>
      </tbody>
    </table>
    <div class="sign">For ${escEwb(profile?.business_name || profile?.name || 'Business')}<br><br><br>Authorised Signatory</div>
  </div>

  <div class="ft">
    <span>Internal transport reference &mdash; not an official NIC E-Way Bill.</span>
    <span>Generated ${formatDate(new Date())}</span>
  </div>
</div>
<script>window.onload = function(){ window.print(); };<\/script>
</body></html>`;
}
