// The number-settings endpoint, actually executed.
//
// proforma-sequence-edit.test.js proves the rules and the wiring by reading
// them; proforma-sequence-edit-api.test.js proves the behaviour against a
// real database but is skipped unless STOCK_TEST_DATABASE_URL is set. That
// left the handler itself - the branch order, the status codes, the SQL it
// builds, what it writes and when it refuses - never once run.
//
// This file runs it, with the pool stubbed. Postgres is replaced by a fake
// client that answers the four statements the handler issues and records
// every one of them, so the test can assert not just the response but the
// exact SQL and parameters that would have reached the database, and that a
// refusal issues no UPDATE and does ROLLBACK.
//
// A stub is not a database: it cannot prove the UPDATE's jsonb merge really
// merges, or that FOR UPDATE really serializes. Those are the API file's job.
// What it does prove is that this code path executes, in the right order,
// with the right values - which no amount of reading the source can.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const net = require('net');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub/stub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-route-secret';

const jwt = require('jsonwebtoken');
const express = require('express');

// ── The stub, injected before documents.js is loaded ──────────────────
//
// routes/documents.js does `require('../config/pool')` at module load, so the
// stub has to be in the cache under that resolved path first. Nothing here
// touches the real pool module, and no connection is ever opened.
const POOL_PATH = require.resolve('../src/config/pool');

const LOG = [];            // every statement the handler issued
let BOOK;                  // what the fake profile row and book hold

function fakeClient() {
  return {
    async query(sql, params) {
      const text = String(typeof sql === 'string' ? sql : (sql && sql.text) || '');
      LOG.push({ sql: text.replace(/\s+/g, ' ').trim(), params: params || [] });

      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(text.trim())) return { rows: [], rowCount: 0 };

      if (/FROM profiles WHERE id = \$1 FOR UPDATE/.test(text)) {
        return BOOK.profileMissing
          ? { rows: [], rowCount: 0 }
          : { rows: [{ document_series_sequences: BOOK.sequences,
                       document_series_formats: BOOK.formats }], rowCount: 1 };
      }
      // Any book's table: the handler names it from the fixed registry, and
      // the stub answers whichever one it chose.
      if (/^SELECT \w+ AS document_number FROM \w+ WHERE user_id = \$1 AND document_series = \$2$/
          .test(text.trim())) {
        return { rows: BOOK.issued.map(n => ({ document_number: n })), rowCount: BOOK.issued.length };
      }
      if (/^UPDATE profiles SET/.test(text.trim())) return { rows: [], rowCount: 1 };

      throw new Error('the handler issued an unexpected statement: ' + text);
    },
    release() { this.released = true; }
  };
}

let RELEASED = 0;
require.cache[POOL_PATH] = {
  id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: {
    async connect() {
      const c = fakeClient();
      const release = c.release.bind(c);
      c.release = () => { RELEASED++; release(); };
      return c;
    },
    async query() { throw new Error('the handler must use a checked-out client, not pool.query'); },
    on() {}
  }
};

const documentsRouter = require('../src/routes/documents');
const { errorHandler } = require('../src/middleware/errorHandler');

// ── A real server, so the real middleware chain runs ──────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

let server, base;
const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN = jwt.sign({ sub: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });
const SETTINGS = '/api/documents/proforma_invoice/number-settings';

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/documents', documentsRouter);
  app.use(errorHandler);
  const port = await freePort();
  await new Promise((r) => { server = app.listen(port, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + port;
});
test.after(() => { if (server) server.close(); });

// Console noise: errorHandler logs every 4xx, which is correct of it and
// unhelpful here. Silenced per-test rather than globally.
function quiet(fn) {
  const real = console.error;
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => { console.error = real; });
}

async function call(body, { formats = {}, sequences = {}, issued = [], profileMissing = false } = {},
                   token = TOKEN, url = SETTINGS) {
  BOOK = { formats, sequences, issued, profileMissing };
  LOG.length = 0;
  const before = RELEASED;
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json, log: LOG.slice(), releasedHere: RELEASED - before };
}
const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';
const sqls = (r) => r.log.map(e => e.sql);
const did = (r, re) => r.log.some(e => re.test(e.sql));

// ═══ 1. The happy path, executed ══════════════════════════════════════

test('R1 setting the counter to 169 answers PI-00169 and writes it', async () => {
  const res = await call({ format: 'PI-#####', seq: 169 },
    { formats: { proforma_invoice: 'PI-#####' }, sequences: { proforma_invoice: 5 } });

  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body, {
    series: 'proforma_invoice', format: 'PI-#####', seq: 169, documentNumber: 'PI-00169'
  });

  // The statements, in order: lock, scan, write, commit.
  assert.deepStrictEqual(sqls(res).map(s => s.split(' ').slice(0, 2).join(' ')),
    ['BEGIN', 'SELECT document_series_sequences,', 'SELECT document_number', 'UPDATE profiles', 'COMMIT']);

  // The UPDATE carries this book's key and the two values, plus the user
  // from the JWT - and nothing from the request body.
  const upd = res.log.find(e => /^UPDATE profiles/.test(e.sql));
  assert.deepStrictEqual(upd.params, ['proforma_invoice', 'PI-#####', 169, USER]);
  assert.match(upd.sql, /document_series_formats = COALESCE\(document_series_formats, '\{\}'::jsonb\)/);
  assert.match(upd.sql, /document_series_sequences = COALESCE\(document_series_sequences, '\{\}'::jsonb\)/);
  assert.match(upd.sql, /jsonb_build_object\(\$1::text, \$2::text\)/);
  assert.match(upd.sql, /jsonb_build_object\(\$1::text, \$3::int\)/);
  assert.match(upd.sql, /WHERE id = \$4$/);
  assert.strictEqual(res.releasedHere, 1, 'the client must be released');
});

test('R2 the profile row is locked, and the book scanned under the lock', async () => {
  const res = await call({ seq: 7 }, { sequences: { proforma_invoice: 1 } });
  assert.strictEqual(res.status, 200);
  const order = sqls(res);
  const lockAt = order.findIndex(s => /FOR UPDATE/.test(s));
  const scanAt = order.findIndex(s => /FROM proforma_invoices/.test(s));
  const beginAt = order.findIndex(s => /^BEGIN/.test(s));
  assert.ok(beginAt === 0, 'BEGIN first');
  assert.ok(lockAt > beginAt, 'then the lock');
  assert.ok(scanAt > lockAt, 'then the scan - never before the lock');
  // Scoped to the tenant from the token and to this book alone.
  const scan = res.log.find(e => /FROM proforma_invoices/.test(e.sql));
  assert.deepStrictEqual(scan.params, [USER, 'proforma_invoice']);
  assert.match(scan.sql, /SELECT document_number AS document_number/);
});

test('R3 only the field sent is written', async () => {
  // Counter alone: the format column is not in the UPDATE at all.
  const seqOnly = await call({ seq: 55 },
    { formats: { proforma_invoice: 'QT/2026/###' }, sequences: { proforma_invoice: 10 } });
  assert.strictEqual(seqOnly.status, 200);
  assert.strictEqual(seqOnly.body.documentNumber, 'QT/2026/055',
    'it must format with the STORED format');
  const u1 = seqOnly.log.find(e => /^UPDATE profiles/.test(e.sql));
  assert.strictEqual(/document_series_formats/.test(u1.sql), false,
    'the format column must not be written');
  assert.deepStrictEqual(u1.params, ['proforma_invoice', 55, USER]);

  // Format alone: the counter column is not in the UPDATE at all.
  const fmtOnly = await call({ format: 'PI-#####' },
    { formats: { proforma_invoice: 'QT/2026/###' }, sequences: { proforma_invoice: 77 } });
  assert.strictEqual(fmtOnly.status, 200);
  assert.strictEqual(fmtOnly.body.seq, 77, 'the stored counter must come back unchanged');
  const u2 = fmtOnly.log.find(e => /^UPDATE profiles/.test(e.sql));
  assert.strictEqual(/document_series_sequences/.test(u2.sql), false,
    'the counter column must not be written');
  assert.deepStrictEqual(u2.params, ['proforma_invoice', 'PI-#####', USER]);
});

test('R4 an unconfigured book falls back to its default format', async () => {
  const res = await call({ seq: 3 }, { formats: {}, sequences: {} });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.format, 'PI-#####', 'the documented default for this book');
  assert.strictEqual(res.body.documentNumber, 'PI-00003');
});

// ═══ 2. The refusals, executed ════════════════════════════════════════

test('R5 a counter landing on an issued number is refused with 409, writing nothing', async () => {
  const res = await quiet(() => call({ seq: 2 },
    { formats: { proforma_invoice: 'PI-#####' }, sequences: { proforma_invoice: 4 },
      issued: ['PI-00001', 'PI-00002', 'PI-00003'] }));

  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.error.code, 'sequence_already_issued');
  assert.match(msg(res), /PI-00002/, 'it names the number in the way');
  assert.match(msg(res), /already been issued/);
  assert.match(msg(res), /next free number in this book is 4 \(PI-00004\)/,
    'and what would be accepted instead');
  assert.match(msg(res), /^Proforma /, 'in the book\'s own words');

  // Nothing written, and rolled back.
  assert.strictEqual(did(res, /^UPDATE profiles/), false, 'no UPDATE may be issued');
  assert.strictEqual(did(res, /^COMMIT/), false, 'and nothing committed');
  assert.ok(did(res, /^ROLLBACK/), 'the transaction must be rolled back');
  assert.strictEqual(res.releasedHere, 1, 'and the client released anyway');
});

test('R6 a refused counter does not write the format sent alongside it', async () => {
  const res = await quiet(() => call({ format: 'ZZ-#####', seq: 2 },
    { formats: { proforma_invoice: 'PI-#####' }, sequences: { proforma_invoice: 9 },
      issued: ['ZZ-00002'] }));
  assert.strictEqual(res.status, 409);
  assert.strictEqual(did(res, /^UPDATE profiles/), false,
    'one refusal must prevent BOTH writes');
  assert.ok(did(res, /^ROLLBACK/));
});

test('R7 the conflict is judged against the format in the request', async () => {
  const book = { formats: { proforma_invoice: 'PI-#####' }, sequences: { proforma_invoice: 9 },
                 issued: ['PI-00002'] };
  // Unsafe under PI-#####...
  assert.strictEqual((await quiet(() => call({ format: 'PI-#####', seq: 2 }, book))).status, 409);
  // ...and safe under a format whose 2 is a different number.
  const ok = await call({ format: 'QT/2026/###', seq: 2 }, book);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.documentNumber, 'QT/2026/002');
});

test('R8 case is not a way past the check', async () => {
  const res = await quiet(() => call({ format: 'PI-#####', seq: 2 },
    { sequences: { proforma_invoice: 9 }, issued: ['pi-00002'] }));
  assert.strictEqual(res.status, 409, 'a number differing only in case is still taken');
});

test('R9 an invalid counter is refused before the database is touched at all', async () => {
  for (const bad of ['', '   ', 0, -1, '1.5', 1.5, '1e3', '169abc', 'abc', true, null, [], {},
    100000000]) {
    const res = await quiet(() => call({ seq: bad }, { sequences: { proforma_invoice: 25 } }));
    assert.strictEqual(res.status, 400,
      JSON.stringify(bad) + ' must be refused with 400, got ' + res.status);
    assert.strictEqual(res.body.error.code, 'sequence_invalid',
      JSON.stringify(bad) + ' must be refused as an invalid sequence');
    assert.deepStrictEqual(res.log, [],
      JSON.stringify(bad) + ' must not reach the database - no BEGIN, no lock');
    assert.strictEqual(res.releasedHere, 0, 'and no client checked out');
  }
});

test('R10 an invalid format is refused the same way', async () => {
  for (const bad of ['', '   ', 'PI-###/###', 'x'.repeat(41), 'PI-\n###']) {
    const res = await quiet(() => call({ format: bad, seq: 5 }));
    assert.strictEqual(res.status, 400, JSON.stringify(bad) + ' must be refused');
    assert.strictEqual(res.body.error.code, 'number_format_invalid');
    assert.deepStrictEqual(res.log, [], 'and must not reach the database');
  }
  // The format is reported before the counter when both are wrong, matching
  // the browser's order so the two never disagree about what to fix first.
  const both = await quiet(() => call({ format: '', seq: 'abc' }));
  assert.strictEqual(both.body.error.code, 'number_format_invalid');
});

test('R11 a payload with nothing in it is refused rather than written', async () => {
  const res = await quiet(() => call({}));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, 'nothing_to_save');
  assert.deepStrictEqual(res.log, []);
});

test('R12 a missing profile is a 404, not a silent insert', async () => {
  const res = await quiet(() => call({ seq: 5 }, { profileMissing: true }));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error.code, 'profile_not_found');
  assert.strictEqual(did(res, /^UPDATE profiles/), false);
  assert.ok(did(res, /^ROLLBACK/));
});

test('R13 an unknown document type is refused, and names no table', async () => {
  const res = await quiet(() => call({ seq: 5 }, {}, TOKEN,
    '/api/documents/not_a_document/number-settings'));
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(res.log, [], 'nothing may be queried for a type with no book');
  assert.strictEqual(/proforma_invoices|profiles/.test(msg(res)), false,
    'the refusal must not leak a table name');
});

test('R14 no session, no save', async () => {
  for (const token of [null, 'not-a-token']) {
    const res = await quiet(() => call({ seq: 5 }, {}, token));
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(res.log, []);
  }
});

// ═══ 3. The tenant ════════════════════════════════════════════════════

test('R15 the tenant comes from the token, never from the body', async () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const res = await call({ seq: 11, user_id: OTHER, id: OTHER },
    { sequences: { proforma_invoice: 1 } });
  assert.strictEqual(res.status, 200);
  for (const e of res.log) {
    assert.strictEqual(e.params.includes(OTHER), false,
      'a user id from the body must never reach SQL: ' + e.sql);
  }
  const upd = res.log.find(e => /^UPDATE profiles/.test(e.sql));
  assert.ok(upd.params.includes(USER), 'the token\'s user is the only one used');
});

// ═══ 4. The other books this endpoint also serves ═════════════════════

test('R16 the same endpoint numbers another book without crossing into it', async () => {
  // The route is generic over the registry, so a purchase order's book is
  // reachable too - and must use ITS table, ITS series and ITS default.
  BOOK = { formats: {}, sequences: {}, issued: [] };
  LOG.length = 0;
  const res = await fetch(base + '/api/documents/purchase_order/number-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ seq: 88 })
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.series, 'purchase_order');
  assert.strictEqual(body.format, 'PO-#####', 'the purchase order default, not the proforma one');
  assert.strictEqual(body.documentNumber, 'PO-00088');
  const scan = LOG.find(e => /FROM purchase_orders/.test(e.sql));
  assert.ok(scan, 'it must scan the purchase order table');
  assert.deepStrictEqual(scan.params, [USER, 'purchase_order']);
  const upd = LOG.find(e => /^UPDATE profiles/.test(e.sql));
  assert.strictEqual(upd.params[0], 'purchase_order', 'and write only that book\'s key');
});

test('R17 a book whose number column is not document_number still works', async () => {
  // The warranty register calls its column warranty_number, and the name
  // comes from the fixed spec rather than from anything the client sent.
  BOOK = { formats: {}, sequences: {}, issued: [] };
  LOG.length = 0;
  const res = await fetch(base + '/api/documents/warranty/number-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ seq: 4, numberCol: 'injected' })
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.documentNumber, 'WAR-00004');
  const scan = LOG.find(e => /FROM warranties/.test(e.sql));
  assert.match(scan.sql, /SELECT warranty_number AS document_number/,
    'the column must come from the spec');
  assert.strictEqual(/injected/.test(JSON.stringify(LOG)), false,
    'and never from the request');
});
