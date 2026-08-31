// Automatic warranty registration: the properties that must hold for the
// invoice save to be the single, safe way a warranty comes into existence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const SYNC = rd('server', 'src', 'services', 'warranty-sync.js');
const INVOICES = rd('server', 'src', 'routes', 'invoices.js');
const DOCS = rd('server', 'src', 'routes', 'documents.js');
const LIST = rd('client', 'js', 'pages', 'invoice-list.js');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');
const { warrantyUntilFrom } = require('../src/services/warranty-sync');

// ── where it runs ──
test('A1 the sync runs inside the invoice transaction, before the commit', () => {
  const fn = INVOICES.slice(INVOICES.indexOf("router.post('/:type/save-with-items'"));
  const syncAt = fn.indexOf('syncWarrantiesForInvoice(');
  const commitAt = fn.indexOf("client.query('COMMIT')");
  const itemsAt = fn.indexOf('INSERT INTO invoice_items');
  assert.ok(itemsAt > -1 && syncAt > itemsAt, 'the lines must exist before they are synced');
  assert.ok(commitAt > syncAt, 'the sync must run before the commit, not after');
  // and it is handed the transaction's own client
  assert.match(fn, /syncWarrantiesForInvoice\(\s*[\r\n]?\s*client, req\.userId/);
});

test('A2 a failed invoice save cannot leave a warranty behind', () => {
  const fn = INVOICES.slice(INVOICES.indexOf("router.post('/:type/save-with-items'"));
  // Same transaction, so the rollback covers the register too.
  assert.match(fn, /client\.query\('ROLLBACK'\)/);
  // The sync never opens its own connection.
  assert.equal(/pool\.connect\(\)/.test(SYNC), false, 'the sync must not take its own connection');
  assert.equal(/BEGIN|COMMIT|ROLLBACK/.test(SYNC), false, 'the sync must not manage its own transaction');
});

test('A3 the warranty number is drawn on the same client, not over HTTP', () => {
  assert.match(DOCS, /async function reserveDocumentNumberOn\(client, userId, documentType\)/);
  assert.match(DOCS, /module\.exports\.reserveDocumentNumberOn = reserveDocumentNumberOn/);
  // one implementation: the route calls the same helper
  assert.match(DOCS, /await reserveDocumentNumberOn\(client, req\.userId/);
  assert.equal(/fetch\(|apiFetch\(/.test(SYNC), false, 'the sync must not call itself over HTTP');
});

// ── what it creates ──
test('A4 only lines that actually carry cover produce a record', () => {
  assert.match(SYNC, /\.filter\(it => monthsOf\(it\.warranty_period_months\)\)/);
  const fn = SYNC.slice(SYNC.indexOf('function monthsOf'));
  assert.match(fn, /n > 0 \? n : null/);
});

test('A5 no serial number is ever invented', () => {
  // The INSERT passes a literal NULL in the serial position; nothing
  // computes a value for it.
  const ins = SYNC.slice(SYNC.indexOf('INSERT INTO warranties'));
  assert.ok(ins.includes(',NULL,'), 'serial must be inserted as NULL');
  assert.equal(/generateSerial|makeSerial|randomSerial|uuid\(\)/.test(SYNC), false);
});

// ── idempotence ──
test('A6 a line is matched by product, not by invoice_item_id', () => {
  // save-with-items DELETEs and re-INSERTs items, so the id changes every
  // save; matching on it would mint a new warranty each time.
  assert.match(INVOICES, /DELETE FROM invoice_items/);
  assert.match(SYNC, /function lineKey\(row\)/);
  assert.match(SYNC, /row\.product_id[\s\S]{0,120}product_name/);
  const fn = SYNC.slice(SYNC.indexOf('const takeMatch'));
  assert.match(fn, /claimed\.has\(w\.id\)/, 'each existing record may be claimed once');
});

test('A7 a matched line updates in place and refreshes the item id', () => {
  assert.match(SYNC, /UPDATE warranties SET[\s\S]{0,80}invoice_item_id = \$1/);
  assert.equal(/INSERT INTO warranties[\s\S]{0,400}ON CONFLICT/.test(SYNC), false,
    'matching is done in application logic, not by swallowing a conflict');
});

test('A8 the database unique index is still the backstop', () => {
  const mig = rd('server', 'db', 'migrations', 'migration_warranty_register.sql');
  assert.match(mig, /CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_invoice_item/);
  assert.match(mig, /WHERE invoice_item_id IS NOT NULL/);
});

// ── removal keeps history ──
test('A9 cover removed cancels the record, never deletes it', () => {
  assert.match(SYNC, /status = 'cancelled'/);
  assert.equal(/DELETE FROM warranties/.test(SYNC), false,
    'a tag may already be on the goods - the record must keep resolving');
  assert.match(SYNC, /const AUTO_CANCEL_REASON/);
});

test('A10 re-adding cover revives only what this module cancelled', () => {
  assert.match(SYNC, /match\.cancel_reason === AUTO_CANCEL_REASON/);
  // a human cancellation in the register is not overridden
  assert.match(SYNC, /CASE WHEN \$17::boolean THEN 'active' ELSE status END/);
});

// ── one way in ──
test('A11 the competing manual create flow is gone', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'client', 'js', 'pages', 'warranty-create.js')), false,
    'two ways to create the same record is how duplicates get made');
  assert.equal(/openCreateWarranty/.test(LIST), false);
  assert.match(LIST, /function viewInvoiceWarranties/);
  assert.equal(/warranty-create\.js/.test(rd('invoice-list.html')), false);
});

test('A12 the save reports what the register did, rather than assuming', () => {
  assert.match(ITEMS, /const \{ invoiceId, warranty \} = await apiFetch/);
  assert.match(INVOICES, /res\.json\(\{ invoiceId, warranty \}\)/);
});

// ── tenant isolation ──
test('A13 scoping comes from the verified session, never the request body', () => {
  assert.match(INVOICES, /syncWarrantiesForInvoice\(\s*[\r\n]?\s*client, req\.userId/);
  // every statement in the sync is scoped to the passed userId
  for (const q of ['SELECT id, invoice_item_id', 'UPDATE warranties SET', 'INSERT INTO warranties']) {
    assert.ok(SYNC.includes(q), 'expected query missing: ' + q);
  }
  assert.equal(/req\.body|req\.query|workshop|role/.test(SYNC), false,
    'the sync must not read anything the browser supplied');
});

// ── dates agree with the invoice PDF ──
test('A14 the expiry rule matches the one the invoice prints', () => {
  assert.equal(warrantyUntilFrom('2026-08-29', 12), '2027-08-28');
  assert.equal(warrantyUntilFrom('2026-08-29', 6), '2027-02-28');   // clamped month end
  assert.equal(warrantyUntilFrom('2026-08-29', 1), '2026-09-28');
  assert.equal(warrantyUntilFrom('2026-01-31', 1), '2026-02-28');
  assert.equal(warrantyUntilFrom('2026-03-01', 1), '2026-03-31');
  assert.equal(warrantyUntilFrom('', 6), null);
  assert.equal(warrantyUntilFrom('2026-08-29', 0), null);
});

// ── isolation from the tax document ──
test('A15 registration moves no total, tax figure, sequence, stock or payment', () => {
  // Comments are stripped first: an earlier version of this test matched
  // the word 'stock' inside the comment saying it does not touch stock.
  const code = SYNC.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ['taxable_amount', 'gst_amount', 'cgst', 'sgst', 'igst',
                     'invoice_series_sequences', 'stock', 'payment_status', 'amount_paid']) {
    assert.equal(code.includes(bad), false, 'the sync must not touch ' + bad);
  }
  // it writes to exactly one table
  const writes = [...code.matchAll(/(INSERT INTO|UPDATE)\s+(\w+)/g)].map(m => m[2]);
  assert.deepEqual([...new Set(writes)], ['warranties'], 'writes: ' + writes.join(', '));
});

// ── the invoice-level period is the default for the lines ──
// The bug this guards: the header warranty saved and printed correctly while
// every invoice_items.warranty_period_months stayed NULL, so the register -
// which registers per line - had nothing to create. Five real invoices carried
// header cover and not one line did.
test('A16 the header period is pushed down to the lines that follow it', () => {
  assert.ok(ITEMS.includes('function applyHeaderWarrantyToItems'),
    'a header change must reach the product rows');
  const fn = ITEMS.slice(ITEMS.indexOf('function applyHeaderWarrantyToItems'));
  const body = fn.slice(0, fn.indexOf('persistItemsDraft'));
  assert.ok(body.includes('if (row.warranty_overridden) return;'),
    'a row the user set themselves must not be overwritten');
  // and the header calls it
  assert.ok(ENTRY.includes('applyHeaderWarrantyToItems('),
    'onWarrantyPeriodChange must cascade to the lines');
});

test('A17 an explicit row choice is recorded as an override, not inferred', () => {
  const fn = ITEMS.slice(ITEMS.indexOf("} else if (field === 'warranty_period_months')"));
  const body = fn.slice(0, fn.indexOf("discount_percentage'"));
  assert.ok(body.includes('row.warranty_overridden = true;'),
    'editing the row dropdown is what marks it authoritative');
  // No Warranty stores null, never 0 - a zero-month warranty is not a thing
  assert.ok(body.includes('n > 0 ? n : null'));
});

test('A18 a row added later inherits the current header period', () => {
  assert.ok(ITEMS.includes('warranty_period_months: itemsHeaderWarrantyMonths, warranty_overridden: false'),
    'a new row starts on the header default and following it');
});

test('A19 reopening an invoice restores the line cover', () => {
  const fn = ITEMS.slice(ITEMS.indexOf('function loadItemsIntoTable'));
  const body = fn.slice(0, fn.indexOf('renderItemsTable'));
  assert.ok(body.includes('warranty_period_months:'),
    'editing an invoice must not drop the cover each line was sold with');
  assert.ok(body.includes('warranty_overridden:'),
    'and must reconstruct which rows were following the header');
});

test('A20 the header default is seeded before the lines load', () => {
  // loadItemsIntoTable() compares each line against it, so it has to be set
  // first or every row would look like an override.
  // Execution order, not definition order: restoreWarrantyFields() is
  // defined at the end of the file but CALLED before the lines load.
  const seedAt = ENTRY.indexOf('restoreWarrantyFields(rec);');
  const loadAt = ENTRY.indexOf('loadItemsIntoTable(activeItems)');
  assert.ok(seedAt > -1, 'restoreWarrantyFields must run on edit load');
  assert.ok(ENTRY.includes('setItemsHeaderWarrantyDefault(rec?.warranty_period_months'),
    'and it must seed the header default');
  assert.ok(loadAt > -1 && seedAt < loadAt, 'it must be called before the lines load');
});
