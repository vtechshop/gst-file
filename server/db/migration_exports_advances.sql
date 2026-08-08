-- ============================================================
-- Phase 2, Batch 5 — exports, advances, advance adjustments,
--                    bill of supply
--
-- Additive only: new columns are nullable and new tables are new. No
-- existing column is altered or dropped, and nothing here changes what an
-- existing row means. Re-runnable — every statement is guarded and the
-- triggers are dropped before being recreated.
-- ============================================================

-- ── Module 5: export invoices (GSTR-1 Table 6A, `exp`) ──────
-- An export is not a different kind of invoice, it is an invoice with a
-- shipping bill against it, so the columns go on the invoice rather than
-- into a table of their own. All four are nullable: an invoice with no
-- export_type is exactly the invoice it was before this migration, and
-- the exporter routes on export_type being present.
--
--   WPAY  — exported on payment of IGST, refund claimed later
--   WOPAY — exported under a LUT or bond, no IGST charged
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS export_type TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS shipping_bill_number TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS shipping_bill_date DATE;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS port_code TEXT;

ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS export_type TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS shipping_bill_number TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS shipping_bill_date DATE;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS port_code TEXT;

CREATE INDEX IF NOT EXISTS idx_b2b_invoices_export
  ON b2b_invoices(user_id, export_type) WHERE export_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_export
  ON b2c_invoices(user_id, export_type) WHERE export_type IS NOT NULL;

-- ── Module 7: advance adjustments (GSTR-1 Table 11B, `txpd`) ─
-- Table 11A reports advances received in the period; 11B reports advances
-- ADJUSTED against invoices in the period. The receipt voucher already
-- carries a running adjusted_amount, but a running total has no date, and
-- 11B is a question about a period. So each adjustment is its own dated
-- row and the running total stays as a convenience.
CREATE TABLE IF NOT EXISTS advance_adjustments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  receipt_voucher_id UUID REFERENCES receipt_vouchers(id) ON DELETE CASCADE NOT NULL,
  -- Which invoice the advance was applied to. Kept as text as well as an
  -- id because the invoice may be edited or removed later and the
  -- adjustment still has to say what it was applied to.
  invoice_id UUID,
  invoice_table TEXT,
  invoice_number TEXT,
  invoice_date DATE,
  -- The date that decides which return this adjustment falls in.
  adjusted_on DATE NOT NULL,
  -- Copied from the receipt voucher at the time of adjustment, so a
  -- voucher corrected later cannot change a return already filed — the
  -- same rule the invoice lines follow.
  place_of_supply TEXT NOT NULL,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  adjusted_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advance_adjustments_date
  ON advance_adjustments(user_id, adjusted_on);
CREATE INDEX IF NOT EXISTS idx_advance_adjustments_voucher
  ON advance_adjustments(receipt_voucher_id);

-- ── Module 9: bill of supply (GSTR-1 Table 8, `nil`) ────────
-- Issued INSTEAD of a tax invoice by a composition dealer or a supplier
-- of exempt goods. No tax is charged, so there is no tax column here —
-- the value is the supply. It shares Table 13 row 1 with tax invoices
-- because that table reports numbering series, not tax status.
CREATE TABLE IF NOT EXISTS bill_of_supply (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  party_name TEXT NOT NULL,
  party_gstin TEXT,
  place_of_supply TEXT,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  -- Which of the three the supply is, because Table 8 splits them:
  -- 'exempted' | 'nil_rated' | 'non_gst'
  supply_nature TEXT NOT NULL DEFAULT 'exempted',
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  reason TEXT,
  notes TEXT,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_of_supply_number
  ON bill_of_supply(user_id, document_series, document_number);
CREATE INDEX IF NOT EXISTS idx_bill_of_supply_date
  ON bill_of_supply(user_id, document_date);

CREATE TABLE IF NOT EXISTS bill_of_supply_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  bill_of_supply_id UUID REFERENCES bill_of_supply(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT,
  quantity DECIMAL(15,3) NOT NULL DEFAULT 1,
  rate DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_treatment TEXT NOT NULL DEFAULT 'exempted',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bill_of_supply_items_doc
  ON bill_of_supply_items(bill_of_supply_id, sort_order);

-- ── updated_at triggers ─────────────────────────────────────
DROP TRIGGER IF EXISTS advance_adjustments_upd ON advance_adjustments;
CREATE TRIGGER advance_adjustments_upd BEFORE UPDATE ON advance_adjustments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS bill_of_supply_upd ON bill_of_supply;
CREATE TRIGGER bill_of_supply_upd BEFORE UPDATE ON bill_of_supply FOR EACH ROW EXECUTE FUNCTION update_updated_at();
