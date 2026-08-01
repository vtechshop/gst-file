// =============================================
// Customer Invoice Scan — Gemini proxy.
//
// The browser posts one or more documents (PDF / JPG / PNG / CSV /
// XLSX); this route asks Gemini to read them and returns a LIST of
// structured invoices. Same architecture and the same shared services as
// the Purchase Bill scanner (routes/bill-scan.js) — geminiClient,
// scanUpload, scanNormalise — differing only in prompt, schema and the
// shape assembled here.
//
// Two things are specific to this route:
//
//   • It returns MANY invoices, not one. A spreadsheet export, a
//     multi-invoice PDF or a batch of photos all legitimately contain
//     several, and they must come back separated for the user to pick
//     from. Nothing here merges them.
//
//   • XLSX is converted to CSV before it is sent. Gemini accepts PDF,
//     images and text formats inline, but not the OOXML spreadsheet
//     type, so exceljs flattens the workbook to CSV text. That is a
//     FORMAT conversion, not extraction — Gemini still does all the
//     reading. No OCR is involved anywhere in this file.
//
// This route CANNOT write to the database. It does not import the pool,
// so there is no code path from a scan to a stored row — an invoice is
// created only when the user presses Save Invoice, which goes through
// routes/invoices.js exactly as manual entry always has.
//
// Nothing here computes GST, taxable values or totals. The figures
// Gemini reports come back prefixed `reported_` purely so the review
// screen can show what was printed; the app's own calcGST() and
// computeInvoiceRollups() remain the only things that decide money.
// =============================================
const express = require('express');
const ExcelJS = require('exceljs');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { INVOICE_SCHEMA, INVOICE_PROMPT } = require('../services/geminiInvoicePrompt');
const { extractDocument, GEMINI_MODEL } = require('../services/geminiClient');
const { makeScanLimiter, makeUploader, logScan, MAX_FILES } = require('../services/scanUpload');
const { str, gstin, isoDate, lineItem, isUsableLine } = require('../services/scanNormalise');

const router = express.Router();
router.use(requireAuth);

const XLSX_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
];
const ACCEPTED_MIME = [
  'application/pdf', 'image/jpeg', 'image/jpg', 'image/png',
  'text/csv', 'application/csv', 'text/plain',
  ...XLSX_MIME
];

const scanLimiter = makeScanLimiter('invoice');
const upload = makeUploader(ACCEPTED_MIME);

// ── XLSX → CSV ───────────────────────────────────────
// Every sheet is emitted, each preceded by its name, so a workbook that
// splits invoices across tabs still arrives as one readable document.
// Deliberately dumb: it preserves the grid and leaves every judgement
// about what the rows MEAN to Gemini.
async function xlsxToCsv(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet(sheet => {
    out.push(`# Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells = [];
      // row.values is 1-based with a leading hole; walk by index so
      // blank cells keep their column position instead of collapsing.
      for (let i = 1; i <= sheet.columnCount; i++) {
        const v = row.getCell(i).value;
        cells.push(cellToText(v));
      }
      // Trailing empties add nothing but tokens.
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) out.push(cells.map(csvEscape).join(','));
    });
    out.push('');
  });
  return out.join('\n');
}

function cellToText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // ExcelJS wraps formulas, hyperlinks and rich text in objects.
    if ('result' in v) return cellToText(v.result);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    return '';
  }
  return String(v);
}

const csvEscape = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// ── Normalisation ────────────────────────────────────
function normaliseInvoice(raw, index) {
  const cust = raw.customer || {};
  const tr = raw.transport || {};
  return {
    // Stable handle for the review screen to reference a chosen invoice
    // without relying on array position surviving a re-render.
    id: `scan-${index}`,
    source: str(raw.source).slice(0, 80),
    invoice_number: str(raw.invoice_number).slice(0, 60),
    invoice_date: isoDate(raw.invoice_date),
    customer: {
      customer_name: str(cust.customer_name).slice(0, 200),
      gstin: gstin(cust.gstin),
      phone: str(cust.phone).replace(/[^\d+\-\s]/g, '').slice(0, 20),
      address: str(cust.address).slice(0, 300),
      state: str(cust.state).slice(0, 60),
      place_of_supply: str(cust.place_of_supply).slice(0, 60)
    },
    transport: {
      vehicle_number: str(tr.vehicle_number).toUpperCase().replace(/\s/g, '').slice(0, 20),
      lr_number: str(tr.lr_number).slice(0, 40),
      transporter_name: str(tr.transporter_name).slice(0, 120)
    },
    products: (Array.isArray(raw.products) ? raw.products : []).map(lineItem).filter(isUsableLine)
  };
}

// ── Route ────────────────────────────────────────────
router.post('/', scanLimiter, (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { message: 'One of those files is over 10 MB — please use smaller files.' } });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: { message: `Please upload at most ${MAX_FILES} files at a time.` } });
    }
    next(err);
  });
}, asyncRoute(async (req, res) => {
  const started = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logScan('invoice-scan', req, GEMINI_MODEL, started, 'FAIL', 'not-configured');
    return res.status(503).json({ error: { message: 'Invoice scanning is not configured on the server (GEMINI_API_KEY is not set).' } });
  }
  if (!req.files || !req.files.length) {
    const e = new Error('Upload a PDF, image, CSV or Excel file.');
    e.status = 400; e.expose = true; throw e;
  }

  // Spreadsheets become CSV text; everything else goes to Gemini as-is.
  const parts = [];
  for (const f of req.files) {
    if (!XLSX_MIME.includes(f.mimetype)) {
      // Sent as-is; geminiClient canonicalises the spelling (application/
      // csv -> text/csv, image/jpg -> image/jpeg) for both scanners.
      parts.push({ mimeType: f.mimetype, buffer: f.buffer });
      continue;
    }
    try {
      const csv = await xlsxToCsv(f.buffer);
      if (!csv.trim()) {
        logScan('invoice-scan', req, GEMINI_MODEL, started, 'FAIL', 'empty-workbook');
        return res.status(400).json({ error: { message: `"${f.originalname}" appears to be empty.` } });
      }
      parts.push({ mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    } catch (err) {
      console.error('[invoice-scan] xlsx parse failed:', err.message);
      logScan('invoice-scan', req, GEMINI_MODEL, started, 'FAIL', 'xlsx-unreadable');
      return res.status(400).json({ error: { message: `"${f.originalname}" could not be read as an Excel workbook.` } });
    }
  }

  const out = await extractDocument({
    apiKey, model: GEMINI_MODEL, prompt: INVOICE_PROMPT, schema: INVOICE_SCHEMA,
    parts, label: 'invoice-scan'
  });
  if (!out.ok) {
    logScan('invoice-scan', req, GEMINI_MODEL, started, 'FAIL', out.reason);
    return res.status(out.status).json({ error: { message: out.message } });
  }

  // An invoice with neither a number nor any product row is not an
  // invoice the user can do anything with — usually a cover page or a
  // stray sheet the model listed for completeness.
  const invoices = (Array.isArray(out.data.invoices) ? out.data.invoices : [])
    .map(normaliseInvoice)
    .filter(inv => inv.invoice_number || inv.products.length);

  logScan('invoice-scan', req, GEMINI_MODEL, started, 'OK',
    `files=${req.files.length} invoices=${invoices.length}`);
  res.json({ model: GEMINI_MODEL, invoices });
}));

module.exports = router;
