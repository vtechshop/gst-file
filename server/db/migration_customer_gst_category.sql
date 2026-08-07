-- =============================================
-- Phase 2, Module 2 — customer GST category
-- =============================================
-- What kind of recipient a supply is made to. This is what decides which
-- GSTR-1 table an invoice appears in and what inv_typ it carries:
--
--   regular / composition / government / uin  -> 4A, inv_typ 'R'
--   sez_unit / sez_developer                  -> 4B, inv_typ 'SEWP' or 'SEWOP'
--   deemed_export                             -> 6C, inv_typ 'DE'
--   export                                    -> 6A (its own section)
--   unregistered / consumer                   -> 5 (B2CL) or 7 (B2CS)
--
-- 'regular' is the default because it is what every existing customer
-- and every existing invoice is: they have been reported in 4A with
-- inv_typ 'R', and they will continue to be, byte for byte.
--
-- Safe to run more than once. Purely additive: no column is renamed,
-- retyped or dropped, and no existing row needs touching.

-- ── Customer master ─────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gst_category TEXT NOT NULL DEFAULT 'regular';

-- PAN, for customers whose GSTIN is not held (exports, deemed export
-- documentation) and for reconciliation.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pan TEXT;

-- Exports have a country rather than a state. Blank means India, which
-- is what every existing customer is.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS country TEXT;

-- Place of supply is normally derived — from the customer's GSTIN for a
-- registered recipient, from their state otherwise. This overrides it
-- for the cases where the supply is made somewhere else: goods delivered
-- to a third party's premises, services performed at another location.
-- Blank means "derive it as before", so an unset value changes nothing.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS place_of_supply TEXT;

-- Bill-to is the existing address/state columns, untouched. Ship-to is
-- separate because they genuinely differ, and when they do it is the
-- ship-to state that fixes the place of supply for goods.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shipping_address TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shipping_state TEXT;

-- ── The invoice carries its own classification ──
-- Deliberately stored on the invoice rather than looked up from the
-- customer master at export time. A return that has been filed must not
-- change because a master record was edited afterwards: if a customer
-- becomes an SEZ unit in September, the invoices raised to them in July
-- were not SEZ supplies and must keep being reported as they were filed.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS gst_category TEXT NOT NULL DEFAULT 'regular';
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS gst_category TEXT NOT NULL DEFAULT 'regular';

-- Reported per category in several places, and filtered by it in others.
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_category ON b2b_invoices(user_id, gst_category);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_category ON b2c_invoices(user_id, gst_category);
CREATE INDEX IF NOT EXISTS idx_customers_category ON customers(user_id, gst_category);
