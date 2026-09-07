// The stock rules that can be proved without a database.
//
// The behaviour lives in stock-ledger-integration.test.js and
// stock-api-integration.test.js, which need real Postgres. These are the
// invariants a future edit could quietly undo — a movement type slipping
// into the allow-list, Product Sync learning to write stock again, the
// negative-stock guard being softened — and they run in the default suite.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const LEDGER = rd('server', 'src', 'services', 'stock-ledger.js');
const STOCK_ROUTE = rd('server', 'src', 'routes', 'stock.js');
const GENERIC = rd('server', 'src', 'routes', 'generic.js');
const INVOICES = rd('server', 'src', 'routes', 'invoices.js');
const PURCHASES = rd('server', 'src', 'routes', 'purchases.js');
const RETURNS = rd('server', 'src', 'routes', 'sales-returns.js');
const SYNC = rd('client', 'js', 'api', 'product-sync.js');
const MIGRATION = rd('server', 'db', 'migrations', 'migration_stock_ledger.sql');

const { MOVEMENT_TYPES, MANUAL_MOVEMENT_DIRECTION, round3 } =
  require(path.join(__dirname, '..', 'src', 'services', 'stock-ledger'));

// ── The movement vocabulary ───────────────────────────────────────────
test('G1 the movement types are exactly the approved Phase 1 set', () => {
  assert.deepStrictEqual([...MOVEMENT_TYPES].sort(), [
    'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'CONSUMPTION', 'DAMAGE', 'FREE_ISSUE',
    'OPENING', 'PURCHASE', 'PURCHASE_RETURN', 'SALE', 'SALES_RETURN',
    'SAMPLE', 'SCRAP'
  ]);
  // Location/transfer types are a later phase and must not appear yet.
  for (const deferred of ['TRANSFER_IN', 'TRANSFER_OUT']) {
    assert.ok(!MOVEMENT_TYPES.includes(deferred), `${deferred} is deferred to a later phase`);
    assert.ok(!MIGRATION.includes(`'${deferred}'`), `${deferred} must not be in the CHECK constraint`);
  }
});

test('G2 the database CHECK matches the code allow-list exactly', () => {
  const check = MIGRATION.slice(MIGRATION.indexOf('movement_type TEXT NOT NULL CHECK'),
    MIGRATION.indexOf('direction TEXT NOT NULL'));
  const inSql = [...check.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(inSql, [...MOVEMENT_TYPES].sort(),
    'a type the code accepts but the database rejects would fail at runtime, and vice versa');
});

test('G3 every manual movement type has a direction and is a real type', () => {
  for (const [type, dir] of Object.entries(MANUAL_MOVEMENT_DIRECTION)) {
    assert.ok(MOVEMENT_TYPES.includes(type), `${type} must be a known movement type`);
    assert.ok(dir === 'IN' || dir === 'OUT', `${type} needs a direction`);
  }
  // The document-driven types are NOT manually raisable: a SALE must come
  // from an invoice, not from someone posting to /api/stock/adjustment.
  for (const documentDriven of ['SALE', 'PURCHASE', 'SALES_RETURN', 'PURCHASE_RETURN', 'OPENING']) {
    assert.ok(!MANUAL_MOVEMENT_DIRECTION[documentDriven],
      `${documentDriven} must not be raisable through the adjustment endpoint`);
  }
});

// ── The guard ─────────────────────────────────────────────────────────
test('G4 the negative-stock guard is present and unconditional', () => {
  assert.match(LEDGER, /if \(next < 0\) \{/);
  assert.match(LEDGER, /throw insufficientStock\(/);
  assert.match(LEDGER, /Insufficient Stock/);
  assert.match(LEDGER, /Available: /);
  assert.match(LEDGER, /Required: /);
  // No escape hatch: an env flag or an option that lets it through would
  // make "negative stock is blocked" untrue without anything failing.
  assert.equal(/allowNegative|ALLOW_NEGATIVE|skipGuard/.test(LEDGER), false,
    'the guard must not be bypassable in Phase 1');
});

test('G5 stock cannot move without a movement context', () => {
  assert.match(LEDGER, /applyStockDelta requires a movement context/);
  assert.match(LEDGER, /Unknown stock movement type/);
  // and the row-lock that makes the guard sound is still there
  assert.match(LEDGER, /SELECT stock, unit, name FROM products WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
});

test('G6 the NULL sentinel still means "not stock-tracked"', () => {
  assert.match(LEDGER, /if \(!rows\.length \|\| rows\[0\]\.stock === null\) return null;/);
  assert.match(MIGRATION, /products\.stock IS NULL/);
  // and the summary honours it
  assert.match(STOCK_ROUTE, /p\.stock IS NOT NULL/);
});

// ── Direct writes ─────────────────────────────────────────────────────
test('G7 stock is readable but not writable through the generic router', () => {
  assert.match(GENERIC, /function refuseImmutable\(body, immutable, table\)/);
  assert.match(GENERIC, /immutable: \['stock'\]/);
  // both write verbs are covered
  const post = GENERIC.slice(GENERIC.indexOf("router.post('/'"), GENERIC.indexOf("router.patch('/'"));
  const patch = GENERIC.slice(GENERIC.indexOf("router.patch('/'"), GENERIC.indexOf("router.delete('/'"));
  assert.match(post, /refuseImmutable\(req\.body, immutable, table\)/);
  assert.match(patch, /refuseImmutable\(req\.body, immutable, table\)/);
  // ...and it is STILL in the column list, so reads/filters/order survive
  const products = GENERIC.slice(GENERIC.indexOf('  products: {'), GENERIC.indexOf('  import_mappings: {'));
  assert.match(products, /'source','stock',/);
  assert.match(products, /'reorder_level'/);
});

// ── Product Sync ──────────────────────────────────────────────────────
test('G8 Product Sync neither writes nor compares stock', () => {
  assert.equal(/PRODUCT_SYNC_COMPARE_FIELDS = \[[^\]]*'stock'/.test(SYNC), false,
    'stock must not be a sync comparison field');
  // the payload sent to the products table carries no stock key
  const payload = SYNC.slice(SYNC.indexOf('const payload = {'), SYNC.indexOf('if (match) {'));
  assert.equal(/\bstock:/.test(payload), false, 'the sync payload must not carry stock');
  // nothing anywhere in the client writes it either
  assert.equal(/stock:\s*(rp|raw)\./.test(SYNC), false);
  // and sync still syncs everything else it always did
  for (const f of ['name', 'sku', 'category', 'hsn_code', 'gst_percentage', 'unit',
    'default_rate', 'warranty', 'description', 'image_url']) {
    assert.match(SYNC, new RegExp(`PRODUCT_SYNC_COMPARE_FIELDS[^\\]]*'${f}'`, 's'),
      `${f} must still be compared`);
  }
});

// ── The four document flows ───────────────────────────────────────────
test('G9 every document flow writes a typed, traceable movement', () => {
  // sale
  assert.match(INVOICES, /type: 'SALE', sourceType: type, sourceId: invoiceId/);
  assert.match(INVOICES, /type: 'SALE', sourceType: type, sourceId: id, sourceItemId: it\.id/);
  // purchase and purchase return, through one generalised config
  assert.match(PURCHASES, /movementType: 'PURCHASE', sourceType: 'purchase'/);
  assert.match(PURCHASES, /movementType: 'PURCHASE_RETURN', sourceType: 'purchase_return'/);
  // sales return
  assert.match(RETURNS, /type: 'SALES_RETURN', sourceType: 'sales_return', sourceId: returnId/);
  assert.match(RETURNS, /type: 'SALES_RETURN', sourceType: 'sales_return', sourceId: id, sourceItemId: it\.id/);
});

test('G10 each flow still nets old against new rather than re-applying', () => {
  for (const [name, src] of [['invoices', INVOICES], ['purchases', PURCHASES], ['sales-returns', RETURNS]]) {
    assert.match(src, /const delta = \(newQtyByProduct\[pid\] \|\| 0\) - \(oldQtyByProduct\[pid\] \|\| 0\);/,
      `${name} must compute a net delta`);
    assert.match(src, /if \(delta\) await applyStockDelta\(/,
      `${name} must skip a zero delta entirely — that is what makes a repeated save write nothing`);
  }
});

test('G11 the stock helper is imported, never reimplemented', () => {
  assert.match(INVOICES, /require\('\.\.\/services\/stock-ledger'\)/);
  assert.match(PURCHASES, /require\('\.\/invoices'\)/);
  assert.match(RETURNS, /require\('\.\/invoices'\)/);
  // exactly one place performs the UPDATE
  const updates = (LEDGER.match(/UPDATE products SET stock/g) || []).length;
  assert.strictEqual(updates, 1, 'one choke point, in the service');
  for (const [name, src] of [['invoices', INVOICES], ['purchases', PURCHASES], ['sales-returns', RETURNS]]) {
    assert.equal(/UPDATE products SET stock/.test(src), false,
      `${name} must not write products.stock directly`);
  }
});

// ── Tenancy ───────────────────────────────────────────────────────────
test('G12 every stock query is scoped to the authenticated user', () => {
  assert.match(STOCK_ROUTE, /router\.use\(requireAuth\)/);
  // no query in the router may reference a tenant id taken from the body
  assert.equal(/body\.user_id|body\.tenant_id|body\.workshopId|query\.user_id/.test(STOCK_ROUTE), false,
    'tenancy comes from the JWT, never from the request');
  // Every query either carries a literal user_id filter or is built from a
  // `where` array — and every such array is SEEDED with the tenant filter
  // before any optional clause is pushed onto it, so a query cannot be
  // assembled without one.
  for (const seed of [`const where = ['p.user_id = $1', 'p.stock IS NOT NULL']`,
    `const where = ['m.user_id = $1']`]) {
    assert.ok(STOCK_ROUTE.includes(seed), 'where-clauses must start from the tenant: ' + seed);
  }
  // Nothing may push a user_id clause later (which would mean it was
  // optional), and req.userId is always the first bound parameter.
  assert.match(STOCK_ROUTE, /const params = \[req\.userId\]/);

  // Every hand-written statement that names a stock table filters on it.
  const literal = STOCK_ROUTE.match(/(SELECT|UPDATE)[\s\S]{0,500}?(FROM|SET)[\s\S]{0,500}?`/g) || [];
  const naming = literal.filter(s => /\b(products|stock_movements)\b/.test(s) && !/\$\{where/.test(s));
  assert.ok(naming.length >= 5, 'expected several direct statements to check');
  for (const s of naming) {
    assert.ok(/user_id\s*=\s*\$\d/.test(s),
      'a direct stock statement is missing its tenant filter:\n' + s.slice(0, 200));
  }
});

// ── Migration safety ──────────────────────────────────────────────────
test('G13 the migration is additive only', () => {
  const sql = MIGRATION
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const destructive of ['DROP ', 'TRUNCATE', 'DELETE FROM', 'UPDATE ']) {
    assert.equal(sql.toUpperCase().includes(destructive), false,
      `the migration must not contain ${destructive.trim()}`);
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS stock_movements/);
  assert.match(sql, /ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_level/);
  // re-runnable
  const creates = sql.match(/CREATE (TABLE|INDEX)[^\n]*/g) || [];
  for (const c of creates) assert.match(c, /IF NOT EXISTS/, 'every create must be idempotent: ' + c);
});

test('G14 the migration declares tenancy, keys, constraints and indexes', () => {
  assert.match(MIGRATION, /user_id UUID REFERENCES users\(id\) ON DELETE CASCADE NOT NULL/);
  assert.match(MIGRATION, /product_id UUID REFERENCES products\(id\) ON DELETE CASCADE NOT NULL/);
  assert.match(MIGRATION, /CHECK \(direction IN \('IN', 'OUT'\)\)/);
  assert.match(MIGRATION, /quantity DECIMAL\(15,3\) NOT NULL CHECK \(quantity > 0\)/);
  assert.match(MIGRATION, /balance_after DECIMAL\(15,3\) NOT NULL/);
  for (const idx of [
    'idx_stock_movements_user_product_created',
    'idx_stock_movements_user_created',
    'idx_stock_movements_user_type',
    'idx_stock_movements_source'
  ]) assert.match(MIGRATION, new RegExp(idx), `${idx} must exist`);
  // no RLS — this schema authorises in Express, and stock must not differ
  assert.equal(/ROW LEVEL SECURITY|CREATE POLICY/i.test(MIGRATION), false);
});

test('G15 the migration is registered in the manifest, last', () => {
  const manifest = JSON.parse(rd('server', 'db', 'migrations', '_manifest.json'));
  assert.strictEqual(manifest.order[manifest.order.length - 1], 'migration_stock_ledger.sql');
  assert.strictEqual(manifest.order.filter(f => f === 'migration_stock_ledger.sql').length, 1);
  // and no already-applied migration was edited
  assert.strictEqual(manifest.order.length, 28);
});

// ── No backfill ───────────────────────────────────────────────────────
test('G16 nothing fabricates history for stock that predates the ledger', () => {
  assert.equal(/INSERT INTO stock_movements/i.test(MIGRATION), false,
    'the migration must not invent movements');
  // the reconciliation reports the situation instead of hiding it
  assert.match(STOCK_ROUTE, /NO_LEDGER_HISTORY/);
  assert.match(STOCK_ROUTE, /UNRECONCILED/);
  assert.match(STOCK_ROUTE, /RECONCILED/);
});

// ── Reporting is server-side ──────────────────────────────────────────
test('G17 reports aggregate in SQL and page their results', () => {
  assert.match(STOCK_ROUTE, /COALESCE\(SUM\(\$\{SIGNED_QTY_SQL\}\), 0\) AS ledger_balance/);
  assert.match(STOCK_ROUTE, /function paging\(query\)/);
  assert.match(STOCK_ROUTE, /Math\.min\(Math\.max\(parseInt\(query\.limit, 10\) \|\| 100, 1\), 500\)/);
  // the status rule exists once, in SQL, so the summary and the low/out
  // reports cannot classify a product differently
  const statusUses = (STOCK_ROUTE.match(/STOCK_STATUS_SQL/g) || []).length;
  assert.ok(statusUses >= 4, 'the one status expression is reused, not retyped');
  assert.match(LEDGER, /WHEN p\.stock <= 0 THEN 'OUT_OF_STOCK'/);
  assert.match(LEDGER, /p\.reorder_level IS NOT NULL AND p\.stock <= p\.reorder_level THEN 'LOW_STOCK'/);
});

test('G18 rounding stays at three places, matching the column', () => {
  assert.strictEqual(round3(0.1 + 0.2), 0.3);
  assert.strictEqual(round3(1 / 3), 0.333);
  assert.strictEqual(round3(-2.0005), -2.001);
  assert.match(MIGRATION, /quantity DECIMAL\(15,3\)/);
});
