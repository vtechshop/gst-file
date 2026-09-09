-- =====================================================================
-- Stock locations, per-location balances, and transfers (Phase 2A + 2B)
--
-- Phase 1 gave stock a ledger. It could say how much of a product a
-- business has and why, but not WHERE it is: products.stock is one scalar
-- per product, and one number cannot describe goods split across a
-- warehouse and a showroom.
--
-- This migration adds the place, and keeps products.stock exactly where it
-- is and exactly what it means - the company-wide total. For a product
-- managed across locations that total is the sum of its balances:
--
--     SUM(stock_balances.quantity) = products.stock
--
-- and a transfer moves stock between two balances without changing it.
--
-- Additive. No DROP TABLE, no TRUNCATE, no DELETE, and no backfill: the
-- default location and the reconciliation of existing stock into it are a
-- DATA change, kept in a separate reviewed script and not run from here.
--
-- The one non-additive statement is the movement_type CHECK, which is
-- REPLACED rather than altered because Postgres has no "extend a CHECK".
-- It is widened, never narrowed - every value the old constraint allowed
-- the new one allows - so no existing row can be invalidated by it.
-- =====================================================================

-- ── Where stock lives ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_locations (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,

  name TEXT NOT NULL,
  -- Short handle for the location, unique per tenant where given. Optional:
  -- a business with two places does not need codes for them.
  code TEXT,

  -- Where stock goes when a document does not say. Exactly one per tenant,
  -- enforced by the partial unique index below rather than by convention.
  is_default BOOLEAN NOT NULL DEFAULT FALSE,

  -- Locations are deactivated, never deleted: movements and balances point
  -- at them, and a deleted location would leave a ledger that cannot say
  -- where its stock went. The API refuses the delete; this column is what
  -- it offers instead.
  active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One location list per tenant, and no two locations sharing a code within
-- it. Case-insensitive, because "MAIN" and "main" are the same handle to
-- the person typing them. Codeless locations are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_user_code
  ON stock_locations (user_id, lower(code)) WHERE code IS NOT NULL;

-- Exactly one default per tenant. A partial unique index is what makes
-- "exactly one" true in the database instead of merely intended.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_one_default
  ON stock_locations (user_id) WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_stock_locations_user
  ON stock_locations (user_id, active, name);

-- ── How much is in each ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_balances (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  location_id UUID REFERENCES stock_locations(id) ON DELETE RESTRICT NOT NULL,

  -- Never negative. The service refuses the movement first, with a message
  -- naming the shortfall; this is the backstop that makes it true even if
  -- a future caller forgets to ask.
  quantity DECIMAL(15,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per product per location per tenant. This is also what lets the
-- service upsert a balance and then lock it, rather than racing to create
-- two rows for the same shelf.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_balances_user_product_location
  ON stock_balances (user_id, product_id, location_id);

CREATE INDEX IF NOT EXISTS idx_stock_balances_user_product
  ON stock_balances (user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_balances_user_location
  ON stock_balances (user_id, location_id);

-- ON DELETE RESTRICT above is deliberate: it makes the "you cannot delete a
-- location that holds stock" rule a database fact, not only an API check.

-- ── The ledger learns where ───────────────────────────────────────────
-- location_id: where this movement happened. NULL for movements recorded
-- before locations existed, and for tenants that have not created any -
-- both of which are legitimate states, so the column is nullable.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES stock_locations(id) ON DELETE RESTRICT;

-- to_location_id: only a transfer has two ends. On a TRANSFER_OUT it names
-- where the goods went; on the paired TRANSFER_IN, where they came from.
-- That is what lets one ledger line read "Main -> Showroom" without
-- joining it to its partner.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS to_location_id UUID REFERENCES stock_locations(id) ON DELETE RESTRICT;

-- transfer_id: the pair's shared identity. Both halves of one transfer
-- carry it, which is what makes a repeated request answerable - the server
-- can see the transfer already happened instead of moving the stock twice.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS transfer_id UUID;

CREATE INDEX IF NOT EXISTS idx_stock_movements_user_location
  ON stock_movements (user_id, location_id, created_at DESC);

-- Idempotency: one transfer reference can produce one pair of movements.
-- Partial, so the millions of non-transfer rows cost nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_transfer_half
  ON stock_movements (transfer_id, movement_type) WHERE transfer_id IS NOT NULL;

-- ── The two new movement types ────────────────────────────────────────
-- Widening a CHECK requires replacing it. Every value the old constraint
-- permitted is permitted here, so this cannot invalidate an existing row;
-- the two additions are the only difference.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN (
    'OPENING',
    'PURCHASE', 'PURCHASE_RETURN',
    'SALE', 'SALES_RETURN',
    'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
    'DAMAGE', 'SCRAP', 'CONSUMPTION', 'SAMPLE', 'FREE_ISSUE',
    'TRANSFER_IN', 'TRANSFER_OUT'
  ));

-- A transfer must name both ends; nothing else may claim a destination.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_transfer_shape_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_transfer_shape_check
  CHECK (
    (movement_type IN ('TRANSFER_IN','TRANSFER_OUT')
       AND to_location_id IS NOT NULL AND transfer_id IS NOT NULL)
    OR
    (movement_type NOT IN ('TRANSFER_IN','TRANSFER_OUT')
       AND to_location_id IS NULL AND transfer_id IS NULL)
  );

-- ── Deliberately NOT done here ────────────────────────────────────────
-- No default location is created and no existing products.stock is moved
-- into one. That is a data backfill over live rows; it lives in
-- db/backfill/backfill_default_location.sql, is reviewed separately, and
-- is not run by the migrator.
--
-- Until it runs, a tenant with no locations keeps exactly the Phase 1
-- behaviour: products.stock moves, stock_movements.location_id is NULL,
-- and nothing is invented.
