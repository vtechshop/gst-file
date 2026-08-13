// Centralized error → JSON response. Route handlers can either throw
// (caught by asyncRoute below) or call next(err) directly; either way
// the client always gets the SAME response shape and nothing about the
// underlying DB error (constraint names, SQL, stack) leaks into it:
//
//   { error: { message, code, requestId } }
//
//   message   — safe to show a user verbatim. Either the route's own
//               `expose`d message, or a generic line for anything that
//               wasn't deliberately written for human eyes.
//   code      — stable machine-readable slug (never a human sentence),
//               so the browser can branch on the KIND of failure without
//               string-matching a message that may be reworded later.
//               js/apiClient.js's classifyApiError() reads this.
//   requestId — short id printed on the same line as the server-side
//               stack trace and echoed to the client, so a user reporting
//               "it said server error, ref a1b2c3d4" can be matched to an
//               exact log entry. Only meaningful for 5xx (the ones where
//               the message itself has to stay vague), but sent always.
//
// Every field here is ADDITIVE — the pre-existing { error: { message } }
// contract is unchanged, so any caller that only reads `.message` keeps
// working untouched.
const crypto = require('crypto');

// Slug used when a route throws without naming one. Chosen per status so
// even legacy `e.status = 400; e.expose = true` throws (there are dozens
// across routes/, all predating AppError) still arrive at the browser
// with a usable code and need no edit.
const CODE_BY_STATUS = {
  400: 'bad_request',
  401: 'auth_required',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'validation_failed',
  429: 'rate_limited',
  500: 'server_error',
  502: 'upstream_failed',
  503: 'unavailable'
};

function codeForStatus(status) {
  return CODE_BY_STATUS[status] || (status >= 500 ? 'server_error' : 'request_failed');
}

// The one way routes should raise a client-visible failure from here on.
// `expose` is implicit — if you're constructing an AppError you have
// already decided the message is fit for a user to read. Plain
// `new Error()` (or anything thrown by pg/node) stays unexposed and is
// reported as a generic 500, which is the safe default.
class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || codeForStatus(status);
    this.expose = true;
  }
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// A per-field validation map is only worth putting on the wire if it is
// exactly that: a plain object whose every value is a non-empty string.
// Anything else — an array, a nested object, an Error — is refused rather
// than serialised, because the whole point of the envelope is that the
// browser never receives a shape the server did not deliberately choose.
function isFieldMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(k => typeof value[k] === 'string' && value[k].trim());
}

// Postgres SQLSTATEs that are really the CLIENT's fault, not ours, and
// so must not be reported as a 500 the user can only shrug at. Mapped to
// a status + a message that says what to do about it.
const PG_ERRORS = {
  // unique_violation — the generic CRUD router and the partial-unique
  // invoice-number index both rely on this becoming a 409.
  '23505': [409, 'A record with that value already exists.', 'duplicate'],
  // foreign_key_violation — e.g. deleting a row something else references.
  '23503': [409, 'This record is referenced by other data and cannot be changed.', 'in_use'],
  // not_null_violation — a required column arrived empty.
  '23502': [400, 'A required field is missing.', 'missing_field'],
  // check_violation — a column constraint rejected the value.
  '23514': [400, 'One of the values is outside the allowed range.', 'invalid_value'],
  // invalid_text_representation — e.g. a malformed uuid or a number
  // field that got sent a word. Previously a bare 500.
  '22P02': [400, 'One of the values is not in the expected format.', 'invalid_value'],
  // numeric_value_out_of_range / string_data_right_truncation — a value
  // too large for its column.
  '22003': [400, 'A number is too large for that field.', 'invalid_value'],
  '22001': [400, 'One of the values is too long.', 'invalid_value']
};

// The database being unreachable is a 503 the user can act on ("try
// again in a moment"), not an opaque 500 — and it must never be
// mistaken for a bug in the request they just made.
const DB_DOWN = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH']);

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const requestId = crypto.randomBytes(4).toString('hex');

  // One log line per failure, always carrying the requestId and the
  // route — this is the half of the correlation the client's "ref
  // a1b2c3d4" is matched against, so it has to be logged even for the
  // 4xx cases that are perfectly ordinary.
  const where = `${req.method} ${req.originalUrl}`;
  console.error(`[${requestId}] ${where} —`, err && err.stack ? err.stack : err);

  // Already-sent responses (a stream that failed mid-flight, e.g. a
  // backup zip) can't be given a JSON body — Express would throw
  // ERR_HTTP_HEADERS_SENT on top of the original error and lose it.
  if (res.headersSent) return;

  const pg = err && PG_ERRORS[err.code];
  if (pg) {
    const [status, message, code] = pg;
    return res.status(status).json({ error: { message, code, requestId } });
  }

  if (err && DB_DOWN.has(err.code)) {
    return res.status(503).json({
      error: {
        message: 'The database is temporarily unreachable. Please try again in a moment.',
        code: 'db_unavailable',
        requestId
      }
    });
  }

  // Payload limits are enforced by express.json()/multer, which throw
  // their own error types rather than anything with `expose` set.
  if (err && (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE')) {
    return res.status(413).json({ error: { message: 'That upload is too large.', code: 'payload_too_large', requestId } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'The request body was not valid JSON.', code: 'bad_request', requestId } });
  }

  const status = err && err.status ? err.status : 500;
  const message = err && err.expose ? err.message : 'Something went wrong on the server.';
  // Only a deliberately-exposed error is trusted to name its own code.
  // Anything else (a pg SQLSTATE that isn't in PG_ERRORS, a node system
  // error code like ERR_INVALID_ARG_TYPE) gets the status-derived slug
  // instead, so no internal identifier reaches the browser.
  const code = (err && err.expose && typeof err.code === 'string' && !/^\d/.test(err.code))
    ? err.code
    : codeForStatus(status);
  const body = { message, code, requestId };
  // A per-field complaint map, when the thrower deliberately exposed one
  // (see runValidate() in routes/generic.js). Only ever added to an
  // `expose`d error and only when it is a plain object of strings, so an
  // internal error can never leak structure here; every response that did
  // not carry one is byte-identical to before.
  if (err && err.expose && isFieldMap(err.fields)) body.fields = err.fields;
  res.status(status).json({ error: body });
}

module.exports = { asyncRoute, errorHandler, AppError, codeForStatus };
