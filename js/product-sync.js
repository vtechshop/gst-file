// =============================================
// Product Sync — mirrors each company's OWN website Product Master
// Every account here is a different company with its own website — the
// website is that company's single source of truth for its products,
// synced into that company's own products rows (user_id-scoped). The
// one deliberate exception is the "Quick Add Product" local-draft flow
// in js/invoice-items.js, which is explicitly excluded from sync by
// having no external_id and source:'local'.
//
// This file NEVER holds a website API key. It only calls our own
// backend proxy at PRODUCT_SYNC_BACKEND_URL (js/config.js), with the
// user's own JWT attached — server/routes/product-sync.js looks up
// THAT company's product_api_url/product_api_key from its own profiles
// row (never a shared/global credential) and makes the authenticated
// call to that company's website on our behalf. Until a company sets
// its Product API URL in Business Profile, sync stays inert ("Not
// Configured") for that company only and nothing here touches the
// products table.
//
// mapRemoteProduct() below is mapped to one confirmed response shape
// (see its own comment) — every company syncs through the same mapper,
// so a company whose website API returns a differently-shaped response
// would need that mapper adjusted to branch on shape, which isn't done
// here (out of scope for the per-company URL/key isolation fix this
// file is otherwise about).
// =============================================

const PRODUCT_SYNC_LAST_ATTEMPT_KEY = 'gst_sync_last_attempt_at';
const PRODUCT_SYNC_META_KEY = 'gst_product_sync_meta';
const PRODUCT_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000; // auto-refresh threshold
const PRODUCT_SYNC_RETRY_COOLDOWN_MS = 60 * 1000; // throttle repeat attempts, but never lock out for the whole tab session

function getProductSyncMeta() {
  try {
    return JSON.parse(localStorage.getItem(PRODUCT_SYNC_META_KEY) || 'null')
      || { lastSyncAt: null, status: 'never', message: '' };
  } catch {
    return { lastSyncAt: null, status: 'never', message: '' };
  }
}

function setProductSyncMeta(meta) {
  localStorage.setItem(PRODUCT_SYNC_META_KEY, JSON.stringify(meta));
  try { window.dispatchEvent(new CustomEvent('productSyncUpdated', { detail: meta })); } catch {}
}

// "2 hours ago" / "3 minutes ago" / "Never" — shared by the Products
// page status bar and the invoice-entry sync notice.
function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'Just now';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  return day + (day === 1 ? ' day ago' : ' days ago');
}

function isProductSyncStale(meta) {
  meta = meta || getProductSyncMeta();
  if (!meta.lastSyncAt) return true;
  return (Date.now() - new Date(meta.lastSyncAt).getTime()) > PRODUCT_SYNC_MAX_AGE_MS;
}

// Called from js/auth.js's requireAuth() on every page. Auto-refreshes
// in the background only for an account that has already synced at
// least once and is now stale (>24h since lastSyncAt) — once that
// succeeds, lastSyncAt is recent again so this naturally stays quiet
// until the next 24h boundary.
//
// A brand-new or never-synced account (zero rows in its own Product
// Master) is deliberately left alone here — no auto-trigger, even
// though the old behavior used to sync immediately in that case. That
// made every fresh account silently populate itself with the shared
// company catalog the moment it first logged in, which is easy to
// mistake for another account's data leaking in during multi-account
// testing (it isn't — each account gets its own independently-scoped
// rows — but it looks exactly like it from the outside). Sync for a
// zero-product account only ever happens via an explicit "Sync Now"
// click (runManualSync() below), never automatically.
//
// A prior version of this function used a one-shot "already attempted
// this session" sessionStorage flag to stop a failed sync from being
// retried on every page navigation. That was a real bug: the flag was
// set unconditionally on the FIRST attempt and then never cleared, so
// if that first attempt happened before the backend was configured or
// running, every later page load for the rest of that tab's lifetime
// silently skipped syncing entirely — even after the backend came up —
// with no way to recover short of closing the tab. Fixed by using a
// timestamp-based cooldown instead: repeat attempts are throttled to at
// most once every PRODUCT_SYNC_RETRY_COOLDOWN_MS, but never blocked
// outright, so the very next page load after the cooldown elapses picks
// up a since-fixed backend automatically. Never awaited by callers —
// sync always happens in the background and never blocks a page
// (requirement 4/7).
async function syncProductsIfNeeded(userId) {
  if (!userId) return;

  let hasNoProducts = true;
  try {
    const { data } = await _supabase.from('products').select('id').eq('user_id', userId);
    hasNoProducts = !data || data.length === 0;
  } catch {
    // Can't tell — fall through to the normal staleness/cooldown path
    // rather than assuming empty and hammering the backend.
    hasNoProducts = false;
  }

  // Zero products for this account — stay empty until the user
  // explicitly syncs. See the comment above for why this is no longer
  // an auto-trigger.
  if (hasNoProducts) return;

  if (!isProductSyncStale()) return;

  const lastAttemptAt = +sessionStorage.getItem(PRODUCT_SYNC_LAST_ATTEMPT_KEY) || 0;
  if (Date.now() - lastAttemptAt < PRODUCT_SYNC_RETRY_COOLDOWN_MS) return;

  sessionStorage.setItem(PRODUCT_SYNC_LAST_ATTEMPT_KEY, String(Date.now()));
  syncProducts(userId);
}

// Also called directly by the "Sync Now" button on products.html,
// bypassing the once-per-session gate.
async function syncProducts(userId) {
  if (!IS_PRODUCT_SYNC_CONFIGURED) {
    // This only means "our backend isn't deployed at all" — a company
    // that hasn't set its own Product API URL yet gets a distinct
    // 'not_configured' status below instead (a 503 from the backend
    // itself), not this one.
    setProductSyncMeta({
      lastSyncAt: getProductSyncMeta().lastSyncAt,
      status: 'not_configured',
      message: 'Product Sync backend is not deployed yet.'
    });
    return { ok: false, reason: 'not_configured' };
  }

  try {
    // The JWT is what lets the backend know WHICH company's own
    // product_api_url/product_api_key to use — see
    // server/routes/product-sync.js. The key itself never comes back
    // to this file; only the resulting product list does.
    const token = localStorage.getItem('gst_jwt');
    const res = await fetch(PRODUCT_SYNC_BACKEND_URL, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = body?.error || ('HTTP ' + res.status);
      if (res.status === 503) {
        // This company hasn't configured its own Product API URL yet —
        // a normal, expected state, not a failure.
        setProductSyncMeta({ lastSyncAt: getProductSyncMeta().lastSyncAt, status: 'not_configured', message });
        return { ok: false, reason: 'not_configured' };
      }
      throw new Error(message);
    }
    const payload = await res.json();
    const remoteRaw = Array.isArray(payload) ? payload : (payload.products || payload.data || null);
    if (!Array.isArray(remoteRaw)) throw new Error('Unexpected response shape from product sync endpoint');

    const result = await applyProductSync(userId, remoteRaw);

    setProductSyncMeta({
      lastSyncAt: new Date().toISOString(),
      status: 'success',
      message: `Synced ${result.total} product(s) — ${result.inserted} new, ${result.updated} updated`
        + (result.skippedInvalid ? `, ${result.skippedInvalid} unavailable (kept last known version)` : '')
    });
    return { ok: true, ...result };
  } catch (err) {
    // Failure never touches existing product rows — the app keeps
    // using whatever was last synced (or local data) as-is.
    setProductSyncMeta({
      lastSyncAt: getProductSyncMeta().lastSyncAt,
      status: 'error',
      message: err?.message || 'Product sync failed'
    });
    return { ok: false, reason: err?.message };
  }
}

// Mapped to the confirmed real shape of GET /catalog/products from
// https://api.vtechkitchen.com (verified directly against a live
// response, not guessed). Two fields the Billing System wants have no
// equivalent in this API at all and are left blank on purpose rather
// than invented — see the note above each:
//   - unit: no unit-of-sale field (PCS/KG/NOS/etc.) exists anywhere in
//     the product schema. `dimensions.unit` is a physical size unit
//     (in/cm), not a sales unit, so it is NOT used here.
//   - category: only `categoryIds` (raw internal ObjectId strings) is
//     returned — no human-readable category name/label anywhere in
//     this response. Storing the opaque IDs would be worse than
//     leaving this blank, so it's left blank until the website exposes
//     a name for these (e.g. a /catalog/categories endpoint).
function mapRemoteProduct(raw) {
  const hasWarrantyText = raw.hasWarranty && raw.warranty && (raw.warranty.duration || raw.warranty.durationType);
  return {
    external_id: String(raw._id ?? '').trim(),
    name: (raw.title ?? '').trim(),
    sku: raw.sku ?? '',
    category: '', // not available — see file header note
    hsn_code: raw.hsnCode ?? '',
    gst_percentage: raw.taxable === false ? 0 : (+raw.taxRate || 0),
    unit: '', // not available — see file header note
    default_rate: +raw.price || 0,
    warranty: hasWarrantyText ? `${raw.warranty.duration ?? ''} ${raw.warranty.durationType ?? ''}`.trim() : '',
    description: raw.description ?? '',
    image_url: Array.isArray(raw.images) && raw.images.length ? raw.images[0] : '',
    stock: raw.stock !== undefined && raw.stock !== null ? +raw.stock : null,
    active: raw.published !== undefined ? !!raw.published : true
  };
}

const PRODUCT_SYNC_COMPARE_FIELDS = ['name','sku','category','hsn_code','gst_percentage','unit','default_rate','warranty','description','image_url','stock'];

function productPayloadChanged(existing, incoming) {
  return PRODUCT_SYNC_COMPARE_FIELDS.some(f => String(existing[f] ?? '') !== String(incoming[f] ?? ''));
}

// No soft-delete/Recycle Bin exists anymore, so sync only ever adds or
// updates a product — it never removes one. A product the website marks
// unpublished, or that's missing entirely from this response, is simply
// left untouched (whatever's already stored here stands) rather than
// deleted, since an automated sync silently hard-deleting inventory on
// a false negative (a pagination glitch, a temporary unpublish) would be
// far more destructive than leaving stale data for the next successful
// sync to correct.
async function applyProductSync(userId, remoteRaw) {
  const mapped = remoteRaw.map(mapRemoteProduct);

  const { data: existing } = await _supabase.from('products').select('*').eq('user_id', userId);
  const existingByExternalId = {};
  (existing || []).forEach(p => { if (p.external_id) existingByExternalId[p.external_id] = p; });

  let inserted = 0, updated = 0, skippedInvalid = 0;

  for (const rp of mapped) {
    if (!rp.external_id) continue; // no id at all — can't match to anything, ignore entirely

    if (!rp.name || !rp.active) {
      // A product came back unavailable/incomplete/unpublished this
      // sync — keep the last synchronized version untouched rather than
      // overwrite it with junk or remove it.
      skippedInvalid++;
      continue;
    }

    const match = existingByExternalId[rp.external_id];
    const payload = {
      user_id: userId, name: rp.name, sku: rp.sku, category: rp.category,
      hsn_code: rp.hsn_code, type: 'goods', gst_percentage: rp.gst_percentage, unit: rp.unit,
      default_rate: rp.default_rate, warranty: rp.warranty, description: rp.description,
      image_url: rp.image_url, stock: rp.stock, external_id: rp.external_id, source: 'synced'
    };
    if (match) {
      if (productPayloadChanged(match, payload)) {
        await _supabase.from('products').update(payload).eq('id', match.id);
        updated++;
      }
    } else {
      await _supabase.from('products').insert(payload);
      inserted++;
    }
  }

  return { total: mapped.filter(p => p.external_id && p.name).length, inserted, updated, skippedInvalid };
}
