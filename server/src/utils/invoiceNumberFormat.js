// Server-side port of js/utils.js's applyInvoiceNumberFormat() and
// invoiceSeriesFormat() — kept in sync intentionally (same logic, two
// runtimes): the frontend copy drives the non-committing
// Settings/Invoice-Entry PREVIEW, this copy drives the AUTHORITATIVE
// number handed out by POST /api/invoices/reserve-number
// (routes/invoices.js), which is the only place a number actually gets
// reserved and persisted. A preview that disagreed with what gets saved
// would be worse than no preview, so the two are tested against each
// other rather than merely written to match.
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

// The default format for a series nobody has configured yet.
//
// "online" is spelled out rather than derived because no rule could get
// there: the W is for Website. Every other series falls back to its own
// first letter — amazon -> A-#####, flipkart -> F-#####, pos -> P-#####
// — which is a starting point, not a decision: Settings can change any
// of them, and whatever is stored always wins over this.
const INVOICE_SERIES_DEFAULT_FORMATS = { online: 'W-#####' };

function defaultInvoiceSeriesFormat(series) {
  const s = String(series || '').trim().toLowerCase();
  if (INVOICE_SERIES_DEFAULT_FORMATS[s]) return INVOICE_SERIES_DEFAULT_FORMATS[s];
  const initial = (s.match(/[a-z0-9]/) || [''])[0].toUpperCase();
  return initial ? `${initial}-#####` : 'INV-###';
}

// Which format a given series numbers its invoices with.
//
// The offline series reads invoice_number_format, the column that
// existed before series did and is already every current business's only
// format — so a shop that has been issuing 138, 139, 140 keeps issuing
// 141 and is not moved onto anything new. Every other series reads
// invoice_series_formats, falling back to the default above.
const INVOICE_SOURCE_DEFAULT = 'offline';

function invoiceSeriesFormat(profile, series) {
  const s = String(series || '').trim().toLowerCase() || INVOICE_SOURCE_DEFAULT;
  if (s === INVOICE_SOURCE_DEFAULT) {
    return (profile && profile.invoice_number_format) || 'INV-###';
  }
  const stored = profile && profile.invoice_series_formats && profile.invoice_series_formats[s];
  return (stored && String(stored).trim()) || defaultInvoiceSeriesFormat(s);
}

module.exports = {
  applyInvoiceNumberFormat,
  invoiceSeriesFormat,
  defaultInvoiceSeriesFormat,
  INVOICE_SERIES_DEFAULT_FORMATS
};
