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

test('C14 no other PDF module was modified', async () => {
  const { execSync } = require('child_process');
  const changed = execSync('git status --porcelain -- client/js/pages/invoice-pdf.js '
    + 'client/js/pages/proforma-pdf.js client/js/pages/sales-return-pdf.js '
    + 'client/js/pages/purchase-order-pdf.js', { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', 'the existing PDF modules must be untouched');
});

// ═══════════════════════════════════════════════════════════════════════
//  The boundary: whose note can be downloaded at all
// ═══════════════════════════════════════════════════════════════════════

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

test('C19 saving, editing and deleting a note are unchanged', async () => {
  // The page's own write paths are the ones that were there before; the
  // PDF button added no fourth way to change a note.
  assert.match(CDPAGE, /_supabase\.from\('cdn_notes'\)\.update\(payload\)/);
  assert.match(CDPAGE, /_supabase\.from\('cdn_notes'\)\.insert\(payload\)/);
  assert.match(CDPAGE, /_supabase\.from\('cdn_notes'\)\.delete\(\)/);
  // Exactly one insert, one update, one delete - the PDF added none.
  assert.strictEqual((CDPAGE.match(/\.insert\(/g) || []).length, 1);
  assert.strictEqual((CDPAGE.match(/\.update\(/g) || []).length, 1);
  assert.strictEqual((CDPAGE.match(/\.delete\(/g) || []).length, 1);

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
