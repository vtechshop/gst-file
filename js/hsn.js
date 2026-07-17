// =============================================
// HSN Summary — read-only report
// Generated automatically from B2B/B2C invoice line items
// (js/invoice-items.js). There is no manual HSN entry anywhere in
// the app any more — invoices are the single source of truth.
// Rows saved here in the past (before this became a report) are
// still shown, read-only, as historical entries so no data is lost.
// =============================================
let hsnB2BData = [];
let hsnB2CData = [];

async function initHSN() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  loadUserProfile(user.id);
  setupMobileMenu();
  await Promise.all([loadB2BHSN(user.id), loadB2CHSN(user.id)]);
}

// ── Build the summary: live aggregation from invoice_items,
// unioned with whatever pre-existing historical rows already exist
// in b2b_hsn / b2c_hsn (from before this page became read-only). ──
async function buildHSNSummary(userId, type) {
  const invTable = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const hsnTable = type === 'b2b' ? 'b2b_hsn' : 'b2c_hsn';

  const [invRes, itemsRes, hsnRes] = await Promise.all([
    _supabase.from(invTable).select('*').eq('user_id', userId),
    _supabase.from('invoice_items').select('*').eq('user_id', userId).eq('invoice_type', type),
    _supabase.from(hsnTable).select('*').eq('user_id', userId)
  ]);

  const invSupply = {};
  const activeInvoiceIds = new Set();
  (invRes.data || []).forEach(r => {
    invSupply[r.id] = r.supply_type;
    if (!r.is_deleted) activeInvoiceIds.add(r.id);
  });

  const activeItems = (itemsRes.data || []).filter(r => !r.is_deleted && activeInvoiceIds.has(r.invoice_id) && r.hsn_code);

  const groups = {};
  activeItems.forEach(it => {
    const supply = invSupply[it.invoice_id] || 'intrastate';
    const key = it.hsn_code + '|' + it.gst_percentage + '|' + supply;
    if (!groups[key]) {
      groups[key] = {
        id: 'computed:' + key, source: 'computed', hsn_code: it.hsn_code, productNames: new Set(),
        type: 'goods', quantity: 0, taxable_value: 0, gst_percentage: +it.gst_percentage,
        supply_type: supply, igst: 0, cgst: 0, sgst: 0, total_gst: 0, total_invoice_value: 0,
        invoiceIds: new Set()
      };
    }
    const g = groups[key];
    g.productNames.add(it.product_name);
    g.quantity += +it.quantity || 0;
    g.taxable_value = round2(g.taxable_value + (+it.taxable_value || 0));
    g.igst = round2(g.igst + (+it.igst || 0));
    g.cgst = round2(g.cgst + (+it.cgst || 0));
    g.sgst = round2(g.sgst + (+it.sgst || 0));
    g.total_gst = round2(g.total_gst + (+it.gst_amount || 0));
    g.total_invoice_value = round2(g.total_invoice_value + (+it.total_amount || 0));
    g.invoiceIds.add(it.invoice_id);
  });

  const computedRows = Object.values(groups).map(g => ({
    ...g,
    product_name: [...g.productNames].join(', '),
    invoiceCount: g.invoiceIds.size
  }));

  // 'auto' rows were written by an earlier version of this feature that
  // persisted a synced copy into this table on every invoice save; that
  // mechanism is gone now (HSN Summary computes live from invoice_items
  // instead), so any leftover 'auto' rows are stale caches — excluded
  // here to avoid double-counting against the live computation above.
  const legacyRows = (hsnRes.data || [])
    .filter(r => !r.is_deleted && r.source !== 'auto')
    .map(r => ({ ...r, source: r.source || 'legacy' }));

  return [...computedRows, ...legacyRows].sort((a, b) => b.total_invoice_value - a.total_invoice_value);
}

async function loadB2BHSN(userId) {
  hsnB2BData = await buildHSNSummary(userId, 'b2b');
  renderHSNTable('b2b', hsnB2BData);
}

async function loadB2CHSN(userId) {
  hsnB2CData = await buildHSNSummary(userId, 'b2c');
  renderHSNTable('b2c', hsnB2CData);
}

function renderHSNTable(prefix, data) {
  const tbody = document.getElementById(`hsn${prefix.toUpperCase()}TableBody`);
  const tfoot = document.getElementById(`hsn${prefix.toUpperCase()}TableTotal`);
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-state"><i class="fas fa-barcode" style="display:block;font-size:40px;margin-bottom:10px;"></i>No HSN data yet &mdash; add products to an invoice and it will appear here automatically.</td></tr>`;
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  tbody.innerHTML = data.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><b>${r.hsn_code}</b></td>
      <td>${r.product_name}</td>
      <td><span class="badge badge-green">${r.type}</span></td>
      ${prefix === 'b2b' ? `<td style="text-align:center;">${r.quantity || 0}</td>` : ''}
      <td style="text-align:right;">₹${formatNum(r.taxable_value)}</td>
      <td style="text-align:center;">${r.gst_percentage}%</td>
      <td><span class="badge ${r.supply_type==='interstate'?'badge-blue':'badge-green'}">${r.supply_type}</span></td>
      <td style="text-align:right;">₹${formatNum(r.igst)}</td>
      <td style="text-align:right;">₹${formatNum(r.cgst)} / ₹${formatNum(r.sgst)}</td>
      <td style="text-align:right;font-weight:700;">₹${formatNum(r.total_gst)}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary-dark);">₹${formatNum(r.total_invoice_value)}</td>
      <td>
        ${r.source === 'computed'
          ? `<span class="badge badge-blue" title="Live total from ${r.invoiceCount} invoice(s) — edit those invoices to change this"><i class="fas fa-link"></i> ${r.invoiceCount} Invoice${r.invoiceCount === 1 ? '' : 's'}</span>`
          : `<span class="badge" style="background:#eceff1;color:#546e7a;margin-right:6px;" title="Historical entry saved before HSN Summary became an automatic report">Historical</span>
             <button class="btn btn-danger btn-sm btn-icon" onclick="deleteHSN('${prefix}','${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>`}
      </td>
    </tr>`).join('');

  const totals = {
    taxable: data.reduce((s,r)=>s+ +r.taxable_value,0),
    igst:    data.reduce((s,r)=>s+ +r.igst,0),
    cgst:    data.reduce((s,r)=>s+ +r.cgst,0),
    sgst:    data.reduce((s,r)=>s+ +r.sgst,0),
    totalGst: data.reduce((s,r)=>s+ +r.total_gst,0),
    totalInv: data.reduce((s,r)=>s+ +r.total_invoice_value,0)
  };
  const cols = prefix === 'b2b' ? 5 : 4;
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="${cols}" style="font-weight:700;">TOTALS (${data.length})</td><td></td><td></td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.igst)}</td><td style="text-align:right;font-weight:700;">C+S: ₹${formatNum(totals.cgst + totals.sgst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.totalGst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.totalInv)}</td><td></td></tr>`;
}

// Only historical rows (source !== 'computed') can be deleted — a
// computed row has nothing of its own to delete, it's a live total.
async function deleteHSN(prefix, id) {
  const data = prefix === 'b2b' ? hsnB2BData : hsnB2CData;
  const rec = data.find(r => r.id === id);
  if (!rec || rec.source === 'computed') return;

  const ok = await showConfirm('Move this historical HSN entry to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const table = prefix === 'b2b' ? 'b2b_hsn' : 'b2c_hsn';
  const { error } = await _supabase.from(table).update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('HSN entry moved to Recycle Bin.');
  const user = await getCurrentUser();
  if (user) { if (prefix === 'b2b') await loadB2BHSN(user.id); else await loadB2CHSN(user.id); }
}

function switchHSNTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i)  => b.classList.toggle('active', i === (tab==='b2b'?0:1)));
  document.querySelectorAll('.tab-pane').forEach((p,i) => p.classList.toggle('active', i === (tab==='b2b'?0:1)));
}

function hsnTabClick(tab) {
  switchHSNTab(tab);
  // Sync URL hash & sidebar active state
  history.replaceState(null, '', '#' + tab);
  document.getElementById('sideB2BHSN')?.classList.toggle('active', tab === 'b2b');
  document.getElementById('sideB2CHSN')?.classList.toggle('active', tab === 'b2c');
  // Update page title
  const titleEl = document.querySelector('.page-title');
  if (titleEl) {
    titleEl.innerHTML = tab === 'b2c'
      ? '<i class="fas fa-tags" style="color:var(--primary);margin-right:8px;"></i>HSN Summary &mdash; B2C'
      : '<i class="fas fa-barcode" style="color:var(--primary);margin-right:8px;"></i>HSN Summary &mdash; B2B';
  }
}
