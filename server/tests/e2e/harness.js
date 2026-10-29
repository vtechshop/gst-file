// The isolated world the browser specs run in.
//
// Deliberately the same shape as the node:test integration harnesses in
// tests/*.test.js - same disposable database, same spawned real server, same
// directly-minted JWT - so there is one way this project stands an app up for
// testing rather than two. The only addition is SERVE_CLIENT=1, because a
// browser needs the pages served and the API tests do not.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '..', '..');
// Where global-setup leaves what the specs need: the port the server actually
// got, and the token to sign in with. A file, because globalSetup and the
// specs are separate processes.
const STATE_FILE = path.join(__dirname, '.state.json');

// The browser keeps the session here; see API_TOKEN_KEY in
// client/js/api/apiClient.js. Injected before any script runs, which is how
// these specs sign in: the seeded user's password_hash is not a real hash
// (the integration tests never needed one), so the login form cannot be used
// and minting the token is the honest equivalent of a logged-in session.
const TOKEN_STORAGE_KEY = 'gst_jwt';

function requireScratchDatabase() {
  const url = process.env.STOCK_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'STOCK_TEST_DATABASE_URL is not set.\n' +
      'These tests write, cancel and delete rows, so they refuse to run without a\n' +
      'disposable database. Point it at a scratch database (gst_stock_scratch), never\n' +
      'at production.');
  }
  // A named guard rather than a comment: the whole safety argument for this
  // suite rests on this string not being the production database.
  if (/hostinger|onrender|render\.com/i.test(url)) {
    throw new Error('STOCK_TEST_DATABASE_URL looks like a hosted database. Refusing to run.');
  }
  return url;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startServer(port, databaseUrl) {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      // The one difference from the API harnesses: serve the pages too.
      SERVE_CLIENT: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const giveUp = setTimeout(() => {
      child.kill();
      reject(new Error('server did not start within 40s:\n' + out));
    }, 40_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) { clearTimeout(giveUp); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => {
      clearTimeout(giveUp);
      reject(new Error('server exited with ' + code + ':\n' + out));
    });
  });
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error('tests/e2e/.state.json is missing - global-setup did not run.');
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

module.exports = {
  SERVER_ROOT, STATE_FILE, TOKEN_STORAGE_KEY,
  requireScratchDatabase, freePort, startServer,
  writeState, readState, clearState
};
