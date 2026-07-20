// Generic CRUD router factory — serves every table whose query needs are
// covered by the confirmed frontend surface (eq/gte/lte filters AND-ed
// together, single-field order, optional column projection): profiles,
// customers, cdn_notes, products, import_mappings, payments,
// b2b_invoices, b2c_invoices, b2b_hsn, b2c_hsn, invoice_items.
//
// Response bodies are plain REST (array for list, single object for
// insert, array of updated rows for patch) — NOT pre-shaped into
// Supabase's {data,error} envelope. That shaping (including turning an
// empty single-row select into the {data:null, error:{code:'PGRST116'}}
// shape callers check for) is js/apiClient.js's job on the client side,
// since it's a client-abstraction detail, not something a REST backend
// should need to know about.
//
// Every request is scoped to req.userId (from the verified JWT) via
// `ownerColumn` — never from anything the client sends — so one user
// can never read, write, or delete another user's rows. Column names
// used in filters/select/order/patch are always checked against the
// per-table `columns` allow-list before being interpolated into SQL
// (values are always parameterized; only identifiers can't be, hence
// the whitelist).
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

function buildWhere(query, ownerColumn, userId, columns) {
  const clauses = [`${ownerColumn} = $1`];
  const params = [userId];
  for (const key of Object.keys(query)) {
    let field, op;
    if (key.startsWith('eq_')) { field = key.slice(3); op = '='; }
    else if (key.startsWith('gte_')) { field = key.slice(4); op = '>='; }
    else if (key.startsWith('lte_')) { field = key.slice(4); op = '<='; }
    else continue;
    if (!columns.includes(field)) continue; // unknown/unsafe column — silently ignored, never interpolated
    params.push(query[key]);
    clauses.push(`${field} ${op} $${params.length}`);
  }
  return { where: 'WHERE ' + clauses.join(' AND '), params };
}

function buildOrder(orderParam, columns) {
  if (!orderParam) return '';
  const [field, dir] = String(orderParam).split('.');
  if (!columns.includes(field)) return '';
  return `ORDER BY ${field} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
}

function buildSelect(selectParam, columns) {
  if (!selectParam) return '*';
  const requested = String(selectParam).split(',').map(s => s.trim()).filter(c => columns.includes(c));
  return requested.length ? requested.join(',') : '*';
}

function makeCrudRouter(table, { columns, insertable = true, ownerColumn = 'user_id' }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', asyncRoute(async (req, res) => {
    const { where, params } = buildWhere(req.query, ownerColumn, req.userId, columns);
    const orderClause = buildOrder(req.query.order, columns);
    const selectCols = buildSelect(req.query.select, columns);
    const { rows } = await pool.query(`SELECT ${selectCols} FROM ${table} ${where} ${orderClause}`, params);
    res.json(rows);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    if (!insertable) { const e = new Error(`${table} does not accept direct inserts.`); e.status = 405; e.expose = true; throw e; }
    // Ownership is always forced from the JWT, never trusted from the
    // body — this also correctly handles `profiles`, where ownerColumn
    // is `id` itself: whatever `id` the client sent gets overwritten
    // with req.userId, which is the only value that could ever be valid.
    const payload = { ...req.body, [ownerColumn]: req.userId };
    const cols = Object.keys(payload).filter(c => columns.includes(c));
    if (!cols.length) { const e = new Error('No valid fields to insert.'); e.status = 400; e.expose = true; throw e; }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const values = cols.map(c => payload[c]);
    const { rows } = await pool.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, values
    );
    res.status(201).json(rows[0]);
  }));

  router.patch('/', asyncRoute(async (req, res) => {
    const { where, params } = buildWhere(req.query, ownerColumn, req.userId, columns);
    const patchCols = Object.keys(req.body).filter(c => columns.includes(c) && c !== ownerColumn); // ownership is never reassignable
    if (!patchCols.length) { const e = new Error('No valid fields to update.'); e.status = 400; e.expose = true; throw e; }
    const setClause = patchCols.map((c, i) => `${c} = $${params.length + i + 1}`).join(',');
    const values = [...params, ...patchCols.map(c => req.body[c])];
    const { rows } = await pool.query(`UPDATE ${table} SET ${setClause} ${where} RETURNING *`, values);
    res.json(rows);
  }));

  router.delete('/', asyncRoute(async (req, res) => {
    const { where, params } = buildWhere(req.query, ownerColumn, req.userId, columns);
    const { rowCount } = await pool.query(`DELETE FROM ${table} ${where}`, params);
    res.json({ deletedCount: rowCount });
  }));

  return router;
}

// ── Per-table column allow-lists (must match server/db/schema.sql) ──
const TABLES = {
  profiles: {
    ownerColumn: 'id',
    columns: ['id','name','email','gstin','business_name','phone','address','state',
      'bank_name','bank_account_no','bank_ifsc','bank_branch','upi_id',
      'logo_base64','seal_base64','signature_base64','qr_base64','header_color',
      'footer_text','terms_conditions','pan','website',
      'invoice_auto_number','invoice_number_format','invoice_current_sequence','created_at']
  },
  customers: {
    columns: ['id','user_id','name','gstin','phone','email','address','state',
      'is_deleted','deleted_at','created_at','updated_at']
  },
  cdn_notes: {
    columns: ['id','user_id','note_type','note_number','note_date','original_invoice',
      'customer_name','gstin','reason','taxable_amount','gst_percentage','supply_type',
      'igst','cgst','sgst','gst_amount','total_amount','is_deleted','deleted_at',
      'created_at','updated_at']
  },
  products: {
    columns: ['id','user_id','name','hsn_code','type','gst_percentage','default_rate',
      'unit','description','sku','category','warranty','image_url','external_id',
      'source','stock','is_deleted','deleted_at','created_at','updated_at']
  },
  import_mappings: {
    columns: ['id','user_id','import_type','mapping','created_at','updated_at']
  },
  payments: {
    columns: ['id','user_id','invoice_id','invoice_type','amount','method',
      'payment_date','note','created_at']
  },
  b2b_invoices: {
    columns: ['id','user_id','gst_number','customer_name','phone','address','state',
      'invoice_number','invoice_date','taxable_amount','gst_percentage','gst_amount',
      'total_amount','supply_type','igst','cgst','sgst','transport_required',
      'vehicle_number','transporter_name','transport_mode','transport_distance_km',
      'lr_number','lr_date','transporter_gstin','vehicle_type','dispatch_from','dispatch_to',
      'payment_status','amount_paid','is_deleted','deleted_at',
      'created_at','updated_at']
  },
  b2c_invoices: {
    columns: ['id','user_id','gst_number','customer_name','phone','address','state',
      'invoice_number','taxable_amount','gst_percentage','gst_amount','total_amount',
      'supply_type','igst','cgst','sgst','invoice_date','transport_required',
      'vehicle_number','transporter_name','transport_mode','transport_distance_km',
      'lr_number','lr_date','transporter_gstin','vehicle_type','dispatch_from','dispatch_to',
      'payment_status','amount_paid','is_deleted','deleted_at',
      'created_at','updated_at']
  },
  b2b_hsn: {
    // Legacy — no longer written to directly by normal invoice flow, but
    // the Recycle Bin cascade paths still need PATCH (restore) and
    // DELETE (hard-delete) here, so only direct INSERT is blocked.
    insertable: false,
    columns: ['id','user_id','hsn_code','product_name','type','quantity','taxable_value',
      'gst_percentage','supply_type','igst','cgst','sgst','total_gst','total_invoice_value',
      'entry_date','source','source_invoice_id','source_invoice_type','is_deleted',
      'deleted_at','created_at','updated_at']
  },
  b2c_hsn: {
    insertable: false,
    columns: ['id','user_id','hsn_code','product_name','type','taxable_value',
      'gst_percentage','supply_type','igst','cgst','sgst','total_gst','total_invoice_value',
      'entry_date','source','source_invoice_id','source_invoice_type','is_deleted',
      'deleted_at','created_at','updated_at']
  },
  invoice_items: {
    columns: ['id','user_id','invoice_id','invoice_type','product_id','product_name',
      'hsn_code','unit','quantity','rate','discount_percentage','gst_percentage',
      'taxable_value','gst_amount','igst','cgst','sgst','total_amount','sort_order',
      'is_deleted','deleted_at','created_at','updated_at']
  },
  vendors: {
    columns: ['id','user_id','name','gstin','phone','email','address','state',
      'is_deleted','deleted_at','created_at','updated_at']
  },
  purchases: {
    columns: ['id','user_id','vendor_id','vendor_name','vendor_gstin','phone','address','state',
      'purchase_number','purchase_date','taxable_amount','gst_percentage','gst_amount',
      'total_amount','supply_type','igst','cgst','sgst','payment_status','amount_paid',
      'is_deleted','deleted_at','created_at','updated_at']
  },
  purchase_items: {
    columns: ['id','user_id','purchase_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','total_amount','sort_order','is_deleted','deleted_at',
      'created_at','updated_at']
  },
  purchase_returns: {
    columns: ['id','user_id','vendor_id','vendor_name','vendor_gstin','return_number','return_date',
      'original_purchase_id','original_purchase_number','reason','taxable_amount','gst_percentage',
      'gst_amount','total_amount','supply_type','igst','cgst','sgst','is_deleted','deleted_at',
      'created_at','updated_at']
  },
  purchase_return_items: {
    columns: ['id','user_id','return_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','total_amount','sort_order','is_deleted','deleted_at',
      'created_at','updated_at']
  },
  expense_categories: {
    columns: ['id','user_id','name','description','is_deleted','deleted_at','created_at','updated_at']
  },
  expenses: {
    columns: ['id','user_id','category_id','category_name','expense_date','amount',
      'payment_method','payee','description','is_deleted','deleted_at','created_at','updated_at']
  },
  sales_returns: {
    columns: ['id','user_id','original_invoice_id','original_invoice_type','original_invoice_number',
      'customer_name','customer_gstin','phone','address','state','return_number','return_date','reason',
      'taxable_amount','gst_percentage','gst_amount','total_amount','supply_type','igst','cgst','sgst',
      'is_deleted','deleted_at','created_at','updated_at']
  },
  sales_return_items: {
    columns: ['id','user_id','return_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','total_amount','sort_order','is_deleted','deleted_at',
      'created_at','updated_at']
  }
};

// Mounts one router per table onto `app` at /api/<table>.
function mountGenericRoutes(app) {
  for (const [table, config] of Object.entries(TABLES)) {
    app.use(`/api/${table}`, makeCrudRouter(table, config));
  }
}

module.exports = { mountGenericRoutes, TABLES };
