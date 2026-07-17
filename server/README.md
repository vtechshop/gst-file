# Product Sync Backend

A small secure proxy. It's the only thing in this project allowed to hold
the company website's product API key.

```
Billing System Frontend  (js/product-sync.js — no secrets)
        │
        ▼
Billing Backend           (this folder)   GET /api/product-sync
        │   (reads WEBSITE_PRODUCT_API_KEY from .env, in memory only)
        ▼
Website Product API  (authenticated)
        │
        ▼
Website Database
```

## Where the API key goes

**`server/.env`** — nowhere else. Never in `js/config.js`, never in any
file under the main app, never committed to git (`.env` is listed in
`../.gitignore`).

If you deploy this backend to a hosting platform (Render, Railway, Fly.io,
a VPS, etc.) instead of running it on your own machine, set the same
variables in that platform's **environment variables / secrets** panel
— not in a file that ships with the code. Locally, `.env` fills that
same role via the `dotenv` package.

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
WEBSITE_PRODUCT_API_URL=https://yourcompany.com/api/products
WEBSITE_PRODUCT_API_KEY=<your real key>
```

`ALLOWED_ORIGIN` must match wherever the Billing System frontend is
actually served from (comma-separated if more than one, e.g. local dev
+ a deployed URL) — the proxy rejects browser requests from any other
origin.

Run it:

```bash
npm start
```

You should see:

```
Product sync backend listening on http://localhost:4000
  Website API configured: true
  Allowed origins: http://localhost:5500
```

## Wiring up the frontend

In `js/config.js`, set:

```js
const PRODUCT_SYNC_BACKEND_URL = 'http://localhost:4000/api/product-sync';
```

(or wherever this backend ends up deployed). That's the only frontend
change needed — the Billing System's Products page and its "Sync Now"
button already call this URL once it's set.

## Deployment note

The main Billing System is a static site — it can be hosted on GitHub
Pages or similar. **This backend cannot** — GitHub Pages only serves
static files, no server code. This folder needs a real Node host
(Render, Railway, Fly.io, a small VPS, or converted to a serverless
function later). Point `PRODUCT_SYNC_BACKEND_URL` at wherever it ends
up running, and set `ALLOWED_ORIGIN` there to match your deployed
frontend's actual URL.

**Never deploy this `server/` folder to the same static host as the
frontend** (e.g. don't let it end up inside whatever gets published to
GitHub Pages). `.env` itself is git-ignored so it can never get
committed or published that way — but keep the two physically
separate deployments regardless, as defense in depth. `server/index.js`
and `package.json` contain no secrets themselves (they only read
`process.env.*`), so accidentally serving *those* isn't a key leak,
but there's no reason to expose backend source to the public frontend
origin either.

## Endpoints

- `GET /api/product-sync` — returns the website's product list (proxied). Never includes the API key in its response.
- `GET /api/product-sync/health` — `{ ok, websiteConfigured, keyConfigured }`, booleans only, safe to leave public. Useful for confirming `.env` loaded correctly without exposing anything.
