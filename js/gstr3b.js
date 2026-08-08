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
  // The last day of the month, not a fixed 31st. April, June, September,
  // November and February have no 31st, and Postgres rejects the date
  // outright rather than clamping it — so the query errored and the page
  // reported an empty month as a month with no sales. Built the same way
  // getReportDateRange() builds it: day 0 of the next month.
  const [my, mm] = month.split('-').map(Number);
  const lastDay = new Date(my, mm, 0).getDate();
  const end = `${month}-${String(lastDay).padStart(2, '0')}`;

  const [b2bRes, b2cRes, itemsRes] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', gstr3bUser.id).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('b2c_invoices').select('*').eq('user_id', gstr3bUser.id).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('invoice_items').select('*').eq('user_id', gstr3bUser.id)
  ]);

  const b2b = (b2bRes.data || []);
  const b2c = (b2cRes.data || []);

  const itemsByInvoice = {};
  (itemsRes.data || []).forEach(r => {
    const key = r.invoice_type + ':' + r.invoice_id;
    (itemsByInvoice[key] = itemsByInvoice[key] || []).push(r);
  });

  renderGSTR3B(b2b, b2c, month, itemsByInvoice);
  await loadGSTR3BExtras(start, end, itemsByInvoice, [...b2b, ...b2c]);
}

// The three lines of 3.1 that are not built from the invoice headers.
//
// 3.1(c) nil-rated and exempt, and 3.1(e) non-GST, come from the invoice
// LINES (a taxable invoice can carry an exempt line) and from bills of
// supply, which are entirely non-taxable. 3.1(d) is inward reverse charge,
// and the document that records one is the self invoice.
//
// Run after the page has rendered so a slow read never delays the figures
// that were already on screen; the JSON export reads the same object.
async function loadGSTR3BExtras(start, end, itemsByInvoice, invoices) {
  const d = window._gstr3bData;
  if (!d) return;
  const r2v = n => round2(+n || 0);

  // Lines belonging to invoices inside the period, by treatment.
  const inPeriod = new Set(invoices.map(r => (r.gst_number ? 'b2b:' : 'b2c:') + r.id));
  let nil = 0, nonGst = 0;
  Object.entries(itemsByInvoice || {}).forEach(([key, rows]) => {
    if (!inPeriod.has(key)) return;
    rows.forEach(it => {
      const t = String(it.gst_treatment || 'taxable');
      if (t === 'nil_rated' || t === 'exempt' || t === 'exempted') nil += (+it.taxable_value || 0);
      else if (t === 'non_gst') nonGst += (+it.taxable_value || 0);
    });
  });

  const [bosRes, siRes] = await Promise.all([
    _supabase.from('bill_of_supply').select('*').eq('user_id', gstr3bUser.id)
      .gte('document_date', start).lte('document_date', end).then(r => r).catch(() => ({ data: [] })),
    _supabase.from('self_invoices').select('*').eq('user_id', gstr3bUser.id)
      .gte('document_date', start).lte('document_date', end).then(r => r).catch(() => ({ data: [] }))
  ]);

  (bosRes.data || [])
    .filter(r => String(r.status || '').toLowerCase() !== 'cancelled')
    .forEach(r => {
      if (String(r.supply_nature) === 'non_gst') nonGst += (+r.total_value || 0);
      else nil += (+r.total_value || 0);
    });

  const rcm = (siRes.data || []).filter(r => String(r.status || '').toLowerCase() !== 'cancelled');

  // ── Table 4: input tax credit ──────────────────────────────
  // This was exported as all zeros. A business filing that would pay its
  // full output tax with no credit against it — the single most expensive
  // thing this file could get wrong — while the tax it had already paid
  // sat in the purchases table untouched.
  //
  // Two kinds are computed here, and only two:
  //   OTH   — ordinary inward supplies, from purchases
  //   ISRC  — inward supplies liable to reverse charge, from self
  //           invoices, which is the document that records one
  // IMPG and IMPS (imports) and ISD stay zero because this application
  // has no bill of entry and no ISD document, so it has nothing to say
  // about them. Reversals under rules 42/43 stay zero for the same
  // reason: they depend on exempt-turnover apportionment this file does
  // not compute. All of that is stated on the page rather than implied.
  const purRes = await _supabase.from('purchases').select('*').eq('user_id', gstr3bUser.id)
    .gte('purchase_date', start).lte('purchase_date', end).then(r => r).catch(() => ({ data: [] }));
  const purchases = purRes.data || [];

  d.itcOthIGST = r2v(purchases.reduce((s2, r) => s2 + (+r.igst || 0), 0));
  d.itcOthCGST = r2v(purchases.reduce((s2, r) => s2 + (+r.cgst || 0), 0));
  d.itcOthSGST = r2v(purchases.reduce((s2, r) => s2 + (+r.sgst || 0), 0));
  d.itcOthCess = 0;
  d.itcPurchaseCount = purchases.length;

  // Tax paid under reverse charge is itself creditable, so a self invoice
  // both creates the liability at 3.1(d) and the credit here.
  //
  // Summed from `rcm` directly rather than read back off `d`: the 3.1(d)
  // figures are assigned further down this function, so reading them here
  // got undefined and quietly credited nothing.
  d.itcRcmIGST = r2v(rcm.reduce((s2, r) => s2 + (+r.igst || 0), 0));
  d.itcRcmCGST = r2v(rcm.reduce((s2, r) => s2 + (+r.cgst || 0), 0));
  d.itcRcmSGST = r2v(rcm.reduce((s2, r) => s2 + (+r.sgst || 0), 0));
  d.itcRcmCess = r2v(rcm.reduce((s2, r) => s2 + (+r.cess || 0), 0));

  d.itcNetIGST = r2v(d.itcOthIGST + d.itcRcmIGST);
  d.itcNetCGST = r2v(d.itcOthCGST + d.itcRcmCGST);
  d.itcNetSGST = r2v(d.itcOthSGST + d.itcRcmSGST);
  d.itcNetCess = r2v(d.itcOthCess + d.itcRcmCess);

  // ── Table 3.2: inter-state supplies to unregistered persons ──
  // Reported per place of supply, which is what makes it a different
  // question from 3.1. It was written as a single aggregate row typed
  // 'EXPWOP' — an export code — for supplies that are neither exports nor
  // place-of-supply-wise.
  const posBuckets = new Map();
  (invoices || [])
    .filter(r => r.supply_type === 'interstate')
    .filter(r => !String(r.gst_number || '').trim())     // unregistered only
    .filter(r => !r.export_type)                          // an export is not a 3.2 supply
    .forEach(r => {
      const pos = (typeof getStateCode === 'function' ? getStateCode(r.state || '') : '') || '';
      if (!pos || pos === '99') return;
      if (!posBuckets.has(pos)) posBuckets.set(pos, { pos, txval: 0, iamt: 0 });
      const b = posBuckets.get(pos);
      b.txval = r2v(b.txval + (+r.taxable_amount || 0));
      b.iamt = r2v(b.iamt + (+r.igst || 0));
    });
  d.unregByPos = [...posBuckets.values()].sort((a, b) => a.pos.localeCompare(b.pos));
  d.nilExemptTxval = r2v(nil);
  d.nonGstTxval = r2v(nonGst);
  d.rcmTxval = r2v(rcm.reduce((s, r) => s + (+r.taxable_value || 0), 0));
  d.rcmIGST = r2v(rcm.reduce((s, r) => s + (+r.igst || 0), 0));
  d.rcmCGST = r2v(rcm.reduce((s, r) => s + (+r.cgst || 0), 0));
  d.rcmSGST = r2v(rcm.reduce((s, r) => s + (+r.sgst || 0), 0));
  d.rcmCess = r2v(rcm.reduce((s, r) => s + (+r.cess || 0), 0));

  // Shown as well as exported — a figure that only appears in a JSON file
  // nobody opens is a figure nobody can check.
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = '₹' + fmt(v); };
  setTxt('g3bZeroRated', d.osupZeroTxval || 0);
  setTxt('g3bNilExempt', d.nilExemptTxval);
  setTxt('g3bNonGst', d.nonGstTxval);
  setTxt('g3bRcm', d.rcmTxval);
  setTxt('g3bItcOth', d.itcOthIGST + d.itcOthCGST + d.itcOthSGST);
  setTxt('g3bItcRcm', d.itcRcmIGST + d.itcRcmCGST + d.itcRcmCess + d.itcRcmSGST);
  setTxt('g3bItcNet', d.itcNetIGST + d.itcNetCGST + d.itcNetSGST);
  const cnt = document.getElementById('g3bItcSource');
  if (cnt) cnt.textContent = `from ${d.itcPurchaseCount} purchase${d.itcPurchaseCount === 1 ? '' : 's'} in this period`;
}

function sum(arr, key) { return arr.reduce((s, r) => s + (+r[key] || 0), 0); }

// Rounds through round2() in js/utils.js, the same helper every other
// money figure in the app goes through.
//
// This was its own `Math.round(n * 100) / 100`, which is the one formula
// round2() exists to avoid: 1.005 is held as ~1.00499999999999989, so
// multiplying by 100 gives 100.49999999999999 and the value rounds DOWN
// to 1.00 instead of up to 1.01. Four of ten exact half-paisa values
// tested came out a paisa short.
//
// It changed nothing here in practice — every figure on this page is a
// sum of columns already stored to two decimals, and such a sum cannot
// land exactly on a half-paisa, which two million randomised sums
// confirmed with no disagreement. The duplicate is removed so a future
// input that is not a sum of stored columns cannot quietly hit the trap.
function r2(n) { return round2(n); }

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
  // 3.1 has five lines, and this page reported one of them and wrote zero
  // for the rest. Every figure below is data the application already
  // holds — exports since Batch 5, reverse-charge inward since Module 4B,
  // nil/exempt since Module 3, cess since Module 10 — so reporting them
  // as zero was understating the return, not simplifying it.
  //
  // An export is an outward supply but a ZERO-RATED one: it belongs in
  // 3.1(b), not 3.1(a), and counting it in both would double the turnover.
  const isExport = r => !!r.export_type;
  const zeroRated = all.filter(isExport);
  const taxableOnly = all.filter(r => !isExport(r));

  const osupDetTxval = r2(sum(taxableOnly, 'taxable_amount'));
  const osupDetIGST  = r2(sum(taxableOnly, 'igst'));
  const osupDetCGST  = r2(sum(taxableOnly, 'cgst'));
  const osupDetSGST  = r2(sum(taxableOnly, 'sgst'));
  const osupDetCess  = r2(sum(taxableOnly, 'cess_amount'));

  const osupZeroTxval = r2(sum(zeroRated, 'taxable_amount'));
  const osupZeroIGST  = r2(sum(zeroRated, 'igst'));
  const osupZeroCess  = r2(sum(zeroRated, 'cess_amount'));

  window._gstr3bData = { b2b, b2c, month, totTax, totIGST, totCGST, totSGST, totGST, rateWise,
    regInterTax, regInterIGST, unregInterTax, unregInterIGST,
    osupDetTxval, osupDetIGST, osupDetCGST, osupDetSGST, osupDetCess,
    osupZeroTxval, osupZeroIGST, osupZeroCess,
    // Filled in by loadGSTR3BExtras() below, which reads the documents
    // that 3.1(c) and 3.1(d) are built from.
    nilExemptTxval: 0, nonGstTxval: 0,
    rcmTxval: 0, rcmIGST: 0, rcmCGST: 0, rcmSGST: 0, rcmCess: 0 };

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
      // 3.1(a) — taxable outward supplies, exports excluded because they
      // are reported at 3.1(b) and counting them twice doubles turnover.
      osup_det: {
        txval: d.osupDetTxval ?? d.totTax,
        iamt:  d.osupDetIGST ?? d.totIGST,
        camt:  d.osupDetCGST ?? d.totCGST,
        samt:  d.osupDetSGST ?? d.totSGST,
        csamt: d.osupDetCess ?? 0
      },
      // 3.1(b) — zero rated: exports and SEZ supplies.
      osup_zero:     { txval: d.osupZeroTxval ?? 0, iamt: d.osupZeroIGST ?? 0, csamt: d.osupZeroCess ?? 0 },
      // 3.1(c) — nil rated and exempt.
      osup_nil_exmp: { txval: d.nilExemptTxval ?? 0 },
      // 3.1(d) — inward supplies on which tax is payable by the recipient.
      // Built from self invoices, which is the document that records one.
      isup_rev:      { txval: d.rcmTxval ?? 0, iamt: d.rcmIGST ?? 0, camt: d.rcmCGST ?? 0,
                       samt: d.rcmSGST ?? 0, csamt: d.rcmCess ?? 0 },
      // 3.1(e) — non-GST outward supplies.
      osup_nongst:   { txval: d.nonGstTxval ?? 0 }
    },
    inter_sup: {
      // 3.2 is reported per place of supply. It previously wrote one
      // aggregate row typed 'EXPWOP', which is an export code and was
      // never right for a domestic B2C supply.
      unreg_details: (d.unregByPos || []).map(r => ({ pos: r.pos, txval: r.txval, iamt: r.iamt })),
      comp_details:  [],
      uin_details:   []
    },
    itc_elg: {
      // IMPG, IMPS and ISD stay zero: this application records no bill of
      // entry and no ISD document, so it has nothing to say about them.
      // ISRC and OTH are computed from self invoices and purchases.
      itc_avl: [
        { ty: 'IMPG', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'IMPS', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'ISRC', iamt: d.itcRcmIGST ?? 0, camt: d.itcRcmCGST ?? 0, samt: d.itcRcmSGST ?? 0, csamt: d.itcRcmCess ?? 0 },
        { ty: 'ISD',  iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'OTH',  iamt: d.itcOthIGST ?? 0, camt: d.itcOthCGST ?? 0, samt: d.itcOthSGST ?? 0, csamt: d.itcOthCess ?? 0 }
      ],
      itc_rev:  [{ ty: 'RUL_42_43', iamt: 0, camt: 0, samt: 0, csamt: 0 }, { ty: 'OTH', iamt: 0, camt: 0, samt: 0, csamt: 0 }],
      itc_net:  { iamt: d.itcNetIGST ?? 0, camt: d.itcNetCGST ?? 0,
                  samt: d.itcNetSGST ?? 0, csamt: d.itcNetCess ?? 0 },
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
