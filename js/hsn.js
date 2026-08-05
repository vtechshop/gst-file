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
    activeInvoiceIds.add(r.id);
  });

  const activeItems = (itemsRes.data || []).filter(r => activeInvoiceIds.has(r.invoice_id) && r.hsn_code);

  const groups = {};
  activeItems.forEach(it => {
    const supply = invSupply[it.invoice_id] || 'intrastate';
    const key = it.hsn_code + '|' + it.gst_percentage + '|' + supply;
    if (!groups[key]) {
      groups[key] = {
        id: 'computed:' + key, source: 'computed', hsn_code: it.hsn_code, productNames: new Set(),
        type: 'goods', quantity: 0, taxable_value: 0, gst_percentage: +it.gst_percentage,
        supply_type: supply, igst: 0, cgst: 0, sgst: 0, total_gst: 0, total_invoice_value: 0,
        invoiceIds: new Set(),
        // Per-product running totals, kept while we're already walking the
        // line items. HSN Analytics' product breakdown reads these instead of
        // re-querying invoice_items — this loop is the only pass over that
        // table, for the table and the analytics alike.
        productStats: {}
      };
    }
    const g = groups[key];
    g.productNames.add(it.product_name);
    const ps = g.productStats[it.product_name] ||
      (g.productStats[it.product_name] = { quantity: 0, taxable_value: 0, total_gst: 0, total_invoice_value: 0 });
    ps.quantity += +it.quantity || 0;
    ps.taxable_value = round2(ps.taxable_value + (+it.taxable_value || 0));
    ps.total_gst = round2(ps.total_gst + (+it.gst_amount || 0));
    ps.total_invoice_value = round2(ps.total_invoice_value + (+it.total_amount || 0));
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
    .filter(r => r.source !== 'auto')
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

// ── HSN Analytics ────────────────────────────────────
// Search one HSN code and see its totals plus the products behind it.
//
// Works entirely off hsnB2BData / hsnB2CData — the arrays buildHSNSummary()
// already produced for the table — so searching issues no request at all.
// B2B and B2C keep their own array, which is what keeps the two figures
// separate; nothing here ever reads the other type's data.
//
// The summary table below is deliberately NOT filtered: it stays complete,
// so the Excel export (which reads the same arrays) is byte-for-byte what it
// was before this feature existed.

// Aggregates every row carrying `hsnCode` into one set of figures. A single
// HSN can span several rows — the table groups by HSN + GST% + supply type —
// so this re-unions them. invoiceIds is a Set union rather than a sum of
// invoiceCount: one invoice may contribute lines to more than one of those
// groups and must be counted once.
function computeHsnAnalytics(data, hsnCode) {
  const wanted = (hsnCode || '').trim();
  const rows = (data || []).filter(r => (r.hsn_code || '').trim() === wanted);
  if (!rows.length) return null;

  const invoiceIds = new Set();
  const products = {};
  const totals = { quantity: 0, taxable_value: 0, igst: 0, cgst: 0, sgst: 0, total_invoice_value: 0 };

  rows.forEach(r => {
    if (r.invoiceIds) r.invoiceIds.forEach(id => invoiceIds.add(id));   // historical rows have none
    totals.quantity += +r.quantity || 0;
    totals.taxable_value = round2(totals.taxable_value + (+r.taxable_value || 0));
    const gst = splitHsnRowGst(r);
    totals.igst = round2(totals.igst + gst.igst);
    totals.cgst = round2(totals.cgst + gst.cgst);
    totals.sgst = round2(totals.sgst + gst.sgst);
    totals.total_invoice_value = round2(totals.total_invoice_value + (+r.total_invoice_value || 0));

    // Computed rows carry per-product totals. Historical rows predate that
    // and only have a product_name plus their own totals, so they fold in as
    // a single entry rather than being dropped — otherwise the breakdown
    // wouldn't reconcile with the card above it.
    const stats = r.productStats || { [r.product_name || '—']: {
      quantity: +r.quantity || 0, taxable_value: +r.taxable_value || 0,
      total_gst: +r.total_gst || 0, total_invoice_value: +r.total_invoice_value || 0 } };
    Object.entries(stats).forEach(([name, s]) => {
      const p = products[name] ||
        (products[name] = { name, quantity: 0, taxable_value: 0, total_gst: 0, total_invoice_value: 0 });
      p.quantity += +s.quantity || 0;
      p.taxable_value = round2(p.taxable_value + (+s.taxable_value || 0));
      p.total_gst = round2(p.total_gst + (+s.total_gst || 0));
      p.total_invoice_value = round2(p.total_invoice_value + (+s.total_invoice_value || 0));
    });
  });

  const productList = Object.values(products).sort((a, b) => b.total_invoice_value - a.total_invoice_value);
  return {
    hsn_code: wanted,
    productsSold: productList.length,
    invoiceCount: invoiceIds.size,
    quantity: round2(totals.quantity),
    taxable_value: totals.taxable_value,
    igst: totals.igst,
    cgst: totals.cgst,
    sgst: totals.sgst,
    // Derived from the three components rather than accumulated separately,
    // so the breakup on screen always adds up to the total beneath it.
    total_gst: round2(totals.igst + totals.cgst + totals.sgst),
    total_invoice_value: totals.total_invoice_value,
    products: productList
  };
}

// Splits one summary row's GST into IGST / CGST / SGST.
//
// The per-line igst, cgst and sgst saved with the invoice are used as they
// stand — an interstate invoice carries IGST only and an intrastate one
// CGST + SGST, so a mixed HSN aggregates correctly without anything here
// having to assume a supply type.
//
// The reconciliation below exists for the historical rows saved before this
// page became a live report: some kept only a total. Where the components
// don't add up to the row's own GST amount, the difference is attributed by
// that row's supply type, so nothing is silently lost from the breakup and
// interstate sales never surface as CGST/SGST.
function splitHsnRowGst(r) {
  let igst = +r.igst || 0, cgst = +r.cgst || 0, sgst = +r.sgst || 0;
  const residual = round2((+r.total_gst || 0) - round2(igst + cgst + sgst));
  if (Math.abs(residual) >= 0.01) {
    if ((r.supply_type || 'intrastate') === 'interstate') {
      igst = round2(igst + residual);
    } else {
      const half = round2(residual / 2);
      cgst = round2(cgst + half);
      sgst = round2(sgst + round2(residual - half));
    }
  }
  return { igst, cgst, sgst };
}

function hsnAnalyticsHtml(a) {
  const label = (k, v) => `<div class="calc-row"><span class="label">${k}</span><span class="value">${v}</span></div>`;
  return `
    <div class="calc-box mt-16">
      <div class="calc-row"><span class="label">HSN Code</span><span class="value"><b>${escHsnHtml(a.hsn_code)}</b></span></div>
      ${label('Products Sold', a.productsSold)}
      ${label('Invoice Count', a.invoiceCount)}
      ${label('Quantity Sold', formatNum(a.quantity))}
      ${label('Taxable Value', '₹' + formatNum(a.taxable_value))}
      ${label('IGST', '₹' + formatNum(a.igst))}
      ${label('CGST', '₹' + formatNum(a.cgst))}
      ${label('SGST', '₹' + formatNum(a.sgst))}
      <div class="calc-row calc-subtotal"><span class="label">Total GST</span><span class="value">₹${formatNum(a.total_gst)}</span></div>
      <div class="calc-row total"><span class="label">Total Sales</span><span class="value">₹${formatNum(a.total_invoice_value)}</span></div>
    </div>
    <div class="section-title mb-14 mt-20">Products under this HSN</div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr><th>#</th><th>Product Name</th><th style="text-align:center;">Quantity Sold</th>
              <th style="text-align:right;">Taxable Value</th><th style="text-align:right;">GST</th>
              <th style="text-align:right;">Total Sales</th></tr>
        </thead>
        <tbody>
          ${a.products.map((p, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${escHsnHtml(p.name)}</td>
              <td style="text-align:center;">${formatNum(p.quantity)}</td>
              <td style="text-align:right;">₹${formatNum(p.taxable_value)}</td>
              <td style="text-align:right;">₹${formatNum(p.total_gst)}</td>
              <td style="text-align:right;font-weight:700;color:var(--primary-dark);">₹${formatNum(p.total_invoice_value)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function escHsnHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function runHsnSearch(prefix) {
  const slot = document.getElementById(`hsn${prefix.toUpperCase()}Analytics`);
  if (!slot) return;
  const code = document.getElementById(`hsn${prefix.toUpperCase()}Search`)?.value?.trim() || '';

  // Empty box means "no analytics" — the complete table below is already
  // there and is never filtered, so there is nothing to restore.
  if (!code) { slot.innerHTML = ''; return; }

  const analytics = computeHsnAnalytics(prefix === 'b2b' ? hsnB2BData : hsnB2CData, code);
  slot.innerHTML = analytics
    ? hsnAnalyticsHtml(analytics)
    : `<div class="empty-state mt-16"><i class="fas fa-barcode" style="display:block;font-size:32px;margin-bottom:8px;"></i>No records found for this HSN Code.</div>`;
}

function clearHsnSearch(prefix) {
  const input = document.getElementById(`hsn${prefix.toUpperCase()}Search`);
  if (input) { input.value = ''; input.focus(); }
  const slot = document.getElementById(`hsn${prefix.toUpperCase()}Analytics`);
  if (slot) slot.innerHTML = '';
}

// Only historical rows (source !== 'computed') can be deleted — a
// computed row has nothing of its own to delete, it's a live total.
async function deleteHSN(prefix, id) {
  const data = prefix === 'b2b' ? hsnB2BData : hsnB2CData;
  const rec = data.find(r => r.id === id);
  if (!rec || rec.source === 'computed') return;

  const ok = await showConfirm('Permanently delete this historical HSN entry? This cannot be undone.');
  if (!ok) return;
  const table = prefix === 'b2b' ? 'b2b_hsn' : 'b2c_hsn';
  const { error } = await _supabase.from(table).delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('HSN entry permanently deleted.');
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
