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
const { str, num, gstin, isoDate, pct, lineItem, isUsableLine } = require('../services/scanNormalise');

const router = express.Router();
router.use(requireAuth);

const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const scanLimiter = makeScanLimiter('bill');
const upload = makeUploader(ACCEPTED_MIME);

// The bill's own tax breakdown, per line and in the summary block. Every
// one of these is prefixed `reported_` and is for DISPLAY ONLY: the
// review screen shows what the document printed beside what this app
// computes, so a misread line is obvious before import. savePurchase()
// stores the app's figures from calcGST(), never these.
function reportedTax(p) {
  return {
    reported_cgst_percentage: pct(p.cgst_percentage),
    reported_cgst_amount: num(p.cgst_amount),
    reported_sgst_percentage: pct(p.sgst_percentage),
    reported_sgst_amount: num(p.sgst_amount),
    reported_igst_percentage: pct(p.igst_percentage),
    reported_igst_amount: num(p.igst_amount),
    reported_cess_amount: num(p.cess_amount),
    reported_discount_amount: num(p.discount_amount)
  };
}

// Rows from the bill's summary block that the model sometimes lists as
// products. They must be dropped BEFORE any rate derivation: a "Grand
// Total" row carries a taxable value, so deriving a rate for it would
// make it look like a perfectly valid product line and import the
// invoice total as a purchased item.
const SUMMARY_ROW = /^(sub\s*total|total|grand\s*total|net\s*(amount|total)|taxable(\s*value)?|round\s*off|c?gst|sgst|igst|cess|amount\s*in\s*words|balance|discount)\b/i;
const isSummaryRow = p => SUMMARY_ROW.test(p.product_name.trim());

// Handwritten bills routinely omit the rate column and print only the
// line's taxable value. The prompt asks Gemini to fill rate in that
// case; this is the backstop for when it doesn't, so a visible taxable
// value never arrives as a blank rate. It only ever fills a NULL rate,
// and it reads the bill's own arithmetic rather than inventing a price —
// the app still recomputes tax from the result via calcGST().
function deriveRateFromTaxable(p) {
  if (p.rate !== null || p.reported_taxable_value === null) return p;
  const qty = p.quantity !== null && p.quantity > 0 ? p.quantity : 1;
  const derived = p.reported_taxable_value / qty;
  return Number.isFinite(derived) ? { ...p, rate: Math.round(derived * 100) / 100, rate_derived: true } : p;
}

function normaliseTotals(t = {}) {
  return {
    reported_subtotal: num(t.subtotal),
    reported_taxable_value: num(t.taxable_value),
    reported_cgst_amount: num(t.cgst_amount),
    reported_sgst_amount: num(t.sgst_amount),
    reported_igst_amount: num(t.igst_amount),
    reported_cess_amount: num(t.cess_amount),
    reported_round_off: num(t.round_off),
    reported_grand_total: num(t.grand_total)
  };
}

function normalise(raw) {
  const vendor = raw.vendor || {};
  const purchase = raw.purchase || {};
  const supply = str(purchase.supply_type).toLowerCase();

  return {
    vendor: {
      vendor_name: str(vendor.vendor_name).slice(0, 200),
      gstin: gstin(vendor.gstin),
      address: str(vendor.address).slice(0, 300),
      state: str(vendor.state).slice(0, 60),
      phone: str(vendor.phone).replace(/[^\d+\-\s]/g, '').trim().slice(0, 20),
      email: str(vendor.email).slice(0, 120)
    },
    purchase: {
      purchase_number: str(purchase.purchase_number).slice(0, 60),
      purchase_date: isoDate(purchase.purchase_date),
      // Reported only. detectPurchSupplyType() derives the real value
      // from the business/vendor state pair, as it does for typed entry.
      reported_supply_type: supply === 'intrastate' || supply === 'interstate' ? supply : ''
    },
    products: (Array.isArray(raw.products) ? raw.products : [])
      .map(p => ({
        ...lineItem(p),
        product_description: str(p.product_description).slice(0, 300),
        ...reportedTax(p)
      }))
      // Order matters: discard the bill's summary rows first, then fill
      // a missing rate, then keep only lines that can actually be priced.
      .filter(p => p.product_name && !isSummaryRow(p))
      .map(deriveRateFromTaxable)
      .filter(isUsableLine),
    totals: normaliseTotals(raw.totals)
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
