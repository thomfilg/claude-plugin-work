/**
 * Step: triage — Parse monitor output to determine next action.
 *
 * Priority order:
 *   1. Merge conflict → fix-ci
 *   2. CI FAILING → fix-ci
 *   3. CI PENDING → back to monitor (wait for CI to finish)
 *   4. CI CANCELLED + merge blocked → fix-ci
 *   5. CI CANCELLED + merge NOT blocked → treat as passing
 *   6. Blocking reviews with NO ongoing bot review → fix-reviews
 *   7. Ongoing bot review (awaiting) → back to monitor (wait for bot)
 *   8. All clear (CI passed, no reviews) → report
 */

'use strict';

module.exports = function registerTriage(register) {
  register('triage', (state) => {
    const result = state.lastMonitorResult || {};
    const output = result.output || '';

    // Error (exit 2) — unrecoverable
    if (result.exitCode === 2) {
      return {
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Monitor error: ${output.substring(0, 500)}`,
      };
    }

    const hasConflict = /merge conflict|cannot be merged/i.test(output);
    const hasCiFailure = /CI:\s*FAILING/i.test(output);
    const hasCiPending = /CI:\s*PENDING/i.test(output);
    const hasCiCancelled = /CI:\s*CANCELLED/i.test(output);
    const isMergeBlocked = /MERGE STATUS:\s*BLOCKED/i.test(output);
    const hasBlockingReviews = /Reviews:.*BLOCKING/i.test(output);
    const hasOngoingReview = /awaiting bot reviews/i.test(output);

    if (hasConflict) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    if (hasCiFailure) {
      state.failureCategory = 'ci_failure';
      state.currentStep = 'fix-ci';
      return null;
    }

    // CI still running — should not reach here if monitor runs full polling.
    // Safety fallback: loop back to monitor.
    if (hasCiPending) {
      state.currentStep = 'monitor';
      return null;
    }

    // CI cancelled: only care if it blocks the merge
    if (hasCiCancelled && isMergeBlocked && !hasBlockingReviews) {
      state.failureCategory = 'ci_cancelled_blocking';
      state.currentStep = 'fix-ci';
      return null;
    }

    if (hasBlockingReviews && !hasOngoingReview) {
      state.failureCategory = 'reviews';
      state.currentStep = 'fix-reviews';
      return null;
    }

    // Bot still reviewing — loop back to monitor and wait
    if (hasOngoingReview) {
      state.currentStep = 'monitor';
      return null;
    }

    // Only reach report when CI passed AND no blocking reviews
    state.currentStep = 'report';
    return null;
  });
};
