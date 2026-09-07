-- =====================================================================
-- Stock ledger (Phase 1)
--
-- products.stock already exists and is already maintained transactionally
-- by the four document flows (sale, purchase, purchase return, sales
-- return) through applyStockDelta(). What it has never had is a REASON:
-- the column moves and nothing records who moved it, by how much, or
-- against which document.
--
-- This migration adds that record. products.stock stays exactly where it
-- is and keeps its meaning, including its NULL sentinel:
--
--     products.stock IS NULL  ->  the product is not stock-tracked
--                                 (services, and every product nobody has
--                                  chosen to track). No movement is ever
--                                  written for such a product.
--
-- The ledger is the source of truth; products.stock is a cache of its
-- running sum, kept in step inside the same transaction that writes the
-- movement. Nothing here backfills history for stock that already exists
-- - see the note at the foot of this file.
--
-- Additive only. No DROP, no TRUNCATE, no DELETE, no UPDATE of existing
-- rows. Safe to run against a database that already carries products.
-- =====================================================================

-- ── The ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,

  -- Tenancy, exactly as every other table in this schema does it: the
  -- Express layer filters on req.userId from the JWT. No RLS here, for
  -- the same reason schema.sql gives for not having it anywhere else.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  product_id UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,

  -- A closed allow-list, the same shape as supply_type and gst_treatment
  -- elsewhere in this schema. Location/transfer types are deliberately
  -- absent: godowns are a later phase, and a type nothing can produce
  -- would be a promise the application does not keep.
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'OPENING',
    'PURCHASE', 'PURCHASE_RETURN',
    'SALE', 'SALES_RETURN',
    'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
    'DAMAGE', 'SCRAP', 'CONSUMPTION', 'SAMPLE', 'FREE_ISSUE'
  )),

  -- quantity is always a positive magnitude and direction carries the
  -- sign. Storing a signed quantity instead would make CHECK (quantity>0)
  -- impossible and let a typo write a "negative IN".
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  quantity DECIMAL(15,3) NOT NULL CHECK (quantity > 0),

  -- Copied from the product at the time of the movement, not joined: a
  -- ledger read years later must still say what was counted, even if the
  -- product master has since been re-unitised.
  unit TEXT,

  -- What one unit was worth on this movement, where the source document
  -- knows. Recorded for a later valuation phase; nothing in Phase 1
  -- computes with it.
  rate DECIMAL(15,2),

  -- products.stock immediately after this movement was applied, written
  -- inside the same locked transaction. This is what makes a ledger
  -- readable as a running balance without re-summing it every row.
  balance_after DECIMAL(15,3) NOT NULL,

  -- Traceability. source_type/source_id name the document; source_item_id
  -- names the line where the caller knows it. All nullable because an
  -- OPENING or an ADJUSTMENT has no source document - its justification
  -- is `reason` instead.
  source_type TEXT,
  source_id UUID,
  source_item_id UUID,

  -- Why. Required by the API for the manual movement types, which have no
  -- document to point at.
  reason TEXT,
  notes TEXT,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────
-- One per query the Phase 1 API actually issues, and no others.

-- Stock Ledger for one product, newest first.
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_product_created
  ON stock_movements (user_id, product_id, created_at DESC);

-- The Stock Movements feed, newest first, and its date-range filter.
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_created
  ON stock_movements (user_id, created_at DESC);

-- The movement-type filter on that feed, and the Stock In / Stock Out
-- reports which are that filter with a fixed set of types.
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_type
  ON stock_movements (user_id, movement_type);

-- "Which movements did this document cause?" - used by the ledger drill
-- down and by the reconciliation report when a balance disagrees.
CREATE INDEX IF NOT EXISTS idx_stock_movements_source
  ON stock_movements (user_id, source_type, source_id);

-- ── Reorder level ─────────────────────────────────────────────────────
-- The one product column Phase 1 genuinely needs. LOW_STOCK cannot be
-- computed without it and nothing equivalent exists on products.
--
-- NULL means "no reorder level set", which reads as: this product can be
-- IN_STOCK or OUT_OF_STOCK but never LOW_STOCK. That is deliberately not
-- the same as 0.
--
-- track_stock is NOT added. products.stock IS NULL already carries
-- exactly that meaning and is already honoured by applyStockDelta(); a
-- second flag would be a second source of truth for one fact.
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_level DECIMAL(15,3);

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No backfill. Products that already carry a stock value have no ledger
-- history, and inventing OPENING rows for them would fabricate a date and
-- a quantity nobody recorded. Until an opening balance is entered for such
-- a product through POST /api/stock/opening, the reconciliation report
-- reports it as UNRECONCILED - which is the truth - rather than silently
-- agreeing with itself.
