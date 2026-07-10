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
async function saveUserProfile(userId, fields) {
  const payload = { id: userId, ...fields };
  const existing = await _supabase.from('profiles').select('id').eq('id', userId).single();
  let error;
  if (existing.data) {
    ({ error } = await _supabase.from('profiles').update(payload).eq('id', userId));
  } else {
    ({ error } = await _supabase.from('profiles').insert(payload));
  }
  if (!error) {
    _currentProfile = payload;
    updateNavFromProfile(payload);
    showToast('Business profile saved!', 'success');
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
        <button class="modal-close" onclick="document.getElementById('profileModalWrap').remove()" style="color:rgba(255,255,255,0.7);font-size:20px;">&#10005;</button>
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
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('profileModalWrap').remove()">
          ${isRequired ? '<i class="fas fa-times"></i> Skip for Now' : 'Cancel'}
        </button>
        <button class="btn btn-primary" onclick="submitProfile()"><i class="fas fa-save"></i> Save Profile</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);
  document.getElementById('profGSTIN').addEventListener('input', function() { this.value = this.value.toUpperCase(); });
}

function e(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

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
    <div class="modal" style="max-width:520px;border-radius:14px;overflow:hidden;">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,var(--primary-dark),var(--primary));padding:18px 22px;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;color:#fff;">
          <div style="width:36px;height:36px;background:rgba(255,255,255,0.15);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;">
            <i class="fas fa-cog"></i>
          </div>
          <div>
            <div style="font-size:15px;font-weight:700;">Settings</div>
            <div style="font-size:11px;opacity:0.75;">Profile & Data Management</div>
          </div>
        </div>
        <button onclick="document.getElementById('settingsModalWrap').remove()" style="background:rgba(255,255,255,0.15);border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;">&times;</button>
      </div>

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

        <button class="btn btn-primary btn-sm" onclick="document.getElementById('settingsModalWrap').remove();openProfileModal();" style="margin-top:6px;">
          <i class="fas fa-${noProfile?'plus':'edit'}"></i> ${noProfile ? 'Setup Profile' : 'Edit Profile'}
        </button>
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
          <button class="btn btn-sm" onclick="document.getElementById('settingsModalWrap').remove();confirmClearData();" style="border:1px solid #ddd;color:var(--danger);background:#fff;">
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
    </div>`;

  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
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
    email:   document.getElementById('profEmail')?.value?.trim() || ''
  });

  if (!error) document.getElementById('profileModalWrap')?.remove();
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

// ── Business header for Print ──────────────
function getBusinessPrintHTML() {
  const p = _currentProfile;
  if (!p || !p.business_name) return '';
  return `
    <div style="border:2px solid #004d40;border-radius:8px;padding:14px 18px;margin-bottom:18px;background:#f0faf9;page-break-inside:avoid;">
      <table style="width:100%;border:none;">
        <tr>
          <td style="vertical-align:top;border:none;padding:0;">
            <div style="font-size:18px;font-weight:700;color:#004d40;">${p.business_name}</div>
            <div style="font-size:12px;color:#333;margin-top:3px;"><b>GSTIN:</b> ${p.gstin || '-'}</div>
            ${p.address ? `<div style="font-size:11px;color:#555;margin-top:2px;">${p.address}${p.state?', '+p.state:''}</div>` : ''}
          </td>
          <td style="text-align:right;vertical-align:top;border:none;padding:0;">
            ${p.phone ? `<div style="font-size:11px;color:#555;">&#128222; ${p.phone}</div>` : ''}
            ${p.email ? `<div style="font-size:11px;color:#555;">&#9993; ${p.email}</div>` : ''}
            <div style="margin-top:6px;font-size:10px;color:#888;">GST Invoice & GSTR-1 Management</div>
          </td>
        </tr>
      </table>
    </div>`;
}
