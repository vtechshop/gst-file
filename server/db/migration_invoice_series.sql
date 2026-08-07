-- =============================================
-- Multiple invoice series
-- =============================================
-- A business can run more than one numbering series at once: the shop
-- counter issuing 138, 139, 140 while the website issues 4, 5, 6. Both
-- are outward supplies and belong in the same return, but GSTR-1's
-- "Documents Issued" table reports each series separately — one series
-- reported as 4 to 170 would claim 167 documents that were never issued.
--
-- Safe to run more than once.

-- Which series an invoice belongs to. Deliberately free text and NOT
-- constrained to a fixed list: a business that later sells through
-- Amazon, Flipkart or a second POS gets those series reported without a
-- schema change.
--
-- 'offline' is the default, so every invoice that already exists — none
-- of which carries a source — becomes part of the shop series, which is
-- what it was.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS invoice_source TEXT NOT NULL DEFAULT 'offline';
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS invoice_source TEXT NOT NULL DEFAULT 'offline';

-- Auto-numbering keeps one counter per series. invoice_current_sequence
-- on profiles stays as it is and continues to drive the offline series,
-- so a business already using Auto Generate sees no change in the numbers
-- it issues; other series get their own counters in here.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invoice_series_sequences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Series is part of how invoices are looked up for a return.
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_source ON b2b_invoices(user_id, invoice_source);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_source ON b2c_invoices(user_id, invoice_source);
