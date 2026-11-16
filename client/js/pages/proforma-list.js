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
  // Before any row is drawn: the list shows stored numbers under the format
  // configured now, and the sort reads the sequence out of them.
  await ensureProformaDisplayFormat();
  await loadProformas(user.id);
}

async function loadProformas(userId) {
  const read = await readAll([
    _supabase.from('proforma_invoices').select('*').eq('user_id', userId),
    _supabase.from('proforma_invoice_items').select('*').eq('user_id', userId)
  ], 'Could not load proforma invoices');
  if (!read) return;
  // Highest proforma number first - 256, 169, 168... - read numerically out
  // of the stored number under the configured format, so 256 sorts above 99
  // where a string compare would not. A number no rule can read sorts after
  // every one that can, newest first among themselves; see
  // compareDocumentNumberDesc() in utils.js.
  proformaRows = (read[0] || []).slice()
    .sort((a, b) => compareDocumentNumberDesc(a, b, proformaDisplayFormat()));
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
  // Matched against both the stored number and the one on screen, so a
  // search for PI-00165 finds a row stored as a bare 165, and a search for
  // 165 still finds it too.
  return String(row.document_number || '').toLowerCase().includes(q)
      || proformaDisplayNumber(row.document_number).toLowerCase().includes(q)
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
  renderProformaFormatNotice();
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
      <td><b>${escItemHtml(proformaDisplayNumber(r.document_number))}</b></td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.customer_name || '')}</td>
      <td class="text-right">&#8377;${formatNum(r.total_amount)}</td>
      <td>${r.valid_until ? escItemHtml(formatDate(r.valid_until)) : '<span class="text-muted-sm">&mdash;</span>'}</td>
      <td>${proformaStatusBadge(r)}</td>
      <td>${converted}</td>
      <td>
        <div class="action-btns">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="viewProformaFromList('${r.id}')" title="View"><i class="fas fa-eye"></i></button>
          <a class="btn btn-secondary btn-sm btn-icon" href="proforma.html?id=${encodeURIComponent(r.id)}" title="Edit"><i class="fas fa-edit"></i></a>
          <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="downloadProformaPDF('${r.id}')" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" onclick="printProformaFromList('${r.id}')" title="Print"><i class="fas fa-print"></i></button>
          <button type="button" class="btn btn-success btn-sm btn-icon" onclick="shareProformaFromList('${r.id}')" title="Share via WhatsApp"><i class="fab fa-whatsapp"></i></button>
          <button type="button" class="btn btn-info btn-sm btn-icon btn-info-alt" onclick="emailProformaFromList('${r.id}')" title="Email PDF"><i class="fas fa-envelope"></i></button>
          ${canImport ? `<button type="button" class="btn btn-primary btn-sm" onclick="importProformaIntoInvoice('${r.id}')" title="Open Invoice Entry with this data"><i class="fas fa-file-import"></i> Convert to Invoice</button>` : ''}
          ${canImport ? `<button type="button" class="btn btn-danger btn-sm btn-icon" onclick="cancelProforma('${r.id}')" title="Cancel"><i class="fas fa-ban"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
  renderProformaPagination(rows.length);
}

// Said once, above the list, rather than per row: the saved format cannot
// draw a number, so the numbers below are the stored ones. The format itself
// is left exactly as saved - this is a message, not a correction.
function renderProformaFormatNotice() {
  const el = document.getElementById('pfFormatNotice');
  if (!el) return;
  const problem = typeof proformaDisplayFormatProblem === 'function'
    ? proformaDisplayFormatProblem() : null;
  if (!problem) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = 'Your saved Proforma number format cannot be used: ' + problem
    + ' The numbers below are shown exactly as they are stored. Fix the format in '
    + 'Settings \u2192 Proforma Numbering; nothing here has been changed.';
  el.style.display = '';
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
    // The quoted delivery charge, so the invoice bills what the customer was
    // quoted. Only the charge travels: the invoice derives its own tax from
    // it and its lines, at the principal supply's rate.
    transport_charge: r.transport_charge,
    // What the quotation asked for up front. It travels so the invoice can
    // SAY so, and for no other purpose: it fills in no payment field,
    // records no receipt and marks nothing paid. See the note Invoice Entry
    // shows, and the reasoning in loadInvoiceDraft().
    advance_amount: r.advance_amount,
    // Read once by Invoice Entry and used only after a successful save.
    source_proforma_id: r.id,
    items
  }));
  window.location.href = 'invoice.html?duplicate=1';
}

async function cancelProforma(id) {
  const r = proformaById(id);
  if (!r) return;
  if (!confirm(`Cancel proforma ${proformaDisplayNumber(r.document_number)}? It stays on this list as a record.`)) return;
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

// Preview, in the modal on this page rather than a second tab - the same
// place and the same iframe the Tax Invoice List reviews an invoice in. The
// markup is buildProformaHTML()'s, which is what print and the PDF are built
// from, so what is reviewed here is what gets sent.
async function viewProformaFromList(id) {
  const r = proformaById(id);
  if (!r) { showToast('Proforma not found.', 'error'); return; }
  try {
    const html = await buildProformaHTML(r, proformaItemsByParent[id] || [], { autoPrint: false });
    const frame = document.getElementById('viewProformaFrame');
    if (frame) frame.srcdoc = html;
    document.getElementById('viewProformaModal')?.classList.add('open');
  } catch (err) {
    handleApiError(err, 'Could not open the proforma preview');
  }
}

function closeViewProformaModal() {
  document.getElementById('viewProformaModal')?.classList.remove('open');
}

async function printProformaFromList(id) {
  const r = proformaById(id);
  if (!r) { showToast('Proforma not found.', 'error'); return; }
  try {
    await printProformaDocument(r, proformaItemsByParent[id] || []);
  } catch (err) {
    handleApiError(err, 'Could not print the proforma');
  }
}

// Opens WhatsApp with the message prepared. Nothing is sent from here and no
// customer number is dialled - the person reviews it and presses send.
async function shareProformaFromList(id) {
  const r = proformaById(id);
  if (!r) { showToast('Proforma not found.', 'error'); return; }
  try {
    await shareProformaWhatsApp(r, proformaItemsByParent[id] || []);
  } catch (err) {
    handleApiError(err, 'Could not open WhatsApp for this proforma');
  }
}

// Downloads the PDF and opens the mail client with the details filled in -
// there is no mail server in this application, and a browser will not attach
// a file from a mailto: link, so the file is downloaded for attaching.
async function emailProformaFromList(id) {
  const r = proformaById(id);
  if (!r) { showToast('Proforma not found.', 'error'); return; }
  try {
    await emailProformaDocument(r, proformaItemsByParent[id] || []);
  } catch (err) {
    handleApiError(err, 'Could not prepare the proforma email');
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
