-- =====================================================================
-- Employee logins, admin-controlled, with per-module permissions
-- =====================================================================
-- Until now one `users` row WAS one business: profiles.id = users.id, and
-- every one of the 48 tenant tables is scoped by that user_id. There was
-- no second person who could sign in.
--
-- This adds one. An employee gets their own `users` row - their own
-- password, their own session - and an `employee_accounts` row saying
-- which Admin's data they act in and exactly what they may do there. The
-- existing Admin account is untouched: no row is modified, and an account
-- with no employee_accounts row is an Admin, which is what every existing
-- account already is.
--
-- WHY owner_user_id AND NOT A NEW companies TABLE
-- -----------------------------------------------
-- The approved multi-company architecture creates `companies` with the
-- founder's profiles.id as its id - deliberately the same UUID that is
-- already in every row's user_id. So the tenant key is that UUID either
-- way, and `owner_user_id` here holds exactly the value `company_id` will
-- hold later. This is forward-compatible with that plan rather than a
-- detour from it: when companies arrives, owner_user_id is already the
-- right value and needs no remapping.
--
-- ZERO DATA LOSS
-- --------------
-- No INSERT, UPDATE, DELETE, TRUNCATE or DROP TABLE. No existing row is
-- read or written. No employee is created here - accounts are made by an
-- Admin through the API, never by a migration.
--
-- WHY THESE TWO FOREIGN KEYS SAY NOTHING ABOUT ON DELETE
-- ------------------------------------------------------
-- They are NO ACTION (the default), not RESTRICT, and the difference is
-- deliberate rather than an oversight.
--
-- For a non-deferrable constraint PostgreSQL treats the two identically:
-- both raise foreign_key_violation and refuse the delete. What differs is
-- bookkeeping - migration_cascade_protection.sql, which is already
-- committed and applied, closes with "there must be exactly 49 RESTRICT
-- foreign keys to users(id)". Adding RESTRICT keys here would make that
-- assertion fail, so `npm run migrate` would abort on a fresh database -
-- and the alternative, editing an applied migration, is exactly what the
-- runner's checksum guard exists to prevent.
--
-- So: identical protection, no perturbation of an invariant someone else
-- already asserted. The refusal is covered by a test rather than left to
-- this comment (see employee-accounts.test.js E23).
--
-- ONE NON-ADDITIVE CHANGE, called out rather than buried
-- -----------------------------------------------------
-- users.email is dropped from NOT NULL. An employee is identified by
-- their Employee ID and the brief makes email optional for them, but
-- `email TEXT UNIQUE NOT NULL` would force one. The alternative was to
-- synthesise an address like VT-EMP-K7M4Q9@employee.local, which puts a
-- string that is not an email into a column that means email - false data
-- to preserve a constraint, which is the worse trade.
--
-- Dropping NOT NULL deletes nothing, rewrites nothing, and every existing
-- row keeps its address. The UNIQUE index stays, and PostgreSQL permits
-- many NULLs under a UNIQUE index, so two employees without an email do
-- not collide. The rollback restores NOT NULL, and will refuse if a NULL
-- exists by then - which is correct: it should not quietly delete an
-- account to put a constraint back.
--
-- TRANSACTION
-- -----------
-- No BEGIN. src/db/migrator.js wraps each migration in its own
-- BEGIN/COMMIT and records it applied inside that transaction, so any
-- failure below rolls the whole file back.
-- =====================================================================


-- ── 1. users: credentials and session state ──────────────────────────
--
-- employee_code is the login identifier for an employee and NULL for an
-- Admin, who signs in with the email they always used. It is globally
-- unique because it is a credential: the login form is given one string
-- and must resolve it to exactly one account, with no tenant to
-- disambiguate by.
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_code TEXT;

-- Partial, so the many Admin rows with NULL do not collide with each
-- other. upper() because the login lookup upper-cases what was typed -
-- an Employee ID read off a screen should not fail on case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_code
  ON users (upper(employee_code)) WHERE employee_code IS NOT NULL;

-- Forces the temporary password to be replaced before the account can
-- reach anything else. FALSE for every existing account, so no Admin is
-- asked to change anything.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- The revocation mechanism. The JWT is stateless with a 7-day life and
-- was never re-checked, so deactivating an account would have left its
-- token working for up to a week. The token now carries this number and
-- every request compares it: bump it and every outstanding token for
-- that account stops being accepted, with no session table, no
-- revocation list and no shortening of token lifetime.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- See the header. Guarded so re-running is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.users'::regclass
       AND a.attname  = 'email'
       AND a.attnotnull
  ) THEN
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
  END IF;
END $$;


-- ── 2. employee_accounts ─────────────────────────────────────────────
--
-- One row per employee login. Its absence is what makes an account an
-- Admin, so no column has to be added to users to say "is admin" and no
-- existing row has to be updated to claim a role it already has.
CREATE TABLE IF NOT EXISTS employee_accounts (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,

  -- The Admin whose business data this employee works in. Deleting them
  -- is refused while any employee references them - see the note above the
  -- table about NO ACTION.
  owner_user_id UUID NOT NULL REFERENCES users(id),

  -- The employee's own login. UNIQUE, so one login belongs to exactly one
  -- employer - the approved "one login = one company" decision expressed
  -- as a constraint rather than a convention. Deleting the login is
  -- refused while this row exists.
  user_id UUID NOT NULL REFERENCES users(id) UNIQUE,

  -- HR detail. Kept here rather than on users because it describes the
  -- person's employment, not their credentials.
  full_name TEXT,
  mobile    TEXT,
  email     TEXT,

  -- 'active' | 'suspended'. Deactivation is a status change, never a
  -- delete: created_by on a document must keep pointing at a row that
  -- still exists, or "who raised this invoice" stops being answerable.
  status TEXT NOT NULL DEFAULT 'active',

  -- {"customers":["view","create"],"invoices":["view"]} - keys and
  -- actions from shared/access-modules.js, which the server sanitises on
  -- the way in so an unknown module or a module with no `view` can never
  -- be stored. Default '{}' is NO permissions: a new employee can reach
  -- nothing until an Admin says otherwise.
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 'own'  - only rows this employee created (created_by = their user id)
  -- 'all'  - every row belonging to the employer
  -- Defaults to the narrower one. Broader visibility is a deliberate
  -- Admin grant, not something an employee inherits by existing.
  record_scope TEXT NOT NULL DEFAULT 'own',

  -- Who did what to this account, which the brief requires recorded.
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  deactivated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  deactivated_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CHECKs added separately and guarded, the way every other migration in
-- this directory does it, so the file is safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_accounts_status_check') THEN
    ALTER TABLE employee_accounts ADD CONSTRAINT employee_accounts_status_check
      CHECK (status IN ('active', 'suspended'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_accounts_scope_check') THEN
    ALTER TABLE employee_accounts ADD CONSTRAINT employee_accounts_scope_check
      CHECK (record_scope IN ('own', 'all'));
  END IF;
  -- An employee may not employ anyone: their own login cannot also be an
  -- employer row's owner. Enforced in the API too, but a constraint is
  -- what makes it true regardless of which code path writes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_accounts_not_self_check') THEN
    ALTER TABLE employee_accounts ADD CONSTRAINT employee_accounts_not_self_check
      CHECK (owner_user_id <> user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_accounts_owner
  ON employee_accounts (owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_employee_accounts_user
  ON employee_accounts (user_id);


-- ── 3. employee_account_audit ────────────────────────────────────────
--
-- Every create, edit, password reset, deactivation and reactivation, with
-- the Admin who did it. Separate from document_audit_log because that one
-- is keyed by document type and id and is about documents; this is about
-- accounts, and conflating them would make both harder to read.
--
-- Deliberately append-only in the API: it is not in the generic CRUD
-- registry at all, so the browser has no write path to it.
CREATE TABLE IF NOT EXISTS employee_account_audit (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  owner_user_id  UUID NOT NULL REFERENCES users(id),
  employee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  employee_code  TEXT,
  action         TEXT NOT NULL,
  -- What changed, with no password material of any kind in it.
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_account_audit_action_check') THEN
    ALTER TABLE employee_account_audit ADD CONSTRAINT employee_account_audit_action_check
      CHECK (action IN ('created', 'updated', 'permissions_changed', 'password_reset',
                        'deactivated', 'reactivated', 'password_changed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_account_audit_owner
  ON employee_account_audit (owner_user_id, created_at DESC);


-- ── 4. created_by on the tenant tables ───────────────────────────────
--
-- Needed for two things the brief asks for: showing which employee raised
-- a document, and the 'own' record scope, which filters on exactly this
-- column. Without it "their own records" has nothing to mean.
--
-- Nullable with no default and no backfill. A document raised before
-- employees existed has no author to name, and NULL says that honestly
-- where stamping the Admin's id would be inventing a fact about a
-- historical record. The three tables that already carry created_by are
-- skipped BY NAME, not by IF NOT EXISTS, so a rename upstream fails
-- loudly here instead of silently adding a second author column.
ALTER TABLE advance_adjustments     ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE b2b_hsn                 ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE b2b_invoices            ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE b2c_hsn                 ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE b2c_invoices            ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bill_of_supply          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bill_of_supply_items    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cdn_note_items          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cdn_notes               ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customers               ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE delivery_challan_items  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE delivery_challans       ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE eway_bills              ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE expense_categories      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE expenses                ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE gst_amendments          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE import_mappings         ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invoice_items           ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE job_workers             ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payment_vouchers        ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payments                ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products                ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE proforma_invoice_items  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE proforma_invoices       ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_items          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_note_items     ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_notes          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_return_items   ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_returns        ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchases               ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE receipt_vouchers        ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE refund_vouchers         ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE revised_invoice_items   ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE revised_invoices        ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sales_return_items      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sales_returns           ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE self_invoices           ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stock_balances          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stock_locations         ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE unregistered_suppliers  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vendors                 ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE warranties              ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- purchase_orders, stock_serials and stock_movements already have one.
-- document_audit_log and invoice_series_migrations are append-only
-- records of who did what; they carry user_id and need no second author.


-- ── 5. Assert the shape, so a half-applied file cannot pass ──────────
DO $$
DECLARE
  n_created_by INTEGER;
  n_cols       INTEGER;
BEGIN
  SELECT count(*) INTO n_created_by
    FROM pg_attribute a
    JOIN pg_class c  ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND a.attname = 'created_by'
     AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r';

  -- 42 added here + 3 that already had one (purchase_orders, stock_serials,
  -- stock_movements) + 3 on the new employee tables (employee_accounts has
  -- created_by; employee_account_audit does not) = 46.
  IF n_created_by < 45 THEN
    RAISE EXCEPTION
      'employee accounts: expected at least 45 created_by columns after this '
      'migration, found %. Rolled back.', n_created_by;
  END IF;

  SELECT count(*) INTO n_cols
    FROM pg_attribute
   WHERE attrelid = 'public.users'::regclass
     AND attname IN ('employee_code', 'must_change_password', 'session_epoch', 'password_changed_at')
     AND attnum > 0 AND NOT attisdropped;
  IF n_cols <> 4 THEN
    RAISE EXCEPTION 'employee accounts: users is missing credential columns (found % of 4). Rolled back.', n_cols;
  END IF;

  IF (SELECT attnotnull FROM pg_attribute
       WHERE attrelid = 'public.users'::regclass AND attname = 'email') THEN
    RAISE EXCEPTION 'employee accounts: users.email is still NOT NULL. Rolled back.';
  END IF;

  RAISE NOTICE 'employee accounts: schema ready (% created_by columns)', n_created_by;
END $$;
