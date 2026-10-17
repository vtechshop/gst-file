-- =====================================================================
-- Advance amount quoted on a proforma invoice
--
-- A quotation often states what is payable up front and what is payable
-- on delivery: "₹25,000 advance, balance ₹75,000". That is a TERM OF THE
-- QUOTE, not a payment - nothing has necessarily been received - so it
-- lives here beside the quoted figures and nowhere near the money:
--
--   advance_amount  what the quotation asks for up front
--
-- The balance is NOT stored. It is total_amount - advance_amount and it
-- is derived wherever it is shown, for the same reason round_off is
-- derived in the proforma PDF: a figure that can be computed from two
-- stored ones must not be able to disagree with them.
--
-- What this is deliberately NOT
-- -----------------------------
-- It is not a receipt voucher (receipt_vouchers, GSTR-1 Table 11A), not
-- an advance adjustment (advance_adjustments, Table 11B) and not a
-- payment. Those three record money that actually changed hands and all
-- of them carry tax consequences. Typing a figure on a quotation carries
-- none, so nothing here writes to any of them, and the amount below
-- reaches no return.
--
-- It also does not touch the GST. taxable_amount, gst_amount, igst,
-- cgst, sgst and total_amount are what they were: an advance changes who
-- pays when, never what is owed.
--
-- NULL, not 0
-- -----------
-- NULL means "no advance was quoted", which is what every proforma that
-- exists today means, so NULL is the default and there is NO backfill:
-- not one existing row is read or written. Everything that reads the
-- column treats NULL as zero, so an older proforma opens, prints and
-- converts exactly as it did before.
--
-- Re-runnable: the column is added IF NOT EXISTS, and the CHECK only
-- when it is not already there.
-- =====================================================================

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(14,2);

-- An advance cannot be negative. Stated with the column as well as in the
-- route that writes it. Every existing row is NULL, and NULL passes a
-- CHECK, so there is nothing to validate.
--
-- That it cannot exceed the quoted total is NOT a CHECK here: the total
-- and the advance are written in the same UPDATE, and a cross-column
-- constraint would make the order of two columns in one statement matter.
-- The save route refuses that combination before anything is written
-- (routes/documents.js), which is where the rule can be explained to the
-- person who typed it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'proforma_invoices_advance_amount_nonneg') THEN
    ALTER TABLE proforma_invoices
      ADD CONSTRAINT proforma_invoices_advance_amount_nonneg
      CHECK (advance_amount IS NULL OR advance_amount >= 0);
  END IF;
END
$$;

-- Deliberately NOT done here: no UPDATE, no backfill, no DEFAULT 0, no
-- balance column, and nothing on b2b_invoices / b2c_invoices, which
-- record payments through the payments ledger instead.
