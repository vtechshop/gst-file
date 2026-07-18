// Single shared `pg` connection pool for the whole backend. Every query
// anywhere in the app should go through this (or a client checked out
// from it for a transaction) — never open a second pool/connection.
const { Pool, types } = require('pg');

// `pg` parses Postgres DATE columns (OID 1082) into JS Date objects by
// default, which then JSON-serialize as full ISO datetimes
// ("2026-07-18T00:00:00.000Z") instead of the plain "YYYY-MM-DD" the
// frontend's <input type="date"> fields require — that mismatch makes
// the browser silently reject the value, leaving the field blank (this
// broke Invoice Edit's date field before this fix). Returning the raw
// string Postgres itself sends avoids both the format issue and any
// timezone-shift risk from the Date-object conversion.
types.setTypeParser(1082, (val) => val);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — check server/.env');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  // Idle client errors (e.g. the DB restarting) shouldn't crash the
  // whole server — log and let the pool recover on the next checkout.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;
