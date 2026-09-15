// Two architecture guarantees, both protecting regressions that actually
// happened in this repository.
//
//   S-series  schema.sql is the COMPLETE current baseline. Six tables
//             (purchase_orders, purchase_order_items, stock_locations,
//             stock_balances, stock_movements, stock_serials) existed only
//             in migrations, so a database built from schema.sql alone had
//             no stock ledger and no purchase orders while four server
//             routes and two client pages required them.
//
//   B-series  baseline never lies. It records migrations as applied without
//             running them, and it used to trust the operator completely -
//             baselining a schema.sql database recorded four migrations
//             whose tables did not exist, stranding them permanently.
//
// The S-series derives its expectation from the migrations themselves, not
// from a hard-coded list, so a NEW migration that creates a table and is
// never folded into schema.sql fails here too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIGDIR = path.join(ROOT, 'server', 'db', 'migrations');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema', 'schema.sql'), 'utf8');
const ORDER = JSON.parse(fs.readFileSync(path.join(MIGDIR, '_manifest.json'), 'utf8')).order;

const { ownedTables } = require(path.join(ROOT, 'server', 'src', 'db', 'migrator'));

const declaredIn = sql => {
  const out = new Set();
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) out.add(m[1].toLowerCase());
  return out;
};

// ══════════════════════════════════════════════════════════════════
//  S — schema.sql is the complete baseline
// ══════════════════════════════════════════════════════════════════

test('S1 every table any migration creates is also declared in schema.sql', () => {
  const inSchema = declaredIn(SCHEMA);
  const missing = [];
  for (const file of ORDER) {
    const sql = fs.readFileSync(path.join(MIGDIR, file), 'utf8');
    for (const t of ownedTables(sql)) {
      if (!inSchema.has(t)) missing.push(`${t} (from ${file})`);
    }
  }
  assert.deepStrictEqual(missing, [],
    'schema.sql must be the complete current baseline. A table that exists only in a migration '
    + 'means a database built from schema.sql is missing it, and the application will 500 on the '
    + 'first query — exactly how purchase_orders and the stock ledger went missing.');
});

test('S2 the six repaired tables are declared, with their dependencies first', () => {
  const inSchema = declaredIn(SCHEMA);
  for (const t of ['purchase_orders', 'purchase_order_items', 'stock_locations',
    'stock_balances', 'stock_movements', 'stock_serials']) {
    assert.ok(inSchema.has(t), 'schema.sql must declare ' + t);
  }
  const at = t => SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' ');
  // Real foreign keys fix this order; a fresh database fails to build otherwise.
  assert.ok(at('stock_locations') < at('stock_balances'), 'stock_balances references stock_locations');
  assert.ok(at('stock_locations') < at('stock_movements'), 'stock_movements.location_id references stock_locations');
  assert.ok(at('purchase_orders') < at('purchase_order_items'), 'items reference their order');
  assert.ok(at('purchase_order_items') < at('stock_serials'), 'stock_serials references purchase_order_items');
  assert.ok(at('stock_serials') < at('stock_movements'), 'stock_movements.serial_id references stock_serials');
});

test('S3 the baseline carries the FINAL shape, not each migration\'s first draft', () => {
  // These arrived in later migrations. Copying the original CREATE TABLE
  // blocks would have produced a baseline silently missing all of them.
  for (const col of ['location_id', 'to_location_id', 'transfer_id', 'serial_id']) {
    assert.ok(new RegExp('\\b' + col + '\\b').test(SCHEMA), 'stock_movements must carry ' + col);
  }
  for (const col of ['supplier_return_type', 'supplier_return_id',
    'returned_source_type', 'returned_source_id']) {
    assert.ok(new RegExp('\\b' + col + '\\b').test(SCHEMA), 'stock_serials must carry ' + col);
  }
  // The widened CHECKs, not the originals.
  assert.match(SCHEMA, /RETURNED_TO_SUPPLIER/, 'the serial status CHECK must be the widened one');
  assert.match(SCHEMA, /TRANSFER_IN/, 'the movement type CHECK must include the transfer pair');
  assert.match(SCHEMA, /stock_movements_transfer_shape_check/, 'the transfer shape CHECK must survive');
});

// ══════════════════════════════════════════════════════════════════
//  B — baseline cannot vouch for schema it cannot see
// ══════════════════════════════════════════════════════════════════

test('B1 ownedTables reads a migration\'s own CREATE TABLE statements', () => {
  assert.deepStrictEqual(
    ownedTables('CREATE TABLE IF NOT EXISTS alpha (id UUID);\nCREATE TABLE IF NOT EXISTS beta (id UUID);'),
    ['alpha', 'beta']);
  // Case and whitespace are not a way round it.
  assert.deepStrictEqual(ownedTables('create table if not exists  Gamma (id UUID);'), ['gamma']);
  // No fabricated ownership: a column-only migration owns nothing.
  assert.deepStrictEqual(ownedTables('ALTER TABLE alpha ADD COLUMN IF NOT EXISTS x TEXT;'), []);
  assert.deepStrictEqual(ownedTables('CREATE INDEX IF NOT EXISTS i ON alpha (x);'), []);
});

test('B2 the repository\'s own migrations all resolve to real tables', () => {
  const inSchema = declaredIn(SCHEMA);
  let creating = 0;
  for (const file of ORDER) {
    const owned = ownedTables(fs.readFileSync(path.join(MIGDIR, file), 'utf8'));
    if (!owned.length) continue;
    creating++;
    for (const t of owned) {
      assert.ok(inSchema.has(t), `${file} creates ${t}, which schema.sql must also declare`);
    }
  }
  // A floor, not a guess: most migrations in this repository only add a
  // column, widen a CHECK or build an index, so only a minority create
  // tables. This guards against the scan silently matching nothing at all
  // (a broken regex would make every assertion above vacuous).
  assert.ok(creating >= 10,
    `only ${creating} migration(s) were found to create a table - the ownership scan looks broken`);
});


// ══════════════════════════════════════════════════════════════════
//  C — the CLI baseline guard
// ══════════════════════════════════════════════════════════════════
//
// The library contract (baseline records without executing) is deliberately
// unchanged and is pinned by migrator.test.js. The guard lives at the CLI,
// so an operator cannot baseline a database whose schema is missing the
// tables those migrations create. It runs before any write.
const os = require('os');
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const { validateBaselineTargets } = require(path.join(ROOT, 'server', 'src', 'db', 'migrator'));

const LOCAL_URL = (() => {
  const m = fs.readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
    .match(/^DATABASE_URL\s*=\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
})();
const CLI_DB = 'gst_cli_guard_probe';
const isLocal = LOCAL_URL && ['localhost', '127.0.0.1', '::1'].includes(new URL(LOCAL_URL).hostname);
const urlFor = db => LOCAL_URL.replace(/\/[^/?#]+(\?|#|$)/, '/' + db + '$1');
const NO_DB = { skip: 'no local DATABASE_URL - the CLI guard needs a throwaway database' };
const dbTest = (name, fn) => (isLocal ? test(name, fn) : test(name, NO_DB, () => {}));

async function admin(sql, params) {
  const c = new Client({ connectionString: urlFor('postgres') });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function freshCliDb() {
  await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [CLI_DB]);
  await admin(`DROP DATABASE IF EXISTS ${CLI_DB}`);
  await admin(`CREATE DATABASE ${CLI_DB}`);
}
async function dropCliDb() {
  await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [CLI_DB]);
  await admin(`DROP DATABASE IF EXISTS ${CLI_DB}`);
}
// Run the CLI as a process, against the throwaway database.
function cli(args) {
  try {
    const out = execFileSync(process.execPath, ['src/db/migrator.js', ...args], {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, DATABASE_URL: urlFor(CLI_DB) },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}
async function recordedIds() {
  const c = new Client({ connectionString: urlFor(CLI_DB) });
  await c.connect();
  try {
    const t = await c.query("SELECT to_regclass('public.schema_migrations') AS t");
    if (!t.rows[0].t) return null;
    const r = await c.query('SELECT id FROM schema_migrations ORDER BY id');
    return r.rows.map(x => x.id);
  } finally { await c.end(); }
}

test('C0 validateBaselineTargets proves ownership rather than assuming it', async () => {
  // A fake client: every table is reported absent.
  const none = { query: async (_sql, [names]) => ({ rows: names.map(n => ({ name: n, present: false })) }) };
  const plan = [{ id: 'm1', filename: 'm1.sql', sql: 'CREATE TABLE IF NOT EXISTS alpha (id int);' }];
  const r1 = await validateBaselineTargets(none, plan, []);
  assert.strictEqual(r1.divergent.length, 1);
  assert.deepStrictEqual(r1.divergent[0].missing, ['alpha']);

  // --except is not being baselined, so it is not validated.
  const r2 = await validateBaselineTargets(none, plan, ['m1']);
  assert.strictEqual(r2.divergent.length, 0);
  assert.strictEqual(r2.checked, 0);

  // A migration that creates no table owns nothing: reported, never invented.
  const colOnly = [{ id: 'm2', filename: 'm2.sql', sql: 'ALTER TABLE alpha ADD COLUMN IF NOT EXISTS x TEXT;' }];
  const r3 = await validateBaselineTargets(none, colOnly, []);
  assert.strictEqual(r3.divergent.length, 0);
  assert.deepStrictEqual(r3.unverifiable, ['m2']);
});

dbTest('C1 the CLI refuses to baseline a database missing migration-owned tables', async () => {
  await freshCliDb();
  try {
    const r = cli(['baseline', '--yes']);
    assert.notStrictEqual(r.code, 0, 'the CLI must exit non-zero');
    const msg = r.err + r.out;
    assert.match(msg, /refusing to baseline/i);
    assert.match(msg, /migration_purchases\.sql/, 'names the migration');
    assert.match(msg, /missing:/, 'names what is missing');
    assert.match(msg, /purchase_items|purchases/, 'names a missing table');
    // Nothing written for a refused migration.
    assert.strictEqual(await recordedIds(), null,
      'the guard must run before any write - schema_migrations must not even exist');
  } finally { await dropCliDb(); }
});

dbTest('C2 the CLI allows baseline when the schema really is there', async () => {
  await freshCliDb();
  try {
    const c = new Client({ connectionString: urlFor(CLI_DB) });
    await c.connect();
    await c.query(SCHEMA);          // the complete current baseline
    await c.end();

    const r = cli(['baseline', '--yes']);
    assert.strictEqual(r.code, 0, 'baseline must be allowed: ' + (r.err || r.out));
    const ids = await recordedIds();
    assert.ok(Array.isArray(ids) && ids.length === ORDER.length,
      `every migration should be recorded (${ids ? ids.length : 'none'} of ${ORDER.length})`);
    // Recorded, never executed: no migration ran, so nothing new was created
    // beyond what schema.sql itself made.
    assert.ok(ids.includes('migration_purchase_notes'));
  } finally { await dropCliDb(); }
});

dbTest('C3 --except narrows what must be proven', async () => {
  await freshCliDb();
  try {
    const c = new Client({ connectionString: urlFor(CLI_DB) });
    await c.connect();
    await c.query(SCHEMA);
    await c.query('DROP TABLE IF EXISTS purchase_notes CASCADE');
    await c.query('DROP TABLE IF EXISTS purchase_note_items CASCADE');
    await c.end();

    // Without --except the missing pair is refused...
    const bad = cli(['baseline', '--yes']);
    assert.notStrictEqual(bad.code, 0);
    assert.match(bad.err + bad.out, /migration_purchase_notes\.sql/);

    // ...and holding it back makes the rest provable.
    const ok = cli(['baseline', '--yes', '--except', 'migration_purchase_notes']);
    assert.strictEqual(ok.code, 0, 'the remainder should baseline: ' + (ok.err || ok.out));
    const ids = await recordedIds();
    assert.ok(!ids.includes('migration_purchase_notes'), 'the excluded migration stays pending');
  } finally { await dropCliDb(); }
});

// ══════════════════════════════════════════════════════════════════
//  T - transport columns in the baseline
// ══════════════════════════════════════════════════════════════════
//
// S1 proves every TABLE a migration creates is declared in schema.sql. It
// cannot see a COLUMN a migration adds to a table that already exists - and
// that is how the transport charge went missing: the invoice and proforma
// migrations add it with ALTER TABLE, so a database built from schema.sql and
// then baselined had no transport_charge, and every save touching it would
// have failed with 42703.
//
// These read the migrations themselves, so a future transport column or
// constraint is covered without editing a list here.
const TB_MIG_DIR = path.join(ROOT, 'server', 'db', 'migrations');
const TB_SCHEMA = fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema', 'schema.sql'), 'utf8')
  .replace(/\r\n/g, '\n');
const tbStrip = (s) => s.replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
const tbSquash = (s) => s.replace(/\s+/g, ' ').trim();

// Every transport column and CHECK any migration adds with ALTER TABLE.
function tbMigrationTransport() {
  const order = JSON.parse(fs.readFileSync(path.join(TB_MIG_DIR, '_manifest.json'), 'utf8')).order;
  const cols = [], cons = [];
  for (const file of order) {
    const sql = tbStrip(fs.readFileSync(path.join(TB_MIG_DIR, file), 'utf8'));
    for (const m of sql.matchAll(/ALTER TABLE\s+([a-z_0-9]+)\s+([^;]*);/gi)) {
      const table = m[1], body = m[2];
      for (const c of body.matchAll(/ADD COLUMN IF NOT EXISTS\s+(transport[a-z_0-9]*)\s+([A-Z]+(?:\(\d+(?:,\d+)?\))?)/gi)) {
        cols.push({ file, table, column: c[1], type: c[2].toUpperCase() });
      }
      for (const k of body.matchAll(/ADD CONSTRAINT\s+([a-z_0-9]*transport[a-z_0-9]*)\s+CHECK\s*\(([\s\S]*)\)\s*$/gi)) {
        cons.push({ file, table, name: k[1], check: tbSquash(k[2]) });
      }
    }
  }
  return { cols, cons };
}
function tbTableBlock(table) {
  const m = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\(([\\s\\S]*?)\\n\\);').exec(tbStrip(TB_SCHEMA));
  assert.ok(m, 'schema.sql must declare ' + table);
  return tbSquash(m[1]);
}

test('T1 every transport column a migration adds is declared in schema.sql, with the same type', () => {
  const { cols } = tbMigrationTransport();
  assert.ok(cols.length >= 6, 'the scan must find the invoice and proforma transport columns (found ' + cols.length + ')');
  for (const c of cols) {
    const decl = new RegExp('(^|[ ,(])' + c.column + ' ' + c.type.replace(/[()]/g, '\\$&') + '[ ,]');
    assert.ok(decl.test(tbTableBlock(c.table) + ' '),
      c.table + '.' + c.column + ' ' + c.type + ' (added by ' + c.file + ') is missing from schema.sql');
  }
});

test('T2 every transport CHECK a migration adds is declared in schema.sql, under the same name', () => {
  const { cons } = tbMigrationTransport();
  assert.ok(cons.length >= 6, 'the scan must find the transport constraints (found ' + cons.length + ')');
  for (const k of cons) {
    assert.ok(tbTableBlock(k.table).includes('CONSTRAINT ' + k.name + ' CHECK (' + k.check + ')'),
      k.table + ': ' + k.name + ' (added by ' + k.file + ') is missing from schema.sql, or its CHECK differs');
  }
});

dbTest('T3 a database built from schema.sql alone has the transport shape the migrations produce', async () => {
  const DBN = 'gst_tb_baseline_probe';
  await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DBN]);
  await admin(`DROP DATABASE IF EXISTS ${DBN}`);
  await admin(`CREATE DATABASE ${DBN}`);
  const c = new Client({ connectionString: urlFor(DBN) });
  c.on('error', () => {});
  await c.connect();
  try {
    await c.query(TB_SCHEMA);
    const { cols, cons } = tbMigrationTransport();
    for (const col of cols) {
      const { rows } = await c.query(
        `SELECT data_type, numeric_precision AS p, numeric_scale AS s, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [col.table, col.column]);
      assert.strictEqual(rows.length, 1, col.table + '.' + col.column + ' must exist');
      const num = /^NUMERIC\((\d+),(\d+)\)$/.exec(col.type);
      if (num) {
        assert.strictEqual(rows[0].data_type, 'numeric', col.table + '.' + col.column);
        assert.strictEqual(rows[0].p, Number(num[1]), col.table + '.' + col.column + ' precision');
        assert.strictEqual(rows[0].s, Number(num[2]), col.table + '.' + col.column + ' scale');
      }
      assert.strictEqual(rows[0].is_nullable, 'YES', col.table + '.' + col.column + ': nullable, as the migration adds it');
      assert.strictEqual(rows[0].column_default, null, col.table + '.' + col.column + ': no default, as the migration adds it');
    }
    // What PostgreSQL makes of each migration's own CHECK expression, on
    // columns of the same types - so the baseline's constraint is compared by
    // meaning, not by how it happens to be spelled.
    const probeCols = [...new Map(cols.map(x => [x.column, x.type])).entries()]
      .map(([name, type]) => name + ' ' + type).join(', ');
    for (const k of cons) {
      const got = await c.query(
        'SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass',
        [k.name, k.table]);
      assert.strictEqual(got.rows.length, 1, k.name + ' must exist on ' + k.table);
      await c.query('CREATE TEMP TABLE tb_probe (' + probeCols + ', CONSTRAINT tb_probe_check CHECK (' + k.check + '))');
      const ref = await c.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'tb_probe_check'");
      await c.query('DROP TABLE tb_probe');
      assert.strictEqual(got.rows[0].d, ref.rows[0].d, k.name + ' must mean what ' + k.file + ' declares');
    }
  } finally {
    await c.end();
    await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DBN]);
    await admin(`DROP DATABASE IF EXISTS ${DBN}`);
  }
});
