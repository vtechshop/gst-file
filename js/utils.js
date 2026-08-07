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
