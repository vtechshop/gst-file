// Phase 0 — account-root cascade protection.
//
// Before this migration, `DELETE FROM users WHERE id = ...` destroyed that
// account's entire business history through 49 ON DELETE CASCADE foreign
// keys. Nothing in the application deletes a user, so it never fired; these
// tests are what make that a property of the database rather than luck.
//
// What is asserted, in order: the file is shaped so the runner can make it
// atomic; the conversion really is transactional; the end state is exactly
// 49 RESTRICT; names, indexes and NOT NULL survive; the cascades that are
// SUPPOSED to cascade still do; deletion is refused for an account that owns
// anything, and still allowed for one that owns nothing; the rollback
// restores the original state; and DELETE /api/profiles is closed while GET
// and PATCH keep working.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE local database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('cascade protection (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

// ── Local-only guard ─────────────────────────────────────────────────
//
// This file applies DDL and deletes users, so it refuses to run anywhere but
// a local scratch database. Checked here rather than trusting the runner,
// because `node --test` on this file alone bypasses scripts/test-full.js.
// Nothing from the URL is ever printed: the assertions name the hostname and
// the database only, never the credentials.
const SAFE_HOSTS = ['localhost', '127.0.0.1', '::1'];
{
  const u = new URL(SCRATCH);
  const dbName = u.pathname.replace(/^\//, '');
  if (!SAFE_HOSTS.includes(u.hostname)) {
    throw new Error(
      'cascade-protection.test.js refuses to run: STOCK_TEST_DATABASE_URL '
      + 'host is "' + u.hostname + '", not a local host. This file applies '
      + 'DDL and deletes users.');
  }
  if (!/scratch|test/i.test(dbName)) {
    throw new Error(
      'cascade-protection.test.js refuses to run: database "' + dbName
      + '" is not named as a scratch/test database.');
  }
}

process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cascade-test-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

const MIG = path.join(__dirname, '..', 'db', 'migrations', 'migration_cascade_protection.sql');
const ROLLBACK = path.join(__dirname, '..', 'db', 'migrations', 'rollback',
  'migration_cascade_protection_rollback.sql');
const MIG_SQL = fs.readFileSync(MIG, 'utf8');
const ROLLBACK_SQL = fs.readFileSync(ROLLBACK, 'utf8');

// What PostgreSQL will actually execute, with the `--` commentary removed.
// The shape assertions below have to run against this rather than the whole
// file: the header deliberately quotes `DELETE FROM users WHERE id = ...` to
// say what the migration exists to prevent, and describes the runner's
// BEGIN/COMMIT - and a test that cannot tell an explanation from an
// instruction would force the explanation out of the file. Neither of these
// files contains a string literal with `--` in it, so a line strip is exact.
const executable = (sql) => sql.replace(/--.*$/gm, '');
const MIG_EXEC = executable(MIG_SQL);
const ROLLBACK_EXEC = executable(ROLLBACK_SQL);

// The 7 document-to-line-item cascades (Group B) and the 3 history cascades
// (Group C) that this migration must leave exactly as they were.
const GROUP_B = [
  'proforma_invoice_items_proforma_invoice_id_fkey',
  'bill_of_supply_items_bill_of_supply_id_fkey',
  'delivery_challan_items_challan_id_fkey',
  'revised_invoice_items_revised_invoice_id_fkey',
  'purchase_order_items_purchase_order_id_fkey',
  'cdn_note_items_note_fk',
  'purchase_note_items_note_fk'
];
const GROUP_C = [
  'stock_movements_product_id_fkey',
  'stock_balances_product_id_fkey',
  'advance_adjustments_receipt_voucher_id_fkey'
];

let db;

// ── catalog helpers ──────────────────────────────────────────────────
const USER_FK_SQL = `
  SELECT con.conname, cl.relname AS tbl, att.attname AS col,
         con.confdeltype, con.confupdtype, con.convalidated
    FROM pg_constraint con
    JOIN pg_class      cl  ON cl.oid = con.conrelid
    JOIN pg_class      rf  ON rf.oid = con.confrelid
    JOIN pg_namespace  ns  ON ns.oid = cl.relnamespace
    JOIN unnest(con.conkey) AS k(attnum) ON TRUE
    JOIN pg_attribute  att ON att.attrelid = cl.oid AND att.attnum = k.attnum
   WHERE con.contype = 'f' AND ns.nspname = 'public' AND rf.relname = 'users'
     AND array_length(con.conkey, 1) = 1
   ORDER BY cl.relname, att.attname`;

async function userFks() { return (await db.query(USER_FK_SQL)).rows; }
async function deltypeCount(ch) {
  return (await userFks()).filter(r => r.confdeltype === ch).length;
}
async function deltypeOf(names) {
  const { rows } = await db.query(
    `SELECT con.conname, con.confdeltype
       FROM pg_constraint con WHERE con.conname = ANY($1::text[])`, [names]);
  return Object.fromEntries(rows.map(r => [r.conname, r.confdeltype]));
}
async function indexSnapshot() {
  const { rows } = await db.query(
    `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes WHERE schemaname = 'public'
      ORDER BY tablename, indexname`);
  return rows.map(r => r.tablename + '|' + r.indexname + '|' + r.indexdef).join('\n');
}
async function notNullSnapshot() {
  const { rows } = await db.query(
    `SELECT cl.relname AS tbl, att.attname AS col, att.attnotnull
       FROM pg_attribute att
       JOIN pg_class cl ON cl.oid = att.attrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE ns.nspname = 'public' AND att.attname = 'user_id' AND att.attnum > 0
        AND NOT att.attisdropped
      ORDER BY cl.relname`);
  return rows.map(r => r.tbl + '|' + r.attnotnull).join('\n');
}

// ── seeding ──────────────────────────────────────────────────────────
let seq = 0;
async function newUser({ withProfile = true } = {}) {
  seq += 1;
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'x', 'Cascade Test') RETURNING id`,
    ['cascade' + seq + '@scratch.test']);
  const id = rows[0].id;
  if (withProfile) {
    await db.query('INSERT INTO profiles (id, email) VALUES ($1, $2)',
      [id, 'cascade' + seq + '@scratch.test']);
  }
  return id;
}
async function deleteUser(id) {
  try {
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    return { ok: true, code: null };
  } catch (err) {
    // The transaction is poisoned once a constraint fires; the harness runs
    // statements outside an explicit transaction, so nothing to roll back,
    // but the error code is the whole point of the assertion.
    return { ok: false, code: err.code, message: err.message };
  }
}

// ── server, for the DELETE /api/profiles tests ───────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function startServer(port) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: SCRATCH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(done); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}
let server, BASE;
const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const errOf = (r) => (r && r.body && r.body.error) || {};

let BEFORE_FKS, BEFORE_INDEXES, BEFORE_NOTNULL;

// ═══════════════════════════════════════════════════════════════════════
test('setup: connect and record the pre-migration state', async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  const { rows } = await db.query('SELECT current_database() AS d');
  assert.match(rows[0].d, /scratch|test/i, 'connected to a scratch database');

  await db.query('TRUNCATE users CASCADE');

  // Start from the pre-migration state whatever the scratch database was
  // left in, so this file is repeatable rather than passing only on a
  // database that has never had it applied. Restoring CASCADE here is
  // exactly what the rollback script is for, so using it also exercises it
  // before anything depends on it.
  if ((await deltypeCount('r')) === 49) {
    await db.query(ROLLBACK_SQL);
  }

  BEFORE_FKS = await userFks();
  BEFORE_INDEXES = await indexSnapshot();
  BEFORE_NOTNULL = await notNullSnapshot();
  // 53 single-column foreign keys point at users(id): the 49 that carry
  // OWNERSHIP, plus 4 that carry ATTRIBUTION (purchase_orders.created_by and
  // .cancelled_by, stock_serials.created_by, stock_movements.created_by).
  // The attribution four are ON DELETE SET NULL and must come out of this
  // migration untouched - erasing who raised a document is its own kind of
  // data loss, and nothing here is entitled to do it.
  assert.equal(BEFORE_FKS.length, 53, '53 single-column foreign keys to users(id)');
  assert.equal(BEFORE_FKS.filter(r => r.confdeltype === 'c').length, 49, '49 ownership, CASCADE');
  assert.equal(BEFORE_FKS.filter(r => r.confdeltype === 'n').length, 4, '4 attribution, SET NULL');
});

// ── C1-C3  the file is shaped for atomicity ─────────────────────────
test('C1 the migration does not open its own transaction', () => {
  const { managesOwnTransaction } = require('../src/db/migrator.js');
  assert.equal(managesOwnTransaction(MIG_SQL), false,
    'the runner must be the one to BEGIN, so its applied-record commits with the DDL');
  assert.equal(/^\s*BEGIN\s*;/mi.test(MIG_EXEC), false, 'no BEGIN statement');
  assert.equal(/\bCOMMIT\s*;/i.test(MIG_EXEC), false, 'no COMMIT statement');
  assert.equal(/\bROLLBACK\s*;/i.test(MIG_EXEC), false, 'no ROLLBACK statement');
});

test('C2 the migration touches no data', () => {
  for (const kw of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bDROP\s+TABLE\b/i, /\bDROP\s+INDEX\b/i]) {
    assert.equal(kw.test(MIG_EXEC), false, 'migration must not execute ' + kw);
    assert.equal(kw.test(ROLLBACK_EXEC), false, 'rollback must not execute ' + kw);
  }
});

test('C3 the migration is registered, the rollback is not', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '_manifest.json'), 'utf8'));
  assert.ok(manifest.order.includes('migration_cascade_protection.sql'),
    'listed in the manifest, or the runner would skip it forever');
  assert.equal(manifest.order[manifest.order.length - 1], 'migration_cascade_protection.sql',
    'last, so it runs after the receipt-voucher migration it follows');
  assert.equal(manifest.order.filter(f => /rollback/.test(f)).length, 0,
    'the rollback must never be picked up by the runner');
});

// ── C4  transactional ───────────────────────────────────────────────
test('C4 the conversion is transactional — a rollback undoes all of it', async () => {
  assert.equal(await deltypeCount('c'), 49, 'starting from CASCADE');
  await db.query('BEGIN');
  await db.query(MIG_SQL);
  assert.equal(await deltypeCount('r'), 49, 'converted inside the transaction');
  await db.query('ROLLBACK');
  assert.equal(await deltypeCount('c'), 49,
    'all 49 back to CASCADE — so a failed assertion leaves no partial conversion');
  assert.equal(await deltypeCount('r'), 0);
});

// ── C5  apply ───────────────────────────────────────────────────────
test('C5 applying the migration converts exactly 49 to RESTRICT', async () => {
  await db.query(MIG_SQL);
  const after = await userFks();
  assert.equal(after.filter(r => r.confdeltype === 'r').length, 49, 'exactly 49 RESTRICT');
  assert.equal(after.filter(r => r.confdeltype === 'c').length, 0, 'no CASCADE left');
  assert.equal(after.length, 53, 'no constraint was added or lost');
  assert.equal(after.filter(r => r.confdeltype === 'n').length, 4,
    'the 4 attribution keys are still SET NULL - attribution was not touched');
  assert.ok(after.filter(r => r.confdeltype === 'r').every(r => r.convalidated),
    'every converted constraint is VALIDATED, not left NOT VALID');
});

test('C6 profiles.id is among the converted', async () => {
  const row = (await userFks()).find(r => r.tbl === 'profiles' && r.col === 'id');
  assert.ok(row, 'profiles.id references users(id)');
  assert.equal(row.confdeltype, 'r', 'and is now RESTRICT');
});

// ── C7-C9  nothing else moved ───────────────────────────────────────
test('C7 constraint names are preserved exactly', async () => {
  const before = BEFORE_FKS.map(r => r.tbl + '.' + r.col + '=' + r.conname).sort();
  const after = (await userFks()).map(r => r.tbl + '.' + r.col + '=' + r.conname).sort();
  assert.deepEqual(after, before, 'same constraint name on the same table and column');
});

test('C8 indexes are untouched', async () => {
  assert.equal(await indexSnapshot(), BEFORE_INDEXES,
    'every index definition in the schema is byte-identical');
});

test('C9 NOT NULL on user_id is untouched', async () => {
  assert.equal(await notNullSnapshot(), BEFORE_NOTNULL);
  const nn = BEFORE_NOTNULL.split('\n').filter(l => l.endsWith('|true')).length;
  assert.equal(nn, 48, 'all 48 user_id columns are still NOT NULL');
});

test('C10 ON UPDATE behaviour is preserved', async () => {
  const after = await userFks();
  assert.ok(after.every(r => r.confupdtype === 'a'),
    'all still NO ACTION on update, as they were');
  const before = BEFORE_FKS.map(r => r.conname + '=' + r.confupdtype).sort();
  assert.deepEqual(after.map(r => r.conname + '=' + r.confupdtype).sort(), before);
});

test('C10b the 4 attribution foreign keys are still ON DELETE SET NULL', async () => {
  const attribution = (await userFks()).filter(r => r.confdeltype === 'n');
  assert.deepEqual(
    attribution.map(r => r.tbl + '.' + r.col).sort(),
    ['purchase_orders.cancelled_by', 'purchase_orders.created_by',
      'stock_movements.created_by', 'stock_serials.created_by']);
});

// ── C11-C12  Group B and Group C unchanged ──────────────────────────
test('C11 the 7 document-to-line-item cascades are unchanged', async () => {
  const got = await deltypeOf(GROUP_B);
  for (const name of GROUP_B) {
    assert.equal(got[name], 'c', name + ' must still be ON DELETE CASCADE');
  }
});

test('C12 the 3 history cascades are unchanged', async () => {
  const got = await deltypeOf(GROUP_C);
  for (const name of GROUP_C) {
    assert.equal(got[name], 'c', name + ' must still be ON DELETE CASCADE');
  }
});

test('C13 a Group B cascade still actually cascades', async () => {
  const uid = await newUser();
  const { rows: pf } = await db.query(
    `INSERT INTO proforma_invoices (user_id, document_number, document_date, customer_name)
     VALUES ($1, 'PI-CASCADE-1', '2026-08-01', 'Acme') RETURNING id`, [uid]);
  await db.query(
    `INSERT INTO proforma_invoice_items (user_id, proforma_invoice_id, product_name)
     VALUES ($1, $2, 'Widget')`, [uid, pf[0].id]);

  await db.query('DELETE FROM proforma_invoices WHERE id = $1', [pf[0].id]);
  const { rows: left } = await db.query(
    'SELECT count(*)::int AS n FROM proforma_invoice_items WHERE proforma_invoice_id = $1',
    [pf[0].id]);
  assert.equal(left[0].n, 0, 'items went with their header, as they must');
  await db.query('TRUNCATE users CASCADE');
});

// ── C14-C17  the behaviour this was all for ─────────────────────────
test('C14 an account owning a customer cannot be hard-deleted', async () => {
  const uid = await newUser();
  await db.query('INSERT INTO customers (user_id, name) VALUES ($1, $2)', [uid, 'Acme Traders']);

  const r = await deleteUser(uid);
  assert.equal(r.ok, false, 'the delete must be refused');
  assert.equal(r.code, '23503', 'foreign_key_violation');

  const { rows } = await db.query('SELECT count(*)::int AS n FROM customers WHERE user_id = $1', [uid]);
  assert.equal(rows[0].n, 1, 'and the customer is still there');
  await db.query('TRUNCATE users CASCADE');
});

test('C15 an account owning an invoice cannot be hard-deleted', async () => {
  const uid = await newUser();
  await db.query(
    `INSERT INTO b2b_invoices
       (user_id, gst_number, customer_name, invoice_number, invoice_date,
        taxable_amount, gst_percentage, gst_amount, total_amount, supply_type)
     VALUES ($1,'29ABCDE1234F1Z5','Acme','INV-CASCADE-1','2026-08-01',
             100,18,18,118,'intrastate')`, [uid]);

  const r = await deleteUser(uid);
  assert.equal(r.ok, false);
  assert.equal(r.code, '23503');

  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM b2b_invoices WHERE user_id = $1', [uid]);
  assert.equal(rows[0].n, 1, 'the invoice survives the attempt');
  await db.query('TRUNCATE users CASCADE');
});

test('C16 an account with only a profile cannot be hard-deleted', async () => {
  const uid = await newUser({ withProfile: true });
  const r = await deleteUser(uid);
  assert.equal(r.ok, false, 'profiles.id alone is enough to refuse');
  assert.equal(r.code, '23503');

  const { rows } = await db.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [uid]);
  assert.equal(rows[0].n, 1, 'the profile, with its numbering counters, survives');
  await db.query('TRUNCATE users CASCADE');
});

test('C17 an account owning nothing at all can still be deleted', async () => {
  const uid = await newUser({ withProfile: false });
  const r = await deleteUser(uid);
  assert.equal(r.ok, true,
    'nothing was over-restricted: an account with no profile and no records still goes');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [uid]);
  assert.equal(rows[0].n, 0);
});

// ── C18  idempotent ────────────────────────────────────────────────
test('C18 the migration is safely re-runnable', async () => {
  await db.query(MIG_SQL);
  assert.equal(await deltypeCount('r'), 49, 'second run is a no-op, not an error');
  assert.equal(await deltypeCount('c'), 0);
});

// ── C19  rollback ──────────────────────────────────────────────────
test('C19 the rollback restores the original state, then forward again', async () => {
  await db.query(ROLLBACK_SQL);
  assert.equal(await deltypeCount('c'), 49, 'all 49 back to CASCADE');
  assert.equal(await deltypeCount('r'), 0);

  const names = (await userFks()).map(r => r.tbl + '.' + r.col + '=' + r.conname).sort();
  const before = BEFORE_FKS.map(r => r.tbl + '.' + r.col + '=' + r.conname).sort();
  assert.deepEqual(names, before, 'names preserved through the round trip');
  assert.equal(await indexSnapshot(), BEFORE_INDEXES, 'indexes preserved through the round trip');

  // Leave the database protected — the state the rest of the suite should
  // run against, and the state Phase 0 is meant to deliver.
  await db.query(MIG_SQL);
  assert.equal(await deltypeCount('r'), 49);
});

// ── C20-C23  DELETE /api/profiles ──────────────────────────────────
test('setup: start the server for the API checks', async () => {
  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;
});

test('C20 DELETE /api/profiles is refused with a usable error', async () => {
  const uid = await newUser();
  await db.query(
    `UPDATE profiles SET gstin = $2, business_name = 'Acme Traders',
            invoice_current_sequence = 77 WHERE id = $1`,
    [uid, '29ABCDE1234F1Z5']);

  const r = await api('DELETE', '/api/profiles', { token: tok(uid) });
  assert.equal(r.status, 409, '409 so classifyApiError passes the message through verbatim');
  assert.equal(errOf(r).code, 'profile_delete_blocked');
  assert.match(errOf(r).message, /cannot be deleted/i);
  assert.match(errOf(r).message, /deactivate/i, 'and it says what to do instead');

  const { rows } = await db.query(
    'SELECT gstin, business_name, invoice_current_sequence FROM profiles WHERE id = $1', [uid]);
  assert.equal(rows.length, 1, 'the row is still there');
  assert.equal(rows[0].gstin, '29ABCDE1234F1Z5', 'GST settings intact');
  assert.equal(Number(rows[0].invoice_current_sequence), 77, 'numbering counter intact');
});

test('C21 GET /api/profiles still works', async () => {
  const uid = await newUser();
  await db.query('UPDATE profiles SET business_name = $2 WHERE id = $1', [uid, 'Readable Co']);
  const r = await api('GET', '/api/profiles', { token: tok(uid) });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body) && r.body.length === 1, 'one row, the caller\'s own');
  assert.equal(r.body[0].business_name, 'Readable Co');
});

test('C22 PATCH /api/profiles still works', async () => {
  const uid = await newUser();
  const r = await api('PATCH', '/api/profiles', {
    token: tok(uid), body: { business_name: 'Patched Co', state: 'Tamil Nadu' }
  });
  assert.equal(r.status, 200, 'settings must still be savable — this is not read-only');
  const { rows } = await db.query('SELECT business_name, state FROM profiles WHERE id = $1', [uid]);
  assert.equal(rows[0].business_name, 'Patched Co');
  assert.equal(rows[0].state, 'Tamil Nadu');
});

test('C23 no API route can remove a user or a profile', async () => {
  // The honest form of "soft deactivation still works": there is no
  // deactivation feature yet (it arrives with company_members in Phase 3),
  // and there is no hard-delete path either. What can be asserted today is
  // that the API offers no way to remove an account or its settings, so
  // this change broke no existing workflow.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.equal(/DELETE\s+FROM\s+users/i.test(src), false, 'auth.js deletes no user');
  const files = fs.readdirSync(path.join(__dirname, '..', 'src', 'routes'))
    .filter(f => f.endsWith('.js'));
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
    assert.equal(/DELETE\s+FROM\s+(users|profiles)\b/i.test(s), false,
      f + ' must not delete a user or profile row');
  }
  const uid = await newUser();
  const r = await api('DELETE', '/api/profiles', { token: tok(uid) });
  assert.equal(r.status, 409);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [uid]);
  assert.equal(rows[0].n, 1);
});

test('teardown', async () => {
  if (server) server.kill();
  if (db) {
    await db.query('TRUNCATE users CASCADE');
    await db.end();
  }
});
