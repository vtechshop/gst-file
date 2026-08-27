// =============================================
// Proforma Invoice List
// =============================================
// Reads only the proforma tables. Nothing here writes to, or reads from,
// b2b_invoices/b2c_invoices - which is what keeps quotations out of the
// Invoice List, the Dashboard, the ledgers and GSTR-1 without any of those
// needing a filter.
let proformaRows = [];
let proformaItemsByParent = {};
let proformaPage = 1;
const PROFORMA_PAGE_SIZE = 15;

async function initProformaList() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const filter = document.getElementById('pfStatusFilter');
  if (filter) {
    // Expired is offered as a filter even though it is never stored - it is
    // derived per row, and it is the thing a user most wants to look for.
    filter.innerHTML = '<option value="">All</option>' +
      PROFORMA_STATUSES.concat(['expired']).map(s =>
        `<option value="${escHtmlAttr(s)}">${escItemHtml(PROFORMA_STATUS_LABELS[s])}</option>`).join('');
  }
  await loadProformas(user.id);
}

async function loadProformas(userId) {
  const read = await readAll([
    _supabase.from('proforma_invoices').select('*').eq('user_id', userId),
    _supabase.from('proforma_invoice_items').select('*').eq('user_id', userId)
  ], 'Could not load proforma invoices');
  if (!read) return;
  proformaRows = (read[0] || []).slice()
    .sort((a, b) => String(b.document_date).localeCompare(String(a.document_date)));
  proformaItemsByParent = {};
  (read[1] || []).forEach((it) => {
    (proformaItemsByParent[it.proforma_invoice_id] ||= []).push(it);
  });
  Object.values(proformaItemsByParent).forEach(list =>
    list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
  renderProformaList();
}

function proformaMatchesFilters(row) {
  const q = (document.getElementById('pfSearch')?.value || '').trim().toLowerCase();
  const want = document.getElementById('pfStatusFilter')?.value || '';
  if (want && proformaEffectiveStatus(row) !== want) return false;
  if (!q) return true;
  return String(row.document_number || '').toLowerCase().includes(q)
      || String(row.customer_name || '').toLowerCase().includes(q);
}

function proformaStatusBadge(row) {
  const st = proformaEffectiveStatus(row);
  const cls = st === 'converted' ? 'badge-green'
            : st === 'cancelled' ? 'badge-grey'
            : st === 'expired' ? 'badge-red'
            : st === 'accepted' ? 'badge-blue' : 'badge-amber';
  return `<span class="badge ${cls}">${escItemHtml(PROFORMA_STATUS_LABELS[st])}</span>`;
}

function renderProformaList() {
  const body = document.getElementById('pfTableBody');
  if (!body) return;
  const rows = proformaRows.filter(proformaMatchesFilters);
  const start = (proformaPage - 1) * PROFORMA_PAGE_SIZE;
  const page = rows.slice(start, start + PROFORMA_PAGE_SIZE);

  if (!page.length) {
    body.innerHTML = '<tr><td colspan="9" class="text-center text-muted-sm">No proforma invoices yet.</td></tr>';
    renderProformaPagination(rows.length);
    return;
  }

  body.innerHTML = page.map((r, i) => {
    const st = proformaEffectiveStatus(r);
    // A quotation that has already become an invoice is not imported again -
    // that would quietly raise a second invoice for the same offer.
    const canImport = st !== 'converted' && st !== 'cancelled';
    const converted = r.converted_invoice_id
      ? `<span class="fs-11">${escItemHtml(String(r.converted_invoice_type || '').toUpperCase())} &middot; ${escItemHtml(r.converted_invoice_id.slice(0, 8))}</span>`
      : '<span class="text-muted-sm">&mdash;</span>';
    return `<tr>
      <td>${start + i + 1}</td>
      <td><b>${escItemHtml(r.document_number || '')}</b></td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.customer_name || '')}</td>
      <td class="text-right">&#8377;${formatNum(r.total_amount)}</td>
      <td>${r.valid_until ? escItemHtml(formatDate(r.valid_until)) : '<span class="text-muted-sm">&mdash;</span>'}</td>
      <td>${proformaStatusBadge(r)}</td>
      <td>${converted}</td>
      <td>
        <div class="d-flex gap-8">
          <a class="btn btn-secondary btn-sm btn-icon" href="proforma.html?id=${encodeURIComponent(r.id)}" title="View / Edit"><i class="fas fa-pen"></i></a>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="downloadProformaPDF('${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
          ${canImport ? `<button type="button" class="btn btn-primary btn-sm" onclick="importProformaIntoInvoice('${r.id}')" title="Open Invoice Entry with this data"><i class="fas fa-file-import"></i> Import into Invoice</button>` : ''}
          ${canImport ? `<button type="button" class="btn btn-danger btn-sm btn-icon" onclick="cancelProforma('${r.id}')" title="Cancel"><i class="fas fa-ban"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
  renderProformaPagination(rows.length);
}

function renderProformaPagination(total) {
  const el = document.getElementById('pfPagination');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / PROFORMA_PAGE_SIZE));
  if (pages === 1) { el.innerHTML = ''; return; }
  let out = '';
  for (let p = 1; p <= pages; p++) {
    out += `<button type="button" class="btn btn-sm ${p === proformaPage ? 'btn-primary' : 'btn-secondary'}" onclick="gotoProformaPage(${p})">${p}</button>`;
  }
  el.innerHTML = out;
}

function gotoProformaPage(p) {
  proformaPage = p;
  renderProformaList();
}

function proformaById(id) {
  return proformaRows.find(r => r.id === id) || null;
}

// ── Import into Invoice ────────────────────────────
// Copies the quotation into the SAME draft Invoice Entry already uses for
// Duplicate, rather than inventing a second prefill route. Nothing is saved
// and no invoice number is reserved here: the user lands on a normal, fully
// editable New Invoice form, and an ordinary save is what creates the tax
// invoice. The proforma itself is not touched - it is marked Converted only
// after that save succeeds (see markProformaConverted in invoice-entry.js).
function importProformaIntoInvoice(id) {
  const r = proformaById(id);
  if (!r) { showToast('Proforma not found.', 'error'); return; }
  const items = (proformaItemsByParent[id] || []).map(it => ({
    product_id: it.product_id, product_name: it.product_name, hsn_code: it.hsn_code,
    unit: it.unit, quantity: it.quantity, rate: it.rate,
    discount_percentage: it.discount_percentage, gst_percentage: it.gst_percentage,
    taxable_value: it.taxable_value, gst_amount: it.gst_amount,
    igst: it.igst, cgst: it.cgst, sgst: it.sgst, total_amount: it.total_amount,
    gst_treatment: it.gst_treatment, cess_rate: it.cess_rate, cess_amount: it.cess_amount
  }));
  if (!items.length) { showToast('This proforma has no line items.', 'error'); return; }

  sessionStorage.setItem('invoice_duplicate_draft', JSON.stringify({
    // A quoted party with a GSTIN is a B2B sale; without, B2C. The user can
    // still switch it on the form.
    type: r.gst_number ? 'b2b' : 'b2c',
    customer_name: r.customer_name, gst_number: r.gst_number, phone: r.phone,
    address: r.address, state: r.state, district: r.district,
    shipping_address: r.shipping_address, shipping_state: r.shipping_state,
    shipping_district: r.shipping_district,
    supply_type: r.supply_type, gst_category: r.gst_category,
    // Read once by Invoice Entry and used only after a successful save.
    source_proforma_id: r.id,
    items
  }));
  window.location.href = 'invoice.html?duplicate=1';
}

async function cancelProforma(id) {
  const r = proformaById(id);
  if (!r) return;
  if (!confirm(`Cancel proforma ${r.document_number}? It stays on this list as a record.`)) return;
  try {
    await apiFetch(`/documents/proforma_invoice/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cancelled from Proforma list' })
    });
    showToast('Proforma cancelled.', 'success');
    const user = await getCurrentUser();
    if (user) await loadProformas(user.id);
  } catch (err) {
    handleApiError(err, 'Could not cancel the proforma');
  }
}

async function downloadProformaPDF(id) {
  const r = proformaById(id);
  if (!r) { showToast('Proforma not found.', 'error'); return; }
  try {
    await downloadProformaDocument(r, proformaItemsByParent[id] || []);
  } catch (err) {
    handleApiError(err, 'Could not generate the proforma PDF');
  }
}
