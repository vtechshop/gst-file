-- =====================================================================
-- WHAT REFERS TO A SERIAL
--
-- The serial table is the authority on a unit. These two columns let the
-- ledger and the warranty register point AT one, without either of them
-- owning it.
-- =====================================================================

-- ── A movement can name the unit it moved ─────────────────────────────
-- Nullable, because most movements are of counted goods and have no unit
-- to name. For a serialised product every movement carries one, which is
-- what makes a serial's timeline a query rather than a second history
-- table: the movement row already records the type, the direction, the
-- document, the location and who did it.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS serial_id UUID REFERENCES stock_serials(id) ON DELETE SET NULL;

-- The timeline of one unit, in the order it happened.
CREATE INDEX IF NOT EXISTS idx_stock_movements_serial
  ON stock_movements (serial_id, created_at)
  WHERE serial_id IS NOT NULL;

-- ── A warranty can name the unit it covers ────────────────────────────
-- One direction only, and this is the safe one. warranties rows are
-- created, cancelled and revived by services/warranty-sync.js inside the
-- invoice transaction; if a serial pointed at a warranty, a unit's
-- identity would depend on a record that reconciles itself on every
-- invoice save. Pointing this way leaves the serial authoritative and the
-- warranty a reader of it.
--
-- ON DELETE SET NULL for the same reason the purchase line link uses it:
-- losing the reference must never take the warranty with it.
ALTER TABLE warranties
  ADD COLUMN IF NOT EXISTS serial_id UUID REFERENCES stock_serials(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_warranties_serial
  ON warranties (serial_id)
  WHERE serial_id IS NOT NULL;

-- ── Deliberately NOT done here ────────────────────────────────────────
-- warranties.serial_number is NOT touched, NOT migrated into stock_serials
-- and NOT dropped. It is free text a person typed, it has never been
-- reconciled against inventory, and in production every one of its rows is
-- currently NULL. Treating those strings as inventory identity would turn
-- unverified notes into stock records. If they are ever populated, mapping
-- them is a separate, verified exercise.
--
-- services/warranty-sync.js is NOT changed by this migration or this
-- release. serial_id is additive and stays NULL until something explicitly
-- sets it.
