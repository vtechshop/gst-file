// =============================================
// Credit / Debit Notes Logic
// =============================================
let cdEditId = null;
let cdAllData = [];
let cdPage = 1;
const CD_PAGE = 10;

async function initCDNotes() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  loadUserProfile(user.id);
  setupCDCalc();
  setupCDSearch();
  await loadCDNotes(user.id);
  applyIncomingSearchQuery('cdSearch');
  document.getElementById('cdNoteDate').value = new Date().toISOString().split('T')[0];
}

function setupCDCalc() {
  ['cdTaxable','cdGstPct','cdSupply'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', recalcCD);
    document.getElementById(id)?.addEventListener('input',  recalcCD);
  });
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

async function saveCDNote() {
  const user = await getCurrentUser();
  if (!user) return;

  const noteType   = document.getElementById('cdNoteType')?.value;
  const noteNum    = document.getElementById('cdNoteNum')?.value?.trim();
  const noteDate   = document.getElementById('cdNoteDate')?.value;
  const origInv    = document.getElementById('cdOrigInv')?.value?.trim();
  const custName   = document.getElementById('cdCustName')?.value?.trim();
  const gstin      = document.getElementById('cdGSTIN')?.value?.trim().toUpperCase();
  const reason     = document.getElementById('cdReason')?.value?.trim();
  const taxable    = parseFloat(document.getElementById('cdTaxable')?.value) || 0;
  const gstPct     = parseFloat(document.getElementById('cdGstPct')?.value)  || 0;
  const supply     = document.getElementById('cdSupply')?.value || 'intrastate';

  if (!noteNum || !noteDate || !custName) { showToast('Note number, date and customer name are required.', 'error'); return; }
  if (taxable <= 0) { showToast('Taxable amount must be positive.', 'error'); return; }

  const r = calcGST(taxable, gstPct, supply);
  const payload = {
    user_id: user.id, note_type: noteType, note_number: noteNum, note_date: noteDate,
    original_invoice: origInv, customer_name: custName, gstin,
    reason, taxable_amount: taxable, gst_percentage: gstPct, supply_type: supply,
    igst: r.igst, cgst: r.cgst, sgst: r.sgst,
    gst_amount: r.gstAmount, total_amount: r.totalAmount
  };

  let error;
  if (cdEditId) {
    ({ error } = await _supabase.from('cdn_notes').update(payload).eq('id', cdEditId));
  } else {
    ({ error } = await _supabase.from('cdn_notes').insert(payload));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
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
  document.getElementById('cdNoteType').value   = 'credit';
  document.getElementById('cdGstPct').value     = '18';
  document.getElementById('cdSupply').value     = 'intrastate';
  recalcCD();
  cdEditId = null;
  const t = document.getElementById('cdFormTitle'); if (t) t.textContent = 'Add Credit / Debit Note';
  const b = document.getElementById('cdSaveBtn');   if (b) b.innerHTML = '<i class="fas fa-save"></i> Save Note';
}

async function loadCDNotes(userId) {
  const { data } = await _supabase.from('cdn_notes').select('*').eq('user_id', userId).order('note_date', { ascending: false });
  cdAllData = data || [];
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

function editCDNote(id) {
  const rec = cdAllData.find(r => r.id === id);
  if (!rec) return;
  cdEditId = id;
  document.getElementById('cdNoteType').value   = rec.note_type;
  document.getElementById('cdNoteNum').value    = rec.note_number;
  document.getElementById('cdNoteDate').value   = rec.note_date;
  document.getElementById('cdOrigInv').value    = rec.original_invoice || '';
  document.getElementById('cdCustName').value   = rec.customer_name;
  document.getElementById('cdGSTIN').value      = rec.gstin || '';
  document.getElementById('cdReason').value     = rec.reason || '';
  document.getElementById('cdTaxable').value    = rec.taxable_amount;
  document.getElementById('cdGstPct').value     = rec.gst_percentage;
  document.getElementById('cdSupply').value     = rec.supply_type;
  recalcCD();
  document.getElementById('cdFormTitle').textContent = 'Edit Note';
  document.getElementById('cdSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Note';
  document.getElementById('cdNoteNum').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteCDNote(id) {
  const ok = await showConfirm('Delete this note?');
  if (!ok) return;
  const { error } = await _supabase.from('cdn_notes').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Note deleted!');
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
