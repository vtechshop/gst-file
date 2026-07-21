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
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const backupRoutes = require('./routes/backup');
const invoiceRoutes = require('./routes/invoices');
const purchaseRoutes = require('./routes/purchases');
const salesReturnRoutes = require('./routes/sales-returns');
const paymentsRoutes = require('./routes/payments');
const uploadRoutes = require('./routes/uploads');
const productSyncRoutes = require('./routes/product-sync');
const { mountGenericRoutes } = require('./routes/generic');
const { errorHandler } = require('./middleware/errorHandler');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();

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
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use('/api/auth', authRoutes);
// Mounted at its own sub-path, not bare /api — backupRoutes applies
// requireAuth to every path under wherever it's mounted (router.use with
// no path arg), so mounting it at bare /api would gate every OTHER /api/*
// route behind it too, regardless of registration order.
app.use('/api/backup', backupRoutes);
app.use('/api/invoices', invoiceRoutes);
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
mountGenericRoutes(app);

// Must be mounted last — Express only routes an error to this once no
// earlier route/middleware has already sent a response.
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`GST Billing backend listening on http://localhost:${PORT}`);
  console.log(`  Database: ${process.env.DATABASE_URL ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
