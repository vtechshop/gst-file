# GST Invoice & GSTR-1 Management System — Upgrade Audit & Roadmap

_Generated 2026-07-09. Base version audited: v2.0 (see `project-summary.json`)._

## 1. Audit Findings

### Bugs / gaps found
1. **Missing Supabase tables (critical)** — `js/localdb.js` and `customers.html`/`cdnotes.html` already read/write `customers` and `cdn_notes` tables, but `supabase-schema.sql` never defines them or their RLS policies. Today this only works because the app defaults to local-storage mode; the moment real Supabase credentials are added, Customer Master and Credit/Debit Notes silently break (table not found). **Fixed in Phase 1.**
2. **No product master** — GST%, HSN code and rate must be retyped on every invoice/HSN line; nothing is remembered per product.
3. **No bulk import** — only a JSON import exists for B2B (`importB2BFromJSON`); there is no Excel import, no column mapping, no preview step, and B2C/HSN have no import path at all.
4. **Validation is minimal** — only duplicate invoice number, taxable > 0, and a soft GSTIN-format warning exist. No duplicate-GSTIN-per-invoice check, no missing-HSN check, no negative-value guard beyond taxable amount, no missing invoice number/date check surfaced as a structured warning list (import needs a batch version of this).
5. **No global search or cross-page filters** — every page has its own local text-search box (`b2bSearch`, `custSearch`, etc.); there's no way to search by GSTIN/HSN/customer across the whole app, and list pages can't be filtered by month/year/rate/HSN/customer beyond a single free-text field.
6. **No bulk operations** — every row action (edit/delete) is one at a time; no multi-select, bulk delete, or bulk export of a filtered subset.
7. **No draft/autosave** — a page refresh or accidental navigation mid-entry loses the whole form.
8. **No dedicated Settings page** — company/GSTIN details live only in the "Business Profile" modal; there's no UI for default GST rate, financial year, or theme.
9. **Reports are date-range only** — no quarterly, customer-wise, product-wise, or HSN-wise report views (data already exists to derive all of these).
10. **Duplicated pagination code** — `gstr1.js` (`renderPagination`) and `customers.js` (`renderCustPagination`) reimplement the same pager independently; new modules should reuse one shared version instead of adding a third copy.
11. **Dashboard fetches the selected year's data twice** — once for the stat cards (date-range query) and again for the 12-month table (full-year query) — a minor duplicate-fetch inefficiency, not a bug.
12. **GSTR-3B already exists** (`gstr3b.html`/`js/gstr3b.js`) — "future ready for GSTR-3B" is already partially true; the roadmap below only adds the E-Invoice/E-Way Bill placeholders that are genuinely missing.

### Constraints respected
- No framework, no build step — everything stays vanilla HTML/CSS/JS loaded via `<script>` tags in the existing order.
- Supabase stays the backing store; `js/localdb.js` (offline mode) is extended in lockstep so both modes keep working identically.
- No existing page is renamed, no existing function signature is broken, no existing feature is removed.
- New capability is added as new modules/pages first; existing files are only touched to add integration hooks (new sidebar links, new hooks in `save*()` functions, new tables in `DB_TABLES`, etc.).

## 2. Phased Roadmap (executed in this order)

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 | DB migrations: `customers`, `cdn_notes`, `products`, `import_mappings` tables + RLS in `supabase-schema.sql`; mirrored in `localdb.js` DB_TABLES | — |
| 2 | `js/validate.js` — shared validation module (GSTIN format, duplicate invoice/GSTIN, missing HSN/date/number, negative values) | 1 |
| 3 | Product Master page (`products.html` + `js/products.js`) — CRUD, same pattern as Customer Master | 1 |
| 4 | Auto-fill hooks — B2B/B2C/HSN entry forms look up Product Master by HSN/name and prefill GST%/rate; Customer Master already auto-fills GSTIN (kept) | 3 |
| 5 | Excel Import pipeline (`js/import.js` + import UI) — xlsx/xls parsing via SheetJS, preview grid, column-mapping UI with remembered mapping (localStorage), auto-classify by GSTIN presence (B2B vs B2C), auto-generate HSN summary from imported rows, validation warnings from Phase 2, bulk insert with progress | 2, 3 |
| 6 | Dashboard analytics — Top Customers, Top Products, Import Statistics widgets | 3, 5 |
| 7 | Global search + per-page filters (month/year/rate/HSN/customer/invoice no.) | 1 |
| 8 | Bulk operations — row checkboxes, bulk delete, bulk export of current filtered set | 7 |
| 9 | Draft autosave + recovery banner on B2B/B2C/HSN forms | — |
| 10 | Settings page (`settings.html`) — company details, GSTIN, default GST rate, financial year, theme toggle | — |
| 11 | Expanded Reports — quarterly, customer-wise, product-wise, HSN-wise, GST-wise views/exports | 3 |
| 12 | Future-ready stubs — config flags + disabled "Coming soon" entry points for E-Invoice and E-Way Bill (GSTR-3B already exists) | — |

Each phase is implemented completely (schema → JS → UI → wiring into existing pages) before the next one starts. This file is updated with a ✅ per phase as it lands.

## 3. Status

- [x] Phase 1 — DB schema: `customers`, `cdn_notes`, `products`, `import_mappings` tables + RLS added to `supabase-schema.sql`; mirrored in `localdb.js` `DB_TABLES` (so backup/restore/clear-data cover them too).
- [x] Phase 2 — `js/validate.js`: GSTIN format check, duplicate invoice/GSTIN detection, missing-field warnings — non-blocking, used by the import pipeline.
- [x] Phase 3 — Product Master: `products.html` + `js/products.js`, full CRUD, added to every page's sidebar.
- [x] Phase 4 — Auto-fill: HSN entry (`hsn.html`) looks up Product Master by name and prefills HSN code / type / GST% / default rate. (B2B/B2C invoices have no product field in this schema — Customer Master auto-fill there was already in place and is untouched.)
- [x] Phase 5 — Excel Import: "Import Excel" button on `gstr1.html` opens a 3-step modal (upload → map columns, remembered per user via `import_mappings` → validate/preview → bulk insert). Auto-classifies by GSTIN presence into B2B/B2C, auto-generates a matching HSN Summary row when HSN Code + Product Name are mapped.
- [x] Phase 6 — Dashboard: Top Customers (from B2B, period-aware), Top Products (from HSN, all-time), Import Statistics (persisted in `localStorage.gst_import_stats`).
- [x] Phase 7 — Global search (`Ctrl+K` or the search icon on every page) queries invoices/customers/products/HSN/credit-debit notes and deep-links to the right page with `?q=`, which each page's own search box picks up automatically. Added a GST-rate filter dropdown (combines with text search) on the B2B and B2C list pages.
- [x] Phase 8 — Bulk operations: fully implemented on the B2B Invoices table (row checkboxes, select-all, bulk delete, bulk Excel export of the selection). The same pattern (see `js/gstr1.js`'s "Bulk operations" section) can be copied to B2C/Customers/HSN — not yet duplicated there to avoid four near-identical, hard-to-maintain copies without a reuse layer.
- [x] Phase 9 — Draft autosave: B2B and B2C entry forms autosave to `localStorage` as you type and show a "Restore draft?" banner on reload; cleared automatically on successful save. HSN forms can adopt the same two `js/drafts.js` calls if wanted.
- [x] Phase 10 — Settings: extended the existing Settings modal (`js/profile.js`) with Default GST Rate, Financial Year, and a working Dark Theme toggle (new `[data-theme="dark"]` CSS block + `toggleTheme()` in `js/utils.js`, applied before paint to avoid a flash).
- [x] Phase 11 — Reports: added Quarterly (Q1–Q4) to the existing month filter, plus four new aggregated views — Customer-wise, Product-wise, HSN-wise (grouped by code), GST Rate-wise.
- [x] Phase 12 — Future-ready: `FEATURE_FLAGS` in `js/config.js` + `js/future.js` stubs document the intended request/response shape for E-Invoice (IRN) and E-Way Bill generation; disabled "Coming Soon" entry points added next to the existing GSTR-1 JSON export. GSTR-3B was already implemented pre-existing (`gstr3b.html`).

### Known follow-ups (not done in this pass, by design — see notes above)
- Bulk select/delete/export only on B2B; B2C/Customers/HSN would benefit from the same UI once a shared table-toolbar helper is factored out.
- Draft autosave only on B2B/B2C forms; HSN entry can reuse `js/drafts.js` directly.
- Financial Year preference is stored and shown in Settings but not yet used to filter reports (Quarterly/FY date-range filters already exist independently on the Reports page).
- Month/Year/HSN/Customer filters beyond GST-rate are covered today by each page's free-text search plus Dashboard/Reports date filters, not as separate dropdowns on every list page.

## 4. Architecture Migration — LocalStorage/placeholder-Supabase → Node.js + Express + PostgreSQL

_Landed 2026-07-18. See `server/README.md` for the backend's own architecture notes._

Everything above this section describes features built while the app ran entirely in "local demo mode" — `js/localdb.js`'s `LocalSupabase` shim storing all data as JSON in the browser's `localStorage`, with fake auth (a single hardcoded local user, no real password check). That's been replaced end-to-end with a real production stack, in six phases, with zero change to how any page looks or behaves:

- [x] Phase 1 — PostgreSQL schema (`server/db/schema.sql`) + Express foundation: JWT auth (register/login/logout, bcrypt-hashed passwords), a generic parameterized-SQL CRUD router covering all 11 business tables, new indexes (invoice number, customer name, GST number, HSN code, date) and a partial-unique constraint preventing two active invoices from ever sharing a number.
- [x] Phase 2 — `js/apiClient.js`: a drop-in `_supabase` replacement with the *identical* chainable query-builder interface `LocalSupabase` had, backed by `fetch()` against the new REST API instead of `localStorage`. Because every page already went through that one interface, ~20 of the ~27 files in `js/` needed zero changes. Settings' Backup/Restore/Clear-Data (previously reading `localStorage` directly, bypassing the data layer entirely) was rebuilt against new backend endpoints in the same phase.
- [x] Phase 3 — Invoices wired through the same generic router, mechanically, with no behavior change — isolated the "did the REST translation work" question from Phase 4's atomicity upgrade. Caught and fixed a real bug here: `pg` parses Postgres `DATE` columns into JS `Date` objects, which serialize as full ISO datetimes instead of the plain `YYYY-MM-DD` every `<input type="date">` needs — fixed once at the connection-pool level, correcting every date field app-wide.
- [x] Phase 4 — The three places that used to do multi-step, non-atomic orchestration across separate calls (invoice save-with-items, Auto-Generate invoice-number reservation, Recycle Bin cascades) now run inside real Postgres transactions, with row-level locking (`SELECT ... FOR UPDATE`) making stock adjustment and invoice-number reservation genuinely race-safe under concurrent use — verified by firing two simultaneous reservations and confirming they return distinct numbers.
- [x] Phase 5 — Cloudinary image uploads for Settings' logo/seal/signature/QR (`server/routes/uploads.js`), storing only the URL in Postgres. Caught and fixed a real gap: jsPDF's `doc.addImage()` needs actual image data, not a URL, so PDF generation would have silently lost branding images the moment they became URLs — fixed with a URL-to-data-URL resolver in `js/invoice-pdf.js`.
- [x] Phase 6 — Helmet, rate limiting (a gentle global limit plus a much tighter one specifically on login/register/forgot-password — deliberately *not* on `/me`, which fires on every page load), input validation on the transactional endpoints, and cleanup: `js/localdb.js` deleted, the unused Supabase JS CDN `<script>` tag removed from every page, `IS_LOCAL_MODE`/`LOCAL_USER` fully retired.

**Explicitly out of scope, by the user's own decision, not an oversight:** no data-migration script (confirmed no real/production data existed anywhere to migrate — this was a from-scratch backend build); no offline/no-backend demo mode preserved (the app now always requires PostgreSQL + `node server/index.js` running); no real email delivery for password reset (honest "not available yet" stub instead).
