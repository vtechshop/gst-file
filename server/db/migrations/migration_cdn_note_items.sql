-- ============================================================
-- Credit / Debit Note items - which products a note applies to
--
-- Additive only. Every note saved before this has no items and keeps
-- meaning exactly what it meant; nothing here reads or changes a note, an
-- invoice or a product. Re-runnable.
-- ============================================================

-- A note's items must belong to a note of the SAME tenant. A composite
-- foreign key says that in the database itself, and it needs (id, user_id)
-- to be unique on cdn_notes. id alone is already the primary key, so this
-- adds no new restriction on the notes - it only gives the pair a key the
-- foreign key can point at.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cdn_notes_id_user_key'
       AND conrelid = 'public.cdn_notes'::regclass
  ) THEN
    ALTER TABLE cdn_notes ADD CONSTRAINT cdn_notes_id_user_key UNIQUE (id, user_id);
  END IF;
END
$$;

-- Each row is a SNAPSHOT of an invoice line the note was raised against,
-- taken when the note is saved: the name, HSN, unit, quantity, rate and
-- taxable value as they stood. Not a reference to invoice_items - those
-- rows are deleted and re-inserted every time an invoice is saved, so their
-- ids do not survive - and not read from the Product Master, which can be
-- renamed later. The note prints what it was issued for.
--
-- The note stays authoritative for the money: its taxable amount, GST split
-- and total. These rows only say which products it applies to, and the save
-- path refuses a note whose rows do not add up to it.
CREATE TABLE IF NOT EXISTS cdn_note_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT,
  quantity DECIMAL(15,3),
  rate DECIMAL(15,2),
  taxable_value DECIMAL(15,2),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Deleting a note deletes its items with it; the invoice is untouched.
  CONSTRAINT cdn_note_items_note_fk FOREIGN KEY (note_id, user_id)
    REFERENCES cdn_notes (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cdn_note_items_note ON cdn_note_items (note_id, sort_order);
