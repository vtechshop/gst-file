// =============================================
// Who is asking, whose data is it, and what may they do with it
// =============================================
// requireAuth (middleware/auth.js) answers only "is this token ours". It
// sets req.userId and stops. Everything else about authority is decided
// here, from the database, on every single request:
//
//   req.accountOwnerId  whose business data this request operates in.
//                       For an Admin, themselves. For an employee, their
//                       employer. This is the value that replaces
//                       req.userId in every ownership clause - and it is
//                       the same UUID `company_id` will hold when the
//                       approved multi-company work lands.
//   req.isAdmin         true when the account has no employee row.
//   req.employee        the employee_accounts row, or null.
//   req.permissions     the sanitised permission map, {} for an employee
//                       with nothing granted.
//   req.recordScope     'own' | 'all'  ('all' for an Admin).
//
// Nothing here is read from the request body, query string, URL or token
// payload beyond the subject id. An employee cannot send a company id, a
// role, a permission map or a scope and have any of it believed - the
// only thing the client controls is which account it proves it is, and
// everything else is looked up.
//
// WHY A DATABASE READ PER REQUEST, and not a claim in the JWT
// ----------------------------------------------------------
// The token is stateless with a 7-day life. Putting the role, the
// permissions or the employer in it would make all three stale the moment
// an Admin changed them: a permission withdrawn at 9am would keep working
// until the token expired. Worse, deactivating an employee would not
// actually stop them. So authority is resolved fresh every time, which is
// one indexed read on employee_accounts, and the cost of being correct.
const pool = require('../config/pool');
const {
  accessModuleForApiPath, accessActionForMethod, accessAllows, accessDocumentRequirement,
  ACCESS_MODULES
} = require('../../shared/access-modules');

const ADMIN_ONLY_MODULES = new Set(ACCESS_MODULES.filter(m => m.adminOnly).map(m => m.key));

// The only paths an account that must change its password may reach.
// Anything else answers 403 password_change_required, so a temporary
// password cannot be used to do work - only to be replaced.
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/auth/me', '/auth/change-password', '/auth/logout'
]);

function deny(status, code, message) {
  const e = new Error(message);
  e.status = status; e.expose = true; e.code = code;
  return e;
}

// One query: the account, plus its employee row if it has one.
//
// LEFT JOIN rather than two reads, so "is this an employee" and "what may
// they do" cannot disagree between two round trips.
const ACCOUNT_SQL = `
  SELECT u.id, u.email, u.name, u.employee_code, u.must_change_password, u.session_epoch,
         e.id              AS employee_id,
         e.owner_user_id,
         e.status          AS employee_status,
         e.permissions,
         e.record_scope,
         e.full_name       AS employee_name,
         e.mobile          AS employee_mobile
    FROM users u
    LEFT JOIN employee_accounts e ON e.user_id = u.id
   WHERE u.id = $1`;

// Has the employee_accounts table been created yet - and is its absence
// legitimate?
//
// The application ships before its migration is run, which is the normal
// order here. Between the two, a middleware that simply queried
// employee_accounts would fail with 42P01 on EVERY authenticated request,
// taking the whole API down rather than just the new feature. So the
// absence has to be handled.
//
// But "handled" must not mean "assume Admin whenever a query fails".
// Treating any database error as "no employees yet" would turn a dropped
// connection, a permission problem or a dropped table into a silent
// promotion of every employee to administrator. That is a privilege
// escalation with a database outage as its trigger.
//
// So two questions are asked, not one:
//
//   to_regclass    does the table exist? NULL means absent, and this
//                  function CANNOT fail quietly - a thrown error
//                  propagates to the caller, which answers 500.
//   schema_migrations
//                  was the migration ever applied? If it was, the table
//                  must exist. If the table is gone and the migration is
//                  recorded, that is not a pre-migration database - it is
//                  a damaged one, and the safe answer is to refuse, not
//                  to hand out Admin.
//
// Cached because it runs on every request: a positive answer is permanent
// within the process (a table does not un-exist on its own), a negative
// one is short-lived so applying the migration is picked up without a
// restart. Nothing is cached when a query throws.
const EMPLOYEE_MIGRATION_ID = 'migration_employee_accounts';
let _employeeTable = null;
let _employeeCheckedAt = 0;
const MISSING_RECHECK_MS = 30000;

async function employeeTableExists() {
  if (_employeeTable === true) return true;
  if (_employeeTable === false && Date.now() - _employeeCheckedAt < MISSING_RECHECK_MS) return false;

  // A throw here is NOT caught: a database that cannot answer must not be
  // read as a database with no employees.
  const { rows } = await pool.query("SELECT to_regclass('public.employee_accounts') AS t");
  const present = !!rows[0].t;

  if (!present) {
    // Absent. Legitimate only if the migration was never applied.
    const { rows: applied } = await pool.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'`);
    if (applied.length) {
      const { rows: rec } = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1 OR filename = $2',
        [EMPLOYEE_MIGRATION_ID, EMPLOYEE_MIGRATION_ID + '.sql']);
      if (rec.length) {
        const e = new Error(
          'The employee accounts table is missing although its migration is recorded as '
          + 'applied. Refusing to continue rather than treating every account as an '
          + 'administrator. Restore the schema before using the application.');
        e.status = 503; e.expose = true; e.code = 'employee_schema_damaged';
        throw e;
      }
    }
  }

  _employeeTable = present;
  _employeeCheckedAt = Date.now();
  return present;
}

// Mounted after requireAuth, before any route that touches business data.
async function loadAccount(req, res, next) {
  try {
    // Before the migration there are no employees, so every account is an
    // Admin - which is exactly what every account was beforehand. The
    // application behaves as it did, rather than refusing to serve.
    if (!(await employeeTableExists())) {
      const { rows: u } = await pool.query(
        'SELECT id, email, name FROM users WHERE id = $1', [req.userId]);
      if (!u[0]) throw deny(401, 'auth_required', 'This account no longer exists.');
      req.isAdmin = true;
      req.account = { id: u[0].id, email: u[0].email, name: u[0].name, employeeCode: null };
      req.accountOwnerId = u[0].id;
      req.employee = null;
      req.permissions = null;
      req.recordScope = 'all';
      req.mustChangePassword = false;
      req.employeeSupportPending = true;
      return next();
    }

    const { rows } = await pool.query(ACCOUNT_SQL, [req.userId]);
    const row = rows[0];

    // The account was deleted while a token was still in the wild.
    if (!row) throw deny(401, 'auth_required', 'This account no longer exists.');

    // Session revocation. The token carries the epoch it was issued
    // under; a password reset or a deactivation bumps the stored one, and
    // every token minted before that stops being accepted on its very
    // next request. No session table, no revocation list, and no need to
    // shorten the token's life to make deactivation mean something.
    if (typeof req.tokenEpoch === 'number' && req.tokenEpoch !== row.session_epoch) {
      throw deny(401, 'session_revoked',
        'Your session has ended because the account password or access was changed. Please sign in again.');
    }

    req.isAdmin = !row.employee_id;
    req.account = { id: row.id, email: row.email, name: row.name, employeeCode: row.employee_code };

    if (req.isAdmin) {
      req.accountOwnerId = row.id;
      req.employee = null;
      req.permissions = null;      // null means "unrestricted", not "none"
      req.recordScope = 'all';
    } else {
      // A suspended employee is refused here, before any route runs, so
      // no endpoint has to remember to check it.
      if (row.employee_status !== 'active') {
        throw deny(403, 'account_inactive',
          'This employee account has been deactivated. Contact your administrator.');
      }
      req.accountOwnerId = row.owner_user_id;
      req.employee = {
        id: row.employee_id,
        code: row.employee_code,
        name: row.employee_name,
        mobile: row.employee_mobile,
        ownerUserId: row.owner_user_id
      };
      req.permissions = row.permissions || {};
      req.recordScope = row.record_scope === 'all' ? 'all' : 'own';
    }

    // A temporary password buys exactly one thing: the chance to replace
    // it. Checked after the account is resolved so the message can be
    // specific, and checked for Admins too - if an Admin ever gets a
    // reset, the same rule applies to them.
    if (row.must_change_password) {
      const bare = req.baseUrl ? req.baseUrl.replace(/^\/api/, '') + (req.path === '/' ? '' : req.path) : req.path;
      if (!PASSWORD_CHANGE_ALLOWED.has(bare)) {
        throw deny(403, 'password_change_required',
          'Please set a new password before continuing.');
      }
    }
    req.mustChangePassword = !!row.must_change_password;

    next();
  } catch (err) {
    next(err);
  }
}

// Admin-only, for the surfaces no permission can reach: company and GST
// settings, numbering, backup import and wipe, branding, and employee
// management itself.
function requireAdmin(req, res, next) {
  if (req.isAdmin) return next();
  next(deny(403, 'admin_only',
    'Only an administrator can do this.'));
}

// Permission gate for one named module and action.
function requirePermission(moduleKey, action) {
  return function (req, res, next) {
    if (req.isAdmin) return next();
    if (ADMIN_ONLY_MODULES.has(moduleKey)) {
      return next(deny(403, 'admin_only', 'Only an administrator can do this.'));
    }
    if (accessAllows(req.permissions, moduleKey, action)) return next();
    next(deny(403, 'permission_denied',
      'You do not have permission to ' + action + ' in this section.'));
  };
}

// The blanket gate for the generic CRUD surface and the hand-written
// routers, derived from the request's own path and method.
//
// An endpoint no module claims is treated as ADMIN-ONLY, not as open. A
// path missing from shared/access-modules.js is an oversight, and the
// safe reading of an oversight is "nobody yet" - an employee is refused
// and an Admin is unaffected, which fails visibly instead of silently
// handing out access nobody granted.
function enforceModuleAccess(req, res, next) {
  if (req.isAdmin) return next();

  const bare = (req.baseUrl || '').replace(/^\/api/, '') + (req.path === '/' ? '' : (req.path || ''));

  // /api/documents is one router for thirteen document types, so the
  // module comes from the TYPE and the action from the endpoint. Resolved
  // here rather than waved through: an unrecognised path under /documents
  // returns null and is refused, so this is a mapping, not a bypass.
  if (/^\/documents(\/|$)/.test(bare)) {
    const need = accessDocumentRequirement(req.method, bare, req.body);
    if (!need) {
      return next(deny(403, 'admin_only', 'Only an administrator can use this section.'));
    }
    if (need.adminOnly) {
      return next(deny(403, 'admin_only',
        'Only an administrator can change document numbering.'));
    }
    if (!accessAllows(req.permissions, need.module, need.action)) {
      return next(deny(403, 'permission_denied',
        need.action === 'create'
          ? 'You do not have permission to create documents in this section.'
          : 'You do not have permission to ' + need.action + ' here.'));
    }
    return next();
  }
  const moduleKey = accessModuleForApiPath(bare) || accessModuleForApiPath((req.baseUrl || '').replace(/^\/api/, ''));
  if (!moduleKey) {
    return next(deny(403, 'admin_only',
      'Only an administrator can use this section.'));
  }
  if (ADMIN_ONLY_MODULES.has(moduleKey)) {
    return next(deny(403, 'admin_only', 'Only an administrator can use this section.'));
  }

  const action = accessActionForMethod(req.method);
  if (!action) return next(deny(405, 'method_not_allowed', 'That action is not supported here.'));

  if (!accessAllows(req.permissions, moduleKey, action)) {
    return next(deny(403, 'permission_denied',
      action === 'view'
        ? 'You do not have permission to view this section.'
        : 'You do not have permission to ' + action + ' here.'));
  }
  next();
}

// Everything an authenticated caller is allowed to know about itself.
// Sent to the browser by GET /auth/me and used to build the sidebar; it
// carries no other employee's details and no password material.
function describeAccess(req) {
  return {
    role: req.isAdmin ? 'admin' : 'employee',
    employee_code: req.account ? req.account.employeeCode || null : null,
    account_owner_id: req.accountOwnerId,
    permissions: req.isAdmin ? null : req.permissions,
    record_scope: req.recordScope,
    must_change_password: !!req.mustChangePassword,
    employee: req.employee
      ? { name: req.employee.name, mobile: req.employee.mobile, code: req.employee.code }
      : null
  };
}

module.exports = {
  loadAccount, requireAdmin, requirePermission, enforceModuleAccess, describeAccess,
  employeeTableExists, PASSWORD_CHANGE_ALLOWED,
  // Tests reset the cache after creating or dropping the table.
  __resetEmployeeTableCache: () => { _employeeTable = null; _employeeCheckedAt = 0; }
};
