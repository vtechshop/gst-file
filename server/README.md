# GST Billing Backend

Node.js + Express + PostgreSQL backend for the GST Invoice & GSTR-1
Management System. Started life as a small product-sync proxy; now the
single backend for the whole app — auth, business data (invoices,
customers, products, payments, credit/debit notes, HSN), image uploads,
and the original product-sync proxy all live here.

```
Frontend (js/apiClient.js — no secrets)
        │  JWT in Authorization header
        ▼
This backend (server/)
        │
        ├── PostgreSQL — all business data
        ├── Cloudinary — logo/seal/signature/QR images (URL only in Postgres)
        └── Website Product API — proxied, key never reaches the browser
```

## Setup

```bash
cd server
npm install
cp .env.example .env
```

Edit `.env`:

```
PORT=4000
ALLOWED_ORIGIN=http://localhost:5500

# PostgreSQL — any Postgres instance (local, Docker, or hosted)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gst_invoicing

# JWT auth
JWT_SECRET=<a long random string>
JWT_EXPIRES_IN=7d

# Cloudinary — Settings' logo/seal/signature/QR uploads
CLOUDINARY_CLOUD_NAME=<your cloud name>
CLOUDINARY_API_KEY=<your api key>
CLOUDINARY_API_SECRET=<your api secret>

# Website Product API (existing product-sync proxy)
WEBSITE_PRODUCT_API_URL=https://yourcompany.com/api/products
WEBSITE_PRODUCT_API_KEY=<your real key>
```

Create the database and apply the schema (idempotent — safe to re-run):

```bash
psql -U postgres -c "CREATE DATABASE gst_invoicing;"
psql -U postgres -d gst_invoicing -f db/schema.sql
```

Run it:

```bash
npm start        # or: npm run dev  (auto-restarts on file changes)
```

## Where secrets go

**`server/.env`** only — never in `js/config.js`, never anywhere under
the frontend, never committed to git (`.env` is listed in
`../.gitignore`). If you deploy this backend to a hosting platform
(Render, Railway, Fly.io, a VPS, etc.), set the same variables in that
platform's environment-variables panel instead of shipping a `.env` file.

## Architecture

- **`db/schema.sql`** — the authoritative Postgres schema (one consolidated
  file; see its header comment for how it differs from the historical
  `../supabase-schema.sql`, kept in the repo root for reference).
- **`db/pool.js`** — the one shared `pg` connection pool every query goes
  through (or a client checked out from it for a transaction).
- **`middleware/auth.js`** — verifies the JWT, attaches `req.userId`.
  Every route filters its SQL by this — never by anything the client sends.
- **`routes/auth.js`** — register / login / logout / forgot-password
  (honest "not available yet" stub, no email infra exists) / `me`.
- **`routes/generic.js`** — one CRUD router factory serving the 11 tables
  whose query needs fit a common shape (`eq`/`gte`/`lte` filters, single-field
  order, column projection): `profiles`, `customers`, `cdn_notes`, `products`,
  `import_mappings`, `payments`, `b2b_invoices`, `b2c_invoices`, `b2b_hsn`,
  `b2c_hsn`, `invoice_items`.
- **`routes/invoices.js`** — the three operations that need a real Postgres
  transaction rather than generic single-table CRUD: saving an invoice with
  its line items + stock delta, reserving the next Auto-Generate invoice
  number (row-locked to prevent duplicates under concurrent saves), and the
  Recycle Bin delete/restore/hard-delete cascades.
- **`routes/uploads.js`** — Cloudinary image upload for Settings' branding assets.
- **`routes/backup.js`** — Settings' Backup/Restore/Clear-All-Data, scoped per user.
- **`index.js`** — mounts everything above, plus the original product-sync proxy.

## Wiring up the frontend

In `js/config.js`:

```js
const API_BASE_URL = 'http://localhost:4000/api';
```

(or wherever this backend ends up deployed). That single constant is
the only thing that needs to change — every page already talks to
`_supabase`/`apiFetch`, which route through this URL automatically.

## Deployment note

The frontend is a static site — it can be hosted on GitHub Pages or
similar. **This backend cannot** — GitHub Pages only serves static
files. This folder needs a real Node host (Render, Railway, Fly.io, a
VPS) with a PostgreSQL instance reachable from it. Point `API_BASE_URL`
at wherever this backend ends up running, and set `ALLOWED_ORIGIN`
there to match your deployed frontend's actual URL.

**Never deploy this `server/` folder to the same static host as the
frontend.** `.env` is git-ignored so it can't get committed or
published that way, but keep the two deployments physically separate
regardless, as defense in depth.

## Security

- Every query is parameterized (`pg`'s `$1, $2, ...` placeholders) —
  never string-concatenated SQL. The generic router additionally
  whitelists column names per table before they're ever interpolated
  into a query (only values are parameterizable; identifiers can't be).
- JWT auth (`jsonwebtoken`), passwords hashed with `bcryptjs`.
- `helmet()` mounted globally; CORS restricted to `ALLOWED_ORIGIN`.
- Rate limiting: a gentle general limit across all of `/api`, plus a
  much tighter one specifically on `/api/auth/register|login|forgot-password`
  (never on `/api/auth/me`, which fires on every page load and would
  otherwise lock normal users out).
- Every table has `user_id` (or, for `profiles`, `id` itself) scoping —
  no query anywhere trusts a client-supplied user id; it's always
  derived from the verified JWT.

## Endpoints

- `POST /api/auth/{register,login,logout,forgot-password}`, `GET /api/auth/me`
- `GET/POST/PATCH/DELETE /api/<table>` for the 11 generic tables listed above
- `POST /api/invoices/:type/save-with-items`, `POST /api/invoices/reserve-number`,
  `POST /api/invoices/:type/:id/cascade-{delete,restore,hard-delete}`
- `POST /api/uploads/image`
- `GET /api/backup/export`, `POST /api/backup/import`, `DELETE /api/backup/all-data`
- `GET /api/product-sync` — proxies the website's product list, never includes the API key.
- `GET /api/product-sync/health` — `{ ok, websiteConfigured, keyConfigured }`, safe to leave public.
