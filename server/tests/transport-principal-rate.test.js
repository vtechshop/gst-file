// The rate a delivery charge is taxed at.
//
// Transport is not taxed at a rate of its own. Billed alongside goods it is
// part of the value of that supply and follows what is being delivered: 5%
// goods carry 5% delivery, 12% goods carry 12%, 18% goods carry 18%. The
// earlier build hard-coded 18% for every invoice, which over-charged every
// 5% and 12% sale.
//
// The one case this app cannot answer is a MIXED-rate invoice. Which supply
// is "principal" is a fact about the goods — not something any rate can be
// read off — and nothing in this schema records it. products.supply_bundle
// and products.principal_gst_rate describe a bundle INSIDE one product and
// are Product Master validation only (utils.js:840); no invoice, rollup or
// export reads them. So a mixed-rate invoice with a delivery charge is
// REFUSED at all three layers rather than stored at a guessed rate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const GSTR1 = rd('client', 'js', 'gst', 'gstr1-export.js');
const ROUTE = rd('server', 'src', 'routes', 'invoices.js');

const { principalGstRate, transportGstAmount, validateTransportCharge } =
  require('../src/utils/validation');

const noop = () => {};
const mkEl = (value) => ({
  value: value === undefined ? '' : value,
  textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop
});

function load({ supply = 'intrastate' } = {}) {
  const store = new Map();
  for (const id of ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
    'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsAmountWords',
    'itemsTransportCharge', 'itemsTransportGst', 'itemsTransportRate',
    'itemsTransportNote', 'itemsTransportNoteRow', 'itemsTableBody']) store.set(id, mkEl());
  store.set('invSupply', mkEl(supply));

  const el = mkEl();
  const sb = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      documentElement: el, body: el, head: el,
      getElementById: (id) => store.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl()
    },
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    _supabase: { from: () => ({}) }, readMaybeOne: async () => null, readAll: async () => [[]]
  };
  sb.__toasts = [];
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(ITEMS, sb, { filename: 'invoice-items.js' });
  // The exporter too, so the SAC row it builds can be read back here from
  // the same figures the rollup above produced.
  vm.runInContext(rd('client', 'js', 'api', 'apiClient.js'), sb, { filename: 'apiClient.js' });
  vm.runInContext(GSTR1, sb, { filename: 'gstr1-export.js' });
  vm.runInContext("showToast = function (m, k) { __toasts.push({ m: m, k: k }); }; itemsFormPrefix = 'invoice';", sb);
  sb.__el = (id) => store.get(id);
  sb.__setTransport = (v) => { store.get('itemsTransportCharge').value = v; };
  sb.__setItems = (rows) => vm.runInContext('currentItems = ' + JSON.stringify(rows) + ';', sb);
  return sb;
}

// One product line at a given rate, with the tax already split the way the
// grid would have split it.
function line(taxable, rate, supply, o = {}) {
  const gst = Math.round(taxable * rate) / 100;
  const inter = supply === 'interstate';
  return {
    rowId: 'r' + (o.n || 1), product_id: 'p' + (o.n || 1),
    product_name: o.name || 'Machine', hsn_code: o.hsn || '84388090', unit: 'PCS',
    quantity: 1, rate: taxable, discount_percentage: 0, gst_percentage: rate,
    gst_treatment: o.treatment || 'taxable', cess_rate: 0, cess_amount: 0,
    taxable_value: taxable, gst_amount: gst,
    igst: inter ? gst : 0, cgst: inter ? 0 : gst / 2, sgst: inter ? 0 : gst / 2,
    total_amount: taxable + gst, locked: false
  };
}

function rollup(rows, transport, supply = 'intrastate') {
  const sb = load({ supply });
  sb.__setItems(rows);
  if (transport !== undefined) sb.__setTransport(transport);
  return { sb, out: sb.computeInvoiceRollups() };
}

// ═══ 3-5: the three mandatory single-rate flows ═══════════════════════

test('P1 MANDATORY 18% - delivery follows an 18% machine', () => {
  const { sb, out } = rollup([line(2700, 18, 'intrastate')], '1000');
  assert.strictEqual(out.transport_charge, 1000);
  assert.strictEqual(out.transport_gst_amount, 180);
  assert.strictEqual(out.taxable_amount, 3700);
  assert.strictEqual(out.gst_amount, 666);
  assert.strictEqual(out.cgst, 333);
  assert.strictEqual(out.sgst, 333);
  assert.strictEqual(out.total_amount, 4366);
  assert.strictEqual(sb.__el('itemsTransportRate').textContent, '18%');
});

test('P2 MANDATORY 12% - delivery follows a 12% machine, NOT 18%', () => {
  const { sb, out } = rollup([line(2700, 12, 'intrastate')], '1000');
  assert.strictEqual(out.transport_gst_amount, 120, '12% of 1000, not 180');
  assert.strictEqual(out.taxable_amount, 3700);
  assert.strictEqual(out.gst_amount, 444, 'product 324 + transport 120');
  assert.strictEqual(out.total_amount, 4144);
  assert.strictEqual(sb.__el('itemsTransportRate').textContent, '12%');
});

test('P3 MANDATORY 5% - delivery follows a 5% machine, NOT 18%', () => {
  const { sb, out } = rollup([line(2700, 5, 'intrastate')], '1000');
  assert.strictEqual(out.transport_gst_amount, 50, '5% of 1000, not 180');
  assert.strictEqual(out.taxable_amount, 3700);
  assert.strictEqual(out.gst_amount, 185, 'product 135 + transport 50');
  assert.strictEqual(out.total_amount, 3885);
  assert.strictEqual(sb.__el('itemsTransportRate').textContent, '5%');
});

test('P4 a 0% taxable supply carries 0% delivery', () => {
  const { out } = rollup([line(2700, 0, 'intrastate')], '1000');
  assert.strictEqual(out.transport_gst_amount, 0);
  assert.strictEqual(out.taxable_amount, 3700);
  assert.strictEqual(out.total_amount, 3700);
});

// ═══ 6-7: the split is the existing one ═══════════════════════════════

test('P5 intra-state splits the delivery tax in half, at whatever the rate is', () => {
  for (const [rate, gst] of [[18, 180], [12, 120], [5, 50]]) {
    const { out } = rollup([line(2700, rate, 'intrastate')], '1000');
    const productGst = Math.round(2700 * rate) / 100;
    assert.strictEqual(out.cgst - productGst / 2, gst / 2, `${rate}%: CGST carries half the delivery tax`);
    assert.strictEqual(out.sgst - productGst / 2, gst / 2, `${rate}%: SGST carries half`);
    assert.strictEqual(out.igst, 0);
  }
});

test('P6 inter-state puts the whole delivery tax in IGST, at whatever the rate is', () => {
  for (const [rate, gst] of [[18, 180], [12, 120], [5, 50]]) {
    const { out } = rollup([line(2700, rate, 'interstate')], '1000', 'interstate');
    const productGst = Math.round(2700 * rate) / 100;
    assert.strictEqual(out.igst - productGst, gst, `${rate}%: IGST carries the whole delivery tax`);
    assert.strictEqual(out.cgst, 0);
    assert.strictEqual(out.sgst, 0);
  }
});

// ═══ 1-2: optional, and zero ══════════════════════════════════════════

test('P7 blank transport leaves a 12% invoice exactly as it was', () => {
  const plain = rollup([line(2700, 12, 'intrastate')], '').out;
  assert.strictEqual(plain.transport_charge, null);
  assert.strictEqual(plain.transport_gst_amount, null);
  assert.strictEqual(plain.taxable_amount, 2700);
  assert.strictEqual(plain.gst_amount, 324);
  assert.strictEqual(plain.total_amount, 3024);
});

test('P8 zero transport is stored, taxes nothing, and needs no principal rate', () => {
  const { out } = rollup([line(2700, 5, 'intrastate')], '0');
  assert.strictEqual(out.transport_charge, 0);
  assert.strictEqual(out.transport_gst_amount, 0);
  assert.strictEqual(out.total_amount, 2835, 'unchanged from the no-transport total');
  // ...and even with NO principal rate at all, a zero charge is fine.
  assert.strictEqual(transportGstAmount(0, null), 0);
});

// ═══ 16: the mixed-rate case — refused, never guessed ═════════════════

test('P9 MANDATORY MIXED-RATE - a 5% + 18% invoice refuses to tax delivery', () => {
  const rows = [line(3000, 5, 'intrastate', { n: 1, hsn: '85044090', name: 'Cable' }),
                line(1700, 18, 'intrastate', { n: 2 })];
  const { sb, out } = rollup(rows, '1000');

  // No rate could be determined, so nothing was taxed...
  assert.strictEqual(sb.invoicePrincipalGstRate(), null);
  assert.strictEqual(out.transport_gst_amount, 0);
  assert.strictEqual(sb.__el('itemsTransportRate').textContent, '–');
  // ...the person is told why...
  assert.match(sb.__el('itemsTransportNote').textContent, /more than one GST rate/i);
  // ...and Save refuses it rather than storing a guess.
  assert.strictEqual(sb.validateInvoiceItems(), false);
  assert.match(sb.__toasts.at(-1).m, /more than one GST rate/i);

  // The products themselves are untouched by any of this.
  assert.strictEqual(out.taxable_amount - 1000, 4700);
  assert.strictEqual(out.gst_amount, 456, 'product tax only: 150 + 306');
});

test('P10 the same mixed invoice saves perfectly well with NO transport', () => {
  const rows = [line(3000, 5, 'intrastate', { n: 1, hsn: '85044090', name: 'Cable' }),
                line(1700, 18, 'intrastate', { n: 2 })];
  const { sb, out } = rollup(rows, '');
  assert.strictEqual(sb.validateInvoiceItems(), true, 'mixed rates are only a problem for delivery');
  assert.strictEqual(out.taxable_amount, 4700);
  assert.strictEqual(out.gst_amount, 456);
  assert.strictEqual(out.total_amount, 5156);
  assert.strictEqual(out.transport_charge, null);
});

test('P11 a charge with no taxable product at all is refused too', () => {
  const { sb } = rollup([], '1000');
  assert.strictEqual(sb.invoicePrincipalGstRate(), null);
  assert.strictEqual(sb.validateInvoiceItems(), false);
});

test('P12 an exempt line does not make a single-rate invoice look mixed', () => {
  // Exempt is not a taxable supply, so its 0% is not a second rate.
  const rows = [line(2700, 18, 'intrastate', { n: 1 }),
                line(500, 0, 'intrastate', { n: 2, treatment: 'exempt', name: 'Exempt goods' })];
  const { sb, out } = rollup(rows, '1000');
  assert.strictEqual(sb.invoicePrincipalGstRate(), 18);
  assert.strictEqual(out.transport_gst_amount, 180);
  assert.strictEqual(sb.validateInvoiceItems(), true);
});

// ═══ The server decides the rate, not the browser ═════════════════════

test('P13 principalGstRate reads the line items, server-side', () => {
  const it = (taxable, rate, treatment) => ({ taxable_value: taxable, gst_percentage: rate, gst_treatment: treatment || 'taxable' });
  assert.strictEqual(principalGstRate([it(2700, 18)]), 18);
  assert.strictEqual(principalGstRate([it(2700, 12)]), 12);
  assert.strictEqual(principalGstRate([it(2700, 5)]), 5);
  assert.strictEqual(principalGstRate([it(2700, 0)]), 0);
  assert.strictEqual(principalGstRate([it(2700, 18), it(1000, 18)]), 18, 'two lines, one rate');
  assert.strictEqual(principalGstRate([it(3000, 5), it(1700, 18)]), null, 'mixed is refused');
  assert.strictEqual(principalGstRate([]), null);
  assert.strictEqual(principalGstRate(null), null);
  // Non-taxable lines are skipped, not counted as a rate.
  assert.strictEqual(principalGstRate([it(2700, 18), it(500, 0, 'exempt')]), 18);
  assert.strictEqual(principalGstRate([it(500, 0, 'nil_rated'), it(2700, 12)]), 12);
  assert.strictEqual(principalGstRate([it(500, 0, 'non_gst')]), null, 'no taxable supply at all');
  // A zero-value line has nothing to be principal about.
  assert.strictEqual(principalGstRate([it(0, 5), it(2700, 18)]), 18);
});

test('P14 the route derives the rate from the items and refuses when it cannot', () => {
  assert.match(ROUTE, /const rate = principalGstRate\(items\);/);
  assert.match(ROUTE, /const gst = transportGstAmount\(check\.value, rate\);/);
  assert.match(ROUTE, /transport_rate_indeterminate/);
  assert.match(ROUTE, /header\.transport_gst_amount = gst;/);
  // The browser's own figure is never what gets stored.
  assert.ok(!/transport_gst_amount = header\.transport_gst_amount/.test(ROUTE));
});

test('P15 no fixed transport rate survives anywhere', () => {
  for (const [name, src] of [['invoice-items.js', ITEMS], ['gstr1-export.js', GSTR1],
    ['validation.js', rd('server', 'src', 'utils', 'validation.js')]]) {
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/TRANSPORT_GST_RATE/.test(code), name + ' must not carry a fixed transport rate');
  }
  assert.match(ITEMS, /function invoicePrincipalGstRate\(\)/);
  // The SAC is still configured in exactly one place, and the rate is not.
  assert.strictEqual((GSTR1.match(/996511/g) || []).length, 1);
  assert.match(GSTR1, /rate: round2\(gst \/ charge \* 100\)/);
});

// ═══ 13-14: what the return declares ══════════════════════════════════

test('P16 the SAC row reports the rate the invoice was actually taxed at', () => {
  const sb = load();
  for (const [charge, gst, rate] of [[1000, 180, 18], [1000, 120, 12], [1000, 50, 5], [2000, 100, 5]]) {
    const t = sb.gstr1TransportOf({ supply_type: 'intrastate',
      transport_charge: charge, transport_gst_amount: gst });
    assert.strictEqual(t.rate, rate, `${charge}/${gst} must report ${rate}%`);
    assert.strictEqual(t.taxable, charge);
    assert.strictEqual(t.cgst, gst / 2);
    assert.strictEqual(t.sgst, gst / 2);
  }
  // Nothing charged, nothing to declare.
  assert.strictEqual(sb.gstr1TransportOf({ transport_charge: null }), null);
  assert.strictEqual(sb.gstr1TransportOf({ transport_charge: 0, transport_gst_amount: 0 }), null);
});

// ═══ The e-way toggle is a separate concept ═══════════════════════════

test('P17 the charge is independent of the e-way Transport Required toggle', () => {
  // Nothing in the charge's path reads transport_required, and nothing in
  // the e-way path reads the charge.
  const fn = ITEMS.slice(ITEMS.indexOf('function invoiceTransportCharge'),
    ITEMS.indexOf('function onTransportChargeInput'));
  assert.ok(!/transport_required|transportToggle/.test(fn),
    'the money charge must not be gated by the e-way toggle');
  const entry = rd('client', 'js', 'pages', 'invoice-entry.js');
  const eway = entry.slice(entry.indexOf('const transportRequired ='),
    entry.indexOf('headerBase.gst_number'));
  assert.ok(!/transport_charge/.test(eway),
    'the e-way block must not read the money charge');
});
