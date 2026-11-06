-- =====================================================================
-- ROLLBACK: receipt voucher line items
-- =====================================================================
-- Drops the table migration_receipt_voucher_items.sql created.
--
-- NOT A MIGRATION. Deliberately absent from _manifest.json so the runner
-- can never pick it up; run by hand with psql against a named database.
--
-- It REFUSES while any line item exists, because those rows are the only
-- record of what a manually entered advance was received against.
-- Dropping them would leave vouchers whose printed total no longer adds
-- up from anything, which is the kind of quiet damage the zero-data-loss
-- rule exists to prevent. Empty the table deliberately, or decide
-- deliberately to lose it - but not as a side effect of a rollback.
-- =====================================================================

DO $$
DECLARE n INTEGER;
BEGIN
  IF to_regclass('public.receipt_voucher_items') IS NULL THEN
    RAISE NOTICE 'receipt voucher items rollback: already reversed';
    RETURN;
  END IF;
  SELECT count(*) INTO n FROM receipt_voucher_items;
  IF n > 0 THEN
    RAISE EXCEPTION
      'receipt voucher items rollback: % line item(s) exist. They are the only '
      'record of what those advances were received against. Nothing was changed.', n;
  END IF;
END $$;

DROP TABLE IF EXISTS receipt_voucher_items;

DO $$
BEGIN
  IF to_regclass('public.receipt_voucher_items') IS NOT NULL THEN
    RAISE EXCEPTION 'receipt voucher items rollback: the table is still present.';
  END IF;
  RAISE NOTICE 'receipt voucher items rollback: reversed';
END $$;
