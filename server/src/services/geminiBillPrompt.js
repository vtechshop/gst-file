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

// The model is NOT declared here — it lives once in
// services/geminiClient.js so both scanners cannot drift onto different
// models. This file is only the prompt and the schema.

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
        state:       { type: 'STRING', description: 'Indian state of the supplier, full name e.g. "Tamil Nadu".' },
        phone:       { type: 'STRING', description: 'Supplier phone/mobile as printed, digits only.' },
        email:       { type: 'STRING', description: 'Supplier email address as printed.' }
      },
      required: ['vendor_name', 'gstin', 'address', 'state', 'phone', 'email']
    },
    purchase: {
      type: 'OBJECT',
      properties: {
        purchase_number: { type: 'STRING', description: 'The supplier bill/invoice number exactly as printed.' },
        purchase_date:   { type: 'STRING', description: 'Bill date as YYYY-MM-DD.' },
        // Deliberately a plain STRING, not an enum. Gemini's Schema.enum
        // requires format:"enum" and every member to be a real value —
        // it cannot express "one of these, or blank if the bill does not
        // say". A strict enum would force the model to pick intrastate
        // or interstate even when it cannot tell, which is exactly the
        // guessing the rest of this prompt forbids. The permitted values
        // are stated below and enforced by normalise() in
        // routes/bill-scan.js, which blanks anything else.
        supply_type:     { type: 'STRING', description: 'Exactly "intrastate" if CGST+SGST are charged, exactly "interstate" if IGST is charged, or "" if the bill does not make it clear.' }
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
          product_description: { type: 'STRING', description: 'Any extra description printed under or beside the product name. "" if none.' },
          hsn_code:            { type: 'STRING', description: 'HSN/SAC code, digits only.' },
          unit:                { type: 'STRING', description: 'Unit of measure, e.g. NOS, KG, PCS.' },
          quantity:            { type: 'NUMBER', nullable: true },
          rate:                { type: 'NUMBER', nullable: true, description: 'Per-unit rate before tax.' },
          discount_amount:     { type: 'NUMBER', nullable: true, description: 'Discount in rupees, if printed as an amount.' },
          discount_percentage: { type: 'NUMBER', nullable: true },
          taxable_value:       { type: 'NUMBER', nullable: true, description: 'Line value before tax, as printed.' },
          gst_percentage:      { type: 'NUMBER', nullable: true, description: 'Total GST rate for the line (CGST+SGST combined, or IGST).' },
          cgst_percentage:     { type: 'NUMBER', nullable: true },
          cgst_amount:         { type: 'NUMBER', nullable: true },
          sgst_percentage:     { type: 'NUMBER', nullable: true },
          sgst_amount:         { type: 'NUMBER', nullable: true },
          igst_percentage:     { type: 'NUMBER', nullable: true },
          igst_amount:         { type: 'NUMBER', nullable: true },
          cess_amount:         { type: 'NUMBER', nullable: true },
          line_total:          { type: 'NUMBER', nullable: true, description: 'Line value including tax, as printed.' },
          // How sure you are you read THAT figure correctly, 0..1.
          // Anything below 0.75 is discarded server-side and left blank,
          // so an honest low score is always better than a confident
          // guess — a blank box gets checked, a wrong number gets saved.
          qty_confidence:      { type: 'NUMBER', nullable: true, description: '0..1 confidence in quantity.' },
          rate_confidence:     { type: 'NUMBER', nullable: true, description: '0..1 confidence in rate.' },
          taxable_confidence:  { type: 'NUMBER', nullable: true, description: '0..1 confidence in taxable_value.' },
          gst_confidence:      { type: 'NUMBER', nullable: true, description: '0..1 confidence in gst_percentage.' }
        },
        required: ['product_name', 'product_description', 'hsn_code', 'unit', 'quantity', 'rate',
                   'discount_amount', 'discount_percentage', 'taxable_value', 'gst_percentage',
                   'cgst_percentage', 'cgst_amount', 'sgst_percentage', 'sgst_amount',
                   'igst_percentage', 'igst_amount', 'cess_amount', 'line_total',
                   'qty_confidence', 'rate_confidence', 'taxable_confidence', 'gst_confidence']
      }
    },
    // The bill's own summary block. Extracted so the review screen can
    // show what the document actually printed next to what this app
    // computes — a mismatch is the fastest way to spot a misread line.
    // These are never saved; savePurchase() stores the app's own figures.
    totals: {
      type: 'OBJECT',
      description: 'The summary block at the foot of the bill. Search the whole document for these.',
      properties: {
        subtotal:      { type: 'NUMBER', nullable: true },
        taxable_value: { type: 'NUMBER', nullable: true },
        cgst_amount:   { type: 'NUMBER', nullable: true },
        sgst_amount:   { type: 'NUMBER', nullable: true },
        igst_amount:   { type: 'NUMBER', nullable: true },
        cess_amount:   { type: 'NUMBER', nullable: true },
        round_off:     { type: 'NUMBER', nullable: true },
        grand_total:   { type: 'NUMBER', nullable: true, description: 'Final payable amount / Invoice Total.' },
        taxable_confidence:     { type: 'NUMBER', nullable: true, description: '0..1 confidence in taxable_value.' },
        gst_confidence:         { type: 'NUMBER', nullable: true, description: '0..1 confidence in the tax amounts.' },
        grand_total_confidence: { type: 'NUMBER', nullable: true, description: '0..1 confidence in grand_total.' }
      },
      required: ['subtotal', 'taxable_value', 'cgst_amount', 'sgst_amount',
                 'igst_amount', 'cess_amount', 'round_off', 'grand_total',
                 'taxable_confidence', 'gst_confidence', 'grand_total_confidence']
    }
  },
  required: ['vendor', 'purchase', 'products', 'totals']
};

// Two rules carry most of the weight here:
//   • "leave it blank" — a guessed GSTIN or invoice number is worse than
//     an empty box, because an empty box is visibly incomplete whereas a
//     plausible wrong value gets saved.
//   • "supplier, not buyer" — a purchase bill names both companies, and
//     the buyer is usually the more prominent of the two. Without this,
//     the model reliably returns the user's own business as the vendor.
const BILL_PROMPT = `You are an expert GST purchase bill extraction engine for Indian
invoices. Extract EVERY field exactly as printed into the required JSON.

Many of these bills are HANDWRITTEN. Read handwritten text carefully —
handwritten amounts, quantities and GST values matter exactly as much as
printed ones and must never be skipped.

WHOSE DETAILS TO EXTRACT
The vendor is the SUPPLIER / SELLER who issued this bill — the party the
money is paid TO. Never return the buyer / "Bill To" / "Ship To" party as
the vendor, even if their details appear larger or first on the page.

ACCURACY RULES
- Prefer a value PRINTED on the document over anything inferred.
- Never recalculate a value that is already printed. Copy it.
- If a field is genuinely absent or unreadable, return "" for text and
  null for numbers. Never invent a value. But do NOT leave a field blank
  when it is clearly visible on the bill — read it.
- GSTIN must be exactly 15 characters, uppercase, no spaces. If what you
  can see is not a complete 15-character GSTIN, return "".
- Dates must be YYYY-MM-DD. Indian bills are almost always DD/MM/YYYY —
  read 05/07/2026 as 2026-07-05. If the date is ambiguous, return "".
- state must be a full Indian state name, e.g. "Tamil Nadu", "Karnataka".

ACCURACY BEATS COMPLETENESS
A blank field gets checked by a human. A wrong number gets saved and
becomes a wrong tax return. When those two conflict, return the blank.

QUANTITY — NEVER GUESSED
Quantity is a bare number. Strip any unit written beside it:
  "1", "1 No", "1 Nos", "1 Pc", "1 Piece"  ->  quantity = 1
Put the unit in the "unit" field instead.
- If the quantity is unclear, smudged, overwritten or absent, return
  null. Do NOT fall back to 1.
- NEVER infer quantity from an amount. If the line shows only a value,
  that tells you nothing about how many units were bought.
- Never return 2 when the bill shows 1.

RATE
If the rate column is empty but the line's taxable value is printed AND
the quantity is known:
  - quantity 1  ->  rate = that taxable value
  - otherwise   ->  rate = taxable value / quantity
This is reading the bill's own arithmetic, not guessing. If the quantity
is NOT known, leave rate null — dividing by an assumed quantity invents a
price.

SINGLE-PRODUCT CONSISTENCY
When the invoice has exactly ONE product line and quantity is 1 with no
discount, rate, taxable_value and the line total must agree. Example:
quantity 1, taxable 17966.10 -> rate must be 17966.10. If your first
reading disagrees, re-read that line before answering.

NUMBERS OUTRANK WORDS
Financial figures matter more than descriptions. If a smudge forces a
choice between reading the product name and reading the amount, spend
the effort on the amount.

GST DETECTION
- If a GST % is printed, return it exactly.
- gst_percentage is the COMBINED rate for the line: CGST 9% + SGST 9%
  means gst_percentage = 18.
- If no GST % is printed but CGST/SGST/IGST AMOUNTS are visible, derive
  the percentage from the taxable value. Example: taxable 17966.10,
  CGST 1616.95, SGST 1616.95 -> gst_percentage = 18, cgst_percentage = 9,
  sgst_percentage = 9.
- Never return 0 for GST when GST amounts are visible on the bill.

PRODUCT LINES — CLASSIFY BY POSITION, NOT JUST WORDS
- Return EVERY product row from EVERY page, in the order printed.
- Decide what is a product using the row's PLACE IN THE TABLE first:
  a product row sits inside the itemised grid, has a description in the
  item column, and normally carries a quantity or a rate. The summary
  block sits BELOW the last item row, is usually right-aligned, spans
  fewer columns, and has no item description.
- Any row in that summary block — Subtotal, Taxable Value, CGST, SGST,
  IGST, CESS, Round Off, Grand Total, Balance — is NEVER a product, even
  when it carries the largest figure on the page. Its numbers belong in
  "totals". Keyword matching alone is not enough; a row sitting under the
  grid with only an amount is a summary row whatever it is labelled.
- Also exclude amount-in-words, terms, declarations, bank details and any
  HSN-wise tax summary table.
- Strip leading serial numbers from product names ("1. Mixer" -> "Mixer").
- Put extra wording printed under or beside the name into
  product_description, not into product_name.
- Record a rupee discount in discount_amount and a percentage discount in
  discount_percentage. If only one is printed, leave the other null.

TOTALS — HIGH PRIORITY
Financial values matter more than descriptions. Search the WHOLE bill,
including the foot of the last page, for: Subtotal, Taxable Value, CGST,
SGST, IGST, CESS, Round Off, Grand Total / Invoice Total. If a figure is
visible anywhere on the bill, extract it exactly. Never leave the grand
total null when it is printed.

IGNORE
- QR codes, barcodes, IRN strings, digital signature blocks and logos.

BEFORE YOU ANSWER — SECOND PASS ON THE MONEY
Having drafted an answer, go back over the document once more and re-read
ONLY these: quantity, rate, taxable value, GST %, CGST, SGST, IGST and
grand total. Handwriting is easy to misread the first time. If the second
reading is clearer than the first, keep the second reading.

Then check the arithmetic:
    taxable + CGST + SGST + IGST + CESS ± round off  ≈  grand total
If that does not hold within a rupee or two, the financial section has
been misread. Re-read it before answering, and lower your confidence on
whichever figures you are still unsure of.

CONFIDENCE SCORES
For every financial field with a *_confidence property, return how sure
you are that you read THAT figure correctly, from 0 to 1:
  1.0  = crisp, unambiguous, cross-checks with the rest of the bill
  0.75 = legible, no real doubt
  0.5  = plausible but a digit could be wrong
  0.2  = barely legible, largely a guess
Score honestly. Anything below 0.75 is discarded and shown to the user as
blank, which is the correct outcome for a figure you cannot actually
read. Do not inflate a score to make a field survive.

Return only the JSON.`;

module.exports = { BILL_SCHEMA, BILL_PROMPT };
