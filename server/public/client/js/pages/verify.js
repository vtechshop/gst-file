// =============================================
// Public invoice verification page
// =============================================
// Reached by scanning the QR on a printed invoice, so it runs for someone
// with no login and loads no auth code at all - no token is read, stored or
// sent from here. It asks the public endpoint for one invoice and prints
// what comes back; every value shown is already on the paper in the
// reader's hand.
//
// Self-contained on purpose: config.js constructs an ApiClient and installs
// the app's global error handlers, and neither belongs on a page that is
// meant to work without a session.
(function () {
  // Same rule config.js uses, kept short here rather than importing the
  // whole client: Vercel talks to the Render API, everything else - the
  // Hostinger host the QR actually points at - is same-origin.
  var API_BASE = location.hostname.endsWith('vercel.app')
    ? 'https://gst-file.onrender.com/api'
    : (['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0 ? 'http://localhost:4000/api' : '/api');

  var FIELDS = [
    ['Invoice Number', 'invoice_number'],
    ['Invoice Date', 'invoice_date'],
    ['Supplier Name', 'supplier_name'],
    ['Supplier GSTIN', 'supplier_gstin'],
    ['Buyer Name', 'buyer_name'],
    ['Buyer GSTIN', 'buyer_gstin'],
    ['Place of Supply', 'place_of_supply'],
    ['Invoice Type', 'invoice_type'],
    ['Taxable Amount', 'taxable_amount', true],
    ['CGST', 'cgst', true],
    ['SGST', 'sgst', true],
    ['IGST', 'igst', true],
    ['Total Invoice Amount', 'total_amount', true],
    ['Invoice ID', 'invoice_id']
  ];

  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A field the invoice genuinely does not carry - a B2C buyer has no GSTIN -
  // is stated as N/A rather than left blank, so the reader can tell "not
  // applicable" from "failed to load".
  function show(v) {
    if (v === null || v === undefined || v === '') return 'N/A';
    return esc(v);
  }

  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) return 'N/A';
    return 'Rs.' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function typeLabel(t) {
    return t === 'b2b' ? 'B2B (Registered)' : t === 'b2c' ? 'B2C (Unregistered)' : show(t);
  }

  function dateLabel(d) {
    if (!d) return 'N/A';
    var m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : show(d);
  }

  function banner(ok, text) {
    return '<div style="padding:14px 16px;border-radius:8px;font-weight:700;font-size:16px;'
      + (ok ? 'background:#e6f4ea;color:#1b5e20;border:1px solid #1b5e20;'
            : 'background:#fdecea;color:#b3261e;border:1px solid #b3261e;')
      + '"><i class="fas ' + (ok ? 'fa-circle-check' : 'fa-circle-xmark') + '"></i> ' + text + '</div>';
  }

  function render(data) {
    var st = document.getElementById('verifyStatus');
    var body = document.getElementById('verifyBody');
    if (!data || !data.found) {
      st.innerHTML = banner(false, 'INVOICE NOT FOUND');
      body.innerHTML = '<p class="text-muted-sm">This invoice could not be verified. '
        + 'Check that the QR code was scanned completely, or contact the issuing business.</p>';
      return;
    }
    st.innerHTML = banner(true, 'VALID INVOICE');
    var inv = data.invoice || {};
    var rows = FIELDS.map(function (f) {
      var raw = inv[f[1]];
      var val = f[2] ? money(raw) : (f[1] === 'invoice_type' ? typeLabel(raw)
                     : f[1] === 'invoice_date' ? dateLabel(raw) : show(raw));
      return '<tr><td style="padding:8px 12px;color:#555;">' + esc(f[0]) + '</td>'
           + '<td style="padding:8px 12px;font-weight:600;text-align:right;">' + val + '</td></tr>';
    }).join('');
    body.innerHTML = '<table style="width:100%;border-collapse:collapse;">'
      + '<tbody>' + rows + '</tbody></table>';
  }

  function init() {
    var q = new URLSearchParams(location.search);
    var t = q.get('t');
    var id = q.get('id');
    var st = document.getElementById('verifyStatus');
    if (!t || !id) { render(null); return; }
    st.innerHTML = '<p class="text-muted-sm">Verifying…</p>';
    fetch(API_BASE + '/verify/invoice/' + encodeURIComponent(t) + '/' + encodeURIComponent(id))
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(render)
      // A network failure is not proof the invoice is fake, but this page has
      // nothing else to offer, so it says the same thing rather than guessing.
      .catch(function () { render(null); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
