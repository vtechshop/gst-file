// Purchase Orders list - the presentation contract.
//
// The list was redesigned for layout only. These guard what a restyle must
// never move: what each row shows, which actions each status offers and
// what they call, what the filters send, every hook the page's script
// depends on, and the scoping that keeps the new styles on this page alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = rd('purchase-orders.html');
const LIST = rd('client', 'js', 'pages', 'purchase-order-list.js');
const CSS = rd('client', 'css', 'style.css');
const UTILS = rd('client', 'js', 'utilities', 'utils.js');

// The list script and the formatters it uses, in a sandbox.
function sandbox() {
  const noop = () => {};
  const el = { addEventListener: noop, appendChild: noop, style: {}, classList: { add: noop, remove: noop } };
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, RegExp, Intl, Promise, Error,
    parseInt, parseFloat, isNaN, isFinite, URLSearchParams,
    navigator: { userAgent: 'node' }, location: { href: '', search: '', hostname: 'x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      addEventListener: noop, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], createElement: () => el, body: el, head: el, documentElement: el
    }
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(UTILS, sb, { filename: 'utils.js' });
  vm.runInContext(LIST, sb, { filename: 'purchase-order-list.js' });
  return sb;
}
// The visible text of each cell of a rendered row.
function cellsOf(html) {
  return html.split(/<td\b/).slice(1).map(s => s.slice(s.indexOf('>') + 1)
    .replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '—').replace(/&#8377;/g, '₹')
    .replace(/\s+/g, ' ').trim());
}
// Every action control: what it is, what it says, what it calls, where it goes.
function actionsOf(html) {
  return [...html.matchAll(/<(a|button)\b([^>]*)>/g)].map(m => {
    const attr = n => { const r = new RegExp(n + '="([^"]*)"').exec(m[2]); return r ? r[1] : null; };
    return [m[1], attr('title'), attr('onclick'), attr('href')];
  });
}

const ID = '11111111-2222-3333-4444-555555555555';
const ROW = {
  id: ID, document_number: 'PO-00042', document_date: '2026-09-04',
  vendor_name: 'Coimbatore Precision Engineering & Industrial Machinery Suppliers Private Limited',
  expected_delivery_date: '2026-09-18', total_amount: '1476187.08',
  ordered_quantity: '7', received_quantity: '1', pending_quantity: '6'
};
const EDIT = ['a', 'View / Edit', null, 'purchase-order.html?id=' + ID];
const PDF = ['button', 'PDF', `poPdf('${ID}')`, null];
const PRINT = ['button', 'Print', `poPrint('${ID}')`, null];
const RECEIVE = ['button', 'Receive goods', `openPoReceive('${ID}')`, null];
const CANCEL = ['button', 'Cancel', `poCancel('${ID}')`, null];
// Status value -> label, badge class, and exactly the actions it offers.
const STATUSES = {
  DRAFT: ['Draft', 'badge-secondary', [EDIT, PDF, PRINT, CANCEL]],
  SENT: ['Sent', 'badge-info', [EDIT, PDF, PRINT, RECEIVE, CANCEL]],
  CONFIRMED: ['Confirmed', 'badge-green', [EDIT, PDF, PRINT, RECEIVE, CANCEL]],
  PARTIALLY_RECEIVED: ['Partially received', 'badge-warning', [EDIT, PDF, PRINT, RECEIVE]],
  FULLY_RECEIVED: ['Fully received', 'badge-success', [EDIT, PDF, PRINT]],
  CANCELLED: ['Cancelled', 'badge-danger', [EDIT, PDF, PRINT]],
  CLOSED: ['Closed', 'badge-secondary', [EDIT, PDF, PRINT]]
};

test('UI1 every status shows the same cells, label, badge and actions it always has', () => {
  const sb = sandbox();
  for (const [status, [label, cls, actions]] of Object.entries(STATUSES)) {
    const html = sb.poRow({ ...ROW, status });
    assert.deepStrictEqual(cellsOf(html), [
      'PO-00042', sb.formatDate('2026-09-04'), ROW.vendor_name.replace('&', '&amp;'), sb.formatDate('2026-09-18'),
      '₹' + sb.formatNum('1476187.08'), '7', '1', '6', label, ''
    ], status + ': cell text (the vendor still HTML-escaped)');
    assert.match(html, new RegExp(`<span class="badge ${cls}">${label}</span>`), status + ': badge');
    assert.deepStrictEqual(actionsOf(html), actions, status + ': actions, handlers and link');
  }
});

test('UI2 nothing is received on an order with nothing pending, and a missing date is a dash', () => {
  const sb = sandbox();
  const html = sb.poRow({ ...ROW, status: 'CONFIRMED', pending_quantity: '0', expected_delivery_date: null });
  assert.deepStrictEqual(actionsOf(html), [EDIT, PDF, PRINT, CANCEL]);
  assert.strictEqual(cellsOf(html)[3], '—');
  assert.doesNotMatch(html, /text-warning/, 'nothing pending is not highlighted');
  assert.match(sb.poRow({ ...ROW, status: 'CONFIRMED' }), /class="text-right text-warning"><b>6<\/b>/);
});

test('UI3 the actions are wrapped for layout, and nothing about them changed', () => {
  const sb = sandbox();
  const html = sb.poRow({ ...ROW, status: 'SENT' });
  const cell = html.slice(html.lastIndexOf('<td'));
  assert.match(cell, /^<td class="text-right">\s*<div class="po-actions">/, 'one wrapper, inside the same cell');
  assert.strictEqual((cell.match(/class="po-actions"/g) || []).length, 1);
  assert.match(cell, /<\/div>\s*<\/td>\s*<\/tr>\s*$/);
  // The vendor name is wrapped so it can clamp to two lines; the same
  // escaped name is its text and its tooltip.
  const vendor = ROW.vendor_name.replace('&', '&amp;');
  assert.ok(html.includes(`<td><span class="po-vendor" title="${vendor}">${vendor}</span></td>`));
  const quoted = sb.poRow({ ...ROW, status: 'SENT', vendor_name: 'A "B" <C>' });
  assert.ok(quoted.includes('<span class="po-vendor" title="A &quot;B&quot; &lt;C&gt;">A &quot;B&quot; &lt;C&gt;</span>'),
    'a quote in a vendor name cannot break out of the tooltip');
});

test('UI4 the filters send exactly the query they always have', () => {
  for (const line of [
    "params.set('q', val('poSearch').trim())", "params.set('status', val('poStatus'))",
    "params.set('from', val('poFrom'))", "params.set('to', val('poTo'))",
    "params.set('delivery_from', val('poDeliveryFrom'))", "params.set('delivery_to', val('poDeliveryTo'))",
    "params.set('pending', '1')", "params.set('limit', String(PO_PAGE_SIZE))",
    "params.set('offset', String(poPage * PO_PAGE_SIZE))"
  ]) assert.ok(LIST.includes(line), line);
  assert.match(LIST, /apiFetch\('\/purchase-orders\?' \+ params\.toString\(\)\)/);
  // The empty row keeps its messages; only a styling class was added.
  assert.match(LIST, /'No purchase orders match these filters\.'/);
  assert.match(LIST, /'No purchase orders yet\. Raise one to order goods from a vendor\.'/);
  assert.match(LIST, /class="text-center text-muted po-empty"/);
});

test('UI5 the page keeps every hook, option and destination', () => {
  for (const [id, attr, handler] of [
    ['poSearch', 'oninput', 'poDebouncedReload()'], ['poStatus', 'onchange', 'poReload()'],
    ['poFrom', 'onchange', 'poReload()'], ['poTo', 'onchange', 'poReload()'],
    ['poDeliveryFrom', 'onchange', 'poReload()'], ['poDeliveryTo', 'onchange', 'poReload()'],
    ['poPending', 'onchange', 'poReload()']
  ]) {
    const tag = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(HTML);
    assert.ok(tag, id + ' is on the page');
    assert.ok(tag[0].includes(`${attr}="${handler}"`), `${id} still calls ${handler}`);
  }
  const options = id => [...HTML.slice(HTML.indexOf(`id="${id}"`), HTML.indexOf('</select>', HTML.indexOf(`id="${id}"`)))
    .matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);
  assert.deepStrictEqual(options('poStatus'), [['', 'All statuses'], ['DRAFT', 'Draft'], ['SENT', 'Sent'],
    ['CONFIRMED', 'Confirmed'], ['PARTIALLY_RECEIVED', 'Partially received'], ['FULLY_RECEIVED', 'Fully received'],
    ['CANCELLED', 'Cancelled'], ['CLOSED', 'Closed']]);
  assert.deepStrictEqual(options('poPending'), [['', 'Everything'], ['1', 'Still awaiting goods']]);
  assert.match(HTML, /<a href="purchase-order\.html" class="btn btn-primary[^"]*">[^<]*<i class="fas fa-plus"><\/i> New Purchase Order<\/a>/);
  for (const id of ['poListBody', 'poPagination', 'poReceiveModal', 'poReceiveNumber', 'poReceiveNum',
    'poReceiveDate', 'poReceiveBody', 'poReceiveError', 'poReceiveSave']) {
    assert.ok(HTML.includes(`id="${id}"`), id + ' is on the page');
  }
  assert.match(HTML, /<div class="modal-overlay" id="poReceiveModal">/, 'the receive panel is still an overlay');
  const head = HTML.slice(HTML.indexOf('po-list-table'), HTML.indexOf('</thead>'));
  assert.deepStrictEqual([...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]),
    ['PO Number', 'Date', 'Vendor', 'Expected', 'Total', 'Ordered', 'Received', 'Pending', 'Status', 'Actions']);
  // The changed assets carry new keys on this page.
  assert.ok(HTML.includes('client/css/style.css?v=37'));
  assert.ok(HTML.includes('client/js/pages/purchase-order-list.js?v=2'));
});

test('UI6 the new styles are scoped to this page, and style every status class the list uses', () => {
  const start = CSS.indexOf('Purchase Orders list (purchase-orders.html)');
  const end = CSS.indexOf('/* end Purchase Orders list */');
  assert.ok(start > -1 && end > start, 'one delimited section');
  const block = CSS.slice(CSS.lastIndexOf('/*', start), end).replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...block.matchAll(/([^{}]+)\{/g)].map(m => m[1].trim()).filter(s => !s.startsWith('@media'));
  assert.ok(selectors.length > 20, 'the section was found and parsed');
  for (const group of selectors) {
    for (const sel of group.split(',').map(s => s.trim())) {
      assert.ok(sel.startsWith('.po-list-page') || sel.startsWith(':root[data-theme="dark"] .po-list-page'),
        'unscoped selector: ' + sel);
    }
  }
  // Colours come from page tokens that the app's dark theme swaps.
  assert.match(block, /:root\[data-theme="dark"\] \.po-list-page \{[^}]*--po-ink:/);
  const used = [...new Set([...LIST.matchAll(/'(badge-[a-z]+)'/g)].map(m => m[1]))];
  assert.deepStrictEqual(used.sort(), ['badge-danger', 'badge-green', 'badge-info', 'badge-secondary', 'badge-success', 'badge-warning']);
  for (const cls of used) {
    assert.match(block, new RegExp(`\\.po-list-page \\.po-list-table \\.${cls}\\s*\\{`), cls + ' is styled');
  }
  assert.equal(/!important/.test(block), false, 'no !important');
});
