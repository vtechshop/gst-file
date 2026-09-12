// =============================================
// Purchase Credit / Debit Notes
//
// A FINANCIAL adjustment against a completed purchase - a rate difference,
// a shortfall, a discount agreed after the bill. It is NOT a Purchase
// Return: a return sends goods back and moves stock, this moves money only.
// Nothing on this page changes stock, serials or the purchase itself.
// =============================================
let pnEditId = null;
let pnAllData = [];
let pnPage = 1;
const PN_PAGE = 10;

// ── Affected items ────────────────────────────────
// The purchases a note can be raised against, the lines of the one picked,
// and which of those lines are ticked (line id -> quantity). The server
// re-reads every ticked line from the purchase itself, so what is held here
// decides only WHICH lines and HOW MANY - never what is printed.
let pnPurchases = [];
let pnPicked = null;
let pnPurchaseLines = [];
let pnSelected = new Map();
// Items an edited note already carries whose purchase can no longer be read.
let pnOrphanItems = [];

function populatePNStateOptions() {
  const sel = document.getElementById('pnState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>'
    + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function initPurchaseNotes() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  populatePNStateOptions();
  loadUserProfile(user.id);
  setupPNCalc();
  setupPNSearch();
  await Promise.all([loadPurchaseNotes(user.id), loadPNPurchases(user.id)]);
  applyIncomingSearchQuery('pnSearch');
  document.getElementById('pnNoteDate').value = new Date().toISOString().split('T')[0];
}

function setupPNCalc() {
  ['pnTaxable', 'pnGstPct', 'pnSupply'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', recalcPN);
    document.getElementById(id)?.addEventListener('input', recalcPN);
  });
  document.getElementById('pnTaxable')?.addEventListener('input', renderPNItemsSummary);
  document.getElementById('pnGstPct')?.addEventListener('change', renderPNItems);
}

// The one calculator the whole app uses - utils.js calcGST(). No second
// engine lives on this page.
function recalcPN() {
  const amt = parseFloat(document.getElementById('pnTaxable')?.value) || 0;
  const pct = parseFloat(document.getElementById('pnGstPct')?.value) || 0;
  const type = document.getElementById('pnSupply')?.value || 'intrastate';
  const r = calcGST(amt, pct, type);
  const sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  sv('pnIGST', formatNum(r.igst));
  sv('pnCGST', formatNum(r.cgst));
  sv('pnSGST', formatNum(r.sgst));
  sv('pnGstAmt', formatNum(r.gstAmount));
  sv('pnTotalAmt', formatNum(r.totalAmount));
}

// ── Purchase picker ───────────────────────────────
async function loadPNPurchases(userId) {
  const FIELDS = 'id,purchase_number,purchase_date,vendor_name,vendor_gstin,state,supply_type,vendor_id';
  const rows = await readAll([
    _supabase.from('purchases').select(FIELDS).eq('user_id', userId)
  ], 'Could not load the purchase list');
  if (!rows) return;
  pnPurchases = rows[0].slice()
    .sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  renderPNPurchaseOptions();
}

function renderPNPurchaseOptions() {
  const sel = document.getElementById('pnPurchasePick');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Not linked to a purchase</option>' + pnPurchases.map(r =>
    `<option value="${escItemHtml(r.id)}">${escItemHtml(r.purchase_number || '(no number)')}`
    + ` &middot; ${escItemHtml(formatDate(r.purchase_date))}`
    + ` &middot; ${escItemHtml(r.vendor_name || 'Unnamed supplier')}</option>`).join('');
  sel.value = current;
}

async function onPNPurchasePick() {
  const id = document.getElementById('pnPurchasePick')?.value || '';
  await pickPNPurchase(pnPurchases.find(r => r.id === id) || null, { fill: true });
}

function resetPNItemState() {
  pnPicked = null;
  pnPurchaseLines = [];
  pnSelected = new Map();
  pnOrphanItems = [];
  const sel = document.getElementById('pnPurchasePick');
  if (sel) sel.value = '';
  const orig = document.getElementById('pnOrigPurchase');
  if (orig) orig.readOnly = false;
}

// Picks a purchase, or none. `fill` copies its number and supplier onto the
// note - the server refuses a note whose supplier is not the purchase's.
// `saved` is an edited note's stored items, to tick again.
async function pickPNPurchase(pur, { fill, saved } = {}) {
  resetPNItemState();
  if (!pur) { renderPNItems(); return; }
  pnPicked = pur;
  const sel = document.getElementById('pnPurchasePick');
  if (sel) sel.value = pur.id;
  if (fill) {
    const sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    sv('pnVendorName', pur.vendor_name || '');
    sv('pnVendorGstin', pur.vendor_gstin || '');
    sv('pnState', pur.state || '');
    sv('pnSupply', pur.supply_type === 'interstate' ? 'interstate' : 'intrastate');
    recalcPN();
  }
  const orig = document.getElementById('pnOrigPurchase');
  if (orig) { orig.value = pur.purchase_number || orig.value; orig.readOnly = true; }
  renderPNItems();

  const read = await readAll([
    _supabase.from('purchase_items').select('*').eq('purchase_id', pur.id)
  ], 'Could not load the purchase\'s products');
  // A newer pick replaced this one while it loaded.
  if (pnPicked !== pur) return;
  if (!read) return;
  pnPurchaseLines = read[0].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (saved && saved.length) preselectPNItems(saved);
  renderPNItems();
}

// An edit: tick the lines the note already carries. Purchase lines are
// re-created whenever a purchase is saved, so they are matched by product
// (or by name and HSN where there is no product), never by line id.
function preselectPNItems(saved) {
  const used = new Set();
  const sameLine = (s, l) => (s.product_id
    ? s.product_id === l.product_id
    : String(s.product_name || '') === String(l.product_name || '')
      && String(s.hsn_code || '') === String(l.hsn_code || ''));
  let missed = 0;
  for (const s of saved) {
    const line = pnPurchaseLines.find(l => !used.has(l.id) && sameLine(s, l));
    if (!line) { missed++; continue; }
    used.add(line.id);
    pnSelected.set(line.id, String(Number(s.quantity ?? line.quantity)));
  }
  if (missed) {
    showToast(`${missed} saved item${missed === 1 ? ' is' : 's are'} no longer on the purchase and `
      + `${missed === 1 ? 'has' : 'have'} been left unticked.`, 'warning');
  }
}

// What a ticked line will be worth on the note. Shown here only - the server
// takes the same figure from the stored purchase: the whole line is its own
// value, part of it is that value in proportion.
function pnLineTaxable(line, qty) {
  const full = Number(line.quantity), q = Number(qty);
  const value = Number(line.taxable_value) || 0;
  if (!(full > 0) || Math.abs(q - full) < 1e-9) return round2(value);
  return round2(value * (Number.isFinite(q) ? q : 0) / full);
}

function pnSelectedLines() { return pnPurchaseLines.filter(l => pnSelected.has(l.id)); }
function pnSelectedTotal() {
  return round2(pnSelectedLines().reduce((s, l) => s + pnLineTaxable(l, pnSelected.get(l.id)), 0));
}
function pnSameRate(a, b) { return Math.round(Number(a) * 100) === Math.round(Number(b) * 100); }

function renderPNItems() {
  const box = document.getElementById('pnItemsSection');
  if (!box) return;

  if (pnOrphanItems.length) {
    box.innerHTML = `
      <div class="calc-box">
        <p class="fs-13 mb-14">This note's items came from a purchase that can no longer be read, so they
          cannot be checked again. Save is blocked until you remove them; the note keeps its amount and tax either way.</p>
        <div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Product</th><th>HSN/SAC</th><th class="text-right">Qty</th><th class="text-right">Rate</th><th class="text-right">Taxable Amount</th></tr></thead>
          <tbody>${pnOrphanItems.map(it => `<tr>
            <td>${escItemHtml(it.product_name)}</td><td>${escItemHtml(it.hsn_code || '&mdash;')}</td>
            <td class="text-right">${it.quantity == null ? '&mdash;' : Number(it.quantity)} ${escItemHtml(it.unit || '')}</td>
            <td class="text-right">${it.rate == null ? '&mdash;' : '&#8377;' + formatNum(it.rate)}</td>
            <td class="text-right">${it.taxable_value == null ? '&mdash;' : '&#8377;' + formatNum(it.taxable_value)}</td></tr>`).join('')}</tbody>
        </table></div>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="removePNOrphanItems()"><i class="fas fa-trash"></i> Remove item details</button>
      </div>`;
    renderPNItemsSummary();
    return;
  }
  if (!pnPicked) { box.innerHTML = ''; renderPNItemsSummary(); return; }
  if (!pnPurchaseLines.length) {
    box.innerHTML = '<p class="text-muted-sm">Loading the purchase\'s products&hellip;</p>';
    renderPNItemsSummary();
    return;
  }

  const notePct = Number(document.getElementById('pnGstPct')?.value || 0);
  // A percentage as it is stored: "0.00" reads as 0, and a missing one as 0.
  // Cess is one of those: the purchase entry screen does not capture it yet,
  // so it reads 0 here rather than being invented.
  const pct = v => (v === null || v === undefined || v === '' ? '0' : String(Number(v)));
  // Left of Note Qty every figure is the PURCHASE's own, shown so the user
  // can see exactly which product the note is being raised against; none of
  // them is editable. Right of it are the note's: the quantity they may
  // change, the rate carried from the purchase, and what that comes to -
  // from pnLineTaxable(), the one helper that values a line here and in the
  // summary below.
  box.innerHTML = `
    <div class="table-wrapper"><table class="data-table">
      <thead><tr>
        <th style="width:36px;"></th>
        <th class="min-w-280">Product</th>
        <th style="min-width:92px;">HSN/SAC</th>
        <th style="min-width:62px;">Unit</th>
        <th class="text-right" style="min-width:88px;">Invoice Qty</th>
        <th class="text-right" style="min-width:100px;">Invoice Rate</th>
        <th class="text-right" style="min-width:112px;">Invoice Amount</th>
        <th class="text-right" style="min-width:104px;">Note Qty</th>
        <th class="text-right" style="min-width:100px;">Note Rate</th>
        <th class="text-center" style="min-width:84px;">Discount %</th>
        <th class="text-center" style="min-width:70px;">GST %</th>
        <th class="text-center" style="min-width:70px;">Cess %</th>
        <th class="text-right" style="min-width:126px;">Note Taxable Amount</th>
      </tr></thead>
      <tbody>${pnPurchaseLines.map(l => {
        const on = pnSelected.has(l.id);
        const qty = on ? pnSelected.get(l.id) : String(Number(l.quantity));
        const rateOk = pnSameRate(l.gst_percentage, notePct);
        return `<tr>
          <td><input type="checkbox" ${on ? 'checked' : ''} onchange="togglePNItem('${l.id}', this.checked)" aria-label="Include ${escItemHtml(l.product_name)}"></td>
          <td>${escItemHtml(l.product_name)}</td>
          <td>${escItemHtml(l.hsn_code || '&mdash;')}</td>
          <td>${escItemHtml(l.unit || '&mdash;')}</td>
          <td class="text-right">${Number(l.quantity)}</td>
          <td class="text-right">&#8377;${formatNum(l.rate)}</td>
          <td class="text-right">&#8377;${formatNum(l.taxable_value)}</td>
          <td class="text-right"><input type="number" class="form-control calc-input-sm" style="width:88px;" min="0" step="any" max="${Number(l.quantity)}"
            value="${escItemHtml(qty)}" ${on ? '' : 'disabled'} oninput="setPNItemQty('${l.id}', this.value)" aria-label="Quantity on this note"></td>
          <td class="text-right">&#8377;${formatNum(l.rate)}</td>
          <td class="text-center">${pct(l.discount_percentage)}%</td>
          <td class="text-center">${on && !rateOk
            ? `<b style="color:#c62828;" title="This note is at ${notePct}%">${Number(l.gst_percentage)}%</b>`
            : Number(l.gst_percentage) + '%'}</td>
          <td class="text-center">${pct(l.cess_rate)}%</td>
          <td class="text-right" id="pnItemTax-${l.id}">${on ? '&#8377;' + formatNum(pnLineTaxable(l, qty)) : '&mdash;'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  renderPNItemsSummary();
}

function togglePNItem(id, on) {
  const line = pnPurchaseLines.find(l => l.id === id);
  if (!line) return;
  if (on) pnSelected.set(id, String(Number(line.quantity)));
  else pnSelected.delete(id);
  renderPNItems();
}

// Updates the one row and the total, not the whole table, so the quantity
// box being typed in keeps its focus.
function setPNItemQty(id, value) {
  const line = pnPurchaseLines.find(l => l.id === id);
  if (!line || !pnSelected.has(id)) return;
  pnSelected.set(id, value);
  const cell = document.getElementById('pnItemTax-' + id);
  if (cell) cell.innerHTML = '&#8377;' + formatNum(pnLineTaxable(line, value));
  renderPNItemsSummary();
}

function renderPNItemsSummary() {
  const el = document.getElementById('pnItemsSummary');
  const btn = document.getElementById('pnUseItemsTotal');
  if (!el) return;
  const lines = pnSelectedLines();
  if (!lines.length) {
    el.innerHTML = pnOrphanItems.length
      ? '<div>Saved items cannot be checked</div>'
      : '<div>Selected Items: <b>0</b></div><div>Items Total: <b>&#8377;0.00</b></div>';
    if (btn) btn.disabled = true;
    return;
  }
  const sum = pnSelectedTotal();
  const taxable = parseFloat(document.getElementById('pnTaxable')?.value) || 0;
  const match = Math.round(sum * 100) === Math.round(taxable * 100);
  el.innerHTML = `<div>Selected Items: <b>${lines.length}</b></div>`
    + `<div>Items Total: <b>&#8377;${formatNum(sum)}</b> `
    + (match
      ? '<span style="color:#2e7d32;">&#10003; matches the taxable amount</span>'
      : `<span style="color:#c62828;">&ne; taxable amount &#8377;${formatNum(taxable)}</span>`)
    + '</div>';
  if (btn) btn.disabled = match;
}

// The user's choice, made visibly - the amount is never changed to fit the
// items behind their back, and the server refuses a note where they differ.
function usePNItemsTotal() {
  if (!pnSelectedLines().length) return;
  const el = document.getElementById('pnTaxable');
  if (el) el.value = String(pnSelectedTotal());
  recalcPN();
  renderPNItemsSummary();
}

function removePNOrphanItems() {
  pnOrphanItems = [];
  renderPNItems();
  showToast('The item details will be removed when you save the note.', 'info');
}

async function savePurchaseNote() {
  const user = await getCurrentUser();
  if (!user) return;

  const noteType = document.getElementById('pnNoteType')?.value;
  const noteNum = document.getElementById('pnNoteNum')?.value?.trim();
  const noteDate = document.getElementById('pnNoteDate')?.value;
  const origPur = document.getElementById('pnOrigPurchase')?.value?.trim();
  const vendorName = document.getElementById('pnVendorName')?.value?.trim();
  const vendorGstin = document.getElementById('pnVendorGstin')?.value?.trim().toUpperCase();
  const state = document.getElementById('pnState')?.value || '';
  const reason = document.getElementById('pnReason')?.value?.trim();
  const taxable = parseFloat(document.getElementById('pnTaxable')?.value) || 0;
  const gstPct = parseFloat(document.getElementById('pnGstPct')?.value) || 0;
  const supply = document.getElementById('pnSupply')?.value || 'intrastate';

  if (!noteNum || !noteDate || !vendorName) {
    showToast('Note number, date and supplier name are required.', 'error'); return;
  }
  if (taxable <= 0) { showToast('Taxable amount must be positive.', 'error'); return; }
  if (pnOrphanItems.length) {
    showToast('This note\'s items came from a purchase that can no longer be read. Click "Remove item details" to save the note without them.', 'error');
    return;
  }

  // The same checks the server makes, made first so the user is told before
  // a round trip. The server's answer is the one that counts.
  const picked = pnSelectedLines();
  if (pnPicked && !picked.length) {
    showToast('Tick the product(s) this note is for. A note linked to a purchase must say which items it covers.', 'error');
    return;
  }
  if (picked.length) {
    const offRate = picked.find(l => !pnSameRate(l.gst_percentage, gstPct));
    if (offRate) {
      showToast(`${offRate.product_name} is at ${Number(offRate.gst_percentage)}% GST on the purchase, but this note is at ${gstPct}%. A note has one GST rate, so that item needs a note of its own.`, 'error');
      return;
    }
    const over = picked.find(l => Number(pnSelected.get(l.id)) > Number(l.quantity) + 1e-9);
    if (over) {
      showToast(`${over.product_name}: the purchase has ${Number(over.quantity)}, so the note cannot cover more.`, 'error');
      return;
    }
    const sum = pnSelectedTotal();
    if (Math.round(sum * 100) !== Math.round(taxable * 100)) {
      showToast(`The selected items add up to ₹${formatNum(sum)}, but the taxable amount is ₹${formatNum(taxable)}. They must be equal.`, 'error');
      return;
    }
  }

  const r = calcGST(taxable, gstPct, supply);
  const header = {
    note_type: noteType, note_number: noteNum, note_date: noteDate,
    original_purchase_number: origPur,
    vendor_name: vendorName, vendor_gstin: vendorGstin, state,
    reason, taxable_amount: taxable, gst_percentage: gstPct, supply_type: supply,
    igst: r.igst, cgst: r.cgst, sgst: r.sgst,
    gst_amount: r.gstAmount, total_amount: r.totalAmount
  };

  // One request for the note and its items, in one transaction: an edit
  // replaces the items it had, and a rejected note changes nothing. No stock
  // moves - a Purchase Return is the document for goods going back.
  try {
    await apiFetch('/purchase_notes/save-with-items', {
      method: 'POST',
      body: JSON.stringify({
        editId: pnEditId || null,
        header,
        purchase: pnPicked ? { id: pnPicked.id } : null,
        items: picked.map(l => ({ purchase_item_id: l.id, quantity: Number(pnSelected.get(l.id)) }))
      })
    });
  } catch (err) {
    handleApiError(err, 'Could not save the note');
    return;
  }

  showToast(pnEditId ? 'Note updated!' : 'Note saved!');
  pnEditId = null;
  resetPurchaseNote();
  await loadPurchaseNotes(user.id);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function resetPurchaseNote() {
  ['pnNoteNum', 'pnOrigPurchase', 'pnVendorName', 'pnVendorGstin', 'pnReason', 'pnTaxable'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const st = document.getElementById('pnState'); if (st) st.value = '';
  const ty = document.getElementById('pnNoteType'); if (ty) ty.value = 'credit';
  const pc = document.getElementById('pnGstPct'); if (pc) pc.value = '18';
  const sp = document.getElementById('pnSupply'); if (sp) sp.value = 'intrastate';
  document.getElementById('pnNoteDate').value = new Date().toISOString().split('T')[0];
  pnEditId = null;
  resetPNItemState();
  renderPNItems();
  recalcPN();
  document.getElementById('pnFormTitle').textContent = 'Add Purchase Credit / Debit Note';
  document.getElementById('pnSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Note';
}

async function loadPurchaseNotes(userId) {
  const rows = await readAll([
    _supabase.from('purchase_notes').select('*').eq('user_id', userId)
  ], 'Could not load the purchase notes');
  if (!rows) return;
  pnAllData = rows[0].slice()
    .sort((a, b) => (b.note_date || '').localeCompare(a.note_date || ''));
  renderPNTable(pnAllData);
}

function renderPNTable(data) {
  const body = document.getElementById('pnTableBody');
  if (!body) return;
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="10" class="empty-state">No purchase credit/debit notes yet.</td></tr>';
    document.getElementById('pnPagination').innerHTML = '';
    return;
  }
  const start = (pnPage - 1) * PN_PAGE;
  const rows = data.slice(start, start + PN_PAGE);
  body.innerHTML = rows.map((r, i) => `<tr>
    <td>${start + i + 1}</td>
    <td><span class="badge ${r.note_type === 'debit' ? 'badge-warning' : 'badge-success'}">${r.note_type === 'debit' ? 'DEBIT' : 'CREDIT'}</span></td>
    <td>${escItemHtml(r.note_number)}</td>
    <td>${escItemHtml(formatDate(r.note_date))}</td>
    <td>${escItemHtml(r.original_purchase_number || '&mdash;')}</td>
    <td>${escItemHtml(r.vendor_name || '')}</td>
    <td class="text-right">&#8377;${formatNum(r.taxable_amount)}</td>
    <td class="text-center">${Number(r.gst_percentage)}%</td>
    <td class="text-right">&#8377;${formatNum(r.total_amount)}</td>
    <td>
      <button type="button" class="btn btn-secondary btn-sm" onclick="downloadPurchaseNotePDF('${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
      <button type="button" class="btn btn-secondary btn-sm" onclick="editPurchaseNote('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
      <button type="button" class="btn btn-danger btn-sm" onclick="deletePurchaseNote('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
    </td></tr>`).join('');
  renderPNPagination(data.length);
}

function renderPNPagination(total) {
  const pg = document.getElementById('pnPagination');
  if (!pg) return;
  const pages = Math.ceil(total / PN_PAGE);
  if (pages <= 1) { pg.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="pnPage=${pnPage - 1};renderPNTable(pnAllData)" ${pnPage === 1 ? 'disabled' : ''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="page-btn ${i === pnPage ? 'active' : ''}" onclick="pnPage=${i};renderPNTable(pnAllData)">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="pnPage=${pnPage + 1};renderPNTable(pnAllData)" ${pnPage === pages ? 'disabled' : ''}>&#8250;</button>`;
  pg.innerHTML = html;
}

async function editPurchaseNote(id) {
  const rec = pnAllData.find(r => r.id === id);
  if (!rec) return;
  // The items first, before the form is touched: if they cannot be read,
  // saving would drop them, so the edit does not start at all.
  const savedRead = await readAll([
    _supabase.from('purchase_note_items').select('*').eq('note_id', id).order('sort_order', { ascending: true })
  ], 'Could not load the note\'s items');
  if (!savedRead) return;
  const saved = savedRead[0];

  pnEditId = id;
  document.getElementById('pnNoteType').value = rec.note_type;
  document.getElementById('pnNoteNum').value = rec.note_number;
  document.getElementById('pnNoteDate').value = rec.note_date;
  document.getElementById('pnOrigPurchase').value = rec.original_purchase_number || '';
  document.getElementById('pnVendorName').value = rec.vendor_name || '';
  document.getElementById('pnVendorGstin').value = rec.vendor_gstin || '';
  document.getElementById('pnState').value = rec.state || '';
  document.getElementById('pnReason').value = rec.reason || '';
  document.getElementById('pnTaxable').value = rec.taxable_amount;
  // The API returns NUMERIC as a string ("18.00") and a <select> only accepts
  // a value one of its options actually has ("18"), so the rate is normalised
  // here exactly as the sales note does it. Nothing else about it changes.
  document.getElementById('pnGstPct').value = String(Number(rec.gst_percentage));
  document.getElementById('pnSupply').value = rec.supply_type;
  recalcPN();
  document.getElementById('pnFormTitle').textContent = 'Edit Purchase Note';
  document.getElementById('pnSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Note';
  document.getElementById('pnNoteNum').scrollIntoView({ behavior: 'smooth', block: 'center' });

  const pur = rec.original_purchase_id
    ? pnPurchases.find(r => r.id === rec.original_purchase_id)
    : null;
  if (pur) {
    await pickPNPurchase(pur, { fill: false, saved });
  } else {
    resetPNItemState();
    // Items whose purchase is gone are shown and must be removed on purpose.
    pnOrphanItems = saved;
    renderPNItems();
  }
}

async function deletePurchaseNote(id) {
  const ok = await showConfirm('Permanently delete this purchase note? This cannot be undone.');
  if (!ok) return;
  // The note's items go with it, through the database's foreign key. The
  // purchase it was raised against, and stock, are not touched.
  const { error } = await _supabase.from('purchase_notes').delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the note'); return; }
  showToast('Note permanently deleted.');
  pnAllData = pnAllData.filter(r => r.id !== id);
  renderPNTable(pnAllData);
}

function setupPNSearch() {
  const input = document.getElementById('pnSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    pnPage = 1;
    if (!q) { renderPNTable(pnAllData); return; }
    renderPNTable(pnAllData.filter(r =>
      String(r.note_number || '').toLowerCase().includes(q)
      || String(r.vendor_name || '').toLowerCase().includes(q)
      || String(r.original_purchase_number || '').toLowerCase().includes(q)));
  });
}
