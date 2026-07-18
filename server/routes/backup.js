// Backs Settings' "Backup Data / Restore Data / Clear All" buttons
// (js/backup.js on the frontend, formerly js/localdb.js's DB_TABLES
// functions that read/wrote localStorage directly). Same JSON shape the
// old client-side exportLocalBackup() already produced, now scoped per
// user against Postgres instead of the whole browser's localStorage.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

// Keep in sync with js/backup.js's DB_TABLES — deliberately excludes
// `profiles` (identity/settings, not "data" in the backup/restore sense).
const DB_TABLES = ['b2b_invoices', 'b2c_invoices', 'b2b_hsn', 'b2c_hsn', 'customers', 'cdn_notes', 'products', 'import_mappings', 'invoice_items', 'payments'];

router.get('/export', asyncRoute(async (req, res) => {
  const backup = { _version: '1.0', _exported_at: new Date().toISOString() };
  for (const table of DB_TABLES) {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE user_id = $1`, [req.userId]);
    backup[table] = rows;
  }
  res.json(backup);
}));

router.post('/import', asyncRoute(async (req, res) => {
  const backup = req.body;
  if (!backup || !backup._version) {
    const e = new Error('Invalid backup file.'); e.status = 400; e.expose = true; throw e;
  }

  const client = await pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    for (const table of DB_TABLES) {
      const incoming = Array.isArray(backup[table]) ? backup[table] : [];
      // Replace semantics (matches the old localStorage behavior of
      // wholesale-overwriting a table) — but scoped to this user only,
      // never touching any other user's rows in the shared database.
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [req.userId]);
      for (const row of incoming) {
        const payload = { ...row, user_id: req.userId }; // ownership always forced, never trusted from the file
        const cols = Object.keys(payload);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(c => payload[c]));
        count++;
      }
    }
    await client.query('COMMIT');
    res.json({ restoredCount: count });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/all-data', asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of DB_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [req.userId]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
