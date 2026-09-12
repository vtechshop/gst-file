#!/usr/bin/env node
// Targeted, idempotent schema check for Purchase Credit / Debit Notes.
//
// Why this exists, and why it is not `npm run migrate`
// ----------------------------------------------------
// Production was missing `purchase_notes`, so every read of the page failed
// with `42P01 relation "purchase_notes" does not exist`. The fix is one
// migration. The free plan has no Shell, so it has to happen on the deploy
// itself — but running the full migration runner at boot is exactly what
// db/MIGRATIONS.md and src/app.js deliberately refuse to do: 37 other
// migrations are pending against a database whose lineage predates them,
// one of them fails on the live shape, and a runner failing at boot would
// put a single free-tier instance into a restart loop.
//
// So this applies ONE named migration and nothing else. It is the narrowest
// thing that fixes the incident:
//
//   * reads db/migrations/migration_purchase_notes.sql from disk and refuses
//     to run if its sha256 is not the approved one — the SQL is never
//     restated here, so it cannot drift from the repository
//   * touches only purchase_notes, purchase_note_items, and the one
//     schema_migrations row that records this migration
//   * records `baselined = false`, because the SQL really is executed
//   * no-ops once the tables are present, so restarts cost one cheap
//     catalogue query and change nothing
//   * on any failure: rolls back, exits non-zero, and the app never starts
//     on a half-applied schema
//
// Wired in as package.json's `prestart`, so `npm start` runs it first and
// npm aborts the start if it exits non-zero.
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// The migrator owns the checksum algorithm, the id convention, the tracking
// table's shape and the advisory lock key. Imported, never re-stated: a
// second copy of any of them could disagree with the real runner and the
// ledger would stop meaning what the runner thinks it means.
const { checksum, idOf, TABLE_DDL, LOCK_KEY, MIGRATIONS_DIR } = require('../src/db/migrator');

const FILENAME = 'migration_purchase_notes.sql';
const ID = idOf(FILENAME);
const TABLES = ['purchase_notes', 'purchase_note_items'];
const DEPENDENCIES = ['users', 'products', 'vendors', 'purchases'];

// Pinned deliberately. If the migration file is ever edited, this script
// stops rather than applying something that was never reviewed — and the
// mismatch is reported with both values so the difference is obvious.
const APPROVED_CHECKSUM = '512dcfcea05adf9b6760fa226bf39ab99f7ec7d6e75dadda7393dcad48c20186';

const TAG = '[purchase-notes]';
const log = (msg) => console.log(`${TAG} ${msg}`);
const warn = (msg) => console.warn(`${TAG} ${msg}`);

class Abort extends Error {}
const abort = (msg) => { throw new Abort(msg); };

// ── reading the migration ────────────────────────────
// Columns are derived from the file itself so the compatibility check below
// cannot drift from the schema it is checking.
function declaredColumns(sql, table) {
  const m = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\s*\\(([\\s\\S]*?)\\n\\);').exec(sql);
  if (!m) return [];
  return m[1].split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter((l) => l && !/^CONSTRAINT/i.test(l))
    .map((l) => (l.match(/^([a-z_]+)\s+(UUID|TEXT|DATE|DECIMAL|INTEGER|TIMESTAMPTZ|BOOLEAN)\b/i) || [])[1])
    .filter(Boolean);
}

function readMigration() {
  const file = path.join(MIGRATIONS_DIR, FILENAME);
  if (!fs.existsSync(file)) abort(`${FILENAME} is missing from ${MIGRATIONS_DIR}`);
  const sql = fs.readFileSync(file, 'utf8');
  const actual = checksum(sql);
  if (actual !== APPROVED_CHECKSUM) {
    abort(`${FILENAME} does not match the approved checksum — refusing to apply it.\n`
      + `    approved: ${APPROVED_CHECKSUM}\n`
      + `    on disk : ${actual}`);
  }
  return sql;
}

// ── database helpers ─────────────────────────────────
const present = async (client, table) =>
  (await client.query('SELECT to_regclass($1) AS t', ['public.' + table])).rows[0].t !== null;

async function columnsOf(client, table) {
  const { rows } = await client.query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
    ['public', table]);
  return rows.map((r) => r.column_name);
}

// Neon's free compute suspends when idle, so the very first connection of a
// deploy can arrive while it is still waking. A transient connect failure
// must not fail the deploy and leave the incident unfixed.
async function connectWithRetry(pool, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (i === attempts) throw err;
      warn(`  database not reachable yet (attempt ${i}/${attempts}: ${err.message}) — retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null; // unreachable
}

// ── the three states ─────────────────────────────────

// Both tables already there: prove the shape is usable, report the ledger,
// and change nothing at all.
async function verifyExisting(client, sql) {
  for (const table of TABLES) {
    const want = declaredColumns(sql, table);
    const have = new Set(await columnsOf(client, table));
    const missing = want.filter((c) => !have.has(c));
    if (missing.length) {
      abort(`${table} exists but is missing ${missing.length} column(s): ${missing.join(', ')}.\n`
        + '    The app would fail with 42703 on this shape, so the start is blocked rather than\n'
        + '    left to fail per-request. This needs a decision, not an automatic change.');
    }
    log(`  ${table}: present, all ${want.length} expected columns`);
  }

  if (await present(client, 'schema_migrations')) {
    const { rows } = await client.query(
      'SELECT checksum, baselined FROM schema_migrations WHERE id = $1', [ID]);
    if (!rows.length) {
      // Deliberately not written here: when the tables already exist this
      // script changes nothing. Recording a migration it did not run is the
      // kind of half-true ledger entry the runner exists to prevent.
      warn(`  note: ${ID} is NOT recorded in schema_migrations (the tables were created some`);
      warn('        other way). Nothing was changed — the ledger is left as it is.');
    } else if (rows[0].checksum !== APPROVED_CHECKSUM) {
      warn(`  note: ${ID} is recorded with a different checksum than the file on disk.`);
    } else {
      log(`  ${ID}: recorded (baselined=${rows[0].baselined})`);
    }
  }
  log('  already present and compatible — nothing to do');
}

// Neither table there: apply the file, record it, in one transaction.
async function applyMigration(client, sql) {
  if (await present(client, 'schema_migrations')) {
    const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [ID]);
    if (rows.length) {
      abort(`${ID} is recorded as applied but its tables do not exist.\n`
        + '    The ledger and the schema disagree; applying it now would contradict the record.\n'
        + '    This needs a human decision, so the start is blocked.');
    }
  }

  log(`  applying ${FILENAME} (sha256 ${APPROVED_CHECKSUM.slice(0, 12)}…)`);
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(TABLE_DDL);
    await client.query(sql);
    const ms = Date.now() - started;
    await client.query(
      `INSERT INTO schema_migrations (id, filename, checksum, execution_ms, baselined)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [ID, FILENAME, APPROVED_CHECKSUM, ms]);
    await client.query('COMMIT');
    log(`  applied in ${ms}ms and recorded (baselined=false)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    abort(`applying ${FILENAME} failed and was rolled back: ${err.code || ''} ${err.message}`.trim());
  }
}

// ── main ─────────────────────────────────────────────
async function main() {
  const sql = readMigration();

  if (!process.env.DATABASE_URL) {
    abort('DATABASE_URL is not set, so the schema cannot be checked.');
  }
  const pool = require('../src/config/pool');
  const client = await connectWithRetry(pool);
  let locked = false;

  try {
    // The same key the migrator uses, so this and a real migration run can
    // never overlap on the same database.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    const { rows: [who] } = await client.query(
      'SELECT current_database() AS db, current_user AS usr');
    // Identity only. The connection string and password are never read here
    // and never logged.
    log(`  database: ${who.db}   user: ${who.usr}`);

    const missingDeps = [];
    for (const t of DEPENDENCIES) if (!(await present(client, t))) missingDeps.push(t);
    if (missingDeps.length) {
      abort(`missing required table(s): ${missingDeps.join(', ')}.\n`
        + '    This does not look like the application database, so nothing was changed.');
    }
    log(`  dependencies present: ${DEPENDENCIES.join(', ')}`);

    const exists = {};
    for (const t of TABLES) exists[t] = await present(client, t);
    const found = TABLES.filter((t) => exists[t]);

    if (found.length === TABLES.length) {
      await verifyExisting(client, sql);
    } else if (found.length === 0) {
      await applyMigration(client, sql);
    } else {
      abort(`only ${found.join(', ')} exists, without ${TABLES.filter((t) => !exists[t]).join(', ')}.\n`
        + '    That is a half-built state this script will not guess at, so nothing was changed.');
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
}

main()
  .then(() => { log('schema check complete'); process.exit(0); })
  .catch((err) => {
    console.error(`${TAG} FAILED: ${err.message}`);
    if (!(err instanceof Abort) && err.stack) console.error(err.stack);
    console.error(`${TAG} the application will not be started on an unverified schema.`);
    process.exit(1);
  });
