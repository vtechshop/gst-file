-- =====================================================================
-- SERIAL NUMBER INVENTORY
--
-- A serial is an individual UNIT of a product, tracked by name rather than
-- counted. The quantity ledger already says how many of a product exist;
-- this says which ones, and where each of them is in its life.
--
-- The two are not alternatives. A serialised product still moves through
-- stock_movements and stock_balances exactly as before - the serial rows
-- are an additional, reconcilable account of the same goods, which is why
-- nothing here changes how quantity is computed.
-- =====================================================================

-- ── Which products are tracked this way ───────────────────────────────
-- Deliberately NOT NULL DEFAULT FALSE. Every existing product stays
-- quantity-tracked, because turning on serial tracking for a product that
-- already holds stock would immediately claim that stock has serials
-- nobody has entered. Enabling it is a decision made per product, in the
-- Product Master, on purpose.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS serial_tracking BOOLEAN NOT NULL DEFAULT FALSE;

-- ── The serials themselves ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_serials (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Stored exactly as it was typed or scanned: "00123" keeps its leading
  -- zeros, because a serial is an identifier and the characters ARE the
  -- identity. Matching and uniqueness use upper(btrim(...)) instead, so
  -- the stored value never has to be damaged to be compared.
  serial_no     TEXT NOT NULL CHECK (btrim(serial_no) <> ''),

  status        TEXT NOT NULL DEFAULT 'AVAILABLE'
                CHECK (status IN ('AVAILABLE','SOLD','RETURNED','DAMAGED','SCRAPPED')),

  -- Where the unit physically is. NULL only while a status makes location
  -- meaningless - a SOLD unit has left, and a SCRAPPED one is gone.
  location_id   UUID REFERENCES stock_locations(id) ON DELETE SET NULL,

  -- Where it came IN from. The header id, never a line id: invoice_items
  -- and purchase_items are deleted and re-inserted on every save, so their
  -- ids are regenerated and cannot own anything. See the note at the foot
  -- of this file.
  source_type   TEXT,
  source_id     UUID,

  -- Which PO line it was received against, when it came from an order.
  -- purchase_order_items rows are updated in place rather than replaced,
  -- so this id IS stable - the one line-level reference that is safe.
  purchase_order_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,

  -- Where it went OUT to, by the same stable-header rule. Kept separate
  -- from source_* so a unit that is sold, returned and sold again does not
  -- lose the purchase it arrived on.
  sold_source_type TEXT,
  sold_source_id   UUID,

  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Uniqueness: tenant-wide, case- and space-insensitive ──────────────
-- One serial cannot exist twice inside a tenant even on two different
-- products, so scanning a number identifies a unit without first knowing
-- what product it is - which is the whole point of scanning it. Two
-- different tenants may legitimately hold the same number.
--
-- upper(btrim(...)) means "SN001", "sn001" and " SN001 " are one serial
-- while the stored text keeps whatever was typed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_serials_user_serial
  ON stock_serials (user_id, upper(btrim(serial_no)));

-- Listing and the available-serial picker: both filter by product and
-- status within a tenant.
CREATE INDEX IF NOT EXISTS idx_stock_serials_user_product_status
  ON stock_serials (user_id, product_id, status);

-- "Which serials did this document bring in / take out", which is how a
-- purchase or an invoice reconciles its own serials on edit and delete.
CREATE INDEX IF NOT EXISTS idx_stock_serials_source
  ON stock_serials (user_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_serials_sold_source
  ON stock_serials (user_id, sold_source_type, sold_source_id)
  WHERE sold_source_id IS NOT NULL;

-- The stock summary counts AVAILABLE serials per location to reconcile
-- them against the quantity balance.
CREATE INDEX IF NOT EXISTS idx_stock_serials_location
  ON stock_serials (user_id, location_id, status)
  WHERE location_id IS NOT NULL;

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No FK to invoice_items.id or purchase_items.id, and none will ever be
-- added. Both tables are DELETEd and re-INSERTed wholesale by their save
-- paths (routes/invoices.js and routes/purchases.js), so those ids are
-- different after every edit. A serial hung off one would be orphaned by
-- the next save of the document that owns it. services/warranty-sync.js
-- hit exactly this and had to identify a line by its PRODUCT instead;
-- this table starts from that lesson rather than repeating it.
--
-- No backfill, and no invented serials. A product that already holds
-- quantity stock has no serials until someone enters them, and fabricating
-- them would put names on units nobody has identified.
--
-- No valuation. A serial carries no cost here; default_rate is a price
-- list, not what a unit was bought for.
