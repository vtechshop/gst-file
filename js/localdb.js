// =============================================
// Local Database – localStorage fallback
// Works fully offline without Supabase
// =============================================

const LOCAL_USER = {
  id: 'local-demo-user-001',
  email: 'demo@gstapp.local',
  user_metadata: { name: 'GST Manager' }
};

class QueryBuilder {
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

  select()  { if (this._op !== 'insert' && this._op !== 'update') this._op = 'select'; return this; }
  insert(d) { this._op = 'insert';  this._payload = d; return this; }
  update(d) { this._op = 'update';  this._payload = d; return this; }
  delete()  { this._op = 'delete';  return this; }

  eq(f, v)       { this._filters[f] = v; return this; }
  gte(f, v)      { this._gteF[f] = v;    return this; }
  lte(f, v)      { this._lteF[f] = v;    return this; }
  order(f, opts) { this._orderField = f; this._orderAsc = opts?.ascending !== false; return this; }
  single()       { this._isSingle = true; return this; }

  _getAll() {
    try { return JSON.parse(localStorage.getItem('gst_' + this._table) || '[]'); }
    catch { return []; }
  }

  _saveAll(data) {
    localStorage.setItem('gst_' + this._table, JSON.stringify(data));
  }

  async _execute() {
    let records = this._getAll();

    // INSERT — keep existing id if payload already has one (e.g. profiles)
    if (this._op === 'insert') {
      const rec = {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...this._payload,
        id: this._payload.id || crypto.randomUUID()
      };
      records.push(rec);
      this._saveAll(records);
      return { data: rec, error: null };
    }

    // UPDATE — match by all eq filters
    if (this._op === 'update') {
      let filtered = [...records];
      Object.entries(this._filters).forEach(([f, v]) => {
        filtered = filtered.filter(r => String(r[f]) === String(v));
      });
      if (filtered.length === 0) return { data: null, error: { message: 'Record not found' } };
      const updatedIds = new Set(filtered.map(r => r.id));
      const updated = records.map(r => updatedIds.has(r.id)
        ? { ...r, ...this._payload, updated_at: new Date().toISOString() }
        : r
      );
      this._saveAll(updated);
      return { data: updated.find(r => updatedIds.has(r.id)), error: null };
    }

    // DELETE — match by all eq filters (not just id)
    if (this._op === 'delete') {
      let filtered = [...records];
      Object.entries(this._filters).forEach(([f, v]) => {
        filtered = filtered.filter(r => String(r[f]) === String(v));
      });
      const deletedIds = new Set(filtered.map(r => r.id));
      this._saveAll(records.filter(r => !deletedIds.has(r.id)));
      return { data: null, error: null };
    }

    // SELECT – apply all filters
    let result = [...records];

    Object.entries(this._filters).forEach(([f, v]) => {
      result = result.filter(r => String(r[f]) === String(v));
    });
    Object.entries(this._gteF).forEach(([f, v]) => {
      result = result.filter(r => (r[f] ?? '') >= v);
    });
    Object.entries(this._lteF).forEach(([f, v]) => {
      result = result.filter(r => (r[f] ?? '') <= v);
    });

    if (this._orderField) {
      const fld = this._orderField;
      const asc = this._orderAsc;
      result.sort((a, b) => {
        const va = a[fld] ?? '', vb = b[fld] ?? '';
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return asc ? cmp : -cmp;
      });
    }

    if (this._isSingle) {
      const found = result[0] || null;
      return { data: found, error: found ? null : { message: 'Not found', code: 'PGRST116' } };
    }

    return { data: result, error: null };
  }

  // Makes QueryBuilder awaitable
  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }
}

class LocalSupabase {
  constructor() {
    this.auth = {
      getSession: async () => ({
        data: { session: { user: LOCAL_USER } },
        error: null
      }),
      signOut: async () => {
        window.location.href = 'index.html';
      },
      signInWithPassword: async () => ({
        data: { user: LOCAL_USER, session: { user: LOCAL_USER } },
        error: null
      }),
      signUp: async () => ({
        data: { user: LOCAL_USER },
        error: null
      }),
      resetPasswordForEmail: async () => ({ error: null }),
      onAuthStateChange: (cb) => {
        setTimeout(() => cb('SIGNED_IN', { user: LOCAL_USER }), 0);
        return { data: { subscription: { unsubscribe: () => {} } } };
      }
    };
  }

  from(table) {
    return new QueryBuilder(table);
  }
}

// =============================================
// Storage Status & Backup / Restore
// =============================================
const DB_TABLES = ['b2b_invoices', 'b2c_invoices', 'b2b_hsn', 'b2c_hsn', 'customers', 'cdn_notes', 'products', 'import_mappings', 'invoice_items'];

function getStorageStats() {
  const stats = {};
  let total = 0;
  DB_TABLES.forEach(t => {
    const rows = JSON.parse(localStorage.getItem('gst_' + t) || '[]').length;
    stats[t] = rows;
    total += rows;
  });
  stats.total = total;
  const lastBackup = localStorage.getItem('gst_last_backup');
  stats.lastBackup = lastBackup ? new Date(lastBackup).toLocaleString('en-IN') : 'Never';
  return stats;
}

function exportLocalBackup() {
  const backup = { _version: '1.0', _exported_at: new Date().toISOString() };
  DB_TABLES.forEach(t => {
    backup[t] = JSON.parse(localStorage.getItem('gst_' + t) || '[]');
  });
  const total = DB_TABLES.reduce((s,t) => s + backup[t].length, 0);
  if (total === 0) { showToast('No data to backup!', 'warning'); return; }

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `GST_Backup_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  localStorage.setItem('gst_last_backup', new Date().toISOString());
  showToast(`Backup saved! (${total} records)`, 'success');
  refreshStorageStatus();
}

function importLocalBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup._version) { showToast('Invalid backup file!', 'error'); return; }
      let count = 0;
      DB_TABLES.forEach(t => {
        if (Array.isArray(backup[t])) {
          localStorage.setItem('gst_' + t, JSON.stringify(backup[t]));
          count += backup[t].length;
        }
      });
      showToast(`Restored ${count} records successfully!`, 'success');
      setTimeout(() => location.reload(), 1200);
    } catch {
      showToast('Invalid or corrupted backup file!', 'error');
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  DB_TABLES.forEach(t => localStorage.removeItem('gst_' + t));
  localStorage.removeItem('gst_last_backup');
  showToast('All data cleared!', 'warning');
  setTimeout(() => location.reload(), 1000);
}

async function confirmClearData() {
  const ok = await showConfirm('Clear ALL data? Invoices, HSN, Customers — everything will be deleted. This cannot be undone!');
  if (ok) clearAllData();
}

function refreshStorageStatus() {
  const stats = getStorageStats();
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('storeB2B',   stats.b2b_invoices   + ' records');
  setTxt('storeB2C',   stats.b2c_invoices   + ' records');
  setTxt('storeHSN',   (stats.b2b_hsn + stats.b2c_hsn) + ' records');
  setTxt('storeTotal', stats.total + ' total records');
  setTxt('storeBackup', stats.lastBackup);
  const dot = document.getElementById('storeDot');
  if (dot) dot.style.background = stats.total > 0 ? '#2e7d32' : '#9e9e9e';
}
