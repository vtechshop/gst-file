// =============================================
// Business Profile – Setup, Edit, Print Header
// =============================================

let _currentProfile = null;

// ── Load profile from DB ───────────────────
// A failed read must not erase a profile we already hold. Assigning the
// result unconditionally meant one unlucky request — a 429, a dropped
// connection — replaced a good profile with undefined, and everything
// downstream then behaved as though the business had no GSTIN and no
// state. The GSTR-1 exporter turned exactly that into an empty gstin and
// place of supply 99 on a return.
async function loadUserProfile(userId) {
  // readMaybeOne(), so "this user has no profile row yet" (a real state on
  // a brand-new account) stays distinct from "the read failed". The
  // keep-what-we-have behaviour below is unchanged — it is right — but a
  // failure is now reported instead of passing silently, because the GSTIN
  // and state this profile carries end up on the return.
  const data = await readMaybeOne(
    _supabase.from('profiles').select('*').eq('id', userId).single(),
    'Could not load your business profile'
  );
  if (data) {
    _currentProfile = data;
    updateNavFromProfile(data);
  }
  // What we actually have, which on a failed read is the previous value
  // rather than nothing. Still null for a user who genuinely has no
  // profile row yet.
  return data || _currentProfile;
}

// ── Save profile (upsert) ──────────────────
// Callers pass only the fields relevant to the form they're saving
// (e.g. Business Profile identity fields vs. Company Branding
// assets) — merge onto the cache rather than replacing it, so a
// save from one form never drops fields owned by another.
async function saveUserProfile(userId, fields, silent) {
  const payload = { id: userId, ...fields };
  const existing = await _supabase.from('profiles').select('id').eq('id', userId).single();
  let error;
  if (existing.data) {
    ({ error } = await _supabase.from('profiles').update(payload).eq('id', userId));
  } else {
    ({ error } = await _supabase.from('profiles').insert(payload));
  }
  if (!error) {
    _currentProfile = { ..._currentProfile, ...payload };
    updateNavFromProfile(_currentProfile);
    if (!silent) showToast('Saved!', 'success');
  }
  return { error };
}

function updateNavFromProfile(profile) {
  const el = document.getElementById('navUserName');
  if (el && profile?.business_name) el.textContent = profile.business_name;
}

// ── Get profile (cached) ───────────────────
function getCachedProfile() { return _currentProfile; }

// ── Check on first visit ───────────────────
async function checkAndShowProfileSetup(userId) {
  const profile = await loadUserProfile(userId);
  if (!profile || !profile.business_name || !profile.gstin) {
    setTimeout(() => openProfileModal(true), 700);
  }
  return profile;
}

// ── Open profile modal ─────────────────────
// Every caller on a given page (nav link, first-run auto-open, Settings)
// runs after that page's own requireAuth()/loadUserProfile() has already
// verified the session — re-verifying via another getCurrentUser() call
// (a fresh /auth/me round trip) is redundant whenever _currentProfile is
// already cached, since profiles.id IS the authenticated user's id.
async function openProfileModal(isRequired = false) {
  let profile = _currentProfile;
  if (!profile) {
    const user = await getCurrentUser();
    if (!user) return;
    profile = await loadUserProfile(user.id);
  }
  buildProfileModal(profile, isRequired);
  // Both notes describe values that are already on screen, so they are
  // drawn once the fields exist rather than only when something changes.
  onProfRegTypeChange();
}

function buildProfileModal(profile, isRequired) {
  document.getElementById('profileModalWrap')?.remove();
  // A freshly-opened form has no history: nothing has been touched, so
  // nothing is shown as wrong yet.
  resetProfileValidationState();

  const wrap = document.createElement('div');
  wrap.id = 'profileModalWrap';
  wrap.className = 'modal-overlay open';
  wrap.innerHTML = `
    <div class="modal" style="max-width:580px;">
      <div class="modal-header" style="background:var(--primary-dark);border-radius:10px 10px 0 0;">
        <span class="modal-title" style="color:#fff;display:flex;align-items:center;gap:8px;">
          <i class="fas fa-building"></i> Business GST Profile
        </span>
        <button class="modal-close" onclick="closeProfileModal()" style="color:rgba(255,255,255,0.7);font-size:20px;">&#10005;</button>
      </div>
      <div class="modal-body">
        ${isRequired ? `<div style="background:#fff3e0;border:1px solid #ffb300;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#e65100;display:flex;gap:8px;align-items:flex-start;">
          <i class="fas fa-info-circle" style="margin-top:2px;"></i>
          <span>Please complete all required fields before saving your business profile. Fields marked with * are required.</span>
        </div>` : ''}
        <div class="form-grid cols-2" style="gap:14px;">
          <div class="form-group" style="grid-column:1/-1;">
            <label for="profBizName">Business / Trade Name <span class="text-required">*</span></label>
            <input type="text" id="profBizName" class="form-control" value="${e(profile?.business_name)}"
                   oninput="onProfileFieldInput('profBizName')" onblur="markProfileFieldTouched('profBizName')" aria-describedby="profBizNameError">
            <div id="profBizNameError" class="fs-11 text-danger d-none" style="margin-top:4px;"></div>
            <div class="fs-11 text-muted" style="margin-top:3px;">Required</div>
          </div>
          <div class="form-group">
            <label for="profGSTIN">Your GSTIN <span class="text-required">*</span></label>
            <input type="text" id="profGSTIN" class="form-control" value="${e(profile?.gstin)}" maxlength="15"
                   style="text-transform:uppercase;letter-spacing:1px;"
                   oninput="this.value=this.value.toUpperCase();onProfileFieldInput('profGSTIN')" onblur="markProfileFieldTouched('profGSTIN')" aria-describedby="profGSTINError">
            <div id="profGSTINError" class="fs-11 text-danger d-none" style="margin-top:4px;"></div>
            <div class="fs-11 text-muted" style="margin-top:3px;">Required</div>
          </div>
          <div class="form-group">
            <label for="profPAN">PAN</label>
            <input type="text" id="profPAN" class="form-control uppercase" maxlength="10" value="${e(profile?.pan)}"
                   oninput="onProfileFieldInput('profPAN')" onblur="markProfileFieldTouched('profPAN')" aria-describedby="profPANError">
            <div id="profPANError" class="fs-11 text-danger d-none" style="margin-top:4px;"></div>
          </div>
          <div class="form-group">
            <label for="profPhone">Phone Number</label>
            <input type="tel" id="profPhone" class="form-control" value="${e(profile?.phone)}"
                   oninput="onProfileFieldInput('profPhone')" onblur="markProfileFieldTouched('profPhone')" aria-describedby="profPhoneError">
            <div id="profPhoneError" class="fs-11 text-danger d-none" style="margin-top:4px;"></div>
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label for="profAddress">Business Address</label>
            <textarea id="profAddress" class="form-control" rows="2">${e(profile?.address)}</textarea>
          </div>
          <div class="form-group">
            <label for="profState">State</label>
            <select id="profState" class="form-control" onchange="onProfStateChange()">
              <option value="">Select State</option>
              ${INDIAN_STATES.map(s=>`<option value="${s}"${profile?.state===s?' selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="profDistrict">District</label>
            <input type="text" id="profDistrict" class="form-control" list="profDistrictList"
                   value="${e(profile?.district)}" placeholder="Select State first" autocomplete="off"
                   onchange="onProfDistrictChange()" aria-describedby="profDistrictError">
            <datalist id="profDistrictList"></datalist>
            <div id="profDistrictError" class="fs-11 text-danger d-none" style="margin-top:4px;"></div>
          </div>
          <div class="form-group">
            <label for="profEmail">Email</label>
            <input type="email" id="profEmail" class="form-control" value="${e(profile?.email)}"
                   oninput="onProfileFieldInput('profEmail')" onblur="markProfileFieldTouched('profEmail')" aria-describedby="profEmailError">
            <div id="profEmailError" class="fs-11 text-danger d-none" style="margin-top:4px;"></div>
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label for="profWebsite">Website</label>
            <input type="text" id="profWebsite" class="form-control" value="${e(profile?.website)}">
          </div>
        </div>

        <!-- GST registration. Everything here is optional and everything
             defaults to what the business already is, so a profile that
             ignores this section behaves exactly as it did before. -->
        <div class="section-title mb-14 mt-20">GST Registration</div>
        <div class="form-grid cols-2" style="gap:14px;">
          <div class="form-group">
            <label for="profRegType">Registration Type</label>
            <select id="profRegType" class="form-control" onchange="onProfRegTypeChange()">
              ${GST_REGISTRATION_TYPES.map(t => `<option value="${t.value}"${gstRegistrationType(profile) === t.value ? ' selected' : ''}>${t.label}</option>`).join('')}
            </select>
            <span class="fs-11 text-muted-sm" id="profRegTypeNote"></span>
          </div>
          <div class="form-group">
            <label for="profConstitution">Constitution of Business</label>
            <select id="profConstitution" class="form-control">
              <option value="">Not set</option>
              ${GST_BUSINESS_CONSTITUTIONS.map(c => `<option value="${escHtmlAttr(c)}"${profile?.business_constitution === c ? ' selected' : ''}>${c}</option>`).join('')}
              ${profile?.business_constitution && !GST_BUSINESS_CONSTITUTIONS.includes(profile.business_constitution)
                ? `<option value="${escHtmlAttr(profile.business_constitution)}" selected>${e(profile.business_constitution)}</option>` : ''}
            </select>
          </div>
          <div class="form-group">
            <label for="profLegalName">Legal Name <span class="fs-11 text-muted-sm">(as on PAN)</span></label>
            <input type="text" id="profLegalName" class="form-control" value="${e(profile?.legal_name)}" placeholder="${e(profile?.business_name)}">
          </div>
          <div class="form-group">
            <label for="profTradeName">Trade Name</label>
            <input type="text" id="profTradeName" class="form-control" value="${e(profile?.trade_name)}" placeholder="${e(profile?.business_name)}">
          </div>
          <div class="form-group">
            <label for="profDefaultPos">Default Place of Supply</label>
            <select id="profDefaultPos" class="form-control">
              <option value="">Same as my state</option>
              ${INDIAN_STATES.map(s => `<option value="${escHtmlAttr(s)}"${profile?.default_pos === s ? ' selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="profFinancialYear">Financial Year</label>
            <input type="text" id="profFinancialYear" class="form-control" maxlength="7"
                   value="${e(profile?.financial_year || defaultFinancialYear())}" placeholder="2026-27">
          </div>
        </div>

        <!-- Exports. An LUT is what lets a business export without paying
             IGST, and which applies decides how an export invoice is
             reported. Recorded once here rather than asked at export. -->
        <div class="section-title mb-14 mt-20">Exports <span class="fs-11 text-muted-sm">(only if you export)</span></div>
        <div class="form-grid cols-3" style="gap:14px;">
          <div class="form-group">
            <label for="profLutNumber">LUT / Bond Number</label>
            <input type="text" id="profLutNumber" class="form-control" value="${e(profile?.lut_number)}" oninput="updateProfLutNote()">
          </div>
          <div class="form-group">
            <label for="profLutExpiry">LUT Valid Until</label>
            <input type="date" id="profLutExpiry" class="form-control" value="${e((profile?.lut_expiry || '').toString().slice(0, 10))}" onchange="updateProfLutNote()">
          </div>
          <div class="form-group">
            <label for="profIec">IEC Number</label>
            <input type="text" id="profIec" class="form-control uppercase" maxlength="10" value="${e(profile?.iec_number)}">
          </div>
        </div>
        <p class="fs-11 text-muted-sm mb-10" id="profLutNote"></p>

        <div class="section-title mb-14 mt-20">Defaults</div>
        <div class="form-grid cols-3" style="gap:14px;">
          <div class="form-group">
            <label class="d-flex align-center gap-8" style="cursor:pointer;">
              <input type="checkbox" id="profReverseChargeDefault" ${profile?.reverse_charge_default ? 'checked' : ''}>
              <span>New invoices are reverse charge</span>
            </label>
          </div>
          <div class="form-group">
            <label class="d-flex align-center gap-8" style="cursor:pointer;">
              <input type="checkbox" id="profEinvoiceApplicable" ${profile?.einvoice_applicable ? 'checked' : ''}>
              <span>e-Invoicing applies to me</span>
            </label>
          </div>
          <div class="form-group">
            <label class="d-flex align-center gap-8" style="cursor:pointer;">
              <input type="checkbox" id="profEwaybillApplicable" ${profile?.ewaybill_applicable ? 'checked' : ''}>
              <span>e-Way Bills apply to me</span>
            </label>
          </div>
          <div class="form-group">
            <label for="profHsnDigits">HSN digits I must report</label>
            <select id="profHsnDigits" class="form-control">
              <option value="">Not stated &mdash; nothing is enforced</option>
              <option value="4" ${String(profile?.hsn_digits_required) === '4' ? 'selected' : ''}>4 digits (turnover up to &#8377;5 crore)</option>
              <option value="6" ${String(profile?.hsn_digits_required) === '6' ? 'selected' : ''}>6 digits (turnover above &#8377;5 crore)</option>
              <option value="8" ${String(profile?.hsn_digits_required) === '8' ? 'selected' : ''}>8 digits</option>
            </select>
            <small class="text-muted">GSTR-1 Table 12. Stated by you, for the same reason as the two above.</small>
          </div>
        </div>
        <p class="fs-11 text-muted-sm">Both are stated by you rather than worked out from turnover &mdash; the thresholds are changed by notification, and a figure built into the software would quietly go out of date.</p>

        <p class="text-muted-sm mt-16"><i class="fas fa-info-circle"></i> Logo, seal, signature, bank/UPI details and invoice footer text are set once under <b>Settings &rarr; Company Branding</b> and apply to every invoice automatically.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeProfileModal()">
          ${isRequired ? '<i class="fas fa-times"></i> Skip for Now' : 'Cancel'}
        </button>
        <button class="btn btn-primary" onclick="submitProfile()"><i class="fas fa-save"></i> Save Profile</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);
  lockBodyScroll();
  document.getElementById('profGSTIN').addEventListener('input', function() { this.value = this.value.toUpperCase(); });
  document.getElementById('profPAN').addEventListener('input', function() { this.value = this.value.toUpperCase(); });
  // Seed the district list from the state the profile already has, so a
  // returning user sees their own state's districts without touching the
  // State dropdown first.
  populateDistrictList('profDistrictList', document.getElementById('profState')?.value || '');
}

function closeProfileModal() {
  document.getElementById('profileModalWrap')?.remove();
  unlockBodyScrollIfNoModalsOpen();
}

function e(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── Generic image upload/clear (reused for logo/seal/signature/QR) ──
// The file goes to POST /uploads/image, which writes it into this
// company's profile row and answers with a confirmation. The image
// itself never comes back and never enters this form, so Save Profile
// carries text only.
//
// It used to come back as a base64 data URL and sit in a hidden input
// until save, at which point a 500KB logo became about 667KB of JSON and
// the save died with 413 Content Too Large.
const IMAGE_SLOT_BY_INPUT = {
  brandLogoBase64: 'logo',
  brandSealBase64: 'seal',
  brandSignatureBase64: 'signature',
  brandQRBase64: 'qr'
};

async function handleImageUpload(file, hiddenId, previewWrapId, iconClass) {
  if (!file) return;
  if (file.size > 500 * 1024) { showToast('Image too large — please use a file under 500KB.', 'error'); return; }

  const hidden = document.getElementById(hiddenId);
  const wrap = document.getElementById(previewWrapId);

  // Instant local preview while the upload is in flight — same
  // immediate visual feedback the old base64-only version had.
  const reader = new FileReader();
  reader.onload = (e) => { if (wrap) wrap.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:contain;">`; };
  reader.readAsDataURL(file);

  const formData = new FormData();
  formData.append('image', file);
  // Which of the four slots this is. The server maps it to a column; it
  // is never interpolated into SQL.
  formData.append('slot', IMAGE_SLOT_BY_INPUT[hiddenId] || '');
  try {
    const token = localStorage.getItem('gst_jwt');
    const res = await fetch(API_BASE_URL + '/uploads/image', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: formData
    });
    const body = await res.json().catch(() => null);
    // apiErrorFrom() (js/apiClient.js) rather than lifting body.error
    // straight out: that lost the status, so a 413 (file too large for
    // the server's limit) and an expired session both surfaced as the
    // same anonymous red toast.
    if (!res.ok) throw apiErrorFrom(res, body);
    // Stored server-side. The hidden input is deliberately left empty:
    // the image is already saved, and putting it here would only put it
    // back into the next PATCH. `cleared` is reset so a previous clear in
    // the same sitting does not wipe what was just uploaded.
    if (hidden) {
      hidden.value = '';
      delete hidden.dataset.cleared;
      hidden.dataset.stored = '1';
    }
    if (typeof showToast === 'function') showToast('Image saved.', 'success');
  } catch (error) {
    handleApiError(error, 'Image upload failed');
    // Upload didn't succeed — roll the preview back rather than leaving
    // it showing a local-only image the hidden input doesn't reference.
    if (wrap) wrap.innerHTML = `<i class="fas ${iconClass} text-gray-mid"></i>`;
  }
}

function clearImageUpload(hiddenId, previewWrapId, iconClass) {
  const hidden = document.getElementById(hiddenId);
  // Removing an image IS sent on save — an empty string is a few bytes,
  // and it is the only way the column gets emptied.
  if (hidden) { hidden.value = ''; hidden.dataset.cleared = '1'; delete hidden.dataset.stored; }
  const wrap = document.getElementById(previewWrapId);
  if (wrap) wrap.innerHTML = `<i class="fas ${iconClass} text-gray-mid"></i>`;
}

// ── Settings Modal ─────────────────────────
// Same redundant-/auth/me-call avoidance as openProfileModal() above.
async function openSettingsModal() {
  let profile = _currentProfile;
  if (!profile) {
    const user = await getCurrentUser();
    if (!user) return;
    profile = await loadUserProfile(user.id);
  }

  document.getElementById('settingsModalWrap')?.remove();

  const noProfile = !profile?.business_name;
  const stats = typeof getStorageStats === 'function' ? await getStorageStats() : {};
  const productSyncConfig = await fetchProductSyncConfig();
  // Remembered outside the markup so submitProductSyncSettings() can refuse
  // to write a form that was rendered from a failed read.
  _productSyncConfigUnavailable = !!productSyncConfig.unavailable;

  const wrap = document.createElement('div');
  wrap.id = 'settingsModalWrap';
  wrap.className = 'modal-overlay open';
  wrap.innerHTML = `
    <div class="modal" style="max-width:620px;border-radius:14px;">

      <!-- Header (sticky — stays fixed while the body below scrolls) -->
      <div style="background:linear-gradient(135deg,var(--primary-dark),var(--primary));padding:18px 22px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;color:#fff;">
          <div style="width:36px;height:36px;background:rgba(255,255,255,0.15);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;">
            <i class="fas fa-cog"></i>
          </div>
          <div>
            <div style="font-size:15px;font-weight:700;">Settings</div>
            <div style="font-size:11px;opacity:0.75;">Profile & Data Management</div>
          </div>
        </div>
        <button onclick="closeSettingsModal()" style="background:rgba(255,255,255,0.15);border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;">&times;</button>
      </div>

      <!-- Body (only this area scrolls) -->
      <div class="modal-body" style="padding:0;">

      <!-- Business Profile Card -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">
          <i class="fas fa-building" style="color:var(--primary);margin-right:5px;"></i> Business Profile
        </div>

        ${noProfile ? `
          <div style="background:#fff3e0;border:1px solid #ffb300;border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:10px;">
            <i class="fas fa-exclamation-triangle" style="color:#f57c00;font-size:18px;"></i>
            <div>
              <div style="font-size:13px;font-weight:600;color:#e65100;">Profile not set up yet</div>
              <div style="font-size:12px;color:#888;">Add your business details to appear on reports & PDFs</div>
            </div>
          </div>
        ` : `
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;">
            <div style="width:46px;height:46px;background:var(--primary);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;flex-shrink:0;">
              <i class="fas fa-building"></i>
            </div>
            <div style="flex:1;">
              <div style="font-size:16px;font-weight:700;color:var(--primary-dark);">${e(profile.business_name)}</div>
              <div style="font-size:12px;color:var(--primary);font-weight:600;margin:2px 0;">GSTIN: ${e(profile.gstin)}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
            ${_settingRow('fa-map-marker-alt', 'Address', profile.address + (profile.state ? (profile.address?', ':'') + profile.state : ''))}
            ${_settingRow('fa-phone', 'Phone', profile.phone)}
            ${_settingRow('fa-envelope', 'Email', profile.email)}
          </div>
        `}

        <button class="btn btn-primary btn-sm" onclick="closeSettingsModal();openProfileModal();" style="margin-top:6px;">
          <i class="fas fa-${noProfile?'plus':'edit'}"></i> ${noProfile ? 'Setup Profile' : 'Edit Profile'}
        </button>
      </div>

      <!-- Invoice Numbering -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">
          <i class="fas fa-hashtag" style="color:var(--primary);margin-right:5px;"></i> Invoice Numbering
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">Auto Generate</div>
            <div style="font-size:11.5px;color:var(--text-muted);">Off = type any invoice number yourself. On = the field is filled in automatically and read-only.</div>
          </div>
          <label class="inv-toggle" title="Toggle auto invoice numbering">
            <input type="checkbox" id="setAutoInvToggle" ${profile?.invoice_auto_number ? 'checked' : ''}>
            <span class="inv-toggle-track"><span class="inv-toggle-thumb"></span></span>
          </label>
        </div>
        <!-- One row per numbering book. Each keeps its own format and its
             own counter, so the shop can run 171, 172, 173 while the
             website runs W-00001, W-00002 and a marketplace runs
             A-00001 — no shared prefix, no shared sequence. -->
        <p class="fs-11 text-muted-sm mb-10">Each Invoice Source is numbered separately &mdash; its own format, its own running count. Auto Generate uses whichever row matches the Invoice Source chosen on the invoice.</p>
        <div class="table-wrapper mb-10">
          <table class="data-table">
            <thead><tr><th>Invoice Source</th><th>Number Format</th><th>Next Number</th><th>Next invoice will be</th></tr></thead>
            <tbody id="setSeriesRows">${_seriesFormatRows(profile)}</tbody>
          </table>
        </div>
        <div class="d-flex gap-8 align-center mb-10 flex-wrap">
          <input type="text" id="setNewSeriesName" class="form-control w-150" placeholder="amazon" aria-label="New series name">
          <button type="button" class="btn btn-secondary btn-sm" onclick="addSettingsSeriesRow()"><i class="fas fa-plus"></i> Add Series</button>
          <span class="fs-11 text-muted-sm">Adds another numbering book &mdash; Amazon, Flipkart, POS, anything. It starts at 1 with its own prefix.</span>
        </div>
        <p class="fs-11 text-muted-sm mb-10"><b>#</b> marks the running sequence &mdash; <code>###</code> = 001, 002&hellip; &nbsp;<code>#####</code> = 00001, 00002&hellip; Everything else in the format is kept exactly as typed, so <code>W-#####</code> gives W-00001. No <b>#</b>? A plain number (<code>1</code>) counts up on its own (1, 2, 3&hellip;); any other text gets the sequence appended (<code>INV</code> &rarr; INV-1, INV-2).</p>
        <button class="btn btn-primary btn-sm" onclick="submitInvoiceNumberingSettings()"><i class="fas fa-save"></i> Save Numbering Settings</button>
      </div>

      <!-- Company Branding -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">
          <i class="fas fa-palette" style="color:var(--primary);margin-right:5px;"></i> Company Branding
        </div>
        <p class="text-muted-sm mb-14">Set these once &mdash; every invoice PDF generated from B2B or B2C Invoice Entry uses them automatically. No need to re-upload per invoice.</p>

        <div class="form-grid cols-2" style="gap:14px;margin-bottom:14px;">
          ${_brandUpload('Company Logo', 'brandLogoBase64', 'brandLogoPreview', profile?.logo_base64, 'fa-image')}
          ${_brandUpload('Company Seal', 'brandSealBase64', 'brandSealPreview', profile?.seal_base64, 'fa-stamp')}
          ${_brandUpload('Authorized Signature', 'brandSignatureBase64', 'brandSignaturePreview', profile?.signature_base64, 'fa-signature')}
          ${_brandUpload('QR Code', 'brandQRBase64', 'brandQRPreview', profile?.qr_base64, 'fa-qrcode')}
        </div>

        <div class="form-grid cols-2" style="gap:14px;margin-bottom:14px;">
          <div class="form-group">
            <label>Company Header Color</label>
            <input type="color" id="brandHeaderColor" class="form-control" value="${profile?.header_color || '#004d40'}" style="height:38px;padding:4px;">
          </div>
          <div class="form-group">
            <label>UPI ID</label>
            <input type="text" id="brandUPI" class="form-control" value="${e(profile?.upi_id)}">
          </div>
        </div>

        <div class="section-title mb-14" style="font-size:11px;">Bank Details</div>
        <div class="form-grid cols-2" style="gap:14px;margin-bottom:14px;">
          <div class="form-group">
            <label>Bank Name</label>
            <input type="text" id="brandBankName" class="form-control" value="${e(profile?.bank_name)}">
          </div>
          <div class="form-group">
            <label>Account Number</label>
            <input type="text" id="brandBankAccount" class="form-control" value="${e(profile?.bank_account_no)}">
          </div>
          <div class="form-group">
            <label>IFSC Code</label>
            <input type="text" id="brandBankIFSC" class="form-control uppercase" value="${e(profile?.bank_ifsc)}">
          </div>
          <div class="form-group">
            <label>Branch</label>
            <input type="text" id="brandBankBranch" class="form-control" value="${e(profile?.bank_branch)}">
          </div>
        </div>

        <div class="form-group mb-14">
          <label>Invoice Footer Text</label>
          <textarea id="brandFooterText" class="form-control" rows="2">${e(profile?.footer_text)}</textarea>
        </div>

        <div class="form-group mb-14">
          <label>Terms &amp; Conditions</label>
          <textarea id="brandTerms" class="form-control" rows="3">${e(profile?.terms_conditions)}</textarea>
        </div>

        <button class="btn btn-primary btn-sm" onclick="submitCompanyBranding()"><i class="fas fa-save"></i> Save Branding</button>
      </div>

      <!-- Product Sync -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">
          <i class="fas fa-sync" style="color:var(--primary);margin-right:5px;"></i> Product Sync
        </div>
        <p class="text-muted-sm mb-14">Point this at your own company's product API so Sync Now pulls only your catalog &mdash; never another company's.</p>

        ${productSyncConfig.unavailable ? `
        <div class="fs-11" style="background:#fff3e0;border:1px solid #ffb300;border-radius:6px;padding:8px 12px;margin-bottom:12px;color:#e65100;">
          <i class="fas fa-triangle-exclamation"></i>
          Your saved Product Sync settings could not be read just now, so the boxes below are blank &mdash;
          which is <b>not</b> the same as having none saved. Saving is disabled until they load, so an empty
          box cannot overwrite a URL you already have. Close this and reopen it to retry.
        </div>` : ''}

        <div class="form-group mb-14">
          <label for="pSyncApiUrl">Product API URL</label>
          <input type="text" id="pSyncApiUrl" class="form-control" value="${e(productSyncConfig.product_api_url)}"
                 placeholder="https://your-domain.com/api/catalog/products"
                 ${productSyncConfig.unavailable ? 'disabled' : ''}>
        </div>

        <div class="form-group mb-14">
          <label for="pSyncApiKey">Product API Key</label>
          <input type="password" id="pSyncApiKey" class="form-control" autocomplete="new-password">
          <div class="fs-11 text-muted-sm mt-4">
            ${productSyncConfig.has_key
              ? '<i class="fas fa-check-circle" style="color:var(--primary);"></i> A key is already saved and stays hidden — leave this blank to keep it, or type a new one to replace it.'
              : 'No key saved yet. Leave blank if your company\'s API doesn\'t require one.'}
          </div>
        </div>

        <div class="btn-group">
          <button class="btn btn-primary btn-sm" onclick="submitProductSyncSettings()"
                  ${productSyncConfig.unavailable ? 'disabled' : ''}><i class="fas fa-save"></i> Save Product Sync Settings</button>
          ${productSyncConfig.has_key ? '<button class="btn btn-secondary btn-sm" onclick="clearProductSyncKey()"><i class="fas fa-times"></i> Remove Saved Key</button>' : ''}
        </div>
      </div>

      <!-- Data Management -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">
          <i class="fas fa-database" style="color:var(--primary);margin-right:5px;"></i> Data Storage
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;">
          ${_storeTile('B2B', stats.b2b_invoices||0, '#00796b')}
          ${_storeTile('B2C', stats.b2c_invoices||0, '#26a69a')}
          ${_storeTile('HSN', (stats.b2b_hsn||0)+(stats.b2c_hsn||0), '#1565c0')}
          ${_storeTile('Total', stats.total||0, '#004d40')}
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;">
          <i class="fas fa-clock" style="margin-right:4px;"></i> Last Backup: <b>${stats.lastBackup||'Never'}</b>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-success btn-sm" onclick="exportLocalBackup()"><i class="fas fa-download"></i> Backup Data</button>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0;">
            <i class="fas fa-upload"></i> Restore
            <input type="file" accept=".json" style="display:none;" onchange="importLocalBackup(this.files[0])">
          </label>
          <button class="btn btn-sm" onclick="closeSettingsModal();confirmClearData();" style="border:1px solid #ddd;color:var(--danger);background:#fff;">
            <i class="fas fa-trash-alt"></i> Clear All
          </button>
        </div>
      </div>

      <!-- Preferences -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">
          <i class="fas fa-sliders-h" style="color:var(--primary);margin-right:5px;"></i> Preferences
        </div>
        <div class="form-grid cols-2" style="gap:12px;margin-bottom:12px;">
          <div class="form-group">
            <label for="prefDefaultGst">Default GST Rate</label>
            <select id="prefDefaultGst" class="form-control" onchange="saveAppSetting('defaultGstPct', this.value)">
              ${[0,5,12,18,28].map(p => `<option value="${p}"${String(getDefaultGstPct())===String(p)?' selected':''}>${p}%</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="prefFinancialYear">Financial Year</label>
            <input type="text" id="prefFinancialYear" class="form-control" value="${e(getAppSettings().financialYear || defaultFinancialYear())}" onchange="saveAppSetting('financialYear', this.value)">
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:13px;color:var(--text);"><i class="fas fa-moon" style="color:var(--primary);margin-right:6px;"></i>Dark Theme</span>
          <label class="inv-toggle" title="Toggle dark theme">
            <input type="checkbox" id="prefDarkTheme" onchange="toggleTheme(this.checked)" ${document.documentElement.getAttribute('data-theme')==='dark'?'checked':''}>
            <span class="inv-toggle-track"><span class="inv-toggle-thumb"></span></span>
          </label>
        </div>
      </div>

      <!-- App Info -->
      <div style="padding:14px 22px;background:var(--bg);display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:12px;color:var(--text-muted);">
          <i class="fas fa-info-circle" style="margin-right:4px;color:var(--primary);"></i>
          GST Invoice &amp; GSTR-1 Management System
        </div>
        <div style="font-size:11px;color:var(--text-muted);">Data stored locally in browser</div>
      </div>

      </div><!-- /.modal-body -->
    </div>`;

  document.body.appendChild(wrap);
  lockBodyScroll();
  wrap.addEventListener('click', e => { if (e.target === wrap) closeSettingsModal(); });
  document.getElementById('brandBankIFSC')?.addEventListener('input', function() { this.value = this.value.toUpperCase(); });
}

function closeSettingsModal() {
  document.getElementById('settingsModalWrap')?.remove();
  unlockBodyScrollIfNoModalsOpen();
}

// ── Invoice Numbering (Settings) ───────────
// One editable row per numbering book. The series name is carried in a
// data attribute rather than baked into an element id, because it is
// user-typed text and ids built from it would need escaping rules of
// their own.
function _seriesFormatRows(profile) {
  return knownInvoiceSeries(profile).map(s => _seriesFormatRow(profile, s)).join('');
}

function _seriesFormatRow(profile, series) {
  const fmt = invoiceSeriesFormat(profile, series);
  const seq = invoiceSeriesSequence(profile, series);
  const a = escHtmlAttr(series);
  return `<tr data-series-row="${a}">
    <td><span class="badge ${invoiceSourceBadgeClass(series)}">${e(invoiceSourceLabel(series))}</span></td>
    <td><input type="text" class="form-control set-series-format" data-series="${a}" value="${e(fmt)}" oninput="updateSettingsInvPreview()" aria-label="Number format for ${a}"></td>
    <td><input type="number" class="form-control set-series-seq" data-series="${a}" min="1" step="1" value="${seq}" oninput="updateSettingsInvPreview()" aria-label="Next number for ${a}"></td>
    <td class="fw-700 text-primary-dark set-series-preview" data-series="${a}">${e(applyInvoiceNumberFormat(fmt, seq))}</td>
  </tr>`;
}

// Adds another book. It exists from the moment it is saved, which is
// what makes it selectable as an Invoice Source on a new invoice — the
// dropdown there is built from the series that have a format or a
// counter of their own.
function addSettingsSeriesRow() {
  const input = document.getElementById('setNewSeriesName');
  const name = String(input?.value || '').trim().toLowerCase();
  if (!name) { showToast('Type a name for the new series first.', 'error'); return; }
  const tbody = document.getElementById('setSeriesRows');
  if (!tbody) return;
  const existing = tbody.querySelector(`[data-series-row="${CSS.escape(name)}"]`);
  if (existing) {
    showToast(`${invoiceSourceLabel(name)} is already listed.`, 'error');
    existing.querySelector('.set-series-format')?.focus();
    return;
  }
  // No profile entry yet, so invoiceSeriesFormat() supplies the default
  // for this name — amazon starts at A-00001, flipkart at F-00001.
  tbody.insertAdjacentHTML('beforeend', _seriesFormatRow(null, name));
  if (input) input.value = '';
  tbody.querySelector(`[data-series-row="${CSS.escape(name)}"] .set-series-format`)?.focus();
}

function updateSettingsInvPreview() {
  document.querySelectorAll('#setSeriesRows .set-series-format').forEach(fmtEl => {
    const series = fmtEl.dataset.series;
    const format = fmtEl.value || '';
    const trimmed = format.trim();
    const seqEl = document.querySelector(`#setSeriesRows .set-series-seq[data-series="${CSS.escape(series)}"]`);
    // A purely numeric format (e.g. "25") IS the sequence to preview —
    // show exactly what was typed, not whatever's separately sitting in
    // Next Number (that field only matters for # / text formats, or once
    // this numeric format is already saved and its own counter has moved
    // on — see submitInvoiceNumberingSettings()'s save-time logic).
    // Mirror it into the Next Number field too, live, purely so the two
    // never visually disagree while typing.
    let seq;
    if (/^\d+$/.test(trimmed)) {
      seq = parseInt(trimmed, 10) || 1;
      if (seqEl) seqEl.value = seq;
    } else {
      seq = parseInt(seqEl?.value, 10) || 1;
    }
    const out = document.querySelector(`#setSeriesRows .set-series-preview[data-series="${CSS.escape(series)}"]`);
    if (out) out.textContent = applyInvoiceNumberFormat(format, seq);
  });
}

async function submitInvoiceNumberingSettings() {
  const user = await getCurrentUser();
  if (!user) return;

  const prior = getCachedProfile();
  const formats = {};      // non-offline series only — see below
  const sequences = {};
  let offlineFormat = 'INV-###', offlineSeq = 1;

  document.querySelectorAll('#setSeriesRows .set-series-format').forEach(fmtEl => {
    const series = String(fmtEl.dataset.series || '').trim().toLowerCase();
    if (!series) return;
    // No # required — applyInvoiceNumberFormat() (js/utils.js) handles a
    // #-free format on its own (bare numeric formats count directly;
    // any other plain text gets "-N" appended), so it's saved as typed.
    const format = fmtEl.value.trim() || invoiceSeriesFormat(null, series);
    const seqEl = document.querySelector(`#setSeriesRows .set-series-seq[data-series="${CSS.escape(series)}"]`);
    let seq = Math.max(1, parseInt(seqEl?.value, 10) || 1);

    // A numeric format IS the starting sequence itself — typing "25" and
    // saving must actually start generating from 25, not from whatever
    // Next Number happened to still show. Only re-seed when the format
    // actually changed to this number just now: once "25" is already the
    // saved format and invoices have advanced past it (e.g. to 28),
    // re-saving the SAME unchanged format must NOT reset the counter
    // back down — that would reissue numbers already in use. Judged per
    // series, against that series' own previous format.
    const priorFormat = String(invoiceSeriesFormat(prior, series) || '').trim();
    if (/^\d+$/.test(format) && format !== priorFormat) {
      seq = Math.max(1, parseInt(format, 10) || 1);
    }

    // The offline series is stored where it has always been stored, so a
    // business that never touches this screen keeps issuing exactly what
    // it issued yesterday.
    if (series === INVOICE_SOURCE_DEFAULT) { offlineFormat = format; offlineSeq = seq; }
    else { formats[series] = format; sequences[series] = seq; }
  });

  const autoOn = !!document.getElementById('setAutoInvToggle')?.checked;

  const { error } = await saveUserProfile(user.id, {
    invoice_auto_number: autoOn,
    invoice_number_format: offlineFormat,
    invoice_current_sequence: offlineSeq,
    invoice_series_formats: formats,
    invoice_series_sequences: sequences
  });
  if (error) return;

  // Invoice Entry (js/invoice-entry.js) may or may not be loaded on
  // whichever page this Settings modal was opened from — keep its own
  // toggle/field in sync immediately if it is, no-op otherwise. The
  // Source dropdown is rebuilt too: a series added here has to be
  // pickable on the invoice without a reload, or adding one appears to
  // have done nothing.
  if (typeof updateAutoToggleUI === 'function') updateAutoToggleUI();
  if (typeof populateInvoiceSourceOptions === 'function') populateInvoiceSourceOptions();
  if (typeof generateInvoiceNo === 'function') generateInvoiceNo(user.id, true);
}

function defaultFinancialYear() {
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 3 ? y : y - 1; // Indian FY starts in April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function _settingRow(icon, label, value) {
  if (!value) return '';
  return `<div style="display:flex;align-items:flex-start;gap:6px;font-size:12px;">
    <i class="fas ${icon}" style="color:var(--primary);margin-top:2px;width:14px;text-align:center;"></i>
    <div><span style="color:var(--text-muted);">${label}: </span><span style="color:var(--text);">${e(value)}</span></div>
  </div>`;
}

function _storeTile(label, count, color) {
  return `<div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center;border-top:3px solid ${color};">
    <div style="font-size:20px;font-weight:800;color:${color};">${count}</div>
    <div style="font-size:11px;color:var(--text-muted);">${label}</div>
  </div>`;
}

function _brandUpload(label, hiddenId, previewId, currentValue, iconClass) {
  return `<div class="form-group">
    <label>${label}</label>
    <div class="d-flex align-center gap-10">
      <div id="${previewId}" style="width:48px;height:48px;border:1.5px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;background:var(--bg);">
        ${currentValue ? `<img src="${currentValue}" style="width:100%;height:100%;object-fit:contain;">` : `<i class="fas ${iconClass} text-gray-mid"></i>`}
      </div>
      <div>
        <label class="btn btn-secondary btn-sm btn-file-label" style="font-size:11px;padding:5px 10px;">
          <i class="fas fa-upload"></i> Upload
          <input type="file" accept="image/*" class="file-input-hidden" onchange="handleImageUpload(this.files[0],'${hiddenId}','${previewId}','${iconClass}')" aria-label="Upload ${label}">
        </label>
        ${currentValue ? `<button type="button" class="btn btn-secondary btn-sm" style="font-size:11px;padding:5px 8px;margin-left:4px;" onclick="clearImageUpload('${hiddenId}','${previewId}','${iconClass}')" aria-label="Remove ${label}"><i class="fas fa-times"></i></button>` : ''}
      </div>
    </div>
    <input type="hidden" id="${hiddenId}" value="">
  </div>`;
}

// The Business Profile form's field rules, in one place. Mirrors
// validateProfilePayload() in server/utils/validation.js exactly, and
// like the Customer Master form it defers the GSTIN rule itself to the
// shared validateGstin() (js/utils.js) rather than re-deciding what a
// GSTIN looks like — the 15-character length test this replaced would
// happily have accepted fifteen spaces.
//
// Business / Trade Name and GSTIN are the only required fields, because
// they are the only two this app has ever required: checkAndShowProfileSetup()
// treats exactly that pair as "profile complete", and every other column
// here is optional and has always saved empty. Optional means empty is
// allowed — a rule fires only once the user has actually typed something.
const PROFILE_FIELD_ERROR_IDS = {
  business_name: 'profBizNameError',
  gstin:         'profGSTINError',
  pan:           'profPANError',
  phone:         'profPhoneError',
  email:         'profEmailError'
};
const PROFILE_FIELD_INPUT_IDS = {
  business_name: 'profBizName',
  gstin:         'profGSTIN',
  pan:           'profPAN',
  phone:         'profPhone',
  email:         'profEmail'
};
// Order matters: it is the order the fields appear in the form, and so
// the order "focus the first invalid one" has to walk them in.
const PROFILE_FIELD_ORDER = ['business_name', 'gstin', 'pan', 'phone', 'email'];

// Which fields have earned the right to show an error yet.
//
// A GSTIN is invalid for its first fourteen keystrokes, and on a first-run
// modal every field starts empty — so validating everything on every input
// would tell the user they had got it wrong before they had finished, or
// even started, typing. A field speaks up once the user has left it, and
// from then on re-checks as they type so a correction clears immediately.
// Saving marks every field touched, because at that point the form has
// been asserted complete and silence would be the wrong answer.
let _profileTouchedFields = new Set();

function resetProfileValidationState() { _profileTouchedFields = new Set(); }

function markProfileFieldTouched(inputId) {
  const field = PROFILE_FIELD_ORDER.find(f => PROFILE_FIELD_INPUT_IDS[f] === inputId);
  if (field) _profileTouchedFields.add(field);
  validateProfileForm();
}

// Typing only refreshes a complaint that is already on screen.
function onProfileFieldInput(inputId) {
  const field = PROFILE_FIELD_ORDER.find(f => PROFILE_FIELD_INPUT_IDS[f] === inputId);
  if (field && _profileTouchedFields.has(field)) validateProfileForm();
}

// The ten digits a written phone number actually is: separators removed,
// and the two prefixes that are not part of the subscriber number dropped
// (a +91 country code, the single leading 0 of an STD dial-out). Mirrors
// normalizeIndianPhone() in server/utils/validation.js.
//
// This form had no phone rule until now, so profiles hold whatever was
// typed — "+91 44 4000 1234", "98430 12345". Judged by /^\d{10}$/ those
// profiles could never be saved again, over a field the user need not
// have touched. Still exactly ten digits; it is the punctuation that
// stopped counting, not the rule that relaxed.
function normalizeProfilePhone(value) {
  let digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function getProfileFormErrors() {
  const errors = {};
  const v = id => document.getElementById(id)?.value?.trim() || '';

  if (!v('profBizName')) errors.business_name = 'Business / Trade Name is required.';

  const gstin = v('profGSTIN').toUpperCase();
  if (!gstin) errors.gstin = 'GSTIN is required.';
  else if (!validateGstin(gstin).valid) errors.gstin = 'Enter a valid 15-character GSTIN.';

  const pan = v('profPAN').toUpperCase();
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) errors.pan = 'PAN must be 10 characters, e.g. ABCDE1234F.';

  const phone = v('profPhone');
  if (phone && !/^\d{10}$/.test(normalizeProfilePhone(phone))) errors.phone = 'Phone number must be exactly 10 digits.';

  const email = v('profEmail');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';

  return errors;
}

// Writes each message under its own field and marks the input itself, so
// the failure is never carried by colour alone: there is text under the
// field, and aria-invalid tells a screen reader the same thing the red
// border tells everyone else. Returns the error map so submitProfile()
// can reuse this one result instead of computing it twice.
function validateProfileForm(extraErrors) {
  const errors = { ...getProfileFormErrors(), ...(extraErrors || {}) };
  // A field the server complained about is by definition one the user has
  // committed to, whatever they did or did not touch on the way there.
  Object.keys(extraErrors || {}).forEach(f => _profileTouchedFields.add(f));

  PROFILE_FIELD_ORDER.forEach(field => {
    const el = document.getElementById(PROFILE_FIELD_ERROR_IDS[field]);
    const input = document.getElementById(PROFILE_FIELD_INPUT_IDS[field]);
    const message = _profileTouchedFields.has(field) ? errors[field] : '';
    if (el) {
      el.textContent = message || '';
      el.classList.toggle('d-none', !message);
    }
    if (input) {
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      input.classList.toggle('error', !!message);
    }
  });

  return errors;
}

function focusFirstInvalidProfileField(errors) {
  const field = PROFILE_FIELD_ORDER.find(f => errors[f]);
  if (!field) return;
  const input = document.getElementById(PROFILE_FIELD_INPUT_IDS[field]);
  if (input) input.focus();
}

// Changing State refills the district list and drops a district that
// belonged to the previous state, so a district cannot survive a switch
// to a state it does not belong to.
function onProfStateChange() {
  syncDistrictField('profState', 'profDistrict', 'profDistrictList', 'profDistrictError');
}
function onProfDistrictChange() {
  syncDistrictField('profState', 'profDistrict', 'profDistrictList', 'profDistrictError');
}

async function submitProfile() {
  // Validate before anything is sent. An invalid form never becomes a
  // request, so the user is not made to wait on a round trip to be told
  // something the page already knew.
  PROFILE_FIELD_ORDER.forEach(f => _profileTouchedFields.add(f));
  const errors = validateProfileForm();
  if (Object.keys(errors).length > 0) {
    focusFirstInvalidProfileField(errors);
    // Say which of the two things is actually wrong. A badly-formatted
    // optional field reported as "complete all required fields" sends the
    // user to check the fields marked *, which are already filled in —
    // the message has to name the problem the form actually found.
    const missingRequired = !!(errors.business_name || errors.gstin);
    showToast(missingRequired
      ? 'Please complete all required fields before saving your business profile. Fields marked with * are required.'
      : 'Please correct the highlighted fields before saving your business profile.', 'error');
    return;
  }

  // District against its own State. Checked here as well as on change,
  // because a district can be typed straight in without the change
  // handler ever firing.
  if (!validateStateDistrict('profState', 'profDistrict', 'profDistrictError')) {
    showToast('Select a district that belongs to the chosen state.', 'error');
    document.getElementById('profDistrict')?.focus();
    return;
  }

  const bizName = document.getElementById('profBizName')?.value?.trim();
  const gstin   = document.getElementById('profGSTIN')?.value?.trim().toUpperCase();

  const user = await getCurrentUser();
  if (!user) return;

  const val = (id, up) => {
    const v = document.getElementById(id)?.value?.trim() || '';
    return up ? v.toUpperCase() : v;
  };
  const checked = id => !!document.getElementById(id)?.checked;

  const { error } = await saveUserProfile(user.id, {
    business_name: bizName,
    gstin,
    // Stored as the ten digits, not as the user's punctuation, so a
    // profile saved once stops depending on normalisation to load again.
    phone:   normalizeProfilePhone(val('profPhone')),
    address: val('profAddress'),
    state:    document.getElementById('profState')?.value || '',
    district: val('profDistrict'),
    email:   val('profEmail'),
    pan:     val('profPAN', true),
    website: val('profWebsite'),

    // GST registration. Every one of these is optional; a profile that
    // leaves the whole section alone saves the same values it always did
    // plus defaults that mean "unchanged".
    registration_type:      document.getElementById('profRegType')?.value || GST_REGISTRATION_DEFAULT,
    business_constitution:  document.getElementById('profConstitution')?.value || '',
    legal_name:             val('profLegalName'),
    trade_name:             val('profTradeName'),
    default_pos:            document.getElementById('profDefaultPos')?.value || '',
    financial_year:         val('profFinancialYear'),
    lut_number:             val('profLutNumber'),
    // A date input left blank yields '', which Postgres rejects for a
    // DATE column — null is the absence of a date, '' is not a date.
    lut_expiry:             val('profLutExpiry') || null,
    iec_number:             val('profIec', true),
    reverse_charge_default: checked('profReverseChargeDefault'),
    einvoice_applicable:    checked('profEinvoiceApplicable'),
    ewaybill_applicable:    checked('profEwaybillApplicable'),
    hsn_digits_required:    parseInt(document.getElementById('profHsnDigits')?.value, 10) || null
  }, true); // this form reports its own outcome — see below

  if (!error) {
    showToast('Business profile saved successfully.', 'success');
    closeProfileModal();
    return;
  }

  // The save was refused. If the server said which fields it objected to,
  // show its complaint under those fields — the backend is the authority
  // on what it will store, and a rule it enforces that the form somehow
  // let through should be visible in the same place as every other field
  // error, not only as a toast. The modal deliberately stays open.
  if (error.fields) {
    const merged = validateProfileForm(error.fields);
    focusFirstInvalidProfileField(merged);
  }
  // One toast, through the shared reporter, so this failure carries the
  // same wording, status code and requestId as every other in the app.
  handleApiError(error, 'Could not save your business profile');
}

// Says what the chosen registration actually files, because the choice
// has consequences the label alone does not carry: a composition dealer
// files CMP-08 and GSTR-4 and does not file GSTR-1 at all, and an ISD,
// deductor or collector each file something else again. Better said here
// than discovered at export time.
function onProfRegTypeChange() {
  const note = document.getElementById('profRegTypeNote');
  if (!note) return;
  const value = document.getElementById('profRegType')?.value || GST_REGISTRATION_DEFAULT;
  const spec = GST_REGISTRATION_TYPES.find(t => t.value === value);
  const filesGstr1 = gstFilesGstr1({ registration_type: value });
  note.innerHTML = `Files ${escItemHtml(spec?.files || '')}` +
    (filesGstr1 ? '' : ' &mdash; <b>not GSTR-1</b>, so the GSTR-1 export does not apply to this registration.');
  note.style.color = filesGstr1 ? '' : 'var(--danger)';
  updateProfLutNote();
}

// Whether the recorded LUT is actually in force today, in the same words
// the export will use when it decides between exporting with payment of
// IGST and without.
function updateProfLutNote() {
  const note = document.getElementById('profLutNote');
  if (!note) return;
  const lut = gstLutStatus({
    lut_number: document.getElementById('profLutNumber')?.value,
    lut_expiry: document.getElementById('profLutExpiry')?.value
  }, toISO(new Date()));
  note.innerHTML = lut.number
    ? (lut.active
        ? `LUT ${escItemHtml(lut.number)} is in force${lut.expiry ? ` until ${escItemHtml(formatDate(lut.expiry))}` : ''} &mdash; exports can be made without payment of IGST.`
        : `LUT ${escItemHtml(lut.number)} <b>${escItemHtml(lut.reason)}</b> &mdash; until it is renewed, exports must be made with payment of IGST.`)
    : 'With no LUT recorded, exports are treated as made with payment of IGST.';
  note.style.color = lut.number && !lut.active ? 'var(--danger)' : '';
}

// ── Company Branding (Settings) ────────────
async function submitCompanyBranding() {
  const user = await getCurrentUser();
  if (!user) return;

  // Images are sent ONLY when the user actually changed one.
  //
  // These four columns are named *_base64 for historical reasons but now
  // hold a URL from POST /uploads/image. A profile created before that
  // change still holds a real data-URL, and one 500KB image becomes about
  // 667KB of base64 — so re-sending the untouched values on every save
  // pushed the PATCH past the JSON body limit and the save failed with
  // 413 Content Too Large. The image had uploaded fine; it was the save
  // that broke.
  //
  // A field the user did not touch is simply left out, and a partial
  // PATCH leaves the stored value alone — which is also what preserves
  // the legacy data-URLs already in the database. The data: guard is
  // belt and braces: nothing should put a data-URL in these inputs any
  // more, and if something does it must not travel in this request.
  const imageFields = {
    logo_base64:      'brandLogoBase64',
    seal_base64:      'brandSealBase64',
    signature_base64: 'brandSignatureBase64',
    qr_base64:        'brandQRBase64'
  };
  const images = {};
  Object.entries(imageFields).forEach(([column, inputId]) => {
    const el = document.getElementById(inputId);
    // An upload already wrote itself to the profile, so there is nothing
    // to send. Only a removal travels here, and it travels as ''.
    if (!el || el.dataset.cleared !== '1') return;
    images[column] = '';
  });

  const { error } = await saveUserProfile(user.id, {
    ...images,
    header_color:     document.getElementById('brandHeaderColor')?.value || '#004d40',
    footer_text:      document.getElementById('brandFooterText')?.value?.trim() || '',
    terms_conditions: document.getElementById('brandTerms')?.value?.trim() || '',
    bank_name:        document.getElementById('brandBankName')?.value?.trim() || '',
    bank_account_no:  document.getElementById('brandBankAccount')?.value?.trim() || '',
    bank_ifsc:        document.getElementById('brandBankIFSC')?.value?.trim() || '',
    bank_branch:      document.getElementById('brandBankBranch')?.value?.trim() || '',
    upi_id:           document.getElementById('brandUPI')?.value?.trim() || ''
  });

  if (!error) showToast('Company branding saved — every invoice PDF will use it automatically.', 'success');
}

// True when the last settings read failed, so the Product Sync form on
// screen is blank because nothing could be loaded — not because nothing is
// configured. Guards the save; see submitProductSyncSettings().
let _productSyncConfigUnavailable = false;

// ── Product Sync config (server/routes/product-sync.js) ────────────
// Deliberately NOT part of the generic profiles read/write path (see
// submitCompanyBranding() above, which goes through saveUserProfile()) —
// product_api_key is a secret that must never round-trip back to the
// browser once saved, so it's handled through its own dedicated
// endpoint that only ever reports has_key, never the key itself.
async function fetchProductSyncConfig() {
  try {
    const token = localStorage.getItem('gst_jwt');
    const res = await fetch(API_BASE_URL + '/product-sync/config', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    if (!res.ok) {
      // Reported rather than silently falling back to blanks. An empty
      // Product API URL box looks exactly like "not configured yet", so
      // a failed read here invited the user to retype a URL they had
      // already saved — or to save an empty one over it.
      const body = await res.json().catch(() => null);
      handleApiError(apiErrorFrom(res, body), 'Could not load your Product Sync settings');
      return { product_api_url: '', has_key: false, unavailable: true };
    }
    return await res.json();
  } catch {
    handleApiError(
      { message: 'Could not reach the server — check your connection and try again.', code: 'network', status: 0, networkError: true },
      'Could not load your Product Sync settings'
    );
    return { product_api_url: '', has_key: false, unavailable: true };
  }
}

async function saveProductSyncConfig(body) {
  try {
    const token = localStorage.getItem('gst_jwt');
    const res = await fetch(API_BASE_URL + '/product-sync/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      // The `errBody?.error` string fallback that used to be here was
      // covering for server/routes/product-sync.js answering with a bare
      // { error: '<string>' }; those now send the standard
      // { error: { message, code } } like every other endpoint, and
      // apiErrorFrom() handles either shape anyway.
      throw apiErrorFrom(res, errBody);
    }
    // The background sync caches "is this company configured" per tab
    // (js/api/product-sync.js). Clearing it here is what makes turning
    // Product Sync on take effect on the next page load rather than only in
    // a new tab - and turning it off stop probing just as promptly.
    if (typeof forgetCompanyProductSyncConfigured === 'function') forgetCompanyProductSyncConfigured();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err, message: err.message };
  }
}

async function submitProductSyncSettings() {
  // Refuse to save a form that was never populated. fetchProductSyncConfig()
  // returns unavailable:true when the read failed, and the form it renders
  // is therefore blank — indistinguishable on screen from "nothing is
  // configured". Saving that blank writes NULL over a URL the company had
  // already set, and the first anyone knows of it is Sync Now reporting
  // "not set up yet". The flag existed for exactly this and was never
  // checked; the button is disabled too, but the guard belongs here, where
  // the write actually happens.
  if (_productSyncConfigUnavailable) {
    showToast('Your Product Sync settings could not be loaded, so they cannot be saved yet. Close Settings and open it again.', 'error');
    return;
  }

  const product_api_url = document.getElementById('pSyncApiUrl')?.value?.trim() || '';
  const product_api_key = document.getElementById('pSyncApiKey')?.value?.trim() || '';

  const result = await saveProductSyncConfig({ product_api_url, product_api_key });
  if (!result.ok) { handleApiError(result.error, 'Could not save the Product Sync settings'); return; }
  showToast('Product Sync settings saved.', 'success');
  await openSettingsModal(); // re-render so the key field/status reflects what's now saved
}

async function clearProductSyncKey() {
  const ok = await showConfirm('Remove the saved Product API key? Sync will stop authenticating until a new one is added.');
  if (!ok) return;
  const result = await saveProductSyncConfig({ clear_key: true });
  if (!result.ok) { handleApiError(result.error, 'Could not remove the Product API key'); return; }
  showToast('Product API key removed.', 'success');
  await openSettingsModal();
}

// ── Business header for PDF ────────────────
function getBusinessPDFHeader(doc, reportTitle, period) {
  const p = _currentProfile;
  const pw = doc.internal.pageSize.width;

  doc.setFillColor(0, 77, 64);
  doc.rect(0, 0, pw, 28, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(p?.business_name || 'GST Invoice Management', 14, 10);

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  const line2Parts = [];
  if (p?.gstin)   line2Parts.push('GSTIN: ' + p.gstin);
  if (p?.phone)   line2Parts.push('Ph: ' + p.phone);
  if (p?.email)   line2Parts.push(p.email);
  doc.text(line2Parts.join('   |   '), 14, 17);

  if (p?.address || p?.state) {
    doc.text((p.address || '') + (p.state ? (p.address ? ', ' : '') + p.state : ''), 14, 23);
  }

  doc.setTextColor(200, 230, 228);
  doc.setFontSize(8);
  doc.text(reportTitle + (period ? '  |  Period: ' + period : ''), pw - 14, 10, { align: 'right' });
  doc.text('Generated: ' + new Date().toLocaleString('en-IN'), pw - 14, 17, { align: 'right' });

  doc.setTextColor(0, 0, 0);
  return 34;
}

