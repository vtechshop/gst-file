// Server-side port of js/utils.js's applyInvoiceNumberFormat() — kept in
// sync intentionally (same logic, two runtimes): the frontend copy
// drives the non-committing Settings/Invoice-Entry PREVIEW, this copy
// drives the AUTHORITATIVE number handed out by
// POST /api/invoices/reserve-number (routes/invoices.js), which is the
// only place a number actually gets reserved and persisted.
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

module.exports = { applyInvoiceNumberFormat };
