// =============================================
// GST Billing Backend
//
// Product Sync (routes/product-sync.js) deserves a callout: every
// account here is a different company, each with its own website and
// product catalog, so that catalog's URL/key live per-company in
// profiles (product_api_url/product_api_key) — never a process-wide
// env var. See that file's header for the full per-tenant proxy shape.
// =============================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const backupRoutes = require('./routes/backup');
const invoiceRoutes = require('./routes/invoices');
const documentRoutes = require('./routes/documents');
const purchaseRoutes = require('./routes/purchases');
const salesReturnRoutes = require('./routes/sales-returns');
const paymentsRoutes = require('./routes/payments');
const uploadRoutes = require('./routes/uploads');
const productSyncRoutes = require('./routes/product-sync');
const billScanRoutes = require('./routes/bill-scan');
const invoiceScanRoutes = require('./routes/invoice-scan');
const gstVerifyRoutes = require('./routes/gst-verify');
const verifyRoutes = require('./routes/verify');
const { mountGenericRoutes } = require('./routes/generic');
const { errorHandler } = require('./middleware/errorHandler');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();

// One proxy sits in front of this app in production (Render's load
// balancer, which sets X-Forwarded-For). Without this, Express reports
// every request as coming from the proxy's own address, so the rate
// limiter below keyed EVERY user in the world to a single bucket — one
// busy session could exhaust the 600-request window for everyone, and
// express-rate-limit logged ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
// request to say so.
//
// A hop count, not `true`. `true` trusts the whole X-Forwarded-For chain
// including the part the CLIENT can write, which would let anyone spoof
// a fresh address per request and bypass the limiter completely — the
// opposite of the problem being fixed. `1` takes the address Render's
// balancer appended and nothing further left of it.
//
// Locally there is no proxy and no X-Forwarded-For, so req.ip stays the
// real connecting address and nothing changes.
app.set('trust proxy', 1);

// Gzip every response big enough to be worth it. These endpoints return
// plain JSON arrays — highly repetitive keys — which compress by roughly
// 90%, and the report pages fetch a few MB of them. Mounted before the
// routes so it wraps every one of them, and before CORS/helmet only by
// convention: it just wires up res.write/res.end, it never short-circuits.
// Clients that don't send Accept-Encoding still get identical plain JSON,
// so no endpoint, payload shape or status code changes.
app.use(compression());

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin/non-browser requests (no Origin header) and
    // anything explicitly listed in ALLOWED_ORIGIN.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Origin not allowed: ' + origin));
  }
}));
app.use(express.json());

// Gentle, general defense-in-depth across the whole API. A much tighter
// limit specifically on login/register/forgot-password (the genuinely
// brute-forceable endpoints) lives in routes/auth.js itself — NOT here,
// because a blanket limit on the whole /api/auth/* prefix would also
// throttle GET /api/auth/me, which fires on every single authenticated
// page load and would lock normal users out after a few page visits.
// `message` is given explicitly because express-rate-limit's default 429
// body is PLAIN TEXT — which would be the one response in the whole API
// that isn't { error: { message, code } }, so js/apiClient.js's
// res.json() would fail on it and the user would see a bare
// "Request failed (429)" instead of being told to wait. The RateLimit-*
// / Retry-After headers (standardHeaders) are what the browser reads to
// say HOW long.
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a moment and try again.', code: 'rate_limited' } }
}));

app.use('/api/auth', authRoutes);
// Mounted at its own sub-path, not bare /api — backupRoutes applies
// requireAuth to every path under wherever it's mounted (router.use with
// no path arg), so mounting it at bare /api would gate every OTHER /api/*
// route behind it too, regardless of registration order.
app.use('/api/backup', backupRoutes);
app.use('/api/invoices', invoiceRoutes);
// Vouchers and self invoices (Phase 2, Module 4B-impl) — their own
// namespace, so nothing about /api/invoices changes.
app.use('/api/documents', documentRoutes);
app.use('/api/purchases', purchaseRoutes);
// Shares the /api/payments prefix with the generic router's plain
// payments-table CRUD (still used for read-only ledger listing) —
// no collision since these routes are all multi-segment
// (/:type/:invoiceId/record etc.), never the bare path the generic
// router's GET/POST/PATCH/DELETE operate on.
app.use('/api/payments', paymentsRoutes);
// Shares the /api/sales_returns prefix with the generic router's plain
// sales_returns-table CRUD, same reasoning as /api/purchases above —
// these routes are all multi-segment (/save-with-items, /:id/cascade-*),
// never the bare path the generic router's own routes use.
app.use('/api/sales_returns', salesReturnRoutes);
app.use('/api/uploads', uploadRoutes);
// Per-company proxy — see routes/product-sync.js header. requireAuth'd
// internally (every sub-route), so mounted the same bare way as
// uploadRoutes above.
app.use('/api/product-sync', productSyncRoutes);
// Purchase Bill Scanner — reads an uploaded bill via Gemini and returns
// structured JSON for the Purchase Entry form to propose. Holds the
// Gemini key server-side; cannot write to the database. requireAuth'd
// internally, so mounted the same bare way as uploadRoutes above.
app.use('/api/bill-scan', billScanRoutes);
// Customer Invoice Scanner — same shape as bill-scan above, but returns
// a LIST of invoices (one upload can hold several) for the user to pick
// from. Shares the Gemini client, upload plumbing and sanitisers with
// it; also cannot write to the database.
app.use('/api/invoice-scan', invoiceScanRoutes);
// GSTIN lookup against the public taxpayer register. Holds the Appyflow
// secret server-side for the same reason bill-scan holds the Gemini key,
// and like it cannot write to the database. requireAuth'd internally.
app.use('/api/gst', gstVerifyRoutes);
// PUBLIC - the only router here without requireAuth. It answers the QR
// printed on invoices, which is read by customers, transporters and tax
// officers who have no login. It is read-only, returns a fixed list of
// fields already printed on the document they are holding, and is covered
// by the /api rate limiter mounted above. See routes/verify.js.
app.use('/api/verify', verifyRoutes);
mountGenericRoutes(app);

// ── Frontend, only where it is deployed beside the API ───
//
// Vercel serves the frontend today and Render serves only the API, so this
// is off unless SERVE_CLIENT=1 — both keep behaving exactly as they do now.
// Hostinger runs one process for both, and sets the flag.
//
// Hostinger's deploy root is server/, so nothing above it exists at
// runtime. server/public/ holds the pages and client/ for that reason.
//
// Serving public/ is safe by structure rather than by pattern: it is a
// sibling of src/, db/ and .env, and express.static cannot reach a
// sibling — so no backend file is publishable through it at all.
//
// Every href and src in the HTML is relative (no leading slash), so the
// pages need no change to be served from here: /client/* resolves inside
// public/, and /shared/* is mapped below.
// A deploy can change which scripts a page pulls in. A browser holding the
// previous HTML then runs the old markup against the new assets and misses a
// <script> that only the new page lists - which is exactly how a missing PDF
// helper survived a deploy and looked like a code bug. So HTML is revalidated
// on every load: no-cache still stores the copy but revalidates before
// reusing it, and express.static's ETag/Last-Modified turn that check into
// a cheap 304 rather than a full re-download.
//
// The assets the page references are deliberately left alone. They carry
// ?v=NN, so the query IS their cache key - a changed asset arrives under a
// URL nothing has cached, and an unchanged one stays cacheable at the CDN.
function cacheControlForStatic(res, filePath) {
  if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
}

if (process.env.SERVE_CLIENT === '1') {
  app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: cacheControlForStatic }));
  // The browser loads the same district and return-rule files the API
  // validates against, so both are served from the one copy in server/
  // rather than a second one inside public/.
  app.use('/shared', express.static(path.join(__dirname, '..', 'shared'), { setHeaders: cacheControlForStatic }));
}

// Any /api/* path that no route above claimed. Without this Express
// falls through to its own HTML 404 page, which the browser's
// res.json() can't parse — so a typo'd endpoint surfaced as a confusing
// "Request failed (404)" instead of naming the path.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: { message: `No such endpoint: ${req.method} ${req.originalUrl}`, code: 'not_found' }
  });
});

// Must be mounted last — Express only routes an error to this once no
// earlier route/middleware has already sent a response.
app.use(errorHandler);

// Last-resort guards. asyncRoute covers every route handler, but a
// rejection raised OUTSIDE a request (a background scan job in
// services/scanJobs.js, a pool-level error, a stray timer) has no
// request to fail and would otherwise either kill the process on a
// modern Node or vanish silently. Logged, not swallowed — and
// deliberately NOT exited on, because dropping the process would take
// every in-flight invoice save down with it.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

// Reports schema drift at boot — it does NOT apply anything.
//
// Migrations run as their own deploy step (`npm run migrate`), never on
// startup: this service is a single free-tier instance that spins down on
// idle, so boot happens often and unattended, and a migration failing there
// would take the API down in a restart loop with no operator watching. See
// db/MIGRATIONS.md.
//
// But a silent drift is what caused three production incidents, so boot is
// where it gets said out loud. Advisory only — the server still starts,
// because refusing to boot would turn "some writes fail" into "nothing
// works", and the operator needs the app up to diagnose it.
function reportPendingMigrations() {
  const { run } = require('./db/migrator');
  const pool = require('./config/pool');
  const lines = [];
  run(pool, { mode: 'status', log: (l) => lines.push(l) })
    .then((r) => {
      if (r.pending.length) {
        console.warn('  ' + '!'.repeat(64));
        console.warn(`  !! ${r.pending.length} PENDING MIGRATION(S) — this database is behind the code`);
        r.pending.forEach((id) => console.warn(`  !!   ${id}`));
        console.warn('  !! Writes touching new columns will fail with 42703 until you run:');
        console.warn('  !!   npm run migrate');
        console.warn('  ' + '!'.repeat(64));
      } else {
        console.log('  Migrations: up to date');
      }
    })
    .catch((err) => {
      // Never fatal. A brand-new database has no schema_migrations table
      // yet, and a permissions problem here must not stop the API serving.
      console.warn(`  Migrations: could not be checked (${err.message})`);
    });
}

app.listen(PORT, () => {
  console.log(`GST Billing backend listening on http://localhost:${PORT}`);
  console.log(`  Database: ${process.env.DATABASE_URL ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  reportPendingMigrations();
});
