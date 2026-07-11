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
