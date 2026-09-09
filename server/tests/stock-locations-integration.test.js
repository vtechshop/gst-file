// Locations, per-location balances and transfers, against real Postgres.
//
// The two things only a real database can prove are here: that two
// simultaneous transfers of the last unit cannot both win, and that a
// transfer A->B racing a transfer B->A does not deadlock. Both depend on
// row locks taken in an agreed order, which a mock cannot demonstrate.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('stock locations integration (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}

const { Client } = require('pg');
const {
  applyStockDelta, transferStock, SIGNED_QTY_SQL, round3
} = require(path.join(__dirname, '..', 'src', 'services', 'stock-ledger'));

let db, USER_A, USER_B, MAIN, SHOWROOM, WORKSHOP, B_MAIN;

const q = (sql, p) => db.query(sql, p);

async function mkUser(email) {
  const { rows } = await q(`INSERT INTO users (email,password_hash) VALUES ($1,'x') RETURNING id`, [email]);
  return rows[0].id;
}
async function mkLocation(userId, name, code, isDefault) {
  const { rows } = await q(
    `INSERT INTO stock_locations (user_id,name,code,is_default,active) VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
    [userId, name, code, !!isDefault]);
  return rows[0].id;
}
async function mkProduct(userId, name) {
  const { rows } = await q(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock,reorder_level)
     VALUES ($1,$2,'84388090','PCS',18,0,NULL) RETURNING id`, [userId, name]);
  return rows[0].id;
}
// One movement in its own transaction, the way a route does it.
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
async function transfer(userId, opts) {
  const c = new Client({ connectionString: SCRATCH });
  await c.connect();
  try {
    await c.query('BEGIN');
    const r = await transferStock(c, userId, opts);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
}
const total = async (productId) => {
  const { rows } = await q('SELECT stock FROM products WHERE id=$1', [productId]);
  return rows[0].stock === null ? null : +rows[0].stock;
};
const at = async (productId, locationId) => {
  const { rows } = await q(
    'SELECT quantity FROM stock_balances WHERE product_id=$1 AND location_id=$2', [productId, locationId]);
  return rows.length ? +rows[0].quantity : 0;
};
const balanceSum = async (productId) => {
  const { rows } = await q(
    'SELECT COALESCE(SUM(quantity),0) s FROM stock_balances WHERE product_id=$1', [productId]);
  return +rows[0].s;
};
const newId = async () => (await q('SELECT uuid_generate_v4() id')).rows[0].id;
const ledgerSum = async (productId) => {
  const { rows } = await q(
    `SELECT COALESCE(SUM(${SIGNED_QTY_SQL}),0) s FROM stock_movements WHERE product_id=$1`, [productId]);
  return +rows[0].s;
};

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  USER_A = await mkUser(`loc-a-${Date.now()}@test.invalid`);
  USER_B = await mkUser(`loc-b-${Date.now()}@test.invalid`);
  MAIN = await mkLocation(USER_A, 'Main Warehouse', 'MAIN', true);
  SHOWROOM = await mkLocation(USER_A, 'Showroom', 'SHOW', false);
  WORKSHOP = await mkLocation(USER_A, 'Workshop', 'WORK', false);
  B_MAIN = await mkLocation(USER_B, 'Tenant B Warehouse', 'BMAIN', true);
});

test.after(async () => {
  await q('DELETE FROM stock_movements WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await q('DELETE FROM stock_balances WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await q('DELETE FROM products WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await q('DELETE FROM stock_locations WHERE user_id = ANY($1)', [[USER_A, USER_B]]);
  await q('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
  await db.end();
});

// ── Location constraints ──────────────────────────────────────────────
test('L1 a tenant may have exactly one default location', async () => {
  await assert.rejects(
    () => q(`INSERT INTO stock_locations (user_id,name,is_default) VALUES ($1,'Second Default',TRUE)`, [USER_A]),
    /uq_stock_locations_one_default/,
    'the database must refuse a second default, not merely the API');
  // ...and another tenant's default is unaffected
  const { rows } = await q('SELECT COUNT(*)::int n FROM stock_locations WHERE user_id=$1 AND is_default', [USER_B]);
  assert.strictEqual(rows[0].n, 1);
});

test('L2 location codes are unique per tenant, case-insensitively', async () => {
  await assert.rejects(
    () => q(`INSERT INTO stock_locations (user_id,name,code) VALUES ($1,'Duplicate','main')`, [USER_A]),
    /uq_stock_locations_user_code/);
  // the same code under a DIFFERENT tenant is fine
  const okRow = await q(`INSERT INTO stock_locations (user_id,name,code) VALUES ($1,'B Main','MAIN') RETURNING id`, [USER_B]);
  assert.ok(okRow.rows[0].id);
  await q('DELETE FROM stock_locations WHERE id=$1', [okRow.rows[0].id]);
});

test('L3 a location holding stock cannot be deleted', async () => {
  const p = await mkProduct(USER_A, 'Held Product');
  await move(USER_A, p, 5, { type: 'OPENING', locationId: SHOWROOM });
  await assert.rejects(
    () => q('DELETE FROM stock_locations WHERE id=$1', [SHOWROOM]),
    /violates foreign key constraint/,
    'ON DELETE RESTRICT must make this a database rule');
  await move(USER_A, p, -5, { type: 'ADJUSTMENT_OUT', locationId: SHOWROOM, reason: 'cleanup' });
});

// ── The mandatory location sequence ───────────────────────────────────
test('L4 the approved location walkthrough', async () => {
  const p = await mkProduct(USER_A, 'Walkthrough Machine');

  // opening 10 at Main
  await move(USER_A, p, 10, { type: 'OPENING', locationId: MAIN });
  assert.strictEqual(await at(p, MAIN), 10);
  assert.strictEqual(await at(p, SHOWROOM), 0);
  assert.strictEqual(await total(p), 10, 'company total');

  // purchase +5 at Main
  await move(USER_A, p, 5, { type: 'PURCHASE', locationId: MAIN, sourceType: 'purchase' });
  assert.strictEqual(await at(p, MAIN), 15);
  assert.strictEqual(await total(p), 15);

  // sale 3 from Main
  await move(USER_A, p, -3, { type: 'SALE', locationId: MAIN, sourceType: 'b2b' });
  assert.strictEqual(await at(p, MAIN), 12);
  assert.strictEqual(await total(p), 12);

  // transfer 5 Main -> Showroom: the company total must NOT change
  const before = await total(p);
  await transfer(USER_A, {
    productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM,
    quantity: 5, transferId: await newId(),
    reason: 'stock the showroom'
  });
  assert.strictEqual(await at(p, MAIN), 7);
  assert.strictEqual(await at(p, SHOWROOM), 5);
  assert.strictEqual(await total(p), before, 'a transfer moves stock, it does not create or destroy it');
  assert.strictEqual(await total(p), 12);

  // sales return +1, purchase return -1, adjustment +4
  await move(USER_A, p, 1, { type: 'SALES_RETURN', locationId: MAIN, sourceType: 'sales_return' });
  assert.strictEqual(await total(p), 13);
  await move(USER_A, p, -1, { type: 'PURCHASE_RETURN', locationId: MAIN, sourceType: 'purchase_return' });
  assert.strictEqual(await total(p), 12);
  await move(USER_A, p, 4, { type: 'ADJUSTMENT_IN', locationId: MAIN, reason: 'found' });
  assert.strictEqual(await total(p), 16);

  // everything reconciles three ways
  assert.strictEqual(await balanceSum(p), 16, 'location balances sum to the company total');
  assert.strictEqual(await ledgerSum(p), 16, 'and the ledger agrees with both');
  assert.strictEqual(await at(p, MAIN), 11);
  assert.strictEqual(await at(p, SHOWROOM), 5);
});

// ── Negative stock, per location ──────────────────────────────────────
test('L5 a location cannot sell stock that is in another location', async () => {
  const p = await mkProduct(USER_A, 'Split Machine');
  await move(USER_A, p, 3, { type: 'OPENING', locationId: MAIN });
  await transfer(USER_A, {
    productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM, quantity: 3,
    transferId: await newId() });
  assert.strictEqual(await at(p, MAIN), 0);
  assert.strictEqual(await at(p, SHOWROOM), 3);
  assert.strictEqual(await total(p), 3, 'the company still has 3');

  // the company has 3, but Main has none — the sale must still fail
  await assert.rejects(
    () => move(USER_A, p, -1, { type: 'SALE', locationId: MAIN, sourceType: 'b2b' }),
    (e) => { assert.match(e.message, /Insufficient Stock/); assert.match(e.message, /Available: 0/); return true; },
    'checking only the company total would let a showroom sell warehouse stock');
  assert.strictEqual(await total(p), 3, 'nothing moved');
  assert.strictEqual(await at(p, SHOWROOM), 3);
});

test('L6 a transfer beyond the source balance is refused entirely', async () => {
  const p = await mkProduct(USER_A, 'Short Transfer');
  await move(USER_A, p, 2, { type: 'OPENING', locationId: MAIN });
  const tooMuch = await newId();
  await assert.rejects(
    () => transfer(USER_A, {
      productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM, quantity: 5,
      transferId: tooMuch }),
    /Insufficient Stock/);
  assert.strictEqual(await at(p, MAIN), 2, 'source untouched');
  assert.strictEqual(await at(p, SHOWROOM), 0, 'destination untouched');
  const { rows } = await q(
    "SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1 AND movement_type LIKE 'TRANSFER%'", [p]);
  assert.strictEqual(rows[0].n, 0, 'and neither half was written');
});

test('L7 a transfer to the same location is refused', async () => {
  const p = await mkProduct(USER_A, 'Self Transfer');
  await move(USER_A, p, 5, { type: 'OPENING', locationId: MAIN });
  const sameId = await newId(), zeroId = await newId();
  await assert.rejects(
    () => transfer(USER_A, {
      productId: p, fromLocationId: MAIN, toLocationId: MAIN, quantity: 1,
      transferId: sameId }),
    /different locations/);
  await assert.rejects(
    () => transfer(USER_A, {
      productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM, quantity: 0,
      transferId: zeroId }),
    /greater than zero/);
});

// ── Idempotency ───────────────────────────────────────────────────────
test('L8 a repeated transfer reference cannot move the stock twice', async () => {
  const p = await mkProduct(USER_A, 'Retried Transfer');
  await move(USER_A, p, 10, { type: 'OPENING', locationId: MAIN });
  const ref = await newId();

  await transfer(USER_A, { productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM, quantity: 4, transferId: ref });
  assert.strictEqual(await at(p, MAIN), 6);
  assert.strictEqual(await at(p, SHOWROOM), 4);

  // the same reference again — the unique index refuses it
  await assert.rejects(
    () => transfer(USER_A, { productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM, quantity: 4, transferId: ref }),
    (e) => { assert.strictEqual(e.code, '23505'); return true; },
    'a retry must collide in the database, not depend on the browser');
  assert.strictEqual(await at(p, MAIN), 6, 'stock did not move a second time');
  assert.strictEqual(await at(p, SHOWROOM), 4);
  const { rows } = await q(
    "SELECT COUNT(*)::int n FROM stock_movements WHERE transfer_id=$1", [ref]);
  assert.strictEqual(rows[0].n, 2, 'exactly one pair of movements exists');
});

// ── Concurrency ───────────────────────────────────────────────────────
test('L9 two simultaneous transfers of the last unit: exactly one wins', async () => {
  const p = await mkProduct(USER_A, 'Last Unit Transfer');
  await move(USER_A, p, 1, { type: 'OPENING', locationId: MAIN });

  const run = async () => {
    const c = new Client({ connectionString: SCRATCH });
    await c.connect();
    try {
      await c.query('BEGIN');
      await transferStock(c, USER_A, {
        productId: p, fromLocationId: MAIN, toLocationId: SHOWROOM, quantity: 1,
        transferId: (await c.query('SELECT uuid_generate_v4() id')).rows[0].id });
      await new Promise(r => setTimeout(r, 150));
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      return 'failed:' + (e.code || e.message.split('\n')[0]);
    } finally { await c.end(); }
  };

  const out = await Promise.all([run(), run()]);
  assert.strictEqual(out.filter(o => o === 'ok').length, 1,
    `exactly one transfer must succeed, got ${JSON.stringify(out)}`);
  assert.strictEqual(await at(p, MAIN), 0, 'source ends at 0');
  assert.strictEqual(await at(p, SHOWROOM), 1, 'destination ends at 1');
  assert.strictEqual(await total(p), 1, 'company total unchanged');
  const { rows } = await q(
    "SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1 AND movement_type LIKE 'TRANSFER%'", [p]);
  assert.strictEqual(rows[0].n, 2, 'one pair only — no duplicate movement');
});

test('L10 opposing transfers A->B and B->A do not deadlock', async () => {
  // Two DIFFERENT products, so the product row lock cannot serialise them
  // and the balance-lock ordering is the only thing preventing a deadlock.
  const p1 = await mkProduct(USER_A, 'Opposing One');
  const p2 = await mkProduct(USER_A, 'Opposing Two');
  await move(USER_A, p1, 10, { type: 'OPENING', locationId: MAIN });
  await move(USER_A, p2, 10, { type: 'OPENING', locationId: SHOWROOM });

  const run = async (product, from, to) => {
    const c = new Client({ connectionString: SCRATCH });
    await c.connect();
    try {
      await c.query('BEGIN');
      await transferStock(c, USER_A, {
        productId: product, fromLocationId: from, toLocationId: to, quantity: 2,
        transferId: (await c.query('SELECT uuid_generate_v4() id')).rows[0].id });
      await new Promise(r => setTimeout(r, 200));   // hold both locks
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      return 'failed:' + (e.code || e.message.split('\n')[0]);
    } finally { await c.end(); }
  };

  const out = await Promise.all([
    run(p1, MAIN, SHOWROOM),
    run(p2, SHOWROOM, MAIN)
  ]);
  assert.deepStrictEqual(out, ['ok', 'ok'],
    `both opposing transfers must complete; a deadlock would show as 40P01: ${JSON.stringify(out)}`);
  assert.ok(!out.some(o => /40P01/.test(o)), 'no deadlock detected');
  assert.strictEqual(await at(p1, MAIN), 8);
  assert.strictEqual(await at(p1, SHOWROOM), 2);
  assert.strictEqual(await at(p2, SHOWROOM), 8);
  assert.strictEqual(await at(p2, MAIN), 2);
});

test('L11 three-way concurrent transfers stay consistent', async () => {
  const p = await mkProduct(USER_A, 'Three Way');
  await move(USER_A, p, 30, { type: 'OPENING', locationId: MAIN });
  const one = (from, to, qty) => (async () => {
    const c = new Client({ connectionString: SCRATCH });
    await c.connect();
    try {
      await c.query('BEGIN');
      await transferStock(c, USER_A, { productId: p, fromLocationId: from, toLocationId: to,
        quantity: qty, transferId: (await c.query('SELECT uuid_generate_v4() id')).rows[0].id });
      await c.query('COMMIT'); return 'ok';
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); return 'failed:' + (e.code || e.message); }
    finally { await c.end(); }
  })();
  const out = await Promise.all([one(MAIN, SHOWROOM, 5), one(MAIN, WORKSHOP, 5), one(MAIN, SHOWROOM, 5)]);
  assert.ok(!out.some(o => /40P01/.test(o)), 'no deadlock: ' + JSON.stringify(out));
  assert.strictEqual(await total(p), 30, 'company total is never changed by transfers');
  assert.strictEqual(await balanceSum(p), 30, 'and the balances still add up to it');
});

// ── Tenancy ───────────────────────────────────────────────────────────
test('L12 one tenant cannot transfer into or out of another tenant location', async () => {
  const p = await mkProduct(USER_A, 'Tenant Guard');
  await move(USER_A, p, 5, { type: 'OPENING', locationId: MAIN });

  // B's location is not A's to send to
  const crossId = await newId();
  await assert.rejects(
    () => transfer(USER_A, { productId: p, fromLocationId: MAIN, toLocationId: B_MAIN, quantity: 1,
      transferId: crossId }),
    /does not exist or is not active/);

  // and B cannot move A's product at all
  const crossId2 = await newId();
  await assert.rejects(
    () => transfer(USER_B, { productId: p, fromLocationId: B_MAIN, toLocationId: B_MAIN, quantity: 1,
      transferId: crossId2 }),
    /different locations|Product not found/);
  assert.strictEqual(await at(p, MAIN), 5, 'A stock untouched');
  assert.strictEqual(await total(p), 5);
});

// ── Backward compatibility ────────────────────────────────────────────
test('L13 a tenant with no locations keeps Phase 1 behaviour exactly', async () => {
  const noLoc = await mkUser(`noloc-${Date.now()}@test.invalid`);
  const p = (await q(
    `INSERT INTO products (user_id,name,unit,gst_percentage,stock) VALUES ($1,'Legacy Flow','PCS',18,0) RETURNING id`,
    [noLoc])).rows[0].id;
  await move(noLoc, p, 7, { type: 'OPENING' });
  assert.strictEqual(await total(p), 7, 'products.stock still moves');
  const { rows } = await q('SELECT location_id FROM stock_movements WHERE product_id=$1', [p]);
  assert.strictEqual(rows[0].location_id, null, 'and the movement records no location');
  assert.strictEqual(await balanceSum(p), 0, 'no balance rows are invented');

  await q('DELETE FROM stock_movements WHERE user_id=$1', [noLoc]);
  await q('DELETE FROM products WHERE user_id=$1', [noLoc]);
  await q('DELETE FROM users WHERE id=$1', [noLoc]);
});

// ── Schema guarantees ─────────────────────────────────────────────────
test('L14 the database refuses a malformed transfer row', async () => {
  const p = await mkProduct(USER_A, 'Constraint Check');
  const ins = (type, to, tid) => q(
    `INSERT INTO stock_movements (user_id,product_id,movement_type,direction,quantity,balance_after,location_id,to_location_id,transfer_id)
     VALUES ($1,$2,$3,'OUT',1,0,$4,$5,$6)`, [USER_A, p, type, MAIN, to, tid]);
  const uuid = await newId();
  await assert.rejects(() => ins('TRANSFER_OUT', null, uuid), /transfer_shape_check/,
    'a transfer must name its other end');
  await assert.rejects(() => ins('TRANSFER_OUT', SHOWROOM, null), /transfer_shape_check/,
    'a transfer must carry its reference');
  await assert.rejects(() => ins('SALE', SHOWROOM, uuid), /transfer_shape_check/,
    'nothing but a transfer may claim a destination');
  await assert.rejects(
    () => q(`INSERT INTO stock_balances (user_id,product_id,location_id,quantity) VALUES ($1,$2,$3,-1)`,
      [USER_A, p, WORKSHOP]),
    /quantity_check|violates check constraint/,
    'a balance may never be negative');
});

test('L15 both transfer types are accepted by the widened CHECK', async () => {
  const p = await mkProduct(USER_A, 'Type Check');
  await move(USER_A, p, 1, { type: 'OPENING', locationId: MAIN });
  const ref = await newId();
  await transfer(USER_A, { productId: p, fromLocationId: MAIN, toLocationId: WORKSHOP, quantity: 1, transferId: ref });
  const { rows } = await q(
    'SELECT movement_type, direction, location_id, to_location_id FROM stock_movements WHERE transfer_id=$1 ORDER BY movement_type',
    [ref]);
  assert.deepStrictEqual(rows.map(r => r.movement_type), ['TRANSFER_IN', 'TRANSFER_OUT']);
  const out = rows.find(r => r.movement_type === 'TRANSFER_OUT');
  const inn = rows.find(r => r.movement_type === 'TRANSFER_IN');
  assert.strictEqual(out.direction, 'OUT');
  assert.strictEqual(inn.direction, 'IN');
  assert.strictEqual(out.location_id, MAIN);
  assert.strictEqual(out.to_location_id, WORKSHOP, 'the OUT half names where it went');
  assert.strictEqual(inn.location_id, WORKSHOP);
  assert.strictEqual(inn.to_location_id, MAIN, 'the IN half names where it came from');
});
