// =============================================
// Generates shared/india-districts.js from the official LGD district
// export (Local Government Directory, Ministry of Panchayati Raj).
//
//   node tools/build-districts.mjs <path-to-lgd-districts.csv>
//
// The CSV is the ONLY source. Nothing here invents, adds, removes or
// corrects a district: the English district name is copied through
// verbatim, and a state is carried over only if it matches an entry in
// INDIAN_STATES. If the LGD export gains or loses a district, re-running
// this is the whole update.
//
// WHY A GENERATOR RATHER THAN A HAND-EDITED FILE
// 785 rows is past the point where a human edit is trustworthy, and the
// district list genuinely changes — states reorganise. Keeping the
// derivation in code means the next update is auditable: same input, same
// output, and the diff shows exactly which districts moved.
//
// STATE NAME MATCHING
// LGD and this application spell three states differently:
//
//   LGD                                           INDIAN_STATES
//   "Jammu And Kashmir"                           "Jammu and Kashmir"
//   "Andaman And Nicobar Islands"                 "Andaman and Nicobar Islands"
//   "The Dadra And Nagar Haveli And Daman And Diu"
//                        "Dadra and Nagar Haveli and Daman and Diu"
//
// Only case and a leading "The" differ. Rather than edit INDIAN_STATES —
// which is the stored value on every existing address row and feeds the
// GST place-of-supply split — the match is made case-insensitively with a
// leading "The " ignored. INDIAN_STATES stays the canonical key, so the
// generated data is addressable by exactly the string the app already
// stores.
//
// A state that fails to match is a hard error, not a silent drop. Silently
// losing a state would leave its District dropdown permanently empty and
// look like a UI bug rather than a data one.
// =============================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'shared', 'india-districts.js');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: node tools/build-districts.mjs <lgd-districts.csv>');
  process.exit(1);
}

// The LGD export carries local-language columns in a non-UTF-8 encoding.
// Only the *_english columns are read, so the file is decoded as latin1 —
// that leaves the ASCII English columns byte-exact and stops a decoder
// error in a column nobody reads from failing the whole build.
const text = fs.readFileSync(csvPath, 'latin1');

// RFC 4180: quoted fields, "" as a literal quote, commas inside quotes.
function parseLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const lines = text.split(/\r?\n/).filter(l => l.trim());
const header = parseLine(lines[0]).map(h => h.trim());
const iState = header.indexOf('state_name_english');
const iDist = header.indexOf('district_name_english');
if (iState < 0 || iDist < 0) {
  console.error('CSV is missing state_name_english / district_name_english');
  process.exit(1);
}

// INDIAN_STATES is read out of the shipped file rather than restated here,
// so the generated keys cannot drift from the dropdown's own list.
const utils = fs.readFileSync(path.join(ROOT, 'client', 'js', 'utilities', 'utils.js'), 'utf8');
const start = utils.indexOf('const INDIAN_STATES = [');
const INDIAN_STATES = [...utils.slice(start, utils.indexOf('];', start)).matchAll(/'([^']+)'/g)].map(m => m[1]);
if (INDIAN_STATES.length !== 36) {
  console.error(`expected 36 INDIAN_STATES, found ${INDIAN_STATES.length}`);
  process.exit(1);
}

const norm = s => String(s).trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
const canonical = new Map(INDIAN_STATES.map(s => [norm(s), s]));

const byState = new Map(INDIAN_STATES.map(s => [s, []]));
const unmatched = new Set();
let rows = 0;

for (const line of lines.slice(1)) {
  const cols = parseLine(line);
  const lgdState = (cols[iState] || '').trim();
  const district = (cols[iDist] || '').trim();
  if (!lgdState || !district) continue;      // blank rows are skipped, never guessed at
  rows++;
  const key = canonical.get(norm(lgdState));
  if (!key) { unmatched.add(lgdState); continue; }
  byState.get(key).push(district);
}

if (unmatched.size) {
  console.error('LGD states that match no INDIAN_STATES entry:');
  [...unmatched].forEach(s => console.error(`  "${s}"`));
  process.exit(1);
}

// Deduplicate defensively and sort, so the dropdown reads alphabetically
// and a re-run produces a byte-identical file.
let total = 0;
const data = {};
for (const state of INDIAN_STATES) {
  const list = [...new Set(byState.get(state))].sort((a, b) => a.localeCompare(b, 'en'));
  data[state] = list;
  total += list.length;
}

const empty = INDIAN_STATES.filter(s => !data[s].length);
if (empty.length) {
  console.error('states with no districts:', empty.join(', '));
  process.exit(1);
}

const body = INDIAN_STATES
  .map(s => `    ${JSON.stringify(s)}: [\n${data[s].map(d => `      ${JSON.stringify(d)}`).join(',\n')}\n    ]`)
  .join(',\n');

const file = `// =============================================
// India State/UT -> District master data.
//
// GENERATED FILE — DO NOT EDIT BY HAND.
//   node tools/build-districts.mjs <lgd-districts.csv>
//
// Source: Local Government Directory (LGD), Ministry of Panchayati Raj,
// Government of India — the official district register. District names are
// the LGD English spellings, copied verbatim; none is invented, renamed or
// corrected here.
//
// Keys are INDIAN_STATES values (js/utils.js), which is what every address
// row already stores, so a state read from the database indexes this
// directly. LGD's own spelling differs for three states by case and a
// leading "The"; the generator reconciles that rather than changing
// INDIAN_STATES, because those strings drive the GST place-of-supply
// split and must not move.
//
// Shared deliberately: the browser loads it as a plain script and the
// server require()s it, so the list the user picks from is the same list
// the API validates against. Two copies of a master list drift, and when
// they do the database ends up holding a district the UI would refuse.
//
// States/UTs: ${INDIAN_STATES.length}   Districts: ${total}
// =============================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IndiaDistricts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INDIA_DISTRICTS = {
${body}
  };

  // The districts of one state, or [] for anything unrecognised. Never
  // null: every caller renders a list, and a null here would mean each of
  // them needed its own guard.
  function districtsForState(state) {
    if (!state) return [];
    var key = String(state).trim();
    if (INDIA_DISTRICTS[key]) return INDIA_DISTRICTS[key];
    // Tolerate case/spacing drift in stored data without accepting a
    // different state: only an exact case-insensitive name matches.
    var want = key.toLowerCase().replace(/\\s+/g, ' ');
    var names = Object.keys(INDIA_DISTRICTS);
    for (var i = 0; i < names.length; i++) {
      if (names[i].toLowerCase() === want) return INDIA_DISTRICTS[names[i]];
    }
    return [];
  }

  // Is this district one of that state's districts?
  //
  // An EMPTY district is valid. District is a new field on rows that have
  // existed for years without one, and on forms where it is optional —
  // treating blank as invalid would make every one of those records
  // unsavable the moment someone edits an unrelated field. Requiredness,
  // where a form wants it, is that form's own check.
  //
  // An unknown STATE is also not judged here. This answers "does this
  // district belong to this state", and with no state there is no question
  // to answer — reporting a mismatch would blame the district for a state
  // that was never chosen.
  function isValidStateDistrict(state, district) {
    var d = district == null ? '' : String(district).trim();
    if (!d) return true;
    var list = districtsForState(state);
    if (!list.length) return true;
    for (var i = 0; i < list.length; i++) {
      if (list[i].toLowerCase() === d.toLowerCase()) return true;
    }
    return false;
  }

  // The stored spelling for a district, so a value that differs only in
  // case is saved the way LGD writes it. Returns '' when there is no match
  // — callers must not treat that as "delete the value".
  function canonicalDistrict(state, district) {
    var d = district == null ? '' : String(district).trim();
    if (!d) return '';
    var list = districtsForState(state);
    for (var i = 0; i < list.length; i++) {
      if (list[i].toLowerCase() === d.toLowerCase()) return list[i];
    }
    return '';
  }

  return {
    INDIA_DISTRICTS: INDIA_DISTRICTS,
    districtsForState: districtsForState,
    isValidStateDistrict: isValidStateDistrict,
    canonicalDistrict: canonicalDistrict
  };
}));
`;

fs.writeFileSync(OUT, file, 'utf8');
console.log(`  read ${rows} district rows from ${path.basename(csvPath)}`);
console.log(`  wrote ${path.relative(ROOT, OUT)}`);
console.log(`  states/UTs: ${INDIAN_STATES.length}   districts: ${total}`);
