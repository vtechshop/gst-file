// Editing the number on a saved proforma — the parts that are decided by
// the shape of the code rather than by the database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ENTRY = read('client/js/pages/proforma-entry.js');
const DOCS = read('server/src/routes/documents.js');
const PDF = read('client/js/pages/proforma-pdf.js');
const LIST = read('client/js/pages/proforma-list.js');
const HTML = read('proforma.html');

test('P1 the number field is not locked when an existing proforma is opened', () => {
  // This is the whole reported defect: loadProformaForEdit used to end with
  // pfNumber.readOnly = true, so a saved proforma could not be renumbered.
  assert.equal(/pfNumber[\s\S]{0,80}readOnly\s*=\s*true/.test(ENTRY), false,
    'the proforma number must stay editable in edit mode');
  assert.equal(/readOnly\s*=\s*true/.test(ENTRY), false,
    'nothing on this page should be made read-only on load');
});

test('P2 the input itself is an ordinary editable field', () => {
  const input = HTML.match(/<input[^>]*id="pfNumber"[^>]*>/)[0];
  assert.equal(/readonly|disabled/i.test(input), false,
    'the markup must not lock the field either');
  // One field, not a second "edit number" control beside it.
  assert.strictEqual((HTML.match(/id="pfNumber"/g) || []).length, 1);
});

test('P3 a saved proforma is updated in place, never re-created', () => {
  // editId is what makes the save route UPDATE instead of INSERT.
  assert.match(ENTRY, /editId: proformaEditId \|\| undefined/);
  assert.match(DOCS, /if \(editId\) \{[\s\S]{0,400}UPDATE \$\{table\} SET/);
});

test('P4 the page reads the id back off the document, not off the envelope', () => {
  // The route answers { document, items }. Reading res.id gave undefined,
  // so a new proforma never learned its own id and saving twice wrote two
  // rows — the duplicate-record failure this change has to avoid.
  assert.match(ENTRY, /const saved = res && res\.document;/);
  assert.match(ENTRY, /if \(saved && saved\.id\) proformaEditId = saved\.id;/);
  assert.equal(/if \(res && res\.id\) proformaEditId/.test(ENTRY), false,
    'the old envelope read must be gone');
});

test('P5 clearing the number on a saved proforma is refused, not auto-renumbered', () => {
  // The blank check must come BEFORE the reserve-number call, or an empty
  // field would silently issue a fresh number for an offer already sent.
  const blankAt = ENTRY.indexOf('if (proformaEditId && !document_.document_number)');
  const reserveAt = ENTRY.indexOf("/documents/reserve-number");
  assert.ok(blankAt > -1, 'the blank guard must exist');
  assert.ok(reserveAt > -1, 'the reservation must still exist');
  assert.ok(blankAt < reserveAt,
    'the blank guard must run before a number is reserved');
});

test('P6 the server validates the number inside the transaction', () => {
  assert.match(DOCS, /const numberCol = spec\.numberCol \|\| 'document_number';/);
  assert.match(DOCS, /A \$\{numberLabel\(type\)\} number is required\./);
  assert.match(DOCS, /number already exists\./);
  // Between BEGIN and the write, so the duplicate check cannot race a
  // concurrent save.
  const begin = DOCS.indexOf("await client.query('BEGIN')");
  const check = DOCS.indexOf('SELECT 1 FROM ${table} WHERE ${where} LIMIT 1');
  const update = DOCS.indexOf('UPDATE ${table} SET ${setClause}');
  assert.ok(begin > -1 && check > begin && check < update,
    'the check must sit inside the transaction and before the write');
});

test('P7 uniqueness is scoped to the tenant and the numbering book', () => {
  assert.match(DOCS, /let where = `user_id = \$1 AND UPPER\(\$\{numberCol\}\) = UPPER\(\$2\)`/);
  assert.match(DOCS, /where \+= ` AND document_series = \$\$\{params\.length\}`/);
  // The tenant comes from the JWT.
  assert.match(DOCS, /const params = \[req\.userId, number\]/);
  assert.equal(/body\.user_id|body\.tenant_id|query\.user_id/.test(DOCS), false,
    'a tenant id must never be taken from the request');
});

test('P8 the record being edited is excluded from its own duplicate check', () => {
  // Saving PI-00002 unchanged must keep working.
  assert.match(DOCS, /if \(editId\) \{ params\.push\(editId\); where \+= ` AND id <> \$\$\{params\.length\}`; \}/);
});

test('P9 auto-numbering is untouched', () => {
  // The generator still counts from the profile sequence and skips numbers
  // already taken, so a manually renamed document cannot corrupt the book.
  assert.match(DOCS, /async function reserveDocumentNumberOn\(client, userId, documentType\)/);
  assert.match(DOCS, /while \(used\.has\(candidate\.toUpperCase\(\)\) && guard < 100000\)/);
  assert.match(DOCS, /SET document_series_sequences =/);
  assert.match(DOCS, /proforma_invoice: 'PI-#####'/);
});

test('P10 the PDF prints whatever number the record currently holds', () => {
  assert.match(PDF, /invoice_number: row\.document_number \|\| ''/);
  assert.match(PDF, /Proforma_\$\{row\.document_number \|\| row\.id\.slice\(0, 8\)\}\.pdf/);
  // No cached or separately stored copy of the number to go stale.
  assert.equal(/proforma_number/.test(PDF), false);
});

test('P11 the list renders the number straight from the row', () => {
  assert.match(LIST, /document_number/);
  assert.equal(/proforma_number/.test(LIST), false);
});

test('P12 conversion is keyed by id, so renumbering cannot break it', () => {
  const INV = read('client/js/pages/invoice-entry.js');
  assert.match(INV, /\.eq\('id', proformaId\)/);
  // The link stored on the proforma is an invoice id, not an invoice number.
  assert.match(INV, /converted_invoice_id: invoiceId/);
  assert.equal(/converted_invoice_number/.test(INV), false);
});

test('P13 no migration was added — the column already exists', () => {
  const manifest = JSON.parse(read('server/db/migrations/_manifest.json')).order;
  // No migration of this feature's own. The absolute count is deliberately
  // not asserted: a later, unrelated feature adding one says nothing about
  // whether THIS change needed a schema change.
  assert.equal(manifest.some(m => /proforma_number|document_number/i.test(m)), false);
  // document_number is the existing column, on the existing table.
  const mig = read('server/db/migrations/migration_proforma_invoices.sql');
  assert.match(mig, /document_number TEXT NOT NULL/);
});

test('P14 the changed script carries a new cache key', () => {
  // ?v= is the only cache mechanism these pages have.
  const m = HTML.match(/client\/js\/pages\/proforma-entry\.js\?v=(\d+)/);
  assert.ok(m, 'proforma.html must load proforma-entry.js with a version');
  assert.ok(Number(m[1]) >= 41, `expected a bumped cache key, found v=${m[1]}`);
});
