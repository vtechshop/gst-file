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
