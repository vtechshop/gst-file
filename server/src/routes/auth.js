// Authentication — register, login, logout, forgot-password (stub), me.
// Replaces Supabase Auth's signUp/signInWithPassword/signOut/
// resetPasswordForEmail/getSession, called from js/apiClient.js's
// `auth` sub-object (Phase 2) instead of the old fake LocalSupabase auth.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { loadAccount, describeAccess, employeeTableExists } = require('../middleware/access');
const { asyncRoute } = require('../middleware/errorHandler');
const { isEmployeeId } = require('../utils/employeeId');
const { userHasColumn, usersColumnsAmong } = require('../db/schema-probe');

// The columns this file reads from `users` that only exist once
// migration_employee_accounts.sql has run. Every statement below names
// whichever of them the database actually has, so that signing in and
// loading a page keep working on a database where the migration is still
// pending - which is the state every deployment is in until it is applied.
const EMPLOYEE_COLUMNS = ['employee_code', 'session_epoch', 'must_change_password'];

const router = express.Router();
const SALT_ROUNDS = 10;

// Applied only to the genuinely brute-forceable endpoints below (never
// to /me, which fires on every authenticated page load).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts — please wait a few minutes and try again.' } }
});

function checkValidation(req) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const err = new Error(result.array()[0].msg);
    err.status = 400;
    err.expose = true;
    throw err;
  }
}

// The epoch is the second and last claim. Role, employer and permissions
// are deliberately NOT in the token: an Admin changing a permission would
// otherwise not take effect until the token expired, and a deactivated
// employee would keep working for up to seven days. Authority is resolved
// from the database on every request instead - see middleware/access.js.
function signToken(userId, sessionEpoch) {
  return jwt.sign({ sub: userId, epoch: sessionEpoch || 0 }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

function publicUser(row) {
  return {
    id: row.id, email: row.email, name: row.name,
    // An employee needs to see their OWN Employee ID - it is how they sign
    // in. No other account's code is ever included here.
    employee_code: row.employee_code || null
  };
}

router.post('/register',
  authLimiter,
  body('email').isEmail().withMessage('Enter a valid email address.'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  asyncRoute(async (req, res) => {
    checkValidation(req);
    const email = req.body.email.trim().toLowerCase();
    const name = (req.body.name || '').trim();
    const passwordHash = await bcrypt.hash(req.body.password, SALT_ROUNDS);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name',
        [email, passwordHash, name || null]
      );
      const user = rows[0];
      // Mirrors the retired handle_new_user() Supabase trigger — every
      // account gets a profile row up front so Settings/Invoice Entry
      // never have to special-case "no profile yet" on first load.
      await client.query(
        'INSERT INTO profiles (id, email, name) VALUES ($1,$2,$3)',
        [user.id, email, name || null]
      );
      await client.query('COMMIT');
      // Registration always creates an ADMIN: a brand new account with no
      // employee_accounts row, which is what every existing account already
      // is. Employees are never self-registered - only an Admin creates
      // them, through POST /api/employees.
      res.status(201).json({ token: signToken(user.id, 0), user: publicUser(user) });
    } catch (err) {
      await client.query('ROLLBACK');
      // A unique violation here can only be the email — reworded on the
      // way out, because the generic 23505 handler in
      // middleware/errorHandler.js would say "A record with that value
      // already exists", which tells someone signing up nothing about
      // what to do next.
      if (err && err.code === '23505') {
        const e = new Error('An account with that email already exists — try signing in instead.');
        e.status = 409; e.expose = true; e.code = 'email_taken';
        throw e;
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

router.post('/login',
  authLimiter,
  // One field, two kinds of identifier. The old rule was isEmail(), which
  // would now reject VT-EMP-K7M4Q9 before the lookup ever ran, so the
  // check is "not empty" and the SHAPE decides which column to match.
  // Deliberately NOT "try email, then try employee code": that is two
  // lookups and two chances to leak which one existed.
  body('identifier').optional().isString(),
  body('email').optional().isString(),
  body('password').notEmpty().withMessage('Enter your password.'),
  asyncRoute(async (req, res) => {
    checkValidation(req);
    // `identifier` is what the login form sends now; `email` is still
    // accepted so an older cached page keeps working.
    const typed = String(req.body.identifier || req.body.email || '').trim();
    if (!typed) {
      const e = new Error('Enter your email address or Employee ID.');
      e.status = 400; e.expose = true; throw e;
    }

    // An Employee ID is matched case-insensitively on upper(employee_code),
    // which is the expression uq_users_employee_code indexes - so the
    // lookup uses the index rather than scanning. Anything else is treated
    // as an email. A password is required either way: an Employee ID alone
    // authenticates nobody.
    // Only the columns this database has. Before the employee migration
    // there are none of them, and the statement is the one this route ran
    // before employees existed.
    const extra = await usersColumnsAmong(EMPLOYEE_COLUMNS);
    const select = ['id', 'email', 'name', 'password_hash'].concat(extra).join(', ');

    // An Employee ID is matched on a column that does not exist yet, and
    // no employee can exist without it either - so there is nothing to
    // find. Answered with the ordinary wrong-credentials message rather
    // than an error, because to the person typing it that is what it is.
    const byEmployeeId = isEmployeeId(typed);
    const canMatchEmployeeId = byEmployeeId && await userHasColumn('employee_code');

    const { rows } = byEmployeeId
      ? (canMatchEmployeeId
          ? await pool.query(
              `SELECT ${select} FROM users WHERE upper(employee_code) = upper($1)`, [typed])
          : { rows: [] })
      : await pool.query(
          `SELECT ${select} FROM users WHERE email = $1`, [typed.toLowerCase()]);
    const user = rows[0];
    // Same generic message whether the email doesn't exist or the
    // password is wrong — never reveal which, to avoid account enumeration.
    // 'invalid_credentials' rather than the status-derived 'auth_required':
    // this 401 means "those sign-in details are wrong", NOT "your session
    // ended". The browser's handleApiError() only tears down the session
    // and bounces to the login page for the latter, so without its own
    // code a mistyped password on index.html would be reported as an
    // expired session.
    const genericError = () => {
      const e = new Error('Invalid email or password.');
      e.status = 401; e.expose = true; e.code = 'invalid_credentials';
      throw e;
    };
    if (!user) genericError();
    const ok = await bcrypt.compare(req.body.password, user.password_hash);
    if (!ok) genericError();

    // A deactivated employee cannot sign in. Checked here as well as on
    // every request (middleware/access.js) because the two answer
    // different questions: this one stops a new session being created, that
    // one stops an existing one continuing. The message is deliberately
    // specific - unlike a wrong password, "your account is deactivated" is
    // not something an attacker learns anything from, and a employee who is
    // not told would simply keep retrying a password that is correct.
    // Asked only where there is an employee_accounts table to ask. Without
    // one no account can be an employee, so there is no deactivation to
    // honour and nothing is weakened by skipping it.
    const employeesExist = await employeeTableExists();
    const { rows: emp } = employeesExist
      ? await pool.query('SELECT status FROM employee_accounts WHERE user_id = $1', [user.id])
      : { rows: [] };
    if (emp[0] && emp[0].status !== 'active') {
      const e = new Error('This employee account has been deactivated. Contact your administrator.');
      e.status = 403; e.expose = true; e.code = 'account_inactive';
      throw e;
    }

    res.json({
      token: signToken(user.id, user.session_epoch),
      user: publicUser(user),
      // The browser routes straight to the change-password screen on this,
      // rather than letting a temporary password be used for work.
      must_change_password: !!user.must_change_password
    });
  })
);

router.post('/logout', (req, res) => {
  // Stateless JWT — nothing to invalidate server-side; the client
  // discards its token. Endpoint exists purely so the frontend has a
  // symmetric call to make (mirrors _supabase.auth.signOut()).
  res.json({ ok: true });
});

router.post('/forgot-password', authLimiter, body('email').isEmail(), (req, res) => {
  // No email-sending infrastructure exists yet — an honest "not
  // available" response, never a fake success, per the agreed design.
  res.json({ available: false, message: "Password reset isn't available yet — please contact support." });
});

// Identity AND authority, because the browser needs both to draw the right
// sidebar - and because this is the one place the client is allowed to learn
// what it may do. It carries no other employee's details and no password
// material. loadAccount runs first, so a revoked session or a deactivated
// employee is refused here too rather than being told who they are.
router.get('/me', requireAuth, loadAccount, asyncRoute(async (req, res) => {
  // employee_code only once the migration has run. This route fires on
  // every authenticated page load, so naming a column the database has not
  // got made the whole application unreachable, not just this endpoint.
  const extra = await usersColumnsAmong(['employee_code']);
  const { rows } = await pool.query(
    `SELECT ${['id', 'email', 'name'].concat(extra).join(', ')} FROM users WHERE id = $1`,
    [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: { message: 'This account no longer exists.', code: 'auth_required' } });
  res.json({ user: { ...publicUser(rows[0]), ...describeAccess(req) } });
}));

// Replacing a temporary password, and changing a password generally.
//
// The current password is required even though the caller is already
// authenticated: a token left behind on a shared machine should not be
// enough to lock the real owner out of their own account.
router.post('/change-password',
  authLimiter,
  requireAuth,
  loadAccount,
  body('current_password').notEmpty().withMessage('Enter your current password.'),
  body('new_password').isLength({ min: 8 })
    .withMessage('Your new password must be at least 8 characters.'),
  asyncRoute(async (req, res) => {
    checkValidation(req);
    const epochCol = await userHasColumn('session_epoch');
    const { rows } = await pool.query(
      `SELECT password_hash${epochCol ? ', session_epoch' : ''} FROM users WHERE id = $1`,
      [req.userId]);
    if (!rows[0]) {
      const e = new Error('This account no longer exists.');
      e.status = 401; e.expose = true; e.code = 'auth_required'; throw e;
    }
    const ok = await bcrypt.compare(req.body.current_password, rows[0].password_hash);
    if (!ok) {
      const e = new Error('That current password is not right.');
      e.status = 400; e.expose = true; e.code = 'invalid_credentials'; throw e;
    }
    if (req.body.new_password === req.body.current_password) {
      const e = new Error('Choose a password different from the current one.');
      e.status = 400; e.expose = true; throw e;
    }

    const hash = await bcrypt.hash(req.body.new_password, SALT_ROUNDS);
    // The epoch bump signs out every OTHER device holding a token for this
    // account. The caller gets a fresh token below so their own session
    // continues - changing your password should not log you out of the tab
    // you changed it in.
    const next = (rows[0].session_epoch || 0) + 1;
    // Only the columns this database has. Without session_epoch there is
    // no revocation to perform - and no employee to revoke, since the same
    // migration creates both - so the password change itself still lands.
    const sets = ['password_hash = $1'];
    const values = [hash];
    for (const [col, expr] of [
      ['must_change_password', 'must_change_password = FALSE'],
      ['password_changed_at', 'password_changed_at = NOW()']
    ]) {
      if (await userHasColumn(col)) sets.push(expr);
    }
    if (epochCol) { values.push(next); sets.push(`session_epoch = $${values.length}`); }
    values.push(req.userId);
    await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length}`, values);

    if (!req.isAdmin) {
      await pool.query(
        `INSERT INTO employee_account_audit
           (owner_user_id, employee_user_id, employee_code, action, actor_user_id, details)
         VALUES ($1,$2,$3,'password_changed',$2,'{}'::jsonb)`,
        [req.accountOwnerId, req.userId, req.account.employeeCode]);
    }

    res.json({ ok: true, token: signToken(req.userId, next) });
  })
);

module.exports = router;
