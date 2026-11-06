// =============================================
// Vouchers and Self Invoices (Phase 2, Module 4B-impl)
// =============================================
// One page for four documents that are not sales invoices: Receipt
// Voucher, Payment Voucher, Refund Voucher and Self Invoice.
//
// The page is driven by the document registry in js/utils.js rather than
// by four hand-written forms. Which fields show, which master the party
// comes from, whether tax is computed at all, whether a number can be
// auto-issued, whether the document can be cancelled — each is read from
// the registry entry for the chosen type. A fifth document type added to
// the registry would render here without this file changing, except for
// the field-shape entry below that says what its form looks like.
//
// Nothing here touches an invoice, a product, a customer record or a
// return. Each document is written to its own domain table.

let vDocs = [];             // documents of the currently selected type
let vSuppliers = [];        // unregistered supplier master
let vCustomers = [];
let vReceiptVouchers = [];  // for the refund voucher's original-document picker
let vSelfInvoices = [];     // for the payment voucher's
let vEditId = null;
let vUserId = null;

// The four types this page edits, and the shape of each one's form.
//
// This is presentation, not GST: the registry already says what each
// document MEANS. What it cannot say is which master the party comes
// from or what the amount field is called, because those are questions
// about a screen. Everything else below is read from the registry.
const VOUCHER_FORMS = {
  receipt_voucher: {
    party: 'customer', partyLabel: 'Customer Name', amountLabel: 'Advance Received',
    table: 'receipt_vouchers', taxed: true, needsPos: true, original: null,
    amountField: 'advance_amount',
    // Section 31(3)(d) requires the voucher for EVERY advance. Whether tax
    // is payable on it is a separate question, and the answer differs by
    // what is being supplied - see voucherSupplyNature().
    blurb: 'An advance received against a supply not yet made. For services, tax is due on receipt; for goods, Notification 66/2017 defers it to the invoice. The turnover arrives later with the invoice either way.'
  },
  payment_voucher: {
    party: 'supplier', partyLabel: 'Supplier Name', amountLabel: 'Amount Paid',
    table: 'payment_vouchers', taxed: false, needsPos: false, original: 'self_invoice',
    amountField: 'amount_paid',
    blurb: 'Records paying a supplier under reverse charge. It creates no liability — the self invoice already did, and counting both would double it.'
  },
  refund_voucher: {
    party: 'customer', partyLabel: 'Customer Name', amountLabel: 'Amount Refunded',
    table: 'refund_vouchers', taxed: true, needsPos: true, original: 'receipt_voucher',
    amountField: 'refund_amount',
    blurb: 'Issued when an advance is returned without a supply being made. It reverses the liability the receipt voucher created — which is why it is not a credit note.'
  },
  self_invoice: {
    party: 'supplier', partyLabel: 'Supplier Name', amountLabel: 'Taxable Value',
    table: 'self_invoices', taxed: true, needsPos: true, original: null,
    amountField: 'taxable_value',
    blurb: 'Raised on yourself for an inward supply under reverse charge. It is not an outward supply, so it appears in no GSTR-1 supply table — only in Documents Issued.'
  }
};

function vType() {
  const v = document.getElementById('vDocType')?.value || 'receipt_voucher';
  return VOUCHER_FORMS[v] ? v : 'receipt_voucher';
}
function vForm() { return VOUCHER_FORMS[vType()]; }
function vSpec() { return gstDocumentTypeSpec(vType()); }

async function initVouchers() {
  // Delegated, so rows added later need no rebinding: `input` for the
  // boxes, `click` for the remove buttons.
  const itemsBody = document.getElementById('vOrderItemsBody');
  if (itemsBody) {
    itemsBody.addEventListener('input', onVoucherOrderItemInput);
    itemsBody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-vi-del]');
      if (btn) removeVoucherOrderItem(+btn.getAttribute('data-vi-del'));
    });
  }
  const addBtn = document.getElementById('vOrderAddRow');
  if (addBtn) addBtn.addEventListener('click', addVoucherOrderItem);
  renderVoucherOrderItems();

  const user = await requireAuth();
  if (!user) return;
  vUserId = user.id;
  initNavUser(user);
  setupLogoutBtn();
  setupMobileMenu();
  await loadUserProfile(user.id);

  // Only the types this page edits, taken from the registry so a type
  // that is not enabled cannot be selected.
  const sel = document.getElementById('vDocType');
  if (sel) sel.innerHTML = Object.keys(VOUCHER_FORMS)
    .filter(k => gstDocumentTypeEnabled(k))
    .map(k => `<option value="${escHtmlAttr(k)}">${escItemHtml(gstDocumentTypeLabel(k))}</option>`).join('');

  const pos = document.getElementById('vPos');
  if (pos) pos.innerHTML = '<option value="">Select state</option>' +
    INDIAN_STATES.map(s => `<option value="${escHtmlAttr(s)}">${escItemHtml(s)}</option>`).join('');
  const rate = document.getElementById('vRate');
  if (rate) rate.innerHTML = GST_RATE_SLABS.map(r => `<option value="${r}"${r === 18 ? ' selected' : ''}>${r}%</option>`).join('');

  await loadVoucherMasters();
  // The quotations an advance can be received against. Loaded once, beside
  // the other masters this page needs.
  await loadVoucherProformas();
  await onVoucherTypeChange();
}

async function loadVoucherMasters() {
  const [sup, cust] = await Promise.all([
    _supabase.from('unregistered_suppliers').select('*').eq('user_id', vUserId),
    _supabase.from('customers').select('*').eq('user_id', vUserId)
  ]);
  vSuppliers = sup.data || [];
  vCustomers = cust.data || [];
}

// ── Type switch ─────────────────────────────────────
// ── An advance actually received, and the quotation it is against ────
//
// A Receipt Voucher is the GST document for money a customer has paid in
// advance; GSTR-1 already reports it in Table 11A. These helpers add the two
// facts a customer's receipt needs - how the money arrived and which
// quotation it was against - and the figure that follows from them.
//
// The balance is worked out from the quotation's stored total and the
// receipts already recorded against it. It is shown here and printed on the
// receipt, and it is never stored: the server recomputes it under a lock
// when the voucher is saved, which is what actually stops two receipts
// jointly overshooting a quotation.
//
// A proforma's own advance_amount is a payment TERM, not money received, and
// is deliberately not read anywhere here.
let vProformas = [], vProformaItems = {}, vLastSaved = null;
// Whether the person deliberately chose a supply classification on this
// form, and what the voucher being edited arrived with. Together they stop
// an inferred classification being written back onto a historical record
// that never carried one.
let vSupplyNatureTouched = false;
let vEditSupplyNature = null;
// The products in a manually entered order. One row per product, because
// an advance against an order of several is not one description - and the
// receipt has to print what the total adds up from.
//
// A row carries an `amount` of its own rather than deriving it from
// quantity x rate: an order line is often a lump sum ("55,000 for the
// machine") with no meaningful quantity, and deriving it would make that
// line zero. Typing a quantity and a rate fills the amount; typing the
// amount directly leaves it alone.
let vOrderItems = [];

// Columns this database cannot store yet, from GET /documents/:type/field-support.
let vPendingColumns = [];

function voucherIsReceipt() { return vType() === 'receipt_voucher'; }

// ── Fields this database cannot store yet ────────────────────────────
//
// The application ships before its migration is run, so between the two a
// column the form fills may not exist. The server drops such a column from
// the write rather than failing the whole save, and reports it - but the
// honest thing is to say so BEFORE someone types into the box, which is what
// this does. Nothing is disabled on a schema that is up to date.
async function loadVoucherFieldSupport() {
  const el = document.getElementById('vMigrationNotice');
  vPendingColumns = [];
  try {
    const res = await apiFetch('/documents/' + vType() + '/field-support');
    vPendingColumns = (res && Array.isArray(res.missing)) ? res.missing : [];
  } catch {
    // A failed probe must not block the form. The server still refuses to
    // write a column it does not have, so nothing is risked by assuming the
    // schema is current here.
    vPendingColumns = [];
  }
  applyVoucherFieldSupport();
  if (el) {
    if (!vPendingColumns.length || !voucherIsReceipt()) {
      el.classList.add('d-none'); el.textContent = '';
    } else {
      el.innerHTML = 'These fields cannot be saved yet: <b>'
        + vPendingColumns.map(c => escItemHtml(c.replace(/_/g, ' '))).join(', ')
        + '</b>. They need the database migration '
        + '<code>migration_receipt_voucher_order.sql</code>, which has not been applied. '
        + 'Everything else on this voucher saves normally; the boxes below are disabled until '
        + 'then so nothing is typed that cannot be kept.';
      el.classList.remove('d-none');
    }
  }
}

// The boxes whose values have nowhere to go are disabled, so the form never
// invites a value it cannot keep.
const VOUCHER_FIELD_INPUTS = {
  supply_nature: 'vSupplyNature',
  party_address: 'vPartyAddress',
  payment_date: 'vPaymentDate',
  // The order's products live in receipt_voucher_items now, so there is no
  // single input to disable for these three. They are still listed - the
  // notice must still name them while the migration is pending - with the
  // table as the control that gets disabled.
  order_quantity: 'vOrderItemsTable',
  order_rate: 'vOrderItemsTable',
  order_amount: 'vOrderItemsTable',
  packing_charge: 'vPackingCharge',
  order_gst_rate: 'vOrderGstRate'
};

function voucherFieldUnsupported(column) {
  return vPendingColumns.indexOf(column) >= 0;
}

function applyVoucherFieldSupport() {
  for (const [column, id] of Object.entries(VOUCHER_FIELD_INPUTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (voucherFieldUnsupported(column)) {
      el.disabled = true;
      el.title = 'Needs migration_receipt_voucher_order.sql';
    } else if (el.title === 'Needs migration_receipt_voucher_order.sql') {
      el.disabled = false;
      el.removeAttribute('title');
    }
  }
}

// ── Is any GST payable on this advance? ───────────────────────────────
//
// Section 31(3)(d) requires a receipt voucher for every advance, and Rule 50
// says what it must contain. Whether TAX is payable on it is a different
// question with two different answers:
//
//   * services - tax is due when the advance is received (Section 13(2)),
//     so the advance carries GST and GSTR-1 Table 11A reports it.
//   * goods    - Notification 66/2017-Central Tax, 15 November 2017, relieved
//     every registered person other than a composition taxpayer from paying
//     tax on an advance for a supply of goods. Tax falls due when the invoice
//     is issued, so the advance carries none.
//
// 'goods' is the default for a NEW receipt because it is both the common case
// and the safe one: it charges no tax that is not yet payable. A composition
// taxpayer is outside the notification, so the control stays visible and a
// business on that scheme can mark the advance as taxable.
// Who the relief is actually available to.
//
// Notification 66/2017-Central Tax reaches "a registered person who did not
// opt for the composition levy". A composition taxpayer is outside it, and
// this file must not decide what IS right for them: their outward tax works
// differently (CMP-08, no GSTR-1 Table 11A), and guessing a treatment would
// be worse than declining to.
//
// The schemes below file GSTR-1/GSTR-3B and make outward supplies, so the
// relief applies. Anything else - ISD, a tax deductor or collector, an
// unconfigured profile - is not refused, but is not given the relief
// automatically either: it is reported as a configuration to confirm and the
// advance is taxed the way it was before this feature existed.
const VOUCHER_ADVANCE_RELIEF_SCHEMES = new Set(['regular', 'casual', 'sez_unit', 'sez_developer']);
const VOUCHER_ADVANCE_RELIEF_EXCLUDED = new Set(['composition']);

function voucherRegistrationType() {
  return String(getCachedProfile()?.registration_type || '').trim().toLowerCase();
}

// 'eligible'    - the goods relief applies
// 'excluded'    - composition: explicitly outside the notification
// 'unknown'     - nothing configured yet
// 'unsupported' - a scheme this rule was not written for
function voucherAdvanceReliefStatus() {
  const t = voucherRegistrationType();
  if (!t) return 'unknown';
  if (VOUCHER_ADVANCE_RELIEF_EXCLUDED.has(t)) return 'excluded';
  if (VOUCHER_ADVANCE_RELIEF_SCHEMES.has(t)) return 'eligible';
  return 'unsupported';
}

function voucherAdvanceReliefApplies() {
  return voucherAdvanceReliefStatus() === 'eligible';
}

// Goods is the default only where the relief is actually available. Where it
// is not, the default is the treatment in force before this feature existed -
// tax on receipt - so an ineligible business is never quietly moved onto a
// relief it cannot claim.
const VOUCHER_SUPPLY_NATURE_DEFAULT = 'goods';
function voucherSupplyNatureDefault() {
  return voucherAdvanceReliefApplies() ? VOUCHER_SUPPLY_NATURE_DEFAULT : 'services';
}

function voucherSupplyNature() {
  if (!voucherIsReceipt()) return 'services';
  const v = (document.getElementById('vSupplyNature')?.value || '').trim().toLowerCase();
  return v === 'services' ? 'services' : 'goods';
}

// A goods advance carries no tax, so the rate and cess boxes have nothing to
// say and are held at zero rather than left showing a figure that is not
// charged. Disabled rather than hidden, so it is visible WHY they are zero.
// The user picked a classification. Recorded as a deliberate choice, which
// is what lets an untouched historical voucher keep its blank one - see
// saveVoucher().
function onVoucherSupplyNaturePicked() {
  vSupplyNatureTouched = true;
  onVoucherSupplyNatureChange();
}

function onVoucherSupplyNatureChange() {
  const goods = voucherSupplyNature() === 'goods';
  const rate = document.getElementById('vRate');
  const cess = document.getElementById('vCess');
  if (voucherIsReceipt()) {
    if (rate) { rate.disabled = goods; if (goods) rate.value = '0'; }
    if (cess) { cess.disabled = goods; if (goods) cess.value = '0'; }
  } else {
    if (rate) rate.disabled = false;
    if (cess) cess.disabled = false;
  }
  const note = document.getElementById('vSupplyNatureNote');
  if (note) {
    const status = voucherAdvanceReliefStatus();
    if (!goods) {
      note.innerHTML = 'GST is charged on this advance and reported as tax paid on it '
        + '(GSTR-1 Table 11A), because tax on an advance for <b>services</b> is due when the '
        + 'money is received (Section 13(2)).';
    } else if (status === 'eligible') {
      note.innerHTML = 'No GST is charged on this advance. Notification 66/2017-Central Tax '
        + 'defers tax on an advance for <b>goods</b> to the invoice, so nothing is reported as '
        + 'tax paid on it. The order\'s own GST is shown above and falls due when you invoice.';
    } else if (status === 'excluded') {
      note.innerHTML = '<b>The goods relief does not apply to you.</b> Notification 66/2017 '
        + 'reaches a registered person who did <i>not</i> opt for the composition levy, and your '
        + 'profile says Composition. GST is charged on this advance as before. What is correct '
        + 'for a composition taxpayer is not decided here &mdash; confirm it with your '
        + 'practitioner before relying on this voucher.';
    } else {
      note.innerHTML = '<b>Your registration type is '
        + (status === 'unknown' ? 'not set' : 'one this rule was not written for')
        + '.</b> The goods relief is not applied automatically, so GST is charged on this advance '
        + 'as before. Set your registration type in Settings, or confirm the treatment with your '
        + 'practitioner.';
    }
  }
  recalcVoucher();
}

// ── The order the advance belongs to ─────────────────────────────────
//
// One place decides this arithmetic, and the screen, the validation and the
// receipt all read it from here - so none of them can disagree with another.
//
// A linked quotation wins: its total is what the customer agreed to, and it
// is read, never written back. With no quotation the boxes on the form supply
// the order, and the taxable value, GST and total are derived from them
// rather than stored, for the reason the balance is not stored.
// One row's amount, in the order the person most likely meant it:
//
//   a typed Amount wins, because a lump sum is a lump sum
//   else quantity x rate, when both are given
//   else the Rate alone, because "55,000" for one machine and
//     "1 x 55,000" are the same order - which is how the single-row
//     version of this form behaved, and there is no reason for a table to
//     be less forgiving than the box it replaced.
function voucherItemAmount(it) {
  const typed = +it.amount;
  if (Number.isFinite(typed) && typed > 0) return round2(typed);
  const q = +it.quantity, r = +it.rate;
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (Number.isFinite(q) && q > 0) return round2(q * r);
  return round2(r);
}

// Draws the rows. Rebuilt wholesale rather than patched, because a table
// that is partly re-rendered is how a row's index stops matching its data.
function renderVoucherOrderItems() {
  const body = document.getElementById('vOrderItemsBody');
  if (!body) return;
  if (!vOrderItems.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">'
      + 'No products yet. Add the products this advance was received against.</td></tr>';
  } else {
    body.innerHTML = vOrderItems.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><input type="text" class="form-control" data-vi="name" data-i="${i}"
                   value="${escItemHtml(it.name || '')}"
                   placeholder="e.g. Steamer 8 Tray with Idly Tray"></td>
        <td><input type="number" class="form-control text-right" data-vi="quantity" data-i="${i}"
                   min="0" step="0.001" value="${it.quantity === '' || it.quantity == null ? '' : it.quantity}"></td>
        <td><input type="number" class="form-control text-right" data-vi="rate" data-i="${i}"
                   min="0" step="0.01" value="${it.rate === '' || it.rate == null ? '' : it.rate}"></td>
        <td><input type="number" class="form-control text-right" data-vi="amount" data-i="${i}"
                   min="0" step="0.01" value="${it.amount === '' || it.amount == null ? '' : it.amount}"></td>
        <td><button type="button" class="btn btn-sm btn-danger" data-vi-del="${i}"
                    title="Remove this product"><i class="fas fa-times"></i></button></td>
      </tr>`).join('');
  }
  const total = document.getElementById('vOrderItemsTotal');
  if (total) {
    total.textContent = formatCurrency(
      round2(vOrderItems.reduce((n, it) => n + voucherItemAmount(it), 0)));
  }
}

function addVoucherOrderItem() {
  vOrderItems.push({ name: '', quantity: '', rate: '', amount: '' });
  renderVoucherOrderItems();
  recalcVoucher();
  // Focus the description of the row just added, so adding three products
  // is three clicks and typing, not three clicks and three more.
  const rows = document.querySelectorAll('#vOrderItemsBody input[data-vi="name"]');
  if (rows.length) rows[rows.length - 1].focus();
}

function removeVoucherOrderItem(index) {
  vOrderItems.splice(index, 1);
  renderVoucherOrderItems();
  recalcVoucher();
}

// Typing in a row updates the model and the totals, but does NOT redraw
// the table: redrawing would take the caret out of the box being typed in.
// The row's own Amount cell is refreshed only when quantity or rate moved
// and no amount was typed, so a lump sum is never overwritten.
function onVoucherOrderItemInput(ev) {
  const el = ev.target;
  const field = el.getAttribute('data-vi');
  if (!field) return;
  const i = +el.getAttribute('data-i');
  if (!vOrderItems[i]) return;
  vOrderItems[i][field] = field === 'name' ? el.value : el.value.trim();

  if (field === 'quantity' || field === 'rate') {
    const typedAmount = String(vOrderItems[i].amount || '').trim();
    if (!typedAmount) {
      const derived = voucherItemAmount(
        Object.assign({}, vOrderItems[i], { amount: '' })) || '';
      const cell = document.querySelector(`#vOrderItemsBody input[data-vi="amount"][data-i="${i}"]`);
      if (cell && document.activeElement !== cell) cell.value = derived === '' ? '' : derived;
    }
  }
  const total = document.getElementById('vOrderItemsTotal');
  if (total) {
    total.textContent = formatCurrency(
      round2(vOrderItems.reduce((n, it) => n + voucherItemAmount(it), 0)));
  }
  recalcVoucher();
}

// The rows as the save route wants them, and as the PDF reads them.
function voucherOrderItemsPayload() {
  return vOrderItems
    .filter((it) => (it.name || '').trim() || voucherItemAmount(it) > 0)
    .map((it, i) => ({
      product_name: (it.name || '').trim() || 'Item ' + (i + 1),
      quantity: it.quantity === '' || it.quantity == null ? null : +it.quantity,
      rate: it.rate === '' || it.rate == null ? null : +it.rate,
      taxable_value: voucherItemAmount(it),
      sort_order: i
    }));
}

function voucherOrderAmounts() {
  const num = (id) => {
    const raw = (document.getElementById(id)?.value || '').trim();
    if (!raw) return 0;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const quoteId = (document.getElementById('vProforma') || {}).value || '';
  const quote = quoteId ? voucherProformaById(quoteId) : null;

  if (quote) {
    // Taken from the quotation as saved. transport_charge is its packing or
    // delivery line, which is why it is read here rather than re-typed.
    const packing = round2(+quote.transport_charge || 0);
    const taxable = round2(+quote.taxable_amount || 0);
    const gst = round2(+quote.gst_amount || 0);
    const total = round2(+quote.total_amount || 0);
    return {
      source: 'quotation',
      quantity: 0,
      amount: round2(taxable - packing),
      packing,
      taxable,
      rate: round2(+quote.gst_percentage || 0),
      gst,
      total
    };
  }

  const quantity = vOrderItems.reduce((n, it) => n + (+it.quantity || 0), 0);
  const rate = 0;
  // Summed from the rows. Each row's own amount is authoritative, for the
  // lump-sum reason in the note on vOrderItems.
  const amount = round2(vOrderItems.reduce((n, it) => n + voucherItemAmount(it), 0));
  const packing = round2(num('vPackingCharge'));
  const taxable = round2(amount + packing);
  const gstRate = round2(+(document.getElementById('vOrderGstRate')?.value) || 0);
  const gst = round2(taxable * gstRate / 100);
  return {
    source: 'manual',
    quantity, amount, packing, taxable,
    rate: gstRate, gst,
    total: round2(taxable + gst)
  };
}

function renderVoucherOrderBox() {
  const o = voucherOrderAmounts();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = '\u20B9' + formatNum(v); };
  set('vOrderAmountOut', o.amount);
  set('vPackingOut', o.packing);
  set('vOrderTaxable', o.taxable);
  set('vOrderGstAmount', o.gst);
  set('vOrderTotal', o.total);
  const rateOut = document.getElementById('vOrderGstRateOut');
  if (rateOut) rateOut.textContent = formatNum(o.rate);

  // With a quotation linked, the order is the quotation's and the boxes
  // would only invite a contradiction, so they are put out of reach.
  const manual = document.getElementById('vOrderManualGrid');
  const fromQuote = o.source === 'quotation';
  vOrderItems = [];
  renderVoucherOrderItems();
  ['vPackingCharge', 'vOrderGstRate'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = fromQuote;
  });
  if (manual) manual.classList.toggle('is-readonly', fromQuote);
}

async function loadVoucherProformas() {
  const sel = document.getElementById('vProforma');
  if (!sel) return;
  const rows = await readAll([
    _supabase.from('proforma_invoices').select('*').eq('user_id', vUserId)
  ], 'Could not load quotations');
  vProformas = (rows && rows[0]) || [];
  // Newest first, and cancelled quotations are not offered: money is not
  // received against an offer that was withdrawn.
  const open = vProformas
    .filter(r => String(r.status || '').toLowerCase() !== 'cancelled')
    .sort((a, b) => String(b.document_date || '').localeCompare(String(a.document_date || '')));
  // Built with the DOM rather than with a string, so a customer name that
  // contains a quote or an angle bracket is text and never markup.
  sel.innerHTML = '';
  sel.add(new Option('— no quotation —', ''));
  for (const r of open) {
    sel.add(new Option(`${r.document_number || ''} — ${r.customer_name || ''}`
      + ` (${formatCurrency(+r.total_amount || 0)})`, r.id));
  }

  // Said out loud: the three reasons the list can be empty need different
  // things done about them, and all three used to look like a selector that
  // simply did nothing when used.
  const note = document.getElementById('vProformaNote');
  if (note) {
    note.textContent = !rows
      ? 'Quotations could not be loaded, so none can be selected.'
      : open.length === 0
        ? (vProformas.length
            ? 'Every quotation is cancelled, so none can be received against.'
            : 'No quotations yet — create one under Proforma Invoice to show its products here.')
        : '';
    note.classList.toggle('d-none', !note.textContent);
  }
}

function voucherProformaById(id) { return vProformas.find(r => r.id === id) || null; }

// What has already been received against a quotation.
//
// The rows come from vDocs, which for this form is the receipt_vouchers
// table itself - loadVouchers() re-reads it after every save, so the figure
// is current without a second request. (The refund voucher's picker list is
// NOT the source: a receipt form never fills it, because receipt_voucher has
// original: null and loadVoucherOriginals returns before loading anything.)
//
// Cancelled receipts are left out, matching proformaRoomLeftOn() in
// routes/documents.js: a cancelled advance is no longer held, so its room
// returns to the quotation. The row stays on the books either way - what
// changes is only whether it still occupies room.
function voucherReceivedAgainst(proformaId, excludeId) {
  const ledger = voucherIsReceipt() ? (vDocs || []) : [];
  return round2(ledger
    .filter(r => r.proforma_invoice_id === proformaId && r.id !== excludeId
      && String(r.status || '') !== 'cancelled')
    .reduce((sum, r) => sum + (+r.advance_amount || 0), 0));
}

// The quotation's own lines, read once per quotation and kept.
// The voucher's own line items, for the manual path. Empty before the
// migration that creates the table - a receipt that prints no item table
// is a poorer receipt, not a broken one.
async function voucherOwnItems(voucherId) {
  if (!voucherId) return [];
  try {
    const { data } = await _supabase.from('receipt_voucher_items')
      .select('*').eq('receipt_voucher_id', voucherId).order('sort_order');
    return data || [];
  } catch {
    return [];
  }
}

async function voucherProformaItems(proformaId) {
  if (!proformaId) return [];
  if (!vProformaItems[proformaId]) {
    const rows = await readAll([
      _supabase.from('proforma_invoice_items').select('*').eq('proforma_invoice_id', proformaId)
    ], 'Could not load the quotation lines');
    if (!rows) return [];
    vProformaItems[proformaId] = (rows[0] || [])
      .slice().sort((a, b) => (+a.sort_order || 0) - (+b.sort_order || 0));
  }
  return vProformaItems[proformaId];
}

// What was quoted, shown beside what is being received. Reference only: the
// receipt acknowledges a payment and is not a tax invoice, so these lines are
// never editable here and no tax is ever computed from them.
async function renderVoucherQuotePanel() {
  const panel = document.getElementById('vQuotePanel');
  if (!panel) return;
  const id = voucherIsReceipt() ? ((document.getElementById('vProforma') || {}).value || '') : '';
  const quote = id ? voucherProformaById(id) : null;
  panel.classList.toggle('d-none', !quote);
  if (!quote) return;

  const row = (k, v) => `<div class="calc-row"><span class="label">${k}</span><span class="value">${v}</span></div>`;
  const summary = document.getElementById('vQuoteSummary');
  if (summary) summary.innerHTML =
    row('Quotation Number', escItemHtml(quote.document_number) || '&mdash;') +
    row('Quotation Date', quote.document_date ? formatDate(quote.document_date) : '&mdash;') +
    row('Customer', escItemHtml(quote.customer_name) || '&mdash;') +
    row('Customer GSTIN', escItemHtml(quote.gst_number) || '&mdash;') +
    row('Place of Supply', escItemHtml(quote.state) || '&mdash;') +
    row('Taxable Value', '₹' + formatNum(quote.taxable_amount)) +
    // The quotation's own tax, as the quotation stored it. Nothing is
    // recomputed from the lines, and none of it is the tax due on the advance
    // - that is the voucher's own figure, in its own box.
    (+quote.igst ? row('IGST', '₹' + formatNum(quote.igst)) : '') +
    (+quote.cgst ? row('CGST', '₹' + formatNum(quote.cgst)) : '') +
    (+quote.sgst ? row('SGST', '₹' + formatNum(quote.sgst)) : '') +
    row('GST', '₹' + formatNum(quote.gst_amount)) +
    `<div class="calc-row total"><span class="label">Grand Total</span><span class="value">₹${formatNum(quote.total_amount)}</span></div>`;

  const items = await voucherProformaItems(quote.id);
  // A different quotation may have been chosen while that read was in flight.
  if (((document.getElementById('vProforma') || {}).value || '') !== quote.id) return;

  const body = document.getElementById('vQuoteItemsBody');
  if (body) body.innerHTML = items.length
    ? items.map((it, i) => `
      <tr>
        <td class="text-center">${i + 1}</td>
        <td>${escItemHtml(it.product_name)}</td>
        <td>${escItemHtml(it.hsn_code) || '&mdash;'}</td>
        <td>${escItemHtml(it.unit) || '&mdash;'}</td>
        <td>${escItemHtml(gstTreatmentLabel(it.gst_treatment))}</td>
        <td class="text-center">${formatNum(it.quantity)}</td>
        <td class="text-right">₹${formatNum(it.rate)}</td>
        <td class="text-center">${(+it.discount_percentage || 0)}%</td>
        <td class="text-center">${(+it.gst_percentage || 0)}%</td>
        <td class="text-right">₹${formatNum(it.total_amount)}</td>
      </tr>`).join('')
    : '<tr><td colspan="10" class="empty-state">This quotation has no line items.</td></tr>';

  const foot = document.getElementById('vQuoteItemsTotal');
  if (foot) foot.innerHTML = `<tr><td colspan="9">GRAND TOTAL (${items.length} ${items.length === 1 ? 'item' : 'items'})</td>
    <td class="text-right">₹${formatNum(quote.total_amount)}</td></tr>`;
}

// The customer the money came from is the customer the quotation was made out
// to, so picking a quotation fills the party in. The fields stay editable:
// the receipt still has to be able to say what actually happened. The amount
// is deliberately untouched - a quotation's advance_amount is a payment TERM,
// and money received is only ever typed in by hand.
function applyQuotationParty(quote) {
  if (!quote) return;
  setVoucherValue('vPartyName', quote.customer_name || '');
  setVoucherValue('vPartyGstin', quote.gst_number || '');
  const pos = document.getElementById('vPos');
  if (pos && quote.state) pos.value = quote.state;
  onVoucherPosChange();
}

function renderVoucherBalance() {
  const box = document.getElementById('vBalanceBox');
  if (!box) return;
  const id = (document.getElementById('vProforma') || {}).value || '';
  const quote = id ? voucherProformaById(id) : null;
  const money = (elId, v) => { const el = document.getElementById(elId); if (el) el.textContent = '\u20B9' + formatNum(v); };

  // The order is the quotation's when one is linked, and the typed one when
  // not - so a receipt against an order with no quotation gets the same
  // summary. Shown as soon as there is an order value to show.
  const order = voucherOrderAmounts();
  const total = round2(order.total);
  box.classList.toggle('d-none', !total);
  const err = document.getElementById('vBalanceError');
  if (!total) { if (err) err.classList.add('d-none'); return; }

  // Only receipts that still stand, and never this one if it is being
  // edited. The quotation's own advance_amount is a payment term rather than
  // money received, so it is not read here. With no quotation there is
  // nothing to have been received earlier against.
  const previous = quote ? voucherReceivedAgainst(quote.id, vEditId || null) : 0;
  // The amount being typed: counted in the preview, saved by nothing.
  const now = round2(parseFloat(voucherFieldValue('vAmount')) || 0);
  const paid = round2(previous + now);
  money('vQuoteTotal', total);
  money('vQuotePrev', previous);
  money('vQuoteNow', now);
  money('vQuotePaid', paid);

  const balance = round2(total - paid);
  const over = balance < 0;
  const balEl = document.getElementById('vQuoteBalance');
  // A negative balance is not a balance: showing one would read as though
  // the overpayment had been accepted.
  if (balEl) balEl.textContent = over ? '\u2014' : '\u20B9' + formatNum(balance);
  if (err) {
    const against = quote
      ? (quote.document_number || 'this quotation')
      : 'this order';
    err.textContent = over
      ? `This receipt is more than the ${formatCurrency(round2(total - previous))} still due on ${against}.`
      : '';
    err.classList.toggle('d-none', !over);
  }

  // What this voucher actually records, said in words next to the figures.
  // The distinction the summary exists to make: the order is what was
  // agreed, and only the advance is money received.
  const note = document.getElementById('vReceivedNote');
  if (note) {
    note.innerHTML = now > 0
      ? `This voucher records <b>${escItemHtml(formatCurrency(now))}</b> actually received. `
        + `The ${escItemHtml(formatCurrency(total))} order value is not money received and is `
        + 'shown for context only.'
      : '';
  }
}

async function onVoucherProformaChange() {
  const id = (document.getElementById('vProforma') || {}).value || '';
  applyQuotationParty(id ? voucherProformaById(id) : null);
  renderVoucherBalance();
  validateVoucherForm();
  await renderVoucherQuotePanel();
}

// What the last save wrote, so the receipt can be printed from exactly that
// rather than from whatever the form holds afterwards.
function showReceiptActions(voucher) {
  vLastSaved = voucher || null;
  for (const id of ['vPrintBtn', 'vPdfBtn']) {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('d-none', !(voucher && voucher.id));
  }
}

async function receiptPdfArgs() {
  if (!vLastSaved) return null;
  const quote = vLastSaved.proforma_invoice_id ? voucherProformaById(vLastSaved.proforma_invoice_id) : null;
  // A voucher raised against a quotation prints that quotation's items; a
  // manual one prints its own. Either way the receipt shows what the total
  // adds up from, rather than one description.
  const items = quote
    ? await voucherProformaItems(quote.id)
    : await voucherOwnItems(vLastSaved.id);
  // What was received BEFORE this voucher, which is what the receipt prints.
  const previous = quote ? voucherReceivedAgainst(quote.id, vLastSaved.id) : 0;
  return { voucher: vLastSaved, quote, items, previous };
}

async function downloadSavedReceipt() {
  const a = await receiptPdfArgs();
  if (!a) { showToast('Save the receipt first.', 'error'); return; }
  try { await downloadReceiptDocument(a.voucher, a.quote, a.items, a.previous); }
  catch (e) { handleApiError(e, 'Could not generate the receipt'); }
}

async function printSavedReceipt() {
  const a = await receiptPdfArgs();
  if (!a) { showToast('Save the receipt first.', 'error'); return; }
  try { await printReceiptDocument(a.voucher, a.quote, a.items, a.previous); }
  catch (e) { handleApiError(e, 'Could not print the receipt'); }
}

async function onVoucherTypeChange() {
  const f = vForm(), spec = vSpec();
  resetVoucherForm(true);

  document.getElementById('vDocTitle').textContent = 'New ' + spec.label;
  document.getElementById('vListTitle').textContent = spec.label + 's';
  document.getElementById('vPartyTitle').textContent =
    f.party === 'supplier' ? 'Supplier Details' : 'Customer Details';
  document.getElementById('vPartyLabel').textContent = f.partyLabel;
  document.getElementById('vAmountLabel').textContent = f.amountLabel;

  // What the registry says about this document, on screen. The user
  // asked for behaviour to follow the registry rather than be re-decided,
  // so the registry's own answers are shown rather than paraphrased.
  const sections = gstDocumentSections(vType()).map(s => `${s.ret} ${s.table}`).join(' &middot; ');
  document.getElementById('vRegistryNote').innerHTML = `
    <div class="calc-row"><span class="label">${escItemHtml(f.blurb)}</span></div>
    <div class="calc-row"><span class="label">Filed in</span><span class="value">${sections || '&mdash;'}</span></div>
    <div class="calc-row"><span class="label">Documents Issued row</span><span class="value">${spec.docNum ?? '&mdash;'} &mdash; ${escItemHtml(spec.portalName)}</span></div>
    <div class="calc-row"><span class="label">Creates a tax liability</span><span class="value">${spec.affectsLiability ? 'Yes' : 'No'}</span></div>
    <div class="calc-row"><span class="label">Counts toward turnover</span><span class="value">${spec.affectsTurnover ? 'Yes' : 'No'}</span></div>
    <div class="calc-row"><span class="label">Feeds the HSN summary</span><span class="value">${spec.affectsHsn ? 'Yes' : 'No'}</span></div>`;

  // Numbering, per the registry rather than per this file.
  const modes = gstDocumentNumberingModes(vType());
  document.getElementById('vNumberModes').textContent =
    modes.length === 2 ? '(auto or typed)' : modes[0] === 'auto' ? '(auto)' : '(typed)';
  const autoBtn = document.getElementById('vAutoNumBtn');
  if (autoBtn) autoBtn.classList.toggle('d-none', !gstDocumentSupportsAutoNumbering(vType()));
  const numEl = document.getElementById('vDocNumber');
  if (numEl) numEl.readOnly = !gstDocumentSupportsManualNumbering(vType());

  // A payment voucher carries no tax at all — the registry says it
  // creates no liability, so the tax fields have nothing to show.
  document.getElementById('vRateGroup').classList.toggle('d-none', !f.taxed);
  document.getElementById('vCessGroup').classList.toggle('d-none', !f.taxed);
  document.getElementById('vTaxBox').classList.toggle('d-none', !f.taxed);
  document.getElementById('vPosGroup').classList.toggle('d-none', !f.needsPos);
  // Money received is a receipt voucher's business only.
  const pay = document.getElementById('vReceiptPayment');
  if (pay) pay.classList.toggle('d-none', !voucherIsReceipt());
  // Rule 50's address, and the question of whether the advance is taxed at
  // all, are a receipt voucher's business only.
  const addrGroup = document.getElementById('vPartyAddressGroup');
  if (addrGroup) addrGroup.classList.toggle('d-none', !voucherIsReceipt());
  const natureGroup = document.getElementById('vSupplyNatureGroup');
  if (natureGroup) natureGroup.classList.toggle('d-none', !voucherIsReceipt());
  onVoucherSupplyNatureChange();
  showReceiptActions(null);
  // Re-read on the way in, so a quotation created since the page opened can
  // be received against without reloading the whole page.
  if (voucherIsReceipt()) await loadVoucherProformas();
  await loadVoucherFieldSupport();
  renderVoucherBalance();
  await renderVoucherQuotePanel();
  document.getElementById('vGstinHint').textContent =
    f.party === 'supplier' ? '(blank if unregistered — which is why this document exists)' : '(optional)';

  await loadVoucherOriginals();
  document.getElementById('vOriginalGroup').classList.toggle('d-none', !f.original);
  if (f.original) {
    document.getElementById('vOriginalLabel').textContent =
      gstDocumentTypeLabel(f.original);
  }

  fillVoucherPartyList();
  await loadVouchers();
}

function fillVoucherPartyList() {
  const list = document.getElementById('vPartyList');
  if (!list) return;
  const rows = vForm().party === 'supplier' ? vSuppliers : vCustomers;
  list.innerHTML = rows.map(r => `<option value="${escHtmlAttr(r.name)}"></option>`).join('');
}

// The party's stored details, filled in without overwriting anything
// already typed — the same only-fill-what-is-empty rule the invoice form
// follows.
function onVoucherPartyInput() {
  const name = (document.getElementById('vPartyName')?.value || '').trim().toLowerCase();
  const rows = vForm().party === 'supplier' ? vSuppliers : vCustomers;
  const match = rows.find(r => (r.name || '').toLowerCase() === name);
  if (match) {
    const g = document.getElementById('vPartyGstin');
    if (g && !g.value && match.gstin) g.value = match.gstin;
    const p = document.getElementById('vPos');
    if (p && !p.value && match.state) p.value = match.state;
    onVoucherPosChange();
  }
  validateVoucherForm();
}

// Place of supply against the business's own state decides whether the
// tax is IGST or CGST+SGST — the same rule invoices follow, read from
// the same helper.
function onVoucherPosChange() { recalcVoucher(); }

async function loadVoucherOriginals() {
  const f = vForm();
  const selEl = document.getElementById('vOriginalRef');
  if (!f.original || !selEl) return;
  if (f.original === 'receipt_voucher') {
    // The picker for "which advance is being returned". An empty list on
    // a failed read says no advance exists to refund against, which is a
    // dead end the user cannot diagnose.
    const rows = await readAll([
      _supabase.from('receipt_vouchers').select('*').eq('user_id', vUserId)
    ], 'Could not load the receipt vouchers');
    if (!rows) return;
    vReceiptVouchers = rows[0].filter(r => r.status !== 'cancelled');
    selEl.innerHTML = '<option value="">Select the advance being returned</option>' +
      vReceiptVouchers.map(r => `<option value="${escHtmlAttr(r.id)}">${escItemHtml(r.document_number)} — ${escItemHtml(r.party_name)} — ₹${formatNum(r.advance_amount)}</option>`).join('');
  } else if (f.original === 'self_invoice') {
    const rows = await readAll([
      _supabase.from('self_invoices').select('*').eq('user_id', vUserId)
    ], 'Could not load the self invoices');
    if (!rows) return;
    vSelfInvoices = rows[0].filter(r => r.status !== 'cancelled');
    selEl.innerHTML = '<option value="">Select the self invoice being settled</option>' +
      vSelfInvoices.map(r => `<option value="${escHtmlAttr(r.id)}">${escItemHtml(r.document_number)} — ${escItemHtml(r.supplier_name)} — ₹${formatNum(r.total_value)}</option>`).join('');
  }
}

function onVoucherOriginalChange() {
  const f = vForm();
  const id = document.getElementById('vOriginalRef')?.value;
  const rows = f.original === 'receipt_voucher' ? vReceiptVouchers : vSelfInvoices;
  const row = rows.find(r => r.id === id);
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = v || ''; };
  set('vOriginalNumber', row?.document_number);
  set('vOriginalDate', row ? String(row.document_date).slice(0, 10) : '');
  if (row) {
    // Carry the party and the rate across: a refund reverses the advance
    // it names, so it reverses it at the rate the advance was taxed at.
    const p = document.getElementById('vPartyName');
    if (p && !p.value) p.value = row.party_name || row.supplier_name || '';
    const pos = document.getElementById('vPos');
    if (pos && !pos.value) pos.value = row.place_of_supply || '';
    const rate = document.getElementById('vRate');
    if (rate && row.gst_percentage != null) rate.value = String(+row.gst_percentage);
  }
  recalcVoucher();
}

// ── Tax ─────────────────────────────────────────────
// One calculation, from the shared calcGST() every other page uses, so a
// voucher's tax cannot drift from an invoice's.
function voucherAmounts() {
  const f = vForm();
  const amount = +(document.getElementById('vAmount')?.value) || 0;
  if (!f.taxed) return { taxable: amount, rate: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: amount };
  // An advance for GOODS carries no tax: Notification 66/2017-Central Tax
  // defers it to the invoice. Forced here rather than only in the UI, so the
  // figure that gets saved and the figure on screen are the same one even if
  // the disabled box still holds an old value.
  // The relief, and only where it is available: a composition taxpayer or an
  // unconfigured profile keeps the previous treatment rather than being given
  // a relief this file cannot establish they are entitled to.
  const goodsAdvance = voucherIsReceipt()
    && voucherSupplyNature() === 'goods'
    && voucherAdvanceReliefApplies();
  const rate = goodsAdvance ? 0 : (+(document.getElementById('vRate')?.value) || 0);
  const cess = goodsAdvance ? 0 : (+(document.getElementById('vCess')?.value) || 0);
  const myState = getCachedProfile()?.state || '';
  const pos = document.getElementById('vPos')?.value || '';
  const supply = pos && myState && pos !== myState ? 'interstate' : 'intrastate';
  const calc = calcGST(amount, rate, supply);
  return { taxable: amount, rate, supply, igst: calc.igst, cgst: calc.cgst, sgst: calc.sgst,
           cess, total: round2(amount + calc.gstAmount + cess) };
}

function recalcVoucher() {
  // The order total, the balance and the tax are all functions of the boxes
  // being typed in, so they follow the same keystrokes.
  renderVoucherOrderBox();
  renderVoucherBalance();
  const a = voucherAmounts();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = '₹' + formatNum(v); };
  set('vTaxable', a.taxable); set('vIgst', a.igst); set('vCgst', a.cgst);
  set('vSgst', a.sgst); set('vCessOut', a.cess); set('vTotal', a.total);
  validateVoucherForm();
}

// ── Validation ──────────────────────────────────────
// Returns { field: message }. The rules a document of this type must
// satisfy, taken from what the registry says it requires.
function voucherFormErrors() {
  const f = vForm(), errors = {};
  const val = id => (document.getElementById(id)?.value || '').trim();
  const number = val('vDocNumber'), date = val('vDocDate'), party = val('vPartyName');
  const gstin = val('vPartyGstin').toUpperCase();
  const amount = +(document.getElementById('vAmount')?.value) || 0;

  if (!number) errors.document_number = 'A document number is required.';
  else if (number.length > 16) errors.document_number = 'A document number cannot exceed 16 characters.';
  if (!date) errors.document_date = 'A document date is required.';
  else if (date > toISO(new Date())) errors.document_date = 'A document cannot be dated in the future.';
  if (!party) errors.party_name = f.partyLabel + ' is required.';
  // A GSTIN is optional on all four, but a wrong one is never acceptable.
  if (gstin && !validateGstin(gstin).valid) errors.party_gstin = 'That GSTIN is not valid.';
  if (f.needsPos && !val('vPos')) errors.place_of_supply = 'Place of supply is required.';
  if (amount <= 0) errors.amount = 'The amount must be greater than zero.';

  // ── The order, and the advance against it ──
  //
  // Only a receipt voucher has an order behind it. These rules are about one
  // thing: the money recorded as received must never exceed what is actually
  // outstanding, because a receipt is a statement that this much changed
  // hands.
  if (voucherIsReceipt()) {
    const o = voucherOrderAmounts();
    const rawRate = '';
    const rawPack = (document.getElementById('vPackingCharge')?.value || '').trim();
    const neg = (s) => s !== '' && parseFloat(s) < 0;
    // Money is typed to two decimals here as everywhere else on this page.
    const overPrecise = (s) => s !== '' && /\.\d{3,}$/.test(s);
    // Each row is checked, so the message names the row rather than
    // leaving the person to find which of five is wrong.
    vOrderItems.forEach((it, i) => {
      for (const [field, label] of [['quantity', 'quantity'], ['rate', 'rate'], ['amount', 'amount']]) {
        const raw = String(it[field] == null ? '' : it[field]).trim();
        if (neg(raw)) errors.order_rate = `Row ${i + 1}: the ${label} cannot be negative.`;
        else if (overPrecise(raw) && field !== 'quantity') {
          errors.order_rate = `Row ${i + 1}: use at most two decimal places.`;
        }
      }
    });
    if (neg(rawRate)) errors.order_rate = 'The product amount cannot be negative.';
    if (neg(rawPack)) errors.packing_charge = 'A packing charge cannot be negative.';
    if (overPrecise(rawRate)) errors.order_rate = 'Use at most two decimal places.';
    if (overPrecise(rawPack)) errors.packing_charge = 'Use at most two decimal places.';

    const quoteId = val('vProforma');
    // Previous advances exist only against a quotation; a typed order has no
    // earlier receipts to find.
    const previous = quoteId ? voucherReceivedAgainst(quoteId, vEditId || null) : 0;
    if (o.total > 0) {
      const outstanding = round2(o.total - previous);
      if (amount > outstanding) {
        errors.amount = previous > 0
          ? `Only ₹${formatNum(outstanding)} is still due on this order — `
            + `₹${formatNum(previous)} has already been received against it.`
          : `This advance is more than the ₹${formatNum(o.total)} order value.`;
      } else if (round2(previous + amount) > o.total) {
        errors.amount =
          `Previous and current advances together cannot exceed the ₹${formatNum(o.total)} order value.`;
      }
    }
    // A payment date is optional, but it cannot be in the future and it
    // cannot precede the quotation it is received against.
    const payDate = val('vPaymentDate');
    if (payDate) {
      if (payDate > toISO(new Date())) errors.payment_date = 'A payment cannot be dated in the future.';
      const quote = quoteId ? voucherProformaById(quoteId) : null;
      if (quote && String(quote.document_date).slice(0, 10) > payDate) {
        errors.payment_date = 'A payment cannot be dated before the quotation it is received against.';
      }
    }
  }

  if (f.original) {
    const ref = val('vOriginalRef');
    if (!ref) {
      errors.original = `A ${gstDocumentTypeLabel(f.original).toLowerCase()} must be named.`;
    } else if (f.original === 'receipt_voucher') {
      // A refund cannot return more than the advance still held.
      const rv = vReceiptVouchers.find(r => r.id === ref);
      if (rv) {
        const available = round2(+rv.advance_amount - (+rv.adjusted_amount || 0));
        if (amount > available) {
          errors.amount = `That advance has ₹${formatNum(available)} left — a refund cannot exceed it.`;
        }
        if (date && String(rv.document_date).slice(0, 10) > date) {
          errors.document_date = 'A refund cannot be dated before the advance it returns.';
        }
      }
    } else if (f.original === 'self_invoice') {
      const si = vSelfInvoices.find(r => r.id === ref);
      if (si && date && String(si.document_date).slice(0, 10) > date) {
        errors.document_date = 'A payment cannot be dated before the self invoice it settles.';
      }
    }
  }
  return errors;
}

function validateVoucherForm() {
  const errors = voucherFormErrors();
  const show = (field, elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (errors[field]) { el.textContent = errors[field]; el.classList.add('show'); }
    else { el.textContent = ''; el.classList.remove('show'); }
  };
  show('document_number', 'vDocNumberError');
  show('document_date', 'vDocDateError');
  show('party_name', 'vPartyNameError');
  show('party_gstin', 'vPartyGstinError');
  show('place_of_supply', 'vPosError');
  show('amount', 'vAmountError');
  show('original', 'vOriginalRefError');
  show('order_rate', 'vOrderItemsError');
  show('packing_charge', 'vPackingChargeError');
  show('payment_date', 'vPaymentDateError');
  const btn = document.getElementById('vSaveBtn');
  if (btn) btn.disabled = Object.keys(errors).length > 0;
  return errors;
}

// ── Numbering ───────────────────────────────────────
// From this document type's own book, never from an invoice counter.
async function reserveVoucherNumber() {
  if (!gstDocumentSupportsAutoNumbering(vType())) return;
  try {
    const res = await apiFetch('/documents/reserve-number', {
      method: 'POST', body: JSON.stringify({ documentType: vType() })
    });
    setVoucherValue('vDocNumber', res.documentNumber);
    validateVoucherForm();
  } catch (e) {
    handleApiError(e, 'Could not issue a number');
  }
}

function setVoucherValue(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }
// The read that matches it. validateVoucherForm() and saveVoucher() each
// declare a local `val` for this, but a top-level function has no such local
// in scope, so the shared one lives here.
function voucherFieldValue(id) { return (document.getElementById(id)?.value || '').trim(); }

// ── Save ────────────────────────────────────────────
async function saveVoucher() {
  if (Object.keys(validateVoucherForm()).length) { showToast('Fix the highlighted fields first.', 'error'); return; }
  const f = vForm(), a = voucherAmounts();
  const val = id => (document.getElementById(id)?.value || '').trim();

  // Only the columns this document's own table has. A payment voucher
  // has no tax columns at all, so none are sent.
  const doc = {
    document_number: val('vDocNumber'),
    document_date: val('vDocDate'),
    document_series: vSpec().series,
    status: 'issued',
    description: val('vDescription'),
    notes: val('vNotes')
  };
  doc[f.amountField] = a.taxable;

  if (f.party === 'supplier') {
    doc.supplier_name = val('vPartyName');
    doc.supplier_gstin = val('vPartyGstin').toUpperCase();
    const s = vSuppliers.find(x => (x.name || '').toLowerCase() === doc.supplier_name.toLowerCase());
    if (s) doc.supplier_id = s.id;
  } else {
    doc.party_name = val('vPartyName');
    doc.party_gstin = val('vPartyGstin').toUpperCase();
    const c = vCustomers.find(x => (x.name || '').toLowerCase() === doc.party_name.toLowerCase());
    if (c) doc.customer_id = c.id;
  }
  if (f.needsPos) { doc.place_of_supply = val('vPos'); doc.supply_type = a.supply || 'intrastate'; }
  if (vType() === 'self_invoice') doc.supplier_state = val('vPos');
  if (f.taxed) {
    doc.gst_percentage = a.rate; doc.igst = a.igst; doc.cgst = a.cgst;
    doc.sgst = a.sgst; doc.cess = a.cess; doc.total_value = a.total;
  }
  if (voucherIsReceipt()) {
    // Judged by the server: the method must be one the payments ledger
    // knows, and the quotation must belong to this business and still have
    // room for this much (routes/documents.js).
    doc.payment_method = val('vPaymentMethod') || null;
    doc.reference_number = val('vReference') || null;
    doc.proforma_invoice_id = val('vProforma') || null;
    doc.payment_date = val('vPaymentDate') || null;
    doc.party_address = val('vPartyAddress') || null;
    // What decided whether this advance carried tax, recorded so the voucher
    // says on its face which rule was applied rather than leaving it to be
    // inferred from a zero rate.
    //
    // Sent only when it is genuinely this voucher's own answer: a NEW voucher,
    // one that already carried a classification, or one where the person
    // deliberately chose a different one. Editing a historical voucher that
    // never recorded a nature, without touching the control, leaves it blank -
    // the form INFERS a treatment in order to display it, and an inference is
    // not a fact to write onto an issued document.
    if (!vEditId || vEditSupplyNature || vSupplyNatureTouched) {
      doc.supply_nature = voucherSupplyNature();
    }

    // The order, stored only when it was typed here. A linked quotation IS
    // the order, and copying its figures onto the receipt would make a second
    // copy that could disagree with it.
    const o = voucherOrderAmounts();
    if (o.source === 'manual') {
      // The summed figures stay on the voucher so a reader of the row -
      // a report, an export - sees the order without having to join the
      // items. The items are the detail; these are the totals they add to.
      doc.order_quantity = o.quantity || null;
      doc.order_rate = null;
      doc.order_amount = o.amount || null;
      doc.packing_charge = o.packing || null;
      doc.order_gst_rate = o.rate || null;
      // The product description belongs with the order, and the receipt
      // already prints `description` as its line, so it is written there
      // rather than into a second column of its own.
      // The description still carries the order in one line, for the
      // places that show a voucher as a single row. Built from the items
      // rather than from a separate box nobody would keep in step.
      if (!doc.description) {
        const names = voucherOrderItemsPayload().map((it) => it.product_name);
        if (names.length) {
          doc.description = names.length === 1
            ? names[0]
            : names[0] + ' and ' + (names.length - 1) + ' more';
        }
      }
    }
  }
  if (f.original) {
    const ref = val('vOriginalRef');
    if (f.original === 'receipt_voucher') doc.receipt_voucher_id = ref;
    else doc.self_invoice_id = ref;
    doc.original_document_number = val('vOriginalNumber');
    doc.original_document_date = val('vOriginalDate') || null;
  }

  try {
    // Items are sent only for a receipt voucher, and only on the manual
    // path: a voucher raised against a quotation reads that quotation's
    // items instead of copying them, so there is nothing of its own to
    // store. Sending [] on that path is deliberate - it clears rows left
    // behind by an edit that switched from manual to a quotation.
    const orderItems = voucherIsReceipt() ? voucherOrderItemsPayload() : null;
    const saved = await apiFetch(`/documents/${vType()}/save`, {
      method: 'POST',
      body: JSON.stringify({ editId: vEditId, document: doc,
        ...(orderItems ? { items: orderItems } : {}) })
    });
    const wasReceipt = voucherIsReceipt();
    // The server drops a column this database does not have yet and names
    // it here. Saying so is the difference between a save and a save that
    // quietly lost a field.
    const dropped = (saved && Array.isArray(saved.unsupported)) ? saved.unsupported : [];
    if (dropped.length) {
      showToast('Saved, but these fields were not stored (migration pending): '
        + dropped.map(c => c.replace(/_/g, ' ')).join(', ') + '.', 'warning');
    } else {
      showToast(vEditId ? 'Document updated.' : 'Document saved.');
    }
    resetVoucherForm();
    await loadVouchers();
    await loadVoucherOriginals();
    // Offered after the save, from the row the server actually wrote - the
    // receipt then prints the stored number, date and amount rather than
    // whatever the cleared form holds.
    if (wasReceipt && saved && saved.document) showReceiptActions(saved.document);
  } catch (e) {
    handleApiError(e, 'Could not save the document');
  }
}

function resetVoucherForm(keepType) {
  vEditId = null;
  ['vDocNumber', 'vPartyName', 'vPartyGstin', 'vDescription', 'vNotes',
   'vOriginalNumber', 'vOriginalDate'].forEach(id => setVoucherValue(id, ''));
  setVoucherValue('vDocDate', toISO(new Date()));
  setVoucherValue('vAmount', 0);
  setVoucherValue('vCess', 0);
  const pos = document.getElementById('vPos'); if (pos) pos.value = getCachedProfile()?.state || '';
  const ref = document.getElementById('vOriginalRef'); if (ref) ref.value = '';
  for (const id of ['vPaymentMethod', 'vReference', 'vProforma', 'vPaymentDate',
    'vPartyAddress', 'vPackingCharge']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  // Back to the default for this registration - the no-tax treatment only
  // where the relief is actually available.
  vSupplyNatureTouched = false;
  vEditSupplyNature = null;
  setVoucherValue('vSupplyNature', voucherSupplyNatureDefault());
  const orderRate = document.getElementById('vOrderGstRate');
  if (orderRate) orderRate.value = '18';
  onVoucherSupplyNatureChange();
  const quotePanel = document.getElementById('vQuotePanel');
  if (quotePanel) quotePanel.classList.add('d-none');
  renderVoucherBalance();
  const badge = document.getElementById('vStatusBadge');
  if (badge) { badge.textContent = 'Issued'; badge.className = 'badge badge-green'; }
  const title = document.getElementById('vDocTitle');
  if (title && !keepType) title.textContent = 'New ' + vSpec().label;
  const btn = document.getElementById('vSaveBtn');
  if (btn) btn.innerHTML = '<i class="fas fa-save"></i> Save Document';
  recalcVoucher();
}

// ── List, edit, cancel, delete ──────────────────────
async function loadVouchers() {
  // Leaves the previous list on screen rather than replacing it with an
  // empty one — this list is also what editVoucher()/cancelVoucher() look
  // documents up in, so emptying it would break those too.
  const rows = await readAll([
    _supabase.from(vForm().table).select('*').eq('user_id', vUserId)
  ], 'Could not load the documents');
  if (!rows) return;
  vDocs = rows[0].sort((a, b) => compareInvoiceNumbers(b.document_number, a.document_number));
  renderVoucherList();
}

function voucherRowAmounts(r) {
  const f = vForm();
  const taxable = +(r[f.amountField]) || 0;
  const tax = round2((+r.igst || 0) + (+r.cgst || 0) + (+r.sgst || 0) + (+r.cess || 0));
  return { taxable, tax, total: +(r.total_value) || taxable };
}

function renderVoucherList() {
  const tbody = document.getElementById('vListBody');
  if (!tbody) return;
  const q = (document.getElementById('vSearch')?.value || '').toLowerCase();
  const status = document.getElementById('vStatusFilter')?.value || '';
  const f = vForm();
  let rows = vDocs;
  if (q) rows = rows.filter(r =>
    (r.document_number || '').toLowerCase().includes(q) ||
    ((r.party_name || r.supplier_name || '')).toLowerCase().includes(q));
  if (status) rows = rows.filter(r => (r.status || 'issued') === status);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No ${escItemHtml(vSpec().label.toLowerCase())}s yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const a = voucherRowAmounts(r);
    const cancelled = (r.status || 'issued') === 'cancelled';
    return `<tr>
      <td>${i + 1}</td>
      <td class="fw-600">${escItemHtml(r.document_number)}</td>
      <td>${escItemHtml(formatDate(r.document_date))}</td>
      <td>${escItemHtml(r.party_name || r.supplier_name || '')}</td>
      <td class="text-right">₹${formatNum(a.taxable)}</td>
      <td class="text-right">${f.taxed ? '₹' + formatNum(a.tax) : '&mdash;'}</td>
      <td class="text-right fw-700">₹${formatNum(a.total)}</td>
      <td>${cancelled
        ? '<span class="badge badge-red">Cancelled</span>'
        : '<span class="badge badge-green">Issued</span>'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editVoucher('${r.id}')" title="Edit"${cancelled ? ' disabled' : ''}><i class="fas fa-edit"></i></button>
          <button class="btn btn-secondary btn-sm btn-icon" onclick="cancelVoucher('${r.id}')" title="Cancel — keeps the number and reports it as cancelled"${cancelled ? ' disabled' : ''}><i class="fas fa-ban"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteVoucher('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function editVoucher(id) {
  const r = vDocs.find(x => x.id === id);
  if (!r) return;
  const f = vForm();
  vEditId = id;
  setVoucherValue('vDocNumber', r.document_number);
  setVoucherValue('vDocDate', String(r.document_date).slice(0, 10));
  setVoucherValue('vPartyName', r.party_name || r.supplier_name || '');
  setVoucherValue('vPartyGstin', r.party_gstin || r.supplier_gstin || '');
  setVoucherValue('vPos', r.place_of_supply || r.supplier_state || '');
  setVoucherValue('vAmount', +(r[f.amountField]) || 0);
  setVoucherValue('vRate', String(+r.gst_percentage || 0));
  setVoucherValue('vCess', +r.cess || 0);
  setVoucherValue('vDescription', r.description || '');
  setVoucherValue('vNotes', r.notes || '');
  if (voucherIsReceipt()) {
    setVoucherValue('vPaymentMethod', r.payment_method || '');
    setVoucherValue('vReference', r.reference_number || '');
    setVoucherValue('vPaymentDate', r.payment_date ? String(r.payment_date).slice(0, 10) : '');
    setVoucherValue('vPartyAddress', r.party_address || '');
    // The order's products, as saved. A voucher from before line items
    // existed has none; its single description and amount become one row,
    // so an old voucher opens showing what it always showed rather than an
    // empty table.
    vOrderItems = [];
    try {
      const { data: rows } = await _supabase.from('receipt_voucher_items')
        .select('*').eq('receipt_voucher_id', r.id).order('sort_order');
      vOrderItems = (rows || []).map((it) => ({
        name: it.product_name || '',
        quantity: it.quantity == null ? '' : +it.quantity,
        rate: it.rate == null ? '' : +it.rate,
        amount: it.taxable_value == null ? '' : +it.taxable_value
      }));
    } catch {
      // The table does not exist until its migration runs. An older
      // voucher still opens; it simply has no rows to show.
      vOrderItems = [];
    }
    if (!vOrderItems.length && (r.description || r.order_amount != null)) {
      vOrderItems = [{
        name: r.description || '',
        quantity: r.order_quantity != null ? +r.order_quantity : '',
        rate: r.order_rate != null ? +r.order_rate : '',
        amount: r.order_amount != null ? +r.order_amount : ''
      }];
    }
    renderVoucherOrderItems();
    setVoucherValue('vPackingCharge', r.packing_charge != null ? +r.packing_charge : '');
    if (r.order_gst_rate != null) setVoucherValue('vOrderGstRate', String(+r.order_gst_rate));

    // A voucher issued before supply_nature existed has no recorded nature,
    // and reopening it must not restate the tax position it was issued with.
    // So the nature is INFERRED from the GST it already carries: a voucher
    // that charged tax was a services advance, one that charged none was
    // not. Without this, opening an old taxed receipt would read as 'goods',
    // zero its GST and quietly change an issued document on the next save.
    //
    // What it ARRIVED with is remembered separately from what is displayed: a
    // blank one stays blank unless the person changes it (see saveVoucher).
    vEditSupplyNature = r.supply_nature || null;
    vSupplyNatureTouched = false;
    const nature = r.supply_nature
      || ((+r.gst_percentage || 0) > 0 ? 'services' : 'goods');
    setVoucherValue('vSupplyNature', nature);
    onVoucherSupplyNatureChange();
    setVoucherValue('vRate', String(+r.gst_percentage || 0));
    setVoucherValue('vCess', +r.cess || 0);
    const quoteSel = document.getElementById('vProforma');
    if (quoteSel && r.proforma_invoice_id) {
      const known = Array.prototype.some.call(quoteSel.options, o => o.value === r.proforma_invoice_id);
      if (!known) {
        const q = voucherProformaById(r.proforma_invoice_id);
        quoteSel.add(new Option(
          (q ? `${q.document_number || ''} — ${q.customer_name || ''}` : 'Quotation no longer listed')
          + ' (cancelled)', r.proforma_invoice_id));
      }
    }
    setVoucherValue('vProforma', r.proforma_invoice_id || '');
    // vEditId is already set, so the balance leaves this receipt out of what
    // was "received earlier" - it is not its own competitor for the room it
    // already occupies.
    renderVoucherBalance();
    renderVoucherQuotePanel();
  }
  if (f.original) {
    setVoucherValue('vOriginalRef', r.receipt_voucher_id || r.self_invoice_id || '');
    setVoucherValue('vOriginalNumber', r.original_document_number || '');
    setVoucherValue('vOriginalDate', r.original_document_date ? String(r.original_document_date).slice(0, 10) : '');
  }
  const badge = document.getElementById('vStatusBadge');
  if (badge) {
    const cancelled = (r.status || 'issued') === 'cancelled';
    badge.textContent = cancelled ? 'Cancelled' : 'Issued';
    badge.className = 'badge ' + (cancelled ? 'badge-red' : 'badge-green');
  }
  document.getElementById('vDocTitle').textContent = 'Edit ' + vSpec().label;
  document.getElementById('vSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Document';
  recalcVoucher();
  document.getElementById('vDocNumber')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Cancelling, not deleting. Table 13 reports how many documents a series
// issued AND how many were cancelled, and a deleted document can be
// counted in neither — so the row and its number stay.
async function cancelVoucher(id) {
  if (!gstDocumentSupportsCancellation(vType())) {
    showToast(`A ${vSpec().label.toLowerCase()} cannot be cancelled.`, 'error');
    return;
  }
  const r = vDocs.find(x => x.id === id);
  if (!r) return;
  const ok = await showYesNo(
    `Cancel "${r.document_number}"?\n\n` +
    'It keeps its number and stays on the books. Documents Issued will report it as cancelled, ' +
    'which is what a cancelled document is for — deleting it would report nothing at all.' +
    '\n\nContinue?', 'Cancel Document');
  if (!ok) return;
  try {
    await apiFetch(`/documents/${vType()}/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: '' }) });
    showToast('Document cancelled.');
    await loadVouchers();
    await loadVoucherOriginals();
    // That receipt no longer occupies room on its quotation.
    renderVoucherBalance();
  } catch (e) {
    handleApiError(e, 'Could not cancel the document');
  }
}

// Deletion is for a mistake caught immediately. The server refuses it
// where another document points at this one.
async function deleteVoucher(id) {
  const r = vDocs.find(x => x.id === id);
  if (!r) return;
  const ok = await showYesNo(
    `Permanently delete "${r.document_number}"?\n\n` +
    'Nothing will record that this number was ever issued. If the document was issued and is being ' +
    'withdrawn, CANCEL it instead so Documents Issued can report it.\n\nDelete anyway?',
    'Delete Document');
  if (!ok) return;
  try {
    await apiFetch(`/documents/${vType()}/${id}`, { method: 'DELETE' });
    showToast('Document deleted.');
    if (vEditId === id) resetVoucherForm();
    await loadVouchers();
    // A deleted receipt frees its room too.
    renderVoucherBalance();
    await loadVoucherOriginals();
  } catch (e) {
    handleApiError(e, 'Could not delete the document');
  }
}
