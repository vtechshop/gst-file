-- =====================================================================
-- Export invoices priced in a foreign currency
--
-- An export is already a first-class invoice here: export_type (WPAY /
-- WOPAY), port_code, the shipping bill, export_of and lut_number have
-- existed since Batch 5/7. What was missing is the money. An exporter
-- bills the buyer in USD, EUR or AED, while GST is reported in rupees at
-- the rate on the invoice date (Rule 34 of the CGST Rules).
--
-- Both figures are facts, and neither is derivable from the other without
-- loss, so both are stored.
--
-- The rupee columns do not move
-- -----------------------------
-- taxable_amount, gst_amount, total_amount, igst/cgst/sgst and every
-- invoice_items money column keep meaning exactly what they have always
-- meant: INR. GSTR-1, GSTR-3B, the payment ledger, the customer ledger,
-- receivables and every dashboard read them, and all of those are rupee
-- accounts. An export invoice stores the converted rupee value there -
-- foreign amount x exchange_rate - so not one of those consumers needs to
-- know this feature exists.
--
-- The fx_* columns hold what the buyer was actually billed, in the
-- invoice's own currency. They are never used for tax, never totalled
-- across currencies, and never overwritten by the rupee figures.
--
-- NULL, not 0, and no backfill
-- ----------------------------
-- NULL currency_code means "this invoice is in rupees" - which is what
-- every invoice that already exists is. Nothing here reads or writes a
-- single existing row, and an invoice saved by the previous version of
-- the app is byte-for-byte the row it was.
--
-- exchange_rate is NUMERIC(14,6): rupees per ONE unit of the currency
-- (1 USD = 83.250000). Six decimals because a rate quoted for a weak
-- currency - IDR, VND - needs them, and a rate is a rate rather than
-- money, so it is not rounded to paise.
-- =====================================================================

ALTER TABLE b2b_invoices
  ADD COLUMN IF NOT EXISTS currency_code TEXT,
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14,6),
  ADD COLUMN IF NOT EXISTS fx_taxable_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_gst_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_total_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS destination_country TEXT;

ALTER TABLE b2c_invoices
  ADD COLUMN IF NOT EXISTS currency_code TEXT,
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14,6),
  ADD COLUMN IF NOT EXISTS fx_taxable_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_gst_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_total_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS destination_country TEXT;

-- The line, in the currency the line was quoted in. rate stays the rupee
-- rate the rest of the app reads; fx_rate is what the buyer sees.
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_taxable_value NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_total_amount NUMERIC(15,2);

-- A currency without a rate cannot be converted, and a rate without a
-- currency converts nothing: half a conversion is never a valid row. A rate
-- is strictly positive - zero would make every rupee figure zero - and a
-- billed amount cannot be negative in any currency.
--
-- Each one is added only when it is absent, so this file can be re-run, and
-- can finish a half-applied schema, without rewriting anything already
-- there. Every existing row has these columns NULL, which satisfies all
-- three, so validation reads nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'b2b_invoices_currency_pair') THEN
    ALTER TABLE b2b_invoices
      ADD CONSTRAINT b2b_invoices_currency_pair
      CHECK ((currency_code IS NULL AND exchange_rate IS NULL)
          OR (currency_code IS NOT NULL AND exchange_rate IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'b2b_invoices_exchange_rate_positive') THEN
    ALTER TABLE b2b_invoices
      ADD CONSTRAINT b2b_invoices_exchange_rate_positive
      CHECK (exchange_rate IS NULL OR exchange_rate > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'b2b_invoices_fx_amounts_nonneg') THEN
    ALTER TABLE b2b_invoices
      ADD CONSTRAINT b2b_invoices_fx_amounts_nonneg
      CHECK ((fx_taxable_amount IS NULL OR fx_taxable_amount >= 0)
         AND (fx_gst_amount IS NULL OR fx_gst_amount >= 0)
         AND (fx_total_amount IS NULL OR fx_total_amount >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'b2c_invoices_currency_pair') THEN
    ALTER TABLE b2c_invoices
      ADD CONSTRAINT b2c_invoices_currency_pair
      CHECK ((currency_code IS NULL AND exchange_rate IS NULL)
          OR (currency_code IS NOT NULL AND exchange_rate IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'b2c_invoices_exchange_rate_positive') THEN
    ALTER TABLE b2c_invoices
      ADD CONSTRAINT b2c_invoices_exchange_rate_positive
      CHECK (exchange_rate IS NULL OR exchange_rate > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'b2c_invoices_fx_amounts_nonneg') THEN
    ALTER TABLE b2c_invoices
      ADD CONSTRAINT b2c_invoices_fx_amounts_nonneg
      CHECK ((fx_taxable_amount IS NULL OR fx_taxable_amount >= 0)
         AND (fx_gst_amount IS NULL OR fx_gst_amount >= 0)
         AND (fx_total_amount IS NULL OR fx_total_amount >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoice_items_fx_amounts_nonneg') THEN
    ALTER TABLE invoice_items
      ADD CONSTRAINT invoice_items_fx_amounts_nonneg
      CHECK ((fx_rate IS NULL OR fx_rate >= 0)
         AND (fx_taxable_value IS NULL OR fx_taxable_value >= 0)
         AND (fx_total_amount IS NULL OR fx_total_amount >= 0));
  END IF;
END
$$;

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No UPDATE. No backfill. No DEFAULT. Every invoice that exists keeps
-- currency_code NULL, which is what it has always meant - an invoice in
-- rupees - and its stored taxable_amount, gst_amount and total_amount are
-- untouched.
--
-- proforma_invoices is deliberately absent: a quotation is not an export
-- document here, and a table that cannot store a currency cannot silently
-- lose one either.
