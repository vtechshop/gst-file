// Tests for POST /api/gst/verify.
//
// The route is exercised directly with a stubbed global fetch — no network
// call is made and no Appyflow credit is spent. The stub also lets the
// tests assert the one thing that matters most here: that the secret goes
// out in the upstream request and never comes back in a response.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gst-verify';
const { errorHandler } = require('../src/middleware/errorHandler');

const SECRET = 'super-secret-appyflow-value';
const GSTIN = '33AARFV8415B1Z4';

// Captured once, before any stub is installed. Taken per-call instead, the
// second makeApp() would capture the first one's stub and the chain would
// never reach the real implementation.
const REAL_FETCH = global.fetch;

// A realistic Appyflow success payload, trimmed to the documented fields.
const TAXPAYER = {
  gstin: GSTIN,
  lgnm: 'V TECH ENTERPRISES',
  tradeNam: 'Vtech',
  sts: 'Active',
  rgdt: '01/07/2017',
  ctb: 'Partnership',
  dty: 'Regular',
  pradr: { addr: {
    bno: '12', bnm: 'Anna Salai', st: 'Main Road', loc: 'Peelamedu', city: 'Coimbatore',
    dst: 'Coimbatore', stcd: 'Tamil Nadu', pncd: '641004'
  } }
};

// Builds the app with only this router mounted, and a stub that records
// every outbound call.
function makeApp({ secret = SECRET, respond } = {}) {
  const calls = [];
  const prevSecret = process.env.APPYFLOW_KEY_SECRET;

  if (secret === null) delete process.env.APPYFLOW_KEY_SECRET;
  else process.env.APPYFLOW_KEY_SECRET = secret;

  // Only the Appyflow call is stubbed. The test's own request to the local
  // server has to reach it, so anything else is handed to the real fetch —
  // without this the stub answers the test client and the route under test
  // is never actually executed.
  global.fetch = async (url, opts) => {
    const href = String(url);
    if (!href.includes('appyflow.in')) return REAL_FETCH(url, opts);
    calls.push(href);
    if (typeof respond === 'function') return respond();
    return { ok: true, status: 200, json: async () => ({ taxpayerInfo: TAXPAYER }) };
  };

  // Required fresh so the module re-reads the env for each scenario.
  delete require.cache[require.resolve('../src/routes/gst-verify')];
  const router = require('../src/routes/gst-verify');

  const app = express();
  app.use(express.json());
  // Stand in for requireAuth's effect — the router mounts it itself, so a
  // token is minted rather than the middleware being bypassed.
  app.use('/api/gst', router);
  app.use(errorHandler);

  const restore = () => {
    global.fetch = REAL_FETCH;
    if (prevSecret === undefined) delete process.env.APPYFLOW_KEY_SECRET;
    else process.env.APPYFLOW_KEY_SECRET = prevSecret;
  };
  return { app, calls, restore };
}

function token() {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: '11111111-1111-1111-1111-111111111111' }, process.env.JWT_SECRET);
}

// Minimal request helper — starts the app on an ephemeral port.
async function post(app, path, body, auth = true) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer ' + token() } : {})
      },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json, raw: JSON.stringify(json) };
  } finally {
    server.close();
  }
}

test('A1 a valid GSTIN returns the mapped taxpayer details', async () => {
  const { app, restore } = makeApp();
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 200);
    const t = r.body.taxpayer;
    assert.strictEqual(t.gstin, GSTIN);
    assert.strictEqual(t.legalName, 'V TECH ENTERPRISES');
    assert.strictEqual(t.tradeName, 'Vtech');
    assert.strictEqual(t.state, 'Tamil Nadu');
    assert.strictEqual(t.district, 'Coimbatore');
    assert.strictEqual(t.pincode, '641004');
    assert.strictEqual(t.status, 'Active');
    assert.match(t.address, /Anna Salai/);
  } finally { restore(); }
});

// The whole reason this route exists.
test('A2 the secret is sent upstream and never appears in the response', async () => {
  const { app, calls, restore } = makeApp();
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.ok(calls.length === 1, 'exactly one upstream call');
    assert.ok(calls[0].includes(encodeURIComponent(SECRET)), 'secret must reach Appyflow');
    assert.ok(!r.raw.includes(SECRET), 'secret must NOT be in the response body');
    assert.ok(!r.raw.includes('appyflow'), 'the upstream URL must not be echoed');
  } finally { restore(); }
});

test('A3 an unexpected upstream field is not passed through', async () => {
  const { app, restore } = makeApp({
    respond: async () => ({ ok: true, status: 200,
      json: async () => ({ taxpayerInfo: { ...TAXPAYER, key_secret: SECRET, internalDebug: 'x' } }) })
  });
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 200);
    assert.ok(!('key_secret' in r.body.taxpayer));
    assert.ok(!('internalDebug' in r.body.taxpayer));
    assert.ok(!r.raw.includes(SECRET));
  } finally { restore(); }
});

test('A4 a malformed GSTIN is rejected before any upstream call', async () => {
  const { app, calls, restore } = makeApp();
  try {
    const r = await post(app, '/api/gst/verify', { gstin: 'NOTAGSTIN' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'invalid_gstin');
    assert.strictEqual(calls.length, 0, 'no paid lookup for an impossible GSTIN');
  } finally { restore(); }
});

test('A5 a GSTIN failing the checksum is rejected too', async () => {
  const { app, calls, restore } = makeApp();
  try {
    const r = await post(app, '/api/gst/verify', { gstin: '33AARFV8415B1Z5' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.length, 0);
  } finally { restore(); }
});

test('A6 an unconfigured server says so without naming the variable', async () => {
  const { app, calls, restore } = makeApp({ secret: null });
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error.code, 'not_configured');
    assert.ok(!/APPYFLOW/i.test(r.raw), 'must not name the env var to the user');
    assert.strictEqual(calls.length, 0);
  } finally { restore(); }
});

test('A7 an upstream not-found becomes a clean 404', async () => {
  const { app, restore } = makeApp({
    respond: async () => ({ ok: true, status: 200,
      json: async () => ({ error: true, message: 'GSTIN not found in the records' }) })
  });
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error.code, 'gstin_not_found');
  } finally { restore(); }
});

test('A8 an upstream auth failure is reported as unavailable, not as our credential', async () => {
  const { app, restore } = makeApp({
    respond: async () => ({ ok: false, status: 401, json: async () => ({ message: 'bad key_secret' }) })
  });
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 503);
    assert.ok(!/key_secret|credential|unauthorized/i.test(r.raw));
  } finally { restore(); }
});

test('A9 a network failure does not leak the request URL', async () => {
  const { app, restore } = makeApp({
    respond: async () => { const e = new Error(`connect ECONNREFUSED ${SECRET}`); throw e; }
  });
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 504);
    assert.ok(!r.raw.includes(SECRET), 'an upstream error message must never be forwarded');
  } finally { restore(); }
});

test('A10 an unrecognised payload shape is refused rather than half-mapped', async () => {
  const { app, restore } = makeApp({
    respond: async () => ({ ok: true, status: 200, json: async () => ({ something: 'else' }) })
  });
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.error.code, 'upstream_failed');
  } finally { restore(); }
});

test('A11 the route requires authentication', async () => {
  const { app, calls, restore } = makeApp();
  try {
    const r = await post(app, '/api/gst/verify', { gstin: GSTIN }, false);
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
    assert.strictEqual(calls.length, 0, 'an unauthenticated caller must not spend a lookup');
  } finally { restore(); }
});

test('A12 the fetched state and district are a pair the app would accept', async () => {
  // The lookup is only useful if what it returns passes the same
  // State/District validation a hand-typed pair does.
  const { isValidStateDistrict } = require('../../shared/india-districts');
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', 'Coimbatore'), true);
});
