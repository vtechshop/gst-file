// =============================================
// Utility Functions
// =============================================

// ── Theme (applied immediately to avoid a flash of the wrong theme) ──
(function applyStoredTheme() {
  const theme = localStorage.getItem('gst_theme') || 'light';
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

function toggleTheme(dark) {
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('gst_theme', dark ? 'dark' : 'light');
}

// ── App-wide preferences (default GST rate, financial year) ──
function getAppSettings() {
  try { return JSON.parse(localStorage.getItem('gst_app_settings') || '{}'); } catch { return {}; }
}

function saveAppSetting(key, value) {
  const settings = getAppSettings();
  settings[key] = value;
  localStorage.setItem('gst_app_settings', JSON.stringify(settings));
}

function getDefaultGstPct() {
  const v = getAppSettings().defaultGstPct;
  return v === undefined || v === null || v === '' ? 18 : v;
}

// ── Invoice Number Format (Auto Generate mode) ──────
// Three cases, in order:
//  1. Format contains a run of # characters — it becomes the zero-padded
//     running sequence, everything else left exactly as typed, wherever
//     it appears (prefix, middle, or suffix). INV-2026-### -> INV-2026-001,
//     VT/B2B/#### -> VT/B2B/0001, SALE## -> SALE01.
//  2. Format is purely digits (e.g. "1") — that number IS the running
//     sequence, not a literal prefix to keep re-stating (appending would
//     read "1-1", "1-2", which isn't what a bare numeric format means).
//     1 -> 1, 2, 3, 4...
//  3. Any other plain text with no # — the running sequence is appended
//     as a new "-N" suffix, not merged into any digits already present
//     (INV-2026 keeps "2026" literal and still counts from -1, it does
//     NOT continue 2027, 2028...). INV -> INV-1, INV-2; INV-2026 ->
//     INV-2026-1, INV-2026-2; VT/B2B -> VT/B2B-1, VT/B2B-2.
function applyInvoiceNumberFormat(format, seq) {
  const fmt = (format || '').trim() || 'INV-###';
  const n = Math.max(1, parseInt(seq, 10) || 1);
  const match = fmt.match(/#+/);
  if (match) {
    const padded = String(n).padStart(match[0].length, '0');
    return fmt.slice(0, match.index) + padded + fmt.slice(match.index + match[0].length);
  }
  if (/^\d+$/.test(fmt)) return String(n);
  return fmt + '-' + n;
}

function calcGST(taxableAmount, gstPct, supplyType) {
  const gstAmt = (taxableAmount * gstPct) / 100;
  let igst = 0, cgst = 0, sgst = 0;
  if (supplyType === 'interstate') {
    igst = gstAmt;
  } else {
    cgst = gstAmt / 2;
    sgst = gstAmt / 2;
  }
  return {
    gstAmount: round2(gstAmt),
    igst: round2(igst),
    cgst: round2(cgst),
    sgst: round2(sgst),
    totalGst: round2(gstAmt),
    totalAmount: round2(taxableAmount + gstAmt)
  };
}

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(n || 0);
}

function formatNum(n) {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Local calendar date as YYYY-MM-DD. Deliberately NOT d.toISOString() —
// that converts to UTC first, which silently rolls the date (or even
// the month) backward by one for any timezone ahead of UTC (e.g. IST)
// whenever d was built from local parts like new Date(y, m, 1) at local
// midnight. Every caller here wants "the calendar date this Date
// represents", not a UTC instant.
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthYearOptions() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push({
      label: d.toLocaleString('default', { month: 'long', year: 'numeric' }),
      value: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    });
  }
  return opts;
}

function showToast(msg, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const colors = { success: '#00796b', error: '#d32f2f', warning: '#f57c00', info: '#1565c0' };
  toast.style.cssText = `background:${colors[type]||colors.success};color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.2);min-width:250px;display:flex;align-items:center;gap:10px;animation:slideIn 0.3s ease;`;
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
  toast.innerHTML = `<i class="fas ${icons[type]||icons.success}"></i><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100px)'; toast.style.transition = 'all 0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function showConfirm(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <i class="fas fa-exclamation-triangle" style="color:#f57c00;font-size:22px;"></i>
          <h3 style="margin:0;color:#333;font-size:17px;">Confirm Action</h3>
        </div>
        <p style="margin:0 0 24px;color:#666;font-size:14px;">${msg}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="confirmNo" style="padding:8px 20px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">Cancel</button>
          <button id="confirmYes" style="padding:8px 20px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirmYes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirmNo').onclick  = () => { overlay.remove(); resolve(false); };
  });
}

// Same shape as showConfirm, but for neutral Yes/No questions (not
// destructive actions) — no red "Delete" button, a primary-colored "Yes".
function showYesNo(msg, title) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <i class="fas fa-question-circle" style="color:#00796b;font-size:22px;"></i>
          <h3 style="margin:0;color:#333;font-size:17px;">${title || 'Confirm'}</h3>
        </div>
        <p style="margin:0 0 24px;color:#666;font-size:14px;">${msg}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="yesNoNo" style="padding:8px 20px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">No</button>
          <button id="yesNoYes" style="padding:8px 20px;background:#00796b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Yes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#yesNoYes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#yesNoNo').onclick  = () => { overlay.remove(); resolve(false); };
  });
}

// ── Background scroll lock while a modal is open ──
// Call lockBodyScroll() right after showing a modal, and
// unlockBodyScrollIfNoModalsOpen() on every path that closes one — it
// only actually restores scrolling once no modal is left open, so
// chained close+reopen calls (e.g. Settings → Business Profile) never
// flicker the page scrollbar on and off.
function lockBodyScroll() {
  document.body.style.overflow = 'hidden';
}

function unlockBodyScrollIfNoModalsOpen() {
  const anyOpen = document.getElementById('profileModalWrap')
    || document.getElementById('settingsModalWrap')
    || document.querySelector('.modal-overlay.open');
  if (!anyOpen) document.body.style.overflow = '';
}

function setupMobileMenu() {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target) && !toggle.contains(e.target)) sidebar.classList.remove('open');
    });
  }
}

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa',
  'Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala',
  'Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland',
  'Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura',
  'Uttar Pradesh','Uttarakhand','West Bengal','Andaman and Nicobar Islands',
  'Chandigarh','Dadra and Nagar Haveli and Daman and Diu','Delhi',
  'Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry'
];

// ── Number to words (Indian numbering: lakh/crore) ──
function numberToWordsINR(n) {
  const num = Math.round(Math.abs(+n || 0));
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

  function twoDigits(v) {
    if (v < 20) return ones[v];
    return tens[Math.floor(v / 10)] + (v % 10 ? ' ' + ones[v % 10] : '');
  }
  function threeDigits(v) {
    if (v < 100) return twoDigits(v);
    return ones[Math.floor(v / 100)] + ' Hundred' + (v % 100 ? ' and ' + twoDigits(v % 100) : '');
  }

  if (num === 0) return 'Zero Rupees Only';

  const crore = Math.floor(num / 10000000);
  const lakh  = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred   = num % 1000;

  const parts = [];
  if (crore)    parts.push(threeDigits(crore) + ' Crore');
  if (lakh)     parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (hundred)  parts.push(threeDigits(hundred));

  return parts.join(' ') + ' Rupees Only';
}
