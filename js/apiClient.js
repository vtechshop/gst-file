// =============================================
// REST API Client — replaces js/localdb.js's LocalSupabase/QueryBuilder
// as the app's `_supabase` implementation (see js/config.js). Exposes
// the EXACT same chainable surface (`from(table).select().eq()...`,
// `.insert()`, `.update()`, `.delete()`, `.auth.*`) so every page that
// only ever calls `_supabase.from(...)` keeps working with zero changes
// — this file is the only thing that changed what's behind that name.
//
// Talks to the Node.js + Express + PostgreSQL backend in server/ over a
// small, generic REST convention (server/routes/generic.js):
//   GET    /api/<table>?eq_f=v&gte_f=v&lte_f=v&order=f.asc   -> [rows]
//   POST   /api/<table>                        body=obj      -> row
//   PATCH  /api/<table>?eq_f=v...               body=patch    -> [rows]
//   DELETE /api/<table>?eq_f=v...                             -> {deletedCount}
// Every call attaches Authorization: Bearer <jwt>; the backend derives
// the authenticated user from that token and scopes every query to it —
// this file never needs to (and never should) send a user id itself.
// =============================================

const API_TOKEN_KEY = 'gst_jwt';

function getToken() { return localStorage.getItem(API_TOKEN_KEY); }
function setToken(t) { if (t) localStorage.setItem(API_TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(API_TOKEN_KEY); }

// Builds the single error shape every failure in this app is reported
// through, from a response the server rejected. Exported (window-global,
// like everything else here) because a handful of endpoints can't go
// through apiFetch — multipart uploads in js/profile.js, the polling
// scanners in js/invoice-scan.js / js/purchase-scan.js — and they must
// still produce an error the shared classifier understands rather than
// each inventing its own.
//
// `body.error` is read defensively: the API contract is
// { error: { message, code, requestId } }, but a rate-limiter or proxy
// in front of the app can still answer with plain text or an HTML error
// page, and a string must not be spread into the result (that yields
// {0:'T',1:'o',…} and a message of `undefined` — the exact bug the
// bare-string bodies in server/routes/product-sync.js used to cause).
function apiErrorFrom(res, body) {
  const raw = body && body.error;
  const fromServer = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const message = fromServer.message
    || (typeof raw === 'string' && raw.trim() ? raw.trim() : null)
    || 'Request failed (' + res.status + ')';

  // How long the client must wait before retrying, in seconds. Sent by
  // express-rate-limit as Retry-After (and RateLimit-Reset) on a 429;
  // without it the browser can only say "too many requests" and leave
  // the user guessing.
  let retryAfter = 0;
  const ra = res.headers && (res.headers.get('Retry-After') || res.headers.get('RateLimit-Reset'));
  if (ra && /^\d+$/.test(String(ra).trim())) retryAfter = parseInt(ra, 10);

  return {
    message,
    code: typeof fromServer.code === 'string' ? fromServer.code : '',
    requestId: typeof fromServer.requestId === 'string' ? fromServer.requestId : '',
    status: res.status,
    retryAfter
  };
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(API_BASE_URL + path, { ...options, headers });
  } catch {
    // The request never got a response at all (offline, server down, or the
    // browser aborted it — e.g. a page reload firing while this fetch was
    // still in flight). This is NOT the server telling us the token is bad,
    // so callers (see getSession() below) must not treat it as one.
    // `status: 0` marks "never reached the server" for classifyApiError().
    throw {
      message: 'Could not reach the server — check your connection and try again.',
      code: 'network',
      status: 0,
      networkError: true
    };
  }
  let body = null;
  try { body = await res.json(); } catch { /* e.g. 204/empty body, or a non-JSON error page */ }
  if (!res.ok) throw apiErrorFrom(res, body);
  // Paginated reads need the row count / column total the server sends
  // as headers alongside the page of rows; every other caller keeps
  // receiving just the parsed body.
  return options.withHeaders ? { body, headers: res.headers } : body;
}

class RestQueryBuilder {
  constructor(table) {
    this._table   = table;
    this._op      = 'select';
    this._filters = {};
    this._gteF    = {};
    this._lteF    = {};
    this._inF     = {};
    this._orderField = null;
    this._orderAsc   = false;
    this._isSingle   = false;
    this._payload    = null;
    this._select     = null;
  }

  // The column list IS now sent, as `select=` — server/routes/generic.js's
  // buildSelect() has always accepted it, filters it against that table's
  // allow-list and falls back to SELECT * if nothing matches, so an
  // unknown column can never reach SQL.
  //
  // This was previously dropped on purpose, because LocalSupabase returned
  // full rows regardless and a caller might read a field its projection
  // omitted. Before enabling it, every narrowed .select() call site in the
  // app was checked against the fields its caller actually reads — all of
  // them stay within their own projection. '*' and bare select() are
  // unaffected and still return full rows.
  select(cols) {
    if (this._op !== 'insert' && this._op !== 'update') this._op = 'select';
    if (typeof cols === 'string' && cols.trim() && cols.trim() !== '*') this._select = cols.trim();
    return this;
  }
  insert(d) { this._op = 'insert';  this._payload = d; return this; }
  update(d) { this._op = 'update';  this._payload = d; return this; }
  delete()  { this._op = 'delete';  return this; }

  eq(f, v)       { this._filters[f] = v; return this; }
  gte(f, v)      { this._gteF[f] = v;    return this; }
  lte(f, v)      { this._lteF[f] = v;    return this; }
  // Scopes to a set of values in one round trip (server/routes/generic.js's
  // in_<column> filter) — for tables with no date column of their own
  // (e.g. invoice_items, keyed to a parent invoice id rather than
  // carrying its own date) so a caller can filter to a known set of
  // parent ids without either fetching the whole table or firing one
  // request per id.
  in(f, values)  { this._inF[f] = values; return this; }
  order(f, opts) { this._orderField = f; this._orderAsc = opts?.ascending !== false; return this; }
  single()       { this._isSingle = true; return this; }

  // Server-side pagination. Without these a list page has to fetch every
  // row it owns and slice in the browser, which grows without bound as
  // the account does.
  limit(n)  { this._limit = n; return this; }
  offset(n) { this._offset = n; return this; }

  // Asks the server for figures over the WHOLE filtered set, not just
  // the page: a row count for the pager and a total for each named money
  // column, for a footer. Accepts one column or an array. They arrive as
  // headers, so `count` and `sums` appear on the result beside `data`.
  withTotals(sumColumns) {
    this._wantCount = true;
    this._sumColumns = !sumColumns ? [] : (Array.isArray(sumColumns) ? sumColumns : [sumColumns]);
    return this;
  }

  _filterQueryString() {
    const params = new URLSearchParams();
    Object.entries(this._filters).forEach(([f, v]) => params.append('eq_' + f, v));
    Object.entries(this._gteF).forEach(([f, v]) => params.append('gte_' + f, v));
    Object.entries(this._lteF).forEach(([f, v]) => params.append('lte_' + f, v));
    Object.entries(this._inF).forEach(([f, values]) => { if (values && values.length) params.append('in_' + f, values.join(',')); });
    if (this._orderField) params.set('order', this._orderField + '.' + (this._orderAsc ? 'asc' : 'desc'));
    if (this._select) params.set('select', this._select);
    if (this._limit)  params.set('limit', this._limit);
    if (this._offset) params.set('offset', this._offset);
    if (this._wantCount) params.set('count', 'exact');
    if (this._sumColumns && this._sumColumns.length) params.set('sum', this._sumColumns.join(','));
    return params.toString();
  }

  async _execute() {
    try {
      if (this._op === 'insert') {
        const row = await apiFetch('/' + this._table, { method: 'POST', body: JSON.stringify(this._payload) });
        return { data: row, error: null };
      }

      if (this._op === 'update') {
        const qs = this._filterQueryString();
        const rows = await apiFetch('/' + this._table + (qs ? '?' + qs : ''), { method: 'PATCH', body: JSON.stringify(this._payload) });
        return { data: rows[0] || null, error: rows.length ? null : { message: 'Record not found' } };
      }

      if (this._op === 'delete') {
        const qs = this._filterQueryString();
        await apiFetch('/' + this._table + (qs ? '?' + qs : ''), { method: 'DELETE' });
        return { data: null, error: null };
      }

      // select
      const qs = this._filterQueryString();
      if (this._wantCount || (this._sumColumns && this._sumColumns.length)) {
        const { body, headers } = await apiFetch('/' + this._table + (qs ? '?' + qs : ''), { withHeaders: true });
        let sums = {};
        try { sums = JSON.parse(headers.get('X-Total-Sums') || '{}'); } catch { sums = {}; }
        return {
          data: body,
          count: Number(headers.get('X-Total-Count') || 0),
          sums,
          error: null
        };
      }
      const rows = await apiFetch('/' + this._table + (qs ? '?' + qs : ''));
      if (this._isSingle) {
        const found = rows[0] || null;
        return { data: found, error: found ? null : { message: 'Not found', code: 'PGRST116' } };
      }
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }
}

class ApiClient {
  constructor() {
    this.auth = {
      getSession: async () => {
        if (!getToken()) return { data: { session: null }, error: null };
        try {
          const { user } = await apiFetch('/auth/me');
          return { data: { session: { user } }, error: null };
        } catch (err) {
          // Only a genuine "the server rejected this token" (401/403)
          // means the token is actually invalid — clear it so the user is
          // asked to log in again. A network failure or aborted request
          // (err.networkError, or no status at all) says nothing about
          // whether the token is still good, so it must NOT be cleared —
          // otherwise a transient connectivity blip (or a page reload
          // racing an in-flight check) would silently sign the user out
          // and force an unnecessary re-login even though their session
          // was still perfectly valid.
          // `reason` is what lets the caller tell those two cases apart —
          // js/auth.js's requireAuth() sends the user to the login page
          // for 'rejected' but keeps them where they are for 'network',
          // which is the whole point of not clearing the token above.
          if (err && (err.status === 401 || err.status === 403)) {
            clearToken();
            return { data: { session: null }, error: null, reason: 'rejected' };
          }
          return { data: { session: null }, error: null, reason: 'network' };
        }
      },
      signInWithPassword: async ({ email, password }) => {
        try {
          const { token, user } = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
          setToken(token);
          return { data: { user, session: { user } }, error: null };
        } catch (error) {
          return { data: { user: null, session: null }, error };
        }
      },
      signUp: async ({ email, password, options }) => {
        try {
          const name = options?.data?.name;
          const { token, user } = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) });
          setToken(token);
          return { data: { user, session: { user } }, error: null };
        } catch (error) {
          return { data: { user: null, session: null }, error };
        }
      },
      signOut: async () => {
        try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* token is being discarded regardless */ }
        clearToken();
        window.location.href = 'index.html';
      },
      resetPasswordForEmail: async (email) => {
        try {
          const { available, message } = await apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
          return { error: available ? null : { message } };
        } catch (error) {
          return { error };
        }
      },
      onAuthStateChange: (cb) => {
        this.auth.getSession().then(({ data }) => cb(data.session ? 'SIGNED_IN' : 'SIGNED_OUT', data.session));
        return { data: { subscription: { unsubscribe: () => {} } } };
      }
    };
  }

  from(table) {
    return new RestQueryBuilder(table);
  }
}

// =============================================
// Failure reporting — the one place that decides what a failed request
// MEANS and how it is told to the user.
//
// Everything above produces a uniform error carrying { status, code,
// message, requestId, retryAfter }. Everything below turns that into a
// toast, a severity, and (for a lost session) a redirect. Call sites
// call handleApiError() and nothing else, so the wording, colour and
// side effects of a given status are decided once here instead of being
// re-guessed in ~25 page scripts.
//
// This lives in apiClient.js rather than utils.js on purpose: apiClient
// is the only script every page loads (index.html, the login page, loads
// just this and config.js), and this must work there too.
// =============================================

// A 429/503 wants a "try again shortly" tone, a 400 wants "fix your
// input", a 500 wants "not your fault, here's a reference". Mapping them
// once, by status, is what keeps a duplicate-record conflict from being
// shouted at the user in the same red as a crashed server.
//
//   type      — the showToast() severity, i.e. the colour and dwell time.
//   showCode  — whether the numeric status is worth putting in front of
//               the user. It is for 5xx and 429, where the message alone
//               can't distinguish "the server broke" from "you were
//               throttled" and the number is what a support ticket needs.
//               It is NOT for 400/404/409, where the server already sent
//               a specific human sentence and a bare "(409)" only adds
//               noise to it.
//   session   — whether this means the session is gone and the user has
//               to be sent back to sign in.
function classifyApiError(error) {
  const err = error || {};
  const status = Number(err.status) || 0;
  const code = err.code || '';
  const message = err.message || 'Something went wrong.';

  // Never reached the server. Deliberately NOT treated as a session
  // problem — see getSession() above; the token is still perfectly good
  // and the user must not be signed out over a dropped connection.
  if (status === 0 || err.networkError || code === 'network') {
    return { type: 'warning', status, code: 'network', session: false, showCode: false, retryAfter: 0,
             message: 'Could not reach the server — check your connection and try again.' };
  }

  if (status === 401 || status === 403) {
    // Only a token that is missing/expired/rejected means "sign in
    // again". A 401 from the login form itself (invalid_credentials) is
    // a normal wrong-password answer and must not tear down the page.
    const lostSession = code === 'auth_required' || code === 'token_expired' || code === 'forbidden' || !code;
    return { type: 'warning', status, code, session: lostSession, showCode: false, retryAfter: 0,
             message: code === 'token_expired' ? 'Your session has expired — please sign in again.' : message };
  }

  if (status === 429) {
    const wait = Number(err.retryAfter) || 0;
    return { type: 'info', status, code: 'rate_limited', session: false, showCode: true, retryAfter: wait,
             message: wait
               ? `Too many requests — please try again in ${wait} second${wait === 1 ? '' : 's'}.`
               : 'Too many requests — please wait a moment and try again.' };
  }

  // The server wrote these for a human and they say what to correct, so
  // they are passed through verbatim.
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 413 || status === 422) {
    return { type: status === 404 ? 'info' : 'warning', status, code, session: false, showCode: false, retryAfter: 0, message };
  }

  // 5xx. `expose`d ones (502 upstream, 503 unconfigured/db-down) carry a
  // real explanation; a bare 500 does not, and for that one the status
  // number plus the requestId are the only actionable things the user
  // can pass on to whoever looks at the logs.
  if (status >= 500) {
    return { type: 'error', status, code, session: false, showCode: true, retryAfter: 0, message };
  }

  return { type: 'error', status, code, session: false, showCode: status >= 400, retryAfter: 0, message };
}

// The user-facing sentence for a failure, with the status code and log
// reference appended only where they earn their place (see showCode
// above). Split out from handleApiError() so the pages that report into
// an inline panel rather than a toast — index.html's sign-in errors —
// get exactly the same wording.
function describeApiError(error, context) {
  const c = classifyApiError(error);
  const lead = context ? context.replace(/[.:\s]+$/, '') + ': ' : '';
  let text = lead + c.message;
  if (c.showCode) {
    const ref = (error && error.requestId) ? `, ref ${error.requestId}` : '';
    text += ` (${c.status}${ref})`;
  }
  return text;
}

// Guards the session teardown below. Several requests firing together
// (a list page loads six tables at once) all fail 401 together; without
// this the user would get six toasts and six competing redirects.
let apiSessionEndedHandled = false;

// The single entry point every failed call site funnels into.
//
//   handleApiError(error, 'Could not save the customer')
//
// Shows one appropriately-coloured toast, adds the status code where it
// helps, and for a lost session clears the token and returns the user to
// the login page. Returns the classification so a caller that needs to
// do something extra (re-enable a button after retryAfter, focus the
// field a 400 complained about) can, without re-deriving any of it.
function handleApiError(error, context) {
  const c = classifyApiError(error);
  const text = describeApiError(error, context);

  // Always leave a full record in the console — the toast is deliberately
  // short, and the object behind it is what makes a bug report useful.
  console.error('[api]', context || '', c.status || 'network', c.code || '', error);

  if (c.session) {
    if (apiSessionEndedHandled) return c;
    apiSessionEndedHandled = true;
    clearToken();
    if (typeof showToast === 'function') showToast('Your session has expired — please sign in again.', 'warning');
    // Long enough for the message to be read before the page changes.
    // Skipped when already on the login page, where redirecting to
    // itself would just discard whatever the user was typing.
    const onLoginPage = /(^|\/)index\.html$/.test(window.location.pathname) || window.location.pathname.replace(/\/$/, '') === '';
    if (!onLoginPage) setTimeout(() => { window.location.href = 'index.html'; }, 1500);
    return c;
  }

  if (typeof showToast === 'function') showToast(text, c.type);
  return c;
}

// Runs a batch of reads and refuses to return partial data.
//
// The pattern this replaces — Promise.all([...]) followed by
// `(res.data || [])` on each result — turns a failed read into an empty
// array, which for the GST pages means a return computed from SOME of
// the invoices and presented as if it were complete. No toast, no
// console line, and nothing on screen distinguishing it from a genuinely
// quiet month. That is the worst failure this app can have, so reads
// that feed a figure go through here instead:
//
//   const rows = await readAll([q1, q2, q3], 'Could not load the return');
//   if (!rows) return;            // already reported; render nothing
//   const [a, b, c] = rows;       // every one of these is real data
//
// Returns null (having shown one toast) if ANY read failed, so the
// caller's only options are complete data or no data.
async function readAll(queries, context) {
  let results;
  try {
    results = await Promise.all(queries);
  } catch (error) {
    // A thrown rejection rather than an { error } result — the query
    // builder catches its own failures, so this is a programming error
    // or a rejected non-builder promise mixed into the batch.
    handleApiError(error, context);
    return null;
  }

  const failed = results.find(r => r && r.error);
  if (failed) { handleApiError(failed.error, context); return null; }
  return results.map(r => (r && r.data) || []);
}

// Same contract as readAll(), for a single read. Returns undefined
// (never null, which is a legitimate `.single()` result meaning "no such
// row") when the read failed and has been reported.
async function readOne(query, context) {
  const res = await query;
  if (res && res.error) { handleApiError(res.error, context); return undefined; }
  return res ? res.data : null;
}

// For a `.single()` read where "there is no such row" is an ordinary,
// expected answer — above all the duplicate-number checks the entry forms
// run before saving an invoice, a purchase or a return.
//
// Those checks are why this exists as its own helper. `.single()` reports
// "no row" as an error object (code PGRST116, see RestQueryBuilder), which
// is indistinguishable at a glance from the request having FAILED — and
// the entry forms read both the same way, as `if (dup?.id)`. So a 500, a
// dropped connection or an expired session on the duplicate check was
// silently read as "no duplicate exists" and the save went through,
// putting a second invoice on the same number into a filing. The Portal
// rejects the return, and the fix is manual.
//
// Three distinct outcomes, which the caller must keep distinct:
//   a row     — found
//   null      — genuinely no such row
//   undefined — the read FAILED and has been reported; the caller must
//               abort rather than treat it as either of the above.
async function readMaybeOne(query, context) {
  const res = await query;
  if (res && res.error) {
    if (res.error.code === 'PGRST116') return null;   // no row: a real answer
    handleApiError(res.error, context);
    return undefined;
  }
  return res ? res.data : null;
}

// Last-resort net for failures that never passed through a call site:
// an exception thrown while rendering AFTER a successful fetch, or a
// promise nobody awaited. Without this the page is left half-drawn and
// the console is clean, which reads to the user as "the app just stopped
// working" with nothing to report. Attached once per page by config.js.
function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    // A rejected API call that a call site already reported would double
    // up here; those are objects with a numeric status, so they're left
    // to the handler that owns them.
    if (reason && typeof reason === 'object' && 'status' in reason) return;
    console.error('[unhandled rejection]', reason);
    if (typeof showToast === 'function') showToast('Something went wrong on this page — please reload.', 'error');
  });
  window.addEventListener('error', (ev) => {
    // Resource load failures (a missing image) also fire this and are
    // not worth a toast; only script errors carry an `error`.
    if (!ev || !ev.error) return;
    console.error('[uncaught]', ev.error);
    if (typeof showToast === 'function') showToast('Something went wrong on this page — please reload.', 'error');
  });
}
