// =============================================
// Bill of Supply (Batch 5)
// =============================================
// Rule 49. Issued INSTEAD of a tax invoice by a composition dealer or by
// anyone supplying exempt, nil-rated or non-GST goods. No tax is charged,
// so there is no tax to enter — the value is the supply.
//
// It reaches GSTR-1 Table 8 (the nil/exempt/non-GST summary), never the
// taxable sections, and its number is reported in Table 13 row 1, which it
// shares with tax invoices because that table reports numbering series
// rather than tax status.

const BOS_TYPE = 'bill_of_supply';
let bosRows = [], bosCustomers = [], bosProducts = [], bosItems = [], bosEditId = null, bosUserId = null;

const BOS_NATURES = [
  { value: 'exempted',  label: 'Exempted',  hint: 'Exempt under a notification' },
  { value: 'nil_rated', label: 'Nil rated', hint: 'Taxable at 0%' },
  { value: 'non_gst',   label: 'Non-GST',   hint: 'Outside GST — alcohol, petrol and the like' }
];

function bosEl(id) { return document.getElementById(id); }
function bosVal(id) { return (bosEl(id)?.value || '').trim(); }
function bosRound(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

async function initBillOfSupply() {
  const user = await requireAuth();
  if (!user) return;
  bosUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const nat = bosEl('bosNature');
  if (nat) {
    nat.innerHTML = BOS_NATURES
      .map(n => `<option value="${escHtmlAttr(n.value)}">${escItemHtml(n.label)} — ${escItemHtml(n.hint)}</option>`)
      .join('');
  }

  const [cust, prod] = await Promise.all([
    _supabase.from('customers').select('*').eq('user_id', bosUserId),
    _supabase.from('products').select('*').eq('user_id', bosUserId)
  ]);
  bosCustomers = cust.data || [];
  bosProducts = prod.data || [];

  const sel = bosEl('bosCustomer');
  if (sel) {
    sel.innerHTML = '<option value="">— select or type below —</option>' +
      bosCustomers.map(c => `<option value="${escHtmlAttr(c.id)}">${escItemHtml(c.customer_name || c.name || '')}</option>`).join('');
  }
  const d = bosEl('bosDate');
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);

  renderBosRegistryPanel();
  renderBosItems();
  await loadBillsOfSupply();
}

function renderBosRegistryPanel() {
  const box = bosEl('bosRegistryBox');
  if (!box) return;
  const s = gstDocumentTypeSpec(BOS_TYPE);
  if (!s) return;
  const row = typeof gstTable13RowFor === 'function' ? gstTable13RowFor(BOS_TYPE) : null;
  const yn = v => v ? '<span class="text-danger fw-600">Yes</span>' : '<span class="text-success fw-600">No</span>';
  box.innerHTML = `
    <div class="d-flex gap-16 flex-wrap fs-12">
      <div><span class="text-muted">Rule</span> <b>${escItemHtml(s.rule || '—')}</b></div>
      <div><span class="text-muted">Filed in</span> <b>${escItemHtml(gstDocumentSections(BOS_TYPE).map(x => `${x.ret} ${x.table}`).join(' · ') || '—')}</b></div>
      <div><span class="text-muted">Table 13 row</span> <b>${row ? row.docNum : '—'}</b></div>
      <div><span class="text-muted">Taxable supply</span> ${yn(s.taxable)}</div>
      <div><span class="text-muted">Counts in turnover</span> ${yn(s.affectsTurnover)}</div>
      <div><span class="text-muted">Creates liability</span> ${yn(s.affectsLiability)}</div>
    </div>`;
}

function bosAddItem() {
  bosItems.push({ product_name: '', hsn_code: '', unit: '', quantity: 1, rate: 0, total_value: 0 });
  renderBosItems();
}
function bosRemoveItem(i) { bosItems.splice(i, 1); renderBosItems(); }

function bosOnItemChange(i, field, value) {
  const it = bosItems[i];
  if (!it) return;
  it[field] = value;
  if (field === 'product_name') {
    const p = bosProducts.find(x => (x.product_name || '').toLowerCase() === String(value).toLowerCase());
    if (p) {
      const eff = typeof productEffective === 'function' ? productEffective(p) : p;
      it.hsn_code = eff.hsn_code || '';
      it.unit = eff.unit || '';
      if (!it.rate) it.rate = eff.selling_price || 0;
    }
  }
  it.total_value = bosRound((parseFloat(it.quantity) || 0) * (parseFloat(it.rate) || 0));
  renderBosItems();
}

function renderBosItems() {
  const body = bosEl('bosItemsBody');
  if (!body) return;
  if (!bosItems.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-center text-muted p-16">No lines yet.</td></tr>`;
  } else {
    body.innerHTML = bosItems.map((it, i) => `
      <tr>
        <td><input class="form-control form-control-sm" list="bosProductList" value="${escHtmlAttr(it.product_name)}"
             onchange="bosOnItemChange(${i},'product_name',this.value)"></td>
        <td><input class="form-control form-control-sm w-110" value="${escHtmlAttr(it.hsn_code || '')}"
             onchange="bosOnItemChange(${i},'hsn_code',this.value)"></td>
        <td><input class="form-control form-control-sm w-90" value="${escHtmlAttr(it.unit || '')}"
             onchange="bosOnItemChange(${i},'unit',this.value)"></td>
        <td><input type="number" step="0.001" class="form-control form-control-sm w-100 text-right" value="${it.quantity}"
             onchange="bosOnItemChange(${i},'quantity',this.value)"></td>
        <td><input type="number" step="0.01" class="form-control form-control-sm w-110 text-right" value="${it.rate}"
             onchange="bosOnItemChange(${i},'rate',this.value)"></td>
        <td class="text-right fw-600">${formatCurrency(it.total_value || 0)}
          <button type="button" class="btn btn-sm btn-danger ml-8" onclick="bosRemoveItem(${i})"><i class="fas fa-times"></i></button></td>
      </tr>`).join('');
  }
  const total = bosItems.reduce((s, it) => s + (parseFloat(it.total_value) || 0), 0);
  const el = bosEl('bosTotal');
  if (el) el.textContent = formatCurrency(bosRound(total));
}

async function bosAutoNumber() {
  if (!gstDocumentSupportsAutoNumbering(BOS_TYPE)) return;
  try {
    const res = await apiFetch('/documents/reserve-number', {
      method: 'POST', body: JSON.stringify({ documentType: BOS_TYPE })
    });
    if (res && res.documentNumber) bosEl('bosNumber').value = res.documentNumber;
  } catch (e) { bosError('bosNumberError', e.message || String(e)); }
}

function bosError(id, msg) {
  const el = bosEl(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}

function validateBillOfSupply() {
  const errors = {};
  if (!bosVal('bosNumber')) errors.bosNumberError = 'A number is required.';
  if (!bosVal('bosDate')) errors.bosDateError = 'A date is required.';
  if (!bosVal('bosCustomer') && !bosVal('bosPartyName')) errors.bosPartyError = 'Name who it was issued to.';
  if (!bosItems.length) errors.bosItemsError = 'A bill of supply must list what was supplied.';
  if (bosItems.some(it => !String(it.product_name || '').trim())) {
    errors.bosItemsError = 'Every line needs a description.';
  }
  const dt = bosVal('bosDate');
  if (dt && typeof GST_COMMENCEMENT === 'string' && dt < GST_COMMENCEMENT) {
    errors.bosDateError = `GST began on ${GST_COMMENCEMENT}; a bill of supply cannot be dated before it.`;
  }
  // A return cannot contain a future-dated document — the same rule every
  // other document follows.
  const today = new Date().toISOString().slice(0, 10);
  if (dt && dt > today) errors.bosDateError = 'A bill of supply cannot be dated in the future.';
  return errors;
}

async function saveBillOfSupply() {
  ['bosNumberError', 'bosDateError', 'bosPartyError', 'bosItemsError'].forEach(id => bosError(id, ''));
  const errors = validateBillOfSupply();
  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([id, m]) => bosError(id, m));
    return;
  }
  const custId = bosVal('bosCustomer') || null;
  const cust = bosCustomers.find(c => c.id === custId);
  const total = bosRound(bosItems.reduce((s, it) => s + (parseFloat(it.total_value) || 0), 0));

  const doc = {
    document_number: bosVal('bosNumber'),
    document_date: bosVal('bosDate'),
    status: 'issued',
    customer_id: custId,
    party_name: bosVal('bosPartyName') || (cust && (cust.customer_name || cust.name)) || '',
    party_gstin: (cust && cust.gst_number) || bosVal('bosPartyGstin') || null,
    place_of_supply: bosVal('bosPlaceOfSupply') || null,
    supply_type: bosVal('bosSupplyType') || 'intrastate',
    supply_nature: bosVal('bosNature') || 'exempted',
    total_value: total,
    reason: bosVal('bosReason') || null,
    notes: bosVal('bosNotes') || null
  };
  const items = bosItems.map((it, i) => ({
    product_name: String(it.product_name || '').trim(),
    hsn_code: it.hsn_code || null, unit: it.unit || null,
    quantity: parseFloat(it.quantity) || 0, rate: parseFloat(it.rate) || 0,
    total_value: bosRound(it.total_value), gst_treatment: doc.supply_nature, sort_order: i
  }));

  try {
    await apiFetch(`/documents/${BOS_TYPE}/save`, {
      method: 'POST', body: JSON.stringify({ editId: bosEditId, document: doc, items })
    });
    resetBillOfSupplyForm();
    await loadBillsOfSupply();
    if (typeof showToast === 'function') showToast('Bill of supply saved.', 'success');
  } catch (e) { bosError('bosNumberError', e.message || String(e)); }
}

function resetBillOfSupplyForm() {
  bosEditId = null;
  ['bosNumber', 'bosPartyName', 'bosPartyGstin', 'bosPlaceOfSupply', 'bosReason', 'bosNotes']
    .forEach(id => { const e = bosEl(id); if (e) e.value = ''; });
  const c = bosEl('bosCustomer'); if (c) c.value = '';
  const d = bosEl('bosDate'); if (d) d.value = new Date().toISOString().slice(0, 10);
  bosItems = [];
  renderBosItems();
}

async function loadBillsOfSupply() {
  if (!bosUserId) return;
  const { data, error } = await _supabase.from('bill_of_supply').select('*').eq('user_id', bosUserId);
  // Reported and abandoned rather than rendered as an empty list — an
  // empty table is indistinguishable from having no records at all.
  if (error) { handleApiError(error, 'Could not load the bills of supply'); return; }
  bosRows = (data || []).sort((a, b) => compareInvoiceNumbers(b.document_number, a.document_number));
  const body = bosEl('bosListBody');
  if (!body) return;
  if (!bosRows.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-center text-muted p-16">No bills of supply yet.</td></tr>`;
    return;
  }
  body.innerHTML = bosRows.map(r => {
    const cancelled = String(r.status).toLowerCase() === 'cancelled';
    const nature = (BOS_NATURES.find(n => n.value === r.supply_nature) || {}).label || r.supply_nature;
    return `<tr class="${cancelled ? 'text-muted' : ''}">
      <td class="fw-600">${escItemHtml(r.document_number)}</td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.party_name || '')}</td>
      <td>${escItemHtml(nature)}</td>
      <td class="text-right">${formatCurrency(r.total_value || 0)}</td>
      <td class="text-center">
        <span class="badge ${cancelled ? 'badge-danger' : 'badge-success'}">${cancelled ? 'Cancelled' : 'Issued'}</span>
        <button class="btn btn-sm btn-warning ml-8" onclick="cancelBillOfSupply('${escHtmlAttr(r.id)}')" ${cancelled ? 'disabled' : ''}><i class="fas fa-ban"></i></button>
      </td></tr>`;
  }).join('');
}

async function cancelBillOfSupply(id) {
  if (!gstDocumentSupportsCancellation(BOS_TYPE)) return;
  const reason = prompt('Why is this bill of supply being cancelled?');
  if (reason === null) return;
  try {
    await apiFetch(`/documents/${BOS_TYPE}/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    await loadBillsOfSupply();
  } catch (e) { alert(e.message || String(e)); }
}
