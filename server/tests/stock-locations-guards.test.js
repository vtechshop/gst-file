// Phase 2 rules that can be proved without a database.
//
// The behaviour is in stock-locations-integration.test.js, which needs real
// Postgres. These are the invariants a later edit could quietly undo: the
// lock ordering that prevents transfer deadlock, the single Low Stock
// threshold, the migration staying additive, and the backfill staying out
// of the migrator.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const LEDGER = rd('server', 'src', 'services', 'stock-ledger.js');
const ROUTES = rd('server', 'src', 'routes', 'stock.js');
const MIG = rd('server', 'db', 'migrations', 'migration_stock_locations.sql');
const BACKFILL = rd('server', 'db', 'backfill', 'backfill_default_location.sql');
const DASH = rd('dashboard.html');

// ── Low Stock: one authority ──────────────────────────────────────────
test('P1 reorder_level is the only Low Stock threshold in the application', () => {
  // the hardcoded browser threshold is gone
  assert.equal(/LOW_STOCK_THRESHOLD/.test(DASH), false,
    'the flat "<= 10 units" rule must not remain anywhere');
  // and the dashboard no longer classifies at all: it asks the server,
  // which is stronger than keeping a copy that merely agrees. Two
  // implementations of one rule agree only until one of them is edited.
  assert.equal(/function dashStockStatus/.test(DASH), false,
    'the browser must not classify stock itself');
  assert.equal(/'LOW_STOCK'/.test(DASH), false,
    'no second LOW_STOCK rule may live in the browser');
  assert.match(DASH, /apiFetch\('\/stock\/stats'\)/,
    'the counts come from the server summary');
  assert.match(DASH, /apiFetch\('\/stock\?status=LOW_STOCK/,
    'and so does the list, already classified');
  assert.match(DASH, /stats\.low_stock/);
  assert.match(DASH, /stats\.out_of_stock/);
  // the server's rule is unchanged and still the single SQL definition
  assert.match(LEDGER, /WHEN p\.stock <= 0 THEN 'OUT_OF_STOCK'/);
  assert.match(LEDGER, /p\.reorder_level IS NOT NULL AND p\.stock <= p\.reorder_level THEN 'LOW_STOCK'/);
  // no second threshold was invented
  assert.equal(/THRESHOLD\s*=\s*\d/.test(LEDGER + ROUTES), false);
});

// ── Deadlock prevention ───────────────────────────────────────────────
test('P2 balance rows are always locked in one agreed order', () => {
  // sorted ids, inserted in that order, then locked in that order
  assert.match(LEDGER, /const ids = \[\.\.\.new Set\(locationIds\.filter\(Boolean\)\)\]\.sort\(\);/);
  assert.match(LEDGER, /ORDER BY location_id\s*\n\s*FOR UPDATE/);
  // the product row is taken first, before any balance
  const fn = LEDGER.slice(LEDGER.indexOf('async function applyStockDelta'), LEDGER.indexOf('async function transferStock'));
  assert.ok(fn.indexOf('FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE')
    < fn.indexOf('lockBalances'), 'product lock must precede balance locks');
  // a transfer locks BOTH ends up front, before writing either
  const tf = LEDGER.slice(LEDGER.indexOf('async function transferStock'));
  assert.ok(tf.indexOf('lockBalances(client, userId, productId, [from, to])') < tf.indexOf('applyStockDelta'),
    'both balances must be locked before either half is applied');
  // and the halves reuse those locks rather than re-taking them
  assert.match(tf, /locationLocked: true, lockedBalances: locked/);
});

test('P3 a transfer validates both ends against the tenant', () => {
  const tf = LEDGER.slice(LEDGER.indexOf('async function transferStock'));
  assert.match(tf, /const from = await resolveLocation\(client, userId, fromLocationId\);/);
  assert.match(tf, /const to = await resolveLocation\(client, userId, toLocationId\);/);
  assert.match(tf, /if \(fromLocationId === toLocationId\)/);
  assert.match(tf, /Transfer quantity must be a number greater than zero/);
  // a location id from a request is a request, not an authorisation
  assert.match(LEDGER, /WHERE id = \$1 AND user_id = \$2 AND active/);
  // and products.stock is never written by a transfer
  const applyCalls = (tf.match(/applyStockDelta\(/g) || []).length;
  assert.strictEqual(applyCalls, 2, 'a transfer is exactly two movements');
  assert.equal(/UPDATE products SET stock/.test(tf), false,
    'the two halves cancel out; a transfer must not touch the company total itself');
});

// ── Guard applies per location ────────────────────────────────────────
test('P4 the negative guard checks the location, not only the company total', () => {
  const fn = LEDGER.slice(LEDGER.indexOf('async function applyStockDelta'), LEDGER.indexOf('async function transferStock'));
  assert.match(fn, /const hereNext = round3\(here \+ deltaQty\);/);
  assert.match(fn, /if \(hereNext < 0\) \{/);
  assert.match(fn, /if \(next < 0\) \{/, 'the company-wide guard is still there too');
  // the balance is written before the movement is recorded
  assert.ok(fn.indexOf('UPDATE stock_balances SET quantity') < fn.indexOf('INSERT INTO stock_movements'));
});

test('P5 a tenant with no locations keeps Phase 1 behaviour', () => {
  assert.match(LEDGER, /async function defaultLocationId\(client, userId\)/);
  assert.match(LEDGER, /if \(!requested\) return defaultLocationId\(client, userId\);/);
  // location work is conditional on there being a location at all
  const fn = LEDGER.slice(LEDGER.indexOf('async function applyStockDelta'), LEDGER.indexOf('async function transferStock'));
  assert.match(fn, /if \(locationId\) \{/);
  // and the NULL sentinel is untouched
  assert.match(fn, /if \(!rows\.length \|\| rows\[0\]\.stock === null\) return null;/);
});

// ── API shape ─────────────────────────────────────────────────────────
test('P6 location routes are declared before the product-detail route', () => {
  const order = ['/locations', '/transfer', "'/:productId'"];
  const at = order.map(p => ROUTES.indexOf(p));
  assert.ok(at[0] > 0 && at[1] > 0 && at[2] > 0);
  assert.ok(at[0] < at[2], "'/locations' would otherwise be read as a product id");
  assert.ok(at[1] < at[2], "'/transfer' would otherwise be read as a product id");
});

test('P7 transfers are idempotent by reference, enforced in the database', () => {
  assert.match(MIG, /CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_transfer_half\s*\n\s*ON stock_movements \(transfer_id, movement_type\) WHERE transfer_id IS NOT NULL;/);
  // the route turns the collision into "already recorded", not a failure
  assert.match(ROUTES, /err\.code === '23505'/);
  assert.match(ROUTES, /transfer_already_recorded/);
  assert.match(ROUTES, /const transferId = body\.transfer_id \|\| randomUUID\(\);/);
});

test('P8 a location that has been used cannot be deleted', () => {
  assert.match(MIG, /location_id UUID REFERENCES stock_locations\(id\) ON DELETE RESTRICT NOT NULL/);
  assert.match(ROUTES, /still holds \$\{round3\(\+held\[0\]\.q\)\} in stock/);
  assert.match(ROUTES, /appears in the stock ledger and cannot be deleted/);
  assert.match(ROUTES, /The default location cannot be deleted/);
  assert.match(ROUTES, /The default location cannot be deactivated/);
});

test('P9 every location and balance query is tenant-scoped', () => {
  const slice = ROUTES.slice(ROUTES.indexOf("router.get('/locations'"), ROUTES.indexOf('// ── Stock Summary'));
  const statements = slice.match(/(SELECT|INSERT INTO|UPDATE|DELETE FROM)[\s\S]{0,600}?`/g) || [];
  assert.ok(statements.length >= 6);
  for (const st of statements) {
    if (!/stock_locations|stock_balances|stock_movements/.test(st)) continue;
    // Every such statement must name user_id — as a filter, or as the column
    // an INSERT forces from the JWT. Matching an exact placeholder number is
    // too brittle: several are computed from the parameter array's length
    // rather than written literally, and an earlier version of this test
    // failed on two statements that were correctly scoped.
    assert.ok(/user_id/.test(st),
      'a location statement never mentions user_id:\n' + st.replace(/\s+/g, ' ').slice(0, 180));
  }
  // The value bound to it is always req.userId, never anything from the body.
  assert.match(ROUTES, /INSERT INTO stock_locations \(user_id, name, code, is_default, active\)/);
  assert.match(ROUTES, /\[req\.userId, name, code, isDefault\]/);
  assert.equal(/body\.user_id|body\.tenant_id|body\.workshopId|query\.user_id/.test(ROUTES), false,
    'tenancy comes from the JWT, never from the request');
});

// ── Migration safety ──────────────────────────────────────────────────
test('P10 the Phase 2 migration is additive', () => {
  const sql = MIG.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').toUpperCase();
  for (const d of ['DROP TABLE', 'TRUNCATE', 'DELETE FROM', 'UPDATE ']) {
    assert.equal(sql.includes(d), false, `the migration must not contain ${d}`);
  }
  // The one DROP permitted is the CHECK being replaced, which is how
  // Postgres widens a constraint.
  const drops = (sql.match(/DROP /g) || []).length;
  assert.strictEqual(drops, 2, 'only the two CHECK constraints are dropped and re-added');
  assert.match(MIG, /DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check/);
  assert.match(MIG, /DROP CONSTRAINT IF EXISTS stock_movements_transfer_shape_check/);
  for (const c of MIG.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)[^\n]*/g) || []) {
    assert.match(c, /IF NOT EXISTS/, 'every create must be idempotent: ' + c);
  }
  for (const a of MIG.match(/ADD COLUMN[^\n]*/g) || []) {
    assert.match(a, /IF NOT EXISTS/, 'every column add must be idempotent: ' + a);
  }
});

test('P11 the migration declares the constraints Phase 2 depends on', () => {
  assert.match(MIG, /CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_one_default\s*\n\s*ON stock_locations \(user_id\) WHERE is_default;/);
  assert.match(MIG, /CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_user_code\s*\n\s*ON stock_locations \(user_id, lower\(code\)\) WHERE code IS NOT NULL;/);
  assert.match(MIG, /CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_balances_user_product_location\s*\n\s*ON stock_balances \(user_id, product_id, location_id\);/);
  assert.match(MIG, /quantity DECIMAL\(15,3\) NOT NULL DEFAULT 0 CHECK \(quantity >= 0\)/);
  assert.match(MIG, /stock_movements_transfer_shape_check/);
  for (const idx of ['idx_stock_balances_user_product', 'idx_stock_balances_user_location',
    'idx_stock_movements_user_location', 'idx_stock_locations_user']) {
    assert.match(MIG, new RegExp(idx), `${idx} must exist`);
  }
  // no RLS: this schema authorises in Express, and stock must not differ
  assert.equal(/ROW LEVEL SECURITY|CREATE POLICY/i.test(MIG), false);
  // serials are a later phase and must not appear
  assert.equal(/serial/i.test(MIG), false);
});

// ── The backfill stays a decision, not a side effect ──────────────────
test('P12 the backfill is separate, guarded, and fabricates no history', () => {
  const manifest = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));
  assert.ok(!manifest.order.some(f => /backfill/i.test(f)),
    'the migrator must never run the backfill');
  // it writes no movements
  assert.equal(/INSERT INTO stock_movements/i.test(BACKFILL), false,
    'placing existing stock must not invent ledger history for it');
  // it changes no product totals
  assert.equal(/UPDATE products/i.test(BACKFILL), false);
  // re-runnable
  assert.match(BACKFILL, /ON CONFLICT \(user_id, product_id, location_id\) DO NOTHING/);
  assert.match(BACKFILL, /NOT EXISTS \(\s*\n?\s*SELECT 1 FROM stock_locations l WHERE l\.user_id = p\.user_id\s*\n?\s*\)/);
  // and it proves itself before committing
  assert.match(BACKFILL, /RAISE EXCEPTION 'Backfill aborted/);
  assert.match(BACKFILL, /BEGIN;/);
  assert.match(BACKFILL, /COMMIT;/);
});

// ── Nothing outside scope was touched ─────────────────────────────────
test('P13 Phase 3 concerns are absent', () => {
  // routes/stock.js now serves the serial endpoints as well as the location
  // ones, so scanning the whole file can no longer say anything about the
  // locations work. Only the LOCATIONS section of it is read here - from
  // the first location route to where the serial section begins.
  const locationsSection = ROUTES.slice(
    ROUTES.indexOf("router.get('/locations'"),
    ROUTES.indexOf('// ── Serial numbers'));
  const all = LEDGER + locationsSection + MIG;
  // Specific identifiers, not loose words: "serialises" in a comment about
  // row locks is not a serial-inventory feature, and an earlier version of
  // this test failed on exactly that.
  // Serial inventory HAS since been built, and lives in its own migration,
  // service and routes - so this no longer asserts its absence. What it
  // still asserts is that it did not leak into the LOCATIONS work: the
  // files this test reads are the Phase 2 ones, and they carry no serial
  // identifiers of their own.
  for (const later of ['serial_number', 'stock_serials', 'serial_status',
    'valuation', 'weighted_average', 'weighted average', 'FIFO']) {
    assert.equal(all.includes(later), false,
      `${later} does not belong in the locations work`);
  }
  // Valuation is still deferred, and no serial table was created here.
  assert.equal(/CREATE TABLE[^;]*serial/i.test(MIG), false);
});
