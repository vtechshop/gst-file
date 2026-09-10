// Entering and choosing serial numbers on a document line.
//
// One panel serves both grids because the job is the same on each: a
// serial-tracked line needs exactly as many numbers as its quantity, and
// the person filling it in needs to see at a glance whether it has them.
// A purchase TYPES numbers in (the goods have just arrived and the numbers
// are on the boxes); a sale PICKS from what is available. Both end up as
// an array of strings on the row, which is what the save path sends.
//
// The server refuses a wrong count independently. Nothing here is the
// enforcement — it is what stops the person discovering the problem after
// they press Save.

let serialPanelRow = null;      // the row object being edited
let serialPanelOnDone = null;   // called with the finished array
let serialPanelMode = 'entry';  // 'entry' for purchases, 'select' for sales
let serialPanelAvailable = [];

function escSerial(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Products this tenant tracks by serial. Cached for the life of the page:
// the answer changes when someone edits a product, not while a document is
// being typed.
let _serialTrackedIds = null;
async function serialTrackedIds() {
  if (_serialTrackedIds) return _serialTrackedIds;
  try {
    const rows = await apiFetch('/products?select=id,serial_tracking');
    _serialTrackedIds = new Set((rows || []).filter(r => r.serial_tracking).map(r => r.id));
  } catch {
    // A failed lookup must not block document entry; the server still
    // refuses a serial-tracked line with no serials, so the worst case is
    // a clear error on save rather than a silently unserialised delivery.
    _serialTrackedIds = new Set();
  }
  return _serialTrackedIds;
}

const isSerialTracked = async (productId) =>
  !!productId && (await serialTrackedIds()).has(productId);

// What the grid cell shows for a line: how many of the needed numbers are
// present, so a short line is obvious without opening anything.
function serialCellHtml(row) {
  const have = Array.isArray(row.serials) ? row.serials.length : 0;
  const need = Math.round(Number(row.quantity) || 0);
  const ok = have === need && need > 0;
  return `<button type="button" class="btn ${ok ? 'btn-success' : 'btn-secondary'} btn-sm"
    onclick="openSerialPanel('${escSerial(row.rowId)}')">
    <i class="fas fa-barcode"></i> ${have}/${need}</button>`;
}

// ── The panel ─────────────────────────────────────────────────────────
async function openSerialPanel(rowId, opts) {
  const o = opts || {};
  const rows = o.rows || (typeof purchItems !== 'undefined' ? purchItems : currentItems);
  const row = rows.find(r => r.rowId === rowId);
  if (!row) return;
  serialPanelRow = row;
  serialPanelMode = o.mode || (typeof purchItems !== 'undefined' ? 'entry' : 'select');
  serialPanelOnDone = o.onDone || null;

  const need = Math.round(Number(row.quantity) || 0);
  document.getElementById('serialPanelTitle').textContent =
    `${row.product_name || 'Product'} — ${need} serial number${need === 1 ? '' : 's'}`;

  if (serialPanelMode === 'select') {
    // Which units this document may pick from. A sale offers what is
    // available; a return may offer ONLY the units its own document
    // covers — the ones that invoice sold, or that purchase received.
    // Offering by product alone would show a unit from another delivery
    // or another customer's invoice, which the save would then refuse.
    const query = o.query
      || `status=AVAILABLE&product_id=${encodeURIComponent(row.product_id)}`;
    try {
      const res = await apiFetch(`/stock/serials?limit=500&${query}`);
      serialPanelAvailable = (res.rows || []).map(r => r.serial_no);
    } catch (err) {
      serialPanelAvailable = [];
      handleApiError(err, 'loading serial numbers');
    }
    for (const s of (row.serials || [])) {
      if (!serialPanelAvailable.some(v => v.toUpperCase() === s.toUpperCase())) {
        serialPanelAvailable.unshift(s);
      }
    }
  }

  renderSerialPanel();
  document.getElementById('serialPanel')?.classList.add('open');
  if (typeof lockBodyScroll === 'function') lockBodyScroll();
  setTimeout(() => document.getElementById('serialPanelInput')?.focus(), 50);
}

function renderSerialPanel() {
  const row = serialPanelRow;
  if (!row) return;
  const chosen = Array.isArray(row.serials) ? row.serials : [];
  const need = Math.round(Number(row.quantity) || 0);
  const body = document.getElementById('serialPanelBody');
  const count = document.getElementById('serialPanelCount');

  count.innerHTML = chosen.length === need
    ? `<span class="badge badge-success">${chosen.length} of ${need}</span>`
    : `<span class="badge badge-warning">${chosen.length} of ${need}</span>`;

  if (serialPanelMode === 'select') {
    body.innerHTML = serialPanelAvailable.length
      ? serialPanelAvailable.map(s => {
        const on = chosen.some(v => v.toUpperCase() === s.toUpperCase());
        return `<label class="checkbox-label serial-pick">
          <input type="checkbox" ${on ? 'checked' : ''}
            onchange="toggleSerialPick('${escSerial(s)}')"> ${escSerial(s)}</label>`;
      }).join('')
      : '<p class="text-muted-sm">No units of this product are available to sell.</p>';
    return;
  }

  body.innerHTML = chosen.length
    ? chosen.map((s, i) => `<div class="mini-list-row">
        <span>${escSerial(s)}</span>
        <button type="button" class="btn btn-danger btn-sm" onclick="removeSerialAt(${i})"
          aria-label="Remove ${escSerial(s)}"><i class="fas fa-times"></i></button>
      </div>`).join('')
    : '<p class="text-muted-sm">Scan or type a serial number and press Enter.</p>';
}

// A barcode scanner is a keyboard that types fast and finishes with Enter,
// so it needs nothing special: one handler serves both it and a person.
function serialPanelKey(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addSerialFromInput();
}

function addSerialFromInput() {
  const input = document.getElementById('serialPanelInput');
  if (!input || !serialPanelRow) return;
  // Pasting a column from a spreadsheet or a comma-separated list adds all
  // of them at once, which is how a delivery note actually arrives.
  const parts = String(input.value || '').split(/[\n,;\t]+/).map(v => v.trim()).filter(Boolean);
  if (!parts.length) return;

  const chosen = Array.isArray(serialPanelRow.serials) ? [...serialPanelRow.serials] : [];
  const need = Math.round(Number(serialPanelRow.quantity) || 0);
  const problems = [];
  for (const value of parts) {
    if (chosen.some(v => v.toUpperCase() === value.toUpperCase())) {
      problems.push(`"${value}" is already on this line`); continue;
    }
    if (chosen.length >= need) {
      problems.push(`"${value}" would make ${chosen.length + 1}, more than the ${need} received`);
      continue;
    }
    chosen.push(value);
  }
  serialPanelRow.serials = chosen;
  input.value = '';
  renderSerialPanel();
  serialPanelNote(problems.join('. '));
}

function removeSerialAt(index) {
  if (!serialPanelRow) return;
  const chosen = [...(serialPanelRow.serials || [])];
  chosen.splice(index, 1);
  serialPanelRow.serials = chosen;
  renderSerialPanel();
  serialPanelNote('');
}

function toggleSerialPick(value) {
  if (!serialPanelRow) return;
  const chosen = [...(serialPanelRow.serials || [])];
  const at = chosen.findIndex(v => v.toUpperCase() === value.toUpperCase());
  const need = Math.round(Number(serialPanelRow.quantity) || 0);
  if (at >= 0) chosen.splice(at, 1);
  else if (chosen.length >= need) {
    serialPanelNote(`This line sells ${need}. Unpick one before choosing another.`);
    renderSerialPanel();
    return;
  } else chosen.push(value);
  serialPanelRow.serials = chosen;
  renderSerialPanel();
  serialPanelNote('');
}

function serialPanelNote(text) {
  const el = document.getElementById('serialPanelNote');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('d-none', !text);
}

function closeSerialPanel() {
  document.getElementById('serialPanel')?.classList.remove('open');
  if (typeof unlockBodyScroll === 'function') unlockBodyScroll();
  if (serialPanelOnDone) serialPanelOnDone(serialPanelRow);
  serialPanelRow = null;
  serialPanelOnDone = null;
  serialPanelNote('');
}

// Called by a document's own validation before it saves. Returns a
// sentence naming the first short line, or null when every serial-tracked
// line has exactly the numbers it needs.
async function serialLinesProblem(rows) {
  const tracked = await serialTrackedIds();
  for (const [i, r] of (rows || []).entries()) {
    if (!r.product_id || !tracked.has(r.product_id)) continue;
    const need = Math.round(Number(r.quantity) || 0);
    const have = Array.isArray(r.serials) ? r.serials.length : 0;
    if (have !== need) {
      return `Line ${i + 1} (${r.product_name || 'product'}) needs ${need} serial `
        + `number${need === 1 ? '' : 's'} and has ${have}.`;
    }
  }
  return null;
}
