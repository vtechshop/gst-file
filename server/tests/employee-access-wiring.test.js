// The wiring that makes the permission system real, asserted statically.
//
// No database and no server: these are the invariants that would make the
// tested behaviour in employee-accounts.test.js stop being true if someone
// later added a module, a page or a router and missed a step. A permission
// system fails quietly, so the checks that keep it honest have to be loud.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVER = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const {
  ACCESS_MODULES, ACCESS_GRANTABLE, ACCESS_PAGE_MODULE, ACCESS_ACTIONS,
  accessModuleForApiPath, accessAllows, sanitisePermissions
} = require('../../shared/access-modules');

test('W1 the module registry has exactly one copy, mirrored byte-for-byte', () => {
  // The server requires ../../shared from server/, so it reads
  // server/shared - a hand-made mirror of the repo-root directory that
  // NOTHING automates (build-public.js only builds server/public). Two
  // copies of the authority list silently disagreeing is exactly the
  // failure this asserts away.
  const rootCopy = read('shared/access-modules.js');
  const serverCopy = SERVER('../shared/access-modules.js');
  assert.equal(serverCopy, rootCopy,
    'shared/access-modules.js and server/shared/access-modules.js must be identical — '
    + 'nothing syncs them, so a change to one needs a copy to the other');
});

test('W2 every grantable module declares a real label and no admin-only leaks in', () => {
  assert.ok(ACCESS_GRANTABLE.length >= 20, 'the registry covers the application');
  for (const m of ACCESS_GRANTABLE) {
    assert.ok(m.key && /^[a-z_]+$/.test(m.key), m.key + ' is a plain key');
    assert.ok(m.label && m.label.length > 2, m.key + ' has a human label');
    assert.notEqual(m.adminOnly, true);
  }
  const adminOnly = ACCESS_MODULES.filter(m => m.adminOnly).map(m => m.key);
  assert.deepEqual(adminOnly.sort(), ['employees', 'settings'],
    'exactly two modules are never grantable');
  // And they are unreachable through the permission map whatever is stored.
  for (const key of adminOnly) {
    assert.equal(accessAllows({ [key]: ACCESS_ACTIONS }, key, 'view'), false);
    assert.equal(key in sanitisePermissions({ [key]: ACCESS_ACTIONS }), false);
  }
});

test('W3 module keys are unique and so is every page mapping', () => {
  const keys = ACCESS_MODULES.map(m => m.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate module keys');
  const pages = ACCESS_MODULES.flatMap(m => m.pages);
  assert.equal(new Set(pages).size, pages.length,
    'a page belongs to one module, so hiding it cannot depend on which rule ran first');
});

test('W4 every gated page actually exists', () => {
  for (const page of Object.keys(ACCESS_PAGE_MODULE)) {
    assert.ok(fs.existsSync(path.join(ROOT, page)),
      page + ' is gated by the registry but is not in the repository');
  }
});

test('W5 every sidebar link is either gated or deliberately ungated', () => {
  // The dashboard sidebar is the application's own menu. A link that is
  // neither in the registry nor on this list is a module someone added
  // without deciding who may see it - which this test turns into a
  // failure rather than a silent grant.
  const UNGATED = new Set([
    'dashboard.html',   // its own module, always visible
    'index.html',
    'amendments.html',  // reached through the invoices module
    'eway-bills.html',
    'warranty.html',
    'purchase-order.html',
    'b2c.html',
    'gstr1.html'
  ]);
  const html = read('dashboard.html');
  const links = [...new Set([...html.matchAll(/href="([a-z0-9.-]+\.html)"/gi)].map(m => m[1]))];
  const ungoverned = links.filter(l => !ACCESS_PAGE_MODULE[l] && !UNGATED.has(l));
  assert.deepEqual(ungoverned, [],
    'these sidebar pages have no module, so no permission governs them: ' + ungoverned.join(', '));
});

test('W6 longest-prefix API matching, so neighbouring prefixes do not swallow each other', () => {
  const pairs = [
    ['/purchases', 'purchases'],
    ['/purchase_items', 'purchases'],
    ['/purchase_notes', 'purchase_notes'],
    ['/purchase_note_items', 'purchase_notes'],
    ['/purchase_orders', 'purchase_orders'],
    ['/purchase_order_items', 'purchase_orders'],
    ['/purchase_returns', 'purchase_returns'],
    ['/products', 'products'],
    ['/product-sync', 'products'],
    ['/profiles', 'settings'],
    ['/proforma_invoices', 'proforma'],
    ['/proforma_invoice_items', 'proforma'],
    ['/receipt_vouchers', 'vouchers'],
    ['/employees', 'employees'],
    ['/employees/modules', 'employees'],
    ['/stock/locations', 'stock']
  ];
  for (const [p, expected] of pairs) {
    assert.equal(accessModuleForApiPath(p), expected, p + ' -> ' + expected);
  }
  // Unclaimed means admin-only, never open. See middleware/access.js.
  for (const p of ['/documents/proforma_invoice', '/bill-scan', '/invoice-scan', '/nonsense']) {
    assert.equal(accessModuleForApiPath(p), null, p + ' is claimed by no module');
  }
});

test('W7 the authority chain is mounted before the routers, and skips only auth and verify', () => {
  const app = SERVER('src/app.js');
  const chain = app.indexOf("app.use('/api', (req, res, next) => {");
  const firstRouter = app.indexOf("app.use('/api/auth', authRoutes);");
  const limiter = app.indexOf("app.use('/api', rateLimit(");
  assert.ok(chain > 0, 'the chain exists');
  assert.ok(limiter > 0 && limiter < chain, 'rate limiting still comes first');
  assert.ok(chain < firstRouter, 'authority is decided before any router matches');

  // The four steps, in order. Swapping the last two would decide
  // permission against the account being acted AS rather than the caller.
  const order = ['requireAuth(req, res,', 'loadAccount(req, res,', 'enforceModuleAccess(req, res,', 'actAsAccountOwner(req, res,'];
  let at = chain;
  for (const step of order) {
    const i = app.indexOf(step, at);
    assert.ok(i > 0, step + ' is in the chain');
    at = i;
  }

  assert.match(app, /PUBLIC_API\s*=\s*\/\^\\\/\(auth\|verify\)/,
    'only /auth and /verify bypass it');
});

test('W8 the generic router scopes to the account owner, not the caller', () => {
  const g = SERVER('src/routes/generic.js');
  assert.match(g, /const ownerIdOf = \(req\) => req\.accountOwnerId \|\| req\.userId;/);
  // Every one of the four handlers must use it.
  assert.equal((g.match(/ownerIdOf\(req\)/g) || []).length, 4,
    'GET, POST, PATCH and DELETE each resolve the owner the same way');
  // Ownership and authorship are forced, never taken from the body.
  assert.match(g, /\[ownerColumn\]: ownerIdOf\(req\)/);
  assert.match(g, /payload\[AUTHOR_COLUMN\] = req\.actorUserId \|\| req\.userId;/);
  assert.match(g, /c !== ownerColumn && c !== AUTHOR_COLUMN/,
    'neither can be reassigned by a PATCH');
  // 'own' scope narrows, and is applied on top of ownership rather than
  // instead of it.
  assert.match(g, /if \(!authored \|\| req\.isAdmin \|\| req\.recordScope !== 'own'\) return '';/);
  assert.match(g, /return ` AND \$\{AUTHOR_COLUMN\} = \$\$\{params\.length\}`;/);
});

test('W9 no authority is read from the token beyond the subject and the epoch', () => {
  const auth = SERVER('src/routes/auth.js');
  assert.match(auth, /jwt\.sign\(\{ sub: userId, epoch: sessionEpoch \|\| 0 \}/);
  for (const claim of ['role:', 'permissions:', 'isAdmin', 'owner_user_id:', 'record_scope:']) {
    const signBlock = auth.slice(auth.indexOf('function signToken'), auth.indexOf('function publicUser'));
    assert.equal(signBlock.includes(claim), false,
      claim + ' must not be a token claim — it would be stale the moment an Admin changed it');
  }
  const mw = SERVER('src/middleware/auth.js');
  assert.match(mw, /req\.tokenEpoch = Number\.isInteger\(payload\.epoch\) \? payload\.epoch : 0;/);
});

test('W10 every employee route is admin-gated and owner-scoped', () => {
  const e = SERVER('src/routes/employees.js');
  assert.match(e, /router\.use\(requireAuth\);/);
  assert.match(e, /router\.use\(loadAccount\);/);
  assert.match(e, /router\.use\(requireAdmin\);/);

  // Every query that reads or writes an employee must name the owner, so
  // an Admin cannot reach another Admin's staff even if the middleware
  // were somehow bypassed.
  const queries = [...e.matchAll(/(?:pool|client)\.query\(\s*(`[^`]*`|'[^']*')/g)].map(m => m[1]);
  const touching = queries.filter(q => /employee_accounts|employee_account_audit/.test(q));
  assert.ok(touching.length >= 8, 'there are employee queries to check (' + touching.length + ')');
  for (const q of touching) {
    const ok = /owner_user_id/.test(q) || /LIST_SQL/.test(q);
    assert.ok(ok, 'query does not mention owner_user_id: ' + q.replace(/\s+/g, ' ').slice(0, 90));
  }
  // The Employee ID is never written by an update.
  assert.equal(/UPDATE users SET[^`']*employee_code/.test(e), false,
    'an issued Employee ID is never rewritten');
  // Deletion is refused rather than performed.
  assert.match(e, /employee_delete_blocked/);
  assert.equal(/DELETE FROM (users|employee_accounts)/.test(e), false,
    'no employee row is ever deleted');
});

test('W11 the login page takes an email address or an Employee ID', () => {
  const index = read('index.html');
  assert.match(index, /<label for="loginEmail">Email Address \/ Employee ID<\/label>/);
  // type="email" would make the browser refuse VT-EMP-K7M4Q9 before the
  // request was ever sent.
  assert.match(index, /<input type="text" id="loginEmail"/);
  assert.equal(/<input type="email" id="loginEmail"/.test(index), false);
  assert.match(index, /identifier: document\.getElementById\('loginEmail'\)\.value\.trim\(\)/);

  const client = read('client/js/api/apiClient.js');
  assert.match(client, /signInWithPassword: async \(\{ identifier, email, password \}\)/);
  assert.match(client, /identifier: identifier \|\| email/,
    'an older cached page sending `email` still works');
});

test('W12 access.js is loaded by every page with a sidebar, after its dependencies', () => {
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  // The pages that genuinely have no sidebar and no session.
  const PUBLIC = new Set(['index.html', 'verify.html', 'warranty-verify.html']);
  // Sub-pages that carry a single back-link and load no auth at all.
  const NO_AUTH = new Set(['b2c.html', 'gstr1.html']);

  let gated = 0;
  for (const p of pages) {
    const html = read(p);
    if (PUBLIC.has(p) || NO_AUTH.has(p)) {
      assert.equal(html.includes('core/access.js'), false, p + ' needs no access control');
      continue;
    }
    assert.ok(html.includes('core/access.js'), p + ' must load core/access.js');
    assert.ok(html.includes('shared/access-modules.js'), p + ' must load the module registry');
    // Order matters: access.js reads ACCESS_PAGE_MODULE at call time, and
    // core/auth.js must be parsed before the hook it calls exists.
    assert.ok(html.indexOf('shared/access-modules.js') < html.indexOf('core/access.js'),
      p + ': the registry must load before access.js');
    assert.ok(html.indexOf('core/auth.js') < html.indexOf('core/access.js'),
      p + ': auth.js must load before access.js');
    gated++;
  }
  assert.ok(gated >= 38, 'every sidebar page is wired (' + gated + ')');
});

test('W13 the page guard calls the hook and stops the page when refused', () => {
  const a = read('client/js/core/auth.js');
  assert.match(a, /if \(typeof applyAccessControl === 'function'\) \{/);
  assert.match(a, /const allowed = await applyAccessControl\(session\.user\);/);
  assert.match(a, /if \(!allowed\) return null;/);
  // Optional, so a page that does not load access.js is unaffected rather
  // than broken.
  assert.match(a, /typeof applyAccessControl === 'function'/);
});

test('W14 the client treats an Admin as unrestricted, not as unpermitted', () => {
  const ac = read('client/js/core/access.js');
  // permissions === null means UNRESTRICTED for an Admin. Reading it as
  // "nothing granted" would lock an Admin out of their own application.
  assert.match(ac, /if \(!_access \|\| _access\.role === 'admin'\) return true;/);
  // And the file says plainly that none of it is the security boundary.
  assert.match(ac, /Everything here is PRESENTATION/);
});

test('W15 the new migration is additive, registered, and its rollback is not', () => {
  const mig = SERVER('db/migrations/migration_employee_accounts.sql');
  const exec = mig.replace(/--.*$/gm, '');
  for (const kw of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i, /\bDROP\s+TABLE\b/i]) {
    assert.equal(kw.test(exec), false, 'migration must not execute ' + kw);
  }
  assert.equal(/^\s*BEGIN\s*;/mi.test(exec), false, 'the runner owns the transaction');
  // The one non-additive change, deliberately and visibly.
  assert.match(exec, /ALTER COLUMN email DROP NOT NULL/);
  assert.match(mig, /ONE NON-ADDITIVE CHANGE/, 'and it is called out in the file');

  const manifest = JSON.parse(SERVER('db/migrations/_manifest.json'));
  // Present and in the right place. It is no longer LAST - the receipt
  // voucher items migration was registered after it - and being final was
  // only incidentally true, where the ORDER is what matters.
  assert.ok(manifest.order.includes('migration_employee_accounts.sql'));
  assert.ok(manifest.order.indexOf('migration_employee_accounts.sql')
    > manifest.order.indexOf('migration_cascade_protection.sql'),
    'it runs after the cascade protection it depends on');
  assert.equal(manifest.order.filter(f => /rollback/.test(f)).length, 0);
  assert.ok(fs.existsSync(path.join(__dirname, '..',
    'db/migrations/rollback/migration_employee_accounts_rollback.sql')));
});

test('W16 schema.sql describes the same database the migration produces', () => {
  const s = SERVER('db/schema/schema.sql');
  assert.match(s, /CREATE TABLE IF NOT EXISTS employee_accounts/);
  assert.match(s, /CREATE TABLE IF NOT EXISTS employee_account_audit/);
  assert.match(s, /employee_code TEXT,/);
  assert.match(s, /must_change_password BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(s, /session_epoch INTEGER NOT NULL DEFAULT 0/);
  assert.equal(/email TEXT UNIQUE NOT NULL/.test(s), false, 'users.email is nullable here too');
  assert.match(s, /uq_users_employee_code/);
  // created_by on the tenant tables, which is what 'own' scope filters on.
  const authors = (s.match(/created_by UUID REFERENCES users\(id\) ON DELETE SET NULL/g) || []).length;
  assert.ok(authors >= 45, 'created_by is declared on the tenant tables (' + authors + ')');
});
