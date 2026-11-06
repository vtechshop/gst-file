#!/usr/bin/env node
// =============================================
// Build server/public — the frontend Hostinger actually serves
// =============================================
// Hostinger's root directory can only be server/, so nothing above it
// exists at runtime. The frontend therefore has to be present INSIDE
// server/, and server/public/ is that copy.
//
// This exists because the first copy was made by hand. A hand copy cannot
// be repeated safely: it leaves stale files behind when a page is renamed,
// and it drifts silently from client/ the moment either side is edited.
//
// Two rules keep the output trustworthy:
//
//   The file list comes from `git ls-files`, never from walking a
//   directory. A directory walk would happily publish whatever happens to
//   be lying in the tree — an editor backup, a scratch dump, a .env
//   someone left in client/. Only what is committed can be published.
//
//   Every path is then checked against an allow-list anyway. Belt and
//   braces: if a backend file is ever committed somewhere the patterns
//   below would otherwise match, the deny check still refuses it.
//
// Run it after changing anything under client/ or the root pages:
//   npm run build:public
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..');
const PUBLIC_DIR = path.join(SERVER_DIR, 'public');

// What the browser loads, and nothing else. Anchored so that "client/js/x"
// matches but "server/client/js/x" cannot.
const ALLOW = [
  /^[^/]+\.html$/,        // the root pages
  /^client\/css\/.+/,
  /^client\/js\/.+/,
  /^favicon\.ico$/
];

// shared/*.js is loaded by BOTH sides: the browser gets it from /shared
// (app.js maps that to server/shared) and the server requires it from
// ../../shared, which from server/ is server/shared as well. So it is not
// part of public/ - it has its own destination.
//
// It used to be copied by hand. Two copies of a file the authorisation
// layer depends on, with nothing keeping them equal, is exactly the drift
// this script exists to prevent for public/; it now prevents it here too.
const SHARED_ALLOW = [/^shared\/.+\.js$/];

// Checked even after ALLOW has passed. These must never reach public/,
// whatever the allow-list thinks.
const DENY = [
  /^server\//,
  /^tools\//,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env/,
  /\.sql$/,
  /(^|\/)package(-lock)?\.json$/,
  /\.ya?ml$/
];

function fail(message) {
  console.error(`\n  BUILD FAILED: ${message}\n`);
  process.exit(1);
}

// The list comes from git rather than from walking the tree, so nothing
// outside the repository and nothing ignored can be published.
//
// --others --exclude-standard adds files that are NEW and not yet staged,
// while still honouring .gitignore. Without it a new page could only be
// mirrored after being committed, which made "build the mirror" and
// "commit" the same step - and left the served copy referencing scripts it
// did not contain. The DENY list below is still applied to every
// candidate, tracked or not.
function candidateFiles() {
  const out = execFileSync('git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
  // --cached and --others can both list the same path, so a file is never
  // copied, or counted, twice.
  return [...new Set(out.split('\0').filter(Boolean))];
}

function selectBy(all, allow) {
  const picked = [];
  for (const f of all) {
    if (!allow.some((re) => re.test(f))) continue;
    if (DENY.some((re) => re.test(f))) {
      fail(`"${f}" matched an allow-list but is denied by policy`);
    }
    picked.push(f);
  }
  return picked.sort();
}
const selectFrontend = (all) => selectBy(all, ALLOW);
const selectShared = (all) => selectBy(all, SHARED_ALLOW);

// Refuses to write anywhere but public/. A crafted path can otherwise walk
// out of the destination with ".." and overwrite real source.
function destFor(rel) {
  const dest = path.resolve(PUBLIC_DIR, rel);
  const within = dest === PUBLIC_DIR || dest.startsWith(PUBLIC_DIR + path.sep);
  if (!within) fail(`"${rel}" resolves outside server/public`);
  return dest;
}

// shared/x.js -> server/shared/x.js, with the same refusal to write
// anywhere but its own destination.
function sharedDestFor(rel) {
  const dest = path.resolve(SERVER_DIR, rel);
  const root = path.join(SERVER_DIR, 'shared');
  if (!dest.startsWith(root + path.sep)) fail(`"${rel}" resolves outside server/shared`);
  return dest;
}

// Copy, then read both back and compare bytes: a truncated or re-encoded
// file would serve a broken page rather than an obvious error.
function copyAll(files, dest) {
  for (const rel of files) {
    const to = dest(rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), to);
  }
  let mismatched = 0;
  for (const rel of files) {
    const a = fs.readFileSync(path.join(REPO_ROOT, rel));
    const b = fs.readFileSync(dest(rel));
    if (!a.equals(b)) { console.error(`  MISMATCH: ${rel}`); mismatched++; }
  }
  if (mismatched) fail(`${mismatched} file(s) did not copy byte-for-byte`);
}

function main() {
  const all = candidateFiles();
  const files = selectFrontend(all);
  const shared = selectShared(all);
  if (!files.length) fail('no frontend files matched — refusing to write an empty public/');
  if (!shared.length) fail('no shared/*.js matched — refusing to leave server/shared stale');

  const pages = files.filter((f) => /^[^/]+\.html$/.test(f)).length;
  if (!pages) fail('no root-level HTML pages matched — refusing to publish a site with no pages');

  // Cleaned rather than merged, so a renamed or deleted page cannot survive
  // as a stale file that is still reachable over HTTP.
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  copyAll(files, destFor);

  // server/shared is NOT emptied first: the server require()s these files
  // at startup, and a window in which they are missing is a window in
  // which the application cannot boot. Each is overwritten in place.
  copyAll(shared, sharedDestFor);

  const css = files.filter((f) => f.startsWith('client/css/')).length;
  const js = files.filter((f) => f.startsWith('client/js/')).length;
  const ico = files.filter((f) => f === 'favicon.ico').length;

  console.log('  build:public');
  console.log(`    pages        : ${pages}`);
  console.log(`    client/css   : ${css}`);
  console.log(`    client/js    : ${js}`);
  console.log(`    favicon.ico  : ${ico}`);
  console.log(`    shared/js    : ${shared.length}  -> server/shared`);
  console.log(`    total        : ${files.length + shared.length} files, all byte-for-byte identical`);
  console.log(`    output       : server/public + server/shared`);
}

main();
