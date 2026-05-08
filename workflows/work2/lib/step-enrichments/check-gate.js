/**
 * Check dispatch-advance gate.
 *
 * When check2's run-tests step fails, reads .check2-state.json
 * and triggers a backward transition check → implement so the
 * developer can fix the failing tests.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} safeName
 * @param {object} ctx
 * @param {object} deps
 * @returns {null | { recurse: true } | object}
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState, log, recursionDepth } = deps;

  // Read check2 state
  const checkStatePath = path.join(ctx.tasksDir, '.check2-state.json');
  let checkState;
  try {
    checkState = JSON.parse(fs.readFileSync(checkStatePath, 'utf8'));
  } catch {
    return null; // no check2 state — let normal flow handle
  }

  // If tests failed, transition back to implement
  if (checkState.testsFailed) {
    const ws = loadWorkState(safeName);
    if (!ws) return null;

    // Read the test report path for context
    const reportPath = path.join(ctx.tasksDir, 'tests.check.md');

    // Reset check2 state so next check run starts fresh
    try {
      fs.unlinkSync(checkStatePath);
    } catch {
      /* fail-open */
    }

    // Transition back to implement
    ws.stepStatus.check = 'pending';
    ws.stepStatus.commit = 'pending';
    ws.stepStatus.task_review = 'pending';
    ws.stepStatus.implement = 'in_progress';
    ws.currentStep = 7; // implement index
    delete ws._work2Dispatched;
    delete ws._work2DispatchedAction;
    saveWorkState(safeName, ws);

    if (log) {
      log.recurse(recursionDepth, 'check→implement (tests failed)');
    }

    return { recurse: true };
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
