// =============================================
// HSN Summary Logic
// =============================================
let hsnB2BEditId = null;
let hsnB2CEditId = null;
let hsnB2BData = [];
let hsnB2CData = [];
let hsnProductsList = [];

async function initHSN() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  loadUserProfile(user.id);
  setupMobileMenu();
  setupHSNCalc('b2b');
  setupHSNCalc('b2c');
  await loadHSNProductsList(user.id);
  await Promise.all([loadB2BHSN(user.id), loadB2CHSN(user.id)]);
}

// ── Product Master auto-fill ──────────────────────
async function loadHSNProductsList(userId) {
  hsnProductsList = await loadProductsList(userId);
  const opts = hsnProductsList.map(p => `<option value="${p.name}">${p.hsn_code ? '(' + p.hsn_code + ')' : ''}</option>`).join('');
  const dlB2B = document.getElementById('productDatalistB2B');
  const dlB2C = document.getElementById('productDatalistB2C');
  if (dlB2B) dlB2B.innerHTML = opts;
  if (dlB2C) dlB2C.innerHTML = opts;
}

function onHSNProductSelect(prefix) {
  const p = prefix.toUpperCase();
  const name = document.getElementById(`hsn${p}Prod`)?.value?.trim();
  const prod = findProductByName(hsnProductsList, name);
  if (!prod) return;

  const codeEl = document.getElementById(`hsn${p}Code`);
  if (codeEl && !codeEl.value) codeEl.value = prod.hsn_code || '';

  const typeEl = document.getElementById(`hsn${p}Type`);
  if (typeEl) typeEl.value = prod.type || 'goods';

  const pctEl = document.getElementById(`hsn${p}GstPct`);
  if (pctEl) pctEl.value = prod.gst_percentage ?? 18;

  const taxableEl = document.getElementById(`hsn${p}Taxable`);
  if (taxableEl && !taxableEl.value && prod.default_rate) taxableEl.value = prod.default_rate;

  recalcHSN(prefix);
}

function setupHSNCalc(prefix) {
  ['Taxable','GstPct','Supply'].forEach(s => {
    const id = `hsn${prefix.toUpperCase()}${s}`;
    document.getElementById(id)?.addEventListener('change', () => recalcHSN(prefix));
    document.getElementById(id)?.addEventListener('input',  () => recalcHSN(prefix));
  });
}

function recalcHSN(prefix) {
  const p = prefix.toUpperCase();
  const amt  = parseFloat(document.getElementById(`hsn${p}Taxable`)?.value) || 0;
  const pct  = parseFloat(document.getElementById(`hsn${p}GstPct`)?.value)  || 0;
  const type = document.getElementById(`hsn${p}Supply`)?.value || 'intrastate';
  const r    = calcGST(amt, pct, type);
  const sv   = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  sv(`hsn${p}IGST`,  formatNum(r.igst));
  sv(`hsn${p}CGST`,  formatNum(r.cgst));
  sv(`hsn${p}SGST`,  formatNum(r.sgst));
  sv(`hsn${p}TotalGST`, formatNum(r.totalGst));
  sv(`hsn${p}TotalInv`, formatNum(r.totalAmount));
}

async function saveHSN(prefix) {
  const user = await getCurrentUser();
  if (!user) return;
  const p = prefix.toUpperCase();
  const gt = (id) => document.getElementById(id)?.value?.trim() || '';

  const hsnCode  = gt(`hsn${p}Code`);
  const prodName = gt(`hsn${p}Prod`);
  const type     = gt(`hsn${p}Type`);
  const taxable  = parseFloat(gt(`hsn${p}Taxable`)) || 0;
  const gstPct   = parseFloat(gt(`hsn${p}GstPct`))  || 0;
  const supply   = gt(`hsn${p}Supply`);

  if (!hsnCode || !prodName || !type) { showToast('Please fill HSN Code, Product Name and Type.', 'error'); return; }
  if (taxable <= 0) { showToast('Taxable value must be positive.', 'error'); return; }

  const r = calcGST(taxable, gstPct, supply);

  const table = prefix === 'b2b' ? 'b2b_hsn' : 'b2c_hsn';
  const editId = prefix === 'b2b' ? hsnB2BEditId : hsnB2CEditId;

  const payload = {
    user_id: user.id, hsn_code: hsnCode, product_name: prodName,
    type, taxable_value: taxable, gst_percentage: gstPct,
    supply_type: supply, igst: r.igst, cgst: r.cgst, sgst: r.sgst,
    total_gst: r.totalGst, total_invoice_value: r.totalAmount,
    entry_date: new Date().toISOString().split('T')[0]
  };

  if (prefix === 'b2b') {
    payload.quantity = parseFloat(gt('hsnB2BQty')) || 0;
  }

  let error;
  if (editId) {
    ({ error } = await _supabase.from(table).update(payload).eq('id', editId));
  } else {
    ({ error } = await _supabase.from(table).insert(payload));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(editId ? 'HSN entry updated!' : 'HSN entry saved!');

  if (prefix === 'b2b') { hsnB2BEditId = null; resetHSN('b2b'); await loadB2BHSN(user.id); }
  else { hsnB2CEditId = null; resetHSN('b2c'); await loadB2CHSN(user.id); }
}

function resetHSN(prefix) {
  const p = prefix.toUpperCase();
  ['Code','Prod','Taxable'].forEach(s => { const el = document.getElementById(`hsn${p}${s}`); if (el) el.value = ''; });
  if (prefix === 'b2b') { const q = document.getElementById('hsnB2BQty'); if (q) q.value = ''; }
  document.getElementById(`hsn${p}Type`)?.querySelector('option')?.parentElement && (document.getElementById(`hsn${p}Type`).value = 'goods');
  document.getElementById(`hsn${p}GstPct`).value  = getDefaultGstPct();
  document.getElementById(`hsn${p}Supply`).value  = 'intrastate';
  recalcHSN(prefix);
  if (prefix === 'b2b') hsnB2BEditId = null;
  else hsnB2CEditId = null;
}

async function loadB2BHSN(userId) {
  const { data } = await _supabase.from('b2b_hsn').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  hsnB2BData = data || [];
  renderHSNTable('b2b', hsnB2BData);
}

async function loadB2CHSN(userId) {
  const { data } = await _supabase.from('b2c_hsn').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  hsnB2CData = data || [];
  renderHSNTable('b2c', hsnB2CData);
}

function renderHSNTable(prefix, data) {
  const tbody = document.getElementById(`hsn${prefix.toUpperCase()}TableBody`);
  const tfoot = document.getElementById(`hsn${prefix.toUpperCase()}TableTotal`);
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state"><i class="fas fa-barcode" style="display:block;font-size:40px;margin-bottom:10px;"></i>No HSN entries found</td></tr>`;
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  tbody.innerHTML = data.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><b>${r.hsn_code}</b></td>
      <td>${r.product_name}</td>
      <td><span class="badge badge-green">${r.type}</span></td>
      ${prefix === 'b2b' ? `<td style="text-align:center;">${r.quantity || 0}</td>` : ''}
      <td style="text-align:right;">₹${formatNum(r.taxable_value)}</td>
      <td style="text-align:center;">${r.gst_percentage}%</td>
      <td><span class="badge ${r.supply_type==='interstate'?'badge-blue':'badge-green'}">${r.supply_type}</span></td>
      <td style="text-align:right;">₹${formatNum(r.igst)}</td>
      <td style="text-align:right;">₹${formatNum(r.cgst)} / ₹${formatNum(r.sgst)}</td>
      <td style="text-align:right;font-weight:700;">₹${formatNum(r.total_gst)}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary-dark);">₹${formatNum(r.total_invoice_value)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editHSN('${prefix}','${r.id}')" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteHSN('${prefix}','${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const totals = {
    taxable: data.reduce((s,r)=>s+ +r.taxable_value,0),
    igst:    data.reduce((s,r)=>s+ +r.igst,0),
    cgst:    data.reduce((s,r)=>s+ +r.cgst,0),
    sgst:    data.reduce((s,r)=>s+ +r.sgst,0),
    totalGst: data.reduce((s,r)=>s+ +r.total_gst,0),
    totalInv: data.reduce((s,r)=>s+ +r.total_invoice_value,0)
  };
  const cols = prefix === 'b2b' ? 5 : 4;
  if (tfoot) tfoot.innerHTML = `<tr><td colspan="${cols}" style="font-weight:700;">TOTALS (${data.length})</td><td></td><td></td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.igst)}</td><td style="text-align:right;font-weight:700;">C+S: ₹${formatNum(totals.cgst + totals.sgst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.totalGst)}</td><td style="text-align:right;font-weight:700;">₹${formatNum(totals.totalInv)}</td><td></td></tr>`;
}

async function editHSN(prefix, id) {
  const data = prefix === 'b2b' ? hsnB2BData : hsnB2CData;
  const rec  = data.find(r => r.id === id);
  if (!rec) return;
  const p = prefix.toUpperCase();
  if (prefix === 'b2b') { hsnB2BEditId = id; document.getElementById('hsnB2BQty').value = rec.quantity || 0; }
  else hsnB2CEditId = id;

  document.getElementById(`hsn${p}Code`).value   = rec.hsn_code;
  document.getElementById(`hsn${p}Prod`).value   = rec.product_name;
  document.getElementById(`hsn${p}Type`).value   = rec.type;
  document.getElementById(`hsn${p}Taxable`).value = rec.taxable_value;
  document.getElementById(`hsn${p}GstPct`).value  = rec.gst_percentage;
  document.getElementById(`hsn${p}Supply`).value  = rec.supply_type;
  recalcHSN(prefix);

  if (prefix === 'b2b') {
    document.querySelectorAll('.tab-btn')[0].click();
  } else {
    document.querySelectorAll('.tab-btn')[1].click();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteHSN(prefix, id) {
  const ok = await showConfirm('Delete this HSN entry?');
  if (!ok) return;
  const table = prefix === 'b2b' ? 'b2b_hsn' : 'b2c_hsn';
  const { error } = await _supabase.from(table).delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('HSN entry deleted!');
  if (prefix === 'b2b') { hsnB2BData = hsnB2BData.filter(r=>r.id!==id); renderHSNTable('b2b', hsnB2BData); }
  else { hsnB2CData = hsnB2CData.filter(r=>r.id!==id); renderHSNTable('b2c', hsnB2CData); }
}

function switchHSNTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i)  => b.classList.toggle('active', i === (tab==='b2b'?0:1)));
  document.querySelectorAll('.tab-pane').forEach((p,i) => p.classList.toggle('active', i === (tab==='b2b'?0:1)));
}

function hsnTabClick(tab) {
  switchHSNTab(tab);
  // Sync URL hash & sidebar active state
  history.replaceState(null, '', '#' + tab);
  document.getElementById('sideB2BHSN')?.classList.toggle('active', tab === 'b2b');
  document.getElementById('sideB2CHSN')?.classList.toggle('active', tab === 'b2c');
  // Update page title
  const titleEl = document.querySelector('.page-title');
  if (titleEl) {
    titleEl.innerHTML = tab === 'b2c'
      ? '<i class="fas fa-tags" style="color:var(--primary);margin-right:8px;"></i>HSN Summary &mdash; B2C'
      : '<i class="fas fa-barcode" style="color:var(--primary);margin-right:8px;"></i>HSN Summary &mdash; B2B';
  }
}
