-- =============================================
-- Phase 2, Module 1 — GST registration details
-- =============================================
-- What a GST return needs to know about the filer itself, beyond a GSTIN
-- and a state. Every column here is new and nullable or defaulted, so an
-- existing profile is unchanged and every existing invoice, report and
-- return behaves exactly as it did.
--
-- Nothing in this migration is read by the GSTR-1 exporter yet. It is
-- storage and screen only; the sections that consume it (6A exports,
-- SEZ supplies, section 9(5) e-commerce) arrive in their own modules,
-- each with its own tests. Landing the fields first means those modules
-- do not have to change the profile and the return in one step.
--
-- Safe to run more than once.

-- ── Identity ────────────────────────────────
-- GST distinguishes the legal name (as on the PAN) from the trade name
-- (as the business is known). business_name above stays exactly what it
-- is — the name already printed on every invoice — and is used as the
-- fallback for both, so nothing changes for a profile that never fills
-- these in.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trade_name TEXT;

-- Proprietorship, Partnership, LLP, Private Limited, Public Limited,
-- HUF, Society/Trust, Government Department, Public Sector Undertaking.
-- Free text rather than a CHECK constraint: the Portal's list has
-- changed before and a schema migration is a poor way to track it.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_constitution TEXT;

-- ── Registration type ───────────────────────
-- Drives what the business may and must file. 'regular' is the default
-- because it is what every existing profile is — they have been filing
-- GSTR-1, which is a regular-registration return.
--
--   regular        normal registration, files GSTR-1 / GSTR-3B
--   composition    files CMP-08 and GSTR-4, NOT GSTR-1, and issues a
--                  Bill of Supply rather than a tax invoice
--   casual         casual taxable person
--   sez_unit       supplies are zero-rated
--   sez_developer  likewise
--   isd            input service distributor, files GSTR-6
--   tds            tax deductor, files GSTR-7
--   tcs            tax collector (e-commerce operator), files GSTR-8
--
-- Free text with a default rather than an enum, same reasoning as above.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS registration_type TEXT NOT NULL DEFAULT 'regular';

-- ── Exports ─────────────────────────────────
-- A Letter of Undertaking lets a business export without paying IGST.
-- Which one applies decides exp_typ in GSTR-1's 6A: WPAY (with payment)
-- or WOPAY (without). Recorded here so that section can be generated
-- from fact rather than from a question asked at export time.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS lut_number TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS lut_expiry DATE;
-- Importer Exporter Code — required on export documentation.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS iec_number TEXT;

-- ── Defaults that shape a document ──────────
-- The place of supply to assume when an invoice does not establish one
-- of its own. Blank means "the state of registration", which is what the
-- app already assumes, so leaving it blank changes nothing.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS default_pos TEXT;

-- Whether new invoices start with reverse charge on. FALSE is what every
-- existing invoice is.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reverse_charge_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Whether this business is required to issue e-invoices / e-way bills.
-- Deliberately a stored flag rather than a turnover threshold evaluated
-- in code: the thresholds are changed by notification, and a hardcoded
-- one silently becomes wrong. The business states its own position.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS einvoice_applicable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ewaybill_applicable BOOLEAN NOT NULL DEFAULT FALSE;

-- The financial year being worked in, as "2026-27". Used for defaulting
-- and for period labelling; it does not override the filing period,
-- which is still derived from the invoices in the return.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS financial_year TEXT;
