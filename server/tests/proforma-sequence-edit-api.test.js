// Editing the Proforma "Next Number" counter, through the real HTTP surface
// and against a real database.
//
// The browser half, the pure rules and the wiring are in
// proforma-sequence-edit.test.js and always run. These are the questions only
// a database can answer, and they are the ones the feature actually rests on:
//
//   * does setting the counter to 169 make the next proforma PI-00169;
//   * is a counter that would REISSUE an already-issued number refused;
//   * is a lower but unused counter allowed;
//   * does issuing skip numbers that are occupied;
//   * can two saves arriving together both take the same number;
//   * are the invoice counters and every other document book left alone;
//   * do existing proforma rows come through untouched;
//   * does a refused save really write nothing.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('proforma sequence edit API (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-sequence-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function startServer(port) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: SCRATCH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(done); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

let server, base, db, USER, OTHER, TOKEN;
const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function req(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? { authorization: 'Bearer ' + TOKEN }
        : token ? { authorization: 'Bearer ' + token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}
const get = (url, token) => req('GET', url, undefined, token);
const post = (url, body, token) => req('POST', url, body, token);
// The server answers { error: { message, code, requestId } } - see
// middleware/errorHandler.js. Same helper every other *-api.test.js uses.
const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';

const SETTINGS = '/api/documents/proforma_invoice/number-settings';
const NEXT = '/api/documents/proforma_invoice/next-number';

// ── Fixtures ──────────────────────────────────────────────────────────

test.before(async () => {
  const port = await freePort();
  server = await startServer(port);
  base = 'http://127.0.0.1:' + port;
  db = new Client({ connectionString: SCRATCH });
  await db.connect();

  const mk = async (email) => {
    const u = await db.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    const id = u.rows[0].id;
    await db.query('INSERT INTO profiles (id, name) VALUES ($1, $2)', [id, email]);
    return id;
  };
  USER = await mk('seq-' + Date.now() + '@test.local');
  OTHER = await mk('seq-other-' + Date.now() + '@test.local');
  TOKEN = tok(USER);
});

test.after(async () => {
  if (db) await db.end();
  if (server) server.kill();
});

// Puts the book in a known state without going through the endpoint under
// test, so a test never depends on the thing it is checking.
async function seed(userId, { format, seq, numbers = [] } = {}) {
  await db.query(
    `UPDATE profiles SET
       document_series_formats   = COALESCE(document_series_formats, '{}'::jsonb)
                                   || jsonb_build_object('proforma_invoice', $2::text),
       document_series_sequences = COALESCE(document_series_sequences, '{}'::jsonb)
                                   || jsonb_build_object('proforma_invoice', $3::int)
     WHERE id = $1`, [userId, format || 'PI-#####', seq || 1]);
  for (const n of numbers) {
    await db.query(
      `INSERT INTO proforma_invoices
         (user_id, document_number, document_date, document_series, customer_name, total_amount)
       VALUES ($1, $2, CURRENT_DATE, 'proforma_invoice', 'Seeded', 100)`, [userId, n]);
  }
}
async function clearBook(userId) {
  await db.query('DELETE FROM proforma_invoices WHERE user_id = $1', [userId]);
}
const bookSeq = async (userId) => (await db.query(
  "SELECT (document_series_sequences->>'proforma_invoice')::int AS s FROM profiles WHERE id=$1",
  [userId])).rows[0].s;
const bookFormat = async (userId) => (await db.query(
  "SELECT document_series_formats->>'proforma_invoice' AS f FROM profiles WHERE id=$1",
  [userId])).rows[0].f;
const profileRow = async (userId) => (await db.query(
  'SELECT * FROM profiles WHERE id = $1', [userId])).rows[0];

// ═══ 1. Setting the counter ═══════════════════════════════════════════

test('A1 the counter can be moved from 5 to 169, and 169 is what gets issued', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 5 });

  const res = await post(SETTINGS, { format: 'PI-#####', seq: 169 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.seq, 169);
  assert.strictEqual(res.body.documentNumber, 'PI-00169');
  assert.strictEqual(await bookSeq(USER), 169, 'the stored counter must have moved');

  // The preview agrees, and so does the number the save actually issues.
  const preview = await get(NEXT);
  assert.strictEqual(preview.body.seq, 169);
  assert.strictEqual(preview.body.documentNumber, 'PI-00169');

  const saved = await post('/api/documents/proforma_invoice/save', {
    document: { document_number: '', document_date: '2026-10-31', customer_name: 'A', total_amount: 100 }
  });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const row = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
    [USER]);
  assert.strictEqual(row.rows[0].document_number, 'PI-00169',
    'the issued number must be the one the counter was set to');
  assert.strictEqual(await bookSeq(USER), 170, 'and the counter must advance past it');
});

test('A2 the format and the counter can be saved together', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 1 });

  const res = await post(SETTINGS, { format: 'QT/2026/###', seq: 42 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.documentNumber, 'QT/2026/042');
  assert.strictEqual(await bookFormat(USER), 'QT/2026/###');
  assert.strictEqual(await bookSeq(USER), 42);
});

test('A3 changing the counter alone leaves the format alone', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'QT/2026/###', seq: 10 });

  const res = await post(SETTINGS, { seq: 77 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(await bookFormat(USER), 'QT/2026/###', 'the format must not change');
  assert.strictEqual(await bookSeq(USER), 77);
  assert.strictEqual(res.body.documentNumber, 'QT/2026/077');
});

test('A4 changing the format alone leaves the counter alone', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'QT/2026/###', seq: 77 });

  const res = await post(SETTINGS, { format: 'PI-#####' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(await bookSeq(USER), 77, 'the counter must not move');
  assert.strictEqual(res.body.documentNumber, 'PI-00077');
});

test('A5 a lower but unused counter is accepted', async () => {
  await clearBook(USER);
  // The book has run to 500, but nothing below 498 was ever issued.
  await seed(USER, { format: 'PI-#####', seq: 501, numbers: ['PI-00498', 'PI-00499', 'PI-00500'] });

  const res = await post(SETTINGS, { seq: 120 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(await bookSeq(USER), 120, 'lowering onto an unused number is legitimate');
  assert.strictEqual((await get(NEXT)).body.documentNumber, 'PI-00120');
});

// ═══ 2. Duplicate protection ══════════════════════════════════════════

test('A6 a counter that would reissue an existing number is refused', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 4, numbers: ['PI-00001', 'PI-00002', 'PI-00003'] });

  const res = await post(SETTINGS, { seq: 2 });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.match(msg(res), /PI-00002/, 'the refusal must name the number in the way');
  assert.match(msg(res), /already been issued/);
  assert.match(msg(res), /\b4\b/, 'and the next free counter');

  // And nothing moved.
  assert.strictEqual(await bookSeq(USER), 4, 'the counter must be unchanged');
});

test('A7 a refused counter writes nothing - not even the format sent with it', async () => {
  await clearBook(USER);
  // The number seeded must be the one the format BEING SAVED would produce:
  // the conflict is judged against the request's format, not the stored one
  // (A8). Seeding PI-00002 while sending ZZ-##### is no conflict at all, and
  // the first version of this test wrongly expected one.
  await seed(USER, { format: 'PI-#####', seq: 4, numbers: ['ZZ-00002'] });
  const before = await profileRow(USER);

  const res = await post(SETTINGS, { format: 'ZZ-#####', seq: 2 });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));

  const after = await profileRow(USER);
  assert.deepStrictEqual(after.document_series_formats, before.document_series_formats,
    'the format must not have been written');
  assert.deepStrictEqual(after.document_series_sequences, before.document_series_sequences,
    'nor the counter');
});

test('A8 the conflict is judged against the format being saved', async () => {
  await clearBook(USER);
  // PI-00002 is taken; QT/2026/002 is not. The same counter is unsafe under
  // one format and safe under the other, which is why the check has to use
  // the format from the request rather than the one already stored.
  await seed(USER, { format: 'PI-#####', seq: 9, numbers: ['PI-00002'] });

  const refused = await post(SETTINGS, { format: 'PI-#####', seq: 2 });
  assert.strictEqual(refused.status, 409);

  const allowed = await post(SETTINGS, { format: 'QT/2026/###', seq: 2 });
  assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
  assert.strictEqual(allowed.body.documentNumber, 'QT/2026/002');
});

test('A9 case does not let a duplicate through', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 9, numbers: ['pi-00002'] });
  const res = await post(SETTINGS, { format: 'PI-#####', seq: 2 });
  assert.strictEqual(res.status, 409, 'a number differing only in case is still taken');
});

test('A10 another tenant\'s numbers are not conflicts', async () => {
  await clearBook(USER);
  await clearBook(OTHER);
  await seed(OTHER, { format: 'PI-#####', seq: 1, numbers: ['PI-00002'] });
  await seed(USER, { format: 'PI-#####', seq: 1 });

  const res = await post(SETTINGS, { seq: 2 });
  assert.strictEqual(res.status, 200, 'only this tenant\'s book may refuse a counter');
  assert.strictEqual(await bookSeq(USER), 2);
  await clearBook(OTHER);
});

test('A11 issuing skips numbers that are occupied', async () => {
  await clearBook(USER);
  // 5, 6 and 7 exist. The counter is legitimately set to 8 - but a number
  // typed by hand later could have filled 8 too, so the issue path must walk.
  await seed(USER, { format: 'PI-#####', seq: 8, numbers: ['PI-00005', 'PI-00006', 'PI-00007'] });

  // Someone types PI-00008 by hand on a quotation.
  const manual = await post('/api/documents/proforma_invoice/save', {
    document: { document_number: 'PI-00008', document_date: '2026-10-31', customer_name: 'B', total_amount: 50 }
  });
  assert.strictEqual(manual.status, 200, JSON.stringify(manual.body));

  // The next automatic one must not collide with it.
  const auto = await post('/api/documents/proforma_invoice/save', {
    document: { document_number: '', document_date: '2026-10-31', customer_name: 'C', total_amount: 50 }
  });
  assert.strictEqual(auto.status, 200, JSON.stringify(auto.body));
  const rows = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE user_id=$1 ORDER BY document_number', [USER]);
  const numbers = rows.rows.map(r => r.document_number);
  assert.ok(numbers.includes('PI-00009'), 'it must have skipped to PI-00009, got ' + numbers.join(','));
  assert.strictEqual(new Set(numbers).size, numbers.length, 'and no number may repeat');
});

test('A12 a counter pointing at a taken number still cannot issue a duplicate', async () => {
  await clearBook(USER);
  // The counter is forced to 2 behind the endpoint's back - the state a
  // database restored from an old backup could be in. The ISSUE path must
  // still refuse to hand out PI-00002 twice.
  await seed(USER, { format: 'PI-#####', seq: 2, numbers: ['PI-00002'] });

  const res = await post('/api/documents/proforma_invoice/save', {
    document: { document_number: '', document_date: '2026-10-31', customer_name: 'D', total_amount: 10 }
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const rows = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE user_id=$1', [USER]);
  const numbers = rows.rows.map(r => r.document_number);
  assert.strictEqual(numbers.filter(n => n === 'PI-00002').length, 1,
    'PI-00002 must exist exactly once');
  assert.ok(numbers.includes('PI-00003'), 'and the new one must be PI-00003');
});

// ═══ 3. Concurrency ═══════════════════════════════════════════════════

test('A13 two settings saves arriving together cannot both win silently', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 1 });

  const [a, b] = await Promise.all([
    post(SETTINGS, { seq: 300 }),
    post(SETTINGS, { seq: 400 })
  ]);
  // Both are legitimate on an empty book, so both may succeed - what must NOT
  // happen is a stored counter that is neither of them, or a torn write.
  assert.ok([200, 409].includes(a.status), 'unexpected ' + a.status);
  assert.ok([200, 409].includes(b.status), 'unexpected ' + b.status);
  const stored = await bookSeq(USER);
  assert.ok([300, 400].includes(stored), 'the counter must be one of the two, got ' + stored);
});

test('A14 two proforma saves arriving together take different numbers', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 50 });

  const mk = (name) => post('/api/documents/proforma_invoice/save', {
    document: { document_number: '', document_date: '2026-10-31', customer_name: name, total_amount: 10 }
  });
  const results = await Promise.all([mk('P1'), mk('P2'), mk('P3'), mk('P4')]);
  for (const r of results) assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const rows = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE user_id=$1', [USER]);
  const numbers = rows.rows.map(r => r.document_number);
  assert.strictEqual(numbers.length, 4);
  assert.strictEqual(new Set(numbers).size, 4,
    'four concurrent saves must take four distinct numbers, got ' + numbers.join(','));
});

test('A15 a settings save and a proforma save cannot interleave into a duplicate', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 60 });

  const [, saveRes] = await Promise.all([
    post(SETTINGS, { seq: 61 }),
    post('/api/documents/proforma_invoice/save', {
      document: { document_number: '', document_date: '2026-10-31', customer_name: 'E', total_amount: 10 }
    })
  ]);
  assert.strictEqual(saveRes.status, 200, JSON.stringify(saveRes.body));
  const rows = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE user_id=$1', [USER]);
  const numbers = rows.rows.map(r => r.document_number);
  assert.strictEqual(new Set(numbers).size, numbers.length, 'no number may repeat');
});

// ═══ 4. Invalid values ════════════════════════════════════════════════

test('A16 invalid counters are refused with 400, and change nothing', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 25 });

  for (const bad of ['', '   ', 0, -1, -169, '1.5', 1.5, '1e3', '169abc', 'abc',
    true, null, [], {}, 100000000]) {
    const res = await post(SETTINGS, { seq: bad });
    assert.strictEqual(res.status, 400,
      JSON.stringify(bad) + ' must be refused with 400, got ' + res.status);
    assert.strictEqual(await bookSeq(USER), 25,
      'the counter must be untouched after refusing ' + JSON.stringify(bad));
  }
  // A format that cannot issue a number is refused the same way.
  for (const bad of ['', 'PI-###/###', 'x'.repeat(41)]) {
    const res = await post(SETTINGS, { format: bad, seq: 30 });
    assert.strictEqual(res.status, 400, JSON.stringify(bad) + ' format must be refused');
    assert.strictEqual(await bookSeq(USER), 25, 'and the counter must not move');
  }
  // An empty payload has nothing to do, and says so.
  assert.strictEqual((await post(SETTINGS, {})).status, 400);
});

test('A17 the endpoint needs a real session and a known document type', async () => {
  assert.strictEqual((await post(SETTINGS, { seq: 5 }, null)).status, 401);
  assert.strictEqual((await post(SETTINGS, { seq: 5 }, 'not-a-token')).status, 401);
  const unknown = await post('/api/documents/not_a_document/number-settings', { seq: 5 });
  assert.strictEqual(unknown.status, 400, 'an unknown type must be refused, not guessed at');
});

test('A18 one tenant cannot move another tenant\'s counter', async () => {
  await seed(OTHER, { format: 'PI-#####', seq: 7 });
  const res = await post(SETTINGS, { seq: 999 }, tok(USER));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await bookSeq(OTHER), 7, 'the other tenant\'s book must be untouched');
});

// ═══ 5. Independence ══════════════════════════════════════════════════

test('A19 invoice formats and counters are untouched', async () => {
  await clearBook(USER);
  await db.query(
    `UPDATE profiles SET invoice_number_format = 'INV-###', invoice_current_sequence = 138,
       invoice_series_formats = '{"amazon":"A-#####"}'::jsonb,
       invoice_series_sequences = '{"amazon":12}'::jsonb
     WHERE id = $1`, [USER]);
  const before = await profileRow(USER);

  assert.strictEqual((await post(SETTINGS, { format: 'PI-#####', seq: 250 })).status, 200);

  const after = await profileRow(USER);
  assert.strictEqual(after.invoice_number_format, before.invoice_number_format);
  assert.strictEqual(after.invoice_current_sequence, before.invoice_current_sequence);
  assert.deepStrictEqual(after.invoice_series_formats, before.invoice_series_formats);
  assert.deepStrictEqual(after.invoice_series_sequences, before.invoice_series_sequences);
  assert.strictEqual(after.document_series_sequences.proforma_invoice, 250, 'and the book did move');
});

test('A20 every other document book keeps its own format and counter', async () => {
  await clearBook(USER);
  await db.query(
    `UPDATE profiles SET
       document_series_formats = '{"proforma_invoice":"PI-#####","purchase_order":"PO-#####","dc_job_work":"JW-###"}'::jsonb,
       document_series_sequences = '{"proforma_invoice":3,"purchase_order":88,"dc_job_work":9}'::jsonb
     WHERE id = $1`, [USER]);

  assert.strictEqual((await post(SETTINGS, { format: 'QT-####', seq: 400 })).status, 200);

  const row = await profileRow(USER);
  assert.deepStrictEqual(row.document_series_formats, {
    proforma_invoice: 'QT-####', purchase_order: 'PO-#####', dc_job_work: 'JW-###'
  }, 'only the proforma key may change');
  assert.deepStrictEqual(row.document_series_sequences, {
    proforma_invoice: 400, purchase_order: 88, dc_job_work: 9
  }, 'and only the proforma counter');
});

test('A21 the counter cannot be written through PATCH /profiles', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 30 });

  // The whole reason the endpoint above can be trusted: the unvalidated door
  // is shut, so a client cannot set a counter without the duplicate check.
  const res = await req('PATCH', '/api/profiles?eq_id=' + USER,
    { document_series_sequences: { proforma_invoice: 1 } });
  assert.strictEqual(res.status, 400, 'PATCH /profiles must refuse the counter');
  assert.match(msg(res), /document_series_sequences/);
  assert.strictEqual(await bookSeq(USER), 30, 'and it must be unchanged');

  // The format is still writable there, as it always was - it carries no
  // duplicate risk of its own.
  const fmt = await req('PATCH', '/api/profiles?eq_id=' + USER,
    { document_series_formats: { proforma_invoice: 'PI-#####' } });
  assert.strictEqual(fmt.status, 200, JSON.stringify(fmt.body));

  // And the column is still readable, or Settings could not show it.
  const read = await get('/api/profiles?eq_id=' + USER);
  assert.strictEqual(read.status, 200);
  assert.ok(read.body[0].document_series_sequences, 'the counter must still be readable');
});

// ═══ 6. Existing records ══════════════════════════════════════════════

test('A22 existing proforma rows are never renumbered or altered', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 4, numbers: ['PI-00001', 'PI-00002', 'PI-00003'] });
  const before = await db.query(
    'SELECT id, document_number, customer_name, total_amount, updated_at FROM proforma_invoices '
    + 'WHERE user_id=$1 ORDER BY document_number', [USER]);

  // A format change and a counter change, both accepted.
  assert.strictEqual((await post(SETTINGS, { format: 'QT/2026/###', seq: 900 })).status, 200);

  const after = await db.query(
    'SELECT id, document_number, customer_name, total_amount, updated_at FROM proforma_invoices '
    + 'WHERE user_id=$1 ORDER BY document_number', [USER]);
  assert.deepStrictEqual(after.rows, before.rows,
    'no stored proforma may be touched by a numbering change');
});

test('A23 the counter survives a round trip through the preview endpoint', async () => {
  await clearBook(USER);
  await seed(USER, { format: 'PI-#####', seq: 1 });

  assert.strictEqual((await post(SETTINGS, { format: 'PI-#####', seq: 169 })).status, 200);
  // Reading the preview must not consume or move anything, however often.
  for (let i = 0; i < 3; i++) {
    const p = await get(NEXT);
    assert.strictEqual(p.body.seq, 169);
    assert.strictEqual(p.body.documentNumber, 'PI-00169');
  }
  assert.strictEqual(await bookSeq(USER), 169);
});
