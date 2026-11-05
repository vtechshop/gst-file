-- =====================================================================
-- ROLLBACK: account-root cascade protection
-- =====================================================================
-- Restores ON DELETE CASCADE on exactly the 49 foreign keys that
-- migration_cascade_protection.sql converted to ON DELETE RESTRICT.
--
-- NOT A MIGRATION. This file is deliberately absent from _manifest.json:
-- the runner must never pick it up, or it would undo the forward
-- migration on the next `npm run migrate`. It is an operator's tool, run
-- by hand with psql against a named database, and only on a decision to
-- reverse Phase 0.
--
-- Running this puts the database back in the state where
-- `DELETE FROM users WHERE id = ...` destroys that account's entire
-- business history. That is the whole point of the file, and the reason
-- not to run it casually.
--
-- Like the forward migration: no INSERT, UPDATE, DELETE, TRUNCATE or
-- DROP TABLE. Constraint definitions only. No row, key, index or NOT NULL
-- property is touched in either direction.
--
-- Mirror-image of the forward file - same snapshot-then-convert shape,
-- same name preservation, same single-column filter so the two composite
-- tenant keys stay out of reach, same end-state assertion. The only
-- differences are the selector ('r' instead of 'c') and the action
-- (CASCADE instead of RESTRICT).
-- =====================================================================

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
      SELECT con.conname::text     AS conname,
             cl.relname::text      AS tbl,
             att.attname::text     AS col,
             con.confupdtype::text AS upd
        FROM pg_constraint con
        JOIN pg_class      cl  ON cl.oid = con.conrelid
        JOIN pg_class      rf  ON rf.oid = con.confrelid
        JOIN pg_namespace  ns  ON ns.oid = cl.relnamespace
        JOIN unnest(con.conkey) AS k(attnum) ON TRUE
        JOIN pg_attribute  att ON att.attrelid = cl.oid AND att.attnum = k.attnum
       WHERE con.contype     = 'f'
         AND ns.nspname      = 'public'
         AND rf.relname      = 'users'
         AND con.confdeltype = 'r'                 -- the ones we converted
         AND array_length(con.conkey, 1) = 1
    ) t;

  n_found := COALESCE(n_found, 0);

  IF n_found NOT IN (0, 49) THEN
    RAISE EXCEPTION
      'cascade rollback: found % single-column RESTRICT foreign key(s) to '
      'users(id), expected 49 (to reverse) or 0 (already reversed). Nothing '
      'was changed.',
      n_found;
  END IF;

  FOR i IN 1 .. n_found LOOP
    IF v_upd[i] <> 'a' THEN
      RAISE EXCEPTION
        'cascade rollback: %.% declares ON UPDATE (confupdtype=%), which '
        'this script cannot preserve. Nothing was changed.',
        v_tables[i], v_names[i], v_upd[i];
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
                   v_tables[i], v_names[i]);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES public.users(id) ON DELETE CASCADE NOT VALID',
      v_tables[i], v_names[i], v_cols[i]);
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
                   v_tables[i], v_names[i]);
  END LOOP;

  RAISE NOTICE 'cascade rollback: restored CASCADE on % constraint(s)', n_found;
END $$;


DO $$
DECLARE
  n_cascade  INTEGER;
  n_restrict INTEGER;
BEGIN
  SELECT count(*) INTO n_cascade
    FROM pg_constraint con
    JOIN pg_class     cl ON cl.oid = con.conrelid
    JOIN pg_class     rf ON rf.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   WHERE con.contype = 'f' AND ns.nspname = 'public'
     AND rf.relname = 'users' AND con.confdeltype = 'c'
     AND array_length(con.conkey, 1) = 1;

  SELECT count(*) INTO n_restrict
    FROM pg_constraint con
    JOIN pg_class     cl ON cl.oid = con.conrelid
    JOIN pg_class     rf ON rf.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   WHERE con.contype = 'f' AND ns.nspname = 'public'
     AND rf.relname = 'users' AND con.confdeltype = 'r'
     AND array_length(con.conkey, 1) = 1;

  IF n_restrict > 0 THEN
    RAISE EXCEPTION
      'cascade rollback: % foreign key(s) to users(id) are still RESTRICT. '
      'Rolled back.', n_restrict;
  END IF;

  IF n_cascade <> 49 THEN
    RAISE EXCEPTION
      'cascade rollback: expected exactly 49 CASCADE foreign keys to '
      'users(id), found %. Rolled back.', n_cascade;
  END IF;

  RAISE NOTICE 'cascade rollback: verified 49 CASCADE, 0 RESTRICT';
END $$;
