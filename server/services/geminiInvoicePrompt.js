// =============================================
// Gemini prompt + response schema for Customer Invoice extraction.
//
// THIS IS THE ONLY FILE TO EDIT when invoice extraction needs to change
// — wording, new fields, stricter rules. routes/invoice-scan.js just
// hands whatever this module exports to services/geminiClient.js and
// normalises the reply; it has no opinion about what the model is asked
// for. Same split as geminiBillPrompt.js on the purchase side.
//
// The defining difference from the bill scanner: this returns an ARRAY.
// One upload can legitimately contain many invoices — a spreadsheet
// export with a row-group per invoice, a multi-page PDF holding several,
// a batch of photographed invoices — and the whole point is that they
// come back separated, never merged.
// =============================================

// The model is NOT declared here — it lives once in
// services/geminiClient.js so both scanners cannot drift onto different
// models. This file is only the prompt and the schema.

const INVOICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    invoices: {
      type: 'ARRAY',
      description: 'One entry per DISTINCT invoice found across all supplied files. Never merge two invoices into one entry.',
      items: {
        type: 'OBJECT',
        properties: {
          source: { type: 'STRING', description: 'Where this invoice came from, e.g. "pages 1-2", "photo 3", "rows 5-9". Short human-readable label.' },
          invoice_number: { type: 'STRING' },
          invoice_date: { type: 'STRING', description: 'YYYY-MM-DD.' },
          customer: {
            type: 'OBJECT',
            properties: {
              customer_name:   { type: 'STRING', description: 'The BUYER — the "Bill To" party. Not the seller issuing the invoice.' },
              gstin:           { type: 'STRING', description: '15-character buyer GSTIN, uppercase, no spaces.' },
              phone:           { type: 'STRING' },
              address:         { type: 'STRING', description: 'Buyer postal address as one line.' },
              state:           { type: 'STRING', description: 'Buyer state, full Indian state name e.g. "Tamil Nadu".' },
              place_of_supply: { type: 'STRING', description: 'Place of Supply if printed, full Indian state name. Otherwise "".' }
            },
            required: ['customer_name', 'gstin', 'phone', 'address', 'state', 'place_of_supply']
          },
          transport: {
            type: 'OBJECT',
            description: 'Transport details if the invoice carries them, otherwise all blank.',
            properties: {
              vehicle_number:   { type: 'STRING' },
              lr_number:        { type: 'STRING', description: 'Lorry receipt / consignment note number.' },
              transporter_name: { type: 'STRING' }
            },
            required: ['vehicle_number', 'lr_number', 'transporter_name']
          },
          products: {
            type: 'ARRAY',
            description: 'Every product line belonging to THIS invoice only.',
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
                gst_amount:          { type: 'NUMBER', nullable: true, description: 'Line tax amount, as printed.' },
                total:               { type: 'NUMBER', nullable: true, description: 'Line value including tax, as printed.' }
              },
              required: ['product_name', 'hsn_code', 'unit', 'quantity', 'rate',
                         'discount_percentage', 'gst_percentage', 'taxable_value', 'gst_amount', 'total']
            }
          }
        },
        required: ['source', 'invoice_number', 'invoice_date', 'customer', 'transport', 'products']
      }
    }
  },
  required: ['invoices']
};

// The separation rules carry most of the weight. Everything else is the
// same "copy, never guess" contract the bill prompt uses — see
// geminiBillPrompt.js for why an empty field beats a plausible one.
const INVOICE_PROMPT = `You are reading Indian GST sales invoices (tax invoices issued to customers).

Extract EVERY invoice you find into the required JSON structure.

SEPARATING INVOICES — THE MOST IMPORTANT RULE
The supplied files may contain more than one invoice. Return each one as
its own entry in the "invoices" array. NEVER merge two invoices, and
never split one invoice into two.

- MULTI-PAGE PDF: an invoice may span several pages. A new invoice
  begins where a new invoice number appears, or where a fresh header /
  "Tax Invoice" block starts. Pages 1-2 might be one invoice and pages
  3-4 another; put each in its own entry and set "source" to the page
  range, e.g. "pages 1-2".
- SPREADSHEET OR CSV: rows are usually grouped by invoice number. All
  rows sharing an invoice number belong to ONE invoice, and its
  "products" array holds one entry per row. A different invoice number
  means a different invoice. Set "source" to the row range.
- IMAGES: each image is exactly ONE invoice. Never combine two images
  into one invoice, even if they look similar. Set "source" to the image
  position, e.g. "photo 2".

WHOSE DETAILS TO EXTRACT
The customer is the BUYER — the "Bill To" / "Customer" party. Do NOT
return the seller / issuer / "From" party as the customer, even if their
details appear larger or first on the page.

ACCURACY RULES
- Copy values exactly as printed. Do not calculate, correct or infer any
  value that is not on the page.
- If a field is absent, unreadable, or you are not confident, return ""
  for text fields and null for numeric fields. NEVER guess. An empty
  value is always better than a plausible wrong one.
- GSTIN must be exactly 15 characters, uppercase, no spaces. If what you
  can see is not a complete 15-character GSTIN, return "".
- Dates must be YYYY-MM-DD. Indian invoices are almost always
  DD/MM/YYYY — read 05/07/2026 as 2026-07-05. If the date is ambiguous
  or unclear, return "".
- state and place_of_supply must be full Indian state names, e.g.
  "Tamil Nadu", "Karnataka".

PRODUCT LINES
- Return EVERY product row of EVERY invoice, in the order printed.
- Ignore non-product rows entirely: subtotals, tax summary rows, grand
  total, round-off, amount-in-words, terms, declarations, bank details,
  and any HSN-wise tax summary table.
- Strip leading serial numbers from product names ("1. Mixer" -> "Mixer").
- gst_percentage is the COMBINED rate for the line: if the invoice shows
  CGST 9% and SGST 9%, return 18.
- If a discount is shown in rupees rather than a percentage, and the
  percentage is not printed, return null for discount_percentage.

IGNORE
- QR codes, barcodes, IRN strings, digital signature blocks and logos.
- Any handwriting or stamp overlaying the printed invoice.

Return only the JSON.`;

module.exports = { INVOICE_SCHEMA, INVOICE_PROMPT };
