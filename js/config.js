// =============================================
// Backend API Configuration
// Points at localhost:4000 automatically during local dev (this file
// served from 127.0.0.1/localhost), and at the deployed Render backend
// everywhere else (e.g. the Vercel-hosted production site) — no manual
// toggling needed between the two.
// js/apiClient.js must be loaded before this script on every page.
// =============================================
const IS_LOCAL_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE_URL = IS_LOCAL_DEV ? 'http://localhost:4000/api' : 'https://gst-file.onrender.com/api';

const _supabase = new ApiClient();

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
const PRODUCT_SYNC_BACKEND_URL = IS_LOCAL_DEV ? 'http://localhost:4000/api/product-sync' : 'https://gst-file.onrender.com/api/product-sync';
const IS_PRODUCT_SYNC_CONFIGURED = PRODUCT_SYNC_BACKEND_URL !== 'YOUR_PRODUCT_SYNC_BACKEND_URL' && !!PRODUCT_SYNC_BACKEND_URL;
