// =============================================
// GSTIN lookup against the public GST taxpayer register, via Appyflow.
//
// WHY THIS IS A BACKEND ROUTE AND NOT A FETCH FROM THE BROWSER
// The Appyflow call needs a paid account secret. Anything the browser
// sends is readable by whoever is using the browser, so a frontend call
// would publish the secret to every user of the app and to anyone who
// opens DevTools. The secret therefore lives only in this process's
// environment and never appears in a response, a log line, or an error
// message — same arrangement as GEMINI_API_KEY for the scanners.
//
// WHAT IT RETURNS
// An allowlisted subset of the taxpayer record: the fields the Invoice
// form actually fills in, plus the status fields that tell a user whether
// they should be invoicing this GSTIN at all. Nothing else from the
// upstream payload is passed through — not the raw response, not the
// request URL, not anything that could carry the secret back out.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not write to the database, does not create or update a
// customer, and does not decide place of supply. It answers "who is this
// GSTIN registered to" and stops there; what the form does with the
// answer is the form's business.
// =============================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, AppError } = require('../middleware/errorHandler');
const { validateGstin } = require('../utils/validation');

const router = express.Router();
router.use(requireAuth);

const APPYFLOW_URL = 'https://appyflow.in/api/verifyGST';
const TIMEOUT_MS = parseInt(process.env.APPYFLOW_TIMEOUT_MS, 10) || 15000;

// Each lookup costs money, so it is capped per user rather than per IP —
// an office behind one NAT address is many users, and rate limiting them
// as one would punish the wrong people.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: parseInt(process.env.APPYFLOW_LOOKUP_LIMIT, 10) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.userId || req.ip,
  message: { error: { message: 'Too many GST lookups. Try again in a few minutes.', code: 'rate_limited' } }
});

// The taxpayer record, reduced to what this application has a use for.
// Written as an explicit mapping rather than a spread so that a change in
// the upstream payload cannot quietly introduce a new field into our
// response — including one that echoes back part of the request.
function safeTaxpayer(info) {
  const addr = (info.pradr && info.pradr.addr) || {};
  // The Portal splits the registered address across several optional
  // parts; joined here in reading order so the form gets one line, the
  // shape its Address field already holds.
  const addressLine = [
    addr.bno, addr.bnm, addr.flno, addr.st, addr.loc, addr.city
  ].map(p => (p || '').trim()).filter(Boolean).join(', ');

  return {
    gstin: info.gstin || '',
    legalName: info.lgnm || '',
    tradeName: info.tradeNam || '',
    address: addressLine,
    district: addr.dst || '',
    state: addr.stcd || '',
    pincode: addr.pncd ? String(addr.pncd) : '',
    status: info.sts || '',
    registrationDate: info.rgdt || '',
    constitution: info.ctb || '',
    taxpayerType: info.dty || ''
  };
}

router.post('/verify', lookupLimiter, asyncRoute(async (req, res) => {
  const gstin = String((req.body && req.body.gstin) || '').trim().toUpperCase();

  // Checked here before spending a paid lookup on a string that cannot
  // possibly be a GSTIN. Same validator the form and the customer API
  // use, so a GSTIN accepted anywhere is accepted here.
  const shape = validateGstin(gstin);
  if (!shape.valid) {
    throw new AppError(400, 'Enter a valid 15-character GSTIN before verifying.', 'invalid_gstin');
  }

  const secret = process.env.APPYFLOW_KEY_SECRET;
  if (!secret) {
    // Unconfigured is not an error in the user's work — it is an error in
    // ours, and it is said plainly without hinting at the variable name.
    throw new AppError(503, 'GST verification is not configured on this server.', 'not_configured');
  }

  const url = `${APPYFLOW_URL}?gstNo=${encodeURIComponent(gstin)}&key_secret=${encodeURIComponent(secret)}`;

  let upstream, payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    upstream = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    payload = await upstream.json().catch(() => null);
  } catch (err) {
    // The upstream error is deliberately NOT forwarded: it can contain the
    // request URL, and the request URL contains the secret.
    const timedOut = err && err.name === 'AbortError';
    throw new AppError(504,
      timedOut ? 'The GST verification service did not respond in time. Try again.'
               : 'Could not reach the GST verification service. Try again.',
      'upstream_unavailable');
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    // 401/403 from upstream means OUR credential is wrong. That is an
    // operator problem, and telling the user which credential failed would
    // describe our configuration to them.
    if (upstream.status === 401 || upstream.status === 403) {
      throw new AppError(503, 'GST verification is unavailable right now.', 'not_configured');
    }
    if (upstream.status === 404) {
      throw new AppError(404, 'No GST record found for that GSTIN.', 'gstin_not_found');
    }
    throw new AppError(502, 'The GST verification service returned an error.', 'upstream_failed');
  }

  // Appyflow signals a lookup failure in the body with HTTP 200, so the
  // body is what decides, not the status code.
  if (!payload || payload.error) {
    const msg = typeof payload?.message === 'string' ? payload.message : '';
    // Upstream messages are matched, never echoed — an upstream string is
    // not ours to put in front of a user.
    const notFound = /not\s*found|invalid|no\s*record/i.test(msg);
    throw new AppError(notFound ? 404 : 502,
      notFound ? 'No GST record found for that GSTIN.'
               : 'The GST verification service could not complete the lookup.',
      notFound ? 'gstin_not_found' : 'upstream_failed');
  }

  const info = payload.taxpayerInfo || payload.data || payload;
  if (!info || typeof info !== 'object' || !(info.lgnm || info.tradeNam || info.pradr)) {
    throw new AppError(502, 'The GST verification service returned an unexpected response.', 'upstream_failed');
  }

  res.json({ taxpayer: safeTaxpayer({ ...info, gstin: info.gstin || gstin }) });
}));

module.exports = router;
