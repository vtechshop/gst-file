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

// Below this, a figure is treated as unread rather than as data. On a
// handwritten bill a plausible-looking wrong number is far more damaging
// than a blank the user has to fill in: the blank gets noticed, the
// wrong number gets saved into a tax return.
const MIN_CONFIDENCE = 0.75;

// Drops a value whose reported confidence is below the threshold. A
// missing score is treated as confident, because most bills are printed
// and the model only volunteers low scores when it is genuinely unsure.
const gated = (value, confidence) => {
  const c = num(confidence);
  return c !== null && c < MIN_CONFIDENCE ? null : value;
};

// Handwritten bills routinely omit the rate column and print only the
// line's taxable value. The prompt asks Gemini to fill rate in that
// case; this is the backstop for when it doesn't.
//
// It will NOT run when the quantity is unknown. Dividing a taxable value
// by an assumed quantity of 1 invents a unit price, and that is exactly
// the guessing this pass exists to prevent.
function deriveRateFromTaxable(p) {
  if (p.rate !== null || p.reported_taxable_value === null) return p;
  if (p.quantity === null || !(p.quantity > 0)) return p;
  const derived = p.reported_taxable_value / p.quantity;
  return Number.isFinite(derived) ? { ...p, rate: Math.round(derived * 100) / 100, rate_derived: true } : p;
}

// A single line, quantity 1, no discount: rate and taxable value are the
// same number by definition. If the two disagree the rate column was
// misread, so the taxable value wins — it is the figure the bill's own
// totals are built from.
function reconcileSingleLine(products) {
  if (products.length !== 1) return products;
  const p = products[0];
  if (p.quantity !== 1 || p.reported_taxable_value === null) return products;
  if (p.discount_percentage || p.reported_discount_amount) return products;
  if (p.rate !== null && Math.abs(p.rate - p.reported_taxable_value) < 0.02) return products;
  return [{ ...p, rate: p.reported_taxable_value, rate_derived: true }];
}

// taxable + tax + cess ± round off should land on the grand total. When
// it doesn't, something in the financial block was misread — surfaced as
// a warning on the review screen rather than a rejection, because the
// user can see the bill and we cannot.
function checkTotals(t) {
  const parts = [t.reported_taxable_value ?? t.reported_subtotal, t.reported_grand_total];
  if (parts.some(v => v === null || v === undefined)) return null;
  const sum = (t.reported_taxable_value ?? t.reported_subtotal)
    + (t.reported_cgst_amount || 0) + (t.reported_sgst_amount || 0)
    + (t.reported_igst_amount || 0) + (t.reported_cess_amount || 0)
    + (t.reported_round_off || 0);
  const diff = Math.round((sum - t.reported_grand_total) * 100) / 100;
  return Math.abs(diff) <= 2 ? null
    : `The bill's own totals do not add up: taxable + tax ± round off = ${sum.toFixed(2)}, but the grand total reads ${t.reported_grand_total.toFixed(2)} (out by ${diff.toFixed(2)}). Check the amounts before importing.`;
}

function normaliseTotals(t = {}) {
  return {
    reported_subtotal: gated(num(t.subtotal), t.taxable_confidence),
    reported_taxable_value: gated(num(t.taxable_value), t.taxable_confidence),
    reported_cgst_amount: gated(num(t.cgst_amount), t.gst_confidence),
    reported_sgst_amount: gated(num(t.sgst_amount), t.gst_confidence),
    reported_igst_amount: gated(num(t.igst_amount), t.gst_confidence),
    reported_cess_amount: num(t.cess_amount),
    reported_round_off: num(t.round_off),
    reported_grand_total: gated(num(t.grand_total), t.grand_total_confidence)
  };
}

function normalise(raw) {
  const vendor = raw.vendor || {};
  const purchase = raw.purchase || {};
  const supply = str(purchase.supply_type).toLowerCase();

  const products = reconcileSingleLine(
    (Array.isArray(raw.products) ? raw.products : [])
      .map(p => {
        const base = lineItem(p);
        return {
          ...base,
          // Each figure survives only if the model was sure enough of it.
          quantity: gated(base.quantity, p.qty_confidence),
          rate: gated(base.rate, p.rate_confidence),
          gst_percentage: gated(base.gst_percentage, p.gst_confidence),
          reported_taxable_value: gated(base.reported_taxable_value, p.taxable_confidence),
          product_description: str(p.product_description).slice(0, 300),
          ...reportedTax(p)
        };
      })
      // Order matters: discard the bill's summary rows first, then fill
      // a missing rate, then keep only lines that can actually be priced.
      .filter(p => p.product_name && !isSummaryRow(p))
      .map(deriveRateFromTaxable)
      // Deliberately more permissive than the shared isUsableLine(): a
      // handwritten line whose quantity and rate are both illegible but
      // which clearly shows a value is still a real purchase. Dropping
      // it would lose a line off the bill silently, which is a worse
      // accuracy failure than showing it with blanks for the user to
      // complete. Summary rows are already gone by this point.
      .filter(p => p.quantity !== null || p.rate !== null || p.reported_taxable_value !== null)
  );
  const totals = normaliseTotals(raw.totals);

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
    products,
    totals,
    // Non-fatal things the user should look at before importing. The
    // scan still succeeds — only a human holding the bill can settle
    // them, so they are surfaced rather than used to reject the scan.
    warnings: [
      checkTotals(totals),
      products.some(p => p.quantity === null)
        ? 'One or more quantities could not be read and have been left blank — set them before saving.'
        : null,
      products.some(p => p.rate === null)
        ? 'One or more rates could not be read and have been left blank — set them before saving.'
        : null
    ].filter(Boolean)
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
