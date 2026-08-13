-- ============================================================
-- Phase 2, Batch 6 — cess, e-commerce supplies, HSN reporting level
--
-- Additive only: every new column is nullable or defaults to zero, so an
-- existing row means exactly what it meant before. Re-runnable.
-- ============================================================

-- ── Module 10: cess ────────────────────────────────────────
-- Compensation cess is charged on top of GST on a short list of goods
-- (tobacco, aerated drinks, coal, some motor vehicles). The rate has been
-- on the product master and the two cess columns have been on the invoice
-- LINES since before this batch — what was missing was a place to total
-- it on the document, which is why it never reached the return.
--
-- Defaults to zero, so an invoice raised before this migration reports
-- exactly the cess it always did: none.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE cdn_notes    ADD COLUMN IF NOT EXISTS cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

-- ── Module 11: supplies through an e-commerce operator ─────
-- Two different things share the word "e-commerce" in GSTR-1:
--
--   * a supply MADE THROUGH an operator, where the supplier still pays
--     the tax and the operator collects TCS. The operator's GSTIN goes on
--     the invoice as `etin`.
--   * a supply notified under section 9(5) — passenger transport,
--     accommodation, housekeeping, restaurant service — where the
--     OPERATOR pays the tax instead of the supplier.
--
-- They are reported differently, so they are recorded separately rather
-- than as one flag.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS ecom_gstin TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS ecom_supply_type TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS ecom_gstin TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS ecom_supply_type TEXT;

CREATE INDEX IF NOT EXISTS idx_b2b_invoices_ecom
  ON b2b_invoices(user_id, ecom_gstin) WHERE ecom_gstin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_ecom
  ON b2c_invoices(user_id, ecom_gstin) WHERE ecom_gstin IS NOT NULL;

-- ── Module 12: how many HSN digits this business must report ───
-- The requirement is driven by aggregate annual turnover: up to 5 crore
-- needs 4 digits (2 for B2C until it was tightened), above 5 crore needs
-- 6. Stated rather than inferred, for the same reason einvoice_applicable
-- is stated: the thresholds move, and a hardcoded one goes stale quietly.
--
-- NULL means "not stated", and nothing is enforced until it is set, so an
-- existing profile behaves exactly as it did.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hsn_digits_required SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS aggregate_turnover_band TEXT;

-- ── Module 14: what an amendment to a note will need ───────
-- A credit or debit note already records the invoice number it relates
-- to. The amendment sections (9C, cdnra/cdnura) additionally need the
-- original note's own number and date, and the period it was reported in.
--
-- Captured now, emitted never — the amendment sections stay switched off
-- until a Utility export settles their shape. Capturing it now means
-- switching them on later needs no re-entry of documents already issued.
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS original_invoice_date DATE;
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS original_period TEXT;
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS original_note_number TEXT;
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS original_note_date DATE;
