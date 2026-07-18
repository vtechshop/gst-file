// Authentication — register, login, logout, forgot-password (stub), me.
// Replaces Supabase Auth's signUp/signInWithPassword/signOut/
// resetPasswordForEmail/getSession, called from js/apiClient.js's
// `auth` sub-object (Phase 2) instead of the old fake LocalSupabase auth.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

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

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name };
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
      res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

router.post('/login',
  authLimiter,
  body('email').isEmail(),
  body('password').notEmpty(),
  asyncRoute(async (req, res) => {
    checkValidation(req);
    const email = req.body.email.trim().toLowerCase();
    const { rows } = await pool.query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email]);
    const user = rows[0];
    // Same generic message whether the email doesn't exist or the
    // password is wrong — never reveal which, to avoid account enumeration.
    const genericError = () => { const e = new Error('Invalid email or password.'); e.status = 401; e.expose = true; throw e; };
    if (!user) genericError();
    const ok = await bcrypt.compare(req.body.password, user.password_hash);
    if (!ok) genericError();
    res.json({ token: signToken(user.id), user: publicUser(user) });
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

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: { message: 'User no longer exists.' } });
  res.json({ user: publicUser(rows[0]) });
}));

module.exports = router;
