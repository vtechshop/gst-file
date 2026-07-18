// Verifies the JWT on every protected request and attaches req.userId —
// every downstream route filters its SQL by this value, never by
// anything the client sends in the body/query, so one user can never
// read or write another user's rows.
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: { message: 'Missing Authorization header' } });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: { message: 'Invalid or expired token' } });
  }
}

module.exports = { requireAuth };
