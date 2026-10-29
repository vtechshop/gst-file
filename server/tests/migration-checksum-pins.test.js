// The checksum pins the targeted migration runners carry.
//
// Five scripts under server/scripts/ hold an APPROVED_CHECKSUM for one
// migration file and refuse to run if the file no longer hashes to it. That
// guard is worth having, and it has exactly one way to go wrong silently: the
// pin can be computed from the author's WORKING COPY instead of from what git
// stores.
//
// .gitattributes pins *.sql to `eol=lf`, so git stores LF while a Windows
// checkout may hold CRLF, and migrator.checksum() hashes the bytes as they
// are read. A pin taken from a CRLF working copy therefore matches on the
// machine it was made on and cannot match anywhere else. That happened to
// migration_invoice_export_currency.sql: its pin was e4bca783... (the CRLF
// hash) while every host checks out cb29566d... (the LF hash), so the runner
// exited 1 on every deploy - and because `prestart` chains with &&, it
// blocked the entire application start on any host that runs `npm start`.
// It went unnoticed for a month because it cannot reproduce on Windows.
//
// These tests compare every pin against the COMMITTED blob, which is what a
// host actually gets. No database and no network: this is a repository-shape
// test, so it always runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'server', 'scripts');
const MIGRATIONS_REL = 'server/db/migrations';

// The runner's own hash function, imported rather than restated - a second
// copy of it here could drift and make this test agree with nothing.
const { checksum } = require('../src/db/migrator');

// Every runner that pins a checksum, discovered rather than listed, so a sixth
// one is covered the day it is written.
function pinnedRunners() {
  return fs.readdirSync(SCRIPTS)
    .filter((f) => f.startsWith('migrate-') && f.endsWith('.js'))
    .map((f) => ({ runner: f, src: fs.readFileSync(path.join(SCRIPTS, f), 'utf8') }))
    .filter((r) => r.src.includes('APPROVED_CHECKSUM'))
    .map((r) => {
      const pin = (/APPROVED_CHECKSUM\s*=\s*'([0-9a-f]{64})'/.exec(r.src) || [])[1];
      const file = (/const FILENAME\s*=\s*'([^']+)'/.exec(r.src) || [])[1];
      return { ...r, pin, file };
    });
}

// `git show HEAD:<path>` as a Buffer, or null when this is not a git checkout
// (a deployed tree has no .git). Returned as bytes, never decoded here, so
// nothing can normalise line endings on the way.
function committedBytes(relPath) {
  try {
    return execFileSync('git', ['show', 'HEAD:' + relPath],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const RUNNERS = pinnedRunners();

test('MP1 the pinned runners were found, and each names a pin and a migration', () => {
  // If the discovery above ever matches nothing, every test below would pass
  // vacuously. Five exist today; this is a floor, not an exact count.
  assert.ok(RUNNERS.length >= 5,
    'expected at least 5 pinned runners, found ' + RUNNERS.length);
  for (const r of RUNNERS) {
    assert.ok(r.pin, r.runner + ' has an APPROVED_CHECKSUM this test could not read');
    assert.ok(r.file, r.runner + ' has a FILENAME this test could not read');
    assert.ok(fs.existsSync(path.join(ROOT, MIGRATIONS_REL, r.file)),
      r.runner + ' points at a migration that does not exist: ' + r.file);
  }
});

test('MP2 every migration in the working copy is LF, as .gitattributes requires', () => {
  // The root cause, caught at its source. A CRLF migration on disk hashes
  // differently from the one git stores, which breaks both these pins and the
  // migrator's own drift detection against schema_migrations.
  const dir = path.join(ROOT, MIGRATIONS_REL);
  const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(sql.length > 0, 'no migrations found');
  const crlf = sql.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('\r\n'));
  assert.deepStrictEqual(crlf, [],
    'these migrations have CRLF endings in the working copy, so they do not hash\n'
    + 'like the blobs git stores. Run: git add --renormalize ' + MIGRATIONS_REL + '\n'
    + '  ' + crlf.join('\n  '));
});

test('MP3 .gitattributes still pins *.sql to LF', () => {
  // Every guarantee above rests on this line. Without it a fresh Windows
  // clone gets CRLF migrations again and the whole class of bug returns.
  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\.sql\s+text\s+eol=lf\s*$/m,
    '.gitattributes must keep `*.sql text eol=lf`');
});

test('MP4 each pin is the hash of its migration as it exists on disk', () => {
  // The guard the runner itself applies. With MP2 holding, the file on disk is
  // LF and therefore byte-identical to the committed blob, so this is already
  // the deployable check - MP5 then proves it against git directly.
  for (const r of RUNNERS) {
    const sql = fs.readFileSync(path.join(ROOT, MIGRATIONS_REL, r.file), 'utf8');
    const actual = checksum(sql);
    assert.strictEqual(actual, r.pin,
      r.runner + ' would refuse to run: its pin does not match ' + r.file + '\n'
      + '    pin     : ' + r.pin + '\n'
      + '    on disk : ' + actual);
  }
});

test('MP5 each pin is the hash of the COMMITTED blob - what a host checks out', () => {
  // The decisive one, and the check whose absence let this ship. A pin is only
  // correct if it matches what git stores, because that is what Render,
  // Hostinger and every CI runner receive. Compared as raw bytes.
  const checked = [];
  for (const r of RUNNERS) {
    const bytes = committedBytes(MIGRATIONS_REL + '/' + r.file);
    if (bytes === null) continue;   // not a git checkout; MP2+MP4 still cover it
    assert.strictEqual(bytes.includes('\r\n'), false,
      r.file + ' is stored with CRLF in git, which .gitattributes forbids');
    const actual = checksum(bytes.toString('utf8'));
    assert.strictEqual(actual, r.pin,
      r.runner + ' can never pass its own checksum guard on a deployed host.\n'
      + '    ' + r.file + '\n'
      + '    pin in the runner : ' + r.pin + '\n'
      + '    committed blob    : ' + actual + '\n'
      + '    The pin was almost certainly taken from a CRLF working copy.\n'
      + '    Recompute it with: git show HEAD:' + MIGRATIONS_REL + '/' + r.file + ' | sha256sum');
    checked.push(r.runner);
  }
  // Not a skip: in this repository git is present, and saying so keeps the
  // test honest about what it actually verified.
  if (!checked.length) {
    assert.ok(!fs.existsSync(path.join(ROOT, '.git')),
      'this is a git checkout, so every pin should have been compared against HEAD');
  } else {
    assert.strictEqual(checked.length, RUNNERS.length,
      'every pinned runner must be compared against the committed blob');
  }
});

test('MP6 the working copy and the committed blob are byte-identical', () => {
  // Together with MP4 this is what makes MP5 meaningful on a machine where git
  // is unavailable: if the two forms are the same bytes, a pin that matches one
  // matches the other.
  for (const r of RUNNERS) {
    const bytes = committedBytes(MIGRATIONS_REL + '/' + r.file);
    if (bytes === null) continue;
    const disk = fs.readFileSync(path.join(ROOT, MIGRATIONS_REL, r.file));
    assert.ok(disk.equals(bytes),
      r.file + ' differs between the working copy and HEAD. If the only difference\n'
      + '    is line endings, run: git add --renormalize ' + MIGRATIONS_REL);
  }
});

test('MP7 invoice-export-currency specifically carries the LF hash', () => {
  // Named rather than left to the loops above, because this is the pin that
  // was wrong and the one a future edit is most likely to get wrong again.
  const r = RUNNERS.find((x) => x.runner === 'migrate-invoice-export-currency.js');
  assert.ok(r, 'the invoice-export-currency runner must exist');
  assert.strictEqual(r.pin,
    'cb29566dcb50c4f632fa0c4e9ae86cd5b41ee5fa8b8c0633d5714c95b6b55512',
    'this must be the sha256 of the LF blob, not the e4bca783... CRLF hash');
  assert.notStrictEqual(r.pin,
    'e4bca783d214e5626bce67223ba506d319af7d4df6995d21079a200f91bf0026',
    'the old CRLF-derived pin must never come back');
});

test('MP8 the checksum gate runs before anything that could mask it', () => {
  // readMigration() is the first statement of main(), before the database is
  // touched, so a mismatch stops the process whatever state the database is
  // in - and the process exits non-zero, which is what makes a bad pin block
  // `prestart`. Worth pinning: moving the gate below the already-applied
  // early return would turn this class of bug from loud into invisible.
  const src = fs.readFileSync(
    path.join(SCRIPTS, 'migrate-invoice-export-currency.js'), 'utf8');
  const mainAt = src.indexOf('async function main()');
  assert.ok(mainAt > -1);
  const readAt = src.indexOf('readMigration()', mainAt);
  const dbAt = src.indexOf("require('../src/config/pool')", mainAt);
  const doneAt = src.indexOf('already present and compatible', mainAt);
  assert.ok(readAt > -1 && dbAt > readAt,
    'the checksum must be verified before the database is opened');
  assert.ok(doneAt > readAt,
    'the checksum must be verified before the already-applied early return');
  assert.match(src, /process\.exit\(1\)/,
    'a failed check must exit non-zero, or prestart would continue past it');
});
