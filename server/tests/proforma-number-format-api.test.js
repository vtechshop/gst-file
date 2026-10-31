// Configuring the Proforma Number format, through the real HTTP surface and
// against a real database.
//
// The browser half is in proforma-number-format.test.js. These are the
// questions only a database can answer: does the format persist, does the very
// next number use it, are numbers already issued left alone, and is the
// invoice side genuinely untouched.
//
// Skipped unless STOCK_TEST_DATABASE_URL names a DISPOSABLE database.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRATCH = process.env.STOCK_TEST_DATABASE_URL;
if (!SCRATCH) {
  test('proforma number format API (skipped)',
    { skip: 'STOCK_TEST_DATABASE_URL is not set' }, () => {});
  return;
}
process.env.DATABASE_URL = SCRATCH;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proforma-format-secret';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const net = require('net');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function startServer(port) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: SCRATCH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const done = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 40000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(done); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(done); reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

let server, base, db, USER, TOKEN;
const tok = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function req(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? { authorization: 'Bearer ' + TOKEN }
        : token ? { authorization: 'Bearer ' + token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}
const get = (url, token) => req('GET', url, undefined, token);
const patch = (url, body, token) => req('PATCH', url, body, token);
const post = (url, body, token) => req('POST', url, body, token);
const msg = (r) => (r && r.body && r.body.error && r.body.error.message) || '';

const doc = (extra) => ({
  document_date: '2026-10-31', customer_name: 'Format Co', status: 'draft',
  taxable_amount: 100, gst_amount: 18, total_amount: 118, ...(extra || {})
});
const ITEMS = [{
  product_name: 'Widget', quantity: 1, rate: 100, taxable_value: 100,
  gst_percentage: 18, gst_amount: 18, total_amount: 118, sort_order: 0
}];
const save = (body, token) => post('/documents/proforma_invoice/save', body, token);
const preview = (token) => get('/documents/proforma_invoice/next-number', token);
// What the Settings screen does when Save is pressed.
const setFormat = (formats, token) => patch('/profiles', { document_series_formats: formats }, token);

const profileRow = async (id) => (await db.query(
  `SELECT document_series_formats, document_series_sequences,
          invoice_number_format, invoice_current_sequence,
          invoice_series_formats, invoice_series_sequences
     FROM profiles WHERE id = $1`, [id || USER])).rows[0];
const numbersOf = async (id) => (await db.query(
  'SELECT document_number FROM proforma_invoices WHERE user_id=$1 ORDER BY created_at',
  [id || USER])).rows.map((r) => r.document_number);

async function freshUser(email) {
  const id = (await db.query(
    'INSERT INTO users (email,password_hash) VALUES ($1,$2) RETURNING id',
    [email, 'x'])).rows[0].id;
  // The invoice columns get real values, so a later assertion that they are
  // unchanged is comparing against something rather than against NULL.
  await db.query(
    `INSERT INTO profiles (id,name,invoice_number_format,invoice_current_sequence,
                           invoice_series_formats,invoice_series_sequences)
     VALUES ($1,'Scratch Co','INV-###',7,'{"online":"W-#####"}'::jsonb,'{"online":3}'::jsonb)`,
    [id]);
  return id;
}

test.before(async () => {
  db = new Client({ connectionString: SCRATCH });
  await db.connect();
  await db.query('TRUNCATE users CASCADE');
  USER = await freshUser('pfformat@scratch.test');
  TOKEN = tok(USER);
  const port = await freePort();
  server = await startServer(port);
  base = 'http://127.0.0.1:' + port + '/api';
});

test.after(async () => {
  if (server) server.kill();
  if (db) { await db.query('TRUNCATE users CASCADE'); await db.end(); }
});

// ═══ The default ══════════════════════════════════════════════════════

test('G1 with nothing configured, the book defaults to PI-#####', async () => {
  const p = await preview();
  assert.strictEqual(p.status, 200, msg(p));
  assert.strictEqual(p.body.format, 'PI-#####');
  assert.strictEqual(p.body.documentNumber, 'PI-00001');
  assert.strictEqual(p.body.seq, 1);
  // And nothing is stored for it yet - the default is the server's, not a row.
  const row = await profileRow();
  assert.deepStrictEqual(row.document_series_formats, {});
});

test('G2 the default is what an automatic save actually issues', async () => {
  const r = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, 'PI-00001');
});

// ═══ Saving a format ══════════════════════════════════════════════════

test('G3 a new format persists through the profile API', async () => {
  const r = await setFormat({ proforma_invoice: 'QT/2026/###' });
  assert.strictEqual(r.status, 200, msg(r));
  const row = await profileRow();
  assert.deepStrictEqual(row.document_series_formats, { proforma_invoice: 'QT/2026/###' });
});

test('G4 reopening the settings reads the saved format back', async () => {
  // fetchProformaNumbering() does exactly this call.
  const p = await preview();
  assert.strictEqual(p.body.format, 'QT/2026/###',
    'the modal must show what was saved, not the default');
});

test('G5 the Auto preview reflects the new format immediately', async () => {
  const p = await preview();
  // One proforma exists (PI-00001), issued under the old format. The new
  // book's own run starts at 2 because the counter moved, and the preview
  // shows the NEW format applied to it.
  assert.strictEqual(p.body.documentNumber, 'QT/2026/' + String(p.body.seq).padStart(3, '0'));
  assert.match(p.body.documentNumber, /^QT\/2026\/\d{3}$/);
});

test('G6 the next automatic save issues a number in the new format', async () => {
  const before = await preview();
  const r = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, before.body.documentNumber,
    'the preview was honest about what the save would take');
  assert.match(r.body.document.document_number, /^QT\/2026\/\d{3}$/);
});

test('G7 a format with no # still issues usable numbers', async () => {
  const r = await setFormat({ proforma_invoice: 'QUOTE' });
  assert.strictEqual(r.status, 200, msg(r));
  const saved = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(saved.status, 200, msg(saved));
  // applyInvoiceNumberFormat's documented #-free branch: <format>-<n>.
  assert.match(saved.body.document.document_number, /^QUOTE-\d+$/);
});

// ═══ Nothing already issued is rewritten ══════════════════════════════

test('G8 changing the format never rewrites a number already issued', async () => {
  const before = await numbersOf();
  assert.ok(before.length >= 3, 'there are numbers from three different formats by now');
  await setFormat({ proforma_invoice: 'PI-#####' });
  await setFormat({ proforma_invoice: 'ZZ-###' });
  const after = await numbersOf();
  assert.deepStrictEqual(after, before,
    'every stored document_number must be byte-identical after two format changes');
});

test('G9 editing an existing proforma keeps its number under a new format', async () => {
  await setFormat({ proforma_invoice: 'PI-#####' });
  const created = await save({ document: doc(), items: ITEMS });
  const id = created.body.document.id;
  const number = created.body.document.document_number;

  await setFormat({ proforma_invoice: 'NEW-###' });
  // The page sends no document_number on Automatic, which is what leaves the
  // stored one alone.
  const edited = await save({ editId: id, document: doc({ notes: 'edited' }), items: ITEMS });
  assert.strictEqual(edited.status, 200, msg(edited));
  assert.strictEqual(edited.body.document.document_number, number,
    'a saved quotation keeps the number it was issued');
});

test('G10 a manually typed number is stored as typed, whatever the format says', async () => {
  await setFormat({ proforma_invoice: 'PI-#####' });
  const r = await save({ document: doc({ document_number: 'LEGACY/2026/0918' }), items: ITEMS });
  assert.strictEqual(r.status, 200, msg(r));
  assert.strictEqual(r.body.document.document_number, 'LEGACY/2026/0918');

  // And a later format change leaves it exactly as it is.
  await setFormat({ proforma_invoice: 'XX-####' });
  const { rows } = await db.query(
    'SELECT document_number FROM proforma_invoices WHERE id=$1', [r.body.document.id]);
  assert.strictEqual(rows[0].document_number, 'LEGACY/2026/0918');
});

// ═══ Validation at the API ════════════════════════════════════════════

test('G11 an invalid format is refused by the API, and nothing is stored', async () => {
  const before = (await profileRow()).document_series_formats;
  for (const bad of ['', '   ', 'PI-###/###', 'a#b#c', 'x'.repeat(41)]) {
    const r = await setFormat({ proforma_invoice: bad });
    assert.strictEqual(r.status, 400, 'expected 400 for ' + JSON.stringify(bad));
    assert.match(msg(r) + JSON.stringify(r.body), /proforma_invoice/,
      'the message must name the book that was wrong');
  }
  assert.deepStrictEqual((await profileRow()).document_series_formats, before,
    'a refused format must leave the stored one untouched');
});

test('G12 a non-object document_series_formats is refused', async () => {
  for (const junk of ['PI-#####', 42, []]) {
    const r = await patch('/profiles', { document_series_formats: junk });
    assert.strictEqual(r.status, 400, JSON.stringify(junk) + ' must be refused');
  }
});

test('G13 ownership is enforced - a format is written only to the caller profile', async () => {
  const other = await freshUser('pfformat-other@scratch.test');
  // The generic router forces id = req.userId, so even an explicit id in the
  // body cannot redirect the write.
  const r = await patch('/profiles', {
    id: other, document_series_formats: { proforma_invoice: 'HACK-###' }
  });
  assert.strictEqual(r.status, 200, msg(r));
  assert.deepStrictEqual((await profileRow(other)).document_series_formats, {},
    "another tenant's format must be untouched");
  assert.deepStrictEqual((await profileRow()).document_series_formats,
    { proforma_invoice: 'HACK-###' }, "the caller's own format is what changed");
  // Unauthenticated writes are refused outright.
  const anon = await patch('/profiles', { document_series_formats: { proforma_invoice: 'NO-###' } }, null);
  assert.strictEqual(anon.status, 401);
});

test('G14 each business numbers from its own format', async () => {
  const other = await freshUser('pfformat-tenant2@scratch.test');
  const otherToken = tok(other);
  await setFormat({ proforma_invoice: 'AAA-###' }, TOKEN);
  await setFormat({ proforma_invoice: 'BBB-###' }, otherToken);
  const mine = await save({ document: doc(), items: ITEMS }, TOKEN);
  const theirs = await save({ document: doc(), items: ITEMS }, otherToken);
  assert.match(mine.body.document.document_number, /^AAA-\d{3}$/);
  assert.strictEqual(theirs.body.document.document_number, 'BBB-001',
    "a second business starts at 1 in its own book, with its own format");
});

// ═══ Invoice numbering is untouched ═══════════════════════════════════

test('G15 writing a proforma format changes no invoice column', async () => {
  const before = await profileRow();
  const r = await setFormat({ proforma_invoice: 'PI-#####' });
  assert.strictEqual(r.status, 200, msg(r));
  const after = await profileRow();
  assert.strictEqual(after.invoice_number_format, before.invoice_number_format);
  assert.strictEqual(after.invoice_current_sequence, before.invoice_current_sequence);
  assert.deepStrictEqual(after.invoice_series_formats, before.invoice_series_formats);
  assert.deepStrictEqual(after.invoice_series_sequences, before.invoice_series_sequences);
  // Still the values seeded for this profile, so the comparison meant something.
  assert.strictEqual(after.invoice_number_format, 'INV-###');
  assert.deepStrictEqual(after.invoice_series_formats, { online: 'W-#####' });
});

test('G16 writing an invoice format changes no document column', async () => {
  const before = await profileRow();
  const r = await patch('/profiles', {
    invoice_number_format: 'BILL-####',
    invoice_series_formats: { online: 'WEB-#####' }
  });
  assert.strictEqual(r.status, 200, msg(r));
  const after = await profileRow();
  assert.deepStrictEqual(after.document_series_formats, before.document_series_formats,
    'the proforma format must be untouched by an invoice format change');
  assert.deepStrictEqual(after.document_series_sequences, before.document_series_sequences);
  assert.strictEqual(after.invoice_number_format, 'BILL-####', 'the invoice write did happen');
});

test('G17 the invoice number preview is unaffected by the proforma format', async () => {
  await setFormat({ proforma_invoice: 'PI-#####' });
  const inv = await get('/invoices/next-number?source=offline');
  assert.strictEqual(inv.status, 200, msg(inv));
  // It follows the invoice format set in G16, never the proforma one.
  assert.match(inv.body.invoiceNumber, /^BILL-\d{4}$/);
  assert.strictEqual(/^PI-/.test(inv.body.invoiceNumber), false);
});

test('G18 another document book keeps its own format when the proforma one is saved', async () => {
  // The Settings save merges rather than replaces, so a challan's format is
  // not collateral damage.
  await patch('/profiles', {
    document_series_formats: { proforma_invoice: 'PI-#####', dc_job_work: 'JW/2026/###' }
  });
  const r = await setFormat({ proforma_invoice: 'PQ-###', dc_job_work: 'JW/2026/###' });
  assert.strictEqual(r.status, 200, msg(r));
  const stored = (await profileRow()).document_series_formats;
  assert.strictEqual(stored.dc_job_work, 'JW/2026/###', "the challan book's format survived");
  assert.strictEqual(stored.proforma_invoice, 'PQ-###');
});

// ═══ The guarantees the format change must not break ══════════════════

test('G19 a format change moves no counter', async () => {
  const before = (await profileRow()).document_series_sequences;
  await setFormat({ proforma_invoice: 'KEEP-###' });
  await setFormat({ proforma_invoice: 'PI-#####' });
  assert.deepStrictEqual((await profileRow()).document_series_sequences, before,
    'only issuing a number may move the counter');
});

test('G20 previewing under a new format consumes nothing', async () => {
  await setFormat({ proforma_invoice: 'PV-####' });
  const before = (await profileRow()).document_series_sequences;
  const countBefore = (await numbersOf()).length;
  for (let i = 0; i < 5; i++) {
    const p = await preview();
    assert.match(p.body.documentNumber, /^PV-\d{4}$/);
  }
  assert.deepStrictEqual((await profileRow()).document_series_sequences, before);
  assert.strictEqual((await numbersOf()).length, countBefore);
});

test('G21 a failed save under a custom format burns no number', async () => {
  await setFormat({ proforma_invoice: 'FAIL-####' });
  const seqBefore = (await profileRow()).document_series_sequences.proforma_invoice;
  const countBefore = (await numbersOf()).length;

  // An item the database cannot accept: the number is issued, then the
  // transaction rolls back.
  const r = await save({ document: doc(), items: [{ ...ITEMS[0], quantity: 'not-a-number' }] });
  assert.ok(r.status >= 400, 'the save must fail, got ' + r.status);
  assert.strictEqual((await numbersOf()).length, countBefore, 'nothing was written');
  assert.strictEqual((await profileRow()).document_series_sequences.proforma_invoice, seqBefore,
    'and the counter did not move');

  // The next good save takes the number the failed one nearly had.
  const ok = await save({ document: doc(), items: ITEMS });
  assert.strictEqual(ok.body.document.document_number,
    'FAIL-' + String(seqBefore).padStart(4, '0'));
});

test('G22 duplicate protection still applies under a custom format', async () => {
  await setFormat({ proforma_invoice: 'DUP-###' });
  const first = await save({ document: doc({ document_number: 'DUP-500' }), items: ITEMS });
  assert.strictEqual(first.status, 200, msg(first));
  const again = await save({ document: doc({ document_number: 'DUP-500' }), items: ITEMS });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(msg(again), 'Proforma number already exists.');
  // Case-insensitively, as the automatic side compares.
  const lower = await save({ document: doc({ document_number: 'dup-500' }), items: ITEMS });
  assert.strictEqual(lower.status, 409);
});

test('G23 concurrent automatic saves under a custom format still get distinct numbers', async () => {
  const fresh = await freshUser('pfformat-race@scratch.test');
  const token = tok(fresh);
  await setFormat({ proforma_invoice: 'RACE/###' }, token);
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () => save({ document: doc(), items: ITEMS }, token)));

  const ok = results.filter((r) => r.status === 200);
  assert.strictEqual(ok.length, N,
    'every save must succeed: ' + JSON.stringify(results.filter((r) => r.status !== 200).map(msg)));
  const issued = ok.map((r) => r.body.document.document_number);
  assert.strictEqual(new Set(issued).size, N, 'every number distinct: ' + issued.join(', '));
  assert.deepStrictEqual(issued.slice().sort(),
    Array.from({ length: N }, (_, i) => 'RACE/' + String(i + 1).padStart(3, '0')),
    'and a contiguous run in the configured format');
});

test('G24 the automatic side walks past a typed number that collides with the format', async () => {
  const fresh = await freshUser('pfformat-collide@scratch.test');
  const token = tok(fresh);
  await setFormat({ proforma_invoice: 'CL-###' }, token);
  // Type CL-001 by hand, then let the automatic side choose.
  const typed = await save({ document: doc({ document_number: 'CL-001' }), items: ITEMS }, token);
  assert.strictEqual(typed.status, 200, msg(typed));
  const auto = await save({ document: doc(), items: ITEMS }, token);
  assert.strictEqual(auto.status, 200, msg(auto));
  assert.strictEqual(auto.body.document.document_number, 'CL-002',
    'a number already issued by hand must not be handed out again');
});
