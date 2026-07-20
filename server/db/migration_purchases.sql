-- =============================================
-- Migration: Purchase Module (vendors, purchases, purchase_items,
-- purchase_returns, purchase_return_items)
--
-- Run once against an existing database:
--   psql -U postgres -d gst_invoicing -f db/migration_purchases.sql
-- (Also folded into db/schema.sql so a fresh database gets these tables
-- from the one consolidated CREATE TABLE pass.)
-- =============================================

-- ── Vendor Master ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
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

CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(user_id, name);
CREATE INDEX IF NOT EXISTS idx_vendors_gstin ON vendors(user_id, gstin);

-- ── Purchases (header) ────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT NOT NULL,
  vendor_gstin TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  purchase_number TEXT NOT NULL,
  purchase_date DATE NOT NULL,
  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_number_active ON purchases(user_id, purchase_number) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(user_id, purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_vendor_name ON purchases(user_id, vendor_name);

-- ── Purchase Line Items ────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  purchase_id UUID NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);

-- ── Purchase Returns (header) ─────────────────────────
CREATE TABLE IF NOT EXISTS purchase_returns (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT NOT NULL,
  vendor_gstin TEXT,
  return_number TEXT NOT NULL,
  return_date DATE NOT NULL,
  original_purchase_id UUID,
  original_purchase_number TEXT,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_returns_number_active ON purchase_returns(user_id, return_number) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_purchase_returns_date ON purchase_returns(user_id, return_date);

-- ── Purchase Return Line Items ─────────────────────────
CREATE TABLE IF NOT EXISTS purchase_return_items (
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

CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(return_id);

-- ── updated_at triggers (update_updated_at() already exists, defined
--    in db/schema.sql) ─────────────────────────────────
CREATE TRIGGER vendors_upd              BEFORE UPDATE ON vendors              FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchases_upd            BEFORE UPDATE ON purchases            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchase_items_upd       BEFORE UPDATE ON purchase_items       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchase_returns_upd     BEFORE UPDATE ON purchase_returns     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchase_return_items_upd BEFORE UPDATE ON purchase_return_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
