// Credit / Debit Note PDF.
//
// A note is a tax document a customer receives, so the one thing that must
// never happen is a printed figure that disagrees with the stored record.
// Every case below builds a REAL PDF with jsPDF and reads the text back out
// of it — nothing is asserted from the source alone.
//
// The other half is the boundary: a note belonging to another tenant, or
// one that has been deleted, must not be downloadable at all. That half
// needs the API and is skipped unless STOCK_TEST_DATABASE_URL names a
// DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CDPDF = rd('client', 'js', 'pages', 'cdnote-pdf.js');
const CDPAGE = rd('client', 'js', 'pages', 'cdnotes.js');
const CDHTML = rd('cdnotes.html');

// ── A browser-shaped sandbox with the real jsPDF in it ────────────────
const noop = () => {};
const mkEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop,
  getContext: () => null, toDataURL: () => '' });

// jsPDF is a CDN script in the browser, not a server dependency, so the
// render cases need a copy of it to exist somewhere. They run when one
// does — node_modules if it is ever installed, or JSPDF_PATH — and skip
// with a reason when it does not, rather than failing over a library the
// application never asks the server for.
const JSPDF_FILE = (() => {
  const candidates = [
    process.env.JSPDF_PATH,
    path.join(__dirname, '..', 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js')
  ].filter(Boolean);
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
})();
const NO_JSPDF = { skip: 'jsPDF is not available — set JSPDF_PATH to the umd build to run the render cases' };
const renderTest = (name, fn) => (JSPDF_FILE ? test(name, fn) : test(name, NO_JSPDF, () => {}));

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
    __toasts: []
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);

  // The real library, the same 2.5.1 build the pages load from the CDN.
  vm.runInContext(fs.readFileSync(JSPDF_FILE, 'utf8'), sb, { filename: 'jspdf.umd.min.js' });

  vm.runInContext(rd('client', 'js', 'utilities', 'utils.js'), sb, { filename: 'utils.js' });
  // Only the shared PDF helpers are needed; the rest of invoice-pdf.js
  // loads harmlessly beside them, exactly as it does in the browser.
  vm.runInContext(rd('client', 'js', 'pages', 'invoice-pdf.js'), sb, { filename: 'invoice-pdf.js' });
  vm.runInContext(CDPDF, sb, { filename: 'cdnote-pdf.js' });
  vm.runInContext(`
    showToast = function (m, k) { __toasts.push({ m: m, k: k }); };
    handleApiError = function () {};
    getCachedProfile = function () { return ${JSON.stringify(profile || {})}; };
    generateQRDataUrl = async function () { return null; };
    imageUrlToDataUrl = async function () { return null; };
  `, sb);
  return sb;
}

// Pull the readable text out of a finished PDF. jsPDF compresses its
// content streams, so each one is inflated before being searched - a
// substring check against the raw bytes would silently pass on nothing.
function pdfText(buf) {
  const out = [];
  const raw = buf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1], 'latin1');
    let text = null;
    try { text = zlib.inflateSync(chunk).toString('latin1'); }
    catch { try { text = zlib.inflateRawSync(chunk).toString('latin1'); } catch { text = chunk.toString('latin1'); } }
    out.push(text);
  }
  // Text in a PDF content stream sits inside (...) before a Tj/TJ operator.
  const shown = [];
  for (const s of out) {
    const tr = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let t;
    while ((t = tr.exec(s)) !== null) {
      shown.push(t[1].replace(/\\([()\\])/g, '$1'));
    }
  }
  return shown.join('\n');
}

const PROFILE = {
  business_name: 'VTECH KITCHEN EQUIPMENTS', address: '12 Anna Salai, Chennai',
  state: 'Tamil Nadu', gstin: '33AABCU9603R1ZX', pan: 'AABCU9603R',
  email: 'sales@vtech.test', phone: '9840000000', header_color: '#004D40'
};

// The record from the screenshot: DEBIT note 5, 96000 taxable at 18%
// intra-state, so 8640 + 8640 and a total of 113280.
const DEBIT = {
  id: 'n1', note_type: 'debit', note_number: '5', note_date: '2026-09-09',
  original_invoice: '3236', original_invoice_date: '2026-07-09',
  customer_name: 'Mega Kitchen System Pvt Ltd', gstin: '33AAACI1681G1ZP',
  state: 'Tamil Nadu', reason: 'Price revision on supplied equipment',
  taxable_amount: '96000.00', gst_percentage: '18.00', supply_type: 'intrastate',
  igst: '0.00', cgst: '8640.00', sgst: '8640.00', cess_amount: '0.00',
  gst_amount: '17280.00', total_amount: '113280.00'
};

const CREDIT = {
  id: 'n2', note_type: 'credit', note_number: 'CN-005', note_date: '2026-08-14',
  original_invoice: 'INV-1042', original_invoice_date: null,
  customer_name: 'Sri Balaji Caterers', gstin: '29AAACI1681G1ZL',
  state: 'Karnataka', reason: 'Goods returned - damaged in transit',
  taxable_amount: '20000.00', gst_percentage: '18.00', supply_type: 'interstate',
  igst: '3600.00', cgst: '0.00', sgst: '0.00', cess_amount: '0.00',
  gst_amount: '3600.00', total_amount: '23600.00'
};

async function render(note, profile) {
  const sb = load(profile || PROFILE);
  const doc = await sb.buildCDNotePDFDoc(note);
  const buf = Buffer.from(doc.output('arraybuffer'));
  return { sb, doc, buf, text: pdfText(buf) };
}

// ═══ 1-2, 10: both kinds render, and say which they are ═══════════════

renderTest('C1 a DEBIT note renders a valid PDF titled DEBIT NOTE', async () => {
  const { buf, text } = await render(DEBIT);
  assert.strictEqual(buf.subarray(0, 5).toString('latin1'), '%PDF-', 'must be a real PDF');
  assert.ok(buf.length > 3000, 'a one-page note is a few kB, not empty');
  assert.match(text, /DEBIT NOTE/);
  assert.ok(!/CREDIT NOTE/.test(text), 'a debit note must not also call itself a credit note');
  assert.match(text, /Total Debit Amount/);
  assert.match(text, /Additional amount payable/);
});

renderTest('C2 a CREDIT note renders a valid PDF titled CREDIT NOTE', async () => {
  const { buf, text } = await render(CREDIT);
  assert.strictEqual(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(text, /CREDIT NOTE/);
  assert.ok(!/DEBIT NOTE/.test(text));
  assert.match(text, /Total Credit Amount/);
  assert.match(text, /Amount credited to your account/);
});

// ═══ 3-9: every figure is the one that is stored ══════════════════════

renderTest('C3 MANDATORY the screenshot record prints exactly its stored values', async () => {
  const { text } = await render(DEBIT);

  assert.match(text, /Note No: 5/, 'note number');
  assert.match(text, /Mega Kitchen System Pvt Ltd/, 'customer');
  assert.match(text, /33AAACI1681G1ZP/, 'customer GSTIN');
  assert.match(text, /Tamil Nadu/, 'customer state');
  assert.match(text, /Original Invoice: 3236/, 'original invoice');
  assert.match(text, /Price revision on supplied equipment/, 'reason');

  // The money, formatted the way the rest of the app formats money.
  assert.match(text, /96,000\.00/, 'taxable 96000');
  assert.match(text, /18%/, 'GST rate');
  assert.ok((text.match(/8,640\.00/g) || []).length === 2, 'CGST and SGST, once each');
  assert.match(text, /17,280\.00/, 'total GST');
  assert.match(text, /1,13,280\.00/, 'total 113280');

  // Intra-state, so no IGST row at all.
  assert.ok(!/IGST/.test(text), 'an intra-state note must not print an IGST line');
});

renderTest('C4 an inter-state note prints IGST and no CGST/SGST', async () => {
  const { text } = await render(CREDIT);
  assert.match(text, /IGST \(18%\)/);
  assert.match(text, /3,600\.00/);
  assert.match(text, /20,000\.00/);
  assert.match(text, /23,600\.00/);
  assert.ok(!/CGST/.test(text), 'no CGST on an inter-state note');
  assert.ok(!/SGST/.test(text), 'no SGST on an inter-state note');
});

renderTest('C5 the rate is split for display but never recomputed', async () => {
  const { text } = await render(DEBIT);
  // 18% intra-state shows as 9% + 9%, which is presentation only - the
  // AMOUNTS are the stored ones, and nothing here derives them.
  assert.match(text, /CGST \(9%\)/);
  assert.match(text, /SGST \(9%\)/);
  const fn = CDPDF.replace(/\/\/[^\n]*/g, '');
  for (const bad of ['taxable_amount *', 'taxable_amount /', '* 0.18', '/ 2 *']) {
    assert.ok(!fn.includes(bad), 'the PDF must not compute tax: found "' + bad + '"');
  }
  assert.ok(!/calcGST/.test(fn), 'the note PDF must not run the GST engine');
});

renderTest('C6 amount in words comes from the stored total', async () => {
  const { sb, text } = await render(DEBIT);
  const words = sb.numberToWordsINR(113280);
  assert.ok(words && words.length > 5);
  assert.match(text, /Amount in Words/);
  // The first distinctive word of the phrase must appear in the document.
  assert.ok(text.includes(words.split(' ')[0]), 'the words must be the stored total\'s');
});

renderTest('C7 the company letterhead and signatory block are present', async () => {
  const { text } = await render(DEBIT);
  assert.match(text, /VTECH KITCHEN EQUIPMENTS/, 'company name');
  assert.match(text, /33AABCU9603R1ZX/, 'company GSTIN');
  assert.match(text, /Authorized Signatory/);
  assert.match(text, /computer-generated Debit Note/);
  assert.match(text, /Page 1 of 1/);
});

renderTest('C8 optional fields are omitted, not printed empty', async () => {
  // CREDIT has no original_invoice_date and no cess.
  const { text } = await render(CREDIT);
  assert.ok(!/Invoice Date:/.test(text), 'an absent invoice date must not print a bare label');
  assert.ok(!/Compensation Cess/.test(text), 'zero cess prints no cess row');

  // A note with no reason prints no REASON heading.
  const noReason = { ...CREDIT, reason: null };
  const out = await render(noReason);
  assert.ok(!/REASON/.test(out.text));
});

// ═══ 11: the filename ═════════════════════════════════════════════════

renderTest('C9 the filename names the kind and the note number', async () => {
  const sb = load(PROFILE);
  assert.strictEqual(sb.cdNoteFileName(DEBIT), 'Debit-Note-5');
  assert.strictEqual(sb.cdNoteFileName(CREDIT), 'Credit-Note-CN-005');
  // A number carrying characters a filesystem dislikes is made safe
  // without losing the number itself.
  assert.strictEqual(sb.cdNoteFileName({ note_type: 'credit', note_number: 'CN/2026/07' }),
    'Credit-Note-CN-2026-07');
  assert.strictEqual(sb.cdNoteFileName({ note_type: 'debit', note_number: '' }), 'Debit-Note-note');
});

// ═══ 12: an edited note prints its latest values ══════════════════════

renderTest('C10 an edited note prints the new figures, never the old', async () => {
  const before = await render(DEBIT);
  assert.match(before.text, /96,000\.00/);

  // The same note after an edit: the record is re-read for every download,
  // so the document follows the record.
  const edited = { ...DEBIT, taxable_amount: '50000.00', gst_amount: '9000.00',
    cgst: '4500.00', sgst: '4500.00', total_amount: '59000.00' };
  const after = await render(edited);
  assert.match(after.text, /50,000\.00/);
  assert.match(after.text, /59,000\.00/);
  assert.ok(!/96,000\.00/.test(after.text), 'the old taxable amount must be gone');
  assert.ok(!/1,13,280\.00/.test(after.text), 'the old total must be gone');

  // ...and the download path re-fetches rather than drawing from a cache.
  const dl = CDPDF.slice(CDPDF.indexOf('async function downloadCDNotePDF'),
    CDPDF.indexOf('async function buildCDNotePDFDoc'));
  assert.match(dl, /await fetchCDNoteRecord\(id\)/);
});

// ═══ The button, and what it must not do ═════════════════════════════

test('C11 the Records table offers Download PDF beside Edit and Delete', async () => {
  assert.match(CDPAGE, /onclick="downloadCDNotePDF\('\$\{r\.id\}'\)"/);
  assert.match(CDPAGE, /title="Download PDF"/);
  assert.match(CDPAGE, /fa-file-pdf/);
  // The existing actions are untouched.
  assert.match(CDPAGE, /onclick="editCDNote\('\$\{r\.id\}'\)"/);
  assert.match(CDPAGE, /onclick="deleteCDNote\('\$\{r\.id\}'\)"/);
});

test('C12 downloading changes nothing and navigates nowhere', async () => {
  const fn = CDPDF.replace(/\/\/[^\n]*/g, '');
  for (const bad of ['.insert(', '.update(', '.delete(', 'location.href',
    'window.open', 'location.assign', 'form.submit']) {
    assert.ok(!fn.includes(bad), 'the PDF path must not ' + bad);
  }
  // It saves the file directly - no blank tab, no navigation.
  assert.match(CDPDF, /doc\.save\(cdNoteFileName\(note\) \+ '\.pdf'\)/);
});

test('C13 the page loads what the PDF needs, and reuses the shared helpers', async () => {
  for (const s of ['jspdf.umd.min.js', 'qrcode', 'client/js/pages/invoice-pdf.js',
    'client/js/pages/cdnote-pdf.js']) {
    assert.ok(CDHTML.includes(s), 'cdnotes.html must load ' + s);
  }
  // cdnote-pdf.js must come before the page that calls it.
  assert.ok(CDHTML.indexOf('cdnote-pdf.js') < CDHTML.indexOf('pages/cdnotes.js'));
  // ...and invoice-pdf.js before cdnote-pdf.js, which borrows from it.
  assert.ok(CDHTML.indexOf('invoice-pdf.js') < CDHTML.indexOf('cdnote-pdf.js'));
  // The engine is reused, not duplicated: these are defined in
  // invoice-pdf.js and must NOT be redefined here.
  for (const h of ['hexToRgb', 'wrapLines', 'imageUrlToDataUrl', 'bankDetailLines']) {
    assert.ok(!new RegExp('function ' + h + '\\b').test(CDPDF),
      h + ' must be reused from invoice-pdf.js, not redefined');
  }
});

// The Purchase Order PDF has since been redesigned under its own approved
// change, so "unmodified" is no longer the right test for that one file.
// It is pinned by content instead: Credit/Debit Note work still cannot
// touch it, and any further edit fails here until it is approved and this
// digest is updated deliberately. The rest stay pinned to untouched.
const APPROVED_PO_PDF_SHA256 = '002752cdf0deaf798d9359e60be493d7b24eb612b80c702ec26665ae94fa78a4';

test('C14 no other PDF module was modified', async () => {
  const { execSync } = require('child_process');
  const changed = execSync('git status --porcelain -- client/js/pages/invoice-pdf.js '
    + 'client/js/pages/proforma-pdf.js client/js/pages/sales-return-pdf.js',
  { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', 'the existing PDF modules must be untouched');

  // Line endings differ between checkouts; the content does not.
  const po = require('crypto').createHash('sha256')
    .update(rd('client', 'js', 'pages', 'purchase-order-pdf.js').replace(/\r\n/g, '\n')).digest('hex');
  assert.strictEqual(po, APPROVED_PO_PDF_SHA256,
    'purchase-order-pdf.js is not the approved Purchase Order redesign - Credit/Debit Note work must not '
    + 'modify it, and any further Purchase Order change needs its own approval and this digest updated');
});

// ═══════════════════════════════════════════════════════════════════════
//  The boundary: whose note can be downloaded at all
// ═══════════════════════════════════════════════════════════════════════

// ═══ The seal / signature block is the Tax Invoice's ══════════════════
//
// A note is signed exactly as an invoice is. These pin the note's block to
// the formula drawSignatureBlock() uses in invoice-pdf.js, so if either one
// is changed without the other, this fails rather than the two documents
// quietly drifting apart.

test('C20 the note uses the invoice\'s signature geometry, and its helpers', async () => {
  const INV = rd('client', 'js', 'pages', 'invoice-pdf.js');
  const code = CDPDF.replace(/\/\/[^\n]*/g, '');
  // The reference, as it stands in the invoice renderer.
  assert.match(INV, /const L = 8, R = pw - 8;/, 'the invoice right edge this block is placed against');
  assert.match(INV, /const SEAL = 26;/);
  assert.match(INV, /const sealCx = R - 5 - SEAL \/ 2;/);
  // ...and the same numbers in the note, against that same edge.
  assert.match(code, /const SIG_R = pw - 8;/);
  assert.match(code, /const SEAL = 26;/);
  assert.match(code, /const sealCx = SIG_R - 5 - SEAL \/ 2;/);
  assert.match(code, /doc\.text\('For ' \+ \(p\?\.business_name \|\| 'Us'\), sealCx, sealTop - 1\.8, \{ align: 'center' \}\);/);
  assert.match(code, /doc\.text\('Authorized Signatory', sealCx, authY, \{ align: 'center' \}\);/);
  // The measurement and placement are the invoice's own functions.
  assert.match(code, /inkBoundsOf\(sealData\)/);
  assert.match(code, /placeInk\(sealInk, sealWantW, sealCx, sealTop\)/);
  for (const h of ['placeInk', 'inkBoundsOf']) {
    assert.ok(!new RegExp('function ' + h + '\\b').test(CDPDF), h + ' must be reused, not redefined');
  }
  // Vertically too: the invoice hangs its signature row directly above a
  // footer measured against the same page bottom, and so must the note -
  // not draw it wherever its content happens to end.
  assert.match(INV, /const SIG_BLOCK_H = 6 \+ sealReserveH \+ 5;/);
  assert.match(INV, /const PAGE_BOTTOM = doc\.internal\.pageSize\.height - 12;/);
  assert.match(INV, /const footerH =\s*6\s[\s\S]{0,400}?\+ 4 \+ 4;/);
  assert.match(code, /const SIG_BLOCK_H = 6 \+ sealReserveH \+ 5;/);
  assert.match(code, /const PAGE_BOTTOM = doc\.internal\.pageSize\.height - 12;/);
  assert.match(code, /const footerH = 6 \+ 4 \+ 4;/);
  assert.match(code, /const sigBlockY = FOOTER_Y - SIG_ROW_H;/);
  assert.ok(!/const sigBlockY = y;/.test(code), 'the band is no longer drawn inline after the content');
  // The old right-aligned block with fixed offsets is gone.
  assert.ok(!/R - 88/.test(code) && !/R - 45/.test(code), 'no leftover fixed seal/signature offsets');
});

renderTest('C21 the rendered stamp, signature, caption and rule land where the invoice puts them', async () => {
  // A real seal and signature, with measured ink, so placement does real work.
  const SEAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const SEAL_INK = { x: 0.2, y: 0.2, w: 0.6, h: 0.6, imgW: 400, imgH: 400 };
  const SIG_INK = { x: 0.1, y: 0.3, w: 0.8, h: 0.4, imgW: 600, imgH: 200 };

  for (const note of [DEBIT, CREDIT]) {
    const sb = load({ ...PROFILE, seal_base64: 'SEAL', signature_base64: 'SIG' });
    sb.__calls = [];
    sb.__SEAL = SEAL_PNG; sb.__SIG = SIG_PNG;
    vm.runInContext(`
      imageUrlToDataUrl = async function (u) { return u === 'SEAL' ? __SEAL : u === 'SIG' ? __SIG : null; };
      inkBoundsOf = async function (d) {
        return d === __SEAL ? ${JSON.stringify(SEAL_INK)} : d === __SIG ? ${JSON.stringify(SIG_INK)} : null;
      };
      (function () {
        const Orig = window.jspdf.jsPDF;
        function Wrapped(o) {
          const d = new Orig(o);
          const t = d.text, ai = d.addImage, ln = d.line;
          d.text = function (s, x, y, opt) { __calls.push({ k: 'text', s: String(s), x, y, align: opt && opt.align }); return t.apply(d, arguments); };
          d.addImage = function (img, f, x, y, w, h) { __calls.push({ k: 'img', tag: img === __SEAL ? 'seal' : img === __SIG ? 'sig' : 'other', x, y, w, h }); return ai.apply(d, arguments); };
          d.line = function (x1, y1, x2, y2) { __calls.push({ k: 'line', x1, y1, x2, y2, lw: d.getLineWidth() }); return ln.apply(d, arguments); };
          return d;
        }
        Wrapped.API = Orig.API;
        window.jspdf.jsPDF = Wrapped;
      })();
    `, sb);

    const doc = await sb.buildCDNotePDFDoc(note);
    const pw = doc.internal.pageSize.width;
    const calls = sb.__calls;
    const forT = calls.find(c => c.k === 'text' && /^For VTECH/.test(c.s));
    const auth = calls.find(c => c.k === 'text' && c.s === 'Authorized Signatory');
    const sealImg = calls.find(c => c.k === 'img' && c.tag === 'seal');
    const sigImg = calls.find(c => c.k === 'img' && c.tag === 'sig');
    assert.ok(forT && auth && sealImg && sigImg, 'caption, signatory, seal and signature must all be drawn');

    // The invoice's formula, restated with the invoice's own placeInk.
    const SEAL = 26;
    const sealCx = (pw - 8) - 5 - SEAL / 2;
    const sealTop = forT.y + 1.8;
    const sealWantW = SEAL * SEAL_INK.w / Math.max(SEAL_INK.w, SEAL_INK.h * (SEAL_INK.imgH / SEAL_INK.imgW));
    const seal = sb.placeInk(SEAL_INK, sealWantW, sealCx, sealTop);
    let sig = sb.placeInk(SIG_INK, seal.inkW * 0.62, sealCx, 0);
    if (sig.inkH > seal.inkH * 0.5) sig = sb.placeInk(SIG_INK, seal.inkW * 0.62 * (seal.inkH * 0.5 / sig.inkH), sealCx, 0);
    sig.y = (sealTop + seal.inkH * 0.5) - SIG_INK.y * sig.h - sig.inkH / 2;
    const authY = sealTop + seal.inkH + 5;
    const authW = Math.min(22, (pw - 8) - 3 - sealCx);

    const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${note.note_type} ${what}: ${a} vs ${b}`);
    near(forT.x, sealCx, 'caption x'); assert.strictEqual(forT.align, 'center');
    near(sealImg.x, seal.x, 'seal x'); near(sealImg.y, seal.y, 'seal y');
    near(sealImg.w, seal.w, 'seal w'); near(sealImg.h, seal.h, 'seal h');
    near(sigImg.x, sig.x, 'signature x'); near(sigImg.y, sig.y, 'signature y');
    near(sigImg.w, sig.w, 'signature w'); near(sigImg.h, sig.h, 'signature h');
    near(auth.x, sealCx, 'signatory x'); near(auth.y, authY, 'signatory y');
    assert.strictEqual(auth.align, 'center');
    const rule = calls.find(c => c.k === 'line' && Math.abs(c.y1 - (authY - 3.5)) < 1e-6);
    assert.ok(rule, 'the rule above Authorized Signatory must be drawn');
    near(rule.x1, sealCx - authW, 'rule x1'); near(rule.x2, sealCx + authW, 'rule x2');
    assert.ok(Math.abs(rule.lw - 0.25) < 1e-9, 'rule drawn at the invoice\'s RULE_CELL weight');

    // Vertically the band and the footer sit where the invoice's do: the
    // invoice's footer measured against the same page bottom, and its
    // signature row hung directly above it - not wherever the content ends.
    const pageH = doc.internal.pageSize.height;
    const footerTop = (pageH - 12) - (6 + 4 + 4);
    near(forT.y, footerTop - (6 + SEAL + 5 + 3) + 6 - 1.8, 'caption height on the sheet');
    near(authY + 3, footerTop, 'signatory-to-footer gap');
    const divider = calls.find(c => c.k === 'line' && c.y1 === c.y2 && Math.abs(c.y1 - footerTop) < 1e-6);
    assert.ok(divider, 'the footer divider must sit where the invoice\'s does');
    const gen = calls.find(c => c.k === 'text' && /computer-generated/.test(c.s));
    const contact = calls.find(c => c.k === 'text' && c.s.includes('  |  '));
    const pageNo = calls.find(c => c.k === 'text' && /^Page 1 of 1$/.test(c.s));
    assert.ok(gen && contact && pageNo, 'footer lines and page number must all be drawn');
    near(gen.y, footerTop + 6, 'computer-generated line');
    near(contact.y, footerTop + 11, 'contact line');
    near(pageNo.y, pageH - 8, 'page number');
    assert.strictEqual(doc.internal.getNumberOfPages(), 1, 'a one-page note keeps its signature on that page');
  }
});

// ═══ The band's page break ═══════════════════════════════════════════
//
// The band is anchored at the foot of the page, so content long enough to
// reach it has to move it rather than be drawn over. Swept across reason
// lengths rather than one hand-picked note, so the page-break path is hit
// whatever the font metrics make of a given line.
renderTest('C22 content that reaches the band moves it to a new page, never under it', async () => {
  const QR_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const isBand = s => s === 'Scan to verify' || s === 'Authorized Signatory' || /^For VTECH/.test(s)
    || /computer-generated/.test(s) || s.includes('  |  ') || /^Page \d+ of \d+$/.test(s);
  let onePage = 0, movedAlone = 0;
  for (let reps = 0; reps <= 40; reps++) {
    const sb = load(PROFILE);
    sb.__calls = []; sb.__QR = QR_PNG;
    vm.runInContext(`
      generateQRDataUrl = async function () { return __QR; };
      (function () {
        const Orig = window.jspdf.jsPDF;
        function Wrapped(o) {
          const d = new Orig(o);
          const pg = () => d.internal.getCurrentPageInfo().pageNumber;
          const t = d.text, ai = d.addImage, ln = d.line;
          d.text = function (s, x, y) { __calls.push({ k: 'text', s: Array.isArray(s) ? s.join(' ') : String(s), y, page: pg() }); return t.apply(d, arguments); };
          d.addImage = function (img, f, x, y, w, h) { __calls.push({ k: 'img', x, y, w, h, page: pg() }); return ai.apply(d, arguments); };
          d.line = function (x1, y1, x2, y2) { __calls.push({ k: 'line', y1, y2, page: pg() }); return ln.apply(d, arguments); };
          return d;
        }
        Wrapped.API = Orig.API;
        window.jspdf.jsPDF = Wrapped;
      })();
    `, sb);
    const reason = 'Revised price for the supplied equipment as agreed. '.repeat(reps).trim() || 'Price revision';
    const doc = await sb.buildCDNotePDFDoc({ ...DEBIT, reason });
    const pageH = doc.internal.pageSize.height;
    const last = doc.internal.getNumberOfPages();
    const footerTop = (pageH - 12) - (6 + 4 + 4);
    const calls = sb.__calls;
    const tag = `(reason x${reps}, ${last} page(s))`;

    // With no seal or signature the QR column is the taller one, so the band
    // is 32mm deep and its top is where the QR is drawn.
    const qr = calls.find(c => c.k === 'img');
    assert.ok(qr, 'the QR is drawn ' + tag);
    assert.ok(Math.abs(qr.y - (footerTop - 32)) < 1e-6, 'band top ' + qr.y + ' ' + tag);
    assert.strictEqual(qr.page, last, 'the QR is on the last page ' + tag);
    for (const c of calls.filter(c => c.k === 'text' && isBand(c.s) && !/^Page /.test(c.s))) {
      assert.strictEqual(c.page, last, `"${c.s}" belongs on the last page ${tag}`);
    }
    const divider = calls.find(c => c.k === 'line' && c.page === last && c.y1 === c.y2
      && Math.abs(c.y1 - footerTop) < 1e-6);
    assert.ok(divider, 'footer divider at the invoice height ' + tag);
    const caption = calls.find(c => c.s === 'Scan to verify');
    const auth = calls.find(c => c.s === 'Authorized Signatory');
    assert.ok(caption.y < footerTop - 1 && auth.y <= footerTop - 3 + 1e-6, 'band clears the footer ' + tag);

    // Nothing of the note's own content reaches down into the band...
    const content = calls.filter(c => c.k === 'text' && !isBand(c.s));
    const intruder = content.find(c => c.page === last && c.y > qr.y);
    assert.ok(!intruder, `"${intruder && intruder.s}" at ${intruder && intruder.y} runs into the band at ${qr.y} ${tag}`);
    // ...and nothing anywhere falls off the sheet.
    assert.ok(calls.every(c => (c.y === undefined || c.y < pageH) && (c.y1 === undefined || c.y1 < pageH)),
      'drawn past the page ' + tag);

    if (last === 1) onePage++;
    if (last > 1 && !content.some(c => c.page === last)) movedAlone++;
  }
  // Both paths were actually exercised: short notes stay on one page, and a
  // note whose content reaches the band sends the band on by itself.
  assert.ok(onePage > 0, 'no sweep case stayed on one page');
  assert.ok(movedAlone > 0, 'no sweep case moved the band to a page of its own');
});

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('cdnote download boundary (skipped)', { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cdnote-pdf-test-secret';

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

let server, base, db, USER_A, TOKEN_A, USER_B, TOKEN_B, NOTE_A;

async function api(method, url, { token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { method, headers });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER_A = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('cdn-a@scratch.test','x') RETURNING id`)).rows[0].id;
  USER_B = (await db.query(
    `INSERT INTO users (email,password_hash) VALUES ('cdn-b@scratch.test','x') RETURNING id`)).rows[0].id;
  for (const u of [USER_A, USER_B]) await db.query(`INSERT INTO profiles (id,name) VALUES ($1,'Co')`, [u]);
  TOKEN_A = jwt.sign({ sub: USER_A }, process.env.JWT_SECRET, { expiresIn: '1h' });
  TOKEN_B = jwt.sign({ sub: USER_B }, process.env.JWT_SECRET, { expiresIn: '1h' });

  NOTE_A = (await db.query(
    `INSERT INTO cdn_notes (user_id, note_type, note_number, note_date, original_invoice,
       customer_name, gstin, state, reason, taxable_amount, gst_percentage, supply_type,
       igst, cgst, sgst, gst_amount, total_amount)
     VALUES ($1,'debit','5','2026-09-09','3236','Mega Kitchen System Pvt Ltd',
       '33AAACI1681G1ZP','Tamil Nadu','Price revision',96000,18,'intrastate',
       0,8640,8640,17280,113280) RETURNING id`, [USER_A])).rows[0].id;

  const port = await freePort();
  server = await startServer(port);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

test('C15 the owner can read their own note, and the figures are the stored ones', async () => {
  const r = await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}`, { token: TOKEN_A });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 1);
  const n = r.body[0];
  assert.strictEqual(Number(n.taxable_amount), 96000);
  assert.strictEqual(Number(n.cgst), 8640);
  assert.strictEqual(Number(n.sgst), 8640);
  assert.strictEqual(Number(n.total_amount), 113280);

  // ...and that record renders the document the customer receives. Only
  // this half needs jsPDF; the stored figures above are checked either way.
  if (JSPDF_FILE) {
    const { text } = await render(n);
    assert.match(text, /DEBIT NOTE/);
    assert.match(text, /1,13,280\.00/);
  }
});

test('C16 MANDATORY another tenant cannot read the note, so cannot download it', async () => {
  const r = await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}`, { token: TOKEN_B });
  assert.strictEqual(r.status, 200, 'the read succeeds but is scoped');
  assert.strictEqual(r.body.length, 0, 'B must see none of A\'s notes');

  // The browser cannot widen it: the tenant comes from the token.
  const spoof = await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}&user_id=${USER_A}`, { token: TOKEN_B });
  assert.strictEqual(spoof.body.length, 0, 'a user_id in the query string is ignored');
});

test('C17 the note read is authenticated', async () => {
  const anon = await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}`, { token: null });
  assert.strictEqual(anon.status, 401);
  const bad = await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}`, { token: 'not-a-token' });
  assert.strictEqual(bad.status, 401);
});

test('C18 a deleted note can no longer be downloaded', async () => {
  const gone = (await db.query(
    `INSERT INTO cdn_notes (user_id, note_type, note_number, note_date, customer_name,
       taxable_amount, gst_percentage, supply_type, igst, cgst, sgst, gst_amount, total_amount)
     VALUES ($1,'credit','TMP-1','2026-09-09','Temp Co',1000,18,'intrastate',0,90,90,180,1180)
     RETURNING id`, [USER_A])).rows[0].id;

  let r = await api('GET', `/api/cdn_notes?eq_id=${gone}`, { token: TOKEN_A });
  assert.strictEqual(r.body.length, 1, 'downloadable while it exists');

  await db.query('DELETE FROM cdn_notes WHERE id = $1', [gone]);

  r = await api('GET', `/api/cdn_notes?eq_id=${gone}`, { token: TOKEN_A });
  assert.strictEqual(r.body.length, 0, 'and not afterwards');
  // fetchCDNoteRecord reports that and draws nothing.
  assert.match(CDPDF, /That note no longer exists/);
  assert.match(CDPDF, /if \(!note\) \{ showToast/);
});

test('C19 notes are saved through the route that checks their items, and deleted as before', async () => {
  // Saving and editing go through /api/cdn_notes/save-with-items, which
  // writes the note and its items in one transaction. The generic insert and
  // update the page used before are gone from it, so there is no way left to
  // save a note without its items being checked. Deleting is unchanged, and
  // the PDF button added no write path of its own.
  assert.match(CDPAGE, /apiFetch\('\/cdn_notes\/save-with-items'/);
  assert.ok(!/_supabase\.from\('cdn_notes'\)\.(insert|update)\(/.test(CDPAGE),
    'no generic insert/update of a note is left on the page');
  assert.match(CDPAGE, /_supabase\.from\('cdn_notes'\)\.delete\(\)/);
  // Counted on the API client only: the page's own Map of ticked lines has a
  // .delete() too, and that writes nothing.
  const writes = verb => (CDPAGE.match(new RegExp("_supabase\\.from\\('[a-z_]+'\\)\\." + verb + '\\(', 'g')) || []).length;
  assert.strictEqual(writes('insert'), 0);
  assert.strictEqual(writes('update'), 0);
  assert.strictEqual(writes('upsert'), 0);
  assert.strictEqual(writes('delete'), 1);

  // A round trip through the real API leaves the stored figures alone.
  // Needs jsPDF to actually build the document, so it is checked when one
  // is available; the write-path assertions above hold regardless.
  if (JSPDF_FILE) {
    const before = (await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}`, { token: TOKEN_A })).body[0];
    await render(before);
    const after = (await api('GET', `/api/cdn_notes?eq_id=${NOTE_A}`, { token: TOKEN_A })).body[0];
    assert.deepStrictEqual(after, before, 'building a PDF must not touch the record');
  }
});
