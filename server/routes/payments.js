// Bespoke transactional endpoint for the Payments ledger — same reason
// invoices.js/purchases.js have their own bespoke endpoints instead of
// using the generic router: recording (or removing) a payment has to
// both write the payments ledger row AND recompute the invoice header's
// cached payment_status/amount_paid, and those two writes must succeed
// or fail together. js/payments.js used to do this as two separate
// client-driven REST calls (INSERT into payments, then a separate PATCH
// to the invoice header) — if the second call failed after the first
// succeeded (network drop, tab closed, timeout), the ledger and the
// invoice's cached totals could drift out of sync, self-healing only
// the next time a payment was added/removed on that same invoice. This
// wraps both writes in one Postgres transaction so that can't happen.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

function invoiceTable(type) { return type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices'; }
function badType(type) {
  if (type !== 'b2b' && type !== 'b2c') { const e = new Error('type must be b2b or b2c.'); e.status = 400; e.expose = true; throw e; }
}
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// Recomputes payment_status/amount_paid from the full ledger (run INSIDE
// the same transaction, after the ledger write, using the SAME client so
// it sees that write) and applies it to the invoice header — the one
// place both fields are ever computed, same invariant js/payments.js's
// comment already documented client-side.
async function recomputeAndApply(client, userId, type, invoiceId) {
  const table = invoiceTable(type);
  const { rows: invRows } = await client.query(
    `SELECT total_amount FROM ${table} WHERE id = $1 AND user_id = $2`, [invoiceId, userId]
  );
  if (!invRows.length) { const e = new Error('Invoice not found.'); e.status = 404; e.expose = true; throw e; }
  const total = +invRows[0].total_amount || 0;

  const { rows: payRows } = await client.query(
    'SELECT amount FROM payments WHERE invoice_id = $1 AND invoice_type = $2 AND user_id = $3',
    [invoiceId, type, userId]
  );
  const paid = round2(payRows.reduce((s, p) => s + (+p.amount || 0), 0));
  const status = paid <= 0 ? 'unpaid' : (paid + 0.005 >= total ? 'paid' : 'partial');

  await client.query(
    `UPDATE ${table} SET payment_status = $1, amount_paid = $2 WHERE id = $3 AND user_id = $4`,
    [status, paid, invoiceId, userId]
  );
  return { paid, status, total, balance: round2(Math.max(0, total - paid)) };
}

router.post('/:type/:invoiceId/record', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const { type, invoiceId } = req.params;
  const amount = +req.body.amount || 0;
  if (amount <= 0) { const e = new Error('Enter an amount greater than zero.'); e.status = 400; e.expose = true; throw e; }
  const method = req.body.method || 'cash';
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const note = req.body.note || '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO payments (user_id, invoice_id, invoice_type, amount, method, payment_date, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.userId, invoiceId, type, amount, method, date, note]
    );
    const summary = await recomputeAndApply(client, req.userId, type, invoiceId);
    await client.query('COMMIT');
    res.json(summary);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:type/:invoiceId/:paymentId/delete', asyncRoute(async (req, res) => {
  badType(req.params.type);
  const { type, invoiceId, paymentId } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM payments WHERE id = $1 AND user_id = $2', [paymentId, req.userId]);
    const summary = await recomputeAndApply(client, req.userId, type, invoiceId);
    await client.query('COMMIT');
    res.json(summary);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
