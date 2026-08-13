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

// Render (and most hosted Postgres providers) require/accept SSL on
// both their internal and external connection strings; a plain local
// install doesn't speak SSL at all. `RENDER` is set automatically by
// Render's runtime, so this needs no manual config either way.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.RENDER ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  // Idle client errors (e.g. the DB restarting) shouldn't crash the
  // whole server — log and let the pool recover on the next checkout.
  console.error('Unexpected error on idle Postgres client', err);
});

// ── Query timing ─────────────────────────────────────
// Wraps pool.query so every statement reports how long it took and how
// many rows it returned. Off by default; set DB_LOG_QUERIES=1 to profile
// a page, or DB_SLOW_MS=<n> to log only statements slower than n ms.
//
// Row count matters as much as duration here: a 40ms query returning
// 20,000 rows is usually the real problem, because the cost lands on
// serialisation and on the browser, where no server timing would show
// it.
const LOG_ALL = process.env.DB_LOG_QUERIES === '1';
const SLOW_MS = parseInt(process.env.DB_SLOW_MS) || 0;

if (LOG_ALL || SLOW_MS > 0) {
  const rawQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    const started = process.hrtime.bigint();
    try {
      const res = await rawQuery(...args);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (LOG_ALL || ms >= SLOW_MS) {
        const sql = String(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
          .replace(/\s+/g, ' ').trim().slice(0, 160);
        console.log(`[sql] ${ms.toFixed(1).padStart(8)}ms  rows=${String(res?.rowCount ?? 0).padStart(6)}  ${sql}`);
      }
      return res;
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`[sql] ${ms.toFixed(1).padStart(8)}ms  FAILED  ${err.message}`);
      throw err;
    }
  };
}

module.exports = pool;
