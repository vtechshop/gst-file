// =============================================
// Product Master — synced mirror of the company website
// (js/product-sync.js is the single source of truth writer here).
// This page is a viewer/manager: synced rows are read-only (edited
// on the website, reflected automatically on next sync); the only
// products creatable in-app are "Local Draft" rows made via Quick
// Add during invoice entry (js/invoice-items.js), which stay local
// and untouched by sync until the matching product exists on the
// website and someone deletes the draft.
// =============================================
let prodAllData = [];
let prodPage = 1;
const PROD_PAGE = 15;
let prodCurrentUserId = null;

async function initProducts() {
  const user = await requireAuth();
  if (!user) return;
  prodCurrentUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupProdSearch();
  await loadProducts(user.id);
  applyIncomingSearchQuery('prodSearch');
  renderSyncStatusBar();
  window.addEventListener('productSyncUpdated', async () => {
    await loadProducts(user.id);
    renderSyncStatusBar();
  });
}

// ── Sync status bar ────────────────────────────
function renderSyncStatusBar() {
  const meta = getProductSyncMeta();
  const dot = document.getElementById('syncDot');
  const lastTime = document.getElementById('syncLastTime');
  const statusText = document.getElementById('syncStatusText');
  const totalCount = document.getElementById('syncTotalCount');
  if (lastTime) {
    lastTime.textContent = formatRelativeTime(meta.lastSyncAt);
    lastTime.title = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('en-IN') : '';
  }
  if (totalCount) totalCount.textContent = prodAllData.filter(p => p.source === 'synced').length;

  const stale = isProductSyncStale(meta);
  const labels = {
    success: { text: (meta.message || 'Synced') + (stale ? ' — due for refresh' : ''), color: stale ? '#f57c00' : '#2e7d32' },
    error: { text: `Using cached products (${meta.message || 'sync failed'})`, color: '#f57c00' },
    not_configured: { text: 'Not Configured — using cached/local products', color: '#9e9e9e' },
    never: { text: 'Never Synced', color: '#9e9e9e' }
  };
  const s = labels[meta.status] || labels.never;
  if (statusText) { statusText.textContent = s.text; }
  if (dot) dot.style.background = s.color;
}

async function runManualSync() {
  const btn = document.getElementById('syncNowBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...'; }
  const statusText = document.getElementById('syncStatusText');
  if (statusText) statusText.textContent = 'Syncing…';

  const result = await syncProducts(prodCurrentUserId);
  await loadProducts(prodCurrentUserId);
  renderSyncStatusBar();

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync"></i> Sync Now'; }
  if (result.ok) showToast(`Product sync complete — ${result.inserted} new, ${result.updated} updated, ${result.deactivated} deactivated.`, 'success');
  else if (result.reason === 'not_configured') showToast('Product sync is not configured yet (set PRODUCT_SYNC_BACKEND_URL in js/config.js).', 'warning');
  else showToast('Product sync failed: ' + result.reason, 'error');
}

async function loadProducts(userId) {
  const { data } = await _supabase.from('products').select('*').eq('user_id', userId).order('name', { ascending: true });
  prodAllData = (data || []).filter(r => !r.is_deleted);
  prodPage = 1;
  renderProdTable(prodAllData);
}

function renderProdTable(data) {
  const tbody = document.getElementById('prodTableBody');
  if (!tbody) return;

  const start = (prodPage - 1) * PROD_PAGE;
  const page  = data.slice(start, start + PROD_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state"><i class="fas fa-box table-loading-icon"></i>No products yet. Run a product sync, or add one from an invoice via Quick Add.</td></tr>';
    renderProdPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td>
        ${r.image_url ? `<img src="${escProdHtml(r.image_url)}" alt="" style="width:24px;height:24px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;" onerror="this.style.display='none'">` : ''}
        <b>${escProdHtml(r.name)}</b>
      </td>
      <td>${escProdHtml(r.sku) || '&mdash;'}</td>
      <td>${escProdHtml(r.category) || '&mdash;'}</td>
      <td>${escProdHtml(r.hsn_code) || '&mdash;'}</td>
      <td>${escProdHtml(r.unit) || '&mdash;'}</td>
      <td class="text-center">${r.gst_percentage}%</td>
      <td class="text-right">&#8377;${formatNum(r.default_rate)}</td>
      <td>${escProdHtml(r.warranty) || '&mdash;'}</td>
      <td>${r.source === 'synced'
        ? '<span class="badge badge-blue" title="Managed on the company website — updates automatically on sync"><i class="fas fa-sync"></i> Synced</span>'
        : '<span class="badge badge-orange" title="Created via Quick Add on an invoice — not on the website yet">Local Draft</span>'}</td>
      <td>
        ${r.source === 'local'
          ? `<div class="action-btns"><button class="btn btn-danger btn-sm btn-icon" onclick="deleteProduct('${r.id}')" title="Delete draft"><i class="fas fa-trash"></i></button></div>`
          : '<span class="text-muted-sm fs-11">&mdash;</span>'}
      </td>
    </tr>`).join('');

  renderProdPagination(data.length);
}

function escProdHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function renderProdPagination(total) {
  const c = document.getElementById('prodPagination');
  if (!c) return;
  const pages = Math.ceil(total / PROD_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="prodPage=${prodPage-1};renderProdTable(prodAllData)" ${prodPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===prodPage?'active':''}" onclick="prodPage=${i};renderProdTable(prodAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="prodPage=${prodPage+1};renderProdTable(prodAllData)" ${prodPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

// Only local-draft products (Quick Add) can be deleted from here —
// synced products are removed by removing them on the website, which
// the next sync reflects automatically.
async function deleteProduct(id) {
  const rec = prodAllData.find(r => r.id === id);
  if (!rec || rec.source !== 'local') return;
  const ok = await showConfirm('Delete this local draft product? You can restore it later from Recycle Bin.');
  if (!ok) return;
  const { error } = await _supabase.from('products').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Product moved to Recycle Bin.');
  prodAllData = prodAllData.filter(r => r.id !== id);
  renderProdTable(prodAllData);
}

function setupProdSearch() {
  document.getElementById('prodSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? prodAllData.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.hsn_code || '').toLowerCase().includes(q) ||
      (r.sku || '').toLowerCase().includes(q) ||
      (r.category || '').toLowerCase().includes(q)
    ) : prodAllData;
    prodPage = 1;
    renderProdTable(filtered);
  });
}

// Exposed for other pages (B2B/B2C invoice entry auto-fill, HSN
// display, Excel import auto-classification)
async function loadProductsList(userId) {
  const { data } = await _supabase.from('products').select('*').eq('user_id', userId);
  return (data || []).filter(r => !r.is_deleted);
}

function findProductByName(list, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return list.find(p => p.name.toLowerCase() === n) || null;
}
