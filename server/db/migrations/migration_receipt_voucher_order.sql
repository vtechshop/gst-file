-- =====================================================================
-- What the advance was received against: the order, and how it is taxed
--
-- A Receipt Voucher already records money a customer paid in advance, how
-- it arrived (payment_method, reference_number) and which quotation it was
-- taken against (proforma_invoice_id, from
-- migration_receipt_voucher_payment.sql). Two things it still could not
-- say, and both are on the face of the receipt the customer is handed:
--
--   1. the ORDER the advance belongs to, when there is no quotation to
--      read it from. A receipt for 30,000 against a 66,670 order is only
--      legible if the 66,670 is written down somewhere, and until now it
--      existed only when a proforma was linked.
--   2. whether the advance is for GOODS or for SERVICES, which is what
--      decides whether any GST is payable on it at all - see the note at
--      the bottom, which is the reason this migration exists at all.
--
--   supply_nature     'goods' or 'services'. NULL on every existing row,
--                     meaning "not recorded", because nothing asked until
--                     now and inventing an answer would be a statement
--                     about a tax position nobody took.
--   party_address     the customer's address, as Rule 50 asks a receipt
--                     voucher to carry it.
--   payment_date      when the money actually arrived, which is not
--                     always the date the voucher is raised.
--   order_quantity    the order, for a receipt with no quotation behind
--   order_rate        it. Quantity and rate are what a person types;
--   order_amount      order_amount is the line value.
--   packing_charge    packing or other additional charge on the order.
--   order_gst_rate    the rate the ORDER will be invoiced at, which is
--                     not necessarily the rate this advance carries.
--
-- Derived, and therefore deliberately NOT stored
-- ----------------------------------------------
-- The order's taxable value (order_amount + packing_charge), its GST
-- amount and its total are computed wherever they are shown, for the same
-- reason the quotation balance is not stored: a figure that can be
-- computed from stored ones must not be able to disagree with them. One
-- place decides the arithmetic - voucherOrderAmounts() in
-- client/js/pages/vouchers.js - and the receipt, the screen and the PDF
-- all read it from there.
--
-- The advance is still advance_amount, and the balance is still the order
-- total less the receipts against it. Neither changes here.
--
-- Why supply_nature matters: Notification 66/2017-Central Tax
-- ----------------------------------------------------------
-- Section 31(3)(d) requires a receipt voucher for an advance, and Rule 50
-- says what it must contain. Whether TAX is payable on that advance is a
-- separate question:
--
--   * services - tax is due when the advance is received
--     (Section 13(2)), so the voucher carries GST and GSTR-1 Table 11A
--     reports it.
--   * goods - Notification 66/2017-Central Tax, 15 November 2017,
--     relieved every registered person other than a composition
--     taxpayer from paying tax on an advance for a supply of GOODS. Tax
--     is payable when the invoice is issued, so the advance carries no
--     GST and there is no 11A liability to report.
--
-- Until this column exists there is nothing on a receipt voucher that
-- says which case it is, and the form charged GST on every advance. That
-- is right for a services advance and wrong for a goods one.
--
-- This migration only RECORDS the distinction. It changes no tax rule, no
-- return, and not one existing row: every receipt voucher raised before
-- this column existed keeps exactly the gst_percentage, igst, cgst, sgst
-- and cess it was saved with, and GSTR-1 continues to report those
-- figures unchanged. What the form does with a NEW voucher is a decision
-- in the application, not here.
--
-- NULL everywhere, no backfill
-- ----------------------------
-- Every column is nullable and no row is read or written. A NULL
-- supply_nature on an old voucher means "nobody recorded it", which is
-- the truth, and the GST it already carries is left exactly as issued.
--
-- Re-runnable: each column is added IF NOT EXISTS and each CHECK only
-- when it is not already there.
-- =====================================================================

ALTER TABLE receipt_vouchers
  ADD COLUMN IF NOT EXISTS supply_nature TEXT,
  ADD COLUMN IF NOT EXISTS party_address TEXT,
  ADD COLUMN IF NOT EXISTS payment_date DATE,
  ADD COLUMN IF NOT EXISTS order_quantity NUMERIC(14,3),
  ADD COLUMN IF NOT EXISTS order_rate NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS order_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS packing_charge NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS order_gst_rate NUMERIC(5,2);

-- Two values and no third. NULL is permitted because every receipt
-- voucher raised before this column existed has no nature recorded, and
-- choosing one for them would restate a tax position they never took.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_supply_nature_known') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_supply_nature_known
      CHECK (supply_nature IS NULL OR supply_nature IN ('goods','services'));
  END IF;
END
$$;

-- Money is not negative. Each is checked on its own so a bad value names
-- its own column rather than a shared constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_order_amount_nonneg') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_order_amount_nonneg
      CHECK (order_amount IS NULL OR order_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_packing_charge_nonneg') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_packing_charge_nonneg
      CHECK (packing_charge IS NULL OR packing_charge >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_order_rate_nonneg') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_order_rate_nonneg
      CHECK (order_rate IS NULL OR order_rate >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_order_quantity_nonneg') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_order_quantity_nonneg
      CHECK (order_quantity IS NULL OR order_quantity >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'receipt_vouchers_order_gst_rate_range') THEN
    ALTER TABLE receipt_vouchers
      ADD CONSTRAINT receipt_vouchers_order_gst_rate_range
      CHECK (order_gst_rate IS NULL OR (order_gst_rate >= 0 AND order_gst_rate <= 100));
  END IF;
END
$$;

-- Deliberately NOT done here: no UPDATE and no backfill, no DEFAULT, no
-- foreign key, no stored taxable value, GST amount, order total or
-- balance, nothing touching gst_percentage, igst, cgst, sgst or cess on
-- any existing row, and nothing on proforma_invoices, payments,
-- advance_adjustments or either invoice table. No GSTR-1 or GSTR-3B
-- behaviour is changed by this file.
