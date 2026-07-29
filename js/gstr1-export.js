// =============================================
// GSTR-1 JSON Export — GST Portal Compliance Engine
// =============================================
// Replaces the old exportGSTR1JSON() in js/export.js, which had several
// real, confirmed defects (see the accompanying report — not guesses):
//   - POS for B2B was derived from supply_type + the BUSINESS's own state
//     instead of the customer's GSTIN, and produced an invalid/blank POS
//     for every single interstate B2B invoice.
//   - The HSN section was built from repB2BHSN/repB2CHSN, which mix ALL-
//     TIME invoice items with the period-filtered B2B/B2C invoice list —
//     so HSN totals could never reconcile against B2B+B2C totals for any
//     period except "since the beginning of time."
//   - Every money figure came from the invoice header's cached columns,
//     never recomputed from line items — a corrupted/hand-edited cached
//     total (or an invoice with items at several different GST rates)
//     would export silently wrong.
//   - No B2CL section existed at all — large unregistered inter-state
//     invoices were always folded into the state-rate B2CS bucket.
//   - No CDNR/CDNUR section existed — Credit/Debit Notes never appeared
//     in the filing at all.
//   - `fp` (filing period) was always "the current calendar month",
//     regardless of which period was actually selected/exported.
//   - UQC was hardcoded to 'NOS' for every single HSN row.
//   - Nothing was validated before the file downloaded.
//
// This file fixes the generator itself — every export recomputes from
// source data and is validated before a single byte is written to disk.
//
// Two-phase validation, per the compliance brief:
//   1. Structural/format checks happen inline while the payload is being
//      assembled (GSTIN, POS, HSN, invoice number, date, non-negative
//      values) — each failure is pushed onto a shared `errors` array with
//      enough context to fix it.
//   2. runFinalGSTR1Audit() is a separate pass, run only after the whole
//      payload exists, that re-derives every total independently and
//      cross-checks it against the payload — the actual reconciliation
//      step. Anything wrong here means the two halves of the generator
//      itself disagree, which should never happen; it exists as a
//      standing guardrail so a future code change can't silently break
//      the invariant without the export refusing to run.
//
// If either phase finds anything, the JSON is never written — a modal
// lists every failure and the download is aborted, exactly as asked.

// ── Statutory constants ─────────────────────────────────────
// Fixed by law, not derived from any invoice — kept as one named
// constant (never inlined into the logic below) so it's one place to
// update if CBIC revises it, not a magic number buried in a comparison.
// Value as of the CBIC notification in effect at the time this was
// written (₹1,00,000 for B2C inter-state invoices to go to B2CL instead
// of B2CS) — confirm against the current notification before relying on
// this for an actual filing; thresholds like this do get revised.
const GSTR1_B2CL_THRESHOLD = 100000;

// UQC (Unit Quantity Code) — the GST Portal's official master list uses
// compound codes like "PCS-PIECES", never the bare unit text this app
// stores on invoice_items.unit (see COMMON_UNITS in js/utils.js).
// Reconstructed from the documented UQC master list — verify against the
// live GST Portal/offline-tool dropdown before relying on it for a real
// filing. Deliberately not guessed further than this: any unit this map
// doesn't recognize falls back to "OTH-OTHERS" (itself a real, always-
// valid UQC entry), never a fabricated specific code.
const GSTR1_UQC_MAP = {
  'PCS': 'PCS-PIECES', 'NOS': 'NOS-NUMBERS', 'KG': 'KGS-KILOGRAMS',
  'LTR': 'LTR-LITRES', 'MTR': 'MTR-METERS', 'BOX': 'BOX-BOX',
  'SET': 'SET-SETS', 'PAIR': 'PRS-PAIRS', 'DOZ': 'DOZ-DOZENS',
  'BAG': 'BAG-BAGS', 'BTL': 'BTL-BOTTLES'
  // 'HRS' (hours) has no intent as a UQC — services don't carry a real
  // unit-of-measure quantity, deliberately left unmapped -> OTH-OTHERS.
};
function gstr1ToUQC(unit) {
  const key = (unit || '').trim().toUpperCase();
  return GSTR1_UQC_MAP[key] || 'OTH-OTHERS';
}

function gstr1InvoiceNumberOk(num) {
  // GSTN's own offline-utility validation: max 16 chars, letters/digits/-//
  return /^[A-Za-z0-9\-\/]{1,16}$/.test(num || '');
}
function gstr1HsnFormatOk(hsn) {
  // Digits only, 4/6/8-digit tiers (the exact tier required depends on
  // the filer's aggregate turnover, which this app doesn't track — so
  // this checks the code is *a* valid HSN shape, not which tier applies
  // to this specific business).
  return /^(\d{4}|\d{6}|\d{8})$/.test((hsn || '').trim());
}
function gstr1DateOk(ddmmyyyy) {
  return /^\d{2}-\d{2}-\d{4}$/.test(ddmmyyyy || '');
}

// ── Recompute every money figure from line items — never trust the
// cached header row. Each item's own tax is re-derived from
// taxable_value/gst_percentage/supply_type via the exact same calcGST()
// every other part of the app already uses (js/utils.js) — a corrupted
// or hand-edited cached item.gst_amount/igst/cgst/sgst can't silently
// flow into the filing either. ──
function gstr1RecomputeItem(item, supplyType) {
  const taxable = round2(+item.taxable_value || 0);
  const rate = +item.gst_percentage || 0;
  const calc = calcGST(taxable, rate, supplyType);
  return { taxable, rate, igst: calc.igst, cgst: calc.cgst, sgst: calc.sgst, gstAmount: calc.gstAmount };
}

// Recomputes an invoice's totals from its items, AND groups them by GST
// rate — a single invoice can legitimately carry several rate slabs
// (multiple products at different rates), which the old generator
// collapsed into one itms[0] using whatever rate happened to sit on the
// header row.
function gstr1RecomputeInvoice(items, supplyType) {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0;
  const byRate = new Map();
  items.forEach(it => {
    const r = gstr1RecomputeItem(it, supplyType);
    taxable = round2(taxable + r.taxable); igst = round2(igst + r.igst);
    cgst = round2(cgst + r.cgst); sgst = round2(sgst + r.sgst);
    if (!byRate.has(r.rate)) byRate.set(r.rate, { rate: r.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    const b = byRate.get(r.rate);
    b.taxable = round2(b.taxable + r.taxable); b.igst = round2(b.igst + r.igst);
    b.cgst = round2(b.cgst + r.cgst); b.sgst = round2(b.sgst + r.sgst);
  });
  const gstAmount = round2(igst + cgst + sgst);
  return { taxable, igst, cgst, sgst, gstAmount, total: round2(taxable + gstAmount), byRate: [...byRate.values()] };
}

// A pre-line-item invoice (created before item-level tracking existed)
// has nothing in invoice_items — its only surviving breakdown is the
// matching b2b_hsn/b2c_hsn legacy row(s), linked via source_invoice_id/
// source_invoice_type. Reshaped to look like an invoice_items row so
// gstr1RecomputeInvoice() can treat both uniformly instead of needing a
// second code path.
function gstr1ItemsForInvoice(inv, type, itemsByInvoice, legacyHsnRows) {
  const live = itemsByInvoice[type + ':' + inv.id];
  if (live && live.length) return live;
  return legacyHsnRows
    .filter(r => r.source_invoice_id === inv.id && r.source_invoice_type === type)
    .map(r => ({ hsn_code: r.hsn_code, product_name: r.product_name, unit: null, quantity: +r.quantity || 0, taxable_value: +r.taxable_value || 0, gst_percentage: +r.gst_percentage || 0 }));
}

// ── POS (Place of Supply) — the one rule that determines everything
// else about how an invoice is classified in the filing. ──
// Registered customer: POS = first two digits of the CUSTOMER's own
// GSTIN — never derived indirectly from supply_type or the business's
// own state (that was the root cause of the old B2B POS bug).
function gstr1PosRegistered(customerGstin) {
  return (customerGstin || '').toUpperCase().slice(0, 2);
}
// Unregistered customer: POS = the customer's state code. 99 is reserved
// for genuine export/SEZ (no such concept exists anywhere in this app
// today) — never used as a silent fallback for an unrecognized/blank
// state, which getStateCode() on its own would otherwise do.
function gstr1PosUnregistered(customerState, errors, context) {
  const code = getStateCode(customerState);
  if (code === '99' && (customerState || '').trim()) {
    errors.push(`${context}: customer state "${customerState}" is not a recognized Indian state/UT — cannot derive a valid POS (99 is reserved for genuine export/SEZ, not unrecognized data).`);
  } else if (code === '99') {
    errors.push(`${context}: customer state is missing — cannot derive POS.`);
  }
  return code;
}

// ── Build the full payload. Every validation failure is appended to
// `errors` with enough context (invoice number, table, row) to act on —
// the payload is still fully built even when invalid so the caller can
// show every problem at once instead of stopping at the first one. ──
async function buildGSTR1Payload(userId, profile, periodFilter) {
  const errors = [];
  const { start, end } = getReportDateRange(periodFilter);

  // A GSTR-1 JSON is inherently a single filing PERIOD (one `fp`) — a
  // "Financial Year"/"Quarter" report selection spans several months and
  // has no single valid `fp` to put in the file. Reject those up front
  // rather than silently picking one month's worth of the label.
  const isSingleMonth = /^\d{4}-\d{2}$/.test(periodFilter) || periodFilter === 'current';
  if (!isSingleMonth) {
    errors.push(`Selected report period ("${periodFilter}") spans more than one calendar month. GSTR-1 is filed per month — select a specific month (or "Current Month") before generating the return.`);
    return { errors };
  }
  const startDate = new Date(start);
  const fp = String(startDate.getMonth() + 1).padStart(2, '0') + startDate.getFullYear();

  const businessGstin = (profile?.gstin || '').toUpperCase();
  const businessState = profile?.state || '';
  const businessGstinCheck = validateGstin(businessGstin);
  if (!businessGstinCheck.valid) {
    errors.push(`Business Profile GSTIN "${businessGstin}" is invalid (${businessGstinCheck.reason}). Fix it in Business Profile before generating a return.`);
  }

  const [b2bRes, b2cRes, itemsRes, hsnB2BRes, hsnB2CRes, cdnRes, srRes, srItemsRes] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('invoice_items').select('*').eq('user_id', userId),
    _supabase.from('b2b_hsn').select('*').eq('user_id', userId),
    _supabase.from('b2c_hsn').select('*').eq('user_id', userId),
    _supabase.from('cdn_notes').select('*').eq('user_id', userId).gte('note_date', start).lte('note_date', end),
    _supabase.from('sales_returns').select('*').eq('user_id', userId).gte('return_date', start).lte('return_date', end),
    _supabase.from('sales_return_items').select('*').eq('user_id', userId)
  ]);

  const b2bData = b2bRes.data || [], b2cData = b2cRes.data || [];
  const allItems = itemsRes.data || [];
  const legacyHsnRows = [...(hsnB2BRes.data || []), ...(hsnB2CRes.data || [])];
  const cdnNotes = cdnRes.data || [];
  const salesReturns = srRes.data || [];
  const srItemsAll = srItemsRes.data || [];

  const itemsByInvoice = {};
  allItems.forEach(r => {
    const key = r.invoice_type + ':' + r.invoice_id;
    (itemsByInvoice[key] = itemsByInvoice[key] || []).push(r);
  });
  const srItemsByReturn = {};
  srItemsAll.forEach(r => { (srItemsByReturn[r.return_id] = srItemsByReturn[r.return_id] || []).push(r); });

  // Duplicate invoice number check — b2b_invoices/b2c_invoices share one
  // numbering sequence app-wide, so any collision across the combined
  // period set is real data corruption, not a false positive.
  const seenInvNums = new Map();
  [...b2bData.map(r => ({ ...r, __kind: 'B2B' })), ...b2cData.map(r => ({ ...r, __kind: 'B2C' }))].forEach(inv => {
    const num = (inv.invoice_number || '').toUpperCase();
    if (!num) return;
    if (seenInvNums.has(num)) errors.push(`Duplicate invoice number "${inv.invoice_number}" (${seenInvNums.get(num)} and ${inv.__kind}) — invoice numbers must be unique.`);
    else seenInvNums.set(num, inv.__kind);
  });

  const hsnBuckets = new Map(); // "hsncode|rate" -> { hsn_sc, desc, uqc, qty, taxable, igst, cgst, sgst }
  function addToHsn(hsnCode, desc, uqc, qty, r, errCtx) {
    if (!gstr1HsnFormatOk(hsnCode)) { errors.push(`${errCtx}: HSN code "${hsnCode}" is not a valid 4/6/8-digit code.`); return; }
    const key = hsnCode + '|' + r.rate;
    if (!hsnBuckets.has(key)) hsnBuckets.set(key, { hsn_sc: hsnCode, desc: desc || '', uqc, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    const b = hsnBuckets.get(key);
    b.qty = round2(b.qty + (qty || 0));
    b.taxable = round2(b.taxable + r.taxable); b.igst = round2(b.igst + r.igst);
    b.cgst = round2(b.cgst + r.cgst); b.sgst = round2(b.sgst + r.sgst);
    // A later row can supply a UQC where an earlier one (e.g. a legacy
    // row with no unit at all) couldn't.
    if (b.uqc === 'OTH-OTHERS' && uqc !== 'OTH-OTHERS') b.uqc = uqc;
  }

  // ── B2B ──
  const b2bGroups = new Map(); // ctin -> inv[]
  b2bData.forEach(inv => {
    const ctx = `B2B invoice ${inv.invoice_number || inv.id}`;
    const gstin = (inv.gst_number || '').toUpperCase();
    const gCheck = validateGstin(gstin);
    if (!gCheck.valid) { errors.push(`${ctx}: customer GSTIN "${gstin}" is invalid (${gCheck.reason}).`); return; }
    if (!gstr1InvoiceNumberOk(inv.invoice_number)) { errors.push(`${ctx}: invoice number is not portal-valid (max 16 chars, letters/digits/-/ only).`); return; }
    const idt = formatDateDDMMYYYY(inv.invoice_date);
    if (!gstr1DateOk(idt)) { errors.push(`${ctx}: invoice date "${inv.invoice_date}" did not convert to a valid DD-MM-YYYY date.`); return; }
    if (inv.supply_type !== 'interstate' && inv.supply_type !== 'intrastate') { errors.push(`${ctx}: supply_type "${inv.supply_type}" is neither interstate nor intrastate.`); return; }

    const pos = gstr1PosRegistered(gstin);
    if (!GST_VALID_STATE_CODES.has(pos)) { errors.push(`${ctx}: derived POS "${pos}" (from customer GSTIN) is not a recognized state code.`); return; }
    // POS vs supply_type must agree — if they don't, one of the two is
    // stale/wrong (see the earlier Interstate/Intrastate detection fix
    // for exactly this class of bug on the entry form itself).
    const expectedSupplyType = pos === getStateCode(businessState) ? 'intrastate' : 'interstate';
    if (expectedSupplyType !== inv.supply_type) {
      errors.push(`${ctx}: supply_type is "${inv.supply_type}" but the customer GSTIN's state code ("${pos}") implies "${expectedSupplyType}" — these must agree.`);
    }

    const items = gstr1ItemsForInvoice(inv, 'b2b', itemsByInvoice, legacyHsnRows);
    if (!items.length) { errors.push(`${ctx}: has no line items (neither current nor legacy) — cannot compute taxable/tax values.`); return; }
    let itemsOk = true;
    items.forEach((it, idx) => {
      if (+it.quantity <= 0) { errors.push(`${ctx}, item ${idx + 1} ("${it.product_name}"): quantity must be greater than zero (got ${it.quantity}).`); itemsOk = false; }
      if (+it.taxable_value < 0) { errors.push(`${ctx}, item ${idx + 1} ("${it.product_name}"): taxable value cannot be negative (got ${it.taxable_value}).`); itemsOk = false; }
      const uqc = gstr1ToUQC(it.unit);
      addToHsn(it.hsn_code, it.product_name, uqc, +it.quantity || 0, gstr1RecomputeItem(it, inv.supply_type), `${ctx}, item ${idx + 1}`);
    });
    if (!itemsOk) return;

    const recomputed = gstr1RecomputeInvoice(items, inv.supply_type);
    if (Math.abs(recomputed.total - round2(+inv.total_amount)) > 0.02) {
      errors.push(`${ctx}: cached total (₹${round2(+inv.total_amount)}) does not match the total recomputed from line items (₹${recomputed.total}) — the invoice's stored totals are stale/corrupted.`);
      return;
    }

    const invEntry = {
      inum: inv.invoice_number, idt, val: recomputed.total, pos, rchrg: 'N', inv_typ: 'R',
      itms: recomputed.byRate.map((b, i) => ({ num: i + 1, itm_det: { txval: b.taxable, rt: b.rate, iamt: b.igst, camt: b.cgst, samt: b.sgst, csamt: 0 } }))
    };
    if (!b2bGroups.has(gstin)) b2bGroups.set(gstin, []);
    b2bGroups.get(gstin).push(invEntry);
  });
  const b2b = [...b2bGroups.entries()].map(([ctin, inv]) => ({ ctin, inv }));

  // ── B2C — split into B2CL (unregistered, inter-state, above
  // threshold — reported per-invoice) vs B2CS (everything else in the
  // B2C bucket — reported as a state+rate aggregate). The old generator
  // had no B2CL section at all. ──
  const b2clGroups = new Map(); // pos -> inv[]
  const b2csBuckets = new Map(); // "state|rate|supplyType" -> aggregate
  b2cData.forEach(inv => {
    const ctx = `B2C invoice ${inv.invoice_number || inv.id}`;
    if (inv.supply_type !== 'interstate' && inv.supply_type !== 'intrastate') { errors.push(`${ctx}: supply_type "${inv.supply_type}" is neither interstate nor intrastate.`); return; }
    const idt = formatDateDDMMYYYY(inv.invoice_date);
    if (!gstr1DateOk(idt)) { errors.push(`${ctx}: invoice date "${inv.invoice_date}" did not convert to a valid DD-MM-YYYY date.`); return; }

    const pos = gstr1PosUnregistered(inv.state, errors, ctx);
    if (!GST_VALID_STATE_CODES.has(pos) && pos !== '99') { errors.push(`${ctx}: derived POS "${pos}" is not a recognized state code.`); return; }

    const items = gstr1ItemsForInvoice(inv, 'b2c', itemsByInvoice, legacyHsnRows);
    if (!items.length) { errors.push(`${ctx}: has no line items (neither current nor legacy) — cannot compute taxable/tax values.`); return; }
    let itemsOk = true;
    items.forEach((it, idx) => {
      if (+it.quantity <= 0) { errors.push(`${ctx}, item ${idx + 1} ("${it.product_name}"): quantity must be greater than zero (got ${it.quantity}).`); itemsOk = false; }
      if (+it.taxable_value < 0) { errors.push(`${ctx}, item ${idx + 1} ("${it.product_name}"): taxable value cannot be negative (got ${it.taxable_value}).`); itemsOk = false; }
      const uqc = gstr1ToUQC(it.unit);
      addToHsn(it.hsn_code, it.product_name, uqc, +it.quantity || 0, gstr1RecomputeItem(it, inv.supply_type), `${ctx}, item ${idx + 1}`);
    });
    if (!itemsOk) return;

    const recomputed = gstr1RecomputeInvoice(items, inv.supply_type);
    if (Math.abs(recomputed.total - round2(+inv.total_amount)) > 0.02) {
      errors.push(`${ctx}: cached total (₹${round2(+inv.total_amount)}) does not match the total recomputed from line items (₹${recomputed.total}) — the invoice's stored totals are stale/corrupted.`);
      return;
    }

    const isLarge = inv.supply_type === 'interstate' && recomputed.total > GSTR1_B2CL_THRESHOLD;
    if (isLarge) {
      const invEntry = {
        inum: inv.invoice_number || `B2C-${inv.id.slice(0, 8)}`, idt, val: recomputed.total,
        itms: recomputed.byRate.map((b, i) => ({ num: i + 1, itm_det: { txval: b.taxable, rt: b.rate, iamt: b.igst, csamt: 0 } }))
      };
      if (!b2clGroups.has(pos)) b2clGroups.set(pos, []);
      b2clGroups.get(pos).push(invEntry);
    } else {
      recomputed.byRate.forEach(b => {
        const key = `${pos}|${b.rate}|${inv.supply_type}`;
        if (!b2csBuckets.has(key)) b2csBuckets.set(key, { sply_ty: inv.supply_type === 'interstate' ? 'INTER' : 'INTRA', pos, typ: 'OE', rt: b.rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
        const bucket = b2csBuckets.get(key);
        bucket.txval = round2(bucket.txval + b.taxable); bucket.iamt = round2(bucket.iamt + b.igst);
        bucket.camt = round2(bucket.camt + b.cgst); bucket.samt = round2(bucket.samt + b.sgst);
      });
    }
  });
  const b2cl = [...b2clGroups.entries()].map(([pos, inv]) => ({ pos, inv }));
  const b2cs = [...b2csBuckets.values()];

  // ── Sales Returns — net the returned quantity/value OUT of the HSN
  // summary for the period (a physical return genuinely reduces net
  // outward supply for that HSN+rate). Not fabricated into a CDNR/CDNUR
  // entry: this app's Sales Return module does not itself create a
  // matching credit note document, and GSTR-1 has no dedicated "sales
  // return" section of its own — inventing a credit note that doesn't
  // exist as a real document would be worse than omitting it. If the
  // business also issued a formal Credit Note for a return, that flows
  // through the cdn_notes/CDNR path below on its own. ──
  // Tracked separately (not just inferred from before/after HSN totals)
  // so the final audit can reconcile HSN against B2B+B2CL+B2CS using the
  // exact same adjustment figure this loop actually applied — see the
  // reconciliation note by runFinalGSTR1Audit() for why this must be
  // kept apart from CDNR/CDNUR's effect on turnover.
  let salesReturnNettedTaxable = 0;
  salesReturns.forEach(ret => {
    const items = srItemsByReturn[ret.id] || [];
    items.forEach((it, idx) => {
      const ctx = `Sales Return ${ret.return_number || ret.id}, item ${idx + 1} ("${it.product_name}")`;
      if (+it.quantity <= 0) { errors.push(`${ctx}: return quantity must be greater than zero.`); return; }
      if (!gstr1HsnFormatOk(it.hsn_code)) { errors.push(`${ctx}: HSN code "${it.hsn_code}" is not a valid 4/6/8-digit code.`); return; }
      const r = gstr1RecomputeItem(it, ret.supply_type);
      const key = it.hsn_code + '|' + r.rate;
      const bucket = hsnBuckets.get(key);
      if (!bucket) return; // return references an HSN/rate with no matching outward supply this period — nothing to net against, not an error on its own
      const newTaxable = round2(bucket.taxable - r.taxable);
      if (newTaxable < 0) {
        errors.push(`${ctx}: netting this return against HSN ${it.hsn_code} at ${r.rate}% would make the period's HSN taxable value negative (${newTaxable}) — this return likely belongs to a different filing period than the original sale.`);
        return;
      }
      bucket.taxable = newTaxable;
      bucket.qty = round2(bucket.qty - (+it.quantity || 0));
      bucket.igst = round2(bucket.igst - r.igst); bucket.cgst = round2(bucket.cgst - r.cgst); bucket.sgst = round2(bucket.sgst - r.sgst);
      salesReturnNettedTaxable = round2(salesReturnNettedTaxable + r.taxable);
    });
  });

  // ── CDNR / CDNUR — Credit and Debit Notes, split by whether the note
  // carries a customer GSTIN (registered -> CDNR, grouped by ctin like
  // B2B) or not (unregistered -> CDNUR, flat array). cdn_notes has no
  // line-item/HSN table of its own (single rate per note, same shape the
  // whole app's B2B/B2C invoice headers used before line items existed)
  // — so, same as B2B/B2C above, each note can only ever produce exactly
  // one itms[] entry; it is NOT included in the HSN section, since there
  // is no HSN code recorded against a credit/debit note anywhere in the
  // schema to attribute it to. ──
  const cdnrGroups = new Map();
  const cdnur = [];
  cdnNotes.forEach(note => {
    const ctx = `${note.note_type === 'credit' ? 'Credit' : 'Debit'} Note ${note.note_number || note.id}`;
    if (!['credit', 'debit'].includes(note.note_type)) { errors.push(`${ctx}: note_type "${note.note_type}" must be credit or debit.`); return; }
    if (note.supply_type !== 'interstate' && note.supply_type !== 'intrastate') { errors.push(`${ctx}: supply_type "${note.supply_type}" is neither interstate nor intrastate.`); return; }
    const ntty = note.note_type === 'credit' ? 'C' : 'D';
    const ntDt = formatDateDDMMYYYY(note.note_date);
    if (!gstr1DateOk(ntDt)) { errors.push(`${ctx}: note date "${note.note_date}" did not convert to a valid DD-MM-YYYY date.`); return; }
    if (+note.taxable_amount <= 0) { errors.push(`${ctx}: taxable amount must be greater than zero (got ${note.taxable_amount}).`); return; }

    const taxable = round2(+note.taxable_amount);
    const calc = calcGST(taxable, +note.gst_percentage || 0, note.supply_type);
    const val = round2(taxable + calc.gstAmount);
    const gstin = (note.gstin || '').toUpperCase();

    if (gstin) {
      const gCheck = validateGstin(gstin);
      if (!gCheck.valid) { errors.push(`${ctx}: customer GSTIN "${gstin}" is invalid (${gCheck.reason}).`); return; }
      const pos = gstr1PosRegistered(gstin);
      const entry = { ntty, nt_num: note.note_number, nt_dt: ntDt, pos, rchrg: 'N', val, itms: [{ num: 1, itm_det: { txval: taxable, rt: +note.gst_percentage || 0, iamt: calc.igst, camt: calc.cgst, samt: calc.sgst, csamt: 0 } }] };
      if (!cdnrGroups.has(gstin)) cdnrGroups.set(gstin, []);
      cdnrGroups.get(gstin).push(entry);
    } else {
      const pos = gstr1PosUnregistered(note.state, errors, ctx);
      // Unregistered credit/debit notes are reported under the same
      // large-value B2CL-style bucket, per GSTN's CDNUR shape — there is
      // no lower-value aggregate section for CDNUR the way B2CS covers
      // small B2C invoices.
      cdnur.push({ typ: 'B2CL', ntty, nt_num: note.note_number, nt_dt: ntDt, pos, val, itms: [{ num: 1, itm_det: { txval: taxable, rt: +note.gst_percentage || 0, iamt: calc.igst, csamt: 0 } }] });
    }
  });
  const cdnr = [...cdnrGroups.entries()].map(([ctin, nt]) => ({ ctin, nt }));

  // hsnBuckets is keyed "hsn_sc|rate", so each bucket maps to exactly
  // one rate — pulled straight from the key rather than stored twice.
  const hsn = { data: [...hsnBuckets.entries()].map(([key, b], i) => ({
    num: i + 1, hsn_sc: b.hsn_sc, desc: b.desc, uqc: b.uqc, qty: b.qty,
    txval: b.taxable, rt: +key.split('|')[1], iamt: b.igst, camt: b.cgst, samt: b.sgst, csamt: 0
  })) };

  const gt = round2(
    b2b.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.val, 0), 0) +
    b2cl.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.val, 0), 0) +
    b2cs.reduce((s, r) => s + round2(r.txval + r.iamt + r.camt + r.samt), 0) -
    cdnr.reduce((s, g) => s + g.nt.reduce((s2, n) => s2 + (n.ntty === 'C' ? n.val : -n.val), 0), 0) -
    cdnur.reduce((s, n) => s + (n.ntty === 'C' ? n.val : -n.val), 0)
  );

  const payload = { gstin: businessGstin, fp, gt, cur_gt: gt, b2b, b2cl, b2cs, cdnr, cdnur, hsn };
  return { payload, errors, context: { periodStart: start, periodEnd: end, salesReturnNettedTaxable } };
}

// ── Final audit — a fully independent second pass over the ALREADY-BUILT
// payload, re-deriving every total from the payload's own arrays and
// cross-checking them against each other. This is the reconciliation gate
// the brief calls out explicitly: it exists so that if a future edit to
// buildGSTR1Payload() ever breaks the invariant that B2B+B2CL+B2CS+
// adjustments == HSN taxable total, the export refuses to run instead of
// silently producing a file that fails on the Portal. ──
function runFinalGSTR1Audit(payload, errors, context) {
  // 1. JSON Parse — round-trip through JSON.stringify/parse; anything
  // that can't survive that (a stray undefined turned into a hole, NaN,
  // circular ref) fails here before it ever reaches disk.
  let reparsed;
  try { reparsed = JSON.parse(JSON.stringify(payload)); }
  catch (e) { errors.push(`JSON serialization failed: ${e.message}`); return; }

  // 2. Mandatory top-level keys / schema shape.
  const requiredKeys = ['gstin', 'fp', 'gt', 'cur_gt', 'b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'hsn'];
  requiredKeys.forEach(k => { if (!(k in reparsed)) errors.push(`Final audit: missing mandatory key "${k}" in the payload.`); });
  const unknownKeys = Object.keys(reparsed).filter(k => !requiredKeys.includes(k));
  if (unknownKeys.length) errors.push(`Final audit: unexpected key(s) in the payload: ${unknownKeys.join(', ')}.`);
  if (!Array.isArray(reparsed.b2b) || !Array.isArray(reparsed.b2cl) || !Array.isArray(reparsed.b2cs) || !Array.isArray(reparsed.cdnr) || !Array.isArray(reparsed.cdnur)) {
    errors.push('Final audit: b2b/b2cl/b2cs/cdnr/cdnur must all be arrays.');
  }
  if (!reparsed.hsn || !Array.isArray(reparsed.hsn.data)) errors.push('Final audit: hsn.data must be an array.');

  // 3. GSTIN — filer's own GSTIN, re-validated on the built payload.
  const filerCheck = validateGstin(reparsed.gstin);
  if (!filerCheck.valid) errors.push(`Final audit: filer GSTIN "${reparsed.gstin}" is invalid (${filerCheck.reason}).`);

  // 4. fp format — exactly MMYYYY, 6 digits.
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(reparsed.fp || '')) errors.push(`Final audit: filing period "${reparsed.fp}" is not a valid MMYYYY value.`);

  // 5. Mathematical reconciliation — "Invoice taxable total = B2B +
  // B2CL + B2CS + adjustments AND = HSN taxable total."
  //
  // The only "adjustment" that can legitimately apply to this check is
  // sales-return netting: HSN rows are built by summing B2B+B2CL+B2CS
  // line items by HSN+rate and then subtracting returned quantity/value
  // for that same HSN+rate (see buildGSTR1Payload's Sales Returns
  // section) — so HSN taxable is *always* (B2B+B2CL+B2CS) minus exactly
  // that netted figure, never more, never less.
  //
  // CDNR/CDNUR (Credit/Debit Notes) are deliberately NOT part of this
  // specific check: cdn_notes has no hsn_code column anywhere in the
  // schema, so a note can never be attributed to an HSN row in the first
  // place — comparing HSN against a total that includes them would be
  // comparing two numbers that were never supposed to be equal, not a
  // real reconciliation. Their effect on the filer's overall turnover is
  // checked separately in the Grand Total check (#6) instead, which is
  // the number they actually belong to.
  const sumItmTaxable = (invArr) => invArr.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.itms.reduce((s3, it) => s3 + it.itm_det.txval, 0), 0), 0);
  const b2bTaxable = round2(sumItmTaxable(reparsed.b2b));
  const b2clTaxable = round2(sumItmTaxable(reparsed.b2cl));
  const b2csTaxable = round2(reparsed.b2cs.reduce((s, r) => s + r.txval, 0));
  const salesReturnNettedTaxable = round2(context?.salesReturnNettedTaxable || 0);
  const invoiceSideTaxable = round2(b2bTaxable + b2clTaxable + b2csTaxable - salesReturnNettedTaxable);
  const hsnTaxable = round2(reparsed.hsn.data.reduce((s, r) => s + r.txval, 0));
  if (Math.abs(invoiceSideTaxable - hsnTaxable) > 0.05) {
    errors.push(`Final audit — RECONCILIATION FAILED: (B2B + B2CL + B2CS − Sales Return adjustments) = ₹${invoiceSideTaxable} does not equal HSN section taxable total (₹${hsnTaxable}). Difference: ₹${round2(invoiceSideTaxable - hsnTaxable)}.`);
  }

  // 5b. CDNR/CDNUR self-consistency — each note's stated val must equal
  // its own itms' taxable + tax (this is what actually needs to
  // reconcile for notes, since HSN structurally can't).
  const noteValOk = (n) => Math.abs(n.val - round2(n.itms.reduce((s, it) => s + it.itm_det.txval + (it.itm_det.iamt || 0) + (it.itm_det.camt || 0) + (it.itm_det.samt || 0), 0))) <= 0.05;
  reparsed.cdnr.forEach(g => g.nt.forEach(n => { if (!noteValOk(n)) errors.push(`Final audit: CDNR note ${n.nt_num} val (₹${n.val}) does not match its own item total.`); }));
  reparsed.cdnur.forEach(n => { if (!noteValOk(n)) errors.push(`Final audit: CDNUR note ${n.nt_num} val (₹${n.val}) does not match its own item total.`); });

  // 6. Grand total — gt/cur_gt must equal the sum of every section's own
  // invoice-level value (independently re-derived here, not just trusted
  // from whatever buildGSTR1Payload() computed).
  const sumVal = (invArr) => invArr.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.val, 0), 0);
  const b2bVal = sumVal(reparsed.b2b), b2clVal = sumVal(reparsed.b2cl);
  const b2csVal = reparsed.b2cs.reduce((s, r) => s + round2(r.txval + r.iamt + r.camt + r.samt), 0);
  const cdnrVal = reparsed.cdnr.reduce((s, g) => s + g.nt.reduce((s2, n) => s2 + (n.ntty === 'C' ? n.val : -n.val), 0), 0);
  const cdnurVal = reparsed.cdnur.reduce((s, n) => s + (n.ntty === 'C' ? n.val : -n.val), 0);
  const recomputedGt = round2(b2bVal + b2clVal + b2csVal - cdnrVal - cdnurVal);
  if (Math.abs(recomputedGt - reparsed.gt) > 0.05) {
    errors.push(`Final audit — GRAND TOTAL MISMATCH: payload.gt (₹${reparsed.gt}) does not equal the independently recomputed grand total (₹${recomputedGt}).`);
  }
  if (reparsed.gt !== reparsed.cur_gt) errors.push(`Final audit: gt (₹${reparsed.gt}) and cur_gt (₹${reparsed.cur_gt}) must be equal for a first-time filing.`);

  // 7. GSTIN validation across every section.
  reparsed.b2b.forEach(g => { if (!validateGstin(g.ctin).valid) errors.push(`Final audit: B2B section ctin "${g.ctin}" is invalid.`); });
  reparsed.cdnr.forEach(g => { if (!validateGstin(g.ctin).valid) errors.push(`Final audit: CDNR section ctin "${g.ctin}" is invalid.`); });

  // 8. POS validation across every section.
  const checkPos = (pos, where) => { if (!GST_VALID_STATE_CODES.has(pos) && pos !== '99') errors.push(`Final audit: invalid POS "${pos}" in ${where}.`); };
  reparsed.b2b.forEach(g => g.inv.forEach(i => checkPos(i.pos, `B2B invoice ${i.inum}`)));
  reparsed.b2cl.forEach(g => checkPos(g.pos, `B2CL group`));
  reparsed.b2cs.forEach(r => checkPos(r.pos, `B2CS bucket (rate ${r.rt}%)`));

  // 9. HSN validation — format, and no duplicate hsn+rate rows (the
  // bucket map construction already prevents this internally, but the
  // final audit re-checks the actual array that will be written).
  const hsnSeen = new Set();
  reparsed.hsn.data.forEach(row => {
    if (!gstr1HsnFormatOk(row.hsn_sc)) errors.push(`Final audit: HSN row "${row.hsn_sc}" is not a valid 4/6/8-digit code.`);
    const key = row.hsn_sc + '|' + row.rt;
    if (hsnSeen.has(key)) errors.push(`Final audit: duplicate HSN row for code ${row.hsn_sc} at rate ${row.rt}%.`);
    hsnSeen.add(key);
    if (row.qty <= 0) errors.push(`Final audit: HSN row ${row.hsn_sc} has non-positive quantity (${row.qty}).`);
    if (row.txval < 0) errors.push(`Final audit: HSN row ${row.hsn_sc} has negative taxable value (${row.txval}).`);
  });
}

// ── UI: validation-failure modal (never a native alert()) ──
function showGSTR1ValidationErrors(errors) {
  const modal = document.getElementById('gstr1ValidationModal');
  const list = document.getElementById('gstr1ValidationList');
  if (!modal || !list) { showToast(`GSTR-1 export blocked — ${errors.length} validation error(s). See console.`, 'error'); console.error('GSTR-1 validation errors:', errors); return; }
  list.innerHTML = errors.map(e => `<li>${escItemHtml(e)}</li>`).join('');
  modal.classList.add('open');
}
function closeGSTR1ValidationModal() {
  document.getElementById('gstr1ValidationModal')?.classList.remove('open');
}

// ── Entry point — re-derives the period from the report page's own
// filter (the single source of truth for "what period is being
// exported"), so there is no separate stale copy of that decision passed
// around through function arguments. ──
async function exportGSTR1JSON() {
  const user = await getCurrentUser();
  if (!user) return;
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const periodFilter = document.getElementById('reportMonth')?.value || 'current';

  showToast('Validating GSTR-1 data…', 'success');
  const { payload, errors, context } = await buildGSTR1Payload(user.id, profile, periodFilter);

  if (!errors.length) runFinalGSTR1Audit(payload, errors, context);

  if (errors.length) {
    showGSTR1ValidationErrors(errors);
    return; // never write the file
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `GSTR1_${payload.fp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('GSTR-1 JSON validated and exported — ready to upload to the GST Portal.', 'success');
}

function formatDateDDMMYYYY(d) {
  if (!d) return '';
  const parts = String(d).split('-');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return d;
}

function getStateCode(stateName) {
  const map = {
    'andhra pradesh':'37','arunachal pradesh':'12','assam':'18','bihar':'10',
    'chhattisgarh':'22','goa':'30','gujarat':'24','haryana':'06','himachal pradesh':'02',
    'jharkhand':'20','karnataka':'29','kerala':'32','madhya pradesh':'23','maharashtra':'27',
    'manipur':'14','meghalaya':'17','mizoram':'15','nagaland':'13','odisha':'21',
    'punjab':'03','rajasthan':'08','sikkim':'11','tamil nadu':'33','telangana':'36',
    'tripura':'16','uttar pradesh':'09','uttarakhand':'05','west bengal':'19',
    'andaman and nicobar':'35','chandigarh':'04','dadra and nagar haveli':'26',
    'daman and diu':'25','delhi':'07','jammu and kashmir':'01','ladakh':'38',
    'lakshadweep':'31','puducherry':'34'
  };
  return map[(stateName || '').toLowerCase()] || '99';
}
