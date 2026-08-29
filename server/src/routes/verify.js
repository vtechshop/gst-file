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

// ── Public warranty verification ──
// Same rules as the invoice route above, for the same reason: this answers a
// QR or an NFC tag on goods in a customer's hands, and that customer has no
// login. The id is checked by shape before it reaches the database, the
// SELECT names its columns so a later migration cannot widen the response,
// and every failure answers one generic 404 - so the endpoint cannot be used
// to discover which warranties exist.
//
// Expiry is computed here rather than read, because the stored status only
// records what a person decided. That is what makes a tag answer truthfully
// the day after cover ends without anyone rewriting it.
function warrantyNotFound(res) {
  return res.status(404).json({ found: false, status: 'WARRANTY_NOT_FOUND', message: 'Warranty not found' });
}

router.get('/warranty/:id', asyncRoute(async (req, res) => {
  if (!UUID_RE.test(String(req.params.id || ''))) return warrantyNotFound(res);

  // customer_phone, notes, internal ids and every timestamp are deliberately
  // absent: none of them is needed to answer 'is this item still covered?'.
  const { rows } = await pool.query(
    `SELECT w.warranty_number, w.status, w.customer_name,
            w.invoice_number, w.invoice_date, w.purchase_date,
            w.product_name, w.product_sku, w.serial_number, w.quantity,
            w.warranty_period_months, w.warranty_start_date,
            w.warranty_until, w.extended_until, w.warranty_terms,
            p.business_name AS supplier_name
       FROM warranties w
       LEFT JOIN profiles p ON p.id = w.user_id
      WHERE w.id = $1`,
    [req.params.id]
  );
  const w = rows[0];
  if (!w) return warrantyNotFound(res);

  const until = w.extended_until || w.warranty_until;
  const today = new Date().toISOString().slice(0, 10);
  const cancelled = String(w.status || '').toLowerCase() === 'cancelled';
  const expired = !cancelled && !!until && String(until).slice(0, 10) < today;
  const state = cancelled ? 'CANCELLED' : expired ? 'EXPIRED' : 'ACTIVE';
  const daysRemaining = until && !cancelled
    ? Math.round((new Date(String(until).slice(0, 10) + 'T00:00:00')
                - new Date(today + 'T00:00:00')) / 86400000)
    : null;

  res.json({
    found: true,
    status: state,
    warranty: {
      warranty_number: w.warranty_number,
      status: state,
      days_remaining: daysRemaining,
      supplier_name: w.supplier_name || null,
      customer_name: w.customer_name || null,
      invoice_number: w.invoice_number || null,
      invoice_date: w.invoice_date || null,
      purchase_date: w.purchase_date || null,
      product_name: w.product_name || null,
      product_sku: w.product_sku || null,
      serial_number: w.serial_number || null,
      quantity: w.quantity,
      warranty_period_months: w.warranty_period_months,
      warranty_start_date: w.warranty_start_date || null,
      warranty_until: until || null,
      warranty_terms: w.warranty_terms || null
    }
  });
}));

module.exports = router;
