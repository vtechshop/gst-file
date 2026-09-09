// Stock ledger, against a real Postgres.
//
// These are integration tests on purpose. The three things most worth
// proving — that a rejected sale rolls the whole document back, that two
// concurrent sales of the last unit cannot both win, and that products.stock
// reconciles with the sum of its movements — are all properties of the
// database and its locks. A mocked client would prove none of them.
//
// They are skipped, loudly, when no scratch database is configured. Set
// STOCK_TEST_DATABASE_URL to a DISPOSABLE database: these tests create and
// drop their own rows and must never point at anything real.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('stock ledger integration (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

const { Client } = require('pg');
const {
  applyStockDelta, SIGNED_QTY_SQL, round3
} = require(path.join(__dirname, '..', 'src', 'services', 'stock-ledger'));

let db;                       // one connection for setup/teardown
let USER_A, USER_B;

async function q(sql, params) { return db.query(sql, params); }

async function mkUser(email) {
  const { rows } = await q(
    `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email]);
  return rows[0].id;
}
// Seeds a product with a starting quantity THROUGH the ledger, not by
// writing products.stock behind its back.
//
// Writing the column directly is what a pre-ledger database looks like:
// cached stock with no movements to explain it. Doing that here made two
// of these tests fail against correct code, because the ledger then
// genuinely disagreed with the balance — which is the very thing the
// reconciliation endpoint is built to notice. Opening the balance
// properly is both the honest fixture and the one the app itself uses.
async function mkProduct(userId, name, opts = {}) {
  const tracked = opts.stock !== null;
  const { rows } = await q(
    `INSERT INTO products (user_id, name, hsn_code, unit, gst_percentage, stock, reorder_level)
     VALUES ($1,$2,'84388090',$3,18,$4,$5) RETURNING id`,
    [userId, name, opts.unit || 'PCS',
      tracked ? 0 : null,
      opts.reorder === undefined ? null : opts.reorder]);
  const id = rows[0].id;
  const start = opts.stock === undefined ? 0 : opts.stock;
  if (tracked && start > 0) {
    await move(userId, id, start, { type: 'OPENING', sourceType: 'opening', reason: 'test fixture' });
  }
  return id;
}
async function stockOf(productId) {
  const { rows } = await q('SELECT stock FROM products WHERE id = $1', [productId]);
  return rows[0].stock === null ? null : +rows[0].stock;
}
async function ledgerSum(userId, productId) {
  const { rows } = await q(
    `SELECT COALESCE(SUM(${SIGNED_QTY_SQL}),0) s FROM stock_movements WHERE user_id=$1 AND product_id=$2`,
    [userId, productId]);
  return +rows[0].s;
}
async function movements(userId, productId) {
  const { rows } = await q(
    `SELECT movement_type, direction, quantity, balance_after FROM stock_movements
      WHERE user_id=$1 AND product_id=$2 ORDER BY created_at ASC, id ASC`, [userId, productId]);
  return rows;
}
// Run one applyStockDelta inside its own transaction, the way a route does.
async function move(userId, productId, delta, movement) {
  const c = new Client({ connectionString: SCRATCH });
  await c.connect();
  try {
    await c.query('BEGIN');
    const r = await applyStockDelta(c, userId, productId, delta, movement);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  USER_A = await mkUser(`stock-a-${Date.now()}@test.invalid`);
  USER_B = await mkUser(`stock-b-${Date.now()}@test.invalid`);
});

test.after(async () => {
  // Disposable data only: everything these tests made, and nothing else.
  await q('DELETE FROM stock_movements WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await q('DELETE FROM products WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await q('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
  await db.end();
});

// ── The mandatory sequence ────────────────────────────────────────────
test('S1 the mandatory numeric sequence reconciles at every step', async () => {
  const p = await mkProduct(USER_A, 'Sequence Machine', { stock: 0 });
  const steps = [
    ['OPENING',          +10, 10],
    ['PURCHASE',          +5, 15],
    ['SALE',              -3, 12],
    ['SALES_RETURN',      +1, 13],
    ['PURCHASE_RETURN',   -1, 12],
    ['DAMAGE',            -1, 11],
    ['ADJUSTMENT_IN',     +4, 15]
  ];
  for (const [type, delta, expected] of steps) {
    const after = await move(USER_A, p, delta, { type, reason: 'sequence' });
    assert.strictEqual(after, expected, `${type} ${delta} should leave ${expected}`);
    assert.strictEqual(await stockOf(p), expected, `${type}: products.stock`);
    assert.strictEqual(await ledgerSum(USER_A, p), expected, `${type}: ledger must reconcile`);
  }
  const rows = await movements(USER_A, p);
  assert.strictEqual(rows.length, 7, 'one movement per step');
  assert.deepStrictEqual(rows.map(r => r.movement_type), steps.map(s => s[0]));
  assert.deepStrictEqual(rows.map(r => r.direction), ['IN','IN','OUT','IN','OUT','OUT','IN']);
  // balance_after must trace the same path the balance actually took
  assert.deepStrictEqual(rows.map(r => +r.balance_after), steps.map(s => s[2]));
});

// ── Negative stock ────────────────────────────────────────────────────
test('S2 a sale beyond available stock is refused, and nothing is written', async () => {
  const p = await mkProduct(USER_A, 'Scarce Machine', { stock: 3 });
  await assert.rejects(
    () => move(USER_A, p, -5, { type: 'SALE', sourceType: 'b2b' }),
    (err) => {
      assert.match(err.message, /Insufficient Stock/);
      assert.match(err.message, /Available: 3 PCS/);
      assert.match(err.message, /Required: 5 PCS/);
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.expose, true);
      assert.strictEqual(err.code, 'insufficient_stock');
      return true;
    });
  assert.strictEqual(await stockOf(p), 3, 'stock must be untouched');
  const after = await movements(USER_A, p);
  assert.strictEqual(after.filter(m => m.movement_type === 'SALE').length, 0,
    'no SALE movement may survive a rejected sale');
  assert.strictEqual(await ledgerSum(USER_A, p), 3, 'and the ledger still reconciles');
});

test('S2b a sale of exactly the available stock succeeds and lands on zero', async () => {
  const p = await mkProduct(USER_A, 'Exact Machine', { stock: 3 });
  assert.strictEqual(await move(USER_A, p, -3, { type: 'SALE' }), 0);
  assert.strictEqual(await ledgerSum(USER_A, p), 0);
});

// ── The document flows, end to end, through the real routes' helper ───
test('S3 edit reconciles from old to new rather than re-applying', async () => {
  const p = await mkProduct(USER_A, 'Edited Machine', { stock: 0 });
  // purchase of 10, then edited to 15: the route computes new-old and
  // applies that, so the net effect is +15 and never +25.
  await move(USER_A, p, +10, { type: 'PURCHASE', sourceType: 'purchase' });
  assert.strictEqual(await stockOf(p), 10);
  await move(USER_A, p, +5, { type: 'PURCHASE', sourceType: 'purchase' });   // delta of the edit
  assert.strictEqual(await stockOf(p), 15, 'edit 10 -> 15 must net +15 total, not +25');
  assert.strictEqual(await ledgerSum(USER_A, p), 15);

  // a sale of 5 later edited to 8 costs 3 more, not 13
  await move(USER_A, p, -5, { type: 'SALE', sourceType: 'b2b' });
  assert.strictEqual(await stockOf(p), 10);
  await move(USER_A, p, -3, { type: 'SALE', sourceType: 'b2b' });
  assert.strictEqual(await stockOf(p), 7, 'sale 5 -> 8 must cost 3 more, not 13');
  assert.strictEqual(await ledgerSum(USER_A, p), 7);
});

test('S4 a delta of zero writes nothing at all', async () => {
  const p = await mkProduct(USER_A, 'Resaved Machine', { stock: 10 });
  const before = (await movements(USER_A, p)).length;
  assert.strictEqual(await move(USER_A, p, 0, { type: 'SALE' }), null);
  assert.strictEqual((await movements(USER_A, p)).length, before,
    'a re-save with no change must not write a movement');
  assert.strictEqual(await ledgerSum(USER_A, p), 10, 'and the balance still reconciles');
  assert.strictEqual(await stockOf(p), 10);
});

test('S5 a product that is not stock-tracked is never touched', async () => {
  const p = await mkProduct(USER_A, 'Service Item', { stock: null });
  assert.strictEqual(await move(USER_A, p, -99, { type: 'SALE' }), null);
  assert.strictEqual(await stockOf(p), null, 'the NULL sentinel must survive');
  assert.strictEqual((await movements(USER_A, p)).length, 0, 'and no movement is invented');
});

// ── Concurrency ───────────────────────────────────────────────────────
test('S6 two concurrent sales of the last unit: exactly one wins', async () => {
  const p = await mkProduct(USER_A, 'Last Unit Machine', { stock: 1 });

  // Two real connections, both holding an open transaction, so the row
  // lock is the only thing that can decide the winner.
  const run = async () => {
    const c = new Client({ connectionString: SCRATCH });
    await c.connect();
    try {
      await c.query('BEGIN');
      await applyStockDelta(c, USER_A, p, -1, { type: 'SALE', sourceType: 'b2b' });
      // Hold the lock long enough that the other transaction is certainly
      // waiting on it rather than merely running afterwards.
      await new Promise(r => setTimeout(r, 150));
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      return 'failed:' + (e.code || e.message);
    } finally { await c.end(); }
  };

  const [a, b] = await Promise.all([run(), run()]);
  const outcomes = [a, b].sort();
  assert.strictEqual(outcomes.filter(o => o === 'ok').length, 1,
    `exactly one sale must succeed, got ${JSON.stringify(outcomes)}`);
  assert.strictEqual(outcomes.filter(o => o.startsWith('failed')).length, 1);
  assert.match(outcomes.find(o => o.startsWith('failed')), /insufficient_stock/);

  assert.strictEqual(await stockOf(p), 0, 'final stock must be exactly 0');
  assert.ok((await stockOf(p)) >= 0, 'never negative');
  const rows = await movements(USER_A, p);
  assert.strictEqual(rows.filter(m => m.movement_type === 'SALE').length, 1,
    'exactly one SALE movement may be committed');
  assert.strictEqual(await ledgerSum(USER_A, p), 0, 'ledger reconciles to zero');
});

// ── Tenant isolation ──────────────────────────────────────────────────
test('S7 one tenant cannot move another tenant\'s stock', async () => {
  const p = await mkProduct(USER_A, 'Tenant A Machine', { stock: 10 });
  // B addresses A's product id directly. The helper's WHERE user_id
  // makes the row invisible, so nothing moves and nothing is recorded.
  assert.strictEqual(await move(USER_B, p, -5, { type: 'SALE' }), null);
  assert.strictEqual(await stockOf(p), 10, 'A\'s stock must be untouched');
  assert.strictEqual((await movements(USER_B, p)).length, 0, 'B records no movement');
  assert.strictEqual((await movements(USER_A, p)).filter(m => m.movement_type === 'SALE').length, 0,
    'and no sale appears under A either');
  assert.strictEqual(await ledgerSum(USER_A, p), 10, 'the other tenant ledger is untouched');
});

test('S8 every movement is attributable', async () => {
  const p = await mkProduct(USER_A, 'Audited Machine', { stock: 0 });
  const invoiceId = (await q('SELECT uuid_generate_v4() id')).rows[0].id;
  const itemId = (await q('SELECT uuid_generate_v4() id')).rows[0].id;
  await move(USER_A, p, +7, {
    type: 'PURCHASE', sourceType: 'purchase', sourceId: invoiceId,
    sourceItemId: itemId, unit: 'PCS', rate: 4200, reason: 'goods received'
  });
  const { rows } = await q(
    `SELECT * FROM stock_movements WHERE user_id=$1 AND product_id=$2`, [USER_A, p]);
  const m = rows[0];
  assert.strictEqual(m.user_id, USER_A);
  assert.strictEqual(m.created_by, USER_A, 'who');
  assert.ok(m.created_at, 'when');
  assert.strictEqual(m.product_id, p, 'what');
  assert.strictEqual(+m.quantity, 7, 'how much');
  assert.strictEqual(m.direction, 'IN');
  assert.strictEqual(m.reason, 'goods received', 'why');
  assert.strictEqual(m.source_type, 'purchase');
  assert.strictEqual(m.source_id, invoiceId, 'which document');
  assert.strictEqual(m.source_item_id, itemId, 'which line');
  assert.strictEqual(m.unit, 'PCS');
  assert.strictEqual(+m.rate, 4200);
  assert.strictEqual(+m.balance_after, 7);
});

test('S9 the database refuses a malformed movement even if code tried', async () => {
  const p = await mkProduct(USER_A, 'Constrained Machine', { stock: 0 });
  const ins = (type, dir, qty) => q(
    `INSERT INTO stock_movements (user_id,product_id,movement_type,direction,quantity,balance_after)
     VALUES ($1,$2,$3,$4,$5,0)`, [USER_A, p, type, dir, qty]);
  await assert.rejects(() => ins('TELEPORTED', 'IN', 1), /movement_type_check/,
    'a type outside the allow-list must be refused');
  // TRANSFER_IN and TRANSFER_OUT joined the allow-list in Phase 2, so a
  // transfer half is no longer refused for its name. It is refused for its
  // shape: half a transfer that names neither its other end nor the transfer
  // it belongs to is not a transfer, and the database says so.
  await assert.rejects(() => ins('TRANSFER_IN', 'IN', 1), /transfer_shape_check/,
    'a transfer half must carry its other end and its pairing id');
  await assert.rejects(() => ins('SALE', 'SIDEWAYS', 1), /direction_check/);
  await assert.rejects(() => ins('SALE', 'OUT', -1), /quantity_check/,
    'quantity is a magnitude; the sign lives in direction');
  await assert.rejects(() => ins('SALE', 'OUT', 0), /quantity_check/);
});

test('S10 a movement context is required — stock cannot move anonymously', async () => {
  const p = await mkProduct(USER_A, 'Anonymous Machine', { stock: 5 });
  await assert.rejects(
    () => move(USER_A, p, -1, undefined),
    /requires a movement context/);
  await assert.rejects(
    () => move(USER_A, p, -1, { type: 'NOT_A_TYPE' }),
    /Unknown stock movement type/);
  assert.strictEqual(await stockOf(p), 5, 'nothing moved');
});

test('S11 fractional quantities stay exact to three places', async () => {
  const p = await mkProduct(USER_A, 'Weighed Goods', { stock: 0, unit: 'KGS' });
  await move(USER_A, p, +0.1, { type: 'OPENING' });
  await move(USER_A, p, +0.2, { type: 'PURCHASE' });
  assert.strictEqual(await stockOf(p), 0.3, '0.1 + 0.2 must not drift');
  assert.strictEqual(await ledgerSum(USER_A, p), 0.3);
});
