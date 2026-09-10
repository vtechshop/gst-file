// Source-shape guards for serial inventory.
//
// These assert the decisions that are easy to undo by accident later: that
// no serial is ever owned by a document LINE, that the serial table is not
// reachable through the generic router, and that warranty-sync was left
// alone. They read files rather than run anything, so they cost nothing
// and hold whether or not a scratch database is configured.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');

const MIG_SERIALS = rd('server/db/migrations/migration_stock_serials.sql');
const MIG_LINKS = rd('server/db/migrations/migration_stock_serial_links.sql');
const SVC = rd('server/src/services/stock-serials.js');
const STOCK = rd('server/src/routes/stock.js');
const PURCHASES = rd('server/src/routes/purchases.js');
const INVOICES = rd('server/src/routes/invoices.js');
const GENERIC = rd('server/src/routes/generic.js');
const LEDGER = rd('server/src/services/stock-ledger.js');

test('G1 uniqueness is tenant-wide, case- and space-insensitive', () => {
  assert.match(MIG_SERIALS,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_serials_user_serial\s*\n\s*ON stock_serials \(user_id, upper\(btrim\(serial_no\)\)\)/);
  // product_id must NOT be part of the key: a scan has to identify a unit
  // without knowing the product first.
  assert.equal(/ON stock_serials \(user_id, product_id, upper/.test(MIG_SERIALS), false,
    'the key must not include product_id');
});

test('G2 a serial is never owned by a document line', () => {
  // The whole design rests on this. invoice_items and purchase_items are
  // deleted and re-inserted on save, so a foreign key to either would be
  // orphaned by the next edit of the document that owns it.
  assert.equal(/REFERENCES invoice_items/.test(MIG_SERIALS), false);
  assert.equal(/REFERENCES purchase_items/.test(MIG_SERIALS), false);
  assert.equal(/invoice_item_id/.test(MIG_SERIALS), false);
  assert.equal(/purchase_item_id\b/.test(MIG_SERIALS), false);
  // The one line reference that IS stable, because those rows are updated
  // in place rather than replaced.
  assert.match(MIG_SERIALS, /purchase_order_item_id UUID REFERENCES purchase_order_items\(id\)/);
  // And the services look documents up by their header.
  assert.match(SVC, /source_type = \$2 AND source_id = \$3/);
  assert.match(SVC, /sold_source_type = \$2 AND sold_source_id = \$3/);
});

test('G3 the lifecycle is the one that was approved, and scrap is terminal', () => {
  assert.match(SVC, /AVAILABLE: \['SOLD', 'DAMAGED', 'RETURNED_TO_SUPPLIER'\]/);
  assert.match(SVC, /RETURNED: \['AVAILABLE', 'DAMAGED'\]/);
  assert.match(SVC, /SCRAPPED: \[\]/, 'nothing follows scrapped');
  // A unit sent back to the supplier has left the business. It is NOT the
  // same state as a customer's return, which is goods on our premises
  // awaiting inspection — one word for both would make the register unable
  // to answer what we actually hold.
  assert.match(SVC, /RETURNED_TO_SUPPLIER: \[\]/, 'nothing follows a supplier return either');
  assert.match(SVC, /'RETURNED_TO_SUPPLIER'/);
  // A sale must not be able to put a unit straight back on the shelf, and
  // a returned unit is not sellable until it has been inspected.
  assert.match(SVC, /const SELLABLE_STATUS = 'AVAILABLE'/);
  assert.match(SVC, /status !== SELLABLE_STATUS/);
});

test('G4 both accounts move in one transaction', () => {
  // The serial work happens between BEGIN and COMMIT of the document that
  // causes it — never in a transaction of its own, or a rolled-back
  // invoice could leave a unit sold by nothing.
  for (const [name, src, call] of [
    ['purchases', PURCHASES, 'applyPurchaseSerials'],
    ['invoices', INVOICES, 'applyInvoiceSerials']
  ]) {
    const begin = src.indexOf("client.query('BEGIN')");
    const at = src.indexOf(`await ${call}(`);
    const commit = src.indexOf("client.query('COMMIT')", at);
    assert.ok(at > begin, `${name}: inside the transaction`);
    assert.ok(commit > at, `${name}: committed with everything else`);
  }
});

test('G5 the serial check runs before the stock movement on a sale', () => {
  // Order decides the message. The other way round, selling a unit that is
  // already sold fails as "insufficient stock" — true, but it does not
  // tell the person WHICH serial is the problem.
  const at = INVOICES.indexOf('await applyInvoiceSerials(');
  const delta = INVOICES.indexOf('await applyStockDelta(', INVOICES.indexOf('const oldQtyByProduct'));
  assert.ok(at > 0 && delta > at, 'serials are settled first');
});

test('G6 stock_serials is unreachable through the generic router', () => {
  // Not registered at all, which is stronger than marking fields
  // immutable: there is no generic surface to defend. stock_movements and
  // stock_balances are absent for the same reason.
  assert.equal(/\n  stock_serials:/.test(GENERIC), false);
  assert.equal(/\n  stock_movements:/.test(GENERIC), false);
  assert.equal(/\n  stock_balances:/.test(GENERIC), false);
  // The product FLAG is editable, because it is a policy, not a balance.
  assert.match(GENERIC, /'serial_tracking',/);
});

test('G7 the ledger carries the unit, and there is no second history table', () => {
  assert.match(MIG_LINKS, /ALTER TABLE stock_movements\s*\n\s*ADD COLUMN IF NOT EXISTS serial_id UUID/);
  assert.match(LEDGER, /movement\.serialId \|\| null/);
  assert.equal(/stock_serial_movements/.test(MIG_SERIALS + MIG_LINKS + SVC), false,
    'a serial timeline is a query over the ledger, not a table of its own');
});

test('G8 warranty linkage is one-directional and warranty-sync is untouched', () => {
  assert.match(MIG_LINKS, /ALTER TABLE warranties\s*\n\s*ADD COLUMN IF NOT EXISTS serial_id UUID REFERENCES stock_serials\(id\) ON DELETE SET NULL/);
  // The serial does not point back at the warranty: warranty rows are
  // created, cancelled and revived by warranty-sync on every invoice save,
  // and a unit's identity must not depend on one.
  assert.equal(/warranty_id/.test(MIG_SERIALS), false);
  // warranty-sync itself is not part of this release.
  const sync = rd('server/src/services/warranty-sync.js');
  assert.equal(/stock_serials|serial_id/.test(sync), false,
    'warranty-sync.js must not be changed by this phase');
});

test('G9 the migration is additive and invents nothing', () => {
  const both = MIG_SERIALS + MIG_LINKS;
  for (const forbidden of [/\bDROP TABLE\b/, /\bDROP COLUMN\b/, /\bTRUNCATE\b/, /\bDELETE FROM\b/]) {
    assert.equal(forbidden.test(both), false, `${forbidden} must not appear`);
  }
  // No UPDATE of existing rows: no backfill, no fabricated serials, and
  // warranties.serial_number is left exactly as it is.
  assert.equal(/UPDATE\s+warranties/.test(both), false);
  assert.equal(/UPDATE\s+products\s+SET/.test(both), false);
  // Existing products stay quantity-tracked.
  assert.match(MIG_SERIALS, /serial_tracking BOOLEAN NOT NULL DEFAULT FALSE/);
});

test('G10 a serialised product cannot move stock anonymously', () => {
  assert.match(STOCK, /This product is serial-tracked\. Adjust its stock by entering or selecting/);
  // And the serial endpoints are declared before /:productId, or Express
  // would read "serials" as a product id and none of them would exist.
  assert.ok(STOCK.indexOf("router.get('/serials'") < STOCK.indexOf("router.get('/:productId'"),
    'route order matters');
});

test('G11 every serial route is authenticated and tenant-scoped', () => {
  const section = STOCK.slice(STOCK.indexOf("router.get('/serials'"),
    STOCK.indexOf("// ── Stock Summary"));
  assert.match(STOCK, /router\.use\(requireAuth\)/);
  // Every query in the serial section filters on the token's user.
  const queries = section.match(/user_id = \$\d/g) || [];
  assert.ok(queries.length >= 3, 'each serial query is scoped by user_id');
  assert.equal(/req\.body\.user_id|body\.tenant_id|workshopId/.test(section), false,
    'never a tenant id from the browser');
});

test('G12 the Serial Numbers page is linked and served', () => {
  const page = rd('stock-serials.html');
  assert.match(page, /id="snTableBody"/);
  assert.match(page, /client\/js\/pages\/stock-serials\.js\?v=\d+/);
  assert.match(page, /initStockSerials/);
  // Linked from the Inventory section of a page that has a sidebar.
  assert.match(rd('stock.html'), /href="stock-serials\.html"/);
  assert.match(rd('dashboard.html'), /href="stock-serials\.html"/);
});

test('G13 the Product Master can turn serial tracking on', () => {
  assert.match(rd('products.html'), /id="prodSerialTracking"/);
  assert.match(rd('client/js/pages/products.js'),
    /serial_tracking: !!document\.getElementById\('prodSerialTracking'\)\?\.checked/);
});

test('G14 both document grids send serials and check the count first', () => {
  for (const f of ['client/js/pages/purchase-items.js', 'client/js/pages/invoice-items.js']) {
    const src = rd(f);
    assert.match(src, /serials: Array\.isArray\(r\.serials\) \? r\.serials : undefined/, f);
    assert.match(src, /serialLinesProblem\(/, f);
  }
  assert.match(rd('purchases.html'), /client\/js\/pages\/serial-entry\.js/);
  assert.match(rd('invoice.html'), /client\/js\/pages\/serial-entry\.js/);
});

test('G15 the GSTR-1 export and the invoice PDF were not touched', () => {
  // Serial inventory is internal. Nothing about it belongs in a return or
  // on a customer's invoice without a separate decision.
  // Matched on the INVENTORY terms, not the word "serial": gstr1-export.js
  // legitimately talks about serialising JSON, which is a different sense
  // of the word and was there long before any of this.
  const inventoryTerms = /stock_serials|serial_no\b|serial_id\b|serial_number\b/;
  for (const f of ['client/js/gst/gstr1-export.js', 'client/js/pdf/invoice-pdf.js',
    'client/js/pdf/proforma-pdf.js']) {
    let src;
    try { src = rd(f); } catch { continue; }
    assert.equal(inventoryTerms.test(src), false, `${f} must not carry serial inventory yet`);
  }
});

test('G16 both return pages can pick serials, scoped to their own document', () => {
  for (const f of ['sales-returns.html', 'purchase-returns.html']) {
    const page = rd(f);
    assert.match(page, /client\/js\/pages\/serial-entry\.js/, f + ' loads the picker');
    assert.match(page, /id="serialPanel"/, f + ' has the panel');
    assert.match(page, /id="serialPanelBody"/, f);
  }
  // The picker takes a query, so a return offers ONLY the units its own
  // document covers rather than every unit of the product — offering by
  // product alone would show a unit from another delivery or another
  // customer's invoice, which the save would then rightly refuse.
  assert.match(rd('client/js/pages/serial-entry.js'), /const query = o\.query/);
  assert.match(STOCK, /req\.query\.source_id/);
  assert.match(STOCK, /req\.query\.sold_source_id/);
});

test('G17 both return grids send serials and check the count first', () => {
  for (const f of ['client/js/pages/sales-return-items.js', 'client/js/pages/purchase-items.js']) {
    const src = rd(f);
    assert.match(src, /serials: Array\.isArray\(r\.serials\) \? r\.serials : undefined/, f);
    assert.match(src, /serialLinesProblem\(/, f);
  }
});

test('G18 existing stock must be reconciled before tracking can be enabled', () => {
  assert.match(GENERIC, /must be reconciled with serial numbers before Serial Tracking/);
  assert.match(GENERIC, /serial_reconciliation_required/);
  // COUNT(s.id), not COUNT(*): on a LEFT JOIN the latter counts the product
  // row itself and would report a unit for a product that has never had one.
  assert.match(GENERIC, /COUNT\(s\.id\)::int AS serials/);
});

test('G20 Product Master offers reconciliation, and only where it applies', () => {
  const html = rd('products.html');
  const js = rd('client/js/pages/products.js');

  // The action, and the panel it opens - the SAME serial entry the purchase
  // screen uses, so scanning and pasting behave identically.
  assert.match(html, /id="prodReconcileBox"/);
  assert.match(html, /Reconcile Existing Stock/);
  assert.match(html, /client\/js\/pages\/serial-entry\.js/, 'reuses the existing entry panel');
  assert.match(html, /id="serialPanel"/);
  assert.match(html, /id="prodReconcileSave"/);

  // Offered only for a product that is untracked, holds stock, and has no
  // unit recorded. All three conditions, or it stays hidden.
  const fn = js.slice(js.indexOf('async function prodShowReconcile'),
    js.indexOf('function openProdReconcile'));
  assert.match(fn, /r\.serial_tracking \|\| r\.stock == null \|\| !\(\+r\.stock > 0\)/);
  assert.match(fn, /\/stock\/serials\?limit=1&product_id=/, 'and no unit already recorded');
  assert.match(fn, /if \(\(res\.total \|\| 0\) > 0\) return;/);
});

test('G21 the UI uses the existing endpoint and sends only what it should', () => {
  const js = rd('client/js/pages/products.js');
  // Bounded to this function alone: reading to the end of the file would
  // sweep in saveProduct(), which legitimately sends user_id.
  const from = js.indexOf('async function submitProdReconcile');
  const fn = js.slice(from, js.indexOf('\nfunction ', from));

  // One endpoint, the existing one. No second reconciliation path.
  assert.match(fn, /apiFetch\('\/stock\/serials\/reconcile-opening'/);
  assert.strictEqual((js.match(/reconcile-opening/g) || []).length, 1,
    'exactly one call site');
  // Only the product and the numbers. Ownership is the server's to decide.
  assert.match(fn, /body: JSON\.stringify\(\{ product_id: r\.id, serials \}\)/);
  assert.equal(/user_id|tenant_id|location_id/.test(fn), false,
    'the browser must not send ownership or placement');
  // The server's own sentence is shown, not a generic one.
  assert.match(fn, /serialPanelNote\(\(err && err\.message\)/);
});

test('G19 opening reconciliation names units without inventing a purchase', () => {
  const fn = STOCK.slice(
    STOCK.indexOf("router.post('/serials/reconcile-opening'"),
    STOCK.indexOf('// One unit, with the timeline'));
  assert.ok(fn.length > 0, 'the reconciliation route must exist');
  // Marked as opening, pointing at no document.
  assert.match(fn, /sourceType: 'opening', sourceId: null/);
  // Nothing arrives and nothing moves: inventing a PURCHASE row would put
  // goods on a date and a supplier nobody recorded.
  assert.equal(/applyStockDelta|INSERT INTO purchases|INSERT INTO stock_movements/.test(fn), false,
    'reconciliation must not fabricate a purchase or a movement');
  // The count must equal the balance, and the flag flips WITH the units so
  // a product is never tracked with nothing named.
  assert.match(fn, /so it needs exactly /);
  assert.match(fn, /UPDATE products SET serial_tracking = TRUE/);
  // Stock spread across locations is refused rather than divided by guess.
  assert.match(fn, /is held at /);
});
