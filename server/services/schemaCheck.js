// =============================================
// Structural validation against a Gemini Schema object.
//
// Gemini is ASKED to honour responseSchema, and almost always does — but
// "almost always" is not a guarantee, and the reply is fed straight into
// a form the user then saves. This walks the very same BILL_SCHEMA that
// was sent to the model, so the contract has exactly one definition:
// change services/geminiBillPrompt.js and the check follows automatically.
//
// It validates SHAPE, not plausibility. Whether a GSTIN is well-formed or
// a date exists on the calendar is normalise()'s job in
// routes/bill-scan.js — this only answers "is this the object we asked
// for", so a reply that is the wrong shape entirely is rejected before
// any of it reaches Purchase Entry.
// =============================================

const TYPE_CHECKS = {
  STRING:  v => typeof v === 'string',
  NUMBER:  v => typeof v === 'number' && Number.isFinite(v),
  INTEGER: v => Number.isInteger(v),
  BOOLEAN: v => typeof v === 'boolean',
  ARRAY:   v => Array.isArray(v),
  OBJECT:  v => v !== null && typeof v === 'object' && !Array.isArray(v)
};

// Returns [] when the value matches, otherwise a list of human-readable
// paths — capped by the caller, since a wholly wrong reply would
// otherwise produce one error per field.
function validateAgainstSchema(value, schema, path = 'root') {
  const errors = [];
  if (!schema || !schema.type) return errors;

  // nullable is how the schema says "unreadable" for numeric fields, so
  // null is a valid answer wherever it is set — that is requirement 10
  // (leave it blank) expressed in the contract rather than in prose.
  if (value === null) {
    if (!schema.nullable) errors.push(`${path} is null but not nullable`);
    return errors;
  }
  if (value === undefined) { errors.push(`${path} is missing`); return errors; }

  const check = TYPE_CHECKS[schema.type];
  if (check && !check(value)) {
    errors.push(`${path} should be ${schema.type} but was ${Array.isArray(value) ? 'ARRAY' : typeof value}`);
    return errors;   // no point descending into the wrong type
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} is "${value}", not one of [${schema.enum.join(', ')}]`);
  }

  if (schema.type === 'OBJECT') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validateAgainstSchema(value[key], sub, `${path}.${key}`));
    }
  }

  if (schema.type === 'ARRAY' && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)));
  }

  return errors;
}

module.exports = { validateAgainstSchema };
