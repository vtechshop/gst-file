// GSTR-1 export FORMAT conformance.
//
// The contract under test is the structure of the Vtech return that the GST
// Portal ACCEPTED (GSTIN 33AARFV8415B1Z4, fp 072026, version GST3.1.7). The
// reference below records that file's SHAPE only — key names, nesting and
// value types. None of its amounts, customer GSTINs, HSN codes or invoice
// numbers appear here or in the exporter; every value in a generated return
// comes from the signed-in company's own rows for the selected period.
//
// Why this file exists: a field-by-field comparison of the accepted return
// against the one the Portal rejected found the schemas IDENTICAL — same
// keys, same nesting, same types at every level. `version` was the only
// difference (GST3.1.7 accepted, GST3.2.4 rejected). So there was no format
// bug to fix, and these tests exist to keep it that way: they fail if a
// future change renames a field, drops one, re-nests a section, turns a
// number into a string, or moves the version off GST3.1.7.
const test = require('node:test');
const assert = require('node:assert');
const { createBrowserContext, makeDataSupabase } = require('./helpers/browser-context');

const ctx = createBrowserContext();

// ── The accepted file's shape, and nothing else ────────────────────
const ACCEPTED_VERSION = 'GST3.1.7';
const ACCEPTED_ROOT    = ['gstin', 'fp', 'version', 'hash', 'b2b', 'b2cs', 'hsn', 'doc_issue'];
const B2B_GROUP        = ['ctin', 'inv'];
const B2B_INV          = ['inum', 'idt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms'];
const B2B_ITM          = ['num', 'itm_det'];
const ITM_DET          = ['txval', 'rt', 'iamt', 'camt', 'samt', 'csamt'];
const B2CS_ROW         = ['sply_ty', 'rt', 'typ', 'pos', 'txval', 'iamt', 'camt', 'samt', 'csamt'];
const HSN_ROW          = ['num', 'hsn_sc', 'desc', 'uqc', 'qty', 'rt', 'txval', 'iamt', 'camt', 'samt', 'csamt'];
const DOC_DET          = ['doc_num', 'doc_typ', 'docs'];
const DOCS_ROW         = ['num', 'from', 'to', 'totnum', 'cancel', 'net_issue'];

const sorted = a => a.slice().sort();
const keysOf = o => Object.keys(o).sort();
function assertKeys(obj, expected, where) {
  assert.deepStrictEqual(keysOf(obj), sorted(expected),
    `${where}: key set drifted from the accepted format`);
}
function assertNumbers(obj, fields, where) {
  fields.forEach(f => assert.strictEqual(typeof obj[f], 'number',
    `${where}.${f} must be a number, got ${typeof obj[f]}`));
}

// ── Fixtures ───────────────────────────────────────────────────────
// Two companies, two months. Deliberately arranged so that a leak in
// either direction produces a visible, specific failure.
const US = 'user-under-test';
const OTHER = 'other-company';
const OUR_GSTIN = '33AARFV8415B1Z4';   // the signed-in company
const THEIR_GSTIN = '33BAVPS1659D1ZD'; // a different company entirely

const b2bInvoice = (over = {}) => ({
  id: 'b2b-1', user_id: US, gst_number: '33BQWPJ0501Q1ZI', customer_name: 'A Customer',
  state: 'Tamil Nadu', invoice_number: '138', invoice_date: '2026-07-02',
  taxable_amount: 16000, gst_percentage: 18, gst_amount: 2880, total_amount: 18880,
  supply_type: 'intrastate', igst: 0, cgst: 1440, sgst: 1440,
  gst_category: 'regular', reverse_charge: false, invoice_source: 'manual', ...over
});
const b2cInvoice = (over = {}) => ({
  id: 'b2c-1', user_id: US, customer_name: 'Walk-in', state: 'Tamil Nadu',
  invoice_number: '139', invoice_date: '2026-07-05',
  taxable_amount: 10000, gst_percentage: 18, gst_amount: 1800, total_amount: 11800,
  supply_type: 'intrastate', igst: 0, cgst: 900, sgst: 900,
  gst_category: 'regular', reverse_charge: false, invoice_source: 'manual', ...over
});
const item = (over = {}) => ({
  id: 'it-1', user_id: US, invoice_id: 'b2b-1', invoice_type: 'b2b',
  product_name: 'Chapathi Press', hsn_code: '84388090', unit: 'NOS',
  quantity: 1, rate: 16000, gst_percentage: 18, taxable_value: 16000,
  gst_amount: 2880, igst: 0, cgst: 1440, sgst: 1440, total_amount: 18880,
  gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0, ...over
});
const hsnRow = (over = {}) => ({
  id: 'h-1', user_id: US, hsn_code: '84388090', product_name: 'Chapathi Press',
  quantity: 1, taxable_value: 16000, gst_percentage: 18, supply_type: 'intrastate',
  igst: 0, cgst: 1440, sgst: 1440, total_gst: 2880, total_invoice_value: 18880,
  entry_date: '2026-07-02', source_invoice_id: 'b2b-1', source_invoice_type: 'b2b', ...over
});

function julyTables(extra = {}) {
  return {
    b2b_invoices: [b2bInvoice()],
    b2c_invoices: [b2cInvoice()],
    invoice_items: [item(), item({ id: 'it-2', invoice_id: 'b2c-1', invoice_type: 'b2c',
      rate: 10000, taxable_value: 10000, gst_amount: 1800, cgst: 900, sgst: 900, total_amount: 11800 })],
    b2b_hsn: [hsnRow()],
    b2c_hsn: [hsnRow({ id: 'h-2', source_invoice_id: 'b2c-1', source_invoice_type: 'b2c',
      taxable_value: 10000, cgst: 900, sgst: 900, total_gst: 1800, total_invoice_value: 11800,
      entry_date: '2026-07-05' })],
    ...extra
  };
}

const PROFILE = { gstin: OUR_GSTIN, state: 'Tamil Nadu', business_name: 'V Tech' };

// buildGSTR1Payload() answers { payload, errors, context } — the file that
// gets written is `payload`. Every test here is about the written file, so
// this unwraps it and fails loudly if the build reported problems, rather
// than letting a test assert against the wrapper and pass for the wrong
// reason.
async function build(tables, period = '2026-07', profile = PROFILE, userId = US) {
  ctx._supabase = makeDataSupabase(tables);
  const res = await ctx.buildGSTR1Payload(userId, profile, period);
  assert.ok(!res.errors || !res.errors.length,
    'export reported errors: ' + JSON.stringify((res.errors || []).slice(0, 3)));
  assert.ok(res.payload && typeof res.payload === 'object', 'no payload was produced');
  return res.payload;
}

// ── A. Root schema ─────────────────────────────────────────────────
test('A. root structure matches the accepted format', async () => {
  const p = await build(julyTables());
  assert.deepStrictEqual(keysOf(p), sorted(ACCEPTED_ROOT),
    'root key set must match the accepted return exactly — no added, removed or renamed sections');
});

// ── B. Version ─────────────────────────────────────────────────────
test('B. version is GST3.1.7, the value the Portal accepted', async () => {
  const p = await build(julyTables());
  assert.strictEqual(p.version, ACCEPTED_VERSION);
  assert.notStrictEqual(p.version, 'GST3.2.4', 'GST3.2.4 was rejected by the Portal');
});

// ── C. GSTIN comes from the signed-in company ──────────────────────
test('C. gstin is the signed-in company\'s, never hardcoded', async () => {
  const ours = await build(julyTables());
  assert.strictEqual(ours.gstin, OUR_GSTIN);

  // The same rows exported under a different company's profile must carry
  // that company's GSTIN — proving the value is read, not baked in.
  const theirs = await build(julyTables(), '2026-07', { ...PROFILE, gstin: THEIR_GSTIN });
  assert.strictEqual(theirs.gstin, THEIR_GSTIN);
  assert.notStrictEqual(theirs.gstin, OUR_GSTIN, 'one company\'s GSTIN leaked into another\'s return');
});

// ── D. fp follows the selected period ──────────────────────────────
test('D. fp is MMYYYY for the selected month', async () => {
  const july = await build(julyTables(), '2026-07');
  assert.strictEqual(july.fp, '072026');

  const augTables = julyTables({
    b2b_invoices: [b2bInvoice({ invoice_date: '2026-08-04', invoice_number: '201' })],
    b2c_invoices: [b2cInvoice({ invoice_date: '2026-08-06', invoice_number: '202' })]
  });
  const aug = await build(augTables, '2026-08');
  assert.strictEqual(aug.fp, '082026');
});

// ── E. No cross-month leakage ──────────────────────────────────────
test('E. August rows are supplied but never reach the July return', async () => {
  // Both months present in the same store. The filters must exclude August.
  const mixed = julyTables({
    b2b_invoices: [b2bInvoice(), b2bInvoice({ id: 'b2b-aug', invoice_number: '999',
      invoice_date: '2026-08-15', gst_number: '33ZZZZZ9999Z1ZZ' })],
    b2c_invoices: [b2cInvoice(), b2cInvoice({ id: 'b2c-aug', invoice_number: '998',
      invoice_date: '2026-08-20' })]
  });
  const july = await build(mixed, '2026-07');
  assert.strictEqual(july.fp, '072026');

  const blob = JSON.stringify(july);
  assert.ok(!blob.includes('999'), 'an August invoice number appears in the July return');
  assert.ok(!blob.includes('15-08-2026'), 'an August date appears in the July return');
  (july.b2b || []).forEach(g => g.inv.forEach(i =>
    assert.ok(i.idt.endsWith('-07-2026'), `invoice ${i.inum} dated ${i.idt} is not in the filed month`)));
});

// ── F. No cross-company leakage ────────────────────────────────────
test('F. another company\'s rows are supplied but never reach this return', async () => {
  const shared = julyTables({
    b2b_invoices: [
      b2bInvoice(),
      b2bInvoice({ id: 'b2b-other', user_id: OTHER, invoice_number: '777',
        gst_number: '33YYYYY7777Y1ZY', taxable_amount: 500000 })
    ],
    b2c_invoices: [
      b2cInvoice(),
      b2cInvoice({ id: 'b2c-other', user_id: OTHER, invoice_number: '778', taxable_amount: 400000 })
    ]
  });
  const mine = await build(shared, '2026-07', PROFILE, US);

  const blob = JSON.stringify(mine);
  assert.ok(!blob.includes('777'), 'another company\'s invoice number appears in this return');
  assert.ok(!blob.includes('778'), 'another company\'s B2C invoice leaked into this return');
  assert.ok(!blob.includes('33YYYYY7777Y1ZY'), 'another company\'s customer GSTIN leaked');
  assert.ok(!blob.includes('500000'), 'another company\'s taxable value leaked');
});

// ── G. B2B structure ───────────────────────────────────────────────
test('G. b2b matches the accepted nesting and field names', async () => {
  const p = await build(julyTables());
  assert.ok(Array.isArray(p.b2b) && p.b2b.length, 'b2b should be a non-empty array here');
  p.b2b.forEach((g, gi) => {
    assertKeys(g, B2B_GROUP, `b2b[${gi}]`);
    assert.strictEqual(typeof g.ctin, 'string');
    assert.ok(Array.isArray(g.inv));
    g.inv.forEach((inv, ii) => {
      assertKeys(inv, B2B_INV, `b2b[${gi}].inv[${ii}]`);
      assert.match(inv.idt, /^\d{2}-\d{2}-\d{4}$/, 'idt must be DD-MM-YYYY');
      assert.strictEqual(typeof inv.val, 'number');
      assert.ok(Array.isArray(inv.itms));
      inv.itms.forEach((it, ti) => {
        assertKeys(it, B2B_ITM, `b2b[${gi}].inv[${ii}].itms[${ti}]`);
        assertKeys(it.itm_det, ITM_DET, `b2b[${gi}].inv[${ii}].itms[${ti}].itm_det`);
        assertNumbers(it.itm_det, ITM_DET, 'itm_det');
      });
    });
  });
});

// ── H. B2CS structure ──────────────────────────────────────────────
test('H. b2cs matches the accepted field names and types', async () => {
  const p = await build(julyTables());
  assert.ok(Array.isArray(p.b2cs) && p.b2cs.length, 'b2cs should be a non-empty array here');
  p.b2cs.forEach((r, i) => {
    assertKeys(r, B2CS_ROW, `b2cs[${i}]`);
    assertNumbers(r, ['rt', 'txval', 'iamt', 'camt', 'samt', 'csamt'], `b2cs[${i}]`);
    assert.ok(['INTER', 'INTRA'].includes(r.sply_ty), 'sply_ty must be INTER or INTRA');
    assert.strictEqual(typeof r.pos, 'string');
  });
});

// ── I. HSN structure ───────────────────────────────────────────────
test('I. hsn keeps hsn_b2b / hsn_b2c and the accepted row shape', async () => {
  const p = await build(julyTables());
  assert.strictEqual(typeof p.hsn, 'object');
  Object.keys(p.hsn).forEach(k =>
    assert.ok(['hsn_b2b', 'hsn_b2c'].includes(k), `unexpected hsn sub-key "${k}"`));
  ['hsn_b2b', 'hsn_b2c'].forEach(k => (p.hsn[k] || []).forEach((r, i) => {
    assertKeys(r, HSN_ROW, `hsn.${k}[${i}]`);
    assertNumbers(r, ['num', 'qty', 'rt', 'txval', 'iamt', 'camt', 'samt', 'csamt'], `hsn.${k}[${i}]`);
    assert.strictEqual(typeof r.hsn_sc, 'string');
    assert.strictEqual(typeof r.uqc, 'string');
  }));
});

// ── J. DOC ISSUE structure ─────────────────────────────────────────
test('J. doc_issue keeps doc_det -> docs with the accepted fields', async () => {
  const p = await build(julyTables());
  assertKeys(p.doc_issue, ['doc_det'], 'doc_issue');
  assert.ok(Array.isArray(p.doc_issue.doc_det));
  p.doc_issue.doc_det.forEach((d, i) => {
    assertKeys(d, DOC_DET, `doc_det[${i}]`);
    assert.strictEqual(typeof d.doc_num, 'number');
    assert.strictEqual(typeof d.doc_typ, 'string');
    d.docs.forEach((doc, j) => {
      assertKeys(doc, DOCS_ROW, `doc_det[${i}].docs[${j}]`);
      assertNumbers(doc, ['num', 'totnum', 'cancel', 'net_issue'], `docs[${j}]`);
      assert.strictEqual(typeof doc.from, 'string');
      assert.strictEqual(typeof doc.to, 'string');
    });
  });
});

// ── K. Numeric fields stay numeric ─────────────────────────────────
test('K. no amount is emitted as a string', async () => {
  const p = await build(julyTables());
  const NUMERIC = new Set(['txval', 'rt', 'iamt', 'camt', 'samt', 'csamt',
    'val', 'qty', 'num', 'totnum', 'cancel', 'net_issue', 'doc_num']);
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    Object.entries(node).forEach(([k, v]) => {
      if (NUMERIC.has(k)) {
        assert.strictEqual(typeof v, 'number', `${path}.${k} is ${typeof v}, must be number`);
        assert.ok(Number.isFinite(v), `${path}.${k} is not finite`);
      }
      walk(v, `${path}.${k}`);
    });
  };
  walk(p, 'root');
});

// ── L. Empty sections ──────────────────────────────────────────────
test('L. a section with no data is omitted, as in the accepted file', async () => {
  // B2B only: b2cs must not appear as an empty array. The accepted return
  // carries exactly the sections that had data and no others.
  const b2bOnly = {
    b2b_invoices: [b2bInvoice()],
    b2c_invoices: [],
    invoice_items: [item()],
    b2b_hsn: [hsnRow()],
    b2c_hsn: []
  };
  const p = await build(b2bOnly);
  assert.ok(!('b2cs' in p), 'an empty b2cs must be omitted, not written as []');
  assert.ok(!('cdnr' in p), 'an empty cdnr must be omitted');
  assert.ok(!('exp' in p), 'an empty exp must be omitted');
  // The four header keys are never omitted, even on a nil return.
  ['gstin', 'fp', 'version', 'hash'].forEach(k =>
    assert.ok(k in p, `header key "${k}" must always be present`));
});

// ── M. The application's own strict validator ──────────────────────
test('M. the generated return passes the app\'s schema and strict validators', async () => {
  const p = await build(julyTables());

  const schemaErrors = [];
  ctx.validateGSTR1Schema(p, schemaErrors);
  assert.deepStrictEqual(schemaErrors, [], 'validateGSTR1Schema rejected the generated return');

  if (typeof ctx.validateGSTR1Strict === 'function') {
    const strict = [];
    ctx.validateGSTR1Strict(p, strict);
    const versionComplaints = strict.filter(e => /version/i.test(String(e)));
    assert.deepStrictEqual(versionComplaints, [],
      'the strict validator objected to the version — it must accept GST3.1.7');
  }
});
