-- =====================================================================
-- Receipt voucher line items
-- =====================================================================
-- A receipt voucher could describe the order it was received against in
-- exactly one line: one description, one quantity, one rate. An advance
-- against an order of several products had nowhere to put the others, so
-- the receipt showed a single row and a total that did not add up from
-- what was printed.
--
-- This gives the voucher its own line items, the same way every other
-- document here has them (proforma_invoice_items, revised_invoice_items,
-- bill_of_supply_items, delivery_challan_items). routes/documents.js
-- already writes a document's items generically from its registry entry,
-- so the voucher joins that rather than growing a save path of its own.
--
-- WHEN A QUOTATION IS LINKED, NOTHING IS STORED HERE
-- --------------------------------------------------
-- A voucher raised against a proforma reads that quotation's items. They
-- are not copied, because then a corrected quotation and the receipt
-- drawn from it would disagree and there would be no way to tell which
-- was right. These rows exist for the MANUAL path - an advance against an
-- order that was never quoted in the system.
--
-- ON DELETE CASCADE, deliberately
-- -------------------------------
-- An item has no meaning without its voucher, and this is the same
-- document-to-line-item cascade the seven existing ones use - the group
-- migration_cascade_protection.sql explicitly leaves alone.
--
-- The user_id key is NO ACTION rather than RESTRICT, which is NOT the
-- usual choice for a tenant table here. See the note on that column.
--
-- NO DATA IS READ OR WRITTEN
-- --------------------------
-- No INSERT, UPDATE, DELETE, TRUNCATE or DROP TABLE. One new table and
-- its indexes; no existing row is touched and no voucher is modified.
--
-- TRANSACTION
-- -----------
-- No BEGIN: src/db/migrator.js wraps each migration in its own, and
-- records it applied inside that same transaction.
-- =====================================================================

CREATE TABLE IF NOT EXISTS receipt_voucher_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,

  -- NO ACTION rather than RESTRICT, for the same reason the employee
  -- tables use it: migration_cascade_protection.sql is already applied
  -- and closes with "there must be exactly 49 RESTRICT foreign keys to
  -- users(id)". A 50th would make that assertion fail and abort
  -- `npm run migrate` on a fresh database, and editing an applied
  -- migration is what the runner's checksum guard exists to prevent.
  -- For a non-deferrable constraint NO ACTION refuses the delete exactly
  -- as RESTRICT does, so the protection is identical.
  user_id UUID NOT NULL REFERENCES users(id),

  -- Which employee added the line. NULL on a row created before employee
  -- logins existed, which is honest where stamping an author would not be.
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- The document-to-line-item cascade: an item has no meaning without its
  -- voucher. Group B in migration_cascade_protection.sql.
  receipt_voucher_id UUID NOT NULL REFERENCES receipt_vouchers(id) ON DELETE CASCADE,

  product_name  TEXT NOT NULL,
  hsn_code      TEXT,
  unit          TEXT,
  quantity      NUMERIC(14,3),
  rate          NUMERIC(14,2),
  -- The line total. Stored rather than derived because a line may be
  -- entered as a lump sum with no quantity - "55,000 for the machine" -
  -- and quantity x rate would then be 0.
  taxable_value NUMERIC(14,2),
  sort_order    INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipt_voucher_items_nonneg_check') THEN
    ALTER TABLE receipt_voucher_items ADD CONSTRAINT receipt_voucher_items_nonneg_check
      CHECK ((quantity      IS NULL OR quantity      >= 0)
         AND (rate          IS NULL OR rate          >= 0)
         AND (taxable_value IS NULL OR taxable_value >= 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_receipt_voucher_items_voucher
  ON receipt_voucher_items (receipt_voucher_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_receipt_voucher_items_user
  ON receipt_voucher_items (user_id);

-- ── Assert the shape, so a half-applied file cannot pass ─────────────
DO $$
DECLARE
  n_cols     INTEGER;
  n_restrict INTEGER;
BEGIN
  SELECT count(*) INTO n_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'receipt_voucher_items';
  IF n_cols < 12 THEN
    RAISE EXCEPTION 'receipt voucher items: expected at least 12 columns, found %. Rolled back.', n_cols;
  END IF;

  -- The invariant migration_cascade_protection.sql asserts must still
  -- hold: this migration must not have added a 50th RESTRICT key.
  SELECT count(*) INTO n_restrict
    FROM pg_constraint con
    JOIN pg_class     cl ON cl.oid = con.conrelid
    JOIN pg_class     rf ON rf.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   WHERE con.contype = 'f' AND ns.nspname = 'public'
     AND rf.relname = 'users' AND con.confdeltype = 'r'
     AND array_length(con.conkey, 1) = 1;
  IF n_restrict <> 49 THEN
    RAISE EXCEPTION
      'receipt voucher items: there are now % RESTRICT foreign keys to users(id), '
      'not 49 - migration_cascade_protection.sql would fail. Rolled back.', n_restrict;
  END IF;

  RAISE NOTICE 'receipt voucher items: table ready (% columns, 49 RESTRICT preserved)', n_cols;
END $$;
