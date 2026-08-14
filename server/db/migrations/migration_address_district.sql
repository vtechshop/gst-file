-- =============================================
-- Address District — structured State + District on every address the
-- application collects.
--
-- District is stored alongside the State it belongs to, never instead of
-- it. The State column is unchanged and remains what drives the GST place
-- of supply and the intrastate/interstate split; District is an address
-- detail and nothing reads it for tax.
--
-- EVERY COLUMN IS NULLABLE, WITH NO DEFAULT AND NO BACKFILL.
-- These tables hold years of rows that predate District. Making it NOT
-- NULL, or backfilling a guess, would either fail outright or write a
-- district nobody chose into somebody's invoice. A row without a District
-- keeps working exactly as it does today; the value appears only when a
-- user picks one.
--
-- The pairing differs per table because the tables already disagree about
-- what they call a state — customers has a billing and a Ship To address,
-- delivery_challans has a from and a to. Each district column is named
-- after the state column it belongs with, so the pair is obvious in the
-- schema and not just in the code:
--
--   profiles.state             -> profiles.district
--   customers.state            -> customers.district
--   customers.shipping_state   -> customers.shipping_district
--   vendors.state              -> vendors.district
--   b2b_invoices.state         -> b2b_invoices.district
--   b2c_invoices.state         -> b2c_invoices.district
--   purchases.state            -> purchases.district
--   sales_returns.state        -> sales_returns.district
--   delivery_challans.from_state -> delivery_challans.from_district
--   delivery_challans.to_state   -> delivery_challans.to_district
--   job_workers.state          -> job_workers.district
--
-- Deliberately NOT included: cdn_notes, purchase_returns, self_invoices
-- and unregistered_suppliers all carry a state, but none of them has an
-- address form that collects a District, so a column there would only
-- ever hold NULL.
--
-- No CHECK constraint ties District to State. The valid pairs come from
-- the LGD district register (shared/india-districts.js), which is data
-- that changes when states reorganise — encoding ~785 pairs as a database
-- constraint would mean a migration every time a district is renamed, and
-- would reject rows that were valid when they were written. The pair is
-- enforced where the register lives: the browser filters the dropdown to
-- the selected state, and the API validates the pair on every write.
-- =============================================

ALTER TABLE profiles          ADD COLUMN IF NOT EXISTS district           TEXT;

ALTER TABLE customers         ADD COLUMN IF NOT EXISTS district           TEXT;
ALTER TABLE customers         ADD COLUMN IF NOT EXISTS shipping_district  TEXT;

ALTER TABLE vendors           ADD COLUMN IF NOT EXISTS district           TEXT;

ALTER TABLE b2b_invoices      ADD COLUMN IF NOT EXISTS district           TEXT;
ALTER TABLE b2c_invoices      ADD COLUMN IF NOT EXISTS district           TEXT;

ALTER TABLE purchases         ADD COLUMN IF NOT EXISTS district           TEXT;
ALTER TABLE sales_returns     ADD COLUMN IF NOT EXISTS district           TEXT;

ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS from_district      TEXT;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS to_district        TEXT;

ALTER TABLE job_workers       ADD COLUMN IF NOT EXISTS district           TEXT;
