// =============================================
// Product Sync Backend — secure proxy
//
//   Billing System Frontend
//           │  (no secrets, no key)
//           ▼
//   Billing Backend  (this file)  /api/product-sync
//           │  (WEBSITE_PRODUCT_API_KEY, from .env only)
//           ▼
//   Website Product API (authenticated)
//           │
//           ▼
//   Website Database
//
// The frontend (js/product-sync.js) never sees WEBSITE_PRODUCT_API_KEY —
// it only ever calls this server, over CORS restricted to ALLOWED_ORIGIN.
// This process holds the secret in memory (loaded from .env, which is
// git-ignored) and attaches it to the one outbound call to the real
// website API. See .env.example for the variables this needs.
// =============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const backupRoutes = require('./routes/backup');
const invoiceRoutes = require('./routes/invoices');
const uploadRoutes = require('./routes/uploads');
const { mountGenericRoutes } = require('./routes/generic');
const { errorHandler } = require('./middleware/errorHandler');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',').map(s => s.trim()).filter(Boolean);
const WEBSITE_PRODUCT_API_URL = process.env.WEBSITE_PRODUCT_API_URL || '';
const WEBSITE_PRODUCT_API_KEY = process.env.WEBSITE_PRODUCT_API_KEY || '';

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
// route behind it too (product-sync/health included), regardless of
// registration order.
app.use('/api/backup', backupRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/uploads', uploadRoutes);
mountGenericRoutes(app);

// Simple health/status check — never returns the key itself, only
// whether one is configured, so this is safe to leave public.
app.get('/api/product-sync/health', (req, res) => {
  res.json({
    ok: true,
    websiteConfigured: !!WEBSITE_PRODUCT_API_URL,
    keyConfigured: !!WEBSITE_PRODUCT_API_KEY
  });
});

// Some product catalog APIs (this one included — response shape
// { success, data: [...], meta: { total, page, limit } }) paginate.
// This walks every page server-side so the frontend always gets one
// flat, complete list — it never has to know the upstream API paginates.
const WEBSITE_PRODUCT_PAGE_SIZE = parseInt(process.env.WEBSITE_PRODUCT_PAGE_SIZE) || 50;
const WEBSITE_PRODUCT_MAX_PAGES = parseInt(process.env.WEBSITE_PRODUCT_MAX_PAGES) || 50; // safety cap

app.get('/api/product-sync', async (req, res) => {
  if (!WEBSITE_PRODUCT_API_URL) {
    return res.status(503).json({ error: 'WEBSITE_PRODUCT_API_URL is not set on the backend (server/.env).' });
  }

  try {
    const headers = { Accept: 'application/json' };
    if (WEBSITE_PRODUCT_API_KEY) headers.Authorization = `Bearer ${WEBSITE_PRODUCT_API_KEY}`;

    const allItems = [];
    let page = 1;
    let expectedTotal = null;

    while (page <= WEBSITE_PRODUCT_MAX_PAGES) {
      const sep = WEBSITE_PRODUCT_API_URL.includes('?') ? '&' : '?';
      const pageUrl = `${WEBSITE_PRODUCT_API_URL}${sep}page=${page}&limit=${WEBSITE_PRODUCT_PAGE_SIZE}`;
      const upstream = await fetch(pageUrl, { headers });
      if (!upstream.ok) {
        return res.status(502).json({ error: `Website product API returned HTTP ${upstream.status}` });
      }

      const payload = await upstream.json();
      const items = Array.isArray(payload) ? payload : (payload.data || payload.products || []);
      if (!Array.isArray(items)) {
        return res.status(502).json({ error: 'Unexpected response shape from website product API.' });
      }
      allItems.push(...items);

      // Stop once: a non-paginated API (no meta) has returned its one
      // page, a page comes back short (last page), or we've reached the
      // website's own reported total — whichever happens first.
      const meta = Array.isArray(payload) ? null : payload.meta;
      if (!meta || items.length === 0) break;
      if (meta.total !== undefined) expectedTotal = meta.total;
      if (items.length < WEBSITE_PRODUCT_PAGE_SIZE) break;
      if (expectedTotal !== null && allItems.length >= expectedTotal) break;
      page++;
    }

    res.json({ products: allItems, meta: { total: allItems.length, pagesFetched: page } });
  } catch (err) {
    // Nothing about the key or the failure is leaked beyond a generic
    // message — the frontend's existing fallback logic (js/product-sync.js)
    // already keeps using its last-synced product data on any error here.
    res.status(502).json({ error: 'Failed to reach the website product API.' });
  }
});

// Must be mounted last — Express only routes an error to this once no
// earlier route/middleware has already sent a response.
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`GST Billing backend listening on http://localhost:${PORT}`);
  console.log(`  Database: ${process.env.DATABASE_URL ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  Website product API configured: ${!!WEBSITE_PRODUCT_API_URL}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
