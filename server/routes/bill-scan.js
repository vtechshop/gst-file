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
// The Gemini call itself, the upload plumbing and the value sanitisers
// are shared with the Customer Invoice scanner (routes/invoice-scan.js)
// — see services/geminiClient.js, scanUpload.js and scanNormalise.js.
// What is specific to a purchase bill is only the prompt, the schema and
// the shape assembled below.
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
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { BILL_SCHEMA, BILL_PROMPT } = require('../services/geminiBillPrompt');
const { extractDocument, GEMINI_MODEL } = require('../services/geminiClient');
const { makeScanLimiter, makeUploader, logScan } = require('../services/scanUpload');
const { str, gstin, isoDate, lineItem, isUsableLine } = require('../services/scanNormalise');

const router = express.Router();
router.use(requireAuth);

const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const scanLimiter = makeScanLimiter('bill');
const upload = makeUploader(ACCEPTED_MIME);

function normalise(raw) {
  const vendor = raw.vendor || {};
  const purchase = raw.purchase || {};
  const supply = str(purchase.supply_type).toLowerCase();

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
    products: (Array.isArray(raw.products) ? raw.products : []).map(lineItem).filter(isUsableLine)
  };
}

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
    logScan('bill-scan', req, GEMINI_MODEL, started, 'FAIL', 'not-configured');
    return res.status(503).json({ error: { message: 'Bill scanning is not configured on the server (GEMINI_API_KEY is not set).' } });
  }
  if (!req.file) {
    const e = new Error('Upload a PDF, JPG or PNG bill.');
    e.status = 400; e.expose = true; throw e;
  }

  const out = await extractDocument({
    apiKey, model: GEMINI_MODEL, prompt: BILL_PROMPT, schema: BILL_SCHEMA,
    parts: [{ mimeType: req.file.mimetype, buffer: req.file.buffer }],
    label: 'bill-scan'
  });
  if (!out.ok) {
    logScan('bill-scan', req, GEMINI_MODEL, started, 'FAIL', out.reason);
    return res.status(out.status).json({ error: { message: out.message } });
  }

  const result = normalise(out.data);
  logScan('bill-scan', req, GEMINI_MODEL, started, 'OK', `products=${result.products.length}`);
  res.json({ model: GEMINI_MODEL, ...result });
}));

module.exports = router;
