// =============================================
// Utility Functions
// =============================================

// ── Theme (applied immediately to avoid a flash of the wrong theme) ──
(function applyStoredTheme() {
  const theme = localStorage.getItem('gst_theme') || 'light';
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

function toggleTheme(dark) {
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('gst_theme', dark ? 'dark' : 'light');
}

// Uppercases an input's value in place without moving the caret —
// toUpperCase() never changes string length, so re-applying the same
// selection range after the swap keeps typing/pasting mid-string safe.
function uppercaseKeepCursor(el) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.toUpperCase();
  if (start !== null && end !== null) el.setSelectionRange(start, end);
}

// ── App-wide preferences (default GST rate, financial year) ──
function getAppSettings() {
  try { return JSON.parse(localStorage.getItem('gst_app_settings') || '{}'); } catch { return {}; }
}

function saveAppSetting(key, value) {
  const settings = getAppSettings();
  settings[key] = value;
  localStorage.setItem('gst_app_settings', JSON.stringify(settings));
}

function getDefaultGstPct() {
  const v = getAppSettings().defaultGstPct;
  return v === undefined || v === null || v === '' ? 18 : v;
}

// ── Invoice Number Format (Auto Generate mode) ──────
// Three cases, in order:
//  1. Format contains a run of # characters — it becomes the zero-padded
//     running sequence, everything else left exactly as typed, wherever
//     it appears (prefix, middle, or suffix). INV-2026-### -> INV-2026-001,
//     VT/B2B/#### -> VT/B2B/0001, SALE## -> SALE01.
//  2. Format is purely digits (e.g. "1") — that number IS the running
//     sequence, not a literal prefix to keep re-stating (appending would
//     read "1-1", "1-2", which isn't what a bare numeric format means).
//     1 -> 1, 2, 3, 4...
//  3. Any other plain text with no # — the running sequence is appended
//     as a new "-N" suffix, not merged into any digits already present
//     (INV-2026 keeps "2026" literal and still counts from -1, it does
//     NOT continue 2027, 2028...). INV -> INV-1, INV-2; INV-2026 ->
//     INV-2026-1, INV-2026-2; VT/B2B -> VT/B2B-1, VT/B2B-2.
function applyInvoiceNumberFormat(format, seq) {
  const fmt = (format || '').trim() || 'INV-###';
  const n = Math.max(1, parseInt(seq, 10) || 1);
  const match = fmt.match(/#+/);
  if (match) {
    const padded = String(n).padStart(match[0].length, '0');
    return fmt.slice(0, match.index) + padded + fmt.slice(match.index + match[0].length);
  }
  if (/^\d+$/.test(fmt)) return String(n);
  return fmt + '-' + n;
}

// ── GST registration ────────────────────────────────────────
// What kind of registration the business holds. This decides what it may
// file and what documents it issues, so it is written down once here and
// read by every module that depends on it rather than being re-guessed.
//
// 'regular' is the default and is what every profile created before this
// existed is: they have been filing GSTR-1, which is a regular
// registration's return.
const GST_REGISTRATION_TYPES = [
  { value: 'regular',       label: 'Regular',                    files: 'GSTR-1 / GSTR-3B' },
  { value: 'composition',   label: 'Composition',                files: 'CMP-08 / GSTR-4' },
  { value: 'casual',        label: 'Casual Taxable Person',      files: 'GSTR-1 / GSTR-3B' },
  { value: 'sez_unit',      label: 'SEZ Unit',                   files: 'GSTR-1 / GSTR-3B' },
  { value: 'sez_developer', label: 'SEZ Developer',              files: 'GSTR-1 / GSTR-3B' },
  { value: 'isd',           label: 'Input Service Distributor',  files: 'GSTR-6' },
  { value: 'tds',           label: 'Tax Deductor',               files: 'GSTR-7' },
  { value: 'tcs',           label: 'Tax Collector',              files: 'GSTR-8' }
];

const GST_REGISTRATION_DEFAULT = 'regular';

function gstRegistrationType(profile) {
  const v = String(profile?.registration_type || '').trim().toLowerCase();
  return GST_REGISTRATION_TYPES.some(t => t.value === v) ? v : GST_REGISTRATION_DEFAULT;
}

function gstRegistrationLabel(value) {
  const t = GST_REGISTRATION_TYPES.find(x => x.value === gstRegistrationType({ registration_type: value }));
  return t ? t.label : value;
}

// Which return this registration actually files. A composition dealer
// does not file GSTR-1 at all — it files CMP-08 quarterly and GSTR-4
// annually — and an ISD, deductor or collector each file their own
// return. Saying so is the point of storing the type.
function gstFilesGstr1(profile) {
  const t = gstRegistrationType(profile);
  return t !== 'composition' && t !== 'isd' && t !== 'tds' && t !== 'tcs';
}

// The constitutions the Portal lists. Free text underneath, so a value
// that is not on this list is kept rather than discarded.
const GST_BUSINESS_CONSTITUTIONS = [
  'Proprietorship', 'Partnership', 'Limited Liability Partnership',
  'Private Limited Company', 'Public Limited Company',
  'Hindu Undivided Family', 'Society / Club / Trust / AOP',
  'Government Department', 'Public Sector Undertaking',
  'Foreign Company', 'Others'
];

// A Letter of Undertaking lets a business export without paying IGST.
// Whether one is in force on a given date decides exp_typ in GSTR-1's
// 6A — WOPAY with a live LUT, WPAY without. Returns a plain object
// rather than a boolean so a caller can say WHY, which matters when an
// LUT has simply expired.
function gstLutStatus(profile, onDateISO) {
  const number = String(profile?.lut_number || '').trim();
  const expiry = String(profile?.lut_expiry || '').slice(0, 10);
  if (!number) return { active: false, reason: 'no LUT recorded', number: '', expiry: '' };
  if (!expiry) return { active: true, reason: 'no expiry recorded', number, expiry: '' };
  // Both are plain YYYY-MM-DD strings; compared as strings so no Date is
  // constructed and no timezone can shift the day. An LUT is valid
  // through its expiry date, not up to the day before.
  const on = String(onDateISO || '').slice(0, 10);
  if (!on) return { active: true, reason: 'no date to check against', number, expiry };
  return on <= expiry
    ? { active: true, reason: 'in force', number, expiry }
    : { active: false, reason: `expired on ${expiry}`, number, expiry };
}

// The place of supply to assume when a document does not establish one.
// Blank falls back to the state of registration, which is what the app
// already assumed before this field existed.
function gstDefaultPlaceOfSupply(profile) {
  return String(profile?.default_pos || '').trim() || String(profile?.state || '').trim();
}

// The financial year a date falls in, as "2026-27". India's runs April
// to March. Built from the string, never from a Date, so a date-only
// value cannot be shifted a day by a timezone.
function gstFinancialYearOf(dateISO) {
  const s = String(dateISO || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return '';
  const year = +m[1], month = +m[2];
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// ── GST document registry ───────────────────────────────────
// Every document GST requires a business to issue or record, described
// as data rather than decided by code.
//
// THIS IS METADATA ONLY. It stores no business record and owns no table.
// Every document type names the domain table its rows live in, and those
// tables stay independent of each other — invoices in the invoice
// tables, notes in cdn_notes, purchases in purchases, e-way bills in
// eway_bills, and a future type in its own table. Reporting, indexing
// and auditing each stay a question about one table rather than a filter
// over a shared one.
//
// The point of the table below is that adding a document type is adding
// a row to it. Nothing about a type is decided by a branch elsewhere:
// what it is called, whether it is taxable, whether it counts toward
// turnover, whether it reaches the HSN summary, which returns report it
// and under which tables, where its rows live, and whether it is in
// force are all fields. A return that does not exist here yet — GSTR-3B,
// GSTR-9, CMP-08, GSTR-6, ITC-04 — reads these same rows through the
// same accessors.
//
// PROVENANCE, because this decides what a filed return claims:
//
//   tax_invoice is PROVEN. The return this application already produces
//   writes doc_num 1 with doc_typ "Invoices for outward supply", and
//   that file was diffed field-for-field against a JSON written by the
//   official Offline Utility for the same invoices, to zero differences.
//
//   The other Table 13 rows are CORROBORATED, not proven: the list and
//   its order come from Oracle's published JD Edwards GST localisation
//   documentation for GSTR-1 Section 13, whose first entry is the one we
//   have proven — which is what makes the ordering credible. The exact
//   spelling of the rest has not been checked against a Utility-written
//   file, because none containing them has been available.
//
//   Documents outside Table 13 are sourced from the CGST Rule named in
//   each row.
//
// `status` and `enabled` are what keep an unbuilt type harmless.
// `status` is what GST says about the document; `enabled` is what this
// application can currently do with it. A type can be perfectly in force
// and still disabled here, which is the normal state for one whose
// module has not landed. Nothing below changes tax_invoice.
//
// FIELDS
//   key / label / portalName / rule    identity, and the name GST uses
//   direction                          outward (we issue) | inward (we receive)
//   storage                            the domain table holding its rows;
//                                      `null` while its module is pending
//   series                             which numbering book it draws from;
//                                      `null` when it is not numbered by
//                                      us (a counterparty or NIC numbers it)
//   taxable / affectsTurnover / affectsHsn / affectsLiability
//   affectsAmendments                  this document IS an amendment of
//                                      another (a revised invoice, an ISD
//                                      credit note)
//   supportsCancellation               may be cancelled before use, which
//                                      is what Table 13's own `cancel`
//                                      column counts. False for a
//                                      document somebody else issued.
//   supportsAmendment                  a later return may amend THIS
//                                      document — the converse of
//                                      affectsAmendments above, and a
//                                      genuinely different question
//   supportsAutoNumbering              this application can issue its next
//                                      number from `series`
//   supportsManualNumbering            its number may be typed or carried
//                                      in from an import. Always true:
//                                      every document type can be recorded
//                                      from one somebody else issued.
//   docNum                             ordinal in GSTR-1 Table 13, or null
//   sections                           [{ ret, table, json }] — every
//                                      return that reports it. A new
//                                      return is another entry here, not
//                                      another column.
//   requires                           fields a document of this type must carry
//   masters                            masters it needs beyond Customer/Product
//   validations                        rules that must hold before it is filed
//   effectiveFrom / effectiveTo        the period the document type is in
//                                      force under GST; null `to` = still current
//   status                             active | superseded | withdrawn | draft
//   version                            this entry's metadata revision
//   enabled                            is its behaviour built in this app yet
//   proven                             is its portalName verified against a
//                                      Utility-written file
const GST_DOCUMENT_STATUS = ['active', 'superseded', 'withdrawn', 'draft'];

// GST commenced on this date, which is when every document created by
// the original CGST Rules came into force.
const GST_COMMENCEMENT = '2017-07-01';

const GST_DOCUMENT_TYPES = [
  // ── Outward: the tax invoice family ──
  { key: 'tax_invoice', label: 'Tax Invoice', portalName: 'Invoices for outward supply',
    rule: 'Rule 46', direction: 'outward', storage: 'b2b_invoices / b2c_invoices',
    series: 'invoice',
    taxable: true, affectsTurnover: true, affectsHsn: true, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 1,
    sections: [
      { ret: 'GSTR-1', table: '4A / 4B / 5 / 6A / 6B / 6C / 7', json: 'b2b[].inv[] / b2cl[].inv[] / b2cs[] / exp[].inv[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a)', json: null },
      { ret: 'GSTR-9', table: '4A-4G', json: null }
    ],
    requires: ['document_number', 'document_date', 'party', 'place_of_supply', 'line_items'],
    masters: [], validations: ['gstin', 'place_of_supply', 'hsn', 'uqc', 'rate', 'total_reconciles'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: true },

  { key: 'bill_of_supply', label: 'Bill of Supply', portalName: 'Invoices for outward supply',
    rule: 'Rule 49', direction: 'outward', storage: null, series: 'bill_of_supply',
    taxable: false, affectsTurnover: true, affectsHsn: true, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true,
    // Not a thirteenth Table 13 row: a Bill of Supply is issued INSTEAD
    // of a tax invoice by a composition dealer or an exempt supplier, and
    // Table 13 reports it under row 1 because that table reports
    // numbering series, not tax status.
    docNum: 1,
    sections: [
      { ret: 'GSTR-1', table: '8', json: 'nil.inv[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(c)', json: null },
      { ret: 'GSTR-9', table: '5D-5F', json: null },
      { ret: 'CMP-08', table: '3', json: null }
    ],
    requires: ['document_number', 'document_date', 'party', 'line_items'],
    masters: [], validations: ['no_tax_charged', 'hsn'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: false, proven: false },

  { key: 'invoice_cum_bill_of_supply', label: 'Invoice-cum-Bill of Supply',
    portalName: 'Invoices for outward supply', rule: 'Rule 46A',
    direction: 'outward', storage: null, series: 'invoice',
    taxable: true, affectsTurnover: true, affectsHsn: true, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 1,
    sections: [
      { ret: 'GSTR-1', table: '7', json: 'b2cs[]' },
      { ret: 'GSTR-1', table: '8', json: 'nil.inv[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a) + 3.1(c)', json: null },
      { ret: 'GSTR-9', table: '4A-4G + 5D-5F', json: null }
    ],
    requires: ['document_number', 'document_date', 'party', 'line_items'],
    // The one type that is ALLOWED to mix taxable and non-taxable lines
    // on one document — Rule 46A exists precisely for that. The mixed-
    // treatment refusal added in Module 3 must exempt this type when its
    // module lands, which is why the exemption is recorded here rather
    // than remembered.
    masters: [], validations: ['mixed_treatment_permitted', 'hsn'],
    effectiveFrom: '2017-10-13', effectiveTo: null, status: 'active', version: 1,
    enabled: false, proven: false },

  { key: 'self_invoice', label: 'Self Invoice (RCM)',
    portalName: 'Invoices for inward supply from unregistered person',
    rule: 'Section 31(3)(f)', direction: 'inward', storage: 'self_invoices', series: 'self_invoice',
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 2,
    // Raised by the recipient on itself for an inward supply, so it is
    // not an outward supply and appears in no GSTR-1 supply table — only
    // in Table 13, which reports documents issued whatever their
    // direction. The liability it creates is declared in GSTR-3B.
    sections: [
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(d)', json: null },
      { ret: 'GSTR-9', table: '4G', json: null }
    ],
    requires: ['document_number', 'document_date', 'supplier', 'place_of_supply', 'line_items'],
    masters: ['unregistered supplier'], validations: ['reverse_charge_applies', 'place_of_supply'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'revised_invoice', label: 'Revised Invoice', portalName: 'Revised Invoice',
    rule: 'Rule 53(1)', direction: 'outward', storage: 'revised_invoices', series: 'revised_invoice',
    taxable: true, affectsTurnover: true, affectsHsn: true, affectsLiability: true,
    affectsAmendments: true,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 3,
    sections: [
      { ret: 'GSTR-1', table: '9A', json: 'b2ba[] / b2cla[] / b2csa[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a)', json: null },
      { ret: 'GSTR-9', table: '10 / 11', json: null }
    ],
    requires: ['document_number', 'document_date', 'original_document', 'party', 'line_items'],
    masters: [], validations: ['original_document_exists', 'original_period_filed'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'debit_note', label: 'Debit Note', portalName: 'Debit Note',
    rule: 'Section 34(3), Rule 53(1A)', direction: 'outward', storage: 'cdn_notes',
    series: 'debit_note',
    taxable: true, affectsTurnover: true, affectsHsn: true, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 4,
    sections: [
      { ret: 'GSTR-1', table: '9B', json: 'cdnr[].nt[] / cdnur[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a)', json: null },
      { ret: 'GSTR-9', table: '4J', json: null }
    ],
    requires: ['document_number', 'document_date', 'original_document', 'party', 'reason'],
    masters: [], validations: ['original_document_exists', 'gstin', 'place_of_supply'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'credit_note', label: 'Credit Note', portalName: 'Credit Note',
    rule: 'Section 34(1), Rule 53(1A)', direction: 'outward', storage: 'cdn_notes',
    series: 'credit_note',
    taxable: true, affectsTurnover: true, affectsHsn: true, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 5,
    sections: [
      { ret: 'GSTR-1', table: '9B', json: 'cdnr[].nt[] / cdnur[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a) reduction', json: null },
      { ret: 'GSTR-9', table: '4I', json: null }
    ],
    requires: ['document_number', 'document_date', 'original_document', 'party', 'reason'],
    masters: [], validations: ['original_document_exists', 'gstin', 'place_of_supply', 'time_limit'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  // ── Outward: vouchers ──
  { key: 'receipt_voucher', label: 'Receipt Voucher', portalName: 'Receipt Voucher',
    rule: 'Section 31(3)(d), Rule 50', direction: 'outward', storage: 'receipt_vouchers',
    series: 'receipt_voucher',
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 6,
    // An advance is taxed when received; the turnover arrives later with
    // the invoice, so counting the voucher toward turnover would count
    // the same supply twice.
    sections: [
      { ret: 'GSTR-1', table: '11A', json: 'at[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a)', json: null },
      { ret: 'GSTR-9', table: '4F', json: null }
    ],
    requires: ['document_number', 'document_date', 'party', 'place_of_supply', 'rate', 'advance_amount'],
    masters: [], validations: ['place_of_supply', 'rate'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'payment_voucher', label: 'Payment Voucher', portalName: 'Payment Voucher',
    rule: 'Section 31(3)(g), Rule 52', direction: 'inward', storage: 'payment_vouchers',
    series: 'payment_voucher',
    taxable: false, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 7,
    // Records paying a supplier under reverse charge. The liability was
    // already created by the Self Invoice; treating the voucher as a
    // second liability would double-count it.
    sections: [
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' }
    ],
    requires: ['document_number', 'document_date', 'supplier', 'amount_paid'],
    masters: ['unregistered supplier'], validations: ['linked_self_invoice'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'refund_voucher', label: 'Refund Voucher', portalName: 'Refund Voucher',
    rule: 'Section 31(3)(e), Rule 51', direction: 'outward', storage: 'refund_vouchers',
    series: 'refund_voucher',
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 8,
    // Issued when an advance is returned without a supply being made, so
    // it reverses the liability the receipt voucher created.
    sections: [
      { ret: 'GSTR-1', table: '11B', json: 'txpd[]' },
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'GSTR-3B', table: '3.1(a) reduction', json: null },
      { ret: 'GSTR-9', table: '4F', json: null }
    ],
    requires: ['document_number', 'document_date', 'original_document', 'party', 'refund_amount'],
    masters: [], validations: ['original_receipt_voucher_exists', 'refund_not_exceeding_advance'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  // ── Outward: delivery challans, four separate Table 13 rows ──
  //
  // Each variant draws on its OWN numbering book. Rule 55 allows a challan
  // to be numbered "in one or multiple series", so either would be lawful,
  // and one shared book was the first design. It was changed because the
  // four variants report as four separate Table 13 rows: a shared book
  // interleaves them, so row 9 might report DC-00001..DC-00005 with a
  // total of 3 while row 10 reports DC-00002..DC-00004 with a total of 2 —
  // overlapping ranges across rows. Nothing in the portal documentation,
  // the schema references or the offline utility material says whether
  // that is accepted, and a filing is the wrong place to find out.
  // Separate books make the question moot: every row's range is its own.
  //
  // `series` is the one place this is decided. Setting all four back to a
  // single word restores shared numbering without a code change.
  // Goods move without being supplied: no supply table, no HSN summary,
  // no liability. Each variant is its own Table 13 row.
  { key: 'dc_job_work', label: 'Delivery Challan — job work',
    portalName: 'Delivery Challan for job work', rule: 'Rule 55, Rule 45',
    direction: 'outward', storage: 'delivery_challans', series: 'dc_job_work',
    taxable: false, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 9,
    sections: [
      { ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' },
      { ret: 'ITC-04', table: '4', json: null }
    ],
    requires: ['document_number', 'document_date', 'job_worker', 'line_items', 'value'],
    masters: ['job worker'], validations: ['job_worker_gstin_or_address', 'return_within_time_limit'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'dc_approval', label: 'Delivery Challan — supply on approval',
    portalName: 'Delivery Challan for supply on approval', rule: 'Rule 55(1)(c)',
    direction: 'outward', storage: 'delivery_challans', series: 'dc_approval',
    taxable: false, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 10,
    sections: [{ ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' }],
    requires: ['document_number', 'document_date', 'party', 'line_items', 'value'],
    masters: [], validations: ['invoice_within_six_months'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'dc_liquid_gas', label: 'Delivery Challan — liquid gas',
    portalName: 'Delivery Challan in case of liquid gas', rule: 'Rule 55(1)(a)',
    direction: 'outward', storage: 'delivery_challans', series: 'dc_liquid_gas',
    taxable: false, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 11,
    sections: [{ ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' }],
    requires: ['document_number', 'document_date', 'party', 'line_items'],
    masters: [], validations: ['quantity_unknown_at_dispatch'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'dc_other', label: 'Delivery Challan — other',
    portalName: 'Delivery Challan in cases other than by way of supply',
    rule: 'Rule 55(1)(d)', direction: 'outward', storage: 'delivery_challans', series: 'dc_other',
    taxable: false, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: 12,
    sections: [{ ret: 'GSTR-1', table: '13', json: 'doc_issue.doc_det[]' }],
    requires: ['document_number', 'document_date', 'party', 'line_items'],
    masters: [], validations: [],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  // ── Documents no GSTR-1 table reports, which other returns need ──
  // Recorded now so those returns are additions rather than redesigns.
  { key: 'isd_invoice', label: 'ISD Invoice', portalName: 'ISD Invoice',
    rule: 'Rule 54(1)', direction: 'outward', storage: null, series: 'isd_invoice',
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: true,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: null,
    sections: [{ ret: 'GSTR-6', table: '5', json: null }],
    requires: ['document_number', 'document_date', 'recipient_gstin', 'credit_distributed'],
    masters: ['ISD recipient unit'], validations: ['same_pan_as_distributor', 'credit_fully_distributed'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: false, proven: false },

  { key: 'isd_credit_note', label: 'ISD Credit Note', portalName: 'ISD Credit Note',
    rule: 'Rule 54(1A)', direction: 'outward', storage: null, series: 'isd_invoice',
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: true,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: true, supportsManualNumbering: true, docNum: null,
    sections: [{ ret: 'GSTR-6', table: '6', json: null }],
    requires: ['document_number', 'document_date', 'original_document', 'recipient_gstin'],
    masters: ['ISD recipient unit'], validations: ['original_isd_invoice_exists'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: false, proven: false },

  { key: 'bill_of_entry', label: 'Bill of Entry (import of goods)',
    portalName: 'Bill of Entry', rule: 'Customs Act / Section 16',
    direction: 'inward', storage: null,
    // Numbered by Customs, not by us — a null series is what stops the
    // numbering system from ever trying to issue one.
    series: null,
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: false, supportsAmendment: false,
    supportsAutoNumbering: false, supportsManualNumbering: true, docNum: null,
    sections: [
      { ret: 'GSTR-3B', table: '4(A)(1)', json: null },
      { ret: 'GSTR-9', table: '6E', json: null }
    ],
    requires: ['document_number', 'document_date', 'port_code', 'assessable_value', 'igst', 'cess'],
    masters: ['port'], validations: ['port_code', 'six_digit_boe_number'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: false, proven: false },

  { key: 'purchase_invoice', label: 'Purchase Invoice (inward)',
    portalName: 'Inward supply invoice', rule: 'Rule 46 (counterparty)',
    direction: 'inward', storage: 'purchases', series: null,
    taxable: true, affectsTurnover: false, affectsHsn: false, affectsLiability: true,
    affectsAmendments: false,
    supportsCancellation: false, supportsAmendment: false,
    supportsAutoNumbering: false, supportsManualNumbering: true, docNum: null,
    sections: [
      { ret: 'GSTR-3B', table: '4(A)(5)', json: null },
      { ret: 'GSTR-9', table: '6B', json: null },
      { ret: 'GSTR-2B', table: 'reconciliation', json: null }
    ],
    requires: ['document_number', 'document_date', 'supplier_gstin', 'line_items'],
    masters: [], validations: ['supplier_gstin', 'itc_eligibility'],
    effectiveFrom: GST_COMMENCEMENT, effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false },

  { key: 'eway_bill', label: 'E-Way Bill', portalName: 'E-Way Bill (EWB-01)',
    rule: 'Rule 138', direction: 'outward', storage: 'eway_bills', series: null,
    taxable: false, affectsTurnover: false, affectsHsn: false, affectsLiability: false,
    affectsAmendments: false,
    supportsCancellation: true, supportsAmendment: false,
    supportsAutoNumbering: false, supportsManualNumbering: true, docNum: null,
    // Numbered by the NIC portal and reported in no return at all. It is
    // here so the registry is a complete answer to "what documents does
    // this business issue", which is what a Document Register and any
    // audit will ask.
    sections: [],
    requires: ['document_number', 'document_date', 'invoice_reference', 'transport'],
    masters: ['transporter'], validations: ['threshold_value', 'distance', 'vehicle_number'],
    effectiveFrom: '2018-04-01', effectiveTo: null, status: 'active', version: 1,
    enabled: true, proven: false }
];

const GST_DOCUMENT_TYPE_DEFAULT = 'tax_invoice';

function gstDocumentType(row) {
  const v = String(row?.document_type || '').trim().toLowerCase();
  return GST_DOCUMENT_TYPES.some(d => d.key === v) ? v : GST_DOCUMENT_TYPE_DEFAULT;
}

function gstDocumentTypeSpec(value) {
  return GST_DOCUMENT_TYPES.find(d => d.key === gstDocumentType({ document_type: value }))
    || GST_DOCUMENT_TYPES[0];
}

function gstDocumentTypeLabel(value) {
  return gstDocumentTypeSpec(value).label;
}

// Selecting by capability rather than by name, so a caller asks for what
// it actually needs and a new type joins the answer by having the field
// set. Nothing downstream lists type keys.
function gstDocumentTypesWhere(predicate) {
  return GST_DOCUMENT_TYPES.filter(predicate);
}

// ── Lifecycle ───────────────────────────────────────
// Whether a document type was in force on a given date. Compared as
// plain YYYY-MM-DD strings so no Date is built and no timezone can move
// a boundary by a day — the same rule the LUT check follows.
function gstDocumentTypeActiveOn(value, dateISO) {
  const d = gstDocumentTypeSpec(value);
  if (d.status !== 'active') return false;
  const on = String(dateISO || '').slice(0, 10);
  if (!on) return true;
  if (d.effectiveFrom && on < d.effectiveFrom) return false;
  if (d.effectiveTo && on > d.effectiveTo) return false;
  return true;
}

// ── Returns and sections ────────────────────────────
// Which returns report this document, and under which table of each. A
// return this application has not built yet is answered from the same
// data as one it has.
function gstDocumentReturns(value) {
  return [...new Set(gstDocumentTypeSpec(value).sections.map(s => s.ret))];
}

function gstDocumentSections(value, ret) {
  const s = gstDocumentTypeSpec(value).sections;
  return ret ? s.filter(x => x.ret === ret) : s;
}

// Every document type a given return reports, which is how a future
// GSTR-3B or GSTR-9 module finds its inputs without naming any of them.
function gstDocumentTypesForReturn(ret) {
  return GST_DOCUMENT_TYPES.filter(d => d.sections.some(s => s.ret === ret));
}

// ── GSTR-1 Table 13 ─────────────────────────────────
// The rows Table 13 reports, deduplicated by ordinal and carrying the
// Portal's own name for each. More than one document type can share a
// row — a Bill of Supply is reported on row 1 alongside tax invoices,
// because the table reports numbering series, not tax status.
//
// This is what the exporter writes. It never names a document type.
function gstTable13Rows() {
  const byNum = new Map();
  GST_DOCUMENT_TYPES.filter(d => d.docNum !== null)
    .sort((a, b) => a.docNum - b.docNum)
    .forEach(d => {
      if (!byNum.has(d.docNum)) byNum.set(d.docNum, { docNum: d.docNum, docTyp: d.portalName, keys: [] });
      byNum.get(d.docNum).keys.push(d.key);
    });
  return [...byNum.values()].sort((a, b) => a.docNum - b.docNum);
}

// The Table 13 row a document type is reported on.
function gstTable13RowFor(value) {
  const d = gstDocumentTypeSpec(value);
  if (d.docNum === null) return null;
  return gstTable13Rows().find(r => r.docNum === d.docNum) || null;
}

// ── Capabilities ────────────────────────────────────
// Whether a document type can be cancelled, amended, auto-numbered or
// manually numbered. Asked by capability like everything else here, so a
// future cancelled-document, amendment, import or manual-numbering
// feature reads these rather than listing type keys.
function gstDocumentSupportsCancellation(value) {
  return !!gstDocumentTypeSpec(value).supportsCancellation;
}

function gstDocumentSupportsAmendment(value) {
  return !!gstDocumentTypeSpec(value).supportsAmendment;
}

function gstDocumentSupportsAutoNumbering(value) {
  return !!gstDocumentTypeSpec(value).supportsAutoNumbering;
}

function gstDocumentSupportsManualNumbering(value) {
  return !!gstDocumentTypeSpec(value).supportsManualNumbering;
}

// How a document of this type may be numbered, as the set of ways rather
// than a flag, so a screen can offer exactly what is allowed. Every type
// supports at least one — a type that supported neither could never be
// recorded at all.
function gstDocumentNumberingModes(value) {
  const d = gstDocumentTypeSpec(value);
  return [d.supportsAutoNumbering ? 'auto' : null,
          d.supportsManualNumbering ? 'manual' : null].filter(Boolean);
}

// Whether a document type's behaviour is built here yet. A type that is
// described and reportable but not yet creatable answers false, which is
// how metadata lands ahead of the module that uses it without changing a
// single byte of what is filed today.
function gstDocumentTypeEnabled(value) {
  return !!gstDocumentTypeSpec(value).enabled;
}

// ── Product GST validation ──────────────────────────────────
// Everything that has to be true of a product before an invoice line
// using it can be reported. One definition, so the Product Master
// refuses to save what the GSTR-1 export would later refuse to file —
// rather than the two disagreeing and the problem surfacing at filing
// time, which is how five products reached the Portal with no unit.
//
// Returns { field: message }. Empty means the product is reportable.
function validateProductGst(product) {
  const p = productEffective(product) || {};
  const errors = {};
  const name = String(p.name || '').trim();
  const hsn = String(p.hsn_code || '').trim();
  const unit = String(p.unit || '').trim();
  const isService = String(p.type || 'goods') === 'service';
  const treatment = gstTreatmentOf(p);
  const rate = +p.gst_percentage;

  if (!name) errors.name = 'A product needs a name.';

  // A non-GST supply is outside GST and has no HSN obligation; every
  // other supply is reported under one.
  if (treatment !== 'non_gst') {
    if (!hsn) {
      errors.hsn_code = isService
        ? 'A service needs a SAC. Service codes begin with 99.'
        : 'Goods need an HSN code — the Portal rejects a line without one (RET191349).';
    } else if (!/^\d{4}$|^\d{6}$|^\d{8}$/.test(hsn)) {
      errors.hsn_code = `"${hsn}" is not an HSN or SAC — these are 4, 6 or 8 digits.`;
    } else if (isService && !hsn.startsWith('99')) {
      errors.hsn_code = `${hsn} is an HSN code, but this is a service. A SAC begins with 99.`;
    } else if (!isService && hsn.startsWith('99')) {
      errors.hsn_code = `${hsn} is a SAC, which is for services. Change the type to Service, or use a goods HSN.`;
    }
  }

  // The one that has been costing them: the Portal rejects a goods line
  // with no unit of measure (RET191353). Services carry NA and need none.
  if (!isService && treatment !== 'non_gst' && !unit) {
    errors.unit = 'Goods need a unit of measure — the Portal rejects a goods line without one (RET191353).';
  }
  // Checked against GST_UQC_MASTER, the Portal's own unit list already
  // in this file — not a second list that could drift from it.
  if (unit && !isService && typeof GST_UQC_MASTER !== 'undefined'
      && !GST_UQC_MASTER.some(u => u.code === unit.toUpperCase())) {
    errors.unit = `"${unit}" is not a unit quantity code the Portal recognises.`;
  }

  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    errors.gst_percentage = 'The GST rate must be between 0 and 100.';
  } else if (!gstIsTaxableTreatment(treatment) && rate > 0) {
    errors.gst_percentage = `A ${gstTreatmentLabel(treatment).toLowerCase()} supply cannot carry a rate of ${rate}%.`;
  } else if (gstIsTaxableTreatment(treatment) && typeof GST_RATE_SLABS !== 'undefined'
             && !GST_RATE_SLABS.includes(rate)) {
    errors.gst_percentage = `${rate}% is not a GST rate slab (${GST_RATE_SLABS.join(', ')}).`;
  }

  const cess = +p.cess_rate;
  if (p.cess_rate !== undefined && p.cess_rate !== null && p.cess_rate !== '' &&
      (!Number.isFinite(cess) || cess < 0 || cess > 100)) {
    errors.cess_rate = 'Compensation cess must be between 0 and 100.';
  }

  // A composite supply takes its principal supply's rate, so that rate
  // has to be recorded and has to be the one charged.
  const bundle = gstSupplyBundle(p);
  if (bundle === 'composite') {
    const principal = +p.principal_gst_rate;
    if (!Number.isFinite(principal)) {
      errors.principal_gst_rate = 'A composite supply takes the principal supply\'s rate — record which rate that is.';
    } else if (Number.isFinite(rate) && principal !== rate) {
      errors.principal_gst_rate = `A composite supply is taxed at the principal supply's rate (${principal}%), but this product charges ${rate}%.`;
    }
  }

  return errors;
}

// ── Product GST corrections that survive sync ───────────────
// The Product Master mirrors the company website, and every sync run
// rewrites name, hsn_code, unit, gst_percentage and type from the feed.
// A unit corrected here would therefore last until the next sync, which
// is why products have stayed without one long enough for the Portal to
// reject their invoice lines.
//
// Corrections live in products.gst_overrides, which sync does not write.
// Everything that reads a product for GST purposes reads it through
// productEffective(), so a correction applies everywhere at once and an
// uncorrected product is byte-for-byte the row sync wrote.
const PRODUCT_GST_OVERRIDABLE = ['unit', 'hsn_code', 'gst_percentage', 'type'];

function productEffective(product) {
  if (!product) return product;
  const ov = product.gst_overrides;
  if (!ov || typeof ov !== 'object') return product;
  const out = { ...product };
  PRODUCT_GST_OVERRIDABLE.forEach(f => {
    // Presence is the test, not truthiness: '' is a legitimate
    // correction meaning "this really has no unit".
    if (Object.prototype.hasOwnProperty.call(ov, f)) out[f] = ov[f];
  });
  return out;
}

// Which fields on this product are a correction rather than the synced
// value. Shown on screen so it is never a mystery why a product differs
// from the website.
function productOverriddenFields(product) {
  const ov = product?.gst_overrides;
  if (!ov || typeof ov !== 'object') return [];
  return PRODUCT_GST_OVERRIDABLE.filter(f => Object.prototype.hasOwnProperty.call(ov, f));
}

// ── Composite and mixed supply ──────────────────────────────
// Two ways of bundling supplies, with two different rate rules:
//
//   composite  naturally bundled and supplied together in the ordinary
//              course of business, one of them principal. The bundle
//              takes the PRINCIPAL supply's rate.
//   mixed      two or more supplies for a single price, not naturally
//              bundled. The bundle takes the HIGHEST rate of any
//              component.
//
// Recorded so a bundle's rate can be checked against its rule instead of
// taken on trust.
const GST_SUPPLY_BUNDLES = [
  { value: 'none',      label: 'Single supply',    note: 'An ordinary supply — its own rate applies.' },
  { value: 'composite', label: 'Composite supply', note: 'Naturally bundled — the rate is the principal supply\'s rate.' },
  { value: 'mixed',     label: 'Mixed supply',     note: 'Not naturally bundled — the rate is the HIGHEST rate of any component.' }
];

function gstSupplyBundle(product) {
  const v = String(product?.supply_bundle || '').trim().toLowerCase();
  return GST_SUPPLY_BUNDLES.some(b => b.value === v) ? v : 'none';
}

function gstSupplyBundleLabel(value) {
  const b = GST_SUPPLY_BUNDLES.find(x => x.value === gstSupplyBundle({ supply_bundle: value }));
  return b ? b.label : value;
}

// ── GST treatment of a supply ───────────────────────────────
// Whether a supply is taxable at all, and if not, in which of three
// distinct ways. GSTR-1 table 8 keeps them in separate columns, so they
// are three values rather than one "not taxable" flag:
//
//   nil_rated  taxable in principle but at a 0% rate
//   exempt     exempt by notification, or wholly exempt
//   non_gst    outside GST altogether — alcohol for human consumption,
//              petroleum products not yet brought under GST
//
// 'taxable' is the default and is what every product and every invoice
// line created before this existed is.
const GST_TREATMENTS = [
  { value: 'taxable',   label: 'Taxable',    field: null,          note: 'Reported in 4A / 5 / 7 with tax' },
  { value: 'nil_rated', label: 'Nil Rated',  field: 'nil_amt',     note: 'Reported in table 8, not as a taxable supply' },
  { value: 'exempt',    label: 'Exempt',     field: 'expt_amt',    note: 'Reported in table 8, not as a taxable supply' },
  { value: 'non_gst',   label: 'Non-GST',    field: 'ngsup_amt',   note: 'Outside GST — reported in table 8' }
];

const GST_TREATMENT_DEFAULT = 'taxable';

function gstTreatmentOf(row) {
  const v = String(row?.gst_treatment || '').trim().toLowerCase();
  return GST_TREATMENTS.some(t => t.value === v) ? v : GST_TREATMENT_DEFAULT;
}

function gstTreatmentLabel(value) {
  const t = GST_TREATMENTS.find(x => x.value === gstTreatmentOf({ gst_treatment: value }));
  return t ? t.label : value;
}

function gstTreatmentSpec(value) {
  return GST_TREATMENTS.find(x => x.value === gstTreatmentOf({ gst_treatment: value })) || GST_TREATMENTS[0];
}

// Nil-rated, exempt and non-GST supplies do not belong in the taxable
// tables at all — reporting them there as a 0% taxable supply puts the
// right money in the wrong table.
function gstIsTaxableTreatment(value) {
  return gstTreatmentOf({ gst_treatment: value }) === GST_TREATMENT_DEFAULT;
}

// ── Customer GST category ───────────────────────────────────
// What kind of recipient a supply is made to. This is the single thing
// that decides which GSTR-1 table an invoice lands in, so it is defined
// once here and read by the customer master, the invoice form and the
// exporter alike.
//
// 'regular' is the default and is what every customer and every invoice
// created before this existed is — they have been reported in table 4A
// as inv_typ 'R', and they continue to be.
//
// `table` below is the GSTR-1 table each category feeds. `registered`
// says whether a GSTIN is required, which is what separates the B2B
// tables from the B2C ones.
const GST_CUSTOMER_CATEGORIES = [
  { value: 'regular',       label: 'Registered — Regular',        table: '4A', registered: true  },
  { value: 'composition',   label: 'Registered — Composition',    table: '4A', registered: true  },
  { value: 'government',    label: 'Government Department / PSU',  table: '4A', registered: true  },
  { value: 'uin',           label: 'UIN Holder — Embassy / UN',    table: '4A', registered: true  },
  { value: 'sez_unit',      label: 'SEZ Unit',                     table: '4B', registered: true  },
  { value: 'sez_developer', label: 'SEZ Developer',                table: '4B', registered: true  },
  { value: 'deemed_export', label: 'Deemed Export',                table: '6C', registered: true  },
  { value: 'export',        label: 'Export (overseas)',            table: '6A', registered: false },
  { value: 'unregistered',  label: 'Unregistered Business',        table: '5 / 7', registered: false },
  { value: 'consumer',      label: 'Consumer (B2C)',               table: '5 / 7', registered: false }
];

const GST_CUSTOMER_CATEGORY_DEFAULT = 'regular';

function gstCustomerCategory(row) {
  const v = String(row?.gst_category || '').trim().toLowerCase();
  return GST_CUSTOMER_CATEGORIES.some(c => c.value === v) ? v : GST_CUSTOMER_CATEGORY_DEFAULT;
}

function gstCustomerCategoryLabel(value) {
  const c = GST_CUSTOMER_CATEGORIES.find(x => x.value === gstCustomerCategory({ gst_category: value }));
  return c ? c.label : value;
}

function gstCustomerCategorySpec(value) {
  return GST_CUSTOMER_CATEGORIES.find(x => x.value === gstCustomerCategory({ gst_category: value }))
    || GST_CUSTOMER_CATEGORIES[0];
}

// Supplies to an SEZ are inter-state supplies by law regardless of where
// the SEZ physically sits — section 7(5)(b) of the IGST Act. A supply to
// an SEZ unit in the same state as the supplier still attracts IGST, not
// CGST+SGST. Worth its own function because the ordinary
// same-state-means-intrastate rule gives the wrong answer here.
function gstIsSezCategory(value) {
  const v = gstCustomerCategory({ gst_category: value });
  return v === 'sez_unit' || v === 'sez_developer';
}

// The inv_typ a B2B-table invoice carries.
//
//   R      regular registered supply
//   SEWP   SEZ supply made WITH payment of IGST
//   SEWOP  SEZ supply made WITHOUT payment of IGST (under an LUT)
//   DE     deemed export
//
// For SEZ the choice between SEWP and SEWOP is taken from the invoice's
// own tax, not from a setting: an invoice that charged IGST was made with
// payment, one that charged nothing was made without. That cannot
// disagree with the figures being filed alongside it, which a stored
// preference could.
function gstr1InvTypFor(category, taxCharged) {
  const v = gstCustomerCategory({ gst_category: category });
  if (v === 'deemed_export') return 'DE';
  if (gstIsSezCategory(v)) return (+taxCharged || 0) > 0 ? 'SEWP' : 'SEWOP';
  return 'R';
}

// ── Invoice series ──────────────────────────────────────────
// Which numbering book an invoice came out of: the shop counter issuing
// 138, 139, 140 while the website issues W-00004, W-00005. Both are
// outward supplies in the same return, each with its own numbering, and
// GSTR-1 reports each book's document range separately.
//
// A blank or missing value is the shop series — that is what every
// invoice saved before this field existed was, and what the database
// column defaults to.
//
// Kept here rather than in any one page's script because the Invoice
// List, the invoice form, and the Series Migration tool all have to name
// the same series the same way. A series with no label of its own shows
// under its own name, so a channel added later is readable immediately.
const INVOICE_SOURCE_DEFAULT = 'offline';
const INVOICE_SOURCE_LABELS = {
  offline: 'Offline / Shop',
  online:  'Online / Website'
};

// ── Per-series number formats ───────────────────────────────
// Each book is written its own way as well as counted its own way: the
// shop issuing 171, 172, 173 while the website issues W-00001, W-00002
// and a marketplace issues A-00001.
//
// "online" is spelled out below rather than derived because no rule
// could get there: the W is for Website. Every other series falls back
// to its own first letter — amazon -> A-#####, flipkart -> F-#####,
// pos -> P-##### — which is a starting point, not a decision. Settings
// can change any of them, and whatever is stored always wins.
//
// The twin of this lives in server/utils/invoiceNumberFormat.js, which
// hands out the number that actually gets saved. This copy only draws
// the preview, and a preview that disagreed with what gets saved would
// be worse than no preview — so the two are tested against each other.
const INVOICE_SERIES_DEFAULT_FORMATS = { online: 'W-#####' };

function defaultInvoiceSeriesFormat(series) {
  const s = String(series || '').trim().toLowerCase();
  if (INVOICE_SERIES_DEFAULT_FORMATS[s]) return INVOICE_SERIES_DEFAULT_FORMATS[s];
  const initial = (s.match(/[a-z0-9]/) || [''])[0].toUpperCase();
  return initial ? `${initial}-#####` : 'INV-###';
}

// The offline series reads invoice_number_format, the column that
// existed before series did and is already every current business's only
// format — so a shop that has been issuing 138, 139, 140 keeps issuing
// 141 rather than being moved onto something new.
function invoiceSeriesFormat(profile, series) {
  const s = String(series || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  if (s === INVOICE_SOURCE_DEFAULT) return profile?.invoice_number_format || 'INV-###';
  const stored = profile?.invoice_series_formats?.[s];
  return (stored && String(stored).trim()) || defaultInvoiceSeriesFormat(s);
}

// The counter a series is up to, from the same split: offline on the
// original column, everything else in the per-series map.
function invoiceSeriesSequence(profile, series) {
  const s = String(series || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  const raw = s === INVOICE_SOURCE_DEFAULT
    ? profile?.invoice_current_sequence
    : profile?.invoice_series_sequences?.[s];
  return Math.max(1, parseInt(raw, 10) || 1);
}

// Every series the business actually numbers invoices in: the ones this
// app ships with, plus any that has a format or a counter of its own.
function knownInvoiceSeries(profile) {
  return [...new Set([
    ...Object.keys(INVOICE_SOURCE_LABELS),
    ...Object.keys(profile?.invoice_series_formats || {}),
    ...Object.keys(profile?.invoice_series_sequences || {})
  ])].map(s => String(s).trim().toLowerCase()).filter(Boolean).sort();
}

function invoiceSourceOf(row) {
  return String((row && row.invoice_source) || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
}

function invoiceSourceLabel(source) {
  const s = String(source || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  return INVOICE_SOURCE_LABELS[s] || s;
}

// Never green or blue: those already mean B2C and B2B in the Type column
// beside it. An unnamed series gets its own colour too rather than
// borrowing the shop's, so it does not read as one.
function invoiceSourceBadgeClass(source) {
  const s = String(source || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  if (s === 'offline') return 'badge-grey';
  if (s === 'online') return 'badge-purple';
  return 'badge-orange';
}

function invoiceSourceCellHtml(source) {
  const s = String(source || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  return `<span class="badge ${invoiceSourceBadgeClass(s)}">${escItemHtml(invoiceSourceLabel(s))}</span>`;
}

// Orders invoice numbers the way a numbering series runs rather than the
// way text sorts. Plain string comparison puts "142" after "1419" and,
// once a prefix is involved, scatters a sequence entirely. Each number is
// split into digit and non-digit runs and compared run by run, digits as
// numbers: 138 < 139 < 142 < 149 for bare numbers, "00193/26-27" after
// "00158/26-27" rather than before "0021/26-27", and prefixed formats
// like INV-2026-00124 stay in sequence — without assuming either shape.
//
// The single definition of that ordering. It existed twice, byte for
// byte, in js/invoice-list.js and js/gstr1-export.js: one sorting the
// on-screen list, one deciding the from/to range of a GSTR-1 series.
// Changing either alone would have let the list and the filing disagree
// about which invoice is first.
function compareInvoiceNumbers(a, b) {
  const chunks = v => String(v ?? '').match(/\d+|\D+/g) || [];
  const A = chunks(a), B = chunks(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1;      // shorter run sorts first
    if (y === undefined) return 1;
    const bothNumeric = /^\d/.test(x) && /^\d/.test(y);
    const d = bothNumeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return d;
  }
  return 0;
}

// One line's taxable value: quantity × rate, less its discount, rounded
// to paise. The single definition of that arithmetic.
//
// It was written out at eight places — three paths each in
// js/invoice-items.js and js/purchase-items.js, one in
// js/sales-return-items.js, and one in js/gstr1-export.js where the
// export re-derives it to check a stored value has not drifted. Editing
// any one of them alone would have made invoices and their own GSTR-1
// validation disagree about the same line.
//
// The multiplication happens before rounding, exactly as every copy did:
// rounding the gross first would change the result on lines where a
// discount lands on a half-paisa.
function lineTaxableValue(qty, rate, discountPct) {
  const gross = (+qty || 0) * (+rate || 0);
  return round2(gross * (1 - (+discountPct || 0) / 100));
}

function calcGST(taxableAmount, gstPct, supplyType) {
  const gstAmt = (taxableAmount * gstPct) / 100;
  let igst = 0, cgst = 0, sgst = 0;
  if (supplyType === 'interstate') {
    igst = gstAmt;
  } else {
    cgst = gstAmt / 2;
    sgst = gstAmt / 2;
  }
  return {
    gstAmount: round2(gstAmt),
    igst: round2(igst),
    cgst: round2(cgst),
    sgst: round2(sgst),
    totalGst: round2(gstAmt),
    totalAmount: round2(taxableAmount + gstAmt)
  };
}

// Single source of truth for every 2-decimal money/GST rounding in the
// app. The naive `Math.round(n * 100) / 100` is a well-known JS trap:
// binary floating point can't represent most decimals exactly, so a
// value like 1.005 is actually stored as ~1.00499999999999989 — meaning
// `1.005 * 100` evaluates to 100.49999999999999, and Math.round wrongly
// floors it to 1.00 instead of 1.01. This silently under-rounds roughly
// half of all values ending in an exact half-paisa (confirmed with a
// 2-million-value randomized sweep during the GSTR-1 production audit —
// see js/gstr1-export.js). Reformatting through exponential notation
// (`n + 'e2'`) instead of multiplying sidesteps the problem entirely:
// the string "1.005e2" parses directly to the nearest double for 100.5,
// which — unlike 1.005 — IS exactly representable in binary, so no
// compounding error survives into the round step.
function round2(n) {
  n = parseFloat(n) || 0;
  if (!isFinite(n)) return 0;
  return Number(Math.round(Number(n + 'e2')) + 'e-2');
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(n || 0);
}

function formatNum(n) {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Local calendar date as YYYY-MM-DD. Deliberately NOT d.toISOString() —
// that converts to UTC first, which silently rolls the date (or even
// the month) backward by one for any timezone ahead of UTC (e.g. IST)
// whenever d was built from local parts like new Date(y, m, 1) at local
// midnight. Every caller here wants "the calendar date this Date
// represents", not a UTC instant.
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthYearOptions() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push({
      label: d.toLocaleString('default', { month: 'long', year: 'numeric' }),
      value: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    });
  }
  return opts;
}

function showToast(msg, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const colors = { success: '#00796b', error: '#d32f2f', warning: '#f57c00', info: '#1565c0' };
  toast.style.cssText = `background:${colors[type]||colors.success};color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.2);min-width:250px;display:flex;align-items:center;gap:10px;animation:slideIn 0.3s ease;`;
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
  toast.innerHTML = `<i class="fas ${icons[type]||icons.success}"></i><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100px)'; toast.style.transition = 'all 0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function showConfirm(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <i class="fas fa-exclamation-triangle" style="color:#f57c00;font-size:22px;"></i>
          <h3 style="margin:0;color:#333;font-size:17px;">Confirm Action</h3>
        </div>
        <p style="margin:0 0 24px;color:#666;font-size:14px;">${msg}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="confirmNo" style="padding:8px 20px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">Cancel</button>
          <button id="confirmYes" style="padding:8px 20px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirmYes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirmNo').onclick  = () => { overlay.remove(); resolve(false); };
  });
}

// Same shape as showConfirm, but for neutral Yes/No questions (not
// destructive actions) — no red "Delete" button, a primary-colored "Yes".
function showYesNo(msg, title) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <i class="fas fa-question-circle" style="color:#00796b;font-size:22px;"></i>
          <h3 style="margin:0;color:#333;font-size:17px;">${title || 'Confirm'}</h3>
        </div>
        <p style="margin:0 0 24px;color:#666;font-size:14px;">${msg}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="yesNoNo" style="padding:8px 20px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">No</button>
          <button id="yesNoYes" style="padding:8px 20px;background:#00796b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Yes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#yesNoYes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#yesNoNo').onclick  = () => { overlay.remove(); resolve(false); };
  });
}

// ── Background scroll lock while a modal is open ──
// Call lockBodyScroll() right after showing a modal, and
// unlockBodyScrollIfNoModalsOpen() on every path that closes one — it
// only actually restores scrolling once no modal is left open, so
// chained close+reopen calls (e.g. Settings → Business Profile) never
// flicker the page scrollbar on and off.
function lockBodyScroll() {
  document.body.style.overflow = 'hidden';
}

function unlockBodyScrollIfNoModalsOpen() {
  const anyOpen = document.getElementById('profileModalWrap')
    || document.getElementById('settingsModalWrap')
    || document.querySelector('.modal-overlay.open');
  if (!anyOpen) document.body.style.overflow = '';
}

// ── Sidebar scroll-position stability ──────────────────────────────
// This is a traditional multi-page app — every nav click is a full page
// load — and .sidebar itself is the scrollable container (overflow-y:
// auto, position:fixed, spanning brand+menu+user footer as one box; see
// css/style.css). Once the sidebar grew past what fits in typical
// viewport heights, it started visibly "jumping" on every load: browsers
// apply CSS Scroll Anchoring to any overflowing box by default, and
// small async layout shifts (e.g. the user's name populating into
// #navUserName after the profile fetch resolves) were enough to trigger
// it. Two independent fixes, neither touching sidebar HTML/CSS:
//   1. overflowAnchor is turned off on the container itself, so the
//      browser never auto-adjusts its scroll position on its own.
//   2. The user's own last scroll position is restored from
//      sessionStorage (never just reset to 0), and the active menu item
//      is nudged into view — smallest possible adjustment, block:
//      'nearest' — ONLY if it isn't already fully visible. If it's
//      already visible, nothing happens at all.
(function setupSidebarScrollStability() {
  const STORAGE_KEY = 'gst_sidebar_scroll_top';

  function reconcile() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    sidebar.style.overflowAnchor = 'none';

    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const savedTop = parseFloat(saved);
      if (!isNaN(savedTop)) sidebar.scrollTop = savedTop;
    }

    const active = sidebar.querySelector('.menu-item.active');
    if (active) {
      const sidebarRect = sidebar.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const alreadyVisible = activeRect.top >= sidebarRect.top && activeRect.bottom <= sidebarRect.bottom;
      if (!alreadyVisible) {
        active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    sidebar.addEventListener('scroll', () => {
      sessionStorage.setItem(STORAGE_KEY, String(sidebar.scrollTop));
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reconcile);
  } else {
    reconcile();
  }
})();

// Shared by js/invoice-items.js and js/purchase-items.js — both render
// product names/SKU/HSN into inline HTML (dropdown options, table cells).
function escItemHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// Shared by js/invoice-items.js and js/purchase-items.js's Quick Add
// Product modal unit datalist.
const COMMON_UNITS = ['PCS','NOS','KG','LTR','MTR','BOX','SET','PAIR','DOZ','BAG','BTL','HRS'];

function setupMobileMenu() {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target) && !toggle.contains(e.target)) sidebar.classList.remove('open');
    });
  }
}

// ── GST Verification — fully offline, no external API/scrape ──────
// Structural + checksum validation only. "Verify on GST Portal" (below)
// hands the actual authoritative lookup to the taxpayer manually on the
// real government site — this never claims to confirm a GSTIN is real,
// only that it's well-formed. Shared by Invoice Entry (customer GSTIN)
// and Vendor Master (vendor GSTIN) so both use the exact same validator.
function isValidGstinFormat(value) {
  return value.length === 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(value);
}

const GST_VALID_STATE_CODES = new Set([
  '01','02','03','04','05','06','07','08','09','10',
  '11','12','13','14','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30',
  '31','32','33','34','35','36','37','38'
]);
const PAN_FORMAT_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Standard GSTIN check-digit algorithm (mod-36, processed right to left
// over the first 14 characters, alternating multiplier 2/1) — verified
// against several real-format GSTINs before shipping.
function gstinCheckDigit(first14) {
  const mod = GSTIN_ALPHABET.length;
  let factor = 2, sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    const codePoint = GSTIN_ALPHABET.indexOf(first14[i]);
    let digit = factor * codePoint;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
    factor = factor === 2 ? 1 : 2;
  }
  return GSTIN_ALPHABET[(mod - (sum % mod)) % mod];
}

// Runs every offline check the spec asks for — length, structural
// format, state code, embedded PAN format, checksum — and returns which
// one first failed, so callers can show a specific reason if they want
// (the status UI itself just shows a single valid/invalid indicator).
function validateGstin(value) {
  const v = (value || '').trim().toUpperCase();
  if (!v) return { valid: false, reason: 'empty' };
  if (v.length !== 15) return { valid: false, reason: 'length' };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return { valid: false, reason: 'format' };
  if (!GST_VALID_STATE_CODES.has(v.slice(0, 2))) return { valid: false, reason: 'state_code' };
  if (!PAN_FORMAT_REGEX.test(v.slice(2, 12))) return { valid: false, reason: 'pan' };
  if (gstinCheckDigit(v.slice(0, 14)) !== v[14]) return { valid: false, reason: 'checksum' };
  return { valid: true };
}

// Opens the official public GST Portal taxpayer-search page for the
// user to manually verify the GSTIN themselves — a plain new tab, never
// an iframe, never pre-filled/auto-submitted, never scraped. This app
// has no relationship with and does not automate anything on that site.
function openGstPortalVerify() {
  window.open('https://services.gst.gov.in/services/searchtp', '_blank', 'noopener,noreferrer');
}

// Shared 🟢/🔴 status renderer — writes into any element id given a raw
// GSTIN field value. Used by both Invoice Entry (#invGstinStatus) and
// Vendor Master (#vendorGstinStatus) so the markup/behavior stays
// identical everywhere a GSTIN is verified.
function renderGstinStatusInto(elId, value) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!value) {
    el.classList.add('d-none');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('d-none');
  const result = validateGstin(value);
  el.innerHTML = result.valid
    ? '<span class="fw-600" style="color:var(--success);">🟢 Valid GST Format</span>' +
      '<button type="button" class="btn btn-secondary btn-sm" onclick="openGstPortalVerify()"><i class="fas fa-external-link-alt"></i> Verify on GST Portal</button>'
    : '<span class="fw-600" style="color:var(--danger);">🔴 Invalid GST Number</span>';
}

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa',
  'Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala',
  'Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland',
  'Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura',
  'Uttar Pradesh','Uttarakhand','West Bengal','Andaman and Nicobar Islands',
  'Chandigarh','Dadra and Nagar Haveli and Daman and Diu','Delhi',
  'Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry'
];

// Two-letter state codes, for compact display only — the full state name
// stays the stored value everywhere (it is the GST place of supply and
// drives the intrastate/interstate split). Keyed off INDIAN_STATES above
// so the two can't drift; getStateCode() in js/gstr1-export.js maps the
// same states to their NUMERIC GST codes for the filing export, which is
// a different thing and stays where it is.
const GST_STATE_SHORT_CODES = {
  'Andhra Pradesh':'AP','Arunachal Pradesh':'AR','Assam':'AS','Bihar':'BR',
  'Chhattisgarh':'CG','Goa':'GA','Gujarat':'GJ','Haryana':'HR',
  'Himachal Pradesh':'HP','Jharkhand':'JH','Karnataka':'KA','Kerala':'KL',
  'Madhya Pradesh':'MP','Maharashtra':'MH','Manipur':'MN','Meghalaya':'ML',
  'Mizoram':'MZ','Nagaland':'NL','Odisha':'OD','Punjab':'PB','Rajasthan':'RJ',
  'Sikkim':'SK','Tamil Nadu':'TN','Telangana':'TS','Tripura':'TR',
  'Uttar Pradesh':'UP','Uttarakhand':'UK','West Bengal':'WB',
  'Andaman and Nicobar Islands':'AN','Chandigarh':'CH',
  'Dadra and Nagar Haveli and Daman and Diu':'DH','Delhi':'DL',
  'Jammu and Kashmir':'JK','Ladakh':'LA','Lakshadweep':'LD','Puducherry':'PY'
};

// Lookup is case- and punctuation-tolerant: records saved before the
// State dropdown existed can hold free text like "TAMILNADU" or
// "Jammu & Kashmir", and those should still show their code rather than
// falling through to the unknown marker.
const _STATE_CODE_LOOKUP = (() => {
  const norm = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  const map = {};
  Object.entries(GST_STATE_SHORT_CODES).forEach(([name, code]) => { map[norm(name)] = code; });
  return { norm, map };
})();

// 'Tamil Nadu' -> 'TN'. Returns '' for a blank/unrecognised state so
// callers can decide how to render the gap.
function stateShortCode(stateName) {
  if (!stateName) return '';
  return _STATE_CODE_LOOKUP.map[_STATE_CODE_LOOKUP.norm(stateName)] || '';
}

// Table cell contents for a state: the short code, with the full name as
// a tooltip so the column stays narrow without losing information. An
// unknown/blank state renders as a muted dash rather than an empty cell,
// so the column still lines up and reads as "not recorded".
function stateCellHtml(stateName) {
  const code = stateShortCode(stateName);
  if (!code) return '<span class="text-muted-sm" title="No state recorded">&mdash;</span>';
  return `<span title="${escHtmlAttr(stateName)}">${code}</span>`;
}

function escHtmlAttr(v) {
  return (v || '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Builds the <option> list for a "All States" filter from records ALREADY
// in memory — deliberately not a query. Only states present in the loaded
// rows appear, de-duplicated and sorted by their full name. `getState` is
// how to read the state off one record, so invoices (customer state) and
// purchases (vendor state / place of supply) can share this.
function buildStateFilterOptions(records, getState, selected) {
  const names = [...new Set((records || []).map(getState).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return '<option value="">All States</option>' + names.map(n => {
    const code = stateShortCode(n);
    const label = code ? `${code} — ${n}` : n;
    return `<option value="${escHtmlAttr(n)}"${n === selected ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

// GST's official UQC (Unit Quantity Code) master — reconstructed from the
// documented GSTN/offline-utility UQC list (the same source already used
// for js/gstr1-export.js's UQC handling) — worth re-confirming against
// the live GST Portal dropdown if it's ever revised. Shared source of
// truth for every "pick a unit" control in the app, so a code entered on
// an invoice line is always one GSTN actually recognizes.
const GST_UQC_MASTER = [
  { code: 'BAG', label: 'BAGS' }, { code: 'BAL', label: 'BALE' }, { code: 'BDL', label: 'BUNDLES' },
  { code: 'BKL', label: 'BUCKLES' }, { code: 'BOU', label: 'BILLIONS OF UNITS' }, { code: 'BOX', label: 'BOX' },
  { code: 'BTL', label: 'BOTTLES' }, { code: 'BUN', label: 'BUNCHES' }, { code: 'CAN', label: 'CANS' },
  { code: 'CBM', label: 'CUBIC METERS' }, { code: 'CCM', label: 'CUBIC CENTIMETERS' }, { code: 'CMS', label: 'CENTIMETERS' },
  { code: 'CTN', label: 'CARTONS' }, { code: 'DOZ', label: 'DOZENS' }, { code: 'DRM', label: 'DRUMS' },
  { code: 'GGK', label: 'GREAT GROSS' }, { code: 'GMS', label: 'GRAMMES' }, { code: 'GRS', label: 'GROSS' },
  { code: 'GYD', label: 'GROSS YARDS' }, { code: 'KGS', label: 'KILOGRAMS' }, { code: 'KLR', label: 'KILOLITRE' },
  { code: 'KME', label: 'KILOMETRE' }, { code: 'MLT', label: 'MILILITRE' }, { code: 'MTR', label: 'METERS' },
  { code: 'MTS', label: 'METRIC TON' }, { code: 'NOS', label: 'NUMBERS' }, { code: 'PAC', label: 'PACKS' },
  { code: 'PCS', label: 'PIECES' }, { code: 'PRS', label: 'PAIRS' }, { code: 'QTL', label: 'QUINTAL' },
  { code: 'ROL', label: 'ROLLS' }, { code: 'SET', label: 'SETS' }, { code: 'SQF', label: 'SQUARE FEET' },
  { code: 'SQM', label: 'SQUARE METERS' }, { code: 'SQY', label: 'SQUARE YARDS' }, { code: 'TBS', label: 'TABLETS' },
  { code: 'TGM', label: 'TEN GROSS' }, { code: 'THD', label: 'THOUSANDS' }, { code: 'TON', label: 'TONNES' },
  { code: 'TUB', label: 'TUBES' }, { code: 'UGS', label: 'US GALLONS' }, { code: 'UNT', label: 'UNITS' },
  { code: 'YDS', label: 'YARDS' }, { code: 'OTH', label: 'OTHERS' }
];

// GST's fixed rate slabs (nil/0.1%/0.25% cover gems & precious stones,
// 1%/1.5%/3% cover unpolished/polished stones and precious metals,
// 5/12/18/28% are the standard goods & services slabs). Any invoice
// line's GST % must be one of these — never free-typed.
const GST_RATE_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28];

function isValidHsnFormat(hsn) {
  // GSTN accepts 4/6/8-digit HSN codes (which tier applies depends on
  // the filer's aggregate turnover, not tracked here) — this checks the
  // code is *a* valid HSN shape.
  return /^(\d{4}|\d{6}|\d{8})$/.test((hsn || '').trim());
}

// Mandatory-HSN check for products created by hand (the Quick Add Product
// dialogs, which save with source 'local'). Builds on isValidHsnFormat()
// above rather than restating the pattern, so the accepted shape is
// defined in exactly one place. Returns '' when acceptable, otherwise the
// message to display.
//
// Deliberately NOT applied to catalog products from Product Sync
// (source 'synced'): those legitimately arrive without an HSN and must
// keep importing. The backend draws the same line — see
// validateProductPayload() in server/utils/validation.js.
function hsnMandatoryError(hsn) {
  const trimmed = (hsn || '').trim();
  if (!trimmed) return 'HSN Code is mandatory.';
  return isValidHsnFormat(trimmed) ? '' : 'HSN Code must be 4, 6 or 8 digits.';
}

// ── Number to words (Indian numbering: lakh/crore) ──
function numberToWordsINR(n) {
  const num = Math.round(Math.abs(+n || 0));
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

  function twoDigits(v) {
    if (v < 20) return ones[v];
    return tens[Math.floor(v / 10)] + (v % 10 ? ' ' + ones[v % 10] : '');
  }
  function threeDigits(v) {
    if (v < 100) return twoDigits(v);
    return ones[Math.floor(v / 100)] + ' Hundred' + (v % 100 ? ' and ' + twoDigits(v % 100) : '');
  }

  if (num === 0) return 'Zero Rupees Only';

  const crore = Math.floor(num / 10000000);
  const lakh  = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred   = num % 1000;

  const parts = [];
  if (crore)    parts.push(threeDigits(crore) + ' Crore');
  if (lakh)     parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (hundred)  parts.push(threeDigits(hundred));

  return parts.join(' ') + ' Rupees Only';
}

// ── Statistic card amounts: shrink-to-fit ────────────
// CSS handles how the amounts respond to SCREEN size (see .stat-value's
// clamp() in css/style.css). It cannot respond to VALUE LENGTH — a
// stylesheet has no way to know the box holds ₹1,23,45,67,890.00 rather
// than ₹8,500.00, and a card wide enough for one is not wide enough for
// the other.
//
// This closes that gap: after the amount is on the page, if it would
// overflow its card the font is reduced until it fits, and no further.
// A value that already fits is never touched, so short amounts keep the
// full size. Generic by design — every .stat-value on every page is
// handled, nothing is special-cased.
const STAT_VALUE_MIN_PX = 10;

function fitStatValue(el) {
  el.style.fontSize = '';                        // back to the CSS baseline
  // Nothing measurable yet (hidden tab, display:none) — leave it alone
  // rather than compute a size from a zero-width box.
  if (!el.clientWidth) return;
  if (el.scrollWidth <= el.clientWidth) return;  // already fits: don't shrink

  const max = parseFloat(getComputedStyle(el).fontSize) || 18;
  if (max <= STAT_VALUE_MIN_PX) return;

  // Binary search for the largest size that fits. Eight passes narrow an
  // 8px range to under 0.05px, which is well past what a screen can
  // show, and costs a fixed number of reflows rather than one per step.
  let lo = STAT_VALUE_MIN_PX, hi = max, best = STAT_VALUE_MIN_PX;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (el.scrollWidth <= el.clientWidth) { best = mid; lo = mid; } else { hi = mid; }
  }

  // Round DOWN. Rounding to the nearest 1/100th could round up past the
  // size that was measured as fitting, which left the text one pixel
  // wider than its box — the exact failure this function exists to
  // prevent.
  el.style.fontSize = (Math.floor(best * 100) / 100) + 'px';

  // Verify rather than trust: sub-pixel text metrics and the browser's
  // own rounding can still leave a hair of overhang. Step down until it
  // genuinely fits, or until the floor says stop.
  let size = parseFloat(el.style.fontSize);
  while (size > STAT_VALUE_MIN_PX && el.scrollWidth > el.clientWidth) {
    size = Math.max(STAT_VALUE_MIN_PX, size - 0.25);
    el.style.fontSize = size + 'px';
  }
}

function fitStatValues(root) {
  (root || document).querySelectorAll('.stat-value').forEach(fitStatValue);
}

// Wires itself up: refits when the page loads, when it is resized, and
// whenever a card's text changes (the amounts arrive from an async
// fetch, long after DOMContentLoaded). Deliberately observes only the
// stat values and only childList/characterData — NOT attributes, since
// the fit sets style.fontSize and watching attributes would make it
// retrigger itself forever.
(function autoFitStatValues() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

  let pending = null;
  const schedule = () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => { pending = null; fitStatValues(); });
  };

  document.addEventListener('DOMContentLoaded', () => {
    const values = document.querySelectorAll('.stat-value');
    if (!values.length) return;                  // not a page with stat cards
    schedule();
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    values.forEach(el => observer.observe(el, { childList: true, characterData: true, subtree: true }));
  });
})();

// ── Returning to a list after an edit ────────────────
// Invoice List stashes where the user was (page, search, filters, sort,
// scroll, the row they clicked) before handing off to the editor, and
// picks it up again when the editor sends them back. Both pages need
// the same key, and this file is the only one both of them load.
//
// sessionStorage rather than the URL: it is per-tab, dies with the tab,
// and keeps a long filter set out of a shareable link. Reading it is
// destructive — see takeListReturnState — so a restore happens exactly
// once and a later Back or refresh shows the list normally.
const INVOICE_LIST_RETURN_KEY = 'gst_invoice_list_return';

function setListReturnState(key, patch) {
  try {
    const current = JSON.parse(sessionStorage.getItem(key) || '{}');
    sessionStorage.setItem(key, JSON.stringify({ ...current, ...patch }));
  } catch { /* private mode / quota — navigation still works, just unrestored */ }
}

function peekListReturnState(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}

// Read-and-clear: one restore per hand-off.
function takeListReturnState(key) {
  const state = peekListReturnState(key);
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  return state;
}
