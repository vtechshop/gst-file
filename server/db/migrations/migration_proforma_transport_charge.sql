-- =====================================================================
-- Transport charge on a proforma invoice
--
-- The quotation carries the same optional, document-level delivery charge
-- a tax invoice does, so the customer is quoted the total they will be
-- billed. Same two columns, same meaning and same rules as
-- migration_invoice_transport_charge.sql, which left proforma_invoices out
-- of its first phase deliberately:
--
--   transport_charge      what was quoted for delivery
--   transport_gst_amount  the tax on it - DERIVED by the save route
--                         (routes/documents.js) from the charge and the
--                         principal supply's rate, never taken from a caller
--
-- The CGST/SGST/IGST split is decided by the proforma's own supply_type,
-- exactly as every product line's split is, so it is not stored a second
-- time.
--
-- NULL, not 0
-- -----------
-- NULL means "no delivery was quoted". 0 means "delivery was quoted, free".
-- They are different facts, and every proforma that exists today means the
-- first one, so NULL is the default and there is NO backfill: not one
-- existing row is read or written, and no stored taxable_amount, gst_amount
-- or total_amount moves.
--
-- Re-runnable: the columns are added IF NOT EXISTS, and each CHECK only
-- when it is not already there.
-- =====================================================================

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS transport_charge NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS transport_gst_amount NUMERIC(14,2);

-- A charge, and the tax on it, cannot be negative. Stated with the column
-- as well as in the route that writes it. Every existing row is NULL, and
-- NULL passes a CHECK, so there is nothing to validate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'proforma_invoices_transport_charge_nonneg') THEN
    ALTER TABLE proforma_invoices
      ADD CONSTRAINT proforma_invoices_transport_charge_nonneg
      CHECK (transport_charge IS NULL OR transport_charge >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'proforma_invoices_transport_gst_nonneg') THEN
    ALTER TABLE proforma_invoices
      ADD CONSTRAINT proforma_invoices_transport_gst_nonneg
      CHECK (transport_gst_amount IS NULL OR transport_gst_amount >= 0);
  END IF;
END
$$;

-- Deliberately NOT done here: no UPDATE, no backfill, no DEFAULT 0, and
-- nothing on b2b_invoices / b2c_invoices, which already have their columns.
