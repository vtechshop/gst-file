// =============================================
// Module and permission registry — the SAME file the browser loads.
//
// One list, required by the server (middleware/access.js, routes/employees.js)
// and loaded by the browser (client/js/core/access.js, pages/employees.js), so
// a module cannot exist in the permission UI and be missing from the API guard,
// or the reverse. That split is how permission systems rot: the checkbox says
// "Vouchers" and the endpoint it was meant to cover was never listed.
//
// The modules below are not invented. They are the application's OWN sidebar,
// read off dashboard.html: 35 links grouped where several pages are one
// concern (Vendors + Vendor Ledger, the five Stock pages, the six report
// pages). `pages` is what the browser gates; `api` is what the server gates.
//
// TWO ADMIN-ONLY MODULES are listed with no actions, because they are not
// grantable at all: company settings and employee management. They are gated
// on being an Admin, not on a permission string, so no combination of
// checkboxes can reach them.
// =============================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node
  else Object.assign(root, api);                                            // browser globals
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The five actions. `view` is the floor: without it the module is invisible
  // and every one of its endpoints refuses, whatever else is ticked.
  const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

  // Which HTTP methods need which action, for the generic CRUD surface.
  const METHOD_ACTION = { GET: 'view', HEAD: 'view', POST: 'create', PATCH: 'edit', PUT: 'edit', DELETE: 'delete' };

  // key          label shown to the Admin        pages gated in the browser                  api prefixes gated on the server
  const MODULES = [
    { key: 'dashboard', label: 'Dashboard', pages: ['dashboard.html'], api: [] },

    { key: 'invoices', label: 'Invoice Management', pages: ['invoice.html', 'b2c.html'],
      api: ['/invoices', '/b2b_invoices', '/b2c_invoices', '/invoice_items', '/b2b_hsn', '/b2c_hsn', '/invoice_series_migrations'] },
    { key: 'invoice_list', label: 'Invoice List', pages: ['invoice-list.html'], api: [] },

    { key: 'proforma', label: 'Proforma Management', pages: ['proforma.html', 'proforma-list.html'],
      api: ['/proforma_invoices', '/proforma_invoice_items'] },

    { key: 'cdnotes', label: 'Credit / Debit Notes', pages: ['cdnotes.html'],
      api: ['/cdn_notes', '/cdn_note_items'] },
    { key: 'sales_returns', label: 'Sales Returns', pages: ['sales-returns.html'],
      api: ['/sales_returns', '/sales_return_items'] },
    { key: 'bill_of_supply', label: 'Bill of Supply', pages: ['bill-of-supply.html'],
      api: ['/bill_of_supply', '/bill_of_supply_items'] },
    { key: 'revised_invoices', label: 'Revised Invoices', pages: ['revised-invoice.html'],
      api: ['/revised_invoices', '/revised_invoice_items'] },
    { key: 'advances', label: 'Advances', pages: ['advances.html'], api: ['/advance_adjustments'] },
    { key: 'vouchers', label: 'Vouchers', pages: ['vouchers.html'],
      api: ['/receipt_vouchers', '/receipt_voucher_items', '/payment_vouchers',
        '/refund_vouchers', '/self_invoices', '/unregistered_suppliers'] },
    { key: 'challans', label: 'Delivery Challans', pages: ['challans.html'],
      api: ['/delivery_challans', '/delivery_challan_items', '/job_workers'] },
    { key: 'amendments', label: 'Amendments', pages: ['amendments.html'], api: ['/gst_amendments'] },
    { key: 'warranty', label: 'Warranty', pages: ['warranty-list.html', 'warranty.html'], api: ['/warranties'] },
    { key: 'eway_bills', label: 'E-Way Bills', pages: ['eway-bills.html'], api: ['/eway_bills'] },

    { key: 'payments', label: 'Payments & Receipts', pages: [], api: ['/payments'] },

    { key: 'customers', label: 'Customers', pages: ['customers.html', 'customer-ledger.html'], api: ['/customers'] },
    { key: 'products', label: 'Products', pages: ['products.html'], api: ['/products', '/product-sync'] },
    { key: 'vendors', label: 'Vendors', pages: ['vendors.html', 'vendor-ledger.html'], api: ['/vendors'] },

    { key: 'purchase_orders', label: 'Purchase Orders', pages: ['purchase-orders.html', 'purchase-order.html'],
      api: ['/purchase-orders', '/purchase_orders', '/purchase_order_items'] },
    { key: 'purchases', label: 'Purchases', pages: ['purchases.html', 'purchase-list.html'],
      api: ['/purchases', '/purchase_items'] },
    { key: 'purchase_returns', label: 'Purchase Returns', pages: ['purchase-returns.html'],
      api: ['/purchase_returns', '/purchase_return_items'] },
    { key: 'purchase_notes', label: 'Purchase Credit / Debit Notes', pages: ['purchase-notes.html'],
      api: ['/purchase_notes', '/purchase_note_items'] },

    { key: 'stock', label: 'Stock & Inventory',
      pages: ['stock.html', 'stock-ledger.html', 'stock-locations.html', 'stock-transfers.html', 'stock-serials.html'],
      api: ['/stock'] },

    { key: 'expenses', label: 'Expenses', pages: ['expenses.html'], api: ['/expenses', '/expense_categories'] },

    { key: 'reports', label: 'Reports, GST Returns & Export',
      pages: ['reports.html', 'product-sales.html', 'gstr1.html', 'gstr3b.html', 'hsn.html', 'document-register.html'],
      api: ['/reports'] },

    // ── Admin only. No actions: not grantable, by design. ──
    { key: 'settings', label: 'Company & GST Settings', adminOnly: true, pages: [],
      api: ['/profiles', '/uploads', '/backup', '/import_mappings', '/gst'] },
    { key: 'employees', label: 'Employee Management', adminOnly: true, pages: ['employees.html'],
      api: ['/employees'] }
  ];

  // ── /api/documents: one shared router, thirteen document types ──────
  //
  // routes/documents.js serves every numbered document through one
  // :type parameter, so the path alone does not say which module a
  // request belongs to - /documents/receipt_voucher/next-number and
  // /documents/purchase_order/next-number are the same route.
  //
  // Leaving it unclaimed made it Admin-only, which was safe but wrong: an
  // employee granted Vouchers could read vouchers and not number one. So
  // the TYPE is mapped to the module, and the ACTION comes from what the
  // endpoint does. The keys are routes/documents.js's own DOCUMENT_TABLES
  // keys, all thirteen of them.
  //
  // Invoices are deliberately absent: they are not numbered through this
  // router. routes/invoices.js allocates its own numbers and is already
  // gated by the `invoices` module, so an Invoice Create permission
  // already governs invoice numbering.
  const DOCUMENT_TYPE_MODULE = {
    proforma_invoice: 'proforma',
    receipt_voucher:  'vouchers',
    payment_voucher:  'vouchers',
    refund_voucher:   'vouchers',
    self_invoice:     'vouchers',
    revised_invoice:  'revised_invoices',
    bill_of_supply:   'bill_of_supply',
    purchase_order:   'purchase_orders',
    warranty:         'warranty',
    dc_job_work:      'challans',
    dc_approval:      'challans',
    dc_liquid_gas:    'challans',
    dc_other:         'challans'
  };

  // What a /documents request needs, as { module, action } - or
  // { adminOnly: true } for the numbering settings, or null when the path
  // is not recognised, which the caller must treat as refused rather than
  // as permitted.
  //
  // `body` is consulted for the two endpoints whose subject is not in the
  // path: /reserve-number carries documentType, and /save carries editId
  // when it is an edit rather than a create. express.json() runs before
  // the authorisation chain, so the body is already parsed.
  function documentRequirement(method, pathname, body) {
    const p = String(pathname || '');
    if (!/^\/documents(\/|$)/.test(p)) return null;
    const rest = p.replace(/^\/documents\/?/, '');
    const parts = rest.split('/').filter(Boolean);
    const m = String(method || '').toUpperCase();
    const b = body && typeof body === 'object' ? body : {};

    // /documents/reserve-number - the type is in the body.
    if (parts.length === 1 && parts[0] === 'reserve-number') {
      const key = DOCUMENT_TYPE_MODULE[String(b.documentType || '').trim().toLowerCase()];
      return key ? { module: key, action: 'create' } : null;
    }

    const type = String(parts[0] || '').trim().toLowerCase();
    const moduleKey = DOCUMENT_TYPE_MODULE[type];
    if (!moduleKey) return null;
    const tail = parts.slice(1);

    // Changing the format or the counter is company numbering, and stays
    // with administrators whatever module permissions say.
    if (tail[0] === 'number-settings') return { adminOnly: true };

    if (tail[0] === 'next-number') return { module: moduleKey, action: 'create' };
    if (tail[0] === 'field-support') return { module: moduleKey, action: 'view' };

    // A save is a create, or an edit when it names a row to replace.
    if (tail[0] === 'save') {
      return { module: moduleKey, action: b.editId ? 'edit' : 'create' };
    }

    // /documents/:type/:id/cancel and DELETE /documents/:type/:id are both
    // the "Cancel / Delete" action.
    if (tail.length === 2 && tail[1] === 'cancel') return { module: moduleKey, action: 'delete' };
    if (tail.length === 1 && m === 'DELETE') return { module: moduleKey, action: 'delete' };
    if (tail.length === 1 && m === 'GET') return { module: moduleKey, action: 'view' };

    // Anything else under /documents is not recognised, and an
    // unrecognised path is refused rather than guessed at.
    return null;
  }

  const GRANTABLE = MODULES.filter(m => !m.adminOnly);
  const BY_KEY = Object.fromEntries(MODULES.map(m => [m.key, m]));

  // Page -> module key. A page not listed here is not gated by module (the
  // login page, the public verification pages, the shell pages that only
  // carry a back-link), so it is never hidden by accident.
  const PAGE_MODULE = {};
  for (const m of MODULES) for (const p of m.pages) PAGE_MODULE[p] = m.key;

  // Longest-prefix match, so '/purchase_notes' is not swallowed by
  // '/purchases' and '/purchase_order_items' is not swallowed by
  // '/purchase_orders'. Returns null for a path no module claims — which the
  // server treats as Admin-only rather than as open (see middleware/access.js):
  // an unclaimed endpoint is an oversight, and the safe reading of an
  // oversight is "nobody", not "everybody".
  function moduleForApiPath(pathname) {
    const p = String(pathname || '');
    let best = null;
    for (const m of MODULES) {
      for (const prefix of m.api) {
        if (p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '?')) {
          if (!best || prefix.length > best.prefix.length) best = { key: m.key, prefix };
        }
      }
    }
    return best ? best.key : null;
  }

  function actionForMethod(method) {
    return METHOD_ACTION[String(method || '').toUpperCase()] || null;
  }

  // Does this permission map allow `action` on `module`?
  //
  // `view` is required for everything: a create without a view is a grant
  // nobody meant to make, and treating it as valid would let an employee post
  // into a module they cannot read.
  function allows(permissions, moduleKey, action) {
    if (!permissions || typeof permissions !== 'object') return false;
    const m = BY_KEY[moduleKey];
    if (!m || m.adminOnly) return false;
    const granted = permissions[moduleKey];
    if (!Array.isArray(granted) || !granted.length) return false;
    if (!granted.includes('view')) return false;
    return granted.includes(action);
  }

  // Normalises whatever arrives from a request body into a map this file
  // recognises: unknown modules dropped, unknown actions dropped, admin-only
  // modules refused, order fixed, duplicates collapsed, and any module with
  // actions but no `view` given `view` so it cannot be half-granted.
  function sanitisePermissions(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const m of GRANTABLE) {
      const raw = input[m.key];
      if (!Array.isArray(raw)) continue;
      const picked = ACTIONS.filter(a => raw.includes(a));
      if (!picked.length) continue;
      if (!picked.includes('view')) picked.unshift('view');
      out[m.key] = picked;
    }
    return out;
  }

  return {
    ACCESS_DOCUMENT_TYPE_MODULE: DOCUMENT_TYPE_MODULE,
    accessDocumentRequirement: documentRequirement,
    ACCESS_ACTIONS: ACTIONS,
    ACCESS_MODULES: MODULES,
    ACCESS_GRANTABLE: GRANTABLE,
    ACCESS_PAGE_MODULE: PAGE_MODULE,
    accessModuleForApiPath: moduleForApiPath,
    accessActionForMethod: actionForMethod,
    accessAllows: allows,
    sanitisePermissions: sanitisePermissions
  };
});
