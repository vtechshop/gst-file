// Stock Locations — the places stock can be.
//
// Deletion is offered only where the server will actually allow it (nothing
// held, nothing in the ledger). Everywhere else the honest action is
// deactivation, and the button says so rather than failing after the click.
let locEditing = null;

async function initStockLocations() {
  await loadLocations();
}

async function loadLocations() {
  const body = document.getElementById('locationsBody');
  if (!body) return;
  try {
    const res = await apiFetch('/stock/locations');
    if (!res.rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="text-center text-muted">
        No locations yet. The first one you add becomes the default, and existing
        stock keeps working exactly as it does now until you place it.</td></tr>`;
      return;
    }
    body.innerHTML = res.rows.map(r => {
      const canDelete = +r.quantity_held === 0 && !r.is_default;
      return `<tr>
        <td><b>${escLoc(r.name)}</b>${r.is_default ? ' <span class="badge badge-success">Default</span>' : ''}</td>
        <td>${escLoc(r.code) || '—'}</td>
        <td class="text-right">${r.products_held}</td>
        <td class="text-right">${fmtLoc(r.quantity_held)}</td>
        <td><span class="badge ${r.active ? 'badge-success' : 'badge-secondary'}">${r.active ? 'Active' : 'Inactive'}</span></td>
        <td class="text-right">
          <button type="button" class="btn btn-secondary btn-sm" title="Edit"
            onclick="openLocationForm('${escLoc(r.id)}')"><i class="fas fa-pen"></i></button>
          ${r.is_default ? '' : `<button type="button" class="btn btn-secondary btn-sm" title="Make default"
            onclick="makeDefaultLocation('${escLoc(r.id)}')"><i class="fas fa-flag"></i></button>`}
          <button type="button" class="btn btn-secondary btn-sm" title="${r.active ? 'Deactivate' : 'Activate'}"
            onclick="toggleLocationActive('${escLoc(r.id)}', ${r.active ? 'false' : 'true'})">
            <i class="fas fa-power-off"></i></button>
          ${canDelete ? `<button type="button" class="btn btn-danger btn-sm" title="Delete"
            onclick="deleteLocation('${escLoc(r.id)}')"><i class="fas fa-trash"></i></button>` : ''}
        </td>
      </tr>`;
    }).join('');
    window._locations = res.rows;
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Could not load locations.</td></tr>';
    handleApiError(err, 'loading stock locations');
  }
}

function openLocationForm(id) {
  locEditing = id || null;
  showLocError('');
  const row = id && (window._locations || []).find(r => r.id === id);
  document.getElementById('locationModalTitle').innerHTML =
    `<i class="fas fa-map-location-dot"></i> ${id ? 'Edit Location' : 'Add Location'}`;
  document.getElementById('locName').value = row ? row.name : '';
  document.getElementById('locCode').value = row ? (row.code || '') : '';
  const def = document.getElementById('locDefault');
  def.checked = row ? !!row.is_default : false;
  // Unsetting the default here would leave the business without one, so the
  // box is only offered when it would actually change something.
  def.disabled = !!(row && row.is_default);
  document.getElementById('locationModal').classList.add('active');
}
function closeLocationForm() { document.getElementById('locationModal').classList.remove('active'); }

async function saveLocation() {
  const name = (document.getElementById('locName').value || '').trim();
  const code = (document.getElementById('locCode').value || '').trim();
  const isDefault = document.getElementById('locDefault').checked;
  if (!name) return showLocError('A location name is required.');

  const btn = document.getElementById('locSave');
  btn.disabled = true;
  try {
    const body = { name, code: code || null };
    if (isDefault) body.is_default = true;
    if (locEditing) await apiFetch('/stock/locations/' + encodeURIComponent(locEditing),
      { method: 'PATCH', body: JSON.stringify(body) });
    else await apiFetch('/stock/locations', { method: 'POST', body: JSON.stringify(body) });
    closeLocationForm();
    showToast(locEditing ? 'Location updated.' : 'Location added.', 'success');
    await loadLocations();
  } catch (err) {
    showLocError(err && err.message ? err.message : 'Could not save the location.');
  } finally { btn.disabled = false; }
}

async function makeDefaultLocation(id) {
  try {
    await apiFetch('/stock/locations/' + encodeURIComponent(id),
      { method: 'PATCH', body: JSON.stringify({ is_default: true }) });
    showToast('Default location changed.', 'success');
    await loadLocations();
  } catch (err) { handleApiError(err, 'changing the default location'); }
}

async function toggleLocationActive(id, active) {
  try {
    await apiFetch('/stock/locations/' + encodeURIComponent(id),
      { method: 'PATCH', body: JSON.stringify({ active }) });
    showToast(active ? 'Location activated.' : 'Location deactivated.', 'success');
    await loadLocations();
  } catch (err) {
    // The server refuses to deactivate the default; show its reason as it is.
    showToast(err && err.message ? err.message : 'Could not change the location.', 'error');
  }
}

async function deleteLocation(id) {
  const ok = await showConfirm(
    'Delete this location? This is only possible because it holds no stock and has never appeared in the ledger.');
  if (!ok) return;
  try {
    await apiFetch('/stock/locations/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Location deleted.', 'success');
    await loadLocations();
  } catch (err) {
    showToast(err && err.message ? err.message : 'Could not delete the location.', 'error');
  }
}

function showLocError(message) {
  const el = document.getElementById('locError');
  if (!el) return;
  if (!message) { el.classList.add('d-none'); el.textContent = ''; return; }
  el.classList.remove('d-none');
  el.textContent = message;
}
function fmtLoc(v) {
  if (v === null || v === undefined || v === '') return '0';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
}
function escLoc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
