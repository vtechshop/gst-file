// Employee logins, admin-controlled, with per-module permissions.
//
// The security claims here are the ones worth distrusting, so they are
// tested against the real HTTP surface with real tokens, never by calling a
// function directly: a permission check that passes in a unit test and is
// not wired into the route is worth nothing.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE local database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('employee accounts (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

// Local-only guard. This file applies DDL and creates accounts, so it
// refuses anywhere but a scratch database. Checked here and not only in
// scripts/test-full.js, because `node --test` on this file alone bypasses
// that. Nothing from the URL is printed.
{
  const u = new URL(SCRATCH);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    throw new Error('employee-accounts.test.js refuses to run: host "' + u.hostname + '" is not local.');
  }
  const dbName = u.pathname.replace(/^\//, '');
  if (!/scratch|test/i.test(dbName)) {
    throw new Error('employee-accounts.test.js refuses to run: "' + dbName + '" is not a scratch database.');
  }
}

process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'employee-test-secret';

const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const net = require('net');
const { spawn } = require('child_process');

const MIG = path.join(__dirname, '..', 'db', 'migrations', 'migration_employee_accounts.sql');
const MIG_SQL = fs.readFileSync(MIG, 'utf8');
const executable = (sql) => sql.replace(/--.*$/gm, '');

const {
  randomCode, isEmployeeId, generateEmployeeId, generateTemporaryPassword, ALPHABET, PREFIX
} = require('../src/utils/employeeId');
const { sanitisePermissions, accessAllows, accessModuleForApiPath, ACCESS_GRANTABLE } =
  require('../../shared/access-modules');

let db, server, BASE;
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
    child.on('exit', (c) => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}
async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const errOf = (r) => (r && r.body && r.body.error) || {};
const login = (identifier, password) => api('POST', '/api/auth/login', { body: { identifier, password } });

// Two independent Admins, so cross-account isolation can be asserted.
let ADMIN_A, ADMIN_B, TOK_A, TOK_B;

test('setup: migrate the scratch database and sign in two admins', async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  const { rows } = await db.query('SELECT current_database() AS d');
  assert.match(rows[0].d, /scratch|test/i);

  await db.query(MIG_SQL);           // idempotent; see E2
  await db.query('TRUNCATE users CASCADE');

  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;

  const a = await api('POST', '/api/auth/register',
    { body: { email: 'admin-a@scratch.test', password: 'adminpass1', name: 'Admin A' } });
  assert.equal(a.status, 201, 'admin A registers');
  ADMIN_A = a.body.user.id; TOK_A = a.body.token;

  const b = await api('POST', '/api/auth/register',
    { body: { email: 'admin-b@scratch.test', password: 'adminpass2', name: 'Admin B' } });
  assert.equal(b.status, 201);
  ADMIN_B = b.body.user.id; TOK_B = b.body.token;
});

// ── E1-E4  the Employee ID itself ───────────────────────────────────
test('E1 Employee IDs are random, not sequential', () => {
  const codes = Array.from({ length: 400 }, () => randomCode());
  assert.ok(codes.every(c => isEmployeeId(c)), 'every draw matches the documented shape');
  assert.ok(codes.every(c => c.startsWith('VT-EMP-')));
  assert.equal(new Set(codes).size, 400, '400 draws, 400 distinct values');

  // The real property: no draw is predictable from the one before it. A
  // sequential scheme would make consecutive codes differ by one position
  // and one step; these differ everywhere.
  assert.ok(!codes.some(c => /EMP-0{3,}/.test(c)), 'nothing resembling EMP001');
  const suffixes = codes.map(c => c.slice(PREFIX.length));
  const sorted = [...suffixes].sort();
  assert.notDeepEqual(suffixes, sorted, 'draw order is not sorted order');

  // Every alphabet position is reachable, which is what rejection sampling
  // is for - a biased modulo would still pass the shape check above.
  const used = new Set(suffixes.join('').split(''));
  assert.ok(used.size >= 25, 'at least 25 of the ' + ALPHABET.length + ' symbols appear');
  for (const bad of ['I', 'L', 'O', 'U', '0', '1']) {
    assert.ok(!used.has(bad), bad + ' is excluded: it is misread when typed');
  }
});

test('E2 a collision is retried, not surfaced', async () => {
  // Every code is "taken" until the fifth ask, which is what a collision
  // looks like from here.
  let asked = 0;
  const code = await generateEmployeeId(async () => { asked += 1; return asked < 5; });
  assert.ok(isEmployeeId(code));
  assert.equal(asked, 5, 'it kept drawing rather than giving up or reusing');

  // And it gives up rather than looping forever when something is wrong.
  await assert.rejects(() => generateEmployeeId(async () => true, 3), /Could not allocate/);
});

test('E3 the database refuses a duplicate Employee ID', async () => {
  const code = randomCode();
  await db.query(
    `INSERT INTO users (email, password_hash, employee_code) VALUES ($1,'x',$2)`,
    ['dup1@scratch.test', code]);
  await assert.rejects(
    () => db.query(`INSERT INTO users (email, password_hash, employee_code) VALUES ($1,'x',$2)`,
      ['dup2@scratch.test', code.toLowerCase()]),
    (e) => e.code === '23505',
    'uniqueness is case-insensitive, because the login lookup is');
  await db.query('DELETE FROM users WHERE email IN ($1,$2)', ['dup1@scratch.test', 'dup2@scratch.test']);
});

test('E4 the migration is additive and re-runnable', async () => {
  for (const kw of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i, /\bDROP\s+TABLE\b/i]) {
    assert.equal(kw.test(executable(MIG_SQL)), false, 'migration must not execute ' + kw);
  }
  assert.equal(/^\s*BEGIN\s*;/mi.test(executable(MIG_SQL)), false, 'the runner owns the transaction');
  await db.query(MIG_SQL);   // second application
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'users' AND column_name IN
            ('employee_code','must_change_password','session_epoch','password_changed_at')`);
  assert.equal(rows[0].n, 4);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '_manifest.json'), 'utf8'));
  assert.ok(manifest.order.includes('migration_employee_accounts.sql'), 'registered in the manifest');
  assert.equal(manifest.order.filter(f => /rollback/.test(f)).length, 0);
});

// ── E5-E8  Admin creates and manages ───────────────────────────────
let EMP1, EMP1_CODE, EMP1_PW, TOK_E1;

test('E5 an Admin creates an employee and is shown the ID and password once', async () => {
  const r = await api('POST', '/api/employees', {
    token: TOK_A,
    body: { full_name: 'Sales Sam', mobile: '9876543210', email: 'sam@scratch.test' }
  });
  assert.equal(r.status, 201);
  EMP1 = r.body.employee.id;
  EMP1_CODE = r.body.employee.employee_code;
  EMP1_PW = r.body.temporary_password;

  assert.ok(isEmployeeId(EMP1_CODE), 'the ID is generated, not supplied');
  assert.ok(EMP1_PW && EMP1_PW.length >= 12, 'a temporary password comes back');
  assert.match(r.body.notice, /only once/i, 'and the Admin is told it will not be shown again');
  assert.deepEqual(r.body.employee.permissions, {}, 'a new employee has NO permissions');
  assert.equal(r.body.employee.record_scope, 'own', 'and the narrower record scope');
  assert.equal(r.body.employee.must_change_password, true);

  // The password is hashed, never stored as given.
  const { rows } = await db.query(
    'SELECT password_hash FROM users WHERE upper(employee_code) = upper($1)', [EMP1_CODE]);
  assert.match(rows[0].password_hash, /^\$2[aby]\$\d{2}\$/, 'a real bcrypt hash');
  assert.notEqual(rows[0].password_hash, EMP1_PW);
  assert.ok(await bcrypt.compare(EMP1_PW, rows[0].password_hash), 'and it is the hash OF that password');

  // No later request can retrieve it.
  const again = await api('GET', '/api/employees/' + EMP1, { token: TOK_A });
  assert.equal(again.status, 200);
  assert.equal(JSON.stringify(again.body).includes(EMP1_PW), false,
    'the password appears in no subsequent response');
  assert.equal('password_hash' in again.body, false, 'nor does the hash');
});

test('E6 the employee list is scoped to the Admin who owns it', async () => {
  const mine = await api('GET', '/api/employees', { token: TOK_A });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.length, 1);

  const theirs = await api('GET', '/api/employees', { token: TOK_B });
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.length, 0, 'Admin B sees none of Admin A\'s staff');

  // Nor by direct id.
  const byId = await api('GET', '/api/employees/' + EMP1, { token: TOK_B });
  assert.equal(byId.status, 404, 'and a 404, identical to a nonexistent id');
});

test('E7 the Employee ID cannot be changed after creation', async () => {
  const r = await api('PATCH', '/api/employees/' + EMP1, {
    token: TOK_A, body: { employee_code: 'VT-EMP-AAAAAA' }
  });
  assert.equal(r.status, 400);
  assert.equal(errOf(r).code, 'employee_code_immutable');
  const { rows } = await db.query('SELECT employee_code FROM users WHERE id = (SELECT user_id FROM employee_accounts WHERE id = $1)', [EMP1]);
  assert.equal(rows[0].employee_code, EMP1_CODE, 'unchanged');
});

test('E8 who did what is recorded', async () => {
  const h = await api('GET', '/api/employees/' + EMP1 + '/history', { token: TOK_A });
  assert.equal(h.status, 200);
  assert.ok(h.body.some(e => e.action === 'created'), 'creation is on the record');
  assert.equal(h.body[h.body.length - 1].actor_name, 'Admin A', 'with the Admin who did it');
  assert.equal(h.body.length, 1, 'one entry so far: the creation');
  assert.deepEqual(Object.keys(h.body[0].details).sort(), ['full_name', 'modules', 'record_scope'],
    'with what was set, and nothing else');
  // The trail must never carry password material, before or after a reset.
  assert.equal(JSON.stringify(h.body).includes(EMP1_PW), false,
    'no password value is in the audit trail');
  const { rows: audit } = await db.query(
    'SELECT details::text AS d FROM employee_account_audit WHERE owner_user_id = $1', [ADMIN_A]);
  assert.ok(audit.length > 0);
  assert.equal(audit.some(r => /\$2[aby]\$/.test(r.d)), false, 'and no hash either');
});

// ── E9-E12  logging in ──────────────────────────────────────────────
test('E9 an employee signs in with their Employee ID and password', async () => {
  const bad = await login(EMP1_CODE, 'not-the-password');
  assert.equal(bad.status, 401, 'an Employee ID alone authenticates nobody');
  assert.equal(errOf(bad).code, 'invalid_credentials');

  const none = await api('POST', '/api/auth/login', { body: { identifier: EMP1_CODE } });
  assert.equal(none.status, 400, 'and a password is compulsory, not optional');

  const unknown = await login('VT-EMP-ZZZZZZ', EMP1_PW);
  assert.equal(unknown.status, 401);
  assert.equal(errOf(unknown).message, errOf(bad).message,
    'an unknown ID and a wrong password read identically');

  const ok = await login(EMP1_CODE, EMP1_PW);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.must_change_password, true);
  assert.equal(ok.body.user.employee_code, EMP1_CODE, 'an employee can see their OWN id');
  TOK_E1 = ok.body.token;

  // Case-insensitive, because the ID is read off a screen.
  const lower = await login(EMP1_CODE.toLowerCase(), EMP1_PW);
  assert.equal(lower.status, 200);
});

test('E10 a temporary password reaches nothing but the change-password screen', async () => {
  const blocked = await api('GET', '/api/customers', { token: TOK_E1 });
  assert.equal(blocked.status, 403);
  assert.equal(errOf(blocked).code, 'password_change_required');

  const me = await api('GET', '/api/auth/me', { token: TOK_E1 });
  assert.equal(me.status, 200, '/me stays reachable so the browser can see why');
  assert.equal(me.body.user.must_change_password, true);
  assert.equal(me.body.user.role, 'employee');

  const short = await api('POST', '/api/auth/change-password', {
    token: TOK_E1, body: { current_password: EMP1_PW, new_password: 'short' }
  });
  assert.equal(short.status, 400, 'the new password has a floor');

  const wrong = await api('POST', '/api/auth/change-password', {
    token: TOK_E1, body: { current_password: 'wrong-one', new_password: 'employee-pass-1' }
  });
  assert.equal(wrong.status, 400, 'and the current one must be proved');

  const done = await api('POST', '/api/auth/change-password', {
    token: TOK_E1, body: { current_password: EMP1_PW, new_password: 'employee-pass-1' }
  });
  assert.equal(done.status, 200);
  assert.ok(done.body.token, 'a fresh token, so the tab that changed it stays signed in');
  EMP1_PW = 'employee-pass-1';
  TOK_E1 = done.body.token;

  // The old token is dead: the epoch moved.
  const stale = await api('GET', '/api/auth/me', { token: TOK_E1 });
  assert.equal(stale.status, 200, 'the new token works');
});

test('E11 a changed password revokes the other sessions', async () => {
  const first = (await login(EMP1_CODE, EMP1_PW)).body.token;
  const second = await api('POST', '/api/auth/change-password', {
    token: first, body: { current_password: EMP1_PW, new_password: 'employee-pass-2' }
  });
  assert.equal(second.status, 200);
  EMP1_PW = 'employee-pass-2';
  TOK_E1 = second.body.token;

  const old = await api('GET', '/api/auth/me', { token: first });
  assert.equal(old.status, 401, 'the token the change was made with is itself superseded');
  assert.equal(errOf(old).code, 'session_revoked');
});

test('E12 an Admin signs in exactly as before', async () => {
  const r = await login('admin-a@scratch.test', 'adminpass1');
  assert.equal(r.status, 200, 'email and password, unchanged');
  assert.equal(r.body.must_change_password, false, 'no Admin is asked to change anything');
  assert.equal(r.body.user.employee_code, null);

  // The legacy field name still works, so a cached older login page does not break.
  const legacy = await api('POST', '/api/auth/login',
    { body: { email: 'admin-a@scratch.test', password: 'adminpass1' } });
  assert.equal(legacy.status, 200);

  const me = await api('GET', '/api/auth/me', { token: r.body.token });
  assert.equal(me.body.user.role, 'admin');
  assert.equal(me.body.user.permissions, null, 'null means unrestricted, not none');
  assert.equal(me.body.user.record_scope, 'all');
});

// ── E13-E18  permissions, enforced at the API ───────────────────────
test('E13 an employee with no permissions can reach no module', async () => {
  for (const url of ['/api/customers', '/api/products', '/api/proforma_invoices',
    '/api/receipt_vouchers', '/api/reports/summary']) {
    const r = await api('GET', url, { token: TOK_E1 });
    assert.equal(r.status, 403, url + ' is refused');
    assert.equal(errOf(r).code, 'permission_denied');
  }
});

test('E14 a granted module opens exactly the granted actions', async () => {
  const g = await api('PATCH', '/api/employees/' + EMP1, {
    token: TOK_A, body: { permissions: { customers: ['view', 'create'] } }
  });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.permissions, { customers: ['view', 'create'] });

  const list = await api('GET', '/api/customers', { token: TOK_E1 });
  assert.equal(list.status, 200, 'view was granted');

  const made = await api('POST', '/api/customers', {
    token: TOK_E1, body: { name: 'Employee Customer', phone: '9876500001', state: 'Karnataka' }
  });
  assert.equal(made.status, 201, 'create was granted');

  // Edit and delete were not.
  const edited = await api('PATCH', '/api/customers?eq_id=' + made.body.id, {
    token: TOK_E1, body: { name: 'Renamed' }
  });
  assert.equal(edited.status, 403, 'edit was not granted');
  const removed = await api('DELETE', '/api/customers?eq_id=' + made.body.id, { token: TOK_E1 });
  assert.equal(removed.status, 403, 'nor delete');

  // And the row is still there, which is the assertion that matters.
  const { rows } = await db.query('SELECT name, user_id, created_by FROM customers WHERE id = $1', [made.body.id]);
  assert.equal(rows[0].name, 'Employee Customer', 'unchanged by the refused edit');
  assert.equal(rows[0].user_id, ADMIN_A, 'the row belongs to the EMPLOYER, not the employee');
  const { rows: who } = await db.query(
    'SELECT user_id FROM employee_accounts WHERE id = $1', [EMP1]);
  assert.equal(rows[0].created_by, who[0].user_id, 'and records which employee raised it');
});

test('E15 an employee cannot escalate their own privileges', async () => {
  // The employee-management API itself.
  for (const [m, u, b] of [
    ['GET', '/api/employees', undefined],
    ['POST', '/api/employees', { full_name: 'Smuggled Colleague' }],
    ['PATCH', '/api/employees/' + EMP1, { permissions: { customers: ['view', 'create', 'edit', 'delete'] } }],
    ['POST', '/api/employees/' + EMP1 + '/reset-password', undefined],
    ['POST', '/api/employees/' + EMP1 + '/deactivate', undefined],
    ['GET', '/api/employees/modules', undefined]
  ]) {
    const r = await api(m, u, { token: TOK_E1, body: b });
    assert.equal(r.status, 403, m + ' ' + u + ' is refused');
    assert.equal(errOf(r).code, 'admin_only');
  }

  // Permissions are read from the database, never from the request, so a
  // forged body cannot widen them.
  const forged = await api('POST', '/api/customers', {
    token: TOK_E1,
    body: {
      name: 'Forged', phone: '9876500004', state: 'Karnataka',
      user_id: ADMIN_B, created_by: ADMIN_B,
      permissions: { customers: ['view', 'create', 'edit', 'delete'] },
      role: 'admin', record_scope: 'all', isAdmin: true
    }
  });
  assert.equal(forged.status, 201, 'the row is created');
  const { rows } = await db.query('SELECT user_id, created_by FROM customers WHERE id = $1', [forged.body.id]);
  assert.equal(rows[0].user_id, ADMIN_A, 'but ownership came from the session, not the body');
  assert.notEqual(rows[0].created_by, ADMIN_B, 'and authorship could not be reassigned');

  // Still cannot edit, after all that.
  const after = await api('PATCH', '/api/customers?eq_id=' + forged.body.id, {
    token: TOK_E1, body: { name: 'x' }
  });
  assert.equal(after.status, 403);

  const { rows: perms } = await db.query('SELECT permissions, record_scope FROM employee_accounts WHERE id = $1', [EMP1]);
  assert.deepEqual(perms[0].permissions, { customers: ['view', 'create'] }, 'unchanged');
  assert.equal(perms[0].record_scope, 'own');
});

test('E16 settings, backup and branding are Admin-only whatever is granted', async () => {
  await api('PATCH', '/api/employees/' + EMP1, {
    token: TOK_A,
    body: {
      permissions: {
        customers: ['view', 'create', 'edit', 'delete', 'export'],
        settings: ['view', 'create', 'edit', 'delete', 'export'],
        employees: ['view', 'create', 'edit', 'delete', 'export']
      }
    }
  });
  const { rows } = await db.query('SELECT permissions FROM employee_accounts WHERE id = $1', [EMP1]);
  assert.equal('settings' in rows[0].permissions, false,
    'an admin-only module is dropped on the way in, not merely ignored later');
  assert.equal('employees' in rows[0].permissions, false);

  for (const [m, u] of [['GET', '/api/profiles'], ['PATCH', '/api/profiles'],
    ['GET', '/api/backup/export'], ['DELETE', '/api/backup/all-data'],
    ['GET', '/api/import_mappings']]) {
    const r = await api(m, u, { token: TOK_E1, body: m === 'PATCH' ? { business_name: 'x' } : undefined });
    assert.equal(r.status, 403, m + ' ' + u + ' refused');
    assert.equal(errOf(r).code, 'admin_only');
  }
});

test('E17 an endpoint no module claims is Admin-only, not open', () => {
  assert.equal(accessModuleForApiPath('/documents/proforma_invoice/next-number'), null);
  assert.equal(accessModuleForApiPath('/bill-scan'), null);
  // Longest-prefix matching, so neighbouring prefixes do not swallow each other.
  assert.equal(accessModuleForApiPath('/purchases'), 'purchases');
  assert.equal(accessModuleForApiPath('/purchase_notes'), 'purchase_notes');
  assert.equal(accessModuleForApiPath('/purchase_orders'), 'purchase_orders');
  assert.equal(accessModuleForApiPath('/purchase_order_items'), 'purchase_orders');
  assert.equal(accessModuleForApiPath('/products'), 'products');
  assert.equal(accessModuleForApiPath('/profiles'), 'settings');
});

test('E18 a half-granted module is refused, and view is the floor', () => {
  // create without view is not a grant anyone meant to make.
  assert.equal(accessAllows({ customers: ['create'] }, 'customers', 'create'), false);
  assert.equal(accessAllows({ customers: ['view', 'create'] }, 'customers', 'create'), true);
  assert.equal(accessAllows({ customers: ['view'] }, 'customers', 'edit'), false);
  assert.equal(accessAllows(null, 'customers', 'view'), false);
  assert.equal(accessAllows({}, 'customers', 'view'), false);
  // sanitise repairs it rather than storing a shape the gate would reject.
  assert.deepEqual(sanitisePermissions({ customers: ['create'] }), { customers: ['view', 'create'] });
  assert.deepEqual(sanitisePermissions({ nonsense: ['view'] }), {});
  assert.deepEqual(sanitisePermissions({ customers: ['view', 'fly'] }), { customers: ['view'] });
  assert.ok(ACCESS_GRANTABLE.every(m => !m.adminOnly), 'the grantable list excludes admin-only modules');
});

// ── E19-E21  record scope ───────────────────────────────────────────
test('E19 own-scope shows an employee only what they created', async () => {
  // A customer created by the Admin, and one by the employee.
  const adminRow = await api('POST', '/api/customers', {
    token: TOK_A, body: { name: 'Admin Customer', phone: '9876500002', state: 'Karnataka' }
  });
  assert.equal(adminRow.status, 201);

  const list = await api('GET', '/api/customers', { token: TOK_E1 });
  assert.equal(list.status, 200);
  const names = list.body.map(r => r.name);
  assert.equal(names.includes('Admin Customer'), false, 'not theirs, not shown');
  assert.ok(names.includes('Employee Customer'), 'theirs is shown');

  // The Admin sees both.
  const adminList = await api('GET', '/api/customers', { token: TOK_A });
  assert.ok(adminList.body.length >= 3, 'the Admin sees everything in their own books');
  assert.ok(adminList.body.map(r => r.name).includes('Employee Customer'));
});

test('E20 all-scope is an explicit Admin grant', async () => {
  await api('PATCH', '/api/employees/' + EMP1, { token: TOK_A, body: { record_scope: 'all' } });
  const list = await api('GET', '/api/customers', { token: TOK_E1 });
  assert.ok(list.body.map(r => r.name).includes('Admin Customer'),
    'now the employee sees the company\'s records, because an Admin said so');
  await api('PATCH', '/api/employees/' + EMP1, { token: TOK_A, body: { record_scope: 'own' } });
});

test('E21 an employee never reaches another company\'s records', async () => {
  const bRow = await api('POST', '/api/customers', {
    token: TOK_B, body: { name: 'Company B Customer', phone: '9876500003', state: 'Kerala' }
  });
  assert.equal(bRow.status, 201);

  await api('PATCH', '/api/employees/' + EMP1, { token: TOK_A, body: { record_scope: 'all' } });
  const list = await api('GET', '/api/customers', { token: TOK_E1 });
  assert.equal(list.body.map(r => r.name).includes('Company B Customer'), false,
    'all-scope means all of THEIR employer\'s, not everyone\'s');

  // Not by direct id either.
  const direct = await api('GET', '/api/customers?eq_id=' + bRow.body.id, { token: TOK_E1 });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.length, 0, 'substituting the id returns nothing');
  await api('PATCH', '/api/employees/' + EMP1, { token: TOK_A, body: { record_scope: 'own' } });
});

// ── E22-E24  deactivation ───────────────────────────────────────────
test('E22 deactivation ends the session immediately', async () => {
  const live = await login(EMP1_CODE, EMP1_PW);
  assert.equal(live.status, 200);
  const liveToken = live.body.token;
  assert.equal((await api('GET', '/api/auth/me', { token: liveToken })).status, 200);

  const off = await api('POST', '/api/employees/' + EMP1 + '/deactivate', { token: TOK_A });
  assert.equal(off.status, 200);
  assert.equal(off.body.status, 'suspended');
  assert.ok(off.body.deactivated_at, 'and when');
  assert.equal(off.body.deactivated_by_name, 'Admin A', 'and by whom');

  // The token that worked a moment ago no longer does. This is the test
  // that a 7-day stateless JWT would otherwise fail for a week.
  const now = await api('GET', '/api/auth/me', { token: liveToken });
  assert.equal(now.status, 401);
  assert.equal(errOf(now).code, 'session_revoked');

  const relogin = await login(EMP1_CODE, EMP1_PW);
  assert.equal(relogin.status, 403, 'and they cannot sign in again');
  assert.equal(errOf(relogin).code, 'account_inactive');
});

test('E23 deactivation preserves the history and the employee reference', async () => {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.created_by FROM customers c
      WHERE c.name = 'Employee Customer'`);
  assert.equal(rows.length, 1, 'the document the employee created is still there');
  assert.ok(rows[0].created_by, 'and still names its author');

  const { rows: still } = await db.query('SELECT id FROM users WHERE id = $1', [rows[0].created_by]);
  assert.equal(still.length, 1, 'whose users row was not deleted');

  // DELETE is refused, with a reason.
  const r = await api('DELETE', '/api/employees/' + EMP1, { token: TOK_A });
  assert.equal(r.status, 409);
  assert.equal(errOf(r).code, 'employee_delete_blocked');
  assert.match(errOf(r).message, /Deactivate/i);

  // And the database would refuse anyway.
  await assert.rejects(
    () => db.query('DELETE FROM users WHERE id = $1', [rows[0].created_by]),
    (e) => e.code === '23503', 'ON DELETE RESTRICT stands behind the API');
});

test('E24 reactivation restores access, and a reset revokes sessions', async () => {
  const on = await api('POST', '/api/employees/' + EMP1 + '/reactivate', { token: TOK_A });
  assert.equal(on.status, 200);
  assert.equal(on.body.status, 'active');

  const back = await login(EMP1_CODE, EMP1_PW);
  assert.equal(back.status, 200, 'they can sign in again');
  const token = back.body.token;

  const reset = await api('POST', '/api/employees/' + EMP1 + '/reset-password', { token: TOK_A });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.temporary_password);
  assert.match(reset.body.notice, /once/i);

  const dead = await api('GET', '/api/auth/me', { token });
  assert.equal(dead.status, 401, 'the reset signed them out everywhere');
  assert.equal(errOf(dead).code, 'session_revoked');

  const withNew = await login(EMP1_CODE, reset.body.temporary_password);
  assert.equal(withNew.status, 200);
  assert.equal(withNew.body.must_change_password, true, 'and they must set a new one');
  EMP1_PW = reset.body.temporary_password;
});

// ── E25-E26  the Admin account is untouched ─────────────────────────
test('E25 the existing Admin keeps unrestricted access', async () => {
  const tok = (await login('admin-a@scratch.test', 'adminpass1')).body.token;
  for (const url of ['/api/customers', '/api/products', '/api/profiles',
    '/api/proforma_invoices', '/api/receipt_vouchers', '/api/vendors',
    '/api/import_mappings', '/api/employees']) {
    const r = await api('GET', url, { token: tok });
    assert.ok(r.status === 200, url + ' answers 200 for an Admin (got ' + r.status + ')');
  }
  const patched = await api('PATCH', '/api/profiles', { token: tok, body: { business_name: 'Admin A Co' } });
  assert.equal(patched.status, 200, 'settings still savable');
});

test('E26 an Admin cannot manage another Admin\'s employees', async () => {
  for (const [m, u] of [
    ['PATCH', '/api/employees/' + EMP1],
    ['POST', '/api/employees/' + EMP1 + '/deactivate'],
    ['POST', '/api/employees/' + EMP1 + '/reset-password'],
    ['GET', '/api/employees/' + EMP1 + '/history']
  ]) {
    const r = await api(m, u, { token: TOK_B, body: m === 'PATCH' ? { full_name: 'Hijacked' } : undefined });
    assert.equal(r.status, 404, m + ' ' + u + ' from the wrong Admin is a 404');
  }
  const { rows } = await db.query('SELECT full_name FROM employee_accounts WHERE id = $1', [EMP1]);
  assert.equal(rows[0].full_name, 'Sales Sam', 'and nothing changed');
});

test('teardown', async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});
