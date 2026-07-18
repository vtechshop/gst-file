-- =============================================
-- GST Invoice & GSTR-1 Management System
-- Supabase Database Schema
-- =============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles (linked to Supabase Auth users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  name TEXT,
  email TEXT,
  gstin TEXT,
  business_name TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  bank_name TEXT,
  bank_account_no TEXT,
  bank_ifsc TEXT,
  bank_branch TEXT,
  upi_id TEXT,
  logo_base64 TEXT,
  seal_base64 TEXT,
  signature_base64 TEXT,
  qr_base64 TEXT,
  header_color TEXT,
  footer_text TEXT,
  terms_conditions TEXT,
  pan TEXT,
  website TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B2B Invoices
CREATE TABLE IF NOT EXISTS b2b_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  gst_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B2C Invoices
CREATE TABLE IF NOT EXISTS b2c_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  state TEXT NOT NULL,
  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  invoice_date DATE DEFAULT CURRENT_DATE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B2B HSN
CREATE TABLE IF NOT EXISTS b2b_hsn (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  hsn_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('goods','service')),
  quantity DECIMAL(15,3) DEFAULT 0,
  taxable_value DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  total_gst DECIMAL(15,2) NOT NULL,
  total_invoice_value DECIMAL(15,2) NOT NULL,
  entry_date DATE DEFAULT CURRENT_DATE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B2C HSN
CREATE TABLE IF NOT EXISTS b2c_hsn (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  hsn_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('goods','service')),
  taxable_value DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  total_gst DECIMAL(15,2) NOT NULL,
  total_invoice_value DECIMAL(15,2) NOT NULL,
  entry_date DATE DEFAULT CURRENT_DATE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customers (Customer Master)
CREATE TABLE IF NOT EXISTS customers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  gstin TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  state TEXT,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Credit / Debit Notes
CREATE TABLE IF NOT EXISTS cdn_notes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  note_type TEXT NOT NULL CHECK (note_type IN ('credit','debit')),
  note_number TEXT NOT NULL,
  note_date DATE NOT NULL,
  original_invoice TEXT,
  customer_name TEXT NOT NULL,
  gstin TEXT,
  reason TEXT,
  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Product Master
CREATE TABLE IF NOT EXISTS products (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  hsn_code TEXT,
  type TEXT NOT NULL DEFAULT 'goods' CHECK (type IN ('goods','service')),
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 18,
  default_rate DECIMAL(15,2) DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Remembered Excel import column mappings (one row per user per import type)
CREATE TABLE IF NOT EXISTS import_mappings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  import_type TEXT NOT NULL DEFAULT 'invoice_excel',
  mapping JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, import_type)
);

-- Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2c_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_hsn ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2c_hsn ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdn_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Own profile select" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Own profile insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Own profile update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- B2B policies
CREATE POLICY "Own b2b select" ON b2b_invoices FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own b2b insert" ON b2b_invoices FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own b2b update" ON b2b_invoices FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own b2b delete" ON b2b_invoices FOR DELETE USING (auth.uid() = user_id);

-- B2C policies
CREATE POLICY "Own b2c select" ON b2c_invoices FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own b2c insert" ON b2c_invoices FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own b2c update" ON b2c_invoices FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own b2c delete" ON b2c_invoices FOR DELETE USING (auth.uid() = user_id);

-- B2B HSN policies
CREATE POLICY "Own b2b_hsn select" ON b2b_hsn FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own b2b_hsn insert" ON b2b_hsn FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own b2b_hsn update" ON b2b_hsn FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own b2b_hsn delete" ON b2b_hsn FOR DELETE USING (auth.uid() = user_id);

-- B2C HSN policies
CREATE POLICY "Own b2c_hsn select" ON b2c_hsn FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own b2c_hsn insert" ON b2c_hsn FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own b2c_hsn update" ON b2c_hsn FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own b2c_hsn delete" ON b2c_hsn FOR DELETE USING (auth.uid() = user_id);

-- Customers policies
CREATE POLICY "Own customers select" ON customers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own customers insert" ON customers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own customers update" ON customers FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own customers delete" ON customers FOR DELETE USING (auth.uid() = user_id);

-- Credit/Debit note policies
CREATE POLICY "Own cdn_notes select" ON cdn_notes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own cdn_notes insert" ON cdn_notes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own cdn_notes update" ON cdn_notes FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own cdn_notes delete" ON cdn_notes FOR DELETE USING (auth.uid() = user_id);

-- Product master policies
CREATE POLICY "Own products select" ON products FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own products insert" ON products FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own products update" ON products FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own products delete" ON products FOR DELETE USING (auth.uid() = user_id);

-- Import mapping policies
CREATE POLICY "Own import_mappings select" ON import_mappings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own import_mappings insert" ON import_mappings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own import_mappings update" ON import_mappings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own import_mappings delete" ON import_mappings FOR DELETE USING (auth.uid() = user_id);

-- Auto updated_at function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER b2b_invoices_upd   BEFORE UPDATE ON b2b_invoices   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER b2c_invoices_upd   BEFORE UPDATE ON b2c_invoices   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER b2b_hsn_upd        BEFORE UPDATE ON b2b_hsn        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER b2c_hsn_upd        BEFORE UPDATE ON b2c_hsn        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER customers_upd      BEFORE UPDATE ON customers      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER cdn_notes_upd      BEFORE UPDATE ON cdn_notes      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER products_upd       BEFORE UPDATE ON products       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER import_mappings_upd BEFORE UPDATE ON import_mappings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- Product Master-Driven Itemized Invoicing
-- (adds line items + Product Master unit/description +
-- HSN Summary source tracking; additive only)
-- =============================================

-- Product Master: Unit + optional Description
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;

-- =============================================
-- Product Sync (js/product-sync.js)
-- The company website's Product Master is the only source of truth;
-- this app mirrors it. 'source' distinguishes synced rows from local
-- Quick-Add drafts (created inline during invoice entry when a typed
-- product isn't found — the one deliberately-kept local-creation path).
-- 'external_id' is the website's own product id and the dedup key —
-- sync never creates a duplicate row for a product it's already seen.
-- Website-removed products are soft-deleted via the existing
-- is_deleted/deleted_at columns rather than a separate active flag,
-- so Recycle Bin keeps working unchanged.
-- =============================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','synced'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock DECIMAL(15,3);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_user_external ON products(user_id, external_id) WHERE external_id IS NOT NULL;

-- Invoice Line Items (shared by b2b_invoices and b2c_invoices via
-- invoice_type discriminator — same no-real-FK pattern already used
-- between b2b_hsn/b2c_hsn and the invoice tables)
CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('b2b','b2c')),
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT,
  quantity DECIMAL(15,3) NOT NULL DEFAULT 1,
  rate DECIMAL(15,2) NOT NULL DEFAULT 0,
  discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  taxable_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id, invoice_type);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own invoice_items select" ON invoice_items FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own invoice_items insert" ON invoice_items FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own invoice_items update" ON invoice_items FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own invoice_items delete" ON invoice_items FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER invoice_items_upd BEFORE UPDATE ON invoice_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- HSN Summary: distinguish auto-generated (from invoice line items) rows
-- from manually-entered / Excel-imported ones, and trace auto rows back
-- to the invoice that produced them so they can be wholesale-replaced
-- whenever that invoice is re-saved, without touching other rows.
ALTER TABLE b2b_hsn ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','auto'));
ALTER TABLE b2b_hsn ADD COLUMN IF NOT EXISTS source_invoice_id UUID;
ALTER TABLE b2b_hsn ADD COLUMN IF NOT EXISTS source_invoice_type TEXT CHECK (source_invoice_type IN ('b2b','b2c'));
ALTER TABLE b2c_hsn ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','auto'));
ALTER TABLE b2c_hsn ADD COLUMN IF NOT EXISTS source_invoice_id UUID;
ALTER TABLE b2c_hsn ADD COLUMN IF NOT EXISTS source_invoice_type TEXT CHECK (source_invoice_type IN ('b2b','b2c'));

CREATE INDEX IF NOT EXISTS idx_b2b_hsn_source_invoice ON b2b_hsn(source_invoice_id, source_invoice_type);
CREATE INDEX IF NOT EXISTS idx_b2c_hsn_source_invoice ON b2c_hsn(source_invoice_id, source_invoice_type);

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'name', NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- =============================================
-- One-Page Invoice (js/invoice-entry.js / invoice.html)
-- Customer contact fields, optional Transport section, and Payment
-- tracking, added identically to both invoice tables so one form can
-- write to either without either table lacking a field the other has.
-- All additive/nullable — existing rows are unaffected.
-- =============================================

-- Customer contact (b2c_invoices previously had neither a name nor
-- phone/address at all — B2C invoices were anonymous by design; the
-- one-page form now always collects Name/Phone/Address regardless of
-- whether a GSTIN is present).
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS customer_name TEXT;
-- The one-page form has a single shared Invoice Number sequence
-- regardless of B2B/B2C classification (previously only b2b_invoices
-- had one; B2C rows were identified only by a synthesized id prefix in
-- invoice-pdf.js, which remains as the fallback for old rows here).
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS address TEXT;
-- b2b_invoices previously had no State at all (place of supply was only
-- ever available via a best-effort Customer Master name match in
-- invoice-pdf.js). The one-page form always collects it directly now,
-- for both types, so it's reliable for a brand-new customer too.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS state TEXT;

-- Transport (optional; OFF by default; all fields nullable so leaving
-- them blank never blocks Save). Stored now so a future E-Way Bill
-- draft can be generated from real data without a further migration.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS transport_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS vehicle_number TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS transporter_name TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS transport_mode TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS transport_distance_km DECIMAL(10,2);
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS lr_number TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS lr_date DATE;

ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS transport_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS vehicle_number TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS transporter_name TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS transport_mode TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS transport_distance_km DECIMAL(10,2);
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS lr_number TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS lr_date DATE;

-- Payment tracking. balance_due is intentionally NOT a stored column —
-- it's always computed as total_amount - amount_paid, the same
-- live-computed pattern already used for HSN Summary and GSTR-3B rather
-- than a value that could drift out of sync with edits.
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid'));
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid'));
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0;

-- =============================================
-- Payment History (js/payments.js)
-- An invoice's amount_paid/payment_status above are the current summary
-- (kept for fast reads everywhere that already uses them); this table
-- is the itemized ledger behind that summary — one row per actual
-- payment received, so partial payments over time are never lost.
-- amount_paid is recomputed as the sum of this table's active rows for
-- an invoice every time a payment is recorded or removed.
-- =============================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('b2b','b2c')),
  amount DECIMAL(15,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','upi','bank_transfer','cheque','card','other')),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id, invoice_type);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own payments select" ON payments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Own payments insert" ON payments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own payments update" ON payments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Own payments delete" ON payments FOR DELETE USING (auth.uid() = user_id);

-- =============================================
-- B2B/B2C visually distinct Invoice Entry forms
-- State is now hidden entirely on B2C's form and silently defaulted
-- from the business's own profile (js/invoice-entry.js) rather than
-- collected from the user — safety net for the rare case a business
-- hasn't set their own profile state yet, so that default can
-- legitimately be blank without blocking Save.
-- =============================================
ALTER TABLE b2c_invoices ALTER COLUMN state DROP NOT NULL;

-- =============================================
-- GST Number + State are now always visible on both B2B and B2C forms
-- (previously B2C hid them entirely) — required on B2B, optional on
-- B2C. B2C invoices can now optionally carry a GST Number and still
-- save into b2c_invoices; b2b_invoices.gst_number stays NOT NULL.
-- =============================================
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS gst_number TEXT;

-- =============================================
-- Dual Invoice Numbering System — Manual / Auto Generate
-- Auto Generate uses a user-defined format (# = running sequence, e.g.
-- INV-2026-### -> INV-2026-001) plus a persisted, monotonically
-- increasing sequence counter, kept on the business's own profile row
-- (one numbering sequence per business, same as everything else here).
-- The counter only ever moves forward — it is never re-derived by
-- scanning existing invoices for the highest number in use, because
-- that approach would let a deleted invoice's number get reissued.
-- Manual mode ignores all three columns entirely: the Invoice Number
-- field stays freely editable and only the existing duplicate-number
-- check on save applies.
-- =============================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invoice_auto_number BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invoice_number_format TEXT NOT NULL DEFAULT 'INV-###';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invoice_current_sequence INTEGER NOT NULL DEFAULT 1;
