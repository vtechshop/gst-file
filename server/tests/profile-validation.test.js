// Tests for Business GST Profile validation — the browser-side form rules
// (client/js/pages/profile.js) and the server-side backstop
// (server/src/utils/validation.js), plus the per-field error envelope that
// carries one to the other.
//
// The frontend half runs the SHIPPED profile.js unmodified inside a `vm`
// context, the same technique and for the same reason as
// helpers/browser-context.js: these are plain <script> files with no module
// system, and appending a CommonJS shim to them would put test scaffolding
// into production. A local harness is used rather than the shared one
// because that helper's file list is fixed to the GSTR-1 chain, and its
// element stub deliberately no-ops classList/setAttribute — this suite has
// to assert on exactly those.
//
// No database, no network, no production data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { validateProfilePayload } = require('../src/utils/validation');
const { errorHandler } = require('../src/middleware/errorHandler');

const CLIENT_JS = path.resolve(__dirname, '..', '..', 'client', 'js');

// ── Frontend harness ───────────────────────────────────────────────

// An element stub that actually remembers what was done to it, because
// "was the field highlighted?" and "was aria-invalid set?" are the
// assertions this suite exists to make.
function makeField(tag) {
  return {
    tagName: tag || 'INPUT',
    value: '',
    textContent: '',
    focused: false,
    attributes: {},
    classes: new Set(),
    style: {},
    classList: {
      add(c) { this._o.classes.add(c); },
      remove(c) { this._o.classes.delete(c); },
      contains(c) { return this._o.classes.has(c); },
      toggle(c, on) { if (on) this._o.classes.add(c); else this._o.classes.delete(c); }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    focus() { this.focused = true; },
    addEventListener() {}, removeEventListener() {}
  };
}
function newField(tag) {
  const el = makeField(tag);
  el.classList._o = el;
  return el;
}

// Every id the profile form's validation touches.
const FIELD_IDS = [
  'profBizName', 'profGSTIN', 'profPAN', 'profPhone', 'profEmail',
  'profBizNameError', 'profGSTINError', 'profPANError', 'profPhoneError', 'profEmailError'
];

function loadProfileForm(values = {}) {
  const elements = new Map();
  FIELD_IDS.forEach(id => elements.set(id, newField()));
  Object.keys(values).forEach(id => {
    if (!elements.has(id)) elements.set(id, newField());
    elements.get(id).value = values[id];
  });

  const toasts = [];
  const ctx = {
    console, Date, Math, JSON, RegExp, String, Number, Boolean, Object, Array,
    Set, Map, Promise, Error, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    document: {
      getElementById: id => (elements.has(id) ? elements.get(id) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => newField(),
      addEventListener() {}, removeEventListener() {},
      body: newField(), documentElement: newField()
    },
    window: { location: { pathname: '/customers.html', href: '' }, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    URLSearchParams, Blob: function Blob() {}, FormData: function FormData() {},
    alert() {}, confirm: () => true,
    showToast: (msg, type) => toasts.push({ msg, type }),
    handleApiError() {}
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  // utils.js first — profile.js's GSTIN rule defers to validateGstin().
  for (const rel of [path.join('utilities', 'utils.js'), path.join('pages', 'profile.js')]) {
    const full = path.join(CLIENT_JS, rel);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: full });
  }

  return {
    ctx,
    toasts,
    el: id => elements.get(id),
    // Top-level `const` lives in script scope, not on the context object.
    eval: expr => vm.runInContext(expr, ctx)
  };
}

// A GSTIN that passes the real checksum — Vtech's own, the value the
// production profile actually holds.
const VALID_GSTIN = '33AARFV8415B1Z4';
// The second company from the isolation requirement.
const OTHER_GSTIN = '33BAVPS1659D1ZD';

const filled = (over = {}) => Object.assign({
  profBizName: 'Vtech Enterprises',
  profGSTIN: VALID_GSTIN,
  profPAN: '',
  profPhone: '',
  profEmail: ''
}, over);

// ── A. Required fields empty ───────────────────────────────────────

test('A1 frontend: blank business name and blank GSTIN are both reported', () => {
  const h = loadProfileForm(filled({ profBizName: '', profGSTIN: '' }));
  const errors = h.eval('getProfileFormErrors()');
  assert.equal(errors.business_name, 'Business / Trade Name is required.');
  assert.equal(errors.gstin, 'GSTIN is required.');
});

test('A2 frontend: whitespace-only business name is still empty', () => {
  const h = loadProfileForm(filled({ profBizName: '     ' }));
  const errors = h.eval('getProfileFormErrors()');
  assert.equal(errors.business_name, 'Business / Trade Name is required.');
});

test('A3 backend: an empty business_name is refused', () => {
  const r = validateProfilePayload({ business_name: '   ', gstin: VALID_GSTIN });
  assert.equal(r.valid, false);
  assert.equal(r.errors.business_name, 'Business / Trade Name is required.');
});

test('A4 backend: an empty gstin is refused', () => {
  const r = validateProfilePayload({ business_name: 'Vtech', gstin: '' });
  assert.equal(r.valid, false);
  assert.equal(r.errors.gstin, 'GSTIN is required.');
});

// ── B. Invalid GSTIN ───────────────────────────────────────────────

test('B1 frontend: fifteen spaces is not a GSTIN (the old length-only rule accepted it)', () => {
  const h = loadProfileForm(filled({ profGSTIN: '               ' }));
  const errors = h.eval('getProfileFormErrors()');
  assert.equal(errors.gstin, 'GSTIN is required.');
});

test('B2 frontend: fifteen characters with a bad checksum is refused', () => {
  // Same GSTIN as VALID_GSTIN with the check digit changed.
  const h = loadProfileForm(filled({ profGSTIN: '33AARFV8415B1Z9' }));
  const errors = h.eval('getProfileFormErrors()');
  assert.equal(errors.gstin, 'Enter a valid 15-character GSTIN.');
});

test('B3 frontend: an out-of-range state code is refused', () => {
  const h = loadProfileForm(filled({ profGSTIN: '99AARFV8415B1Z4' }));
  const errors = h.eval('getProfileFormErrors()');
  assert.equal(errors.gstin, 'Enter a valid 15-character GSTIN.');
});

test('B4 backend: the same three GSTINs are refused server-side', () => {
  ['               ', '33AARFV8415B1Z9', '99AARFV8415B1Z4'].forEach(gstin => {
    const r = validateProfilePayload({ business_name: 'Vtech', gstin });
    assert.equal(r.valid, false, `expected ${JSON.stringify(gstin)} to be refused`);
    assert.ok(r.errors.gstin);
  });
});

test('B5 both layers accept a real GSTIN', () => {
  const h = loadProfileForm(filled());
  assert.deepEqual(h.eval('getProfileFormErrors()'), {});
  assert.equal(validateProfilePayload({ business_name: 'Vtech', gstin: VALID_GSTIN }).valid, true);
});

// ── C. Optional fields may be empty ────────────────────────────────

test('C1 frontend: PAN, phone, email and address left blank is a valid form', () => {
  const h = loadProfileForm(filled({ profPAN: '', profPhone: '', profEmail: '' }));
  assert.deepEqual(h.eval('getProfileFormErrors()'), {});
});

test('C2 backend: empty optional fields are accepted', () => {
  const r = validateProfilePayload({
    business_name: 'Vtech', gstin: VALID_GSTIN,
    pan: '', phone: '', email: '', address: '', state: '', website: ''
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, {});
});

// ── D. Optional fields, when filled, must be well-formed ───────────

test('D1 frontend: a 9-digit phone is refused, a 10-digit one is accepted', () => {
  assert.equal(loadProfileForm(filled({ profPhone: '987654321' })).eval('getProfileFormErrors()').phone,
    'Phone number must be exactly 10 digits.');
  assert.deepEqual(loadProfileForm(filled({ profPhone: '9876543210' })).eval('getProfileFormErrors()'), {});
});

test('D2 frontend: a malformed PAN is refused, a well-formed one is accepted', () => {
  assert.equal(loadProfileForm(filled({ profPAN: 'ABCD1234F' })).eval('getProfileFormErrors()').pan,
    'PAN must be 10 characters, e.g. ABCDE1234F.');
  assert.deepEqual(loadProfileForm(filled({ profPAN: 'AARFV8415B' })).eval('getProfileFormErrors()'), {});
});

test('D3 frontend: a malformed email is refused, a well-formed one is accepted', () => {
  assert.equal(loadProfileForm(filled({ profEmail: 'not-an-email' })).eval('getProfileFormErrors()').email,
    'Enter a valid email address.');
  assert.deepEqual(loadProfileForm(filled({ profEmail: 'ledvtech@gmail.com' })).eval('getProfileFormErrors()'), {});
});

test('D4 backend: the same optional-field rules apply', () => {
  const bad = validateProfilePayload({
    business_name: 'Vtech', gstin: VALID_GSTIN,
    phone: '987654321', pan: 'ABCD1234F', email: 'not-an-email'
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.phone, 'Phone number must be exactly 10 digits.');
  assert.equal(bad.errors.pan, 'PAN must be 10 characters, e.g. ABCDE1234F.');
  assert.equal(bad.errors.email, 'Enter a valid email address.');

  const good = validateProfilePayload({
    business_name: 'Vtech', gstin: VALID_GSTIN,
    phone: '9876543210', pan: 'AARFV8415B', email: 'ledvtech@gmail.com'
  });
  assert.equal(good.valid, true);
});

// ── D5-D8. Phone written the way people write it ───────────────────
// Regression: this form had no phone rule until now, so profiles hold
// "+91 44 4000 1234" and "98430 12345". Judging those by /^\d{10}$/ made
// the profile permanently unsavable — Save was refused over an optional
// field the user need not have touched, and no request was ever sent.

const PHONES_ACCEPTED = ['9843012345', '+91 98430 12345', '98430 12345', '98430-12345',
  '044 4000 1234', '+91 44 4000 1234', '(98430) 12345'];
const PHONES_REJECTED = ['12345', '98430123456', 'abcdefghij', '+91 12',
  '9843 0123 456', '999999999', '+1 415 555 0100'];

test('D5 backend: a phone with separators or a +91/0 prefix is accepted', () => {
  PHONES_ACCEPTED.forEach(phone => {
    const r = validateProfilePayload({ business_name: 'V Tech', gstin: VALID_GSTIN, phone });
    assert.equal(r.valid, true, `${JSON.stringify(phone)} must be accepted`);
  });
});

test('D6 backend: the ten-digit rule is NOT relaxed', () => {
  PHONES_REJECTED.forEach(phone => {
    const r = validateProfilePayload({ business_name: 'V Tech', gstin: VALID_GSTIN, phone });
    assert.equal(r.valid, false, `${JSON.stringify(phone)} must still be rejected`);
    assert.equal(r.errors.phone, 'Phone number must be exactly 10 digits.');
  });
});

test('D7 frontend: the form agrees with the backend on every one of those', () => {
  PHONES_ACCEPTED.forEach(phone => {
    assert.deepEqual(loadProfileForm(filled({ profPhone: phone })).eval('getProfileFormErrors()'), {},
      `${JSON.stringify(phone)} must not block the form`);
  });
  PHONES_REJECTED.forEach(phone => {
    assert.equal(loadProfileForm(filled({ profPhone: phone })).eval('getProfileFormErrors()').phone,
      'Phone number must be exactly 10 digits.', `${JSON.stringify(phone)} must still block the form`);
  });
});

test('D8 the two normalisers agree, and customers keep the stricter rule', () => {
  const { normalizeIndianPhone, validateCustomerPayload } = require('../src/utils/validation');
  const h = loadProfileForm(filled());
  PHONES_ACCEPTED.concat(PHONES_REJECTED).forEach(phone => {
    assert.equal(h.eval(`normalizeProfilePhone(${JSON.stringify(phone)})`), normalizeIndianPhone(phone),
      `client and server must normalise ${JSON.stringify(phone)} identically`);
  });
  // Customer Master has enforced /^\d{10}$/ since its first write and its
  // data was created under that rule — this fix must not reach it.
  const c = validateCustomerPayload({ name: 'A', state: 'Tamil Nadu', phone: '+91 98430 12345' });
  assert.equal(c.valid, false, 'validateCustomerPayload must be left exactly as it was');
});

// ── E. Inline error rendering + accessibility ──────────────────────

test('E1 an invalid field gets its message, aria-invalid and highlight; a valid one gets none', () => {
  const h = loadProfileForm(filled({ profBizName: '', profPhone: '12345' }));
  h.eval("markProfileFieldTouched('profBizName')");

  assert.equal(h.el('profBizNameError').textContent, 'Business / Trade Name is required.');
  assert.equal(h.el('profBizNameError').classes.has('d-none'), false);
  assert.equal(h.el('profBizName').getAttribute('aria-invalid'), 'true');
  assert.equal(h.el('profBizName').classes.has('error'), true, 'invalid field must be highlighted, not signalled by text alone');

  assert.equal(h.el('profGSTINError').textContent, '');
  assert.equal(h.el('profGSTINError').classes.has('d-none'), true);
  assert.equal(h.el('profGSTIN').getAttribute('aria-invalid'), 'false');
  assert.equal(h.el('profGSTIN').classes.has('error'), false);
});

test('E2 fixing a field clears its message, highlight and aria-invalid', () => {
  const h = loadProfileForm(filled({ profBizName: '' }));
  h.eval("markProfileFieldTouched('profBizName')");
  assert.equal(h.el('profBizName').classes.has('error'), true);

  h.el('profBizName').value = 'Vtech Enterprises';
  h.eval("onProfileFieldInput('profBizName')");
  const errors = h.eval('validateProfileForm()');

  assert.deepEqual(errors, {});
  assert.equal(h.el('profBizNameError').textContent, '');
  assert.equal(h.el('profBizNameError').classes.has('d-none'), true);
  assert.equal(h.el('profBizName').getAttribute('aria-invalid'), 'false');
  assert.equal(h.el('profBizName').classes.has('error'), false);
});

test('E3 every validated input is wired to its own error element by aria-describedby', () => {
  const src = fs.readFileSync(path.join(CLIENT_JS, 'pages', 'profile.js'), 'utf8');
  [['profBizName', 'profBizNameError'], ['profGSTIN', 'profGSTINError'], ['profPAN', 'profPANError'],
   ['profPhone', 'profPhoneError'], ['profEmail', 'profEmailError']].forEach(([input, err]) => {
    assert.ok(new RegExp(`id="${input}"[\\s\\S]{0,500}?aria-describedby="${err}"`).test(src),
      `${input} must declare aria-describedby="${err}"`);
    assert.ok(new RegExp(`<label for="${input}"`).test(src),
      `${input} must have a label bound with for="${input}"`);
  });
});

test('E4 the two required fields are marked with * and Required, the optional ones are not', () => {
  const src = fs.readFileSync(path.join(CLIENT_JS, 'pages', 'profile.js'), 'utf8');
  // One field's whole .form-group block: from the div that opens it to
  // the div that opens the next one (or the end of the grid).
  const group = id => {
    const at = src.indexOf(`for="${id}"`);
    const start = src.lastIndexOf('<div class="form-group"', at);
    const next = src.indexOf('<div class="form-group"', at);
    return src.slice(start, next === -1 ? start + 1200 : next);
  };
  ['profBizName', 'profGSTIN'].forEach(id => {
    assert.ok(group(id).includes('<span class="text-required">*</span>'), `${id} must be marked *`);
    assert.ok(group(id).includes('>Required<'), `${id} must carry the Required helper text`);
  });
  ['profPAN', 'profPhone', 'profEmail'].forEach(id => {
    assert.ok(!group(id).includes('text-required'), `${id} is optional and must not be marked *`);
    assert.ok(!group(id).includes('>Required<'), `${id} is optional and must not say Required`);
  });
});

test('E5 the first invalid field is the one focused', () => {
  // GSTIN is invalid and phone is invalid; business name is fine. The
  // earlier field in the form wins.
  const h = loadProfileForm(filled({ profGSTIN: 'BAD', profPhone: '123' }));
  const errors = h.eval('getProfileFormErrors()');
  h.eval(`focusFirstInvalidProfileField(${JSON.stringify(errors)})`);
  assert.equal(h.el('profGSTIN').focused, true);
  assert.equal(h.el('profPhone').focused, false);
});

test('E7 a half-typed GSTIN is not called invalid until the user leaves the field', () => {
  const h = loadProfileForm(filled({ profGSTIN: '' }));
  h.el('profGSTIN').value = '33A';               // three keystrokes in
  h.eval("onProfileFieldInput('profGSTIN')");
  assert.equal(h.el('profGSTINError').textContent, '', 'must stay quiet while the field is being filled');
  assert.equal(h.el('profGSTIN').classes.has('error'), false);

  h.eval("markProfileFieldTouched('profGSTIN')"); // user tabs away
  assert.equal(h.el('profGSTINError').textContent, 'Enter a valid 15-character GSTIN.');
  assert.equal(h.el('profGSTIN').classes.has('error'), true);

  h.el('profGSTIN').value = VALID_GSTIN;          // and corrects it
  h.eval("onProfileFieldInput('profGSTIN')");
  assert.equal(h.el('profGSTINError').textContent, '', 'a correction must clear the error as it is typed');
  assert.equal(h.el('profGSTIN').classes.has('error'), false);
});

test('E8 a server complaint is shown even on a field the user never touched', () => {
  const h = loadProfileForm(filled());
  h.eval("validateProfileForm({ gstin: 'This GSTIN is already registered.' })");
  assert.equal(h.el('profGSTINError').textContent, 'This GSTIN is already registered.');
  assert.equal(h.el('profGSTIN').getAttribute('aria-invalid'), 'true');
});

test('E6 the vague Tamil prompt is gone and the stated message is used', () => {
  const src = fs.readFileSync(path.join(CLIENT_JS, 'pages', 'profile.js'), 'utf8');
  assert.ok(!/business details பூர்த்தி/.test(src), 'the old vague message must be gone');
  assert.ok(src.includes('Please complete all required fields before saving your business profile. Fields marked with * are required.'));
  assert.ok(src.includes('Business profile saved successfully.'));
});

test('E9 a malformed OPTIONAL field is not reported as a missing required one', () => {
  const src = fs.readFileSync(path.join(CLIENT_JS, 'pages', 'profile.js'), 'utf8');
  const gate = src.slice(src.indexOf('async function submitProfile()'), src.indexOf('const bizName'));
  // The required-field wording is reserved for an actually-missing
  // required field; anything else gets the corrective wording. Saying
  // "complete all required fields" over a bad phone sent the user to
  // check the two fields marked *, which were already filled in.
  assert.ok(/errors\.business_name \|\| errors\.gstin/.test(gate),
    'the message must be chosen by whether a REQUIRED field is missing');
  assert.ok(src.includes('Please correct the highlighted fields before saving your business profile.'));
});

// ── F. Partial writes from the other three forms must keep working ──

test('F1 backend: the Company Branding payload is not made to carry identity fields', () => {
  const r = validateProfilePayload({
    id: 'u1', logo_base64: 'data:image/png;base64,AAA', seal_base64: '',
    header_color: '#004d40', footer_text: 'Thank you',
    bank_name: 'HDFC', bank_account_no: '123456', bank_ifsc: 'HDFC0000123', upi_id: 'x@y'
  });
  assert.equal(r.valid, true, 'branding-only saves must not start demanding a business name');
});

test('F2 backend: the invoice-numbering and auto-number payloads still validate', () => {
  assert.equal(validateProfilePayload({
    id: 'u1', invoice_auto_number: true, invoice_number_format: 'INV-####',
    invoice_current_sequence: 42, invoice_series_formats: {}, invoice_series_sequences: {}
  }).valid, true);
  assert.equal(validateProfilePayload({ id: 'u1', invoice_auto_number: false }).valid, true);
});

test('F3 backend: a field that IS present is validated even in a partial payload', () => {
  const r = validateProfilePayload({ id: 'u1', gstin: 'NOPE' });
  assert.equal(r.valid, false);
  assert.equal(r.errors.gstin, 'Enter a valid 15-character GSTIN.');
});

test('F4 backend: null is treated as empty, never crashed on', () => {
  assert.equal(validateProfilePayload({ business_name: null, gstin: null }).valid, false);
  assert.equal(validateProfilePayload({ phone: null, email: null, pan: null }).valid, true);
});

// ── G. The structured error envelope ───────────────────────────────

function runErrorHandler(err) {
  let captured = null;
  const res = {
    headersSent: false,
    status(code) { this._status = code; return this; },
    json(body) { captured = { status: this._status, body }; return this; }
  };
  errorHandler(err, { method: 'PATCH', originalUrl: '/api/profiles' }, res, () => {});
  return captured;
}

test('G1 an exposed validation error carries a per-field map alongside message/code/requestId', () => {
  const err = new Error('Business / Trade Name is required. Enter a valid 15-character GSTIN.');
  err.status = 400; err.expose = true;
  err.fields = { business_name: 'Business / Trade Name is required.', gstin: 'Enter a valid 15-character GSTIN.' };

  const out = runErrorHandler(err);
  assert.equal(out.status, 400);
  assert.deepEqual(out.body.error.fields, err.fields);
  assert.equal(out.body.error.message, err.message);
  assert.ok(out.body.error.code);
  assert.match(out.body.error.requestId, /^[0-9a-f]{8}$/, 'requestId behaviour must be unchanged');
});

test('G2 an internal error never grows a fields key, and never leaks its message', () => {
  const err = new Error('relation "profiles" does not exist');
  err.fields = { secret: 'internal detail' };
  const out = runErrorHandler(err);
  assert.equal(out.status, 500);
  assert.equal(out.body.error.message, 'Something went wrong on the server.');
  assert.equal('fields' in out.body.error, false, 'an unexposed error must not carry a field map');
});

test('G3 a fields value that is not a plain map of strings is dropped', () => {
  [['a', 'b'], 'nope', { a: { nested: 1 } }, { a: '' }, {}, null].forEach(fields => {
    const err = new Error('bad'); err.status = 400; err.expose = true; err.fields = fields;
    const out = runErrorHandler(err);
    assert.equal('fields' in out.body.error, false,
      `a fields value of ${JSON.stringify(fields)} must not be serialised`);
  });
});

test('G4 an exposed error with no fields is byte-identical to before', () => {
  const err = new Error('No valid fields to update.');
  err.status = 400; err.expose = true;
  const out = runErrorHandler(err);
  assert.deepEqual(Object.keys(out.body.error).sort(), ['code', 'message', 'requestId']);
});

test('G5 apiClient re-checks the map rather than trusting it', () => {
  const src = fs.readFileSync(path.resolve(CLIENT_JS, 'api', 'apiClient.js'), 'utf8');
  assert.ok(/typeof rawFields\[k\] === 'string'/.test(src),
    'apiErrorFrom must filter the field map to strings, as it does for message/code/requestId');
});

// ── H. Isolation: the form never chooses whose profile it writes ────

test('H1 profiles is owned by its own id, forced from the JWT', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'generic.js'), 'utf8');
  const profiles = src.slice(src.indexOf('  profiles: {'), src.indexOf('  customers: {'));
  assert.ok(/ownerColumn: 'id'/.test(profiles), 'profiles must stay keyed on its own id');
  assert.ok(/validate: validateProfilePayload/.test(profiles), 'profiles must be wired to the profile validator');

  // The two lines that make a forged id impossible.
  assert.ok(src.includes('const payload = { ...req.body, [ownerColumn]: req.userId };'),
    'INSERT must overwrite whatever owner the body claimed');
  assert.ok(src.includes("c !== ownerColumn"), 'PATCH must refuse to reassign ownership');
});

test('H2 the profile form writes only the signed-in user id, never a form value', () => {
  const src = fs.readFileSync(path.join(CLIENT_JS, 'pages', 'profile.js'), 'utf8');
  const body = src.slice(src.indexOf('async function submitProfile()'), src.indexOf('// Says what the chosen registration'));
  assert.ok(/const user = await getCurrentUser\(\);/.test(body));
  assert.ok(/saveUserProfile\(user\.id,/.test(body),
    'the target row must come from the session, not from anything the form collected');
  assert.ok(!/gstin.*=>.*user|user\.id\s*=/.test(body));
});

test('H3 the validator is identity-blind — it judges the value, never the owner', () => {
  // The same payload shape for two different companies validates on its
  // own merits; nothing here can be steered by whose row it is.
  const vtech = validateProfilePayload({ business_name: 'Vtech', gstin: VALID_GSTIN });
  const other = validateProfilePayload({ business_name: 'Subbaiyan Savitha', gstin: OTHER_GSTIN });
  assert.equal(vtech.valid, true);
  assert.equal(other.valid, true);
  // And a user_id smuggled into the body is simply not a column the
  // validator or the profiles column list knows about.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'generic.js'), 'utf8');
  const profiles = src.slice(src.indexOf('  profiles: {'), src.indexOf('  customers: {'));
  assert.ok(!/'user_id'/.test(profiles), 'profiles has no user_id column to forge');
});
