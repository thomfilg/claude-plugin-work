'use strict';

/**
 * Persist completion-checker enforcement failures + summary counters across
 * phase-runner invocations. `create-phase-runner.js` builds a fresh `ctx` per
 * invocation, so any `ctx.failures` pushed by an earlier enforcement phase
 * (reuse_audit, suggested_scope, test_pass_crossref) would otherwise be lost
 * by the time `report.js` runs in a later invocation. This module gives those
 * phases a tiny disk-backed mailbox keyed off `tasksDir`.
 */

const fs = require('node:fs');
const path = require('node:path');

const STORE_FILENAME = 'completion-enforcement-failures.json';

function storePath(tasksDir) {
  return path.join(tasksDir, STORE_FILENAME);
}

function emptyState() {
  return { failures: [], summary: { reuseChecked: 0, scopeChecked: 0, testsChecked: 0 } };
}

function readState(tasksDir) {
  try {
    const raw = fs.readFileSync(storePath(tasksDir), 'utf8');
    const parsed = JSON.parse(raw);
    const failures = Array.isArray(parsed && parsed.failures) ? parsed.failures : [];
    const summary = Object.assign(emptyState().summary, (parsed && parsed.summary) || {});
    return { failures, summary };
  } catch {
    return emptyState();
  }
}

function writeState(tasksDir, state) {
  try {
    fs.writeFileSync(storePath(tasksDir), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* hook-gated; persistence is best-effort */
  }
}

/**
 * Reset the store at the top of a completion-checker run so failures from a
 * previous attempt don't leak into the new verdict.
 */
function resetStore(tasksDir) {
  writeState(tasksDir, emptyState());
}

/**
 * Append new failure records (replacing any prior records of the same
 * `checkType`) and merge summary counters from this phase invocation.
 *
 * Records are keyed by `checkType` because each enforcement phase owns its
 * own checkType ('reuse_audit' / 'suggested_scope' / 'test_pass') — when a
 * phase re-runs (e.g. agent retries after a fix) its prior records should be
 * replaced, not duplicated.
 */
function appendForCheckType(tasksDir, checkType, newFailures, summaryPatch) {
  const state = readState(tasksDir);
  state.failures = state.failures.filter((f) => f && f.checkType !== checkType);
  for (const f of newFailures || []) state.failures.push(f);
  if (summaryPatch) Object.assign(state.summary, summaryPatch);
  writeState(tasksDir, state);
}

module.exports = {
  STORE_FILENAME,
  storePath,
  readState,
  writeState,
  resetStore,
  appendForCheckType,
  emptyState,
};
