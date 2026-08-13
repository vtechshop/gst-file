-- =============================================
-- Phase 2, Module 3A — Product Master completion
-- =============================================
-- The Product Master is a mirror of the company website: every sync run
-- overwrites name, hsn_code, unit, gst_percentage, type, rate, stock and
-- the rest from the remote feed. That is correct for a catalogue, and
-- fatal for GST, because it means a unit corrected in this application
-- survives only until the next sync — which is why five products have
-- had no unit for months and the Portal keeps rejecting their lines
-- (RET191353: a goods line with no unit).
--
-- Rather than stop sync overwriting anything, or fork the catalogue,
-- corrections are kept beside the synced values and win over them.
--
-- Safe to run more than once. Additive only.

-- GST fields the operator has explicitly corrected, as
-- {"unit":"NOS","hsn_code":"84386000","gst_percentage":18,"type":"goods"}.
--
-- Sync does not write this column, so a correction survives every sync.
-- A key that is absent means "no correction" and the synced value is
-- used, so an untouched product behaves exactly as it always has.
--
-- Deliberately one JSONB column rather than four *_override columns:
-- the set of correctable fields will grow, and "is there a correction
-- for this field" is a question about presence, which a JSON key answers
-- and a NULL column does not (NULL is also a legitimate corrected value
-- for a text field).
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Composite and mixed supply, which decide which rate a bundle carries:
--
--   none       an ordinary single supply
--   composite  naturally bundled, supplied together in the ordinary
--              course of business, one of them principal — the whole
--              bundle takes the PRINCIPAL supply's rate
--   mixed      two or more supplies for a single price, not naturally
--              bundled — the whole bundle takes the HIGHEST rate of any
--              component
--
-- Recorded so the rate on a bundle can be checked against the rule
-- rather than taken on trust. 'none' is what every existing product is.
ALTER TABLE products ADD COLUMN IF NOT EXISTS supply_bundle TEXT NOT NULL DEFAULT 'none';

-- For a composite supply, the rate of the principal supply — the rate
-- the whole bundle should carry. NULL for anything else.
ALTER TABLE products ADD COLUMN IF NOT EXISTS principal_gst_rate DECIMAL(5,2);
