// =============================================
// Shared Gemini document-extraction client.
//
// Both scanners — Purchase Bill (routes/bill-scan.js) and Customer
// Invoice (routes/invoice-scan.js) — do the same thing to different
// documents: post files plus a prompt, demand JSON shaped by a schema,
// and refuse anything that comes back malformed. That whole sequence
// lives here once; the routes differ only in which prompt and schema
// they hand over and how they normalise the result.
//
// The API key is read from process.env by the caller and passed in, so
// this module never reaches for configuration itself and stays trivially
// testable. It cannot touch the database — it does not import the pool.
// =============================================
const { validateAgainstSchema } = require('./schemaCheck');

const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS) || 60000;

// Every failure is returned, never thrown: the caller needs both an HTTP
// status for the browser and a short reason string for the log line, and
// an exception would carry neither without extra plumbing.
const fail = (status, message, reason) => ({ ok: false, status, message, reason });

// Google's error bodies sometimes quote the offending request back,
// including the key. Nothing that leaves this process should carry it.
function redactKey(text, apiKey) {
  return apiKey ? text.split(apiKey).join('[REDACTED]') : text;
}

// Gemini accepts a fixed set of media types and is strict about the
// spelling. Browsers and operating systems are not: "image/jpg" is a
// widespread non-standard variant that Windows in particular reports for
// .jpg files, and sending it verbatim earns an HTTP 400 from Google even
// though the bytes are a perfectly ordinary JPEG. Likewise CSV arrives
// as application/csv from some clients.
const MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/csv': 'text/csv',
  'text/comma-separated-values': 'text/csv',
  'application/x-pdf': 'application/pdf'
};
const canonicalMime = m => MIME_ALIASES[(m || '').toLowerCase()] || (m || '').toLowerCase();

// Everything in a generateContent call travels inline, base64-encoded,
// inside one JSON request — and Google caps that whole request at 20 MB.
// Base64 inflates bytes by about a third, so the real ceiling on raw
// file content is ~14 MB. Without this check a large upload (or several
// smaller ones together) fails as an opaque 400 from Google rather than
// a message telling the user to send less.
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

// Google returns a machine-readable status and a human message. Turning
// the common ones into plain operator English is the difference between
// "upstream HTTP 400" — which says nothing about what to do — and a
// message naming the actual misconfiguration.
function explainUpstream(status, raw) {
  let g = {};
  try { g = JSON.parse(raw).error || {}; } catch { /* not JSON */ }
  const msg = g.message || '';
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
    return 'The Gemini API key on the server is not valid. Check GEMINI_API_KEY.';
  }
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(msg)) {
    return 'The Generative Language API is not enabled for this Google project.';
  }
  if (/API key not authorized|PERMISSION_DENIED|referer|IP address/i.test(msg)) {
    return 'The Gemini API key is restricted and refused this server. Remove its HTTP-referrer/IP restrictions.';
  }
  if (/quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return 'The Gemini API quota for this key has been exhausted.';
  }
  if (/not found|is not supported|NOT_FOUND/i.test(msg)) {
    return `The configured Gemini model was rejected: ${msg.slice(0, 160)}`;
  }
  // Anything else — including schema complaints — is passed through
  // rather than swallowed. It is Google's own validation text, already
  // key-redacted by the caller, and it is what makes a misconfiguration
  // diagnosable from the UI instead of only from the server log.
  return msg
    ? `Document analysis failed (HTTP ${status}): ${msg.slice(0, 200)}`
    : `Document analysis failed (upstream HTTP ${status}).`;
}

/**
 * @param {object}  opts
 * @param {string}  opts.apiKey
 * @param {string}  opts.model
 * @param {string}  opts.prompt
 * @param {object}  opts.schema     Gemini Schema; also used to validate the reply
 * @param {Array}   opts.parts      [{ mimeType, buffer }] — one entry per uploaded file
 * @param {number}  [opts.timeoutMs]
 * @param {string}  [opts.label]    for log lines, e.g. 'bill-scan'
 * @returns {Promise<{ok:true,data:object}|{ok:false,status:number,message:string,reason:string}>}
 */
async function extractDocument({ apiKey, model, prompt, schema, parts, timeoutMs, label = 'gemini' }) {
  const totalBytes = parts.reduce((n, p) => n + p.buffer.length, 0);
  if (totalBytes > MAX_INLINE_BYTES) {
    return fail(413, `Those files total ${Math.round(totalBytes / 1024 / 1024)} MB, over the ${Math.round(MAX_INLINE_BYTES / 1024 / 1024)} MB the analysis service accepts in one request. Please send fewer or smaller files.`, 'too-large');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        ...parts.map(p => ({ inlineData: { mimeType: canonicalMime(p.mimeType), data: p.buffer.toString('base64') } }))
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      // Transcription, not composition — there is no upside to sampling.
      temperature: 0
    }
  };

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || GEMINI_TIMEOUT_MS)
    });
  } catch (err) {
    console.error(`[${label}] request failed:`, err.name, err.message);
    return err.name === 'TimeoutError'
      ? fail(504, 'The document took too long to analyse. Try a smaller or clearer file.', 'timeout')
      : fail(504, 'Could not reach the document analysis service.', 'unreachable');
  }

  if (!upstream.ok) {
    // Log Google's reply IN FULL. It is the only thing that says which
    // field or setting it objected to, and truncating it to a few
    // hundred characters is what turns a specific complaint into an
    // unactionable "upstream HTTP 400". The key is redacted first —
    // error bodies can quote the request back, and server logs get
    // shipped, retained and read by people who should never see it.
    const raw = redactKey(await upstream.text().catch(() => ''), apiKey);
    console.error(`[${label}] upstream HTTP ${upstream.status}. Full Google response follows:\n${raw}`);
    return fail(502, explainUpstream(upstream.status, raw), `upstream-http-${upstream.status}`);
  }

  const payload = await upstream.json().catch(() => null);
  const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  if (!text) {
    const reason = payload?.candidates?.[0]?.finishReason || payload?.promptFeedback?.blockReason;
    console.error(`[${label}] returned no content - finishReason:`, reason);
    return fail(502, 'The document could not be read. Try a clearer scan, or enter it manually.', `no-content:${reason || 'unknown'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`[${label}] returned non-JSON:`, text.slice(0, 300));
    return fail(502, 'The analysis came back in an unexpected format. Please enter it manually.', 'non-json');
  }

  // Reject a structurally wrong reply BEFORE any normalisation runs.
  // Normalisers are forgiving by design — they turn anything unusable
  // into a blank — which means on their own they would quietly convert a
  // garbage response into an empty-looking but "successful" scan.
  // Checking the shape first is what makes the difference between "the
  // document was blank" and "the model did not answer the question".
  const schemaErrors = validateAgainstSchema(parsed, schema);
  if (schemaErrors.length) {
    console.error(`[${label}] reply failed schema check:`, schemaErrors.slice(0, 10).join('; '));
    return fail(502, 'The analysis came back in an unexpected format. Please enter it manually.', `schema-invalid(${schemaErrors.length})`);
  }

  return { ok: true, data: parsed };
}

module.exports = { extractDocument, GEMINI_TIMEOUT_MS };
