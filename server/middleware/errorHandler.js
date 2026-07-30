// Centralized error → JSON response. Route handlers can either throw
// (caught by asyncRoute below) or call next(err) directly; either way
// the client always gets a consistent { error: { message } } shape and
// nothing about the underlying DB error (constraint names, SQL, stack)
// leaks into the response.
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function errorHandler(err, req, res, next) {
  console.error(err);

  // Postgres unique-violation — surface as a 409 with a clear message
  // rather than a generic 500 (the generic CRUD router and the
  // partial-unique invoice-number index both rely on this).
  if (err && err.code === '23505') {
    return res.status(409).json({ error: { message: 'A record with that value already exists.' } });
  }
  // Postgres foreign-key violation (e.g. deleting a row something else references).
  if (err && err.code === '23503') {
    return res.status(409).json({ error: { message: 'This record is referenced by other data and cannot be changed.' } });
  }

  const status = err.status || 500;
  res.status(status).json({ error: { message: err.expose ? err.message : 'Something went wrong on the server.' } });
}

module.exports = { asyncRoute, errorHandler };
