/**
 * Step: infra-retry — Gate CI retries on infra-flake evidence (R2-R5, R12, R17).
 *
 * Deliverable 3.1 (GREEN): off-flag short-circuit, conflict / review_failure
 * bypass, and `classify() → code-failure` short-circuit. The full state machine
 * (attempt persistence, surface-on-exhaust) is layered on in deliverables
 * 3.2 / 3.3.
 *
 * See also: synapsys memory [[never-rerun-ci]] — feature defaults OFF; we
 * only consider a retry when ≥2 signals fire (enforced by the classifier).
 */

'use strict';

const path = require('node:path');

const getConfig = require(path.resolve(__dirname, '..', '..', '..', 'lib', 'get-config'));
const { classify } = require('../infra-classifier');

/**
 * Decide whether the infra-retry step should short-circuit without touching
 * the classifier.
 *
 * Three short-circuit predicates today:
 *  - feature flag is off (default — preserves `never-rerun-ci` invariant)
 *  - failureCategory indicates a merge conflict
 *  - failureCategory indicates a review failure (not a CI failure at all)
 *
 * @param {object} state
 * @returns {boolean}
 */
function shouldBypass(state) {
  const flag = getConfig('WORK_AUTO_RETRY_INFRA');
  if (!flag || flag === 'false' || flag === '0') return true;
  const cat = state && state.failureCategory;
  if (cat === 'conflict') return true;
  if (cat === 'review_failure') return true;
  return false;
}

module.exports = function registerInfraRetry(register) {
  register('infra-retry', (state, ctx) => {
    // R12: default the persisted retry record on first read so downstream
    // logic (cycle 3.2/3.3) can always rely on the shape.
    if (state && !state.infraRetry) {
      state.infraRetry = { count: 0, attempts: [] };
    }

    if (shouldBypass(state)) return null;

    // R1e / R7: consult the classifier. If it says the failure looks like
    // genuine code, do not consume a retry attempt.
    const result = classify(state || {}, ctx || {});
    if (!result || result.classification !== 'infra-suspected') return null;

    // Deliverables 3.2 / 3.3 layer the attempt-recording state machine and
    // the surface-on-exhaust branch on top of this short-circuit scaffold.
    return null;
  });
};
