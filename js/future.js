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
//
// Builds exactly the payload a real E-Way Bill API call would send,
// from an already-fetched invoice record (the shape fetchInvoiceRecord()
// in js/invoice-pdf.js returns — customer/seller GSTIN, full transport
// section, line items). Pure/no network call — this is the "prepare the
// architecture" piece: the transport data (including the 4 fields added
// in this phase — transporter_gstin, vehicle_type, dispatch_from,
// dispatch_to) now genuinely flows through to here instead of being
// theoretical, even though no real E-Way Bill API call is made yet.
function buildEWayBillPayload(inv) {
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  return {
    supplyType: inv.supply_type === 'interstate' ? 'Interstate' : 'Intrastate',
    docType: 'INV',
    docNo: inv.invoice_number,
    docDate: formatDate(inv.invoice_date),
    fromGstin: profile?.gstin || '',
    fromState: profile?.state || '',
    toGstin: inv.gstin || '',
    toState: inv.state || '',
    itemList: (inv.items || []).map(it => ({
      productName: it.product_name,
      hsnCode: it.hsn_code,
      quantity: it.quantity,
      taxableAmount: it.taxable_value,
      gstRate: it.gst_percentage
    })),
    totalValue: inv.total_amount,
    transporterGstin: inv.transporter_gstin || '',
    transporterName: inv.transporter_name || '',
    transportMode: inv.transport_mode || '',
    vehicleNumber: inv.vehicle_number || '',
    vehicleType: inv.vehicle_type || '',
    distanceKm: inv.transport_distance_km || null,
    dispatchFrom: inv.dispatch_from || '',
    dispatchTo: inv.dispatch_to || ''
  };
}

async function generateEWayBill(type, invoiceId) {
  if (!FEATURE_FLAGS.eWayBill) {
    // Even with the feature off, when called with a real invoice
    // (type + invoiceId) the actual data plumbing already runs — only
    // the outbound API call itself is stubbed out.
    if (type && invoiceId && typeof fetchInvoiceRecord === 'function') {
      const inv = await fetchInvoiceRecord(type, invoiceId);
      if (inv) buildEWayBillPayload(inv); // built, ready for a future real API call — not sent anywhere yet
    }
    showToast('E-Way Bill generation is coming soon.', 'info');
    return null;
  }
  // Placeholder for future implementation.
  return null;
}
