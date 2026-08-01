// =============================================
// Upload plumbing shared by both document scanners: the size cap, the
// multer instance, the money-spending rate limit, and the one-line-per-
// scan log.
//
// Kept together because these four are the parts that must stay
// identical between scanners — a limit that applies to bills but not
// invoices would just be a hole. Only the accepted MIME list differs,
// so that is the parameter.
// =============================================
const multer = require('multer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const MAX_FILES = parseInt(process.env.GEMINI_SCAN_MAX_FILES) || 10;

// Tighter than the global /api limiter (600 per 15 min), because every
// call downstream of this costs real money at Google. A human scanning
// documents one at a time never comes close; a runaway loop or a stolen
// token hits it almost immediately.
function makeScanLimiter(what) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.GEMINI_SCAN_LIMIT) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    // requireAuth runs first, so req.userId is always present in
    // practice; the IP fallback goes through ipKeyGenerator because a
    // raw req.ip would let an IPv6 client hop addresses within its own
    // /64 and evade the limit entirely.
    keyGenerator: req => req.userId || ipKeyGenerator(req.ip),
    message: { error: { message: `Too many ${what} scans in a short time. Please wait a few minutes.` } }
  });
}

function makeUploader(acceptedMime) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_SCAN_BYTES, files: MAX_FILES },
    fileFilter: (req, file, cb) => cb(null, acceptedMime.includes(file.mimetype))
  });
}

// One line per scan: how long it took, which model, and whether it
// worked. Enough to answer "is the scanner slow / failing / which model
// is production actually on" from the Render logs without turning on
// anything heavier. Deliberately records no document content — only
// each file's type and size, never its bytes or anything extracted
// from it.
function logScan(label, req, model, started, outcome, extra = '') {
  const ms = Date.now() - started;
  const files = req.files || (req.file ? [req.file] : []);
  const desc = files.length
    ? files.map(f => `${Math.round(f.size / 1024)}KB ${f.mimetype}`).join(',')
    : 'no-file';
  console.log(`[${label}] user=${req.userId} model=${model} ${desc} ${ms}ms ${outcome}${extra ? ' ' + extra : ''}`);
}

module.exports = { MAX_SCAN_BYTES, MAX_FILES, makeScanLimiter, makeUploader, logScan };
