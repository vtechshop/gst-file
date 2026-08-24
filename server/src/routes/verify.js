// =============================================
// Public invoice verification
// =============================================
// The only route in this application without requireAuth, and deliberately
// so: it answers a QR printed on a document that is handed to customers,
// transporters and tax officers, none of whom have a login here.
//
// That makes it the one endpoint a stranger can reach, so it is written to
// give away nothing beyond what is already printed on the invoice they are
// holding:
//
//   The id is a v4 UUID and is rejected by shape before it reaches the
//   database, so the path cannot carry SQL and cannot be walked. UUIDs are
//   not enumerable, so possessing the document is what grants the lookup.
//
//   The type chooses between two named tables from a fixed map. It is never
//   interpolated, so no other table can be addressed.
//
//   The SELECT names its columns. Adding a column to the invoice tables can
//   therefore never widen this response by accident - phone, address, email
//   and every internal flag stay unlisted, and user_id is never returned.
//
//   Anything not found answers one generic 404. A wrong id and an id
//   belonging to another company read identically, so the endpoint cannot
//   be used to test whether an invoice exists.
const express = require('express');
const pool = require('../config/pool');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

// Fixed map, not string interpolation — the table can only ever be one of
// these two whatever the URL says.
const INVOICE_TABLES = { b2b: 'b2b_invoices', b2c: 'b2c_invoices' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One shape for every failure. Callers cannot tell a malformed id from a
// real invoice they are not entitled to see.
function notFound(res) {
  return res.status(404).json({ found: false, status: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
}

router.get('/invoice/:type/:id', asyncRoute(async (req, res) => {
  const table = INVOICE_TABLES[String(req.params.type || '').toLowerCase()];
  if (!table) return notFound(res);
  if (!UUID_RE.test(String(req.params.id || ''))) return notFound(res);

  // Supplier name and GSTIN come from the issuing company's profile, joined
  // on the invoice's owner. That owner id is used for the join only and is
  // never returned.
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.customer_name, i.gst_number,
            i.state, i.supply_type, i.gst_category,
            i.taxable_amount, i.cgst, i.sgst, i.igst, i.total_amount,
            p.business_name AS supplier_name, p.gstin AS supplier_gstin
       FROM ${table} i
       LEFT JOIN profiles p ON p.id = i.user_id
      WHERE i.id = $1`,
    [req.params.id]
  );
  const inv = rows[0];
  if (!inv) return notFound(res);

  res.json({
    found: true,
    status: 'VALID_INVOICE',
    invoice: {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      supplier_name: inv.supplier_name || null,
      supplier_gstin: inv.supplier_gstin || null,
      buyer_name: inv.customer_name || null,
      buyer_gstin: inv.gst_number || null,
      place_of_supply: inv.state || null,
      invoice_type: req.params.type.toLowerCase(),
      supply_type: inv.supply_type || null,
      gst_category: inv.gst_category || null,
      taxable_amount: inv.taxable_amount,
      cgst: inv.cgst,
      sgst: inv.sgst,
      igst: inv.igst,
      total_amount: inv.total_amount
    }
  });
}));

module.exports = router;
