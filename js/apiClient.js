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
    throw { message: 'Could not reach the server. Is it running?', networkError: true };
  }
  let body = null;
  try { body = await res.json(); } catch { /* e.g. 204/empty body */ }
  if (!res.ok) throw { ...((body && body.error) || { message: 'Request failed (' + res.status + ')' }), status: res.status };
  return body;
}

class RestQueryBuilder {
  constructor(table) {
    this._table   = table;
    this._op      = 'select';
    this._filters = {};
    this._gteF    = {};
    this._lteF    = {};
    this._orderField = null;
    this._orderAsc   = false;
    this._isSingle   = false;
    this._payload    = null;
  }

  // Column-projection argument is intentionally not sent to the server
  // — LocalSupabase always returned full rows regardless of what
  // .select(cols) was called with, and every page in this app was
  // built and tested against that. Matching it exactly here avoids a
  // silent regression where some caller expected a field that a
  // narrower projection would have dropped.
  select()  { if (this._op !== 'insert' && this._op !== 'update') this._op = 'select'; return this; }
  insert(d) { this._op = 'insert';  this._payload = d; return this; }
  update(d) { this._op = 'update';  this._payload = d; return this; }
  delete()  { this._op = 'delete';  return this; }

  eq(f, v)       { this._filters[f] = v; return this; }
  gte(f, v)      { this._gteF[f] = v;    return this; }
  lte(f, v)      { this._lteF[f] = v;    return this; }
  order(f, opts) { this._orderField = f; this._orderAsc = opts?.ascending !== false; return this; }
  single()       { this._isSingle = true; return this; }

  _filterQueryString() {
    const params = new URLSearchParams();
    Object.entries(this._filters).forEach(([f, v]) => params.append('eq_' + f, v));
    Object.entries(this._gteF).forEach(([f, v]) => params.append('gte_' + f, v));
    Object.entries(this._lteF).forEach(([f, v]) => params.append('lte_' + f, v));
    if (this._orderField) params.set('order', this._orderField + '.' + (this._orderAsc ? 'asc' : 'desc'));
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
          if (err && (err.status === 401 || err.status === 403)) clearToken();
          return { data: { session: null }, error: null };
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
