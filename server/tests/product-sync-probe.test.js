// The background Product Sync probe: what must hold so an unconfigured
// company stops generating a 503 on every page load, without changing
// anything for a company that IS configured.
//
// Read from the source rather than a running browser, for the same reason the
// other structural tests are: they assert wiring that no amount of test data
// can prove. Comments are stripped before any assertion about behaviour, so a
// test cannot pass by matching the prose that describes the code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const SYNC = strip(rd('client', 'js', 'api', 'product-sync.js'));
const AUTH = strip(rd('client', 'js', 'core', 'auth.js'));
const PROFILE = strip(rd('client', 'js', 'pages', 'profile.js'));
const ROUTE = strip(rd('server', 'src', 'routes', 'product-sync.js'));

const IF_NEEDED = SYNC.slice(SYNC.indexOf('async function syncProductsIfNeeded'),
                             SYNC.indexOf('async function isCompanyProductSyncConfigured'));
const CONFIGURED_FN = SYNC.slice(SYNC.indexOf('async function isCompanyProductSyncConfigured'),
                                 SYNC.indexOf('function forgetCompanyProductSyncConfigured'));
const SYNC_PRODUCTS = SYNC.slice(SYNC.indexOf('async function syncProducts(userId)'),
                                 SYNC.indexOf('function mapRemoteProduct'));

// ── 1. an unconfigured company makes no sync request ──
test('P1 the page-load probe is gated on the company actually being configured', () => {
  // The initialization path: requireAuth fires it on every page.
  assert.match(AUTH, /syncProductsIfNeeded\(session\.user\.id\)/);
  // and the gate sits in front of the request that produced the 503
  assert.match(IF_NEEDED, /if \(!\(await isCompanyProductSyncConfigured\(\)\)\) return;/);
  const gateAt = IF_NEEDED.indexOf('isCompanyProductSyncConfigured');
  const callAt = IF_NEEDED.indexOf('syncProducts(userId)');
  assert.ok(gateAt > -1 && callAt > -1 && gateAt < callAt,
    'the configured check must run BEFORE syncProducts()');
});

test('P2 an unconfigured answer is remembered, so it is asked once per tab', () => {
  assert.match(CONFIGURED_FN, /sessionStorage\.getItem\(PRODUCT_SYNC_CONFIGURED_KEY\)/);
  assert.match(CONFIGURED_FN, /if \(cached === 'no'\) return false;/);
  assert.match(CONFIGURED_FN, /sessionStorage\.setItem\(PRODUCT_SYNC_CONFIGURED_KEY, configured \? 'yes' : 'no'\)/);
});

test('P3 nothing user-facing is raised by the background probe', () => {
  // No toast, no handleApiError, no thrown error anywhere in the gate.
  for (const noisy of ['showToast', 'handleApiError', 'alert(']) {
    assert.equal(CONFIGURED_FN.includes(noisy), false,
      'the background probe must not raise ' + noisy);
  }
  assert.equal(/throw /.test(CONFIGURED_FN), false, 'the background probe must not throw');
});

// ── 2. a configured company is unaffected ──
test('P4 a configured company still reaches the existing sync unchanged', () => {
  assert.match(CONFIGURED_FN, /if \(cached === 'yes'\) return true;/);
  // syncProducts itself is untouched: same endpoint, same JWT, same handling.
  assert.match(SYNC_PRODUCTS, /fetch\(PRODUCT_SYNC_BACKEND_URL, \{/);
  assert.match(SYNC_PRODUCTS, /Authorization: 'Bearer ' \+ token/);
  assert.match(SYNC_PRODUCTS, /applyProductSync\(userId, remoteRaw\)/);
  // the staleness and cooldown gates that already existed are still in front
  assert.match(IF_NEEDED, /if \(!isProductSyncStale\(\)\) return;/);
  assert.match(IF_NEEDED, /PRODUCT_SYNC_RETRY_COOLDOWN_MS/);
});

test('P5 turning Product Sync on takes effect without opening a new tab', () => {
  assert.match(SYNC, /function forgetCompanyProductSyncConfigured\(\)/);
  assert.match(SYNC, /sessionStorage\.removeItem\(PRODUCT_SYNC_CONFIGURED_KEY\)/);
  // called from the one place that can change the answer
  const save = PROFILE.slice(PROFILE.indexOf('async function saveProductSyncConfig'));
  assert.match(save, /forgetCompanyProductSyncConfigured\(\)/);
  assert.ok(save.indexOf('forgetCompanyProductSyncConfigured') < save.indexOf('return { ok: true }'),
    'the cache must be cleared before the save reports success');
});

// ── 3. a configured upstream failure is still surfaced ──
test('P6 the backend contract is unchanged', () => {
  // 503 not_configured still exists and still means what it meant.
  assert.match(ROUTE, /code: 'not_configured'/);
  assert.match(ROUTE, /res\.status\(503\)/);
  // and a configured upstream that fails is still a 502 the caller can see
  assert.match(ROUTE, /res\.status\(502\)/);
  assert.match(ROUTE, /code: 'upstream_failed'/);
});

test('P7 the client still distinguishes not_configured from a real failure', () => {
  assert.match(SYNC_PRODUCTS, /if \(res\.status === 503\)/);
  assert.match(SYNC_PRODUCTS, /reason: 'not_configured'/);
  // anything else is still thrown rather than swallowed
  assert.match(SYNC_PRODUCTS, /throw apiError;/);
});

test('P8 an explicit Sync Now is NOT gated, so the user still learns it is off', () => {
  // products.html's button calls syncProducts directly; only the automatic
  // page-load path is gated. Gating the button would hide the reason.
  const PRODUCTS = strip(rd('client', 'js', 'pages', 'products.js'));
  assert.match(PRODUCTS, /await syncProducts\(prodCurrentUserId\)/);
  assert.equal(/isCompanyProductSyncConfigured/.test(PRODUCTS), false,
    'the explicit Sync Now button must not be gated by the background check');
});

// ── 4. authentication and tenant isolation are unchanged ──
test('P9 the probe asks the server, and never says which company it is', () => {
  // Ownership comes from the JWT the server verifies, exactly as before.
  assert.match(CONFIGURED_FN, /Authorization: 'Bearer ' \+ token/);
  assert.match(CONFIGURED_FN, /PRODUCT_SYNC_BACKEND_URL \+ '\/config'/);
  // no browser-supplied identity is sent
  for (const bad of ['user_id', 'userId', 'workshop_id', 'workshopId', 'company_id', 'role']) {
    assert.equal(CONFIGURED_FN.includes(bad), false,
      'the probe must not send ' + bad);
  }
});

// The GET handler is sliced out between the two /config routes. That upper
// bound is deliberate: anchoring on a helper further down the file would tie
// this test to code that may not be present in every checkout.
test('P10 the server still resolves the company from the verified JWT alone', () => {
  const cfg = ROUTE.slice(ROUTE.indexOf("router.get('/config'"), ROUTE.indexOf("router.patch('/config'"));
  assert.match(cfg, /WHERE id = \$1/);
  assert.match(cfg, /\[req\.userId\]/);
  assert.equal(/req\.body|req\.query/.test(cfg), false,
    'the config read must not take an id from the request');
  // and the whole router is still behind auth
  assert.match(ROUTE, /router\.use\(requireAuth\)/);
});

test('P11 the key is still never returned to the browser', () => {
  const cfg = ROUTE.slice(ROUTE.indexOf("router.get('/config'"), ROUTE.indexOf("router.patch('/config'"));
  assert.match(cfg, /AS has_key/);
  assert.match(cfg, /has_key: !!row\.has_key/);
  assert.equal(/product_api_key: /.test(cfg), false, 'the key must never be sent back');
  // the client gate reads only the URL presence, never a key
  assert.equal(/product_api_key/.test(CONFIGURED_FN), false);
});

// ── the changed assets carry their own cache keys ──
test('P12 both changed scripts carry a new cache key on every page', () => {
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  let checked = 0;
  for (const f of pages) {
    const s = rd(f);
    if (s.includes('client/js/api/product-sync.js')) {
      assert.ok(s.includes('client/js/api/product-sync.js?v=39'), f + ' must load product-sync.js at v=39');
      checked++;
    }
    if (s.includes('client/js/pages/profile.js')) {
      assert.ok(s.includes('client/js/pages/profile.js?v=39'), f + ' must load profile.js at v=39');
    }
  }
  assert.ok(checked >= 20, 'expected the sidebar pages to load product-sync.js');
});
