-- =============================================
-- Per-series invoice number formats
-- =============================================
-- Each numbering book gets its own format, not just its own counter:
-- the shop counting 171, 172, 173 while the website issues W-00001,
-- W-00002 and a marketplace issues A-00001.
--
-- Deliberately a new column rather than a change to any existing one:
--
--   invoice_number_format     stays the OFFLINE / SHOP format. It is
--                             already the only format a business has,
--                             so every existing profile keeps issuing
--                             exactly the numbers it issued yesterday.
--   invoice_current_sequence  stays the offline counter, likewise.
--   invoice_series_sequences  stays the per-series counters.
--
-- so nothing needs backfilling and no invoice already issued is affected.
--
-- Safe to run more than once.

-- Format per series, keyed the same way invoice_series_sequences is:
-- {"online": "W-#####", "amazon": "A-#####"}. The offline series is
-- absent by design — its format lives in invoice_number_format above.
--
-- Free text, and NOT constrained to a known set of series: a business
-- that starts selling through another channel gets to number that
-- channel its own way without a schema change.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invoice_series_formats JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Uniqueness is per series, because that is what a numbering book means.
--
-- The old index was (user_id, invoice_number) — unique across every
-- series at once. That was right when a business had one book, and wrong
-- the moment it had two: a shop at 138 and a website starting at 1 will
-- both reach 5, and those are two different documents in two different
-- books. Worse, POST /invoices/reserve-number already counts per series,
-- so it would hand out a number the database then refused to store.
--
-- The replacement is strictly weaker, so it can always be built wherever
-- the old one held: anything the old index permitted, this permits too.
DROP INDEX IF EXISTS idx_b2b_invoices_number_active;
DROP INDEX IF EXISTS idx_b2c_invoices_number_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_invoices_number_series
  ON b2b_invoices(user_id, invoice_source, invoice_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2c_invoices_number_series
  ON b2c_invoices(user_id, invoice_source, invoice_number);
