// Loads the browser-side GSTR-1 scripts into a Node `vm` context so their
// functions can be tested directly.
//
// WHY A vm CONTEXT, AND NOT module.exports IN THE SOURCE FILES:
// js/utils.js, js/reports.js and js/gstr1-export.js are plain <script>
// files — they declare globals and are loaded in order by every page. The
// alternative to this harness was appending a CommonJS shim to each of
// them, which puts test scaffolding into files that ship to production and
// changes what the browser parses. This loads the very same bytes the
// browser loads, unmodified, and reads the globals back out of the context
// afterwards. If a test here passes, it passed against the shipped file.
//
// The DOM stub is deliberately minimal — just enough for the files to
// finish evaluating. Nothing under test touches the DOM: the period
// helpers are pure, and buildGSTR1Payload() reads only `_supabase`, which
// the caller injects.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CLIENT_JS = path.resolve(__dirname, '..', '..', '..', 'client', 'js');

// Order matters and mirrors the <script> order in reports.html:
// utils.js first (toISO, validateGstin, INDIAN_STATES), then reports.js
// (getReportDateRange), then gstr1-export.js. Paths are the categorised
// locations under client/js/ — if a file is recategorised, update it here
// too or the harness loads nothing and every test fails at once.
const FILES = [
  path.join('utilities', 'utils.js'),
  path.join('reports', 'reports.js'),
  path.join('gst', 'gstr1-export.js')
];

function makeElementStub() {
  return {
    value: '', textContent: '', innerHTML: '', style: {}, options: [],
    selectedIndex: -1, checked: false, files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, remove() {}, append() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    getAttribute() { return null; }, focus() {}, click() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, closest() { return null; }, insertAdjacentHTML() {}
  };
}

function createBrowserContext() {
  const elements = new Map();

  const document = {
    getElementById(id) { return elements.has(id) ? elements.get(id) : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeElementStub(); },
    addEventListener() {},
    removeEventListener() {},
    body: makeElementStub(),
    documentElement: makeElementStub()
  };

  const ctx = {
    console, Date, Math, JSON, RegExp, String, Number, Boolean, Object, Array,
    Set, Map, Promise, Error, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
    decodeURIComponent, setTimeout, clearTimeout, setInterval, clearInterval,
    document,
    window: { location: { pathname: '/reports.html', href: '', replace() {}, assign() {} }, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node', clipboard: { writeText() {} } },
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: function Blob() {},
    alert() {}, confirm: () => true, prompt: () => null,
    // Swallowed: the code under test reports progress through these, and a
    // test asserting on data should not depend on toast wording.
    showToast() {}, showConfirm: () => Promise.resolve(true)
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  for (const file of FILES) {
    const full = path.join(CLIENT_JS, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: full });
  }

  // Helper for tests that need to drive the period dropdown.
  ctx.__setElement = (id, el) => elements.set(id, el);

  // Top-level `const`/`let` in a script live in that script's lexical
  // scope, not on the context object — so ctx.GSTR1_MONTH_SELECTION is
  // undefined even though the code under test can see it. (Only `var` and
  // function declarations become context properties.) This evaluates an
  // expression inside the context, which is the only way to reach those
  // bindings from out here.
  ctx.__eval = (expression) => vm.runInContext(expression, ctx);

  return ctx;
}

// A stand-in for js/apiClient.js's RestQueryBuilder that records the
// filters it was given instead of issuing a request. Every query resolves
// to an empty result set, which is what a month with no data returns —
// so the builder still runs end to end and the recorded filters are the
// exact ones the real client would have sent.
function makeRecordingSupabase(recorded) {
  function builder(table) {
    const rec = { table, eq: {}, gte: {}, lte: {}, in: {}, select: null };
    recorded.push(rec);
    const api = {
      select(cols) { rec.select = cols; return api; },
      eq(f, v) { rec.eq[f] = v; return api; },
      gte(f, v) { rec.gte[f] = v; return api; },
      lte(f, v) { rec.lte[f] = v; return api; },
      in(f, v) { rec.in[f] = v; return api; },
      order() { return api; },
      limit() { return api; },
      single() { rec.single = true; return api; },
      then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
      catch(fn) { return Promise.resolve({ data: [], error: null }).catch(fn); }
    };
    return api;
  }
  return { from: builder };
}

module.exports = { createBrowserContext, makeRecordingSupabase };
