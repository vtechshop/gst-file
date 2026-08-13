# Database migrations

## Why this exists

`db/schema/schema.sql` declares every column inside `CREATE TABLE IF NOT EXISTS`,
which is a **no-op against a table that already exists**, and it contains no
`ALTER` statements. So a new column reaches an existing database only through a
migration file — and until now nothing recorded which had been run.

Three production incidents came from that gap. The most recent took invoice
saving offline for a day (`42703 column "invoice_source" does not exist`,
2026-08-12) with ten migrations unapplied.

## The two paths into a database

| Situation | Use |
| --- | --- |
| Brand-new, empty database | `db/schema/schema.sql`, then `npm run migrate:baseline -- --yes` |
| Existing database | `npm run migrate` |

`schema.sql` is the current shape. The migrations are the patch path from an
older shape to it. **They are not interchangeable** — see *Known gaps* below.

## Commands

Run from `server/`.

```bash
npm run migrate:status     # what is applied, what is pending. Changes nothing.
npm run migrate            # apply every pending migration, in order
npm run migrate:baseline -- --yes   # record pending migrations as applied WITHOUT running them

# baseline everything EXCEPT one that this database does not actually have,
# so `migrate` applies it for real afterwards:
npm run migrate:baseline -- --yes --except migration_sales_return_perf
```

All exit non-zero on failure, so a deploy step can gate on them.

### `--except`

Takes one or more migration ids. Accepted forms:

```bash
--except a              --except a b              --except=a,b
```

An excluded migration is **not recorded and not executed** — it simply stays
pending. Unknown ids are rejected *before* anything is written, because a typo
would otherwise baseline the very migration you meant to hold back. `--except`
only applies to `baseline`; using it with `migrate` or `status` is an error
rather than a silent no-op.

**Why it exists.** Baseline asserts "this database already has these changes".
That is true for most of a long-lived database's migrations and false for any
that were skipped. Baselining a skipped one records it as done and it never runs
again — the exact failure this runner was built to prevent. `--except` is how
you tell the truth about a database that is *mostly* up to date.

## Migration order

`db/migrations/_manifest.json` is the order. **Not the filename sort.**

This is not a preference. `migration_exports_advances.sql` creates
`advance_adjustments`, which has a foreign key to `receipt_vouchers` — created by
`migration_vouchers.sql`. `"exports"` sorts before `"vouchers"`, so a runner
ordering by filename fails with `42P01` on any database predating both. That
happened during the 2026-08-12 recovery.

The runner refuses to start if the directory and the manifest disagree, in
either direction, so a migration cannot be silently skipped or silently missing.

## Adding a migration

1. Create `db/migrations/NNN_short_description.sql` using the next free number.
2. Append the filename to `order` in `_manifest.json`.
3. Run `npm run migrate:status` to confirm it shows as pending.
4. Run `npm run migrate`.

Two rules:

- **Do not open your own transaction.** The runner wraps each migration in one
  and records the migration inside it, so the schema change and the record of it
  commit together or not at all. A file containing `BEGIN;` manages itself, and
  the runner detects that — but then those two writes are no longer atomic. Two
  existing files do this for historical reasons; new ones should not.
- **Never edit an applied migration.** See below.

## The tracking table

```sql
CREATE TABLE schema_migrations (
  id           TEXT PRIMARY KEY,   -- filename without .sql
  filename     TEXT        NOT NULL,
  checksum     TEXT        NOT NULL,   -- sha256 of the file
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_ms INTEGER,
  baselined    BOOLEAN     NOT NULL DEFAULT FALSE
)
```

`baselined = true` means *recorded as applied without being executed* — the
database was already at that point when the runner was introduced.

## Checksum mismatch

The runner stores a SHA-256 of each migration when it applies it, and re-checks
on every run. If a file changed after it was applied, the run **stops before
executing anything** and names the migration.

That state means the database has one version and the repository claims another,
and nothing will reconcile them on its own. The fix is a *new* migration, never
an edit to the old one. If the change was genuinely comment-only, update the
recorded checksum deliberately:

```sql
UPDATE schema_migrations SET checksum = '<new sha256>' WHERE id = '<migration id>';
```

Only do that when you are certain the SQL is unchanged.

## Failure behaviour

A failing migration is rolled back, **not** recorded, and the run stops there —
later migrations do not execute. The runner exits non-zero. Because it was never
recorded, it is simply pending again on the next run, so the fix is to correct
the file and re-run.

A migration that failed leaves no row behind. There is deliberately no "failed"
row: anything written inside the transaction is rolled back with it, and a row
written outside the transaction could disagree with the schema.

## Concurrency

The runner takes a Postgres session advisory lock (key `4021979`) before doing
anything. A second runner against the same database fails fast with a clear
message rather than interleaving. The lock is released automatically if the
process dies, so a crashed run cannot wedge the next one.

## Startup behaviour

The server **reports** pending migrations at boot and **does not apply them**.

Migrations are a deploy step, not a boot step, because this service runs as a
single free-tier instance that spins down on idle — boot happens often and
unattended, and a migration failing there would put the API into a restart loop
with nobody watching. Boot also does not *block* on drift: refusing to start
would turn "some writes fail" into "nothing works", and the operator needs the
app up to diagnose it.

What you see in the log:

```
  Migrations: up to date
```

or

```
  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  !! 3 PENDING MIGRATION(S) — this database is behind the code
  !!   migration_cess_ecom
  ...
  !! Writes touching new columns will fail with 42703 until you run:
  !!   npm run migrate
```

## Production procedure

1. `npm run migrate:status` — confirm what is pending.
2. Take a backup. Render's free Postgres tier has no point-in-time recovery.
3. `npm run migrate`.
4. `npm run migrate:status` — confirm zero pending.
5. Deploy the application.

**Order matters:** migrate first, then deploy. Code that expects a column must
never reach production before the column does.

### First run against an already-live database

The production database already contains every existing migration's effect, so
they must be **baselined**, not executed:

```bash
npm run migrate:status              # expect: all 20 pending
npm run migrate:baseline -- --yes --except migration_sales_return_perf
npm run migrate                     # applies the one that was held back
npm run migrate:status              # expect: 20 applied, 0 pending
```

`migration_sales_return_perf` is excluded deliberately. A read-only check of
production on 2026-08-13 found all four of its indexes absent — it is
index-only, so it left no column trace and had never been run there. The other
19 migrations' effects were each verified present. Baselining that one would
have recorded four performance indexes as existing when they do not, and they
would never have been created.

Baseline asserts *"this database is already at this point"*. Only do it when you
know that is true — hence the explicit `--yes`. It is the correct action for
this project's production and local databases as of 2026-08-12, whose schema was
verified column-by-column during the incident recovery.

## Known gaps

Replaying every migration onto the original `schema.sql` does **not** reproduce
the current `schema.sql`. Verified on a disposable database:

| Difference | Detail |
| --- | --- |
| `transporter_gstin`, `vehicle_type`, `dispatch_from`, `dispatch_to` | Present in `schema.sql` and in live databases, but **no migration creates them**. Added directly to `schema.sql` in `453c54e` / `2ad087f`. |
| `is_deleted`, `deleted_at` | Removed from `schema.sql` in `e6d83b6`, but **no migration drops them**, so a replay leaves them behind. |

Neither affects a live database today — both live databases already have the
correct shape. They matter when rebuilding from history. Closing the gap needs
one new migration; it has not been written yet.
