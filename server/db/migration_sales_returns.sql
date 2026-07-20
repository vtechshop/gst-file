-- =============================================
-- Migration: Sales Return Module (sales_returns, sales_return_items)
--
-- Run once against an existing database:
--   psql -U postgres -d gst_invoicing -f db/migration_sales_returns.sql
-- (Also folded into db/schema.sql so a fresh database gets these tables
-- from the one consolidated CREATE TABLE pass.)
--
-- A sales return always references the original invoice it came from
-- (original_invoice_id/type/number) — unlike purchase_returns, where
-- the original purchase reference is optional free text, Sales Return
-- is created directly from an existing B2B/B2C invoice (requirement),
-- so the reference is NOT NULL here. b2b_invoices/b2c_invoices
-- themselves are never written to by this module — see
-- server/routes/sales-returns.js.
-- =============================================

CREATE TABLE IF NOT EXISTS sales_returns (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  original_invoice_id UUID NOT NULL,
  original_invoice_type TEXT NOT NULL CHECK (original_invoice_type IN ('b2b','b2c')),
  original_invoice_number TEXT,
  customer_name TEXT NOT NULL,
  customer_gstin TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  return_number TEXT NOT NULL,
  return_date DATE NOT NULL,
  reason TEXT,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_returns_number_active ON sales_returns(user_id, return_number) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_sales_returns_date ON sales_returns(user_id, return_date);
CREATE INDEX IF NOT EXISTS idx_sales_returns_customer_name ON sales_returns(user_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_sales_returns_original_invoice ON sales_returns(original_invoice_id, original_invoice_type);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  return_id UUID NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_sales_return_items_return ON sales_return_items(return_id);

CREATE TRIGGER sales_returns_upd       BEFORE UPDATE ON sales_returns       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sales_return_items_upd  BEFORE UPDATE ON sales_return_items  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
