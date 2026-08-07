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
  product_api_url TEXT,
  product_api_key TEXT,
  invoice_auto_number BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_number_format TEXT NOT NULL DEFAULT 'INV-###',
  invoice_current_sequence INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  invoice_series_sequences JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Format per series: {"online": "W-#####", "amazon": "A-#####"}. The
  -- offline series is absent by design — invoice_number_format above is
  -- its format, which is what it already was before series existed.
  invoice_series_formats JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ── GST registration details (Phase 2, Module 1) ──
  --    See db/migration_gst_registration.sql for why each of these is
  --    stored rather than derived. All additive: an existing profile
  --    with none of them set behaves exactly as it did before.
  legal_name TEXT,                 -- as on the PAN; business_name is the fallback
  trade_name TEXT,                 -- as the business is known; likewise
  business_constitution TEXT,      -- Proprietorship, Partnership, LLP, ...
  -- regular | composition | casual | sez_unit | sez_developer | isd | tds | tcs
  -- 'regular' is what every existing profile is: they file GSTR-1.
  registration_type TEXT NOT NULL DEFAULT 'regular',
  lut_number TEXT,                 -- export without payment of IGST
  lut_expiry DATE,
  iec_number TEXT,                 -- Importer Exporter Code
  default_pos TEXT,                -- blank = the state of registration
  reverse_charge_default BOOLEAN NOT NULL DEFAULT FALSE,
  -- Stated, not inferred from turnover: the thresholds move by
  -- notification and a hardcoded one silently goes stale.
  einvoice_applicable BOOLEAN NOT NULL DEFAULT FALSE,
  ewaybill_applicable BOOLEAN NOT NULL DEFAULT FALSE,
  financial_year TEXT              -- "2026-27"
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
  transporter_gstin TEXT,
  vehicle_type TEXT,
  dispatch_from TEXT,
  dispatch_to TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  invoice_source TEXT NOT NULL DEFAULT 'offline',
  -- Which GSTR-1 table this supply belongs in. Stored on the document,
  -- not looked up from the customer master at export time: a filed
  -- return must not change because a master was edited afterwards.
  gst_category TEXT NOT NULL DEFAULT 'regular',
  -- Tax payable by the recipient. rchrg 'Y' in the return.
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE
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
  transporter_gstin TEXT,
  vehicle_type TEXT,
  dispatch_from TEXT,
  dispatch_to TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  invoice_source TEXT NOT NULL DEFAULT 'offline',
  -- Which GSTR-1 table this supply belongs in. Stored on the document,
  -- not looked up from the customer master at export time: a filed
  -- return must not change because a master was edited afterwards.
  gst_category TEXT NOT NULL DEFAULT 'regular',
  -- Tax payable by the recipient. rchrg 'Y' in the return.
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE
);

-- No two invoices may share a number WITHIN A SERIES — a real DB-level
-- backstop behind the app-level scan. Scoped to invoice_source because
-- that is what a numbering book means: a shop at 138 and a website
-- starting at 1 will both reach 5, and those are two different documents
-- in two different books. Delete is permanent (no soft-delete/Recycle
-- Bin), so a deleted invoice's number is simply gone and free to reuse —
-- nothing partial needed here, a plain unique index is the correct
-- shape. NULLs (rare/legacy) never conflict with each other under a
-- unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_invoices_number_series ON b2b_invoices(user_id, invoice_source, invoice_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2c_invoices_number_series ON b2c_invoices(user_id, invoice_source, invoice_number);

-- New indexes (invoice_number, customer_name, gst_number, date)
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_date ON b2b_invoices(user_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_date ON b2c_invoices(user_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_customer_name ON b2b_invoices(user_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_customer_name ON b2c_invoices(user_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_gst_number ON b2b_invoices(user_id, gst_number);
CREATE INDEX IF NOT EXISTS idx_b2c_invoices_gst_number ON b2c_invoices(user_id, gst_number);

-- ── B2B HSN (legacy — no longer written to; HSN Summary is computed
--    live from invoice_items. Kept for historical rows.) ──
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- ── Customer GST category (Phase 2, Module 2) ──
  --    Decides which GSTR-1 table a supply to this recipient appears in.
  --    'regular' is what every existing customer is: reported in 4A with
  --    inv_typ 'R'. See db/migration_customer_gst_category.sql.
  gst_category TEXT NOT NULL DEFAULT 'regular',
  pan TEXT,
  country TEXT,                    -- blank = India
  place_of_supply TEXT,            -- blank = derive as before
  shipping_address TEXT,           -- bill-to remains address/state above
  shipping_state TEXT
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
  state TEXT,
  reason TEXT,
  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unlike every other transactional table, cdn_notes had no index beyond
-- its primary key — js/cdnotes.js's loadCDNotes() filters by user_id and
-- sorts by note_date on every load, same shape idx_b2b_invoices_date /
-- idx_purchases_date already serve for their own tables.
CREATE INDEX IF NOT EXISTS idx_cdn_notes_date ON cdn_notes(user_id, note_date);
CREATE INDEX IF NOT EXISTS idx_cdn_notes_customer_name ON cdn_notes(user_id, customer_name);

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
  -- ── GST treatment (Phase 2, Module 3) ──
  --    taxable | nil_rated | exempt | non_gst. The three non-taxable
  --    treatments are reported in different columns of GSTR-1 table 8,
  --    so they are three values rather than one flag.
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_user_external ON products(user_id, external_id) WHERE external_id IS NOT NULL;
-- New index (product_name)
CREATE INDEX IF NOT EXISTS idx_products_name ON products(user_id, name);
-- Explicit standalone index for plain user-scoped queries (list/count with
-- no other filter) — the two composite indexes above already have user_id
-- as their leading column so this is largely redundant, but explicit.
CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);

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
  -- The line carries its own treatment: a product reclassified later
  -- must not change a return already filed.
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id, invoice_type);
-- New index (hsn_code)
CREATE INDEX IF NOT EXISTS idx_invoice_items_hsn_code ON invoice_items(user_id, hsn_code);

-- ── Payment History (itemized ledger behind
--    b2b_invoices/b2c_invoices/purchases.amount_paid/payment_status) ───
CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('b2b','b2c','purchase')),
  amount DECIMAL(15,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','upi','bank_transfer','cheque','card','other')),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_number TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id, invoice_type);
-- New index (date)
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(user_id, payment_date);

-- ── Invoice Series Migration log ──────────────────────
--    Every bulk change of invoice_source: when, by whom, over which
--    range, out of which series and into which.
--
--    Moving an invoice between series changes which range it is reported
--    under in GSTR-1's Documents Issued table. The figures filed do not
--    change, but the document ranges do, and a filed return has to stay
--    explainable afterwards.
CREATE TABLE IF NOT EXISTS invoice_series_migrations (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  -- As typed, not derived from what was found: "4 to 25 matched nothing"
  -- is itself worth recording.
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  -- Count per source ({"offline": 22}). A map, because one range can span
  -- more than one series and recording only the first would misstate it.
  old_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_source TEXT NOT NULL,
  -- Which documents moved, not just how many — that is what an audit asks.
  invoice_count INTEGER NOT NULL DEFAULT 0,
  invoice_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_series_migrations_user
  ON invoice_series_migrations(user_id, created_at DESC);

-- ── E-Way Bills (internal transport documents) ────────
--    One record per transport movement, linked to the invoice it ships.
--    Deliberately its own table rather than more columns on the invoice:
--    an invoice can be dispatched more than once (part loads, a vehicle
--    change mid-transit), and the transport details belong to the
--    movement, not the sale. The invoice's own transport_* columns are
--    left untouched.
--
--    ewb_number/ewb_date/valid_until/status are reserved for a future
--    NIC E-Way Bill API integration and are NOT written by this phase —
--    status stays 'not_generated' until a real EWB is obtained, at which
--    point the same row is updated in place rather than replaced.
CREATE TABLE IF NOT EXISTS eway_bills (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- Source invoice. Same (id, type) pair invoice_items and payments use;
  -- number/date are denormalised so the list renders without a join.
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('b2b','b2c')),
  invoice_number TEXT NOT NULL,
  invoice_date DATE,

  -- The only fields the user enters.
  vehicle_number TEXT,
  transporter_name TEXT,
  transport_mode TEXT,
  transport_distance_km DECIMAL(10,2),
  lr_number TEXT,
  lr_date DATE,
  transporter_gstin TEXT,
  vehicle_type TEXT,
  dispatch_from TEXT,
  dispatch_to TEXT,

  -- Reserved for future NIC integration — see note above.
  ewb_number TEXT,
  ewb_date DATE,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'not_generated'
    CHECK (status IN ('not_generated','generated','cancelled','expired')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eway_bills_invoice ON eway_bills(user_id, invoice_id, invoice_type);
CREATE INDEX IF NOT EXISTS idx_eway_bills_user ON eway_bills(user_id, created_at);

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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_number_active ON purchases(user_id, purchase_number);
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
  -- The line carries its own treatment: a product reclassified later
  -- must not change a return already filed.
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
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
  state TEXT,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_returns_number_active ON purchase_returns(user_id, return_number);
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
  -- The line carries its own treatment: a product reclassified later
  -- must not change a return already filed.
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(return_id);

-- ── Expense Categories ────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_categories_name ON expense_categories(user_id, name);

-- ── Expenses ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  category_id UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
  category_name TEXT,
  expense_date DATE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','upi','bank_transfer','cheque','card','other')),
  payee TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(user_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(user_id, category_id);

-- ── Sales Returns (header) — always created from an existing B2B/B2C
--    invoice (original_invoice_id/type NOT NULL); b2b_invoices/
--    b2c_invoices themselves are never written to by this module ──
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_returns_number_active ON sales_returns(user_id, return_number);
CREATE INDEX IF NOT EXISTS idx_sales_returns_date ON sales_returns(user_id, return_date);
CREATE INDEX IF NOT EXISTS idx_sales_returns_customer_name ON sales_returns(user_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_sales_returns_original_invoice ON sales_returns(original_invoice_id, original_invoice_type);

-- ── Sales Return Line Items ────────────────────────────
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
  -- The line carries its own treatment: a product reclassified later
  -- must not change a return already filed.
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_return_items_return ON sales_return_items(return_id);

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
CREATE TRIGGER vendors_upd              BEFORE UPDATE ON vendors              FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchases_upd            BEFORE UPDATE ON purchases            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchase_items_upd       BEFORE UPDATE ON purchase_items       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchase_returns_upd     BEFORE UPDATE ON purchase_returns     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER purchase_return_items_upd BEFORE UPDATE ON purchase_return_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER expense_categories_upd BEFORE UPDATE ON expense_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER expenses_upd           BEFORE UPDATE ON expenses           FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sales_returns_upd       BEFORE UPDATE ON sales_returns       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sales_return_items_upd  BEFORE UPDATE ON sales_return_items  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER eway_bills_upd          BEFORE UPDATE ON eway_bills          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
