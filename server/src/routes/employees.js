// =============================================
// Employee Management — Admin only
// =============================================
// Every route here is behind requireAdmin, and every query is additionally
// scoped to req.accountOwnerId. That is belt and braces on purpose: the
// middleware decides WHO may call, the WHERE clause decides WHOSE
// employees they see. Either alone would be a single point of failure, and
// an Admin reaching another Admin's staff list is the kind of bug that is
// quiet until it is a breach.
//
// No employee is ever created by anything but an explicit Admin request.
// There is no seeding, no sample account and no self-registration path.
//
// PASSWORDS
// ---------
// A temporary password is generated server-side, hashed with bcrypt at the
// same cost the rest of the application uses, and returned to the Admin
// EXACTLY ONCE - in the response to the call that created or reset it.
// Nothing stores it, nothing logs it, and no later request can retrieve
// it: a second look requires issuing a new one. That is why the create and
// reset responses are the only places in this file that contain a
// password, and why they say so.
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { loadAccount, requireAdmin, employeeTableExists } = require('../middleware/access');
const { asyncRoute } = require('../middleware/errorHandler');
const { generateEmployeeId, generateTemporaryPassword, isEmployeeId } = require('../utils/employeeId');
const { sanitisePermissions, ACCESS_GRANTABLE } = require('../../shared/access-modules');

const router = express.Router();
const SALT_ROUNDS = 10;

router.use(requireAuth);
router.use(loadAccount);
router.use(requireAdmin);

// Before the migration there is nowhere to put an employee. Saying so is
// the difference between a feature that is not available yet and a 500
// that looks like a bug.
router.use(asyncRoute(async (req, res, next) => {
  if (await employeeTableExists()) return next();
  const e = new Error(
    'Employee management is not available yet: the database migration '
    + 'migration_employee_accounts.sql has not been applied.');
  e.status = 503; e.expose = true; e.code = 'migration_pending';
  throw e;
}));

function checkValidation(req) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const err = new Error(result.array()[0].msg);
    err.status = 400; err.expose = true;
    throw err;
  }
}

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status; e.expose = true; e.code = code;
  return e;
}

// What an Admin is shown about one of their employees. No password hash,
// no session epoch, no token - nothing that could be replayed.
function publicEmployee(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    employee_code: row.employee_code,
    full_name: row.full_name,
    mobile: row.mobile,
    email: row.email,
    status: row.status,
    permissions: row.permissions || {},
    record_scope: row.record_scope,
    must_change_password: !!row.must_change_password,
    last_password_change: row.password_changed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deactivated_at: row.deactivated_at,
    created_by_name: row.created_by_name || null,
    updated_by_name: row.updated_by_name || null,
    deactivated_by_name: row.deactivated_by_name || null
  };
}

const LIST_SQL = `
  SELECT e.id, e.user_id, u.employee_code, e.full_name, e.mobile, e.email,
         e.status, e.permissions, e.record_scope, e.created_at, e.updated_at,
         e.deactivated_at, u.must_change_password, u.password_changed_at,
         cb.name AS created_by_name, ub.name AS updated_by_name, db.name AS deactivated_by_name
    FROM employee_accounts e
    JOIN users u  ON u.id = e.user_id
    LEFT JOIN users cb ON cb.id = e.created_by
    LEFT JOIN users ub ON ub.id = e.updated_by
    LEFT JOIN users db ON db.id = e.deactivated_by
   WHERE e.owner_user_id = $1`;

async function writeAudit(client, req, row, action, details) {
  await client.query(
    `INSERT INTO employee_account_audit
       (owner_user_id, employee_user_id, employee_code, action, actor_user_id, details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [req.accountOwnerId, row.user_id, row.employee_code, action, req.userId,
      JSON.stringify(details || {})]);
}

// ── The permission vocabulary, so the UI is built from the server's own
//    list rather than a copy that can drift out of step. ──
router.get('/modules', (req, res) => {
  res.json({
    modules: ACCESS_GRANTABLE.map(m => ({ key: m.key, label: m.label })),
    actions: ['view', 'create', 'edit', 'delete', 'export']
  });
});

// ── List ──
router.get('/', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(LIST_SQL + ' ORDER BY e.created_at DESC', [req.accountOwnerId]);
  res.json(rows.map(publicEmployee));
}));

// ── One employee ──
router.get('/:id', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(LIST_SQL + ' AND e.id = $2', [req.accountOwnerId, req.params.id]);
  if (!rows[0]) throw fail(404, 'not_found', 'No such employee.');
  res.json(publicEmployee(rows[0]));
}));

// ── The account's own audit trail ──
router.get('/:id/history', asyncRoute(async (req, res) => {
  const { rows: own } = await pool.query(
    'SELECT user_id FROM employee_accounts WHERE id = $1 AND owner_user_id = $2',
    [req.params.id, req.accountOwnerId]);
  if (!own[0]) throw fail(404, 'not_found', 'No such employee.');
  const { rows } = await pool.query(
    `SELECT a.action, a.details, a.created_at, u.name AS actor_name
       FROM employee_account_audit a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.owner_user_id = $1 AND a.employee_user_id = $2
      ORDER BY a.created_at DESC LIMIT 200`,
    [req.accountOwnerId, own[0].user_id]);
  res.json(rows);
}));

// ── Create ──
//
// One transaction: the users row, the employee_accounts row and the audit
// entry commit together or not at all. A half-created employee - a login
// with no permissions row - would read as an ADMIN, which is the one
// outcome that must be impossible.
router.post('/',
  body('full_name').trim().notEmpty().withMessage('Enter the employee name.')
    .isLength({ max: 120 }).withMessage('That name is too long.'),
  body('mobile').optional({ values: 'falsy' }).trim()
    .matches(/^[0-9+\-\s()]{6,20}$/).withMessage('Enter a valid mobile number.'),
  body('email').optional({ values: 'falsy' }).trim().isEmail()
    .withMessage('Enter a valid email address, or leave it blank.'),
  asyncRoute(async (req, res) => {
    checkValidation(req);

    const fullName = req.body.full_name.trim();
    const mobile = (req.body.mobile || '').trim() || null;
    const email = (req.body.email || '').trim().toLowerCase() || null;
    // Default is NO permissions. An employee created and then forgotten
    // about can reach nothing, which is the safe direction for a default
    // to point.
    const permissions = sanitisePermissions(req.body.permissions);
    const scope = req.body.record_scope === 'all' ? 'all' : 'own';

    const isTaken = async (code) => {
      const { rows } = await pool.query(
        'SELECT 1 FROM users WHERE upper(employee_code) = upper($1)', [code]);
      return rows.length > 0;
    };

    const tempPassword = generateTemporaryPassword();
    const hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

    // Retried as a whole, not just the code: uq_users_employee_code is
    // what actually guarantees uniqueness, and it can only refuse at
    // INSERT time. Two Admins creating an employee in the same instant
    // can both be told a code is free, so the constraint is the arbiter
    // and this loop is how its refusal is handled.
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const code = await generateEmployeeId(isTaken);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: u } = await client.query(
          `INSERT INTO users (email, password_hash, name, employee_code, must_change_password)
           VALUES ($1,$2,$3,$4,TRUE) RETURNING id, employee_code`,
          [email, hash, fullName, code]);
        const { rows: e } = await client.query(
          `INSERT INTO employee_accounts
             (owner_user_id, user_id, full_name, mobile, email, permissions, record_scope, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
          [req.accountOwnerId, u[0].id, fullName, mobile, email,
            JSON.stringify(permissions), scope, req.userId]);
        await writeAudit(client, req, { user_id: u[0].id, employee_code: code }, 'created',
          { full_name: fullName, record_scope: scope, modules: Object.keys(permissions) });
        await client.query('COMMIT');
        created = { id: e[0].id, user_id: u[0].id, employee_code: u[0].employee_code };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // 23505 on the employee_code index: the draw collided after the
        // check. Draw again. Any other unique violation is the email,
        // which is the Admin's input and not something to retry.
        if (err && err.code === '23505' && /employee_code/.test(err.constraint || err.detail || '')) {
          continue;
        }
        if (err && err.code === '23505') {
          throw fail(409, 'email_taken',
            'An account with that email address already exists. Leave the email blank, or use a different one.');
        }
        throw err;
      } finally {
        client.release();
      }
    }
    if (!created) {
      throw fail(503, 'employee_id_unavailable',
        'Could not allocate an Employee ID. Please try again.');
    }

    const { rows } = await pool.query(LIST_SQL + ' AND e.id = $2', [req.accountOwnerId, created.id]);
    res.status(201).json({
      employee: publicEmployee(rows[0]),
      // Shown to the Admin once and never again. Not stored anywhere in
      // this shape, not written to any log, and not retrievable by any
      // later request - re-issuing is the only way to see one again.
      temporary_password: tempPassword,
      notice: 'Give these details to the employee now. The password is shown only once and cannot be retrieved later.'
    });
  })
);

// ── Edit: details, permissions and scope ──
//
// The Employee ID is not in the allowed set and no branch here writes it.
// It is the login identifier and it stays fixed for the life of the
// account, so a document raised under it keeps meaning what it meant.
router.patch('/:id',
  body('full_name').optional().trim().notEmpty().withMessage('Enter the employee name.')
    .isLength({ max: 120 }).withMessage('That name is too long.'),
  body('mobile').optional({ values: 'falsy' }).trim()
    .matches(/^[0-9+\-\s()]{6,20}$/).withMessage('Enter a valid mobile number.'),
  body('email').optional({ values: 'falsy' }).trim().isEmail()
    .withMessage('Enter a valid email address, or leave it blank.'),
  asyncRoute(async (req, res) => {
    checkValidation(req);

    if (req.body.employee_code !== undefined) {
      throw fail(400, 'employee_code_immutable',
        'An Employee ID cannot be changed once it has been issued.');
    }
    if (req.body.status !== undefined) {
      throw fail(400, 'use_status_route',
        'Use the deactivate or reactivate action to change an account status.');
    }

    const { rows: existing } = await pool.query(
      `SELECT e.id, e.user_id, u.employee_code, e.permissions, e.record_scope
         FROM employee_accounts e JOIN users u ON u.id = e.user_id
        WHERE e.id = $1 AND e.owner_user_id = $2`,
      [req.params.id, req.accountOwnerId]);
    if (!existing[0]) throw fail(404, 'not_found', 'No such employee.');

    const sets = ['updated_by = $1', 'updated_at = NOW()'];
    const params = [req.userId];
    const details = {};

    for (const col of ['full_name', 'mobile', 'email']) {
      if (req.body[col] === undefined) continue;
      let value = String(req.body[col] || '').trim() || null;
      if (col === 'email' && value) value = value.toLowerCase();
      params.push(value); sets.push(`${col} = $${params.length}`);
      details[col] = value;
    }
    if (req.body.permissions !== undefined) {
      const perms = sanitisePermissions(req.body.permissions);
      params.push(JSON.stringify(perms));
      sets.push(`permissions = $${params.length}::jsonb`);
      details.modules = Object.keys(perms);
    }
    if (req.body.record_scope !== undefined) {
      const scope = req.body.record_scope === 'all' ? 'all' : 'own';
      params.push(scope); sets.push(`record_scope = $${params.length}`);
      details.record_scope = scope;
    }
    if (sets.length === 2) throw fail(400, 'nothing_to_update', 'No changes were supplied.');

    params.push(req.params.id, req.accountOwnerId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE employee_accounts SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND owner_user_id = $${params.length}`, params);
      // The display name and the email address live on BOTH rows, and both
      // have to move together.
      //
      // The name, so the name beside a document matches the one in the
      // list. The email because users.email is a CREDENTIAL - it is what
      // the login form matches - so leaving it behind would mean an
      // employee whose address was corrected still signs in with the old
      // one, and the uniqueness of the new address was never checked. A
      // collision surfaces as the 23505 handled below.
      if (details.full_name) {
        await client.query('UPDATE users SET name = $1 WHERE id = $2',
          [details.full_name, existing[0].user_id]);
      }
      if ('email' in details) {
        await client.query('UPDATE users SET email = $1 WHERE id = $2',
          [details.email, existing[0].user_id]);
      }
      await writeAudit(client, req, existing[0],
        details.modules || details.record_scope ? 'permissions_changed' : 'updated', details);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.code === '23505') {
        throw fail(409, 'email_taken', 'An account with that email address already exists.');
      }
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(LIST_SQL + ' AND e.id = $2', [req.accountOwnerId, req.params.id]);
    res.json(publicEmployee(rows[0]));
  })
);

// ── Reset the password ──
router.post('/:id/reset-password', asyncRoute(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT e.id, e.user_id, u.employee_code, u.session_epoch
       FROM employee_accounts e JOIN users u ON u.id = e.user_id
      WHERE e.id = $1 AND e.owner_user_id = $2`,
    [req.params.id, req.accountOwnerId]);
  if (!existing[0]) throw fail(404, 'not_found', 'No such employee.');

  const tempPassword = generateTemporaryPassword();
  const hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The epoch bump is what makes this a real reset rather than a new
    // password beside a still-working old session: every token already
    // issued for this account stops being accepted on its next request.
    await client.query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE,
              password_changed_at = NOW(), session_epoch = session_epoch + 1
        WHERE id = $2`, [hash, existing[0].user_id]);
    await writeAudit(client, req, existing[0], 'password_reset', { sessions_revoked: true });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({
    employee_code: existing[0].employee_code,
    temporary_password: tempPassword,
    notice: 'Shown only once. The employee is signed out everywhere and must set a new password at next sign-in.'
  });
}));

// ── Deactivate / reactivate ──
//
// This is what "delete" means here. The row is never removed: created_by
// on every document the employee raised points at their users row, and
// deleting it would either break those references or - worse, under the
// old cascade - take the documents with it. Deactivation keeps the history
// readable and stops the login working, which is the whole of what is
// actually wanted.
router.post('/:id/deactivate', asyncRoute(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT e.id, e.user_id, e.status, u.employee_code
       FROM employee_accounts e JOIN users u ON u.id = e.user_id
      WHERE e.id = $1 AND e.owner_user_id = $2`,
    [req.params.id, req.accountOwnerId]);
  if (!existing[0]) throw fail(404, 'not_found', 'No such employee.');
  if (existing[0].status !== 'active') {
    throw fail(409, 'already_inactive', 'That employee is already deactivated.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE employee_accounts
          SET status = 'suspended', deactivated_by = $1, deactivated_at = NOW(), updated_at = NOW()
        WHERE id = $2 AND owner_user_id = $3`,
      [req.userId, req.params.id, req.accountOwnerId]);
    // Revokes every live session immediately, rather than leaving the
    // account working until its 7-day token expires.
    await client.query(
      'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1', [existing[0].user_id]);
    await writeAudit(client, req, existing[0], 'deactivated', { sessions_revoked: true });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(LIST_SQL + ' AND e.id = $2', [req.accountOwnerId, req.params.id]);
  res.json(publicEmployee(rows[0]));
}));

router.post('/:id/reactivate', asyncRoute(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT e.id, e.user_id, e.status, u.employee_code
       FROM employee_accounts e JOIN users u ON u.id = e.user_id
      WHERE e.id = $1 AND e.owner_user_id = $2`,
    [req.params.id, req.accountOwnerId]);
  if (!existing[0]) throw fail(404, 'not_found', 'No such employee.');
  if (existing[0].status === 'active') {
    throw fail(409, 'already_active', 'That employee is already active.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE employee_accounts
          SET status = 'active', deactivated_by = NULL, deactivated_at = NULL, updated_at = NOW()
        WHERE id = $1 AND owner_user_id = $2`,
      [req.params.id, req.accountOwnerId]);
    await writeAudit(client, req, existing[0], 'reactivated', {});
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(LIST_SQL + ' AND e.id = $2', [req.accountOwnerId, req.params.id]);
  res.json(publicEmployee(rows[0]));
}));

// DELETE is answered, not ignored, because a client that tries it deserves
// to be told why rather than getting a 404 that looks like a bug. 409 so
// the explanation reaches the user verbatim - see the note on
// classifyApiError in routes/generic.js.
router.delete('/:id', (req, res, next) => {
  next(fail(409, 'employee_delete_blocked',
    'An employee account is deactivated, not deleted, so the invoices and vouchers '
    + 'they raised keep showing who raised them. Use Deactivate instead.'));
});

module.exports = router;
