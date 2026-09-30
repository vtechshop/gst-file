#!/usr/bin/env node
// Targeted, idempotent schema check for export invoices billed in a foreign
// currency.
//
// Why this exists, and why it is not `npm run migrate`
// ----------------------------------------------------
// An export can now be billed in the buyer's currency. Its save route writes
// b2b_invoices / b2c_invoices currency_code, exchange_rate and the fx_*
// columns, and invoice_items fx_rate / fx_taxable_value / fx_total_amount, so
// until that migration has run every export save fails with 42703 - the exact
// failure mode db/MIGRATIONS.md was written after. The free plan has no
// Shell, so the migration has to ride the deploy; and for the reasons
// scripts/migrate-purchase-notes.js sets out, the full runner must never run
// at boot.
//
// A DOMESTIC invoice is unaffected either way: the page sends no fx_* key at
// all when no currency is chosen, so a database that has not been migrated
// yet keeps saving rupee invoices exactly as before. This check is what makes
// the export half safe, not what keeps the rest working.
//
// So this applies ONE named migration and nothing else:
//
//   * reads db/migrations/<FILENAME> from disk and refuses to run unless its
//     sha256, computed here at runtime, is the approved one
//   * everything it checks - the columns, their types, the constraint names
//     and what each CHECK means - is read from that file, never restated
//   * touches only those columns on those three tables, their CHECK
//     constraints, and the one schema_migrations row recording it
//   * records baselined = false, because the SQL really is executed
//   * no-ops once the final shape is present, so a restart costs a few
//     catalogue queries and changes nothing
//   * takes the migrator's own advisory lock first, so two instances booting
//     together cannot both apply it - the second waits, then finds the work
//     done and does nothing
//   * a PARTIAL state is completed only when that can be proven safe: every
//     object already there has exactly the final shape, and the file adds
//     every column IF NOT EXISTS and every constraint only when absent.
//     Anything else is refused, and the final shape is checked again inside
//     the transaction before it commits
//   * on any failure it rolls back, exits non-zero, and npm does not start
//     the app on an unverified schema
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// The migrator owns the checksum algorithm, the id convention, the tracking
// table's shape, the advisory lock key and the rule for a self-managed
// transaction. Imported, never re-stated.
const { checksum, idOf, TABLE_DDL, LOCK_KEY, MIGRATIONS_DIR, managesOwnTransaction } = require('../src/db/migrator');

const FILENAME = 'migration_invoice_export_currency.sql';
const ID = idOf(FILENAME);
// The three tables this migration is allowed to touch. Stated here so a file
// that alters anything else is refused rather than applied on trust.
const TABLES = ['b2b_invoices', 'b2c_invoices', 'invoice_items'];

// Pinned deliberately. If the migration file is ever edited, this check stops
// rather than applying something that was never reviewed - and the mismatch
// is reported with both values so the difference is obvious.
const APPROVED_CHECKSUM = 'e4bca783d214e5626bce67223ba506d319af7d4df6995d21079a200f91bf0026';

const TAG = '[invoice-export-currency]';
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
//
// Columns are attributed to the table of the ALTER TABLE they sit under: this
// file alters three tables, and b2b_invoices gaining invoice_items' columns
// would be a real failure rather than a spelling difference.
function readPlan(sql) {
  const code = sql.replace(/--[^\n]*/g, '');
  const altered = [...code.matchAll(/ALTER TABLE\s+([a-z_0-9]+)/gi)].map(m => m[1]);
  const unknown = [...new Set(altered)].filter(t => !TABLES.includes(t));
  if (!altered.length || unknown.length) {
    abort(`${FILENAME} alters ${unknown.join(', ') || 'nothing'}, which is not among `
      + `${TABLES.join(', ')} - refusing to guess what it does.`);
  }

  // ALTER TABLE <t> ... ADD COLUMN IF NOT EXISTS <name> <type>, repeated.
  const columns = [];
  for (const stmt of code.split(';')) {
    const t = (stmt.match(/ALTER TABLE\s+([a-z_0-9]+)/i) || [])[1];
    if (!t || !TABLES.includes(t)) continue;
    for (const m of stmt.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_0-9]+)\s+(TEXT|NUMERIC\((\d+),\s*(\d+)\))/gi)) {
      columns.push({ table: t, name: m[1],
        type: m[3] ? 'numeric' : 'text',
        precision: m[3] ? Number(m[3]) : null,
        scale: m[4] ? Number(m[4]) : null });
    }
  }

  // Each CHECK, with the table it belongs to, taken from the guarded block.
  const constraints = [...code.matchAll(
    /IF NOT EXISTS \(SELECT 1 FROM pg_constraint\s+WHERE conname = '([a-z_0-9]+)'\)\s+THEN\s+ALTER TABLE\s+([a-z_0-9]+)\s+ADD CONSTRAINT\s+\1\s+CHECK\s*\(([\s\S]*?)\);\s+END IF;/gi)]
    .map(m => ({ name: m[1], table: m[2], check: m[3].replace(/\s+/g, ' ').trim() }));

  const unguardedColumns = (code.match(/ADD COLUMN(?! IF NOT EXISTS)/gi) || []).length;
  const unguardedConstraints = (code.match(/ADD CONSTRAINT/gi) || []).length - constraints.length;
  if (!columns.length || !constraints.length || unguardedColumns || unguardedConstraints) {
    abort(`${FILENAME} is not in a shape this check understands `
      + `(columns ${columns.length}, constraints ${constraints.length}, `
      + `unguarded columns ${unguardedColumns}, unguarded constraints ${unguardedConstraints}) - refusing.`);
  }

  // Can the file finish a half-applied schema without touching what is
  // already there? Only if every constraint is added solely when absent,
  // nothing is dropped or rewritten, and the runner - not the file - owns
  // the transaction.
  const destructive = /\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(code);
  return { columns, constraints, idempotent: !destructive && !managesOwnTransaction(sql) };
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
  const out = {};
  await client.query('BEGIN');
  try {
    for (const k of plan.constraints) {
      const cols = plan.columns.filter(c => c.table === k.table)
        .map(c => `${c.name} ${c.type === 'text' ? 'TEXT' : `NUMERIC(${c.precision},${c.scale})`}`)
        .join(', ');
      await client.query(`CREATE TEMP TABLE iec_probe (${cols}, CONSTRAINT iec_probe_check CHECK (${k.check}))`);
      const { rows } = await client.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'iec_probe'::regclass AND conname = 'iec_probe_check'");
      out[k.name] = rows[0].def;
      await client.query('DROP TABLE iec_probe');
    }
  } finally {
    await client.query('ROLLBACK');
  }
  return out;
}

async function inspect(client, plan) {
  const cols = (await client.query(
    `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name = ANY($2)`,
    [TABLES, [...new Set(plan.columns.map(c => c.name))]])).rows;
  const cons = (await client.query(
    `SELECT conname, conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conname = ANY($1)`,
    [plan.constraints.map(k => k.name)])).rows;
  return { cols, cons };
}

// complete | missing | partial, what is present and absent, and every way
// something present differs from the final shape.
function classify(found, plan, expected) {
  const presentObjs = [], absent = [], problems = [];
  for (const c of plan.columns) {
    const where = `${c.table}.${c.name}`;
    const r = found.cols.find(x => x.table_name === c.table && x.column_name === c.name);
    if (!r) { absent.push('column ' + where); continue; }
    presentObjs.push('column ' + where);
    if (c.type === 'numeric') {
      if (r.data_type !== 'numeric' || Number(r.numeric_precision) !== c.precision || Number(r.numeric_scale) !== c.scale) {
        problems.push(`column ${where} is ${r.data_type}(${r.numeric_precision},${r.numeric_scale}), not numeric(${c.precision},${c.scale})`);
      }
    } else if (r.data_type !== 'text') {
      problems.push(`column ${where} is ${r.data_type}, not text`);
    }
    if (r.is_nullable !== 'YES') problems.push(`column ${where} is NOT NULL - a rupee invoice stores NULL in it`);
    if (r.column_default !== null) problems.push(`column ${where} has a default (${r.column_default}) - the migration adds none`);
  }
  for (const k of plan.constraints) {
    const r = found.cons.find(x => x.conname === k.name);
    if (!r) { absent.push('constraint ' + k.name); continue; }
    presentObjs.push('constraint ' + k.name);
    if (r.table_name !== k.table) problems.push(`constraint ${k.name} is on ${r.table_name}, not ${k.table}`);
    else if (r.def !== expected[k.name]) problems.push(`constraint ${k.name} is ${r.def}, not ${expected[k.name]}`);
  }
  const kind = !presentObjs.length ? 'missing' : !absent.length ? 'complete' : 'partial';
  return { kind, present: presentObjs, absent, problems };
}
const describe = (s) => `present: ${s.present.length} object(s); absent: ${s.absent.join(', ') || 'nothing'}`;

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
    // The same key the migrator and the other targeted checks use, so no two
    // of them can ever overlap on the same database - including two app
    // instances starting at the same moment.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    const { rows: [who] } = await client.query('SELECT current_database() AS db, current_user AS usr');
    // Identity only. The connection string and password are never read here
    // and never logged.
    log(`  database: ${who.db}   user: ${who.usr}`);

    for (const t of TABLES) {
      if (!(await present(client, t))) {
        abort(`required table ${t} is missing.\n`
          + '    This does not look like the application database, so nothing was changed.');
      }
    }
    log(`  dependencies present: ${TABLES.join(', ')}`);

    const expected = await expectedDefinitions(client, plan);
    const state = classify(await inspect(client, plan), plan, expected);
    const recorded = await ledgerRow(client);
    log(`  export-currency schema: ${state.kind} (${describe(state)})`);

    if (state.problems.length) {
      abort('the invoice tables have export-currency objects that are not the shape '
        + `${FILENAME} creates:\n`
        + state.problems.map(p => '    - ' + p).join('\n') + '\n'
        + '    Completing it would leave them wrong, so the start is blocked. This needs a decision, not an automatic change.');
    }

    if (state.kind === 'complete') {
      if (!recorded) {
        // Deliberately not written: when the schema is already there this
        // check changes nothing, and recording a migration it did not run
        // would be a half-true ledger entry. This is the normal state of a
        // database built from schema.sql and then baselined.
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
      abort(`${ID} is recorded as applied, but the export-currency schema is ${state.kind} `
        + `(${describe(state)}).\n    The ledger and the schema disagree, so the start is blocked.`);
    }

    if (state.kind === 'partial') {
      if (!plan.idempotent) {
        abort(`the export-currency schema is partial (${describe(state)}), and ${FILENAME} cannot be\n`
          + '    proven to complete it without touching what is already there - refusing.');
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
