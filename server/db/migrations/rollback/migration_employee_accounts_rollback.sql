-- =====================================================================
-- ROLLBACK: employee logins and permissions
-- =====================================================================
-- Reverses migration_employee_accounts.sql.
--
-- NOT A MIGRATION. Deliberately absent from _manifest.json so the runner
-- can never pick it up; run by hand with psql against a named database.
--
-- It DOES drop two tables and several columns - but only objects the
-- forward migration created, which hold no pre-existing business data.
-- It never touches a customer, product, invoice, voucher or payment row.
--
-- One thing it will REFUSE rather than force, and that refusal is the
-- point:
--
--   * Restoring users.email NOT NULL fails if any account has a NULL
--     email by then - i.e. an employee created without one. Deleting that
--     account to satisfy a constraint would be destroying a login and its
--     authorship of every document it raised. So it stops and says which
--     accounts are in the way, and a human decides.
--
--   * Dropping employee_accounts while employees exist removes their
--     permissions but NOT their users rows, so nothing can sign in as
--     them (an account with no employee row reads as an Admin, so the
--     DROP below is gated on there being no employees left).
-- =====================================================================

-- ── 1. Refuse while employee accounts still exist ────────────────────
DO $$
DECLARE
  n_emp  INTEGER;
  codes  TEXT;
BEGIN
  IF to_regclass('public.employee_accounts') IS NULL THEN
    RAISE NOTICE 'employee rollback: already reversed, nothing to do';
    RETURN;
  END IF;

  SELECT count(*), string_agg(u.employee_code, ', ' ORDER BY u.employee_code)
    INTO n_emp, codes
    FROM employee_accounts e JOIN users u ON u.id = e.user_id;

  IF n_emp > 0 THEN
    RAISE EXCEPTION
      'employee rollback: % employee account(s) still exist (%). Reversing '
      'would strip their permissions while leaving logins that would then '
      'read as Admins. Deactivate and remove them deliberately first.',
      n_emp, codes;
  END IF;
END $$;


-- ── 2. Restore users.email NOT NULL, or refuse ───────────────────────
DO $$
DECLARE n_null INTEGER;
BEGIN
  SELECT count(*) INTO n_null FROM users WHERE email IS NULL;
  IF n_null > 0 THEN
    RAISE EXCEPTION
      'employee rollback: % user(s) have no email address, so NOT NULL '
      'cannot be restored without deleting them. Nothing was changed.',
      n_null;
  END IF;
  IF NOT (SELECT attnotnull FROM pg_attribute
           WHERE attrelid = 'public.users'::regclass AND attname = 'email') THEN
    ALTER TABLE users ALTER COLUMN email SET NOT NULL;
  END IF;
END $$;


-- ── 3. Drop what the forward migration created ───────────────────────
DROP TABLE IF EXISTS employee_account_audit;
DROP TABLE IF EXISTS employee_accounts;

DROP INDEX IF EXISTS uq_users_employee_code;
ALTER TABLE users DROP COLUMN IF EXISTS employee_code;
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;
ALTER TABLE users DROP COLUMN IF EXISTS session_epoch;
ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;

-- created_by on the 42 tenant tables the forward migration added it to.
-- purchase_orders, stock_serials and stock_movements are NOT listed: they
-- had created_by before any of this and must keep it.
ALTER TABLE advance_adjustments     DROP COLUMN IF EXISTS created_by;
ALTER TABLE b2b_hsn                 DROP COLUMN IF EXISTS created_by;
ALTER TABLE b2b_invoices            DROP COLUMN IF EXISTS created_by;
ALTER TABLE b2c_hsn                 DROP COLUMN IF EXISTS created_by;
ALTER TABLE b2c_invoices            DROP COLUMN IF EXISTS created_by;
ALTER TABLE bill_of_supply          DROP COLUMN IF EXISTS created_by;
ALTER TABLE bill_of_supply_items    DROP COLUMN IF EXISTS created_by;
ALTER TABLE cdn_note_items          DROP COLUMN IF EXISTS created_by;
ALTER TABLE cdn_notes               DROP COLUMN IF EXISTS created_by;
ALTER TABLE customers               DROP COLUMN IF EXISTS created_by;
ALTER TABLE delivery_challan_items  DROP COLUMN IF EXISTS created_by;
ALTER TABLE delivery_challans       DROP COLUMN IF EXISTS created_by;
ALTER TABLE eway_bills              DROP COLUMN IF EXISTS created_by;
ALTER TABLE expense_categories      DROP COLUMN IF EXISTS created_by;
ALTER TABLE expenses                DROP COLUMN IF EXISTS created_by;
ALTER TABLE gst_amendments          DROP COLUMN IF EXISTS created_by;
ALTER TABLE import_mappings         DROP COLUMN IF EXISTS created_by;
ALTER TABLE invoice_items           DROP COLUMN IF EXISTS created_by;
ALTER TABLE job_workers             DROP COLUMN IF EXISTS created_by;
ALTER TABLE payment_vouchers        DROP COLUMN IF EXISTS created_by;
ALTER TABLE payments                DROP COLUMN IF EXISTS created_by;
ALTER TABLE products                DROP COLUMN IF EXISTS created_by;
ALTER TABLE proforma_invoice_items  DROP COLUMN IF EXISTS created_by;
ALTER TABLE proforma_invoices       DROP COLUMN IF EXISTS created_by;
ALTER TABLE purchase_items          DROP COLUMN IF EXISTS created_by;
ALTER TABLE purchase_note_items     DROP COLUMN IF EXISTS created_by;
ALTER TABLE purchase_notes          DROP COLUMN IF EXISTS created_by;
ALTER TABLE purchase_return_items   DROP COLUMN IF EXISTS created_by;
ALTER TABLE purchase_returns        DROP COLUMN IF EXISTS created_by;
ALTER TABLE purchases               DROP COLUMN IF EXISTS created_by;
ALTER TABLE receipt_vouchers        DROP COLUMN IF EXISTS created_by;
ALTER TABLE refund_vouchers         DROP COLUMN IF EXISTS created_by;
ALTER TABLE revised_invoice_items   DROP COLUMN IF EXISTS created_by;
ALTER TABLE revised_invoices        DROP COLUMN IF EXISTS created_by;
ALTER TABLE sales_return_items      DROP COLUMN IF EXISTS created_by;
ALTER TABLE sales_returns           DROP COLUMN IF EXISTS created_by;
ALTER TABLE self_invoices           DROP COLUMN IF EXISTS created_by;
ALTER TABLE stock_balances          DROP COLUMN IF EXISTS created_by;
ALTER TABLE stock_locations         DROP COLUMN IF EXISTS created_by;
ALTER TABLE unregistered_suppliers  DROP COLUMN IF EXISTS created_by;
ALTER TABLE vendors                 DROP COLUMN IF EXISTS created_by;
ALTER TABLE warranties              DROP COLUMN IF EXISTS created_by;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attname = 'created_by'
         AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r') <> 3 THEN
    RAISE EXCEPTION 'employee rollback: expected the original 3 created_by columns to remain. Rolled back.';
  END IF;
  RAISE NOTICE 'employee rollback: reversed';
END $$;
