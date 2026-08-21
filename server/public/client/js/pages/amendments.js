// =============================================
// Amendments to already-filed returns (Batch 7)
// =============================================
// An amendment is not an edit. The original figures were filed and stay
// filed; the amendment says what they should have been, and it belongs to
// the period it is MADE in, not the period it corrects. Editing the
// original invoice instead would silently change a return already
// submitted, which is the one thing that must never happen.
//
// So an amendment is its own record, pointing at what it amends.
//
// What reaches the JSON is deliberately narrower than what is recorded
// here. b2ba and b2cla have a shape corroborated by two independent
// references; b2csa, cdnra, cdnura and the advance amendments do not, and
// a section written to a guessed shape risks the whole return. Everything
// is captured either way, and the export says plainly which ones it is
// holding back.

let amRows = [], amInvoices = [], amNotes = [], amUserId = null;

// Which sections can be amended, and what each one is called on the
// portal. `emitted` is the honest part: it says whether recording an
// amendment here will actually put anything in the JSON.
const AM_SECTIONS = [
  { value: 'b2b',   label: 'B2B invoice (Table 9A)',            emitted: true },
  { value: 'b2cl',  label: 'B2CL invoice (Table 9A)',           emitted: true },
  { value: 'b2cs',  label: 'B2CS summary (Table 10)',           emitted: false },
  { value: 'cdnr',  label: 'Credit/debit note, registered (9C)', emitted: false },
  { value: 'cdnur', label: 'Credit/debit note, unregistered (9C)', emitted: false },
  { value: 'at',    label: 'Advance received (Table 11A)',      emitted: false },
  { value: 'txpd',  label: 'Advance adjusted (Table 11B)',      emitted: false }
];

function amEl(id) { return document.getElementById(id); }
function amVal(id) { return (amEl(id)?.value || '').trim(); }
function amNum(id) { const n = parseFloat(amEl(id)?.value); return Number.isFinite(n) ? n : 0; }
function amRound(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// "2026-06" -> "062026", the form every amendment period takes.
function amPeriodOf(dateISO) {
  const [y, m] = String(dateISO || '').split('-');
  return (m && y) ? `${m}${y}` : '';
}

async function initAmendments() {
  const user = await requireAuth();
  if (!user) return;
  amUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const sel = amEl('amSection');
  if (sel) {
    sel.innerHTML = AM_SECTIONS.map(x =>
      `<option value="${escHtmlAttr(x.value)}">${escItemHtml(x.label)}${x.emitted ? '' : ' — recorded, not yet in JSON'}</option>`
    ).join('');
  }
  const d = amEl('amAmendmentDate');
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);

  await loadAmendments();
  onAmSectionChange();
}

async function loadAmendments() {
  const [b2b, b2c, notes, ams] = await Promise.all([
    _supabase.from('b2b_invoices').select('*').eq('user_id', amUserId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', amUserId),
    _supabase.from('cdn_notes').select('*').eq('user_id', amUserId),
    _supabase.from('gst_amendments').select('*').eq('user_id', amUserId)
  ]);
  amInvoices = [
    ...(b2b.data || []).map(r => ({ ...r, __table: 'b2b_invoices' })),
    ...(b2c.data || []).map(r => ({ ...r, __table: 'b2c_invoices' }))
  ];
  amNotes = (notes.data || []).map(r => ({ ...r, __table: 'cdn_notes' }));
  amRows = ams.data || [];
  renderAmendmentPicker();
  renderAmendments();
}

// The picker offers documents, not free text: an amendment that does not
// point at something already filed is not an amendment.
function renderAmendmentPicker() {
  const sel = amEl('amOriginal');
  if (!sel) return;
  const section = amVal('amSection');
  const source = (section === 'cdnr' || section === 'cdnur') ? amNotes : amInvoices;
  const label = r => r.__table === 'cdn_notes'
    ? `${r.note_number} · ${formatDate(r.note_date)} · ${r.customer_name || ''}`
    : `${r.invoice_number} · ${formatDate(r.invoice_date)} · ${r.customer_name || ''}`;
  sel.innerHTML = '<option value="">— the document being amended —</option>' +
    source
      .slice()
      .sort((a, b) => compareInvoiceNumbers(b.invoice_number || b.note_number, a.invoice_number || a.note_number))
      .map(r => `<option value="${escHtmlAttr(r.__table + ':' + r.id)}">${escItemHtml(label(r))}</option>`)
      .join('');
}

function onAmSectionChange() {
  renderAmendmentPicker();
  const spec = AM_SECTIONS.find(x => x.value === amVal('amSection'));
  const warn = amEl('amEmitWarning');
  if (warn) {
    if (spec && spec.emitted) {
      warn.className = 'alert alert-success mb-16';
      warn.innerHTML = '<i class="fas fa-check-circle"></i> This amendment <b>is written</b> to the GSTR-1 JSON.';
    } else {
      warn.className = 'alert alert-warning mb-16';
      warn.innerHTML = '<i class="fas fa-triangle-exclamation"></i> This amendment is <b>recorded here but not written</b> to the JSON. ' +
        'Its exact structure could not be verified, and a section written to a guessed shape risks the whole return. ' +
        'Enter it on the Portal directly &mdash; nothing you type here is lost, and the export lists what it held back.';
    }
  }
}

// Picking the original fills in everything the amendment inherits from
// it, including the period it was filed in — which is taken from the
// document's own date, never from today's.
function onAmOriginalChange() {
  const raw = amVal('amOriginal');
  if (!raw) return;
  const [table, id] = raw.split(':');
  const src = (table === 'cdn_notes' ? amNotes : amInvoices).find(r => r.id === id && r.__table === table);
  if (!src) return;
  const set = (el, v) => { const e = amEl(el); if (e) e.value = v == null ? '' : v; };
  const isNote = table === 'cdn_notes';

  set('amOriginalNumber', isNote ? src.note_number : src.invoice_number);
  set('amOriginalDate', isNote ? src.note_date : src.invoice_date);
  set('amOriginalPeriod', amPeriodOf(isNote ? src.note_date : src.invoice_date));
  set('amPartyName', src.customer_name);
  set('amPartyGstin', src.gst_number || src.gstin || '');
  set('amPlaceOfSupply', src.state || '');
  set('amSupplyType', src.supply_type || 'intrastate');
  set('amTaxable', src.taxable_amount);
  set('amGstPct', src.gst_percentage);
  set('amCess', src.cess_amount || 0);
  if (isNote) set('amNoteType', src.note_type || 'credit');
  recalcAmendment();
}

function recalcAmendment() {
  const taxable = amNum('amTaxable');
  const pct = amNum('amGstPct');
  const gst = amRound(taxable * pct / 100);
  const inter = amVal('amSupplyType') === 'interstate';
  const cess = amNum('amCess');
  const setTxt = (id, v) => { const e = amEl(id); if (e) e.textContent = formatCurrency(v); };
  setTxt('amIgstOut', inter ? gst : 0);
  setTxt('amCgstOut', inter ? 0 : amRound(gst / 2));
  setTxt('amSgstOut', inter ? 0 : amRound(gst / 2));
  setTxt('amTotalOut', amRound(taxable + gst + cess));
}

function amError(msg) {
  const el = amEl('amError');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}

function validateAmendment() {
  if (!amVal('amSection')) return 'Choose which section is being amended.';
  if (!amVal('amOriginalNumber')) return 'An amendment must name the document it amends.';
  if (!amVal('amOriginalDate')) return 'The original document date is required.';
  if (!amVal('amOriginalPeriod')) return 'The period the original was filed in is required.';
  if (!amVal('amAmendmentDate')) return 'The date this amendment is being made is required.';
  const orig = amVal('amOriginalPeriod'), made = amPeriodOf(amVal('amAmendmentDate'));
  // An amendment corrects something already filed, so it cannot be made
  // in a period before the one it corrects.
  const key = p => p.slice(2) + p.slice(0, 2);     // MMYYYY -> YYYYMM, so it sorts
  if (orig && made && key(made) < key(orig)) {
    return 'An amendment cannot be made in a period earlier than the one it amends.';
  }
  if (amNum('amTaxable') < 0) return 'A taxable value cannot be negative.';
  return '';
}

async function saveAmendment() {
  amError('');
  const problem = validateAmendment();
  if (problem) return amError(problem);

  const raw = amVal('amOriginal');
  const [table, id] = raw ? raw.split(':') : [null, null];
  const taxable = amNum('amTaxable');
  const pct = amNum('amGstPct');
  const gst = amRound(taxable * pct / 100);
  const inter = amVal('amSupplyType') === 'interstate';
  const cess = amNum('amCess');

  try {
    const { error } = await _supabase.from('gst_amendments').insert({
      user_id: amUserId,
      section: amVal('amSection'),
      original_period: amVal('amOriginalPeriod'),
      amendment_period: amPeriodOf(amVal('amAmendmentDate')),
      original_document_id: id || null,
      original_document_table: table || null,
      original_number: amVal('amOriginalNumber'),
      original_date: amVal('amOriginalDate'),
      revised_number: amVal('amRevisedNumber') || null,
      revised_date: amVal('amRevisedDate') || null,
      party_gstin: amVal('amPartyGstin') || null,
      party_name: amVal('amPartyName') || null,
      place_of_supply: amVal('amPlaceOfSupply') || null,
      supply_type: amVal('amSupplyType') || 'intrastate',
      inv_typ: amVal('amInvTyp') || 'R',
      note_type: amVal('amNoteType') || null,
      taxable_amount: taxable,
      gst_percentage: pct,
      igst: inter ? gst : 0,
      cgst: inter ? 0 : amRound(gst / 2),
      sgst: inter ? 0 : amRound(gst / 2),
      cess: cess,
      total_amount: amRound(taxable + gst + cess),
      reason: amVal('amReason') || null,
      notes: amVal('amNotes') || null,
      status: 'recorded'
    });
    if (error) throw new Error(error.message);
    resetAmendmentForm();
    await loadAmendments();
    if (typeof showToast === 'function') showToast('Amendment recorded.', 'success');
  } catch (e) { amError(e.message || String(e)); }
}

function resetAmendmentForm() {
  ['amOriginal', 'amOriginalNumber', 'amOriginalDate', 'amOriginalPeriod', 'amRevisedNumber',
   'amRevisedDate', 'amPartyName', 'amPartyGstin', 'amPlaceOfSupply', 'amTaxable', 'amGstPct',
   'amCess', 'amReason', 'amNotes'].forEach(id => { const e = amEl(id); if (e) e.value = ''; });
  const d = amEl('amAmendmentDate'); if (d) d.value = new Date().toISOString().slice(0, 10);
  recalcAmendment();
}

function renderAmendments() {
  const body = amEl('amListBody');
  if (!body) return;
  if (!amRows.length) {
    body.innerHTML = `<tr><td colspan="8" class="text-center text-muted p-16">No amendments recorded.</td></tr>`;
    return;
  }
  body.innerHTML = amRows
    .slice()
    .sort((a, b) => String(b.amendment_period).localeCompare(String(a.amendment_period)))
    .map(a => {
      const spec = AM_SECTIONS.find(x => x.value === a.section);
      return `<tr>
        <td>${escItemHtml(spec ? spec.label.split(' (')[0] : a.section)}</td>
        <td class="fw-600">${escItemHtml(a.original_number || '')}</td>
        <td>${escItemHtml(a.original_period || '')}</td>
        <td>${escItemHtml(a.amendment_period || '')}</td>
        <td>${escItemHtml(a.party_name || '')}</td>
        <td class="text-right">${formatCurrency(a.total_amount || 0)}</td>
        <td class="text-center">${spec && spec.emitted
          ? '<span class="badge badge-success">In JSON</span>'
          : '<span class="badge badge-warning" title="Recorded here; enter on the Portal">Portal only</span>'}</td>
        <td class="text-center"><button class="btn btn-sm btn-danger" onclick="deleteAmendment('${escHtmlAttr(a.id)}')"><i class="fas fa-trash"></i></button></td>
      </tr>`;
    }).join('');
}

async function deleteAmendment(id) {
  if (!confirm('Remove this amendment record?')) return;
  await _supabase.from('gst_amendments').delete().eq('id', id);
  await loadAmendments();
}
