// =============================================
// Warranty Register - list
// =============================================
// Reads only the warranties table. Nothing here writes to, or reads from,
// b2b_invoices/b2c_invoices/invoice_items, which is what keeps the register
// out of the Dashboard, the ledgers, Reports and GSTR-1 without any of those
// needing a filter.
//
// Every read goes through the generic route, which scopes on the user_id in
// the verified JWT - never on anything this page could send - so one
// company's warranties are invisible to another.
let warrantyRows = [];
let warrantyPage = 1;
const WARRANTY_PAGE_SIZE = 15;

async function initWarrantyList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const filter = document.getElementById('wrStatusFilter');
  if (filter) {
    // Expired is offered even though it is never stored: it is derived per
    // row, and it is the thing a person most often comes here to look for.
    filter.innerHTML = '<option value="">All</option>'
      + WARRANTY_STATUSES.concat(['expired']).map(s =>
          `<option value="${escHtmlAttr(s)}">${escItemHtml(WARRANTY_STATUS_LABELS[s])}</option>`).join('');
  }
  await loadWarranties(user.id);
}

async function loadWarranties(userId) {
  const read = await readAll([
    _supabase.from('warranties').select('*').eq('user_id', userId)
  ], 'Could not load warranties');
  if (!read) return;
  warrantyRows = (read[0] || []).slice()
    .sort((a, b) => String(b.warranty_number).localeCompare(String(a.warranty_number)));
  renderWarrantyList();
}

function warrantyMatchesFilters(row) {
  const q = (document.getElementById('wrSearch')?.value || '').trim().toLowerCase();
  const want = document.getElementById('wrStatusFilter')?.value || '';
  if (want && warrantyEffectiveStatus(row) !== want) return false;
  if (!q) return true;
  return [row.warranty_number, row.customer_name, row.product_name,
          row.invoice_number, row.serial_number]
    .some(v => String(v || '').toLowerCase().includes(q));
}

function warrantyStatusBadge(row) {
  const st = warrantyEffectiveStatus(row);
  const cls = st === 'active' ? 'badge-green' : st === 'expired' ? 'badge-red' : 'badge-grey';
  return `<span class="badge ${cls}">${escItemHtml(WARRANTY_STATUS_LABELS[st])}</span>`;
}

function renderWarrantyList() {
  const body = document.getElementById('wrTableBody');
  if (!body) return;
  const rows = warrantyRows.filter(warrantyMatchesFilters);
  const start = (warrantyPage - 1) * WARRANTY_PAGE_SIZE;
  const page = rows.slice(start, start + WARRANTY_PAGE_SIZE);

  if (!page.length) {
    body.innerHTML = '<tr><td colspan="10" class="text-center text-muted-sm">'
      + 'No warranties yet. Create one from an invoice that has warranty on a product.</td></tr>';
    renderWarrantyPagination(rows.length);
    return;
  }

  body.innerHTML = page.map((r, i) => {
    const until = r.extended_until || r.warranty_until;
    const left = warrantyDaysRemaining(r);
    const st = warrantyEffectiveStatus(r);
    return `<tr>
      <td>${start + i + 1}</td>
      <td><b>${escItemHtml(r.warranty_number || '')}</b></td>
      <td>${escItemHtml(r.customer_name || '')}</td>
      <td>${escItemHtml(r.product_name || '')}${r.serial_number
        ? `<div class="fs-11 text-muted-sm">SN: ${escItemHtml(r.serial_number)}</div>` : ''}</td>
      <td>${escItemHtml(r.invoice_number || '')}</td>
      <td>${r.purchase_date ? escItemHtml(formatDate(r.purchase_date)) : '<span class="text-muted-sm">&mdash;</span>'}</td>
      <td>${escItemHtml(warrantyLabel(r.warranty_period_months) || '—')}</td>
      <td>${until ? escItemHtml(formatDate(until)) : '<span class="text-muted-sm">&mdash;</span>'}
        ${st === 'active' && left !== null && left <= 30
          ? `<div class="fs-11 text-muted-sm">${left} day${left === 1 ? '' : 's'} left</div>` : ''}</td>
      <td>${warrantyStatusBadge(r)}</td>
      <td>
        <div class="d-flex gap-8">
          <a class="btn btn-secondary btn-sm btn-icon" href="warranty.html?id=${encodeURIComponent(r.id)}" title="View / QR / NFC"><i class="fas fa-eye"></i></a>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="copyWarrantyVerifyLink('${r.id}')" title="Copy verification link"><i class="fas fa-copy"></i></button>
          ${st !== 'cancelled'
            ? `<button type="button" class="btn btn-danger btn-sm btn-icon" onclick="cancelWarranty('${r.id}')" title="Cancel"><i class="fas fa-ban"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
  renderWarrantyPagination(rows.length);
}

function renderWarrantyPagination(total) {
  const el = document.getElementById('wrPagination');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / WARRANTY_PAGE_SIZE));
  if (pages === 1) { el.innerHTML = ''; return; }
  let out = '';
  for (let p = 1; p <= pages; p++) {
    out += `<button type="button" class="btn btn-sm ${p === warrantyPage ? 'btn-primary' : 'btn-secondary'}" onclick="gotoWarrantyPage(${p})">${p}</button>`;
  }
  el.innerHTML = out;
}

function gotoWarrantyPage(p) { warrantyPage = p; renderWarrantyList(); }

// The same address the QR encodes and the tag carries - built in one place so
// the three can never disagree.
function copyWarrantyVerifyLink(id) {
  const url = warrantyVerifyUrl(id);
  if (!url) return;
  navigator.clipboard?.writeText(url)
    .then(() => showToast('Verification link copied.', 'success'))
    .catch(() => showToast(url, 'info'));
}

async function cancelWarranty(id) {
  const r = warrantyRows.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Cancel warranty ${r.warranty_number}? It stays on this list as a record, and the QR/NFC will report it as cancelled.`)) return;
  try {
    // Cancelling is a status change, not a delete: the tag keeps working and
    // starts telling the truth about the cover immediately.
    await _supabase.from('warranties')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'Cancelled from Warranty Register' })
      .eq('id', id);
    showToast('Warranty cancelled.', 'success');
    const user = await getCurrentUser();
    if (user) await loadWarranties(user.id);
  } catch (err) {
    handleApiError(err, 'Could not cancel the warranty');
  }
}
