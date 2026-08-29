// =============================================
// Public warranty verification page
// =============================================
// Reached by scanning the QR on the goods or tapping the NFC tag, so it runs
// for someone with no login and loads no auth code at all - no token is read,
// stored or sent from here.
//
// Self-contained for the same reason verify.js is: config.js constructs an
// ApiClient and installs the app's global error handlers, and neither belongs
// on a page meant to work without a session.
//
// The status shown is whatever the endpoint computes today, not anything the
// tag carries. That is the whole point of putting only an address on the tag:
// cover that has since been cancelled or has run out says so here, with no
// tag rewritten.
(function () {
  // Same rule config.js uses, kept short here rather than importing the whole
  // client: Vercel talks to the Render API, everything else - the Hostinger
  // host the QR actually points at - is same-origin.
  var API_BASE = location.hostname.endsWith('vercel.app')
    ? 'https://gst-file.onrender.com/api'
    : (['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0 ? 'http://localhost:4000/api' : '/api');

  var FIELDS = [
    ['Warranty No', 'warranty_number'],
    ['Customer', 'customer_name'],
    ['Invoice No', 'invoice_number'],
    ['Purchase Date', 'purchase_date', 'date'],
    ['Product', 'product_name'],
    ['SKU', 'product_sku'],
    ['Serial Number', 'serial_number'],
    ['Quantity', 'quantity'],
    ['Warranty Period', 'warranty_period_months', 'months'],
    ['Warranty Start', 'warranty_start_date', 'date'],
    ['Warranty Until', 'warranty_until', 'date'],
    ['Issued By', 'supplier_name']
  ];

  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(v) {
    if (!v) return '';
    var s = String(v).slice(0, 10);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : s;
  }

  function fmtMonths(n) {
    var v = parseInt(n, 10);
    if (!v || v < 1) return '';
    if (v === 12) return '12 Months / 1 Year';
    return v + (v === 1 ? ' Month' : ' Months');
  }

  function show(statusHtml, bodyHtml) {
    document.getElementById('warrantyStatus').innerHTML = statusHtml;
    document.getElementById('warrantyBody').innerHTML = bodyHtml || '';
  }

  function banner(state, daysRemaining) {
    var map = {
      ACTIVE: ['#0f9d58', 'fa-circle-check', 'Warranty Active'],
      EXPIRED: ['#c5221f', 'fa-circle-xmark', 'Warranty Expired'],
      CANCELLED: ['#5f6368', 'fa-ban', 'Warranty Cancelled']
    };
    var m = map[state] || map.CANCELLED;
    var sub = '';
    if (state === 'ACTIVE' && daysRemaining !== null && daysRemaining !== undefined) {
      sub = '<div style="font-size:12px;opacity:.9;margin-top:2px;">'
          + esc(daysRemaining) + ' day' + (daysRemaining === 1 ? '' : 's') + ' remaining</div>';
    }
    return '<div style="background:' + m[0] + ';color:#fff;padding:12px 14px;border-radius:6px;">'
         + '<i class="fas ' + m[1] + '"></i> <b>' + m[2] + '</b>' + sub + '</div>';
  }

  function rows(w) {
    var out = '<table class="data-table" style="width:100%;">';
    FIELDS.forEach(function (f) {
      var raw = w[f[1]];
      if (raw === null || raw === undefined || raw === '') return;
      var val = f[2] === 'date' ? fmtDate(raw) : f[2] === 'months' ? fmtMonths(raw) : raw;
      if (!val) return;
      out += '<tr><td style="width:42%;color:#5f6368;">' + esc(f[0]) + '</td>'
           + '<td><b>' + esc(val) + '</b></td></tr>';
    });
    out += '</table>';
    if (w.warranty_terms) {
      out += '<div style="margin-top:14px;">'
           + '<div style="color:#5f6368;font-size:12px;margin-bottom:4px;">Warranty Terms</div>'
           + '<div style="white-space:pre-wrap;">' + esc(w.warranty_terms) + '</div></div>';
    }
    return out;
  }

  function run() {
    var id = new URLSearchParams(location.search).get('id') || '';
    if (!id) {
      show('<div class="alert alert-danger">No warranty reference supplied.</div>');
      return;
    }
    show('<div class="text-muted-sm">Checking warranty&hellip;</div>');

    fetch(API_BASE + '/verify/warranty/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.found) {
          // One message for every failure, matching what the endpoint does:
          // a stranger cannot learn which references exist by trying them.
          show('<div class="alert alert-danger"><i class="fas fa-circle-xmark"></i> '
             + 'This warranty could not be found. Check the code and try again.</div>');
          return;
        }
        var w = res.body.warranty;
        show(banner(res.body.status, w.days_remaining), rows(w));
      })
      .catch(function () {
        show('<div class="alert alert-danger">Could not reach the server. Check your connection and try again.</div>');
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
