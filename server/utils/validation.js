// Server-side mirror of js/utils.js's GSTIN checksum validator (kept in
// lockstep intentionally — frontend and backend are separate JS
// runtimes with no shared bundle, so this is a deliberate port, not
// duplication for its own sake) plus the field-level rules for
// Customer Master. The frontend already blocks an invalid submission
// before it's ever sent; this is the defense-in-depth backstop for
// anything that reaches the API directly (Never rely only on frontend
// validation).
const validator = require('validator');

const GST_VALID_STATE_CODES = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '25', '26', '27', '28', '29', '30',
  '31', '32', '33', '34', '35', '36', '37', '38'
]);
const PAN_FORMAT_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function gstinCheckDigit(first14) {
  const mod = GSTIN_ALPHABET.length;
  let factor = 2, sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    const codePoint = GSTIN_ALPHABET.indexOf(first14[i]);
    let digit = factor * codePoint;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
    factor = factor === 2 ? 1 : 2;
  }
  return GSTIN_ALPHABET[(mod - (sum % mod)) % mod];
}

function validateGstin(value) {
  const v = (value || '').trim().toUpperCase();
  if (!v) return { valid: false, reason: 'empty' };
  if (v.length !== 15) return { valid: false, reason: 'length' };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return { valid: false, reason: 'format' };
  if (!GST_VALID_STATE_CODES.has(v.slice(0, 2))) return { valid: false, reason: 'state_code' };
  if (!PAN_FORMAT_REGEX.test(v.slice(2, 12))) return { valid: false, reason: 'pan' };
  if (gstinCheckDigit(v.slice(0, 14)) !== v[14]) return { valid: false, reason: 'checksum' };
  return { valid: true };
}

function isValidPhone(value) {
  return /^\d{10}$/.test((value || '').trim());
}

// Customer Master — Customer Name / Phone / State required; GSTIN and
// Email optional but must be well-formed if provided.
function validateCustomerPayload(payload) {
  const errors = {};
  const name = (payload.name || '').trim();
  const phone = (payload.phone || '').trim();
  const state = (payload.state || '').trim();
  const gstin = (payload.gstin || '').trim();
  const email = (payload.email || '').trim();

  if (!name) errors.name = 'Customer name is required.';

  if (!phone) errors.phone = 'Phone number is required.';
  else if (!isValidPhone(phone)) errors.phone = 'Phone number must be exactly 10 digits.';

  if (!state) errors.state = 'State is required.';

  if (gstin && !validateGstin(gstin).valid) errors.gstin = 'Invalid GSTIN.';

  if (email && !validator.isEmail(email)) errors.email = 'Invalid email address.';

  return { valid: Object.keys(errors).length === 0, errors };
}

// GSTN accepts 4/6/8-digit HSN codes — same shape rule the frontend applies
// in isValidHsnFormat() (js/utils.js).
const HSN_FORMAT_REGEX = /^(\d{4}|\d{6}|\d{8})$/;

// HSN is mandatory on every product write EXCEPT those from Product Sync.
//
// Product Sync (source 'synced') is the single exemption: the company's
// website catalog legitimately contains items with no HSN, and those must
// keep importing exactly as before — enforcing the rule there would fail
// every sync run for such an item.
//
// The test is deliberately "is it synced?" rather than "is it local?".
// Keying off 'local' would let a payload with a missing, empty or unexpected
// `source` slip through unvalidated, which is the weaker default: a caller
// that forgets the field would silently bypass the rule. Requiring an
// explicit 'synced' to opt out means anything else — including undefined —
// is validated.
function validateProductPayload(payload) {
  const errors = {};
  if ((payload.source || '') === 'synced') return { valid: true, errors };

  const hsn = (payload.hsn_code || '').trim();
  if (!hsn || !HSN_FORMAT_REGEX.test(hsn)) {
    errors.hsn_code = 'HSN Code is mandatory and must be 4, 6 or 8 digits.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = { validateGstin, isValidPhone, validateCustomerPayload, validateProductPayload };
