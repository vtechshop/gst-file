-- =============================================
-- Migration: repair the schema drift left by releases ef2baf2–8a09f3b
--   1. payments.reference_number      (new column)      8a09f3b
--   2. payments.invoice_type CHECK    (accept 'purchase') 8a09f3b
--   3. purchase_returns.state         (new column)      8a09f3b
--   4. cdn_notes.state                (new column)      ef2baf2
--
-- Run once against an existing database:
--   psql "$DATABASE_URL" -f db/migrations/migration_payments_reference.sql
--
-- WHY THIS FILE EXISTS (do not fold these into db/schema/schema.sql and call it
-- done): both releases made every change above *inside* schema.sql's
-- `CREATE TABLE IF NOT EXISTS` blocks for tables that already existed —
-- `payments` dates back to b6a9241, `purchase_returns` to
-- a03364b/migration_purchases.sql, `cdn_notes` to b6a9241. On every
-- already-deployed database those blocks are no-ops, so NONE of these
-- four changes was ever applied. schema.sql contains no ALTER TABLE
-- statements at all, so re-running it can never repair an existing
-- table — only ALTER TABLE can, which is what this file does.
--
-- All four are the same defect class, and all four have to be applied
-- before the currently-deployed code works, so they are one migration:
-- splitting them would create an ordering question between files for no
-- benefit. (The filename predates findings #3 and #4 and is kept as-is
-- rather than renamed, so the file that was already reviewed and
-- referenced stays findable.)
--
-- The visible symptom of #1: recording any payment failed outright.
-- server/routes/payments.js INSERTs `reference_number` explicitly, so on
-- a pre-8a09f3b database every insert raised
--   ERROR:  column "reference_number" of relation "payments" does not exist
--   SQLSTATE: 42703
-- and the surrounding transaction rolled back, leaving the ledger empty
-- and the invoice reading UNPAID / paid 0 / balance = full total.
-- #3 and #4 are the same error on the same class of write path:
-- routes/generic.js lists `state` as an insertable column for both
-- purchase_returns and cdn_notes, so saving a Purchase Return or a
-- Credit/Debit Note raised 42703 on the missing column.
--
-- Idempotent: safe to run repeatedly, and safe to run against a fresh
-- database that schema.sql already built correctly (every statement is
-- guarded, and re-adding the CHECK after dropping it is a no-op in
-- effect). Wrapped in a single transaction — if any statement fails,
-- nothing is applied.
-- =============================================

BEGIN;

-- ── 1. reference_number ───────────────────────────────
-- Nullable TEXT with no default, matching db/schema/schema.sql exactly. Nullable
-- is required: existing ledger rows predate the column and must stay
-- valid, and routes/payments.js passes NULL when the user leaves the
-- reference field blank.
ALTER TABLE IF EXISTS payments
  ADD COLUMN IF NOT EXISTS reference_number TEXT;

-- ── 2. invoice_type CHECK must accept 'purchase' ──────
-- The pre-8a09f3b constraint is CHECK (invoice_type IN ('b2b','b2c')) —
-- it rejects the 'purchase' rows the purchase payment ledger writes with
-- SQLSTATE 23514 (check_violation). ADD CONSTRAINT has no IF NOT EXISTS,
-- so the old one is dropped first, which also makes re-running this file
-- a no-op rather than a duplicate-name error.
--
-- The constraint is discovered by *definition* rather than assumed to be
-- named `payments_invoice_type_check`: that is only Postgres' default
-- name for an inline column CHECK, and dropping a name that doesn't
-- match would silently leave the real (still too narrow) constraint in
-- place — the exact class of silent no-op this migration exists to undo.
DO $$
DECLARE
  con_name text;
BEGIN
  FOR con_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE rel.relname = 'payments'
       AND nsp.nspname = current_schema()
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%invoice_type%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE IF EXISTS payments
  ADD CONSTRAINT payments_invoice_type_check
  CHECK (invoice_type IN ('b2b','b2c','purchase'));

-- ── 3. purchase_returns.state ─────────────────────────
-- Same defect, different table — release 8a09f3b's other half ("fix
-- state dropdowns"). Nullable TEXT with no default, matching
-- db/schema/schema.sql: existing purchase-return rows predate the column and
-- must stay valid. Deliberately NOT backfilled from vendors.state —
-- inferring a historical return's place of supply from the vendor's
-- current master record would be inventing GST data, and place of supply
-- drives the intrastate/interstate split. Existing rows stay NULL and
-- keep whatever supply_type they were saved with.
ALTER TABLE IF EXISTS purchase_returns
  ADD COLUMN IF NOT EXISTS state TEXT;

-- ── 4. cdn_notes.state ────────────────────────────────
-- Release ef2baf2's manual migration, which its commit message documented
-- but which was never filed as a runnable file:
--   "Requires a manual migration on any existing database:
--    ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS state TEXT;"
-- Folded in here rather than shipped separately — it is the same defect
-- class as #1-#3 and has to be applied before the deployed code works, so
-- a second file would only add an ordering question.
--
-- Applied unconditionally rather than gated on a check of production: ADD
-- COLUMN IF NOT EXISTS is a no-op when the column is already there, so
-- running this costs nothing if ef2baf2's one-liner was executed by hand,
-- and fixes Credit/Debit Note saves (42703) if it never was.
--
-- Nullable TEXT with no default, matching db/schema/schema.sql. Not backfilled:
-- state is the note's place of supply and drives the intrastate/interstate
-- split, so inferring it for historical notes would be inventing GST data.
ALTER TABLE IF EXISTS cdn_notes
  ADD COLUMN IF NOT EXISTS state TEXT;

COMMIT;

-- ── Verification (run after the migration) ────────────
-- Expect all four fixes present. Should return exactly 4 rows.
--
--   SELECT 'payments.reference_number' AS fix, count(*) AS ok
--     FROM information_schema.columns
--    WHERE table_name = 'payments' AND column_name = 'reference_number'
--   UNION ALL
--   SELECT 'purchase_returns.state', count(*)
--     FROM information_schema.columns
--    WHERE table_name = 'purchase_returns' AND column_name = 'state'
--   UNION ALL
--   SELECT 'cdn_notes.state', count(*)
--     FROM information_schema.columns
--    WHERE table_name = 'cdn_notes' AND column_name = 'state'
--   UNION ALL
--   SELECT 'payments invoice_type CHECK', count(*)
--     FROM pg_constraint
--    WHERE conrelid = 'payments'::regclass AND contype = 'c'
--      AND pg_get_constraintdef(oid) LIKE '%purchase%';
--
-- Every `ok` must be 1. A 0 on the CHECK row means the constraint drop
-- matched nothing and the narrow constraint is still live.

-- ── Rollback ──────────────────────────────────────────
-- Reverts this migration to the pre-ef2baf2 column set and constraint.
--
--   BEGIN;
--   ALTER TABLE IF EXISTS payments
--     DROP CONSTRAINT IF EXISTS payments_invoice_type_check;
--   ALTER TABLE IF EXISTS payments
--     ADD CONSTRAINT payments_invoice_type_check
--     CHECK (invoice_type IN ('b2b','b2c'));
--   ALTER TABLE IF EXISTS payments DROP COLUMN IF EXISTS reference_number;
--   ALTER TABLE IF EXISTS purchase_returns DROP COLUMN IF EXISTS state;
--   ALTER TABLE IF EXISTS cdn_notes DROP COLUMN IF EXISTS state;
--   COMMIT;
--
-- Three warnings before running that:
--   1. DROP COLUMN reference_number destroys every reference/UTR/cheque
--      number captured since this migration was applied, and the two
--      DROP COLUMN state statements every place-of-supply value captured
--      on purchase returns and credit/debit notes. Place of supply drives
--      the intrastate/interstate split, so losing it changes what those
--      documents report. None of it is recoverable without a backup.
--   2. Re-adding the narrow CHECK fails with 23514 if any purchase
--      payments have been recorded, because those rows violate it. The
--      transaction then rolls back and nothing is reverted. Either delete
--      those rows first (DELETE FROM payments WHERE invoice_type =
--      'purchase') — which silently discards real payment history — or
--      simply leave the widened constraint in place. Leaving it is
--      harmless: a wider CHECK rejects nothing the old code ever wrote.
--   3. Rolling back puts the database back into the exact state that
--      breaks the deployed code (42703 on payment, purchase-return and
--      credit/debit-note writes). It is only meaningful alongside
--      reverting the application to a pre-ef2baf2
--      deploy — never as a standalone fix.
