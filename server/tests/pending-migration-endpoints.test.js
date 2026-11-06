// The application, running on a database that has not had the migration yet.
//
// This is the gap that took the live site down. 1676 tests passed, every one
// of them against a database built from the CURRENT schema.sql - so nothing
// ever ran the server against the schema production actually had, and three
// endpoints that named columns from an unapplied migration answered 500:
//
//   POST /api/auth/login     users.employee_code      nobody could sign in
//   GET  /api/auth/me        users.employee_code      every page load failed
//   POST /api/<table>        <table>.created_by       nothing could be created
//
// Reads were unaffected, so the application looked alive while being
// unusable. The deploy is from git and the migration is applied by hand,
// with approval, so this state is not an accident - it is every deployment
// between shipping a feature and migrating for it, and the application has
// to work in it.
//
// P1-P6  the pre-migration database: every endpoint the browser needs
// P7-P9  the migrated database: the same endpoints, plus what the columns
//        are actually for, so degrading never becomes the permanent answer
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('pending-migration endpoints (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
{
  const u = new URL(SCRATCH);
  if (!['localhost', '127.0.0.1', '::1', ''].includes(u.hostname)) {
    throw new Error('pending-migration-endpoints.test.js refuses to run: '
      + 'STOCK_TEST_DATABASE_URL is not a local server, and this file CREATES and DROPS databases.');
  }
  if (!/scratch|test|probe/i.test(decodeURIComponent(u.pathname).replace(/^\//, ''))) {
    throw new Error('pending-migration-endpoints.test.js refuses to run: not a scratch database.');
  }
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'pending-migration-secret';

const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const net = require('net');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..');
const SCHEMA_SQL = fs.readFileSync(path.join(SERVER, 'db', 'schema', 'schema.sql'), 'utf8');
const MIGRATION_SQL = fs.readFileSync(
  path.join(SERVER, 'db', 'migrations', 'migration_employee_accounts.sql'), 'utf8');

// The columns and tables migration_employee_accounts.sql adds. Removing
// exactly these from a current schema gives the schema production has.
const EMPLOYEE_USER_COLUMNS =
  ['employee_code', 'must_change_password', 'password_changed_at', 'session_epoch'];

const urlFor = (n) => { const u = new URL(SCRATCH); u.pathname = '/' + n; return u.toString(); };
const adminClient = () => new Client({ connectionString: urlFor('postgres') });

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

function startServer(port, dbUrl) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(t); resolve({ child, stderr }); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

const PASSWORD = 'pendingmig123';

// One disposable database. `rewind` removes the employee migration's work,
// leaving precisely the schema a deployment has before that migration runs.
async function makeDatabase(name, { rewind }) {
  const admin = adminClient();
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ' + name);
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();

  const db = new Client({ connectionString: urlFor(name) });
  await db.connect();
  assert.strictEqual((await db.query('SELECT current_database() AS d')).rows[0].d, name,
    'working in the disposable database, not the shared one');
  await db.query(SCHEMA_SQL);

  if (rewind) {
    await db.query('DROP TABLE IF EXISTS employee_account_audit');
    await db.query('DROP TABLE IF EXISTS employee_accounts');
    for (const c of EMPLOYEE_USER_COLUMNS) {
      await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${c}`);
    }
    // Only the tables the migration ADDS created_by to. purchase_orders,
    // stock_serials and stock_movements carried one long before it, so
    // dropping theirs would test a state no database has ever been in -
    // and would hide the fact that their writers are already safe. The
    // list is read from the migration itself, so it cannot drift.
    const addsAuthor = [...new Set(
      [...MIGRATION_SQL.matchAll(
        /ALTER\s+TABLE\s+([a-z0-9_]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+created_by/gi)]
        .map(m => m[1]))];
    assert.ok(addsAuthor.length >= 40,
      'the migration adds created_by to 42 tables; found ' + addsAuthor.length);
    for (const t of addsAuthor) {
      await db.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS created_by`);
    }
    for (const kept of ['purchase_orders', 'stock_serials', 'stock_movements']) {
      const { rows: has } = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name='created_by'`, [kept]);
      assert.strictEqual(has.length, 1, kept + ' kept the created_by it always had');
    }
    // Production has never run the migrator, so it has no ledger either.
    await db.query('DROP TABLE IF EXISTS schema_migrations');

    const { rows: left } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = ANY($1::text[])`, [EMPLOYEE_USER_COLUMNS]);
    assert.deepStrictEqual(left, [], 'the employee columns really are gone');
    assert.strictEqual(
      (await db.query("SELECT to_regclass('public.employee_accounts') AS t")).rows[0].t, null,
      'and so is the employee table');
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const { rows: u } = await db.query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id',
    ['pending@scratch.test', hash, 'Pending Migration']);
  await db.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
     VALUES ($1,'VTECH','VTECH Engineering Works','33AAGCV4521K1ZT','Tamil Nadu','Coimbatore','14 Road')`,
    [u[0].id]);

  const port = await freePort();
  const { child, stderr } = await startServer(port, urlFor(name));
  return { name, db, server: child, stderr, userId: u[0].id, base: 'http://127.0.0.1:' + port };
}

async function dropDatabase(env) {
  if (!env) return;
  if (env.server) env.server.kill();
  if (env.db) await env.db.end().catch(() => {});
  const admin = adminClient();
  await admin.connect();
  // The server's pool may not have finished closing. DROP DATABASE waits
  // for every connection, with no timeout, so a straggler would hang the
  // whole run rather than fail it - close them first.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [env.name]).catch(() => {});
  await admin.query('DROP DATABASE IF EXISTS ' + env.name);
  await admin.end();
}

async function api(env, method, p, { token, body } = {}) {
  const res = await fetch(env.base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes answer no body */ }
  return { status: res.status, body: json };
}
const shown = (r) => JSON.stringify(r && r.body);

// ══════════════ P1-P6: the database production actually has ══════════════
let pending = null;
let pendingToken = '';

test('setup: a database with the employee migration NOT applied', async () => {
  pending = await makeDatabase('gst_pendingmig_probe', { rewind: true });
});

test('P1 signing in works', async () => {
  const r = await api(pending, 'POST', '/api/auth/login',
    { body: { identifier: 'pending@scratch.test', password: PASSWORD } });
  assert.strictEqual(r.status, 200, 'login must not 500 on a pending migration: ' + shown(r));
  assert.ok(r.body.token, 'a token comes back');
  assert.strictEqual(r.body.user.email, 'pending@scratch.test');
  assert.strictEqual(r.body.user.employee_code, null, 'no Employee ID exists yet, and that is not an error');
  assert.strictEqual(r.body.must_change_password, false);
  pendingToken = r.body.token;
});

test('P2 a wrong password is still refused, and still generically', async () => {
  const r = await api(pending, 'POST', '/api/auth/login',
    { body: { identifier: 'pending@scratch.test', password: 'wrong-password' } });
  assert.strictEqual(r.status, 401, shown(r));
  assert.strictEqual(r.body.error.code, 'invalid_credentials');
  assert.match(r.body.error.message, /Invalid email or password/);
});

test('P3 an Employee ID cannot sign in, and says so as a credentials failure', async () => {
  // The column it matches on does not exist, and no employee can exist
  // without it - so there is nothing to find. It must read as wrong
  // credentials, never as a server error.
  const r = await api(pending, 'POST', '/api/auth/login',
    { body: { identifier: 'VT-EMP-K7M4Q9', password: PASSWORD } });
  assert.strictEqual(r.status, 401, 'not a 500: ' + shown(r));
  assert.strictEqual(r.body.error.code, 'invalid_credentials');
});

test('P4 /auth/me works - the call every page makes', async () => {
  const r = await api(pending, 'GET', '/api/auth/me', { token: pendingToken });
  assert.strictEqual(r.status, 200,
    'this 500 is what made every page say "Could not reach the server": ' + shown(r));
  assert.strictEqual(r.body.user.id, pending.userId);
  assert.strictEqual(r.body.user.employee_code, null);
  assert.strictEqual(r.body.user.role, 'admin', 'with no employees, the account is its own admin');
  assert.strictEqual(r.body.user.permissions, null, 'an admin is unrestricted, not un-permissioned');
  assert.strictEqual(r.body.user.record_scope, 'all');
  assert.strictEqual(r.body.user.must_change_password, false);
});

test('P5 reading and creating both work', async () => {
  const list = await api(pending, 'GET', '/api/proforma_invoices?limit=5', { token: pendingToken });
  assert.strictEqual(list.status, 200, shown(list));
  assert.ok(Array.isArray(list.body));

  const made = await api(pending, 'POST', '/api/customers', {
    token: pendingToken,
    body: { name: 'Pending Customer', phone: '9876543210', state: 'Tamil Nadu' }
  });
  assert.strictEqual(made.status, 201, 'creating must not 500 for a missing created_by: ' + shown(made));
  assert.strictEqual(made.body.name, 'Pending Customer');

  // Ownership is from the original schema and is still enforced; only
  // authorship, which has nowhere to go, is skipped.
  assert.strictEqual(made.body.user_id, pending.userId, 'the row is still owned by the session');
  assert.strictEqual('created_by' in made.body, false, 'and carries no author column at all');

  const { rows } = await pending.db.query(
    'SELECT user_id FROM customers WHERE id = $1', [made.body.id]);
  assert.strictEqual(rows[0].user_id, pending.userId, 'as stored');
});

test('P6 employee management reports the migration, it does not crash', async () => {
  const r = await api(pending, 'GET', '/api/employees', { token: pendingToken });
  assert.strictEqual(r.status, 503, 'a clear refusal, not a 500: ' + shown(r));
  assert.strictEqual(r.body.error.code, 'migration_pending');
});

test('teardown: drop the pre-migration database', async () => {
  // Cleanup FIRST, assert second. An assertion that throws before the
  // child process is killed leaves it holding its stdio pipes open, and
  // the whole run then hangs instead of failing - which is exactly what
  // happened the first time this file caught the bug it was written for.
  const log = pending.stderr.join('');
  await dropDatabase(pending);
  pending = null;

  // Nothing the server logged may be an undefined-column error: a 200 that
  // swallowed one somewhere else would still be a bug.
  assert.strictEqual(/does not exist/.test(log), false,
    'no missing-column errors were logged:\n' + log.slice(0, 2000));
});

// ══════════════ P7-P9: once the migration IS applied ══════════════
//
// Degrading must not quietly become the permanent behaviour: where the
// columns exist they have to be used.
let migrated = null;
let migratedToken = '';

test('setup: a database with the migration applied', async () => {
  migrated = await makeDatabase('gst_appliedmig_probe', { rewind: false });
});

test('P7 signing in still works, and still reports no Employee ID for an admin', async () => {
  const r = await api(migrated, 'POST', '/api/auth/login',
    { body: { identifier: 'pending@scratch.test', password: PASSWORD } });
  assert.strictEqual(r.status, 200, shown(r));
  assert.ok(r.body.token);
  assert.strictEqual(r.body.user.employee_code, null, 'an owner has no Employee ID');
  migratedToken = r.body.token;
});

test('P8 /auth/me still works', async () => {
  const r = await api(migrated, 'GET', '/api/auth/me', { token: migratedToken });
  assert.strictEqual(r.status, 200, shown(r));
  assert.strictEqual(r.body.user.id, migrated.userId);
  assert.strictEqual(r.body.user.role, 'admin');
  assert.strictEqual(r.body.user.permissions, null);
});

test('P9 authorship IS recorded once the column exists', async () => {
  const made = await api(migrated, 'POST', '/api/customers', {
    token: migratedToken,
    body: { name: 'Applied Customer', phone: '9876543211', state: 'Tamil Nadu' }
  });
  assert.strictEqual(made.status, 201, shown(made));

  const { rows } = await migrated.db.query(
    'SELECT user_id, created_by FROM customers WHERE id = $1', [made.body.id]);
  assert.strictEqual(rows[0].user_id, migrated.userId, 'owned by the account');
  assert.strictEqual(rows[0].created_by, migrated.userId,
    'and attributed to whoever created it - the degraded path must not be the only path');
});

test('teardown: drop the migrated database', async () => {
  await dropDatabase(migrated);
  migrated = null;
});
