-- =============================================
-- Migration: eway_bills — internal transport documents
--
-- Run once against an existing database:
--   psql "$DATABASE_URL" -f db/migration_eway_bills.sql
--
-- Adds the table behind the E-Way Bills module: one record per transport
-- movement, linked to the invoice being shipped. Nothing existing is
-- altered — no column is added to, removed from or retyped on any current
-- table, and no data is migrated. This is purely additive, so the running
-- application is unaffected until the new page is deployed.
--
-- WHY A SEPARATE TABLE rather than reusing the invoice's own transport_*
-- columns: an invoice can be dispatched more than once (part loads, a
-- vehicle change mid-transit), and the transport details describe the
-- movement, not the sale. The invoice columns are left exactly as they are.
--
-- FUTURE NIC INTEGRATION: ewb_number, ewb_date, valid_until and status are
-- created now but never written by this phase. status stays
-- 'not_generated' until a real E-Way Bill is obtained from the NIC portal,
-- at which point that same row is UPDATEd in place — no schema change and
-- no second table will be needed to switch the module on.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, and the trigger is dropped
-- before being created because Postgres has no CREATE TRIGGER IF NOT
-- EXISTS. Safe to run repeatedly and safe on a fresh database that
-- schema.sql already built.
-- =============================================

BEGIN;

CREATE TABLE IF NOT EXISTS eway_bills (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- Source invoice. Same (id, type) pair invoice_items and payments use;
  -- number/date are denormalised so the list renders without a join.
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('b2b','b2c')),
  invoice_number TEXT NOT NULL,
  invoice_date DATE,

  -- The only fields the user enters.
  vehicle_number TEXT,
  transporter_name TEXT,
  transport_mode TEXT,
  transport_distance_km DECIMAL(10,2),
  lr_number TEXT,
  lr_date DATE,
  transporter_gstin TEXT,
  vehicle_type TEXT,
  dispatch_from TEXT,
  dispatch_to TEXT,

  -- Reserved for future NIC integration — not written in this phase.
  ewb_number TEXT,
  ewb_date DATE,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'not_generated'
    CHECK (status IN ('not_generated','generated','cancelled','expired')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eway_bills_invoice ON eway_bills(user_id, invoice_id, invoice_type);
CREATE INDEX IF NOT EXISTS idx_eway_bills_user ON eway_bills(user_id, created_at);

-- Keeps updated_at current, same as every other table. Dropped first so a
-- re-run is a no-op rather than a 42710 duplicate_object.
DROP TRIGGER IF EXISTS eway_bills_upd ON eway_bills;
CREATE TRIGGER eway_bills_upd BEFORE UPDATE ON eway_bills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;

-- ── Verification (run after the migration) ────────────
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'eway_bills' ORDER BY ordinal_position;
--   -- expect 22 columns, ending ewb_number, ewb_date, valid_until, status,
--   -- created_at, updated_at
--
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'eway_bills'::regclass AND NOT tgisinternal;
--   -- expect eway_bills_upd

-- ── Rollback ──────────────────────────────────────────
-- Safe: the table is new in this release, so nothing else references it and
-- no pre-existing data lives in it. Dropping it only discards transport
-- documents created since the migration ran, which cannot be recovered
-- without a backup.
--
--   BEGIN;
--   DROP TABLE IF EXISTS eway_bills;
--   COMMIT;
