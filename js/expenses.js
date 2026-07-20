// =============================================
// Expense Module — combined entry + history page, same shape as
// js/cdnotes.js (form + paginated table with totals footer). Category
// is a <select> populated from expense_categories, with a small "Manage
// Categories" link opening a lightweight add/edit/delete modal (same
// shape as js/invoice-items.js's Quick Add Product modal) — no separate
// categories page/nav entry, per the approved plan's scope decision.
// =============================================

const EXPENSE_PAYMENT_LABELS = {
  cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank Transfer',
  cheque: 'Cheque', card: 'Card', other: 'Other'
};

let expEditId = null;
let expAllData = [];
let expCategories = [];
let expPage = 1;
const EXP_PAGE = 10;

async function initExpenses() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupExpSearch();
  await loadExpCategories(user.id);
  await loadExpenses(user.id);
  setExpValue('expDate', toISO(new Date()));
}

function setExpValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }

// ── Categories ────────────────────────────────────────
async function loadExpCategories(userId) {
  const { data } = await _supabase.from('expense_categories').select('*').eq('user_id', userId).order('name', { ascending: true });
  expCategories = (data || []).filter(c => !c.is_deleted);
  const sel = document.getElementById('expCategory');
  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">Select Category</option>' + expCategories.map(c => `<option value="${c.id}">${escItemHtml(c.name)}</option>`).join('');
    if (current) sel.value = current;
  }
  renderExpCategoryManagerList();
}

function openExpCategoryManager() {
  document.getElementById('expCategoryModal')?.classList.add('open');
  setExpValue('ecName', '');
  setExpValue('ecDescription', '');
  ecEditId = null;
  renderExpCategoryManagerList();
}

function closeExpCategoryManager() {
  document.getElementById('expCategoryModal')?.classList.remove('open');
}

let ecEditId = null;

function renderExpCategoryManagerList() {
  const list = document.getElementById('ecList');
  if (!list) return;
  list.innerHTML = expCategories.length
    ? expCategories.map(c => `
      <div class="mini-list-row">
        <span>${escItemHtml(c.name)}${c.description ? ' &middot; <span class="text-muted-sm">' + escItemHtml(c.description) + '</span>' : ''}</span>
        <span class="d-flex align-center gap-10">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="editExpCategory('${c.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="deleteExpCategory('${c.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </span>
      </div>`).join('')
    : '<p class="text-muted-sm">No categories yet — add one below.</p>';
}

function editExpCategory(id) {
  const c = expCategories.find(x => x.id === id);
  if (!c) return;
  ecEditId = id;
  setExpValue('ecName', c.name);
  setExpValue('ecDescription', c.description || '');
}

async function saveExpCategory() {
  const user = await getCurrentUser();
  if (!user) return;
  const name = document.getElementById('ecName')?.value?.trim();
  const description = document.getElementById('ecDescription')?.value?.trim();
  if (!name) { showToast('Category name is required.', 'error'); return; }

  let error;
  if (ecEditId) {
    ({ error } = await _supabase.from('expense_categories').update({ name, description }).eq('id', ecEditId));
  } else {
    const dup = expCategories.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (dup) { showToast('Category already exists!', 'warning'); return; }
    ({ error } = await _supabase.from('expense_categories').insert({ user_id: user.id, name, description }));
  }
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(ecEditId ? 'Category updated!' : 'Category added!');
  ecEditId = null;
  setExpValue('ecName', '');
  setExpValue('ecDescription', '');
  await loadExpCategories(user.id);
}

async function deleteExpCategory(id) {
  const ok = await showConfirm('Delete this category? Existing expenses keep their recorded category name.');
  if (!ok) return;
  const { error } = await _supabase.from('expense_categories').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Category removed.');
  const user = await getCurrentUser();
  if (user) await loadExpCategories(user.id);
}

// ── Expense entry ─────────────────────────────────────
async function saveExpense() {
  const user = await getCurrentUser();
  if (!user) return;

  const categoryId = document.getElementById('expCategory')?.value || null;
  const category = expCategories.find(c => c.id === categoryId);
  const expenseDate = document.getElementById('expDate')?.value;
  const amount = parseFloat(document.getElementById('expAmount')?.value);
  const method = document.getElementById('expMethod')?.value || 'cash';
  const payee = document.getElementById('expPayee')?.value?.trim();
  const description = document.getElementById('expDescription')?.value?.trim();

  if (!expenseDate) { showToast('Expense date is required.', 'error'); return; }
  if (!amount || amount <= 0) { showToast('Amount must be a positive number.', 'error'); return; }

  const payload = {
    user_id: user.id, category_id: categoryId, category_name: category?.name || null,
    expense_date: expenseDate, amount, payment_method: method, payee, description
  };

  let error;
  if (expEditId) {
    ({ error } = await _supabase.from('expenses').update(payload).eq('id', expEditId));
  } else {
    ({ error } = await _supabase.from('expenses').insert(payload));
  }
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(expEditId ? 'Expense updated!' : 'Expense saved!');
  resetExpense();
  await loadExpenses(user.id);
}

function resetExpense() {
  setExpValue('expCategory', '');
  setExpValue('expDate', toISO(new Date()));
  setExpValue('expAmount', '');
  setExpValue('expMethod', 'cash');
  setExpValue('expPayee', '');
  setExpValue('expDescription', '');
  expEditId = null;
  document.getElementById('expFormTitle').textContent = 'Add Expense';
  document.getElementById('expSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Expense';
}

async function loadExpenses(userId) {
  const { data } = await _supabase.from('expenses').select('*').eq('user_id', userId).order('expense_date', { ascending: false });
  expAllData = (data || []).filter(r => !r.is_deleted);
  expPage = 1;
  renderExpTable(expAllData);
}

function renderExpTable(data) {
  const tbody = document.getElementById('expTableBody');
  const tfoot = document.getElementById('expTableTotal');
  if (!tbody) return;

  const start = (expPage - 1) * EXP_PAGE;
  const page  = data.slice(start, start + EXP_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="fas fa-receipt" style="display:block;font-size:40px;margin-bottom:10px;"></i>No expenses recorded yet</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    renderExpPagination(0);
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td>${formatDate(r.expense_date)}</td>
      <td>${r.category_name ? `<span class="badge badge-blue">${escItemHtml(r.category_name)}</span>` : '&mdash;'}</td>
      <td>${r.payee || '&mdash;'}</td>
      <td>${EXPENSE_PAYMENT_LABELS[r.payment_method] || r.payment_method}</td>
      <td class="text-right fw-700">&#8377;${formatNum(r.amount)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editExpense('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteExpense('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const total = data.reduce((s, r) => s + (+r.amount || 0), 0);
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="5" class="fw-700">TOTAL (${data.length} expenses)</td><td class="text-right fw-700">₹${formatNum(total)}</td><td></td></tr>`;

  renderExpPagination(data.length);
}

function renderExpPagination(total) {
  const c = document.getElementById('expPagination');
  if (!c) return;
  const pages = Math.ceil(total / EXP_PAGE);
  if (pages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="expPage=${expPage-1};renderExpTable(expAllData)" ${expPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i===expPage?'active':''}" onclick="expPage=${i};renderExpTable(expAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="expPage=${expPage+1};renderExpTable(expAllData)" ${expPage===pages?'disabled':''}>&#8250;</button>`;
  c.innerHTML = html;
}

function editExpense(id) {
  const rec = expAllData.find(r => r.id === id);
  if (!rec) return;
  expEditId = id;
  setExpValue('expCategory', rec.category_id || '');
  setExpValue('expDate', rec.expense_date || '');
  setExpValue('expAmount', rec.amount || '');
  setExpValue('expMethod', rec.payment_method || 'cash');
  setExpValue('expPayee', rec.payee || '');
  setExpValue('expDescription', rec.description || '');
  document.getElementById('expFormTitle').textContent = 'Edit Expense';
  document.getElementById('expSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Expense';
  document.getElementById('expAmount').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteExpense(id) {
  const ok = await showConfirm('Move this expense to Recycle Bin? You can restore it later.');
  if (!ok) return;
  const { error } = await _supabase.from('expenses').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Expense moved to Recycle Bin.');
  expAllData = expAllData.filter(r => r.id !== id);
  renderExpTable(expAllData);
}

function setupExpSearch() {
  document.getElementById('expSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? expAllData.filter(r =>
      (r.category_name || '').toLowerCase().includes(q) ||
      (r.payee || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q)
    ) : expAllData;
    expPage = 1;
    renderExpTable(filtered);
  });
}
