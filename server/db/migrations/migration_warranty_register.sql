-- Warranty register.
--
-- One row per warranted PRODUCT, not per invoice: an invoice selling three
-- items with three different periods produces three records with three
-- different expiry dates, and one generic record would hide exactly the fact
-- the customer needs. Items sold without cover produce no row at all.
--
-- Descriptive only, like the warranty columns on the invoice itself. Nothing
-- here is read by GSTR-1, GSTR-3B, the Dashboard, Reports, the ledgers, stock
-- or any numbering book; the register is downstream of an invoice and never
-- feeds back into it.
--
-- Purely additive: a new table and its indexes. No existing table, column,
-- row or sequence is touched and nothing is backfilled - a warranty exists
-- only once someone deliberately creates it from an invoice.

CREATE TABLE IF NOT EXISTS warranties (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- Its own numbering book (WAR-#####). Never the invoice series: a warranty
  -- must not consume a tax invoice number.
  warranty_number TEXT NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'warranty',

  -- Where it came from. invoice_item_id is what makes "already created"
  -- answerable, so opening Invoice Details twice cannot mint a second record
  -- for the same line.
  invoice_id UUID NOT NULL,
  invoice_type TEXT NOT NULL,
  invoice_item_id UUID,
  invoice_number TEXT,
  invoice_date DATE,

  -- Copied, not joined. A warranty is honoured years later and has to keep
  -- saying what was sold and to whom even if the customer record is renamed
  -- or the product is withdrawn from the catalogue.
  customer_id UUID,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  product_id UUID,
  product_name TEXT NOT NULL,
  product_sku TEXT,

  -- Typed by hand when the goods carry one; blank is normal and allowed.
  serial_number TEXT,

  quantity DECIMAL(15,3) NOT NULL DEFAULT 1,
  rate DECIMAL(15,2) NOT NULL DEFAULT 0,
  purchase_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  purchase_date DATE,

  warranty_period_months INTEGER,
  warranty_start_date DATE,
  warranty_until DATE,
  warranty_terms TEXT,

  -- Only what a person decided: 'active' or 'cancelled'. EXPIRED is derived
  -- from warranty_until when the row is read, so no nightly job is needed and
  -- a record cannot sit stale between runs.
  status TEXT NOT NULL DEFAULT 'active',
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,

  -- Room for what comes later without another migration on this table:
  -- an extension writes a new until-date and says why, and notes carry
  -- service history until a claims module earns its own table.
  extended_until DATE,
  extension_reason TEXT,
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warranties_user ON warranties(user_id);
CREATE INDEX IF NOT EXISTS idx_warranties_invoice ON warranties(user_id, invoice_type, invoice_id);
CREATE INDEX IF NOT EXISTS idx_warranties_until ON warranties(user_id, warranty_until);

-- One warranty per invoice line. Partial, because a record created by hand
-- rather than from a specific line has no item to be unique against.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_invoice_item
  ON warranties(user_id, invoice_type, invoice_id, invoice_item_id)
  WHERE invoice_item_id IS NOT NULL;

-- The number is unique within its own book, per company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_number
  ON warranties(user_id, document_series, warranty_number);

DROP TRIGGER IF EXISTS warranties_upd ON warranties;
CREATE TRIGGER warranties_upd BEFORE UPDATE ON warranties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
