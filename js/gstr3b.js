// =============================================
// GSTR-3B Summary — Auto Calculate
// =============================================

let gstr3bUser = null;

async function initGSTR3B() {
  const user = await requireAuth();
  if (!user) return;
  gstr3bUser = user;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  populateMonthDropdown();
  await loadGSTR3B();
}

function populateMonthDropdown() {
  const sel = document.getElementById('gstr3bMonth');
  if (!sel) return;
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    // Local getters, not toISOString() — see js/utils.js's toISO() for why.
    const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const lbl = d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = lbl;
    if (i === 0) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadGSTR3B() {
  const sel   = document.getElementById('gstr3bMonth');
  const now = new Date();
  const month = sel?.value || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
  const start = month + '-01';
  const end   = month + '-31';

  const [b2bRes, b2cRes, itemsRes] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', gstr3bUser.id).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('b2c_invoices').select('*').eq('user_id', gstr3bUser.id).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('invoice_items').select('*').eq('user_id', gstr3bUser.id)
  ]);

  const b2b = (b2bRes.data || []).filter(r => !r.is_deleted);
  const b2c = (b2cRes.data || []).filter(r => !r.is_deleted);

  const itemsByInvoice = {};
  (itemsRes.data || []).filter(r => !r.is_deleted).forEach(r => {
    const key = r.invoice_type + ':' + r.invoice_id;
    (itemsByInvoice[key] = itemsByInvoice[key] || []).push(r);
  });

  renderGSTR3B(b2b, b2c, month, itemsByInvoice);
}

function sum(arr, key) { return arr.reduce((s, r) => s + (+r[key] || 0), 0); }
function r2(n) { return Math.round((+n || 0) * 100) / 100; }

function renderGSTR3B(b2b, b2c, month, itemsByInvoice) {
  const all = [...b2b, ...b2c];

  // ── 3.1(a) Outward Taxable Supplies ──────────────
  const b2bTax  = r2(sum(b2b, 'taxable_amount'));
  const b2cTax  = r2(sum(b2c, 'taxable_amount'));
  const totTax  = r2(b2bTax + b2cTax);

  const b2bIGST = r2(sum(b2b, 'igst'));
  const b2cIGST = r2(sum(b2c, 'igst'));
  const totIGST = r2(b2bIGST + b2cIGST);

  const b2bCGST = r2(sum(b2b, 'cgst'));
  const b2cCGST = r2(sum(b2c, 'cgst'));
  const totCGST = r2(b2bCGST + b2cCGST);

  const b2bSGST = r2(sum(b2b, 'sgst'));
  const b2cSGST = r2(sum(b2c, 'sgst'));
  const totSGST = r2(b2bSGST + b2cSGST);

  const totGST  = r2(totIGST + totCGST + totSGST);

  // ── 3.2 Inter-State Supplies ──────────────────────
  const b2bInter = b2b.filter(r => r.supply_type === 'interstate');
  const b2cInter = b2c.filter(r => r.supply_type === 'interstate');

  const regInterTax  = r2(sum(b2bInter, 'taxable_amount'));
  const regInterIGST = r2(sum(b2bInter, 'igst'));
  const unregInterTax  = r2(sum(b2cInter, 'taxable_amount'));
  const unregInterIGST = r2(sum(b2cInter, 'igst'));

  // ── Rate-wise breakup ─────────────────────────────
  // Itemized invoices are broken down by each line's own rate (one
  // invoice can legitimately mix rates); legacy invoices with no line
  // items fall back to their single header rate exactly as before.
  const byRate = {};
  const bumpRate = (rate, taxable, igst, cgst, sgst, total) => {
    if (!byRate[rate]) byRate[rate] = { rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0 };
    byRate[rate].taxable += taxable;
    byRate[rate].igst += igst;
    byRate[rate].cgst += cgst;
    byRate[rate].sgst += sgst;
    byRate[rate].total += total;
  };
  [['b2b', b2b], ['b2c', b2c]].forEach(([type, list]) => {
    list.forEach(r => {
      const items = (itemsByInvoice || {})[type + ':' + r.id];
      if (items && items.length) {
        items.forEach(it => bumpRate(+it.gst_percentage, +it.taxable_value, +it.igst, +it.cgst, +it.sgst, +it.total_amount));
      } else {
        bumpRate(+r.gst_percentage, +r.taxable_amount, +r.igst, +r.cgst, +r.sgst, +r.total_amount);
      }
    });
  });
  const rateWise = Object.values(byRate)
    .map(r => ({ rate: r.rate, taxable: r2(r.taxable), igst: r2(r.igst), cgst: r2(r.cgst), sgst: r2(r.sgst), total: r2(r.total) }))
    .filter(r => r.taxable > 0)
    .sort((a, b) => a.rate - b.rate);

  // ── Save for export ───────────────────────────────
  window._gstr3bData = { b2b, b2c, month, totTax, totIGST, totCGST, totSGST, totGST, rateWise, regInterTax, regInterIGST, unregInterTax, unregInterIGST };

  // ── Stat cards ────────────────────────────────────
  setEl('g3bTotTaxable', '&#8377;' + fmt(totTax));
  setEl('g3bTotIGST',    '&#8377;' + fmt(totIGST));
  setEl('g3bTotCGST',    '&#8377;' + fmt(totCGST));
  setEl('g3bTotSGST',    '&#8377;' + fmt(totSGST));
  setEl('g3bTotGST',     '&#8377;' + fmt(totGST));
  setEl('g3bInvCount',   b2b.length + b2c.length + ' invoices');

  // ── Table 3.1 ─────────────────────────────────────
  const t31 = document.getElementById('table31Body');
  if (t31) t31.innerHTML = `
    <tr>
      <td>B2B Supplies (Registered Persons)</td>
      <td style="text-align:right;">&#8377;${fmt(b2bTax)}</td>
      <td style="text-align:right;">&#8377;${fmt(b2bIGST)}</td>
      <td style="text-align:right;">&#8377;${fmt(b2bCGST)}</td>
      <td style="text-align:right;">&#8377;${fmt(b2bSGST)}</td>
      <td style="text-align:right;font-weight:700;">&#8377;${fmt(r2(b2bIGST+b2bCGST+b2bSGST))}</td>
    </tr>
    <tr>
      <td>B2C Supplies (Unregistered Persons)</td>
      <td style="text-align:right;">&#8377;${fmt(b2cTax)}</td>
      <td style="text-align:right;">&#8377;${fmt(b2cIGST)}</td>
      <td style="text-align:right;">&#8377;${fmt(b2cCGST)}</td>
      <td style="text-align:right;">&#8377;${fmt(b2cSGST)}</td>
      <td style="text-align:right;font-weight:700;">&#8377;${fmt(r2(b2cIGST+b2cCGST+b2cSGST))}</td>
    </tr>
    <tr style="background:#e0f2f1;font-weight:700;">
      <td>3.1(a) Total Outward Taxable Supplies</td>
      <td style="text-align:right;">&#8377;${fmt(totTax)}</td>
      <td style="text-align:right;">&#8377;${fmt(totIGST)}</td>
      <td style="text-align:right;">&#8377;${fmt(totCGST)}</td>
      <td style="text-align:right;">&#8377;${fmt(totSGST)}</td>
      <td style="text-align:right;color:var(--primary-dark);">&#8377;${fmt(totGST)}</td>
    </tr>
    <tr style="opacity:0.6;">
      <td>3.1(b) Zero Rated Supplies</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&mdash;</td>
      <td style="text-align:right;">&mdash;</td>
      <td style="text-align:right;">&#8377;0.00</td>
    </tr>
    <tr style="opacity:0.6;">
      <td>3.1(c) Nil Rated / Exempted Supplies</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&mdash;</td>
      <td style="text-align:right;">&mdash;</td>
      <td style="text-align:right;">&mdash;</td>
      <td style="text-align:right;">&mdash;</td>
    </tr>
    <tr style="opacity:0.6;">
      <td>3.1(d) Inward Supplies (Reverse Charge)</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&#8377;0.00</td>
      <td style="text-align:right;">&#8377;0.00</td>
    </tr>`;

  // ── Table 3.2 ─────────────────────────────────────
  const t32 = document.getElementById('table32Body');
  if (t32) t32.innerHTML = `
    <tr>
      <td>Supplies to Unregistered Persons (B2C Interstate)</td>
      <td style="text-align:right;">&#8377;${fmt(unregInterTax)}</td>
      <td style="text-align:right;font-weight:700;">&#8377;${fmt(unregInterIGST)}</td>
    </tr>
    <tr>
      <td>Supplies to Registered Persons (B2B Interstate)</td>
      <td style="text-align:right;">&#8377;${fmt(regInterTax)}</td>
      <td style="text-align:right;font-weight:700;">&#8377;${fmt(regInterIGST)}</td>
    </tr>
    <tr style="background:#e0f2f1;font-weight:700;">
      <td>Total Inter-State Supplies</td>
      <td style="text-align:right;">&#8377;${fmt(r2(unregInterTax+regInterTax))}</td>
      <td style="text-align:right;color:var(--primary-dark);">&#8377;${fmt(r2(unregInterIGST+regInterIGST))}</td>
    </tr>`;

  // ── Rate-wise Breakup ─────────────────────────────
  const rateBody = document.getElementById('rateWiseBody');
  if (rateBody) {
    if (!rateWise.length) {
      rateBody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for selected month</td></tr>';
    } else {
      rateBody.innerHTML = rateWise.map(r => `
        <tr>
          <td style="text-align:center;"><span class="badge badge-green">${r.rate}%</span></td>
          <td style="text-align:right;">&#8377;${fmt(r.taxable)}</td>
          <td style="text-align:right;">&#8377;${fmt(r.igst)}</td>
          <td style="text-align:right;">&#8377;${fmt(r.cgst)}</td>
          <td style="text-align:right;">&#8377;${fmt(r.sgst)}</td>
          <td style="text-align:right;font-weight:700;">&#8377;${fmt(r.total)}</td>
        </tr>`).join('') +
        `<tr style="background:#e0f2f1;font-weight:700;">
          <td style="text-align:center;">Total</td>
          <td style="text-align:right;">&#8377;${fmt(totTax)}</td>
          <td style="text-align:right;">&#8377;${fmt(totIGST)}</td>
          <td style="text-align:right;">&#8377;${fmt(totCGST)}</td>
          <td style="text-align:right;">&#8377;${fmt(totSGST)}</td>
          <td style="text-align:right;color:var(--primary-dark);">&#8377;${fmt(r2(totTax+totGST))}</td>
        </tr>`;
    }
  }
}

function setEl(id, html) { const e = document.getElementById(id); if (e) e.innerHTML = html; }
function fmt(n) { return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── Export GSTR-3B JSON (Portal Format) ──────────
function exportGSTR3BJSON() {
  const d = window._gstr3bData;
  if (!d) return;
  const p    = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const mon  = d.month.replace('-', '');
  const fp   = mon.slice(4) + mon.slice(0, 4); // MMYYYY

  const json = {
    gstin:      p?.gstin || '',
    ret_period: fp,
    sup_details: {
      osup_det: {
        txval: d.totTax,
        iamt:  d.totIGST,
        camt:  d.totCGST,
        samt:  d.totSGST,
        csamt: 0
      },
      osup_zero:     { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: 0 },
      isup_rev:      { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
      osup_nongst:   { txval: 0 }
    },
    inter_sup: {
      unreg_details: d.unregInterTax > 0 ? [{ ty: 'EXPWOP', txval: d.unregInterTax, iamt: d.unregInterIGST, csamt: 0 }] : [],
      comp_details:  [],
      uin_details:   []
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'IMPS', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'ISRC', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'ISD',  iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'OTH',  iamt: 0, camt: 0, samt: 0, csamt: 0 }
      ],
      itc_rev:  [{ ty: 'RUL_42_43', iamt: 0, camt: 0, samt: 0, csamt: 0 }, { ty: 'OTH', iamt: 0, camt: 0, samt: 0, csamt: 0 }],
      itc_net:  { iamt: 0, camt: 0, samt: 0, csamt: 0 },
      itc_inelg:[{ ty: 'RUL_42_43', iamt: 0, camt: 0, samt: 0, csamt: 0 }, { ty: 'OTH', iamt: 0, camt: 0, samt: 0, csamt: 0 }]
    },
    intr_ltfee: {
      intr_details: { ty: 'LIABILITY', iamt: 0, camt: 0, samt: 0, csamt: 0 }
    }
  };

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `GSTR3B_${fp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('GSTR-3B JSON exported for portal upload!', 'success');
}

// ── Export GSTR-3B Excel ──────────────────────────
function exportGSTR3BExcel() {
  const d = window._gstr3bData;
  if (!d) return;

  const s31 = [
    { 'Table': '3.1(a)', 'Description': 'B2B Outward Taxable Supplies', 'Taxable Value': d.b2b.reduce((s,r)=>s+ +r.taxable_amount,0), 'IGST': d.b2b.reduce((s,r)=>s+ +r.igst,0), 'CGST': d.b2b.reduce((s,r)=>s+ +r.cgst,0), 'SGST': d.b2b.reduce((s,r)=>s+ +r.sgst,0) },
    { 'Table': '3.1(a)', 'Description': 'B2C Outward Taxable Supplies', 'Taxable Value': d.b2c.reduce((s,r)=>s+ +r.taxable_amount,0), 'IGST': d.b2c.reduce((s,r)=>s+ +r.igst,0), 'CGST': d.b2c.reduce((s,r)=>s+ +r.cgst,0), 'SGST': d.b2c.reduce((s,r)=>s+ +r.sgst,0) },
    { 'Table': 'TOTAL',  'Description': 'Total Outward Taxable Supplies', 'Taxable Value': d.totTax, 'IGST': d.totIGST, 'CGST': d.totCGST, 'SGST': d.totSGST }
  ];

  const s32 = [
    { 'Type': 'To Unregistered (B2C Interstate)', 'Taxable Value': d.unregInterTax, 'IGST': d.unregInterIGST },
    { 'Type': 'To Registered (B2B Interstate)',   'Taxable Value': d.regInterTax,   'IGST': d.regInterIGST }
  ];

  const sRate = d.rateWise.map(r => ({
    'GST Rate': r.rate + '%',
    'Taxable Value': r.taxable,
    'IGST': r.igst,
    'CGST': r.cgst,
    'SGST': r.sgst,
    'Total Invoice': r.total
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s31),   'Table 3.1 Outward');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s32),   'Table 3.2 Interstate');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sRate), 'Rate-wise Breakup');
  XLSX.writeFile(wb, `GSTR3B_${d.month}.xlsx`);
  showToast('GSTR-3B Excel exported!', 'success');
}

// ── Print GSTR-3B ─────────────────────────────────
function printGSTR3B() {
  printReport('gstr3bPrintArea', 'GSTR-3B Summary Return');
}
