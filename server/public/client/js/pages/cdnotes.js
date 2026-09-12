// =============================================
// Credit / Debit Notes Logic
// =============================================
let cdEditId = null;
let cdAllData = [];
let cdPage = 1;
const CD_PAGE = 10;

// ── Affected items ────────────────────────────────
// The invoices a note can be raised against, the lines of the one picked,
// and which of those lines are ticked for this note (line id -> quantity).
// The server re-reads every ticked line from the invoice itself, so what is
// held here decides only WHICH lines and HOW MANY - never what is printed.
let cdInvoices = [];
let cdPicked = null;
let cdInvoiceLines = [];
let cdSelected = new Map();
// Items an edited note already carries whose invoice can no longer be read.
// They cannot be checked again, so they are shown, not silently dropped.
let cdOrphanItems = [];

// Single source of truth for every state dropdown app-wide — see
// INDIAN_STATES in js/utils.js.
function populateCDStateOptions() {
  const sel = document.getElementById('cdState');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select State</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function initCDNotes() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  populateCDStateOptions();
  loadUserProfile(user.id);
  setupCDCalc();
  setupCDSearch();
  await Promise.all([loadCDNotes(user.id), loadCDInvoices(user.id)]);
  applyIncomingSearchQuery('cdSearch');
  document.getElementById('cdNoteDate').value = new Date().toISOString().split('T')[0];
}

function setupCDCalc() {
  ['cdTaxable','cdGstPct','cdSupply'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', recalcCD);
    document.getElementById(id)?.addEventListener('input',  recalcCD);
  });
  // The items are checked against the amount and the rate, so both redraw them.
  document.getElementById('cdTaxable')?.addEventListener('input', renderCDItemsSummary);
  document.getElementById('cdGstPct')?.addEventListener('change', renderCDItems);
}

function recalcCD() {
  const amt  = parseFloat(document.getElementById('cdTaxable')?.value) || 0;
  const pct  = parseFloat(document.getElementById('cdGstPct')?.value)  || 0;
  const type = document.getElementById('cdSupply')?.value || 'intrastate';
  const r    = calcGST(amt, pct, type);
  const sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  sv('cdIGST',     formatNum(r.igst));
  sv('cdCGST',     formatNum(r.cgst));
  sv('cdSGST',     formatNum(r.sgst));
  sv('cdGstAmt',   formatNum(r.gstAmount));
  sv('cdTotalAmt', formatNum(r.totalAmount));
}

// ── Invoice picker ────────────────────────────────
async function loadCDInvoices(userId) {
  const FIELDS = 'id,invoice_number,invoice_date,customer_name,gst_number,state,supply_type';
  // An invoice missing from this list looks like one a note cannot be
  // raised against, so a failed read is reported rather than shown empty.
  const rows = await readAll([
    _supabase.from('b2b_invoices').select(FIELDS).eq('user_id', userId),
    _supabase.from('b2c_invoices').select(FIELDS).eq('user_id', userId)
  ], 'Could not load the invoice list');
  if (!rows) return;
  const tag = (table, type) => r => ({ ...r, table, type });
  cdInvoices = [...rows[0].map(tag('b2b_invoices', 'b2b')), ...rows[1].map(tag('b2c_invoices', 'b2c'))]
    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  renderCDInvoiceOptions();
}

// Two invoices can share a number - one per table and per series - so the
// option is keyed on the table and id, never on the number.
function cdInvoiceKey(r) { return r.table + ':' + r.id; }

function renderCDInvoiceOptions() {
  const sel = document.getElementById('cdInvoicePick');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Not linked to an invoice</option>' + cdInvoices.map(r =>
    `<option value="${escItemHtml(cdInvoiceKey(r))}">${escItemHtml(r.invoice_number || '(no number)')}`
    + ` &middot; ${escItemHtml(formatDate(r.invoice_date))} &middot; ${escItemHtml(r.customer_name || 'Walk-in customer')}`
    + ` (${r.type.toUpperCase()})</option>`).join('');
  sel.value = current;
}

async function onCDInvoicePick() {
  const key = document.getElementById('cdInvoicePick')?.value || '';
  await pickCDInvoice(cdInvoices.find(r => cdInvoiceKey(r) === key) || null, { fill: true });
}

function resetCDItemState() {
  cdPicked = null;
  cdInvoiceLines = [];
  cdSelected = new Map();
  cdOrphanItems = [];
  const sel = document.getElementById('cdInvoicePick');
  if (sel) sel.value = '';
  const orig = document.getElementById('cdOrigInv');
  if (orig) orig.readOnly = false;
}

// Picks an invoice, or none. `fill` copies its number and customer onto the
// note - the server refuses a note whose customer is not the invoice's.
// `saved` is an edited note's stored items, to tick again.
async function pickCDInvoice(inv, { fill, saved } = {}) {
  resetCDItemState();
  if (!inv) { renderCDItems(); return; }
  cdPicked = inv;
  const sel = document.getElementById('cdInvoicePick');
  if (sel) sel.value = cdInvoiceKey(inv);
  if (fill) {
    const sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    sv('cdCustName', inv.customer_name || '');
    sv('cdGSTIN', inv.gst_number || '');
    sv('cdState', inv.state || '');
    sv('cdSupply', inv.supply_type === 'interstate' ? 'interstate' : 'intrastate');
    recalcCD();
  }
  const orig = document.getElementById('cdOrigInv');
  if (orig) { orig.value = inv.invoice_number || orig.value; orig.readOnly = true; }
  renderCDItems();

  const read = await readAll([
    _supabase.from('invoice_items').select('*').eq('invoice_id', inv.id).eq('invoice_type', inv.type)
  ], 'Could not load the invoice\'s products');
  // A newer pick replaced this one while it loaded.
  if (cdPicked !== inv) return;
  if (!read) return;
  cdInvoiceLines = read[0].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (saved && saved.length) preselectCDItems(saved);
  renderCDItems();
}

// An edit: tick the lines the note already carries. Invoice lines are
// re-created whenever the invoice is saved, so they are matched by product
// (or by name and HSN where there is no product), never by line id.
function preselectCDItems(saved) {
  const used = new Set();
  const sameLine = (s, l) => (s.product_id
    ? s.product_id === l.product_id
    : String(s.product_name || '') === String(l.product_name || '')
      && String(s.hsn_code || '') === String(l.hsn_code || ''));
  let missed = 0;
  for (const s of saved) {
    const line = cdInvoiceLines.find(l => !used.has(l.id) && sameLine(s, l));
    if (!line) { missed++; continue; }
    used.add(line.id);
    cdSelected.set(line.id, String(Number(s.quantity ?? line.quantity)));
  }
  if (missed) {
    showToast(`${missed} saved item${missed === 1 ? ' is' : 's are'} no longer on the invoice and ${missed === 1 ? 'has' : 'have'} been left unticked.`, 'warning');
  }
}

// What a ticked line will be worth on the note. Shown here only - the
// server takes the same figure from the stored invoice: the whole line is
// its own value, part of it is that value in proportion.
function cdLineTaxable(line, qty) {
  const full = Number(line.quantity), q = Number(qty);
  const value = Number(line.taxable_value) || 0;
  if (!(full > 0) || Math.abs(q - full) < 1e-9) return round2(value);
  return round2(value * (Number.isFinite(q) ? q : 0) / full);
}

function cdSelectedLines() { return cdInvoiceLines.filter(l => cdSelected.has(l.id)); }
function cdSelectedTotal() {
  return round2(cdSelectedLines().reduce((s, l) => s + cdLineTaxable(l, cdSelected.get(l.id)), 0));
}
function cdSameRate(a, b) { return Math.round(Number(a) * 100) === Math.round(Number(b) * 100); }

function renderCDItems() {
  const box = document.getElementById('cdItemsSection');
  if (!box) return;

  if (cdOrphanItems.length) {
    box.innerHTML = `
      <div class="calc-box">
        <p class="fs-13 mb-14">This note's items came from an invoice that can no longer be read, so they cannot be
          checked again. Save is blocked until you remove them; the note keeps its amount and tax either way.</p>
        <div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Product</th><th>HSN/SAC</th><th class="text-right">Qty</th><th class="text-right">Rate</th><th class="text-right">Taxable Amount</th></tr></thead>
          <tbody>${cdOrphanItems.map(it => `<tr>
            <td>${escItemHtml(it.product_name)}</td><td>${escItemHtml(it.hsn_code || '—')}</td>
            <td class="text-right">${it.quantity == null ? '—' : Number(it.quantity)} ${escItemHtml(it.unit || '')}</td>
            <td class="text-right">${it.rate == null ? '—' : '&#8377;' + formatNum(it.rate)}</td>
            <td class="text-right">${it.taxable_value == null ? '—' : '&#8377;' + formatNum(it.taxable_value)}</td></tr>`).join('')}</tbody>
        </table></div>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="removeCDOrphanItems()"><i class="fas fa-trash"></i> Remove item details</button>
      </div>`;
    renderCDItemsSummary();
    return;
  }
  if (!cdPicked) { box.innerHTML = ''; renderCDItemsSummary(); return; }
  if (!cdInvoiceLines.length) {
    box.innerHTML = '<p class="text-muted-sm">Loading the invoice\'s products&hellip;</p>';
    renderCDItemsSummary();
    return;
  }

  const notePct = Number(document.getElementById('cdGstPct')?.value || 0);
  box.innerHTML = `
    <div class="table-wrapper"><table class="data-table">
      <thead><tr>
        <th style="width:36px;"></th><th>Product</th><th>HSN/SAC</th>
        <th class="text-right">Invoice Qty</th><th class="text-right" style="min-width:110px;">Note Qty</th>
        <th class="text-right">Rate</th><th class="text-right">Taxable Amount</th><th class="text-center">GST%</th>
      </tr></thead>
      <tbody>${cdInvoiceLines.map(l => {
        const on = cdSelected.has(l.id);
        const qty = on ? cdSelected.get(l.id) : String(Number(l.quantity));
        const rateOk = cdSameRate(l.gst_percentage, notePct);
        return `<tr>
          <td><input type="checkbox" ${on ? 'checked' : ''} onchange="toggleCDItem('${l.id}', this.checked)" aria-label="Include ${escItemHtml(l.product_name)}"></td>
          <td>${escItemHtml(l.product_name)}</td>
          <td>${escItemHtml(l.hsn_code || '—')}</td>
          <td class="text-right">${Number(l.quantity)} ${escItemHtml(l.unit || '')}</td>
          <td class="text-right"><input type="number" class="form-control calc-input-sm" min="0" step="any" max="${Number(l.quantity)}"
            value="${escItemHtml(qty)}" ${on ? '' : 'disabled'} oninput="setCDItemQty('${l.id}', this.value)" aria-label="Quantity on this note"></td>
          <td class="text-right">&#8377;${formatNum(l.rate)}</td>
          <td class="text-right" id="cdItemTax-${l.id}">${on ? '&#8377;' + formatNum(cdLineTaxable(l, qty)) : '&mdash;'}</td>
          <td class="text-center">${on && !rateOk
            ? `<b style="color:#c62828;" title="This note is at ${notePct}%">${Number(l.gst_percentage)}%</b>`
            : Number(l.gst_percentage) + '%'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  renderCDItemsSummary();
}

function toggleCDItem(id, on) {
  const line = cdInvoiceLines.find(l => l.id === id);
  if (!line) return;
  if (on) cdSelected.set(id, String(Number(line.quantity)));
  else cdSelected.delete(id);
  renderCDItems();
}

// Updates the one row and the total, not the whole table, so the quantity
// box being typed in keeps its focus.
function setCDItemQty(id, value) {
  const line = cdInvoiceLines.find(l => l.id === id);
  if (!line || !cdSelected.has(id)) return;
  cdSelected.set(id, value);
  const cell = document.getElementById('cdItemTax-' + id);
  if (cell) cell.innerHTML = '&#8377;' + formatNum(cdLineTaxable(line, value));
  renderCDItemsSummary();
}

function renderCDItemsSummary() {
  const el = document.getElementById('cdItemsSummary');
  const btn = document.getElementById('cdUseItemsTotal');
  if (!el) return;
  const lines = cdSelectedLines();
  if (!lines.length) {
    el.innerHTML = cdOrphanItems.length
      ? '<div>Saved items cannot be checked</div>'
      : '<div>Selected Items: <b>0</b></div><div>Items Total: <b>&#8377;0.00</b></div>';
    if (btn) btn.disabled = true;
    return;
  }
  const sum = cdSelectedTotal();
  const taxable = parseFloat(document.getElementById('cdTaxable')?.value) || 0;
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
function useCDItemsTotal() {
  if (!cdSelectedLines().length) return;
  const el = document.getElementById('cdTaxable');
  if (el) el.value = String(cdSelectedTotal());
  recalcCD();
  renderCDItemsSummary();
}

function removeCDOrphanItems() {
  cdOrphanItems = [];
  renderCDItems();
  showToast('The item details will be removed when you save the note.', 'info');
}

async function saveCDNote() {
  const user = await getCurrentUser();
  if (!user) return;

  const noteType   = document.getElementById('cdNoteType')?.value;
  const noteNum    = document.getElementById('cdNoteNum')?.value?.trim();
  const noteDate   = document.getElementById('cdNoteDate')?.value;
  const origInv    = document.getElementById('cdOrigInv')?.value?.trim();
  const custName   = document.getElementById('cdCustName')?.value?.trim();
  const gstin      = document.getElementById('cdGSTIN')?.value?.trim().toUpperCase();
  const state      = document.getElementById('cdState')?.value || '';
  const reason     = document.getElementById('cdReason')?.value?.trim();
  const taxable    = parseFloat(document.getElementById('cdTaxable')?.value) || 0;
  const gstPct     = parseFloat(document.getElementById('cdGstPct')?.value)  || 0;
  const supply     = document.getElementById('cdSupply')?.value || 'intrastate';

  if (!noteNum || !noteDate || !custName) { showToast('Note number, date and customer name are required.', 'error'); return; }
  if (taxable <= 0) { showToast('Taxable amount must be positive.', 'error'); return; }
  if (cdOrphanItems.length) {
    showToast('This note\'s items came from an invoice that can no longer be read. Click "Remove item details" to save the note without them.', 'error');
    return;
  }

  // The same two checks the server makes, made first so the user is told
  // before a round trip. The server's answer is the one that counts.
  const picked = cdSelectedLines();
  // A note raised against an invoice has to say which of its products it
  // covers. Leaving the invoice unselected is still how a note without
  // product details is written.
  if (cdPicked && !picked.length) {
    showToast('Tick the product(s) this note is for. A note linked to an invoice must say which items it covers.', 'error');
    return;
  }
  if (picked.length) {
    const offRate = picked.find(l => !cdSameRate(l.gst_percentage, gstPct));
    if (offRate) {
      showToast(`${offRate.product_name} is at ${Number(offRate.gst_percentage)}% GST on the invoice, but this note is at ${gstPct}%. A note has one GST rate, so that item needs a note of its own.`, 'error');
      return;
    }
    const sum = cdSelectedTotal();
    if (Math.round(sum * 100) !== Math.round(taxable * 100)) {
      showToast(`The selected items add up to ₹${formatNum(sum)}, but the taxable amount is ₹${formatNum(taxable)}. They must be equal.`, 'error');
      return;
    }
  }

  const r = calcGST(taxable, gstPct, supply);
  const header = {
    note_type: noteType, note_number: noteNum, note_date: noteDate,
    original_invoice: origInv,
    // What the note reverses. Defaults to an ordinary supply, so every
    // note already saved keeps meaning exactly what it meant.
    supply_nature: (document.getElementById('cdSupplyNature')?.value || 'regular'),
    reverse_charge: !!document.getElementById('cdReverseCharge')?.checked,
    ecom_gstin: (document.getElementById('cdEcomGstin')?.value || '').trim().toUpperCase() || null,
    differential_65: !!document.getElementById('cdDifferential65')?.checked,
    customer_name: custName, gstin, state,
    reason, taxable_amount: taxable, gst_percentage: gstPct, supply_type: supply,
    igst: r.igst, cgst: r.cgst, sgst: r.sgst,
    gst_amount: r.gstAmount, total_amount: r.totalAmount
  };

  // One request for the note and its items, in one transaction: an edit
  // replaces the items it had, and a rejected note changes nothing.
  try {
    await apiFetch('/cdn_notes/save-with-items', {
      method: 'POST',
      body: JSON.stringify({
        editId: cdEditId || null,
        header,
        invoice: cdPicked ? { id: cdPicked.id, table: cdPicked.table } : null,
        items: picked.map(l => ({ invoice_item_id: l.id, quantity: Number(cdSelected.get(l.id)) }))
      })
    });
  } catch (err) {
    handleApiError(err, 'Could not save the note');
    return;
  }

  showToast(cdEditId ? 'Note updated!' : 'Note saved!');
  cdEditId = null;
  resetCDNote();
  await loadCDNotes(user.id);
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
}

function resetCDNote() {
  ['cdNoteNum','cdOrigInv','cdCustName','cdGSTIN','cdReason','cdTaxable'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('cdNoteDate').value   = new Date().toISOString().split('T')[0];
  document.getElementById('cdState').value      = '';
  document.getElementById('cdNoteType').value   = 'credit';
  document.getElementById('cdGstPct').value     = '18';
  document.getElementById('cdSupply').value     = 'intrastate';
  resetCDItemState();
  renderCDItems();
  recalcCD();
  cdEditId = null;
  const t = document.getElementById('cdFormTitle'); if (t) t.textContent = 'Add Credit / Debit Note';
  const b = document.getElementById('cdSaveBtn');   if (b) b.innerHTML = '<i class="fas fa-save"></i> Save Note';
}

async function loadCDNotes(userId) {
  const { data, error } = await _supabase.from('cdn_notes').select('*').eq('user_id', userId).order('note_date', { ascending: false });
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the credit/debit notes'); return; }
  cdAllData = (data || []);
  cdPage = 1;
  renderCDTable(cdAllData);
}

function renderCDTable(data) {
  const tbody = document.getElementById('cdTableBody');
  const tfoot = document.getElementById('cdTableTotal');
  if (!tbody) return;

  const start = (cdPage - 1) * CD_PAGE;
  const page  = data.slice(start, start + CD_PAGE);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><i class="fas fa-file-minus" style="display:block;font-size:40px;margin-bottom:10px;"></i>No credit/debit notes found</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  tbody.innerHTML = page.map((r, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td><span class="badge ${r.note_type === 'credit' ? 'badge-green' : 'badge-blue'}" style="text-transform:uppercase;">${r.note_type}</span></td>
      <td><b>${r.note_number}</b></td>
      <td>${formatDate(r.note_date)}</td>
      <td>${r.original_invoice || '&mdash;'}</td>
      <td>${r.customer_name}</td>
      <td style="text-align:right;">&#8377;${formatNum(r.taxable_amount)}</td>
      <td style="text-align:center;">${r.gst_percentage}%</td>
      <td style="text-align:right;font-weight:700;">&#8377;${formatNum(r.total_amount)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="downloadCDNotePDF('${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editCDNote('${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCDNote('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const totals = {
    taxable: data.reduce((s,r)=>s+ +r.taxable_amount, 0),
    total:   data.reduce((s,r)=>s+ +r.total_amount,   0)
  };
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="6" style="font-weight:700;">TOTALS (${data.length} notes)</td><td style="text-align:right;font-weight:700;">&#8377;${formatNum(totals.taxable)}</td><td></td><td style="text-align:right;font-weight:700;">&#8377;${formatNum(totals.total)}</td><td></td></tr>`;

  const pg = document.getElementById('cdPagination');
  if (!pg) return;
  const pages = Math.ceil(data.length / CD_PAGE);
  if (pages <= 1) { pg.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="cdPage=${cdPage-1};renderCDTable(cdAllData)" ${cdPage===1?'disabled':''}>&#8249;</button>`;
  for (let i = 1; i <= pages; i++) html += `<button class="page-btn ${i===cdPage?'active':''}" onclick="cdPage=${i};renderCDTable(cdAllData)">${i}</button>`;
  html += `<button class="page-btn" onclick="cdPage=${cdPage+1};renderCDTable(cdAllData)" ${cdPage===pages?'disabled':''}>&#8250;</button>`;
  pg.innerHTML = html;
}

async function editCDNote(id) {
  const rec = cdAllData.find(r => r.id === id);
  if (!rec) return;
  // The items first, before the form is touched: if they cannot be read,
  // saving would drop them, so the edit does not start at all.
  const savedRead = await readAll([
    _supabase.from('cdn_note_items').select('*').eq('note_id', id).order('sort_order', { ascending: true })
  ], 'Could not load the note\'s items');
  if (!savedRead) return;
  const saved = savedRead[0];

  cdEditId = id;
  document.getElementById('cdNoteType').value   = rec.note_type;
  document.getElementById('cdNoteNum').value    = rec.note_number;
  document.getElementById('cdNoteDate').value   = rec.note_date;
  document.getElementById('cdOrigInv').value    = rec.original_invoice || '';
  const nat = document.getElementById('cdSupplyNature');
  if (nat) nat.value = rec.supply_nature || 'regular';
  const rc = document.getElementById('cdReverseCharge');
  if (rc) rc.checked = !!rec.reverse_charge;
  const eg = document.getElementById('cdEcomGstin');
  if (eg) eg.value = rec.ecom_gstin || '';
  const d65 = document.getElementById('cdDifferential65');
  if (d65) d65.checked = !!rec.differential_65;
  document.getElementById('cdCustName').value   = rec.customer_name;
  document.getElementById('cdGSTIN').value      = rec.gstin || '';
  document.getElementById('cdState').value      = rec.state || '';
  document.getElementById('cdReason').value     = rec.reason || '';
  document.getElementById('cdTaxable').value    = rec.taxable_amount;
  // The API returns NUMERIC as a string ("18.00"), and a <select> only
  // accepts a value one of its options actually has ("18"). Assigning the
  // raw string left the select blank, and saveCDNote() reads it back as
  // parseFloat('') || 0 - so opening a note and pressing Update rewrote a
  // real rate to 0% and zeroed its tax. Normalising the number here keeps
  // the stored rate whatever it is; nothing else about the rate changes.
  document.getElementById('cdGstPct').value     = String(Number(rec.gst_percentage));
  document.getElementById('cdSupply').value     = rec.supply_type;
  recalcCD();
  document.getElementById('cdFormTitle').textContent = 'Edit Note';
  document.getElementById('cdSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Note';
  document.getElementById('cdNoteNum').scrollIntoView({ behavior: 'smooth', block: 'center' });

  const inv = rec.original_invoice_id
    ? cdInvoices.find(r => r.id === rec.original_invoice_id && r.table === rec.original_invoice_table)
    : null;
  if (inv) {
    await pickCDInvoice(inv, { fill: false, saved });
  } else {
    resetCDItemState();
    // Items whose invoice is gone are shown and must be removed on purpose.
    cdOrphanItems = saved;
    renderCDItems();
  }
}

async function deleteCDNote(id) {
  const ok = await showConfirm('Permanently delete this note? This cannot be undone.');
  if (!ok) return;
  // The note's items go with it, through the database's foreign key. The
  // invoice it was raised against is not touched.
  const { error } = await _supabase.from('cdn_notes').delete().eq('id', id);
  if (error) { handleApiError(error, 'Could not delete the note'); return; }
  showToast('Note permanently deleted.');
  cdAllData = cdAllData.filter(r => r.id !== id);
  renderCDTable(cdAllData);
}

function setupCDSearch() {
  document.getElementById('cdSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? cdAllData.filter(r =>
      r.note_number.toLowerCase().includes(q) ||
      r.customer_name.toLowerCase().includes(q) ||
      (r.original_invoice || '').toLowerCase().includes(q)
    ) : cdAllData;
    cdPage = 1;
    renderCDTable(filtered);
  });
}
