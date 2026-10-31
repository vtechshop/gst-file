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

// Which sequence number a given invoice number came from - the inverse of
// applyInvoiceNumberFormat above, and written directly against it so the two
// cannot drift: every branch here answers one branch there.
//
// It exists because a number typed by hand still has to move the counter. A
// business that types 1 is telling us where its book is, and the next
// automatic number has to continue from there rather than from wherever the
// counter happened to be.
//
// null means "this number did not come out of this format" - a free-form
// number like SPECIAL/2026 against INV-###. The caller leaves the counter
// alone in that case, because there is no sequence to read from it.
function sequenceFromInvoiceNumber(format, number) {
  const fmt = (format || '').trim() || 'INV-###';
  const value = String(number == null ? '' : number).trim();
  if (!value) return null;

  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hashes = fmt.match(/#+/);

  let re;
  if (hashes) {
    // The padded branch: INV-### <- INV-007. The digits may be longer than
    // the run of #, because applyInvoiceNumberFormat only pads, never truncates.
    re = new RegExp('^' + esc(fmt.slice(0, hashes.index)) + '(\\d+)'
      + esc(fmt.slice(hashes.index + hashes[0].length)) + '$', 'i');
  } else if (/^\d+$/.test(fmt)) {
    // The bare-number branch: a format that is itself digits prints the
    // sequence alone.
    re = /^(\d+)$/;
  } else {
    // The fallback branch: a format with no # at all prints "<format>-<n>".
    re = new RegExp('^' + esc(fmt) + '-(\\d+)$', 'i');
  }

  const m = re.exec(value);
  if (!m) return null;
  const seq = parseInt(m[1], 10);
  return Number.isFinite(seq) && seq > 0 ? seq : null;
}

// Is this format usable? null when it is, a sentence to show when it is not.
//
// applyInvoiceNumberFormat() above tolerates anything, which is right for a
// formatter but means nothing ever refuses a format that cannot do its job.
// These are the three ways a format is genuinely broken, judged against that
// function's own behaviour rather than against a new syntax:
//
//   - empty. The formatter would silently substitute INV-### and the user
//     would be looking at a format they never chose.
//   - more than one run of #. Only the FIRST run is substituted, so
//     'PI-###/###' issues PI-001/### - literal hashes inside a document
//     number, which is never what anyone meant.
//   - unreasonably long, or carrying control characters. The number ends up
//     in a PDF, a filename and a GSTR-1 row.
//
// A format with no # at all is deliberately allowed: the formatter has a
// documented branch for it ('INV' -> INV-1), and the invoice Settings screen
// tells users so.
const NUMBER_FORMAT_MAX = 40;

function numberFormatProblem(format) {
  const fmt = String(format == null ? '' : format).trim();
  if (!fmt) return 'Enter a number format, for example PI-#####.';
  if (fmt.length > NUMBER_FORMAT_MAX) {
    return `Keep the format to ${NUMBER_FORMAT_MAX} characters or fewer.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(fmt)) {
    return 'The format cannot contain line breaks or control characters.';
  }
  if ((fmt.match(/#+/g) || []).length > 1) {
    return 'Use a single run of # for the number — PI-##### gives PI-00001.';
  }
  return null;
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
  sequenceFromInvoiceNumber,
  invoiceSeriesFormat,
  defaultInvoiceSeriesFormat,
  numberFormatProblem,
  NUMBER_FORMAT_MAX,
  INVOICE_SERIES_DEFAULT_FORMATS
};
