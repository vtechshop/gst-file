-- =============================================
-- Phase 2, Module 4B-impl — vouchers and self invoices
-- =============================================
-- Four GST documents that are not sales invoices, each in its own domain
-- table, plus the supplier master a self invoice needs.
--
-- Deliberately NOT one shared table. These four look similar on a form
-- and are different documents in law: a receipt voucher creates a
-- liability on an advance, a refund voucher reverses one, a self invoice
-- creates a liability on an INWARD supply, and a payment voucher creates
-- no liability at all. Keeping them apart keeps every report, index and
-- audit a question about one table.
--
-- Nothing here touches an invoice, a product, a customer or a return.
-- Safe to run more than once.

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
-- invoice ones so nothing about invoice numbering changes. Keyed by the
-- registry's `series` value.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS document_series_sequences JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS document_series_formats JSONB NOT NULL DEFAULT '{}'::jsonb;

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

-- Postgres has no CREATE TRIGGER IF NOT EXISTS, so each one is dropped
-- first. Everything else in this file is already guarded, and a migration
-- that cannot be run twice is a migration nobody can safely re-run after a
-- partial failure. Dropping and recreating a BEFORE UPDATE trigger touches
-- no rows, so this is not a destructive step.
DROP TRIGGER IF EXISTS unregistered_suppliers_upd ON unregistered_suppliers;
CREATE TRIGGER unregistered_suppliers_upd BEFORE UPDATE ON unregistered_suppliers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS self_invoices_upd ON self_invoices;
CREATE TRIGGER self_invoices_upd    BEFORE UPDATE ON self_invoices    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS receipt_vouchers_upd ON receipt_vouchers;
CREATE TRIGGER receipt_vouchers_upd BEFORE UPDATE ON receipt_vouchers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS payment_vouchers_upd ON payment_vouchers;
CREATE TRIGGER payment_vouchers_upd BEFORE UPDATE ON payment_vouchers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS refund_vouchers_upd ON refund_vouchers;
CREATE TRIGGER refund_vouchers_upd  BEFORE UPDATE ON refund_vouchers  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
