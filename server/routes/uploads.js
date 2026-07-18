// Cloudinary image upload — replaces storing logo/seal/signature/QR as
// base64 directly in Postgres (js/profile.js's Settings modal). One
// generic endpoint serves all four image slots; which slot it's for is
// caller-side bookkeeping only (which hidden input the returned URL
// gets written into), never branched on server-side.
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Same 500KB limit js/profile.js's handleImageUpload() already checks
// client-side — enforced again here since the client-side check alone
// is trivially bypassable (a direct API call, a modified request).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 } });

function isCloudinaryConfigured() {
  return !!process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_CLOUD_NAME !== 'your-cloud-name';
}

router.post('/image', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { message: 'Image too large — please use a file under 500KB.' } });
    }
    next(err);
  });
}, asyncRoute(async (req, res) => {
  if (!req.file) { const e = new Error('No image file provided.'); e.status = 400; e.expose = true; throw e; }
  if (!isCloudinaryConfigured()) {
    const e = new Error('Image upload is not configured on the server yet — add CLOUDINARY_* to server/.env.');
    e.status = 503; e.expose = true; throw e;
  }

  const url = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `gst-invoicing/${req.userId}`, resource_type: 'image' },
      (error, result) => error ? reject(error) : resolve(result.secure_url)
    );
    stream.end(req.file.buffer);
  });

  res.json({ url });
}));

module.exports = router;
