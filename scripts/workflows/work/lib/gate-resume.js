'use strict';

/**
 * Pure predicate: returns true only when the named workflow gate step has
 * already been recorded as `"completed"` in `workState.stepStatus`.
 *
 * Used by gate handlers (`spec_gate`, `tasks_gate`) to short-circuit
 * re-validation on resume — when a gate was previously satisfied, replaying
 * `/work` against the same state must be a no-op DEFER, never a fresh
 * validator invocation (see GH-398).
 *
 * Side-effect free: no I/O, no mutation of `workState`, safe to call with
 * `null` / `undefined` / partially-populated state objects from older
 * `.work-state.json` files (back-compat).
 *
 * @param {object|null|undefined} workState - Loaded `.work-state.json` (or `null`).
 * @param {string} stepName - Step identifier (e.g. `"spec_gate"`, `"tasks_gate"`).
 * @returns {boolean} `true` iff `workState.stepStatus[stepName] === "completed"`.
 */
function isGateAlreadySatisfied(workState, stepName) {
  if (workState == null) return false;
  const stepStatus = workState.stepStatus;
  if (stepStatus == null) return false;
  return stepStatus[stepName] === 'completed';
}

module.exports = { isGateAlreadySatisfied };
