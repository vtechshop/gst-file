-- =============================================
-- Invoice series migration — audit log
-- =============================================
-- Records every bulk change of invoice_source made by the Invoice Series
-- Migration tool: when, by whom, over which range, out of which series
-- and into which.
--
-- Why a log at all: moving an invoice between series changes which range
-- it is reported under in GSTR-1's Documents Issued table. The figures
-- filed do not change, but the document ranges do, and a return that has
-- been filed must be explainable afterwards. Without this there would be
-- no record that a range was ever moved, or by whom.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS invoice_series_migrations (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- The range the operator asked for, kept as typed. Not derived from the
  -- invoices found: "4 to 25 matched nothing" is itself worth recording.
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,

  -- Where the invoices came from, as a count per series
  -- ({"offline": 22}). A map rather than a single value because one range
  -- can legitimately span more than one series, and recording only the
  -- first would misstate what happened.
  old_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_source TEXT NOT NULL,

  -- How many invoices actually moved, and exactly which. The numbers are
  -- what an auditor asks for — "which documents were reclassified" is not
  -- answerable from a count.
  invoice_count INTEGER NOT NULL DEFAULT 0,
  invoice_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The log is read newest-first, per user.
CREATE INDEX IF NOT EXISTS idx_invoice_series_migrations_user
  ON invoice_series_migrations(user_id, created_at DESC);
