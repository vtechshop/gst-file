// =============================================
// Warranty register synchronisation
// =============================================
// Runs INSIDE the invoice save transaction, after the line items are written
// and before the commit. That ordering is the whole point: a warranty can
// only exist for an invoice that actually committed, and a warranty number
// drawn here rolls back with the invoice rather than leaving a hole in the
// book.
//
// It is a SYNC, not an insert. Saving the same invoice twice, refreshing
// after a save, or a retried request must leave the register in the same
// state, so every run reconciles what the invoice now says against what the
// register already holds.
//
// The hard part is identity. save-with-items DELETEs and re-INSERTs every
// line, so invoice_item_id is a different UUID after each save and cannot be
// what a warranty is matched on - matching on it would mint a fresh record
// on every edit. A line is therefore identified by the PRODUCT it sells,
// with its position used only to tell two lines of the same product apart.
// invoice_item_id is still stored and refreshed, because it is what the
// database's unique index uses as a last-resort backstop.
//
// Nothing here touches a total, a tax column, stock, a payment or an invoice
// number. A warranty is a promise about goods already sold.

// What identifies a line across saves. product_id when the line came from
// the catalogue; otherwise the typed name, which is all a free-text line has.
function lineKey(row) {
  return row.product_id
    ? 'id:' + row.product_id
    : 'name:' + String(row.product_name || '').trim().toLowerCase();
}

// Set when this module cancels a warranty because the invoice stopped
// offering cover. Distinct from a person cancelling one in the register, so
// re-adding the warranty can revive it without overriding a human decision.
const AUTO_CANCEL_REASON = 'Warranty removed from the invoice line';

function monthsOf(v) {
  const n = parseInt(v, 10);
  return n > 0 ? n : null;
}

// Start + N months, minus a day, with a month-end anniversary clamped to the
// month end. Mirrors warrantyUntil() in client/js/utilities/utils.js - the
// two must agree, because the invoice PDF prints one and the register the
// other.
function warrantyUntilFrom(startISO, months) {
  const n = monthsOf(months);
  if (!startISO || !n) return null;
  const s = String(startISO).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const target = new Date(Date.UTC(y, mo + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  if (d > lastDay) target.setUTCDate(lastDay);
  else { target.setUTCDate(d); target.setUTCDate(target.getUTCDate() - 1); }
  return target.toISOString().slice(0, 10);
}

/**
 * Reconcile the warranty register against one saved invoice.
 *
 * @param client   the transaction's client - NOT a fresh connection
 * @param userId   from the verified JWT, never from the request body
 * @param type     'b2b' | 'b2c'
 * @param invoiceId
 * @param header   the invoice header as saved
 * @param items    the line rows as just inserted, each with its new id
 * @param reserveNumber  (client, userId, 'warranty') => { documentNumber }
 * @returns { created: [numbers], updated: n, cancelled: n }
 */
async function syncWarrantiesForInvoice(client, userId, type, invoiceId, header, items, reserveNumber) {
  const { rows: existing } = await client.query(
    `SELECT id, invoice_item_id, product_id, product_name, serial_number, status, cancel_reason
       FROM warranties
      WHERE user_id = $1 AND invoice_type = $2 AND invoice_id = $3
        AND invoice_item_id IS NOT NULL
      ORDER BY warranty_number`,
    [userId, type, invoiceId]);

  const covered = items
    .map((it, i) => ({ ...it, sort_order: i }))
    .filter(it => monthsOf(it.warranty_period_months));

  // Match by product, then by position among lines of that same product, so
  // an invoice selling the same item twice keeps two distinct warranties and
  // deleting a line above does not re-point a warranty at another product.
  const pool = new Map();
  existing.forEach(w => {
    const k = lineKey(w);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(w);
  });
  const claimed = new Set();
  const takeMatch = (it) => {
    const bucket = pool.get(lineKey(it)) || [];
    const free = bucket.find(w => !claimed.has(w.id));
    if (free) claimed.add(free.id);
    return free || null;
  };

  const startDate = header.warranty_start_date
    ? String(header.warranty_start_date).slice(0, 10)
    : (header.invoice_date ? String(header.invoice_date).slice(0, 10) : null);

  const created = [];
  let updated = 0;

  for (const it of covered) {
    const months = monthsOf(it.warranty_period_months);
    const until = warrantyUntilFrom(startDate, months);
    const match = takeMatch(it);

    if (match) {
      // Reviving a warranty this module cancelled is right; overriding a
      // cancellation a person made in the register is not.
      const revive = match.status === 'cancelled' && match.cancel_reason === AUTO_CANCEL_REASON;
      await client.query(
        `UPDATE warranties SET
           invoice_item_id = $1, invoice_number = $2, invoice_date = $3,
           customer_name = $4, customer_phone = $5,
           product_id = $6, product_name = $7, product_sku = $8,
           quantity = $9, rate = $10, purchase_amount = $11, purchase_date = $12,
           warranty_period_months = $13, warranty_start_date = $14,
           warranty_until = $15, warranty_terms = $16,
           status = CASE WHEN $17::boolean THEN 'active' ELSE status END,
           cancelled_at = CASE WHEN $17::boolean THEN NULL ELSE cancelled_at END,
           cancel_reason = CASE WHEN $17::boolean THEN NULL ELSE cancel_reason END
         WHERE id = $18 AND user_id = $19`,
        [it.id, header.invoice_number || null, header.invoice_date || null,
         header.customer_name || '', header.phone || null,
         it.product_id || null, it.product_name || '', it.hsn_code || null,
         +it.quantity || 1, +it.rate || 0, +it.total_amount || 0, header.invoice_date || null,
         months, startDate, until, header.warranty_terms || null,
         revive, match.id, userId]);
      updated++;
      continue;
    }

    // New cover on this line. The number is drawn on THIS client, so it is
    // part of the invoice's own transaction.
    const { documentNumber } = await reserveNumber(client, userId, 'warranty');
    await client.query(
      `INSERT INTO warranties
         (user_id, warranty_number, document_series, invoice_id, invoice_type, invoice_item_id,
          invoice_number, invoice_date, customer_id, customer_name, customer_phone,
          product_id, product_name, product_sku, serial_number,
          quantity, rate, purchase_amount, purchase_date,
          warranty_period_months, warranty_start_date, warranty_until, warranty_terms, status)
       VALUES ($1,$2,'warranty',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,$16,$17,$18,$19,$20,$21,'active')`,
      [userId, documentNumber, invoiceId, type, it.id,
       header.invoice_number || null, header.invoice_date || null,
       header.customer_id || null, header.customer_name || '', header.phone || null,
       it.product_id || null, it.product_name || '', it.hsn_code || null,
       +it.quantity || 1, +it.rate || 0, +it.total_amount || 0, header.invoice_date || null,
       months, startDate, until, header.warranty_terms || null]);
    created.push(documentNumber);
  }

  // Whatever the invoice no longer covers. Cancelled, never deleted: a tag
  // may already be on the goods, and a QR that 404s tells the customer
  // nothing, where one reporting CANCELLED tells them exactly where they
  // stand. The number stays spent, so history reads truthfully.
  let cancelled = 0;
  for (const w of existing) {
    if (claimed.has(w.id) || w.status === 'cancelled') continue;
    await client.query(
      `UPDATE warranties
          SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1
        WHERE id = $2 AND user_id = $3`,
      [AUTO_CANCEL_REASON, w.id, userId]);
    cancelled++;
  }

  return { created, updated, cancelled };
}

module.exports = { syncWarrantiesForInvoice, warrantyUntilFrom, AUTO_CANCEL_REASON };
