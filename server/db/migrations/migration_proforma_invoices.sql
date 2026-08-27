-- =============================================
-- Proforma Invoices — a quotation, not a tax invoice.
--
-- A proforma is an offer: it states what a supply WOULD cost if the customer
-- accepts. No supply has happened, so no tax is due on it, it is reported in
-- no return, and it must never be mistaken for a tax invoice.
--
-- ISOLATION IS STRUCTURAL, NOT A FILTER.
-- These are their own tables rather than a flag on b2b_invoices/b2c_invoices,
-- because every query that feeds the Dashboard, Reports, the ledgers, the
-- Invoice List and GSTR-1 reads those two tables. A proforma row simply
-- cannot appear in any of them - there is no filter to add, and none to
-- forget later. The registry entry carries docNum: null for the same reason:
-- GSTR-1's Table 13 selects on docNum, so a proforma never qualifies.
--
-- CONVERSION IS ONE-WAY AND RECORDED ON THIS SIDE ONLY.
-- When a proforma is imported and the resulting tax invoice saves, the link
-- is written here - converted_invoice_id/type - and nothing is added to the
-- invoice tables. The invoice stays an ordinary invoice that happens to have
-- been typed from a quotation; the quotation remembers what it became. Both
-- columns stay NULL until that save actually succeeds, so a failed save
-- leaves the proforma exactly as it was.
--
-- STATUS is stored, not derived, EXCEPT for expiry. Draft/Sent/Accepted/
-- Converted/Cancelled are things a person did. "Expired" is only the passage
-- of time against valid_until, so it is computed when the row is read rather
-- than written by a job - a proforma that was converted or cancelled is
-- neither, whatever the date says.
--
-- Every column is nullable or defaulted, nothing is backfilled, and no
-- existing table is altered.
-- =============================================

CREATE TABLE IF NOT EXISTS proforma_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- Its own numbering book. document_series is what keeps it out of the tax
  -- invoice sequence: the two count separately and cannot interleave.
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'proforma_invoice',

  -- An offer is open for a while and then it is not. Defaulted by the form
  -- to 30 days, and editable, so a business that quotes for 7 or 90 can.
  valid_until DATE,

  -- What a person did to it. Expiry is NOT here - see the note above.
  status TEXT NOT NULL DEFAULT 'draft',

  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  gst_number TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  district TEXT,

  -- Same meaning as on an invoice: NULL is "same as the billing address".
  shipping_address TEXT,
  shipping_state TEXT,
  shipping_district TEXT,

  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  gst_category TEXT NOT NULL DEFAULT 'regular',

  taxable_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,

  notes TEXT,
  terms TEXT,

  -- Written only after the tax invoice has actually saved.
  converted_invoice_id UUID,
  converted_invoice_type TEXT,

  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proforma_invoice_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  proforma_invoice_id UUID REFERENCES proforma_invoices(id) ON DELETE CASCADE NOT NULL,
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
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_treatment TEXT NOT NULL DEFAULT 'taxable',
  cess_rate DECIMAL(5,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_user     ON proforma_invoices(user_id, document_date);
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_status   ON proforma_invoices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_proforma_items_parent      ON proforma_invoice_items(proforma_invoice_id, sort_order);

DROP TRIGGER IF EXISTS proforma_invoices_upd ON proforma_invoices;
CREATE TRIGGER proforma_invoices_upd BEFORE UPDATE ON proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS proforma_invoice_items_upd ON proforma_invoice_items;
CREATE TRIGGER proforma_invoice_items_upd BEFORE UPDATE ON proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
