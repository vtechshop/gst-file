-- =====================================================================
-- Transport charge on a tax invoice
--
-- An optional, invoice-level delivery charge billed to the customer at a
-- fixed 18%. It is NOT a product: it has no quantity, no rate, no HSN and
-- no line of its own, so it is not in invoice_items and never becomes a
-- fake SKU on the document.
--
-- Two columns, not five. The CGST/SGST/IGST split of the transport tax is
-- decided by the invoice's own supply_type, exactly as every product line's
-- split is, so storing transport_cgst / transport_sgst / transport_igst
-- would be a second place for the same split to be decided — and a second
-- place for it to drift.
--
-- NULL, not 0
-- -----------
-- NULL means "no transport was charged on this invoice". 0 means "transport
-- was charged and it was free". They are different facts, and every invoice
-- that already exists means the first one, so NULL is the default and there
-- is NO backfill: not one existing row is read or written by this migration.
--
-- These are NOT the e-way bill transport columns
-- ----------------------------------------------
-- transport_required, transporter_name, transport_mode and
-- transport_distance_km already exist on both tables. They describe how the
-- goods travelled, for the e-way bill. They carry no money and they gate
-- nothing here: a transport CHARGE can be billed with the e-way toggle off,
-- and goods can move under an e-way bill with nothing charged for it.
-- =====================================================================

ALTER TABLE b2b_invoices
  ADD COLUMN IF NOT EXISTS transport_charge NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS transport_gst_amount NUMERIC(14,2);

ALTER TABLE b2c_invoices
  ADD COLUMN IF NOT EXISTS transport_charge NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS transport_gst_amount NUMERIC(14,2);

-- A charge cannot be negative. Written as NOT VALID against nothing: there
-- are no existing rows to validate, because every existing row is NULL and
-- NULL passes a CHECK. Stated anyway so the rule lives with the column
-- rather than only in the route that writes it.
ALTER TABLE b2b_invoices
  ADD CONSTRAINT b2b_invoices_transport_charge_nonneg
  CHECK (transport_charge IS NULL OR transport_charge >= 0);

ALTER TABLE b2b_invoices
  ADD CONSTRAINT b2b_invoices_transport_gst_nonneg
  CHECK (transport_gst_amount IS NULL OR transport_gst_amount >= 0);

ALTER TABLE b2c_invoices
  ADD CONSTRAINT b2c_invoices_transport_charge_nonneg
  CHECK (transport_charge IS NULL OR transport_charge >= 0);

ALTER TABLE b2c_invoices
  ADD CONSTRAINT b2c_invoices_transport_gst_nonneg
  CHECK (transport_gst_amount IS NULL OR transport_gst_amount >= 0);

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No UPDATE. No backfill. No DEFAULT 0. Every invoice that exists today
-- keeps transport_charge = NULL and transport_gst_amount = NULL, which is
-- what it has always meant, and its stored taxable_amount, gst_amount and
-- total_amount are untouched.
--
-- proforma_invoices is deliberately absent: transport is a tax-invoice
-- feature in this phase, and a quotation that cannot store the charge
-- cannot silently lose it either.
