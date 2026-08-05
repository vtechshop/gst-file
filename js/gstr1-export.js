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

// One rounding-tolerance constant for every "do these two independently
// computed money figures agree" check in this file (was previously two
// different unnamed magic numbers — 0.02 on the cached-total checks,
// 0.05 on the final-audit checks — with no reason for the two figures
// to differ). ₹0.05 comfortably absorbs legitimate per-line round2()
// noise across several summed items without masking a real mismatch.
const GSTR1_RECONCILE_TOLERANCE = 0.05;

// Server-side `in_<column>` filters (server/routes/generic.js) are still
// passed as one query-string value — chunking the id list keeps any
// single request's URL comfortably under typical server/proxy length
// limits even for a filing period with several thousand invoices,
// without falling back to one request per invoice (real N+1).
const GSTR1_ID_CHUNK_SIZE = 300;

// UQC (Unit Quantity Code) — maps the bare unit text this app stores on
// invoice_items.unit (see COMMON_UNITS in js/utils.js) to the code a
// return carries.
//
// Bare codes, not the compound "NOS-NUMBERS" form this used to emit. A
// GSTR-1 written by the official Offline Utility carries "NOS" and "NA"
// (see the reference file: hsn_b2b rows use "NOS", the service row with
// qty 0 uses "NA"), so the compound form was wrong in every row we ever
// produced.
const GSTR1_UQC_MAP = {
  'PCS': 'PCS', 'NOS': 'NOS', 'KG': 'KGS', 'LTR': 'LTR', 'MTR': 'MTR',
  'BOX': 'BOX', 'SET': 'SET', 'PAIR': 'PRS', 'DOZ': 'DOZ',
  'BAG': 'BAG', 'BTL': 'BTL'
  // 'HRS' (hours) is deliberately unmapped: a service carries no unit of
  // measure, and the reference file uses "NA" for exactly that case.
};

// "NA" is what the official Utility writes on a SERVICE line — its
// reference return carries uqc "NA" against HSN 998719 with qty 0. It is
// not a general fallback: the Portal rejected our return with
// "The UQC entered is not valid" (RET191353) on four goods lines that
// carried it, because a physical good has a unit of measure and NA says
// it has none.
const GSTR1_UQC_SERVICE = 'NA';

// Services live in HSN chapter 99. That is where the reference file's own
// NA line sits (998719), which is the only evidence available here for
// when NA is accepted.
function gstr1IsServiceHsn(hsnCode) {
  return /^99/.test(String(hsnCode || '').trim());
}

// The UQC for a line, or null when it cannot be determined. Null is not a
// value to export — the caller refuses the export and names the product,
// because inventing a unit for someone else's goods is a guess about
// what they sold, and the Portal will reject the wrong one anyway.
function gstr1ToUQC(unit, hsnCode) {
  const key = (unit || '').trim().toUpperCase();
  if (GSTR1_UQC_MAP[key]) return GSTR1_UQC_MAP[key];
  if (gstr1IsServiceHsn(hsnCode)) return GSTR1_UQC_SERVICE;
  return null;
}

// ── Root metadata written by the official Offline Utility ───
// Copied verbatim from a Utility-generated return; neither value is
// derived or guessed. "hash" really is the literal string "hash" in that
// file. One constant each, so a future Utility revision is one edit.
const GSTR1_VERSION = 'GST3.1.7';
const GSTR1_HASH = 'hash';

// ── Payload section registry ────────────────────────────────
// The single declaration of what a payload from this generator contains.
// Adding a section means adding one entry here and a builder that fills
// it — the assembler, the schema validator and the final audit all read
// this table and need no edit of their own. It replaces a top-level key
// list that was hardcoded inside the audit, where any new section was
// rejected as an "unexpected key" by the very check meant to protect the
// payload.
//
// emitWhenEmpty records what this generator does with a section that has
// nothing in it. All of them are now FALSE: a return written by the
// official Offline Utility contains only the sections that have data —
// its b2cl, cdnr and cdnur keys are absent, not empty arrays. We used to
// write "b2cl":[] and the like on every export.
//
// Key order below is the order the Utility writes: identity, then
// metadata, then sections.
const GSTR1_SECTIONS = [
  { key: 'gstin',   kind: 'header',  type: 'string' },
  { key: 'fp',      kind: 'header',  type: 'string' },
  { key: 'version', kind: 'header',  type: 'string' },
  { key: 'hash',    kind: 'header',  type: 'string' },
  { key: 'b2b',     kind: 'section', type: 'array',  label: 'B2B — registered supplies',            emitWhenEmpty: false },
  { key: 'b2cl',    kind: 'section', type: 'array',  label: 'B2CL — large inter-state B2C',          emitWhenEmpty: false },
  { key: 'b2cs',    kind: 'section', type: 'array',  label: 'B2CS — small B2C, state+rate summary',  emitWhenEmpty: false },
  { key: 'cdnr',    kind: 'section', type: 'array',  label: 'CDNR — notes to registered customers',  emitWhenEmpty: false },
  { key: 'cdnur',   kind: 'section', type: 'array',  label: 'CDNUR — notes to unregistered',         emitWhenEmpty: false },
  // Split by supply channel, exactly as the Utility writes it. This was a
  // single combined data[] array under a key the schema has no place for.
  { key: 'hsn',     kind: 'section', type: 'object', label: 'HSN summary',                           emitWhenEmpty: false,
    isEmpty: v => !(v && ((v.hsn_b2b && v.hsn_b2b.length) || (v.hsn_b2c && v.hsn_b2c.length))) },
  { key: 'doc_issue', kind: 'section', type: 'object', label: 'Documents issued',                    emitWhenEmpty: false,
    isEmpty: v => !(v && Array.isArray(v.doc_det) && v.doc_det.length) }
];

// Sections this generator does not produce, and why. Every one is
// reported at export time so what is absent from the file is stated
// rather than left for the Portal to discover.
//
// These are omissions of DATA, not of schema: the application has no
// model for any of them, so there is nothing to serialise. None is
// emitted as an empty stub — a stub asserts "there were none of these
// this period", which this codebase cannot know. Whether a given filing
// requires any of them is a question for the Portal, not for this file.
const GSTR1_UNPRODUCED_SECTIONS = [
  { key: 'exp',       label: 'Exports',                     reason: 'no export-invoice model exists in this application' },
  { key: 'at',        label: 'Advances received',           reason: 'no advance-receipt model exists in this application' },
  { key: 'txpd',      label: 'Advances adjusted',           reason: 'no advance-adjustment model exists in this application' },
  { key: 'nil',       label: 'Nil-rated / exempt / non-GST', reason: 'invoice lines carry no nil/exempt/non-GST classification' },
  { key: 'amendments', label: 'Amendments to earlier periods', reason: 'this application does not track amendments to already-filed returns' }
];

const GSTR1_SECTION_KEYS = GSTR1_SECTIONS.map(s => s.key);
const gstr1Section = key => GSTR1_SECTIONS.find(s => s.key === key);
function gstr1SectionIsEmpty(spec, value) {
  if (spec.isEmpty) return spec.isEmpty(value);
  return Array.isArray(value) ? value.length === 0 : !value;
}

// Assembles the payload in registry order from a { key: value } map, so
// key order in the written file follows the table above rather than the
// order the builders happen to finish in.
function assembleGSTR1Payload(parts) {
  const payload = {};
  GSTR1_SECTIONS.forEach(spec => {
    const value = parts[spec.key];
    if (spec.kind === 'section' && !spec.emitWhenEmpty && gstr1SectionIsEmpty(spec, value)) return;
    payload[spec.key] = value;
  });
  return payload;
}

// ── Schema validation, run before the file is written ───────
// Checks the payload against the registry: every declared key present,
// every value the declared type, nothing present that was never
// declared. The row-shape checks below assert the contract each builder
// in this file is written to produce — they catch a builder that has
// drifted from the shape the rest of the file assumes. They are NOT a
// transcription of GSTN's published schema, which this codebase does not
// have; no field is required here that this generator does not already
// set, and none is invented.
function gstr1RequireKeys(obj, keys, where, errors) {
  if (!obj || typeof obj !== 'object') { errors.push(`Schema: ${where} is not an object.`); return false; }
  const missing = keys.filter(k => obj[k] === undefined || obj[k] === null);
  if (missing.length) errors.push(`Schema: ${where} is missing ${missing.map(k => `"${k}"`).join(', ')}.`);
  return !missing.length;
}

function validateGSTR1Schema(payload, errors) {
  if (!payload || typeof payload !== 'object') { errors.push('Schema: payload is not an object.'); return; }

  GSTR1_SECTIONS.forEach(spec => {
    const value = payload[spec.key];
    const omittedLegitimately = spec.kind === 'section' && !spec.emitWhenEmpty && value === undefined;
    if (value === undefined) {
      if (!omittedLegitimately) errors.push(`Schema: mandatory key "${spec.key}"${spec.label ? ` (${spec.label})` : ''} is missing from the payload.`);
      return;
    }
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (actual !== spec.type) errors.push(`Schema: "${spec.key}" must be ${spec.type}, got ${actual}.`);
  });

  // Unknown keys are derived from the registry, never from a second list
  // that has to be kept in step with it.
  Object.keys(payload)
    .filter(k => !GSTR1_SECTION_KEYS.includes(k))
    .forEach(k => errors.push(`Schema: "${k}" is not a declared section — add it to GSTR1_SECTIONS if it belongs in the payload.`));

  // Row shapes, per the builders in this file.
  const asRows = v => Array.isArray(v) ? v : [];
  asRows(payload.b2b).forEach((g, i) => {
    if (!gstr1RequireKeys(g, ['ctin', 'inv'], `b2b[${i}]`, errors)) return;
    if (!Array.isArray(g.inv)) { errors.push(`Schema: b2b[${i}].inv must be an array.`); return; }
    g.inv.forEach((inv, j) => {
      if (!gstr1RequireKeys(inv, ['inum', 'idt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms'], `b2b[${i}].inv[${j}]`, errors)) return;
      gstr1ValidateItms(inv.itms, `b2b[${i}].inv[${j}].itms`, ['txval', 'rt', 'iamt', 'camt', 'samt', 'csamt'], errors);
    });
  });
  asRows(payload.b2cl).forEach((g, i) => {
    if (!gstr1RequireKeys(g, ['pos', 'inv'], `b2cl[${i}]`, errors)) return;
    if (!Array.isArray(g.inv)) { errors.push(`Schema: b2cl[${i}].inv must be an array.`); return; }
    g.inv.forEach((inv, j) => {
      if (!gstr1RequireKeys(inv, ['inum', 'idt', 'val', 'itms'], `b2cl[${i}].inv[${j}]`, errors)) return;
      gstr1ValidateItms(inv.itms, `b2cl[${i}].inv[${j}].itms`, ['txval', 'rt', 'iamt', 'csamt'], errors);
    });
  });
  asRows(payload.b2cs).forEach((r, i) =>
    gstr1RequireKeys(r, ['sply_ty', 'pos', 'typ', 'rt', 'txval', 'iamt', 'camt', 'samt', 'csamt'], `b2cs[${i}]`, errors));
  asRows(payload.cdnr).forEach((g, i) => {
    if (!gstr1RequireKeys(g, ['ctin', 'nt'], `cdnr[${i}]`, errors)) return;
    if (!Array.isArray(g.nt)) { errors.push(`Schema: cdnr[${i}].nt must be an array.`); return; }
    g.nt.forEach((n, j) => {
      if (!gstr1RequireKeys(n, ['ntty', 'nt_num', 'nt_dt', 'pos', 'rchrg', 'val', 'itms'], `cdnr[${i}].nt[${j}]`, errors)) return;
      gstr1ValidateItms(n.itms, `cdnr[${i}].nt[${j}].itms`, ['txval', 'rt', 'iamt', 'camt', 'samt', 'csamt'], errors);
    });
  });
  asRows(payload.cdnur).forEach((n, i) => {
    if (!gstr1RequireKeys(n, ['typ', 'ntty', 'nt_num', 'nt_dt', 'pos', 'val', 'itms'], `cdnur[${i}]`, errors)) return;
    gstr1ValidateItms(n.itms, `cdnur[${i}].itms`, ['txval', 'rt', 'iamt', 'csamt'], errors);
  });
  if (payload.hsn) {
    const known = ['hsn_b2b', 'hsn_b2c'];
    Object.keys(payload.hsn).filter(k => !known.includes(k)).forEach(k =>
      errors.push(`Schema: hsn.${k} is not a recognised HSN array — the summary is split into hsn_b2b and hsn_b2c.`));
    known.forEach(k => {
      if (payload.hsn[k] === undefined) return;
      if (!Array.isArray(payload.hsn[k])) { errors.push(`Schema: hsn.${k} must be an array.`); return; }
      payload.hsn[k].forEach((r, i) =>
        gstr1RequireKeys(r, ['num', 'hsn_sc', 'desc', 'uqc', 'qty', 'txval', 'rt', 'iamt', 'camt', 'samt', 'csamt'], `hsn.${k}[${i}]`, errors));
    });
  }
  if (payload.doc_issue) {
    if (!Array.isArray(payload.doc_issue.doc_det)) {
      errors.push('Schema: doc_issue.doc_det must be an array.');
    } else {
      payload.doc_issue.doc_det.forEach((d, i) => {
        if (!gstr1RequireKeys(d, ['doc_num', 'doc_typ', 'docs'], `doc_issue.doc_det[${i}]`, errors)) return;
        if (!Array.isArray(d.docs)) { errors.push(`Schema: doc_issue.doc_det[${i}].docs must be an array.`); return; }
        d.docs.forEach((x, j) =>
          gstr1RequireKeys(x, ['num', 'from', 'to', 'totnum', 'cancel', 'net_issue'], `doc_issue.doc_det[${i}].docs[${j}]`, errors));
      });
    }
  }
}

function gstr1ValidateItms(itms, where, detKeys, errors) {
  if (!Array.isArray(itms)) { errors.push(`Schema: ${where} must be an array.`); return; }
  if (!itms.length) { errors.push(`Schema: ${where} is empty — every invoice/note needs at least one rate line.`); return; }
  itms.forEach((it, k) => {
    if (!gstr1RequireKeys(it, ['num', 'itm_det'], `${where}[${k}]`, errors)) return;
    if (gstr1RequireKeys(it.itm_det, detKeys, `${where}[${k}].itm_det`, errors)) {
      detKeys.forEach(f => {
        if (typeof it.itm_det[f] !== 'number' || !isFinite(it.itm_det[f])) {
          errors.push(`Schema: ${where}[${k}].itm_det.${f} must be a finite number, got ${JSON.stringify(it.itm_det[f])}.`);
        }
      });
    }
  });
}

// ── Validation error record ─────────────────────────────────
// A validation failure is only useful if the person reading it can act on
// it, which means naming the document, the line, the field, what is there
// now, what belongs there, and what to do. Errors used to be one prose
// sentence each; the same information is now carried in fields so the
// report can lay it out and so tests can assert on a field rather than on
// a sentence.
//
// Plain strings are still accepted anywhere an error is collected — the
// schema checks raise those, since they describe a JSON path rather than
// a document — and are normalised on the way out.
function gstr1Err({ invoice, customer, product, field, current, expected, fix, message }) {
  return { invoice, customer, product, field, current, expected, fix, message, __gstr1Err: true };
}

// One-line rendering, for the console and for anything that wants text.
function gstr1ErrorText(e) {
  if (typeof e === 'string') return e;
  if (!e || !e.__gstr1Err) return String(e);
  const where = [e.invoice && `Invoice ${e.invoice}`, e.customer && `customer ${e.customer}`, e.product && `item "${e.product}"`]
    .filter(Boolean).join(', ');
  const what = e.message || `${e.field}: ${JSON.stringify(e.current)} — expected ${e.expected}`;
  return [where, what, e.fix && `Fix: ${e.fix}`].filter(Boolean).join(' — ');
}

// ── Lookup tables the generator validates its own output against ──
// Every UQC this generator can emit. Derived from GSTR1_UQC_MAP rather
// than written out again, so the emitter and the validator cannot
// disagree about what is emittable. Whether GSTN's master list matches
// this set is NOT something this codebase can settle — the check here is
// that nothing outside our own map ever reaches the file.
const GSTR1_EMITTABLE_UQC = new Set([...Object.values(GSTR1_UQC_MAP), GSTR1_UQC_SERVICE]);

// The values this generator itself produces for these fields. Asserted so
// a future edit cannot introduce a third value silently; they are our
// emitted vocabulary, not a transcription of GSTN's.
const GSTR1_EMITTED_INV_TYP = new Set(['R']);          // buildGSTR1Payload sets 'R' on every B2B invoice
const GSTR1_EMITTED_RCHRG = new Set(['N']);            // ... and 'N' for reverse charge
const GSTR1_EMITTED_NTTY = new Set(['C', 'D']);        // credit / debit note
const GSTR1_EMITTED_SPLY_TY = new Set(['INTER', 'INTRA']);
const GSTR1_EMITTED_B2CS_TYP = new Set(['OE']);
const GSTR1_EMITTED_CDNUR_TYP = new Set(['B2CL']);

// ── Strict pre-export validation ────────────────────────────
// Runs over the assembled payload and refuses anything that cannot be a
// correct return. It checks values this generator is responsible for
// producing — nothing here asserts a rule that could not be derived from
// this codebase, and no field is required that the generator does not
// already set.
function gstr1CheckMoney(value, field, where, errors, { allowNegative = false } = {}) {
  if (typeof value !== 'number' || !isFinite(value)) {
    errors.push(gstr1Err({ field: `${where}.${field}`, current: value, expected: 'a finite number',
      fix: 'This is produced by the generator, not entered by hand — report it if you see it.' }));
    return false;
  }
  if (!allowNegative && value < 0) {
    errors.push(gstr1Err({ field: `${where}.${field}`, current: value, expected: 'zero or more',
      fix: 'A negative amount in a return usually means a credit note was recorded as an invoice.' }));
    return false;
  }
  if (round2(value) !== value) {
    errors.push(gstr1Err({ field: `${where}.${field}`, current: value, expected: 'at most 2 decimal places',
      fix: 'Rounding is applied by the generator — report it if you see it.' }));
    return false;
  }
  return true;
}

// The tax split must agree with the supply type: an intra-state supply
// carries CGST+SGST and no IGST, an inter-state supply the reverse. This
// is the shape calcGST() produces (js/utils.js), so a payload that breaks
// it means something downstream has rewritten the figures.
function gstr1CheckTaxSplit(det, splyTy, where, errors) {
  const inter = splyTy === 'INTER';
  if (inter && (det.camt || det.samt)) {
    errors.push(gstr1Err({ field: `${where}`, current: `CGST ${det.camt}, SGST ${det.samt}`,
      expected: 'CGST and SGST both zero on an inter-state supply',
      fix: 'Check the invoice\'s Interstate/Intrastate setting against the place of supply.' }));
  }
  if (!inter && det.iamt) {
    errors.push(gstr1Err({ field: `${where}`, current: `IGST ${det.iamt}`,
      expected: 'IGST zero on an intra-state supply',
      fix: 'Check the invoice\'s Interstate/Intrastate setting against the place of supply.' }));
  }
}

function validateGSTR1Strict(payload, errors) {
  if (!payload) return;

  // Filer identity and period.
  const filer = validateGstin(payload.gstin);
  if (!filer.valid) {
    errors.push(gstr1Err({ field: 'gstin', current: payload.gstin, expected: 'a valid 15-character GSTIN',
      message: `Filer GSTIN is invalid (${filer.reason}).`, fix: 'Correct it in Business Profile.' }));
  }
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(payload.fp || '')) {
    errors.push(gstr1Err({ field: 'fp', current: payload.fp, expected: 'MMYYYY, e.g. 072026',
      fix: 'Select a single calendar month on the Reports page.' }));
  }
  if (payload.version !== GSTR1_VERSION) {
    errors.push(gstr1Err({ field: 'version', current: payload.version, expected: GSTR1_VERSION,
      fix: 'Generator-set value — report it if you see it.' }));
  }
  if (payload.hash !== GSTR1_HASH) {
    errors.push(gstr1Err({ field: 'hash', current: payload.hash, expected: GSTR1_HASH,
      fix: 'Generator-set value — report it if you see it.' }));
  }

  const checkItms = (itms, where, splyTy, invoice, customer) => {
    (itms || []).forEach((it, k) => {
      const d = it.itm_det || {};
      const at = `${where}.itms[${k}].itm_det`;
      ['txval', 'iamt', 'camt', 'samt', 'csamt'].forEach(f => {
        if (d[f] !== undefined) gstr1CheckMoney(d[f], f, at, errors);
      });
      if (typeof d.rt !== 'number' || !isFinite(d.rt) || d.rt < 0) {
        errors.push(gstr1Err({ invoice, customer, field: `${at}.rt`, current: d.rt,
          expected: 'a GST rate of zero or more', fix: 'Set a GST % on the product or the invoice line.' }));
      }
      if (splyTy) gstr1CheckTaxSplit(d, splyTy, at, errors);
    });
  };

  (payload.b2b || []).forEach((g, i) => {
    if (!validateGstin(g.ctin).valid) {
      errors.push(gstr1Err({ customer: g.ctin, field: `b2b[${i}].ctin`, current: g.ctin,
        expected: 'a valid 15-character GSTIN', fix: 'Correct the customer\'s GST Number on the invoice.' }));
    }
    (g.inv || []).forEach((inv, j) => {
      const where = `b2b[${i}].inv[${j}]`;
      if (!gstr1InvoiceNumberOk(inv.inum)) {
        errors.push(gstr1Err({ invoice: inv.inum, customer: g.ctin, field: `${where}.inum`, current: inv.inum,
          expected: 'up to 16 characters, letters/digits/hyphen/slash only',
          fix: 'Renumber the invoice on the Invoice List.' }));
      }
      if (!gstr1DateOk(inv.idt)) {
        errors.push(gstr1Err({ invoice: inv.inum, customer: g.ctin, field: `${where}.idt`, current: inv.idt,
          expected: 'DD-MM-YYYY', fix: 'Re-save the invoice with a valid date.' }));
      }
      if (!GSTR1_VALID_POS_CODES.has(inv.pos)) {
        errors.push(gstr1Err({ invoice: inv.inum, customer: g.ctin, field: `${where}.pos`, current: inv.pos,
          expected: 'a state code derived from the customer GSTIN',
          fix: 'Correct the customer\'s GST Number — the first two digits are the place of supply.' }));
      }
      if (!GSTR1_EMITTED_INV_TYP.has(inv.inv_typ)) {
        errors.push(gstr1Err({ invoice: inv.inum, field: `${where}.inv_typ`, current: inv.inv_typ,
          expected: [...GSTR1_EMITTED_INV_TYP].join(' or '), fix: 'Generator-set value — report it if you see it.' }));
      }
      if (!GSTR1_EMITTED_RCHRG.has(inv.rchrg)) {
        errors.push(gstr1Err({ invoice: inv.inum, field: `${where}.rchrg`, current: inv.rchrg,
          expected: [...GSTR1_EMITTED_RCHRG].join(' or '), fix: 'Generator-set value — report it if you see it.' }));
      }
      gstr1CheckMoney(inv.val, 'val', where, errors);
      checkItms(inv.itms, where, inv.pos === payload.gstin.slice(0, 2) ? 'INTRA' : 'INTER', inv.inum, g.ctin);
    });
  });

  (payload.b2cl || []).forEach((g, i) => {
    if (!GSTR1_VALID_POS_CODES.has(g.pos)) {
      errors.push(gstr1Err({ field: `b2cl[${i}].pos`, current: g.pos, expected: 'a recognised state code',
        fix: 'Set the customer\'s State on the invoice.' }));
    }
    (g.inv || []).forEach((inv, j) => {
      const where = `b2cl[${i}].inv[${j}]`;
      if (!gstr1DateOk(inv.idt)) {
        errors.push(gstr1Err({ invoice: inv.inum, field: `${where}.idt`, current: inv.idt,
          expected: 'DD-MM-YYYY', fix: 'Re-save the invoice with a valid date.' }));
      }
      gstr1CheckMoney(inv.val, 'val', where, errors);
      checkItms(inv.itms, where, 'INTER', inv.inum);
    });
  });

  (payload.b2cs || []).forEach((r, i) => {
    const where = `b2cs[${i}]`;
    if (!GSTR1_EMITTED_SPLY_TY.has(r.sply_ty)) {
      errors.push(gstr1Err({ field: `${where}.sply_ty`, current: r.sply_ty,
        expected: [...GSTR1_EMITTED_SPLY_TY].join(' or '), fix: 'Generator-set value — report it if you see it.' }));
    }
    if (!GSTR1_EMITTED_B2CS_TYP.has(r.typ)) {
      errors.push(gstr1Err({ field: `${where}.typ`, current: r.typ,
        expected: [...GSTR1_EMITTED_B2CS_TYP].join(' or '), fix: 'Generator-set value — report it if you see it.' }));
    }
    if (!GSTR1_VALID_POS_CODES.has(r.pos)) {
      errors.push(gstr1Err({ field: `${where}.pos`, current: r.pos, expected: 'a recognised state code',
        fix: 'Set the customer\'s State on the invoices in this bucket.' }));
    }
    ['txval', 'iamt', 'camt', 'samt', 'csamt'].forEach(f => gstr1CheckMoney(r[f], f, where, errors));
    gstr1CheckTaxSplit(r, r.sply_ty, where, errors);
  });

  (payload.cdnr || []).forEach((g, i) => {
    if (!validateGstin(g.ctin).valid) {
      errors.push(gstr1Err({ customer: g.ctin, field: `cdnr[${i}].ctin`, current: g.ctin,
        expected: 'a valid 15-character GSTIN', fix: 'Correct the GST Number on the credit/debit note.' }));
    }
    (g.nt || []).forEach((n, j) => {
      const where = `cdnr[${i}].nt[${j}]`;
      if (!GSTR1_EMITTED_NTTY.has(n.ntty)) {
        errors.push(gstr1Err({ invoice: n.nt_num, field: `${where}.ntty`, current: n.ntty,
          expected: [...GSTR1_EMITTED_NTTY].join(' or '), fix: 'Set the note type to Credit or Debit.' }));
      }
      if (!gstr1DateOk(n.nt_dt)) {
        errors.push(gstr1Err({ invoice: n.nt_num, field: `${where}.nt_dt`, current: n.nt_dt,
          expected: 'DD-MM-YYYY', fix: 'Re-save the note with a valid date.' }));
      }
      gstr1CheckMoney(n.val, 'val', where, errors);
      checkItms(n.itms, where, n.pos === payload.gstin.slice(0, 2) ? 'INTRA' : 'INTER', n.nt_num, g.ctin);
    });
  });

  (payload.cdnur || []).forEach((n, i) => {
    const where = `cdnur[${i}]`;
    if (!GSTR1_EMITTED_CDNUR_TYP.has(n.typ)) {
      errors.push(gstr1Err({ invoice: n.nt_num, field: `${where}.typ`, current: n.typ,
        expected: [...GSTR1_EMITTED_CDNUR_TYP].join(' or '), fix: 'Generator-set value — report it if you see it.' }));
    }
    if (!GSTR1_EMITTED_NTTY.has(n.ntty)) {
      errors.push(gstr1Err({ invoice: n.nt_num, field: `${where}.ntty`, current: n.ntty,
        expected: [...GSTR1_EMITTED_NTTY].join(' or '), fix: 'Set the note type to Credit or Debit.' }));
    }
    if (!gstr1DateOk(n.nt_dt)) {
      errors.push(gstr1Err({ invoice: n.nt_num, field: `${where}.nt_dt`, current: n.nt_dt,
        expected: 'DD-MM-YYYY', fix: 'Re-save the note with a valid date.' }));
    }
    gstr1CheckMoney(n.val, 'val', where, errors);
    checkItms(n.itms, where, 'INTER', n.nt_num);
  });

  const hsnRowsToCheck = [];
  ['hsn_b2b', 'hsn_b2c'].forEach(k => ((payload.hsn && payload.hsn[k]) || [])
    .forEach((r, i) => hsnRowsToCheck.push([r, `hsn.${k}[${i}]`])));
  hsnRowsToCheck.forEach(([r, where]) => {
    if (!gstr1HsnFormatOk(r.hsn_sc)) {
      errors.push(gstr1Err({ product: r.desc, field: `${where}.hsn_sc`, current: r.hsn_sc,
        expected: 'a 4, 6 or 8 digit HSN code', fix: 'Set a valid HSN code on the product.' }));
    }
    if (!GSTR1_EMITTABLE_UQC.has(r.uqc)) {
      errors.push(gstr1Err({ product: r.desc, field: `${where}.uqc`, current: r.uqc,
        expected: `one of ${[...GSTR1_EMITTABLE_UQC].join(', ')}`,
        fix: 'Set the product\'s unit to one this app maps to a UQC.' }));
    } else if (r.uqc === GSTR1_UQC_SERVICE && !gstr1IsServiceHsn(r.hsn_sc)) {
      // Exactly what the Portal refused: RET191353, "The UQC entered is
      // not valid", on goods lines carrying NA.
      errors.push(gstr1Err({ product: r.desc, field: `${where}.uqc`, current: 'NA',
        expected: `a real unit for HSN ${r.hsn_sc} — NA is only for services (HSN 99xx)`,
        message: 'A physical good is being reported with no unit of measure.',
        fix: 'Set the product\'s Unit and re-save the invoices that use it.' }));
    }
    // Zero is legitimate: a Utility-written return carries qty 0 on a
    // service line (uqc "NA"), which has no unit of measure to count.
    // Negative is not.
    if (typeof r.qty !== 'number' || !isFinite(r.qty) || r.qty < 0) {
      errors.push(gstr1Err({ product: r.desc, field: `${where}.qty`, current: r.qty,
        expected: 'a quantity of zero or more',
        fix: 'A negative quantity here means sales returns exceeded sales for this HSN in the period.' }));
    }
    ['txval', 'iamt', 'camt', 'samt', 'csamt'].forEach(f => gstr1CheckMoney(r[f], f, where, errors));
  });
}

// Orders invoice numbers the way a numbering series runs rather than the
// way text sorts, so "00193/26-27" follows "00158/26-27" and does not sit
// before "0021/26-27". Digit runs compare as numbers, everything else as
// text. js/invoice-list.js has an equivalent for sorting the on-screen
// list; this file is loaded on reports.html, which does not include that
// script, and a filing must not depend on which page happens to be open.
function gstr1CompareInvoiceNumbers(a, b) {
  const chunks = v => String(v ?? '').match(/\d+|\D+/g) || [];
  const A = chunks(a), B = chunks(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const bothNumeric = /^\d/.test(x) && /^\d/.test(y);
    const d = bothNumeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return d;
  }
  return 0;
}

// An invoice's val in a Utility-written return is the taxable value plus
// tax rounded to the nearest rupee — every one of the 49 invoices in the
// reference file is a whole number, including the ones whose components
// do not add up to one (txval+tax 9945.04 -> val 9945, 7286.5 -> 7287,
// 530.49 -> 530). The line-level txval and tax figures keep their paise;
// only this invoice-level total rounds.
//
// This does not change any invoice: total_amount in the database, the
// printed invoice and every calculation are untouched. It changes how the
// total is written into the return, which is what the reference proves.
function gstr1InvoiceVal(total) {
  return Math.round(total);
}

// ── Filing period ───────────────────────────────────────────
// fp is MMYYYY and comes from the month the user selected, by string
// rearrangement, with no Date object and no reference to the clock.
//
// It used to be derived as new Date(startOfSelectedMonth).getMonth(). A
// date-only string parses as UTC while getMonth() reads local time, so on
// any machine behind UTC that returns the PREVIOUS month — selecting July
// would have filed 062026. It is right in IST only by accident of the
// offset, which is not something a filing should depend on.
//
// A relative selection is refused rather than resolved. "Current Month",
// a quarter and a financial year are all reasonable things to look at on
// the Reports page, but none of them names the month being filed, and
// resolving "current" against the clock is exactly how a return for July
// ends up stamped August.
const GSTR1_MONTH_SELECTION = /^(\d{4})-(0[1-9]|1[0-2])$/;

// "2026-07" -> "July 2026", for messages. Built from string parts, never
// through a Date: a date-only string parses as UTC and reads back a day
// earlier west of UTC.
const GSTR1_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function gstr1MonthLabel(ym) {
  const m = GSTR1_MONTH_SELECTION.exec(String(ym || ''));
  return m ? `${GSTR1_MONTH_NAMES[+m[2] - 1]} ${m[1]}` : String(ym || '');
}

// Waits for the period dropdown to hold its options before anything reads
// it.
//
// The control ships empty in reports.html and is filled from the database
// after the page loads. A select with no options reports value "" and
// selectedIndex -1, which is indistinguishable from a deliberate empty
// choice — the export used to say "(nothing selected)" while the user was
// looking at July 2026 in that very control a moment later.
//
// Two waits, because the gap has two parts. reportPeriodsReady is the
// promise js/reports.js publishes while it fetches the months, but it is
// only assigned after initReports has awaited requireAuth() — a network
// call, during which the page is painted and the button is clickable. So
// an empty control is also waited on directly, bounded, for the stretch
// before that promise exists.
const GSTR1_PERIOD_WAIT_MS = 15000;

async function gstr1AwaitPeriodOptions() {
  const el = () => document.getElementById('reportMonth');
  const empty = () => { const e = el(); return e && e.options.length === 0; };
  if (!empty() && (typeof reportPeriodsReady === 'undefined' || !reportPeriodsReady)) return;

  showToast('Reading your filing periods…', 'success');
  const deadline = Date.now() + GSTR1_PERIOD_WAIT_MS;
  while (empty() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (typeof reportPeriodsReady !== 'undefined' && reportPeriodsReady) {
    try { await reportPeriodsReady; }
    catch (e) { /* populateMonthFilter reports its own failure */ }
  }
}

// Reports what the period control actually held at the moment it was
// read. Off unless asked for: set localStorage gst_trace_period = '1' (or
// window.GSTR1_TRACE_PERIOD = true) in the console and export again.
function gstr1TracePeriod(where, el, value) {
  let on = false;
  try { on = (typeof window !== 'undefined' && window.GSTR1_TRACE_PERIOD)
    || localStorage.getItem('gst_trace_period') === '1'; } catch (e) { /* storage blocked */ }
  if (!on) return;
  const opts = el ? [...el.options].map((o, i) =>
    `${i === el.selectedIndex ? '>' : ' '} ${JSON.stringify(o.value)} = ${JSON.stringify(o.text)}`) : [];
  console.info(
    `[GSTR-1 period trace] ${where}\n` +
    `  element #reportMonth found : ${!!el}\n` +
    `  selected dropdown value    : ${JSON.stringify(value)}\n` +
    `  selected dropdown text     : ${JSON.stringify(el?.options?.[el.selectedIndex]?.text ?? null)}\n` +
    `  selectedIndex              : ${el ? el.selectedIndex : 'n/a'}\n` +
    `  options present            : ${opts.length}\n` +
    (opts.length ? opts.join('\n') + '\n' : ''));
}

// The months that could be filed, so a rejection can say what the user
// could have picked instead of only what they did.
//
// Read from the list the Reports page discovered in the stored data
// (reportAvailableMonths in js/reports.js) rather than from the dropdown.
// Reading the dropdown to describe the dropdown is circular: if it ever
// failed to render, the message would report no months available while
// the data plainly had some. The dropdown is only a fallback, for a page
// that has the control but not the reports script.
function gstr1AvailableMonths() {
  if (typeof reportAvailableMonths !== 'undefined' && Array.isArray(reportAvailableMonths) && reportAvailableMonths.length) {
    return reportAvailableMonths.map(m => m.label);
  }
  const el = typeof document !== 'undefined' ? document.getElementById('reportMonth') : null;
  if (!el) return [];
  return [...el.options].filter(o => GSTR1_MONTH_SELECTION.test(o.value)).map(o => o.text);
}

// The month the invoices themselves belong to.
//
// A return may only cover one month, so a set of invoices spanning two is
// refused rather than stamped with whichever month happened to be picked.
// An empty set returns no month at all: there is nothing to derive from,
// and a month with no invoices is still a month that can be filed as a
// nil return, so the caller falls back to the selected period there.
function gstr1DeriveFilingMonth(invoices) {
  const months = new Set();
  (invoices || []).forEach(inv => {
    const d = String(inv.invoice_date || '');
    if (/^\d{4}-(0[1-9]|1[0-2])/.test(d)) months.add(d.slice(0, 7));
  });

  if (months.size > 1) {
    const spread = [...months].sort();
    return { error: gstr1Err({
      field: 'Return Period',
      current: spread.map(gstr1MonthLabel).join(', '),
      expected: 'invoices from a single month',
      message: 'GSTR-1 export can contain only one filing month.',
      fix: `The invoices selected span ${spread.length} months. Choose one month from the period dropdown and generate the return again.`
    }) };
  }
  return { month: months.size === 1 ? [...months][0] : null };
}

function gstr1FilingPeriod(selection) {
  const raw = String(selection == null ? '' : selection).trim();
  const m = GSTR1_MONTH_SELECTION.exec(raw);
  if (m) return { fp: m[2] + m[1] };          // "2026-07" -> "072026"

  // Naming the months on offer turns "pick a month" into something the
  // user can act on without going to look, and makes the empty case —
  // no month has any data — visible instead of silent.
  const months = gstr1AvailableMonths();
  const fix = months.length
    ? `Choose one of these from the period dropdown, then generate the return again: ${months.join(', ')}.`
    : 'The period dropdown is not offering any month, which means no invoice, purchase, expense, return or note is stored in any month yet. Save an invoice for the month you are filing, then try again.';
  return { error: gstr1Err({
    field: 'Return Period',
    current: raw || '(nothing selected)',
    expected: months.length ? `one of: ${months.join(', ')}` : 'a specific month, e.g. "July 2026"',
    message: 'GSTR-1 is filed for one named month, and the period selected on the Reports page does not name one.',
    fix
  }) };
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

// A corrupted/hand-edited invoice_items.taxable_value would previously
// flow straight through — gstr1RecomputeItem() only re-derives the TAX
// portion (igst/cgst/sgst) from taxable_value, it never re-derives
// taxable_value itself. This closes that gap by recomputing it from the
// same quantity/rate/discount_percentage formula js/invoice-items.js's
// recalcItemRow() uses at entry time (round2(qty*rate*(1-discount/100))
// — see that file), so a tampered taxable_value with unchanged
// quantity/rate is caught here instead of silently exported. Only
// applies to live invoice_items rows — a legacy pre-line-item invoice's
// pseudo-item (built in gstr1ItemsForInvoice from a b2b_hsn/b2c_hsn row)
// carries no rate/discount_percentage of its own to recompute from, so
// there is nothing to cross-check there.
function gstr1CheckItemTaxable(item, errCtx, errors, who = {}) {
  if (item.rate === undefined || item.discount_percentage === undefined) return; // legacy pseudo-item, nothing to cross-check
  const expected = lineTaxableValue(item.quantity, item.rate, item.discount_percentage);
  const actual = round2(+item.taxable_value || 0);
  if (Math.abs(expected - actual) > GSTR1_RECONCILE_TOLERANCE) {
    errors.push(gstr1Err({
      invoice: who.invoice, customer: who.customer, product: item.product_name,
      field: 'Taxable Value', current: `₹${actual}`,
      expected: `₹${expected} (quantity × rate × (1 − discount%))`,
      message: `${errCtx}: the stored taxable value does not match this line's own quantity, rate and discount.`,
      fix: 'Open the invoice and save it again to recompute the line.'
    }));
  }
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
// ── Does a stored invoice total agree with its own line items? ──────
// This app rounds an invoice to the whole rupee. computeInvoiceRollups()
// in js/invoice-items.js — and the same three lines in purchase-items.js
// and sales-return-items.js — build the total as:
//
//   rawTotal   = taxable + gst
//   grandTotal = Math.round(rawTotal)      <- stored as total_amount
//   roundOff   = grandTotal - rawTotal     <- shown, never stored
//
// Round Off is derived, not a column: there is no round_off anywhere in
// the schema. So a legitimate invoice can differ from taxable + gst by up
// to half a rupee, and comparing the two directly rejected every invoice
// that rounded by more than the 0.05 tolerance — ₹46,610 + ₹8,389.80
// rounds to ₹55,000 and was refused over the resulting ₹0.20.
//
// Both shapes are accepted: a total stored rounded (every invoice this
// app writes today) and a total stored unrounded (anything older, or
// imported, that kept the exact sum). Anything else is a real mismatch.
function gstr1TotalMatches(storedTotal, rawTotal) {
  const stored = round2(+storedTotal || 0);
  const raw = round2(rawTotal);
  return Math.abs(stored - raw) <= GSTR1_RECONCILE_TOLERANCE
      || Math.abs(stored - Math.round(raw)) <= GSTR1_RECONCILE_TOLERANCE;
}

// The four figures that explain a mismatch, so the message is the audit
// rather than a prompt to go and do one.
function gstr1TotalMismatch(inv, rawTotal) {
  const stored = round2(+inv.total_amount || 0);
  const raw = round2(rawTotal);
  const roundOff = round2(Math.round(raw) - raw);
  return gstr1Err({
    invoice: inv.invoice_number, customer: inv.customer_name,
    field: 'Invoice Total',
    current: `stored ₹${stored}`,
    expected: `₹${Math.round(raw)} — line items give ₹${raw}, round off ${roundOff >= 0 ? '+' : ''}₹${roundOff}`,
    message: `Stored total ₹${stored} differs from the line items by ₹${round2(stored - raw)}, which is more than a rounding adjustment can explain.`,
    fix: 'Open the invoice and save it again to rebuild its total from the lines.'
  });
}

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
    errors.push(gstr1Err({ field: 'Customer State', current: customerState, expected: 'one of the states in the State dropdown', message: `${context}: customer state is not a recognised Indian state/UT, so no place of supply can be derived.`, fix: 'Open the invoice and re-pick the State from the dropdown.' }));
  } else if (code === '99') {
    errors.push(gstr1Err({ field: 'Customer State', current: '(blank)', expected: 'one of the states in the State dropdown', message: `${context}: customer state is missing, so no place of supply can be derived.`, fix: 'Open the invoice and set the State.' }));
  }
  return code;
}

// ── Product master audit, run before anything is assembled ──────────
//
// The per-line checks further down catch the same faults, but they stop
// at the first bad line of an invoice and report it as one invoice's
// problem. A bad product is not one invoice's problem — it is wrong on
// every invoice that ever used it, and fixing it once fixes all of them.
// This pass groups by product, names every invoice affected, and reports
// every fault on every product before a single row is built.
//
// What can be checked here, and what cannot:
//   - that an HSN is present and is a 4/6/8 digit code: yes
//   - that the code is the RIGHT one for the goods: no. That is a tax
//     classification, there is no official HSN list in this codebase, and
//     the Portal is the only authority (it answers RET191349).
async function gstr1FetchProductsForLines(userId, items) {
  const ids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  if (!ids.length) return {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += GSTR1_ID_CHUNK_SIZE) chunks.push(ids.slice(i, i + GSTR1_ID_CHUNK_SIZE));
  const res = await Promise.all(chunks.map(c =>
    _supabase.from('products').select('*').eq('user_id', userId).in('id', c)));
  const byId = {};
  res.flatMap(r => r.data || []).forEach(p => { byId[p.id] = p; });
  return byId;
}

function gstr1AuditProducts(lines, productsById, errors) {
  // Grouped by the product the line came from, falling back to its name
  // for a line typed in freehand or whose product has since been deleted.
  const groups = new Map();
  lines.forEach(l => {
    const key = l.product_id || ('name:' + (l.item.product_name || '').trim().toLowerCase());
    if (!groups.has(key)) groups.set(key, { name: l.item.product_name, invoices: new Set(), item: l.item, product: productsById[l.product_id] || null });
    groups.get(key).invoices.add(l.invoiceNumber);
  });

  groups.forEach(g => {
    const invoices = [...g.invoices].sort(gstr1CompareInvoiceNumbers);
    const where = invoices.length === 1 ? `invoice ${invoices[0]}`
      : `${invoices.length} invoices: ${invoices.slice(0, 6).join(', ')}${invoices.length > 6 ? `, +${invoices.length - 6} more` : ''}`;
    const hsn = String(g.item.hsn_code || '').trim();
    const unit = String(g.item.unit || '').trim();
    const rate = g.item.gst_percentage;
    const fault = (field, current, expected, fix, message) => errors.push(gstr1Err({
      invoice: invoices.join(', '), product: g.name, field, current, expected, fix,
      message: message || `${g.name} — used on ${where}.`
    }));

    // 1 + 2. HSN present, and a shape a return can carry.
    if (!hsn) {
      fault('HSN Code', '(not set)', 'a 4, 6 or 8 digit HSN code',
        'Open the product and set its HSN code, then re-save the invoices that use it.');
    } else if (!gstr1HsnFormatOk(hsn)) {
      fault('HSN Code', hsn, 'a 4, 6 or 8 digit code, digits only',
        'Correct the HSN code on the product, then re-save the invoices that use it.');
    }

    const isService = gstr1IsServiceHsn(hsn);

    // 3 + 4. Unit present, and one that maps to a UQC.
    // 7 + 8. NA belongs to services only — the Portal refused it on goods
    // with RET191353, and the official return uses it on a service line.
    if (!isService) {
      if (!unit) {
        fault('Unit', '(not set)', `one of ${Object.keys(GSTR1_UQC_MAP).join(', ')}`,
          'Open the product and set its Unit, then re-save the invoices that use it.',
          `${g.name} is a physical good (HSN ${hsn || 'not set'}) with no unit, so the return would report it as NA — used on ${where}.`);
      } else if (!GSTR1_UQC_MAP[unit.toUpperCase()]) {
        fault('Unit', unit, `one of ${Object.keys(GSTR1_UQC_MAP).join(', ')}`,
          'Change the product\'s Unit to one of those, then re-save the invoices that use it.');
      }
    }

    // 5. A rate has to be a real number. Zero is legitimate — an exempt or
    // nil-rated supply is reported at 0% — so only a missing or nonsense
    // rate is a fault.
    if (rate === null || rate === undefined || !isFinite(+rate) || +rate < 0) {
      fault('GST Rate', rate === null || rate === undefined ? '(not set)' : String(rate),
        'a GST percentage of zero or more',
        'Set the GST % on the product, then re-save the invoices that use it.');
    }

    // 6. The product's own Goods/Service flag against what its HSN says.
    // Chapter 99 is services; anything else is goods. They disagreeing is
    // how a service ends up demanding a unit, or a good ends up as NA.
    if (g.product && g.product.type) {
      const saysService = g.product.type === 'service';
      if (hsn && saysService !== isService) {
        fault('Product Type', `${g.product.type}, but HSN ${hsn} is ${isService ? 'a service code' : 'a goods code'}`,
          isService ? 'type "service" for an HSN in chapter 99' : 'type "goods" for an HSN outside chapter 99',
          'Correct either the product type or its HSN code so the two agree, then re-save the invoices that use it.');
      }
    }
  });
}

// ── Build the full payload. Every validation failure is appended to
// `errors` with enough context (invoice number, table, row) to act on —
// the payload is still fully built even when invalid so the caller can
// show every problem at once instead of stopping at the first one. ──
async function buildGSTR1Payload(userId, profile, periodFilter) {
  const errors = [];

  // The filing period is settled first, from the selection alone. If it
  // does not name a month there is no return to build, so nothing is
  // fetched and nothing is assembled.
  const period = gstr1FilingPeriod(periodFilter);
  gstr1TracePeriod(`buildGSTR1Payload received ${JSON.stringify(periodFilter)} -> fp ${JSON.stringify(period.fp ?? null)}`,
    typeof document !== 'undefined' ? document.getElementById('reportMonth') : null, periodFilter);
  if (period.error) { errors.push(period.error); return { errors }; }
  // Only a candidate at this point. The invoices decide — see the
  // derivation right after they are fetched.
  let fp = period.fp;

  // The invoices to include come from the same selection, so the window
  // queried and the period stamped on the file cannot disagree.
  const { start, end } = getReportDateRange(periodFilter);

  const businessGstin = (profile?.gstin || '').toUpperCase();
  const businessState = profile?.state || '';
  const businessGstinCheck = validateGstin(businessGstin);
  if (!businessGstinCheck.valid) {
    errors.push(gstr1Err({ field: 'Business Profile GSTIN', current: businessGstin, expected: 'a valid 15-character GSTIN', message: `Your own GSTIN is invalid (${businessGstinCheck.reason}).`, fix: 'Correct it in Business Profile, then generate the return again.' }));
  }
  // The business's own GSTIN, once validated, is the single authoritative
  // source for "which state is this registration in" — never the
  // separately-typed Business Profile State text field, which can drift
  // out of sync with the GSTIN (the same class of bug the earlier
  // Interstate/Intrastate entry-form fix addressed for the customer
  // side: a free-text state field silently overriding a more
  // authoritative GSTIN-derived one). Only falls back to the text field
  // when the GSTIN itself is invalid — at which point export is already
  // blocked by the check above, so this fallback only matters for
  // producing a sane (not necessarily final) POS-agreement message.
  const businessStateCode = businessGstinCheck.valid ? businessGstin.slice(0, 2) : getStateCode(businessState);

  const todayISO = toISO(new Date());

  // Round 1: everything that can be scoped by its own date column.
  const [b2bRes, b2cRes, cdnRes, srRes, srItemsRes] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', userId).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('b2c_invoices').select('*').eq('user_id', userId).gte('invoice_date', start).lte('invoice_date', end),
    _supabase.from('cdn_notes').select('*').eq('user_id', userId).gte('note_date', start).lte('note_date', end),
    _supabase.from('sales_returns').select('*').eq('user_id', userId).gte('return_date', start).lte('return_date', end),
    _supabase.from('sales_return_items').select('*').eq('user_id', userId)
  ]);

  const b2bData = b2bRes.data || [], b2cData = b2cRes.data || [];
  const cdnNotes = cdnRes.data || [];
  const salesReturns = srRes.data || [];

  // ── The filing period, decided by the invoices actually going into the
  // file ──────────────────────────────────────────────────────────────
  // The selection above chose which invoices to fetch; these invoices now
  // choose the period stamped on them. A return whose fp disagrees with
  // its own contents is rejected by the Portal as a period mismatch, and
  // no UI value — a dropdown, a default, the clock — outranks the dates
  // on the documents being filed.
  const derivedMonth = gstr1DeriveFilingMonth([...b2bData, ...b2cData]);
  if (derivedMonth.error) { errors.push(derivedMonth.error); return { errors }; }

  if (derivedMonth.month) {
    const derived = derivedMonth.month;
    const derivedFp = gstr1FilingPeriod(derived).fp;
    // A disagreement here means the invoices fetched are not the ones the
    // selected window asked for, which is a fault in the query rather than
    // in the user's choice. The invoices win, and it is reported.
    if (derivedFp !== fp) {
      errors.push(gstr1Err({
        field: 'Return Period',
        current: `${fp} (from the selected period)`,
        expected: `${derivedFp} (from the invoices being exported)`,
        message: 'The period selected and the invoices fetched for it do not agree.',
        fix: 'Reload the Reports page and select the month again. If it persists, report it — the two should never differ.'
      }));
    }
    fp = derivedFp;
  }
  // No invoices at all leaves fp as the selected month, so a nil return
  // for a month with nothing in it can still be filed. There is no
  // invoice date to derive from, and refusing would make an empty month
  // impossible to file rather than merely empty.
  const srItemsAll = srItemsRes.data || [];

  // Round 2: invoice_items and the legacy HSN tables have no date column
  // of their own (items belong to an invoice, not a day) — the old
  // generator fetched ALL of them for the user, every export, forever,
  // regardless of period (a real scaling problem: a business with years
  // of history would re-download its entire item history on every
  // single month's filing). Scoped here instead to exactly this
  // period's invoice ids via the ids already known from round 1, chunked
  // to keep any one request's URL length safe even for a filing period
  // with several thousand invoices.
  const periodInvoiceIds = [...b2bData.map(r => r.id), ...b2cData.map(r => r.id)];
  const chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  const idChunks = chunk(periodInvoiceIds, GSTR1_ID_CHUNK_SIZE);

  const [itemsChunks, hsnB2BChunks, hsnB2CChunks] = await Promise.all([
    Promise.all(idChunks.map(ids => _supabase.from('invoice_items').select('*').eq('user_id', userId).in('invoice_id', ids))),
    Promise.all(idChunks.map(ids => _supabase.from('b2b_hsn').select('*').eq('user_id', userId).in('source_invoice_id', ids))),
    Promise.all(idChunks.map(ids => _supabase.from('b2c_hsn').select('*').eq('user_id', userId).in('source_invoice_id', ids)))
  ]);
  const allItems = itemsChunks.flatMap(r => r.data || []);
  const legacyHsnRows = [...hsnB2BChunks.flatMap(r => r.data || []), ...hsnB2CChunks.flatMap(r => r.data || [])];

  const itemsByInvoice = {};
  allItems.forEach(r => {
    const key = r.invoice_type + ':' + r.invoice_id;
    (itemsByInvoice[key] = itemsByInvoice[key] || []).push(r);
  });
  const srItemsByReturn = {};
  srItemsAll.forEach(r => { (srItemsByReturn[r.return_id] = srItemsByReturn[r.return_id] || []).push(r); });

  // ── Product master audit ──
  // Runs before anything is assembled: a product that cannot be reported
  // is worth knowing about in full, across every invoice that uses it,
  // rather than one invoice at a time as the rows are built.
  const invoiceNumberById = {};
  b2bData.forEach(i => { invoiceNumberById['b2b:' + i.id] = i.invoice_number; });
  b2cData.forEach(i => { invoiceNumberById['b2c:' + i.id] = i.invoice_number || `B2C-${String(i.id).slice(0, 8)}`; });

  const auditLines = allItems.map(it => ({
    item: it,
    product_id: it.product_id,
    invoiceNumber: invoiceNumberById[it.invoice_type + ':' + it.invoice_id]
  })).filter(l => l.invoiceNumber !== undefined);   // items of invoices outside this period

  const productsById = await gstr1FetchProductsForLines(userId, allItems);
  const productErrorsBefore = errors.length;
  gstr1AuditProducts(auditLines, productsById, errors);
  // Nothing is generated while a product cannot be reported correctly.
  if (errors.length > productErrorsBefore) return { errors };

  // Duplicate invoice number check — b2b_invoices/b2c_invoices share one
  // numbering sequence app-wide, so any collision across the combined
  // period set is real data corruption, not a false positive.
  const seenInvNums = new Map();
  [...b2bData.map(r => ({ ...r, __kind: 'B2B' })), ...b2cData.map(r => ({ ...r, __kind: 'B2C' }))].forEach(inv => {
    const num = (inv.invoice_number || '').toUpperCase();
    if (!num) return;
    if (seenInvNums.has(num)) errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Invoice Number', current: `used twice (${seenInvNums.get(num)} and ${inv.__kind})`, expected: 'a number used by only one invoice', fix: 'Renumber one of the two invoices from the Invoice List.' }));
    else seenInvNums.set(num, inv.__kind);
  });

  // The HSN summary is reported per supply channel: hsn_b2b and hsn_b2c
  // are separate arrays in a Utility-written return, so the buckets are
  // kept apart from the moment a line is counted rather than being split
  // afterwards (a line already knows which invoice it came from; the
  // combined totals do not).
  const hsnBuckets = { b2b: new Map(), b2c: new Map() }; // "hsncode|rate" -> row
  function addToHsn(channel, hsnCode, desc, uqc, qty, r, errCtx) {
    if (!gstr1HsnFormatOk(hsnCode)) { errors.push(gstr1Err({ field: 'HSN Code', current: hsnCode, expected: 'a 4, 6 or 8 digit code', message: `${errCtx}: HSN code is not valid.`, fix: 'Set a valid HSN code on the product, then re-save the invoice.' })); return; }
    const buckets = hsnBuckets[channel];
    const key = hsnCode + '|' + r.rate;
    if (!buckets.has(key)) buckets.set(key, { hsn_sc: hsnCode, desc: desc || '', uqc, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    const b = buckets.get(key);
    // GSTN's schema allows exactly one row per HSN+rate — different
    // units genuinely selling under the same HSN+rate can't become two
    // rows (that would itself be a duplicate-HSN-row rejection) or be
    // silently summed together (a combined "8 units" of 5kg + 3pcs is
    // meaningless). Flagged for a human to resolve rather than guessed.
    if (b.uqc !== GSTR1_UQC_SERVICE && uqc !== GSTR1_UQC_SERVICE && b.uqc !== uqc) {
      errors.push(gstr1Err({ field: 'Unit (UQC)', current: `${b.uqc} and ${uqc} on HSN ${hsnCode} at ${r.rate}%`, expected: 'one unit per HSN code and rate', message: `${errCtx}: this HSN and rate is sold in two different units.`, fix: 'Make the unit consistent for this HSN and rate, or give the products distinct HSN codes.' }));
      return;
    }
    b.qty = round2(b.qty + (qty || 0));
    b.taxable = round2(b.taxable + r.taxable); b.igst = round2(b.igst + r.igst);
    b.cgst = round2(b.cgst + r.cgst); b.sgst = round2(b.sgst + r.sgst);
    // A later row can supply a UQC where an earlier one (e.g. a legacy
    // row with no unit at all) couldn't.
    if (b.uqc === GSTR1_UQC_SERVICE && uqc !== GSTR1_UQC_SERVICE) b.uqc = uqc;
  }

  // ── B2B ──
  const b2bGroups = new Map(); // ctin -> inv[]
  b2bData.forEach(inv => {
    const ctx = `B2B invoice ${inv.invoice_number || inv.id}`;
    const gstin = (inv.gst_number || '').toUpperCase();
    const gCheck = validateGstin(gstin);
    if (!gCheck.valid) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Customer GST Number', current: gstin, expected: 'a valid 15-character GSTIN', message: `Customer GSTIN is invalid (${gCheck.reason}).`, fix: 'Open the invoice and correct the customer GST Number.' })); return; }
    if (!gstr1InvoiceNumberOk(inv.invoice_number)) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Invoice Number', current: inv.invoice_number, expected: 'up to 16 characters, letters/digits/hyphen/slash only', fix: 'Renumber this invoice from the Invoice List.' })); return; }
    const idt = formatDateDDMMYYYY(inv.invoice_date);
    if (!gstr1DateOk(idt)) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Invoice Date', current: inv.invoice_date, expected: 'a real date, written to the file as DD-MM-YYYY', fix: 'Re-save the invoice with a valid date.' })); return; }
    if (inv.invoice_date > todayISO) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Invoice Date', current: inv.invoice_date, expected: `a date on or before today (${todayISO})`, fix: 'Correct the invoice date - a return cannot contain a future-dated invoice.' })); return; }
    if (inv.supply_type !== 'interstate' && inv.supply_type !== 'intrastate') { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Supply Type', current: inv.supply_type, expected: 'interstate or intrastate', fix: 'Re-save the invoice; the Interstate/Intrastate toggle sets this.' })); return; }

    const pos = gstr1PosRegistered(gstin);
    if (!GSTR1_VALID_POS_CODES.has(pos)) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Place of Supply', current: pos, expected: 'a recognised state code (the first two digits of the customer GSTIN)', fix: 'Correct the customer GST Number on the invoice.' })); return; }
    // POS vs supply_type must agree — if they don't, one of the two is
    // stale/wrong (see the earlier Interstate/Intrastate detection fix
    // for exactly this class of bug on the entry form itself).
    const expectedSupplyType = pos === businessStateCode ? 'intrastate' : 'interstate';
    if (expectedSupplyType !== inv.supply_type) {
      errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Supply Type', current: inv.supply_type, expected: `${expectedSupplyType} (customer GSTIN state ${pos} vs your state ${businessStateCode})`, fix: 'Open the invoice and re-pick the customer so Interstate/Intrastate is redetected.' }));
    }

    const items = gstr1ItemsForInvoice(inv, 'b2b', itemsByInvoice, legacyHsnRows);
    if (!items.length) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Line Items', current: 'none', expected: 'at least one line item', fix: 'Open the invoice and add its products.' })); return; }
    let itemsOk = true;
    items.forEach((it, idx) => {
      const itemCtx = `${ctx}, item ${idx + 1} ("${it.product_name}")`;
      if (+it.quantity <= 0) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, product: it.product_name, field: 'Quantity', current: it.quantity, expected: 'greater than zero', fix: 'Set a quantity on this line, or remove the line.' })); itemsOk = false; }
      if (+it.taxable_value < 0) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, product: it.product_name, field: 'Taxable Value', current: it.taxable_value, expected: 'zero or more', fix: 'Correct the rate or discount on this line.' })); itemsOk = false; }
      const preErrCount = errors.length;
      gstr1CheckItemTaxable(it, itemCtx, errors, { invoice: inv.invoice_number, customer: inv.customer_name });
      if (errors.length > preErrCount) itemsOk = false;
      const uqc = gstr1ToUQC(it.unit, it.hsn_code);
      if (uqc === null) {
        errors.push(gstr1Err({
          invoice: inv.invoice_number, customer: inv.customer_name, product: it.product_name,
          field: 'Unit', current: it.unit ? `"${it.unit}"` : '(not set)',
          expected: `one of ${Object.keys(GSTR1_UQC_MAP).join(', ')}`,
          message: `HSN ${it.hsn_code} is a physical good and has no unit of measure on it, so no UQC can be stated for it.`,
          fix: 'Open the product and set its Unit, then re-save the invoices that use it. The Portal rejects a goods line with no unit (RET191353).'
        }));
        itemsOk = false;
        return;
      }
      addToHsn('b2b', it.hsn_code, it.product_name, uqc, +it.quantity || 0, gstr1RecomputeItem(it, inv.supply_type), itemCtx);
    });
    if (!itemsOk) return;

    const recomputed = gstr1RecomputeInvoice(items, inv.supply_type);
    if (!gstr1TotalMatches(inv.total_amount, recomputed.total)) {
      errors.push(gstr1TotalMismatch(inv, recomputed.total));
      return;
    }

    const invEntry = {
      inum: inv.invoice_number, idt, val: gstr1InvoiceVal(recomputed.total), pos, rchrg: 'N', inv_typ: 'R',
      itms: recomputed.byRate.map((b, i) => ({ num: i + 1, itm_det: { txval: b.taxable, rt: b.rate, iamt: b.igst, camt: b.cgst, samt: b.sgst, csamt: 0 } }))
    };
    if (!b2bGroups.has(gstin)) b2bGroups.set(gstin, []);
    b2bGroups.get(gstin).push(invEntry);
  });
  // Ordering below follows the reference file, which is ordered
  // throughout: b2b runs in invoice-number order, b2cs by place of
  // supply, and each HSN array by HSN code. JSON arrays are ordered, so
  // unlike object keys this is a real difference rather than a cosmetic
  // one. (In the reference, invoice-number order and invoice-date order
  // coincide, so which of the two is the Utility's actual key is
  // UNVERIFIED; numbering is the more stable of the two.)
  const b2b = [...b2bGroups.entries()]
    .map(([ctin, inv]) => ({ ctin, inv: [...inv].sort((x, y) => gstr1CompareInvoiceNumbers(x.inum, y.inum)) }))
    .sort((a, b) => gstr1CompareInvoiceNumbers(a.inv[0].inum, b.inv[0].inum));

  // ── B2C — split into B2CL (unregistered, inter-state, above
  // threshold — reported per-invoice) vs B2CS (everything else in the
  // B2C bucket — reported as a state+rate aggregate). The old generator
  // had no B2CL section at all. ──
  const b2clGroups = new Map(); // pos -> inv[]
  const b2csBuckets = new Map(); // "state|rate|supplyType" -> aggregate
  b2cData.forEach(inv => {
    const ctx = `B2C invoice ${inv.invoice_number || inv.id}`;
    if (inv.supply_type !== 'interstate' && inv.supply_type !== 'intrastate') { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Supply Type', current: inv.supply_type, expected: 'interstate or intrastate', fix: 'Re-save the invoice; the Interstate/Intrastate toggle sets this.' })); return; }
    const idt = formatDateDDMMYYYY(inv.invoice_date);
    if (!gstr1DateOk(idt)) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Invoice Date', current: inv.invoice_date, expected: 'a real date, written to the file as DD-MM-YYYY', fix: 'Re-save the invoice with a valid date.' })); return; }
    if (inv.invoice_date > todayISO) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Invoice Date', current: inv.invoice_date, expected: `a date on or before today (${todayISO})`, fix: 'Correct the invoice date - a return cannot contain a future-dated invoice.' })); return; }

    const pos = gstr1PosUnregistered(inv.state, errors, ctx);
    if (!GSTR1_VALID_POS_CODES.has(pos) && pos !== '99') { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Place of Supply', current: pos, expected: 'a recognised state code', fix: 'Set the customer State on the invoice.' })); return; }

    const items = gstr1ItemsForInvoice(inv, 'b2c', itemsByInvoice, legacyHsnRows);
    if (!items.length) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, field: 'Line Items', current: 'none', expected: 'at least one line item', fix: 'Open the invoice and add its products.' })); return; }
    let itemsOk = true;
    items.forEach((it, idx) => {
      const itemCtx = `${ctx}, item ${idx + 1} ("${it.product_name}")`;
      if (+it.quantity <= 0) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, product: it.product_name, field: 'Quantity', current: it.quantity, expected: 'greater than zero', fix: 'Set a quantity on this line, or remove the line.' })); itemsOk = false; }
      if (+it.taxable_value < 0) { errors.push(gstr1Err({ invoice: inv.invoice_number, customer: inv.customer_name, product: it.product_name, field: 'Taxable Value', current: it.taxable_value, expected: 'zero or more', fix: 'Correct the rate or discount on this line.' })); itemsOk = false; }
      const preErrCount = errors.length;
      gstr1CheckItemTaxable(it, itemCtx, errors, { invoice: inv.invoice_number, customer: inv.customer_name });
      if (errors.length > preErrCount) itemsOk = false;
      const uqc = gstr1ToUQC(it.unit, it.hsn_code);
      if (uqc === null) {
        errors.push(gstr1Err({
          invoice: inv.invoice_number, customer: inv.customer_name, product: it.product_name,
          field: 'Unit', current: it.unit ? `"${it.unit}"` : '(not set)',
          expected: `one of ${Object.keys(GSTR1_UQC_MAP).join(', ')}`,
          message: `HSN ${it.hsn_code} is a physical good and has no unit of measure on it, so no UQC can be stated for it.`,
          fix: 'Open the product and set its Unit, then re-save the invoices that use it. The Portal rejects a goods line with no unit (RET191353).'
        }));
        itemsOk = false;
        return;
      }
      addToHsn('b2c', it.hsn_code, it.product_name, uqc, +it.quantity || 0, gstr1RecomputeItem(it, inv.supply_type), itemCtx);
    });
    if (!itemsOk) return;

    const recomputed = gstr1RecomputeInvoice(items, inv.supply_type);
    if (!gstr1TotalMatches(inv.total_amount, recomputed.total)) {
      errors.push(gstr1TotalMismatch(inv, recomputed.total));
      return;
    }

    const isLarge = inv.supply_type === 'interstate' && recomputed.total > GSTR1_B2CL_THRESHOLD;
    if (isLarge) {
      const invEntry = {
        inum: inv.invoice_number || `B2C-${inv.id.slice(0, 8)}`, idt, val: gstr1InvoiceVal(recomputed.total),
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
  const b2cl = [...b2clGroups.entries()]
    .map(([pos, inv]) => ({ pos, inv: [...inv].sort((x, y) => gstr1CompareInvoiceNumbers(x.inum, y.inum)) }))
    .sort((a, b) => a.pos.localeCompare(b.pos));
  const b2cs = [...b2csBuckets.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt);

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
    const retCtx = `Sales Return ${ret.return_number || ret.id}`;
    if (ret.return_date > todayISO) { errors.push(gstr1Err({ invoice: ret.return_number, field: 'Return Date', current: ret.return_date, expected: `a date on or before today (${todayISO})`, fix: 'Correct the return date.' })); return; }
    const items = srItemsByReturn[ret.id] || [];
    items.forEach((it, idx) => {
      const ctx = `${retCtx}, item ${idx + 1} ("${it.product_name}")`;
      if (+it.quantity <= 0) { errors.push(gstr1Err({ invoice: ret.return_number, product: it.product_name, field: 'Return Quantity', current: it.quantity, expected: 'greater than zero', fix: 'Correct the quantity on the sales return.' })); return; }
      if (!gstr1HsnFormatOk(it.hsn_code)) { errors.push(gstr1Err({ invoice: ret.return_number, product: it.product_name, field: 'HSN Code', current: it.hsn_code, expected: 'a 4, 6 or 8 digit code', fix: 'Set a valid HSN code on the product.' })); return; }
      const r = gstr1RecomputeItem(it, ret.supply_type);
      const key = it.hsn_code + '|' + r.rate;
      // Net against the channel the original sale went out on; a B2B
      // return cannot reduce the B2C summary.
      const channel = ret.original_invoice_type === 'b2c' ? 'b2c' : 'b2b';
      const bucket = hsnBuckets[channel].get(key);
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
    if (!['credit', 'debit'].includes(note.note_type)) { errors.push(gstr1Err({ invoice: note.note_number, customer: note.customer_name, field: 'Note Type', current: note.note_type, expected: 'credit or debit', fix: 'Re-save the note and pick its type.' })); return; }
    if (note.supply_type !== 'interstate' && note.supply_type !== 'intrastate') { errors.push(gstr1Err({ invoice: note.note_number, customer: note.customer_name, field: 'Supply Type', current: note.supply_type, expected: 'interstate or intrastate', fix: 'Re-save the note; the Interstate/Intrastate toggle sets this.' })); return; }
    const ntty = note.note_type === 'credit' ? 'C' : 'D';
    const ntDt = formatDateDDMMYYYY(note.note_date);
    if (!gstr1DateOk(ntDt)) { errors.push(gstr1Err({ invoice: note.note_number, customer: note.customer_name, field: 'Note Date', current: note.note_date, expected: 'a real date, written to the file as DD-MM-YYYY', fix: 'Re-save the note with a valid date.' })); return; }
    if (note.note_date > todayISO) { errors.push(gstr1Err({ invoice: note.note_number, customer: note.customer_name, field: 'Note Date', current: note.note_date, expected: `a date on or before today (${todayISO})`, fix: 'Correct the note date.' })); return; }
    if (+note.taxable_amount <= 0) { errors.push(gstr1Err({ invoice: note.note_number, customer: note.customer_name, field: 'Taxable Amount', current: note.taxable_amount, expected: 'greater than zero', fix: 'Set the note taxable amount.' })); return; }

    const taxable = round2(+note.taxable_amount);
    const calc = calcGST(taxable, +note.gst_percentage || 0, note.supply_type);
    const val = round2(taxable + calc.gstAmount);
    const gstin = (note.gstin || '').toUpperCase();

    if (gstin) {
      const gCheck = validateGstin(gstin);
      if (!gCheck.valid) { errors.push(gstr1Err({ invoice: note.note_number, customer: note.customer_name, field: 'Customer GST Number', current: gstin, expected: 'a valid 15-character GSTIN', message: `Customer GSTIN on this note is invalid (${gCheck.reason}).`, fix: 'Correct the GST Number on the note.' })); return; }
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

  // Each bucket map is keyed "hsn_sc|rate", so a row's rate comes back
  // out of its key rather than being stored twice. num restarts at 1 in
  // each array, as it does in a Utility-written return.
  // Sorted by HSN code, then rate; num is assigned after sorting so it
  // runs 1..n down the array as it does in the reference.
  const hsnRows = channel => [...hsnBuckets[channel].entries()]
    .map(([key, b]) => ({ ...b, rt: +key.split('|')[1] }))
    .sort((a, b) => a.hsn_sc.localeCompare(b.hsn_sc) || a.rt - b.rt)
    .map((b, i) => ({
      num: i + 1, hsn_sc: b.hsn_sc, desc: b.desc, uqc: b.uqc, qty: b.qty,
      txval: b.taxable, rt: b.rt, iamt: b.igst, camt: b.cgst, samt: b.sgst, csamt: 0
    }));
  const hsnB2B = hsnRows('b2b'), hsnB2C = hsnRows('b2c');
  // Only non-empty arrays are written, the same rule the top-level
  // sections follow.
  const hsn = {};
  if (hsnB2B.length) hsn.hsn_b2b = hsnB2B;
  if (hsnB2C.length) hsn.hsn_b2c = hsnB2C;

  // Documents issued (the Utility's doc_issue). Derived entirely from the
  // invoices already in this return: the numbering runs from the lowest
  // invoice number in the period to the highest, and totnum is how many
  // there are. cancel is 0 because this application has no concept of a
  // cancelled invoice — there is nothing to count, not a figure guessed.
  // doc_num 1 / "Invoices for outward supply" are the values the Utility
  // writes for this document type; the voucher types it also supports are
  // not emitted, because no such document exists in this app.
  const issuedNumbers = [...b2bData, ...b2cData]
    .map(r => r.invoice_number).filter(Boolean)
    .sort(gstr1CompareInvoiceNumbers);
  const doc_issue = issuedNumbers.length ? { doc_det: [{
    doc_num: 1,
    doc_typ: 'Invoices for outward supply',
    docs: [{
      num: 1,
      from: issuedNumbers[0],
      to: issuedNumbers[issuedNumbers.length - 1],
      totnum: issuedNumbers.length,
      cancel: 0,
      net_issue: issuedNumbers.length
    }]
  }] } : {};

  // Still computed, no longer emitted: a Utility-written return has no gt
  // or cur_gt, and the value we produced was the period's invoice total,
  // not the taxpayer's gross annual turnover, which is what gt means. The
  // final audit still reconciles every section against it.
  const grandTotal = round2(
    b2b.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.val, 0), 0) +
    b2cl.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.val, 0), 0) +
    b2cs.reduce((s, r) => s + round2(r.txval + r.iamt + r.camt + r.samt), 0) -
    cdnr.reduce((s, g) => s + g.nt.reduce((s2, n) => s2 + (n.ntty === 'C' ? n.val : -n.val), 0), 0) -
    cdnur.reduce((s, n) => s + (n.ntty === 'C' ? n.val : -n.val), 0)
  );

  // Assembled through the registry rather than as an object literal, so
  // the written key order and the emit-when-empty policy both come from
  // GSTR1_SECTIONS and cannot drift from what the audit expects.
  const payload = assembleGSTR1Payload({
    gstin: businessGstin, fp, version: GSTR1_VERSION, hash: GSTR1_HASH,
    b2b, b2cl, b2cs, cdnr, cdnur, hsn, doc_issue
  });
  return { payload, errors, context: { periodStart: start, periodEnd: end, salesReturnNettedTaxable, grandTotal } };
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

  // 2. Schema — presence, types, unknown keys and row shapes, all driven
  // by GSTR1_SECTIONS. Previously a key list hardcoded here, which meant
  // any section added to the payload was rejected as "unexpected" by this
  // very check. Run against the reparsed copy, so what is validated is
  // exactly what will be written.
  validateGSTR1Schema(reparsed, errors);

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
  const b2bTaxable = round2(sumItmTaxable(reparsed.b2b || []));
  const b2clTaxable = round2(sumItmTaxable(reparsed.b2cl || []));
  const b2csTaxable = round2((reparsed.b2cs || []).reduce((s, r) => s + r.txval, 0));
  const salesReturnNettedTaxable = round2(context?.salesReturnNettedTaxable || 0);
  const invoiceSideTaxable = round2(b2bTaxable + b2clTaxable + b2csTaxable - salesReturnNettedTaxable);
  const hsnTaxable = round2(['hsn_b2b', 'hsn_b2c']
    .flatMap(k => (reparsed.hsn && reparsed.hsn[k]) || [])
    .reduce((s, r) => s + r.txval, 0));
  if (Math.abs(invoiceSideTaxable - hsnTaxable) > GSTR1_RECONCILE_TOLERANCE) {
    errors.push(`Final audit — RECONCILIATION FAILED: (B2B + B2CL + B2CS − Sales Return adjustments) = ₹${invoiceSideTaxable} does not equal HSN section taxable total (₹${hsnTaxable}). Difference: ₹${round2(invoiceSideTaxable - hsnTaxable)}.`);
  }

  // 5b. CDNR/CDNUR self-consistency — each note's stated val must equal
  // its own itms' taxable + tax (this is what actually needs to
  // reconcile for notes, since HSN structurally can't).
  const noteValOk = (n) => Math.abs(n.val - round2(n.itms.reduce((s, it) => s + it.itm_det.txval + (it.itm_det.iamt || 0) + (it.itm_det.camt || 0) + (it.itm_det.samt || 0), 0))) <= GSTR1_RECONCILE_TOLERANCE;
  (reparsed.cdnr || []).forEach(g => g.nt.forEach(n => { if (!noteValOk(n)) errors.push(`Final audit: CDNR note ${n.nt_num} val (₹${n.val}) does not match its own item total.`); }));
  (reparsed.cdnur || []).forEach(n => { if (!noteValOk(n)) errors.push(`Final audit: CDNUR note ${n.nt_num} val (₹${n.val}) does not match its own item total.`); });

  // 6. Grand total — every section's own invoice-level value, re-derived
  // here from the payload and compared against the figure the builder
  // arrived at independently.
  const sumVal = (invArr) => invArr.reduce((s, g) => s + g.inv.reduce((s2, i) => s2 + i.val, 0), 0);
  const b2bVal = sumVal(reparsed.b2b || []), b2clVal = sumVal(reparsed.b2cl || []);
  const b2csVal = (reparsed.b2cs || []).reduce((s, r) => s + round2(r.txval + r.iamt + r.camt + r.samt), 0);
  const cdnrVal = (reparsed.cdnr || []).reduce((s, g) => s + g.nt.reduce((s2, n) => s2 + (n.ntty === 'C' ? n.val : -n.val), 0), 0);
  const cdnurVal = (reparsed.cdnur || []).reduce((s, n) => s + (n.ntty === 'C' ? n.val : -n.val), 0);
  const recomputedGt = round2(b2bVal + b2clVal + b2csVal - cdnrVal - cdnurVal);
  // gt is not written to the file any more, so this reconciles the
  // sections against the figure buildGSTR1Payload() computed while it was
  // assembling them. A disagreement still means the two halves of the
  // generator disagree about the same return.
  const statedGt = round2(context?.grandTotal || 0);
  if (Math.abs(recomputedGt - statedGt) > GSTR1_RECONCILE_TOLERANCE) {
    errors.push(`Final audit — GRAND TOTAL MISMATCH: the sections total ₹${recomputedGt} but the generator computed ₹${statedGt} while building them.`);
  }

  // 7. GSTIN validation across every section.
  (reparsed.b2b || []).forEach(g => { if (!validateGstin(g.ctin).valid) errors.push(`Final audit: B2B section ctin "${g.ctin}" is invalid.`); });
  (reparsed.cdnr || []).forEach(g => { if (!validateGstin(g.ctin).valid) errors.push(`Final audit: CDNR section ctin "${g.ctin}" is invalid.`); });

  // 8. POS validation across every section.
  const checkPos = (pos, where) => { if (!GSTR1_VALID_POS_CODES.has(pos) && pos !== '99') errors.push(`Final audit: invalid POS "${pos}" in ${where}.`); };
  (reparsed.b2b || []).forEach(g => g.inv.forEach(i => checkPos(i.pos, `B2B invoice ${i.inum}`)));
  (reparsed.b2cl || []).forEach(g => checkPos(g.pos, `B2CL group`));
  (reparsed.b2cs || []).forEach(r => checkPos(r.pos, `B2CS bucket (rate ${r.rt}%)`));

  // 9. HSN validation — format, and no duplicate hsn+rate rows (the
  // bucket map construction already prevents this internally, but the
  // final audit re-checks the actual arrays that will be written).
  //
  // Uniqueness is per array, not across both: the same HSN at the same
  // rate legitimately appears once in hsn_b2b and once in hsn_b2c when a
  // product is sold to registered and unregistered customers alike.
  ['hsn_b2b', 'hsn_b2c'].forEach(k => {
  const hsnSeen = new Set();
  ((reparsed.hsn && reparsed.hsn[k]) || []).forEach(row => {
    if (!gstr1HsnFormatOk(row.hsn_sc)) errors.push(`Final audit: HSN row "${row.hsn_sc}" is not a valid 4/6/8-digit code.`);
    const key = row.hsn_sc + '|' + row.rt;
    if (hsnSeen.has(key)) errors.push(`Final audit: duplicate HSN row for code ${row.hsn_sc} at rate ${row.rt}% in ${k}.`);
    hsnSeen.add(key);
    if (row.qty < 0) errors.push(`Final audit: HSN row ${row.hsn_sc} has negative quantity (${row.qty}).`);
    if (row.txval < 0) errors.push(`Final audit: HSN row ${row.hsn_sc} has negative taxable value (${row.txval}).`);
  });
  });
}

// ── Serialisation ───────────────────────────────────────────
// Written the way the Offline Utility writes it: one line, no padding,
// and nested object keys in alphabetical order. Neither matters to a JSON
// parser — objects are unordered and whitespace is insignificant — but
// matching removes a whole class of "why does mine look different"
// question when the two files are put side by side, and costs nothing.
//
// The root keeps the order GSTR1_SECTIONS declares (gstin, fp, version,
// hash, then sections), which is the order the Utility uses there.
function gstr1SortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(gstr1SortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(k => { out[k] = gstr1SortKeysDeep(value[k]); });
    return out;
  }
  return value;
}

function gstr1SerializePayload(payload) {
  const ordered = {};
  Object.keys(payload).forEach(k => { ordered[k] = gstr1SortKeysDeep(payload[k]); });
  // The reference escapes every forward slash ("00158\/26-27"). It is an
  // optional escape that any JSON parser reads back identically, so this
  // changes no value — it makes the two files byte-comparable, which is
  // worth having when the next difference has to be found by eye.
  return JSON.stringify(ordered).replace(/\//g, '\\/');
}

// ── What the file does not contain ──────────────────────────
// Reported on every export, whether or not it succeeds. These do not
// block the download — they are statements of coverage, so the filer
// knows what still has to be entered on the Portal instead of finding
// out when the return is short.
function gstr1CoverageNotes(payload) {
  const notes = GSTR1_UNPRODUCED_SECTIONS.map(s =>
    `Not included — ${s.label}: ${s.reason}. Add it on the Portal after upload if this period needs it.`);
  GSTR1_SECTIONS.filter(s => s.kind === 'section').forEach(spec => {
    if (payload[spec.key] !== undefined && gstr1SectionIsEmpty(spec, payload[spec.key])) {
      notes.push(`Empty — ${spec.label}: no qualifying records this period; the section is still written to the file.`);
    }
  });
  return notes;
}

// ── UI: validation-failure modal (never a native alert()) ──
function gstr1SetModal(titleHtml, leadHtml, innerHtml) {
  const modal = document.getElementById('gstr1ValidationModal');
  const list = document.getElementById('gstr1ValidationList');
  if (!modal || !list) return false;
  const title = document.getElementById('gstr1ValidationTitle');
  const lead = document.getElementById('gstr1ValidationLead');
  if (title) title.innerHTML = titleHtml;
  if (lead) lead.innerHTML = leadHtml;
  list.innerHTML = innerHtml;
  modal.classList.add('open');
  return true;
}

// One error, laid out so the person reading it can act without going
// looking: which document, which line, which field, what is there, what
// belongs there, and what to do about it.
function gstr1ErrorHtml(e) {
  if (typeof e === 'string' || !e || !e.__gstr1Err) return `<li>${escItemHtml(gstr1ErrorText(e))}</li>`;
  const row = (k, v) => v === undefined || v === null || v === ''
    ? '' : `<div><span class="text-muted-sm" style="display:inline-block;min-width:118px;">${k}</span>${escItemHtml(String(v))}</div>`;
  return `<li style="margin-bottom:14px;">
    ${e.message ? `<div class="fw-600 mb-6">${escItemHtml(e.message)}</div>` : ''}
    ${row('Invoice', e.invoice)}
    ${row('Customer', e.customer)}
    ${row('Product', e.product)}
    ${row('Field', e.field)}
    ${row('Current value', e.current)}
    ${row('Expected', e.expected)}
    ${e.fix ? `<div class="mt-6"><b>How to fix:</b> ${escItemHtml(e.fix)}</div>` : ''}
  </li>`;
}

function showGSTR1ValidationErrors(errors, notes = []) {
  const errorItems = errors.map(gstr1ErrorHtml).join('');
  const noteItems = notes.length
    ? `<li style="list-style:none;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
         <b>Sections this export does not produce</b>
         <ul style="margin-top:8px;">${notes.map(n => `<li>${escItemHtml(n)}</li>`).join('')}</ul>
       </li>`
    : '';
  const shown = gstr1SetModal(
    '<i class="fas fa-triangle-exclamation" style="color:var(--danger, #d32f2f);"></i> GSTR-1 Export Blocked — Validation Failed',
    'The JSON was <b>not</b> generated. Fix the issue(s) below and try again.',
    errorItems + noteItems);
  if (!shown) {
    showToast(`GSTR-1 export blocked — ${errors.length} validation error(s). See console.`, 'error');
    // Rendered as text: a structured record logs as [object Object] otherwise.
    console.error('GSTR-1 validation errors:', errors.map(gstr1ErrorText));
  }
}

// Shown after a successful export: what the filer still has to handle on
// the Portal. A return that is short a section is the filer's problem to
// fix, so it is stated here rather than only in the console.
function showGSTR1CoverageSummary(notes) {
  if (!notes.length) return;
  gstr1SetModal(
    '<i class="fas fa-circle-info" style="color:var(--primary);"></i> GSTR-1 Exported — What This File Covers',
    'The JSON was generated and downloaded. It does <b>not</b> contain the sections below, because this application holds no data for them.',
    notes.map(n => `<li>${escItemHtml(n)}</li>`).join(''));
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
  // The period dropdown is filled from the database after the page loads.
  // A click landing in that window used to read a select with no options
  // — value "", selectedIndex -1 — and report "(nothing selected)" while
  // the user was looking at July 2026 in the very same control a moment
  // later. Waiting costs nothing once it is ready, and makes an early
  // click do what was meant instead of failing.
  await gstr1AwaitPeriodOptions();

  // Whatever the period dropdown actually holds — no fallback. A default
  // of 'current' here would put the system month on the file when nothing
  // had been selected, which is the failure this is guarding against.
  const periodEl = document.getElementById('reportMonth');
  const periodFilter = periodEl?.value ?? '';

  // Traceable on demand. A period that arrives wrong has to be diagnosed
  // from the machine it happened on, and "it says current" is not enough
  // to tell whether the dropdown held that, whether the element was found
  // at all, or whether something reset it between the click and here.
  gstr1TracePeriod('exportGSTR1JSON', periodEl, periodFilter);

  showToast('Validating GSTR-1 data…', 'success');
  const { payload, errors, context } = await buildGSTR1Payload(user.id, profile, periodFilter);

  // Before anything else: the state table must still cover every state the
  // app can store. A gap here means POS silently becomes 99, so it blocks
  // the export rather than producing a return with a bad place of supply.
  gstr1AssertStateTableComplete(errors);

  // Schema first, then the reconciliation audit — a payload with a missing
  // or mistyped section produces clearer errors from the schema pass than
  // from arithmetic that trips over it.
  // Three gates, cheapest and most structural first, so the message the
  // user sees is the one closest to the actual cause:
  //   schema  — is the payload the right shape at all
  //   strict  — is every value one this generator may legitimately emit
  //   audit   — do the totals reconcile against each other
  if (!errors.length && payload) validateGSTR1Schema(payload, errors);
  if (!errors.length && payload) validateGSTR1Strict(payload, errors);
  if (!errors.length) runFinalGSTR1Audit(payload, errors, context);

  const notes = payload ? gstr1CoverageNotes(payload) : [];
  notes.forEach(n => console.info('[GSTR-1 coverage]', n));

  if (errors.length) {
    showGSTR1ValidationErrors(errors, notes);
    return; // never write the file
  }

  const blob = new Blob([gstr1SerializePayload(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `GSTR1_${payload.fp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('GSTR-1 JSON validated and exported — ready to upload to the GST Portal.', 'success');
  showGSTR1CoverageSummary(notes);
}

function formatDateDDMMYYYY(d) {
  if (!d) return '';
  const parts = String(d).split('-');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return d;
}

// ── State code table ────────────────────────────────────────
// Keyed by the EXACT strings in INDIAN_STATES (js/utils.js) — the list
// every state dropdown in this app is built from, and therefore the only
// set of values that can actually reach here from stored invoice data.
//
// The previous table was keyed by hand-typed names that had drifted out
// of step with that list, and two of them no longer matched anything the
// app can store:
//
//   "Andaman and Nicobar Islands"              -> no key -> 99
//   "Dadra and Nagar Haveli and Daman and Diu" -> no key -> 99
//
// A 99 here is not a harmless default: gstr1PosUnregistered() treats it
// as "unrecognised state" and blocks the whole export, so a single B2C
// invoice to either of those two UTs made a GSTR-1 file impossible to
// produce at all. gstr1AssertStateTableComplete() below now fails the
// export loudly if this table and INDIAN_STATES ever drift again.
const GSTR1_STATE_CODES = {
  'Andhra Pradesh':'37','Arunachal Pradesh':'12','Assam':'18','Bihar':'10',
  'Chhattisgarh':'22','Goa':'30','Gujarat':'24','Haryana':'06',
  'Himachal Pradesh':'02','Jharkhand':'20','Karnataka':'29','Kerala':'32',
  'Madhya Pradesh':'23','Maharashtra':'27','Manipur':'14','Meghalaya':'17',
  'Mizoram':'15','Nagaland':'13','Odisha':'21','Punjab':'03','Rajasthan':'08',
  'Sikkim':'11','Tamil Nadu':'33','Telangana':'36','Tripura':'16',
  'Uttar Pradesh':'09','Uttarakhand':'05','West Bengal':'19',
  'Andaman and Nicobar Islands':'35','Chandigarh':'04',
  'Dadra and Nagar Haveli and Daman and Diu':'26','Delhi':'07',
  'Jammu and Kashmir':'01','Ladakh':'38','Lakshadweep':'31','Puducherry':'34'
};

// Values stored by older versions of this app, before INDIAN_STATES was
// updated. They are not offered anywhere in the UI any more, but rows
// carrying them still exist in the database and must still resolve.
// Dadra and Nagar Haveli and Daman and Diu are one UT in INDIAN_STATES,
// so both legacy names resolve to that single entry's code — code 25 has
// no entry in INDIAN_STATES to belong to and is therefore never emitted.
const GSTR1_LEGACY_STATE_ALIASES = {
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu'
};

// The POS codes this generator can legitimately emit: exactly the codes
// reachable from the table above, derived rather than listed a second
// time. utils.js's GST_VALID_STATE_CODES is deliberately left alone — it
// backs validateGstin() for data entry app-wide, and is a wider set that
// still accepts historical prefixes; narrowing it is a data-entry change,
// not a generator change.
const GSTR1_VALID_POS_CODES = new Set(Object.values(GSTR1_STATE_CODES));

// Every state the app can store must be mappable. Run as part of export
// validation, so drift surfaces as a blocked export with a precise
// message instead of a silent 99 on someone's return.
function gstr1AssertStateTableComplete(errors) {
  if (typeof INDIAN_STATES === 'undefined') return;
  const missing = INDIAN_STATES.filter(s => !GSTR1_STATE_CODES[s]);
  if (missing.length) {
    errors.push(`GSTR-1 generator: no GST state code is defined for ${missing.map(s => `"${s}"`).join(', ')} — GSTR1_STATE_CODES in js/gstr1-export.js has drifted from INDIAN_STATES in js/utils.js and must be updated before any return can be generated.`);
  }
}

function getStateCode(stateName) {
  const raw = (stateName || '').trim();
  if (!raw) return '99';
  if (GSTR1_STATE_CODES[raw]) return GSTR1_STATE_CODES[raw];
  // Case-insensitive match against the canonical list, then legacy names.
  const lower = raw.toLowerCase();
  const canonical = Object.keys(GSTR1_STATE_CODES).find(k => k.toLowerCase() === lower);
  if (canonical) return GSTR1_STATE_CODES[canonical];
  const alias = GSTR1_LEGACY_STATE_ALIASES[lower];
  return alias ? GSTR1_STATE_CODES[alias] : '99';
}
