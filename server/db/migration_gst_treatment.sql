-- =============================================
-- Phase 2, Module 3 — GST treatment and reverse charge
-- =============================================
-- Two things a return needs that nothing recorded:
--
--   1. Whether a supply is taxable at all. Nil-rated, exempt and non-GST
--      supplies are reported in GSTR-1 table 8, NOT in 4A/5/7, and are
--      excluded from the taxable value of those tables. Until now every
--      line was treated as taxable, so a nil-rated sale was reported as
--      a taxable supply at 0% — the right money in the wrong table.
--
--   2. Whether tax is payable by the recipient. A reverse-charge supply
--      carries rchrg 'Y' in 4A, which is table 4B of the Portal's own
--      numbering (4C in the return format). rchrg was the literal 'N'
--      on every invoice this application has ever produced.
--
-- Every column is additive and defaulted to what existing data already
-- is: 'taxable' and FALSE. No row is touched, and a return over
-- untouched data comes out byte for byte as before.
--
-- Safe to run more than once.

-- ── Product master ──────────────────────────
-- taxable   | nil_rated | exempt | non_gst
--
-- The three non-taxable treatments are distinct in GSTR-1 and are
-- reported in different columns of table 8, so they are three values
-- rather than one "not taxable" flag:
--   nil_rated  goods/services at a 0% rate
--   exempt     exempt by notification, or wholly exempt
--   non_gst    outside GST altogether (alcohol for human consumption,
--              petroleum products not yet notified, and so on)
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_treatment TEXT NOT NULL DEFAULT 'taxable';

-- Compensation cess, as a percentage of taxable value. Separate from
-- gst_percentage because it is a separate levy with its own rate, and
-- GSTR-1 carries it in its own field (csamt) in every section.
ALTER TABLE products ADD COLUMN IF NOT EXISTS cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0;

-- Supplies of this product are taxable in the recipient's hands.
ALTER TABLE products ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Invoice lines carry their own copy ──────
-- Same reasoning as gst_category on the invoice: a filed return must not
-- change because a master record was edited afterwards. A product
-- reclassified as exempt in September does not make July's taxable
-- sales exempt.
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS gst_treatment TEXT NOT NULL DEFAULT 'taxable';
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cess_rate DECIMAL(6,3) NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cess_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

-- ── Reverse charge is a property of the document ──
ALTER TABLE b2b_invoices ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE b2c_invoices ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_invoice_items_treatment ON invoice_items(user_id, gst_treatment);
