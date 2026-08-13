-- ============================================================
-- Phase 2, Batch 8 — differential tax percentage, reverse charge on
--                    notes, e-commerce on B2CL, cess on notes
--
-- Additive only. Every column is nullable or defaults to the value that
-- reproduces today's behaviour. Re-runnable.
-- ============================================================

-- ── Module 20: differential percentage of tax ──────────────
-- A vehicle bought and leased before 1 July 2017 attracts GST at 65% of
-- the applicable rate. GSTR-1 carries that as `diff_percent`, an optional
-- field whose only accepted value is 0.65.
--
-- Stored as a boolean rather than the number, because there is exactly
-- one permitted value and storing 0.65 invites someone to store 0.5.
-- FALSE for every invoice already raised, which is what they all were.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS differential_65 BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS differential_65 BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cdn_notes    ADD COLUMN IF NOT EXISTS differential_65 BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Module 22: reverse charge on a credit or debit note ────
-- A note reversing a reverse-charge invoice is itself a reverse-charge
-- document. cdnr carries rchrg for exactly that, and it was being written
-- as 'N' for every note because there was nowhere to record otherwise.
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Module 21: e-commerce on a note ────────────────────────
-- A note against a supply made through an operator carries the operator's
-- GSTIN, the same way the invoice does.
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS ecom_gstin TEXT;
