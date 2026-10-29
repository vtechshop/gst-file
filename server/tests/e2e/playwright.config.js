// Browser end-to-end tests.
//
// This is the first browser-driven suite in the project. Everything else
// under tests/ is node:test - either a vm sandbox that loads the real
// frontend file and calls its functions, or a spawned server driven over
// HTTP. Those prove logic; they cannot see a rendered page. This exists for
// the questions only a browser can answer: does the grid actually paint, do
// the column widths hold, does the layout survive a 390px viewport.
//
// WHY THE CONFIG LIVES HERE, beside the specs, rather than at server/:
// this directory is its own npm package (package.json alongside), which is
// what keeps @playwright/test out of server/package.json. Hostinger installs
// that manifest on the production host and render.yaml builds it with a plain
// `npm install`, which takes devDependencies too - so a devDependency there
// would pull a browser test framework, and its ~150 MB of browsers, onto two
// hosts that will never run it. Node resolves `require` by walking up the
// directory tree, so from here @playwright/test is found in this package's
// own node_modules while pg and jsonwebtoken still come from
// server/node_modules. A config at server/ could not see the former, which
// is exactly the MODULE_NOT_FOUND the first audit hit.
//
// SAFETY: every spec runs against a server this suite starts itself, bound to
// the DISPOSABLE database named by STOCK_TEST_DATABASE_URL. global-setup
// refuses to run without it, so there is no path by which these tests reach
// the production host or its data. Nothing here ever talks to Hostinger.
//
// RESOURCES: one worker, one browser, no parallelism - the specs share one
// server and one database, and the development machine has little RAM to
// spare. Chromium only; add others once the suite is green on it.
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: __dirname,
  // .spec.js, so `node --test` keeps ignoring these and the two runners stay
  // out of each other's way. Verified: node's own discovery matches only
  // *.test.js, so nothing in this directory is picked up by `npm test`.
  testMatch: '**/*.spec.js',

  globalSetup: require.resolve('./global-setup.js'),
  globalTeardown: require.resolve('./global-teardown.js'),

  // One at a time, for the shared server and the shared rows behind it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,

  // Generous: the app starts under memory pressure here, and a first paint
  // that takes three seconds is a slow machine rather than a broken page.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(__dirname, '.report'), open: 'never' }]
  ],
  outputDir: path.join(__dirname, '.artifacts'),

  use: {
    // No baseURL here on purpose: this module is evaluated before globalSetup
    // runs, and the port does not exist until the server has started.
    // openVouchers() in fixtures.js navigates by absolute URL from the state
    // file instead.
    // Kept on failure only: a trace per passing test would fill the disk.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    },
    {
      // The breakpoint the quotation grid has a rule for lives at 768px, so
      // the tablet case sits deliberately just above it and the phone case
      // well below.
      name: 'chromium-tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 } }
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: false }
    }
  ]
});
