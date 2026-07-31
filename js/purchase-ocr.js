// =============================================
// Purchase Bill Scanner — PDF/Image → Purchase Entry
//
// Reads a supplier bill and PROPOSES values for the existing New Purchase
// form. It is a typist, never a saver: this file contains no insert/update
// of any kind and never calls savePurchase(). The only way a purchase
// reaches the database is the user pressing the existing Save Purchase
// button, exactly as with manual entry.
//
// Everything runs in the browser. No cloud OCR, no paid API, no upload —
// the bill never leaves the machine. PDF.js and Tesseract.js are the only
// libraries, both free, and both are lazy-loaded on first use so a user
// who never scans a bill downloads nothing extra.
//
// Two extraction paths:
//   PDF with a text layer  -> exact text + coordinates from PDF.js. Most
//                             supplier bills are generated PDFs, so this
//                             path is near-perfect and needs no OCR.
//   Image / scanned PDF    -> canvas preprocessing then Tesseract OCR,
//                             with per-word confidence.
//
// Population goes exclusively through the form's own handlers
// (onPurchVendorInput, onPurchGstinBlur, loadPurchItemsIntoTable,
// recalcPurchItemRowLive, computePurchRollups), so vendor auto-fill, the
// Save Vendor / Skip panel, Product Master lookup, HSN validation, GST
// computation and totals all behave precisely as they do when typed.
// =============================================

const OCR_LOW_CONFIDENCE = 75;        // Tesseract word confidence below this is flagged
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

let ocrExtracted = null;              // last extraction, awaiting the user's Import click
let ocrAppliedValues = {};            // what Import wrote, per field id — basis of "never overwrite user edits"

// ── Lazy library loading ─────────────────────────────
// Nothing is fetched until a bill is actually chosen. Keeps Purchase Entry
// at its normal weight for everyone who enters purchases by hand.
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-ocr-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.dataset.ocrSrc = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load a required library. Check your connection and try again.'));
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (!window.pdfjsLib) await loadScriptOnce(PDFJS_URL);
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return window.pdfjsLib;
}
async function ensureTesseract() {
  if (!window.Tesseract) await loadScriptOnce(TESSERACT_URL);
  return window.Tesseract;
}

// ── Entry point ──────────────────────────────────────
async function handlePurchaseBillUpload(file) {
  if (!file) return;
  const okTypes = /\.(pdf|jpe?g|png)$/i;
  if (!okTypes.test(file.name)) { showToast('Upload a PDF, JPG, JPEG or PNG bill.', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { showToast('That file is over 20 MB — try a smaller scan.', 'error'); return; }

  showOcrProgress('Reading bill…');
  try {
    const tokens = /\.pdf$/i.test(file.name) ? await tokensFromPdf(file) : await tokensFromImage(file);
    if (!tokens.length) { hideOcrProgress(); showToast('No readable text found in that bill.', 'warning'); return; }
    ocrExtracted = extractPurchaseData(tokens);
    hideOcrProgress();
    renderOcrReview(ocrExtracted);
  } catch (err) {
    hideOcrProgress();
    showToast(err.message || 'Could not read that bill.', 'error');
  }
  // Let the same file be picked again after a cancel.
  const input = document.getElementById('purchBillInput');
  if (input) input.value = '';
}

// ── PDF → tokens ─────────────────────────────────────
// Every page is read. A page with a real text layer yields exact strings;
// a page without one (a scan saved as PDF) falls back to rendering the
// page to a canvas and OCRing it.
async function tokensFromPdf(file) {
  const pdfjsLib = await ensurePdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const tokens = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    showOcrProgress(`Reading page ${n} of ${pdf.numPages}…`);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    if (content.items.length > 3) {
      // Text layer present — exact characters, no OCR error at all.
      content.items.forEach(it => {
        const text = (it.str || '').trim();
        if (!text) return;
        tokens.push({
          text, page: n,
          x: it.transform[4],
          // PDF y grows upward; flip so downstream row grouping is top-down.
          y: viewport.height - it.transform[5],
          w: it.width || 0, h: it.height || 0,
          conf: 100, exact: true
        });
      });
    } else {
      const canvas = await renderPdfPageToCanvas(page, 2);
      tokens.push(...await ocrCanvas(canvas, n));
    }
  }
  return tokens;
}

async function renderPdfPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

// ── Image → tokens ───────────────────────────────────
async function tokensFromImage(file) {
  const canvas = await fileToCanvas(file);
  preprocessCanvas(canvas);
  return ocrCanvas(canvas, 1);
}

function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      // Upscale small scans — Tesseract is markedly better above ~1500px wide.
      const scale = img.width < 1500 ? Math.min(3, 1500 / img.width) : 1;
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale; canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')); };
    img.src = url;
  });
}

// Greyscale + contrast stretch + threshold. Deliberately plain canvas work
// rather than OpenCV: it captures most of the achievable gain for printed
// bills at zero download. Deskew/dewarp would need OpenCV and is not
// included here.
function preprocessCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const stretched = ((d[i] - min) / range) * 255;
    const v = stretched > 160 ? 255 : stretched < 90 ? 0 : stretched;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

async function ocrCanvas(canvas, pageNo) {
  const Tesseract = await ensureTesseract();
  const { data } = await Tesseract.recognize(canvas, 'eng', {
    logger: m => { if (m.status === 'recognizing text') showOcrProgress(`Reading bill… ${Math.round(m.progress * 100)}%`); }
  });
  return (data.words || [])
    .filter(w => (w.text || '').trim())
    .filter(w => !looksLikeCodeBlock(w))
    .map(w => ({
      text: w.text.trim(), page: pageNo,
      x: w.bbox.x0, y: w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0,
      conf: w.confidence, exact: false
    }));
}

// QR codes and barcodes (GST bills carry a signed IRN QR) turn into
// high-density gibberish. Heuristic only — reliable region detection would
// need OpenCV. In practice such tokens also fail every field pattern
// downstream, so this is a first filter rather than the only defence.
function looksLikeCodeBlock(word) {
  const t = (word.text || '').trim();
  if (t.length < 4) return false;
  const junk = (t.match(/[^A-Za-z0-9 .,\-/₹%:()]/g) || []).length;
  return word.confidence < 45 && junk / t.length > 0.3;
}

// ── Token geometry ───────────────────────────────────
// Groups tokens into visual lines (same page, similar y), each sorted L→R.
function groupIntoLines(tokens) {
  const byPage = {};
  tokens.forEach(t => (byPage[t.page] = byPage[t.page] || []).push(t));
  const lines = [];
  Object.keys(byPage).sort((a, b) => a - b).forEach(p => {
    const sorted = byPage[p].slice().sort((a, b) => a.y - b.y || a.x - b.x);
    let current = [];
    sorted.forEach(t => {
      const tol = Math.max(6, (t.h || 10) * 0.6);
      if (!current.length || Math.abs(t.y - current[0].y) <= tol) current.push(t);
      else { lines.push(finishLine(current, +p)); current = [t]; }
    });
    if (current.length) lines.push(finishLine(current, +p));
  });
  return lines;
}
function finishLine(tokens, page) {
  const sorted = tokens.slice().sort((a, b) => a.x - b.x);
  return {
    page, tokens: sorted,
    text: sorted.map(t => t.text).join(' ').replace(/\s+/g, ' ').trim(),
    y: sorted[0].y,
    conf: Math.min(...sorted.map(t => t.conf))
  };
}

// ── Extraction ───────────────────────────────────────
function extractPurchaseData(tokens) {
  const lines = groupIntoLines(tokens);
  const fullText = lines.map(l => l.text).join('\n');
  const exact = tokens.length ? tokens.every(t => t.exact) : false;

  const gstin = extractGstin(fullText, exact);
  const out = {
    exact,
    pages: Math.max(...tokens.map(t => t.page)),
    vendor_name: extractVendorName(lines, gstin.value),
    gstin,
    address: extractAddress(lines),
    state: extractState(fullText),
    purchase_number: extractLabelled(lines, /(invoice|bill|inv)\s*(no|number|#)/i, /^[A-Za-z0-9\-\/]{3,}$/),
    purchase_date: extractDate(lines),
    items: extractLineItems(lines),
    totals: extractTotals(fullText)
  };
  return out;
}

// GSTIN is the strongest anchor on any GST bill: it has a fixed shape AND a
// checksum, so a candidate that validates is almost certainly right. Common
// OCR confusions are retried against the app's own validateGstin() rather
// than guessed at.
const OCR_CHAR_CONFUSIONS = {
  O: '0', Q: '0', D: '0', '0': 'O',
  I: '1', L: '1', '1': 'I',
  S: '5', '5': 'S',
  B: '8', '8': 'B',
  Z: '2', '2': 'Z',
  G: '6', '6': 'G'
};

function extractGstin(text, exact) {
  // Deliberately permissive: any 15-char alphanumeric run is a candidate.
  // A stricter shape (\d{2}...\d{4}...) would reject exactly the misreads
  // this function exists to repair — an O read for a 0 inside the numeric
  // block means the string no longer matches the strict pattern at all.
  // The checksum, not the regex, is what decides.
  // 14–16 chars, not exactly 15: OCR both drops and invents characters, and
  // an inserted stray letter is at least as common as a misread one. A
  // strict 15-char window would never even see those candidates.
  const candidates = [...new Set(text.toUpperCase().match(/\b[0-9A-Z]{14,16}\b/g) || [])];
  const valid = g => typeof validateGstin === 'function' && validateGstin(g).valid;

  // Every 15-char string derivable from a candidate by at most one edit:
  // itself, or a single deletion if it came out one character too long.
  const variantsOf = raw => {
    if (raw.length === 15) return [raw];
    if (raw.length === 16) return Array.from({ length: 16 }, (_, i) => raw.slice(0, i) + raw.slice(i + 1));
    return [];   // 14 chars — a dropped character can't be recovered unambiguously
  };

  for (const raw of candidates) {
    for (const v of variantsOf(raw)) if (valid(v)) {
      return { value: v, confident: true, corrected: v !== raw };
    }
  }
  // Then a single character substitution, one position at a time — a global
  // replace would also corrupt legitimate occurrences of the same letter
  // elsewhere in the PAN block.
  for (const raw of candidates) {
    for (const v of variantsOf(raw)) {
      for (let i = 0; i < v.length; i++) {
        const swap = OCR_CHAR_CONFUSIONS[v[i]];
        if (!swap) continue;
        const tryVal = v.slice(0, i) + swap + v.slice(i + 1);
        if (valid(tryVal)) return { value: tryVal, confident: true, corrected: true };
      }
    }
  }
  // Nothing passed the checksum. Fall back to the candidate that at least
  // has GSTIN shape, and flag it for the user to check.
  const shaped = candidates.find(c => /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(c)) || candidates[0] || '';
  return { value: shaped, confident: false, corrected: false };
}

// Vendor name: the line above the GSTIN is usually the supplier's name on
// Indian bills; otherwise the first substantial line. Whatever is found is
// matched against Vendor Master, because an existing vendor is far more
// trustworthy than raw text.
function extractVendorName(lines, gstinValue) {
  let guess = '';
  if (gstinValue) {
    const idx = lines.findIndex(l => l.text.toUpperCase().includes(gstinValue));
    for (let i = idx - 1; i >= 0 && i >= idx - 3; i--) {
      const t = lines[i].text.trim();
      if (t.length > 3 && !/^\d/.test(t) && !/gstin|invoice|bill|tax/i.test(t)) { guess = t; break; }
    }
  }
  if (!guess) {
    const cand = lines.slice(0, 6).map(l => l.text.trim())
      .find(t => t.length > 4 && !/^\d/.test(t) && !/tax invoice|gstin|invoice/i.test(t));
    guess = cand || '';
  }
  guess = guess.replace(/^(m\/s\.?|messrs\.?)\s*/i, '').trim();
  const known = typeof purchVendorsList !== 'undefined'
    ? purchVendorsList.find(v => v.name.toLowerCase() === guess.toLowerCase()
        || (guess && v.name.toLowerCase().includes(guess.toLowerCase().slice(0, 8))))
    : null;
  return { value: known ? known.name : guess, confident: !!known || guess.length > 4, matchedVendor: !!known };
}

function extractAddress(lines) {
  const idx = lines.findIndex(l => /gstin/i.test(l.text));
  const near = idx > 0 ? lines.slice(Math.max(0, idx - 4), idx) : lines.slice(1, 5);
  const addr = near.map(l => l.text)
    .filter(t => /\d/.test(t) && t.length > 10 && !/gstin|invoice|bill no|date/i.test(t))
    .join(', ');
  return { value: addr.slice(0, 200), confident: !!addr };
}

// Reuses INDIAN_STATES from js/utils.js rather than restating a state list.
function extractState(text) {
  const upper = text.toUpperCase();
  const hit = (typeof INDIAN_STATES !== 'undefined' ? INDIAN_STATES : [])
    .find(s => upper.includes(s.toUpperCase()));
  return { value: hit || '', confident: !!hit };
}

function extractLabelled(lines, labelRe, valueRe) {
  for (const line of lines) {
    if (!labelRe.test(line.text)) continue;
    const after = line.text.split(labelRe).pop() || '';
    const tok = after.split(/[\s:]+/).map(s => s.trim()).filter(Boolean).find(s => valueRe.test(s));
    if (tok) return { value: tok.replace(/[:.]$/, ''), confident: line.conf >= OCR_LOW_CONFIDENCE };
  }
  return { value: '', confident: false };
}

// Indian bills are overwhelmingly DD/MM/YYYY; an ambiguous pair is read that
// way and flagged so the user can check it.
function extractDate(lines) {
  const re = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/;
  for (const line of lines) {
    if (!/date/i.test(line.text)) continue;
    const m = line.text.match(re);
    if (m) return buildDate(m, line.conf);
  }
  for (const line of lines) {
    const m = line.text.match(re);
    if (m) return buildDate(m, Math.min(line.conf, OCR_LOW_CONFIDENCE - 1));
  }
  return { value: '', confident: false, ambiguous: false };
}
function buildDate(m, conf) {
  let y, mo, d;
  if (m[4]) { y = +m[4]; mo = +m[5]; d = +m[6]; }
  else {
    d = +m[1]; mo = +m[2]; y = +m[3];
    if (y < 100) y += 2000;
  }
  if (mo > 12) { const t = d; d = mo; mo = t; }
  if (!y || !mo || !d || mo > 12 || d > 31) return { value: '', confident: false, ambiguous: false };
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { value: iso, confident: conf >= OCR_LOW_CONFIDENCE, ambiguous: d <= 12 };
}

function extractTotals(text) {
  const grab = re => { const m = text.match(re); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
  return {
    taxable: grab(/(?:taxable|sub\s*total|subtotal)[^\d\-]{0,20}([\d,]+\.?\d*)/i),
    total: grab(/(?:grand\s*total|total\s*(?:amount|value)?|net\s*amount)[^\d\-]{0,20}([\d,]+\.?\d*)/i)
  };
}

// ── Line items ───────────────────────────────────────
// Column geometry, not regex-over-a-blob: find the table header on each
// page, take each heading's x-centre as a column anchor, then assign every
// token on later lines to its nearest column. Handles multi-page bills
// because the header is re-detected per page.
const COLUMN_PATTERNS = [
  { key: 'product_name',        re: /^(description|particulars|product|item|goods)/i },
  { key: 'hsn_code',            re: /^(hsn|sac)/i },
  { key: 'unit',                re: /^(unit|uom|qty\s*unit)/i },
  { key: 'quantity',            re: /^(qty|quantity)/i },
  { key: 'rate',                re: /^(rate|price|mrp)/i },
  { key: 'discount_percentage', re: /^(disc|discount)/i },
  { key: 'gst_percentage',      re: /^(gst|tax|igst|cgst)\s*%?/i },
  { key: 'taxable_value',       re: /^(taxable|amount|value)/i },
  { key: 'total_amount',        re: /^(total)/i }
];

function extractLineItems(lines) {
  const items = [];
  const pages = [...new Set(lines.map(l => l.page))].sort((a, b) => a - b);

  pages.forEach(page => {
    const pageLines = lines.filter(l => l.page === page);
    const headerIdx = pageLines.findIndex(l => countColumnHits(l) >= 3);
    if (headerIdx === -1) return;
    const columns = mapColumns(pageLines[headerIdx]);
    if (!columns.length) return;

    for (let i = headerIdx + 1; i < pageLines.length; i++) {
      const line = pageLines[i];
      // Stop at the totals block — anything after is not a product row.
      if (/^(sub\s*total|total|grand\s*total|amount in words|terms|declaration|e\.?\s*&\s*o\.?e)/i.test(line.text)) break;
      const row = rowFromLine(line, columns);
      if (row) items.push(row);
    }
  });
  return items;
}

function countColumnHits(line) {
  return COLUMN_PATTERNS.filter(c => line.tokens.some(t => c.re.test(t.text))).length;
}

function mapColumns(headerLine) {
  const cols = [];
  COLUMN_PATTERNS.forEach(c => {
    const tok = headerLine.tokens.find(t => c.re.test(t.text));
    if (tok) cols.push({ key: c.key, x: tok.x + (tok.w || 0) / 2 });
  });
  return cols.sort((a, b) => a.x - b.x);
}

function rowFromLine(line, columns) {
  const bucket = {};
  line.tokens.forEach(t => {
    const cx = t.x + (t.w || 0) / 2;
    let best = columns[0], bestD = Infinity;
    columns.forEach(c => { const d = Math.abs(c.x - cx); if (d < bestD) { bestD = d; best = c; } });
    (bucket[best.key] = bucket[best.key] || []).push(t);
  });

  const txt = k => (bucket[k] || []).map(t => t.text).join(' ').trim();
  const num = k => {
    const m = txt(k).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  const name = txt('product_name').replace(/^\d+[.)]\s*/, '').trim();   // drop a leading serial number
  const hsn = (txt('hsn_code').match(/\d{4,8}/) || [''])[0];
  const qty = num('quantity');
  const rate = num('rate');
  // A product row needs a name and at least one of qty/rate — otherwise it
  // is a continuation line, a note, or table furniture.
  if (!name || name.length < 2 || (qty === null && rate === null)) return null;

  const gstPct = num('gst_percentage');
  return {
    product_name: name,
    hsn_code: hsn,
    unit: txt('unit').replace(/[^A-Za-z]/g, '').toUpperCase(),
    quantity: qty !== null && qty > 0 ? qty : 1,
    rate: rate !== null ? rate : 0,
    discount_percentage: num('discount_percentage') || 0,
    gst_percentage: gstPct !== null ? gstPct : 0,
    ocr_taxable: num('taxable_value'),
    ocr_total: num('total_amount'),
    conf: line.conf,
    hsnValid: !hsn || (typeof isValidHsnFormat === 'function' && isValidHsnFormat(hsn))
  };
}

// ── Review panel ─────────────────────────────────────
// Nothing reaches the form until the user presses Import here.
function renderOcrReview(d) {
  const panel = document.getElementById('purchOcrReview');
  if (!panel) return;
  const chip = ok => ok
    ? '<span class="badge badge-green" style="font-size:9px;">OK</span>'
    : '<span class="badge badge-orange" style="font-size:9px;">CHECK</span>';
  const line = (label, field) => `<div class="calc-row"><span class="label">${label}</span>
    <span class="value">${escOcr(field.value) || '<span class="text-muted-sm">not found</span>'} ${chip(field.confident)}</span></div>`;

  const dupNote = '<div id="purchOcrDupWarn" class="fs-12 mb-10"></div>';
  const itemRows = d.items.map((it, i) => `
    <tr${it.conf < OCR_LOW_CONFIDENCE ? ' class="ocr-low"' : ''}>
      <td>${i + 1}</td>
      <td>${escOcr(it.product_name)}</td>
      <td>${escOcr(it.hsn_code) || '&mdash;'} ${it.hsn_code && !it.hsnValid ? '<span class="badge badge-red" style="font-size:9px;">HSN?</span>' : ''}</td>
      <td class="text-center">${formatNum(it.quantity)}</td>
      <td class="text-right">${formatNum(it.rate)}</td>
      <td class="text-center">${formatNum(it.discount_percentage)}%</td>
      <td class="text-center">${formatNum(it.gst_percentage)}%</td>
      <td class="text-center">${productMatchBadge(it.product_name)}</td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="card mb-20" id="purchOcrCard">
      <div class="card-header">
        <span class="card-title"><i class="fas fa-file-invoice"></i> Review Scanned Bill</span>
        <span class="fs-12 text-muted-sm">${d.pages} page(s) &middot; ${d.exact ? 'PDF text layer (exact)' : 'OCR'} &middot; ${d.items.length} product row(s)</span>
      </div>
      <div class="card-body">
        <div class="banner-warning mb-16">
          <div><i class="fas fa-circle-info"></i>Nothing is saved yet. Check the values below, press <b>Import</b> to fill the form, edit anything you like, then press <b>Save Purchase</b>.</div>
        </div>
        ${dupNote}
        <div class="calc-box mb-16">
          ${line('Vendor Name', d.vendor_name)}
          ${line('GSTIN', d.gstin)}${d.gstin.corrected ? '<div class="fs-11 text-muted-sm">GSTIN auto-corrected using its checksum.</div>' : ''}
          ${line('Address', d.address)}
          ${line('State', d.state)}
          ${line('Purchase Number', d.purchase_number)}
          ${line('Purchase Date', d.purchase_date)}${d.purchase_date.ambiguous ? '<div class="fs-11 text-muted-sm">Day/month order was ambiguous — read as DD/MM. Please confirm.</div>' : ''}
        </div>
        ${d.items.length ? `<div class="table-wrapper mb-16"><table class="data-table">
          <thead><tr><th>#</th><th>Product</th><th>HSN</th><th class="text-center">Qty</th>
            <th class="text-right">Rate</th><th class="text-center">Disc</th><th class="text-center">GST</th><th class="text-center">Master</th></tr></thead>
          <tbody>${itemRows}</tbody></table></div>`
          : '<div class="empty-state mb-16">No product rows detected — you can still import the header and add rows by hand.</div>'}
        <div class="d-flex gap-10">
          <button type="button" class="btn btn-primary" onclick="importOcrIntoForm()"><i class="fas fa-file-import"></i> Import into Form</button>
          <button type="button" class="btn btn-secondary" onclick="dismissOcrReview()">Cancel</button>
        </div>
      </div>
    </div>`;
  panel.classList.remove('d-none');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  warnIfPurchaseNumberExists(d.purchase_number.value);
}

function productMatchBadge(name) {
  const list = typeof purchProductsList !== 'undefined' ? purchProductsList : [];
  const match = typeof findProductByName === 'function' ? findProductByName(list, name) : null;
  return match
    ? '<span class="badge badge-green" style="font-size:9px;">matched</span>'
    : '<span class="badge" style="font-size:9px;background:#eceff1;color:#546e7a;">new</span>';
}

// Read-only check, mirroring the duplicate test savePurchase() already runs.
async function warnIfPurchaseNumberExists(num) {
  const slot = document.getElementById('purchOcrDupWarn');
  if (!slot || !num) return;
  try {
    const user = await getCurrentUser();
    if (!user) return;
    const { data } = await _supabase.from('purchases').select('id')
      .eq('user_id', user.id).eq('purchase_number', num).single();
    if (data?.id) {
      slot.innerHTML = `<div class="banner-warning"><div><i class="fas fa-triangle-exclamation"></i>
        Purchase number <b>${escOcr(num)}</b> already exists. Saving with this number will be rejected — change it after importing.</div></div>`;
    }
  } catch { /* no match, or offline — the save-time check remains authoritative */ }
}

function dismissOcrReview() {
  ocrExtracted = null;
  const panel = document.getElementById('purchOcrReview');
  if (panel) { panel.innerHTML = ''; panel.classList.add('d-none'); }
}

// ── Import into the form ─────────────────────────────
// Every write goes through the form's own handlers, and every field the
// user has already touched is left alone.
function importOcrIntoForm() {
  const d = ocrExtracted;
  if (!d) return;

  setIfUntouched('purchVendorName', d.vendor_name.value, d.vendor_name.confident);
  if (typeof onPurchVendorInput === 'function') onPurchVendorInput();   // vendor auto-fill + Save Vendor / Skip panel

  setIfUntouched('purchGstin', d.gstin.value, d.gstin.confident);
  if (typeof onPurchGstinInput === 'function') onPurchGstinInput(document.getElementById('purchGstin'));
  if (typeof onPurchGstinBlur === 'function') onPurchGstinBlur();       // GSTIN validation + vendor-by-GSTIN lookup

  setIfUntouched('purchAddress', d.address.value, d.address.confident);
  setIfUntouched('purchState', d.state.value, d.state.confident);
  setIfUntouched('purchNum', d.purchase_number.value, d.purchase_number.confident);
  setIfUntouched('purchDate', d.purchase_date.value, d.purchase_date.confident);
  if (typeof detectPurchSupplyType === 'function') detectPurchSupplyType();   // supply type is derived, never set

  if (d.items.length) importOcrItems(d.items);

  dismissOcrReview();
  showToast(`Imported ${d.items.length} product row(s). Review, then press Save Purchase.`, 'success');
}

// Rows go in through loadPurchItemsIntoTable() — the same bulk path the
// Edit-purchase flow uses. One render for any number of rows, and it sets
// each row's Product Master match itself. Values are then computed by
// recalcPurchItemRowLive(), so GST/taxable/total come from the app's own
// calcGST(), never from OCR.
function importOcrItems(items) {
  const existing = (typeof purchItems !== 'undefined' ? purchItems : [])
    .filter(r => r.product_name || r.rate || r.hsn_code);          // keep anything already typed
  const rows = existing.concat(items.map(it => ({
    product_name: it.product_name,
    hsn_code: it.hsn_code,
    unit: it.unit,
    quantity: it.quantity,
    rate: it.rate,
    discount_percentage: it.discount_percentage,
    gst_percentage: it.gst_percentage
    // taxable_value / gst_amount / total_amount deliberately omitted —
    // recalcPurchItemRowLive() derives them below.
  })));

  loadPurchItemsIntoTable(rows);
  purchItems.forEach(r => { if (typeof recalcPurchItemRowLive === 'function') recalcPurchItemRowLive(r.rowId); });
  if (typeof renderPurchItemsTable === 'function') renderPurchItemsTable();
  if (typeof computePurchRollups === 'function') computePurchRollups();

  const unmatched = items.filter(it => !(typeof findProductByName === 'function'
    && findProductByName(purchProductsList || [], it.product_name)));
  if (unmatched.length) {
    showToast(`${unmatched.length} product(s) are not in Product Master — use Quick Add on the row to save them.`, 'info');
  }
}

// A field is written only if it is still empty or still holds exactly what a
// previous import put there. Anything the user has typed or corrected wins.
function setIfUntouched(id, value, confident) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  const current = (el.value || '').trim();
  if (current && current !== (ocrAppliedValues[id] || '')) return;   // user edited it — leave alone
  el.value = value;
  ocrAppliedValues[id] = value;
  el.classList.toggle('ocr-low', !confident);
  el.classList.add('ocr-filled');
  el.addEventListener('input', () => {
    el.classList.remove('ocr-low', 'ocr-filled');
    delete ocrAppliedValues[id];
  }, { once: true });
}

// ── Progress ─────────────────────────────────────────
function showOcrProgress(msg) {
  const el = document.getElementById('purchOcrProgress');
  if (!el) return;
  el.innerHTML = `<div class="banner-warning"><div><i class="fas fa-spinner fa-spin"></i> ${escOcr(msg)}</div></div>`;
  el.classList.remove('d-none');
}
function hideOcrProgress() {
  const el = document.getElementById('purchOcrProgress');
  if (el) { el.innerHTML = ''; el.classList.add('d-none'); }
}

function escOcr(v) { return (v || '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
