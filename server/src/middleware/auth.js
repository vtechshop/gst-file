// Verifies the JWT on every protected request and attaches req.userId —
// every downstream route filters its SQL by this value, never by
// anything the client sends in the body/query, so one user can never
// read or write another user's rows.
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { message: 'Please sign in to continue.', code: 'auth_required' } });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (err) {
    // Expiry is called out with its own code because it is the ONLY
    // benign case here — the token was genuinely ours and simply aged
    // out (JWT_EXPIRES_IN, 7d by default), which happens routinely to a
    // page left open overnight. The browser tells the user their session
    // ended and sends them to sign in again; see handleApiError() in
    // js/apiClient.js. Anything else (wrong signature, malformed token)
    // is not routine and gets the neutral message rather than one that
    // would confirm to a would-be forger which part they got wrong.
    const expired = err && err.name === 'TokenExpiredError';
    res.status(401).json({
      error: expired
        ? { message: 'Your session has expired — please sign in again.', code: 'token_expired' }
        : { message: 'Please sign in to continue.', code: 'auth_required' }
    });
  }
}

module.exports = { requireAuth };
