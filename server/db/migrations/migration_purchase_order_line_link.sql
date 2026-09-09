-- =====================================================================
-- PURCHASE ITEM -> PURCHASE ORDER LINE
--
-- A purchase raised against an order already knows WHICH order it came
-- from (purchases.purchase_order_id). What it could not say was which
-- LINE of that order each of its own lines received against, so the
-- reversal had to match by product.
--
-- That is exact whenever a product appears once on an order, and
-- ambiguous when it appears twice - an order with two lines of Product A,
-- 5 and 5, receiving 6, cannot say from the data alone whether that was
-- 5+1 or 3+3. The order-level total was always right; the per-line split
-- was a guess. This column removes the guess.
--
-- ON DELETE SET NULL, deliberately.
--
--   purchase_order_items cascades from purchase_orders, so a CASCADE here
--   would mean deleting an order deletes the LINES OF PURCHASES made
--   against it - erasing bought-and-paid-for history because the order it
--   came from was tidied away. A purchase is an accounting record and
--   outlives the order that prompted it. SET NULL keeps the purchase and
--   its stock movement exactly as they were and drops only the link,
--   which is the same choice purchases.purchase_order_id already makes.
-- =====================================================================

ALTER TABLE purchase_items
  ADD COLUMN IF NOT EXISTS purchase_order_item_id UUID
    REFERENCES purchase_order_items(id) ON DELETE SET NULL;

-- The reversal path looks lines up by this column, and the receive path
-- counts what a line has already had against it. Partial so the index
-- carries only the rows that are actually linked: an ordinary purchase
-- has no order line and never appears here.
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_order_item
  ON purchase_items (purchase_order_item_id)
  WHERE purchase_order_item_id IS NOT NULL;

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No backfill. Existing purchase_items rows keep purchase_order_item_id
-- NULL, which is exactly what "this line was not received against a
-- known order line" means, and it is the truth for every purchase raised
-- before this column existed. Where a historical link could be inferred
-- unambiguously it still would not be recorded here: a backfill over live
-- rows is a separate decision from a schema change, and inventing a line
-- relationship that nobody recorded is the thing this column exists to
-- stop. See db/backfill/ for how that is handled when it is wanted.
--
-- Nothing about stock is touched. This column changes no balance and
-- writes no movement.
