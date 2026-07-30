// =============================================
// Payment History — itemized ledger behind an invoice's
// payment_status/amount_paid summary fields. Every actual payment
// received is its own row in `payments`; the invoice's summary fields
// are recomputed from this ledger every time a payment is recorded or
// removed, so they can never drift out of sync with the real history.
// =============================================

const PAYMENT_METHOD_LABELS = {
  cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank Transfer',
  cheque: 'Cheque', card: 'Card', other: 'Other'
};

// ── Before-Save payment preview (display only) ───────
// Shared by Invoice Entry and Purchase Entry so the two can't drift:
// both show Grand Total / amount / Remaining Balance and a status
// preview that updates while the user types, instead of the outcome
// only becoming visible after the record lands in its list page.
//
// This is strictly a mirror of what Save will do. It is NOT a second
// source of truth and changes no payment behaviour: the total comes
// from the page's own rollup function (the same one filling its Grand
// Total box), and the derivation below duplicates what both save
// handlers already do — 'paid' records the full total, 'partial'
// records the typed amount, 'unpaid' records nothing. Nothing here
// touches the payments ledger; that stays entirely server-side in
// server/routes/payments.js.

// Pure: no DOM, no page-specific naming. Everything the preview and its
// validation need, derived from three inputs.
function computePaymentPreview(total, status, typedAmount) {
  total = +total || 0;
  const received = status === 'paid'    ? total
                 : status === 'partial' ? (parseFloat(typedAmount) || 0)
                 : 0;
  // Same half-paisa tolerance the server uses when deciding paid vs
  // partial (see recomputeAndApply() in server/routes/payments.js), so a
  // full payment can't preview as a ₹0.00 balance that still reads
  // "Partially Paid" because of a rounding artefact.
  const settled = received + 0.005 >= total && total > 0;
  const over    = received > total + 0.005;
  return {
    total, received, over,
    balance: round2(Math.max(0, total - received)),
    state: over ? 'over' : received <= 0 ? 'unpaid' : settled ? 'paid' : 'partial'
  };
}

// Same badge vocabulary Invoice List / Purchase List already use for the
// real (post-save) status, so the preview reads as the same thing.
const PAYMENT_PREVIEW_BADGE = { unpaid: 'badge-red', partial: 'badge-orange', paid: 'badge-green', over: 'badge-red' };
const PAYMENT_PREVIEW_LABEL = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid', over: 'Invalid Amount' };

// `cfg` is the per-page element map — see INVOICE_PAYMENT_PREVIEW in
// js/invoice-entry.js and PURCHASE_PAYMENT_PREVIEW in js/purchase-entry.js.
// cfg.getTotal() is what keeps this generic: each page hands back its own
// rollup total rather than this file knowing either page's item model.
function paymentPreviewValues(cfg, grandTotal) {
  // The page's rollup function calls the renderer on every item change and
  // passes its already-computed total in, so we don't call back into it and
  // recurse. When the payment inputs fire instead, no argument arrives and
  // we ask for the total on demand. Guarded on typeof number so an Event
  // object (if ever wired as a listener rather than an inline handler) is
  // ignored rather than treated as a total.
  const total = typeof grandTotal === 'number' ? grandTotal : cfg.getTotal();
  const status = document.getElementById(cfg.statusField)?.value || 'unpaid';
  const typed  = document.getElementById(cfg.amountField)?.value || '';
  return computePaymentPreview(total, status, typed);
}

function renderPaymentPreview(cfg, grandTotal) {
  if (!document.getElementById(cfg.box)) return; // page has no preview block
  const { total, received, balance, over, state } = paymentPreviewValues(cfg, grandTotal);

  const money = (id, v) => { const el = document.getElementById(id); if (el) el.value = '₹' + formatNum(v); };
  money(cfg.total, total);
  money(cfg.received, received);
  // An over-payment has no meaningful remaining balance — showing ₹0.00
  // would read as "settled", the opposite of the error being raised.
  const balEl = document.getElementById(cfg.balance);
  if (balEl) balEl.value = over ? '—' : '₹' + formatNum(balance);

  const statusEl = document.getElementById(cfg.status);
  if (statusEl) statusEl.innerHTML = `<span class="badge ${PAYMENT_PREVIEW_BADGE[state]}">${PAYMENT_PREVIEW_LABEL[state]}</span>`;

  // Inline error that doesn't block typing: the field keeps whatever was
  // entered (so it can be corrected rather than silently rewritten) and
  // Save refuses it — see validatePaymentPreviewAmount() below.
  const errEl = document.getElementById(cfg.error);
  if (errEl) {
    errEl.classList.toggle('d-none', !over);
    errEl.textContent = over
      ? `${cfg.amountLabel} (₹${formatNum(received)}) is more than the Grand Total (₹${formatNum(total)}). Enter ₹${formatNum(total)} or less.`
      : '';
  }
}

// Blocking check for Save. Only the 'partial' path can over-pay — 'paid'
// is defined as exactly the total and 'unpaid' records nothing — so this
// deliberately does not object to a blank/zero amount: leaving it empty
// already means "record no payment", and that behaviour is unchanged.
// The server enforces this too (routes/payments.js checks the amount
// against the ledger sum); catching it here just avoids saving the record
// and then failing its payment.
function validatePaymentPreviewAmount(cfg) {
  if ((document.getElementById(cfg.statusField)?.value || 'unpaid') !== 'partial') return true;
  const { over, total } = paymentPreviewValues(cfg);
  if (!over) return true;
  renderPaymentPreview(cfg);
  showToast(`${cfg.amountLabel} cannot be more than the Grand Total (₹${formatNum(total)}).`, 'error');
  document.getElementById(cfg.amountField)?.focus();
  return false;
}

async function loadPaymentsForInvoice(type, invoiceId) {
  const { data } = await _supabase.from('payments').select('*').eq('invoice_id', invoiceId).eq('invoice_type', type);
  return (data || []).sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}

// Recording/removing a payment writes both the payments ledger AND the
// invoice header's cached payment_status/amount_paid — server/routes/
// payments.js wraps both in one Postgres transaction (see the comment
// there) so they can never drift apart the way two separate client-side
// calls could if the second one failed after the first succeeded.
async function recordPayment(type, invoiceId, userId, { amount, method, date, referenceNumber, note }) {
  amount = +amount || 0;
  if (amount <= 0) return { ok: false, reason: 'Enter an amount greater than zero.' };
  try {
    const summary = await apiFetch(`/payments/${type}/${invoiceId}/record`, {
      method: 'POST',
      body: JSON.stringify({
        amount, method: method || 'cash', date: date || toISO(new Date()),
        reference_number: referenceNumber || '', note: note || ''
      })
    });
    return { ok: true, ...summary };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function deletePayment(paymentId, type, invoiceId, userId) {
  try {
    const summary = await apiFetch(`/payments/${type}/${invoiceId}/${paymentId}/delete`, { method: 'POST' });
    return { ok: true, ...summary };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Outstanding balance per customer, across both B2B and B2C invoices —
// matched by customer_name, the same identity key already used
// elsewhere (Top Customers, Customer-wise Report) since B2C invoices
// now carry a real customer_name too. Sales Returns reduce what a
// customer owes (goods came back), so each customer's return total is
// netted off their outstanding balance here — this reads sales_returns
// only and never touches the invoice rows themselves.
async function loadCustomerOutstandingSummary(userId) {
  const [{ data: b2b }, { data: b2c }, { data: srData }] = await Promise.all([
    _supabase.from('b2b_invoices').select('customer_name,total_amount,amount_paid,payment_status').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('customer_name,total_amount,amount_paid,payment_status').eq('user_id', userId),
    _supabase.from('sales_returns').select('customer_name,total_amount').eq('user_id', userId)
  ]);
  const all = [...(b2b || []), ...(b2c || [])].filter(r => r.customer_name);
  const byCustomer = {};
  all.forEach(r => {
    const key = r.customer_name;
    if (!byCustomer[key]) byCustomer[key] = { name: key, invoiceCount: 0, totalBilled: 0, totalPaid: 0, totalReturned: 0, outstanding: 0 };
    const bal = Math.max(0, (+r.total_amount || 0) - (+r.amount_paid || 0));
    byCustomer[key].invoiceCount += 1;
    byCustomer[key].totalBilled += (+r.total_amount || 0);
    byCustomer[key].totalPaid += (+r.amount_paid || 0);
    byCustomer[key].outstanding += bal;
  });
  (srData || []).filter(r => r.customer_name && byCustomer[r.customer_name]).forEach(r => {
    byCustomer[r.customer_name].totalReturned += (+r.total_amount || 0);
  });
  Object.values(byCustomer).forEach(c => {
    c.outstanding = Math.max(0, c.outstanding - c.totalReturned);
  });
  return Object.values(byCustomer).sort((a, b) => b.outstanding - a.outstanding);
}

// Outstanding balance per vendor, across `purchases` — same shape as
// loadCustomerOutstandingSummary() above, matched by vendor_name. No
// returns-netting: Purchase Returns don't carry payment tracking (out
// of scope — a return reduces what's owed to the vendor on the next
// purchase, it isn't itself a payable).
async function loadVendorOutstandingSummary(userId) {
  const { data } = await _supabase.from('purchases').select('vendor_name,total_amount,amount_paid,payment_status').eq('user_id', userId);
  const byVendor = {};
  (data || []).filter(r => r.vendor_name).forEach(r => {
    const key = r.vendor_name;
    if (!byVendor[key]) byVendor[key] = { name: key, purchaseCount: 0, totalBilled: 0, totalPaid: 0, outstanding: 0 };
    const bal = Math.max(0, (+r.total_amount || 0) - (+r.amount_paid || 0));
    byVendor[key].purchaseCount += 1;
    byVendor[key].totalBilled += (+r.total_amount || 0);
    byVendor[key].totalPaid += (+r.amount_paid || 0);
    byVendor[key].outstanding += bal;
  });
  return Object.values(byVendor).sort((a, b) => b.outstanding - a.outstanding);
}
