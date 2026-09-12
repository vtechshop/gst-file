// The targeted Purchase Notes schema check that runs before the app starts.
//
// It exists because production was missing `purchase_notes` and the free
// plan has no Shell, so the fix has to ride the deploy. That makes it a
// startup gate on a live service, and a startup gate earns a test for every
// way it can be wrong:
//
//   * it must apply the migration when the tables are absent
//   * it must be a true no-op afterwards, or every restart churns the schema
//   * it must refuse a database that is not this application's
//   * it must refuse a half-built state rather than guess
//   * it must never apply any other migration
//
// The database cases need a throwaway database, built from
// STOCK_TEST_DATABASE_URL's server the same way the rest of the suite does,
// and are skipped when that is not configured.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-purchase-notes.js');
const MIGRATION = path.join(ROOT, 'db', 'migrations', 'migration_purchase_notes.sql');
const APPROVED = '512dcfcea05adf9b6760fa226bf39ab99f7ec7d6e75dadda7393dcad48c20186';

// ── static checks: no database needed ────────────────

test('M1 the script pins the approved checksum, and the file still matches it', () => {
  const { checksum } = require(path.join(ROOT, 'src', 'db', 'migrator'));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, new RegExp(APPROVED), 'the approved checksum must be pinned in the script');
  assert.strictEqual(checksum(fs.readFileSync(MIGRATION, 'utf8')), APPROVED,
    'the migration file no longer matches the approved checksum — the script would refuse to run');
});

test('M2 the script never restates the schema, it reads the repository file', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/CREATE TABLE IF NOT EXISTS purchase_notes\b/.test(src),
    'the migration SQL must not be copied into the script');
  assert.match(src, /readFileSync\(file, 'utf8'\)/, 'it must read the migration from disk');
  assert.match(src, /migration_purchase_notes\.sql/);
});

test('M3 it targets only this migration and never the runner', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // `run` is the migrator's apply-everything entry point; importing it here
  // would make this script capable of applying the other 37 migrations.
  assert.ok(!/\brun\s*[,}]/.test(src.split('require(\'../src/db/migrator\')')[1] || ''),
    'the script must not import the migration runner');
  assert.ok(!/mode:\s*'up'|migrate:baseline|\bbaseline\b/.test(src),
    'the script must not reference the runner or baseline');
  const ids = src.match(/migration_[a-z_]+/g) || [];
  assert.deepStrictEqual([...new Set(ids)], ['migration_purchase_notes'],
    'no migration other than migration_purchase_notes may be named');
});

test('M4 package.json runs it before start, and exposes it as its own command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.prestart, 'node scripts/migrate-purchase-notes.js',
    'prestart must run the targeted check, so npm start cannot skip it');
  assert.strictEqual(pkg.scripts['migrate:purchase-notes'], 'node scripts/migrate-purchase-notes.js');
  assert.strictEqual(pkg.scripts.start, 'node src/app.js', 'start itself must stay unchanged');
  // prestart is pinned exactly above, so it cannot be the runner. What is
  // worth guarding is the other direction: this change must leave the
  // existing runner commands exactly as they were.
  assert.strictEqual(pkg.scripts.migrate, 'node src/db/migrator.js up');
  assert.strictEqual(pkg.scripts['migrate:status'], 'node src/db/migrator.js status');
  assert.strictEqual(pkg.scripts['migrate:baseline'], 'node src/db/migrator.js baseline');
});

// ── database cases ───────────────────────────────────

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('targeted purchase notes migration (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

const { Client } = require('pg');
const PROBE = 'gst_pn_prestart_probe';
const urlFor = (db) => SCRATCH.replace(/\/[^/?#]+(\?|#|$)/, '/' + db + '$1');

// Only the four dependencies the migration needs — deliberately not the
// whole schema, so this proves the script works on a production-shaped
// database rather than on a freshly built one.
const DEPS = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE users (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE products (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, name TEXT NOT NULL);
CREATE TABLE vendors (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, name TEXT NOT NULL);
CREATE TABLE purchases (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  vendor_name TEXT NOT NULL, purchase_number TEXT NOT NULL, purchase_date DATE NOT NULL);
INSERT INTO users (email) VALUES ('probe@example.com');
INSERT INTO purchases (user_id, vendor_name, purchase_number, purchase_date)
  SELECT id, 'Acme', 'P-1', CURRENT_DATE FROM users;
`;

async function admin(sql, params) {
  const c = new Client({ connectionString: urlFor('postgres') });
  c.on('error', () => {});
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function freshProbe(seed) {
  await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [PROBE]);
  await admin(`DROP DATABASE IF EXISTS ${PROBE}`);
  await admin(`CREATE DATABASE ${PROBE}`);
  if (seed) {
    const c = new Client({ connectionString: urlFor(PROBE) });
    c.on('error', () => {});
    await c.connect();
    try { await c.query(seed); } finally { await c.end(); }
  }
}
async function dropProbe() {
  await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [PROBE]);
  await admin(`DROP DATABASE IF EXISTS ${PROBE}`);
}
async function query(sql, params) {
  const c = new Client({ connectionString: urlFor(PROBE) });
  c.on('error', () => {});
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
// Runs the script exactly as `npm start` would, against the probe database.
function runScript() {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: urlFor(PROBE), RENDER: '' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('M5 it applies the migration when the tables are absent, and records only that one', async () => {
  await freshProbe(DEPS);
  try {
    const r = runScript();
    assert.strictEqual(r.code, 0, 'the check must succeed: ' + r.out);
    assert.match(r.out, /applying migration_purchase_notes\.sql/);

    const t = (await query(`SELECT to_regclass('public.purchase_notes') pn,
                                   to_regclass('public.purchase_note_items') pni`)).rows[0];
    assert.ok(t.pn && t.pni, 'both tables must exist');

    const led = (await query('SELECT id, checksum, baselined, execution_ms FROM schema_migrations')).rows;
    assert.strictEqual(led.length, 1, 'exactly one migration may be recorded');
    assert.strictEqual(led[0].id, 'migration_purchase_notes');
    assert.strictEqual(led[0].checksum, APPROVED);
    assert.strictEqual(led[0].baselined, false, 'it was executed, so it is not a baseline');
    assert.ok(led[0].execution_ms !== null, 'a real execution records its duration');

    const counts = (await query(`SELECT (SELECT count(*)::int FROM purchase_notes) pn,
                                        (SELECT count(*)::int FROM purchase_note_items) pni,
                                        (SELECT count(*)::int FROM purchases) p`)).rows[0];
    assert.strictEqual(counts.pn, 0, 'no business data may be created');
    assert.strictEqual(counts.pni, 0);
    assert.strictEqual(counts.p, 1, 'existing purchases must be untouched');

    const idx = (await query(`SELECT indexname FROM pg_indexes
      WHERE tablename IN ('purchase_notes','purchase_note_items')`)).rows.map((x) => x.indexname);
    for (const want of ['idx_purchase_notes_number', 'idx_purchase_notes_date',
                        'idx_purchase_notes_source', 'idx_purchase_note_items_note']) {
      assert.ok(idx.includes(want), 'missing index ' + want);
    }
  } finally { await dropProbe(); }
});

test('M6 a second run is a no-op — no schema churn on restart', async () => {
  await freshProbe(DEPS);
  try {
    assert.strictEqual(runScript().code, 0);
    const first = (await query('SELECT applied_at FROM schema_migrations')).rows[0].applied_at;

    const r = runScript();
    assert.strictEqual(r.code, 0, 'the re-run must succeed: ' + r.out);
    assert.match(r.out, /already present and compatible — nothing to do/);
    assert.ok(!/applying migration_purchase_notes/.test(r.out), 'it must not re-apply');

    const rows = (await query('SELECT applied_at FROM schema_migrations')).rows;
    assert.strictEqual(rows.length, 1, 'no duplicate ledger row');
    assert.strictEqual(rows[0].applied_at.getTime(), first.getTime(),
      'the existing record must be left exactly as it was');
  } finally { await dropProbe(); }
});

test('M7 it refuses a database that is missing its dependencies, and changes nothing', async () => {
  await freshProbe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE TABLE users (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY, email TEXT UNIQUE NOT NULL);`);
  try {
    const r = runScript();
    assert.notStrictEqual(r.code, 0, 'it must exit non-zero so npm start aborts');
    assert.match(r.out, /missing required table\(s\)/);
    assert.match(r.out, /products/);
    const t = (await query(`SELECT to_regclass('public.purchase_notes') pn,
                                   to_regclass('public.schema_migrations') sm`)).rows[0];
    assert.strictEqual(t.pn, null, 'no table may be created');
    assert.strictEqual(t.sm, null, 'not even the tracking table');
  } finally { await dropProbe(); }
});

test('M8 it refuses a half-built state rather than guessing', async () => {
  await freshProbe(DEPS);
  try {
    assert.strictEqual(runScript().code, 0);
    await query('DROP TABLE purchase_note_items');

    const r = runScript();
    assert.notStrictEqual(r.code, 0, 'a half-built schema must block the start');
    assert.match(r.out, /half-built state/);
  } finally { await dropProbe(); }
});

test('M9 it blocks the start when an existing table is missing columns', async () => {
  await freshProbe(DEPS);
  try {
    assert.strictEqual(runScript().code, 0);
    await query('ALTER TABLE purchase_notes DROP COLUMN cess_amount');

    const r = runScript();
    assert.notStrictEqual(r.code, 0, 'a 42703-shaped schema must block the start');
    assert.match(r.out, /missing 1 column\(s\): cess_amount/);
  } finally { await dropProbe(); }
});
