// =============================================
// Business Profile – Setup, Edit, Print Header
// =============================================

let _currentProfile = null;

// ── Load profile from DB ───────────────────
async function loadUserProfile(userId) {
  let { data } = await _supabase.from('profiles').select('*').eq('id', userId).single();

  // Auto-migrate: if profile saved with wrong random UUID (old bug), fix it
  if (!data && typeof IS_LOCAL_MODE !== 'undefined' && IS_LOCAL_MODE) {
    const all = JSON.parse(localStorage.getItem('gst_profiles') || '[]');
    const anyProfile = all.find(p => p.business_name);
    if (anyProfile) {
      anyProfile.id = userId;
      localStorage.setItem('gst_profiles', JSON.stringify(all));
      data = anyProfile;
    }
  }

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
async function openProfileModal(isRequired = false) {
  const user = await getCurrentUser();
  if (!user) return;
  const profile = _currentProfile || (await loadUserProfile(user.id));
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
            <input type="text" id="profBizName" class="form-control" placeholder="Your business name" value="${e(profile?.business_name)}">
          </div>
          <div class="form-group">
            <label>Your GSTIN <span style="color:red;">*</span></label>
            <input type="text" id="profGSTIN" class="form-control" placeholder="e.g. 27AAPFU0939F1ZV" value="${e(profile?.gstin)}" maxlength="15" style="text-transform:uppercase;letter-spacing:1px;">
          </div>
          <div class="form-group">
            <label>PAN</label>
            <input type="text" id="profPAN" class="form-control uppercase" placeholder="e.g. AARFV8415B" maxlength="10" value="${e(profile?.pan)}">
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" id="profPhone" class="form-control" placeholder="+91 98765 43210" value="${e(profile?.phone)}">
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label>Business Address</label>
            <textarea id="profAddress" class="form-control" rows="2" placeholder="Door No, Street, City, PIN Code">${e(profile?.address)}</textarea>
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
            <input type="email" id="profEmail" class="form-control" placeholder="business@email.com" value="${e(profile?.email)}">
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label>Website</label>
            <input type="text" id="profWebsite" class="form-control" placeholder="e.g. www.yourbusiness.com" value="${e(profile?.website)}">
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

// ── Generic base64 image upload/clear (reused for logo/seal/signature/QR) ──
function handleImageUpload(file, hiddenId, previewWrapId, iconClass) {
  if (!file) return;
  if (file.size > 500 * 1024) { showToast('Image too large — please use a file under 500KB.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const hidden = document.getElementById(hiddenId);
    if (hidden) hidden.value = dataUrl;
    const wrap = document.getElementById(previewWrapId);
    if (wrap) wrap.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:contain;">`;
  };
  reader.readAsDataURL(file);
}

function clearImageUpload(hiddenId, previewWrapId, iconClass) {
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = '';
  const wrap = document.getElementById(previewWrapId);
  if (wrap) wrap.innerHTML = `<i class="fas ${iconClass} text-gray-mid"></i>`;
}

// ── Settings Modal ─────────────────────────
async function openSettingsModal() {
  const user  = await getCurrentUser();
  if (!user) return;
  const profile = _currentProfile || await loadUserProfile(user.id);

  document.getElementById('settingsModalWrap')?.remove();

  const noProfile = !profile?.business_name;
  const stats = typeof getStorageStats === 'function' ? getStorageStats() : {};

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
            <input type="text" id="setInvFormat" class="form-control" placeholder="e.g. INV-2026-###" value="${e(profile?.invoice_number_format || 'INV-###')}" oninput="updateSettingsInvPreview()">
          </div>
          <div class="form-group">
            <label for="setInvNextSeq">Next Sequence Number</label>
            <input type="number" id="setInvNextSeq" class="form-control" min="1" step="1" value="${profile?.invoice_current_sequence || 1}" oninput="updateSettingsInvPreview()">
          </div>
        </div>
        <p class="fs-11 text-muted-sm mb-10"><b>#</b> marks the running sequence &mdash; <code>###</code> = 001, 002&hellip; &nbsp;<code>####</code> = 0001, 0002&hellip; Everything else in the format is kept exactly as typed.</p>
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
            <input type="text" id="brandUPI" class="form-control" placeholder="e.g. business@okhdfcbank" value="${e(profile?.upi_id)}">
          </div>
        </div>

        <div class="section-title mb-14" style="font-size:11px;">Bank Details</div>
        <div class="form-grid cols-2" style="gap:14px;margin-bottom:14px;">
          <div class="form-group">
            <label>Bank Name</label>
            <input type="text" id="brandBankName" class="form-control" placeholder="e.g. HDFC Bank" value="${e(profile?.bank_name)}">
          </div>
          <div class="form-group">
            <label>Account Number</label>
            <input type="text" id="brandBankAccount" class="form-control" placeholder="Account number" value="${e(profile?.bank_account_no)}">
          </div>
          <div class="form-group">
            <label>IFSC Code</label>
            <input type="text" id="brandBankIFSC" class="form-control uppercase" placeholder="e.g. HDFC0001234" value="${e(profile?.bank_ifsc)}">
          </div>
          <div class="form-group">
            <label>Branch</label>
            <input type="text" id="brandBankBranch" class="form-control" placeholder="Branch name" value="${e(profile?.bank_branch)}">
          </div>
        </div>

        <div class="form-group mb-14">
          <label>Invoice Footer Text</label>
          <textarea id="brandFooterText" class="form-control" rows="2" placeholder="e.g. Thank you for your business!">${e(profile?.footer_text)}</textarea>
        </div>

        <div class="form-group mb-14">
          <label>Terms &amp; Conditions</label>
          <textarea id="brandTerms" class="form-control" rows="3" placeholder="e.g. Warranty Information: covers manufacturing defects only...&#10;Return Policy: returns accepted within 15 days if unused.">${e(profile?.terms_conditions)}</textarea>
        </div>

        <button class="btn btn-primary btn-sm" onclick="submitCompanyBranding()"><i class="fas fa-save"></i> Save Branding</button>
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
            <input type="text" id="prefFinancialYear" class="form-control" placeholder="e.g. 2026-27" value="${e(getAppSettings().financialYear || defaultFinancialYear())}" onchange="saveAppSetting('financialYear', this.value)">
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
  const seq = parseInt(document.getElementById('setInvNextSeq')?.value, 10) || 1;
  const el = document.getElementById('setInvPreview');
  if (el) el.textContent = applyInvoiceNumberFormat(format, seq);
}

async function submitInvoiceNumberingSettings() {
  const user = await getCurrentUser();
  if (!user) return;

  let format = document.getElementById('setInvFormat')?.value?.trim() || 'INV-###';
  if (!format.includes('#')) {
    format = format + '-###';
    showToast('Format must include # for the running sequence — appended automatically.', 'warning');
  }
  const seq = Math.max(1, parseInt(document.getElementById('setInvNextSeq')?.value, 10) || 1);
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

