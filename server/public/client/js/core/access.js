// =============================================
// What this account may see, applied to the page
// =============================================
// Everything here is PRESENTATION. It hides sidebar links an employee has
// no permission for and replaces the body of a page they may not open —
// and none of that is security. The server refuses the same requests
// whether or not this file ran, which is the only reason it is safe to
// have a cosmetic layer at all: an employee who deletes a `hidden` class
// in devtools gets a visible link to a page whose every API call answers
// 403.
//
// It exists because a sidebar of 35 links, 30 of which answer "you do not
// have permission", is a worse product than a sidebar of five that work.
//
// The authority itself comes from GET /api/auth/me, which resolves it from
// the database on every call. Nothing is cached across pages and nothing
// is read from localStorage: a permission withdrawn by an Admin takes
// effect on the employee's next page load, not whenever a cached copy
// happens to expire.
//
// Module keys, page names and the view/create/edit/delete/export
// vocabulary all come from shared/access-modules.js — the same file the
// server gates with. A module cannot be in this sidebar and missing from
// the API guard.

// Set by applyAccessControl() so pages can ask without a second request.
let _access = null;

function currentAccess() { return _access; }
function isAdminUser() { return !_access || _access.role === 'admin'; }

// An Admin has permissions === null, which means UNRESTRICTED. Treating
// null as "nothing granted" would lock the Admin out of their own
// application, so the check is explicit about which null this is.
function canAccess(moduleKey, action) {
  if (!_access || _access.role === 'admin') return true;
  if (typeof accessAllows !== 'function') return false;
  return accessAllows(_access.permissions, moduleKey, action || 'view');
}

function currentPageName() {
  const file = (window.location.pathname.split('/').pop() || '').toLowerCase();
  return file || 'index.html';
}

// ── The sidebar ──────────────────────────────────────────────────────
//
// Walks the real links rather than rebuilding the menu, so the markup,
// icons, grouping and order stay exactly as they are on all 38 pages. A
// link whose page maps to no module (the brand link, a sub-page) is left
// alone: not being listed is not the same as being forbidden.
function applySidebar() {
  if (isAdminUser()) return;
  const map = (typeof ACCESS_PAGE_MODULE === 'object' && ACCESS_PAGE_MODULE) || {};
  const links = document.querySelectorAll('a[href$=".html"]');
  links.forEach((a) => {
    const href = (a.getAttribute('href') || '').split('/').pop().toLowerCase();
    const moduleKey = map[href];
    if (!moduleKey) return;
    if (canAccess(moduleKey, 'view')) return;
    // Hide the whole row, not just the anchor, so a list item does not
    // leave an empty bullet behind.
    const row = a.closest('li, .nav-item, .sidebar-item') || a;
    row.style.display = 'none';
  });

  // A section heading whose every link is now hidden is noise.
  document.querySelectorAll('.nav-section, .sidebar-section').forEach((sec) => {
    const visible = Array.from(sec.querySelectorAll('a[href$=".html"]'))
      .filter((a) => {
        const row = a.closest('li, .nav-item, .sidebar-item') || a;
        return row.style.display !== 'none';
      });
    if (!visible.length) sec.style.display = 'none';
  });
}

// ── Employee Management, for Admins only ─────────────────────────────
//
// Added by script rather than pasted into 38 sidebars, because a link an
// employee must never see is exactly the kind of thing that gets missed in
// one file out of thirty-eight. An Admin gets it everywhere; an employee
// gets it nowhere, because the element is never created.
// The administrator's own entries in the sidebar.
//
// Injected rather than written into all 39 pages: the sidebar is copied
// into every one of them, so a link added by hand is a link to keep in
// step 39 times - and one that must never appear for an employee, which
// static markup cannot decide.
//
// NOTE ON THE MARKUP. This sidebar is a flat run of <a class="menu-item">
// siblings under a <div class="menu-section"> heading; there is no <li>
// wrapper anywhere. The first version of this function looked for one
// (closest('li, .nav-item, .sidebar-item')) and returned when it found
// none, so these links never appeared on any page at all. Both shapes are
// handled now - the flat anchor this sidebar uses, and a wrapped row if
// one is ever introduced - so neither can silently produce nothing.
//
// Hiding a link is presentation, never protection: employees.html refuses
// a non-Admin on its own, and every /api/employees route is behind
// requireAdmin on the server. This only decides what is worth showing.
const ADMIN_LINKS = [
  { href: 'employees.html', icon: 'fas fa-users-cog', label: 'Employees' },
  // Straight to the Create Employee form, for the common case: the hash
  // is what employees.html reads to open it.
  { href: 'employees.html#new', icon: 'fas fa-user-plus', label: 'Create Emp' }
];

function adminMenuAnchor() {
  // Deliberately in preference order rather than one querySelector with a
  // comma: that returns the first match in DOCUMENT order, which is
  // Customers, and would drop these links into the middle of Masters.
  // After Products puts them at the end of the section, where they read
  // as additions rather than as something inserted between two masters.
  return document.querySelector('a[href="products.html"]')
    || document.querySelector('a[href="customers.html"]')
    || document.querySelector('a[href="dashboard.html"]');
}

function addAdminLinks() {
  if (!isAdminUser()) return;
  const anchor = adminMenuAnchor();
  if (!anchor) return;
  const row = anchor.closest('li, .nav-item, .sidebar-item') || anchor;
  if (!row.parentNode) return;
  const wrapped = row !== anchor;

  const here = currentPageName();
  const onEmployees = here === 'employees.html';
  const creating = (window.location.hash || '').toLowerCase() === '#new';

  let after = row;
  for (const spec of ADMIN_LINKS) {
    // Idempotent: applyAccessControl can run more than once on a page, and
    // a page that already carries the link in its own markup keeps it.
    if (document.querySelector('a[href="' + spec.href + '"]')) continue;

    const a = document.createElement('a');
    a.href = spec.href;
    // The neighbouring link's own classes, minus its active state - so
    // this matches whatever the sidebar's styling happens to be.
    a.className = (anchor.className || 'menu-item').replace(/\bactive\b/g, '').replace(/\s+/g, ' ').trim();
    a.innerHTML = '<i class="' + spec.icon + '"></i> ' + spec.label;
    // Only one of the two is the page you are on, and which one depends on
    // whether the form is open.
    if (onEmployees && (spec.href === 'employees.html#new') === creating) a.classList.add('active');

    let node = a;
    if (wrapped) {
      node = document.createElement(row.tagName);
      node.className = row.className;
      node.appendChild(a);
    }
    after.parentNode.insertBefore(node, after.nextSibling);
    after = node;
  }
}

// ── A page this account may not open ─────────────────────────────────
//
// Replaces the content rather than redirecting: a redirect to the
// dashboard looks like the link was broken, where this says what happened
// and who to ask. The page's own scripts are already running by now, and
// their API calls will be refused — which is the actual protection; this
// is so the person is not left reading a blank table wondering why.
function denyPage(moduleKey) {
  const label = (typeof ACCESS_MODULES === 'object' && ACCESS_MODULES || [])
    .find((m) => m.key === moduleKey);
  const where = label ? label.label : 'this section';
  const host = document.querySelector('.main-content, .content, main') || document.body;
  host.innerHTML =
    '<div class="card" style="max-width:560px;margin:48px auto;text-align:center;padding:32px">'
    + '<i class="fas fa-lock" style="font-size:38px;opacity:.35"></i>'
    + '<h2 style="margin:18px 0 8px">Access not granted</h2>'
    + '<p style="margin:0 0 6px">You do not have permission to open <b>'
    + String(where).replace(/[<>&]/g, '') + '</b>.</p>'
    + '<p style="margin:0 0 22px;opacity:.75">Your administrator decides which sections each '
    + 'employee can use. Ask them if you need this one.</p>'
    + '<a class="btn btn-primary" href="dashboard.html">Back to dashboard</a></div>';
  document.title = 'Access not granted';
}

// ── Must change password ─────────────────────────────────────────────
//
// A temporary password reaches nothing but this, and the server enforces
// that independently: every other endpoint answers 403
// password_change_required. So this prompt is not the gate, it is how the
// person finds out what the gate wants.
function promptPasswordChange() {
  const host = document.querySelector('.main-content, .content, main') || document.body;
  host.innerHTML =
    '<div class="card" style="max-width:460px;margin:48px auto;padding:32px">'
    + '<h2 style="margin:0 0 6px">Set your password</h2>'
    + '<p style="margin:0 0 20px;opacity:.8">You signed in with a temporary password. '
    + 'Choose your own before continuing.</p>'
    + '<div class="form-group"><label for="acCurrent">Temporary password</label>'
    + '<input type="password" id="acCurrent" class="form-control" autocomplete="current-password"></div>'
    + '<div class="form-group"><label for="acNew">New password</label>'
    + '<input type="password" id="acNew" class="form-control" autocomplete="new-password"></div>'
    + '<div class="form-group"><label for="acNew2">Confirm new password</label>'
    + '<input type="password" id="acNew2" class="form-control" autocomplete="new-password"></div>'
    + '<div id="acErr" class="status-msg text-danger" style="display:none"></div>'
    + '<button class="btn btn-primary btn-full" id="acSave">Save and continue</button></div>';
  document.title = 'Set your password';

  const err = (msg) => {
    const el = document.getElementById('acErr');
    el.textContent = msg; el.style.display = 'block';
  };
  document.getElementById('acSave').addEventListener('click', async () => {
    const current = document.getElementById('acCurrent').value;
    const next = document.getElementById('acNew').value;
    if (next !== document.getElementById('acNew2').value) return err('Those two passwords do not match.');
    if ((next || '').length < 8) return err('Use at least 8 characters.');
    try {
      const res = await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next })
      });
      // A fresh token comes back so this tab stays signed in; every other
      // device holding the old one is signed out by the server.
      if (res && res.token) localStorage.setItem('gst_jwt', res.token);
      window.location.href = 'dashboard.html';
    } catch (e) {
      err((e && e.message) || 'Could not change the password.');
    }
  });
}

// ── The hook core/auth.js calls ──────────────────────────────────────
//
// Returns false when the page must not continue, which is what stops the
// page's own init from populating a view the person may not have.
async function applyAccessControl(user) {
  _access = user && user.role
    ? {
      role: user.role,
      permissions: user.permissions || null,
      record_scope: user.record_scope || 'all',
      employee_code: user.employee_code || null,
      must_change_password: !!user.must_change_password
    }
    // An older cached /me response with no role in it: treat as Admin,
    // which is what every account was before employees existed. The
    // server is still the one deciding, so this cannot grant anything.
    : { role: 'admin', permissions: null, record_scope: 'all', employee_code: null, must_change_password: false };

  if (_access.must_change_password) { promptPasswordChange(); return false; }

  addAdminLinks();
  applySidebar();

  // Show the Employee ID beside the name, so an employee can read their
  // own without asking anyone. Only ever their own.
  if (_access.employee_code) {
    const el = document.getElementById('navUserName');
    if (el && !el.dataset.codeShown) {
      el.dataset.codeShown = '1';
      el.textContent = (el.textContent || '').trim() + ' · ' + _access.employee_code;
    }
  }

  const moduleKey = (typeof ACCESS_PAGE_MODULE === 'object' && ACCESS_PAGE_MODULE || {})[currentPageName()];
  if (moduleKey && !canAccess(moduleKey, 'view')) { denyPage(moduleKey); return false; }
  if (moduleKey === 'employees' && !isAdminUser()) { denyPage('employees'); return false; }

  return true;
}

// Lets a page hide an action button it would otherwise draw — again
// presentation only, and again the server refuses regardless.
function hideWithoutPermission(moduleKey, action, selector) {
  if (canAccess(moduleKey, action)) return;
  document.querySelectorAll(selector).forEach((el) => { el.style.display = 'none'; });
}
