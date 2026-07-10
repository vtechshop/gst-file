// =============================================
// Product Master Logic
// =============================================
let prodEditId = null;
let prodAllData = [];
let prodPage = 1;
const PROD_PAGE = 15;

async function initProducts() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupProdSearch();
  await loadProducts(user.id);
  applyIncomingSearchQuery('prodSearch');
}

async function saveProduct() {
  const user = await getCurrentUser();
  if (!user) return;

  const name = document.getElementById('prodName')?.value?.trim();
  const hsn  = document.getElementById('prodHSN')?.value?.trim();
  const type = document.getElementById('prodType')?.value;
  const gstPct = parseFloat(document.getElementById('prodGstPct')?.value) || 0;
  const rate = parseFloat(document.getElementById('prodRate')?.value) || 0;

  if (!name) { showToast('Product name is required.', 'error'); return; }

  const payload = { user_id: user.id, name, hsn_code: hsn, type, gst_percentage: gstPct, default_rate: rate };

  let error;
  if (prodEditId) {
    ({ error } = await _supabase.from('products').update(payload).eq('id', prodEditId));
  } else {
    const dup = prodAllData.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (dup) { showToast('Product already exists!', 'warning'); return; }
    ({ error } = await _supabase.from('products').insert(payload));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(prodEditId ? 'Product updated!' : 'Product saved!');
  prodEditId = null;
  resetProduct();
  await loadProducts(user.id);
}

function resetProduct() {
  const name = document.getElementById('prodName'); if (name) name.value = '';
  const hsn  = document.getElementById('prodHSN');  if (hsn) hsn.value = '';
  const rate = document.getElementById('prodRate'); if (rate) rate.value = '';
  const type = document.getElementById('prodType'); if (type) type.value = 'goods';
  const pct  = document.getElementById('prodGstPct'); if (pct) pct.value = '18';
  prodEditId = null;
  const title = document.getElementById('prodFormTitle');
  if (title) title.textContent = 'Add Product';
  const btn = document.getElementById('prodSaveBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> Save Product';
}

async function loadProducts(userId) {
  const { data } = await _supabase.from('products').select('*').eq('user_id', userId).order('name', { ascending: true });
  prodAllData = data || [];
  prodPage = 1;
  renderProdTable(prodAllData);
}

function renderProdTable(data) {
  const tbody = document.getElementById('prodTableBody');
  if (!tbody) return;

  const start = (prodPage - 1) * PROD_PAGE;
  const page  = data.slice(start, start + PROD_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-box table-loading-icon"></i>No products found. Add your first product!</td></tr>';
    renderProdPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td><b>${r.name}</b></td>
      <td>${r.hsn_code || '&mdash;'}</td>
      <td><span class="badge badge-green">${r.type}</span></td>
      <td class="text-center">${r.gst_percentage}%</td>
      <td class="text-right">&#8377;${formatNum(r.default_rate)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editProduct('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteProduct('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  renderProdPagination(data.length);
}

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

function editProduct(id) {
  const rec = prodAllData.find(r => r.id === id);
  if (!rec) return;
  prodEditId = id;
  document.getElementById('prodName').value = rec.name || '';
  document.getElementById('prodHSN').value = rec.hsn_code || '';
  document.getElementById('prodType').value = rec.type || 'goods';
  document.getElementById('prodGstPct').value = rec.gst_percentage ?? 18;
  document.getElementById('prodRate').value = rec.default_rate || '';
  document.getElementById('prodFormTitle').textContent = 'Edit Product';
  document.getElementById('prodSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Product';
  document.getElementById('prodName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteProduct(id) {
  const ok = await showConfirm('Delete this product?');
  if (!ok) return;
  const { error } = await _supabase.from('products').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Product deleted!');
  prodAllData = prodAllData.filter(r => r.id !== id);
  renderProdTable(prodAllData);
}

function setupProdSearch() {
  document.getElementById('prodSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? prodAllData.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.hsn_code || '').toLowerCase().includes(q)
    ) : prodAllData;
    prodPage = 1;
    renderProdTable(filtered);
  });
}

// Exposed for other pages (B2B/B2C/HSN auto-fill, Excel import auto-classification)
async function loadProductsList(userId) {
  const { data } = await _supabase.from('products').select('*').eq('user_id', userId);
  return data || [];
}

function findProductByName(list, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return list.find(p => p.name.toLowerCase() === n) || null;
}

function findProductByHSN(list, hsn) {
  if (!hsn) return null;
  return list.find(p => (p.hsn_code || '').toLowerCase() === String(hsn).trim().toLowerCase()) || null;
}
