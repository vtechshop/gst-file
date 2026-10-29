#!/usr/bin/env node
// The whole regression suite, run the way it is meant to be run.
//
// `npm test` is `node --test`, which is correct but lenient: 53 of the 1298
// tests are guarded on resources the server does not depend on - a disposable
// database, and the jsPDF build the browser loads from a CDN - and they
// announce themselves as skipped rather than failing. That is right for a
// casual run and wrong for a regression gate, where a skip is a test that did
// not happen.
//
// So this runner refuses to start without both, says exactly how to supply
// whichever is missing, and fails afterwards if anything skipped anyway.
//
// Serial by design (--test-concurrency=1): a dozen of these files spawn a real
// server and share one database, and the machine this runs on has little
// memory to spare.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(SERVER_ROOT, 'tests');
const VENDOR_DIR = path.join(TESTS_DIR, 'vendor');

const problems = [];

// ── The disposable database ─────────────────────────────────────────────
//
// 47 tests write, cancel and delete rows, and one of them truncates. The
// refusal below is the only thing standing between that and a real database,
// so it checks the name as well as the presence.
const scratch = process.env.STOCK_TEST_DATABASE_URL;
if (!scratch) {
  problems.push(
    'STOCK_TEST_DATABASE_URL is not set, so 47 database tests would be skipped.\n' +
    '    Point it at a DISPOSABLE database, never at one with real data:\n' +
    '      export STOCK_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gst_stock_scratch\n' +
    '    Create it once with:  createdb gst_stock_scratch');
} else if (/hostinger|onrender|render\.com|amazonaws|azure|supabase/i.test(scratch)) {
  problems.push(
    'STOCK_TEST_DATABASE_URL looks like a hosted database:\n' +
    '      ' + scratch.replace(/:\/\/[^@]*@/, '://***@') + '\n' +
    '    These tests truncate and delete. Point it at a local scratch database.');
}

// ── jsPDF ───────────────────────────────────────────────────────────────
//
// jsPDF is a CDN <script> in the browser and deliberately not a server
// dependency, so the render tests need a copy to exist somewhere. The order
// below is the one the test files themselves use (JSPDF_PATH, then
// node_modules), plus a local vendor directory for a machine that would
// rather not install anything. Nothing here is a path to any one machine.
function findLib(envVar, pkg, file) {
  const candidates = [
    process.env[envVar],
    path.join(SERVER_ROOT, 'node_modules', pkg, 'dist', file),
    path.join(VENDOR_DIR, file)
  ].filter(Boolean);
  return candidates.find((f) => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  }) || null;
}

const jspdf = findLib('JSPDF_PATH', 'jspdf', 'jspdf.umd.min.js');
const autotable = findLib('JSPDF_AUTOTABLE_PATH', 'jspdf-autotable', 'jspdf.plugin.autotable.min.js');

if (!jspdf || !autotable) {
  const missing = [!jspdf && 'jsPDF', !autotable && 'the autoTable plugin'].filter(Boolean).join(' and ');
  problems.push(
    missing + ' could not be found, so 6 PDF render tests would be skipped.\n' +
    '    Any one of these works - the first is usually easiest:\n' +
    '      1. cd server && npm install --no-save jspdf jspdf-autotable\n' +
    '      2. put jspdf.umd.min.js and jspdf.plugin.autotable.min.js in\n' +
    '         server/tests/vendor/   (git-ignored; for a machine that is offline)\n' +
    '      3. export JSPDF_PATH=/abs/path/jspdf.umd.min.js\n' +
    '         export JSPDF_AUTOTABLE_PATH=/abs/path/jspdf.plugin.autotable.min.js');
}

if (problems.length) {
  console.error('\nnpm run test:full cannot give a clean regression result yet.\n');
  problems.forEach((p, i) => console.error('  ' + (i + 1) + '. ' + p + '\n'));
  console.error('  Fix the above, or use `npm test` to run the suite with those tests skipped.\n');
  process.exit(1);
}

// ── The run ─────────────────────────────────────────────────────────────
//
// The files are listed here rather than passed as a shell glob: this is
// spawned without a shell, so a glob would reach node as a literal string on
// Windows, and an explicit list also lets the count be reported.
const files = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('tests', f));

if (!files.length) {
  console.error('No tests/*.test.js files found - is this the server directory?');
  process.exit(1);
}

console.log('Running ' + files.length + ' test files serially.');
console.log('  database : ' + scratch.replace(/:\/\/[^@]*@/, '://***@'));
console.log('  jsPDF    : ' + path.relative(SERVER_ROOT, jspdf));
console.log('  autoTable: ' + path.relative(SERVER_ROOT, autotable) + '\n');

const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: SERVER_ROOT,
  env: { ...process.env, JSPDF_PATH: jspdf, JSPDF_AUTOTABLE_PATH: autotable },
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024
});

process.stdout.write(run.stdout || '');

if (run.error) {
  console.error('\nCould not run the suite: ' + run.error.message);
  process.exit(1);
}

// ── The skip gate ───────────────────────────────────────────────────────
//
// Everything above exists so that nothing has a reason to skip. If something
// skipped regardless, that is a resource this runner does not yet know about,
// and reporting a pass would hide it.
const summary = (key) => {
  const m = new RegExp('^\\u2139 ' + key + ' (\\d+)$', 'm').exec(run.stdout || '');
  return m ? Number(m[1]) : null;
};
const skipped = summary('skipped');
const failed = summary('fail');
const passed = summary('pass');
const total = summary('tests');

console.log('\n' + '-'.repeat(60));
console.log('  files ' + files.length + '   tests ' + total + '   pass ' + passed
  + '   fail ' + failed + '   skipped ' + skipped);

if (run.status !== 0 || failed) {
  console.error('  RESULT: FAILED');
  process.exit(run.status || 1);
}
if (skipped) {
  console.error('  RESULT: INCOMPLETE - ' + skipped + ' test(s) skipped despite every resource being present.');
  console.error('  A skipped test is one that did not happen; find its guard before trusting this run.');
  process.exit(1);
}
console.log('  RESULT: PASSED - nothing skipped');
