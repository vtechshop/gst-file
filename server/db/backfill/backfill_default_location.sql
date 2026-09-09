-- =====================================================================
-- BACKFILL — default location, and existing stock reconciled into it
--
-- THIS IS NOT A MIGRATION. It is not in _manifest.json and the migrator
-- will never run it. It changes DATA in live rows, which is a different
-- kind of decision from changing a schema, and it is kept separate so it
-- can be read, costed and approved on its own.
--
-- What it does, per tenant that has at least one stock-tracked product:
--
--   1. Create ONE location, "Main Warehouse", marked default - but only
--      if that tenant has no locations at all. A tenant that has already
--      set its own locations up is left completely alone.
--
--   2. For every product with products.stock IS NOT NULL, create the
--      stock_balances row for that default location holding exactly the
--      quantity products.stock already says.
--
-- What it deliberately does NOT do:
--
--   - It writes NO stock_movements. The stock being placed has no history
--     to describe; inventing OPENING rows for it would fabricate a date
--     and a quantity nobody recorded, which is the same rule Phase 1
--     froze. The ledger keeps saying NO_LEDGER_HISTORY for these
--     products, because that is still the truth about them.
--
--   - It changes no products.stock value. Company totals are identical
--     before and after: this only says WHERE the existing total is.
--
--   - It touches no invoice, purchase, return or warranty.
--
-- Re-runnable. Every statement is guarded, so running it twice places
-- nothing twice.
-- =====================================================================

BEGIN;

-- 1) One default location per tenant, only where none exists yet.
INSERT INTO stock_locations (user_id, name, code, is_default, active)
SELECT DISTINCT p.user_id, 'Main Warehouse', 'MAIN', TRUE, TRUE
  FROM products p
 WHERE p.stock IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM stock_locations l WHERE l.user_id = p.user_id
   );

-- 2) Place each tracked product's existing total in that tenant's default
--    location. ON CONFLICT DO NOTHING makes a second run a no-op rather
--    than a double placement.
INSERT INTO stock_balances (user_id, product_id, location_id, quantity)
SELECT p.user_id, p.id, l.id, p.stock
  FROM products p
  JOIN stock_locations l
    ON l.user_id = p.user_id AND l.is_default
 WHERE p.stock IS NOT NULL
ON CONFLICT (user_id, product_id, location_id) DO NOTHING;

-- 3) Prove it before committing. If any tenant's location balances fail to
--    add up to its products.stock, the whole thing rolls back rather than
--    leaving the two disagreeing.
DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
  FROM (
    SELECT p.id
      FROM products p
      LEFT JOIN stock_balances b ON b.product_id = p.id AND b.user_id = p.user_id
     WHERE p.stock IS NOT NULL
     GROUP BY p.id, p.stock
    HAVING COALESCE(SUM(b.quantity), -1) <> p.stock
  ) q;

  IF bad > 0 THEN
    RAISE EXCEPTION 'Backfill aborted: % product(s) do not reconcile with their location balances', bad;
  END IF;
END $$;

COMMIT;
