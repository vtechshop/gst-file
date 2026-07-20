// =============================================
// Backend API Configuration
// Point this at wherever server/ (Node.js + Express + PostgreSQL) is
// running — e.g. http://localhost:4000/api for local dev, or your
// deployed backend's URL in production.
// js/apiClient.js must be loaded before this script on every page.
// =============================================
const API_BASE_URL = 'http://localhost:4000/api';

const _supabase = new ApiClient();

// ── TEMPORARY DEV BYPASS — remove or set to false to restore normal login ──
// When true, index.html auto-signs in with a fixed local dev account
// (self-provisioned on first use — see the bottom of index.html) and
// skips straight to dashboard.html, so the login screen is never shown
// during local development. Nothing about real auth changes: the
// backend, JWT/session logic, users/profiles tables, login/register/
// forgot-password APIs, and every page's requireAuth() check are all
// completely untouched — this only automates the one manual sign-in
// step. Flip DEV_AUTO_LOGIN to false (or delete this block) whenever
// you want the real login screen back.
const DEV_AUTO_LOGIN = true;
const DEV_AUTO_LOGIN_EMAIL = 'dev@local.test';
const DEV_AUTO_LOGIN_PASSWORD = 'dev-local-bypass-only';

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
// Point this at wherever that backend is running — e.g.
// 'http://localhost:4000/api/product-sync' for local dev, or your
// deployed backend's URL in production. Left as a placeholder until
// then; sync stays gracefully inert (status "Not Configured") with
// zero network calls and existing product data untouched.
const PRODUCT_SYNC_BACKEND_URL = 'http://localhost:4000/api/product-sync';   // e.g. http://localhost:4000/api/product-sync
const IS_PRODUCT_SYNC_CONFIGURED = PRODUCT_SYNC_BACKEND_URL !== 'YOUR_PRODUCT_SYNC_BACKEND_URL' && !!PRODUCT_SYNC_BACKEND_URL;
