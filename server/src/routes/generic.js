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
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const {
  validateCustomerPayload, validateProductPayload, validateProfilePayload, makeDistrictValidator
} = require('../utils/validation');

function buildWhere(query, ownerColumn, userId, columns) {
  const clauses = [`${ownerColumn} = $1`];
  const params = [userId];
  for (const key of Object.keys(query)) {
    let field, op;
    if (key.startsWith('eq_')) { field = key.slice(3); op = '='; }
    else if (key.startsWith('gte_')) { field = key.slice(4); op = '>='; }
    else if (key.startsWith('lte_')) { field = key.slice(4); op = '<='; }
    // `in_<column>=id1,id2,id3` — lets a caller scope a table with no
    // date column of its own (e.g. invoice_items, keyed to a parent
    // invoice's id rather than carrying its own date) down to a
    // specific set of parent rows, instead of either fetching that
    // table's entire history for the user (unbounded — the GSTR-1
    // exporter used to do exactly this) or issuing one request per id
    // (real N+1). Every value is still bound as its own parameter, same
    // as eq_/gte_/lte_ — never string-concatenated.
    else if (key.startsWith('in_')) { field = key.slice(3); op = 'IN'; }
    else continue;
    if (!columns.includes(field)) continue; // unknown/unsafe column — silently ignored, never interpolated
    if (op === 'IN') {
      const values = String(query[key]).split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) continue;
      const placeholders = values.map(v => { params.push(v); return `$${params.length}`; });
      clauses.push(`${field} IN (${placeholders.join(',')})`);
    } else {
      params.push(query[key]);
      clauses.push(`${field} ${op} $${params.length}`);
    }
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

// LIMIT/OFFSET so a list page can fetch the rows it displays instead of
// the whole table. Both are clamped: a caller cannot ask for a million
// rows, and a nonsense value falls back to no limit rather than erroring.
const MAX_PAGE_ROWS = 500;
function buildLimit(limitParam, offsetParam) {
  const parts = [];
  const params = [];
  const limit = parseInt(limitParam, 10);
  if (Number.isFinite(limit) && limit > 0) {
    parts.push(`LIMIT ${Math.min(limit, MAX_PAGE_ROWS)}`);
    const offset = parseInt(offsetParam, 10);
    if (Number.isFinite(offset) && offset > 0) parts.push(`OFFSET ${offset}`);
  }
  return parts.join(' ');
}

// A paginated table still needs figures for the whole filtered set — a
// row count for the pager and, for the money tables, a column total for
// the footer. Computing them in Postgres keeps that O(1) over the wire
// instead of shipping every row just to add it up in the browser.
//
// Returned as headers so the body stays a plain array and every existing
// caller is unaffected. `sum` is checked against the table's column
// allow-list, exactly like select/order/filters.
async function attachAggregates(res, req, table, where, params, columns) {
  const wantCount = req.query.count === 'exact';
  // `sum` takes one column or several: a table footer usually needs a
  // total per money column, and doing them in one pass costs the same
  // as doing one. Unknown names are dropped, same as select/order.
  const sumCols = String(req.query.sum || '')
    .split(',').map(s => s.trim()).filter(c => c && columns.includes(c));
  if (!wantCount && !sumCols.length) return;

  const pieces = [];
  if (wantCount) pieces.push('COUNT(*)::bigint AS total_count');
  sumCols.forEach((c, i) => pieces.push(`COALESCE(SUM(${c}),0)::float8 AS sum_${i}`));
  const { rows } = await pool.query(`SELECT ${pieces.join(', ')} FROM ${table} ${where}`, params);

  const agg = rows[0] || {};
  if (wantCount) res.set('X-Total-Count', String(agg.total_count ?? 0));
  if (sumCols.length) {
    const sums = {};
    sumCols.forEach((c, i) => { sums[c] = agg['sum_' + i] ?? 0; });
    res.set('X-Total-Sums', JSON.stringify(sums));
  }
  // Without this the browser cannot read either header cross-origin.
  res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Total-Sums');
}

// Runs a table's optional `validate(payload)` hook (see TABLES.customers
// below for the one real user) and throws a 400 with every failure
// reason joined into one message — same { error: { message } } shape
// every other rejection in this app already uses, not a new response
// shape just for this. Applied on both insert and update, with isInsert
// telling the hook which it is — a create must arrive complete, an
// update validates only the fields it actually writes.
function runValidate(validate, body, isInsert) {
  if (!validate) return;
  const result = validate(body, isInsert);
  if (!result.valid) {
    const e = new Error(Object.values(result.errors).join(' '));
    e.status = 400; e.expose = true;
    // The joined sentence stays the message (every existing caller reads
    // that and nothing else). The map travels alongside it so a form can
    // put each complaint under the field it belongs to instead of making
    // the user work out which of three sentences was about which input.
    e.fields = result.errors;
    throw e;
  }
}

function makeCrudRouter(table, { columns, insertable = true, readOnly = false, ownerColumn = 'user_id', validate }) {
  const router = express.Router();
  router.use(requireAuth);

  // A readOnly table is written only by the endpoint that owns it, in the
  // same transaction as the change it records. An audit log the browser
  // can edit or delete is not an audit log, so the generic write paths
  // are closed rather than merely unused.
  const refuseWrite = () => {
    const e = new Error(`${table} is a read-only record and cannot be changed here.`);
    e.status = 405; e.expose = true; throw e;
  };

  router.get('/', asyncRoute(async (req, res) => {
    const { where, params } = buildWhere(req.query, ownerColumn, req.userId, columns);
    const orderClause = buildOrder(req.query.order, columns);
    const selectCols = buildSelect(req.query.select, columns);
    const limitClause = buildLimit(req.query.limit, req.query.offset);
    // The page of rows and the aggregates over the whole filtered set are
    // independent, so they go together rather than one after the other.
    const [{ rows }] = await Promise.all([
      pool.query(`SELECT ${selectCols} FROM ${table} ${where} ${orderClause} ${limitClause}`, params),
      attachAggregates(res, req, table, where, params, columns)
    ]);
    res.json(rows);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    if (readOnly) refuseWrite();
    if (!insertable) { const e = new Error(`${table} does not accept direct inserts.`); e.status = 405; e.expose = true; throw e; }
    runValidate(validate, req.body, true);
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
    if (readOnly) refuseWrite();
    runValidate(validate, req.body, false);
    const { where, params } = buildWhere(req.query, ownerColumn, req.userId, columns);
    const patchCols = Object.keys(req.body).filter(c => columns.includes(c) && c !== ownerColumn); // ownership is never reassignable
    if (!patchCols.length) { const e = new Error('No valid fields to update.'); e.status = 400; e.expose = true; throw e; }
    const setClause = patchCols.map((c, i) => `${c} = $${params.length + i + 1}`).join(',');
    const values = [...params, ...patchCols.map(c => req.body[c])];
    const { rows } = await pool.query(`UPDATE ${table} SET ${setClause} ${where} RETURNING *`, values);
    res.json(rows);
  }));

  router.delete('/', asyncRoute(async (req, res) => {
    if (readOnly) refuseWrite();
    const { where, params } = buildWhere(req.query, ownerColumn, req.userId, columns);
    const { rowCount } = await pool.query(`DELETE FROM ${table} ${where}`, params);
    res.json({ deletedCount: rowCount });
  }));

  return router;
}

// ── Per-table column allow-lists (must match server/db/schema/schema.sql) ──
const TABLES = {
  profiles: {
    ownerColumn: 'id',
    columns: ['id','name','email','gstin','business_name','phone','address','state','district',
      'bank_name','bank_account_no','bank_ifsc','bank_branch','upi_id',
      'logo_base64','seal_base64','signature_base64','qr_base64','header_color',
      'footer_text','terms_conditions','pan','website',
      'invoice_auto_number','invoice_number_format','invoice_current_sequence',
      'invoice_series_sequences','invoice_series_formats',
      // GST registration details (Phase 2, Module 1)
      'legal_name','trade_name','business_constitution','registration_type',
      'lut_number','lut_expiry','iec_number','default_pos','reverse_charge_default',
      'einvoice_applicable','ewaybill_applicable','financial_year',
      // Document numbering (Phase 2, Module 4B-impl) — kept apart from
      // the invoice counters so invoice numbering is untouched.
      'document_series_sequences','document_series_formats',
      'created_at',
      'hsn_digits_required','aggregate_turnover_band'],
    validate: validateProfilePayload
  },
  customers: {
    columns: ['id','user_id','name','gstin','phone','email','address','state','district',
      // Customer GST category (Phase 2, Module 2)
      'gst_category','pan','country','place_of_supply','shipping_address','shipping_state','shipping_district',
      'created_at','updated_at'],
    validate: validateCustomerPayload
  },
  cdn_notes: {
    columns: ['id','user_id','note_type','note_number','note_date','original_invoice',
      'customer_name','gstin','state','reason','taxable_amount','gst_percentage','supply_type',
      'igst','cgst','sgst','gst_amount','total_amount',
      'created_at','updated_at',
      'cess_amount','original_invoice_date','original_period','original_note_number','original_note_date',
      'supply_nature','original_invoice_id','original_invoice_table',
      'differential_65','reverse_charge','ecom_gstin']
  },
  products: {
    columns: ['id','user_id','name','hsn_code','type','gst_percentage','default_rate',
      'unit','description','sku','category','warranty','image_url','external_id',
      'source','stock',
      // GST treatment (Phase 2, Module 3)
      'gst_treatment','cess_rate','reverse_charge',
      // Product Master completion (Phase 2, Module 3A)
      'gst_overrides','supply_bundle','principal_gst_rate',
      'created_at','updated_at'],
    // Requires a valid HSN on hand-created products only (source 'local').
    // Product Sync writes source 'synced' and is deliberately unaffected —
    // see validateProductPayload() for why.
    validate: validateProductPayload
  },
  import_mappings: {
    columns: ['id','user_id','import_type','mapping','created_at','updated_at']
  },
  payments: {
    columns: ['id','user_id','invoice_id','invoice_type','amount','method',
      'payment_date','reference_number','note','created_at']
  },
  // ── Vouchers and self invoices (Phase 2, Module 4B-impl) ──
  //    Four separate domain tables, deliberately not one. See
  //    db/migrations/migration_vouchers.sql.
  unregistered_suppliers: {
    columns: ['id','user_id','name','gstin','pan','phone','email','address','state',
      'rcm_category','notes','created_at','updated_at']
  },
  self_invoices: {
    columns: ['id','user_id','document_number','document_date','document_series','status',
      'supplier_id','supplier_name','supplier_gstin','supplier_state','place_of_supply',
      'description','taxable_value','gst_percentage','igst','cgst','sgst','cess','total_value',
      'notes','created_at','updated_at']
  },
  receipt_vouchers: {
    columns: ['id','user_id','document_number','document_date','document_series','status',
      'customer_id','party_name','party_gstin','place_of_supply','supply_type','description',
      'advance_amount','gst_percentage','igst','cgst','sgst','cess','total_value',
      'adjusted_amount','notes','created_at','updated_at']
  },
  payment_vouchers: {
    columns: ['id','user_id','document_number','document_date','document_series','status',
      'supplier_id','supplier_name','supplier_gstin','self_invoice_id',
      'original_document_number','original_document_date','description','amount_paid',
      'payment_mode','reference_number','notes','created_at','updated_at']
  },
  refund_vouchers: {
    columns: ['id','user_id','document_number','document_date','document_series','status',
      'customer_id','party_name','party_gstin','place_of_supply','supply_type',
      'receipt_voucher_id','original_document_number','original_document_date','reason',
      'refund_amount','gst_percentage','igst','cgst','sgst','cess','total_value',
      'notes','created_at','updated_at']
  },
  // ── Amendments to already-filed returns (Batch 7) ──
  //    An amendment is a record of its own, never an edit of the document
  //    it amends: the original figures were filed and stay filed.
  gst_amendments: {
    columns: ['id','user_id','section','original_period','amendment_period','original_document_id',
      'original_document_table','original_number','original_date','revised_number','revised_date',
      'party_gstin','party_name','place_of_supply','supply_type','inv_typ','note_type',
      'reverse_charge','taxable_amount','gst_percentage','igst','cgst','sgst','cess','total_amount',
      'reason','notes','status','created_at','updated_at']
  },
  // ── Exports, advances, bill of supply (Batch 5) ──
  advance_adjustments: {
    columns: ['id','user_id','receipt_voucher_id','invoice_id','invoice_table','invoice_number',
      'invoice_date','adjusted_on','place_of_supply','supply_type','gst_percentage',
      'adjusted_amount','igst','cgst','sgst','cess','notes','created_at','updated_at']
  },
  bill_of_supply: {
    columns: ['id','user_id','document_number','document_date','document_series','status',
      'customer_id','party_name','party_gstin','place_of_supply','supply_type','supply_nature',
      'total_value','reason','notes','cancelled_at','cancel_reason','created_at','updated_at']
  },
  bill_of_supply_items: {
    columns: ['id','user_id','bill_of_supply_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','total_value','gst_treatment','sort_order','created_at']
  },
  // ── Challans, revised invoices, job workers (Module 4C) ──
  //    See db/migrations/migration_challans.sql for why the four challan variants
  //    share one table: one numbering series, so one uniqueness rule.
  job_workers: {
    columns: ['id','user_id','name','gstin','is_registered','address','city','state','district',
      'state_code','pincode','phone','email','nature_of_work','customer_id','status',
      'notes','created_at','updated_at'],
    validate: makeDistrictValidator([['state', 'district']])
  },
  delivery_challans: {
    columns: ['id','user_id','document_type','document_number','document_date','document_series',
      'status','job_worker_id','customer_id','party_name','party_gstin','from_address','from_state','from_district',
      'to_address','to_state','to_district','place_of_supply','supply_type','purpose','reason',
      'quantity_known_at_dispatch','approval_due_date','expected_return_date','returned_on',
      'transporter_name','transporter_id','vehicle_number','transport_mode','transport_distance',
      'lr_number','eway_bill_id','eway_bill_number','taxable_value','igst','cgst','sgst','cess',
      'total_value','notes','cancelled_at','cancel_reason','created_at','updated_at'],
    validate: makeDistrictValidator([['from_state', 'from_district'], ['to_state', 'to_district']])
  },
  delivery_challan_items: {
    columns: ['id','user_id','challan_id','product_id','product_name','hsn_code','unit','quantity',
      'rate','taxable_value','gst_percentage','igst','cgst','sgst','cess','total_value',
      'delivered_quantity','returned_quantity','sort_order','created_at']
  },
  revised_invoices: {
    columns: ['id','user_id','document_number','document_date','document_series','status',
      'original_invoice_number','original_invoice_date','original_invoice_id',
      'original_invoice_table','original_period','customer_id','party_name','party_gstin',
      'place_of_supply','supply_type','gst_category','inv_typ','reverse_charge','taxable_amount',
      'gst_percentage','gst_amount','igst','cgst','sgst','cess','total_amount','reason','notes',
      'cancelled_at','cancel_reason','created_at','updated_at']
  },
  revised_invoice_items: {
    columns: ['id','user_id','revised_invoice_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','cess_rate','cess_amount','total_amount','gst_treatment','sort_order',
      'created_at']
  },
  // Append-only, same reasoning as invoice_series_migrations: an audit
  // trail the browser can edit or delete is not an audit trail.
  document_audit_log: {
    readOnly: true,
    columns: ['id','user_id','document_type','document_table','document_id','document_number',
      'action','changes','created_at']
  },
  // Read-only in practice: rows are written by POST /invoices/series-migration
  // inside the same transaction as the change they describe. Exposed here
  // so the migration tool can show its own history, which is the point of
  // keeping the log at all.
  invoice_series_migrations: {
    readOnly: true,
    columns: ['id','user_id','range_from','range_to','old_sources','new_source',
      'invoice_count','invoice_numbers','created_at']
  },
  // Internal transport documents. ewb_* / status are exposed now so a future
  // NIC integration can PATCH them onto the same row without touching this
  // allow-list; this phase never writes them.
  eway_bills: {
    columns: ['id','user_id','invoice_id','invoice_type','invoice_number','invoice_date',
      'vehicle_number','transporter_name','transport_mode','transport_distance_km',
      'lr_number','lr_date','transporter_gstin','vehicle_type','dispatch_from','dispatch_to',
      'ewb_number','ewb_date','valid_until','status','created_at','updated_at']
  },
  b2b_invoices: {
    columns: ['id','user_id','gst_number','customer_name','phone','address','state','district',
      // Ship To. NULL means the goods went to the billing address above -
      // never a copy of it, so nothing can drift when billing is corrected.
      'shipping_address','shipping_state','shipping_district',
      'invoice_number','invoice_date','taxable_amount','gst_percentage','gst_amount',
      'total_amount','supply_type','igst','cgst','sgst','transport_required',
      'vehicle_number','transporter_name','transport_mode','transport_distance_km',
      'lr_number','lr_date','transporter_gstin','vehicle_type','dispatch_from','dispatch_to',
      'payment_status','amount_paid','invoice_source','gst_category','reverse_charge',
      'created_at','updated_at',
      'export_type','shipping_bill_number','shipping_bill_date','port_code',
      'cess_amount','ecom_gstin','ecom_supply_type',
      'sez_recipient_type','export_of','lut_number',
      'differential_65',
      // Warranty on the sale. Descriptive only - no return, total or
      // sequence reads these, and they stay NULL on older invoices.
      'warranty_period_months','warranty_start_date','warranty_until','warranty_terms'],
    validate: makeDistrictValidator([['state', 'district'], ['shipping_state', 'shipping_district']])
  },
  b2c_invoices: {
    columns: ['id','user_id','gst_number','customer_name','phone','address','state','district',
      // Ship To. NULL means the goods went to the billing address above -
      // never a copy of it, so nothing can drift when billing is corrected.
      'shipping_address','shipping_state','shipping_district',
      'invoice_number','taxable_amount','gst_percentage','gst_amount','total_amount',
      'supply_type','igst','cgst','sgst','invoice_date','transport_required',
      'vehicle_number','transporter_name','transport_mode','transport_distance_km',
      'lr_number','lr_date','transporter_gstin','vehicle_type','dispatch_from','dispatch_to',
      'payment_status','amount_paid','invoice_source','gst_category','reverse_charge',
      'created_at','updated_at',
      'export_type','shipping_bill_number','shipping_bill_date','port_code',
      'cess_amount','ecom_gstin','ecom_supply_type',
      'sez_recipient_type','export_of','lut_number',
      'differential_65',
      // Warranty on the sale. Descriptive only - no return, total or
      // sequence reads these, and they stay NULL on older invoices.
      'warranty_period_months','warranty_start_date','warranty_until','warranty_terms'],
    validate: makeDistrictValidator([['state', 'district'], ['shipping_state', 'shipping_district']])
  },
  // Quotations. Separate tables on purpose: no Dashboard, Reports, ledger,
  // Invoice List or GSTR-1 query reads them, so a proforma cannot leak into
  // any of those by accident.
  proforma_invoices: {
    columns: ['id','user_id','document_number','document_date','document_series',
      'valid_until','status','customer_id','customer_name','gst_number','phone',
      'address','state','district','shipping_address','shipping_state','shipping_district',
      'supply_type','gst_category','taxable_amount','gst_percentage','gst_amount',
      'igst','cgst','sgst','total_amount','notes','terms',
      'converted_invoice_id','converted_invoice_type','cancelled_at','cancel_reason',
      'created_at','updated_at'],
    validate: makeDistrictValidator([['state', 'district'], ['shipping_state', 'shipping_district']])
  },
  proforma_invoice_items: {
    columns: ['id','user_id','proforma_invoice_id','product_id','product_name','hsn_code',
      'unit','quantity','rate','discount_percentage','gst_percentage','taxable_value',
      'gst_amount','igst','cgst','sgst','total_amount','gst_treatment','cess_rate',
      'cess_amount','sort_order','created_at','updated_at']
  },

  b2b_hsn: {
    // Legacy — no longer written to directly by normal invoice flow, but
    // the cascade-delete path (server/routes/invoices.js) still needs
    // DELETE here, so only direct INSERT is blocked.
    insertable: false,
    columns: ['id','user_id','hsn_code','product_name','type','quantity','taxable_value',
      'gst_percentage','supply_type','igst','cgst','sgst','total_gst','total_invoice_value',
      'entry_date','source','source_invoice_id','source_invoice_type',
      'created_at','updated_at']
  },
  b2c_hsn: {
    insertable: false,
    columns: ['id','user_id','hsn_code','product_name','type','taxable_value',
      'gst_percentage','supply_type','igst','cgst','sgst','total_gst','total_invoice_value',
      'entry_date','source','source_invoice_id','source_invoice_type',
      'created_at','updated_at']
  },
  invoice_items: {
    columns: ['id','user_id','invoice_id','invoice_type','product_id','product_name',
      'hsn_code','unit','quantity','rate','discount_percentage','gst_percentage',
      'taxable_value','gst_amount','igst','cgst','sgst','total_amount',
      // GST treatment (Phase 2, Module 3)
      'gst_treatment','cess_rate','cess_amount',
      // Cover for this line, in months. Descriptive only.
      'warranty_period_months',
      'sort_order','created_at','updated_at']
  },
  vendors: {
    columns: ['id','user_id','name','gstin','phone','email','address','state','district',
      // Vendor's usual GST status / what it was for THIS purchase.
      'gst_category',
      'created_at','updated_at'],
    validate: makeDistrictValidator([['state', 'district']])
  },
  purchases: {
    columns: ['id','user_id','vendor_id','vendor_name','vendor_gstin','phone','address','state','district',
      // Vendor's usual GST status / what it was for THIS purchase.
      'gst_category',
      'purchase_number','purchase_date','taxable_amount','gst_percentage','gst_amount',
      'total_amount','supply_type','igst','cgst','sgst','payment_status','amount_paid',
      'created_at','updated_at'],
    validate: makeDistrictValidator([['state', 'district']])
  },
  purchase_items: {
    columns: ['id','user_id','purchase_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','total_amount','sort_order',
      'created_at','updated_at']
  },
  purchase_returns: {
    columns: ['id','user_id','vendor_id','vendor_name','vendor_gstin','state','return_number','return_date',
      'original_purchase_id','original_purchase_number','reason','taxable_amount','gst_percentage',
      'gst_amount','total_amount','supply_type','igst','cgst','sgst',
      'created_at','updated_at']
  },
  purchase_return_items: {
    columns: ['id','user_id','return_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','total_amount','sort_order',
      'created_at','updated_at']
  },
  expense_categories: {
    columns: ['id','user_id','name','description','created_at','updated_at']
  },
  expenses: {
    columns: ['id','user_id','category_id','category_name','expense_date','amount',
      'payment_method','payee','description','created_at','updated_at']
  },
  sales_returns: {
    columns: ['id','user_id','original_invoice_id','original_invoice_type','original_invoice_number',
      'customer_name','customer_gstin','phone','address','state','district','return_number','return_date','reason',
      'taxable_amount','gst_percentage','gst_amount','total_amount','supply_type','igst','cgst','sgst',
      'created_at','updated_at'],
    validate: makeDistrictValidator([['state', 'district']])
  },
  sales_return_items: {
    columns: ['id','user_id','return_id','product_id','product_name','hsn_code','unit',
      'quantity','rate','discount_percentage','gst_percentage','taxable_value','gst_amount',
      'igst','cgst','sgst','total_amount','sort_order',
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
