// Stops the server global-setup started and removes the state file.
//
// The seeded rows are deliberately left in the scratch database: a failed run
// is much easier to understand with its data still there, and the next run
// truncates before it seeds anyway.
const { readState, clearState } = require('./harness');

module.exports = async function globalTeardown() {
  let state = null;
  try { state = readState(); } catch { return; }   // setup never got far enough

  if (state.serverPid) {
    try { process.kill(state.serverPid); }
    catch (e) {
      // Already gone, which is fine - say so rather than failing a run that
      // otherwise passed.
      if (e.code !== 'ESRCH') console.warn('[e2e] could not stop server ' + state.serverPid + ': ' + e.message);
    }
  }
  clearState();
};
