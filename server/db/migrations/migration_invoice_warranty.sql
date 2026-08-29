-- Warranty on tax invoices.
--
-- Descriptive only. Nothing here is read by any GST return, the Dashboard,
-- the ledgers, stock or the numbering books - a warranty is a promise about
-- the goods, not a figure on the tax document, so no existing total, tax
-- column or sequence is touched.
--
-- Every column is nullable with no default. An invoice raised before this
-- migration keeps NULL and renders exactly as it did: the PDF prints the
-- warranty block only when there is something to print. That is why no
-- backfill runs here - inventing "1 year" for historic sales would be
-- inventing a liability.
--
-- The period is stored as a MONTH COUNT rather than only an end date, so it
-- survives a change of invoice date: a row saying 6 still means six months,
-- where a stored end date would silently become wrong. warranty_until is
-- kept alongside it because the user may type an end date by hand, and that
-- typed date has to be what the document shows.

-- ── Invoice level ──
ALTER TABLE b2b_invoices
  ADD COLUMN IF NOT EXISTS warranty_period_months INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_start_date DATE,
  ADD COLUMN IF NOT EXISTS warranty_until DATE,
  ADD COLUMN IF NOT EXISTS warranty_terms TEXT;

ALTER TABLE b2c_invoices
  ADD COLUMN IF NOT EXISTS warranty_period_months INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_start_date DATE,
  ADD COLUMN IF NOT EXISTS warranty_until DATE,
  ADD COLUMN IF NOT EXISTS warranty_terms TEXT;

-- ── Item level ──
-- Only the period. A line's cover runs from the same sale as every other
-- line, so a per-item start date would be a second copy of the invoice's own
-- and could disagree with it; the end date follows from the two and is
-- computed for display rather than stored twice. Per-item terms are not
-- added either - the conditions are written once for the sale.
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS warranty_period_months INTEGER;
