// New Invoice page - the presentation contract.
//
// invoice.html was redesigned for layout only: wrapper <div>s and iv- classes
// around its existing markup, and a page-scoped block in style.css. These
// guard what a restyle must never move - every control, in the order Enter
// walks them, with the handlers they had; the classes the page's scripts
// toggle; and the scoping that keeps the new styles on this page and out of
// the way of those toggles.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = rd('invoice.html');
const CSS = rd('client', 'css', 'style.css');
const ENTRY = rd('client', 'js', 'pages', 'invoice-entry.js');

// Every control with an id, in document order, with its inline handlers -
// as the page had them before the redesign. The order is the Enter-key
// order: focusNextFormField() walks the form in document order.
const CONTROLS = [
  ['logoutBtn', ''], ['menuToggle', ''],
  ['invScanInput', 'onchange=handleInvoiceScanUpload(this.files)'],
  ['invTypeB2B', 'onchange=onInvoiceTypeToggle()'], ['invTypeB2C', 'onchange=onInvoiceTypeToggle()'],
  ['invCustName', 'oninput=onInvoiceCustomerInput() | onfocus=onInvCustNameFocus(this) | onmousedown=onInvCustNameMouseDown(event, this)'],
  ['invPhone', ''],
  ['invGstin', 'oninput=onInvoiceGstinInput(this) | onblur=onInvoiceGstinBlur(this)'],
  ['invGstVerifyBtn', 'onclick=verifyInvoiceGstin()'],
  ['invState', 'onchange=detectSupplyType();onInvStateChange()'],
  ['invDistrict', 'onchange=onInvDistrictChange()'],
  ['invAddress', 'oninput=mirrorInvShipFromBilling()'],
  ['invShipSame', 'onchange=onInvShipSameChange()'],
  ['invShipState', 'onchange=onInvShipStateChange()'],
  ['invShipDistrict', 'onchange=onInvShipDistrictChange()'],
  ['invShipAddress', ''],
  ['autoInvToggle', 'onchange=onAutoToggleChange()'],
  ['invNum', ''], ['invSource', 'onchange=onInvoiceSourceChange()'], ['invDate', ''],
  ['invReverseCharge', ''], ['invGstCategory', 'onchange=onInvGstCategoryChange()'], ['invSupply', ''],
  ['invWarrantyPeriod', 'onchange=onWarrantyPeriodChange()'],
  ['invWarrantyStart', 'onchange=onWarrantyStartChange()'],
  ['invWarrantyUntil', 'onchange=onWarrantyUntilEdited()'],
  ['invWarrantyTerms', ''],
  ['transportToggle', 'onchange=onTransportToggleChange()'],
  ['exportToggle', 'onchange=onExportToggleChange()'],
  ['invDifferential65', ''],
  ['invExportType', ''], ['invPortCode', ''], ['invShippingBillNo', ''], ['invShippingBillDate', ''],
  ['invExportOf', ''], ['invSezRecipient', ''],
  ['ecomToggle', 'onchange=onEcomToggleChange()'],
  ['invEcomGstin', 'oninput=uppercaseKeepCursor(this)'], ['invEcomSupplyType', ''],
  ['invVehicleNo', 'oninput=uppercaseKeepCursor(this)'], ['invTransporter', ''], ['invTransportMode', ''],
  ['invDistance', ''], ['invLrNumber', ''], ['invLrDate', ''],
  ['invTransporterGstin', 'oninput=this.value=this.value.toUpperCase()'],
  ['invVehicleType', ''], ['invDispatchFrom', ''], ['invDispatchTo', ''],
  ['invPaymentStatus', 'onchange=onInvPaymentStatusChange()'],
  ['invPaymentAmount', 'oninput=renderInvPaymentPreview()'],
  ['invPaymentDate', ''], ['invPaymentMode', ''], ['invPaymentReference', ''], ['invPaymentNote', ''],
  ['invPreviewTotal', ''], ['invPreviewReceived', ''], ['invPreviewBalance', ''],
  ['invSaveBtn', 'onclick=saveInvoice()'],
  ['invActionPdf', ''], ['invActionPrint', ''], ['invActionWhatsApp', ''], ['invActionEmail', ''],
  ['globalSearchInput', 'oninput=onGlobalSearchInput(this.value)'],
  ['serialPanelInput', 'onkeydown=serialPanelKey(event)']
];

test('IP1 every control keeps its place in the form and its handlers', () => {
  const found = [...HTML.matchAll(/<(input|select|textarea|button)\b([^>]*)>/g)]
    .map(m => [(m[2].match(/\bid="([^"]+)"/) || [])[1], [...m[2].matchAll(/\b(on[a-z]+)="([^"]*)"/g)].map(x => x[1] + '=' + x[2]).join(' | ')])
    .filter(([id]) => id);
  assert.deepStrictEqual(found, CONTROLS);
  // ...and Enter still walks them in document order.
  assert.ok(ENTRY.includes("'.main-content input:not([type=hidden]):not([disabled]), .main-content select:not([disabled])'"));
});

test('IP2 what the scripts toggle is untouched: ids keep their exact classes', () => {
  for (const [id, cls] of [
    ['exportFields', 'form-grid cols-4 mb-16 d-none'],
    ['ecomFields', 'form-grid cols-3 mb-16 d-none'],
    ['transportFields', 'form-grid cols-3 mb-16 d-none'],
    ['invB2BFields', 'form-grid cols-2 mb-16'],
    ['invPaymentEditableFields', 'form-grid cols-2 mb-16'],
    ['invPaymentAmountGroup', 'form-group inv-collapsible collapsed'],
    ['invPaymentDetailGroup', 'form-grid cols-2 mb-16 inv-collapsible collapsed'],
    ['invPaymentPreview', 'calc-box mb-16'],
    ['invPaymentEditNote', 'text-muted-sm fs-12 mb-16 d-none'],
    ['invSavedPanel', 'card mb-20 d-none'],
    ['invModeHeader', 'inv-mode-header inv-mode-b2c'],
    ['invGstinStatus', 'd-flex align-center gap-8 d-none']
  ]) {
    const tag = new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML);
    assert.ok(tag, id + ' is on the page');
    const m = /\bclass="([^"]*)"/.exec(tag[0]);
    assert.strictEqual(m && m[1], cls, id + ' keeps its classes');
  }
  // The summary still shows the same four things, in the same order.
  const box = HTML.slice(HTML.indexOf('id="invPaymentPreview"'), HTML.indexOf('id="invPaymentEditNote"'));
  assert.deepStrictEqual([...box.matchAll(/<span class="label">([^<]*)<\/span>/g)].map(m => m[1]),
    ['Grand Total', 'Amount Received', 'Remaining Balance', 'Status']);
});

test('IP3 the redesign only adds: wrappers carry nothing but a class, iv- classes never land on an id', () => {
  const wrappers = [...HTML.matchAll(/<div\b[^>]*class="[^"]*\biv-(section|options|pay-layout|pay-inputs|pay-summary|actions)\b[^"]*"[^>]*>/g)].map(m => m[0]);
  assert.ok(wrappers.length >= 12, 'the section wrappers are present');
  for (const w of wrappers) assert.match(w, /^<div class="[^"]*">$/, 'a wrapper is a bare styled div: ' + w);
  for (const m of HTML.matchAll(/<[a-z]+\b[^>]*\bclass="[^"]*\b(iv-[a-z0-9-]+|inv-page)\b[^"]*"[^>]*>/g)) {
    assert.ok(!/\bid="/.test(m[0]), 'styling classes stay off elements scripts address by id: ' + m[0]);
    assert.ok(!/\bon[a-z]+="/.test(m[0]), 'and off elements with handlers: ' + m[0]);
  }
  assert.ok(HTML.includes('<div class="content inv-page">'));
  assert.ok(HTML.includes('client/css/style.css?v=38'));
});

test('IP4 the page styles are scoped, and never undo a script toggle', () => {
  const start = CSS.indexOf('New Invoice page (invoice.html)');
  const end = CSS.indexOf('/* end New Invoice page */');
  assert.ok(start > -1 && end > start, 'one delimited section');
  const block = CSS.slice(CSS.lastIndexOf('/*', start), end).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim().replace(/^@media[^{]*$/, ''), body: m[2] }))
    .filter(r => r.sel && !r.sel.startsWith('@'));
  assert.ok(rules.length > 60, 'the section was parsed');
  for (const r of rules) {
    for (const sel of r.sel.split(/,(?![^(]*\))/).map(s => s.trim())) {
      assert.ok(sel.startsWith('.inv-page') || sel.startsWith(':root[data-theme="dark"] .inv-page'), 'unscoped selector: ' + sel);
      // (a ::before caption is its own box; displaying it shows nothing a script hid)
      if (/(^|[;\s])display\s*:/.test(r.body) && !/display\s*:\s*none/.test(r.body) && !/::(before|after)$/.test(sel)) {
        // this block outranks .d-none, so any displayed calc row must opt out of it
        if (/\.calc-row(?![\w-])/.test(sel.split(' ').pop())) assert.match(sel, /:not\(\.d-none\)/, 'shows a row the scripts hide: ' + sel);
        for (const id of ['exportFields', 'ecomFields', 'transportFields', 'invPaymentPreview', 'invPaymentEditNote',
          'invPaymentEditableFields', 'invPaymentDetailGroup', 'invSavedPanel', 'itemsCessRow', 'itemsTransportNoteRow', 'invGstinStatus']) {
          assert.ok(!new RegExp('#' + id + '(?![\\w-])[^ ]*$').test(sel), 'sets display on a toggled element: ' + sel);
        }
      }
    }
  }
  assert.equal(/!important/.test(block), false, 'no !important');
  // Enter skips anything whose offsetParent is null; a fixed element has none.
  assert.equal(/position\s*:\s*fixed/.test(block), false, 'nothing fixed-position');
});
