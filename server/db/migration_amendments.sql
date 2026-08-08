-- ============================================================
-- Phase 2, Batch 7 — SEZ/export supporting data, credit-note supply
--                    nature, and a real amendment workflow
--
-- Additive only. Every new column is nullable or defaults to the value
-- that reproduces today's behaviour. Re-runnable.
-- ============================================================

-- ── Module 15: what a credit or debit note is issued against ───
-- A note against an export or an SEZ supply is not a B2CL note, and a
-- note against an SEZ supply carries an inv_typ the way the invoice does.
-- Until now every note was reported as though it were an ordinary
-- domestic one, because there was nowhere to say otherwise.
--
--   regular | expwp | expwop | sezwp | sezwop | de
--
-- 'regular' is the default, so every note already issued keeps meaning
-- exactly what it meant.
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS supply_nature TEXT NOT NULL DEFAULT 'regular';
-- Which invoice the note reverses, kept as an id AND as written text: the
-- invoice may be edited later, and the note must still say what it was
-- issued against.
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS original_invoice_id UUID;
ALTER TABLE cdn_notes ADD COLUMN IF NOT EXISTS original_invoice_table TEXT;

-- ── Module 19: SEZ and export supporting data ──────────────
-- An SEZ supply can be to a unit or to a developer, and an export can be
-- of goods (which has a shipping bill) or of services (which does not).
-- Both are reported the same way today but are asked for separately on
-- the portal, and neither could be recorded here at all.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS sez_recipient_type TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS sez_recipient_type TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS export_of TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS export_of TEXT;
-- The LUT in force when the invoice was raised, copied onto it. The
-- profile's LUT can be replaced next year; a return already filed must
-- not change because of that.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS lut_number TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS lut_number TEXT;

-- ── Modules 17 & 18: amendments to an already-filed return ─
-- An amendment is not an edit. The original figures were filed and remain
-- filed; the amendment says what they should have been, and both the
-- original period and the amending period matter. So an amendment is its
-- own record rather than a change to the document it amends.
--
-- One table for every amendable section, because the shape is the same
-- for all of them — what differs is only which section the row feeds,
-- which `section` names.
CREATE TABLE IF NOT EXISTS gst_amendments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- Which GSTR-1 section this amends: 'b2b' | 'b2cl' | 'b2cs' | 'cdnr'
  -- | 'cdnur' | 'at' | 'txpd'. Named rather than inferred, because the
  -- same original document can be amended in more than one way.
  section TEXT NOT NULL,
  -- The return period being amended ("062026") and the one it is being
  -- amended IN. Both are needed: the amendment appears in the second and
  -- refers to the first.
  original_period TEXT NOT NULL,
  amendment_period TEXT NOT NULL,

  -- What is being amended, as filed.
  original_document_id UUID,
  original_document_table TEXT,
  original_number TEXT,
  original_date DATE,

  -- What it should have said. A revised number and date are allowed
  -- because an amendment may correct them.
  revised_number TEXT,
  revised_date DATE,
  party_gstin TEXT,
  party_name TEXT,
  place_of_supply TEXT,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  inv_typ TEXT NOT NULL DEFAULT 'R',
  note_type TEXT,
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,

  taxable_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,

  reason TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gst_amendments_period
  ON gst_amendments(user_id, amendment_period);
CREATE INDEX IF NOT EXISTS idx_gst_amendments_section
  ON gst_amendments(user_id, section, original_period);

DROP TRIGGER IF EXISTS gst_amendments_upd ON gst_amendments;
CREATE TRIGGER gst_amendments_upd BEFORE UPDATE ON gst_amendments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
