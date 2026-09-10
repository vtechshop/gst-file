// Optional transport charge on a tax invoice, taxed at a fixed 18%.
//
// Three things have to hold at once and each is easy to break alone:
//
//   1. An invoice with NO transport charge must be bit-for-bit the invoice
//      it was before this feature existed - same taxable, same tax, same
//      total, same printed document. Every "blank" case below exists for
//      that, because a regression there would silently restate invoices
//      that are already filed.
//   2. Transport must be taxed exactly ONCE. The charge joins the taxable
//      base once and its 18% joins the tax once; nothing adds it again.
//   3. The two derived figures elsewhere in the app must not mistake it for
//      something else - the PDF's Round Off (which is total minus taxable
//      minus tax) must not print the transport as a rounding adjustment,
//      and the GSTR-1 reconciliation (which rebuilds the total from line
//      items) must not reject the invoice for a difference it can now
//      account for.
//
// The DB-backed half is skipped unless STOCK_TEST_DATABASE_URL names a
// DISPOSABLE database; the calculation half always runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ITEMS = rd('client', 'js', 'pages', 'invoice-items.js');
const PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');
const GSTR1 = rd('client', 'js', 'gst', 'gstr1-export.js');

// ── A browser-shaped sandbox with a real element store ────────────────
// getElementById has to return something with a settable .value, because
// the transport charge is read from the box the person typed in and the
// rollup writes the results back into the totals panel.
const noop = () => {};
function mkEl(value) {
  return {
    value: value === undefined ? '' : value,
    textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop
  };
}

function load({ supply = 'intrastate', formPrefix = 'invoice' } = {}) {
  const store = new Map();
  for (const id of ['itemsSubtotal', 'itemsGstAmt', 'itemsRoundOff', 'itemsGrandTotal',
    'itemsIGST', 'itemsCGST', 'itemsSGST', 'itemsCess', 'itemsCessRow', 'itemsAmountWords',
    'itemsTransportCharge', 'itemsTransportGst']) store.set(id, mkEl());
  store.set('invSupply', mkEl(supply));

  const el = mkEl();
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
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
    showToast: (m, k) => { sb.__toasts.push({ m, k }); },
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    _supabase: { from: () => ({}) }, readMaybeOne: async () => null, readAll: async () => [[]]
  };
  sb.__toasts = [];
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  vm.runInContext(ITEMS, sb, { filename: 'invoice-items.js' });
  vm.runInContext(PDF, sb, { filename: 'invoice-pdf.js' });
  vm.runInContext(GSTR1, sb, { filename: 'gstr1-export.js' });
  // utils.js declares its own showToast, which replaces the stub above and
  // then needs a real document to append to. Put the capture back AFTER the
  // scripts have loaded, so the messages Save produces can be read here.
  vm.runInContext('showToast = function (m, k) { __toasts.push({ m: m, k: k }); };', sb);
  vm.runInContext(`itemsFormPrefix = ${JSON.stringify(formPrefix)};`, sb);
  sb.__el = (id) => store.get(id);
  sb.__get = (expr) => vm.runInContext(expr, sb);
  sb.__setItems = (rows) => vm.runInContext('currentItems = ' + JSON.stringify(rows) + ';', sb);
  sb.__setTransport = (v) => { store.get('itemsTransportCharge').value = v; };
  return sb;
}

// One product line: 2700 taxable at 18%, the mandatory scenario's machine.
function machineLine(supply) {
  const inter = supply === 'interstate';
  return {
    rowId: 'r1', product_id: 'p1', product_name: 'Machine', hsn_code: '84388090', unit: 'PCS',
    quantity: 1, rate: 2700, discount_percentage: 0, gst_percentage: 18,
    gst_treatment: 'taxable', cess_rate: 0, cess_amount: 0,
    taxable_value: 2700, gst_amount: 486,
    igst: inter ? 486 : 0, cgst: inter ? 0 : 243, sgst: inter ? 0 : 243,
    total_amount: 3186, locked: false
  };
}

function rollup(transport, { supply = 'intrastate', formPrefix = 'invoice' } = {}) {
  const sb = load({ supply, formPrefix });
  sb.__setItems([machineLine(supply)]);
  if (transport !== undefined) sb.__setTransport(transport);
  return { sb, out: sb.computeInvoiceRollups() };
}

// ═══ 1-4, 17-18: the charge itself ════════════════════════════════════

test('T1 blank transport leaves every figure exactly as it was', () => {
  // The baseline is the same rollup with the transport field absent from
  // the DOM entirely - i.e. the function as it behaved before the feature.
  const withField = rollup('').out;
  const noField = (() => {
    const sb = load({ formPrefix: 'proforma' });   // proforma renders no transport row
    sb.__setItems([machineLine('intrastate')]);
    return sb.computeInvoiceRollups();
  })();

  assert.strictEqual(withField.taxable_amount, 2700);
  assert.strictEqual(withField.gst_amount, 486);
  assert.strictEqual(withField.cgst, 243);
  assert.strictEqual(withField.sgst, 243);
  assert.strictEqual(withField.igst, 0);
  assert.strictEqual(withField.total_amount, 3186);
  assert.strictEqual(withField.round_off, 0);
  assert.strictEqual(withField.transport_charge, null, 'blank is NULL, never 0');
  assert.strictEqual(withField.transport_gst_amount, null);

  for (const k of ['taxable_amount', 'gst_amount', 'igst', 'cgst', 'sgst', 'cess_amount', 'total_amount', 'round_off']) {
    assert.strictEqual(withField[k], noField[k], `${k} must be untouched when nothing is charged`);
  }
});

test('T2 zero transport is a real, stored decision - not the same as blank', () => {
  const out = rollup('0').out;
  assert.strictEqual(out.transport_charge, 0, '0 means charged at nothing, and is stored');
  assert.strictEqual(out.transport_gst_amount, 0);
  // ...and it changes no total, which is the whole point of allowing it.
  assert.strictEqual(out.taxable_amount, 2700);
  assert.strictEqual(out.total_amount, 3186);
});

test('T3 a positive integer charge', () => {
  const out = rollup('1000').out;
  assert.strictEqual(out.transport_charge, 1000);
  assert.strictEqual(out.transport_gst_amount, 180);
});

test('T4 a decimal charge rounds by the app rounding, not a new rule', () => {
  const out = rollup('1000.55').out;
  assert.strictEqual(out.transport_charge, 1000.55);
  // 1000.55 * 18% = 180.099 -> 180.10
  assert.strictEqual(out.transport_gst_amount, 180.1);
  assert.strictEqual(out.taxable_amount, 3700.55);
});

test('T17 the product line is untouched by any transport charge', () => {
  const { sb } = rollup('1000');
  const row = sb.__get('currentItems')[0];
  assert.strictEqual(row.quantity, 1);
  assert.strictEqual(row.rate, 2700);
  assert.strictEqual(row.discount_percentage, 0);
  assert.strictEqual(row.gst_percentage, 18);
  assert.strictEqual(row.cess_amount, 0);
  assert.strictEqual(row.taxable_value, 2700, 'the line taxable value must not absorb transport');
  assert.strictEqual(row.gst_amount, 486, 'the line GST must not be recalculated');
  assert.strictEqual(row.total_amount, 3186, 'the line total must not move');
});

test('T18 MANDATORY FLOW 1 - intra state: 2700 + 1000 gives 4366', () => {
  const out = rollup('1000', { supply: 'intrastate' }).out;
  assert.strictEqual(out.taxable_amount, 3700, 'taxable base includes the transport charge');
  assert.strictEqual(out.cgst, 333, 'product 243 + transport 90');
  assert.strictEqual(out.sgst, 333, 'product 243 + transport 90');
  assert.strictEqual(out.igst, 0);
  assert.strictEqual(out.gst_amount, 666);
  assert.strictEqual(out.transport_charge, 1000);
  assert.strictEqual(out.transport_gst_amount, 180);
  assert.strictEqual(out.total_amount, 4366);
});

// ═══ 9-10: the split follows the invoice, not a second engine ═════════

test('T9 intra state splits the transport tax 9% + 9%', () => {
  const out = rollup('1000', { supply: 'intrastate' }).out;
  // The transport half of each: 333 - 243.
  assert.strictEqual(out.cgst - 243, 90);
  assert.strictEqual(out.sgst - 243, 90);
  assert.strictEqual(out.igst, 0, 'an intra-state invoice never carries IGST');
});

test('T10 MANDATORY FLOW 2 - inter state puts the whole 18% in IGST', () => {
  const out = rollup('1000', { supply: 'interstate' }).out;
  assert.strictEqual(out.taxable_amount, 3700);
  assert.strictEqual(out.igst, 666, 'product 486 + transport 180');
  assert.strictEqual(out.cgst, 0);
  assert.strictEqual(out.sgst, 0);
  assert.strictEqual(out.total_amount, 4366);
});

test('T10b the split is calcGST, not a second copy of the rule', () => {
  // The rate is stated once and the split is delegated - so the file must
  // not contain its own /2 for transport, or its own 'interstate' branch.
  assert.match(ITEMS, /function invoicePrincipalGstRate\(\)/);
  assert.match(ITEMS, /return \{ \.\.\.calcGST\(charge, rate, getInvoiceSupplyType\(\)\), rate \};/);
  const fn = ITEMS.slice(ITEMS.indexOf('function invoiceTransportTax'),
    ITEMS.indexOf('function onTransportChargeInput'));
  assert.ok(!/interstate/.test(fn), 'transport must not classify supply type itself');
  assert.ok(!/\/\s*2/.test(fn), 'transport must not split the tax itself');
});

// ═══ 16: taxed exactly once ═══════════════════════════════════════════

test('T16 transport is taxed exactly once', () => {
  const out = rollup('1000').out;
  // Every way of arriving at the total agrees, which it cannot do if the
  // charge or its tax were counted twice anywhere.
  assert.strictEqual(out.taxable_amount - 2700, 1000, 'the charge lands in the base exactly once');
  assert.strictEqual(out.gst_amount - 486, 180, 'its tax lands in the tax exactly once');
  assert.strictEqual(out.total_amount, out.taxable_amount + out.gst_amount + out.cess_amount + out.round_off);
  assert.strictEqual(out.total_amount, 3186 + 1000 + 180);
  // A double count would show as 5546 (charge twice) or 4546 (tax twice).
  assert.notStrictEqual(out.total_amount, 5546);
  assert.notStrictEqual(out.total_amount, 4546);
});

test('T16b the rollup reads the charge once and adds it in one place', () => {
  const fn = ITEMS.slice(ITEMS.indexOf('function computeInvoiceRollups'),
    ITEMS.indexOf('function validateInvoiceItems'));
  assert.strictEqual((fn.match(/invoiceTransportCharge\(\)/g) || []).length, 1,
    'the charge is read exactly once per rollup');
  assert.strictEqual((fn.match(/invoiceTransportTax\(/g) || []).length, 1,
    'its tax is computed exactly once per rollup');
  assert.strictEqual((fn.match(/transportCharge \|\| 0/g) || []).length, 1,
    'the charge is added to the base exactly once');
});

// ═══ 13-15: edit and clear ════════════════════════════════════════════

test('T13/T14 MANDATORY FLOW 4 - editing the charge up then down', () => {
  const { sb } = rollup('1000');
  assert.strictEqual(sb.computeInvoiceRollups().total_amount, 4366);

  sb.__setTransport('1500');
  const up = sb.computeInvoiceRollups();
  assert.strictEqual(up.transport_charge, 1500);
  assert.strictEqual(up.transport_gst_amount, 270);
  assert.strictEqual(up.taxable_amount, 4200, 'the OLD charge must not survive alongside the new one');
  assert.strictEqual(up.gst_amount, 756);
  // 3186 machine + 1500 charge + 270 tax. The old 1000/180 is gone, not
  // added to; a duplicated charge would read 5366 or 5546.
  assert.strictEqual(up.total_amount, 4956);

  sb.__setTransport('800');
  const down = sb.computeInvoiceRollups();
  assert.strictEqual(down.transport_charge, 800);
  assert.strictEqual(down.transport_gst_amount, 144);
  assert.strictEqual(down.total_amount, 3186 + 800 + 144);
});

test('T15 clearing the charge returns the invoice exactly to its no-transport total', () => {
  const { sb } = rollup('1500');
  assert.strictEqual(sb.computeInvoiceRollups().total_amount, 4956);

  sb.__setTransport('');
  const cleared = sb.computeInvoiceRollups();
  assert.strictEqual(cleared.transport_charge, null, 'cleared is NULL, not 0');
  assert.strictEqual(cleared.transport_gst_amount, null);
  assert.strictEqual(cleared.taxable_amount, 2700);
  assert.strictEqual(cleared.gst_amount, 486);
  assert.strictEqual(cleared.cgst, 243);
  assert.strictEqual(cleared.sgst, 243);
  assert.strictEqual(cleared.total_amount, 3186);
  assert.strictEqual(cleared.round_off, 0);
});

test('T12b reopening a saved invoice puts the charge back in a form the box accepts', () => {
  // The regression this guards: formatNum(1000) is "1,000.00" under en-IN
  // grouping, and an <input type="number"> refuses that - the box would
  // come back EMPTY on every charge of a thousand or more, and re-saving
  // would then clear a charge the customer was invoiced for.
  for (const [stored, wantValue, wantTotal] of [
    [1000, '1000', 4366], ['1000.00', '1000', 4366],
    [1500, '1500', 4956], [1000.55, '1000.55', 4367],
    [0, '0', 3186], [null, '', 3186], [undefined, '', 3186]
  ]) {
    const sb = load();
    sb.__setItems([machineLine('intrastate')]);
    sb.restoreInvoiceTransport(stored === undefined ? {} : { transport_charge: stored });
    const box = sb.__el('itemsTransportCharge').value;
    assert.strictEqual(box, wantValue, `stored ${JSON.stringify(stored)} must restore as "${wantValue}"`);
    assert.ok(box === '' || Number.isFinite(Number(box)),
      `"${box}" must parse as a number - an <input type="number"> takes nothing else`);
    assert.strictEqual(sb.computeInvoiceRollups().total_amount, wantTotal);
  }
  // Restoring must not go through the display formatter at all. Bounded to
  // the function's own body - a slice running on to the next section would
  // catch formatNum() calls that legitimately belong to other code.
  const from = ITEMS.indexOf('function restoreInvoiceTransport');
  // Comments stripped first: the code carries a note explaining why
  // formatNum is NOT used here, and the guard must read the code, not the
  // explanation of it.
  const fn = ITEMS.slice(from, from + ITEMS.slice(from).search(/\r?\n\}/))
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(fn.includes('restoreInvoiceTransport'), 'the function must exist to be checked');
  assert.ok(/String\(Number\(stored\)\)/.test(fn), 'the raw number is what goes in the box');
  assert.ok(!/formatNum/.test(fn), 'the restore must not format the value it puts in the box');
});

test('T12c a restored charge survives a round trip through the box', () => {
  // Save -> reopen -> save again must not drift the figure.
  const sb = load();
  sb.__setItems([machineLine('intrastate')]);
  sb.__setTransport('1250.75');
  const saved = sb.computeInvoiceRollups();

  const reopened = load();
  reopened.__setItems([machineLine('intrastate')]);
  reopened.restoreInvoiceTransport({ transport_charge: saved.transport_charge });
  const after = reopened.computeInvoiceRollups();

  assert.strictEqual(after.transport_charge, saved.transport_charge);
  assert.strictEqual(after.transport_gst_amount, saved.transport_gst_amount);
  assert.strictEqual(after.total_amount, saved.total_amount);
});

// ═══ 5-8: what the browser refuses to bill ════════════════════════════

test('T5-T8 a bad entry never becomes a silent charge on screen', () => {
  for (const bad of ['-1', '-0.01', 'abc', '12abc', 'Infinity', '-Infinity', 'NaN', ' ']) {
    const out = rollup(bad).out;
    assert.strictEqual(out.transport_charge, null, `"${bad}" must not bill anything`);
    assert.strictEqual(out.total_amount, 3186, `"${bad}" must leave the total alone`);
  }
});

test('T5-T8b Save refuses a negative or unparseable charge, and says why', () => {
  for (const [bad, wanted] of [['-1', /negative/i], ['abc', /number/i], ['Infinity', /number/i], ['NaN', /number/i]]) {
    const sb = load();
    sb.__setItems([machineLine('intrastate')]);
    sb.__setTransport(bad);
    assert.strictEqual(sb.validateInvoiceItems(), false, `"${bad}" must block Save`);
    assert.match(sb.__toasts.at(-1).m, wanted);
  }
  // ...and a good one, or none at all, does not.
  for (const ok of ['', '0', '1000', '1000.55']) {
    const sb = load();
    sb.__setItems([machineLine('intrastate')]);
    sb.__setTransport(ok);
    assert.strictEqual(sb.validateInvoiceItems(), true, `"${ok}" must be allowed`);
  }
});

// ═══ Server-side validation - the boundary that actually counts ═══════

const { validateTransportCharge, transportGstAmount, principalGstRate } =
  require('../src/utils/validation');

test('T5-T8c the server refuses every malformed charge', () => {
  const refused = [
    ['negative', -1], ['negative decimal', -0.01],
    ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['NaN string', 'NaN'], ['Infinity string', 'Infinity'],
    ['malformed string', 'abc'], ['half-numeric string', '12abc'],
    ['empty array', []], ['array', [1000]], ['object', { amount: 1000 }],
    ['boolean true', true], ['boolean false', false]
  ];
  for (const [name, value] of refused) {
    const r = validateTransportCharge(value);
    assert.strictEqual(r.valid, false, `${name} must be refused`);
    assert.match(r.error, /transport charge/i);
  }
});

test('T5-T8d the server accepts blank, zero and positive', () => {
  for (const blank of [null, undefined, '']) {
    const r = validateTransportCharge(blank);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.value, null, 'blank stores as NULL, never 0');
  }
  for (const [raw, want] of [[0, 0], ['0', 0], [1000, 1000], ['1000', 1000],
    [1000.55, 1000.55], ['1000.55', 1000.55], [0.01, 0.01]]) {
    const r = validateTransportCharge(raw);
    assert.strictEqual(r.valid, true, `${raw} must be accepted`);
    assert.strictEqual(r.value, want);
  }
});

test('T5-T8e the server derives the tax and never takes it from the caller', () => {
  // The rate is the principal supply's, so it is an argument now.
  assert.strictEqual(transportGstAmount(1000, 18), 180);
  assert.strictEqual(transportGstAmount(1500, 18), 270);
  assert.strictEqual(transportGstAmount(1000, 12), 120);
  assert.strictEqual(transportGstAmount(1000, 5), 50);
  assert.strictEqual(transportGstAmount(0, 18), 0);
  assert.strictEqual(transportGstAmount(0, null), 0, 'a free delivery needs no rate');
  assert.strictEqual(transportGstAmount(1000.55, 18), 180.1);
  assert.strictEqual(transportGstAmount(null, 18), null);
  assert.strictEqual(transportGstAmount(1000, null), null, 'no principal rate, no tax');

  // The route must compute it, not copy it.
  const ROUTE = rd('server', 'src', 'routes', 'invoices.js');
  assert.match(ROUTE, /const rate = principalGstRate\(items\);/);
  assert.match(ROUTE, /header\.transport_gst_amount = gst;/);
  assert.match(ROUTE, /delete header\.transport_gst_amount;/);
});

// ═══ 19-20: the printed document ══════════════════════════════════════

test('T19 the PDF shows the charge and its tax, from the stored fields', () => {
  const sb = load();
  const inv = {
    supply_type: 'intrastate', taxable_amount: 3700, gst_amount: 666,
    cgst: 333, sgst: 333, igst: 0, total_amount: 4366,
    transport_charge: 1000, transport_gst_amount: 180
  };
  const t = sb.invoiceTransportParts(inv);
  assert.strictEqual(t.has, true);
  assert.strictEqual(t.charge, 1000);
  assert.strictEqual(t.gst, 180);
  assert.strictEqual(t.cgst, 90);
  assert.strictEqual(t.sgst, 90);
  assert.strictEqual(t.igst, 0);
  // The goods side, recovered by taking the stored transport back off.
  assert.strictEqual(t.productTaxable, 2700);
  assert.strictEqual(t.productCgst, 243);
  assert.strictEqual(t.productSgst, 243);
  assert.strictEqual(sb.invoiceMachineTotal(inv, t), 3186);
  // Goods + charge + tax is the grand total, so the column adds up.
  assert.strictEqual(sb.invoiceMachineTotal(inv, t) + t.charge + t.gst, 4366);

  // Both renderers carry the three rows.
  for (const label of ['Machine / Product Total', 'Transport Charge', 'Transport GST']) {
    assert.ok(PDF.includes(label), `the PDF must print "${label}"`);
  }
  assert.match(PDF, /transportRowsHtml/);
});

test('T19b an inter-state PDF puts the transport tax in IGST', () => {
  const sb = load();
  const t = sb.invoiceTransportParts({
    supply_type: 'interstate', taxable_amount: 3700, gst_amount: 666,
    cgst: 0, sgst: 0, igst: 666, total_amount: 4366,
    transport_charge: 1000, transport_gst_amount: 180
  });
  assert.strictEqual(t.igst, 180);
  assert.strictEqual(t.cgst, 0);
  assert.strictEqual(t.sgst, 0);
  assert.strictEqual(t.productIgst, 486);
});

test('T20 Round Off is the rounding, never the transport', () => {
  const sb = load();
  // The mandatory case: a 1180 "round off" is exactly the bug this guards.
  const roundOff = sb.round2(4366 - 3700 - 666);
  assert.strictEqual(roundOff, 0);
  assert.notStrictEqual(roundOff, 1180);

  // A genuinely rounded invoice still reports its real adjustment. 2699.60
  // of goods at 18% is 485.93; with 1000 transport the raw total is
  // 4365.53, stored rounded to 4366, so the round off is +0.47.
  const taxable = sb.round2(2699.60 + 1000);
  const gst = sb.round2(485.93 + 180);
  const raw = taxable + gst;
  const stored = Math.round(raw);
  assert.strictEqual(sb.round2(stored - taxable - gst), sb.round2(stored - raw));
  assert.ok(Math.abs(sb.round2(stored - taxable - gst)) < 1,
    'a round off can never exceed half a rupee either way');

  // ...and the derivation itself is unchanged - it works because BOTH
  // sides include transport, not because transport was special-cased.
  assert.match(PDF, /round_off: round2\(\+data\.total_amount - \+data\.taxable_amount - \+data\.gst_amount\)/);
});

test('T19c an invoice with no transport prints exactly what it always did', () => {
  const sb = load();
  const inv = {
    supply_type: 'intrastate', taxable_amount: 2700, gst_amount: 486,
    cgst: 243, sgst: 243, igst: 0, total_amount: 3186,
    transport_charge: null, transport_gst_amount: null
  };
  const t = sb.invoiceTransportParts(inv);
  assert.strictEqual(t.has, false, 'no transport row is added');
  assert.strictEqual(t.productTaxable, 2700);
  assert.strictEqual(t.productCgst, 243);
  assert.strictEqual(t.productSgst, 243);
  assert.strictEqual(t.productIgst, 0);
});

// ═══ 21-22: the filing ════════════════════════════════════════════════

test('T21/T22 MANDATORY GSTR-1 FLOW - a transport invoice reconciles', () => {
  // The end-to-end proof lives in gstr1-transport.test.js, which drives the
  // real exporter. What is pinned HERE is the piece the invoice side owns:
  // the stored columns this invoice writes are the ones the export reads.
  const sb = load();
  const inv = { supply_type: 'intrastate', transport_charge: 1000, transport_gst_amount: 180 };
  const t = sb.gstr1TransportOf(inv);
  assert.ok(t, 'a charged invoice must produce a transport component');
  assert.strictEqual(t.taxable, 1000);
  assert.strictEqual(t.rate, 18);
  assert.strictEqual(t.cgst, 90);
  assert.strictEqual(t.sgst, 90);

  // Folded into the invoice totals once, so val and itms describe the whole
  // invoice: 2700 + 1000 taxable, 486 + 180 tax, 4366 total.
  const goods = { taxable: 2700, igst: 0, cgst: 243, sgst: 243, cess: 0, gstAmount: 486,
    total: 3186, byRate: [{ rate: 18, taxable: 2700, igst: 0, cgst: 243, sgst: 243, cess: 0 }] };
  const whole = sb.gstr1WithTransport(goods, t);
  assert.strictEqual(whole.taxable, 3700);
  assert.strictEqual(whole.gstAmount, 666);
  assert.strictEqual(whole.cgst, 333);
  assert.strictEqual(whole.sgst, 333);
  assert.strictEqual(whole.total, 4366);
  assert.strictEqual(sb.gstr1TotalMatches(4366, whole.total), true,
    'the invoice must NOT be reported as a total mismatch');

  // Both collectors build their totals this way.
  assert.strictEqual((GSTR1.match(/gstr1WithTransport\($/gm) || []).length, 2,
    'B2B and B2C must both fold transport into their totals');
  assert.strictEqual((GSTR1.match(/gstr1AddTransportHsn\(addToHsn, 'b2[bc]', transport, ctx\);/g) || []).length, 2,
    'B2B and B2C must both emit the SAC row');
});

test('T22b the export reads stored fields and invents no rate', () => {
  // Comments stripped: the code explains the 18% rule in prose, and the
  // guard must read the code rather than the explanation of it.
  const fn = GSTR1.slice(GSTR1.indexOf('function gstr1TransportOf'),
    GSTR1.indexOf('function gstr1WithTransport')).replace(/\/\/[^\n]*/g, '');
  assert.match(fn, /inv\.transport_charge/);
  assert.match(fn, /inv\.transport_gst_amount/);
  assert.ok(!/\b18\b/.test(fn), 'the rate comes from the config block, not a literal');
  assert.ok(!/total_amount|round_off/.test(fn),
    'transport must never be reverse-engineered from a difference');
});

test('T26 an invoice with no transport reconciles exactly as before', () => {
  const sb = load();
  const goods = { taxable: 2700, igst: 0, cgst: 243, sgst: 243, cess: 0, gstAmount: 486,
    total: 3186, byRate: [{ rate: 18, taxable: 2700, igst: 0, cgst: 243, sgst: 243, cess: 0 }] };
  for (const inv of [
    { supply_type: 'intrastate', transport_charge: null, transport_gst_amount: null },
    { supply_type: 'intrastate', transport_charge: 0, transport_gst_amount: 0 },
    { supply_type: 'intrastate' }                     // a row from before the columns existed
  ]) {
    assert.strictEqual(sb.gstr1TransportOf(inv), null, 'nothing charged is nothing to declare');
    // The totals object is returned untouched - not a rebuilt copy - so an
    // invoice with no transport cannot differ by so much as a rounding step.
    assert.strictEqual(sb.gstr1WithTransport(goods, sb.gstr1TransportOf(inv)), goods);
    assert.strictEqual(sb.gstr1TotalMatches(3186, goods.total), true);
    // A real mismatch is still a real mismatch.
    assert.strictEqual(sb.gstr1TotalMatches(9999, goods.total), false);
  }
});

test('T13b GSTR-1 export structure is untouched - no new column, no new section', () => {
  // val and itms still come from the line items, so the payload stays
  // self-consistent and the HSN cross-check still balances.
  assert.match(GSTR1, /val: gstr1InvoiceVal\(recomputed\.total\)/);
  assert.match(GSTR1, /itms: recomputed\.byRate\.map/);
  // The approved 15-column Complete Invoice Details sheet gains nothing.
  const REPORTS = rd('client', 'js', 'reports', 'reports.js');
  // Count the WIDTHS, not the commas: the array is preceded by a comment
  // block that carries commas of its own.
  const widths = (REPORTS.match(/COMPLETE_DETAIL_WIDTHS = \[[\s\S]*?\]/) || [''])[0]
    .replace(/\/\/[^\n]*/g, '')
    .match(/\d+/g) || [];
  assert.strictEqual(widths.length, 15, 'the sheet must still have exactly 15 columns');
  assert.ok(!/transport/i.test(REPORTS.slice(REPORTS.indexOf('COMPLETE_DETAIL_WIDTHS'),
    REPORTS.indexOf('COMPLETE_DETAIL_WIDTHS') + 1200)),
    'no Transport column may be added to the sheet');
});

// ═══ Proforma must not have grown a transport box ═════════════════════

test('T27 Proforma is untouched', () => {
  assert.match(ITEMS, /function itemsTransportEnabled\(\)\s*\{\s*return itemsFormPrefix === 'invoice';/);
  const sb = load({ formPrefix: 'proforma' });
  sb.__setItems([machineLine('intrastate')]);
  sb.__setTransport('1000');                       // even if something set it
  const out = sb.computeInvoiceRollups();
  assert.strictEqual(out.transport_charge, null, 'a proforma can never carry a transport charge');
  assert.strictEqual(out.total_amount, 3186);

  for (const f of [['client', 'js', 'pages', 'proforma-entry.js'],
                   ['client', 'js', 'pages', 'proforma-pdf.js'],
                   ['proforma.html']]) {
    assert.ok(!/transport_charge|transport_gst_amount/.test(rd(...f)),
      f.join('/') + ' must not mention the transport charge');
  }
  // ...and the column does not exist on the quotation table either.
  assert.ok(!/proforma_invoices/.test(rd('server', 'db', 'migrations', 'migration_invoice_transport_charge.sql')
    .replace(/--[^\n]*/g, '')), 'the migration must not touch proforma_invoices');
});

// ═══════════════════════════════════════════════════════════════════════
//  DB-backed half: persistence, edit, clear, tenant isolation, auth
// ═══════════════════════════════════════════════════════════════════════

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('transport charge persistence (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'transport-test-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function startServer(port) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: SCRATCH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', d => { out += d; if (out.includes('listening on')) { clearTimeout(done); resolve(child); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { clearTimeout(done); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

let server, base, db, USER_A, TOKEN_A, USER_B, TOKEN_B, PRODUCT_A;

// `token: null` really means "send no Authorization header" - it is not the
// same as omitting the option, and the auth test below depends on it.
async function api(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const msg = r => (r && r.body && r.body.error && r.body.error.message) || JSON.stringify(r.body);

let invSeq = 0;
// The header the browser sends: product figures plus whatever transport was
// typed. Written out here rather than derived, so the test states the
// numbers it expects instead of trusting the same arithmetic it is checking.
function header(transportCharge, { supply = 'intrastate', transportGst } = {}) {
  const charge = transportCharge;
  const gst = charge === null || charge === undefined ? null
    : Math.round(charge * 18) / 100 * 1;
  const inter = supply === 'interstate';
  const tGst = charge === null || charge === undefined ? 0 : charge * 0.18;
  const taxable = 2700 + (charge || 0);
  const gstAmt = 486 + tGst;
  return {
    customer_name: 'Transport Test Co', invoice_number: 'TR-' + (++invSeq),
    // b2b_invoices.gst_number is NOT NULL. Disposable, well-formed, and
    // belonging to nobody - this database is scratch and is truncated after.
    invoice_date: '2026-09-10', supply_type: supply, gst_number: '29AABCU9603R1ZM',
    taxable_amount: taxable, gst_percentage: 18, gst_amount: gstAmt,
    igst: inter ? gstAmt : 0,
    cgst: inter ? 0 : gstAmt / 2, sgst: inter ? 0 : gstAmt / 2,
    total_amount: Math.round(taxable + gstAmt),
    transport_charge: charge,
    // Deliberately WRONG where a value is given, to prove the server
    // recomputes it rather than storing what it was handed.
    transport_gst_amount: transportGst === undefined ? gst : transportGst
  };
}
const line = () => ([{
  product_id: PRODUCT_A, product_name: 'Machine', hsn_code: '84388090', unit: 'PCS',
  quantity: 1, rate: 2700, discount_percentage: 0, gst_percentage: 18,
  taxable_value: 2700, gst_amount: 486, gst_treatment: 'taxable',
  igst: 0, cgst: 243, sgst: 243, cess_rate: 0, cess_amount: 0, total_amount: 3186
}]);

const save = (body, token = TOKEN_A) =>
  api('POST', '/api/invoices/b2b/save-with-items', { token, body });

// eq_<column>=<value> is this router's filter syntax (buildWhere in
// routes/generic.js). A PostgREST-shaped `?id=eq.x` is not an error here -
// it is silently ignored as an unknown key, and the read comes back
// unfiltered, which is exactly how a passing assertion can be meaningless.
const readInvoice = async (id, token = TOKEN_A) =>
  (await api('GET', `/api/b2b_invoices?eq_id=${id}`, { token })).body;

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('transport-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('transport-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) {
    await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
    await db.query(
      `INSERT INTO stock_locations (user_id,name,code,is_default,active)
       VALUES ($1,'Main','MAIN',TRUE,TRUE)`, [u]);
  }
  PRODUCT_A = (await db.query(
    `INSERT INTO products (user_id,name,hsn_code,unit,gst_percentage,stock)
     VALUES ($1,'Machine','84388090','PCS',18,500) RETURNING id`, [USER_A])).rows[0].id;
  // The sale path checks the LEDGER, not products.stock, so the balance has
  // to exist too or every save below is refused for insufficient stock.
  // Seeded straight in: what is being tested here is the transport charge,
  // and going through a purchase to get there would be testing the ledger.
  const LOC_A = (await db.query(
    'SELECT id FROM stock_locations WHERE user_id=$1 AND is_default LIMIT 1', [USER_A])).rows[0].id;
  await db.query(
    `INSERT INTO stock_balances (user_id, product_id, location_id, quantity)
     VALUES ($1,$2,$3,500)`, [USER_A, PRODUCT_A, LOC_A]);
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('T11/T12 the charge and its tax save and read back', async () => {
  const r = await save({ editId: null, header: header(1000), items: line() });
  assert.strictEqual(r.status, 200, msg(r));
  const id = r.body.invoiceId;

  const { rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount, taxable_amount, gst_amount, total_amount FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(Number(rows[0].transport_charge), 1000);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 180);
  assert.strictEqual(Number(rows[0].taxable_amount), 3700);
  assert.strictEqual(Number(rows[0].total_amount), 4366);

  // ...and comes back through the API the reopening form reads.
  const [read] = await readInvoice(id);
  assert.strictEqual(Number(read.transport_charge), 1000);
  assert.strictEqual(Number(read.transport_gst_amount), 180);
});

test('T11b blank transport stores NULL, and the invoice is unchanged', async () => {
  const r = await save({ editId: null, header: header(null), items: line() });
  assert.strictEqual(r.status, 200, msg(r));
  const { rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount, taxable_amount, gst_amount, total_amount FROM b2b_invoices WHERE id=$1',
    [r.body.invoiceId]);
  assert.strictEqual(rows[0].transport_charge, null, 'blank must be NULL, never 0');
  assert.strictEqual(rows[0].transport_gst_amount, null);
  assert.strictEqual(Number(rows[0].taxable_amount), 2700);
  assert.strictEqual(Number(rows[0].gst_amount), 486);
  assert.strictEqual(Number(rows[0].total_amount), 3186);
});

test('T2b a zero charge is stored as 0, not folded back into NULL', async () => {
  const r = await save({ editId: null, header: header(0), items: line() });
  assert.strictEqual(r.status, 200, msg(r));
  const { rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount FROM b2b_invoices WHERE id=$1', [r.body.invoiceId]);
  assert.strictEqual(Number(rows[0].transport_charge), 0);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 0);
});

test('T5-T8f the server refuses a malformed charge and saves nothing', async () => {
  const before = (await db.query('SELECT COUNT(*)::int n FROM b2b_invoices')).rows[0].n;
  for (const bad of [-1, 'abc', '12abc', [], [1000], { a: 1 }, true, 'Infinity', 'NaN']) {
    const r = await save({ editId: null, header: header(bad), items: line() });
    assert.strictEqual(r.status, 400, `${JSON.stringify(bad)} must be refused: ${msg(r)}`);
    assert.match(msg(r), /transport charge/i);
  }
  const after = (await db.query('SELECT COUNT(*)::int n FROM b2b_invoices')).rows[0].n;
  assert.strictEqual(after, before, 'a refused save must leave no invoice behind');
});

test('T5-T8g a client-supplied transport tax is ignored - the server derives it', async () => {
  // The browser claims 1000 of transport carries 5000 of tax.
  const r = await save({ editId: null, header: header(1000, { transportGst: 5000 }), items: line() });
  assert.strictEqual(r.status, 200, msg(r));
  const { rows } = await db.query(
    'SELECT transport_gst_amount FROM b2b_invoices WHERE id=$1', [r.body.invoiceId]);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 180, 'the stored tax is the derived one');
});

test('T13c/T14b editing the charge replaces it - the old one never survives', async () => {
  const created = await save({ editId: null, header: header(1000), items: line() });
  const id = created.body.invoiceId;

  const up = await save({ editId: id, header: header(1500), items: line() });
  assert.strictEqual(up.status, 200, msg(up));
  let { rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount, taxable_amount, total_amount FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(Number(rows[0].transport_charge), 1500);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 270);
  assert.strictEqual(Number(rows[0].taxable_amount), 4200);
  assert.strictEqual(Number(rows[0].total_amount), 4956);

  const down = await save({ editId: id, header: header(800), items: line() });
  assert.strictEqual(down.status, 200, msg(down));
  ({ rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount, total_amount FROM b2b_invoices WHERE id=$1', [id]));
  assert.strictEqual(Number(rows[0].transport_charge), 800);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 144);
  assert.strictEqual(Number(rows[0].total_amount), 3186 + 800 + 144);
});

test('T15b clearing the charge on an edit returns the invoice to its original total', async () => {
  const created = await save({ editId: null, header: header(1500), items: line() });
  const id = created.body.invoiceId;

  const cleared = await save({ editId: id, header: header(null), items: line() });
  assert.strictEqual(cleared.status, 200, msg(cleared));
  const { rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount, taxable_amount, gst_amount, total_amount FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(rows[0].transport_charge, null, 'cleared is NULL, not 0');
  assert.strictEqual(rows[0].transport_gst_amount, null);
  assert.strictEqual(Number(rows[0].taxable_amount), 2700);
  assert.strictEqual(Number(rows[0].gst_amount), 486);
  assert.strictEqual(Number(rows[0].total_amount), 3186);
});

test('T10c an inter-state invoice stores the whole tax as IGST', async () => {
  const r = await save({ editId: null, header: header(1000, { supply: 'interstate' }), items: line() });
  assert.strictEqual(r.status, 200, msg(r));
  const { rows } = await db.query(
    'SELECT igst, cgst, sgst, taxable_amount, total_amount, transport_gst_amount FROM b2b_invoices WHERE id=$1',
    [r.body.invoiceId]);
  assert.strictEqual(Number(rows[0].igst), 666);
  assert.strictEqual(Number(rows[0].cgst), 0);
  assert.strictEqual(Number(rows[0].sgst), 0);
  assert.strictEqual(Number(rows[0].taxable_amount), 3700);
  assert.strictEqual(Number(rows[0].total_amount), 4366);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 180);
});

test('T23 tenant isolation - one tenant cannot read or change another\'s charge', async () => {
  const mine = await save({ editId: null, header: header(1000), items: line() });
  const id = mine.body.invoiceId;

  // B cannot see it.
  const seen = await readInvoice(id, TOKEN_B);
  assert.strictEqual(Array.isArray(seen) ? seen.length : 0, 0, 'B must not read A\'s invoice');

  // B cannot edit it - the save path scopes its UPDATE by user_id.
  const stolen = await save({ editId: id, header: header(9999), items: line() }, TOKEN_B);
  assert.strictEqual(stolen.status, 404, msg(stolen));
  const { rows } = await db.query('SELECT transport_charge FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(Number(rows[0].transport_charge), 1000, 'A\'s charge must be untouched');

  // B cannot reach it through the generic router either.
  const patched = await api('PATCH', `/api/b2b_invoices?eq_id=${id}`,
    { token: TOKEN_B, body: { transport_charge: 7777 } });
  assert.ok(patched.status === 404 || patched.status === 200, msg(patched));
  const { rows: after } = await db.query('SELECT transport_charge FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(Number(after[0].transport_charge), 1000);
});

test('T23b the derived tax has one writer - the generic route refuses it outright', async () => {
  const mine = await save({ editId: null, header: header(1000), items: line() });
  const id = mine.body.invoiceId;

  // Even the OWNER cannot set it directly: it is derived, so a figure
  // nothing derived has no way in.
  const patched = await api('PATCH', `/api/b2b_invoices?eq_id=${id}`,
    { token: TOKEN_A, body: { transport_gst_amount: 9999 } });
  assert.strictEqual(patched.status, 400, msg(patched));
  assert.match(msg(patched), /transport_gst_amount/);

  const { rows } = await db.query(
    'SELECT transport_gst_amount FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(Number(rows[0].transport_gst_amount), 180, 'the derived tax stands');

  // ...and the registry says so, on both invoice tables.
  const GEN = rd('server', 'src', 'routes', 'generic.js');
  assert.strictEqual((GEN.match(/immutable: \['transport_gst_amount'\]/g) || []).length, 2,
    'both b2b_invoices and b2c_invoices must refuse it');
});

test('T24 the save path is authenticated', async () => {
  const anon = await save({ editId: null, header: header(1000), items: line() }, null);
  assert.strictEqual(anon.status, 401, msg(anon));
  const bad = await save({ editId: null, header: header(1000), items: line() }, 'not-a-token');
  assert.strictEqual(bad.status, 401, msg(bad));
});

test('T25 an invoice that predates the columns is not disturbed by them', async () => {
  // Written straight to the table with no transport columns named at all -
  // exactly the shape of every row already in production.
  const { rows: made } = await db.query(
    `INSERT INTO b2b_invoices (user_id, customer_name, gst_number, invoice_number, invoice_date,
       supply_type, taxable_amount, gst_percentage, gst_amount, cgst, sgst, igst, total_amount)
     VALUES ($1,'Legacy Co','29AABCU9603R1ZM','LEGACY-1','2026-01-01','intrastate',2700,18,486,243,243,0,3186)
     RETURNING id, transport_charge, transport_gst_amount`, [USER_A]);
  assert.strictEqual(made[0].transport_charge, null, 'no DEFAULT may put a 0 on an old invoice');
  assert.strictEqual(made[0].transport_gst_amount, null);

  // Reading it back changes nothing, and its totals are what they were.
  const [read] = await readInvoice(made[0].id);
  assert.strictEqual(read.transport_charge, null);
  assert.strictEqual(Number(read.taxable_amount), 2700);
  assert.strictEqual(Number(read.total_amount), 3186);

  // Saving it again WITHOUT naming transport leaves it NULL rather than
  // writing a zero over it.
  const h = header(null);
  delete h.transport_charge;
  delete h.transport_gst_amount;
  const again = await save({ editId: made[0].id, header: h, items: line() });
  assert.strictEqual(again.status, 200, msg(again));
  const { rows } = await db.query(
    'SELECT transport_charge, transport_gst_amount FROM b2b_invoices WHERE id=$1', [made[0].id]);
  assert.strictEqual(rows[0].transport_charge, null);
  assert.strictEqual(rows[0].transport_gst_amount, null);
});

test('T14c payments and the ledger see the transport in the balance', async () => {
  const r = await save({ editId: null, header: header(1000), items: line() });
  const id = r.body.invoiceId;
  // No separate transport balance exists: what is owed is total_amount,
  // which already includes the charge and its tax.
  const { rows } = await db.query(
    'SELECT total_amount, amount_paid FROM b2b_invoices WHERE id=$1', [id]);
  assert.strictEqual(Number(rows[0].total_amount), 4366);
  assert.strictEqual(Number(rows[0].amount_paid || 0), 0);
  const { rows: cols } = await db.query(
    `SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name='b2b_invoices' AND column_name LIKE '%transport%balance%'`);
  assert.strictEqual(cols[0].n, 0, 'there must be no separate transport balance');
});
