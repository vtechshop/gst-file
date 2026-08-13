// Image upload for logo/seal/signature/QR (js/profile.js's Settings
// modal). The image is written straight into the caller's own profile
// row and only a confirmation comes back.
//
// It used to return the file to the browser as a base64 data URL, which
// the Settings form then put in a hidden input and sent back in
// PATCH /profiles. A 500KB image is about 667KB of base64 — far past the
// JSON body limit — so the upload appeared to succeed and the save that
// followed failed with 413 Content Too Large. Round-tripping the file
// through the browser was never necessary: the request already has the
// bytes, and it already knows who is asking.
//
// The multipart request itself is not subject to express.json()'s limit;
// multer's own 500KB limit governs it, which is why this route can carry
// an image that the JSON body limit would refuse.
//
// Which of the four slots is being filled is named by the caller. It is
// checked against a fixed map rather than interpolated, so `slot` can
// never reach SQL as anything but one of four known column names.
const express = require('express');
const multer = require('multer');
const pool = require('../config/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

// Same 500KB limit js/profile.js's handleImageUpload() already checks
// client-side — enforced again here since the client-side check alone
// is trivially bypassable (a direct API call, a modified request).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

// slot -> column. A fixed map, never interpolated from user input.
const IMAGE_SLOTS = {
  logo: 'logo_base64',
  seal: 'seal_base64',
  signature: 'signature_base64',
  qr: 'qr_base64'
};

router.post('/image', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { message: 'Image too large — please use a file under 500KB.' } });
    }
    next(err);
  });
}, asyncRoute(async (req, res) => {
  if (!req.file) { const e = new Error('No image file provided — must be an image.'); e.status = 400; e.expose = true; throw e; }

  const slot = String((req.body && req.body.slot) || '').trim().toLowerCase();
  const column = IMAGE_SLOTS[slot];
  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

  // No slot named: behave as before and hand the image back. Nothing in
  // this application does that any more, but an older cached copy of the
  // Settings page might, and it should keep working rather than break.
  if (!column) return res.json({ url: dataUrl });

  // Scoped to req.userId from the verified token — never to anything the
  // client sent — so one company can never write another's branding.
  await pool.query(
    `INSERT INTO profiles (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [req.userId]
  );
  await pool.query(
    `UPDATE profiles SET ${column} = $1 WHERE id = $2`,
    [dataUrl, req.userId]
  );

  // Deliberately no image in the response. The browser already has the
  // file it just picked and shows that as the preview; sending it back
  // is what created the oversized save in the first place.
  res.json({ stored: true, slot });
}));

module.exports = router;
