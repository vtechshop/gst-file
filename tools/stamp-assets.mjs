#!/usr/bin/env node
// =============================================
// Asset cache-busting stamper
// =============================================
// Rewrites every local JavaScript and CSS reference in every HTML page to
// carry ?v=<ASSET_VERSION>, so a deployment cannot be served from a
// browser or CDN cache holding the previous file.
//
//   node tools/stamp-assets.mjs           stamp with ASSET_VERSION below
//   node tools/stamp-assets.mjs --check   report drift, change nothing
//   node tools/stamp-assets.mjs 7         stamp with an explicit build id
//
// Bumping ASSET_VERSION and running this is the whole deployment ritual.
// One value, one place.
//
// Why this exists: js/invoice-list.js was referenced without a version.
// Pagination was fixed in b5ebc7f and browsers kept running the copy from
// before it, so the fix appeared not to work no matter how often it was
// deployed. Two files on that same page already had a version; the one
// that mattered did not. A per-file habit is exactly how that happens,
// which is why this stamps everything rather than leaving it to memory.
//
// Deliberately NOT a date. A date invites hand-editing to "today" and
// says nothing about whether the assets actually changed; an integer that
// only ever goes up cannot be mistaken for anything else.
const ASSET_VERSION = '15';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const version = args.find(a => a !== '--check') || ASSET_VERSION;

// Only local assets are touched. A CDN URL carries its own version in the
// path and is not ours to rewrite.
const LOCAL_ASSET = /((?:src|href)=")((?:js|css)\/[A-Za-z0-9._\/-]+\.(?:js|css))(\?v=[^"]*)?(")/g;

const htmlFiles = fs.readdirSync(root).filter(f => f.endsWith('.html')).sort();
let changedFiles = 0, totalRefs = 0, alreadyCorrect = 0, rewritten = 0;
const drift = [];

for (const file of htmlFiles) {
  const full = path.join(root, file);
  const before = fs.readFileSync(full, 'utf8');
  const after = before.replace(LOCAL_ASSET, (m, lead, asset, existing, tail) => {
    totalRefs++;
    const want = `${lead}${asset}?v=${version}${tail}`;
    if (m === want) { alreadyCorrect++; return m; }
    rewritten++;
    drift.push(`${file}: ${asset}${existing ? ' had ' + existing.slice(1) : ' had no version'}`);
    return want;
  });
  if (after !== before) {
    changedFiles++;
    if (!checkOnly) fs.writeFileSync(full, after);
  }
}

console.log(`asset version   : ${version}`);
console.log(`html files      : ${htmlFiles.length}`);
console.log(`local asset refs: ${totalRefs}`);
console.log(`already correct : ${alreadyCorrect}`);
console.log(`${checkOnly ? 'would rewrite  ' : 'rewritten      '}: ${rewritten}  (in ${changedFiles} file${changedFiles === 1 ? '' : 's'})`);
if (drift.length) { console.log('\ndrift:'); drift.forEach(d => console.log('  ' + d)); }

// --check is for CI: a non-zero exit means a deployment would ship assets
// a browser could serve from cache.
process.exit(checkOnly && rewritten ? 1 : 0);
