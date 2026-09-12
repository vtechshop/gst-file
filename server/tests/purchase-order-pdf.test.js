// Purchase Order PDF.
//
// A purchase order is a document a supplier acts on, so what it prints must
// be what was stored. Every case below builds a REAL PDF with jsPDF and
// reads the text back out of it - nothing is asserted from the source
// alone - and the figures are checked against the order row they came from.
//
// The renderer is presentation only: it derives no tax and no line amount.
// purchase-orders-guards.test.js P16 pins that rule; these pin the document.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const POPDF = rd('client', 'js', 'pages', 'purchase-order-pdf.js');
const PO_LIST_HTML = rd('purchase-orders.html');
const PO_ENTRY_HTML = rd('purchase-order.html');

// ── A browser-shaped sandbox with the real jsPDF in it ────────────────
const noop = () => {};
const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop,
  getContext: () => null, toDataURL: () => '' });

// jsPDF and its autoTable plugin are CDN scripts in the browser, not server
// dependencies, so the render cases need copies to exist somewhere. They run
// when both do - node_modules if ever installed, or JSPDF_PATH /
// JSPDF_AUTOTABLE_PATH - and skip with a reason when they do not.
const findLib = (envVar, ...rel) => {
  const candidates = [process.env[envVar], path.join(__dirname, '..', 'node_modules', ...rel)].filter(Boolean);
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
};
const JSPDF_FILE = findLib('JSPDF_PATH', 'jspdf', 'dist', 'jspdf.umd.min.js');
const AUTOTABLE_FILE = findLib('JSPDF_AUTOTABLE_PATH', 'jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js')
  || (JSPDF_FILE ? path.join(path.dirname(JSPDF_FILE), 'jspdf.plugin.autotable.min.js') : null);
const HAVE_LIBS = !!(JSPDF_FILE && AUTOTABLE_FILE && fs.existsSync(AUTOTABLE_FILE));
const NO_LIBS = { skip: 'jsPDF / autoTable are not available - set JSPDF_PATH (and JSPDF_AUTOTABLE_PATH) to run the render cases' };
const renderTest = (name, fn) => (HAVE_LIBS ? test(name, fn) : test(name, NO_LIBS, () => {}));

const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const PROFILE = {
  business_name: 'VTECH KITCHEN EQUIPMENTS',
  address: '9/83 E, 4th Street Extension, T Balan Nagar',
  district: 'Coimbatore', state: 'Tamil Nadu',
  gstin: '33AAAAA0000A1Z5', pan: 'AAAAA0000A',
  phone: '98400 00000', email: 'orders@vtech.test', website: 'www.vtech.test',
  bank_name: 'Bank of Baroda', bank_account_no: '1234567890123',
  bank_ifsc: 'BARB0GANAPA', bank_branch: 'Ganapathy Pudur',
  logo_base64: PNG_A, seal_base64: PNG_A, signature_base64: PNG_B,
  terms_conditions: ''
};

function load(profile) {
  const el = mkEl();
  const sb = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Math, Date, JSON, Promise, Error, RegExp, Map, Set, Intl, ArrayBuffer,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array, DataView,
    Number, String, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    Buffer, TextEncoder, TextDecoder, btoa, atob,
    navigator: { userAgent: 'node' },
    location: { href: '', search: '', hostname: 'x', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: el, body: el, head: el,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => mkEl() },
    alert: noop, fetch: () => Promise.reject(new Error('no net')),
    __docs: [], __images: [], __texts: []
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), sb, { filename: 'jspdf.umd.min.js' });
  vm.runInContext(fs.readFileSync(AUTOTABLE_FILE, 'utf8'), sb, { filename: 'jspdf.plugin.autotable.min.js' });
  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  // The pages load invoice-pdf.js before this one, for inkBoundsOf() and
  // placeInk(); the sandbox does the same. Without a canvas, inkBoundsOf()
  // returns null and placeInk() falls back to the file's own edges - which
  // is the path a broken or unmeasurable image takes in the browser too.
  vm.runInContext(rd('client', 'js', 'pages', 'invoice-pdf.js'), sb, { filename: 'invoice-pdf.js' });
  vm.runInContext(POPDF, sb, { filename: 'purchase-order-pdf.js' });
  vm.runInContext(`
    showToast = function () {};
    handleApiError = function () {};
    getCachedProfile = function () { return ${JSON.stringify(profile === undefined ? PROFILE : profile)}; };
    (function () {
      const Orig = window.jspdf.jsPDF;
      function Wrapped(o) {
        const d = new Orig(o);
        const ai = d.addImage;
        const tx = d.text;
        d.addImage = function (img, f, x, y, w, h) {
          __images.push({ x: x, y: y, w: w, h: h, page: d.internal.getCurrentPageInfo().pageNumber });
          return ai.apply(d, arguments);
        };
        d.text = function (s, x, y) {
          __texts.push({ s: Array.isArray(s) ? s.join(' ') : String(s), x: x, y: y,
            page: d.internal.getCurrentPageInfo().pageNumber });
          return tx.apply(d, arguments);
        };
        d.save = function () { return d; };
        __docs.push(d);
        return d;
      }
      Wrapped.API = Orig.API;
      window.jspdf.jsPDF = Wrapped;
    })();
  `, sb);
  return sb;
}

// Pull the readable text out of a finished PDF. jsPDF compresses its
// content streams, so each one is inflated before being searched - a
// substring check against the raw bytes would silently pass on nothing.
function pdfText(buf) {
  const raw = buf.toString('latin1');
  const shown = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1], 'latin1');
    let s;
    try { s = zlib.inflateSync(chunk).toString('latin1'); }
    catch { try { s = zlib.inflateRawSync(chunk).toString('latin1'); } catch { s = chunk.toString('latin1'); } }
    const tr = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let t;
    while ((t = tr.exec(s)) !== null) shown.push(t[1].replace(/\\([()\\])/g, '$1'));
  }
  return shown.join('\n');
}

async function render(order, items, profile, ink) {
  const sb = load(profile);
  // In the browser inkBoundsOf() measures the pixels, and the renderer centres
  // the VISIBLE ink rather than the file. The sandbox has no canvas, so a case
  // that cares about that path hands the measurements in itself.
  if (ink) {
    vm.runInContext('inkBoundsOf = async function (u) { return ('
      + JSON.stringify(ink) + ')[u] || null; };', sb);
  }
  sb.__docs.length = 0;
  sb.__images.length = 0;
  sb.__texts.length = 0;
  // The renderer measures the stamp before placing it, so it is a promise.
  await vm.runInContext('generatePurchaseOrderPDF(' + JSON.stringify(order) + ',' + JSON.stringify(items) + ', "save")', sb);
  const doc = sb.__docs[sb.__docs.length - 1];
  const buf = Buffer.from(doc.output('arraybuffer'));
  return { text: pdfText(buf), pages: doc.internal.getNumberOfPages(), images: sb.__images.slice(),
    texts: sb.__texts.slice(), buf };
}

// ── the records, exactly as the API returns them ──────────────────────
const r2 = n => Number(Math.round(Number(n + 'e2')) + 'e-2');
const line = (n, name, hsn, qty, rate, pct, unit) => {
  const taxable = r2(qty * rate);
  const tax = r2(taxable * pct / 100);
  return { id: 'i' + n, product_name: name, hsn_code: hsn, unit: unit || 'PCS',
    quantity: qty + '.000', rate: rate + '.00', gst_percentage: pct + '.00',
    taxable_value: taxable.toFixed(2), gst_amount: tax.toFixed(2),
    total_amount: r2(taxable + tax).toFixed(2), discount_percentage: '0.00' };
};
const mkOrder = (extra, items, interstate) => {
  const taxable = r2(items.reduce((s, i) => s + Number(i.taxable_value), 0));
  const tax = r2(items.reduce((s, i) => s + Number(i.gst_amount), 0));
  return Object.assign({
    id: 'po1', document_number: 'PO/2026/09/0005', document_date: '2026-09-09',
    status: 'CONFIRMED', vendor_name: 'Kookmate India', vendor_gstin: '33AAACK1234C1Z9',
    phone: '99990 00011', address: '9/83 E, 4th Street, Ganapathy Pudur, Coimbatore - 641006',
    state: 'Tamil Nadu', district: 'Coimbatore',
    purchase_representative: 'Jegatheswar', logistics_mode: 'By Transport',
    payment_terms: '100% Advance', expected_delivery_date: '2026-09-16',
    delivery_address: 'VTECH Warehouse, Ganapathy Pudur', delivery_state: 'Tamil Nadu',
    delivery_district: 'Coimbatore', supply_type: interstate ? 'interstate' : 'intrastate',
    taxable_amount: taxable.toFixed(2), gst_percentage: '18.00', gst_amount: tax.toFixed(2),
    igst: interstate ? tax.toFixed(2) : '0.00',
    cgst: interstate ? '0.00' : r2(tax / 2).toFixed(2),
    sgst: interstate ? '0.00' : r2(tax / 2).toFixed(2),
    cess_amount: '0.00', total_amount: r2(taxable + tax).toFixed(2), terms: null
  }, extra || {});
};
const ONE = [line(1, 'Steamer 12 tray with timer - Electrical', '84198190', 5, 62500, 18)];
const MANY = [
  line(1, 'Steamer 12 tray with timer - Electrical', '84198190', 5, 62500, 18),
  line(2, 'Chapathi Press Machine 8 Inch', '84388090', 2, 27000, 18),
  line(3, 'Coconut Scraper Machine', '85094010', 4, 3000, 18, 'NOS')
];

// ══════════════════════════════════════════════════════════════════════
//  The document
// ══════════════════════════════════════════════════════════════════════

renderTest('O1 a one-item order carries the whole company letterhead and the order facts', async () => {
  const { text } = await render(mkOrder({}, ONE), ONE);
  for (const s of ['VTECH KITCHEN EQUIPMENTS', '9/83 E, 4th Street Extension, T Balan Nagar',
    'Coimbatore, Tamil Nadu', 'GSTIN: 33AAAAA0000A1Z5', 'PAN: AAAAA0000A',
    'PURCHASE ORDER', 'PO No: PO/2026/09/0005', 'Order Date: 09-09-2026', 'CONFIRMED',
    'SUPPLIER DETAILS', 'DELIVER TO', 'Kookmate India', 'GSTIN: 33AAACK1234C1Z9',
    'EXPECTED DELIVERY', '16-09-2026', 'REPRESENTATIVE', 'Jegatheswar',
    'LOGISTICS', 'By Transport', 'PAYMENT TERMS', '100% Advance']) {
    assert.ok(text.includes(s), 'missing from the PDF: ' + s);
  }
});

renderTest('O2 the item table prints every stored column of every line', async () => {
  const { text } = await render(mkOrder({}, MANY), MANY);
  for (const s of ['DESCRIPTION', 'HSN/SAC', 'QTY', 'UNIT', 'UNIT PRICE', 'GST %', 'TAX', 'AMOUNT']) {
    assert.ok(text.includes(s), 'missing column head: ' + s);
  }
  // line 1: 5 x 62,500 at 18% = 3,12,500 taxable and 56,250 tax
  for (const s of ['Steamer 12 tray with timer - Electrical', '84198190', '5', 'PCS',
    '62,500.00', '18%', '56,250.00', '3,12,500.00']) {
    assert.ok(text.includes(s), 'missing line value: ' + s);
  }
  for (const s of ['Chapathi Press Machine 8 Inch', '84388090', 'Coconut Scraper Machine', '85094010', 'NOS']) {
    assert.ok(text.includes(s), 'missing line value: ' + s);
  }
});

renderTest('O3 an intra-state order prints CGST and SGST, and no IGST row', async () => {
  const order = mkOrder({}, MANY);
  const { text } = await render(order, MANY);
  assert.ok(text.includes('Untaxed Amount'));
  assert.ok(text.includes('CGST') && text.includes('SGST'), 'CGST/SGST must be printed');
  assert.ok(!/\bIGST\b/.test(text), 'an intra-state order must not carry an IGST row');
  // the stored figures, not recomputed ones
  assert.ok(text.includes(Number(order.taxable_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })));
  assert.ok(text.includes(Number(order.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })));
  assert.ok(text.includes('TOTAL PO VALUE'));
});

renderTest('O4 an inter-state order prints IGST alone', async () => {
  const order = mkOrder({ state: 'Karnataka', vendor_gstin: '29AAACK1234C1Z9' }, MANY, true);
  const { text } = await render(order, MANY);
  assert.ok(text.includes('IGST'), 'IGST must be printed');
  assert.ok(!/\bCGST\b/.test(text) && !/\bSGST\b/.test(text), 'no CGST/SGST on an inter-state order');
  assert.ok(text.includes(Number(order.igst).toLocaleString('en-IN', { minimumFractionDigits: 2 })));
});

renderTest('O5 the amount in words comes from the shared helper, on the stored total', async () => {
  const order = mkOrder({}, ONE);
  const { text } = await render(order, ONE);
  assert.ok(text.includes('AMOUNT IN WORDS'));
  // 3,68,750 -> the app's own numberToWordsINR wording
  assert.ok(text.includes('Three Lakh Sixty Eight Thousand Seven Hundred and Fifty Rupees Only'),
    'the words must match numberToWordsINR for the stored total');
});

renderTest('O6 a long supplier address and a long description wrap instead of clipping', async () => {
  const longVendor = {
    vendor_name: 'Sri Venkateswara Industrial Kitchen Equipments and Allied Services Private Limited',
    address: 'Plot No. 165, Jagananna Mega Industrial Hub, Kopparty (V), Chintha Komma Dinne (M), Kadapa District, Andhra Pradesh - 516003',
    state: 'Andhra Pradesh', district: 'Kadapa'
  };
  const { text } = await render(mkOrder(longVendor, MANY), MANY);
  assert.ok(text.includes('Sri Venkateswara Industrial Kitchen'), 'the long supplier name must appear');
  assert.ok(text.includes('Jagananna Mega Industrial'), 'the long address must appear');

  const longItems = [line(1, 'PTFE non-stick chapati machine plate assembly with reinforced edge banding and heat-resistant coating for continuous commercial duty', '84389090', 3, 4500, 18)];
  const t2 = (await render(mkOrder({}, longItems), longItems)).text;
  assert.ok(t2.includes('PTFE non-stick chapati machine'), 'the long description must appear');
  assert.ok(t2.includes('84389090'));
});

renderTest('O7 a long order runs onto more pages, with the head repeated and one set of closing blocks', async () => {
  const lots = Array.from({ length: 28 }, (_, i) =>
    line(i + 1, `Commercial Kitchen Component Model CK-${100 + i}`, '84198190', (i % 5) + 1, 1500 + i * 250, 18));
  const { text, pages } = await render(mkOrder({ status: 'PARTIALLY_RECEIVED' }, lots), lots);
  assert.ok(pages >= 2, 'twenty-eight lines must not fit on one page');
  const count = (s, n) => s.split(n).length - 1;
  assert.ok(count(text, 'DESCRIPTION') >= 2, 'the item head repeats on every page');
  assert.strictEqual(count(text, 'TOTAL PO VALUE'), 1, 'the totals are drawn once');
  assert.strictEqual(count(text, "SUPPLIER'S AUTHORIZED SIGNATORY"), 1, 'the signatures are drawn once');
  assert.strictEqual(count(text, 'Page 1 of ' + pages), 1, 'every page is numbered');
  assert.ok(text.includes('Page ' + pages + ' of ' + pages));
  assert.ok(text.includes('PARTIALLY RECEIVED'), 'the stored status prints as a badge');
});

renderTest('O8 the seal and the signature are the profile images, at a sensible size', async () => {
  const { images, texts } = await render(mkOrder({}, ONE), ONE);
  assert.ok(images.length >= 2, 'the seal and signature must be drawn');
  for (const im of images) {
    assert.ok(im.w <= 34 && im.h <= 24, `an image is oversized: ${im.w}x${im.h}mm`);
    assert.ok(im.x >= 0 && im.x + im.w <= 210, 'an image runs off the page');
    assert.ok(im.y + im.h <= 297 - 11, 'an image overlaps the footer');
  }
  // The marks must finish above the caption, not print on top of it - the
  // signature block's own geometry, checked rather than assumed.
  const caption = texts.find(t => t.s === 'Authorized Signatory');
  assert.ok(caption, 'the approval caption must be drawn');
  const marks = images.filter(im => im.page === caption.page);
  assert.ok(marks.length >= 2, 'the seal and signature belong on the caption\'s page');
  for (const im of marks) {
    assert.ok(im.y + im.h <= caption.y - 1,
      `a mark overlaps the caption: mark ends ${im.y + im.h}mm, caption baseline ${caption.y}mm`);
  }
  const supplierLabels = texts.filter(t => ['Name:', 'Date:', 'Signature:'].includes(t.s));
  assert.strictEqual(supplierLabels.length, 3, 'the supplier signing area keeps its three lines');
  for (const l of supplierLabels) assert.ok(l.y <= 297 - 16, 'a signing line runs under the footer');

  const { text } = await render(mkOrder({}, ONE), ONE);
  assert.ok(text.includes('For VTECH KITCHEN EQUIPMENTS'));
  assert.ok(text.includes('Authorized Signatory'));
  assert.ok(text.includes("SUPPLIER'S AUTHORIZED SIGNATORY"));
  assert.ok(text.includes('APPROVED BY'));
});

// The approval block's own geometry: the panel is the right-hand half of
// the page between the margins, so its centre is fixed by the page.
const APPROVAL_CENTRE = (() => {
  const M = 12, R = 210 - 12, gap = 6;
  const w = (R - M - gap) / 2;
  return M + w + gap + w / 2;          // 153mm
})();

renderTest('O16 the marks are centred as one group, stamp then signature, never touching', async () => {
  const { images, texts } = await render(mkOrder({}, ONE), ONE);
  const caption = texts.find(t => t.s === 'Authorized Signatory');
  const forLine = texts.find(t => /^For /.test(t.s));
  assert.ok(caption && forLine, 'the approval caption and company line must be drawn');

  // Both lines are centred on the panel.
  assert.ok(Math.abs(caption.x - APPROVAL_CENTRE) < 0.01,
    `the caption is at ${caption.x}mm, not the panel centre ${APPROVAL_CENTRE}mm`);
  assert.ok(Math.abs(forLine.x - APPROVAL_CENTRE) < 0.01,
    `the company line is at ${forLine.x}mm, not the panel centre ${APPROVAL_CENTRE}mm`);

  // Only the marks inside the approval panel - the letterhead logo is an
  // image too, and it sits at the left margin at the top of the page.
  const marks = images.filter(im => im.page === caption.page && im.x >= 108 && im.x + im.w <= 198)
    .sort((a, b) => a.x - b.x);
  assert.strictEqual(marks.length, 2, 'the seal and the signature are both drawn');
  const [seal, sign] = marks;              // left to right: the stamp, then the signature

  // These fixtures carry no measurable ink, so the drawn rectangle IS the
  // mark. O17 covers the measured-ink path that real assets take.
  assert.ok(seal.w >= sign.w, 'the stamp must be the left-hand mark, not the signature');
  assert.ok(seal.w >= 14, `the stamp is only ${seal.w}mm across - it must stay clearly visible`);
  assert.ok(sign.w >= 8, `the signature is only ${sign.w}mm across - it must not shrink to a dash`);

  // Side by side with air between them: neither stacked nor adrift.
  const gap = sign.x - (seal.x + seal.w);
  assert.ok(gap > 0, `the marks overlap by ${(-gap).toFixed(2)}mm - they must stand apart`);
  assert.ok(gap <= 8, `the gap is ${gap.toFixed(2)}mm - the pair must read as one group`);

  const gL = seal.x, gR = sign.x + sign.w;
  assert.ok(Math.abs((gL + gR) / 2 - APPROVAL_CENTRE) < 0.05,
    `the group is centred on ${((gL + gR) / 2).toFixed(2)}mm, not the panel centre ${APPROVAL_CENTRE}mm`);
  assert.ok(gL > 108 + 10, 'the stamp is pushed to the left edge of the panel');
  assert.ok(gR < 198 - 10, 'the signature is pushed to the right edge of the panel');
  assert.ok(gR - gL <= 60, 'the pair is stretched across the panel');

  // One centre line, and both clear of the rule and the caption beneath.
  assert.ok(Math.abs((seal.y + seal.h / 2) - (sign.y + sign.h / 2)) < 0.5,
    'the marks do not share a centre line');
  for (const im of marks) {
    assert.ok(im.y + im.h <= caption.y - 1, 'a mark runs into the caption');
    assert.ok(im.x >= 108 && im.x + im.w <= 198, 'a mark leaves the approval panel');
  }
});

// The browser always measures the assets. A real stamp is a circle on a
// transparent square, so the file's edges and its ink are two different
// boxes: what must be centred, and what must keep its gap, is the ink. The
// drawn rectangles legitimately overlap once the margin is counted, which is
// why nothing here trusts them.
renderTest('O17 the group is centred on the visible ink, not on the image files', async () => {
  const ink = {};
  ink[PNG_A] = { x: 0.10, y: 0.20, w: 0.60, h: 0.50, imgW: 600, imgH: 600 };
  ink[PNG_B] = { x: 0.05, y: 0.30, w: 0.90, h: 0.40, imgW: 900, imgH: 400 };
  const { images, texts } = await render(mkOrder({}, ONE), ONE, undefined, ink);
  const caption = texts.find(t => t.s === 'Authorized Signatory');
  assert.ok(caption, 'the approval caption must be drawn');

  const marks = images.filter(im => im.page === caption.page && im.x >= 100 && im.x + im.w <= 200)
    .sort((a, b) => a.x - b.x);
  assert.strictEqual(marks.length, 2, 'the seal and the signature are both drawn');
  const bounds = [ink[PNG_A], ink[PNG_B]];        // the stamp is the left-hand mark
  const inked = marks.map((m, i) => ({
    x: m.x + bounds[i].x * m.w, w: bounds[i].w * m.w,
    y: m.y + bounds[i].y * m.h, h: bounds[i].h * m.h
  }));
  const [s1, s2] = inked;

  const gap = s2.x - (s1.x + s1.w);
  assert.ok(gap > 0, `the visible marks overlap by ${(-gap).toFixed(2)}mm`);
  assert.ok(gap <= 8, `the visible gap is ${gap.toFixed(2)}mm - the pair must read as one group`);
  const gL = s1.x, gR = s2.x + s2.w;
  assert.ok(Math.abs((gL + gR) / 2 - APPROVAL_CENTRE) < 0.05,
    `the ink is centred on ${((gL + gR) / 2).toFixed(2)}mm, not the panel centre ${APPROVAL_CENTRE}mm`);
  assert.ok(s1.w >= 14, `the stamp's ink is only ${s1.w.toFixed(2)}mm across`);
  assert.ok(s2.w >= 8, `the signature's ink is only ${s2.w.toFixed(2)}mm across`);
  assert.ok(Math.abs((s1.y + s1.h / 2) - (s2.y + s2.h / 2)) < 0.5,
    'the visible marks do not share a centre line');
  assert.ok(gL > 108 + 8 && gR < 198 - 8, 'the ink group is pushed against a panel edge');
  for (const m of inked) {
    assert.ok(m.y + m.h <= caption.y - 1, 'a visible mark runs into the caption');
  }
});

// A purchase order is issued TO a supplier. Our own bank details have no
// business on it, so they are not printed even when the profile carries
// them - which is what the fixture PROFILE does.
renderTest('O9 a purchase order carries no bank details, whatever the profile holds', async () => {
  const withBank = (await render(mkOrder({}, ONE), ONE)).text;
  assert.ok(!withBank.includes('BANK DETAILS'), 'the bank block must not print');
  assert.ok(!withBank.includes('BARB0GANAPA'), 'nor the IFSC behind it');
  assert.ok(!withBank.includes('1234567890123'), 'nor the account number');
  assert.ok(withBank.includes('AMOUNT IN WORDS'), 'the amount in words stays');
  assert.ok(withBank.includes('TOTAL PO VALUE'), 'and the totals block');
  const bare = (await render(mkOrder({}, ONE), ONE, { business_name: 'VTECH KITCHEN EQUIPMENTS' })).text;
  assert.ok(!bare.includes('BANK DETAILS'));
  assert.ok(bare.includes('VTECH KITCHEN EQUIPMENTS'), 'the letterhead still prints');
});

renderTest('O10 terms come from the order, then the profile, then the standard wording', async () => {
  const own = (await render(mkOrder({ terms: 'Inspection at our works before dispatch.' }, ONE), ONE)).text;
  assert.ok(own.includes('TERMS & CONDITIONS'));
  assert.ok(own.includes('Inspection at our works before dispatch.'));
  assert.ok(!own.includes('Standard purchase order terms'), 'saved terms are not labelled standard');

  const saved = (await render(mkOrder({}, ONE), ONE,
    Object.assign({}, PROFILE, { terms_conditions: 'Company terms: payment 30 days from invoice.' }))).text;
  assert.ok(saved.includes('Company terms: payment 30 days from invoice.'));

  // The standard set is laid out two to a row, so each entry is wrapped in
  // the PDF and is matched here on the part that stays on one line.
  const fallback = (await render(mkOrder({}, ONE), ONE)).text;
  assert.ok(fallback.includes('Standard purchase order terms'), 'the default set is labelled as standard');
  // The six approved clauses, each a numbered heading with its wording. They
  // wrap, so each is matched on the part that stays on one line.
  for (const lead of ['1. Delivery:', '2. Inspection & Acceptance:', '3. Price:',
    '4. Order Amendment:', '5. Invoice & Delivery Documents:', '6. Order Acknowledgement:']) {
    assert.ok(fallback.includes(lead), 'missing clause heading: ' + lead);
  }
  assert.ok(fallback.includes('Material shall be dispatched within the agreed delivery period'));
  assert.ok(fallback.includes('All materials are subject to inspection and acceptance'));
  assert.ok(fallback.includes('supplier at no additional cost'));
  assert.ok(fallback.includes('firm and fixed until completion of the'));
  assert.ok(fallback.includes('shall be valid only with written approval from both parties'));
  assert.ok(fallback.includes('Purchase Order Number on the invoice'));
  assert.ok(fallback.includes('shall be deemed accepted'));
  // Reusable wording only: no party, address, GSTIN or phone number INSIDE
  // the clauses. Scoped to the terms block on purpose - the letterhead and
  // the supplier panel carry real GSTINs, and checking the whole document
  // would both fail on those and mask a genuine leak in a clause.
  const termsStart = fallback.indexOf('1. Delivery:');
  const termsEnd = fallback.indexOf("SUPPLIER'S AUTHORIZED SIGNATORY");
  assert.ok(termsStart > -1 && termsEnd > termsStart, 'the terms block must be locatable');
  const termsOnly = fallback.slice(termsStart, termsEnd);
  for (const leak of ['Triovision', 'GSTIN', 'Mobile Number', 'Kadapa', '9550896635',
    '33AAAAA0000A1Z5', '33AAACK1234C1Z9']) {
    assert.ok(!termsOnly.includes(leak), 'the standard terms must stay generic: ' + leak);
  }
  assert.ok(!/7\.\s|8\.\s|9\.\s|10\.\s/.test(fallback.slice(fallback.indexOf('1. Delivery:'))),
    'exactly six clauses, not the old ten');
});

renderTest('O11 the footer names the order and numbers every page', async () => {
  const { text, pages } = await render(mkOrder({}, ONE), ONE);
  assert.ok(text.includes('Purchase Order No. PO/2026/09/0005'));
  assert.ok(text.includes('Page 1 of ' + pages));
  assert.ok(text.includes('www.vtech.test'), 'the footer carries the saved contact line');
});

// ══════════════════════════════════════════════════════════════════════
//  The rules the redesign must not break
// ══════════════════════════════════════════════════════════════════════

test('O12 the renderer reads the profile the rest of the app already caches', () => {
  assert.match(POPDF, /getCachedProfile\(\)/, 'the saved profile is the source of the letterhead');
  assert.ok(!/function (hexToRgb|wrapLines|imageUrlToDataUrl|bankDetailLines|numberToWordsINR|formatNum)\b/.test(POPDF),
    'shared helpers must not be redefined here');
  assert.match(POPDF, /numberToWordsINR\(order\.total_amount\)/, 'the existing words helper is reused');
});

test('O13 it still derives nothing: no tax and no line amount is recomputed', () => {
  assert.equal(/gst_percentage\s*[*/]|[*/]\s*.*gst_percentage|\* 0\.18/.test(POPDF), false,
    'the PDF must not recompute tax from a rate');
  assert.equal(/taxable_value\s*\*|rate\s*\*\s*quantity/.test(POPDF), false, 'nor recompute a line amount');
  assert.match(POPDF, /poPdfMoney\(order\.taxable_amount\)/);
  assert.match(POPDF, /poPdfMoney\(order\.total_amount\)/);
});

test('O14 both purchase order pages load the new renderer', () => {
  for (const html of [PO_LIST_HTML, PO_ENTRY_HTML]) {
    assert.match(html, /client\/js\/pages\/purchase-order-pdf\.js\?v=3/, 'the cache key must be bumped');
    assert.ok(html.includes('jspdf.plugin.autotable'), 'autoTable is required by the item table');
    // The stamp is measured with invoice-pdf.js's helpers, so that file has
    // to be loaded first - reused, never copied into this renderer.
    assert.ok(html.includes('client/js/pages/invoice-pdf.js'), 'invoice-pdf.js must be loaded');
    assert.ok(html.indexOf('invoice-pdf.js') < html.indexOf('purchase-order-pdf.js'),
      'invoice-pdf.js must come before purchase-order-pdf.js');
  }
});

test('O15 no other PDF module was touched', () => {
  const { execSync } = require('child_process');
  const changed = execSync('git status --porcelain -- client/js/pages/invoice-pdf.js '
    + 'client/js/pages/proforma-pdf.js client/js/pages/sales-return-pdf.js '
    + 'client/js/pages/cdnote-pdf.js', { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', 'the other PDF modules must be untouched');
});
