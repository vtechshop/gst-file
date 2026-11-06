// The administrator's sidebar links, against the sidebar that really ships.
//
// These exist because the first version of addAdminLinks() looked for a
// row wrapper - closest('li, .nav-item, .sidebar-item') - and returned
// when it found none. This sidebar is a flat run of <a class="menu-item">
// siblings with no <li> anywhere, so the function returned on every page
// and the Employees link never appeared at all. Nothing caught it: no test
// had ever run it against the real markup.
//
// So every test below takes the sidebar out of an actual page file and
// runs the actual function over it.
//
//   S1-S4  an Admin gets both links, in Masters, styled like their
//          neighbours, and adding them twice changes nothing
//   S5-S6  an employee gets neither, and that is presentation only -
//          the page and the API refuse them regardless
//   S7-S8  "Create Emp" opens the Create Employee form
//   S9     the links are injected, not copied into 39 pages by hand
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ACCESS_JS = read('client/js/core/access.js');
const EMPLOYEES_JS = read('client/js/pages/employees.js');
const MODULES_JS = read('shared/access-modules.js');

// The sidebar exactly as customers.html ships it: flat anchors, section
// headings, no list markup. Sliced from the file so it cannot drift.
function realSidebarHtml() {
  const html = read('customers.html');
  const from = html.indexOf('<div class="menu-section">Masters</div>');
  assert.ok(from > 0, 'customers.html has a Masters section');
  const start = html.lastIndexOf('<a href=', html.indexOf('Dashboard'));
  const end = html.indexOf('<div class="menu-section">Settings</div>', from);
  assert.ok(end > from, 'and a Settings section after it');
  return html.slice(start > 0 ? start : from, end);
}

// A DOM small enough to be honest about: real class names, real hrefs,
// real nesting. Anything these tests rely on is something the page has.
function sidebarDom(html) {
  const anchors = [...html.matchAll(/<a\s+href="([^"]+)"\s+class="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, cls, inner]) => ({ href, cls, inner }));
  assert.ok(anchors.length > 20, 'the sidebar has its links: ' + anchors.length);

  const parent = { children: [] };
  const make = (href, cls, inner) => {
    const classes = new Set(String(cls).split(/\s+/).filter(Boolean));
    const node = {
      tagName: 'A', href, innerHTML: inner, parentNode: parent,
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
      },
      // No li/.nav-item/.sidebar-item exists in this markup, which is the
      // whole point - closest() finds nothing, exactly as in the browser.
      closest: () => null,
      appendChild() {}
    };
    // A real node knows its own next sibling, including one just inserted.
    // Without this a second insertion appends to the end instead of
    // following the first - a fault in the harness that would read as a
    // fault in the code.
    Object.defineProperty(node, 'nextSibling', {
      get() {
        const p = node.parentNode;
        if (!p || !p.children) return null;
        const i = p.children.indexOf(node);
        return i < 0 ? null : (p.children[i + 1] || null);
      }
    });
    return node;
  };
  for (const a of anchors) parent.children.push(make(a.href, a.cls, a.inner));

  parent.insertBefore = (node, ref) => {
    const at = ref ? parent.children.indexOf(ref) : -1;
    node.parentNode = parent;
    if (at < 0) parent.children.push(node);
    else parent.children.splice(at, 0, node);
  };

  const document = {
    createElement: (tag) => {
      const n = make('', '', '');
      n.tagName = String(tag).toUpperCase();
      n.parentNode = null;
      return n;
    },
    querySelector: (sel) => {
      const m = /^a\[href="([^"]+)"\]$/.exec(sel);
      if (m) return parent.children.find((c) => c.href === m[1]) || null;
      return null;
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    title: '',
    body: { innerHTML: '' },
    addEventListener() {}
  };
  return { document, parent };
}

function accessSandbox({ role, permissions, hash, page }) {
  const dom = sidebarDom(realSidebarHtml());
  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, RegExp,
    document: dom.document,
    window: {
      location: { pathname: '/' + (page || 'customers.html'), hash: hash || '', href: '' },
      addEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
    showToast() {}, apiFetch: async () => ({}), handleApiError() {}
  };
  sandbox.location = sandbox.window.location;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(MODULES_JS, ctx, { filename: 'access-modules.js' });
  vm.runInContext(ACCESS_JS, ctx, { filename: 'access.js' });
  // The access state the page would have been given by /auth/me.
  vm.runInContext(
    '_access = ' + JSON.stringify({ role, permissions: permissions === undefined ? null : permissions,
      record_scope: role === 'admin' ? 'all' : 'own', employee_code: role === 'admin' ? null : 'VT-EMP-K7M4Q9',
      must_change_password: false, employee: null }), ctx);
  return {
    ctx, dom,
    run: (code) => vm.runInContext(code, ctx),
    hrefs: () => dom.parent.children.map((c) => c.href),
    find: (href) => dom.parent.children.find((c) => c.href === href) || null
  };
}

const ADMIN = { role: 'admin' };
const EMPLOYEE = { role: 'employee', permissions: { customers: ['view'] } };

test('S1 an Admin gets both links, and they actually appear', () => {
  const s = accessSandbox(ADMIN);
  const before = s.hrefs().length;
  s.run('addAdminLinks()');
  const after = s.hrefs();

  assert.strictEqual(after.length, before + 2, 'two links were added, not zero');
  assert.ok(after.includes('employees.html'), 'Employees');
  assert.ok(after.includes('employees.html#new'), 'Create Emp');

  const create = s.find('employees.html#new');
  assert.match(create.innerHTML, /Create Emp/, 'labelled as the brief asks');
  assert.match(create.innerHTML, /fa-user-plus/, 'with an add-a-person icon');
  assert.match(s.find('employees.html').innerHTML, /fa-users-cog/);
});

test('S2 they land in Masters, after Products', () => {
  const s = accessSandbox(ADMIN);
  s.run('addAdminLinks()');
  const order = s.hrefs();

  const products = order.indexOf('products.html');
  const employees = order.indexOf('employees.html');
  const create = order.indexOf('employees.html#new');
  const expenses = order.indexOf('expenses.html');

  assert.ok(products >= 0 && expenses > products, 'Masters runs up to Expenses');
  assert.strictEqual(employees, products + 1, 'Employees sits straight after Products');
  assert.strictEqual(create, products + 2, 'and Create Emp after it');
  assert.ok(create < expenses, 'both are inside Masters, before the next section');

  // Masters, specifically - not wherever the first matching link happened
  // to be. Customers comes first in document order, and a plain
  // querySelector with a comma would have put them there.
  const customers = order.indexOf('customers.html');
  assert.ok(employees > customers + 1,
    'not wedged between Customers and Customer Ledger');
});

test('S3 they are styled like the links beside them', () => {
  const s = accessSandbox(ADMIN);
  const neighbour = s.find('products.html').className;
  s.run('addAdminLinks()');

  for (const href of ['employees.html', 'employees.html#new']) {
    const link = s.find(href);
    assert.strictEqual(link.className, neighbour.replace(/\bactive\b/g, '').trim(),
      href + ' carries the sidebar class, minus any active state');
    assert.strictEqual(link.classList.contains('active'), false,
      'and is not active on another page');
  }
});

test('S4 running it again changes nothing', () => {
  const s = accessSandbox(ADMIN);
  s.run('addAdminLinks()');
  const once = s.hrefs().join('|');
  s.run('addAdminLinks()');
  s.run('addAdminLinks()');
  assert.strictEqual(s.hrefs().join('|'), once, 'no duplicates on a second pass');
});

test('S5 an employee sees neither link', () => {
  const s = accessSandbox(EMPLOYEE);
  const before = s.hrefs().length;
  s.run('addAdminLinks()');
  assert.strictEqual(s.hrefs().length, before, 'nothing was added');
  assert.strictEqual(s.find('employees.html'), null);
  assert.strictEqual(s.find('employees.html#new'), null);
});

test('S6 hiding the link is not the protection', () => {
  // Said out loud because a hidden menu item protects nothing: an employee
  // who types the URL must still be refused, and the API must refuse them
  // whatever the browser shows.
  assert.match(ACCESS_JS, /if \(moduleKey === 'employees' && !isAdminUser\(\)\) \{ denyPage\('employees'\); return false; \}/,
    'the page itself refuses a non-Admin');
  assert.match(EMPLOYEES_JS, /user\.role && user\.role !== 'admin'/,
    'and so does the page script, independently');

  const api = read('server/src/routes/employees.js');
  assert.match(api, /requireAuth[\s\S]{0,200}loadAccount[\s\S]{0,200}requireAdmin/,
    'and every /api/employees route is behind requireAdmin on the server');

  const mods = read('shared/access-modules.js');
  assert.match(mods, /key:\s*'employees'[\s\S]{0,200}adminOnly:\s*true/,
    'employees is an admin-only module, so no permission can ever grant it');
});

test('S7 Create Emp points at the existing page, not a second one', () => {
  const s = accessSandbox(ADMIN);
  s.run('addAdminLinks()');
  const href = s.find('employees.html#new').href;
  assert.strictEqual(href.split('#')[0], 'employees.html',
    'the same page the Employees link opens - no duplicate system');

  // And it is the same form the page's own button opens.
  assert.match(EMPLOYEES_JS, /window\.addEventListener\('hashchange', openCreateIfRequested\)/);
  assert.match(EMPLOYEES_JS, /if \(\(window\.location\.hash \|\| ''\)\.toLowerCase\(\) === '#new'\) empOpenModal\(null\)/,
    'the hash opens empOpenModal(null) - the create form, not a new one');
  assert.match(EMPLOYEES_JS, /empNewBtn'\)\.addEventListener\('click', \(\) => empOpenModal\(null\)\)/,
    'which is exactly what the New Employee button calls');
});

test('S8 on employees.html only the right one is marked active', () => {
  const list = accessSandbox({ role: 'admin', page: 'employees.html', hash: '' });
  list.run('addAdminLinks()');
  assert.strictEqual(list.find('employees.html').classList.contains('active'), true,
    'the list link, when no form was asked for');
  assert.strictEqual(list.find('employees.html#new').classList.contains('active'), false);

  const creating = accessSandbox({ role: 'admin', page: 'employees.html', hash: '#new' });
  creating.run('addAdminLinks()');
  assert.strictEqual(creating.find('employees.html#new').classList.contains('active'), true,
    'and Create Emp while the form is open');
  assert.strictEqual(creating.find('employees.html').classList.contains('active'), false);
});

test('S9 the links are injected, never written into the pages by hand', () => {
  // 39 copies of a sidebar is 39 chances to forget one - and static markup
  // cannot be admin-only anyway.
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const hardcoded = pages.filter((p) => /href="employees\.html/.test(read(p)));
  assert.deepStrictEqual(hardcoded, [],
    'no page carries the link in its markup: ' + hardcoded.join(', '));

  // Every page that has the sidebar must load the script that adds them,
  // or the links appear on some pages and not others.
  const withSidebar = pages.filter((p) => /href="products\.html"/.test(read(p)));
  const missing = withSidebar.filter((p) => !/core\/access\.js\?v=/.test(read(p)));
  assert.deepStrictEqual(missing, [],
    'every page with the sidebar loads access.js: ' + missing.join(', '));
  assert.ok(withSidebar.length >= 30, 'and there are many of them: ' + withSidebar.length);
});
