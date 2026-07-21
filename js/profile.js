// =============================================
// Business Profile – Setup, Edit, Print Header
// =============================================

let _currentProfile = null;

// ── Load profile from DB ───────────────────
async function loadUserProfile(userId) {
  const { data } = await _supabase.from('profiles').select('*').eq('id', userId).single();
  _currentProfile = data;
  if (data) updateNavFromProfile(data);
  return data;
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
}

function buildProfileModal(profile, isRequired) {
  document.getElementById('profileModalWrap')?.remove();

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
          <span>உங்கள் business details பூர்த்தி பண்ணுங்கள். இவை உங்கள் reports மற்றும் print-ல் தெரியும்.</span>
        </div>` : ''}
        <div class="form-grid cols-2" style="gap:14px;">
          <div class="form-group" style="grid-column:1/-1;">
            <label>Business / Trade Name <span style="color:red;">*</span></label>
            <input type="text" id="profBizName" class="form-control" value="${e(profile?.business_name)}">
          </div>
          <div class="form-group">
            <label>Your GSTIN <span style="color:red;">*</span></label>
            <input type="text" id="profGSTIN" class="form-control" value="${e(profile?.gstin)}" maxlength="15" style="text-transform:uppercase;letter-spacing:1px;">
          </div>
          <div class="form-group">
            <label>PAN</label>
            <input type="text" id="profPAN" class="form-control uppercase" maxlength="10" value="${e(profile?.pan)}">
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" id="profPhone" class="form-control" value="${e(profile?.phone)}">
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label>Business Address</label>
            <textarea id="profAddress" class="form-control" rows="2">${e(profile?.address)}</textarea>
          </div>
          <div class="form-group">
            <label>State</label>
            <select id="profState" class="form-control">
              <option value="">Select State</option>
              ${INDIAN_STATES.map(s=>`<option value="${s}"${profile?.state===s?' selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="profEmail" class="form-control" value="${e(profile?.email)}">
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label>Website</label>
            <input type="text" id="profWebsite" class="form-control" value="${e(profile?.website)}">
          </div>
        </div>
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
}

function closeProfileModal() {
  document.getElementById('profileModalWrap')?.remove();
  unlockBodyScrollIfNoModalsOpen();
}

function e(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── Generic image upload/clear (reused for logo/seal/signature/QR) ──
// Uploads to Cloudinary (server/routes/uploads.js) and stores the
// returned URL — not a base64 data-URL — in the hidden input, which is
// the only thing the rest of this modal's read/save logic cares about
// (it just reads/writes whatever string is there under the same
// logo_base64/seal_base64/etc. column names, now holding URLs).
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
  try {
    const token = localStorage.getItem('gst_jwt');
    const res = await fetch(API_BASE_URL + '/uploads/image', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: formData
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw (body && body.error) || { message: 'Upload failed' };
    if (hidden) hidden.value = body.url;
  } catch (error) {
    showToast('Image upload failed: ' + (error.message || 'unknown error'), 'error');
    // Upload didn't succeed — roll the preview back rather than leaving
    // it showing a local-only image the hidden input doesn't reference.
    if (wrap) wrap.innerHTML = hidden?.value ? `<img src="${hidden.value}" style="width:100%;height:100%;object-fit:contain;">` : `<i class="fas ${iconClass} text-gray-mid"></i>`;
  }
}

function clearImageUpload(hiddenId, previewWrapId, iconClass) {
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = '';
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
        <div class="form-grid cols-2" style="gap:14px;margin-bottom:10px;">
          <div class="form-group">
            <label for="setInvFormat">Invoice Number Format</label>
            <input type="text" id="setInvFormat" class="form-control" value="${e(profile?.invoice_number_format || 'INV-###')}" oninput="updateSettingsInvPreview()">
          </div>
          <div class="form-group">
            <label for="setInvNextSeq">Next Sequence Number</label>
            <input type="number" id="setInvNextSeq" class="form-control" min="1" step="1" value="${profile?.invoice_current_sequence || 1}" oninput="updateSettingsInvPreview()">
          </div>
        </div>
        <p class="fs-11 text-muted-sm mb-10"><b>#</b> marks the running sequence &mdash; <code>###</code> = 001, 002&hellip; &nbsp;<code>####</code> = 0001, 0002&hellip; Everything else in the format is kept exactly as typed. No <b>#</b>? A plain number (<code>1</code>) counts up on its own (1, 2, 3&hellip;); any other text gets the sequence appended (<code>INV</code> &rarr; INV-1, INV-2).</p>
        <div style="background:var(--bg);border:1px dashed var(--border);border-radius:8px;padding:10px 14px;margin-bottom:14px;">
          <span class="fs-11 text-muted-sm">Live Preview</span>
          <div id="setInvPreview" style="font-size:16px;font-weight:700;color:var(--primary);margin-top:2px;">${e(applyInvoiceNumberFormat(profile?.invoice_number_format || 'INV-###', profile?.invoice_current_sequence || 1))}</div>
        </div>
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

        <div class="form-group mb-14">
          <label for="pSyncApiUrl">Product API URL</label>
          <input type="text" id="pSyncApiUrl" class="form-control" value="${e(productSyncConfig.product_api_url)}">
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
          <button class="btn btn-primary btn-sm" onclick="submitProductSyncSettings()"><i class="fas fa-save"></i> Save Product Sync Settings</button>
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
function updateSettingsInvPreview() {
  const format = document.getElementById('setInvFormat')?.value || '';
  const trimmed = format.trim();
  const seqEl = document.getElementById('setInvNextSeq');
  // A purely numeric format (e.g. "25") IS the sequence to preview —
  // show exactly what was typed, not whatever's separately sitting in
  // Next Sequence Number (that field only matters for # / text formats,
  // or once this numeric format is already saved and its own counter
  // has moved on — see submitInvoiceNumberingSettings()'s save-time
  // logic). Mirror it into the Next Sequence field too, live, purely so
  // the two never visually disagree while typing.
  let seq;
  if (/^\d+$/.test(trimmed)) {
    seq = parseInt(trimmed, 10) || 1;
    if (seqEl) seqEl.value = seq;
  } else {
    seq = parseInt(seqEl?.value, 10) || 1;
  }
  const el = document.getElementById('setInvPreview');
  if (el) el.textContent = applyInvoiceNumberFormat(format, seq);
}

async function submitInvoiceNumberingSettings() {
  const user = await getCurrentUser();
  if (!user) return;

  // No # required — applyInvoiceNumberFormat() (js/utils.js) handles a
  // #-free format on its own (bare numeric formats count directly;
  // any other plain text gets "-N" appended), so it's saved as typed.
  const format = document.getElementById('setInvFormat')?.value?.trim() || 'INV-###';
  let seq = Math.max(1, parseInt(document.getElementById('setInvNextSeq')?.value, 10) || 1);

  // A numeric format IS the starting sequence itself — typing "25" and
  // saving must actually start generating from 25, not from whatever
  // Next Sequence Number happened to still show. Only re-seed when the
  // format actually changed to this number just now: once "25" is
  // already the saved format and invoices have advanced past it (e.g.
  // to 28), re-saving the SAME unchanged format must NOT reset the
  // counter back down — that would reissue numbers already in use.
  const priorFormat = (getCachedProfile()?.invoice_number_format || '').trim();
  if (/^\d+$/.test(format) && format !== priorFormat) {
    seq = Math.max(1, parseInt(format, 10) || 1);
  }

  const autoOn = !!document.getElementById('setAutoInvToggle')?.checked;

  const { error } = await saveUserProfile(user.id, {
    invoice_auto_number: autoOn,
    invoice_number_format: format,
    invoice_current_sequence: seq
  });
  if (error) return;

  // Invoice Entry (js/invoice-entry.js) may or may not be loaded on
  // whichever page this Settings modal was opened from — keep its own
  // toggle/field in sync immediately if it is, no-op otherwise.
  if (typeof updateAutoToggleUI === 'function') updateAutoToggleUI();
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
    <input type="hidden" id="${hiddenId}" value="${e(currentValue)}">
  </div>`;
}

async function submitProfile() {
  const bizName = document.getElementById('profBizName')?.value?.trim();
  const gstin   = document.getElementById('profGSTIN')?.value?.trim().toUpperCase();
  if (!bizName) { showToast('Business name is required!', 'error'); return; }
  if (!gstin || gstin.length < 15) { showToast('GSTIN must be 15 characters!', 'error'); return; }

  const user = await getCurrentUser();
  if (!user) return;

  const { error } = await saveUserProfile(user.id, {
    business_name: bizName,
    gstin,
    phone:   document.getElementById('profPhone')?.value?.trim() || '',
    address: document.getElementById('profAddress')?.value?.trim() || '',
    state:   document.getElementById('profState')?.value || '',
    email:   document.getElementById('profEmail')?.value?.trim() || '',
    pan:     document.getElementById('profPAN')?.value?.trim().toUpperCase() || '',
    website: document.getElementById('profWebsite')?.value?.trim() || ''
  });

  if (!error) closeProfileModal();
}

// ── Company Branding (Settings) ────────────
async function submitCompanyBranding() {
  const user = await getCurrentUser();
  if (!user) return;

  const { error } = await saveUserProfile(user.id, {
    logo_base64:      document.getElementById('brandLogoBase64')?.value || '',
    seal_base64:      document.getElementById('brandSealBase64')?.value || '',
    signature_base64: document.getElementById('brandSignatureBase64')?.value || '',
    qr_base64:        document.getElementById('brandQRBase64')?.value || '',
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
    if (!res.ok) return { product_api_url: '', has_key: false };
    return await res.json();
  } catch {
    return { product_api_url: '', has_key: false };
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
      throw new Error(errBody?.error?.message || errBody?.error || 'Save failed');
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function submitProductSyncSettings() {
  const product_api_url = document.getElementById('pSyncApiUrl')?.value?.trim() || '';
  const product_api_key = document.getElementById('pSyncApiKey')?.value?.trim() || '';

  const result = await saveProductSyncConfig({ product_api_url, product_api_key });
  if (!result.ok) { showToast('Error: ' + result.message, 'error'); return; }
  showToast('Product Sync settings saved.', 'success');
  await openSettingsModal(); // re-render so the key field/status reflects what's now saved
}

async function clearProductSyncKey() {
  const ok = await showConfirm('Remove the saved Product API key? Sync will stop authenticating until a new one is added.');
  if (!ok) return;
  const result = await saveProductSyncConfig({ clear_key: true });
  if (!result.ok) { showToast('Error: ' + result.message, 'error'); return; }
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

