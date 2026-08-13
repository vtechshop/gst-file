-- ============================================================
-- Phase 2, Module 4C — delivery challans, revised invoices, job workers
--
-- Additive only. Creates new tables; alters nothing that already holds
-- data. Re-runnable: every statement is guarded, and the triggers are
-- dropped before being recreated because Postgres has no
-- CREATE TRIGGER IF NOT EXISTS.
--
-- WHY THE FOUR CHALLAN VARIANTS SHARE ONE TABLE BUT NOT ONE SERIES
-- The registry gives job work, supply on approval, liquid gas and "other
-- than supply" four document types and four Table 13 rows. Rule 55 allows
-- a challan to be numbered "in one or multiple series", so either would be
-- lawful — but four rows drawing on one book interleave, and the rows then
-- report overlapping ranges. No portal or schema documentation says
-- whether that is accepted, so each variant has its own book instead.
-- They still share a table, told apart by `document_type` holding the
-- registry key: the variants have identical shape, and one table keeps the
-- uniqueness rule in one index. This is not a generic document table — it
-- stores delivery challans and nothing else.
-- ============================================================

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
  to_address TEXT,
  to_state TEXT,
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

-- ── updated_at triggers ─────────────────────────────────────
DROP TRIGGER IF EXISTS job_workers_upd ON job_workers;
CREATE TRIGGER job_workers_upd BEFORE UPDATE ON job_workers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS delivery_challans_upd ON delivery_challans;
CREATE TRIGGER delivery_challans_upd BEFORE UPDATE ON delivery_challans FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS revised_invoices_upd ON revised_invoices;
CREATE TRIGGER revised_invoices_upd BEFORE UPDATE ON revised_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
