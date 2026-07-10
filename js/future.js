// =============================================
// Future-Ready Stubs
// Architecture placeholders for features not yet implemented.
// Each function documents the intended request/response shape
// so the real integration can be dropped in later without
// touching any calling code (buttons already call these names).
// =============================================

// GSTR-3B is already implemented — see gstr3b.html / js/gstr3b.js.

// E-Invoice (IRN generation via GST e-Invoice API / IRP)
// Intended shape once implemented:
//   POST to IRP (via a backend proxy — the IRP API cannot be called
//   directly from the browser) with the invoice payload in the
//   government's e-Invoice schema, receive back { irn, ackNo, ackDate, qrCode }.
async function generateEInvoiceIRN(invoiceId) {
  if (!FEATURE_FLAGS.eInvoice) {
    showToast('E-Invoice (IRN) generation is coming soon.', 'info');
    return null;
  }
  // Placeholder for future implementation.
  return null;
}

// E-Way Bill generation via the GST E-Way Bill API
// Intended shape once implemented:
//   POST invoice + transporter details to the E-Way Bill portal
//   (via a backend proxy), receive back { ewbNo, ewbDate, validUpto }.
async function generateEWayBill(invoiceId) {
  if (!FEATURE_FLAGS.eWayBill) {
    showToast('E-Way Bill generation is coming soon.', 'info');
    return null;
  }
  // Placeholder for future implementation.
  return null;
}
