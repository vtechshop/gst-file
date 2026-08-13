-- =============================================
-- Migration: allow 'partial' in the payment_status CHECK on
--            b2b_invoices, b2c_invoices and purchases
--
-- Run once against an existing database:
--   psql "$DATABASE_URL" -f db/migrations/migration_payment_status_partial.sql
--
-- WHY: recording a PARTIAL payment appeared to do nothing — Invoice List
-- kept showing Paid ₹0.00 / full Balance / UNPAID, while a FULL payment
-- on the same invoice worked correctly. Both go through the same code, so
-- the difference was never the calculation: it is the one value written.
--
-- server/routes/payments.js recomputeAndApply() derives the status as
--   paid <= 0 ? 'unpaid' : (paid + 0.005 >= total ? 'paid' : 'partial')
-- and writes it to the invoice header. On a database whose CHECK
-- constraint predates the 'partial' state, writing 'paid' satisfies it
-- but writing 'partial' raises
--   ERROR:  new row for relation "b2b_invoices" violates check constraint
--           "b2b_invoices_payment_status_check"
--   SQLSTATE: 23514
-- That UPDATE is inside the same transaction as the ledger INSERT, so the
-- rollback discards BOTH: no payments row, no header update. The invoice
-- then reads UNPAID / 0 because there is genuinely nothing there — the
-- ledger, Invoice List, Customer Ledger, Dashboard receivables and the
-- Payment History modal all agree, and all of them are wrong together.
--
-- This is a separate file from migration_payments_reference.sql rather
-- than an addition to it, because that one has already been applied in
-- production — an applied migration must never be edited afterwards.
--
-- Same defect class as everything in that file: schema.sql declares the
-- three-value CHECK inside `CREATE TABLE IF NOT EXISTS`, which is a no-op
-- against an existing table, so a database whose invoice tables were
-- created before 'partial' existed never received the widened constraint.
--
-- Idempotent and transactional: constraints are found by definition and
-- dropped before being re-added, so re-running is a no-op rather than a
-- duplicate-name error, and a database that already has the correct
-- three-value CHECK ends up with exactly the same constraint it started
-- with. Widening a CHECK can never reject data that already satisfies the
-- narrower one, so this is safe to apply without inspecting production
-- first.
-- =============================================

BEGIN;

-- Each table's constraint is discovered by *definition* rather than by an
-- assumed name: `<table>_payment_status_check` is only Postgres' default
-- for an inline column CHECK, and a database that acquired the column via
-- ALTER TABLE (see the historical supabase-schema.sql) may carry a
-- different name. Dropping a name that doesn't match would succeed as a
-- no-op while silently leaving the too-narrow constraint live — the exact
-- failure this migration exists to undo.
DO $$
DECLARE
  tbl  text;
  con  text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['b2b_invoices','b2c_invoices','purchases'] LOOP
    -- Skip tables that don't exist on this database (nothing to repair).
    IF to_regclass(tbl) IS NULL THEN CONTINUE; END IF;

    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.conrelid = tbl::regclass
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) ILIKE '%payment_status%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (payment_status IN (''unpaid'',''partial'',''paid''))',
      tbl, tbl || '_payment_status_check');
  END LOOP;
END $$;

COMMIT;

-- ── Verification (run after the migration) ────────────
-- All three rows must come back with allows_partial = 1.
--
--   SELECT rel.relname AS table_name,
--          count(*) FILTER (WHERE pg_get_constraintdef(con.oid) LIKE '%partial%') AS allows_partial
--     FROM pg_constraint con
--     JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname IN ('b2b_invoices','b2c_invoices','purchases')
--      AND con.contype = 'c'
--      AND pg_get_constraintdef(con.oid) ILIKE '%payment_status%'
--    GROUP BY rel.relname
--    ORDER BY rel.relname;
--
-- Then re-record any partial payment that silently failed while the old
-- constraint was live. Those attempts rolled back completely, so there is
-- nothing to clean up — but there is also no record of them, and they
-- will not reappear on their own.

-- ── Rollback ──────────────────────────────────────────
-- Narrowing the CHECK back fails with 23514 if any invoice is currently
-- 'partial', which after this fix is exactly the state it enables. There
-- is no reason to revert: a wider CHECK rejects nothing the old code ever
-- wrote, and reverting re-breaks partial payments. If it is truly needed,
-- every 'partial' row must first be resolved to 'unpaid' or 'paid' —
-- which would falsify real payment history, so take a backup first.
