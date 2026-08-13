// Product Sync — per-company Product Master mirror.
//
// Every registered account represents a different company, each with
// its own website and product catalog. This router looks up the
// LOGGED-IN user's own product_api_url/product_api_key from their
// profiles row (never a process-wide env var) and proxies to that
// company's product API only. The frontend (js/product-sync.js) never
// sees product_api_key — it only ever calls this server, over CORS
// restricted to ALLOWED_ORIGIN, with its own JWT attached.
//
// product_api_key never round-trips back to the browser once saved:
// GET /config reports only whether one is set (has_key), never its
// value. PATCH /config only overwrites it when a new non-empty value
// is sent, or clears it when clear_key is explicitly true.
const express = require('express');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

const WEBSITE_PRODUCT_PAGE_SIZE = parseInt(process.env.WEBSITE_PRODUCT_PAGE_SIZE) || 50;
const WEBSITE_PRODUCT_MAX_PAGES = parseInt(process.env.WEBSITE_PRODUCT_MAX_PAGES) || 50; // safety cap

router.get('/config', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT product_api_url, (product_api_key IS NOT NULL AND product_api_key <> \'\') AS has_key FROM profiles WHERE id = $1',
    [req.userId]
  );
  const row = rows[0] || { product_api_url: null, has_key: false };
  res.json({ product_api_url: row.product_api_url || '', has_key: !!row.has_key });
}));

router.patch('/config', asyncRoute(async (req, res) => {
  const { product_api_url, product_api_key, clear_key } = req.body;
  const sets = [];
  const values = [];
  if (product_api_url !== undefined) { sets.push(`product_api_url = $${sets.length + 1}`); values.push(product_api_url || null); }
  if (clear_key === true) { sets.push(`product_api_key = $${sets.length + 1}`); values.push(null); }
  else if (product_api_key) { sets.push(`product_api_key = $${sets.length + 1}`); values.push(product_api_key); }

  if (!sets.length) { const e = new Error('No fields to update.'); e.status = 400; e.expose = true; throw e; }

  values.push(req.userId);
  await pool.query(`UPDATE profiles SET ${sets.join(',')} WHERE id = $${values.length}`, values);
  res.json({ ok: true });
}));

// The actual sync fetch — walks the calling company's own product API,
// exactly as the old global-config version did, just parameterized per
// request instead of per process.
router.get('/', asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT product_api_url, product_api_key FROM profiles WHERE id = $1', [req.userId]);
  const profile = rows[0];
  const apiUrl = profile?.product_api_url;
  // Every error body below is the API-wide { error: { message, code } }
  // shape. They used to be a bare { error: '<string>' }, which was the
  // only place in the API that broke that contract — and it broke it
  // invisibly, because js/apiClient.js builds its thrown error by
  // SPREADING body.error: spreading a string yields {0:'P',1:'r',…} with
  // no `message` at all, so any caller reaching these through apiFetch
  // would have shown the user "Error: undefined".
  if (!apiUrl) {
    return res.status(503).json({
      error: {
        message: 'Product Sync is not configured for your company yet — set your Product API URL in Business Profile.',
        code: 'not_configured'
      }
    });
  }

  try {
    const headers = { Accept: 'application/json' };
    if (profile.product_api_key) headers.Authorization = `Bearer ${profile.product_api_key}`;

    const allItems = [];
    let page = 1;
    let expectedTotal = null;

    while (page <= WEBSITE_PRODUCT_MAX_PAGES) {
      const sep = apiUrl.includes('?') ? '&' : '?';
      const pageUrl = `${apiUrl}${sep}page=${page}&limit=${WEBSITE_PRODUCT_PAGE_SIZE}`;
      const upstream = await fetch(pageUrl, { headers });
      if (!upstream.ok) {
        return res.status(502).json({
          error: {
            message: `Your website's product API returned HTTP ${upstream.status}.`,
            code: 'upstream_failed'
          }
        });
      }

      const payload = await upstream.json();
      const items = Array.isArray(payload) ? payload : (payload.data || payload.products || []);
      if (!Array.isArray(items)) {
        return res.status(502).json({
          error: {
            message: "Unexpected response shape from your website's product API.",
            code: 'upstream_failed'
          }
        });
      }
      allItems.push(...items);

      const meta = Array.isArray(payload) ? null : payload.meta;
      if (!meta || items.length === 0) break;
      if (meta.total !== undefined) expectedTotal = meta.total;
      if (items.length < WEBSITE_PRODUCT_PAGE_SIZE) break;
      if (expectedTotal !== null && allItems.length >= expectedTotal) break;
      page++;
    }

    res.json({ products: allItems, meta: { total: allItems.length, pagesFetched: page } });
  } catch (err) {
    // Logged server-side only — nothing about the key or the failure is
    // leaked to the client beyond a generic message. The frontend's
    // existing fallback logic (js/product-sync.js) already keeps using
    // its last-synced product data on any error here.
    console.error('Product sync failed for user', req.userId, ':', err);
    res.status(502).json({
      error: { message: "Could not reach your website's product API.", code: 'upstream_failed' }
    });
  }
}));

module.exports = router;
