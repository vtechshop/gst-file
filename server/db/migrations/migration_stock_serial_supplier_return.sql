-- =====================================================================
-- RETURNED_TO_SUPPLIER
--
-- A unit sent back to the supplier it came from. It has left our
-- inventory: it is not stock, not sellable, not movable, and not the same
-- thing as a customer's return.
--
-- RETURNED is deliberately NOT reused for this. That state means "a
-- customer sent it back and nobody has looked at it yet" — goods on our
-- premises awaiting inspection, which may well go back on the shelf.
-- Goods returned to a supplier are gone. One word for both would make the
-- Serial Numbers list unable to answer "what do we actually hold".
--
-- Terminal, unless the same unit is bought again later — which arrives as
-- a new purchase and is a new row, because it is a new acquisition.
-- =====================================================================

-- Widening a CHECK means replacing it: Postgres has no ALTER CONSTRAINT
-- for the expression. Nothing is dropped but the rule itself, and the
-- replacement admits every value the old one did.
ALTER TABLE stock_serials DROP CONSTRAINT IF EXISTS stock_serials_status_check;

ALTER TABLE stock_serials ADD CONSTRAINT stock_serials_status_check
  CHECK (status IN ('AVAILABLE','SOLD','RETURNED','RETURNED_TO_SUPPLIER','DAMAGED','SCRAPPED'));

-- Which purchase return sent it back, by the same stable-header rule the
-- rest of the table follows: purchase_returns.id, never a line id.
-- purchase_return_items is deleted and re-inserted on every save, exactly
-- as purchase_items and invoice_items are.
ALTER TABLE stock_serials
  ADD COLUMN IF NOT EXISTS supplier_return_type TEXT,
  ADD COLUMN IF NOT EXISTS supplier_return_id UUID;

CREATE INDEX IF NOT EXISTS idx_stock_serials_supplier_return
  ON stock_serials (user_id, supplier_return_type, supplier_return_id)
  WHERE supplier_return_id IS NOT NULL;

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No existing row is touched. Nothing currently holds the new state, and
-- no unit is reclassified by this migration: it only makes the state
-- expressible. The status of every existing serial is exactly what it was.
