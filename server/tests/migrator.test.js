// Tests for the migration runner (src/db/migrator.js).
//
// SAFETY: every test runs against a DISPOSABLE database created and dropped
// by this file (gst_migrator_test_*). The application database named by
// DATABASE_URL is used only to reach the postgres server — its schema and
// data are never read or written. Failure/rollback cases in particular are
// deliberately destructive and must never touch a real database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool, Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const migrator = require('../src/db/migrator');

const ADMIN_URL = process.env.DATABASE_URL.replace(/\/[^/]*$/, '/postgres');
const TEST_DB = 'gst_migrator_test';
const TEST_URL = process.env.DATABASE_URL.replace(/\/[^/]*$/, '/' + TEST_DB);

async function admin(sql) {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

async function freshDatabase() {
  await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB}'`);
  await admin(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin(`CREATE DATABASE ${TEST_DB}`);
  return new Pool({ connectionString: TEST_URL });
}

// Writes a throwaway migrations directory + manifest, and points the
// runner's module-level paths at it. Keeps the real db/migrations
// untouched — these tests must never depend on, or alter, the app's own
// migration files.
function fixtureDir(files, orderOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql, 'utf8');
  fs.writeFileSync(path.join(dir, '_manifest.json'),
    JSON.stringify({ order: orderOverride || Object.keys(files) }, null, 2), 'utf8');
  return dir;
}

// migrator resolves MIGRATIONS_DIR at require time, so point it at the
// fixture by reloading the module with a patched path.
function runnerFor(dir) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'db', 'migrator.js'), 'utf8')
    .replace(/const MIGRATIONS_DIR = [^;]+;/, `const MIGRATIONS_DIR = ${JSON.stringify(dir)};`);
  const tmp = path.join(dir, '_runner.js');
  fs.writeFileSync(tmp, src, 'utf8');
  return require(tmp);
}

const OK_A = 'CREATE TABLE IF NOT EXISTS alpha (id int);';
const OK_B = 'CREATE TABLE IF NOT EXISTS beta (id int);';
const BOOM = 'CREATE TABLE IF NOT EXISTS gamma (id int);\nSELECT this_function_does_not_exist();';

test('migration runner', async (t) => {
  let pool;

  await t.test('creates the tracking table on first run', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A }));
    await r.run(pool, { log: () => {} });
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='schema_migrations' ORDER BY 1");
    const cols = rows.map(x => x.column_name);
    for (const c of ['id', 'filename', 'checksum', 'applied_at', 'execution_ms', 'baselined']) {
      assert.ok(cols.includes(c), `schema_migrations must have ${c}`);
    }
    await pool.end();
  });

  await t.test('applies a pending migration and records it', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A }));
    const res = await r.run(pool, { log: () => {} });
    assert.deepStrictEqual(res.applied, ['001_a']);
    const t1 = await pool.query("SELECT to_regclass('alpha') AS t");
    assert.ok(t1.rows[0].t, 'the migration actually ran');
    const rec = await pool.query('SELECT id, baselined, checksum FROM schema_migrations');
    assert.strictEqual(rec.rows.length, 1);
    assert.strictEqual(rec.rows[0].baselined, false);
    assert.strictEqual(rec.rows[0].checksum.length, 64);
    await pool.end();
  });

  await t.test('a second run is idempotent — zero pending, nothing re-executed', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A, '002_b.sql': OK_B }));
    const first = await r.run(pool, { log: () => {} });
    assert.strictEqual(first.applied.length, 2);
    const second = await r.run(pool, { log: () => {} });
    assert.strictEqual(second.applied.length, 0, 'nothing applied on the second run');
    assert.strictEqual(second.pending.length, 0, 'nothing pending on the second run');
    const n = await pool.query('SELECT count(*)::int n FROM schema_migrations');
    assert.strictEqual(n.rows[0].n, 2, 'no duplicate rows');
    await pool.end();
  });

  await t.test('executes in manifest order, not filename order', async () => {
    pool = await freshDatabase();
    // 'zzz' must run first because 'aaa' depends on the table it creates —
    // the same shape as vouchers -> exports_advances in the real set.
    const dir = fixtureDir({
      'zzz_parent.sql': 'CREATE TABLE IF NOT EXISTS parent (id int PRIMARY KEY);',
      'aaa_child.sql': 'CREATE TABLE IF NOT EXISTS child (id int REFERENCES parent(id));'
    }, ['zzz_parent.sql', 'aaa_child.sql']);
    const res = await runnerFor(dir).run(pool, { log: () => {} });
    assert.deepStrictEqual(res.applied, ['zzz_parent', 'aaa_child'], 'manifest order wins over sort order');
    await pool.end();
  });

  await t.test('a failing migration rolls back and is NOT recorded', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A, '002_boom.sql': BOOM, '003_c.sql': OK_B }));
    await assert.rejects(() => r.run(pool, { log: () => {} }), /this_function_does_not_exist/);

    // the good one before it stands
    assert.ok((await pool.query("SELECT to_regclass('alpha') AS t")).rows[0].t);
    // the failing one left nothing behind, not even the table it created
    // before the error — that is the rollback
    assert.strictEqual((await pool.query("SELECT to_regclass('gamma') AS t")).rows[0].t, null,
      'DDL from the failed migration must be rolled back');
    // and it is not marked applied
    const ids = (await pool.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(x => x.id);
    assert.deepStrictEqual(ids, ['001_a'], 'only the successful migration is recorded');
    // the migration after the failure never ran
    assert.strictEqual((await pool.query("SELECT to_regclass('beta') AS t")).rows[0].t, null,
      'execution stops at the first failure');
    await pool.end();
  });

  await t.test('a failed migration is retried on the next run', async () => {
    pool = await freshDatabase();
    const dir = fixtureDir({ '001_a.sql': OK_A, '002_boom.sql': BOOM });
    await assert.rejects(() => runnerFor(dir).run(pool, { log: () => {} }));
    // repair the migration, re-run, it applies
    fs.writeFileSync(path.join(dir, '002_boom.sql'), OK_B, 'utf8');
    const res = await runnerFor(dir).run(pool, { log: () => {} });
    assert.deepStrictEqual(res.applied, ['002_boom']);
    await pool.end();
  });

  await t.test('detects a migration file edited after it was applied', async () => {
    pool = await freshDatabase();
    const dir = fixtureDir({ '001_a.sql': OK_A });
    await runnerFor(dir).run(pool, { log: () => {} });
    fs.writeFileSync(path.join(dir, '001_a.sql'), OK_A + '\n-- edited after the fact\n', 'utf8');
    await assert.rejects(() => runnerFor(dir).run(pool, { log: () => {} }), /changed after being applied/);
    await pool.end();
  });

  await t.test('rejects a manifest that lists a migration twice', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A, '002_b.sql': OK_B }, ['001_a.sql', '002_b.sql', '001_a.sql']));
    await assert.rejects(() => r.run(pool, { log: () => {} }), /lists a migration twice/);
    await pool.end();
  });

  await t.test('rejects a directory and manifest that disagree', async () => {
    pool = await freshDatabase();
    // file on disk that the manifest does not list — would be silently skipped
    const dir = fixtureDir({ '001_a.sql': OK_A, '002_b.sql': OK_B }, ['001_a.sql']);
    await assert.rejects(() => runnerFor(dir).run(pool, { log: () => {} }), /disagree/);
    await pool.end();
  });

  await t.test('baseline records without executing, and needs confirmation', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A }));
    await assert.rejects(() => r.run(pool, { mode: 'baseline', log: () => {} }), /without confirmation/);

    const res = await r.run(pool, { mode: 'baseline', confirmBaseline: true, log: () => {} });
    assert.deepStrictEqual(res.applied, ['001_a']);
    assert.strictEqual((await pool.query("SELECT to_regclass('alpha') AS t")).rows[0].t, null,
      'baseline must NOT execute the migration');
    assert.strictEqual((await pool.query('SELECT baselined FROM schema_migrations')).rows[0].baselined, true);

    const after = await r.run(pool, { log: () => {} });
    assert.strictEqual(after.applied.length, 0, 'a baselined migration never runs');
    await pool.end();
  });

  await t.test('a second runner cannot run concurrently', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A }));

    // hold the advisory lock on a separate connection, as a rival runner would
    const rival = new Client({ connectionString: TEST_URL });
    await rival.connect();
    await rival.query('SELECT pg_advisory_lock($1)', [migrator.LOCK_KEY]);

    await assert.rejects(() => r.run(pool, { log: () => {} }), /holds the lock/);
    assert.strictEqual((await pool.query("SELECT to_regclass('alpha') AS t")).rows[0].t, null,
      'the blocked runner must not have applied anything');

    await rival.query('SELECT pg_advisory_unlock($1)', [migrator.LOCK_KEY]);
    await rival.end();

    const res = await r.run(pool, { log: () => {} });
    assert.deepStrictEqual(res.applied, ['001_a'], 'runs once the lock is free');
    await pool.end();
  });

  await t.test('status reports without changing anything', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A, '002_b.sql': OK_B }));
    const res = await r.run(pool, { mode: 'status', log: () => {} });
    assert.strictEqual(res.pending.length, 2);
    assert.strictEqual(res.applied.length, 0);
    assert.strictEqual((await pool.query("SELECT to_regclass('alpha') AS t")).rows[0].t, null,
      'status must not execute anything');
    await pool.end();
  });

  await t.test('status is read-only — it does not even create the tracking table', async () => {
    pool = await freshDatabase();
    const r = runnerFor(fixtureDir({ '001_a.sql': OK_A }));
    const res = await r.run(pool, { mode: 'status', log: () => {} });
    assert.strictEqual(res.initialised, false, 'reports that nothing is recorded yet');
    assert.strictEqual(res.pending.length, 1);
    const t0 = await pool.query("SELECT to_regclass('schema_migrations') AS t");
    assert.strictEqual(t0.rows[0].t, null,
      'boot-time status must not write DDL to the database');
    await pool.end();
  });

  await t.test('cleans up the disposable database', async () => {
    await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB}'`);
    await admin(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    const { rows } = await admin(`SELECT 1 FROM pg_database WHERE datname='${TEST_DB}'`);
    assert.strictEqual(rows.length, 0, 'test database removed');
  });
});

// ── The real migration set ───────────────────────────
// Not executed — only checked for the structural properties that would make
// a real run go wrong.
test('the repository\'s own migration set is well-formed', async (t) => {
  const plan = migrator.loadPlan();

  await t.test('manifest and directory agree', () => {
    assert.ok(plan.length >= 20, `expected the full migration set, got ${plan.length}`);
  });

  await t.test('every migration id is unique', () => {
    const ids = plan.map(m => m.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  await t.test('vouchers runs before exports_advances (the FK that broke production)', () => {
    const ids = plan.map(m => m.id);
    const v = ids.indexOf('migration_vouchers');
    const e = ids.indexOf('migration_exports_advances');
    assert.ok(v !== -1 && e !== -1, 'both migrations present');
    assert.ok(v < e, `migration_vouchers (${v}) must precede migration_exports_advances (${e})`);
    // and prove the filename sort gets it wrong, so the manifest is load-bearing
    assert.ok('migration_vouchers.sql' > 'migration_exports_advances.sql',
      'filename sort would put them the wrong way round — this is why _manifest.json exists');
  });

  await t.test('the two self-managed-transaction files are detected', () => {
    const own = plan.filter(m => migrator.managesOwnTransaction(m.sql)).map(m => m.id);
    assert.ok(own.includes('migration_payments_reference'));
    assert.ok(own.includes('migration_payment_status_partial'));
  });
});
