-- =============================================
-- Ship To on the invoice itself.
--
-- Until now an invoice had one address, and Ship To was resolved at render
-- time from the customer master. That made every invoice show the
-- customer's CURRENT Ship To: correcting a customer's delivery address
-- silently rewrote where the goods went on every invoice already issued to
-- them. A tax invoice records what happened on the day it was raised, so
-- the address has to live on the invoice, not be looked up later.
--
-- NULL MEANS "SAME AS THE BILLING ADDRESS".
-- It is not "unknown" and it is not a missing value to be filled in. When
-- the goods go to the billing address the columns stay NULL rather than
-- carrying a copy of it, so there is exactly one address on the row and no
-- second copy that can drift out of step when the billing address is
-- corrected. Every existing invoice is already in that state, which is why
-- this migration needs no backfill: rows written before today read as
-- "same as billing", which is what they always meant.
--
-- EVERY COLUMN IS NULLABLE, WITH NO DEFAULT AND NO BACKFILL,
-- for the same reason migration_address_district.sql gives.
--
-- The columns are named to match customers.shipping_address /
-- shipping_state / shipping_district, which already exist and already hold
-- a customer's default Ship To. Same names, same meaning, so the invoice
-- can be prefilled from the customer without a translation layer, and the
-- district pairs with its own state exactly as it does everywhere else.
--
-- Nothing about tax reads these columns. Place of supply is still `state`,
-- and the intrastate/interstate split is unchanged: where goods are
-- delivered does not move the GST.
-- =============================================

ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS shipping_address  TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS shipping_state    TEXT;
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS shipping_district TEXT;

ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS shipping_address  TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS shipping_state    TEXT;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS shipping_district TEXT;
