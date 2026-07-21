// Image upload for logo/seal/signature/QR (js/profile.js's Settings
// modal) — returns a base64 data URL, stored as-is in profiles'
// logo_base64/seal_base64/etc. columns. One generic endpoint serves
// all four image slots; which slot it's for is caller-side bookkeeping
// only (which hidden input the returned value gets written into),
// never branched on server-side.
const express = require('express');
const multer = require('multer');
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

  const url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  res.json({ url });
}));

module.exports = router;
