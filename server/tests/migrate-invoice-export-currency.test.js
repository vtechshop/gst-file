// The targeted schema check that carries the export-currency migration into
// a running deployment.
//
// The full runner must never run at boot (scripts/migrate-purchase-notes.js
// says why), and the free plan has no Shell - so one named migration rides
// the deploy, checked and applied by scripts/migrate-invoice-export-currency.js.
//
// The source cases run anywhere. The behaviour cases build throwaway
// databases on STOCK_TEST_DATABASE_URL's server, the same way the rest of the
// suite does, and are skipped when that is not configured.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const rd = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-invoice-export-currency.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const MIG_FILE = 'migration_invoice_export_currency.sql';
const MIG = rd('server', 'db', 'migrations', MIG_FILE);
const PKG = JSON.parse(rd('server', 'package.json'));
const { checksum, idOf } = require('../src/db/migrator');

// ══ what the script is ════════════════════════════════════════════════

test('MG1 the script pins the approved checksum, and the file still matches it', () => {
  const pinned = (SRC.match(/APPROVED_CHECKSUM = '([a-f0-9]{64})'/) || [])[1];
  assert.ok(pinned, 'the checksum is pinned in the script');
  assert.strictEqual(checksum(MIG), pinned,
    'the migration on disk is the one that was approved - if it was edited, re-approve it deliberately');
});

test('MG2 the migration is re-runnable by construction, and reads no existing row', () => {
  const code = MIG.replace(/--[^\n]*/g, '');
  // Every column is added only when absent...
  assert.strictEqual((code.match(/ADD COLUMN(?! IF NOT EXISTS)/gi) || []).length, 0,
    'no column is added unguarded');
  assert.strictEqual((code.match(/ADD COLUMN IF NOT EXISTS/gi) || []).length, 15,
    'six columns on each invoice table and three on the lines');
  // ...and so is every constraint, which is what lets a half-applied schema
  // be finished without rewriting what is already there.
  const constraints = [...code.matchAll(/ADD CONSTRAINT\s+([a-z_0-9]+)/gi)].map(m => m[1]);
  assert.strictEqual(constraints.length, 7);
  for (const name of constraints) {
    assert.ok(new RegExp("IF NOT EXISTS \\(SELECT 1 FROM pg_constraint\\s+WHERE conname = '" + name + "'\\)").test(code),
      name + ' is added only when it is absent');
  }
  for (const kw of ['UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'INSERT']) {
    assert.strictEqual(new RegExp('\\b' + kw + '\\b', 'i').test(code), false,
      'no ' + kw + ': not one existing row is read or written');
  }
  // The runner owns the transaction, so the file must not open its own.
  assert.strictEqual(/\bBEGIN\s*;|\bCOMMIT\b/i.test(code), false, 'the file manages no transaction of its own');
});

test('MG3 the script restates nothing: it reads the file and reuses the migrator', () => {
  // The checksum algorithm, the id convention, the ledger DDL and the lock
  // key all come from the migrator - a second copy of any of them could drift.
  for (const imported of ['checksum', 'idOf', 'TABLE_DDL', 'LOCK_KEY', 'MIGRATIONS_DIR', 'managesOwnTransaction']) {
    assert.ok(new RegExp('\\b' + imported + '\\b').test(SRC), 'it imports ' + imported);
  }
  assert.match(SRC, /require\('\.\.\/src\/db\/migrator'\)/);
  // The SQL it applies is the file, never a copy pasted into the script.
  assert.match(SRC, /await client\.query\(sql\)/);
  // The DDL itself is never in the script: it names no column of its own, so
  // there is nothing here that can drift from the file it applies. (It does
  // match on "ADD COLUMN IF NOT EXISTS" - that is reading the file, not
  // restating it.)
  // Read as code: the header comment explains which columns the feature
  // writes, which is documentation, not a second copy of the schema.
  const code = SRC.split(String.fromCharCode(10)).map(l => l.replace(/^\s*\/\/.*$/, '')).join(' ');
  for (const col of ['currency_code', 'exchange_rate', 'fx_taxable_amount', 'fx_gst_amount',
    'fx_total_amount', 'destination_country', 'fx_rate', 'fx_taxable_value']) {
    assert.strictEqual(code.includes(col), false, 'the script does not name ' + col);
  }
  // It refuses a file that alters anything but these three tables.
  assert.match(SRC, /const TABLES = \['b2b_invoices', 'b2c_invoices', 'invoice_items'\]/);
  // And it takes the shared lock before it looks at anything.
  assert.match(SRC, /pg_advisory_lock\(\$1\)', \[LOCK_KEY\]/);
});

test('MG4 it targets only this migration, and never the full runner', () => {
  assert.strictEqual((SRC.match(/migration_[a-z_]+\.sql/g) || []).filter(f => f !== MIG_FILE).length, 0,
    'no other migration is named');
  assert.strictEqual(/migrator\.js (up|baseline)/.test(SRC), false, 'it never shells out to the full runner');
  assert.match(SRC, /baselined\)\s*\n?\s*VALUES \(\$1, \$2, \$3, \$4, FALSE\)/,
    'it records baselined=false, because the SQL really is executed');
});

test('MG5 package.json runs it before start, after the checks that came before it', () => {
  const pre = PKG.scripts.prestart;
  assert.ok(pre.includes('scripts/migrate-invoice-export-currency.js'), 'prestart runs it');
  assert.ok(pre.indexOf('migrate-purchase-notes') < pre.indexOf('migrate-proforma-transport')
    && pre.indexOf('migrate-proforma-transport') < pre.indexOf('migrate-invoice-export-currency'),
    'the targeted checks run in the order they were added, so npm start cannot skip any');
  assert.ok(pre.split('&&').every(c => c.trim().startsWith('node scripts/migrate-')),
    'prestart does nothing but these checks');
  assert.strictEqual(PKG.scripts['migrate:invoice-export-currency'],
    'node scripts/migrate-invoice-export-currency.js', 'and it has its own command for a manual run');
  assert.strictEqual(PKG.scripts.start, 'node src/app.js', 'start itself is unchanged');
});

test('MG6 the manifest and schema.sql agree with the migration', () => {
  const order = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json')).order;
  assert.ok(order.includes(MIG_FILE), 'the full runner knows about it too');
  assert.strictEqual(idOf(MIG_FILE), 'migration_invoice_export_currency');
  // schema.sql is the shape a NEW database is built in, so it must already
  // declare what the migration adds to an old one.
  const schema = rd('server', 'db', 'schema', 'schema.sql');
  for (const col of ['currency_code', 'exchange_rate', 'fx_taxable_amount', 'fx_gst_amount',
    'fx_total_amount', 'destination_country', 'fx_rate', 'fx_taxable_value']) {
    assert.ok(schema.includes(col), 'schema.sql declares ' + col);
  }
});

// ══ what it does to a database ════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('targeted export-currency migration (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

const { Client } = require('pg');
const PROBE = 'gst_iec_test_probe';
const urlFor = (db) => SCRATCH.replace(/\/[^/?#]+(\?|#|$)/, '/' + db + '$1');

// Only what the migration needs, and in the shape they had BEFORE it - so
// this proves the script works on a production-shaped database rather than on
// a freshly built one.
const BEFORE = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE users (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE b2b_invoices (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  invoice_number TEXT NOT NULL, invoice_date DATE NOT NULL,
  taxable_amount DECIMAL(15,2) NOT NULL, gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL);
CREATE TABLE b2c_invoices (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  invoice_number TEXT NOT NULL, invoice_date DATE NOT NULL,
  taxable_amount DECIMAL(15,2) NOT NULL, gst_amount DECIMAL(15,2) NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL);
CREATE TABLE invoice_items (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  invoice_id UUID NOT NULL, invoice_type TEXT NOT NULL,
  product_name TEXT NOT NULL, rate DECIMAL(15,2) NOT NULL DEFAULT 0);
INSERT INTO users (email) VALUES ('probe@example.com');
INSERT INTO b2b_invoices (user_id, invoice_number, invoice_date, taxable_amount, gst_amount, total_amount)
  SELECT id, 'INV-1', CURRENT_DATE, 1000, 180, 1180 FROM users;
`;

const COLUMNS = `SELECT table_name, column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name IN ('currency_code','exchange_rate',
   'fx_taxable_amount','fx_gst_amount','fx_total_amount','destination_country',
   'fx_rate','fx_taxable_value')
 ORDER BY table_name, column_name`;
const CONSTRAINTS = `SELECT conname FROM pg_constraint
 WHERE conname LIKE '%currency_pair' OR conname LIKE '%exchange_rate_positive'
    OR conname LIKE '%fx_amounts_nonneg' ORDER BY conname`;

async function admin(sql, params) {
  const c = new Client({ connectionString: urlFor('postgres') });
  c.on('error', () => {});
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function query(sql, params) {
  const c = new Client({ connectionString: urlFor(PROBE) });
  c.on('error', () => {});
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function freshProbe(seed) {
  await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [PROBE]);
  await admin(`DROP DATABASE IF EXISTS ${PROBE}`);
  await admin(`CREATE DATABASE ${PROBE}`);
  if (seed) await query(seed);
}
async function dropProbe() {
  await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [PROBE]);
  await admin(`DROP DATABASE IF EXISTS ${PROBE}`);
}
// Runs the script exactly as `npm start` would, against the probe database.
// Both streams: the script logs to stdout and warns to stderr, and a warning
// is part of what it said.
function runScript() {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: urlFor(PROBE), RENDER: '' },
    encoding: 'utf8'
  });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('MG7 it applies the migration to an existing database, and touches no row in it', async () => {
  await freshProbe(BEFORE);
  const r = runScript();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /applied in \d+ms and recorded \(baselined=false\)/);

  const cols = (await query(COLUMNS)).rows;
  assert.strictEqual(cols.length, 15, 'six columns on each invoice table, three on the lines');
  for (const c of cols) {
    assert.strictEqual(c.is_nullable, 'YES', `${c.table_name}.${c.column_name} is nullable`);
    assert.strictEqual(c.column_default, null, `${c.table_name}.${c.column_name} has no default`);
  }
  assert.deepStrictEqual((await query(CONSTRAINTS)).rows.map(r => r.conname), [
    'b2b_invoices_currency_pair', 'b2b_invoices_exchange_rate_positive', 'b2b_invoices_fx_amounts_nonneg',
    'b2c_invoices_currency_pair', 'b2c_invoices_exchange_rate_positive', 'b2c_invoices_fx_amounts_nonneg',
    'invoice_items_fx_amounts_nonneg']);

  // The invoice that was already there is the invoice it was.
  assert.deepStrictEqual((await query(
    `SELECT invoice_number, total_amount, currency_code, exchange_rate, fx_total_amount FROM b2b_invoices`)).rows,
  [{ invoice_number: 'INV-1', total_amount: '1180.00', currency_code: null, exchange_rate: null, fx_total_amount: null }]);

  // Recorded once, as executed rather than baselined, and nothing else is.
  const ledger = (await query('SELECT id, baselined FROM schema_migrations')).rows;
  assert.deepStrictEqual(ledger, [{ id: 'migration_invoice_export_currency', baselined: false }]);
  await dropProbe();
});

test('MG8 a second run changes nothing — a restart costs a few catalogue queries', async () => {
  await freshProbe(BEFORE);
  assert.strictEqual(runScript().code, 0);
  const after = runScript();
  assert.strictEqual(after.code, 0, after.out);
  assert.match(after.out, /already present and compatible/);
  assert.strictEqual(/applying migration/.test(after.out), false, 'it applies nothing the second time');
  assert.strictEqual((await query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1,
    'and records nothing twice');
  assert.strictEqual((await query(COLUMNS)).rows.length, 15);
  await dropProbe();
});

test('MG9 a half-applied schema is completed, not guessed at', async () => {
  await freshProbe(BEFORE);
  assert.strictEqual(runScript().code, 0);
  // Something interrupted it: one column and one constraint never landed.
  await query('ALTER TABLE invoice_items DROP COLUMN fx_total_amount');
  await query('ALTER TABLE b2c_invoices DROP CONSTRAINT b2c_invoices_currency_pair');
  await query("DELETE FROM schema_migrations WHERE id = 'migration_invoice_export_currency'");

  const r = runScript();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /partial, and safe to complete/);
  assert.strictEqual((await query(COLUMNS)).rows.length, 15);
  assert.strictEqual((await query(CONSTRAINTS)).rows.length, 7);
  await dropProbe();
});

test('MG10 it blocks the start when the ledger and the schema disagree', async () => {
  await freshProbe(BEFORE);
  assert.strictEqual(runScript().code, 0);
  // Recorded as applied, but something removed part of it afterwards.
  await query('ALTER TABLE invoice_items DROP COLUMN fx_rate');
  const r = runScript();
  assert.strictEqual(r.code, 1, 'the start is blocked');
  assert.match(r.out, /recorded as applied, but the export-currency schema is partial/);
  assert.match(r.out, /will not be started on an unverified schema/);
  await dropProbe();
});

test('MG11 it refuses a database that is not this application, and changes nothing', async () => {
  await freshProbe('CREATE TABLE unrelated (id INT);');
  const r = runScript();
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /required table b2b_invoices is missing/);
  assert.strictEqual((await query(COLUMNS)).rows.length, 0, 'nothing was added');
  assert.strictEqual((await query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t, null,
    'and no ledger was created');
  await dropProbe();
});

test('MG12 a database built from schema.sql is already correct, and is left alone', async () => {
  await freshProbe(null);
  await query(rd('server', 'db', 'schema', 'schema.sql'));
  const r = runScript();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /already present and compatible/);
  assert.match(r.out, /is NOT recorded in schema_migrations/,
    'it says so rather than writing a ledger row for work it did not do');
  assert.strictEqual((await query(COLUMNS)).rows.length, 15);
  await dropProbe();
});

test('MG13 two instances starting together apply it exactly once', async () => {
  await freshProbe(BEFORE);
  const both = await Promise.all([0, 1].map(() => new Promise(resolve => {
    const p = spawn(process.execPath, [SCRIPT], { cwd: ROOT,
      env: { ...process.env, DATABASE_URL: urlFor(PROBE), RENDER: '' } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
  })));

  for (const r of both) assert.strictEqual(r.code, 0, r.out);
  const applied = both.filter(r => /applied in \d+ms/.test(r.out));
  const noop = both.filter(r => /already present and compatible/.test(r.out));
  assert.strictEqual(applied.length, 1, 'exactly one of them applied it');
  assert.strictEqual(noop.length, 1, 'the other waited on the lock and found the work done');
  assert.strictEqual((await query(
    "SELECT count(*)::int AS n FROM schema_migrations WHERE id = 'migration_invoice_export_currency'").then(r => r.rows[0].n)), 1,
  'and it is recorded once');
  assert.strictEqual((await query(COLUMNS)).rows.length, 15);
  assert.strictEqual((await query(CONSTRAINTS)).rows.length, 7);
  await dropProbe();
});
