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
  /^[^/]+\.html$/,        // the 28 root pages
  /^client\/css\/.+/,
  /^client\/js\/.+/,
  /^favicon\.ico$/
];

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

// Only committed files are publishable — see the note above.
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  return out.split('\0').filter(Boolean);
}

function selectFrontend(all) {
  const picked = [];
  for (const f of all) {
    if (!ALLOW.some((re) => re.test(f))) continue;
    if (DENY.some((re) => re.test(f))) {
      fail(`"${f}" matched the frontend allow-list but is denied by policy`);
    }
    picked.push(f);
  }
  return picked.sort();
}

// Refuses to write anywhere but public/. A crafted path can otherwise walk
// out of the destination with ".." and overwrite real source.
function destFor(rel) {
  const dest = path.resolve(PUBLIC_DIR, rel);
  const within = dest === PUBLIC_DIR || dest.startsWith(PUBLIC_DIR + path.sep);
  if (!within) fail(`"${rel}" resolves outside server/public`);
  return dest;
}

function main() {
  const files = selectFrontend(trackedFiles());
  if (!files.length) fail('no frontend files matched — refusing to write an empty public/');

  const pages = files.filter((f) => /^[^/]+\.html$/.test(f)).length;
  if (!pages) fail('no root-level HTML pages matched — refusing to publish a site with no pages');

  // Cleaned rather than merged, so a renamed or deleted page cannot survive
  // as a stale file that is still reachable over HTTP.
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });

  for (const rel of files) {
    const src = path.join(REPO_ROOT, rel);
    const dest = destFor(rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // The copy is only useful if it is exact — a truncated or re-encoded file
  // would serve a broken page rather than an obvious error, so every byte is
  // compared back and a mismatch stops the build.
  let mismatched = 0;
  for (const rel of files) {
    const a = fs.readFileSync(path.join(REPO_ROOT, rel));
    const b = fs.readFileSync(destFor(rel));
    if (!a.equals(b)) { console.error(`  MISMATCH: ${rel}`); mismatched++; }
  }
  if (mismatched) fail(`${mismatched} file(s) did not copy byte-for-byte`);

  const css = files.filter((f) => f.startsWith('client/css/')).length;
  const js = files.filter((f) => f.startsWith('client/js/')).length;
  const ico = files.filter((f) => f === 'favicon.ico').length;

  console.log('  build:public');
  console.log(`    pages        : ${pages}`);
  console.log(`    client/css   : ${css}`);
  console.log(`    client/js    : ${js}`);
  console.log(`    favicon.ico  : ${ico}`);
  console.log(`    total        : ${files.length} files, all byte-for-byte identical`);
  console.log(`    output       : server/public`);
}

main();
