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

// THE single definition of which model both scanners use. It lives here,
// with the rest of the Gemini connection settings, rather than in the
// prompt files — those were each declaring their own copy, which is
// precisely how the Purchase and Invoice scanners could silently end up
// on different models.
//
// Google retires model IDs on a short cycle and starts refusing them for
// new projects ahead of the published shutdown date, so treat this
// default as perishable: GEMINI_MODEL overrides it without a code
// change, and a retired ID surfaces as a clear 404 message via
// explainUpstream() below.
// Environment variables are hand-entered in a dashboard, and what comes
// back is routinely not what was meant. Any of these is interpolated
// straight into the request path and earns HTTP 400
// "GenerateContentRequest.model: unexpected model name format" — an
// error about the STRING, not about the model existing. Normalising here
// is what stops a stray keystroke from taking the scanners down.
//
// The KEY=VALUE case is the one that actually bit us in production:
// pasting a whole `GEMINI_MODEL=gemini-3.6-flash` line into a dashboard
// field that wants only the value. The variable then literally holds
// "GEMINI_MODEL=gemini-3.6-flash", and the request goes to
// .../models/GEMINI_MODEL=gemini-3.6-flash:generateContent. A real model
// id never contains "=", so stripping a leading NAME= prefix is
// unambiguous and cannot damage a correct value.
function normaliseModelId(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '')   // a whole KEY=VALUE line pasted in
    .replace(/^["']+|["']+$/g, '')                   // quotes copied along with the value
    .replace(/^models\//i, '')                       // fully-qualified resource name
    .trim();
}

const GEMINI_MODEL = normaliseModelId(process.env.GEMINI_MODEL) || 'gemini-3.6-flash';

// A model id is a bare slug — no slashes, spaces or colons, since it is
// interpolated into ".../models/<id>:generateContent". Anything else
// would corrupt the path itself, so it is caught before the request
// rather than after Google rejects it.
const MODEL_ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(GEMINI_MODEL);

// Printed once at boot so the resolved value — delimiters included — is
// visible in the deployment log. Whitespace damage is invisible in a
// dashboard field but obvious between pipes.
console.log(`[gemini] model resolved to |${GEMINI_MODEL}|${MODEL_ID_OK ? '' : '  <-- INVALID FORMAT'}`);

// Base allowance for a small document, and how much more each megabyte of
// request buys. MAX caps the whole thing so a pathological upload cannot
// hold a worker open indefinitely. Overridable, like the base value, so a
// slow account can be tuned without a deploy.
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS) || 60000;
const PER_MB_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_PER_MB_MS) || 45000;
const MAX_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MAX_MS) || 240000;

// ── Retry policy ─────────────────────────────────────
// Gemini sheds load under pressure with 429 (rate limited) and 503
// ("currently experiencing high demand"). Both mean "the same request
// would probably succeed shortly", so they are the only two statuses
// worth repeating. Every other status — 400, 401, 403, 404, and schema
// complaints — describes a request that is wrong on its own terms and
// will fail identically however many times it is sent; retrying those
// would just add latency to a certain failure.
const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
// Indexed by attempt number - 1: fire immediately, then back off.
const RETRY_DELAYS_MS = [0, 2000, 4000];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  // Google complains about the model NAME (its shape), not the model
  // itself — so name the offending value and where it comes from.
  if (/unexpected model name format|model name format/i.test(msg)) {
    return `The Gemini model name is malformed: "${GEMINI_MODEL}". Check GEMINI_MODEL for stray spaces, quotes or a "models/" prefix.`;
  }
  if (/not found|is not supported|no longer available|NOT_FOUND/i.test(msg)) {
    return `The Gemini model "${GEMINI_MODEL}" was rejected: ${msg.slice(0, 160)}`;
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
  // Guard the caller's value too — routes read GEMINI_MODEL from here,
  // but this keeps the check at the point of use rather than trusting
  // module load order.
  model = normaliseModelId(model);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    console.error(`[${label}] refusing to call Gemini: GEMINI_MODEL is |${model}|, which is not a valid model id`);
    return fail(500, `The configured Gemini model name is not valid: "${model}". Check the GEMINI_MODEL environment variable.`, 'bad-model-id');
  }

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

  // The request body is built ONCE and reused byte-for-byte across
  // attempts — a retry must be the identical request, not a rebuilt one.
  const payload = JSON.stringify(body);

  // How long Gemini is given, scaled to how much it was asked to read.
  //
  // A flat 60s was the whole bug: it is generous for a one-page photo and
  // far too short for a multi-page PDF or a batch upload, which arrive here
  // as one call carrying every page inline. The document that fails is
  // precisely the one that needed the most time, and it was cut off and
  // reported as "took too long — try a smaller file" when nothing was
  // actually wrong with it.
  //
  // Raising the flat number instead would have made every small scan wait
  // just as long before giving up. Scaling costs the fast documents nothing
  // and gives the slow ones room.
  //
  // This is the only layer with a deadline. The upload returns a job id
  // immediately and the browser polls, so no gateway — Render's, Vercel's
  // or the browser's — is waiting on this request, and none of them can
  // produce the 504. Only this timeout can, which is why it is the only one
  // being changed.
  const payloadMB = payload.length / (1024 * 1024);
  const scaledMs = Math.round(GEMINI_TIMEOUT_MS + payloadMB * PER_MB_TIMEOUT_MS);
  const budgetMs = timeoutMs || Math.min(scaledMs, MAX_TIMEOUT_MS);
  console.log(`[${label}] payload ${payloadMB.toFixed(1)}MB, allowing ${Math.round(budgetMs / 1000)}s`);

  let upstream;
  let raw = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Attempt 1 fires immediately; 2 and 3 wait 2s and 4s.
    const wait = RETRY_DELAYS_MS[attempt - 1];
    if (wait) {
      console.warn(`[${label}] retry attempt ${attempt} of ${MAX_ATTEMPTS} after ${wait}ms (previous attempt returned HTTP ${upstream.status})`);
      await sleep(wait);
    }

    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: payload,
        signal: AbortSignal.timeout(budgetMs)
      });
    } catch (err) {
      // Not retried: the brief is to retry 429 and 503 only, and a
      // timeout has already consumed the caller's whole time budget.
      console.error(`[${label}] request failed:`, err.name, err.message);
      // The two failures are told apart because the fixes differ: a timeout
      // means the document was too much to read in the time allowed, an
      // unreachable service means nothing was read at all. Reporting both
      // as "try a smaller file" sent people to shrink a file that was never
      // the problem.
      return err.name === 'TimeoutError'
        ? fail(504,
            `The document analysis service did not finish within ${Math.round(budgetMs / 1000)} seconds. ` +
            'A very long or high-resolution document can exceed that — try fewer pages or a smaller file.',
            'timeout')
        : fail(504,
            'Could not reach the document analysis service. It may be temporarily unavailable — try again in a moment.',
            'unreachable');
    }

    if (upstream.ok) break;

    // The body can only be read once, so it is captured here and reused
    // below whether this attempt is retried or is the last one.
    raw = redactKey(await upstream.text().catch(() => ''), apiKey);

    // Only capacity errors are transient. 400/401/403/404 and anything
    // else describe a request that will fail identically next time, so
    // retrying them just adds latency to a certain failure.
    const retryable = RETRY_STATUSES.has(upstream.status);
    if (!retryable) break;
    if (attempt === MAX_ATTEMPTS) {
      console.error(`[${label}] giving up after ${MAX_ATTEMPTS} attempts; last status HTTP ${upstream.status}`);
      break;
    }
    console.warn(`[${label}] HTTP ${upstream.status} from Gemini (attempt ${attempt} of ${MAX_ATTEMPTS}) — transient, will retry`);
  }

  if (!upstream.ok) {
    // Log Google's reply IN FULL. It is the only thing that says which
    // field or setting it objected to, and truncating it to a few
    // hundred characters is what turns a specific complaint into an
    // unactionable "upstream HTTP 400". The key is redacted first —
    // error bodies can quote the request back, and server logs get
    // shipped, retained and read by people who should never see it.
    //
    // `raw` was captured inside the retry loop — a Response body can only
    // be read once, so it cannot be re-read here.
    console.error(`[${label}] upstream HTTP ${upstream.status}. Full Google response follows:\n${raw}`);
    // The final Google error is returned unchanged: retries never alter
    // the status, the message or the reason the caller sees.
    return fail(502, explainUpstream(upstream.status, raw), `upstream-http-${upstream.status}`);
  }

  const reply = await upstream.json().catch(() => null);
  const text = reply?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  if (!text) {
    const reason = reply?.candidates?.[0]?.finishReason || reply?.promptFeedback?.blockReason;
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

module.exports = { extractDocument, GEMINI_MODEL, GEMINI_TIMEOUT_MS };
