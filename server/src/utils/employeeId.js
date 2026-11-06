// =============================================
// Employee ID generation
// =============================================
// VT-EMP-K7M4Q9 — a fixed prefix and six random characters.
//
// NOT SEQUENTIAL, and that is the point. EMP001, EMP002, EMP003 tells
// anyone holding one ID how many employees exist, which other IDs are
// valid, and — because the ID is also a login identifier here — exactly
// what to type at the login form to start guessing passwords against a
// real account. A sequential credential is an enumerable credential.
//
// Randomness comes from crypto.randomBytes, never Math.random: the latter
// is seeded predictably, is not meant to resist guessing, and would make
// the ID feel random while remaining reproducible.
//
// The alphabet omits I, L, O, U, 0 and 1. The first five because an ID is
// read off a screen and typed by a person, and I/l/1 and O/0 are where
// that goes wrong; U so no six-character draw can spell an unfortunate
// word. 30 characters over 6 positions is 30^6 = 729,000,000
// combinations, which is not a secret — the password is the secret — but
// is far too sparse to walk.
const crypto = require('crypto');

const PREFIX = 'VT-EMP-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, U, 0, 1
const LENGTH = 6;
// Fresh IDs are drawn until one is free. A collision at 729 million is
// already vanishingly unlikely, so hitting this ceiling does not mean
// "unlucky" - it means something is wrong (the uniqueness check is
// pointing at the wrong column, or the table is unreadable) and the
// honest answer is to fail rather than loop.
const MAX_ATTEMPTS = 12;

// Rejection sampling, so every character is equally likely.
//
// The lazy version, `bytes[i] % ALPHABET.length`, is biased: 256 does not
// divide by 30, so the first 16 letters of the alphabet come up slightly
// more often than the rest. It would still look random and still pass a
// test that only checks the format. Bytes that land in the short tail are
// discarded instead.
function randomCode() {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 240
  let out = '';
  while (out.length < LENGTH) {
    const bytes = crypto.randomBytes(LENGTH * 2);
    for (const b of bytes) {
      if (b >= max) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === LENGTH) break;
    }
  }
  return PREFIX + out;
}

// Shape check, used by the login lookup and by validation. Anchored, so a
// string that merely contains a well-formed ID is not accepted.
const EMPLOYEE_ID_RE = new RegExp('^' + PREFIX + '[' + ALPHABET + ']{' + LENGTH + '}$');

function isEmployeeId(value) {
  return EMPLOYEE_ID_RE.test(String(value || '').trim().toUpperCase());
}

// Draws until the database says the code is free.
//
// `isTaken` does the asking, so this function needs no pool and stays
// unit-testable without one. Uniqueness is NOT established here though -
// it is established by uq_users_employee_code, the unique index. Two
// Admins creating an employee at the same instant could both be told a
// code is free; the index is what refuses the second INSERT, and the
// caller retries. A check without a constraint behind it is a race
// wearing a seatbelt.
async function generateEmployeeId(isTaken, attempts = MAX_ATTEMPTS) {
  for (let i = 0; i < attempts; i++) {
    const code = randomCode();
    if (!(await isTaken(code))) return code;
  }
  const e = new Error('Could not allocate an Employee ID. Please try again.');
  e.status = 503; e.expose = true; e.code = 'employee_id_unavailable';
  throw e;
}

// A temporary password the Admin reads out once.
//
// Same alphabet and the same reason: it is transcribed by a person, and an
// O that was a 0 is a support call. 12 characters from 30 symbols is about
// 59 bits - far beyond guessing - and it is replaced on first login
// anyway, so the only thing it has to survive is the walk from the Admin's
// screen to the employee's keyboard.
function generateTemporaryPassword(length = 12) {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b >= max) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

module.exports = {
  PREFIX,
  ALPHABET,
  LENGTH,
  MAX_ATTEMPTS,
  EMPLOYEE_ID_RE,
  randomCode,
  isEmployeeId,
  generateEmployeeId,
  generateTemporaryPassword
};
