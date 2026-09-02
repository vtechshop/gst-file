// The Content-Security-Policy split: the PAGES get a policy that describes
// what this frontend actually is, and the API keeps helmet's default.
//
// This exists because the Hostinger deployment (SERVE_CLIENT=1, one process
// for pages and API) rendered every page and then did nothing: helmet's
// default `script-src 'self'` blocked each page's inline bootstrap, and
// `script-src-attr 'none'` blocked every inline onclick/onchange. The
// Invoice State dropdown staying empty was that, not a State bug.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const APP = strip(rd('server', 'src', 'app.js'));

// The policy the source actually builds, evaluated the same way app.js does.
function buildFrontendCsp() {
  const d = { ...helmet.contentSecurityPolicy.getDefaultDirectives() };
  d['script-src'] = ["'self'", "'unsafe-inline'",
    'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'];
  d['script-src-attr'] = ["'unsafe-inline'"];
  return Object.entries(d)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join(';');
}

test('C1 the pages may run their own inline bootstrap and handlers', () => {
  const csp = buildFrontendCsp();
  assert.match(csp, /script-src [^;]*'unsafe-inline'/);
  assert.match(csp, /script-src-attr 'unsafe-inline'/);
  assert.equal(/script-src-attr 'none'/.test(csp), false);
});

test('C2 the two CDN hosts are named, not opened to all of https:', () => {
  const csp = buildFrontendCsp();
  const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src '));
  assert.match(scriptSrc, /https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(scriptSrc, /https:\/\/cdn\.jsdelivr\.net/);
  assert.equal(/\bhttps:(?!\/\/)/.test(scriptSrc), false,
    'script-src must not allow every https: origin');
});

test('C3 everything else stays exactly as helmet had it', () => {
  const csp = buildFrontendCsp();
  const defaults = helmet.contentSecurityPolicy.getDefaultDirectives();
  for (const [name, values] of Object.entries(defaults)) {
    if (name === 'script-src' || name === 'script-src-attr') continue;
    const expected = values.length ? `${name} ${values.join(' ')}` : name;
    assert.ok(csp.split(';').includes(expected),
      name + ' must be unchanged from helmet defaults');
  }
  // the ones that matter most for a page that now allows inline script
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /default-src 'self'/);
});

test('C4 the relaxation reaches ONLY files served off disk', () => {
  // It is applied through express.static's setHeaders, which never runs for
  // an API response. That scoping is the whole point.
  assert.match(APP, /function cacheControlForStatic\(res, filePath\)/);
  const fn = APP.slice(APP.indexOf('function cacheControlForStatic'),
                       APP.indexOf("if (process.env.SERVE_CLIENT === '1')"));
  assert.match(fn, /res\.setHeader\('Content-Security-Policy', FRONTEND_CSP\)/);
  // and only for the HTML documents whose inline code it governs
  assert.match(fn, /filePath\.endsWith\('\.html'\)/);
  const setAt = fn.indexOf("setHeader('Content-Security-Policy'");
  const guardAt = fn.indexOf(".endsWith('.html')");
  assert.ok(guardAt > -1 && guardAt < setAt, 'the CSP must be set inside the .html guard');
});

test('C5 helmet still guards the whole app, API included', () => {
  assert.match(APP, /app\.use\(helmet\(\)\)/);
  // The override is never installed as app-level middleware — if it were, it
  // would reach /api responses too.
  assert.equal(/app\.use\(.*FRONTEND_CSP/.test(APP), false);
  assert.equal(/app\.use\(helmet\(\{[\s\S]*contentSecurityPolicy/.test(APP), false,
    'helmet must not be reconfigured globally');
  // and the static mounts are the only place setHeaders is wired
  const mounts = APP.match(/setHeaders: cacheControlForStatic/g) || [];
  assert.equal(mounts.length, 2, 'public/ and shared/ are the only static mounts');
});

test('C6 the frontend policy exists only where the frontend is served', () => {
  // Render serves the API alone (SERVE_CLIENT unset), so nothing about its
  // responses changes: express.static is never mounted there.
  const block = APP.slice(APP.indexOf("if (process.env.SERVE_CLIENT === '1')"));
  assert.match(block, /express\.static/);
  assert.match(APP, /SERVE_CLIENT === '1'/);
});

test('C7 CSP is not disabled, only described', () => {
  assert.equal(/contentSecurityPolicy: false/.test(APP), false,
    'the policy must not be switched off');
  assert.equal(/helmet\.contentSecurityPolicy\(\{[\s\S]*reportOnly: true/.test(APP), false,
    'the policy must be enforced, not report-only');
  const csp = buildFrontendCsp();
  assert.ok(csp.split(';').length >= 10, 'the page policy must still carry every directive');
});
