// =============================================
// Migration runner
// =============================================
// Applies db/migrations/*.sql exactly once each, in a deterministic order,
// recording what it applied so it can never apply it twice.
//
// WHY THIS EXISTS
// db/schema/schema.sql declares every column inside CREATE TABLE IF NOT
// EXISTS, which is a no-op against a table that already exists, and it
// contains no ALTER statements at all. So a new column reaches an existing
// database only through a migration file run by hand — and nothing recorded
// which had been run. Three separate production incidents came from that
// gap, the last one taking invoice saving offline for a day
// (42703 column "invoice_source" does not exist, 2026-08-12).
//
// ORDER IS NOT THE FILENAME SORT
// See db/migrations/_manifest.json. Sorting by filename puts
// migration_exports_advances.sql before migration_vouchers.sql, but the
// former has a foreign key to a table the latter creates. The manifest is
// the order; the directory is only checked against it.
//
// WHAT IT WILL NOT DO
// It never writes to an application table. The only rows it inserts are its
// own bookkeeping in schema_migrations; everything else is whatever DDL the
// migration file itself contains.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');
const MANIFEST = path.join(MIGRATIONS_DIR, '_manifest.json');

// Arbitrary but fixed. Two runners on the same database must pick the same
// number or the lock protects nothing; it must not collide with an advisory
// lock taken anywhere else in the app (nothing else uses one today).
const LOCK_KEY = 4021979;

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id           TEXT PRIMARY KEY,
    filename     TEXT        NOT NULL,
    checksum     TEXT        NOT NULL,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    execution_ms INTEGER,
    baselined    BOOLEAN     NOT NULL DEFAULT FALSE
  )`;

function checksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

// The id is the filename without its extension. Filenames are unique within
// a directory, so ids are unique by construction — but the manifest is
// checked for duplicates anyway, because a duplicate there would silently
// apply one migration twice and skip another.
function idOf(filename) {
  return filename.replace(/\.sql$/i, '');
}

// A migration that opens its own transaction manages it itself. Two of the
// existing files do (migration_payments_reference.sql,
// migration_payment_status_partial.sql) — wrapping those in another BEGIN
// makes the inner COMMIT close the outer transaction, so the runner would
// think it still held one when it did not.
function managesOwnTransaction(sql) {
  return /^\s*BEGIN\s*;/mi.test(sql);
}

// Reads the manifest and the directory, and refuses to continue if they
// disagree. A file present but unlisted would be silently skipped forever;
// a file listed but absent would fail halfway through a run. Both are
// reported before anything executes.
function loadPlan() {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`Migration manifest not found: ${MANIFEST}`);
  }
  const order = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).order;
  if (!Array.isArray(order) || !order.length) {
    throw new Error('Migration manifest has no "order" array.');
  }

  const dupes = order.filter((f, i) => order.indexOf(f) !== i);
  if (dupes.length) throw new Error(`Manifest lists a migration twice: ${[...new Set(dupes)].join(', ')}`);

  const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.toLowerCase().endsWith('.sql')).sort();
  const unlisted = onDisk.filter(f => !order.includes(f));
  const missing = order.filter(f => !onDisk.includes(f));
  if (unlisted.length || missing.length) {
    const parts = [];
    if (unlisted.length) parts.push(`present but not in the manifest: ${unlisted.join(', ')}`);
    if (missing.length) parts.push(`in the manifest but not on disk: ${missing.join(', ')}`);
    throw new Error(`db/migrations and _manifest.json disagree — ${parts.join('; ')}`);
  }

  return order.map(filename => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    return { id: idOf(filename), filename, sql, checksum: checksum(sql) };
  });
}

async function ensureTable(client) {
  await client.query(TABLE_DDL);
}

async function tableExists(client) {
  const { rows } = await client.query("SELECT to_regclass('schema_migrations') AS t");
  return rows[0].t !== null;
}

async function readApplied(client) {
  const { rows } = await client.query('SELECT id, filename, checksum, applied_at, baselined FROM schema_migrations');
  return new Map(rows.map(r => [r.id, r]));
}

// A migration file that changed after it was applied is a real problem: the
// database has the old version, the repository claims the new one, and
// nothing will ever reconcile them. Reported as an error rather than
// repaired, because only a human knows which of the two is right.
function checkChecksums(plan, applied) {
  const drifted = [];
  for (const m of plan) {
    const row = applied.get(m.id);
    if (row && row.checksum !== m.checksum) {
      drifted.push({ id: m.id, appliedAt: row.applied_at, was: row.checksum.slice(0, 12), now: m.checksum.slice(0, 12) });
    }
  }
  return drifted;
}

// Serialises runners across every process pointed at this database. A
// session-level advisory lock is released automatically if the process dies,
// so a crashed run cannot wedge the next one.
async function acquireLock(client) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
  return rows[0].got === true;
}

async function releaseLock(client) {
  try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* connection already gone */ }
}

async function recordApplied(client, m, ms, baselined) {
  await client.query(
    `INSERT INTO schema_migrations (id, filename, checksum, execution_ms, baselined)
     VALUES ($1,$2,$3,$4,$5)`,
    [m.id, m.filename, m.checksum, ms, baselined]
  );
}

// ── The three operations ─────────────────────────────
//
// mode 'up'       apply every pending migration, stopping at the first failure
// mode 'status'   report only; touches nothing but the tracking table
// mode 'baseline' record pending migrations as applied WITHOUT running them
//
// `baseline` exists because this system had a live database long before it
// had a runner. Its schema already contains every migration's effect, so
// running them would at best be a no-op and at worst re-drop and re-add
// constraints under live traffic. Baselining asserts "this database is
// already at this point" — which only an operator can know, hence the
// explicit confirm flag on the CLI.
async function run(pool, { mode = 'up', log = console.log, confirmBaseline = false, except = [] } = {}) {
  const plan = loadPlan();
  const client = await pool.connect();
  const result = { mode, applied: [], pending: [], alreadyApplied: [], failed: null, drifted: [], excluded: [] };

  // `except` is only meaningful when baselining. Silently ignoring it on
  // `up` would be the worst outcome: someone typing
  // `migrate --except <id>` expecting a migration to be skipped would
  // watch it run anyway.
  if (except.length && mode !== 'baseline') {
    client.release();
    throw new Error(`--except only applies to baseline; it cannot be used with "${mode}".`);
  }

  // An unknown id almost always means a typo, and a typo here silently
  // baselines the migration the operator meant to hold back — the exact
  // thing they were trying to prevent. Checked against the manifest
  // before anything is written.
  const known = new Set(plan.map(m => m.id));
  const unknown = except.filter(id => !known.has(id));
  if (unknown.length) {
    client.release();
    throw new Error(
      `--except names ${unknown.length} migration(s) that do not exist: ${unknown.join(', ')}. ` +
      `Use the migration id (the filename without .sql), e.g. ${plan[0].id}.`
    );
  }

  try {
    if (!(await acquireLock(client))) {
      throw new Error('Another migration run holds the lock on this database. Wait for it to finish, then retry.');
    }

    // `status` is strictly read-only — it is what the server calls at boot,
    // and booting the API must not write DDL. On a database that has never
    // been migrated the table simply is not there yet, which reads as
    // "everything pending" rather than as an error.
    let applied = new Map();
    if (mode === 'status') {
      result.initialised = await tableExists(client);
      if (result.initialised) applied = await readApplied(client);
    } else {
      await ensureTable(client);
      applied = await readApplied(client);
      result.initialised = true;
    }
    result.drifted = checkChecksums(plan, applied);
    if (result.drifted.length) {
      for (const d of result.drifted) {
        log(`  CHECKSUM MISMATCH  ${d.id}`);
        log(`      applied ${new Date(d.appliedAt).toISOString().slice(0, 10)} as ${d.was}…, file is now ${d.now}…`);
      }
      throw new Error(
        `${result.drifted.length} migration file(s) changed after being applied. ` +
        'An applied migration must never be edited — add a new migration instead. ' +
        'If the edit was comment-only and you are certain the schema is unaffected, ' +
        'update the recorded checksum deliberately rather than letting the runner guess.'
      );
    }

    const pending = plan.filter(m => !applied.has(m.id));
    result.alreadyApplied = plan.filter(m => applied.has(m.id)).map(m => m.id);
    result.pending = pending.map(m => m.id);

    if (mode === 'status') {
      if (!result.initialised) log('  schema_migrations does not exist yet — nothing has been recorded on this database');
      log(`  applied: ${result.alreadyApplied.length}   pending: ${pending.length}`);
      for (const m of plan) {
        const row = applied.get(m.id);
        const state = row ? (row.baselined ? 'baselined' : 'applied  ') : 'PENDING  ';
        log(`    ${state}  ${m.filename}`);
      }
      return result;
    }

    if (!pending.length) {
      log('  nothing to do — every migration is already recorded as applied');
      return result;
    }

    if (mode === 'baseline') {
      // Held back deliberately: a migration whose effect is NOT in this
      // database must stay pending so `migrate` applies it for real.
      // Baselining it would record it as done and it would never run
      // again — the failure this whole runner exists to prevent.
      const toBaseline = pending.filter(m => !except.includes(m.id));
      result.excluded = pending.filter(m => except.includes(m.id)).map(m => m.id);

      if (!confirmBaseline) {
        throw new Error(
          `Refusing to baseline ${toBaseline.length} migration(s) without confirmation. ` +
          'Baselining marks them applied WITHOUT running them — only do this on a database ' +
          'you know already has their schema. Re-run with --yes.'
        );
      }
      for (const m of toBaseline) {
        await recordApplied(client, m, 0, true);
        result.applied.push(m.id);
        log(`  BASELINED  ${m.filename}  (recorded, not executed)`);
      }
      for (const id of result.excluded) {
        log(`  EXCLUDED   ${id}  (left pending — run "npm run migrate" to apply it)`);
      }
      // `pending` reflects what is still outstanding after this run, which
      // for a baseline is exactly the excluded set.
      result.pending = result.excluded.slice();
      return result;
    }

    // mode 'up'
    for (const m of pending) {
      const own = managesOwnTransaction(m.sql);
      const started = Date.now();
      try {
        if (!own) await client.query('BEGIN');
        await client.query(m.sql);
        // Recorded inside the same transaction as the DDL, so the schema
        // change and the claim that it happened commit together or not at
        // all. A file managing its own transaction has already committed by
        // here, so its record is a separate statement — the one case where
        // the two are not atomic, and the reason new migrations should not
        // open their own transaction.
        if (!own) {
          await recordApplied(client, m, Date.now() - started, false);
          await client.query('COMMIT');
        } else {
          await recordApplied(client, m, Date.now() - started, false);
        }
        result.applied.push(m.id);
        log(`  APPLIED    ${m.filename}  (${Date.now() - started}ms)${own ? '  [self-managed transaction]' : ''}`);
      } catch (err) {
        if (!own) { try { await client.query('ROLLBACK'); } catch { /* already aborted */ } }
        result.failed = { id: m.id, filename: m.filename, code: err.code, message: err.message };
        log(`  FAILED     ${m.filename}`);
        log(`      ${err.code ? err.code + ' ' : ''}${err.message}`);
        log('      rolled back; not recorded as applied; remaining migrations skipped');
        throw err;
      }
    }
    return result;
  } finally {
    await releaseLock(client);
    client.release();
  }
}

module.exports = { run, loadPlan, checksum, idOf, managesOwnTransaction, LOCK_KEY, MIGRATIONS_DIR, TABLE_DDL };

// ── CLI ──────────────────────────────────────────────
// node src/db/migrator.js [status|up|baseline] [--yes]
// Exits non-zero on any failure so a deploy step can gate on it.
if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);

  // Positional mode first, then flags. Parsed explicitly rather than with
  // `find(a => !a.startsWith('--'))`, because --except takes bare values
  // and that predicate would happily mistake one of them for the mode.
  //
  //   node src/db/migrator.js baseline --yes --except a --except b
  //   node src/db/migrator.js baseline --yes --except a b
  //   node src/db/migrator.js baseline --yes --except=a,b
  const mode = (args[0] && !args[0].startsWith('--')) ? args[0] : 'up';
  const except = [];
  for (let i = args[0] === mode ? 1 : 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--except=')) {
      except.push(...a.slice('--except='.length).split(',').map(s => s.trim()).filter(Boolean));
    } else if (a === '--except') {
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) except.push(args[++i]);
    }
  }

  if (!['up', 'status', 'baseline'].includes(mode)) {
    console.error(`Unknown mode "${mode}". Use: status | up | baseline`);
    process.exit(2);
  }
  const pool = require('../config/pool');
  console.log(`\nmigrations: ${mode}${except.length ? `  (excluding ${except.join(', ')})` : ''}`);
  run(pool, { mode, confirmBaseline: args.includes('--yes'), except })
    .then((r) => {
      if (mode === 'up' && r.applied.length) console.log(`\n  ${r.applied.length} migration(s) applied.`);
      console.log('');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      // Deliberately not err.stack: the message is the actionable part and a
      // stack here only buries it. The connection string is never printed.
      console.error(`\n  migration run failed: ${err.message}\n`);
      try { await pool.end(); } catch { /* ignore */ }
      process.exit(1);
    });
}
