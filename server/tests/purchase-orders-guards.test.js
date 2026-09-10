// Purchase order guards — the parts decided by the shape of the code.
//
// The rule the whole feature rests on is that an ORDER moves no stock. That
// is asserted here against the source as well as against a database, because
// it is the kind of thing a later edit could quietly undo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ROUTE = read('server/src/routes/purchase-orders.js');
const DOCS = read('server/src/routes/documents.js');
const GENERIC = read('server/src/routes/generic.js');
const APP = read('server/src/app.js');
const MIGRATION = read('server/db/migrations/migration_purchase_orders.sql');
const ENTRY = read('client/js/pages/purchase-order-entry.js');
const LIST = read('client/js/pages/purchase-order-list.js');
const PDF = read('client/js/pages/purchase-order-pdf.js');

test('P1 an order writes no stock; only the receive path does', () => {
  // applyStockDelta appears exactly once in the router, inside receive.
  const calls = ROUTE.match(/applyStockDelta\(/g) || [];
  assert.strictEqual(calls.length, 1, 'stock may be moved in exactly one place');
  const receiveAt = ROUTE.indexOf("router.post('/:id/receive'");
  const saveAt = ROUTE.indexOf("router.post('/save'");
  const statusAt = ROUTE.indexOf("router.post('/:id/status'");
  const callAt = ROUTE.indexOf('applyStockDelta(client');
  assert.ok(receiveAt > -1 && callAt > receiveAt, 'the one call is inside receive');
  assert.ok(callAt > saveAt && callAt > statusAt, 'neither save nor status can reach it');
});

test('P2 it calls the existing ledger rather than writing movements itself', () => {
  assert.match(ROUTE, /const \{ applyStockDelta \} = require\('\.\.\/services\/stock-ledger'\)/);
  assert.equal(/INSERT INTO stock_movements|UPDATE stock_balances/.test(ROUTE), false,
    'there must be no second stock engine');
});

test('P3 the movement is sourced to the purchase, never to the order', () => {
  assert.match(ROUTE, /type: 'PURCHASE', sourceType: 'purchase', sourceId: purchaseId/);
});

test('P4 over-receipt is refused by the application and by the database', () => {
  assert.match(ROUTE, /has only \$\{remaining\} left to receive/);
  assert.match(MIGRATION, /purchase_order_items_no_over_receipt_check CHECK \(received_quantity <= quantity\)/);
});

test('P5 the order row is locked before its remainder is read', () => {
  const receive = ROUTE.slice(ROUTE.indexOf("router.post('/:id/receive'"));
  assert.match(receive, /FROM purchase_orders WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
  assert.match(receive, /ORDER BY id FOR UPDATE/, 'and its items, in a stable order');
  // Everything is validated before anything is written.
  const validateAt = receive.indexOf('left to receive');
  const insertAt = receive.indexOf('INSERT INTO purchases');
  assert.ok(validateAt > -1 && insertAt > validateAt, 'validate the whole receipt, then write');
});

test('P6 a receipt is one transaction, rolled back whole on any failure', () => {
  const receive = ROUTE.slice(ROUTE.indexOf("router.post('/:id/receive'"));
  assert.match(receive, /await client\.query\('BEGIN'\)/);
  assert.match(receive, /await client\.query\('ROLLBACK'\)/);
  assert.match(receive, /await client\.query\('COMMIT'\)/);
});

test('P7 tenancy comes from the JWT on every query', () => {
  assert.match(ROUTE, /router\.use\(requireAuth\)/);
  assert.equal(/body\.user_id|query\.user_id|body\.tenant_id|workshopId/.test(ROUTE), false,
    'a tenant id must never be read from the request');
  const scoped = ROUTE.match(/user_id = \$/g) || [];
  assert.ok(scoped.length >= 10, `expected every statement scoped; found ${scoped.length}`);
  // Vendor and product are checked against the caller, not trusted.
  assert.match(ROUTE, /FROM vendors WHERE id = \$1 AND user_id = \$2/);
  assert.match(ROUTE, /FROM products WHERE user_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/);
});

test('P8 editing merges lines so received quantities survive', () => {
  // The generic document save replaces items wholesale, which would reset
  // received_quantity — this is why the order has its own save.
  assert.match(ROUTE, /const existingById = new Map\(existing\.map/);
  assert.match(ROUTE, /UPDATE purchase_order_items/);
  assert.match(ROUTE, /already has \$\{already\} received/);
  assert.match(ROUTE, /already been received cannot be removed from the order/);
});

test('P9 status and received_quantity cannot be written through a generic save', () => {
  assert.match(GENERIC, /purchase_orders: \{[\s\S]*?immutable: \['status'\]/);
  assert.match(GENERIC, /purchase_order_items: \{[\s\S]*?immutable: \['received_quantity'\]/);
  // documents.js honours the same list, or it would be a way around it.
  assert.match(DOCS, /const immutable = new Set\(TABLES\[table\]\.immutable \|\| \[\]\)/);
  assert.match(DOCS, /!immutable\.has\(c\)/);
});

test('P10 numbering uses the existing document book, race-safe', () => {
  assert.match(DOCS, /purchase_order:\s+\{ table: 'purchase_orders', series: 'purchase_order'/);
  assert.match(DOCS, /purchase_order:\s+'PO-#####'/);
  assert.match(ROUTE, /reserveDocumentNumberOn\(client, req\.userId, 'purchase_order'\)/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_user_series_number/);
  // Invoice, proforma and challan numbering are untouched.
  for (const other of ["proforma_invoice: 'PI-#####'", "bill_of_supply:  'BOS-#####'", "dc_other:        'DC-#####'"]) {
    assert.ok(DOCS.includes(other), `${other} must remain`);
  }
});

test('P11 the status machine is server-side and one-way where it matters', () => {
  assert.match(ROUTE, /const STATUS_TRANSITIONS = \{/);
  assert.match(ROUTE, /PARTIALLY_RECEIVED: \['CLOSED'\]/, 'a partly received order cannot be cancelled');
  assert.match(ROUTE, /FULLY_RECEIVED:     \['CLOSED'\]/);
  assert.match(ROUTE, /CANCELLED:          \[\]/);
  assert.match(ROUTE, /if \(!STATUS_TRANSITIONS\[from\]\.includes\(to\)\)/);
});

test('P12 the purchase keeps a stable reference to its order', () => {
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders\(id\) ON DELETE SET NULL/);
  assert.match(ROUTE, /purchase_order_id\)/);
});

test('P13 the migration is additive and adds exactly one column elsewhere', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS purchase_orders/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS purchase_order_items/);
  const alters = MIGRATION.match(/ALTER TABLE (\w+)/g) || [];
  assert.deepStrictEqual([...new Set(alters)], ['ALTER TABLE purchases'],
    'only purchases gains anything');
  assert.equal(/DROP TABLE|DROP COLUMN|ALTER COLUMN/.test(MIGRATION), false,
    'nothing existing may be dropped or altered');
  assert.equal(/stock_movements|stock_balances/.test(MIGRATION), false,
    'a purchase order migration must not touch stock');
  // Registered. Its position is not pinned: the line-link migration was
  // added after it, and later work may add more.
  const manifest = JSON.parse(read('server/db/migrations/_manifest.json')).order;
  assert.ok(manifest.includes('migration_purchase_orders.sql'));
  assert.strictEqual(new Set(manifest).size, manifest.length, 'no migration listed twice');
});

test('P14 the route is mounted and the list is paged in SQL', () => {
  assert.match(APP, /app\.use\('\/api\/purchase-orders', purchaseOrderRoutes\)/);
  assert.match(ROUTE, /LIMIT \$\{limit\} OFFSET \$\{offset\}/);
  assert.match(ROUTE, /COALESCE\(SUM\(i\.quantity\), 0\)\s+AS ordered_quantity/);
  assert.match(ROUTE, /COALESCE\(SUM\(i\.received_quantity\), 0\) AS received_quantity/);
  // Aggregated in one query, not one per order.
  assert.match(LIST, /apiFetch\('\/purchase-orders\?' \+ params\.toString\(\)\)/);
});

test('P15 the UI reuses the existing item grid and vendor master', () => {
  assert.match(ENTRY, /await initPurchaseItems\(poUser\.id, 'purchase'\)/);
  assert.match(ENTRY, /computePurchRollups\(\)/);
  assert.match(ENTRY, /apiFetch\('\/vendors\?select=/);
  // No second grid, no second vendor table.
  assert.equal(/renderPoItemsTable|CREATE TABLE|po_vendors/.test(ENTRY), false);
});

test('P16 the PDF is its own renderer and prints stored values', () => {
  assert.match(PDF, /function generatePurchaseOrderPDF\(order, items, mode\)/);
  // It reads from the order, and computes no tax of its own.
  assert.match(PDF, /poPdfMoney\(order\.taxable_amount\)/);
  assert.match(PDF, /poPdfMoney\(order\.total_amount\)/);
  // No tax arithmetic. Rounding a quantity for display is not that, so the
  // check is on the rate being used in a calculation rather than on the
  // presence of a division anywhere in the file.
  assert.equal(/gst_percentage\s*[*/]|[*/]\s*.*gst_percentage|\* 0\.18/.test(PDF), false,
    'the PDF must not recompute tax from a rate');
  assert.equal(/taxable_value\s*\*|rate\s*\*\s*quantity/.test(PDF), false,
    'nor recompute a line amount');
  // It is fetched from the server rather than read off the form.
  assert.match(ENTRY, /apiFetch\('\/purchase-orders\/' \+ encodeURIComponent\(poEditId\)\)/);
  assert.match(PDF, /showHead: 'everyPage'/, 'the item header repeats on every page');
  assert.match(PDF, /function poPdfSpace\(doc, y, need\)/, 'and blocks never overlap the footer');
});

test('P20 deleting a receipt gives back the order quantity, in one transaction', () => {
  const PURCHASES = read('server/src/routes/purchases.js');
  // The reversal is the order's rule, so it lives with the order.
  assert.match(ROUTE, /async function reversePurchaseOrderReceipt\(client, userId, purchaseId, deletedItems\)/);
  assert.match(ROUTE, /module\.exports\.reversePurchaseOrderReceipt = reversePurchaseOrderReceipt/);
  // Imported from the order's own module rather than restated here. What
  // matters is where it comes from, not what else is destructured beside
  // it — the edit path now shares receiptStatus and round3 from the same
  // place for the same reason.
  assert.match(PURCHASES,
    /const \{[^}]*\breversePurchaseOrderReceipt\b[^}]*\} = require\('\.\/purchase-orders'\)/);

  // Called inside the cascade-delete transaction, BEFORE the line items it
  // reads are removed, and only for a purchase.
  const cascade = PURCHASES.slice(PURCHASES.indexOf("router.post('/:kind/:id/cascade-delete'"));
  const beginAt = cascade.indexOf("client.query('BEGIN')");
  const callAt = cascade.indexOf('await reversePurchaseOrderReceipt(client');
  const deleteAt = cascade.indexOf(`DELETE FROM \${itemsTable}`);
  const commitAt = cascade.indexOf("client.query('COMMIT')");
  assert.ok(callAt > beginAt, 'inside the transaction');
  assert.ok(callAt < deleteAt, 'before the line items are removed');
  assert.ok(commitAt > callAt, 'and committed with the stock reversal');
  assert.match(cascade, /if \(kind === 'purchase'\)/, 'a return is not a receipt reversal');

  // An ordinary purchase is unaffected: no order, nothing done.
  assert.match(ROUTE, /if \(!orderId\) return null;/);
  // Never below zero, and the status follows what is left. The per-line
  // bound and the link itself are asserted in P22.
  assert.match(ROUTE, /GREATEST\(received_quantity - \$1, 0\)/);
  assert.match(ROUTE, /const next = receiptStatus\(after, orderRows\[0\]\.status\)/);
});

test('P22 the receipt records, and the reversal follows, the exact order line', () => {
  const LINK_MIG = read('server/db/migrations/migration_purchase_order_line_link.sql');
  const PURCHASES = read('server/src/routes/purchases.js');

  // Stored on the way in.
  assert.match(ROUTE, /purchase_order_item_id, product_id, product_name/);
  assert.match(ROUTE, /\[req\.userId, purchaseId, item\.id, item\.product_id/);

  // Followed on the way out — no inference from the product.
  assert.match(ROUTE, /const lineId = it\.purchase_order_item_id;/);
  assert.match(ROUTE, /if \(!lineId\) continue;/);
  assert.equal(/byProduct|candidates\.sort/.test(ROUTE), false,
    'the reversal must not fall back to matching by product');
  // Bounded, so a reversal can never drive a line negative.
  assert.match(ROUTE, /GREATEST\(received_quantity - \$1, 0\)/);
  // And it can only touch a line of the order it belongs to.
  assert.match(ROUTE, /WHERE id = \$2 AND user_id = \$3 AND purchase_order_id = \$4/);

  // The delete path hands the link over, and only for a purchase — a
  // return's items table has no such column.
  assert.match(PURCHASES, /const linkCol = kind === 'purchase' \? ', purchase_order_item_id' : ''/);

  // SET NULL, so deleting an order cannot erase purchase history.
  assert.match(LINK_MIG, /REFERENCES purchase_order_items\(id\) ON DELETE SET NULL/);
  assert.equal(/purchase_order_item_id[\s\S]{0,80}ON DELETE CASCADE/.test(LINK_MIG), false);
  assert.match(LINK_MIG, /CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_order_item/);
  // Additive, and no backfill.
  assert.equal(/DROP |UPDATE purchase_items SET/.test(LINK_MIG), false,
    'the migration must add a column and nothing else');
  const manifest = JSON.parse(read('server/db/migrations/_manifest.json')).order;
  // Registered, and after the migration that creates the table it points
  // at. Its position relative to THAT is what matters; a later feature
  // appending its own migration must not fail this.
  const ordersAt = manifest.indexOf('migration_purchase_orders.sql');
  const linkAt = manifest.indexOf('migration_purchase_order_line_link.sql');
  assert.ok(ordersAt > -1, 'the purchase order migration must be registered');
  assert.ok(linkAt > ordersAt, 'the line link must come after the table it links');
});

test('P21 a concurrent second deletion cannot reverse the same receipt twice', () => {
  const PURCHASES = read('server/src/routes/purchases.js');
  const cascade = PURCHASES.slice(PURCHASES.indexOf("router.post('/:kind/:id/cascade-delete'"));
  // The record is locked before its line items are read, so two deletions
  // cannot both read the same items and each reverse them.
  assert.match(cascade, /FROM \${headerTable} WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
  const lockAt = cascade.indexOf('FOR UPDATE');
  const readAt = cascade.indexOf('SELECT id, product_id, quantity, unit, rate');
  assert.ok(lockAt > -1 && lockAt < readAt, 'lock first, then read the items');
  // And the order rows are locked too, in the same order the receive path
  // takes them.
  assert.match(ROUTE, /FROM purchase_orders WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
  assert.match(ROUTE, /ORDER BY id FOR UPDATE/);
});

test('P17 the tax invoice and proforma PDFs are untouched', () => {
  const inv = read('client/js/pages/invoice-pdf.js');
  const pro = read('client/js/pages/proforma-pdf.js');
  assert.equal(/purchase_order|PURCHASE ORDER/.test(inv), false);
  assert.equal(/purchase_order|PURCHASE ORDER/.test(pro), false);
});

test('P18 purchase orders stay out of GSTR-1', () => {
  const utils = read('client/js/utilities/utils.js');
  const entry = utils.slice(utils.indexOf("key: 'purchase_order'"));
  const block = entry.slice(0, entry.indexOf('},') + 2);
  assert.match(block, /docNum: null/, 'docNum null is what keeps it out of Table 13');
  assert.match(block, /taxable: false/);
  assert.match(block, /affectsTurnover: false/);
  assert.match(block, /direction: 'inward'/);
  const gstr1 = read('client/js/gst/gstr1-export.js');
  assert.equal(/purchase_order/.test(gstr1), false, 'the GSTR-1 export must not know about orders');
});

test('P19 every page offers Purchase Orders exactly once', () => {
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  let withSidebar = 0, withLink = 0;
  for (const f of pages) {
    const html = read(f);
    if (!html.includes('class="sidebar-menu"')) continue;
    withSidebar++;
    const hits = html.match(/href="purchase-orders\.html" class="menu-item/g) || [];
    assert.strictEqual(hits.length, 1, `${f} should link Purchase Orders exactly once`);
    withLink++;
  }
  assert.ok(withSidebar > 30);
  assert.strictEqual(withLink, withSidebar);
});
