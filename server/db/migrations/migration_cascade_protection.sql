-- =====================================================================
-- Account-root cascade protection
-- =====================================================================
-- Changes the 49 foreign keys that point at users(id) from ON DELETE
-- CASCADE to ON DELETE RESTRICT.
--
-- WHY
-- ---
-- Today `DELETE FROM users WHERE id = ...` destroys that account's entire
-- business history: customers, products, invoices, proforma invoices,
-- receipt vouchers, payments, purchases, stock, and the audit log that
-- would have recorded it going. 48 of those cascades hang off a tenant
-- table's user_id; the 49th is profiles.id, which is both the primary key
-- and a cascade path.
--
-- Nothing in the application deletes a user, so this has never fired.
-- That is not protection, it is luck: one stray query, or one future
-- "remove my account" feature, and a company's statutory records are gone
-- with no recovery short of a point-in-time restore. The database should
-- refuse rather than oblige. Removing an account is deactivation, which
-- leaves every row in place.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
-- -------------------------------------
-- Three groups are left alone, each needing its own design and approval:
--
--   * The 7 document-to-line-item cascades (proforma_invoice_items,
--     bill_of_supply_items, delivery_challan_items, revised_invoice_items,
--     purchase_order_items, cdn_note_items, purchase_note_items). An item
--     has no meaning without its header, and the application relies on
--     these: deleting a proforma removes its items through the cascade,
--     because no route deletes them explicitly.
--
--   * stock_movements_product_id_fkey and stock_balances_product_id_fkey.
--     Deleting a product currently erases its stock ledger, which is a
--     real problem - a ledger that vanishes with its subject is not a
--     ledger - but it is a different argument from account protection.
--
--   * advance_adjustments_receipt_voucher_id_fkey (GSTR-1 Table 11B rows).
--
-- The single-column filter below is what keeps the two composite tenant
-- keys out of reach: cdn_note_items_note_fk and purchase_note_items_note_fk
-- are both two-column keys on (note_id, user_id), so they are never
-- selected and their cascade behaviour is untouched.
--
-- NO DATA IS READ OR WRITTEN
-- --------------------------
-- No INSERT, UPDATE, DELETE, TRUNCATE or DROP TABLE appears in this file.
-- It alters constraint definitions only. Every existing row, primary key,
-- ownership value, index and NOT NULL property is left exactly as it is.
-- A foreign key owns no index, so all 53 user_id indexes and all 22
-- unique indexes survive without being mentioned here at all.
--
-- TRANSACTION
-- -----------
-- Deliberately no BEGIN. src/db/migrator.js wraps each migration in its
-- own BEGIN/COMMIT and records it applied inside that same transaction;
-- its header notes that a migration opening its own transaction loses
-- that atomicity. So if any ALTER below fails, or any assertion does, the
-- entire file rolls back and nothing is recorded as applied. There is no
-- partially-converted state to recover from.
--
-- RE-RUNNABLE
-- -----------
-- Step 2 selects only constraints still set to CASCADE, so a second run
-- finds nothing and does nothing. Step 3 asserts the END STATE rather
-- than the delta, so it passes on a re-run, and also on a database built
-- fresh from schema.sql where these are already RESTRICT.
-- =====================================================================


-- ── 1. Snapshot the targets ──────────────────────────────────────────
--
-- Gathered into arrays before anything is altered, rather than driving a
-- FOR loop straight off pg_constraint. The loop body modifies the very
-- catalog the query reads, and a cursor over changing rows is not a safe
-- thing to iterate; a snapshot is.
--
-- Names are discovered rather than assumed. All 49 are declared inline on
-- the column, so PostgreSQL named them by its <table>_<column>_fkey
-- convention - but a table recreated by hand, or a constraint added out
-- of band, can carry a different name, and a migration holding 49
-- hardcoded names would fail on the first mismatch having already altered
-- the ones before it. Each is found by SHAPE and re-added under the name
-- it actually had.
DO $$
DECLARE
  v_names  TEXT[];
  v_tables TEXT[];
  v_cols   TEXT[];
  v_upd    TEXT[];
  n_found  INTEGER;
  i        INTEGER;
BEGIN
  SELECT array_agg(conname ORDER BY tbl, col),
         array_agg(tbl     ORDER BY tbl, col),
         array_agg(col     ORDER BY tbl, col),
         array_agg(upd     ORDER BY tbl, col),
         count(*)
    INTO v_names, v_tables, v_cols, v_upd, n_found
    FROM (
      SELECT con.conname::text        AS conname,
             cl.relname::text         AS tbl,
             att.attname::text        AS col,
             con.confupdtype::text    AS upd
        FROM pg_constraint con
        JOIN pg_class      cl  ON cl.oid = con.conrelid
        JOIN pg_class      rf  ON rf.oid = con.confrelid
        JOIN pg_namespace  ns  ON ns.oid = cl.relnamespace
        JOIN unnest(con.conkey) AS k(attnum) ON TRUE
        JOIN pg_attribute  att ON att.attrelid = cl.oid AND att.attnum = k.attnum
       WHERE con.contype     = 'f'
         AND ns.nspname      = 'public'
         AND rf.relname      = 'users'
         AND con.confdeltype = 'c'                 -- still CASCADE
         AND array_length(con.conkey, 1) = 1       -- never the composite keys
    ) t;

  n_found := COALESCE(n_found, 0);

  -- 49 on a database that still has the cascades, 0 on one already
  -- converted or built fresh from schema.sql. Anything in between means
  -- the schema is not the one this migration was written against - a
  -- table added, renamed, or half-converted by hand - and converting
  -- "whatever happens to be there" would be guessing. Refuse before
  -- altering anything.
  IF n_found NOT IN (0, 49) THEN
    RAISE EXCEPTION
      'cascade protection: found % single-column CASCADE foreign key(s) to '
      'users(id), expected 49 (unconverted) or 0 (already done). Nothing '
      'was changed - the schema is not the one this migration targets.',
      n_found;
  END IF;

  -- ── 2. Convert, name-preserving ────────────────────────────────────
  --
  -- NOT VALID then VALIDATE, rather than a plain ADD: only the delete
  -- action is changing and every existing row already satisfies this
  -- exact foreign key, so the verification scan a plain ADD runs under
  -- ACCESS EXCLUSIVE has nothing to find. NOT VALID skips it; VALIDATE
  -- CONSTRAINT then performs the check under the weaker SHARE UPDATE
  -- EXCLUSIVE. Inside the runner's single transaction the locks are held
  -- until commit either way, so here this is about doing one scan instead
  -- of two - but it is also what keeps the file correct if it is ever
  -- applied outside a transaction.
  FOR i IN 1 .. n_found LOOP
    -- ON UPDATE is preserved as found. These constraints declare none, so
    -- confupdtype is 'a' (NO ACTION) and the clause is correctly omitted
    -- below - but it is checked rather than assumed, so a constraint that
    -- did declare one could not be silently flattened.
    IF v_upd[i] <> 'a' THEN
      RAISE EXCEPTION
        'cascade protection: %.% declares ON UPDATE (confupdtype=%), which '
        'this migration cannot preserve. Nothing was changed.',
        v_tables[i], v_names[i], v_upd[i];
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
                   v_tables[i], v_names[i]);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES public.users(id) ON DELETE RESTRICT NOT VALID',
      v_tables[i], v_names[i], v_cols[i]);
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
                   v_tables[i], v_names[i]);
  END LOOP;

  RAISE NOTICE 'cascade protection: converted % constraint(s) to RESTRICT', n_found;
END $$;


-- ── 3. Assert the end state, not the delta ───────────────────────────
--
-- Counts what IS RESTRICT rather than what this run changed, so the check
-- means the same thing on a first run, a re-run, and a fresh database.
-- 49 = 48 tenant-table user_id keys + profiles.id.
--
-- A failure here aborts the transaction the runner opened, rolling back
-- the conversions above with it. There is no state in which some
-- constraints are converted and the migration is recorded as applied.
DO $$
DECLARE
  n_restrict INTEGER;
  n_cascade  INTEGER;
  stragglers TEXT;
BEGIN
  SELECT count(*) INTO n_restrict
    FROM pg_constraint con
    JOIN pg_class     cl ON cl.oid = con.conrelid
    JOIN pg_class     rf ON rf.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   WHERE con.contype = 'f' AND ns.nspname = 'public'
     AND rf.relname = 'users' AND con.confdeltype = 'r'
     AND array_length(con.conkey, 1) = 1;

  SELECT count(*),
         string_agg(cl.relname || '.' || con.conname, ', ' ORDER BY cl.relname)
    INTO n_cascade, stragglers
    FROM pg_constraint con
    JOIN pg_class     cl ON cl.oid = con.conrelid
    JOIN pg_class     rf ON rf.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   WHERE con.contype = 'f' AND ns.nspname = 'public'
     AND rf.relname = 'users' AND con.confdeltype = 'c'
     AND array_length(con.conkey, 1) = 1;

  IF n_cascade > 0 THEN
    RAISE EXCEPTION
      'cascade protection: % single-column foreign key(s) to users(id) are '
      'still ON DELETE CASCADE: %. Rolled back.',
      n_cascade, stragglers;
  END IF;

  IF n_restrict <> 49 THEN
    RAISE EXCEPTION
      'cascade protection: expected exactly 49 RESTRICT foreign keys to '
      'users(id), found %. Rolled back.',
      n_restrict;
  END IF;

  RAISE NOTICE 'cascade protection: verified 49 RESTRICT, 0 CASCADE';
END $$;
