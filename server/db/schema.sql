-- =============================================
-- GST Invoice & GSTR-1 Management System
-- PostgreSQL schema for the Node.js + Express backend.
--
-- Derived from ../../supabase-schema.sql (kept in the repo root as
-- historical reference — this file is the new authoritative source).
-- Differences from that file, all deliberate:
--   - `users` replaces Supabase's `auth.users`; every user_id/profiles.id
--     FK now points here instead.
--   - No Row Level Security / policies — authorization happens in the
--     Express layer (every query filtered by req.userId from the JWT).
--   - No handle_new_user() trigger — profile-row creation is explicit
--     application code in POST /api/auth/register (see routes/auth.js),
--     inside the same transaction as the users insert.
--   - Written as one consolidated set of CREATE TABLE statements (this
--     is a fresh database with no existing rows) rather than the base
--     table + years of ALTER TABLE history the source file accumulated.
--   - New indexes and one new partial-unique constraint, called out
--     below where added.
-- =============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users (replaces Supabase auth.users) ────────────
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Profiles (business settings, one row per user) ──
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
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
  invoice_auto_number BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_number_format TEXT NOT NULL DEFAULT 'INV-###',
  invoice_current_sequence INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── B2B Invoices ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS b2b_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  gst_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  state TEXT,
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
  transport_required BOOLEAN NOT NULL DEFAULT FALSE,
  vehicle_number TEXT,
  transporter_name TEXT,
  transport_mode TEXT,
  transport_distance_km DECIMAL(10,2),
  lr_number TEXT,
  lr_date DATE,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── B2C Invoices ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS b2c_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  gst_number TEXT,
  customer_name TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  invoice_number TEXT,
  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  invoice_date DATE DEFAULT CURRENT_DATE,
  transport_required BOOLEAN NOT NULL DEFAULT FALSE,
  vehicle_number TEXT,
  transporter_name TEXT,
  transport_mode TEXT,
  transport_distance_km DECIMAL(10,2),
  lr_number TEXT,
  lr_date DATE,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deleted invoices must never have their number reissued, and no two
-- active invoices (either type shares one numbering sequence) may share
-- a number — enforced today only by an app-level scan; this is a real
-- DB-level backstop. Partial (WHERE is_deleted = false) so a deleted
-- invoice's old number doesn't block a legitimately-reused slot from
-- ever being reachable again by a *different* still-active row, and
-- NULLs (rare/legacy) never conflict with each other under a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_invoices_number_active ON b2b_invoices(user_id, invoice_number) WHERE is_deleted = false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2c_invoices_number_active ON b2c_invoices(user_id, invoice_number) WHERE is_deleted = false;

-- New indexes (invoice_number, customer_name, gst_number, date)
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_date ON b2b_invoices(user_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_date ON b2c_invoices(user_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_customer_name ON b2b_invoices(user_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_customer_name ON b2c_invoices(user_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_gst_number ON b2b_invoices(user_id, gst_number);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_gst_number ON b2c_invoices(user_id, gst_number);

-- ── B2B HSN (legacy — no longer written to; HSN Summary is computed
--    live from invoice_items. Kept for historical rows + Recycle Bin.) ──
CREATE TABLE IF NOT EXISTS b2b_hsn (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
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
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','auto')),
  source_invoice_id UUID,
  source_invoice_type TEXT CHECK (source_invoice_type IN ('b2b','b2c')),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS b2c_hsn (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
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
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','auto')),
  source_invoice_id UUID,
  source_invoice_type TEXT CHECK (source_invoice_type IN ('b2b','b2c')),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_hsn_source_invoice ON b2b_hsn(source_invoice_id, source_invoice_type);
CREATE INDEX IF NOT EXISTS idx_b2c_hsn_source_invoice ON b2c_hsn(source_invoice_id, source_invoice_type);
-- New indexes (hsn_code)
CREATE INDEX IF NOT EXISTS idx_b2b_hsn_code ON b2b_hsn(user_id, hsn_code);
CREATE INDEX IF NOT EXISTS idx_b2c_hsn_code ON b2c_hsn(user_id, hsn_code);

-- ── Customers (Customer Master) ──────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
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

-- New indexes (customer_name, gst_number)
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(user_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_gstin ON customers(user_id, gstin);

-- ── Credit / Debit Notes ──────────────────────────────
CREATE TABLE IF NOT EXISTS cdn_notes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
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

-- ── Product Master ────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  hsn_code TEXT,
  type TEXT NOT NULL DEFAULT 'goods' CHECK (type IN ('goods','service')),
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 18,
  default_rate DECIMAL(15,2) DEFAULT 0,
  unit TEXT,
  description TEXT,
  sku TEXT,
  category TEXT,
  warranty TEXT,
  image_url TEXT,
  external_id TEXT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','synced')),
  stock DECIMAL(15,3),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_user_external ON products(user_id, external_id) WHERE external_id IS NOT NULL;
-- New index (product_name)
CREATE INDEX IF NOT EXISTS idx_products_name ON products(user_id, name);

-- ── Remembered Excel import column mappings ──────────
CREATE TABLE IF NOT EXISTS import_mappings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  import_type TEXT NOT NULL DEFAULT 'invoice_excel',
  mapping JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, import_type)
);

-- ── Invoice Line Items (shared by b2b_invoices/b2c_invoices via
--    invoice_type discriminator — no real FK to either, same
--    no-real-FK pattern the source schema already used for b2b_hsn/
--    b2c_hsn) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
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
-- New index (hsn_code)
CREATE INDEX IF NOT EXISTS idx_invoice_items_hsn_code ON invoice_items(user_id, hsn_code);

-- ── Payment History (itemized ledger behind
--    b2b_invoices/b2c_invoices.amount_paid/payment_status) ───
CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('b2b','b2c')),
  amount DECIMAL(15,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','upi','bank_transfer','cheque','card','other')),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id, invoice_type);
-- New index (date)
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(user_id, payment_date);

-- ── updated_at trigger, applied to every table with that column ──
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER b2b_invoices_upd    BEFORE UPDATE ON b2b_invoices    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER b2c_invoices_upd    BEFORE UPDATE ON b2c_invoices    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER b2b_hsn_upd         BEFORE UPDATE ON b2b_hsn         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER b2c_hsn_upd         BEFORE UPDATE ON b2c_hsn         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER customers_upd       BEFORE UPDATE ON customers       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER cdn_notes_upd       BEFORE UPDATE ON cdn_notes       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER products_upd        BEFORE UPDATE ON products        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER import_mappings_upd BEFORE UPDATE ON import_mappings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER invoice_items_upd   BEFORE UPDATE ON invoice_items   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
