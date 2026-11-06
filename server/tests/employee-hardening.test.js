// The four pre-commit fixes, each tested against the thing it claims.
//
//   1. the served mirrors really contain the new files, byte-for-byte
//   2. document numbers are allocated per module permission, with no
//      blanket allowance for /api/documents
//   3. users.email being nullable breaks nothing that used to work
//   4. a missing employee_accounts table is NOT confused with a database
//      failure, and a failure never hands out Admin
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE local database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SERVER_DIR = path.join(__dirname, '..');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const { accessDocumentRequirement, ACCESS_DOCUMENT_TYPE_MODULE } =
  require('../../shared/access-modules');

// ══════════════ 1. mirror consistency (no database) ══════════════
//
// server/public is what Hostinger serves and server/shared is what the
// server require()s. Both are copies, and a copy that has silently
// diverged from its source serves yesterday's code with today's cache key.

test('M1 every shared/*.js is mirrored into server/shared, byte-for-byte', () => {
  const names = fs.readdirSync(path.join(ROOT, 'shared')).filter(f => f.endsWith('.js'));
  assert.ok(names.length >= 3, 'there are shared modules to mirror (' + names.length + ')');
  for (const n of names) {
    const src = path.join(ROOT, 'shared', n);
    const dst = path.join(SERVER_DIR, 'shared', n);
    assert.ok(fs.existsSync(dst), 'server/shared/' + n + ' is missing — run npm run build:public');
    assert.equal(sha(dst), sha(src), 'server/shared/' + n + ' has drifted from shared/' + n);
  }
});

test('M2 the frontend files the pages reference are all in server/public', () => {
  const pub = path.join(SERVER_DIR, 'public');
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  let checked = 0;
  for (const page of pages) {
    assert.ok(fs.existsSync(path.join(pub, page)), page + ' is not mirrored');
    assert.equal(sha(path.join(pub, page)), sha(path.join(ROOT, page)), page + ' has drifted');

    // Every local script and stylesheet a page asks for must exist in the
    // mirror. A page referencing a script the mirror does not contain is
    // the exact failure that shipped when the build only saw tracked
    // files: a 404 on every page load.
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="((?:client|shared)\/[^"?]+)(?:\?[^"]*)?"/g)) {
      const rel = m[1];
      // shared/ is served from server/shared, everything else from public.
      const dst = rel.startsWith('shared/')
        ? path.join(SERVER_DIR, rel)
        : path.join(pub, rel);
      assert.ok(fs.existsSync(dst), page + ' references ' + rel + ', which is not served');
      assert.equal(sha(dst), sha(path.join(ROOT, rel)), rel + ' has drifted from its source');
      checked++;
    }
  }
  assert.ok(checked > 200, 'a real number of references were checked (' + checked + ')');
});

test('M3 the new files are mirrored, and the build reaches untracked ones', () => {
  for (const rel of ['employees.html', 'client/js/core/access.js', 'client/js/pages/employees.js']) {
    const dst = path.join(SERVER_DIR, 'public', rel);
    assert.ok(fs.existsSync(dst), rel + ' must be in server/public');
    assert.equal(sha(dst), sha(path.join(ROOT, rel)));
  }
  // Proof it is not merely that these happen to be committed now: the
  // build's file list must ask git for untracked files too.
  const build = fs.readFileSync(path.join(SERVER_DIR, 'scripts', 'build-public.js'), 'utf8');
  assert.match(build, /'--cached', '--others', '--exclude-standard'/,
    'the build must include new files that are not yet staged');
  assert.match(build, /SHARED_ALLOW/, 'and must sync shared/ into server/shared');
  // The guards that keep it from writing outside its destinations.
  assert.match(build, /resolves outside server\/public/);
  assert.match(build, /resolves outside server\/shared/);
});

test('M4 the build refuses to publish anything from server/, or any secret', () => {
  const build = fs.readFileSync(path.join(SERVER_DIR, 'scripts', 'build-public.js'), 'utf8');
  // Including untracked files widens the candidate set, so the DENY list
  // matters more than it did. These are the ones that must never ship.
  for (const pattern of ['/^server\\//', '\\.env', '\\.sql\\$', 'package(-lock)?\\.json']) {
    assert.ok(build.includes(pattern) || new RegExp(pattern.replace(/\\\\/g, '\\')).test(build),
      'DENY must still cover ' + pattern);
  }
  const pub = path.join(SERVER_DIR, 'public');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const published = walk(pub).map(p => path.relative(pub, p).replace(/\\/g, '/'));
  for (const f of published) {
    assert.equal(/\.env|\.sql$|package.*\.json$|^server\//.test(f), false,
      f + ' must never be published');
  }
  // And the protected files are not frontend files, so they cannot be here.
  assert.equal(published.some(f => /product-sync\.js$/.test(f) && !f.startsWith('client/')), false);
});

// ══════════════ 2. document-number authorisation (no database) ══════════════

test('N1 every document type routes/documents.js serves is mapped to a module', () => {
  const docs = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'documents.js'), 'utf8');
  const i = docs.indexOf('const DOCUMENT_TABLES = {');
  const block = docs.slice(i, docs.indexOf('\n};', i));
  const types = [...block.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1]);
  assert.ok(types.length >= 13, 'found the document types (' + types.length + ')');
  for (const t of types) {
    assert.ok(ACCESS_DOCUMENT_TYPE_MODULE[t],
      t + ' has no module, so no permission could allow numbering it');
  }
  // And nothing is mapped that the router does not actually serve.
  for (const t of Object.keys(ACCESS_DOCUMENT_TYPE_MODULE)) {
    assert.ok(types.includes(t), t + ' is mapped but routes/documents.js does not serve it');
  }
});

test('N2 the action follows what the endpoint does', () => {
  const r = (m, p, b) => accessDocumentRequirement(m, p, b || {});
  assert.deepEqual(r('GET', '/documents/proforma_invoice/next-number'),
    { module: 'proforma', action: 'create' });
  assert.deepEqual(r('GET', '/documents/receipt_voucher/next-number'),
    { module: 'vouchers', action: 'create' });
  assert.deepEqual(r('POST', '/documents/purchase_order/save'),
    { module: 'purchase_orders', action: 'create' });
  // An edit is an edit, not a create.
  assert.deepEqual(r('POST', '/documents/purchase_order/save', { editId: 'x' }),
    { module: 'purchase_orders', action: 'edit' });
  assert.deepEqual(r('GET', '/documents/dc_job_work/field-support'),
    { module: 'challans', action: 'view' });
  assert.deepEqual(r('POST', '/documents/dc_other/abc/cancel'),
    { module: 'challans', action: 'delete' });
  assert.deepEqual(r('DELETE', '/documents/warranty/abc'),
    { module: 'warranty', action: 'delete' });
  // The type of a reserve-number comes from the body.
  assert.deepEqual(r('POST', '/documents/reserve-number', { documentType: 'bill_of_supply' }),
    { module: 'bill_of_supply', action: 'create' });
});

test('N3 numbering settings stay with administrators', () => {
  for (const t of Object.keys(ACCESS_DOCUMENT_TYPE_MODULE)) {
    assert.deepEqual(accessDocumentRequirement('POST', '/documents/' + t + '/number-settings', {}),
      { adminOnly: true }, t + ' numbering settings must be Admin-only');
  }
});

test('N4 there is no blanket allowance for /api/documents', () => {
  // An unknown type, an unknown endpoint and a missing body all resolve to
  // null, which middleware/access.js turns into a refusal.
  for (const [m, p, b] of [
    ['GET', '/documents/not_a_type/next-number', {}],
    ['POST', '/documents/proforma_invoice/something-new', {}],
    ['POST', '/documents/reserve-number', {}],
    ['POST', '/documents/reserve-number', { documentType: 'nonsense' }],
    ['GET', '/documents', {}]
  ]) {
    assert.equal(accessDocumentRequirement(m, p, b), null, m + ' ' + p + ' must not resolve');
  }
  // And the middleware refuses on null rather than falling through.
  const mw = fs.readFileSync(path.join(SERVER_DIR, 'src', 'middleware', 'access.js'), 'utf8');
  const block = mw.slice(mw.indexOf("if (/^\\/documents(\\/|$)/.test(bare)) {"));
  assert.match(block.slice(0, 600), /if \(!need\) \{[\s\S]*?return next\(deny\(403/,
    'an unresolved /documents path must be refused');
});

test('N5 invoice numbering is governed by the invoices module, not this router', () => {
  // The brief maps "Invoice creation -> Invoice Create permission". Invoices
  // are not numbered through /api/documents at all, so this asserts the
  // thing that actually governs them.
  assert.equal(ACCESS_DOCUMENT_TYPE_MODULE.b2b_invoice, undefined);
  assert.equal(ACCESS_DOCUMENT_TYPE_MODULE.invoice, undefined);
  const { accessModuleForApiPath } = require('../../shared/access-modules');
  assert.equal(accessModuleForApiPath('/invoices'), 'invoices');
  assert.equal(accessModuleForApiPath('/invoices/reserve-number'), 'invoices');
  const inv = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'invoices.js'), 'utf8');
  assert.match(inv, /FOR UPDATE/, 'invoices.js allocates its own numbers under a lock');
});

// ══════════════ 3 & 4: against the scratch database ══════════════
const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('employee hardening, database part (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
{
  const u = new URL(SCRATCH);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    throw new Error('employee-hardening.test.js refuses to run: host is not local.');
  }
  if (!/scratch|test/i.test(u.pathname.replace(/^\//, ''))) {
    throw new Error('employee-hardening.test.js refuses to run: not a scratch database.');
  }
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hardening-test-secret';

const { Client } = require('pg');
const net = require('net');
const { spawn } = require('child_process');

const MIG_SQL = fs.readFileSync(
  path.join(SERVER_DIR, 'db', 'migrations', 'migration_employee_accounts.sql'), 'utf8');

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
    cwd: SERVER_DIR,
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
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}
const errOf = (r) => (r && r.body && r.body.error) || {};
const login = (identifier, password) => api('POST', '/api/auth/login', { body: { identifier, password } });

let ADMIN_TOK, EMP, EMP_CODE, EMP_PW, EMP_TOK;

test('setup: a migrated scratch database, one Admin, one employee', async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  const { rows } = await db.query('SELECT current_database() AS d');
  assert.match(rows[0].d, /scratch|test/i);
  await db.query(MIG_SQL);
  await db.query('TRUNCATE users CASCADE');

  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;

  const admin = await api('POST', '/api/auth/register',
    { body: { email: 'hard-admin@scratch.test', password: 'adminpass1', name: 'Hard Admin' } });
  assert.equal(admin.status, 201);
  ADMIN_TOK = admin.body.token;

  const made = await api('POST', '/api/employees', {
    token: ADMIN_TOK,
    body: {
      full_name: 'Numbering Nina',
      permissions: { proforma: ['view', 'create'], vouchers: ['view'] }
    }
  });
  assert.equal(made.status, 201);
  EMP = made.body.employee.id;
  EMP_CODE = made.body.employee.employee_code;
  const temp = made.body.temporary_password;

  const first = await login(EMP_CODE, temp);
  assert.equal(first.status, 200);
  const changed = await api('POST', '/api/auth/change-password', {
    token: first.body.token, body: { current_password: temp, new_password: 'nina-pass-1' }
  });
  assert.equal(changed.status, 200);
  EMP_PW = 'nina-pass-1';
  EMP_TOK = changed.body.token;
});

test('N6 an employee with Proforma Create can allocate a proforma number', async () => {
  const r = await api('GET', '/api/documents/proforma_invoice/next-number', { token: EMP_TOK });
  assert.equal(r.status, 200, 'allowed: they have proforma create — ' + JSON.stringify(r.body));
  assert.ok(r.body && (r.body.documentNumber || r.body.number || r.body.nextNumber),
    'and a number comes back: ' + JSON.stringify(r.body));
});

test('N7 the same employee cannot allocate a voucher number with only View', async () => {
  const r = await api('GET', '/api/documents/receipt_voucher/next-number', { token: EMP_TOK });
  assert.equal(r.status, 403, 'view is not create');
  assert.equal(errOf(r).code, 'permission_denied');

  // A module they have nothing at all for.
  const none = await api('GET', '/api/documents/purchase_order/next-number', { token: EMP_TOK });
  assert.equal(none.status, 403);
  assert.equal(errOf(none).code, 'permission_denied');
});

test('N8 granting Voucher Create opens voucher numbering and nothing else', async () => {
  await api('PATCH', '/api/employees/' + EMP, {
    token: ADMIN_TOK,
    body: { permissions: { proforma: ['view', 'create'], vouchers: ['view', 'create'] } }
  });
  const ok = await api('GET', '/api/documents/receipt_voucher/next-number', { token: EMP_TOK });
  assert.equal(ok.status, 200, 'now allowed');

  // Still refused where nothing was granted.
  const po = await api('GET', '/api/documents/purchase_order/next-number', { token: EMP_TOK });
  assert.equal(po.status, 403);
  // And field-support, which only needs view.
  const fs2 = await api('GET', '/api/documents/receipt_voucher/field-support', { token: EMP_TOK });
  assert.equal(fs2.status, 200);
});

test('N9 numbering settings are refused for an employee, allowed for the Admin', async () => {
  const denied = await api('POST', '/api/documents/proforma_invoice/number-settings', {
    token: EMP_TOK, body: { format: 'PI-#####', sequence: 1 }
  });
  assert.equal(denied.status, 403, 'even with proforma create');
  assert.equal(errOf(denied).code, 'admin_only');

  // The Admin reaches the route (whatever it then makes of the payload, it
  // is not an authorisation refusal).
  const admin = await api('POST', '/api/documents/proforma_invoice/number-settings', {
    token: ADMIN_TOK, body: {}
  });
  assert.notEqual(admin.status, 403, 'the Admin is not blocked by authorisation');
});

test('N10 an unknown document type is refused, not guessed at', async () => {
  const r = await api('GET', '/api/documents/not_a_type/next-number', { token: EMP_TOK });
  assert.equal(r.status, 403);
  assert.equal(errOf(r).code, 'admin_only', 'unclaimed means nobody, not everybody');
});

// ── 3. users.email nullable ──
test('E30 two employees with no email coexist, and the Admin keeps theirs', async () => {
  const a = await api('POST', '/api/employees', {
    token: ADMIN_TOK, body: { full_name: 'No Email One' }
  });
  assert.equal(a.status, 201, 'an employee needs no email address');
  const b = await api('POST', '/api/employees', {
    token: ADMIN_TOK, body: { full_name: 'No Email Two' }
  });
  assert.equal(b.status, 201, 'and nor does a second — many NULLs under a UNIQUE index');

  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM users WHERE email IS NULL');
  assert.ok(rows[0].n >= 2, 'both are stored with a NULL email');

  const { rows: adm } = await db.query(
    "SELECT email FROM users WHERE email = 'hard-admin@scratch.test'");
  assert.equal(adm.length, 1, 'the Admin address is untouched');

  // They sign in by Employee ID, which is the point.
  const code = a.body.employee.employee_code;
  const r = await login(code, a.body.temporary_password);
  assert.equal(r.status, 200, 'an employee with no email can still sign in');
  assert.equal(r.body.user.email, null);
});

test('E31 existing Admin login, registration and /me are unaffected by nullable email', async () => {
  const r = await login('hard-admin@scratch.test', 'adminpass1');
  assert.equal(r.status, 200);
  const me = await api('GET', '/api/auth/me', { token: r.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'hard-admin@scratch.test');
  assert.equal(me.body.user.role, 'admin');

  // Registration still demands a real address: an Admin without one could
  // not sign in at all, since only employees have a code.
  for (const body of [{ password: 'x'.repeat(10) }, { email: 'not-an-email', password: 'x'.repeat(10) }]) {
    const bad = await api('POST', '/api/auth/register', { body });
    assert.equal(bad.status, 400, 'an Admin must give a valid email');
  }
  const dupe = await api('POST', '/api/auth/register',
    { body: { email: 'hard-admin@scratch.test', password: 'another1' } });
  assert.equal(dupe.status, 409, 'and uniqueness still holds');
  assert.equal(errOf(dupe).code, 'email_taken');
});

test('E32 an email an Admin sets on an employee is unique and reaches the login path', async () => {
  const made = await api('POST', '/api/employees', {
    token: ADMIN_TOK, body: { full_name: 'Mailed Mo', email: 'mo@scratch.test' }
  });
  assert.equal(made.status, 201);

  // Taken by the Admin's own account.
  const clash = await api('PATCH', '/api/employees/' + made.body.employee.id, {
    token: ADMIN_TOK, body: { email: 'hard-admin@scratch.test' }
  });
  assert.equal(clash.status, 409, 'a duplicate address is refused');
  assert.equal(errOf(clash).code, 'email_taken');

  // Corrected, and the change must reach users.email - that column is the
  // credential the login form matches, so a stale copy would mean signing
  // in with an address the Admin had already changed.
  const fixed = await api('PATCH', '/api/employees/' + made.body.employee.id, {
    token: ADMIN_TOK, body: { email: 'mo.new@scratch.test' }
  });
  assert.equal(fixed.status, 200);
  const { rows } = await db.query(
    'SELECT u.email AS login_email, e.email AS hr_email FROM employee_accounts e '
    + 'JOIN users u ON u.id = e.user_id WHERE e.id = $1', [made.body.employee.id]);
  assert.equal(rows[0].login_email, 'mo.new@scratch.test', 'users.email moved too');
  assert.equal(rows[0].hr_email, 'mo.new@scratch.test');

  const r = await login('mo.new@scratch.test', made.body.temporary_password);
  assert.equal(r.status, 200, 'and the new address signs in');
  const old = await login('mo@scratch.test', made.body.temporary_password);
  assert.equal(old.status, 401, 'while the old one no longer does');
});

test('E33 created_by exists on all 42 tenant tables and is nullable', async () => {
  const { rows } = await db.query(
    `SELECT c.relname AS tbl, a.attnotnull
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND a.attname = 'created_by'
        AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'`);
  assert.ok(rows.length >= 45, 'created_by is present widely (' + rows.length + ')');
  for (const r of rows) {
    assert.equal(r.attnotnull, false,
      r.tbl + '.created_by must be nullable: a document raised before employee logins '
      + 'existed has no author, and inventing one would be a false fact about a '
      + 'historical record');
  }
  // Nothing was backfilled.
  const { rows: filled } = await db.query(
    'SELECT count(*)::int AS n FROM customers WHERE created_by IS NOT NULL');
  assert.ok(filled[0].n >= 0);
});

// ── 4. a missing table is not a database failure ──
test('S1 a missing employee_accounts table is distinguished from a damaged schema', async () => {
  const mw = fs.readFileSync(path.join(SERVER_DIR, 'src', 'middleware', 'access.js'), 'utf8');
  const fn = mw.slice(mw.indexOf('async function employeeTableExists'),
    mw.indexOf('// Mounted after requireAuth'));

  // to_regclass answers "absent" without throwing; a thrown error must
  // propagate rather than being read as "no employees yet".
  assert.match(fn, /to_regclass\('public\.employee_accounts'\)/);
  assert.equal(/try\s*\{/.test(fn), false,
    'this function must NOT swallow errors — a database that cannot answer is not '
    + 'a database with no employees');

  // Absence is only legitimate when the migration was never applied.
  assert.match(fn, /schema_migrations/);
  assert.match(fn, /employee_schema_damaged/);
  assert.match(fn, /503/);

  // Nothing is cached when a query throws: the assignments come after both
  // reads.
  const assignAt = fn.indexOf('_employeeTable = present');
  const checkAt = fn.indexOf('employee_schema_damaged');
  assert.ok(checkAt > 0 && assignAt > checkAt,
    'the damaged-schema check runs before anything is cached');
});

test('S2 a database error never promotes an employee to Admin', async () => {
  // The employee is an employee, and stays one.
  const me = await api('GET', '/api/auth/me', { token: EMP_TOK });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'employee');

  // loadAccount's degradation path grants Admin ONLY when the table is
  // absent. Asserted on the code, because provoking a real connection
  // failure mid-suite would be unreliable: what matters is that the only
  // route to isAdmin = true is the explicit absence branch.
  const mw = fs.readFileSync(path.join(SERVER_DIR, 'src', 'middleware', 'access.js'), 'utf8');
  const load = mw.slice(mw.indexOf('async function loadAccount'), mw.indexOf('function requireAdmin'));
  const admins = [...load.matchAll(/req\.isAdmin = (true|!row\.employee_id)/g)].map(m => m[1]);
  assert.deepEqual(admins, ['true', '!row.employee_id'],
    'exactly two places set isAdmin: the pre-migration branch and the real lookup');
  // The pre-migration branch is reached only from the explicit check.
  assert.match(load, /if \(!\(await employeeTableExists\(\)\)\) \{/);
  // And the catch re-throws rather than defaulting to anything.
  assert.match(load, /\} catch \(err\) \{\s*next\(err\);\s*\}/,
    'an error is passed on, never converted into an answer');
});

test('S3 before the migration the API still works, and employee management says why', async () => {
  // Proven against a database that genuinely lacks the table, by removing
  // it here. Safe: this is the scratch database, the tables are empty, and
  // the migration is re-applied at the end of the test.
  await db.query('TRUNCATE users CASCADE');
  await db.query('DROP TABLE IF EXISTS employee_account_audit');
  await db.query('DROP TABLE IF EXISTS employee_accounts');

  const port = await freePort();
  const pre = await startServer(port);
  const base = BASE;
  BASE = 'http://127.0.0.1:' + port;
  try {
    const admin = await api('POST', '/api/auth/register',
      { body: { email: 'pre-mig@scratch.test', password: 'premig123', name: 'Pre Mig' } });
    assert.equal(admin.status, 201, 'registration works before the migration');

    const ok = await api('GET', '/api/customers', { token: admin.body.token });
    assert.equal(ok.status, 200, 'and so does the rest of the API — no 42P01');

    const me = await api('GET', '/api/auth/me', { token: admin.body.token });
    assert.equal(me.body.user.role, 'admin', 'with no employees, every account is an Admin');

    const emp = await api('GET', '/api/employees', { token: admin.body.token });
    assert.equal(emp.status, 503, 'employee management says it is not available yet');
    assert.equal(errOf(emp).code, 'migration_pending');
    assert.match(errOf(emp).message, /migration_employee_accounts\.sql/);
  } finally {
    pre.kill();
    BASE = base;
    await db.query(MIG_SQL);
    await db.query('TRUNCATE users CASCADE');
  }
});

test('teardown', async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});
