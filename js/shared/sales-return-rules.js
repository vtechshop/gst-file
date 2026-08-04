// =============================================
// Sales Return quantity rules — THE single definition.
//
// A customer may return all or part of what they bought, but never more,
// and never more than is still outstanding once earlier returns are
// counted:
//
//     available = sold - already returned
//
// This file is deliberately shared rather than reimplemented per layer.
// The browser loads it as a plain script (sales-returns.html) and the
// server require()s it (server/routes/sales-returns.js), so the number
// the user is told is the limit is byte-for-byte the number the server
// enforces. Two copies of a rule like this drift, and when they do the
// database ends up holding returns that the UI would have refused.
//
// No GST, totals, or persistence logic lives here — only "is this
// quantity allowed, and if not, what should the user be told".
// =============================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node
  else Object.assign(root, api);                                            // browser globals
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Quantities are stored as numerics and can be fractional (0.5 kg), so
  // comparisons are made on 2-decimal rounded values. Without this,
  // floating point makes 2 - 1.1 - 0.9 look like a leftover of 1e-16 and
  // a genuinely exhausted line appears to have something available.
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

  // Trims a trailing ".00" so messages read "2" rather than "2.00",
  // while still showing "1.5" when the quantity really is fractional.
  const q = n => {
    const v = r2(n);
    return Number.isInteger(v) ? String(v) : String(v);
  };

  const plural = (n, one, many) => (r2(n) === 1 ? one : many);

  // How many units of this line may still be returned.
  function availableReturnQty(soldQty, alreadyReturnedQty) {
    return Math.max(0, r2(r2(soldQty) - r2(alreadyReturnedQty)));
  }

  // The whole rule. Returns the verdict plus the message to show, so
  // every caller phrases a rejection identically.
  //
  //   { valid, available, sold, alreadyReturned, exhausted, message }
  function validateReturnQty(soldQty, alreadyReturnedQty, returnQty) {
    const sold = r2(soldQty);
    const already = Math.max(0, r2(alreadyReturnedQty));
    const qty = r2(returnQty);
    const available = availableReturnQty(sold, already);
    const base = { available, sold, alreadyReturned: already, exhausted: available <= 0 };

    if (qty < 0) {
      return { ...base, valid: false, message: 'Return quantity cannot be negative.' };
    }
    // Zero means "not returning this line", which is always allowed —
    // the checkbox, not the quantity, decides whether a line is included.
    if (qty === 0) return { ...base, valid: true, message: '' };

    if (base.exhausted) {
      return { ...base, valid: false,
        message: `This item has already been fully returned (${q(already)} of ${q(sold)}).` };
    }

    if (qty > available) {
      // With nothing returned before, the limit IS the sold quantity and
      // saying so is clearer than talking about availability.
      if (already === 0) {
        return { ...base, valid: false,
          message: `Return quantity cannot exceed the sold quantity (${q(sold)}).` };
      }
      return { ...base, valid: false,
        message: `Only ${q(available)} ${plural(available, 'item is', 'items are')} available for return. ` +
                 `${q(already)} ${plural(already, 'item has', 'items have')} already been returned.` };
    }

    return { ...base, valid: true, message: '' };
  }

  return { availableReturnQty, validateReturnQty };
});
