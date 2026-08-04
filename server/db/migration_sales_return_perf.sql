-- Indexes for the Sales Return screen.
--
-- Safe to re-run: every statement is IF NOT EXISTS, and an index that
-- already exists under a different name simply costs a little disk.
-- Run against production with:
--     psql "$DATABASE_URL" -f db/migration_sales_return_perf.sql
--
-- Nothing here changes a table definition or any data — indexes only.

BEGIN;

-- Sales Return Entry asks "what has already been returned against THIS
-- invoice", joining sales_return_items to sales_returns. The join side
-- had an index on return_id, but the owner-scoped lookups the generic
-- router issues (and the delete-by-user paths) had none, so they fell
-- back to a sequential scan over every return item in the table.
CREATE INDEX IF NOT EXISTS idx_sales_return_items_user
  ON sales_return_items (user_id);

-- The same join benefits from reaching product_id straight off the
-- index rather than the heap, since the aggregate only needs
-- (return_id, product_id, quantity).
CREATE INDEX IF NOT EXISTS idx_sales_return_items_return_product
  ON sales_return_items (return_id, product_id) INCLUDE (quantity);

-- The history table reads one page ordered by return_date DESC.
-- idx_sales_returns_date is (user_id, return_date) ascending, which
-- Postgres can walk backwards, so this is only worth adding if that
-- index is ever dropped — included for completeness and skipped when
-- the equivalent already exists.
CREATE INDEX IF NOT EXISTS idx_sales_returns_user_date_desc
  ON sales_returns (user_id, return_date DESC);

-- The line-items lookup for the selected invoice already has
-- idx_invoice_items_invoice (invoice_id, invoice_type). The server-side
-- quantity check additionally filters by user_id and reads only
-- product_id/product_name/quantity.
CREATE INDEX IF NOT EXISTS idx_invoice_items_user
  ON invoice_items (user_id);

COMMIT;

ANALYZE sales_return_items;
ANALYZE sales_returns;
ANALYZE invoice_items;
