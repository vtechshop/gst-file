// What every spec starts from: a signed-in page, the seeded ids, and a
// recorder for anything the browser complains about.
//
// Console errors and failed requests are collected rather than asserted here,
// so a spec can decide what matters to it - a 404 on a favicon is not a bug,
// an uncaught TypeError is.
const base = require('@playwright/test');
const { Client } = require('pg');
const { readState, TOKEN_STORAGE_KEY } = require('./harness');

// Read on first use, not at require() time. The state file is written by
// globalSetup, and this module is loaded when Playwright collects the specs -
// an order that is not ours to rely on, and that `--list` inverts outright by
// loading spec files without running globalSetup at all. Reading it at module
// scope therefore risked turning a diagnostic command into a hard
// MODULE-level throw before a single test ran. Memoised, so the file is still
// read once per process.
let cachedState = null;
function seededState() {
  if (!cachedState) cachedState = readState();
  return cachedState;
}

// No baseURL fixture and no test.use() here: test.use() belongs in a spec
// file, not in a shared helper, and the config cannot know the port because
// it is evaluated before globalSetup runs. Navigation therefore goes through
// openVouchers() below, which builds an absolute URL from the state file -
// one mechanism, and no dependency on an option resolved elsewhere.

const test = base.test.extend({
  // The seeded world, read once per worker.
  seeded: [async ({}, use) => { await use(seededState()); }, { scope: 'worker' }],

  // A direct connection, for the assertions that are about what was stored
  // rather than what was shown. Per worker, and there is only ever one.
  db: [async ({}, use) => {
    const client = new Client({ connectionString: seededState().databaseUrl });
    await client.connect();
    await use(client);
    await client.end();
  }, { scope: 'worker' }],

  // Everything the page said went wrong, in the order it said it.
  consoleErrors: async ({}, use) => { await use([]); },
  failedRequests: async ({}, use) => { await use([]); },

  page: async ({ page, consoleErrors, failedRequests }, use) => {
    // Before any of the page's own scripts run, so auth.js finds a session
    // already there and does not bounce to the login page.
    await page.addInitScript(([key, token]) => {
      try { localStorage.setItem(key, token); } catch { /* private mode */ }
    }, [TOKEN_STORAGE_KEY, seededState().token]);

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      // An uncaught exception is the class of bug that broke this very
      // feature once already (a ReferenceError that only fired when a
      // quotation was selected), so it is recorded as loudly as possible.
      consoleErrors.push('UNCAUGHT: ' + err.message);
    });
    page.on('requestfailed', (req) => {
      failedRequests.push(req.method() + ' ' + req.url() + ' - ' + (req.failure()?.errorText || 'failed'));
    });
    page.on('response', (res) => {
      if (res.status() >= 500) failedRequests.push(res.status() + ' ' + res.url());
    });

    await use(page);
  }
});

// Opens a page and waits until its own scripts have finished wiring it up,
// rather than for an arbitrary delay. The voucher page is ready when the
// document-type selector has been filled from the registry.
async function openVouchers(page) {
  await page.goto(seededState().baseURL + '/vouchers.html', { waitUntil: 'domcontentloaded' });
  await base.expect(page.locator('#vDocType option')).not.toHaveCount(0);
  return page;
}

module.exports = { test, expect: base.expect, openVouchers, seededState };
