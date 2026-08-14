// Tests for the structured State + District address validation.
//
// The district register (shared/india-districts.js) is generated from the
// official LGD export and is shared byte-for-byte between the browser and
// the API, so these tests exercise the same data both layers use. Nothing
// here reaches a database or a network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const districts = require('../../shared/india-districts');
const { INDIA_DISTRICTS, districtsForState, isValidStateDistrict, canonicalDistrict } = districts;
const { validateCustomerPayload, validateProfilePayload, makeDistrictValidator } = require('../src/utils/validation');

// INDIAN_STATES read out of the shipped file, not restated — a test that
// keeps its own copy of the list cannot detect the list changing.
function readIndianStates() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'js', 'utilities', 'utils.js'), 'utf8');
  const start = src.indexOf('const INDIAN_STATES = [');
  return [...src.slice(start, src.indexOf('];', start)).matchAll(/'([^']+)'/g)].map(m => m[1]);
}

// ── A. Dataset shape and coverage ───────────────────
test('A1 the register covers all 36 states and union territories', () => {
  assert.strictEqual(Object.keys(INDIA_DISTRICTS).length, 36);
});

test('A2 the register holds the 785 districts the LGD export contains', () => {
  const total = Object.values(INDIA_DISTRICTS).reduce((n, list) => n + list.length, 0);
  assert.strictEqual(total, 785);
});

// The drift guard. A state added to the dropdown without district data
// would present an empty District list and look like a UI fault.
test('A3 every INDIAN_STATES entry has district data', () => {
  const missing = readIndianStates().filter(s => !INDIA_DISTRICTS[s] || !INDIA_DISTRICTS[s].length);
  assert.deepStrictEqual(missing, [], `states with no districts: ${missing.join(', ')}`);
});

test('A4 the register names no state the dropdown does not offer', () => {
  const known = new Set(readIndianStates());
  const unknown = Object.keys(INDIA_DISTRICTS).filter(s => !known.has(s));
  assert.deepStrictEqual(unknown, [], `unknown states: ${unknown.join(', ')}`);
});

test('A5 no district is blank or duplicated within its state', () => {
  for (const [state, list] of Object.entries(INDIA_DISTRICTS)) {
    assert.ok(list.every(d => d && d.trim()), `${state} has a blank district`);
    assert.strictEqual(new Set(list).size, list.length, `${state} has a duplicate district`);
  }
});

// ── B. The pairs the requirement names ──────────────
test('B1 Tamil Nadu + Tiruppur is valid', () => {
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', 'Tiruppur'), true);
});

test('B2 Kerala + Tiruppur is invalid', () => {
  assert.strictEqual(isValidStateDistrict('Kerala', 'Tiruppur'), false);
});

test('B3 Kerala + Palakkad is valid', () => {
  assert.strictEqual(isValidStateDistrict('Kerala', 'Palakkad'), true);
});

test('B4 Tamil Nadu + Palakkad is invalid', () => {
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', 'Palakkad'), false);
});

test('B5 Tamil Nadu + Coimbatore is valid, Kerala + Coimbatore is not', () => {
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', 'Coimbatore'), true);
  assert.strictEqual(isValidStateDistrict('Kerala', 'Coimbatore'), false);
});

// ── C. A district name shared by two states ─────────
// Bilaspur is a district of Himachal Pradesh AND of Chhattisgarh. Because
// the question asked is "does this district belong to the selected state"
// rather than "which state owns this district", both pass and neither is
// told it belongs somewhere else.
test('C1 Bilaspur is valid in Himachal Pradesh and in Chhattisgarh', () => {
  assert.strictEqual(isValidStateDistrict('Himachal Pradesh', 'Bilaspur'), true);
  assert.strictEqual(isValidStateDistrict('Chhattisgarh', 'Bilaspur'), true);
});

test('C2 a shared district is still refused by a state that has no such district', () => {
  assert.strictEqual(isValidStateDistrict('Kerala', 'Bilaspur'), false);
});

test('C3 Hamirpur and Pratapgarh are likewise valid in more than one state', () => {
  assert.strictEqual(isValidStateDistrict('Himachal Pradesh', 'Hamirpur'), true);
  assert.strictEqual(isValidStateDistrict('Uttar Pradesh', 'Hamirpur'), true);
  assert.strictEqual(isValidStateDistrict('Uttar Pradesh', 'Pratapgarh'), true);
  assert.strictEqual(isValidStateDistrict('Rajasthan', 'Pratapgarh'), true);
});

// ── D. Blank values, which must never block a save ──
test('D1 an empty district is valid for any state', () => {
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', ''), true);
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', null), true);
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', undefined), true);
});

test('D2 with no state selected there is nothing to judge, so it passes', () => {
  assert.strictEqual(isValidStateDistrict('', 'Tiruppur'), true);
  assert.strictEqual(isValidStateDistrict(null, 'Tiruppur'), true);
});

test('D3 an unrecognised state does not manufacture a mismatch', () => {
  assert.strictEqual(isValidStateDistrict('Atlantis', 'Tiruppur'), true);
});

// ── E. Spelling and spacing ─────────────────────────
test('E1 district matching ignores case', () => {
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', 'tiruppur'), true);
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', 'TIRUPPUR'), true);
});

test('E2 surrounding whitespace is ignored', () => {
  assert.strictEqual(isValidStateDistrict('Tamil Nadu', '  Tiruppur  '), true);
});

test('E3 canonicalDistrict returns the register spelling', () => {
  assert.strictEqual(canonicalDistrict('Tamil Nadu', 'TIRUPPUR'), 'Tiruppur');
  assert.strictEqual(canonicalDistrict('Kerala', 'palakkad'), 'Palakkad');
  assert.strictEqual(canonicalDistrict('Kerala', 'Tiruppur'), '');
});

test('E4 a state whose LGD spelling differs still resolves', () => {
  // LGD writes "Jammu And Kashmir" and "The Dadra And Nagar Haveli...";
  // the register is keyed by the application's own spelling.
  assert.ok(districtsForState('Jammu and Kashmir').length > 0);
  assert.ok(districtsForState('Dadra and Nagar Haveli and Daman and Diu').length > 0);
  assert.ok(districtsForState('Andaman and Nicobar Islands').length > 0);
});

test('E5 state lookup tolerates case drift in stored data', () => {
  assert.strictEqual(districtsForState('tamil nadu').length, districtsForState('Tamil Nadu').length);
});

// ── F. Districts LGD has that other sources miss ────
// These are the exact records the rejected Wikidata dataset got wrong, so
// they double as a check that the LGD export is what actually shipped.
test('F1 Delhi has its 11 districts', () => {
  assert.strictEqual(districtsForState('Delhi').length, 11);
});

test('F2 Puducherry has all four districts including the exclaves', () => {
  const d = districtsForState('Puducherry');
  assert.strictEqual(d.length, 4);
  ['Puducherry', 'Karaikal', 'Mahe', 'Yanam'].forEach(x => assert.ok(d.includes(x), `missing ${x}`));
});

// ── G. Backend enforcement ──────────────────────────
test('G1 the API refuses a customer whose district is in another state', () => {
  const r = validateCustomerPayload({ name: 'X', phone: '9876543210', state: 'Kerala', district: 'Tiruppur' });
  assert.strictEqual(r.valid, false);
  assert.match(r.errors.district, /not a district of Kerala/);
});

test('G2 the API accepts the same customer once the state matches', () => {
  const r = validateCustomerPayload({ name: 'X', phone: '9876543210', state: 'Tamil Nadu', district: 'Tiruppur' });
  assert.strictEqual(r.valid, true);
});

test('G3 the Ship-To address is checked against its own state', () => {
  const r = validateCustomerPayload({
    name: 'X', phone: '9876543210', state: 'Tamil Nadu',
    shipping_state: 'Kerala', shipping_district: 'Salem'
  });
  assert.strictEqual(r.valid, false);
  assert.match(r.errors.shipping_district, /not a district of Kerala/);
});

test('G4 the business profile is checked the same way', () => {
  assert.strictEqual(validateProfilePayload({ state: 'Kerala', district: 'Tiruppur' }).valid, false);
  assert.strictEqual(validateProfilePayload({ state: 'Kerala', district: 'Palakkad' }).valid, true);
});

test('G5 a challan checks its from and to addresses independently', () => {
  const validate = makeDistrictValidator([['from_state', 'from_district'], ['to_state', 'to_district']]);
  const r = validate({ from_state: 'Tamil Nadu', from_district: 'Tiruppur', to_state: 'Kerala', to_district: 'Coimbatore' });
  assert.strictEqual(r.valid, false);
  assert.ok(!r.errors.from_district, 'the valid From pair must not be flagged');
  assert.match(r.errors.to_district, /not a district of Kerala/);
});

// ── H. Existing records keep working ────────────────
// The reason District is presence-based: these tables hold years of rows
// written before the column existed, and several forms legitimately send
// a partial payload.
test('H1 a payload with no district at all is accepted', () => {
  assert.strictEqual(validateProfilePayload({ state: 'Kerala' }).valid, true);
  assert.strictEqual(validateCustomerPayload({ name: 'X', phone: '9876543210', state: 'Kerala' }).valid, true);
});

test('H2 an empty district clears rather than blocks', () => {
  assert.strictEqual(validateProfilePayload({ state: 'Kerala', district: '' }).valid, true);
});

test('H3 a partial update that never mentions district is untouched', () => {
  const validate = makeDistrictValidator([['state', 'district']]);
  assert.strictEqual(validate({ payment_status: 'paid' }).valid, true);
});

test('H4 a district sent without a state is not judged', () => {
  const validate = makeDistrictValidator([['state', 'district']]);
  assert.strictEqual(validate({ district: 'Tiruppur' }).valid, true);
});

// ── I. GST behaviour must be untouched ──────────────
// District is an address field. If any of these change, something has
// reached into the tax logic and must be backed out.
test('I1 GSTIN validation is unchanged', () => {
  const { validateGstin } = require('../src/utils/validation');
  assert.strictEqual(validateGstin('33AARFV8415B1Z4').valid, true);
  assert.strictEqual(validateGstin('33AARFV8415B1Z5').valid, false);
  assert.strictEqual(validateGstin('99AARFV8415B1Z4').reason, 'state_code');
});

test('I2 the district register defines no GST state code', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'shared', 'india-districts.js'), 'utf8');
  assert.ok(!/GSTR1_STATE_CODES|place_of_supply|supply_type|igst|cgst|sgst/i.test(src),
    'the district register must not reference GST logic');
});

test('I3 no district column was added to a GST calculation path', () => {
  const gstr1 = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'js', 'gst', 'gstr1-export.js'), 'utf8');
  assert.ok(!/district/i.test(gstr1), 'the GSTR-1 exporter must not know about districts');
});
