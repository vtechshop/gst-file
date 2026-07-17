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

async function loadPaymentsForInvoice(type, invoiceId) {
  const { data } = await _supabase.from('payments').select('*').eq('invoice_id', invoiceId).eq('invoice_type', type);
  return (data || []).sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}

// Sums the ledger and writes payment_status/amount_paid back onto the
// invoice header — the single place both fields are ever computed, so
// every reader (Invoice List badge, Dashboard Pending Payments, Customer
// Outstanding Summary) sees the same number.
async function recomputeInvoicePaymentSummary(type, invoiceId, userId) {
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const [{ data: invRows }, payments] = await Promise.all([
    _supabase.from(table).select('total_amount').eq('id', invoiceId).single(),
    loadPaymentsForInvoice(type, invoiceId)
  ]);
  const total = +invRows?.total_amount || 0;
  const paid = round2(payments.reduce((s, p) => s + (+p.amount || 0), 0));
  const status = paid <= 0 ? 'unpaid' : (paid + 0.005 >= total ? 'paid' : 'partial');
  await _supabase.from(table).update({ payment_status: status, amount_paid: paid }).eq('id', invoiceId);
  return { paid, status, total, balance: round2(Math.max(0, total - paid)) };
}

async function recordPayment(type, invoiceId, userId, { amount, method, date, note }) {
  amount = +amount || 0;
  if (amount <= 0) return { ok: false, reason: 'Enter an amount greater than zero.' };
  const { error } = await _supabase.from('payments').insert({
    user_id: userId, invoice_id: invoiceId, invoice_type: type,
    amount, method: method || 'cash', payment_date: date || toISO(new Date()), note: note || ''
  });
  if (error) return { ok: false, reason: error.message };
  const summary = await recomputeInvoicePaymentSummary(type, invoiceId, userId);
  return { ok: true, ...summary };
}

async function deletePayment(paymentId, type, invoiceId, userId) {
  const { error } = await _supabase.from('payments').delete().eq('id', paymentId);
  if (error) return { ok: false, reason: error.message };
  const summary = await recomputeInvoicePaymentSummary(type, invoiceId, userId);
  return { ok: true, ...summary };
}

// Outstanding balance per customer, across both B2B and B2C invoices —
// matched by customer_name, the same identity key already used
// elsewhere (Top Customers, Customer-wise Report) since B2C invoices
// now carry a real customer_name too.
async function loadCustomerOutstandingSummary(userId) {
  const [{ data: b2b }, { data: b2c }] = await Promise.all([
    _supabase.from('b2b_invoices').select('customer_name,total_amount,amount_paid,payment_status,is_deleted').eq('user_id', userId),
    _supabase.from('b2c_invoices').select('customer_name,total_amount,amount_paid,payment_status,is_deleted').eq('user_id', userId)
  ]);
  const all = [...(b2b || []), ...(b2c || [])].filter(r => !r.is_deleted && r.customer_name);
  const byCustomer = {};
  all.forEach(r => {
    const key = r.customer_name;
    if (!byCustomer[key]) byCustomer[key] = { name: key, invoiceCount: 0, totalBilled: 0, totalPaid: 0, outstanding: 0 };
    const bal = Math.max(0, (+r.total_amount || 0) - (+r.amount_paid || 0));
    byCustomer[key].invoiceCount += 1;
    byCustomer[key].totalBilled += (+r.total_amount || 0);
    byCustomer[key].totalPaid += (+r.amount_paid || 0);
    byCustomer[key].outstanding += bal;
  });
  return Object.values(byCustomer).sort((a, b) => b.outstanding - a.outstanding);
}
