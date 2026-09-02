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
// Whether this company has a Product API URL at all. Per tab, because it
// changes only when the Business Profile is saved.
const PRODUCT_SYNC_CONFIGURED_KEY = 'gst_product_sync_configured';
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

  // The try/catch this replaces did not do what its comment said. The
  // query builder RESOLVES with { data: null, error } on a failure rather
  // than throwing, so the catch never ran; `data` was null, hasNoProducts
  // came out TRUE, and the function returned early — the exact "assume
  // empty" outcome the comment said it was avoiding, silently disabling
  // the background refresh for as long as the read kept failing.
  // Checked inline rather than through readAll(), deliberately: this is a
  // background probe on EVERY page load, and a toast here would be noise
  // the user can neither act on nor connect to anything they did. The
  // failure still has to be respected, just not announced — "can't tell"
  // falls through to the normal staleness/cooldown path below rather than
  // assuming the account is empty.
  const probe = await _supabase.from('products').select('id').eq('user_id', userId);
  if (probe.error) console.warn('[product-sync] could not check the product list:', probe.error);
  const hasNoProducts = probe.error ? false : (probe.data || []).length === 0;

  // Zero products for this account — stay empty until the user
  // explicitly syncs. See the comment above for why this is no longer
  // an auto-trigger.
  if (hasNoProducts) return;

  if (!isProductSyncStale()) return;

  const lastAttemptAt = +sessionStorage.getItem(PRODUCT_SYNC_LAST_ATTEMPT_KEY) || 0;
  if (Date.now() - lastAttemptAt < PRODUCT_SYNC_RETRY_COOLDOWN_MS) return;

  // Only a company that has actually set a Product API URL is worth syncing.
  // Asked HERE rather than at the top of the function on purpose: this is the
  // last gate before a network call, so a company that is configured pays one
  // cached lookup and a company that is not never issues the sync request at
  // all - which is what stops a 503 not_configured appearing in the Network
  // panel on every page load. See isCompanyProductSyncConfigured().
  if (!(await isCompanyProductSyncConfigured())) return;

  sessionStorage.setItem(PRODUCT_SYNC_LAST_ATTEMPT_KEY, String(Date.now()));
  syncProducts(userId);
}

// Has THIS company configured Product Sync?
//
// Answered by the backend from the profiles row it reads under the verified
// JWT (GET /api/product-sync/config, server/src/routes/product-sync.js) - the
// browser never says which company it is asking about, and the answer cannot
// be influenced by anything held here. The key is never part of it; the
// endpoint reports has_key, never the key itself.
//
// Cached per tab because the answer changes only when someone saves the
// Business Profile, which clears it (forgetCompanyProductSyncConfigured(),
// called from js/pages/profile.js). Without the cache this would simply trade
// a 503 on every page load for a 200 on every page load.
async function isCompanyProductSyncConfigured() {
  if (!IS_PRODUCT_SYNC_CONFIGURED) return false;

  const cached = sessionStorage.getItem(PRODUCT_SYNC_CONFIGURED_KEY);
  if (cached === 'yes') return true;
  if (cached === 'no') return false;

  try {
    const token = localStorage.getItem('gst_jwt');
    const res = await fetch(PRODUCT_SYNC_BACKEND_URL + '/config', {
      headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    });
    // A failed read says nothing about whether the company is configured, so
    // it is NOT cached and NOT announced: this is a background probe, and a
    // toast here would be noise the user can neither act on nor connect to
    // anything they did. The next page load asks again.
    if (!res.ok) return false;
    const cfg = await res.json();
    const configured = !!String((cfg && cfg.product_api_url) || '').trim();
    sessionStorage.setItem(PRODUCT_SYNC_CONFIGURED_KEY, configured ? 'yes' : 'no');
    return configured;
  } catch {
    return false;
  }
}

// Called after the Product Sync settings are saved, so turning sync ON takes
// effect on the very next page load instead of waiting for a new tab.
function forgetCompanyProductSyncConfigured() {
  try { sessionStorage.removeItem(PRODUCT_SYNC_CONFIGURED_KEY); } catch { /* private mode */ }
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
      // apiErrorFrom() (js/apiClient.js) — this used to read body.error
      // as a plain STRING, which only worked because this one endpoint
      // was answering off-contract. It now sends
      // { error: { message, code } } like the rest of the API, and this
      // reads it the same way every other call site does.
      const apiError = apiErrorFrom(res, body);
      if (res.status === 503) {
        // This company hasn't configured its own Product API URL yet —
        // a normal, expected state, not a failure.
        setProductSyncMeta({ lastSyncAt: getProductSyncMeta().lastSyncAt, status: 'not_configured', message: apiError.message });
        return { ok: false, reason: 'not_configured' };
      }
      throw apiError;
    }
    const payload = await res.json();
    const remoteRaw = Array.isArray(payload) ? payload : (payload.products || payload.data || null);
    if (!Array.isArray(remoteRaw)) throw { message: 'Unexpected response shape from the product sync endpoint.', status: 502, code: 'upstream_failed' };

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
    // `error` alongside `reason` so the caller can report this through
    // handleApiError() and keep the status — see js/products.js's
    // syncProductsNow(). `reason` stays for the status-bar text.
    return { ok: false, reason: err?.message, error: err };
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

  // Everything below decides insert-vs-update by looking a product up in
  // this list. A failed read defaulting to an empty list would tell the
  // sync that the account has NO products yet, and it would insert a
  // fresh copy of the entire website catalogue alongside the existing
  // one — duplicating every product, each with its own id, some already
  // referenced by invoices. Thrown instead, and caught by syncProducts(),
  // which leaves existing rows untouched on any failure.
  const existingRead = await readAll([
    _supabase.from('products').select('*').eq('user_id', userId)
  ], 'Could not read your current products');
  if (!existingRead) throw { message: 'Could not read your current products, so nothing was synced.', status: 0, code: 'network' };
  const existing = existingRead[0];
  const existingByExternalId = {};
  existing.forEach(p => { if (p.external_id) existingByExternalId[p.external_id] = p; });

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
