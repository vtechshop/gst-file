// =============================================
// Advances received and adjusted (Batch 5)
// =============================================
// GSTR-1 Table 11A reports tax paid on advances where the supply has not
// yet been invoiced. Table 11B reports that same tax being backed out as
// the invoices are raised.
//
// 11A needs no new data: a Receipt Voucher (Module 4B) already records an
// advance, so this page shows what those vouchers will report rather than
// asking for them again.
//
// 11B does need new data. The receipt voucher carries a running
// adjusted_amount, but a running total has no date, and 11B is a question
// about a period — "what was adjusted in June". So each adjustment is
// recorded here as its own dated row.

let advVouchers = [], advAdjustments = [], advInvoices = [], advUserId = null;

function advEl(id) { return document.getElementById(id); }
function advVal(id) { return (advEl(id)?.value || '').trim(); }
function advRound(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

async function initAdvances() {
  const user = await requireAuth();
  if (!user) return;
  advUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  const d = advEl('advDate');
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
  await loadAdvances();
}

async function loadAdvances() {
  const [rv, adj, b2b, b2c] = await Promise.all([
    _supabase.from('receipt_vouchers').select('*').eq('user_id', advUserId),
    _supabase.from('advance_adjustments').select('*').eq('user_id', advUserId),
    _supabase.from('b2b_invoices').select('*').eq('user_id', advUserId),
    _supabase.from('b2c_invoices').select('*').eq('user_id', advUserId)
  ]);
  advVouchers = rv.data || [];
  advAdjustments = adj.data || [];
  advInvoices = [
    ...(b2b.data || []).map(r => ({ ...r, __table: 'b2b_invoices' })),
    ...(b2c.data || []).map(r => ({ ...r, __table: 'b2c_invoices' }))
  ];

  const sel = advEl('advVoucher');
  if (sel) {
    // Only vouchers with something left to adjust are offered — the rest
    // are fully applied and offering them would only produce a refusal.
    sel.innerHTML = '<option value="">— select the advance —</option>' +
      advVouchers
        .filter(v => String(v.status || '').toLowerCase() !== 'cancelled')
        .filter(v => advRemaining(v) > 0)
        .map(v => `<option value="${escHtmlAttr(v.id)}">${escItemHtml(v.document_number)} · ${escItemHtml(v.party_name || '')} · ${formatCurrency(advRemaining(v))} left</option>`)
        .join('');
  }
  const isel = advEl('advInvoice');
  if (isel) {
    isel.innerHTML = '<option value="">— invoice it was applied to —</option>' +
      advInvoices
        .sort((a, b) => compareInvoiceNumbers(b.invoice_number, a.invoice_number))
        .map(r => `<option value="${escHtmlAttr(r.__table + ':' + r.id)}">${escItemHtml(r.invoice_number)} · ${escItemHtml(formatDate(r.invoice_date))} · ${escItemHtml(r.customer_name || '')}</option>`)
        .join('');
  }
  renderAdvances();
}

// What is left of an advance: what came in, less every adjustment already
// recorded against it.
function advRemaining(v) {
  const applied = advAdjustments
    .filter(a => a.receipt_voucher_id === v.id)
    .reduce((s, a) => s + (parseFloat(a.adjusted_amount) || 0), 0);
  return advRound((parseFloat(v.advance_amount) || 0) - applied);
}

function renderAdvances() {
  const rec = advEl('advReceivedBody');
  if (rec) {
    const live = advVouchers.filter(v => String(v.status || '').toLowerCase() !== 'cancelled');
    rec.innerHTML = live.length ? live.map(v => `<tr>
        <td class="fw-600">${escItemHtml(v.document_number)}</td>
        <td>${escItemHtml(formatDate(v.document_date))}</td>
        <td>${escItemHtml(v.party_name || '')}</td>
        <td>${escItemHtml(v.place_of_supply || '')}</td>
        <td>${escItemHtml(v.supply_type === 'interstate' ? 'INTER' : 'INTRA')}</td>
        <td class="text-right">${v.gst_percentage}%</td>
        <td class="text-right">${formatCurrency(v.advance_amount || 0)}</td>
        <td class="text-right">${formatCurrency(advRemaining(v))}</td>
      </tr>`).join('')
      : `<tr><td colspan="8" class="text-center text-muted p-16">No advances recorded. Receipt Vouchers appear here.</td></tr>`;
  }

  const adj = advEl('advAdjustedBody');
  if (adj) {
    adj.innerHTML = advAdjustments.length ? advAdjustments
      .sort((a, b) => String(b.adjusted_on).localeCompare(String(a.adjusted_on)))
      .map(a => {
        const v = advVouchers.find(x => x.id === a.receipt_voucher_id);
        return `<tr>
          <td>${escItemHtml(formatDate(a.adjusted_on))}</td>
          <td class="fw-600">${escItemHtml(v ? v.document_number : '—')}</td>
          <td>${escItemHtml(a.invoice_number || '—')}</td>
          <td>${escItemHtml(a.place_of_supply || '')}</td>
          <td class="text-right">${a.gst_percentage}%</td>
          <td class="text-right">${formatCurrency(a.adjusted_amount || 0)}</td>
          <td class="text-center"><button class="btn btn-sm btn-danger" onclick="deleteAdjustment('${escHtmlAttr(a.id)}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;
      }).join('')
      : `<tr><td colspan="7" class="text-center text-muted p-16">No adjustments recorded.</td></tr>`;
  }
}

function advError(msg) {
  const el = advEl('advError');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}

// Picking the advance fills in the place of supply and rate, because an
// adjustment has to be reported on the same terms the advance was.
function onAdvVoucherChange() {
  const v = advVouchers.find(x => x.id === advVal('advVoucher'));
  if (!v) return;
  const set = (id, val) => { const e = advEl(id); if (e) e.value = val == null ? '' : val; };
  set('advAmount', advRemaining(v));
  const info = advEl('advVoucherInfo');
  if (info) {
    info.textContent = `${v.place_of_supply || '—'} · ${v.supply_type === 'interstate' ? 'INTER' : 'INTRA'} · ${v.gst_percentage}% · ${formatCurrency(advRemaining(v))} left`;
  }
}

async function saveAdjustment() {
  advError('');
  const v = advVouchers.find(x => x.id === advVal('advVoucher'));
  if (!v) return advError('Pick the advance being adjusted.');
  const amount = advRound(advVal('advAmount'));
  if (!(amount > 0)) return advError('Enter how much of the advance was applied.');
  // More cannot be adjusted than was ever received.
  const left = advRemaining(v);
  if (amount > left) return advError(`Only ${formatCurrency(left)} of that advance is left to adjust.`);
  const on = advVal('advDate');
  if (!on) return advError('An adjustment needs the date it was applied.');
  if (on < String(v.document_date)) {
    return advError('An advance cannot be adjusted before it was received.');
  }

  const raw = advVal('advInvoice');
  const [table, id] = raw ? raw.split(':') : [null, null];
  const inv = advInvoices.find(r => r.id === id && r.__table === table);

  // The tax follows the advance's own rate and supply type, so a voucher
  // corrected later cannot change a return already filed.
  const pct = parseFloat(v.gst_percentage) || 0;
  const tax = advRound(amount * pct / (100 + pct));   // the advance is tax-inclusive
  const inter = v.supply_type === 'interstate';

  try {
    const { error } = await _supabase.from('advance_adjustments').insert({
      user_id: advUserId,
      receipt_voucher_id: v.id,
      invoice_id: id || null,
      invoice_table: table || null,
      invoice_number: inv ? inv.invoice_number : (advVal('advInvoiceNumber') || null),
      invoice_date: inv ? inv.invoice_date : null,
      adjusted_on: on,
      place_of_supply: v.place_of_supply || '',
      supply_type: v.supply_type || 'intrastate',
      gst_percentage: pct,
      adjusted_amount: amount,
      igst: inter ? tax : 0,
      cgst: inter ? 0 : advRound(tax / 2),
      sgst: inter ? 0 : advRound(tax / 2),
      cess: 0,
      notes: advVal('advNotes') || null
    });
    if (error) throw new Error(error.message);
    ['advAmount', 'advNotes'].forEach(x => { const e = advEl(x); if (e) e.value = ''; });
    await loadAdvances();
    if (typeof showToast === 'function') showToast('Adjustment recorded.', 'success');
  } catch (e) { advError(e.message || String(e)); }
}

async function deleteAdjustment(id) {
  if (!confirm('Remove this adjustment? The advance goes back to being unadjusted.')) return;
  await _supabase.from('advance_adjustments').delete().eq('id', id);
  await loadAdvances();
}
