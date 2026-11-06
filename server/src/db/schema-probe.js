// =============================================
// What columns does this database actually have?
// =============================================
// The application is deployed from git; the database is migrated by hand,
// with explicit approval, and sometimes much later. So for a while the code
// knows about columns the database has not got yet - and a query naming one
// of them does not degrade, it raises 42703 and takes the whole request
// down with it.
//
// That is not hypothetical. Shipping the employee-accounts feature to a
// database that had not run its migration made three endpoints answer 500:
// login and /auth/me (users.employee_code), and every create (created_by).
// Reads were unaffected, so the application looked alive while being
// unusable - which is the worst way for this to fail.
//
// Hence this: ask the database what it has, and build the statement from
// the answer. Where a column is missing the feature that needs it is simply
// not available, which is exactly what it means for the migration not to
// have run.
//
// CACHING. A column that exists cannot stop existing, so a positive answer
// is kept for the life of the process. A negative one is kept briefly, so
// that applying the migration starts working without a restart. Nothing is
// cached when the lookup throws.
//
// TRUST. An empty answer for a table that certainly has columns means the
// lookup itself is not to be believed - not that the columns are gone. That
// case throws rather than silently degrading, because quietly dropping
// session_epoch would quietly disable session revocation.
const pool = require('../config/pool');

const RECHECK_MS = 30000;

// The columns migration_employee_accounts.sql adds to `users`. Listed so a
// complete answer can be cached permanently, and so there is one place that
// says which columns are conditional.
const EMPLOYEE_USER_COLUMNS = [
  'employee_code', 'must_change_password', 'password_changed_at', 'session_epoch'
];

const AUTHOR_COLUMN = 'created_by';

let _usersCols = null;
let _usersAt = 0;

// Every column `users` has, as a Set.
async function usersColumns() {
  const complete = _usersCols && EMPLOYEE_USER_COLUMNS.every(c => _usersCols.has(c));
  if (_usersCols && (complete || Date.now() - _usersAt < RECHECK_MS)) return _usersCols;

  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'`);
  const cols = new Set(rows.map(r => r.column_name));
  // `id` is in the original schema and in every migration since. If it is
  // not here, the answer is wrong rather than the table being empty.
  if (!cols.has('id')) {
    const e = new Error('The database did not describe its own users table. Refusing to '
      + 'guess which columns exist.');
    e.status = 503; e.expose = true; e.code = 'schema_unreadable';
    throw e;
  }
  _usersCols = cols;
  _usersAt = Date.now();
  return cols;
}

// Does `users` have this column? Used to build a SELECT that names only
// columns the database can actually return.
async function userHasColumn(name) {
  return (await usersColumns()).has(name);
}

// The subset of `names` this database has, in the order given - ready to
// splice into a column list.
async function usersColumnsAmong(names) {
  const have = await usersColumns();
  return names.filter(n => have.has(n));
}

let _authorTables = null;
let _authorAt = 0;

// Which tables carry created_by. One query answers it for all of them,
// which matters because the generic router serves 45 of them.
async function authorTables() {
  if (_authorTables && Date.now() - _authorAt < RECHECK_MS) return _authorTables;
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = $1`, [AUTHOR_COLUMN]);
  _authorTables = new Set(rows.map(r => r.table_name));
  _authorAt = Date.now();
  return _authorTables;
}

// Can this table record who created a row? False before the migration, and
// the row is then written without an author - which is what every row in
// the database already looks like.
async function tableHasAuthorColumn(table) {
  if (_authorTables && _authorTables.has(table)) return true;   // cannot un-exist
  return (await authorTables()).has(table);
}

module.exports = {
  EMPLOYEE_USER_COLUMNS,
  usersColumns,
  userHasColumn,
  usersColumnsAmong,
  tableHasAuthorColumn,
  // Tests reset these after creating or dropping columns.
  __resetSchemaProbeCache: () => {
    _usersCols = null; _usersAt = 0; _authorTables = null; _authorAt = 0;
  }
};
