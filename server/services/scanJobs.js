// =============================================
// Background scan jobs.
//
// A document scan takes tens of seconds — long enough that a user will
// reasonably switch to another page while waiting. Previously the work
// lived inside the HTTP request, so navigating away aborted the fetch
// and the whole scan (and its Gemini spend) was lost.
//
// The work now belongs to the server. The browser POSTs a file, gets a
// jobId back straight away, and afterwards is only a viewer: it polls
// that job, and may close, navigate or refresh freely without touching
// the work in flight.
//
// Storage is in-process, deliberately. A job holds only its extracted
// RESULT — never the uploaded bytes, which are released as soon as
// Gemini has seen them — so the footprint is a few KB and a Map is the
// right shape. The tradeoff is stated plainly: jobs survive navigation,
// refresh and closing the tab, but NOT a server restart or a Render
// spin-down, and they are per-instance. Surviving those would mean a
// jobs table in Postgres; that is the upgrade path if it ever matters.
// =============================================
const crypto = require('crypto');

// A running job is capped well above the worst realistic scan (three
// Gemini attempts at 60s plus backoff); a finished one sticks around
// long enough for a user to wander off and come back before importing.
const RUNNING_TTL_MS = 15 * 60 * 1000;
const DONE_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 200;   // backstop against unbounded growth

const jobs = new Map();

const isExpired = (job, now) => {
  const age = now - (job.finishedAt || job.createdAt);
  return job.status === 'running' ? age > RUNNING_TTL_MS : age > DONE_TTL_MS;
};

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) if (isExpired(job, now)) jobs.delete(id);
  // If something pathological outruns the TTL, drop the oldest rather
  // than let the map grow without bound.
  if (jobs.size > MAX_JOBS) {
    [...jobs.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, jobs.size - MAX_JOBS)
      .forEach(([id]) => jobs.delete(id));
  }
}

// One job per user at a time. A fresh upload supersedes whatever was
// running or waiting, which matches the single review panel the UI
// shows and stops an abandoned scan lingering in the list.
function create(userId, meta = {}) {
  sweep();
  removeForUser(userId);
  const job = {
    id: crypto.randomUUID(),
    userId,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    ...meta
  };
  jobs.set(job.id, job);
  return job;
}

function finish(id, result) {
  const job = jobs.get(id);
  if (!job) return;                       // superseded or already cleared
  job.status = 'done';
  job.result = result;
  job.finishedAt = Date.now();
}

function fail(id, status, message, reason) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.error = { status, message, reason };
  job.finishedAt = Date.now();
}

// Ownership is checked here rather than at the call site so a jobId
// cannot be used to read another account's scan.
function get(id, userId) {
  sweep();
  const job = jobs.get(id);
  return job && job.userId === userId ? job : null;
}

// What a returning page reconnects to when it has no jobId of its own —
// a different tab, or storage the browser cleared.
function activeForUser(userId) {
  sweep();
  let newest = null;
  for (const job of jobs.values()) {
    if (job.userId !== userId) continue;
    if (!newest || job.createdAt > newest.createdAt) newest = job;
  }
  return newest;
}

function remove(id, userId) {
  const job = jobs.get(id);
  if (job && job.userId === userId) { jobs.delete(id); return true; }
  return false;
}

function removeForUser(userId) {
  for (const [id, job] of jobs) if (job.userId === userId) jobs.delete(id);
}

// The wire shape. Never exposes userId, and only carries the result once
// there actually is one.
function toClient(job) {
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    fileCount: job.fileCount || 0,
    fileNames: job.fileNames || [],
    ...(job.status === 'done' ? { invoices: job.result } : {}),
    ...(job.status === 'error' ? { error: job.error } : {})
  };
}

module.exports = { create, finish, fail, get, activeForUser, remove, removeForUser, toClient };
