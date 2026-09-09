-- =====================================================================
-- BACKFILL — purchase line -> purchase order line, where it is certain
--
-- THIS IS NOT A MIGRATION. It is not in _manifest.json and the migrator
-- will never run it. It changes DATA in live rows, which is a different
-- kind of decision from changing a schema, and it is kept separate so it
-- can be read, costed and approved on its own.
--
-- purchase_items.purchase_order_item_id was added after some purchases had
-- already been raised against orders. Those rows know their ORDER but not
-- the LINE of it, and this fills that in — but only where the answer is
-- not a guess.
--
-- What it does, for a purchase line that has an order but no order line:
--
--   Links it to the order's line IF AND ONLY IF exactly one line of that
--   order carries the same product. One candidate is an answer; anything
--   else is not.
--
-- What it deliberately does NOT do:
--
--   - It leaves a line alone when its order has SEVERAL lines of that
--     product. An order with Product A twice, 5 and 5, that received 6,
--     does not record whether that was 5+1 or 3+3, and writing either
--     would be inventing a relationship nobody recorded — which is the
--     very thing the column exists to stop. Those rows keep NULL, and
--     NULL correctly means "not known", not "not linked".
--
--   - It leaves a line alone when NO line of the order carries that
--     product. That is a data fault to look at, not to paper over.
--
--   - It touches no quantity. received_quantity on the order is already
--     whatever the receipts made it; this only records which line each
--     historical receipt line belonged to. No stock, no balance, no
--     movement, no total changes.
--
--   - It touches nothing that already has a link, so a second run places
--     nothing twice.
--
-- Re-runnable, and reports what it did.
-- =====================================================================

BEGIN;

-- Counted before, so the report at the end can say what actually moved.
CREATE TEMP TABLE _po_link_before ON COMMIT DROP AS
SELECT
  COUNT(*) FILTER (WHERE pi.purchase_order_item_id IS NULL)     AS unlinked,
  COUNT(*) FILTER (WHERE pi.purchase_order_item_id IS NOT NULL) AS linked
FROM purchase_items pi
JOIN purchases p ON p.id = pi.purchase_id AND p.user_id = pi.user_id
WHERE p.purchase_order_id IS NOT NULL;

-- The one update. The correlated count is what makes it safe: a line is
-- written only when the order has exactly one line of that product, so an
-- ambiguous case cannot be reached from here at all.
--
-- Scoped by user_id on both sides as well as by the order, so a link can
-- never be formed across tenants.
UPDATE purchase_items pi
   SET purchase_order_item_id = (
     SELECT poi.id
       FROM purchase_order_items poi
      WHERE poi.purchase_order_id = p.purchase_order_id
        AND poi.user_id = pi.user_id
        AND poi.product_id IS NOT DISTINCT FROM pi.product_id
      LIMIT 1)
  FROM purchases p
 WHERE p.id = pi.purchase_id
   AND p.user_id = pi.user_id
   AND p.purchase_order_id IS NOT NULL
   AND pi.purchase_order_item_id IS NULL
   AND (
     SELECT COUNT(*)
       FROM purchase_order_items poi
      WHERE poi.purchase_order_id = p.purchase_order_id
        AND poi.user_id = pi.user_id
        AND poi.product_id IS NOT DISTINCT FROM pi.product_id
   ) = 1;

-- Say what happened, including what was deliberately left alone. A silent
-- backfill that skipped rows would look exactly like one that had nothing
-- to skip.
DO $$
DECLARE
  still_unlinked INTEGER;
  ambiguous      INTEGER;
  unmatched      INTEGER;
  now_linked     INTEGER;
  was_unlinked   INTEGER;
BEGIN
  SELECT unlinked INTO was_unlinked FROM _po_link_before;

  SELECT COUNT(*) INTO still_unlinked
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id AND p.user_id = pi.user_id
   WHERE p.purchase_order_id IS NOT NULL AND pi.purchase_order_item_id IS NULL;

  SELECT COUNT(*) INTO ambiguous
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id AND p.user_id = pi.user_id
   WHERE p.purchase_order_id IS NOT NULL AND pi.purchase_order_item_id IS NULL
     AND (SELECT COUNT(*) FROM purchase_order_items poi
           WHERE poi.purchase_order_id = p.purchase_order_id
             AND poi.user_id = pi.user_id
             AND poi.product_id IS NOT DISTINCT FROM pi.product_id) > 1;

  SELECT COUNT(*) INTO unmatched
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id AND p.user_id = pi.user_id
   WHERE p.purchase_order_id IS NOT NULL AND pi.purchase_order_item_id IS NULL
     AND (SELECT COUNT(*) FROM purchase_order_items poi
           WHERE poi.purchase_order_id = p.purchase_order_id
             AND poi.user_id = pi.user_id
             AND poi.product_id IS NOT DISTINCT FROM pi.product_id) = 0;

  now_linked := was_unlinked - still_unlinked;

  RAISE NOTICE 'purchase order line backfill:';
  RAISE NOTICE '  linked now (exactly one candidate) : %', now_linked;
  RAISE NOTICE '  left NULL, several candidates      : %', ambiguous;
  RAISE NOTICE '  left NULL, no candidate at all     : %', unmatched;

  IF still_unlinked <> ambiguous + unmatched THEN
    RAISE EXCEPTION 'Backfill aborted: % rows are still unlinked but only % are explained',
      still_unlinked, ambiguous + unmatched;
  END IF;
END $$;

COMMIT;
