-- =============================================
-- GST Invoice & GSTR-1 Management System
-- PostgreSQL schema for the Node.js + Express backend.
--
-- Derived from ../../../supabase-schema.sql (kept in the repo root as
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
  district TEXT,
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
  financial_year TEXT,             -- "2026-27"
  -- Numbering for document types (vouchers, self invoices), kept apart
  -- from the invoice counters so invoice numbering is untouched. Keyed
  -- by the document registry's `series` value.
  document_series_sequences JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_series_formats JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- How many HSN digits this business must report in GSTR-1 Table 12.
  -- Stated, not inferred from turnover, for the same reason
  -- einvoice_applicable is stated. NULL enforces nothing.
  hsn_digits_required SMALLINT,
  aggregate_turnover_band TEXT
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
  district TEXT,
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
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  -- Exports (Batch 5). Nullable: an invoice with no export_type is
  -- exactly the invoice it was before these columns existed. WPAY means
  -- exported on payment of IGST, WOPAY under a LUT or bond.
  export_type TEXT,
  -- Ship To. NULL means the goods went to the billing address above; it is
  -- never a copy of it, so there is one address on the row and nothing that
  -- can drift when the billing address is corrected. Named to match
  -- customers.shipping_* so an invoice can be prefilled from the customer.
  shipping_address TEXT,
  shipping_state TEXT,
  shipping_district TEXT,
  shipping_bill_number TEXT,
  shipping_bill_date DATE,
  port_code TEXT,
  -- Compensation cess totalled for the document (Batch 6). The lines have
  -- carried a rate and an amount since before; this is the total the
  -- return reports. Zero for every invoice raised before it existed.
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- Supplied through an e-commerce operator: the operator's GSTIN, and
  -- whether the operator or the supplier pays the tax.
  ecom_gstin TEXT,
  ecom_supply_type TEXT,
  -- SEZ and export detail (Batch 7). An SEZ supply can be to a unit or a
  -- developer; an export can be of goods (shipping bill) or services (no
  -- shipping bill). The LUT is copied onto the invoice so replacing next
  -- year's LUT cannot change a return already filed.
  sez_recipient_type TEXT,
  export_of TEXT,
  lut_number TEXT,
  -- A vehicle bought and leased before 1 July 2017 attracts GST at 65% of
  -- the applicable rate, reported as diff_percent 0.65. Stored as a
  -- boolean because 0.65 is the only value the schema accepts.
  differential_65 BOOLEAN NOT NULL DEFAULT FALSE
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
  district TEXT,
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
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  -- Exports (Batch 5). Nullable: an invoice with no export_type is
  -- exactly the invoice it was before these columns existed. WPAY means
  -- exported on payment of IGST, WOPAY under a LUT or bond.
  export_type TEXT,
  -- Ship To. NULL means the goods went to the billing address above; it is
  -- never a copy of it, so there is one address on the row and nothing that
  -- can drift when the billing address is corrected. Named to match
  -- customers.shipping_* so an invoice can be prefilled from the customer.
  shipping_address TEXT,
  shipping_state TEXT,
  shipping_district TEXT,
  shipping_bill_number TEXT,
  shipping_bill_date DATE,
  port_code TEXT,
  -- Compensation cess totalled for the document (Batch 6). The lines have
  -- carried a rate and an amount since before; this is the total the
  -- return reports. Zero for every invoice raised before it existed.
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- Supplied through an e-commerce operator: the operator's GSTIN, and
  -- whether the operator or the supplier pays the tax.
  ecom_gstin TEXT,
  ecom_supply_type TEXT,
  -- SEZ and export detail (Batch 7). An SEZ supply can be to a unit or a
  -- developer; an export can be of goods (shipping bill) or services (no
  -- shipping bill). The LUT is copied onto the invoice so replacing next
  -- year's LUT cannot change a return already filed.
  sez_recipient_type TEXT,
  export_of TEXT,
  lut_number TEXT,
  -- A vehicle bought and leased before 1 July 2017 attracts GST at 65% of
  -- the applicable rate, reported as diff_percent 0.65. Stored as a
  -- boolean because 0.65 is the only value the schema accepts.
  differential_65 BOOLEAN NOT NULL DEFAULT FALSE
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
  district TEXT,
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
  shipping_state TEXT,
  shipping_district TEXT
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
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- What an amendment to this note will need. Captured now, emitted only
  -- once the amendment sections' shape is settled.
  original_invoice_date DATE,
  original_period TEXT,
  original_note_number TEXT,
  original_note_date DATE,
  -- What the note reverses: regular | expwp | expwop | sezwp | sezwop | de.
  -- 'regular' is what every note issued before this meant.
  supply_nature TEXT NOT NULL DEFAULT 'regular',
  original_invoice_id UUID,
  original_invoice_table TEXT,
  differential_65 BOOLEAN NOT NULL DEFAULT FALSE,
  -- A note reversing a reverse-charge invoice is itself a reverse-charge
  -- document; this was written as 'N' for every note until there was
  -- somewhere to record otherwise.
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ecom_gstin TEXT
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
  -- ── Product Master completion (Phase 2, Module 3A) ──
  --    Corrections to synced GST fields, which sync does not write and
  --    therefore cannot overwrite. See migration_product_gst_master.sql.
  gst_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  supply_bundle TEXT NOT NULL DEFAULT 'none',   -- none | composite | mixed
  principal_gst_rate DECIMAL(5,2),              -- composite supplies only
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
  -- Same vocabulary as customers.gst_category — one list of categories in
  -- the application, not two. NULL reads as 'regular', which is what every
  -- row written before this column existed already meant.
  gst_category TEXT,
  district TEXT,
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
  -- Same vocabulary as customers.gst_category — one list of categories in
  -- the application, not two. NULL reads as 'regular', which is what every
  -- row written before this column existed already meant.
  gst_category TEXT,
  district TEXT,
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
  district TEXT,
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

-- ── Vouchers and self invoices (Phase 2, Module 4B-impl) ──
--    Four GST documents that are not sales invoices, each in its own
--    domain table. See db/migration_vouchers.sql for why they are not
--    one shared table.
-- ── Unregistered supplier master ────────────
-- A self invoice is raised on a supply RECEIVED from someone who is not
-- registered, so the counterparty is not a customer and does not belong
-- in the customer master. They have no GSTIN by definition — that is
-- what makes the self invoice necessary — so they are identified by name,
-- address, state and optionally a PAN.
CREATE TABLE IF NOT EXISTS unregistered_suppliers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  -- Present only where the supplier is registered but the supply is
  -- still under reverse charge (a GTA, for instance). Blank is the
  -- ordinary case and is why the document exists.
  gstin TEXT,
  pan TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  state TEXT,
  -- Which notified category of reverse-charge supply this supplier
  -- makes. Free text: the notified list changes, and a CHECK constraint
  -- is a poor way to track a notification.
  rcm_category TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_unreg_suppliers_user ON unregistered_suppliers(user_id, name);

-- ── Self Invoice (Table 13 row 2, GSTR-3B 3.1(d)) ──
-- Raised by the recipient on itself for an inward supply under reverse
-- charge. It is not an outward supply and appears in no GSTR-1 supply
-- table; the liability it creates is declared in GSTR-3B.
CREATE TABLE IF NOT EXISTS self_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  -- The numbering book, from the registry's `series` field.
  document_series TEXT NOT NULL DEFAULT 'self_invoice',
  -- issued | cancelled. Cancellation is what Table 13's own `cancel`
  -- column counts, which is why it is a status rather than a delete.
  status TEXT NOT NULL DEFAULT 'issued',
  supplier_id UUID REFERENCES unregistered_suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT NOT NULL,
  supplier_gstin TEXT,
  supplier_state TEXT,
  place_of_supply TEXT,
  description TEXT,
  taxable_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Receipt Voucher (Table 13 row 6, GSTR-1 11A) ──
-- An advance received against a supply not yet made. Taxed on receipt;
-- the turnover arrives later with the invoice, which is why this does
-- NOT count toward turnover — counting both would count the supply twice.
CREATE TABLE IF NOT EXISTS receipt_vouchers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'receipt_voucher',
  status TEXT NOT NULL DEFAULT 'issued',
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  party_name TEXT NOT NULL,
  party_gstin TEXT,
  place_of_supply TEXT NOT NULL,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  description TEXT,
  advance_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- How much of this advance has since been adjusted against invoices.
  -- The Advance module (11A / 11B) will maintain it; nothing writes it
  -- yet, and a refund voucher reads it to refuse refunding more than is
  -- left.
  adjusted_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Payment Voucher (Table 13 row 7 only) ──
-- Records paying a supplier under reverse charge. The liability was
-- already created by the self invoice, so this creates none — treating
-- it as a second liability would double-count the same tax.
CREATE TABLE IF NOT EXISTS payment_vouchers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'payment_voucher',
  status TEXT NOT NULL DEFAULT 'issued',
  supplier_id UUID REFERENCES unregistered_suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT NOT NULL,
  supplier_gstin TEXT,
  -- The self invoice this payment settles, so the two can be reconciled.
  self_invoice_id UUID REFERENCES self_invoices(id) ON DELETE SET NULL,
  original_document_number TEXT,
  original_document_date DATE,
  description TEXT,
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  payment_mode TEXT,
  reference_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Refund Voucher (Table 13 row 8, GSTR-1 11B) ──
-- Issued when an advance is returned without a supply being made, so it
-- reverses the liability the receipt voucher created. Kept separate from
-- a credit note, which reverses an invoice for a supply that WAS made.
CREATE TABLE IF NOT EXISTS refund_vouchers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'refund_voucher',
  status TEXT NOT NULL DEFAULT 'issued',
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  party_name TEXT NOT NULL,
  party_gstin TEXT,
  place_of_supply TEXT NOT NULL,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  -- The receipt voucher whose advance is being returned. Required: a
  -- refund voucher with no advance behind it reverses nothing.
  receipt_voucher_id UUID REFERENCES receipt_vouchers(id) ON DELETE RESTRICT,
  original_document_number TEXT,
  original_document_date DATE,
  reason TEXT,
  refund_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One numbering book per document type, and a number unique within it.
-- Scoped to the series for the same reason invoice numbers are scoped to
-- their source: two books may legitimately both hold a 5.
CREATE UNIQUE INDEX IF NOT EXISTS idx_self_invoices_number
  ON self_invoices(user_id, document_series, document_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_vouchers_number
  ON receipt_vouchers(user_id, document_series, document_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_vouchers_number
  ON payment_vouchers(user_id, document_series, document_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_vouchers_number
  ON refund_vouchers(user_id, document_series, document_number);

-- Table 13 and every report reads these by period.
CREATE INDEX IF NOT EXISTS idx_self_invoices_date ON self_invoices(user_id, document_date);
CREATE INDEX IF NOT EXISTS idx_receipt_vouchers_date ON receipt_vouchers(user_id, document_date);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_date ON payment_vouchers(user_id, document_date);
CREATE INDEX IF NOT EXISTS idx_refund_vouchers_date ON refund_vouchers(user_id, document_date);


-- Numbering counters and formats for document types, kept apart from the
-- invoice ones so nothing about invoice numbering changes.
--   profiles.document_series_sequences JSONB DEFAULT '{}'
--   profiles.document_series_formats   JSONB DEFAULT '{}'

-- ── Audit trail ─────────────────────────────
-- Who created, changed or cancelled which document, and when. One table
-- across the four document types because an audit trail IS a log rather
-- than a domain record — it holds no business data, only a reference to
-- where the business data lives.
CREATE TABLE IF NOT EXISTS document_audit_log (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_type TEXT NOT NULL,        -- registry key
  document_table TEXT NOT NULL,       -- the domain table the row lives in
  document_id UUID NOT NULL,
  document_number TEXT,
  action TEXT NOT NULL,               -- created | updated | cancelled | deleted
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_audit_user ON document_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_audit_doc ON document_audit_log(document_table, document_id);


-- ══ Delivery challans, revised invoices, job workers (Module 4C) ══
-- Mirrors db/migration_challans.sql. See there for why the four
-- challan variants share one table.
-- ── Job worker master ───────────────────────────────────────
-- A job worker is not a customer: nothing is sold to them, and putting
-- them in `customers` would surface them in invoice pickers, the customer
-- ledger and B2B party lists. They do share most identifying fields
-- though, so where a job worker is also a customer, `customer_id` records
-- that rather than copying the row.
CREATE TABLE IF NOT EXISTS job_workers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  gstin TEXT,
  -- A job worker may be unregistered; Rule 45 still allows the challan,
  -- and the address then identifies the place instead of the GSTIN.
  is_registered BOOLEAN NOT NULL DEFAULT FALSE,
  address TEXT,
  city TEXT,
  state TEXT,
  district TEXT,
  state_code TEXT,
  pincode TEXT,
  phone TEXT,
  email TEXT,
  nature_of_work TEXT,
  -- Set when this job worker is the same legal person as a customer.
  -- The relationship is recorded; the data is not duplicated.
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_workers_user ON job_workers(user_id, name);

-- ── Delivery challans ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_challans (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  -- The registry key: 'dc_job_work' | 'dc_approval' | 'dc_liquid_gas' |
  -- 'dc_other'. Table 13 counts a row only for its own type, so the
  -- exporter never needs to know what the variants are called.
  document_type TEXT NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  -- Which numbering book the challan was drawn from. Each variant has its
  -- own, so that four Table 13 rows cannot report overlapping ranges. The
  -- server stamps it from the registry; there is deliberately no default.
  document_series TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',

  -- Who the goods go to. A job-work challan names a job worker; the other
  -- three name a customer or a free-text party. Both are optional at the
  -- database level because which one applies depends on the variant, and
  -- that rule lives in the registry, not here.
  job_worker_id UUID REFERENCES job_workers(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  party_name TEXT NOT NULL,
  party_gstin TEXT,

  -- Rule 55 requires the place of dispatch and the place of delivery.
  from_address TEXT,
  from_state TEXT,
  from_district TEXT,
  to_address TEXT,
  to_state TEXT,
  to_district TEXT,
  place_of_supply TEXT,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',

  purpose TEXT,
  reason TEXT,

  -- Rule 55(1)(a): for liquid gas the quantity is not known when the
  -- goods leave, so the challan records what was dispatched and the
  -- invoice follows once the delivered quantity is known.
  quantity_known_at_dispatch BOOLEAN NOT NULL DEFAULT TRUE,
  -- Rule 55(1)(c) / Section 31(7): goods sent on approval must be
  -- invoiced by the earlier of acceptance or six months.
  approval_due_date DATE,
  -- Rule 45: inputs must come back within one year, capital goods three.
  expected_return_date DATE,
  returned_on DATE,

  transporter_name TEXT,
  transporter_id TEXT,
  vehicle_number TEXT,
  transport_mode TEXT,
  transport_distance DECIMAL(10,2),
  lr_number TEXT,
  eway_bill_id UUID,
  eway_bill_number TEXT,

  -- Rule 55(1) requires the taxable value even though no tax is charged.
  -- These are declared values for the movement, NOT a supply: nothing
  -- here reaches B2B, B2CS, B2CL, the HSN summary or any liability.
  taxable_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,

  notes TEXT,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Uniqueness is per numbering book, so JW-00001 and LG-00001 can both
-- exist: they are numbers in different books, not the same number twice.
-- The index spans the table because the books share it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_challans_number
  ON delivery_challans(user_id, document_series, document_number);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_date
  ON delivery_challans(user_id, document_date);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_type
  ON delivery_challans(user_id, document_type, document_date);

CREATE TABLE IF NOT EXISTS delivery_challan_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  challan_id UUID REFERENCES delivery_challans(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT,
  quantity DECIMAL(15,3) NOT NULL DEFAULT 1,
  rate DECIMAL(15,2) NOT NULL DEFAULT 0,
  taxable_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- Liquid gas: quantity actually delivered, filled in later.
  delivered_quantity DECIMAL(15,3),
  returned_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_challan
  ON delivery_challan_items(challan_id, sort_order);

-- ── Revised invoices ────────────────────────────────────────
-- Rule 53(1): issued against invoices already raised between the
-- effective date of registration and the date the certificate was
-- granted. It is its own document with its own series — not a new sale,
-- and not an edit of the original.
CREATE TABLE IF NOT EXISTS revised_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'revised_invoice',
  status TEXT NOT NULL DEFAULT 'issued',

  -- What is being revised. The number and date are kept as written even
  -- when the original row is not in this system, because a revised
  -- invoice may point at an invoice raised before the software was used.
  original_invoice_number TEXT NOT NULL,
  original_invoice_date DATE NOT NULL,
  original_invoice_id UUID,
  original_invoice_table TEXT,
  -- The return period the original was reported in, as the amendment
  -- sections need it ("072026").
  original_period TEXT,

  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  party_name TEXT NOT NULL,
  party_gstin TEXT,
  place_of_supply TEXT NOT NULL,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  -- Kept per document so a customer reclassified later cannot change a
  -- return already filed — same rule the invoice lines follow.
  gst_category TEXT,
  inv_typ TEXT NOT NULL DEFAULT 'R',
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,

  taxable_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,

  reason TEXT,
  notes TEXT,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revised_invoices_number
  ON revised_invoices(user_id, document_series, document_number);
CREATE INDEX IF NOT EXISTS idx_revised_invoices_date
  ON revised_invoices(user_id, document_date);

CREATE TABLE IF NOT EXISTS revised_invoice_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  revised_invoice_id UUID REFERENCES revised_invoices(id) ON DELETE CASCADE NOT NULL,
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
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revised_invoice_items_doc
  ON revised_invoice_items(revised_invoice_id, sort_order);


-- ══ Advances and bill of supply (Batch 5) ══
-- Mirrors db/migration_exports_advances.sql.
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


-- ══ Amendments to already-filed returns (Batch 7) ══
-- Mirrors db/migration_amendments.sql. An amendment is a record of
-- its own, never an edit of the document it amends.
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


CREATE TRIGGER unregistered_suppliers_upd BEFORE UPDATE ON unregistered_suppliers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER self_invoices_upd    BEFORE UPDATE ON self_invoices    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER receipt_vouchers_upd BEFORE UPDATE ON receipt_vouchers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER payment_vouchers_upd BEFORE UPDATE ON payment_vouchers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER refund_vouchers_upd  BEFORE UPDATE ON refund_vouchers  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER job_workers_upd        BEFORE UPDATE ON job_workers        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER delivery_challans_upd  BEFORE UPDATE ON delivery_challans  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER revised_invoices_upd   BEFORE UPDATE ON revised_invoices   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER advance_adjustments_upd BEFORE UPDATE ON advance_adjustments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER bill_of_supply_upd      BEFORE UPDATE ON bill_of_supply      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER gst_amendments_upd      BEFORE UPDATE ON gst_amendments      FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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
