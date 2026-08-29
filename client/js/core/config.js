// =============================================
// Backend API Configuration
// Points at localhost:4000 automatically during local dev (this file
// served from 127.0.0.1/localhost), and at the deployed Render backend
// everywhere else (e.g. the Vercel-hosted production site) — no manual
// toggling needed between the two.
// js/apiClient.js must be loaded before this script on every page.
// =============================================
const IS_LOCAL_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);
// Vercel keeps calling the Render API, exactly as it does today. Anywhere
// else in production — Hostinger, where one process serves both — the API
// is same-origin, so a relative base is right and there is no CORS hop.
const IS_VERCEL = location.hostname.endsWith('vercel.app');
const API_BASE_URL = IS_LOCAL_DEV ? 'http://localhost:4000/api'
  : IS_VERCEL ? 'https://gst-file.onrender.com/api'
  : '/api';

const _supabase = new ApiClient();

// Wired here because config.js is loaded immediately after apiClient.js
// on every page (including index.html, which loads nothing else), so
// this is the earliest single point that runs everywhere. See
// installGlobalErrorHandlers() in js/apiClient.js for what it catches.
installGlobalErrorHandlers();

// ── Feature flags ─────────────────────────────
// Toggle these on once the corresponding integration is built.
// Keeping them here (rather than scattered checks) is the hook
// point for GSTR-3B (already implemented), E-Invoice IRN
// generation, and E-Way Bill generation.
const FEATURE_FLAGS = {
  gstr3b: true,
  eInvoice: false,
  eWayBill: false
};

// ── Product Sync (js/product-sync.js) ─────────
// The company website's Product Master is the single source of truth.
// This frontend NEVER holds the website's API key — it only calls our
// own backend proxy (server/index.js), which holds the real secret in
// server/.env and makes the authenticated call to the website on our
// behalf. See server/README.md for setup.
//
// Same local-dev/production split as API_BASE_URL above — sync stays
// gracefully inert (status "Not Configured") until WEBSITE_PRODUCT_API_URL
// is actually set on the backend, zero network calls either way.
const PRODUCT_SYNC_BACKEND_URL = IS_LOCAL_DEV ? 'http://localhost:4000/api/product-sync'
  : IS_VERCEL ? 'https://gst-file.onrender.com/api/product-sync'
  : '/api/product-sync';

// ── Invoice QR verification ────────────────────────────────
// Where a scanned invoice QR lands. Deliberately FIXED rather than taken
// from location.origin: a PDF is a document that outlives the session that
// produced it and gets forwarded, printed and filed, so the address printed
// on it has to be the one that will still answer months later - not whichever
// host happened to render it. Kept as one constant so moving to the final
// custom domain is a one-line change.
const INVOICE_VERIFY_BASE_URL = 'https://lemonchiffon-finch-880646.hostingersite.com';

// Compact by design: the QR carries an address, never the invoice itself.
// Encoding the figures would make the paper the source of truth, and a
// forged or stale copy would verify against itself; a lookup by id makes the
// database answer instead.
function invoiceVerifyUrl(type, id) {
  if (!type || !id) return '';
  return INVOICE_VERIFY_BASE_URL + '/verify.html?t='
    + encodeURIComponent(type) + '&id=' + encodeURIComponent(id);
}

// The ONE address a warranty is verified at. The QR and the NFC tag both
// carry this and nothing else: encode the cover itself and the tag becomes
// the source of truth, so a cancelled warranty would keep verifying against
// its own copy. A lookup by id makes the database answer, which is also why
// a status change needs no tag to be rewritten.
function warrantyVerifyUrl(id) {
  if (!id) return '';
  return INVOICE_VERIFY_BASE_URL + '/warranty-verify.html?id=' + encodeURIComponent(id);
}

const IS_PRODUCT_SYNC_CONFIGURED = PRODUCT_SYNC_BACKEND_URL !== 'YOUR_PRODUCT_SYNC_BACKEND_URL' && !!PRODUCT_SYNC_BACKEND_URL;
