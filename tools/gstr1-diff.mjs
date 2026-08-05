#!/usr/bin/env node
// =============================================
// GSTR-1 JSON structural diff
// =============================================
// Compares a JSON produced by js/gstr1-export.js against one produced by
// the official GST Offline Utility for the SAME invoices, and reports
// every structural difference between them.
//
//   node tools/gstr1-diff.mjs <ours.json> <official.json>
//
// A development utility. Nothing the app serves loads it, and nothing in
// the export path calls it — js/gstr1-export.js validates its own output
// before writing, and does not depend on anything here. It is a debugging
// aid for whoever is comparing two returns by hand.
//
// It reports what it can see and nothing else. It has no built-in idea of
// what the official schema is — the second file IS the specification for
// the purposes of this comparison, which is why the comparison needs one
// and cannot be simulated.
//
// Values are compared for TYPE and SHAPE, not for amount: the two files
// describe the same invoices, so a differing rupee figure is a finding
// about our arithmetic, while a differing key name or JSON type is a
// finding about our schema. Both are reported, separately.

import fs from 'node:fs';

const [, , oursPath, officialPath] = process.argv;
if (!oursPath || !officialPath) {
  console.error('usage: node tools/gstr1-diff.mjs <ours.json> <official.json>');
  process.exit(2);
}

const read = p => {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); }
  // The Offline Utility has been observed to write a UTF-8 BOM; strip it
  // rather than fail to parse, and report it as a byte-level difference.
  const hadBom = raw.charCodeAt(0) === 0xFEFF;
  if (hadBom) raw = raw.slice(1);
  try { return { json: JSON.parse(raw), raw, hadBom }; }
  catch (e) { console.error(`${p} is not valid JSON: ${e.message}`); process.exit(2); }
};

const ours = read(oursPath);
const official = read(officialPath);

const findings = { root: [], hierarchy: [], arrays: [], optional: [], names: [], types: [], precision: [], empty: [], bytes: [] };
const add = (bucket, path, ourVal, theirVal, note) =>
  findings[bucket].push({ path, ours: ourVal, official: theirVal, note });

const jsonType = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

// Decimal places actually written, from the source text of the number.
const decimals = n => {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
};

const isEmptyValue = v =>
  (Array.isArray(v) && v.length === 0) ||
  (v && typeof v === 'object' && Object.keys(v).length === 0) ||
  (v && typeof v === 'object' && Array.isArray(v.data) && v.data.length === 0);

// ── Root keys ───────────────────────────────────────────────
const ourRoot = Object.keys(ours.json);
const theirRoot = Object.keys(official.json);
theirRoot.filter(k => !ourRoot.includes(k)).forEach(k =>
  add('root', k, '(absent)', JSON.stringify(official.json[k]).slice(0, 120),
      'the Utility writes this root key and we do not'));
ourRoot.filter(k => !theirRoot.includes(k)).forEach(k =>
  add('root', k, JSON.stringify(ours.json[k]).slice(0, 120), '(absent)',
      'we write this root key and the Utility does not'));
if (ourRoot.join(',') !== theirRoot.filter(k => ourRoot.includes(k)).join(',')) {
  const shared = theirRoot.filter(k => ourRoot.includes(k));
  const oursShared = ourRoot.filter(k => theirRoot.includes(k));
  if (shared.join(',') !== oursShared.join(','))
    add('root', '(key order)', oursShared.join(','), shared.join(','),
        'key order differs — not a schema failure on its own, JSON objects are unordered');
}

// ── Recursive walk over everything present in either file ───
function walk(a, b, path) {
  const ta = jsonType(a), tb = jsonType(b);

  if (a === undefined) { add('optional', path, '(absent)', `${tb}`, 'present in the Utility output, missing from ours'); return; }
  if (b === undefined) { add('optional', path, `${ta}`, '(absent)', 'present in our output, absent from the Utility output'); return; }

  if (ta !== tb) { add('types', path, ta, tb, `JSON type differs (our value ${JSON.stringify(a)?.slice(0, 60)})`); return; }

  if (ta === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    kb.filter(k => !ka.includes(k)).forEach(k =>
      add('names', `${path}.${k}`, '(absent)', jsonType(b[k]), 'field written by the Utility, not by us'));
    ka.filter(k => !kb.includes(k)).forEach(k =>
      add('names', `${path}.${k}`, jsonType(a[k]), '(absent)', 'field written by us, not by the Utility'));
    [...new Set([...ka, ...kb])].forEach(k => {
      if (ka.includes(k) && kb.includes(k)) walk(a[k], b[k], `${path}.${k}`);
    });
    return;
  }

  if (ta === 'array') {
    if (a.length !== b.length) {
      add('arrays', path, `${a.length} element(s)`, `${b.length} element(s)`,
          'element count differs — check whether the two files describe the same invoices');
    }
    if (a.length === 0 && b.length === 0) return;
    // Compare shapes positionally as far as both go; a differing order is
    // reported as a shape difference rather than silently reordered, since
    // reordering would hide a real grouping difference.
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
    return;
  }

  if (ta === 'number') {
    const da = decimals(a), db = decimals(b);
    if (da !== db) add('precision', path, `${a} (${da} dp)`, `${b} (${db} dp)`, 'decimal places written differ');
    if (a !== b) add('precision', path, a, b, 'numeric value differs — same invoices should give the same figure');
    return;
  }

  if (a !== b) add('names', path, a, b, 'value differs');
}

// Only walk keys both files have at the root; root-only keys are already
// reported above and would otherwise be counted twice.
[...new Set([...ourRoot, ...theirRoot])]
  .filter(k => ourRoot.includes(k) && theirRoot.includes(k))
  .forEach(k => walk(ours.json[k], official.json[k], k));

// ── Empty-section handling ──────────────────────────────────
[...new Set([...ourRoot, ...theirRoot])].forEach(k => {
  const inOurs = ourRoot.includes(k), inTheirs = theirRoot.includes(k);
  const ourEmpty = inOurs && isEmptyValue(ours.json[k]);
  const theirEmpty = inTheirs && isEmptyValue(official.json[k]);
  if (inOurs && ourEmpty && !inTheirs)
    add('empty', k, JSON.stringify(ours.json[k]), '(key omitted)', 'we emit this section empty; the Utility omits it entirely');
  if (inTheirs && theirEmpty && !inOurs)
    add('empty', k, '(key omitted)', JSON.stringify(official.json[k]), 'the Utility emits this section empty; we omit it');
  if (inOurs && inTheirs && ourEmpty !== theirEmpty)
    add('empty', k, ourEmpty ? 'empty' : 'populated', theirEmpty ? 'empty' : 'populated', 'emptiness differs');
});

// ── Byte-level formatting ───────────────────────────────────
if (ours.hadBom !== official.hadBom)
  add('bytes', '(file)', ours.hadBom ? 'UTF-8 BOM' : 'no BOM', official.hadBom ? 'UTF-8 BOM' : 'no BOM', 'byte-order mark differs');
const indentOf = raw => { const m = raw.match(/\n(\s+)"/); return m ? `${m[1].length} space(s)` : 'none (single line)'; };
if (indentOf(ours.raw) !== indentOf(official.raw))
  add('bytes', '(file)', indentOf(ours.raw), indentOf(official.raw), 'indentation differs — cosmetic unless the Portal hashes the file');

// ── Report ──────────────────────────────────────────────────
const SECTIONS = [
  ['root', 'ROOT KEYS'], ['hierarchy', 'OBJECT HIERARCHY'], ['arrays', 'ARRAYS'],
  ['optional', 'OPTIONAL SECTIONS'], ['names', 'FIELD NAMES / VALUES'], ['types', 'DATA TYPES'],
  ['precision', 'NUMERIC PRECISION'], ['empty', 'EMPTY SECTION HANDLING'], ['bytes', 'BYTE-LEVEL FORMATTING']
];

console.log(`\nours     : ${oursPath}`);
console.log(`official : ${officialPath}\n`);
let total = 0;
SECTIONS.forEach(([key, title]) => {
  const rows = findings[key];
  total += rows.length;
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))} ${rows.length}`);
  if (!rows.length) { console.log('   (no differences)\n'); return; }
  rows.forEach(r => {
    console.log(`   path     : ${r.path}`);
    console.log(`   ours     : ${r.ours}`);
    console.log(`   official : ${r.official}`);
    console.log(`   reason   : ${r.note}\n`);
  });
});
console.log(`==== ${total} difference(s) ====`);
process.exit(total ? 1 : 0);
