// =============================================
// Supabase Configuration
// Replace with your actual credentials from supabase.com
// Project Settings → API → Project URL + anon public key
// =============================================
const SUPABASE_URL      = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Auto-switch: LocalStorage mode when Supabase not configured
// localdb.js must be loaded before this script on every page
const IS_LOCAL_MODE = (SUPABASE_URL === 'YOUR_SUPABASE_PROJECT_URL');

let _supabase;
if (IS_LOCAL_MODE) {
  _supabase = new LocalSupabase();
} else {
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
}

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
