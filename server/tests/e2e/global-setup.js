// Stands up the isolated world once, before any spec runs: migrate the
// scratch database, seed deterministic rows, start the real server, and
// leave the port and the session token where the specs can find them.
//
// Seeded data is fixed, so an assertion can name a figure. The quotation is
// the one from the brief this feature was built against: 1,750 total, with a
// quoted advance TERM of 500 that must never be read as money received.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const {
  requireScratchDatabase, freePort, startServer, writeState
} = require('./harness');

const MIGRATIONS = path.join(__dirname, '..', '..', 'db', 'migrations');
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'schema', 'schema.sql');

// Fixed ids and numbers, so a failure names a row rather than "some record".
const SEED = {
  user: { email: 'e2e@scratch.test' },
  other: { email: 'e2e-other@scratch.test' },
  // 1,750 quoted: two lines, 18% GST, intrastate, with a 5% discount on one
  // so the Discount % column has something to show.
  quote: { number: 'PI-E2E-001', total: 1750, taxable: 1483.05, gst: 266.95, advanceTerm: 500 },
  // A second quotation, left entirely unreceipted, for the standalone and
  // cap cases so they never collide with the first.
  spare: { number: 'PI-E2E-002', total: 900 },
  cancelledQuote: { number: 'PI-E2E-003', total: 500 }
};

module.exports = async function globalSetup() {
  const databaseUrl = requireScratchDatabase();
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-advance-receipt-secret';

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  // On a fresh machine the scratch database is empty and needs the schema; on
  // one the node:test suite has already used, it has it. The file cannot
  // simply be re-applied to find out: it is idempotent for tables and indexes
  // (every CREATE is IF NOT EXISTS) but not for triggers, because Postgres has
  // no CREATE TRIGGER IF NOT EXISTS - so a second application fails on the
  // first one. Asking first is the only way to be right in both cases.
  const { rows: built } = await db.query(
    "SELECT to_regclass('public.receipt_vouchers') IS NOT NULL AS ok");
  if (!built[0].ok) {
    await db.query(fs.readFileSync(SCHEMA, 'utf8'));
  }
  // Then the additive migrations this feature depends on, in manifest order.
  // The manifest's list lives under `order` - see db/migrations/_manifest.json.
  const manifest = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, '_manifest.json'), 'utf8'));
  const ordered = manifest.order;
  if (!Array.isArray(ordered) || !ordered.length) {
    throw new Error('db/migrations/_manifest.json has no `order` array - refusing to seed '
      + 'a database whose migrations were silently skipped.');
  }
  for (const file of ordered) {
    const full = path.join(MIGRATIONS, file);
    if (fs.existsSync(full)) {
      try { await db.query(fs.readFileSync(full, 'utf8')); }
      catch (e) { /* guarded and additive; already-applied is the normal case */ }
    }
  }

  // A clean slate. Safe only because requireScratchDatabase() has already
  // refused anything that looks like a hosted database.
  await db.query('TRUNCATE users CASCADE');

  const mkUser = async (email, businessName, gstin) => {
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, 'e2e-not-a-real-hash']);
    const id = rows[0].id;
    await db.query(
      `INSERT INTO profiles (id, name, business_name, gstin, state, district, address)
       VALUES ($1, $2, $3, $4, 'Tamil Nadu', 'Coimbatore', '14, Avinashi Road')`,
      [id, businessName, businessName, gstin]);
    return id;
  };

  const userId = await mkUser(SEED.user.email, 'VTECH Engineering Works', '33AAGCV4521K1ZT');
  const otherId = await mkUser(SEED.other.email, 'Other Traders', '33AACCO1234M1ZR');

  const mkQuote = async (owner, q, status) => {
    const { rows } = await db.query(
      `INSERT INTO proforma_invoices
         (user_id, document_number, document_date, customer_name, gst_number, phone,
          address, state, district, supply_type, taxable_amount, gst_percentage,
          gst_amount, cgst, sgst, total_amount, advance_amount, status)
       VALUES ($1,$2,'2026-10-20','Anand Caterers','33AAAAA0000A1Z5','9876500000',
               '5 Mill Road','Tamil Nadu','Coimbatore','intrastate',
               $3,18,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [owner, q.number, q.taxable ?? 0, q.gst ?? 0,
       (q.gst ?? 0) / 2, (q.gst ?? 0) / 2, q.total, q.advanceTerm ?? 0, status || 'issued']);
    return rows[0].id;
  };

  const quoteId = await mkQuote(userId, SEED.quote);
  const spareId = await mkQuote(userId, SEED.spare);
  const cancelledId = await mkQuote(userId, SEED.cancelledQuote, 'cancelled');
  const foreignId = await mkQuote(otherId, { number: 'PI-E2E-OTHER', total: 400 });

  // The two lines the Products grid must render, out of sort_order on purpose
  // so a spec can prove the table sorts rather than trusting insert order.
  const line = (quote, o) => db.query(
    `INSERT INTO proforma_invoice_items
       (proforma_invoice_id, product_name, hsn_code, unit, quantity, rate,
        discount_percentage, gst_percentage, gst_treatment, taxable_value,
        gst_amount, cgst, sgst, total_amount, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,18,'taxable',$8,$9,$10,$11,$12,$13)`,
    [quote, o.name, o.hsn, o.unit, o.qty, o.rate, o.discount,
     o.taxable, o.gst, o.gst / 2, o.gst / 2, o.total, o.sort]);

  await line(quoteId, { name: 'Mixer Grinder', hsn: '8509', unit: 'PCS', qty: 1, rate: 1200,
    discount: 5, taxable: 1200, gst: 216, total: 1416, sort: 2 });
  await line(quoteId, { name: 'Wall Bracket', hsn: '7308', unit: 'PCS', qty: 2, rate: 141.53,
    discount: 0, taxable: 283.05, gst: 50.95, total: 334, sort: 1 });

  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '4h' });

  const port = await freePort();
  const server = await startServer(port, databaseUrl);
  const baseURL = 'http://127.0.0.1:' + port;
  process.env.E2E_BASE_URL = baseURL;

  writeState({
    baseURL, port, token, databaseUrl,
    serverPid: server.pid,
    userId, otherId,
    quoteId, spareId, cancelledId, foreignId,
    seed: SEED
  });

  // Detached from this process's lifetime on purpose: globalSetup exits, and
  // global-teardown is what stops it, by the pid recorded above.
  // The pipes this spawn opened keep handles alive that nothing reads once
  // the server is up; the child outlives globalSetup either way, and
  // global-teardown stops it by the pid above.
  if (server.stdout && server.stdout.unref) server.stdout.unref();
  if (server.stderr && server.stderr.unref) server.stderr.unref();
  server.unref();
  await db.end();

  console.log('[e2e] isolated server on ' + baseURL + ' against ' + databaseUrl.replace(/:\/\/[^@]*@/, '://***@'));
};
