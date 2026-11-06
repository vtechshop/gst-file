// =============================================
// Employee Management — the Admin's screen
// =============================================
// Admin-only, and that is decided by the server: every call below goes to
// /api/employees, which is behind requireAdmin and scoped to the calling
// Admin's own staff. If an employee reaches this page, core/access.js
// replaces the body — and if they bypass that, every request here answers
// 403 admin_only. The page is convenience; the API is the gate.
//
// The permission grid is built from GET /api/employees/modules, i.e. from
// shared/access-modules.js, which is the same list the server enforces
// with. A checkbox therefore cannot exist for a module the API does not
// gate, and the two cannot drift apart.

let _empModules = [];
let _empActions = [];
let _empRows = [];

const EMP_ACTION_LABEL = {
  view: 'View', create: 'Create', edit: 'Edit', delete: 'Cancel / Delete', export: 'Export'
};

function empEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function empShowError(msg) {
  const el = document.getElementById('empError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// ── The permission grid ──────────────────────────────────────────────
function empBuildPermissionGrid() {
  const body = document.getElementById('empPermBody');
  if (!body) return;
  body.innerHTML = _empModules.map((m) => {
    const cells = _empActions.map((a) =>
      '<td style="text-align:center">'
      + '<input type="checkbox" class="emp-perm" data-module="' + empEsc(m.key) + '"'
      + ' data-action="' + empEsc(a) + '" aria-label="' + empEsc(EMP_ACTION_LABEL[a] || a)
      + ' ' + empEsc(m.label) + '">'
      + '</td>').join('');
    return '<tr><td>' + empEsc(m.label) + '</td>' + cells + '</tr>';
  }).join('');

  // View is the floor the server enforces: a create without a view is
  // refused there, so the UI must not let one be ticked. Unticking View
  // clears the row; ticking anything else ticks View.
  body.querySelectorAll('.emp-perm').forEach((cb) => {
    cb.addEventListener('change', () => {
      const row = cb.closest('tr');
      const view = row.querySelector('.emp-perm[data-action="view"]');
      if (cb.dataset.action === 'view' && !cb.checked) {
        row.querySelectorAll('.emp-perm').forEach((o) => { o.checked = false; });
      } else if (cb.checked && view) {
        view.checked = true;
      }
    });
  });
}

function empReadPermissions() {
  const out = {};
  document.querySelectorAll('.emp-perm:checked').forEach((cb) => {
    (out[cb.dataset.module] = out[cb.dataset.module] || []).push(cb.dataset.action);
  });
  return out;
}

function empWritePermissions(permissions) {
  const perms = permissions || {};
  document.querySelectorAll('.emp-perm').forEach((cb) => {
    const granted = perms[cb.dataset.module];
    cb.checked = Array.isArray(granted) && granted.includes(cb.dataset.action);
  });
}

// ── The list ─────────────────────────────────────────────────────────
function empSectionSummary(permissions) {
  const keys = Object.keys(permissions || {});
  if (!keys.length) return '<span class="text-muted">None yet</span>';
  const labels = keys.map((k) => {
    const m = _empModules.find((x) => x.key === k);
    return m ? m.label : k;
  });
  if (labels.length <= 2) return empEsc(labels.join(', '));
  return empEsc(labels.slice(0, 2).join(', ')) + ' <span class="text-muted">+'
    + (labels.length - 2) + ' more</span>';
}

function empRenderList() {
  const body = document.getElementById('empTableBody');
  if (!body) return;
  if (!_empRows.length) {
    body.innerHTML = '<tr><td colspan="8" class="text-muted">'
      + 'No employees yet. Create one to give someone their own sign-in.</td></tr>';
    return;
  }
  body.innerHTML = _empRows.map((e) => {
    const active = e.status === 'active';
    return '<tr>'
      + '<td><code>' + empEsc(e.employee_code) + '</code></td>'
      + '<td>' + empEsc(e.full_name) + '</td>'
      + '<td>' + empEsc(e.mobile || '') + '</td>'
      + '<td>' + empEsc(e.email || '') + '</td>'
      + '<td>' + (e.record_scope === 'all' ? 'All company records' : 'Own records only') + '</td>'
      + '<td>' + empSectionSummary(e.permissions) + '</td>'
      + '<td><span class="badge ' + (active ? 'badge-success' : 'badge-secondary') + '">'
      + (active ? 'Active' : 'Deactivated') + '</span></td>'
      + '<td style="white-space:nowrap">'
      + '<button class="btn btn-sm btn-secondary" data-emp-edit="' + empEsc(e.id) + '">Edit</button> '
      + '<button class="btn btn-sm btn-secondary" data-emp-reset="' + empEsc(e.id) + '">Reset password</button> '
      + (active
        ? '<button class="btn btn-sm btn-danger" data-emp-off="' + empEsc(e.id) + '">Deactivate</button>'
        : '<button class="btn btn-sm btn-primary" data-emp-on="' + empEsc(e.id) + '">Reactivate</button>')
      + '</td></tr>';
  }).join('');
}

async function empLoadList() {
  try {
    _empRows = await apiFetch('/employees');
    empRenderList();
  } catch (e) {
    const body = document.getElementById('empTableBody');
    if (body) {
      body.innerHTML = '<tr><td colspan="8" class="text-danger">'
        + empEsc((e && e.message) || 'Could not load the employee list.') + '</td></tr>';
    }
  }
}

// ── Credentials, shown once ──────────────────────────────────────────
//
// The server returns a temporary password exactly once, in the response
// that created or reset it. Nothing stores it and no later request can
// retrieve it, so this panel is the only place it ever appears. It is
// deliberately not written to the console, not put in the URL, and not
// kept in localStorage.
function empShowCredentials(code, password, notice) {
  document.getElementById('empCredId').value = code;
  document.getElementById('empCredPw').value = password;
  document.getElementById('empCredNotice').textContent = notice
    || 'Give these to the employee now. The password is shown only once.';
  document.getElementById('empCredentials').style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function empCopy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    if (typeof showToast === 'function') showToast((label || 'Copied') + ' copied.');
  } catch {
    if (typeof showToast === 'function') {
      showToast('Could not copy automatically — select the text and copy it.', 'warning');
    }
  }
}

// ── Create / edit ────────────────────────────────────────────────────
function empOpenModal(row) {
  empShowError('');
  document.getElementById('empModalTitle').textContent = row ? 'Edit Employee' : 'Create Employee';
  document.getElementById('empId').value = row ? row.id : '';
  document.getElementById('empName').value = row ? (row.full_name || '') : '';
  document.getElementById('empMobile').value = row ? (row.mobile || '') : '';
  document.getElementById('empEmail').value = row ? (row.email || '') : '';
  document.getElementById('empScope').value = row ? row.record_scope : 'own';

  // The ID is shown when editing and never offered when creating: it is
  // generated by the server, and the API refuses any attempt to set it.
  const codeGroup = document.getElementById('empCodeGroup');
  if (row) {
    codeGroup.style.display = '';
    document.getElementById('empCode').value = row.employee_code;
  } else {
    codeGroup.style.display = 'none';
    document.getElementById('empCode').value = '';
  }

  empWritePermissions(row ? row.permissions : {});
  document.getElementById('empModal').style.display = '';
}

function empCloseModal() {
  document.getElementById('empModal').style.display = 'none';
  // The sidebar's "Create Emp" asks for the form with #new. Clearing it on
  // close means clicking that link again opens the form again - without
  // this, the hash would already be #new, no hashchange would fire, and
  // the second click would appear to do nothing.
  if ((window.location.hash || '').toLowerCase() === '#new') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

async function empSave() {
  const id = document.getElementById('empId').value;
  const payload = {
    full_name: document.getElementById('empName').value.trim(),
    mobile: document.getElementById('empMobile').value.trim(),
    email: document.getElementById('empEmail').value.trim(),
    record_scope: document.getElementById('empScope').value === 'all' ? 'all' : 'own',
    permissions: empReadPermissions()
  };
  if (!payload.full_name) return empShowError('Enter the employee name.');

  const btn = document.getElementById('empSave');
  btn.disabled = true;
  try {
    if (id) {
      await apiFetch('/employees/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify(payload)
      });
      if (typeof showToast === 'function') showToast('Employee updated.');
    } else {
      const res = await apiFetch('/employees', { method: 'POST', body: JSON.stringify(payload) });
      empShowCredentials(res.employee.employee_code, res.temporary_password, res.notice);
    }
    empCloseModal();
    await empLoadList();
  } catch (e) {
    empShowError((e && e.message) || 'Could not save.');
  } finally {
    btn.disabled = false;
  }
}

async function empResetPassword(id) {
  const row = _empRows.find((r) => r.id === id);
  const who = row ? row.full_name : 'this employee';
  if (!confirm('Issue a new temporary password for ' + who + '?\n\n'
    + 'They will be signed out on every device and must set a new password at next sign-in.')) return;
  try {
    const res = await apiFetch('/employees/' + encodeURIComponent(id) + '/reset-password', { method: 'POST' });
    empShowCredentials(res.employee_code, res.temporary_password, res.notice);
    await empLoadList();
  } catch (e) {
    if (typeof showToast === 'function') showToast((e && e.message) || 'Could not reset the password.', 'error');
  }
}

async function empSetStatus(id, activate) {
  const row = _empRows.find((r) => r.id === id);
  const who = row ? row.full_name : 'this employee';
  const msg = activate
    ? 'Reactivate ' + who + '? They will be able to sign in again.'
    : 'Deactivate ' + who + '?\n\nThey are signed out immediately and cannot sign in.\n'
      + 'Their account is kept, so the invoices and vouchers they raised keep showing who raised them.';
  if (!confirm(msg)) return;
  try {
    await apiFetch('/employees/' + encodeURIComponent(id) + (activate ? '/reactivate' : '/deactivate'),
      { method: 'POST' });
    if (typeof showToast === 'function') {
      showToast(activate ? 'Employee reactivated.' : 'Employee deactivated and signed out.');
    }
    await empLoadList();
  } catch (e) {
    if (typeof showToast === 'function') showToast((e && e.message) || 'Could not change the status.', 'error');
  }
}

// ── Wiring ───────────────────────────────────────────────────────────
async function initEmployeesPage() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();

  // Belt and braces with core/access.js, which already replaces the body
  // for a non-Admin: if this page is ever reached another way, it says so
  // rather than showing an empty table.
  if (user.role && user.role !== 'admin') {
    const host = document.querySelector('.main-content') || document.body;
    host.innerHTML = '<div class="card" style="max-width:520px;margin:48px auto;padding:32px;text-align:center">'
      + '<i class="fas fa-lock" style="font-size:36px;opacity:.35"></i>'
      + '<h2 style="margin:16px 0 8px">Administrators only</h2>'
      + '<p style="opacity:.8">Employee management is not available to employee accounts.</p>'
      + '<a class="btn btn-primary" href="dashboard.html">Back to dashboard</a></div>';
    return;
  }

  try {
    const meta = await apiFetch('/employees/modules');
    _empModules = meta.modules || [];
    _empActions = meta.actions || ['view', 'create', 'edit', 'delete', 'export'];
  } catch {
    _empModules = []; _empActions = ['view', 'create', 'edit', 'delete', 'export'];
  }
  empBuildPermissionGrid();
  await empLoadList();

  document.getElementById('empNewBtn').addEventListener('click', () => empOpenModal(null));
  document.getElementById('empCancel').addEventListener('click', empCloseModal);

  // Arriving from the sidebar's "Create Emp" opens the Create Employee
  // form straight away - the same form the button opens, not a second one.
  // Done here, after the permission grid is built and the list is loaded,
  // so the form opens populated rather than empty.
  const openCreateIfRequested = () => {
    if ((window.location.hash || '').toLowerCase() === '#new') empOpenModal(null);
  };
  window.addEventListener('hashchange', openCreateIfRequested);
  openCreateIfRequested();
  document.getElementById('empModalClose').addEventListener('click', empCloseModal);
  document.getElementById('empSave').addEventListener('click', empSave);
  document.getElementById('empCredDone').addEventListener('click', () => {
    document.getElementById('empCredentials').style.display = 'none';
    document.getElementById('empCredId').value = '';
    document.getElementById('empCredPw').value = '';
  });
  document.getElementById('empCopyId').addEventListener('click',
    () => empCopy(document.getElementById('empCredId').value, 'Employee ID'));
  document.getElementById('empCopyPw').addEventListener('click',
    () => empCopy(document.getElementById('empCredPw').value, 'Password'));
  document.getElementById('empCopyBoth').addEventListener('click', () => empCopy(
    'Employee ID: ' + document.getElementById('empCredId').value
    + '\nTemporary password: ' + document.getElementById('empCredPw').value,
    'Sign-in details'));

  document.getElementById('empTableBody').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.empEdit) empOpenModal(_empRows.find((r) => r.id === t.dataset.empEdit));
    else if (t.dataset.empReset) empResetPassword(t.dataset.empReset);
    else if (t.dataset.empOff) empSetStatus(t.dataset.empOff, false);
    else if (t.dataset.empOn) empSetStatus(t.dataset.empOn, true);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEmployeesPage);
} else {
  initEmployeesPage();
}
