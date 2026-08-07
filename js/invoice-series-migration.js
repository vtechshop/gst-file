// =============================================
// Invoice Series Migration
// =============================================
// A one-time tool for a business that was already running more than one
// numbering book before the app could record which was which.
//
// When invoice_source arrived, every invoice already in the database
// became part of the shop series, because that is what the column
// defaults to and it is true of almost all of them. It is not true of
// the website orders numbered 4 to 25, which were sitting in the same
// table all along. Opening twenty-two invoices to change one field each
// is not a reasonable way to correct that.
//
// What this changes: invoice_source, and nothing else. No invoice
// number, date, customer, product, HSN row, tax figure or total is read
// or written here. Reports do not move. The only thing that changes in a
// return is which range each invoice is reported under in GSTR-1's
// Documents Issued table — which is the entire point: a shop book of
// 138 to 170 and a website book of 4 to 25 reported as one range would
// claim 167 documents where 55 were issued.
//
// Deliberately not limited to Offline and Online: the target list is
// built from the series already in use plus anything typed in, so a
// business that later sells through another channel can correct that
// channel's history with the same tool.

// The rows the current preview matched. Held so [Update] moves exactly
// what was shown and nothing that arrived since — a preview the operator
// approved is the thing that gets applied.
let seriesMigrationPreview = null;

function openSeriesMigrationModal() {
  const modal = document.getElementById('seriesMigrationModal');
  if (!modal) return;
  seriesMigrationPreview = null;
  setInvListValue('smFrom', '');
  setInvListValue('smTo', '');
  document.getElementById('smResult').innerHTML = '';
  document.getElementById('smApplyRow').classList.add('d-none');
  populateSeriesMigrationTargets();
  loadSeriesMigrationHistory();
  modal.classList.add('open');
  lockBodyScroll();
  document.getElementById('smFrom')?.focus();
}

function closeSeriesMigrationModal() {
  document.getElementById('seriesMigrationModal')?.classList.remove('open');
  seriesMigrationPreview = null;
  unlockBodyScrollIfNoModalsOpen();
}

// The target list is whatever series the invoices are already in, plus
// the two this app ships with, plus whatever the operator types. Never a
// fixed list: correcting the history of a channel added later has to
// work without a code change.
function populateSeriesMigrationTargets() {
  const sel = document.getElementById('smSource');
  if (!sel) return;
  const inUse = new Set(Object.keys(INVOICE_SOURCE_LABELS));
  (invListAllData || []).forEach(r => {
    const s = invoiceSourceOf(r);
    if (s) inUse.add(s);
  });
  const current = sel.value;
  sel.innerHTML = [...inUse].sort()
    .map(s => `<option value="${escHtmlAttr(s)}">${escItemHtml(invoiceSourceLabel(s))}</option>`)
    .join('') + '<option value="__other">Other (type a name)…</option>';
  sel.value = [...inUse].includes(current) ? current : 'online';
  onSeriesMigrationTargetChange();
}

function onSeriesMigrationTargetChange() {
  const other = document.getElementById('smSource')?.value === '__other';
  document.getElementById('smSourceOtherGroup')?.classList.toggle('d-none', !other);
  if (other) document.getElementById('smSourceOther')?.focus();
}

// The series the operator has actually chosen, whether picked from the
// list or typed. Normalised the same way the server and the exporter
// normalise it, so "Amazon", "amazon" and " amazon " are one series
// rather than three.
function seriesMigrationTarget() {
  const sel = document.getElementById('smSource');
  const raw = sel?.value === '__other'
    ? document.getElementById('smSourceOther')?.value
    : sel?.value;
  return String(raw || '').trim().toLowerCase();
}

// Which invoices fall in the range, by the same ordering the GSTR-1
// export uses to decide a series' from/to — so what is previewed here is
// what the return will report.
function seriesMigrationMatches(from, to) {
  return (invListAllData || []).filter(r => {
    const num = r.invoice_number;
    if (!num) return false;
    return compareInvoiceNumbers(num, from) >= 0 && compareInvoiceNumbers(num, to) <= 0;
  }).sort((a, b) => compareInvoiceNumbers(a.invoice_number, b.invoice_number));
}

function previewSeriesMigration() {
  const from = document.getElementById('smFrom')?.value.trim() || '';
  const to = document.getElementById('smTo')?.value.trim() || '';
  const target = seriesMigrationTarget();
  const result = document.getElementById('smResult');
  const applyRow = document.getElementById('smApplyRow');
  seriesMigrationPreview = null;
  applyRow.classList.add('d-none');

  if (!from || !to) {
    result.innerHTML = `<p class="form-error show">Enter both a From and a To invoice number.</p>`;
    return;
  }
  if (!target) {
    result.innerHTML = `<p class="form-error show">Choose or type the series to move these invoices into.</p>`;
    return;
  }
  if (compareInvoiceNumbers(from, to) > 0) {
    result.innerHTML = `<p class="form-error show">${escItemHtml(from)} comes after ${escItemHtml(to)} — check the order of the two numbers.</p>`;
    return;
  }

  const matches = seriesMigrationMatches(from, to);
  if (!matches.length) {
    result.innerHTML = `<p class="text-muted-sm">No invoices found between ${escItemHtml(from)} and ${escItemHtml(to)}.</p>`;
    return;
  }

  // An invoice already in the target series is shown, but counted as
  // unchanged — the confirmation must not claim to move something that
  // is already where it belongs.
  const changing = matches.filter(r => invoiceSourceOf(r) !== target);
  seriesMigrationPreview = { from, to, target, matches, changing };

  const rows = matches.map(r => {
    const cur = invoiceSourceOf(r);
    const same = cur === target;
    return `<tr>
      <td>${escItemHtml(r.invoice_number)}</td>
      <td>${r.type === 'b2b' ? 'B2B' : 'B2C'}</td>
      <td>${escItemHtml(formatDate(r.invoice_date))}</td>
      <td>${escItemHtml(invoiceSourceLabel(cur))}</td>
      <td>${same
        ? '<span class="text-muted-sm">unchanged</span>'
        : escItemHtml(invoiceSourceLabel(target))}</td>
    </tr>`;
  }).join('');

  const byCurrent = {};
  changing.forEach(r => {
    const cur = invoiceSourceOf(r);
    byCurrent[cur] = (byCurrent[cur] || 0) + 1;
  });
  const breakdown = Object.entries(byCurrent)
    .map(([s, n]) => `${n} from ${invoiceSourceLabel(s)}`).join(', ');

  result.innerHTML = `
    <div class="calc-box mb-16">
      <div class="calc-row"><span class="label">Invoices found</span><span class="value">${matches.length}</span></div>
      <div class="calc-row"><span class="label">Will be moved</span><span class="value">${changing.length}${breakdown ? ` <span class="fs-11 text-muted-sm">(${escItemHtml(breakdown)})</span>` : ''}</span></div>
      <div class="calc-row total"><span class="label">New series</span><span class="value">${escItemHtml(invoiceSourceLabel(target))}</span></div>
    </div>
    <div class="table-wrapper" style="max-height:38vh;overflow:auto;">
      <table class="data-table">
        <thead><tr><th>Invoice No</th><th>Type</th><th>Date</th><th>Current Source</th><th>New Source</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  if (changing.length) applyRow.classList.remove('d-none');
  else result.insertAdjacentHTML('beforeend',
    `<p class="text-muted-sm mt-12">Every invoice in this range is already in the ${escItemHtml(invoiceSourceLabel(target))} series. Nothing to change.</p>`);
}

async function applySeriesMigration() {
  if (!seriesMigrationPreview?.changing.length) return;
  const { from, to, target, changing } = seriesMigrationPreview;

  const sources = [...new Set(changing.map(r => invoiceSourceLabel(invoiceSourceOf(r))))];
  const ok = await showYesNo(
    `You are about to update ${changing.length} invoice${changing.length === 1 ? '' : 's'} from ${escItemHtml(sources.join(' and '))} to ${escItemHtml(invoiceSourceLabel(target))}.<br><br>` +
    `This action only changes the Invoice Source and will affect only the GSTR-1 Documents Issued section. ` +
    `Invoice numbers, dates, customers, GST and totals are not touched.<br><br>Continue?`,
    'Invoice Series Migration');
  if (!ok) return;

  const btn = document.getElementById('smApplyBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...'; }
  try {
    const res = await apiFetch('/invoices/series-migration', {
      method: 'POST',
      body: JSON.stringify({
        b2b: changing.filter(r => r.type === 'b2b').map(r => r.id),
        b2c: changing.filter(r => r.type === 'b2c').map(r => r.id),
        source: target, rangeFrom: from, rangeTo: to
      })
    });
    showToast(`${res.updated} invoice${res.updated === 1 ? '' : 's'} moved to ${invoiceSourceLabel(target)}.`);
    // The list behind the modal is now out of date in exactly one field.
    // Refreshed in place, so the operator keeps their page and filters.
    const user = await getCurrentUser();
    if (user) await refreshInvoiceListInPlace(user.id);
    previewSeriesMigration();   // re-run against the refreshed data
    loadSeriesMigrationHistory();
    populateSeriesMigrationTargets();
  } catch (error) {
    showToast('Migration failed: ' + (error.message || 'unknown error'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Update'; }
  }
}

// The log, shown rather than merely written — a record nobody can read
// is not much of an audit trail.
async function loadSeriesMigrationHistory() {
  const el = document.getElementById('smHistory');
  if (!el) return;
  try {
    const user = await getCurrentUser();
    if (!user) return;
    const { data } = await _supabase.from('invoice_series_migrations')
      .select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
    const rows = data || [];
    if (!rows.length) { el.innerHTML = '<p class="text-muted-sm">No migrations recorded yet.</p>'; return; }
    el.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr><th>When</th><th>Range</th><th>From</th><th>To</th><th>Invoices</th></tr></thead>
          <tbody>${rows.map(r => {
            const old = r.old_sources && typeof r.old_sources === 'object'
              ? Object.entries(r.old_sources).map(([s, n]) => `${invoiceSourceLabel(s)} (${n})`).join(', ')
              : '';
            const nums = Array.isArray(r.invoice_numbers) ? r.invoice_numbers : [];
            return `<tr>
              <td>${escItemHtml(formatDate(r.created_at))}</td>
              <td>${escItemHtml(r.range_from)} &ndash; ${escItemHtml(r.range_to)}</td>
              <td>${escItemHtml(old || '—')}</td>
              <td>${escItemHtml(invoiceSourceLabel(r.new_source))}</td>
              <td title="${escHtmlAttr(nums.join(', '))}">${r.invoice_count}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  } catch {
    el.innerHTML = '<p class="text-muted-sm">Could not load the migration history.</p>';
  }
}
