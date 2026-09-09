-- =====================================================================
-- PURCHASE ORDERS
--
-- A purchase order is an INTENT to buy, not a purchase. It changes no
-- stock. Goods arrive through the existing purchases flow, which already
-- posts the PURCHASE movement through services/stock-ledger.js, and that
-- is the only thing in this feature that touches a balance.
--
-- The header mirrors `purchases` closely - same vendor snapshot, same tax
-- block, same supply_type - so converting one into the other is a copy
-- rather than a translation, exactly as proforma mirrors the invoice
-- tables.
--
-- Numbering joins the document series book (profiles.document_series_*),
-- alongside proforma, bill of supply, challans and vouchers. It does NOT
-- use the purchases module's hand-typed number: that has no server-side
-- uniqueness at all.
-- =====================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  -- Its own numbering book, so PO numbers never interleave with an
  -- invoice, a proforma or a challan.
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  document_series TEXT NOT NULL DEFAULT 'purchase_order',

  -- Where the order is in its life. PARTIALLY_RECEIVED and
  -- FULLY_RECEIVED are derived from the item receipts and written by the
  -- receive path; the rest are set by a person.
  status TEXT NOT NULL DEFAULT 'DRAFT',

  -- Vendor snapshot, the same shape purchases keeps. The FK is SET NULL
  -- so deleting a vendor cannot erase the order it was placed with, and
  -- the denormalised copy is what the PDF prints - an order states who it
  -- was sent to on the day it was sent.
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT NOT NULL,
  vendor_gstin TEXT,
  phone TEXT,
  address TEXT,
  state TEXT,
  district TEXT,
  gst_category TEXT NOT NULL DEFAULT 'regular',

  -- The order's own terms, from the reference layout.
  purchase_representative TEXT,
  logistics_mode TEXT,
  logistics_notes TEXT,
  payment_terms TEXT,
  expected_delivery_date DATE,

  -- Where the goods go, which is not always where the vendor bills from.
  -- Held on the order rather than on the vendor: a vendor has one billing
  -- address but an order can be delivered anywhere.
  delivery_address TEXT,
  delivery_state TEXT,
  delivery_district TEXT,

  -- Same tax block as purchases, computed by the same client-side code.
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  taxable_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  igst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(15,2) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,

  terms TEXT,
  notes TEXT,

  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT purchase_orders_status_check CHECK (status IN
    ('DRAFT','SENT','CONFIRMED','PARTIALLY_RECEIVED','FULLY_RECEIVED','CANCELLED','CLOSED')),
  CONSTRAINT purchase_orders_supply_type_check CHECK (supply_type IN ('intrastate','interstate'))
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE NOT NULL,

  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT,

  -- quantity is what was ORDERED. received_quantity is moved only by the
  -- receive path, inside the same transaction that writes the purchase
  -- and its stock movement.
  --
  -- The CHECK is the real over-receipt guard: the application refuses a
  -- receipt beyond the remainder, and if it ever failed to, the database
  -- would still refuse the row. A purchase RETURN never touches this -
  -- goods that arrived and went back were still received.
  quantity DECIMAL(15,3) NOT NULL,
  received_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,

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
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT purchase_order_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT purchase_order_items_received_nonneg_check CHECK (received_quantity >= 0),
  CONSTRAINT purchase_order_items_no_over_receipt_check CHECK (received_quantity <= quantity)
);

-- The purchase that received goods against an order points back at it.
-- SET NULL rather than CASCADE: cancelling an order must never delete a
-- purchase that really happened, and the purchase's own stock movement
-- stays valid whatever becomes of the order.
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;

-- ── Uniqueness ────────────────────────────────────────────────────────
-- One number per book per tenant, case-insensitively. The save route
-- checks this too, but two simultaneous saves can both pass that check;
-- only the index can actually stop them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_user_series_number
  ON purchase_orders (user_id, document_series, UPPER(document_number));

-- ── Indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_purchase_orders_user_date
  ON purchase_orders (user_id, document_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_user_status
  ON purchase_orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor
  ON purchase_orders (user_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_parent
  ON purchase_order_items (purchase_order_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_purchases_purchase_order
  ON purchases (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

-- ── updated_at ────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS purchase_orders_upd ON purchase_orders;
CREATE TRIGGER purchase_orders_upd BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS purchase_order_items_upd ON purchase_order_items;
CREATE TRIGGER purchase_order_items_upd BEFORE UPDATE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No stock table is touched and no movement is written. A purchase order
-- changes no balance; only the purchase that receives against it does,
-- through the existing ledger service.
--
-- No backfill: there are no historical purchase orders to migrate, and
-- existing purchases keep purchase_order_id NULL, which is exactly what
-- "this purchase did not come from an order" means.
