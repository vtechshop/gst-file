// =============================================
// Purchase Bill Scan — Gemini proxy.
//
// The browser posts a bill (PDF/JPG/PNG) here; this route asks Gemini to
// read it and returns structured JSON. It exists for one reason: the
// Gemini API key must never reach the browser. The frontend is a static
// site, so anything it holds is public — same argument as Product Sync
// (routes/product-sync.js), except the key here is process-wide rather
// than per-company, because it is OUR key paying for OUR quota, not a
// credential belonging to the logged-in company.
//
// This route CANNOT write to the database. It does not import the pool,
// so there is no code path from a scan to a stored row — a purchase is
// created only when the user presses Save Purchase, which goes through
// routes/purchases.js exactly as manual entry always has.
//
// What comes back is a PROPOSAL. Nothing here computes GST, taxable
// values or totals; the numbers Gemini reports are passed through purely
// so the review panel can show what was printed on the bill. The app's
// own calcGST() remains the only thing that decides money.
// =============================================
const express = require('express');
const multer = require('multer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { GEMINI_MODEL, BILL_SCHEMA, BILL_PROMPT } = require('../services/geminiBillPrompt');
const { validateAgainstSchema } = require('../services/schemaCheck');

const router = express.Router();
router.use(requireAuth);

const MAX_BILL_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS) || 60000;

// Tighter than the global /api limiter (600 per 15 min), because every
// call here costs real money at Google. A human scanning bills one at a
// time never comes close to this; a runaway loop or a stolen token hits
// it almost immediately.
const scanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.GEMINI_SCAN_LIMIT) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  // requireAuth runs first, so req.userId is always present in practice;
  // the IP fallback goes through ipKeyGenerator because a raw req.ip
  // would let an IPv6 client hop addresses within its own /64 and evade
  // the limit entirely.
  keyGenerator: req => req.userId || ipKeyGenerator(req.ip),
  message: { error: { message: 'Too many bill scans in a short time. Please wait a few minutes.' } }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BILL_BYTES },
  fileFilter: (req, file, cb) => cb(null, ACCEPTED_MIME.includes(file.mimetype))
});

// ── Normalisation ────────────────────────────────────
// Gemini is schema-constrained, so the shape is reliable — but the
// CONTENT still needs sanitising before it reaches a form. Everything
// below either produces a clean value or produces blank; it never
// repairs, and never invents.
const str = v => (typeof v === 'string' ? v.trim() : '');

const num = v => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Blank unless it is a genuinely well-formed 15-character GSTIN. The
// prompt already asks for "" over a partial read; this is the backstop
// for when the model ignores that.
const gstin = v => {
  const g = str(v).toUpperCase().replace(/\s/g, '');
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g) ? g : '';
};

// The date input needs YYYY-MM-DD and nothing else. A real calendar
// check as well as a shape check — 2026-02-31 matches the regex.
const isoDate = v => {
  const d = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day ? d : '';
};

const pct = v => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};

function normalise(raw) {
  const vendor = raw.vendor || {};
  const purchase = raw.purchase || {};
  const supply = str(purchase.supply_type).toLowerCase();

  const products = (Array.isArray(raw.products) ? raw.products : [])
    .map(p => ({
      product_name: str(p.product_name).replace(/^\d+[.)]\s*/, ''),
      hsn_code: (str(p.hsn_code).match(/\d{4,8}/) || [''])[0],
      unit: str(p.unit).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10),
      quantity: num(p.quantity),
      rate: num(p.rate),
      discount_percentage: pct(p.discount_percentage),
      gst_percentage: pct(p.gst_percentage),
      // Reported for cross-checking in the review panel only. The form
      // recomputes both from quantity/rate/discount/GST — see
      // importScanItems() in js/purchase-scan.js.
      reported_taxable_value: num(p.taxable_value),
      reported_total: num(p.total)
    }))
    // A row with no name is table furniture the model mistook for a
    // product; a row with neither quantity nor rate can't be priced.
    .filter(p => p.product_name && (p.quantity !== null || p.rate !== null));

  return {
    vendor: {
      vendor_name: str(vendor.vendor_name).slice(0, 200),
      gstin: gstin(vendor.gstin),
      address: str(vendor.address).slice(0, 300),
      state: str(vendor.state).slice(0, 60)
    },
    purchase: {
      purchase_number: str(purchase.purchase_number).slice(0, 60),
      purchase_date: isoDate(purchase.purchase_date),
      // Reported only. detectPurchSupplyType() derives the real value
      // from the business/vendor state pair, as it does for typed entry.
      reported_supply_type: supply === 'intrastate' || supply === 'interstate' ? supply : ''
    },
    products
  };
}

// ── Scan logging ─────────────────────────────────────
// One line per scan: how long it took, which model, and whether it
// worked. Enough to answer "is the scanner slow / failing / which model
// is production actually on" from the Render logs without turning on
// anything heavier. Deliberately records no bill content — only the
// file's type and size, never its bytes or anything extracted from it.
function logScan(req, started, outcome, extra = '') {
  const ms = Date.now() - started;
  const size = req.file ? `${Math.round(req.file.size / 1024)}KB ${req.file.mimetype}` : 'no-file';
  console.log(`[bill-scan] user=${req.userId} model=${GEMINI_MODEL} ${size} ${ms}ms ${outcome}${extra ? ' ' + extra : ''}`);
}

// ── Route ────────────────────────────────────────────
router.post('/', scanLimiter, (req, res, next) => {
  upload.single('bill')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { message: 'That file is over 10 MB — please use a smaller scan.' } });
    }
    next(err);
  });
}, asyncRoute(async (req, res) => {
  const started = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Deliberately a clear operator-facing message: this is a deployment
    // step someone has missed, not a user error.
    logScan(req, started, 'FAIL', 'not-configured');
    return res.status(503).json({ error: { message: 'Bill scanning is not configured on the server (GEMINI_API_KEY is not set).' } });
  }
  if (!req.file) {
    const e = new Error('Upload a PDF, JPG or PNG bill.');
    e.status = 400; e.expose = true; throw e;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{
      parts: [
        { text: BILL_PROMPT },
        { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: BILL_SCHEMA,
      // Transcription, not composition — there is no upside to sampling.
      temperature: 0
    }
  };

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
    });
  } catch (err) {
    console.error('Gemini request failed for user', req.userId, ':', err.name, err.message);
    logScan(req, started, 'FAIL', err.name === 'TimeoutError' ? 'timeout' : 'unreachable');
    return res.status(504).json({
      error: { message: err.name === 'TimeoutError' ? 'The bill took too long to analyse. Try a smaller or clearer file.' : 'Could not reach the bill analysis service.' }
    });
  }

  if (!upstream.ok) {
    // The upstream body can echo the API key in some error shapes, so it
    // is logged server-side and never forwarded to the browser.
    console.error('Gemini HTTP', upstream.status, 'for user', req.userId, ':', (await upstream.text().catch(() => '')).slice(0, 500));
    logScan(req, started, 'FAIL', `upstream-http-${upstream.status}`);
    return res.status(502).json({ error: { message: `Bill analysis failed (upstream HTTP ${upstream.status}).` } });
  }

  const payload = await upstream.json().catch(() => null);
  const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  if (!text) {
    const reason = payload?.candidates?.[0]?.finishReason || payload?.promptFeedback?.blockReason;
    console.error('Gemini returned no content for user', req.userId, '- finishReason:', reason);
    logScan(req, started, 'FAIL', `no-content:${reason || 'unknown'}`);
    return res.status(502).json({ error: { message: 'The bill could not be read. Try a clearer scan, or enter it manually.' } });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('Gemini returned non-JSON for user', req.userId, ':', text.slice(0, 300));
    logScan(req, started, 'FAIL', 'non-json');
    return res.status(502).json({ error: { message: 'The bill analysis came back in an unexpected format. Please enter it manually.' } });
  }

  // Reject a structurally wrong reply BEFORE normalise() gets near it.
  // normalise() is forgiving by design — it turns anything unusable into
  // a blank — which means on its own it would quietly convert a garbage
  // response into an empty-looking but "successful" scan. Checking the
  // shape first is what makes the difference between "the bill was
  // blank" and "the model did not answer the question".
  const schemaErrors = validateAgainstSchema(parsed, BILL_SCHEMA);
  if (schemaErrors.length) {
    console.error('Gemini reply failed schema check for user', req.userId, ':', schemaErrors.slice(0, 10).join('; '));
    logScan(req, started, 'FAIL', `schema-invalid(${schemaErrors.length})`);
    return res.status(502).json({ error: { message: 'The bill analysis came back in an unexpected format. Please enter it manually.' } });
  }

  const result = normalise(parsed);
  logScan(req, started, 'OK', `products=${result.products.length}`);
  res.json({ model: GEMINI_MODEL, ...result });
}));

module.exports = router;
