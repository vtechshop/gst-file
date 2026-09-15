#!/usr/bin/env node
// Targeted, idempotent schema check for the Proforma transport charge.
//
// Why this exists, and why it is not `npm run migrate`
// ----------------------------------------------------
// A proforma now quotes a delivery charge. Its save route writes
// proforma_invoices.transport_charge and derives transport_gst_amount, so
// until that migration has run, every proforma save fails with 42703. The
// free plan has no Shell, so the migration has to ride the deploy - and, for
// the reasons scripts/migrate-purchase-notes.js sets out, the full runner
// must never run at boot.
//
// So this applies ONE named migration and nothing else:
//
//   * reads db/migrations/<FILENAME> from disk and refuses to run unless its
//     sha256, computed here at runtime, is the approved one
//   * everything it checks - the columns, their types, the constraint names
//     and what each CHECK means - is read from that file, never restated
//   * touches only the two transport columns on proforma_invoices, their two
//     CHECK constraints, and the one schema_migrations row recording it
//   * records baselined = false, because the SQL really is executed
//   * no-ops once the final shape is present, so a restart costs a few
//     catalogue queries and changes nothing
//   * a PARTIAL state is completed only when that can be proven safe: every
//     object already there has exactly the final shape, and the file adds
//     every column IF NOT EXISTS and every constraint only when absent.
//     Anything else is refused, and the final shape is checked again inside
//     the transaction before it commits
//   * on any failure it rolls back, exits non-zero, and npm does not start
//     the app on an unverified schema
//
// Runs in package.json's prestart, AFTER the Purchase Notes check.
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// The migrator owns the checksum algorithm, the id convention, the tracking
// table's shape, the advisory lock key and the rule for a self-managed
// transaction. Imported, never re-stated.
const { checksum, idOf, TABLE_DDL, LOCK_KEY, MIGRATIONS_DIR, managesOwnTransaction } = require('../src/db/migrator');

const FILENAME = 'migration_proforma_transport_charge.sql';
const ID = idOf(FILENAME);
const TABLE = 'proforma_invoices';

// Pinned deliberately. If the migration file is ever edited, this check stops
// rather than applying something that was never reviewed - and the mismatch
// is reported with both values so the difference is obvious.
const APPROVED_CHECKSUM = 'fe5ee9c17d7ae1297362a5a334e1a826fbae63072154e689bab87d9167714178';

const TAG = '[proforma-transport]';
const log = (msg) => console.log(`${TAG} ${msg}`);
const warn = (msg) => console.warn(`${TAG} ${msg}`);

class Abort extends Error {}
const abort = (msg) => { throw new Abort(msg); };

// ── reading the migration ────────────────────────────
function readMigration() {
  const file = path.join(MIGRATIONS_DIR, FILENAME);
  if (!fs.existsSync(file)) abort(`${FILENAME} is missing from ${MIGRATIONS_DIR}`);
  const sql = fs.readFileSync(file, 'utf8');
  const actual = checksum(sql);
  if (actual !== APPROVED_CHECKSUM) {
    abort(`${FILENAME} does not match the approved checksum - refusing to apply it.\n`
      + `    approved: ${APPROVED_CHECKSUM}\n`
      + `    on disk : ${actual}`);
  }
  return sql;
}

// What the migration creates, read from the migration itself, so every check
// below is against the repository file and never against a second copy of it.
function readPlan(sql) {
  const code = sql.replace(/--[^\n]*/g, '');
  const tables = [...code.matchAll(/ALTER TABLE\s+([a-z_0-9]+)/gi)].map(m => m[1]);
  if (!tables.length || tables.some(t => t !== TABLE)) {
    abort(`${FILENAME} alters ${[...new Set(tables)].join(', ') || 'nothing'}, not only ${TABLE} - refusing to guess what it does.`);
  }
  const columns = [...code.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_0-9]+)\s+NUMERIC\((\d+),\s*(\d+)\)/gi)]
    .map(m => ({ name: m[1], precision: Number(m[2]), scale: Number(m[3]) }));
  const constraints = [...code.matchAll(/ADD CONSTRAINT\s+([a-z_0-9]+)\s+CHECK\s*\(([^;]*)\)\s*;/gi)]
    .map(m => ({ name: m[1], check: m[2].replace(/\s+/g, ' ').trim() }));
  const unguardedColumns = (code.match(/ADD COLUMN(?! IF NOT EXISTS)/gi) || []).length;
  if (!columns.length || !constraints.length || unguardedColumns) {
    abort(`${FILENAME} is not in a shape this check understands `
      + `(columns ${columns.length}, constraints ${constraints.length}, unguarded columns ${unguardedColumns}) - refusing.`);
  }
  // Can the file finish a half-applied schema without touching what is
  // already there? Only if every constraint is added solely when absent,
  // nothing is dropped or rewritten, and the runner - not the file - owns
  // the transaction.
  const guarded = constraints.every(k => new RegExp(
    "IF NOT EXISTS \\(SELECT 1 FROM pg_constraint\\s+WHERE conname = '" + k.name + "'\\)", 'i').test(code));
  const destructive = /\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(code);
  return { columns, constraints, idempotent: guarded && !destructive && !managesOwnTransaction(sql) };
}

// ── database helpers ─────────────────────────────────
const present = async (client, table) =>
  (await client.query('SELECT to_regclass($1) AS t', ['public.' + table])).rows[0].t !== null;

// Neon's free compute suspends when idle, so the very first connection of a
// deploy can arrive while it is still waking.
async function connectWithRetry(pool, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (i === attempts) throw err;
      warn(`  database not reachable yet (attempt ${i}/${attempts}: ${err.message}) - retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null; // unreachable
}

// What PostgreSQL makes of each of the file's own CHECK expressions, on
// columns of the file's own types - so a constraint already in the database
// is compared by meaning, not by spelling. Done on a temporary table inside a
// transaction that is always rolled back: nothing of it survives.
async function expectedDefinitions(client, plan) {
  const cols = plan.columns.map(c => `${c.name} NUMERIC(${c.precision},${c.scale})`).join(', ');
  const out = {};
  await client.query('BEGIN');
  try {
    for (const k of plan.constraints) {
      await client.query(`CREATE TEMP TABLE pft_probe (${cols}, CONSTRAINT pft_probe_check CHECK (${k.check}))`);
      const { rows } = await client.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'pft_probe'::regclass AND conname = 'pft_probe_check'");
      out[k.name] = rows[0].def;
      await client.query('DROP TABLE pft_probe');
    }
  } finally {
    await client.query('ROLLBACK');
  }
  return out;
}

async function inspect(client, plan) {
  const cols = (await client.query(
    `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
    [TABLE, plan.columns.map(c => c.name)])).rows;
  const cons = (await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2)`,
    [TABLE, plan.constraints.map(k => k.name)])).rows;
  return { cols, cons };
}

// complete | missing | partial, what is present and absent, and every way
// something present differs from the final shape.
function classify(found, plan, expected) {
  const presentObjs = [], absent = [], problems = [];
  for (const c of plan.columns) {
    const r = found.cols.find(x => x.column_name === c.name);
    if (!r) { absent.push('column ' + c.name); continue; }
    presentObjs.push('column ' + c.name);
    if (r.data_type !== 'numeric' || Number(r.numeric_precision) !== c.precision || Number(r.numeric_scale) !== c.scale) {
      problems.push(`column ${c.name} is ${r.data_type}(${r.numeric_precision},${r.numeric_scale}), not numeric(${c.precision},${c.scale})`);
    }
    if (r.is_nullable !== 'YES') problems.push(`column ${c.name} is NOT NULL - a blank charge must be storable as NULL`);
    if (r.column_default !== null) problems.push(`column ${c.name} has a default (${r.column_default}) - the migration adds none`);
  }
  for (const k of plan.constraints) {
    const r = found.cons.find(x => x.conname === k.name);
    if (!r) { absent.push('constraint ' + k.name); continue; }
    presentObjs.push('constraint ' + k.name);
    if (r.def !== expected[k.name]) problems.push(`constraint ${k.name} is ${r.def}, not ${expected[k.name]}`);
  }
  const kind = !presentObjs.length ? 'missing' : !absent.length ? 'complete' : 'partial';
  return { kind, present: presentObjs, absent, problems };
}
const describe = (s) => `present: ${s.present.join(', ') || 'nothing'}; absent: ${s.absent.join(', ') || 'nothing'}`;

async function ledgerRow(client) {
  if (!(await present(client, 'schema_migrations'))) return null;
  const { rows } = await client.query('SELECT checksum, baselined FROM schema_migrations WHERE id = $1', [ID]);
  return rows[0] || null;
}

// Missing, or partial and provably safe to complete: apply the file and
// record it in one transaction, proving the final shape before it commits.
async function applyMigration(client, sql, plan, expected) {
  log(`  applying ${FILENAME} (sha256 ${APPROVED_CHECKSUM.slice(0, 12)}…)`);
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(TABLE_DDL);
    await client.query(sql);
    const after = classify(await inspect(client, plan), plan, expected);
    if (after.kind !== 'complete' || after.problems.length) {
      throw new Error(`the migration ran but the final shape is not there (${describe(after)}`
        + `${after.problems.length ? '; ' + after.problems.join('; ') : ''})`);
    }
    const ms = Date.now() - started;
    await client.query(
      `INSERT INTO schema_migrations (id, filename, checksum, execution_ms, baselined)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [ID, FILENAME, checksum(sql), ms]);
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
  const plan = readPlan(sql);

  if (!process.env.DATABASE_URL) {
    abort('DATABASE_URL is not set, so the schema cannot be checked.');
  }
  const pool = require('../src/config/pool');
  const client = await connectWithRetry(pool);
  let locked = false;

  try {
    // The same key the migrator and the Purchase Notes check use, so no two of
    // them can ever overlap on the same database.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    const { rows: [who] } = await client.query('SELECT current_database() AS db, current_user AS usr');
    // Identity only. The connection string and password are never read here
    // and never logged.
    log(`  database: ${who.db}   user: ${who.usr}`);

    if (!(await present(client, TABLE))) {
      abort(`required table ${TABLE} is missing.\n`
        + '    This does not look like the application database, so nothing was changed.');
    }
    log(`  dependency present: ${TABLE}`);

    const expected = await expectedDefinitions(client, plan);
    const state = classify(await inspect(client, plan), plan, expected);
    const recorded = await ledgerRow(client);
    log(`  transport schema: ${state.kind} (${describe(state)})`);

    if (state.problems.length) {
      abort(`${TABLE} has transport objects that are not the shape ${FILENAME} creates:\n`
        + state.problems.map(p => '    - ' + p).join('\n') + '\n'
        + '    Completing it would leave them wrong, so the start is blocked. This needs a decision, not an automatic change.');
    }

    if (state.kind === 'complete') {
      if (!recorded) {
        // Deliberately not written: when the schema is already there this
        // check changes nothing, and recording a migration it did not run
        // would be a half-true ledger entry.
        warn(`  note: ${ID} is NOT recorded in schema_migrations (the schema was created some`);
        warn('        other way). Nothing was changed - the ledger is left as it is.');
      } else if (recorded.checksum !== APPROVED_CHECKSUM) {
        warn(`  note: ${ID} is recorded with a different checksum than the file on disk.`);
      } else {
        log(`  ${ID}: recorded (baselined=${recorded.baselined})`);
      }
      log('  already present and compatible — nothing to do');
      return;
    }

    if (recorded) {
      abort(`${ID} is recorded as applied, but the transport schema is ${state.kind} (${describe(state)}).\n`
        + '    The ledger and the schema disagree, so the start is blocked.');
    }

    if (state.kind === 'partial') {
      if (!plan.idempotent) {
        abort(`the transport schema is partial (${describe(state)}), and ${FILENAME} cannot be proven\n`
          + '    to complete it without touching what is already there - refusing.');
      }
      log('  partial, and safe to complete: everything already present has the final shape, and the');
      log('  migration adds each column IF NOT EXISTS and each constraint only when absent');
    }

    await applyMigration(client, sql, plan, expected);
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
