// =============================================
// Document Register (Phase 2, Module 4C)
// =============================================
// Every GST document this system issues, in one list.
//
// The register asks the document registry what exists rather than keeping
// its own list of types. A document type that names a storage table shows
// up here the day it is added; one that does not is shown as declared but
// not yet built, so the register also answers "what can this system not
// yet issue?" without anyone maintaining a second list to answer it.
//
// Column names differ between tables — an invoice has invoice_number, a
// challan has document_number — so each table says which of its columns
// mean what. That map is the only per-table knowledge here, and it is
// about column naming, not about GST.

let drRows = [];
let drCustomers = new Map();
let drUserId = null;

// Which column carries the number, the date, the party and the total in
// each table. Tables added later fall back to the document_* names, which
// is what every Module 4B and 4C table already uses.
const DR_COLUMNS = {
  b2b_invoices:      { number: 'invoice_number', date: 'invoice_date', party: 'customer_name', total: 'total_amount', series: 'invoice_source' },
  b2c_invoices:      { number: 'invoice_number', date: 'invoice_date', party: 'customer_name', total: 'total_amount', series: 'invoice_source' },
  cdn_notes:         { number: 'note_number',    date: 'note_date',    party: 'customer_name', total: 'total_amount' },
  eway_bills:        { number: 'eway_bill_number', date: 'eway_bill_date', party: 'customer_name', total: 'total_value' },
  purchases:         { number: 'invoice_number', date: 'invoice_date', party: 'vendor_name',   total: 'total_amount' }
};
const DR_DEFAULT_COLUMNS = {
  number: 'document_number', date: 'document_date', party: 'party_name',
  total: 'total_value', series: 'document_series'
};

function drCols(table) { return Object.assign({}, DR_DEFAULT_COLUMNS, DR_COLUMNS[table] || {}); }
function drEl(id) { return document.getElementById(id); }

async function initDocumentRegister() {
  const user = await requireAuth();
  if (!user) return;
  drUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const typeSel = drEl('drType');
  if (typeSel) {
    // Straight from the registry — the register never keeps its own list.
    typeSel.innerHTML = '<option value="">All document types</option>' +
      GST_DOCUMENT_TYPES
        .filter(d => d.enabled && d.storage)
        .map(d => `<option value="${escHtmlAttr(d.key)}">${escItemHtml(d.label)}</option>`)
        .join('');
  }

  const cust = await _supabase.from('customers').select('*').eq('user_id', drUserId);
  (cust.data || []).forEach(c => drCustomers.set(c.id, c.customer_name || c.name || ''));

  await loadDocumentRegister();
  renderDeclaredButUnbuilt();
}

async function loadDocumentRegister() {
  if (!drUserId) return;

  // One read per table, however many types point at it.
  const types = GST_DOCUMENT_TYPES.filter(d => d.enabled && d.storage);
  const tables = [...new Set(types.map(d => d.storage))]
    .filter(t => !t.includes('/'));   // the invoice pair is read as two tables below
  if (types.some(d => d.storage && d.storage.includes('/'))) {
    tables.push('b2b_invoices', 'b2c_invoices');
  }

  const results = await Promise.all([...new Set(tables)].map(t =>
    _supabase.from(t).select('*').eq('user_id', drUserId).then(r => ({ table: t, data: r.data || [] }))
      .catch(() => ({ table: t, data: [] }))));

  const out = [];
  results.forEach(({ table, data }) => {
    const c = drCols(table);
    data.forEach(row => {
      // A row that names its own document type is taken at its word —
      // that is how the four challan variants share one table.
      const declared = String(row.document_type || '').trim();
      const forTable = types.filter(t => t.storage === table
        || (t.storage && t.storage.includes('/') && t.storage.includes(table)));
      const spec = (declared && forTable.find(t => t.key === declared))
        || (forTable.length === 1 ? forTable[0] : null);

      out.push({
        id: row.id,
        table,
        type: spec ? spec.key : '',
        typeLabel: spec ? spec.label : table,
        number: row[c.number] || '',
        date: row[c.date] || '',
        series: row[c.series] || (spec ? spec.series : '') || '',
        source: row.invoice_source || row.document_series || (spec ? spec.series : '') || '',
        status: String(row.status || 'issued').toLowerCase(),
        cancelled: String(row.status || '').toLowerCase() === 'cancelled',
        party: row[c.party] || drCustomers.get(row.customer_id) || '',
        total: row[c.total] != null ? row[c.total] : (row.total_amount != null ? row.total_amount : null)
      });
    });
  });

  drRows = out;
  applyRegisterFilters();
}

function applyRegisterFilters() {
  const v = id => (drEl(id)?.value || '').trim().toLowerCase();
  const type = v('drType'), series = v('drSeries'), source = v('drSource');
  const status = v('drStatus'), party = v('drParty'), number = v('drNumber');
  const from = v('drFrom'), to = v('drTo');

  const rows = drRows.filter(r => {
    if (type && r.type !== type) return false;
    if (series && !String(r.series).toLowerCase().includes(series)) return false;
    if (source && !String(r.source).toLowerCase().includes(source)) return false;
    if (status && r.status !== status) return false;
    if (party && !String(r.party).toLowerCase().includes(party)) return false;
    if (number && !String(r.number).toLowerCase().includes(number)) return false;
    // Dates compared as plain strings: a date-only value turned into a
    // Date shifts a day either side of midnight depending on the timezone.
    if (from && String(r.date) < from) return false;
    if (to && String(r.date) > to) return false;
    return true;
  });

  rows.sort((a, b) => String(b.date).localeCompare(String(a.date))
    || compareInvoiceNumbers(b.number, a.number));
  renderRegister(rows);
}

function renderRegister(rows) {
  const body = drEl('drBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="text-center text-muted p-16">No documents match these filters.</td></tr>`;
  } else {
    body.innerHTML = rows.map(r => `<tr class="${r.cancelled ? 'text-muted' : ''}">
      <td class="fw-600">${escItemHtml(r.number)}</td>
      <td>${escItemHtml(r.typeLabel)}</td>
      <td>${escItemHtml(r.date ? formatDate(r.date) : '—')}</td>
      <td>${escItemHtml(r.series || '—')}</td>
      <td>${escItemHtml(r.source || '—')}</td>
      <td><span class="badge ${r.cancelled ? 'badge-danger' : 'badge-success'}">${r.cancelled ? 'Cancelled' : 'Issued'}</span></td>
      <td class="text-center">${r.cancelled ? '<i class="fas fa-ban text-danger"></i>' : '—'}</td>
      <td>${escItemHtml(r.party || '—')}</td>
      <td class="text-right">${r.total == null ? '—' : formatCurrency(r.total)}</td>
    </tr>`).join('');
  }
  const count = drEl('drCount');
  if (count) {
    const cancelled = rows.filter(r => r.cancelled).length;
    count.textContent = `${rows.length} document${rows.length === 1 ? '' : 's'}` +
      (cancelled ? ` · ${cancelled} cancelled` : '');
  }
}

function resetRegisterFilters() {
  ['drType', 'drSeries', 'drSource', 'drStatus', 'drParty', 'drNumber', 'drFrom', 'drTo']
    .forEach(id => { const e = drEl(id); if (e) e.value = ''; });
  applyRegisterFilters();
}

// What the registry knows about but this system cannot yet issue. Shown
// so the gap is visible rather than discovered at filing time.
function renderDeclaredButUnbuilt() {
  const box = drEl('drUnbuilt');
  if (!box) return;
  const pending = GST_DOCUMENT_TYPES.filter(d => !d.enabled);
  if (!pending.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="text-muted-sm mb-8"><i class="fas fa-circle-info"></i>
      Declared in the document registry, not yet issuable here:</p>
    <div class="d-flex gap-8 flex-wrap">${pending
      .map(d => `<span class="badge badge-secondary">${escItemHtml(d.label)}</span>`).join('')}</div>`;
}

function exportRegisterCsv() {
  const rows = [...drEl('drBody').querySelectorAll('tr')]
    .map(tr => [...tr.children].map(td => `"${String(td.innerText).replace(/"/g, '""').replace(/\s+/g, ' ').trim()}"`).join(','));
  if (!rows.length) return;
  const head = '"Number","Type","Date","Series","Source","Status","Cancelled","Party","Total"';
  const blob = new Blob([head + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'document-register.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

