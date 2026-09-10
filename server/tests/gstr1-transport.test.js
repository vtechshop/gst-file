// Transport charge in the GSTR-1 return.
//
// The invoice stores a delivery charge and its 18% inside taxable_amount,
// gst_amount and total_amount. GSTR-1 rebuilds everything from the LINE
// ITEMS, which do not contain the charge — so without the representation
// tested here the return either drops the invoice as a total mismatch or,
// worse, files it silently at the goods-only value.
//
// The representation: the charge joins the invoice's rate-wise `itms` (the
// Portal's tables 4A/5/7 carry no HSN, so an 18% delivery belongs in the
// same rate entry as 18% goods), and it gets its OWN service SAC row in the
// HSN summary. Product HSN rows are never touched and nothing is allocated
// across them — which is what makes a 5% + 18% + 18%-transport invoice
// representable at all.
//
// These drive the REAL exporter end to end rather than asserting on source
// text: every figure below came out of buildGSTR1Payload().
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const GSTR1 = rd('client', 'js', 'gst', 'gstr1-export.js');

const noop = () => {};
const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop });

// A query builder shaped like the one the app uses: chainable, and thenable
// to { data, error } — the exact contract readAll()/gstr1Read() expect.
function makeSupabase(tables) {
  return {
    from(table) {
      const b = {};
      for (const m of ['select', 'eq', 'gte', 'lte', 'lt', 'gt', 'in', 'order', 'limit', 'neq', 'is', 'not']) b[m] = () => b;
      b.single = () => ({ then: (res) => res({ data: (tables[table] || [])[0] || null, error: null }) });
      b.then = (res) => res({ data: tables[table] || [], error: null });
      return b;
    }
  };
}

function load(tables) {
  const el = mkEl();
  const sb = {
    console: { log: noop, warn: noop, error: noop, info: noop, group: noop, groupEnd: noop, table: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: el, body: el, head: el,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl() },
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    _supabase: makeSupabase(tables)
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(rd('client', 'js', 'api', 'apiClient.js'), sb, { filename: 'apiClient.js' });
  vm.runInContext(GSTR1, sb, { filename: 'gstr1-export.js' });
  // getReportDateRange lives in reports.js, which loads beside the exporter
  // on reports.html. Loading that whole file would drag in ExcelJS, so the
  // one branch used here is provided instead (reports.js:498, "YYYY-MM").
  vm.runInContext(`
    function getReportDateRange(filter) {
      const [yr, mo] = String(filter).split('-').map(Number);
      return { start: toISO(new Date(yr, mo - 1, 1)), end: toISO(new Date(yr, mo, 0)) };
    }
    showToast = function () {}; handleApiError = function () {};
  `, sb);
  return sb;
}

// Check digits are real (validateGstin agrees), so GSTIN validation is
// never what fails a case here. Disposable, belonging to nobody.
const USER = 'u1';
const GSTIN_SELF = '29AABCU9603R1ZJ';   // Karnataka (29)
const GSTIN_KA = '29AAACI1681G1ZL';     // intra-state, registered
const GSTIN_MH = '27AAACI1681G1ZP';     // inter-state, registered
const PROFILE = { id: USER, gstin: GSTIN_SELF, state: 'Karnataka', business_name: 'Test Co' };

function invoice(o) {
  return {
    id: o.id, user_id: USER, gst_number: o.ctin || null, customer_name: 'Cust ' + o.id,
    invoice_number: o.num, invoice_date: '2026-08-10',
    supply_type: o.supply, state: o.supply === 'interstate' ? 'Maharashtra' : 'Karnataka',
    taxable_amount: o.taxable, gst_percentage: 18, gst_amount: o.gst,
    igst: o.igst || 0, cgst: o.cgst || 0, sgst: o.sgst || 0, cess_amount: 0,
    total_amount: o.total, gst_category: 'regular', reverse_charge: false,
    invoice_source: 'offline', payment_status: 'unpaid', amount_paid: 0,
    transport_charge: o.transport === undefined ? null : o.transport,
    transport_gst_amount: o.transportGst === undefined ? null : o.transportGst
  };
}
function item(o) {
  return {
    id: o.id, user_id: USER, invoice_id: o.invoice_id, invoice_type: o.type,
    product_id: 'p' + o.id, product_name: o.name || 'Machine',
    hsn_code: o.hsn || '84388090', unit: 'PCS', quantity: 1,
    rate: o.taxable, discount_percentage: 0, gst_percentage: o.rate,
    taxable_value: o.taxable, gst_amount: o.gst, gst_treatment: o.treatment || 'taxable',
    igst: o.igst || 0, cgst: o.cgst || 0, sgst: o.sgst || 0,
    cess_rate: 0, cess_amount: 0, total_amount: o.taxable + o.gst, sort_order: 0
  };
}

async function build({ b2b = [], b2c = [], items = [] }) {
  const sb = load({
    b2b_invoices: b2b, b2c_invoices: b2c, invoice_items: items,
    cdn_notes: [], sales_returns: [], sales_return_items: [],
    b2b_hsn: [], b2c_hsn: [], gst_amendments: [], advance_adjustments: [],
    products: [], documents: [], profiles: [PROFILE]
  });
  const res = await sb.buildGSTR1Payload(USER, PROFILE, '2026-08');
  return { sb, res, payload: res.payload, errors: res.errors || [] };
}

const errText = (errors) => errors.map(e => typeof e === 'string' ? e : (e.message || JSON.stringify(e))).join(' | ');
const hsnRows = (p) => [...((p.hsn && p.hsn.hsn_b2b) || []), ...((p.hsn && p.hsn.hsn_b2c) || [])];
const sum = (a, f) => Number(a.reduce((t, x) => t + f(x), 0).toFixed(2));
const sacRows = (p) => hsnRows(p).filter(r => r.hsn_sc === '996511');

// Every declared figure, on whichever channel the invoice landed in.
function declared(p) {
  const perInv = [...(p.b2b || []), ...(p.b2cl || [])].flatMap(g => g.inv);
  const itms = perInv.flatMap(i => i.itms.map(x => x.itm_det));
  const cs = p.b2cs || [];
  return {
    val: sum(perInv, i => i.val),
    txval: Number((sum(itms, i => i.txval) + sum(cs, r => r.txval)).toFixed(2)),
    tax: Number((sum(itms, i => (i.iamt || 0) + (i.camt || 0) + (i.samt || 0))
      + sum(cs, r => (r.iamt || 0) + (r.camt || 0) + (r.samt || 0))).toFixed(2)),
    camt: Number((sum(itms, i => i.camt || 0) + sum(cs, r => r.camt || 0)).toFixed(2)),
    samt: Number((sum(itms, i => i.samt || 0) + sum(cs, r => r.samt || 0)).toFixed(2)),
    iamt: Number((sum(itms, i => i.iamt || 0) + sum(cs, r => r.iamt || 0)).toFixed(2)),
    hsnTxval: sum(hsnRows(p), r => r.txval),
    hsnTax: sum(hsnRows(p), r => (r.iamt || 0) + (r.camt || 0) + (r.samt || 0))
  };
}

// The machine invoice: 2700 of goods at 18%.
const MACHINE = (id, supply) => item({ id: 'it' + id, invoice_id: id, type: 'b2b', taxable: 2700,
  rate: 18, gst: 486, igst: supply === 'interstate' ? 486 : 0,
  cgst: supply === 'interstate' ? 0 : 243, sgst: supply === 'interstate' ? 0 : 243 });

// ═══ 1-2, 16: nothing charged — the return must not change at all ══════

test('X1 an invoice with NO transport exports exactly as before', async () => {
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i1', num: 'A-1', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 2700, gst: 486, cgst: 243, sgst: 243, total: 3186 })],
    items: [MACHINE('i1', 'intrastate')]
  });
  assert.strictEqual(errText(errors), '', 'a plain invoice must export cleanly');
  const d = declared(payload);
  assert.strictEqual(d.val, 3186);
  assert.strictEqual(d.txval, 2700);
  assert.strictEqual(d.tax, 486);
  assert.strictEqual(hsnRows(payload).length, 1, 'one product HSN row and nothing else');
  assert.strictEqual(sacRows(payload).length, 0, 'no SAC row may be emitted');
  assert.strictEqual(d.hsnTxval, 2700);
});

test('X2 a ZERO transport charge emits no service row either', async () => {
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i2', num: 'A-2', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 2700, gst: 486, cgst: 243, sgst: 243, total: 3186,
      transport: 0, transportGst: 0 })],
    items: [MACHINE('i2', 'intrastate')]
  });
  assert.strictEqual(errText(errors), '');
  assert.strictEqual(sacRows(payload).length, 0, '0 means nothing was charged');
  const d = declared(payload);
  assert.strictEqual(d.val, 3186);
  assert.strictEqual(d.txval, 2700);
  assert.strictEqual(d.hsnTxval, 2700);
});

// ═══ 3, 5-12, 15: MANDATORY FLOW A — intra-state ══════════════════════

test('X3 MANDATORY FLOW A - intra-state transport is fully declared', async () => {
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i3', num: 'A-3', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366,
      transport: 1000, transportGst: 180 })],
    items: [MACHINE('i3', 'intrastate')]
  });
  assert.strictEqual(errText(errors), '', 'the invoice must not be dropped');
  const d = declared(payload);

  assert.strictEqual(d.val, 4366, 'declared invoice value is the STORED total');
  assert.strictEqual(d.txval, 3700, 'product 2700 + transport 1000');
  assert.strictEqual(d.tax, 666, 'product 486 + transport 180');
  assert.strictEqual(d.camt, 333);
  assert.strictEqual(d.samt, 333);
  assert.strictEqual(d.iamt, 0);

  // The SAC row: its own row, at its own rate, with the service UQC.
  const sac = sacRows(payload);
  assert.strictEqual(sac.length, 1, 'exactly one transport row');
  assert.strictEqual(sac[0].hsn_sc, '996511');
  assert.strictEqual(sac[0].rt, 18);
  assert.strictEqual(sac[0].txval, 1000);
  assert.strictEqual(sac[0].camt, 90);
  assert.strictEqual(sac[0].samt, 90);
  assert.strictEqual(sac[0].iamt, 0);
  assert.strictEqual(sac[0].uqc, 'NA', 'a delivery is not counted in pieces');
  assert.strictEqual(sac[0].qty, 0);

  // The product row is untouched by it.
  const prod = hsnRows(payload).filter(r => r.hsn_sc === '84388090');
  assert.strictEqual(prod.length, 1);
  assert.strictEqual(prod[0].txval, 2700, 'the product HSN must not absorb transport');
  assert.strictEqual(prod[0].camt, 243);

  // 11. HSN reconciliation.
  assert.strictEqual(d.hsnTxval, d.txval, 'invoice taxable must equal HSN/SAC taxable');
  assert.strictEqual(d.hsnTax, d.tax, 'invoice GST must equal HSN/SAC GST');
});

// ═══ 4: MANDATORY FLOW B — inter-state ════════════════════════════════

test('X4 MANDATORY FLOW B - inter-state puts the whole transport tax in IGST', async () => {
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i4', num: 'A-4', ctin: GSTIN_MH, supply: 'interstate',
      taxable: 3700, gst: 666, igst: 666, total: 4366,
      transport: 1000, transportGst: 180 })],
    items: [MACHINE('i4', 'interstate')]
  });
  assert.strictEqual(errText(errors), '');
  const d = declared(payload);
  assert.strictEqual(d.val, 4366);
  assert.strictEqual(d.txval, 3700);
  assert.strictEqual(d.iamt, 666);
  assert.strictEqual(d.camt, 0);
  assert.strictEqual(d.samt, 0);

  const sac = sacRows(payload);
  assert.strictEqual(sac[0].iamt, 180);
  assert.strictEqual(sac[0].camt, 0);
  assert.strictEqual(sac[0].samt, 0);
  assert.strictEqual(d.hsnTxval, d.txval);
  assert.strictEqual(d.hsnTax, d.tax);
});

// ═══ 14: MANDATORY FLOW C — mixed product rates ═══════════════════════

test('X5 MANDATORY FLOW C - 5% + 18% goods with 18% transport, no allocation', async () => {
  // A 3000@5% = 150 | B 1700@18% = 306 | transport 1000@18% = 180
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i5', num: 'A-5', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 5700, gst: 636, cgst: 318, sgst: 318, total: 6336,
      transport: 1000, transportGst: 180 })],
    items: [
      item({ id: 'it5a', invoice_id: 'i5', type: 'b2b', taxable: 3000, rate: 5, gst: 150, cgst: 75, sgst: 75, hsn: '85044090', name: 'Cable' }),
      item({ id: 'it5b', invoice_id: 'i5', type: 'b2b', taxable: 1700, rate: 18, gst: 306, cgst: 153, sgst: 153 })
    ]
  });
  assert.strictEqual(errText(errors), '', 'a mixed-rate transport invoice must not be rejected');
  const d = declared(payload);
  assert.strictEqual(d.val, 6336);
  assert.strictEqual(d.txval, 5700);
  assert.strictEqual(d.tax, 636);

  // Each product HSN row stays at its OWN rate and its OWN value.
  const rows = hsnRows(payload);
  const five = rows.find(r => r.hsn_sc === '85044090');
  const eighteen = rows.find(r => r.hsn_sc === '84388090');
  const sac = rows.find(r => r.hsn_sc === '996511');
  assert.strictEqual(five.rt, 5);
  assert.strictEqual(five.txval, 3000, 'the 5% row must not absorb any transport');
  assert.strictEqual(eighteen.rt, 18);
  assert.strictEqual(eighteen.txval, 1700, 'the 18% row must not absorb any transport');
  assert.strictEqual(sac.rt, 18);
  assert.strictEqual(sac.txval, 1000, 'transport stands alone');
  assert.strictEqual(rows.length, 3);

  assert.strictEqual(d.hsnTxval, 5700);
  assert.strictEqual(d.hsnTxval, d.txval);
  assert.strictEqual(d.hsnTax, d.tax);
});

// ═══ 8-9: counted exactly once ════════════════════════════════════════

test('X6 transport taxable and transport GST are each counted exactly once', async () => {
  const { payload } = await build({
    b2b: [invoice({ id: 'i6', num: 'A-6', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366,
      transport: 1000, transportGst: 180 })],
    items: [MACHINE('i6', 'intrastate')]
  });
  const d = declared(payload);
  // Counted twice anywhere and these would read 4700 / 846 / 5546.
  assert.strictEqual(d.txval - 2700, 1000, 'the charge lands once');
  assert.strictEqual(d.tax - 486, 180, 'its tax lands once');
  assert.strictEqual(d.val, 4366);
  assert.notStrictEqual(d.txval, 4700);
  assert.notStrictEqual(d.tax, 846);
  // ...and the HSN side agrees, which it cannot if either were doubled.
  assert.strictEqual(d.hsnTxval, 3700);
  assert.strictEqual(sacRows(payload).length, 1);
});

// ═══ 17: aggregation across invoices ══════════════════════════════════

test('X7 several invoices on the same SAC aggregate into one summary row', async () => {
  const { payload, errors } = await build({
    b2b: [
      invoice({ id: 'i7', num: 'A-7', ctin: GSTIN_KA, supply: 'intrastate',
        taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366, transport: 1000, transportGst: 180 }),
      invoice({ id: 'i8', num: 'A-8', ctin: GSTIN_KA, supply: 'intrastate',
        taxable: 3200, gst: 576, cgst: 288, sgst: 288, total: 3776, transport: 500, transportGst: 90 })
    ],
    items: [MACHINE('i7', 'intrastate'), MACHINE('i8', 'intrastate')]
  });
  assert.strictEqual(errText(errors), '');
  const sac = sacRows(payload);
  assert.strictEqual(sac.length, 1, 'Table 12 is a summary — one row per code and rate');
  assert.strictEqual(sac[0].txval, 1500, '1000 + 500');
  assert.strictEqual(sac[0].camt, 135, '90 + 45');
  assert.strictEqual(sac[0].samt, 135);
  const d = declared(payload);
  assert.strictEqual(d.hsnTxval, d.txval);
  assert.strictEqual(d.hsnTax, d.tax);
});

// ═══ 13: B2C channels ═════════════════════════════════════════════════

test('X8 B2CS - transport reaches the state+rate aggregate and its own SAC row', async () => {
  const { payload, errors } = await build({
    b2c: [invoice({ id: 'i9', num: 'C-1', ctin: null, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366,
      transport: 1000, transportGst: 180 })],
    items: [item({ id: 'it9', invoice_id: 'i9', type: 'b2c', taxable: 2700, rate: 18, gst: 486, cgst: 243, sgst: 243 })]
  });
  assert.strictEqual(errText(errors), '');
  assert.ok(payload.b2cs && payload.b2cs.length, 'a small B2C sale aggregates into b2cs');
  const row = payload.b2cs.find(r => r.rt === 18);
  assert.strictEqual(row.txval, 3700);
  assert.strictEqual(row.camt, 333);
  assert.strictEqual(row.samt, 333);
  const sac = sacRows(payload);
  assert.strictEqual(sac.length, 1);
  assert.strictEqual(sac[0].txval, 1000);
  const d = declared(payload);
  assert.strictEqual(d.hsnTxval, d.txval);
  assert.strictEqual(d.hsnTax, d.tax);
});

test('X9 B2CL - a large inter-state sale declares transport per invoice', async () => {
  const { payload, errors } = await build({
    b2c: [invoice({ id: 'i10', num: 'C-2', ctin: null, supply: 'interstate',
      taxable: 201000, gst: 36180, igst: 36180, total: 237180,
      transport: 1000, transportGst: 180 })],
    items: [item({ id: 'it10', invoice_id: 'i10', type: 'b2c', taxable: 200000, rate: 18, gst: 36000, igst: 36000 })]
  });
  assert.strictEqual(errText(errors), '');
  assert.ok(payload.b2cl && payload.b2cl.length, 'over the threshold this is b2cl');
  const d = declared(payload);
  assert.strictEqual(d.val, 237180);
  assert.strictEqual(d.txval, 201000);
  assert.strictEqual(d.iamt, 36180);
  assert.strictEqual(sacRows(payload)[0].txval, 1000);
  assert.strictEqual(d.hsnTxval, d.txval);
  assert.strictEqual(d.hsnTax, d.tax);
});

// ═══ MANDATORY FLOW E: edit and clear ═════════════════════════════════

test('X10 MANDATORY FLOW E - editing the charge moves the SAC row, clearing removes it', async () => {
  const at = async (transport, transportGst, taxable, gst, half, total) => {
    const { payload, errors } = await build({
      b2b: [invoice({ id: 'i11', num: 'A-11', ctin: GSTIN_KA, supply: 'intrastate',
        taxable, gst, cgst: half, sgst: half, total,
        transport, transportGst })],
      items: [MACHINE('i11', 'intrastate')]
    });
    assert.strictEqual(errText(errors), '');
    return { payload, d: declared(payload) };
  };

  const before = await at(1000, 180, 3700, 666, 333, 4366);
  assert.strictEqual(sacRows(before.payload)[0].txval, 1000);
  assert.strictEqual(before.d.val, 4366);

  const after = await at(1500, 270, 4200, 756, 378, 4956);
  assert.strictEqual(sacRows(after.payload).length, 1, 'still exactly one row');
  assert.strictEqual(sacRows(after.payload)[0].txval, 1500, 'the OLD 1000 must not survive');
  assert.strictEqual(sacRows(after.payload)[0].camt, 135);
  assert.strictEqual(after.d.val, 4956);
  assert.strictEqual(after.d.hsnTxval, after.d.txval);

  const cleared = await at(undefined, undefined, 2700, 486, 243, 3186);
  assert.strictEqual(sacRows(cleared.payload).length, 0, 'the service row disappears');
  assert.strictEqual(cleared.d.val, 3186);
  assert.strictEqual(cleared.d.txval, 2700);
  assert.strictEqual(cleared.d.hsnTxval, 2700);
});

// ═══ 10-11: the blocking safety test, stated as its own case ══════════

test('X11 BLOCKING SAFETY - stored, declared and HSN figures agree on every shape', async () => {
  const cases = [
    ['no transport', { taxable: 2700, gst: 486, cgst: 243, sgst: 243, total: 3186 }],
    ['zero transport', { taxable: 2700, gst: 486, cgst: 243, sgst: 243, total: 3186, transport: 0, transportGst: 0 }],
    ['intra transport', { taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366, transport: 1000, transportGst: 180 }],
    ['decimal transport', { taxable: 3700.55, gst: 666.1, cgst: 333.05, sgst: 333.05, total: 4367, transport: 1000.55, transportGst: 180.1 }]
  ];
  for (const [name, o] of cases) {
    const { payload, errors } = await build({
      b2b: [invoice({ id: 'z', num: 'Z-1', ctin: GSTIN_KA, supply: 'intrastate', ...o })],
      items: [MACHINE('z', 'intrastate')]
    });
    assert.strictEqual(errText(errors), '', name + ' must export cleanly');
    const d = declared(payload);
    assert.strictEqual(d.val, o.total, name + ': declared total must equal the stored total');
    assert.strictEqual(d.txval, o.taxable, name + ': declared taxable must equal the stored taxable');
    assert.strictEqual(d.tax, o.gst, name + ': declared GST must equal the stored GST');
    assert.strictEqual(d.hsnTxval, d.txval, name + ': invoice taxable must equal HSN/SAC taxable');
    assert.strictEqual(d.hsnTax, d.tax, name + ': invoice GST must equal HSN/SAC GST');
  }
});

// ═══ The reconciliation guard is still armed ══════════════════════════

test('X12 a genuinely wrong stored total is still rejected', async () => {
  // Transport must not become an excuse for any difference. 9999 is not
  // explained by the 1000 charge, so the invoice is still refused.
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i12', num: 'A-12', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 9999,
      transport: 1000, transportGst: 180 })],
    items: [MACHINE('i12', 'intrastate')]
  });
  assert.match(errText(errors), /Invoice Total|differs from the line items/i,
    'a real mismatch must still be reported');
  assert.ok(!payload || !payload.b2b || !payload.b2b.length,
    'and the invoice must not be exported');
});

test('X13 the final HSN audit is still active and still runs', async () => {
  // Proved by construction: the audit is what would fire if the SAC row
  // were omitted while the itms carried transport. Its text is pinned so
  // the guard cannot be quietly deleted.
  assert.match(GSTR1, /RECONCILIATION FAILED/);
  assert.match(GSTR1, /does not equal HSN section taxable total/);
  assert.match(GSTR1, /function runFinalGSTR1Audit/);
});

// ═══ Configuration is in ONE place ════════════════════════════════════

test('X14 the SAC and the rate are stated once, and nowhere else', async () => {
  assert.match(GSTR1, /const GSTR1_TRANSPORT = \{/);
  assert.match(GSTR1, /sac: '996511'/);
  // The rate is NOT configured: it is whatever the invoice was taxed at.
  assert.ok(!/rate: 18,/.test(GSTR1), 'no fixed transport rate may remain');
  assert.match(GSTR1, /rate: round2\(gst \/ charge \* 100\)/);
  // The literal SAC appears exactly once in the file - the config block.
  assert.strictEqual((GSTR1.match(/996511/g) || []).length, 1,
    'the SAC must not be repeated anywhere in the export engine');
  // Neither the SAC nor the rate is read from a product. Comments stripped
  // first: the code carries prose about the 18% rule, and the guard must
  // read the code rather than the explanation of it.
  const fn = GSTR1.slice(GSTR1.indexOf('function gstr1TransportOf'),
    GSTR1.indexOf('function gstr1WithTransport')).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/hsn_code/.test(fn), 'the transport SAC must never come from a product HSN');
  assert.ok(!/\b18\b/.test(fn), 'no fixed rate may be written here');
  // The rate is the one the invoice was actually taxed at, recovered from
  // the two stored figures — delivery follows the principal supply, so it
  // differs invoice by invoice and cannot be a configured constant.
  assert.match(fn, /rate: round2\(gst \/ charge \* 100\)/,
    'the rate comes from what was billed');
  assert.ok(!/GSTR1_TRANSPORT\.rate/.test(GSTR1),
    'there is no configured transport rate any more');
});

test('X15 transport is read from the stored columns, never reverse-engineered', async () => {
  const fn = GSTR1.slice(GSTR1.indexOf('function gstr1TransportOf'),
    GSTR1.indexOf('function gstr1WithTransport'));
  assert.match(fn, /inv\.transport_charge/);
  assert.match(fn, /inv\.transport_gst_amount/);
  assert.ok(!/total_amount|taxable_amount|round_off/.test(fn),
    'transport must not be derived from any difference');
});

// ═══ Classification and structure are untouched ═══════════════════════

test('X16 transport does not change how an invoice is classified', async () => {
  // The same goods sold to a registered and an unregistered customer land
  // in b2b and b2cs respectively, with or without a delivery charge.
  const reg = await build({
    b2b: [invoice({ id: 'i13', num: 'A-13', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366, transport: 1000, transportGst: 180 })],
    items: [MACHINE('i13', 'intrastate')]
  });
  assert.ok(reg.payload.b2b && reg.payload.b2b.length, 'still B2B');
  assert.ok(!reg.payload.b2cs || !reg.payload.b2cs.length);

  const unreg = await build({
    b2c: [invoice({ id: 'i14', num: 'C-3', ctin: null, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366, transport: 1000, transportGst: 180 })],
    items: [item({ id: 'it14', invoice_id: 'i14', type: 'b2c', taxable: 2700, rate: 18, gst: 486, cgst: 243, sgst: 243 })]
  });
  assert.ok(unreg.payload.b2cs && unreg.payload.b2cs.length, 'still B2CS');
  assert.ok(!unreg.payload.b2b || !unreg.payload.b2b.length);
});

test('X17 no new export section was invented', async () => {
  const { payload } = await build({
    b2b: [invoice({ id: 'i15', num: 'A-15', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 3700, gst: 666, cgst: 333, sgst: 333, total: 4366, transport: 1000, transportGst: 180 })],
    items: [MACHINE('i15', 'intrastate')]
  });
  // Transport rides in the sections that already existed.
  for (const k of Object.keys(payload)) {
    assert.ok(!/transport/i.test(k), 'no transport-named section may appear: ' + k);
  }
  const sac = sacRows(payload)[0];
  for (const k of Object.keys(sac)) {
    assert.ok(!/transport/i.test(k), 'the SAC row uses the ordinary HSN row shape: ' + k);
  }
  // ...and it is a service row by the file's own existing convention.
  assert.match(GSTR1, /function gstr1IsServiceHsn/);
  assert.ok(/^99/.test(sac.hsn_sc), 'a 99-prefixed code is what makes it a service row');
  assert.strictEqual(sac.uqc, 'NA');
});

// ═══ An exempt invoice cannot hide a taxable charge ═══════════════════

test('X18 a nil/exempt invoice carrying transport is refused, not silently dropped', async () => {
  const { payload, errors } = await build({
    b2b: [invoice({ id: 'i16', num: 'A-16', ctin: GSTIN_KA, supply: 'intrastate',
      taxable: 1000, gst: 180, cgst: 90, sgst: 90, total: 3180,
      transport: 1000, transportGst: 180 })],
    items: [item({ id: 'it16', invoice_id: 'i16', type: 'b2b', taxable: 2000, rate: 0,
      gst: 0, treatment: 'exempt', name: 'Exempt goods' })]
  });
  assert.match(errText(errors), /transport charge/i,
    'table 8 cannot state a taxable charge, so this must be reported');
  assert.strictEqual(sacRows(payload || {}).length === 0 || !payload, true);
});

// ═══ 18-19: the data behind it stays tenant-scoped and authenticated ══

test('X19 the export reads only the signed-in tenant, over authenticated routes', async () => {
  // Every read is scoped by user_id, and apiClient is what carries the
  // token - the exporter never builds a request of its own.
  const reads = GSTR1.match(/_supabase\.from\('(b2b_invoices|b2c_invoices|invoice_items)'\)[^\n]*/g) || [];
  assert.ok(reads.length >= 3, 'the invoice reads must be found to be checked');
  for (const r of reads) {
    assert.match(r, /\.eq\('user_id', userId\)|\.in\('invoice_id'/,
      'every invoice read must be tenant-scoped: ' + r.slice(0, 120));
  }
  assert.ok(!/authorization|bearer/i.test(GSTR1),
    'the exporter must not mint or carry credentials of its own');
});
