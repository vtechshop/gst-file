-- ============================================================
-- Purchase Credit / Debit Notes
--
-- A purchase-side FINANCIAL / TAX adjustment raised against a completed
-- purchase: a rate difference, a shortfall, a discount agreed after the
-- bill. It is deliberately NOT a Purchase Return.
--
--   Purchase Return          = goods physically go back; moves stock and
--                              serials (purchase_returns, routes/purchases.js)
--   Purchase Credit/Debit    = money only; moves nothing
--
-- So nothing here touches stock_movements, stock_serials, purchases or
-- purchase_returns, and the save path writes no stock delta of any kind.
--
-- Additive only and re-runnable. No purchase, return, product or vendor
-- row is read or changed by this migration. It runs inside the migrator's
-- own transaction, so it opens none of its own.
-- ============================================================

-- ── The note ──────────────────────────────────────────────
-- The money on the note is authoritative: its taxable amount, GST split and
-- total are what the document says. The item rows below only say WHICH
-- purchase lines it covers, and the save path refuses a note whose rows do
-- not add up to it.
--
-- original_purchase_id is a real foreign key - unlike the sales note, whose
-- invoice may live in either of two tables - and is set to NULL rather than
-- cascading if the purchase is ever deleted: a financial document must not
-- disappear because its source was removed. original_purchase_number keeps
-- the printed reference either way.
CREATE TABLE IF NOT EXISTS purchase_notes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_type TEXT NOT NULL CHECK (note_type IN ('credit','debit')),
  note_number TEXT NOT NULL,
  note_date DATE NOT NULL,

  original_purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
  original_purchase_number TEXT,
  original_purchase_date DATE,

  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT NOT NULL,
  vendor_gstin TEXT,
  state TEXT,
  reason TEXT,

  taxable_amount DECIMAL(15,2) NOT NULL,
  gst_percentage DECIMAL(5,2) NOT NULL,
  gst_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intrastate','interstate')),
  igst DECIMAL(15,2) DEFAULT 0,
  cgst DECIMAL(15,2) DEFAULT 0,
  sgst DECIMAL(15,2) DEFAULT 0,
  cess_amount DECIMAL(15,2) DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- A note's items must belong to a note of the SAME tenant, and the
  -- composite foreign key below needs this pair to be unique. id alone is
  -- already the primary key, so this adds no new restriction.
  CONSTRAINT purchase_notes_id_user_key UNIQUE (id, user_id)
);

-- One number per tenant, as purchases and purchase returns already are.
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_notes_number ON purchase_notes (user_id, note_number);
CREATE INDEX IF NOT EXISTS idx_purchase_notes_date ON purchase_notes (user_id, note_date);
CREATE INDEX IF NOT EXISTS idx_purchase_notes_source ON purchase_notes (original_purchase_id);

-- ── The items ─────────────────────────────────────────────
-- Each row is a SNAPSHOT of a purchase line the note was raised against,
-- taken when the note is saved: the name, HSN, unit, quantity, rate,
-- discount, GST rate, cess rate and taxable value as they stood. Not a
-- reference to purchase_items - those rows are deleted and re-inserted
-- every time a purchase is saved, so their ids do not survive - and never
-- read from the Product Master, which can be renamed later. The note prints
-- what it was raised for.
CREATE TABLE IF NOT EXISTS purchase_note_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT,
  quantity DECIMAL(15,3),
  rate DECIMAL(15,2),
  discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
  taxable_value DECIMAL(15,2),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Deleting a note deletes its items with it; the purchase is untouched.
  CONSTRAINT purchase_note_items_note_fk FOREIGN KEY (note_id, user_id)
    REFERENCES purchase_notes (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_note_items_note ON purchase_note_items (note_id, sort_order);
