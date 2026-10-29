// A test user who can actually sign in.
//
// Every harness in tests/ seeds users with a placeholder password_hash ('x',
// 'e2e-not-a-real-hash') and then mints a JWT directly, because none of them
// needed the login route. That is fine for testing what happens after a
// session exists, and it is why nothing here has ever exercised
// POST /api/auth/login: bcrypt.compare() against a placeholder cannot
// succeed, by design.
//
// This produces the one thing that was missing - a real bcrypt hash of a
// known password - using the project's own bcryptjs (already a production
// dependency, so no new package and no second hashing implementation).
//
// SAFETY: the password below is a fixture constant for a disposable database.
// It is not a credential for anything, it is not read from the environment,
// and no production user is touched. Call this only against a scratch
// database, exactly as the rest of tests/ does.
const bcrypt = require('bcryptjs');

// Deliberately obvious. A realistic-looking password invites someone to
// wonder whether it is real somewhere.
const TEST_PASSWORD = 'scratch-only-not-a-real-password';

// The cost the application itself uses, so a login test measures the real
// comparison. Looked up rather than guessed: src/routes/auth.js hashes at
// this cost when it registers a user.
const BCRYPT_ROUNDS = 10;

// Seeds a user who can log in, and returns what a login test needs.
//
// `client` is a connected pg Client or Pool on the SCRATCH database. The
// profile row is created too, because the app's own pages expect one and a
// user without it is not a state the application can reach.
async function seedLoginUser(client, opts) {
  const o = opts || {};
  const email = (o.email || 'login@scratch.test').toLowerCase();
  const password = o.password || TEST_PASSWORD;
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email`,
    [email, hash, o.name || 'Scratch Login User']);
  const user = rows[0];

  await client.query(
    `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
     VALUES ($1, $2, $3, $4, 'Tamil Nadu', 'Coimbatore', '14, Avinashi Road')
     ON CONFLICT (id) DO NOTHING`,
    [user.id, o.businessName || 'VTECH Engineering Works',
     o.businessName || 'VTECH Engineering Works', o.gstin || '33AAGCV4521K1ZT']);

  return { id: user.id, email: user.email, password };
}

module.exports = { seedLoginUser, TEST_PASSWORD, BCRYPT_ROUNDS };
