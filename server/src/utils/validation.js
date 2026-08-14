// Server-side mirror of js/utils.js's GSTIN checksum validator (kept in
// lockstep intentionally — frontend and backend are separate JS
// runtimes with no shared bundle, so this is a deliberate port, not
// duplication for its own sake) plus the field-level rules for
// Customer Master. The frontend already blocks an invalid submission
// before it's ever sent; this is the defense-in-depth backstop for
// anything that reaches the API directly (Never rely only on frontend
// validation).
const validator = require('validator');
// The SAME district master the browser loads — see shared/india-districts.js.
// Not a port: one file, both runtimes, so the API can only accept a
// State + District pair the dropdown could actually have produced.
const { isValidStateDistrict } = require('../../../shared/india-districts');

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

// Customer Master carries two addresses — the billing one and Ship To —
// so it has two State/District pairs to keep consistent.
const CUSTOMER_DISTRICT_PAIRS = [['state', 'district'], ['shipping_state', 'shipping_district']];

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

  Object.assign(errors, validateDistrictPairs(payload, CUSTOMER_DISTRICT_PAIRS));

  return { valid: Object.keys(errors).length === 0, errors };
}

// Reduces a phone number as a person would write it to the ten digits it
// actually is: separators removed, and the two prefixes that are not part
// of the subscriber number dropped — a +91 country code and the single
// leading 0 of an STD dial-out.
//
// This exists because the Business Profile form had NO phone rule until
// now, so profiles were saved with whatever the user typed —
// "+91 44 4000 1234", "98430 12345". Judging those strings by /^\d{10}$/
// made every such profile permanently unsavable: the user reopens the
// modal, changes something else entirely, and Save is refused over a
// field they never touched.
//
// It is deliberately NOT a relaxation. The rule is still exactly ten
// digits — "12345" and "98430123456" stay invalid. What changed is that
// the check now looks at the number rather than at its punctuation.
//
// Scoped to profiles on purpose: validateCustomerPayload keeps the plain
// /^\d{10}$/ it has always had, because Customer Master has enforced that
// rule since its first write and its data was created under it.
function normalizeIndianPhone(value) {
  let digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// Business GST Profile — the same field rules the Business Profile form
// applies in client/js/pages/profile.js, enforced again here so a caller
// that reaches the API directly cannot store a blank business name or a
// GSTIN that would later be rejected by the GST portal.
//
// Every rule fires only when its own field is actually part of the
// payload. That is not laxity, it is the shape of this table: `profiles`
// is written by four different forms and three of them legitimately send
// a partial row — invoice numbering (invoice_* columns), Company Branding
// (logo/seal/bank columns) and the invoice-entry auto-number toggle (one
// boolean). Demanding business_name on every write would break all three.
// Same lesson validateProductPayload() encodes for a PATCH that never
// mentions hsn_code: a field the payload does not carry is a field the
// payload is not changing.
//
// Requiredness of business_name + gstin therefore lives where it is
// actually true — the Business Profile form, which sends both on every
// save and blocks submission without them. What this function guarantees
// is the stronger and more portable half: whatever value does arrive for
// one of these columns is a valid one.
function validateProfilePayload(payload) {
  const errors = {};
  const has = f => Object.prototype.hasOwnProperty.call(payload, f);
  const str = f => (payload[f] == null ? '' : String(payload[f])).trim();

  if (has('business_name') && !str('business_name')) {
    errors.business_name = 'Business / Trade Name is required.';
  }

  if (has('gstin')) {
    const gstin = str('gstin').toUpperCase();
    if (!gstin) errors.gstin = 'GSTIN is required.';
    else if (!validateGstin(gstin).valid) errors.gstin = 'Enter a valid 15-character GSTIN.';
  }

  // Optional fields: empty stays allowed, a value must be well-formed.
  if (has('phone') && str('phone') && !isValidPhone(normalizeIndianPhone(str('phone')))) {
    errors.phone = 'Phone number must be exactly 10 digits.';
  }

  if (has('email') && str('email') && !validator.isEmail(str('email'))) {
    errors.email = 'Enter a valid email address.';
  }

  if (has('pan') && str('pan') && !PAN_FORMAT_REGEX.test(str('pan').toUpperCase())) {
    errors.pan = 'PAN must be 10 characters, e.g. ABCDE1234F.';
  }

  Object.assign(errors, validateDistrictPairs(payload, [['state', 'district']]));

  return { valid: Object.keys(errors).length === 0, errors };
}

// A validate() for a table whose only field rule is the District/State
// pair. Built rather than written out per table so adding District to
// another entity is one line in the table registry, not another copy of
// this function.
function makeDistrictValidator(pairs) {
  return function (payload) {
    const errors = validateDistrictPairs(payload, pairs);
    return { valid: Object.keys(errors).length === 0, errors };
  };
}

// Address District, checked against the State on the same record.
//
// `pairs` names the columns to check, because the tables disagree about
// what they call them: customers carries both state/district and
// shipping_state/shipping_district, delivery_challans has from_ and to_,
// and self_invoices calls its column supplier_state. Passing the pairs in
// keeps that knowledge in the table registry (routes/generic.js) rather
// than duplicating it here.
//
// Presence-based, exactly as validateProfilePayload is and for the same
// reason: these rows are written by several forms, and a PATCH that never
// mentions district is not changing it. A payload carrying a district but
// no state reads the state it is being compared against from... nowhere,
// so it cannot be judged — see the note in shared/india-districts.js about
// why that passes rather than fails.
function validateDistrictPairs(payload, pairs) {
  const errors = {};
  const has = f => Object.prototype.hasOwnProperty.call(payload, f);
  const str = f => (payload[f] == null ? '' : String(payload[f])).trim();

  pairs.forEach(([stateCol, districtCol]) => {
    if (!has(districtCol)) return;          // not being written — not our business
    const district = str(districtCol);
    if (!district) return;                  // clearing or leaving blank is allowed
    if (!has(stateCol)) return;             // no state in this payload to judge against
    const state = str(stateCol);
    if (!state) return;
    if (!isValidStateDistrict(state, district)) {
      errors[districtCol] = `${district} is not a district of ${state}.`;
    }
  });

  return errors;
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
// isInsert distinguishes creating a product from amending one, because
// the two have different obligations:
//
//   creating   the product must arrive complete — an HSN is mandatory,
//              exactly as before.
//   amending   a partial update validates what it actually writes. A
//              PATCH that never mentions hsn_code is not changing it,
//              and demanding one made it impossible to correct any
//              other field on a synced product, whose catalogue columns
//              (hsn_code among them) are owned by the feed and are
//              deliberately left out of the payload.
function validateProductPayload(payload, isInsert) {
  const errors = {};
  if ((payload.source || '') === 'synced') return { valid: true, errors };

  if (!isInsert && !Object.prototype.hasOwnProperty.call(payload, 'hsn_code')) {
    return { valid: true, errors };
  }

  const hsn = (payload.hsn_code || '').trim();
  if (!hsn || !HSN_FORMAT_REGEX.test(hsn)) {
    errors.hsn_code = 'HSN Code is mandatory and must be 4, 6 or 8 digits.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = {
  validateGstin, isValidPhone, normalizeIndianPhone,
  validateCustomerPayload, validateProductPayload, validateProfilePayload,
  validateDistrictPairs, makeDistrictValidator
};
