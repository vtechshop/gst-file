// =============================================
// Warranty Details - one record, its QR and its NFC tag
// =============================================
// Answers the whole question on one page: what was bought, when, on which
// invoice, for how much, what is covered, until when, and whether it is still
// live. Opening a second page to understand a warranty is what this avoids.
//
// The QR and the NFC tag carry the SAME address and nothing else. Encoding
// the cover itself would make the tag the source of truth, and a cancelled
// warranty would keep verifying against its own copy - so both point at a
// lookup, and a status change needs no tag rewritten.
let warrantyRecord = null;

async function initWarrantyDetail() {
  const user = await requireAuth();
  if (!user) return;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const id = new URLSearchParams(window.location.search).get('id');
  const body = document.getElementById('wrDetailBody');
  if (!id) {
    if (body) body.innerHTML = '<div class="card"><div class="card-body">No warranty selected.</div></div>';
    return;
  }

  // Read through the generic route, which scopes to the caller's own user_id:
  // another company's warranty simply is not returned.
  const rows = await readAll([_supabase.from('warranties').select('*').eq('id', id)],
    'Could not load the warranty');
  if (!rows) return;
  warrantyRecord = (rows[0] || [])[0] || null;
  if (!warrantyRecord) {
    if (body) body.innerHTML = '<div class="card"><div class="card-body">Warranty not found.</div></div>';
    return;
  }
  renderWarrantyDetail();
  await renderWarrantyVerification();
}

function wrRow(label, value, strong) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><td style="width:38%;color:var(--text-muted,#5f6368);">${escItemHtml(label)}</td>
    <td>${strong ? '<b>' + escItemHtml(value) + '</b>' : escItemHtml(value)}</td></tr>`;
}

function renderWarrantyDetail() {
  const r = warrantyRecord;
  const st = warrantyEffectiveStatus(r);
  const left = warrantyDaysRemaining(r);
  const until = r.extended_until || r.warranty_until;
  const cls = st === 'active' ? 'badge-green' : st === 'expired' ? 'badge-red' : 'badge-grey';

  document.getElementById('wrDetailBody').innerHTML = `
    <div class="card mb-16">
      <div class="card-header">
        <span class="card-title"><i class="fas fa-shield-halved"></i> ${escItemHtml(r.warranty_number || '')}</span>
        <span class="badge ${cls}">${escItemHtml(WARRANTY_STATUS_LABELS[st])}</span>
      </div>
      <div class="card-body">
        ${st === 'active' && left !== null
          ? `<p class="text-muted-sm">${left} day${left === 1 ? '' : 's'} remaining &mdash; cover ends ${escItemHtml(formatDate(until))}.</p>`
          : st === 'expired'
            ? `<p class="text-muted-sm">Cover ended ${escItemHtml(formatDate(until))}.</p>`
            : r.cancel_reason ? `<p class="text-muted-sm">${escItemHtml(r.cancel_reason)}</p>` : ''}

        <div class="form-grid cols-2">
          <div>
            <div class="section-title mb-14">Customer</div>
            <table class="data-table">
              ${wrRow('Customer Name', r.customer_name, true)}
              ${wrRow('Phone', r.customer_phone)}
            </table>

            <div class="section-title mb-14 mt-20">Purchase</div>
            <table class="data-table">
              ${wrRow('Invoice No', r.invoice_number, true)}
              ${wrRow('Invoice Type', String(r.invoice_type || '').toUpperCase())}
              ${wrRow('Invoice Date', r.invoice_date ? formatDate(r.invoice_date) : '')}
              ${wrRow('Purchase Date', r.purchase_date ? formatDate(r.purchase_date) : '')}
              ${wrRow('Purchase Amount', '₹' + formatNum(r.purchase_amount), true)}
            </table>
          </div>
          <div>
            <div class="section-title mb-14">Product</div>
            <table class="data-table">
              ${wrRow('Product Name', r.product_name, true)}
              ${wrRow('SKU / Product ID', r.product_sku)}
              ${wrRow('Serial Number', r.serial_number)}
              ${wrRow('Quantity', formatNum(r.quantity))}
              ${wrRow('Rate', '₹' + formatNum(r.rate))}
            </table>

            <div class="section-title mb-14 mt-20">Warranty</div>
            <table class="data-table">
              ${wrRow('Warranty Period', warrantyLabel(r.warranty_period_months), true)}
              ${wrRow('Warranty Start', r.warranty_start_date ? formatDate(r.warranty_start_date) : '')}
              ${wrRow('Warranty Until', r.warranty_until ? formatDate(r.warranty_until) : '')}
              ${r.extended_until ? wrRow('Extended Until', formatDate(r.extended_until), true) : ''}
              ${wrRow('Extension Reason', r.extension_reason)}
            </table>
          </div>
        </div>

        ${r.warranty_terms ? `<div class="mt-20">
          <div class="section-title mb-14">Warranty Terms</div>
          <div style="white-space:pre-wrap;">${escItemHtml(r.warranty_terms)}</div>
        </div>` : ''}

        <div class="d-flex gap-10 mt-20" style="flex-wrap:wrap;">
          <a class="btn btn-secondary btn-sm" href="warranty-list.html"><i class="fas fa-arrow-left"></i> Back to register</a>
          <button type="button" class="btn btn-secondary btn-sm" onclick="editWarrantySerial()"><i class="fas fa-pen"></i> Edit serial number</button>
        </div>
      </div>
    </div>`;
}

async function renderWarrantyVerification() {
  const url = warrantyVerifyUrl(warrantyRecord.id);
  const card = document.getElementById('wrVerifyCard');
  if (!card || !url) return;
  card.style.display = '';
  document.getElementById('wrVerifyUrl').value = url;
  document.getElementById('wrOpenVerify').href = url;

  const canvas = document.getElementById('wrQrCanvas');
  if (canvas && typeof QRCode !== 'undefined') {
    try {
      await QRCode.toCanvas(canvas, url, { width: 160, margin: 1 });
    } catch (err) {
      canvas.replaceWith(Object.assign(document.createElement('p'),
        { className: 'text-muted-sm', textContent: 'QR could not be generated.' }));
    }
  }
  renderNfcAvailability();
}

function copyWarrantyLink() {
  const url = document.getElementById('wrVerifyUrl')?.value;
  if (!url) return;
  navigator.clipboard?.writeText(url)
    .then(() => showToast('Verification link copied.', 'success'))
    .catch(() => showToast('Copy failed — select the link and copy it manually.', 'error'));
}

// ── NFC ────────────────────────────────────────────
// Web NFC exists on Android Chrome and essentially nowhere else. Where it is
// missing the button says so plainly rather than pretending: a tag that was
// never written but reported as written is worse than no button at all.
function nfcSupported() {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

function setNfcStatus(text, kind) {
  const el = document.getElementById('wrNfcStatus');
  if (!el) return;
  el.className = 'fs-11 ' + (kind === 'error' ? 'text-danger' : kind === 'ok' ? 'text-success' : 'text-muted-sm');
  el.textContent = text;
}

function renderNfcAvailability() {
  const btn = document.getElementById('wrNfcBtn');
  if (!btn) return;
  if (!nfcSupported()) {
    btn.disabled = true;
    setNfcStatus('NFC writing is not supported on this device/browser. '
      + 'Use the QR code, or open this page on an NFC-capable Android device in Chrome.');
    return;
  }
  btn.disabled = false;
  setNfcStatus('NFC Ready — tap a tag after pressing Write NFC.');
}

async function writeWarrantyNfc() {
  if (!nfcSupported()) { renderNfcAvailability(); return; }
  const url = document.getElementById('wrVerifyUrl')?.value;
  if (!url) return;
  const btn = document.getElementById('wrNfcBtn');
  if (btn) btn.disabled = true;
  setNfcStatus('Writing… hold the tag against the device.');
  try {
    // Only the address is written. Nothing about the customer, the price or
    // the cover goes onto a tag a stranger can read.
    const ndef = new window.NDEFReader();
    await ndef.write({ records: [{ recordType: 'url', data: url }] });
    setNfcStatus('Written Successfully — tapping the tag opens this warranty.', 'ok');
    showToast('NFC tag written.', 'success');
  } catch (err) {
    // Reported exactly as the browser gave it: a refused permission, an
    // absent tag and a read-only tag are different problems.
    setNfcStatus('Write Failed — ' + (err && err.message ? err.message : 'the tag could not be written.'), 'error');
    showToast('NFC write failed.', 'error');
  } finally {
    if (btn) btn.disabled = !nfcSupported();
  }
}

async function editWarrantySerial() {
  const current = warrantyRecord.serial_number || '';
  const next = prompt('Serial number for ' + warrantyRecord.product_name + ':', current);
  if (next === null) return;                       // cancelled
  const value = next.trim();
  if (value === current) return;
  try {
    await _supabase.from('warranties').update({ serial_number: value || null }).eq('id', warrantyRecord.id);
    warrantyRecord.serial_number = value || null;
    renderWarrantyDetail();
    showToast('Serial number updated.', 'success');
  } catch (err) {
    handleApiError(err, 'Could not update the serial number');
  }
}
