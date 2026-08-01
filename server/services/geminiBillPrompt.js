// =============================================
// Gemini prompt + response schema for Purchase Bill extraction.
//
// THIS IS THE ONLY FILE TO EDIT when the extraction needs to change —
// wording, new fields, stricter rules. routes/bill-scan.js just posts
// whatever this module exports and normalises the reply; it has no
// opinion about what the model is asked for.
//
// The schema is not merely documentation: it is sent as Gemini's
// responseSchema alongside responseMimeType: application/json, so the
// model is constrained to emit exactly this shape. That is what lets
// the route trust JSON.parse() instead of scraping prose for values.
// =============================================

// Overridable per-environment so a model can be swapped without a deploy
// of new code. Flash is the right default here: bill extraction is a
// short, highly-structured vision task, not a reasoning problem.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Gemini's Schema type is the OpenAPI subset, with type names as proto
// enum spellings (STRING/NUMBER/...), not JSON-Schema lowercase.
const BILL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    vendor: {
      type: 'OBJECT',
      properties: {
        vendor_name: { type: 'STRING', description: 'Supplier/seller business name. NOT the buyer.' },
        gstin:       { type: 'STRING', description: '15-character supplier GSTIN, uppercase, no spaces.' },
        address:     { type: 'STRING', description: 'Supplier postal address as one line.' },
        state:       { type: 'STRING', description: 'Indian state of the supplier, full name e.g. "Tamil Nadu".' }
      },
      required: ['vendor_name', 'gstin', 'address', 'state']
    },
    purchase: {
      type: 'OBJECT',
      properties: {
        purchase_number: { type: 'STRING', description: 'The supplier bill/invoice number exactly as printed.' },
        purchase_date:   { type: 'STRING', description: 'Bill date as YYYY-MM-DD.' },
        supply_type:     { type: 'STRING', enum: ['intrastate', 'interstate', ''], description: 'intrastate if CGST+SGST are charged, interstate if IGST is charged.' }
      },
      required: ['purchase_number', 'purchase_date', 'supply_type']
    },
    products: {
      type: 'ARRAY',
      description: 'Every product line on the bill, across every page. Do not merge, summarise or truncate.',
      items: {
        type: 'OBJECT',
        properties: {
          product_name:        { type: 'STRING' },
          hsn_code:            { type: 'STRING', description: 'HSN/SAC code, digits only.' },
          unit:                { type: 'STRING', description: 'Unit of measure, e.g. NOS, KG, PCS.' },
          quantity:            { type: 'NUMBER', nullable: true },
          rate:                { type: 'NUMBER', nullable: true, description: 'Per-unit rate before tax.' },
          discount_percentage: { type: 'NUMBER', nullable: true },
          gst_percentage:      { type: 'NUMBER', nullable: true, description: 'Total GST rate for the line (CGST+SGST combined, or IGST).' },
          taxable_value:       { type: 'NUMBER', nullable: true, description: 'Line value before tax, as printed.' },
          total:               { type: 'NUMBER', nullable: true, description: 'Line value including tax, as printed.' }
        },
        required: ['product_name', 'hsn_code', 'unit', 'quantity', 'rate',
                   'discount_percentage', 'gst_percentage', 'taxable_value', 'total']
      }
    }
  },
  required: ['vendor', 'purchase', 'products']
};

// Two rules carry most of the weight here:
//   • "leave it blank" — a guessed GSTIN or invoice number is worse than
//     an empty box, because an empty box is visibly incomplete whereas a
//     plausible wrong value gets saved.
//   • "supplier, not buyer" — a purchase bill names both companies, and
//     the buyer is usually the more prominent of the two. Without this,
//     the model reliably returns the user's own business as the vendor.
const BILL_PROMPT = `You are reading an Indian GST purchase bill (a supplier's tax invoice).

Extract the bill into the required JSON structure.

WHOSE DETAILS TO EXTRACT
The vendor is the SUPPLIER / SELLER who issued this bill — the party the
money is paid TO. Never return the buyer / "Bill To" / "Ship To" party as
the vendor, even if their details appear larger or first on the page.

ACCURACY RULES
- Copy values exactly as printed. Do not calculate, correct or infer any
  value that is not on the page.
- If a field is absent, unreadable, or you are not confident, return ""
  for text fields and null for numeric fields. NEVER guess. An empty
  value is always better than a plausible wrong one.
- GSTIN must be exactly 15 characters, uppercase, no spaces. If what you
  can see is not a complete 15-character GSTIN, return "".
- Dates must be YYYY-MM-DD. Indian bills are almost always DD/MM/YYYY —
  read 05/07/2026 as 2026-07-05. If the date is ambiguous or unclear,
  return "".
- state must be a full Indian state name, e.g. "Tamil Nadu", "Karnataka".

PRODUCT LINES
- Return EVERY product row from EVERY page, in the order printed.
- Ignore non-product rows entirely: subtotals, tax summary rows, grand
  total, round-off, amount-in-words, terms, declarations, bank details,
  and any HSN-wise tax summary table.
- Strip leading serial numbers from product names ("1. Mixer" -> "Mixer").
- gst_percentage is the COMBINED rate for the line: if the bill shows
  CGST 9% and SGST 9%, return 18.
- If a bill shows a discount in rupees rather than a percentage, and the
  percentage is not printed, return null for discount_percentage.

IGNORE
- QR codes, barcodes, IRN strings, digital signature blocks and logos.
- Any handwriting or stamp overlaying the printed bill.

Return only the JSON.`;

module.exports = { GEMINI_MODEL, BILL_SCHEMA, BILL_PROMPT };
