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

// ── The counter a numbering book is sitting on ────────────────────────
//
// A format says what a number LOOKS like; the sequence says which one comes
// next. Settings lets both be typed, so both need a rule, and the rule for
// the counter lives here beside numberFormatProblem() for the same reason
// that one does: the browser refuses a bad value immediately and the server
// refuses it again authoritatively, and there must be exactly one definition
// of "bad" for the two answers to agree.
//
// Deliberately strict about what a number IS. parseInt('169abc') is 169 and
// parseInt('1.9') is 1, so a counter read with parseInt alone would quietly
// accept text that means something else to whoever typed it. A counter is a
// run of digits or it is a mistake.
const SEQUENCE_MAX = 99999999;

function sequenceProblem(value) {
  if (value === null || value === undefined) return 'Enter the next number, for example 169.';
  if (typeof value === 'boolean' || typeof value === 'object') {
    return 'Enter the next number as a whole number, for example 169.';
  }
  const raw = String(value).trim();
  if (!raw) return 'Enter the next number, for example 169.';
  if (/^[+-]/.test(raw)) {
    return 'The next number must be a positive whole number, not ' + raw + '.';
  }
  if (!/^\d+$/.test(raw)) {
    // Catches 1.5, 1e3, '12 34', '169abc' and anything else that is not
    // simply digits. One sentence for all of them: the difference between
    // "a decimal" and "not a number at all" does not change what to do.
    return 'The next number must be a whole number, not ' + raw + '.';
  }
  const n = parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) return 'The next number must be 1 or more.';
  if (n > SEQUENCE_MAX) return 'Keep the next number at ' + SEQUENCE_MAX + ' or below.';
  return null;
}

// The first sequence at or after `seq` whose formatted number is not already
// issued, given the numbers this book has used (upper-cased).
//
// This is the "the counter is only a starting point" rule, extracted so the
// two places that need it cannot drift: nextDocumentNumberOn() walks forward
// past anything already issued when a number is ISSUED, and the Settings
// endpoint uses the same walk to say which counter would actually be free. A
// counter that has fallen behind the saved documents heals itself on the
// next one rather than colliding.
//
// The guard is a ceiling on the walk, not on the book: a pathological run of
// a hundred thousand consecutive numbers stops the scan rather than hanging
// the request, and the caller's duplicate check then refuses the result.
const SEQUENCE_SCAN_GUARD = 100000;

function firstFreeSequence(format, seq, usedUpper) {
  let n = Math.max(1, parseInt(seq, 10) || 1);
  let candidate = applyInvoiceNumberFormat(format, n);
  let guard = 0;
  while (usedUpper.has(candidate.toUpperCase()) && guard < SEQUENCE_SCAN_GUARD) {
    n++;
    candidate = applyInvoiceNumberFormat(format, n);
    guard++;
  }
  return { seq: n, documentNumber: candidate };
}

// Would setting this book's counter to `seq` reissue a number?
//
// The question Settings has to answer before it writes a counter, and the
// reason a counter cannot simply be stored as typed: lowering it onto a
// number the book has already given out would hand that number to a second
// document. Answered against the numbers actually in the book rather than
// against the counter, because the counter is the thing being changed.
//
// `taken` is the issued numbers, as a Set of upper-cased strings or any
// iterable of raw ones. Case is not significant, exactly as the duplicate
// check on save treats it.
function sequenceConflict(format, seq, taken) {
  const usedUpper = taken instanceof Set
    ? taken
    : new Set((taken || []).map(v => String(v == null ? '' : v).trim().toUpperCase()));
  const n = Math.max(1, parseInt(seq, 10) || 1);
  const candidate = applyInvoiceNumberFormat(format, n);
  const conflict = usedUpper.has(candidate.toUpperCase());
  // What to offer instead. Only meaningful when there IS a conflict, and it
  // is the same walk the save would do, so the suggestion can never be a
  // number that would itself be refused.
  const free = conflict
    ? firstFreeSequence(format, n, usedUpper)
    : { seq: n, documentNumber: candidate };
  return { conflict, candidate, nextFree: free.seq, nextFreeNumber: free.documentNumber };
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
  sequenceProblem,
  firstFreeSequence,
  sequenceConflict,
  NUMBER_FORMAT_MAX,
  SEQUENCE_MAX,
  SEQUENCE_SCAN_GUARD,
  INVOICE_SERIES_DEFAULT_FORMATS
};
