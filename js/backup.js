// =============================================
// Storage Status & Backup / Restore / Clear All
// Formerly the second half of js/localdb.js (which read/wrote
// localStorage directly, bypassing _supabase entirely). Same function
// names, same button wiring in profile.js/dashboard.html, same backup
// JSON file shape — now backed by server/routes/backup.js + Postgres
// instead of the browser's localStorage.
// =============================================

async function getStorageStats() {
  try {
    const backup = await apiFetch('/backup/export');
    const stats = {};
    let total = 0;
    Object.keys(backup).forEach(k => {
      if (k.startsWith('_')) return;
      stats[k] = backup[k].length;
      total += backup[k].length;
    });
    stats.total = total;
    const lastBackup = localStorage.getItem('gst_last_backup');
    stats.lastBackup = lastBackup ? new Date(lastBackup).toLocaleString('en-IN') : 'Never';
    return stats;
  } catch {
    return { b2b_invoices: 0, b2c_invoices: 0, b2b_hsn: 0, b2c_hsn: 0, total: 0, lastBackup: 'Never' };
  }
}

async function exportLocalBackup() {
  let backup;
  try {
    backup = await apiFetch('/backup/export');
  } catch (error) {
    showToast('Backup failed: ' + (error.message || 'could not reach the server'), 'error');
    return;
  }

  const tableKeys = Object.keys(backup).filter(k => !k.startsWith('_'));
  const total = tableKeys.reduce((s, k) => s + backup[k].length, 0);
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
  reader.onload = async (e) => {
    let backup;
    try {
      backup = JSON.parse(e.target.result);
      if (!backup._version) throw new Error('missing _version');
    } catch {
      showToast('Invalid or corrupted backup file!', 'error');
      return;
    }
    try {
      const { restoredCount } = await apiFetch('/backup/import', { method: 'POST', body: JSON.stringify(backup) });
      showToast(`Restored ${restoredCount} records successfully!`, 'success');
      setTimeout(() => location.reload(), 1200);
    } catch (error) {
      showToast('Restore failed: ' + (error.message || 'could not reach the server'), 'error');
    }
  };
  reader.readAsText(file);
}

async function clearAllData() {
  try {
    await apiFetch('/backup/all-data', { method: 'DELETE' });
    localStorage.removeItem('gst_last_backup');
    showToast('All data cleared!', 'warning');
    setTimeout(() => location.reload(), 1000);
  } catch (error) {
    showToast('Clear failed: ' + (error.message || 'could not reach the server'), 'error');
  }
}

async function confirmClearData() {
  const ok = await showConfirm('Clear ALL data? Invoices, HSN, Customers — everything will be deleted. This cannot be undone!');
  if (ok) clearAllData();
}

async function refreshStorageStatus() {
  const stats = await getStorageStats();
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('storeB2B',   stats.b2b_invoices   + ' records');
  setTxt('storeB2C',   stats.b2c_invoices   + ' records');
  setTxt('storeHSN',   (stats.b2b_hsn + stats.b2c_hsn) + ' records');
  setTxt('storeTotal', stats.total + ' total records');
  setTxt('storeBackup', stats.lastBackup);
  const dot = document.getElementById('storeDot');
  if (dot) dot.style.background = stats.total > 0 ? '#2e7d32' : '#9e9e9e';
}
