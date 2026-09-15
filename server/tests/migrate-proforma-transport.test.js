// The targeted Proforma transport schema check that runs before the app starts.
//
// Proforma saves write proforma_invoices.transport_charge, so production must
// have migration_proforma_transport_charge.sql before a save can succeed, and
// the free plan has no Shell. This check rides the deploy in prestart, after
// the Purchase Notes check. A startup gate on a live service earns a test for
// every way it can be wrong:
//
//   * it must apply the migration when the transport schema is absent
//   * it must be a true no-op afterwards, or every restart churns the schema
//   * it must refuse a database that is not this application's
//   * it must complete a partial state only when that is provably safe, and
//     refuse every other partial state without changing anything
//   * it must record only its own migration and change no business row
//   * npm start must run it before the server listens, and a failure must
//     stop the start
//
// The database cases need throwaway databases, built from
// STOCK_TEST_DATABASE_URL's server the same way the rest of the suite does,
// and are skipped when that is not configured.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync, execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-proforma-transport.js');
const MIGRATION = path.join(ROOT, 'db', 'migrations', 'migration_proforma_transport_charge.sql');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SRC.replace(/\/\/[^\n]*/g, '');
const { checksum, TABLE_DDL } = require(path.join(ROOT, 'src', 'db', 'migrator'));

// ── static checks: no database needed ────────────────

test('PX1 the approved checksum is pinned, and the file on disk still matches it', () => {
  const pin = /const APPROVED_CHECKSUM = '([0-9a-f]{64})';/.exec(SRC);
  assert.ok(pin, 'a 64-hex approved checksum must be pinned in the script');
  assert.strictEqual(checksum(fs.readFileSync(MIGRATION, 'utf8')), pin[1],
    'the migration file no longer matches the approved checksum - the check would refuse to run');
  assert.match(CODE, /const actual = checksum\(sql\);/, 'the checksum is computed from the file at runtime');
});

test('PX2 the script restates nothing from the migration - it reads the repository file', () => {
  assert.match(CODE, /fs\.readFileSync\(file, 'utf8'\)/);
  assert.match(CODE, /'migration_proforma_transport_charge\.sql'/);
  // No column, constraint or CHECK expression is written into the script:
  // every one is read out of the migration file at runtime.
  // The file's own name, required just above, contains a column name,
  // so it is set aside before the search.
  assert.equal(/transport_charge|transport_gst_amount|_nonneg|IS NULL OR/.test(CODE.split('migration_proforma_transport_charge').join('')), false,
    'the migration schema must not be copied into the script');
});

test('PX3 it targets only this migration and never the runner', () => {
  const imports = /const \{([^}]*)\} = require\('\.\.\/src\/db\/migrator'\)/.exec(SRC);
  assert.ok(imports, 'the migrator import must be a plain destructure');
  assert.equal(/\brun\b/.test(imports[1]), false, 'the script must not import the migration runner');
  assert.equal(/mode:\s*'up'|migrate:baseline|\bbaseline\b/.test(SRC), false, 'no runner, no baseline');
  const ids = [...new Set(SRC.match(/migration_[a-z_]+/g) || [])];
  assert.deepStrictEqual(ids, ['migration_proforma_transport_charge'], 'no other migration may be named');
});

test('PX4 prestart runs the Purchase Notes check first, then this one, and exposes it as its own command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.scripts.prestart.split('&&').map(s => s.trim()),
    ['node scripts/migrate-purchase-notes.js', 'node scripts/migrate-proforma-transport.js'],
    'both checks, in this order, joined so that either one failing stops the start');
  assert.strictEqual(pkg.scripts['migrate:proforma-transport'], 'node scripts/migrate-proforma-transport.js');
  assert.strictEqual(pkg.scripts.start, 'node src/app.js', 'start itself must stay unchanged');
});

// ── database cases ───────────────────────────────────

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('targeted proforma transport migration (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

const { Client } = require('pg');
const PROBE = 'gst_pft_probe';
const urlFor = (db) => SCRATCH.replace(/\/[^/?#]+(\?|#|$)/, '/' + db + '$1');
const APPROVED = /const APPROVED_CHECKSUM = '([0-9a-f]{64})';/.exec(SRC)[1];

// A proforma table as production has it today: no transport columns, and
// real quotations already in it. Deliberately not the whole schema - the
// migration needs only this table.
const PROFORMA = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE proforma_invoices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  document_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  supply_type TEXT NOT NULL DEFAULT 'intrastate',
  taxable_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0
);
INSERT INTO proforma_invoices (document_number, customer_name, taxable_amount, gst_amount, total_amount)
VALUES ('PI-00001', 'Existing Quote Co', 2700, 486, 3186),
       ('PI-00002', 'Another Quote Co', 1000, 180, 1180);
`;
// What the Purchase Notes check needs, for the startup-order case.
const PN_DEPS = `
CREATE TABLE users (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE products (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, name TEXT NOT NULL);
CREATE TABLE vendors (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, name TEXT NOT NULL);
CREATE TABLE purchases (id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  vendor_name TEXT NOT NULL, purchase_number TEXT NOT NULL, purchase_date DATE NOT NULL);
`;

async function admin(sql, params) {
  const c = new Client({ connectionString: urlFor('postgres') });
  c.on('error', () => {});
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
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
async function freshProbe(seed) {
  await dropProbe();
  await admin(`CREATE DATABASE ${PROBE}`);
  if (seed) await query(seed);
}
// Runs the check exactly as prestart does, against the probe database.
function runScript() {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: urlFor(PROBE), RENDER: '' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const businessRows = async () => (await query(
  `SELECT id, document_number, customer_name, supply_type, taxable_amount, gst_amount, total_amount
     FROM proforma_invoices ORDER BY document_number`)).rows;
const transportColumns = async () => (await query(
  `SELECT column_name, data_type, numeric_precision AS p, numeric_scale AS s, is_nullable, column_default
     FROM information_schema.columns
    WHERE table_name = 'proforma_invoices' AND column_name LIKE 'transport%' ORDER BY 1`)).rows;
const transportConstraints = async () => (await query(
  `SELECT conname FROM pg_constraint
    WHERE conrelid = 'proforma_invoices'::regclass AND conname LIKE '%transport%' ORDER BY 1`)).rows.map(r => r.conname);
const hasLedger = async () =>
  (await query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t !== null;
const FINAL_COLUMNS = [
  ['transport_charge', 'numeric', 14, 2, 'YES', null],
  ['transport_gst_amount', 'numeric', 14, 2, 'YES', null]
];
const FINAL_CONSTRAINTS = ['proforma_invoices_transport_charge_nonneg', 'proforma_invoices_transport_gst_nonneg'];
const asRows = (cols) => cols.map(c => [c.column_name, c.data_type, c.p, c.s, c.is_nullable, c.column_default]);

test('PX5 missing schema: applies the migration, records only it, and changes no business row', async () => {
  await freshProbe(PROFORMA + TABLE_DDL + `;
    INSERT INTO schema_migrations (id, filename, checksum, baselined)
    VALUES ('migration_purchase_notes', 'migration_purchase_notes.sql', 'already-there', FALSE);`);
  try {
    const rowsBefore = await businessRows();
    const otherBefore = (await query("SELECT * FROM schema_migrations WHERE id = 'migration_purchase_notes'")).rows;

    const r = runScript();
    assert.strictEqual(r.code, 0, 'the check must succeed: ' + r.out);
    assert.match(r.out, /transport schema: missing/);
    assert.match(r.out, /applying migration_proforma_transport_charge\.sql/);

    assert.deepStrictEqual(asRows(await transportColumns()), FINAL_COLUMNS);
    assert.deepStrictEqual(await transportConstraints(), FINAL_CONSTRAINTS);

    const ledger = (await query('SELECT id, filename, checksum, baselined, execution_ms FROM schema_migrations ORDER BY id')).rows;
    assert.strictEqual(ledger.length, 2, 'the row already there, plus exactly this one');
    const mine = ledger.find(x => x.id === 'migration_proforma_transport_charge');
    assert.strictEqual(mine.filename, 'migration_proforma_transport_charge.sql');
    assert.strictEqual(mine.checksum, APPROVED, 'recorded under the checksum verified at runtime');
    assert.strictEqual(mine.baselined, false, 'it was executed, so it is not a baseline');
    assert.ok(mine.execution_ms !== null, 'a real execution records its duration');
    assert.deepStrictEqual((await query("SELECT * FROM schema_migrations WHERE id = 'migration_purchase_notes'")).rows,
      otherBefore, 'no other ledger row may be touched');

    assert.deepStrictEqual(await businessRows(), rowsBefore, 'no existing proforma may change');
    const untouched = (await query(
      'SELECT count(*)::int AS n FROM proforma_invoices WHERE transport_charge IS NULL AND transport_gst_amount IS NULL')).rows[0].n;
    assert.strictEqual(untouched, rowsBefore.length, 'every existing proforma keeps "no transport" - no backfill');
  } finally { await dropProbe(); }
});

test('PX6 a second run is a no-op - no schema churn on restart', async () => {
  await freshProbe(PROFORMA);
  try {
    assert.strictEqual(runScript().code, 0);
    const first = (await query('SELECT applied_at FROM schema_migrations')).rows;
    const rowsBefore = await businessRows();

    const r = runScript();
    assert.strictEqual(r.code, 0, 'the re-run must succeed: ' + r.out);
    assert.match(r.out, /transport schema: complete/);
    assert.match(r.out, /already present and compatible — nothing to do/);
    assert.equal(/applying/.test(r.out), false, 'it must not re-apply');

    const again = (await query('SELECT applied_at FROM schema_migrations')).rows;
    assert.strictEqual(again.length, 1, 'no duplicate ledger row');
    assert.strictEqual(again[0].applied_at.getTime(), first[0].applied_at.getTime(), 'the record is left exactly as it was');
    assert.deepStrictEqual(await businessRows(), rowsBefore);
  } finally { await dropProbe(); }
});

test('PX7 it refuses a database without proforma_invoices, and changes nothing', async () => {
  await freshProbe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  try {
    const r = runScript();
    assert.notStrictEqual(r.code, 0, 'it must exit non-zero so npm start aborts');
    assert.match(r.out, /required table proforma_invoices is missing/);
    assert.strictEqual(await hasLedger(), false, 'not even the tracking table may be created');
  } finally { await dropProbe(); }
});

test('PX8 a partial state it can prove safe is completed idempotently by the repository file', async () => {
  for (const partial of [
    'ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(14,2), ADD COLUMN transport_gst_amount NUMERIC(14,2);',
    'ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(14,2);'
  ]) {
    await freshProbe(PROFORMA + partial);
    try {
      const rowsBefore = await businessRows();
      const r = runScript();
      assert.strictEqual(r.code, 0, 'a provably safe partial state must complete: ' + r.out);
      assert.match(r.out, /transport schema: partial \(present: column transport_charge/);
      assert.match(r.out, /partial, and safe to complete/);
      assert.deepStrictEqual(asRows(await transportColumns()), FINAL_COLUMNS);
      assert.deepStrictEqual(await transportConstraints(), FINAL_CONSTRAINTS);
      const ledger = (await query('SELECT id, baselined FROM schema_migrations')).rows;
      assert.deepStrictEqual(ledger, [{ id: 'migration_proforma_transport_charge', baselined: false }]);
      assert.deepStrictEqual(await businessRows(), rowsBefore);
    } finally { await dropProbe(); }
  }
});

test('PX9 a partial state with a wrong column is refused, and nothing is changed', async () => {
  for (const [partial, wanted] of [
    ['ALTER TABLE proforma_invoices ADD COLUMN transport_charge TEXT;', /column transport_charge is text/],
    ['ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(10,2);', /column transport_charge is numeric\(10,2\), not numeric\(14,2\)/],
    ['ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(14,2) DEFAULT 0;', /column transport_charge has a default/],
    ["ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(14,2) NOT NULL DEFAULT 0;", /column transport_charge is NOT NULL/]
  ]) {
    await freshProbe(PROFORMA + partial);
    try {
      const colsBefore = await transportColumns();
      const r = runScript();
      assert.notStrictEqual(r.code, 0, 'a wrong shape must block the start: ' + partial);
      assert.match(r.out, /not the shape migration_proforma_transport_charge\.sql creates/);
      assert.match(r.out, wanted);
      assert.deepStrictEqual(await transportColumns(), colsBefore, 'nothing may be added or altered');
      assert.deepStrictEqual(await transportConstraints(), []);
      assert.strictEqual(await hasLedger(), false);
    } finally { await dropProbe(); }
  }
});

test('PX10 a constraint with the right name but a different meaning is refused', async () => {
  await freshProbe(PROFORMA + `
    ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(14,2), ADD COLUMN transport_gst_amount NUMERIC(14,2),
      ADD CONSTRAINT proforma_invoices_transport_charge_nonneg CHECK (transport_charge > 5);`);
  try {
    const r = runScript();
    assert.notStrictEqual(r.code, 0);
    assert.match(r.out, /constraint proforma_invoices_transport_charge_nonneg is CHECK/);
    assert.deepStrictEqual(await transportConstraints(), ['proforma_invoices_transport_charge_nonneg'],
      'the missing constraint is NOT added alongside a wrong one');
    assert.strictEqual(await hasLedger(), false);
  } finally { await dropProbe(); }
});

test('PX11 a ledger that says applied over a schema that is not there is refused', async () => {
  await freshProbe(PROFORMA + TABLE_DDL + `;
    INSERT INTO schema_migrations (id, filename, checksum, baselined)
    VALUES ('migration_proforma_transport_charge', 'migration_proforma_transport_charge.sql', 'x', TRUE);`);
  try {
    const r = runScript();
    assert.notStrictEqual(r.code, 0);
    assert.match(r.out, /is recorded as applied, but the transport schema is missing/);
    assert.deepStrictEqual(await transportColumns(), [], 'the columns are not added against the ledger');
  } finally { await dropProbe(); }
});

test('PX12 a completion that existing data rejects rolls back whole, and changes nothing', async () => {
  await freshProbe(PROFORMA + `
    ALTER TABLE proforma_invoices ADD COLUMN transport_charge NUMERIC(14,2), ADD COLUMN transport_gst_amount NUMERIC(14,2);
    UPDATE proforma_invoices SET transport_charge = -5 WHERE document_number = 'PI-00001';`);
  try {
    const rowsBefore = await businessRows();
    const r = runScript();
    assert.notStrictEqual(r.code, 0, 'a negative stored charge cannot take the CHECK, so the start is blocked');
    assert.match(r.out, /failed and was rolled back/);
    assert.deepStrictEqual(await transportConstraints(), [], 'neither constraint survives the rollback');
    assert.strictEqual(await hasLedger(), false, 'nor the tracking table');
    assert.deepStrictEqual(await businessRows(), rowsBefore);
    const bad = (await query("SELECT transport_charge FROM proforma_invoices WHERE document_number = 'PI-00001'")).rows[0];
    assert.strictEqual(Number(bad.transport_charge), -5, 'the existing value is left for a person to look at');
  } finally { await dropProbe(); }
});

// ── npm start: the real startup path ─────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
// npm runs prestart and start through a shell, so the server is a grandchild:
// the whole tree has to be stopped, or it keeps its port and its connections.
function stopTree(child) {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}
async function npmStart() {
  const port = await freePort();
  return new Promise((resolve) => {
    const child = spawn('npm start', {
      cwd: ROOT, shell: true, detached: process.platform !== 'win32',
      env: { ...process.env, DATABASE_URL: urlFor(PROBE), PORT: String(port), JWT_SECRET: 'pft-start-secret', RENDER: '', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const finish = (listened) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (listened) {
        const gone = new Promise(r => { child.once('exit', r); setTimeout(r, 10000); });
        stopTree(child);
        gone.then(() => resolve({ listened, out }));
      } else {
        resolve({ listened, out });
      }
    };
    const timer = setTimeout(() => { stopTree(child); finish(false); }, 90000);
    const onData = (d) => { out += d; if (/listening on/.test(out)) finish(true); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => finish(/listening on/.test(out)));
  });
}

test('PX13 npm start runs Purchase Notes, then Proforma transport, then listens - and a failed check stops it', async () => {
  await freshProbe(PROFORMA + PN_DEPS);
  try {
    const first = await npmStart();
    assert.ok(first.listened, 'the server must start once both checks pass:\n' + first.out);
    const pn = first.out.indexOf('[purchase-notes]');
    const pf = first.out.indexOf('[proforma-transport]');
    const pfDone = first.out.indexOf('[proforma-transport] schema check complete');
    const up = first.out.indexOf('listening on');
    assert.ok(pn > -1 && pf > pn, `the Purchase Notes check runs first (${pn} < ${pf})`);
    assert.ok(pfDone > pf && up > pfDone, `the server listens only after the transport check completes (${pfDone} < ${up})`);
    assert.match(first.out, /\[purchase-notes\]\s+applying migration_purchase_notes\.sql/);
    assert.match(first.out, /\[proforma-transport\]\s+applying migration_proforma_transport_charge\.sql/);

    const second = await npmStart();
    assert.ok(second.listened, 'a restart must start:\n' + second.out);
    assert.match(second.out, /\[purchase-notes\]\s+already present and compatible/);
    assert.match(second.out, /\[proforma-transport\]\s+already present and compatible/);
    assert.equal(/applying/.test(second.out), false, 'a restart re-applies neither migration');

    // Now make the transport schema wrong: the start must be refused.
    await query('ALTER TABLE proforma_invoices DROP CONSTRAINT proforma_invoices_transport_gst_nonneg');
    await query('ALTER TABLE proforma_invoices ALTER COLUMN transport_gst_amount TYPE TEXT');
    const refused = await npmStart();
    assert.strictEqual(refused.listened, false, 'the server must NOT start when a targeted check fails:\n' + refused.out);
    assert.match(refused.out, /\[proforma-transport\] FAILED/);
  } finally { await dropProbe(); }
});
