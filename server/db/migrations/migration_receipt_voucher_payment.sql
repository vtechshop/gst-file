-- =====================================================================
-- How an advance was received, and what it was received against
--
-- A Receipt Voucher already records money a customer paid in advance:
-- it is the GST document for that event, it is numbered RV-#####, and
-- the GSTR-1 export already reports it in Table 11A. What it could not
-- say was HOW the money arrived and WHICH quotation it was against, so
-- a receipt could not be printed for the customer and no balance could
-- be worked out.
--
--   payment_method       cash / upi / bank_transfer / cheque / card /
--                        other - the same six the payments ledger has
--                        used since it was written, so one vocabulary
--                        describes money received whichever door it
--                        came in by
--   reference_number     the UPI reference, cheque number or bank
--                        transaction id, as the payments ledger records
--                        it for an invoice
--   proforma_invoice_id  the quotation this advance was received
--                        against, when there is one
--
-- The balance is NOT stored. It is the quotation's total less the
-- receipts recorded against it, and it is derived wherever it is shown,
-- for the same reason the proforma's own balance is: a figure that can
-- be computed from stored ones must not be able to disagree with them.
--
-- No foreign key on proforma_invoice_id
-- -------------------------------------
-- Deliberate, and the same choice advance_adjustments.invoice_id makes:
-- a receipt is a record of money that genuinely changed hands, and it
-- must survive the quotation being deleted rather than being cascaded
-- away or blocking the delete. The save route proves the quotation
-- belongs to the same user before it writes the link, which is the
-- check a foreign key could not make anyway.
--
-- What this does NOT do
-- ---------------------
-- It adds no tax column and changes no tax rule. Whether an advance
-- carries GST is already the voucher's own gst_percentage, and the
-- supply the receipt belongs to decides that - not this migration.
-- Nothing here writes to payments, advance_adjustments or any invoice.
--
-- NULL everywhere
-- ---------------
-- Every existing receipt voucher means "not recorded", which is what
-- NULL says, so there is no backfill and not one existing row is read
-- or written.
--
-- Re-runnable: each column is added IF NOT EXISTS, and the CHECK only
-- when it is not already there.
-- =====================================================================

ALTER TABLE receipt_vouchers
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS reference_number TEXT,
  ADD COLUMN IF NOT EXISTS proforma_invoice_id UUID;

-- The six the payments ledger already allows, and no seventh. NULL is
-- permitted because every receipt voucher raised before this column
-- existed has no method recorded, and inventing one for them would be
-- a statement about money nobody made.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_payment_method_known') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_payment_method_known
      CHECK (payment_method IS NULL OR payment_method IN ('cash','upi','bank_transfer','cheque','card','other'));
  END IF;
END
$$;

-- Deliberately NOT done here: no UPDATE, no backfill, no DEFAULT, no
-- balance column, no foreign key, and nothing on payments,
-- advance_adjustments, proforma_invoices or either invoice table.
