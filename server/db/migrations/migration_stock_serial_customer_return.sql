-- =====================================================================
-- WHICH CUSTOMER RETURN BROUGHT A UNIT BACK
--
-- A unit can be sold, returned, inspected, sold again and returned again.
-- sold_source_* says which invoice last sold it; these say which sales
-- return last brought it back, so an edited or deleted return can give up
-- exactly the units it claimed and no others.
--
-- Header references, by the same rule as the rest of the table:
-- sales_returns.id, never sales_return_items.id. That table is deleted and
-- re-inserted on every save, exactly as invoice_items and purchase_items
-- are, so its ids do not survive an edit.
-- =====================================================================

ALTER TABLE stock_serials
  ADD COLUMN IF NOT EXISTS returned_source_type TEXT,
  ADD COLUMN IF NOT EXISTS returned_source_id UUID;

CREATE INDEX IF NOT EXISTS idx_stock_serials_returned_source
  ON stock_serials (user_id, returned_source_type, returned_source_id)
  WHERE returned_source_id IS NOT NULL;

-- ── Deliberately NOT done here ────────────────────────────────────────
-- Nothing existing is changed. No unit is reclassified, no status is
-- rewritten, and sold_source_* is left alone: a returned unit keeps the
-- record of which invoice sold it, because that is what a warranty claim
-- and a second return both need to know.
