# Browser end-to-end tests

The first browser-driven suite in this project. Everything under `tests/*.test.js`
is `node:test`: either a `vm` sandbox that loads the real frontend file and calls
its functions, or a spawned server driven over HTTP. Those prove logic. They
cannot see a rendered page, and this feature has already shipped one bug that
only a browser would have caught — `renderVoucherBalance()` called an undeclared
`val`, so the handler threw the moment a quotation was selected while every
static check stayed green.

## Status: written, never executed

**No test in here has been run.** No browser has been launched and
`@playwright/test` is still not installed. Free RAM was 0.84 GB when this was
last attempted — under a third of the 3 GB a Chromium run wants, and installing
the package alone would pull ~150 MB of browsers via its postinstall. Treat
every spec as unproven until a green run exists.

What changed is that the suite is now *installable*: this directory is its own
npm package (see **Setup**), which is what the earlier `MODULE_NOT_FOUND`
really needed. Previously the config sat at `server/playwright.config.js`, where
no arrangement of dependencies could have reached it without putting Playwright
into `server/package.json`.

What *has* been established, by static inspection and by executing the parts
that need no browser:

- all six JS files parse
- `playwright.config.js` now *constructs*, which it never did before. Verified
  by stubbing the single missing module at the loader and asserting on the
  object the real file returns: `testDir` is this directory, `testMatch` is
  `**/*.spec.js`, `globalSetup` and `globalTeardown` both `require.resolve` to
  files that exist, `workers` is 1, `use.baseURL` is absent by design, and the
  three projects carry the 1440 / 820 / 390 viewports. 13 checks, all passing.
  That is the configuration proven, not the specs.
- the 29 selectors the receipt spec uses all exist in `vouchers.html`
- the seeder's SQL names only columns that exist — 50 across 5 tables
- `requireScratchDatabase()` really does refuse an unset variable and the
  `hostinger` / `onrender` / `render.com` patterns, and allows only a local
  scratch URL

Four defects were found that way and fixed, which is the argument for reading
unexecuted code rather than trusting it:

1. `use.baseURL` read `process.env.E2E_BASE_URL` in `playwright.config.js`. The
   config is evaluated *before* `globalSetup` runs, so it was always undefined
   and every navigation would have had no origin. Navigation now goes through
   `openVouchers()`, which builds an absolute URL from the state file.
2. `global-setup.js` read the migration list from `manifest.migrations` /
   `manifest.files`. The key is **`order`**, so the loop ran zero times and a
   fresh scratch database would have been seeded with no migrations applied.
   It now reads `order` and throws if that array is missing.
3. The row actions were clicked by `[onclick^="editVoucher"]`, coupling the
   spec to how the handler is wired. The rows carry `title="Edit"` and a
   `Cancel …` title, so `getByTitle()` is used instead.
4. `fixtures.js` called `readState()` at `require()` time, which assumes
   `globalSetup` has already run by the time Playwright loads the spec files.
   That order is not ours to rely on, and `playwright test --list` inverts it
   outright — it loads spec files and never runs `globalSetup`, so the first
   diagnostic command anyone reaches for would have thrown at module level
   before a single test ran. The read is now memoised behind `seededState()`.

## The regression suite is a different thing

`npm run test:full` (see `server/scripts/test-full.js`) runs the 72-file
`node:test` suite serially and refuses to start unless the scratch database and
the jsPDF builds are both present, so nothing can skip quietly. That suite is
green: **1306 tests, 1306 pass, 0 skipped**, in about 3 minutes. It needs no
browser and is unaffected by anything in this directory.

(The figure was 1298 across 71 files before `tests/auth-login.test.js` added
its 8; if you see the older number quoted anywhere, that is why.)

Keep the two apart. Nothing here has been proven; that has.

## Setup

Two steps, neither of which has been performed:

```sh
cd server/tests/e2e
npm install                  # @playwright/test, into this directory
npm run install:browser      # chromium, ~150 MB download
```

**Why this directory is its own package.** `@playwright/test` is pinned here, in
`server/tests/e2e/package.json`, and deliberately *not* in `server/package.json`.
Two hosts install that manifest and neither will ever run a browser test:

- Hostinger installs it on the production host.
- `render.yaml` builds `server/` with a plain `npm install` — note the absent
  `--omit=dev`, so a devDependency there would be installed too, browsers and
  all.

Node resolves `require` by walking *up* the directory tree, which is what makes
the split work: from here `@playwright/test` is found in this package's own
`node_modules`, while `pg` and `jsonwebtoken` still come from
`server/node_modules`. Nothing is duplicated and neither host is affected.

This is also why `playwright.config.js` lives here rather than at `server/`. A
config at `server/` resolves its own `require('@playwright/test')` against
`server/node_modules`, which is precisely the `MODULE_NOT_FOUND` that blocked
the first audit.

`node --test` is unaffected: its discovery matches only `*.test.js`, so the
`.spec.js` files, the helpers and this `package.json` are all invisible to
`npm test` and to `npm run test:full`. That was verified, not assumed.

## Running

The suite needs a disposable database and refuses to start without one:

```sh
cd server/tests/e2e
export STOCK_TEST_DATABASE_URL=postgres://…/gst_stock_scratch
npm run test:desktop                      # one viewport
npm test                                  # all three
npx playwright test advance-receipt.spec.js   # one file
```

On a memory-constrained machine run one project at a time, in this order:
`chromium-desktop`, then `chromium-tablet`, then `chromium-mobile`. The config
already pins `workers: 1` and `fullyParallel: false`.

## Isolation

`harness.js` `requireScratchDatabase()` is the whole safety argument:

- It throws unless `STOCK_TEST_DATABASE_URL` is set.
- It throws if that URL mentions `hostinger`, `onrender` or `render.com`.
- `global-setup.js` runs `TRUNCATE users CASCADE` on it, which is why the two
  guards above come first.

`global-setup.js` starts its own server on an ephemeral port with
`DATABASE_URL` pointing at the scratch database, `NODE_ENV=test` and
`SERVE_CLIENT=1`. Nothing in this directory ever addresses the deployed host, and
the `baseURL` is always `127.0.0.1`.

## Signing in

These specs do not use the login form. `fixtures.js` injects a minted JWT into
`localStorage` under `gst_jwt` (`API_TOKEN_KEY` in
`client/js/api/apiClient.js`) via `addInitScript`, before any page script runs,
which is the honest equivalent of arriving with a session already open. The
user `global-setup.js` seeds carries a placeholder `password_hash`, so the form
could not be used against it anyway.

The piece that was missing for a real sign-in now exists:
`tests/helpers/login-user.js` seeds a user whose password is hashed with the
project's own `bcryptjs` at the cost `src/routes/auth.js` uses, and
`tests/auth-login.test.js` exercises `POST /api/auth/login` with it — a correct
password, a wrong one, an unknown address refused in identical words, case
folding, and a missing field. That runs in the `node:test` suite today, with no
browser.

So a **browser** login spec is now unblocked rather than impossible: call
`seedLoginUser()` from `global-setup.js` and drive `index.html`. It is not
written, because nothing here can be run yet. Note the route is rate limited to
20 attempts per 15 minutes per address.

## Seeded data

Fixed, so assertions can name figures:

| Row | Meaning |
|---|---|
| `PI-E2E-001` | ₹1,750 total, ₹1,483.05 taxable, ₹266.95 GST, advance **term** ₹500 |
| `PI-E2E-002` | ₹900, left unreceipted for the save/cancel cases |
| `PI-E2E-003` | cancelled, to prove it is not offered |
| `PI-E2E-OTHER` | owned by a second business, to prove tenancy |

`PI-E2E-001` carries two lines out of `sort_order` on purpose, one with a 5%
discount, so the Products grid's sorting and its Discount % column both have
something real to assert.

The ₹500 on `PI-E2E-001` is a payment **term**, not money received. Several specs
exist only to prove it is never shown as a receipt.

## What is covered

`advance-receipt.spec.js` — Section D of the brief:

- the panel appearing on selection, its ten columns in the invoice's order, the
  sort order, the line values and the Grand Total row
- the panel holding no `input`, `select`, `textarea`, `button`, `[contenteditable]`
  or `[tabindex]`
- the quotation header's own saved figures, including CGST/SGST and no invented IGST
- customer autofill, fields still editable, and the typed amount surviving selection
- all five figures and how they move as the amount changes, including the
  settled-to-zero case, the overpayment flag and an emptied box
- the quoted advance term never appearing as money received
- save → stored method/reference/link/number, and the print action appearing
- edit → method, reference and quotation link restored, and not counted against itself
- cancel → record kept with its number and amount, capacity released without a reload
- overpayment refused, verified by row count rather than by the message
- a standalone receipt with no quotation
- reset clearing the payment facts and hiding the panel
- cancelled and other-tenant quotations not offered; the empty-selector note
- the painted header colour, the distinct total row, in-wrapper scrolling with no
  page overflow, and the save button reachable — at 1440×900, 820×1180 and 390×844

## What is NOT covered

Written down rather than implied, because the brief asked for the whole
application and this is one module of it:

- **Authentication in the browser**: login, logout, invalid login,
  unauthenticated access, session expiry. No longer blocked — the hashed
  fixture exists (above) — simply not written. The login *route* is covered by
  `tests/auth-login.test.js`.
- **Invoices and sales**, **proforma/quotation authoring**, **payment and refund
  vouchers**, **self invoice / RCM**, **credit and debit notes**, **sales
  returns**, **bill of supply**, **revised invoices**, **delivery challans**,
  **amendments**, **GSTR-1/3B reports**, **purchases, vendors, purchase orders,
  ledgers**, **stock, serials, locations, transfers**, **warranty**, **dashboard
  KPIs**, **product sync screens**: 43 pages in total, none of them driven here.
- **PDF content**: the specs confirm the print control appears. Opening the
  generated PDF and reading its text is not done; `tests/advance-receipt.test.js`
  renders through real jsPDF and pins content there instead.

The gap is a resourcing decision, not an oversight: writing specs for 43 pages
that cannot be executed even once would produce a great deal of unverified test
code. Extend this one module at a time, with a green run behind each.
