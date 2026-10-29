// Signing in.
//
// Nothing in this suite had ever exercised POST /api/auth/login, and the
// reason was structural rather than an oversight: every harness seeds users
// with a placeholder password_hash and mints a JWT directly, so
// bcrypt.compare() could never succeed against the seeded rows. The login
// route was therefore the one authenticated path with no test at all.
//
// tests/helpers/login-user.js produces a real bcrypt hash of a known fixture
// password, which is the whole of what was missing. These cases then hold the
// route to the things it promises: a working sign-in, and refusals that do not
// say which half was wrong.
//
// The DB half is skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE
// database, exactly as the rest of the suite is.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('auth login (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-login-secret';

const { Client } = require('pg');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { seedLoginUser, TEST_PASSWORD, BCRYPT_ROUNDS } = require('./helpers/login-user');

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
    child.on('exit', (c) => { clearTimeout(done); reject(new Error('server exited ' + c + ':\n' + out)); });
  });
}

let server = null, BASE = '', USER = null;
const db = new Client({ connectionString: SCRATCH });

async function api(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes answer no body */ }
  return { status: res.status, body: json };
}

const login = (email, password) => api('POST', '/api/auth/login', { email, password });

// The route is rate limited to 20 attempts per 15 minutes per address. These
// cases use six; anything added here should keep well clear of that, or the
// limiter starts answering instead of the route.
test('database setup', async () => {
  await db.connect();
  // The scratch database is expected to be built already, as every other
  // integration test here expects. schema.sql is deliberately not re-applied:
  // it is idempotent for tables and indexes but not for triggers, so running
  // it twice fails on the first CREATE TRIGGER.
  await db.query('TRUNCATE users CASCADE');
  USER = await seedLoginUser(db, { email: 'login@scratch.test' });

  const port = await freePort();
  server = await startServer(port);
  BASE = 'http://127.0.0.1:' + port;
});

test('L1 the seeded password is a real bcrypt hash, not a placeholder', async () => {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [USER.id]);
  const hash = rows[0].password_hash;
  // $2a$ / $2b$ and the cost, which is what makes it comparable at all. The
  // other harnesses store 'x' here, which is why none of them could log in.
  assert.match(hash, /^\$2[aby]\$\d{2}\$/, 'a bcrypt hash');
  assert.ok(hash.length >= 59, 'of the full length');
  assert.notStrictEqual(hash, TEST_PASSWORD, 'the password itself was never stored');
  assert.strictEqual(Number(hash.split('$')[2]), BCRYPT_ROUNDS,
    'hashed at the cost the application itself uses');
  assert.strictEqual(await bcrypt.compare(TEST_PASSWORD, hash), true);
});

test('L2 a correct password signs in and the token works', async () => {
  const res = await login(USER.email, USER.password);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token, 'a token comes back');
  assert.strictEqual(res.body.user.email, USER.email);
  assert.strictEqual(res.body.user.id, USER.id);
  // Whatever the route returns, the password must not be in it.
  assert.equal(/password/i.test(JSON.stringify(res.body)), false,
    'nothing about the password is echoed back');

  // The token is the point of logging in, so it has to open a guarded route.
  const guarded = await api('GET', '/api/invoices', undefined, res.body.token);
  assert.notStrictEqual(guarded.status, 401, 'the token authenticates: ' + JSON.stringify(guarded.body));
});

test('L3 a wrong password is refused, and says only that', async () => {
  const res = await login(USER.email, 'not-the-password');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error.code, 'invalid_credentials');
  assert.ok(!res.body.token, 'no token is issued');
});

test('L4 an unknown email is refused identically - no account enumeration', async () => {
  const unknown = await login('nobody@scratch.test', USER.password);
  const wrongPass = await login(USER.email, 'still-not-the-password');

  assert.strictEqual(unknown.status, wrongPass.status, 'the same status');
  assert.strictEqual(unknown.body.error.code, wrongPass.body.error.code, 'the same code');
  assert.strictEqual(unknown.body.error.message, wrongPass.body.error.message,
    'and the same words - telling the two apart is how accounts get enumerated');
});

test('L5 the address is matched case-insensitively', async () => {
  const res = await login(USER.email.toUpperCase(), USER.password);
  assert.strictEqual(res.status, 200, 'the route lower-cases the address: ' + JSON.stringify(res.body));
  assert.strictEqual(res.body.user.email, USER.email);
});

test('L6 a missing password is a validation error, not a sign-in attempt', async () => {
  const res = await api('POST', '/api/auth/login', { email: USER.email });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.ok(!res.body.token);
});

test('teardown', async () => {
  if (server) { server.kill(); await new Promise((r) => server.on('exit', r)); }
  await db.end();
});
