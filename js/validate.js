// =============================================
// Shared Validation Helpers
// Used by the Excel Import pipeline (js/import.js) to surface
// warnings without blocking a row from being imported — the
// caller decides whether to skip or force-import flagged rows.
// =============================================

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function isValidGSTIN(gstin) {
  return !!gstin && GSTIN_REGEX.test(String(gstin).toUpperCase());
}

// Validate one normalized invoice row.
// existingKeys: { invoiceNumbers: Set<string>, gstinInvoicePairs: Set<string> }
//   built once per import batch (existing DB rows + rows already accepted in this batch)
// Returns { warnings: string[] } — never blocks; caller decides.
function validateInvoiceRow(row, existingKeys) {
  const warnings = [];

  if (!row.invoiceNumber) warnings.push('Missing invoice number');
  if (!row.invoiceDate)   warnings.push('Missing invoice date');
  if (row.gstPct === '' || row.gstPct === null || row.gstPct === undefined) warnings.push('Missing GST %');
  if (!row.hsnCode && row.requireHSN) warnings.push('Missing HSN code');
  if (!isFinite(row.taxableAmount) || row.taxableAmount < 0) warnings.push('Negative or invalid taxable value');

  if (row.gstin && !isValidGSTIN(row.gstin)) warnings.push('Invalid GSTIN format');

  if (row.invoiceNumber && existingKeys?.invoiceNumbers?.has(row.invoiceNumber)) {
    warnings.push('Duplicate invoice number');
  }
  if (row.gstin && row.invoiceNumber) {
    const pair = `${row.gstin}::${row.invoiceNumber}`;
    if (existingKeys?.gstinInvoicePairs?.has(pair)) warnings.push('Duplicate GSTIN + invoice number combination');
  }

  return { warnings, hasWarnings: warnings.length > 0 };
}

// Build the lookup sets used above from existing DB rows for a user.
function buildExistingKeys(existingRows) {
  const invoiceNumbers = new Set();
  const gstinInvoicePairs = new Set();
  (existingRows || []).forEach(r => {
    const num = r.invoice_number || r.invoiceNumber;
    const gstin = r.gst_number || r.gstin;
    if (num) invoiceNumbers.add(num);
    if (gstin && num) gstinInvoicePairs.add(`${gstin}::${num}`);
  });
  return { invoiceNumbers, gstinInvoicePairs };
}

// Register a row's keys into the running set once it's accepted into the batch,
// so later duplicate rows within the *same* import file are also caught.
function registerRowKeys(row, existingKeys) {
  if (row.invoiceNumber) existingKeys.invoiceNumbers.add(row.invoiceNumber);
  if (row.gstin && row.invoiceNumber) existingKeys.gstinInvoicePairs.add(`${row.gstin}::${row.invoiceNumber}`);
}
