-- Export details on a proforma.
--
-- A proforma is the quotation that precedes a tax invoice, and an export
-- quotation has to carry the same export terms the invoice will: the buyer
-- needs to know whether the price is WPAY or under LUT before agreeing to
-- it. Until now Proforma Entry could set an "Export (overseas)" GST category
-- but had nowhere to record what kind of export it was, so the detail was
-- lost between quotation and invoice and had to be retyped.
--
-- Every column mirrors the one b2b_invoices/b2c_invoices already carry, by
-- name and by type, so converting a proforma into an invoice later is a copy
-- rather than a translation.
--
-- Purely additive. Every column is nullable (differential_65 keeps the same
-- NOT NULL DEFAULT FALSE the invoice tables use, which is safe because the
-- default supplies a value for every existing row). No existing column,
-- constraint, index or row is touched, and nothing is backfilled - a proforma
-- raised before this migration keeps NULL and behaves exactly as it did,
-- because the entry form treats "no export_type" as "not an export".
--
-- Nothing here is read by GSTR-1, GSTR-3B, the Dashboard, Reports, the
-- ledgers, stock or any numbering book. proforma_invoices is deliberately
-- outside all of those, and this migration does not change that.

ALTER TABLE proforma_invoices
  -- WPAY (with payment of IGST) or WOPAY (under LUT / bond). NULL means the
  -- proforma is not an export at all - that is what the entry form's toggle
  -- reads back to decide whether it was on.
  ADD COLUMN IF NOT EXISTS export_type TEXT,

  -- The shipping bill, and the port it cleared. Absent for a service export,
  -- which has no shipping bill, so these stay nullable rather than becoming
  -- conditionally required in the database.
  ADD COLUMN IF NOT EXISTS shipping_bill_number TEXT,
  ADD COLUMN IF NOT EXISTS shipping_bill_date DATE,
  ADD COLUMN IF NOT EXISTS port_code TEXT,

  -- 'goods' or 'services'. Services have no shipping bill; goods normally do.
  ADD COLUMN IF NOT EXISTS export_of TEXT,

  -- 'unit' or 'developer' when the recipient is in an SEZ. Kept separate from
  -- export_type because an SEZ supply is domestic-but-zero-rated, not an
  -- overseas export, and the invoice tables draw the same distinction.
  ADD COLUMN IF NOT EXISTS sez_recipient_type TEXT,

  -- The LUT in force when this proforma was raised, copied onto it. The
  -- profile's LUT can be replaced next year; a quotation already sent must
  -- not change because of that.
  ADD COLUMN IF NOT EXISTS lut_number TEXT,

  -- Leased vehicle bought before 1 July 2017, supplied at 65% of the rate.
  -- NOT NULL with a default, exactly as on the invoice tables, so every
  -- existing row gets FALSE rather than an ambiguous NULL.
  ADD COLUMN IF NOT EXISTS differential_65 BOOLEAN NOT NULL DEFAULT FALSE;
