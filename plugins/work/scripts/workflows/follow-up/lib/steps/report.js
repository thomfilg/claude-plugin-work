/**
 * Step: report — Generate review-accountability.json on success. Marks complete.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Format a single infra-retry attempt into a human-readable diagnostic line.
 * Includes the GitHub Actions run URL so the surfaced bundle is clickable.
 * @param {{attemptNumber:number, timestamp:string, runId:string|number, signals:string[], retryMethod:string}} attempt
 * @param {string} repoUrl - https://github.com/<owner>/<repo>
 */
function formatAttemptLine(attempt, repoUrl) {
  const signals = Array.isArray(attempt.signals) ? attempt.signals.join(',') : '';
  const runUrl = `${repoUrl}/actions/runs/${attempt.runId}`;
  return [
    `- attemptNumber=${attempt.attemptNumber}`,
    `timestamp=${attempt.timestamp}`,
    `runId=${attempt.runId}`,
    `signals=[${signals}]`,
    `retryMethod=${attempt.retryMethod}`,
    `url=${runUrl}`,
  ].join(' ');
}

module.exports = function registerReport(register) {
  register('report', (state, ctx) => {
    // Final safety net: never mark complete while the latest monitor cycle
    // still shows merge conflicts. Catches the case where an earlier step
    // (triage/fix-ci) routed past a conflict without resolving it — e.g.
    // fix-ci falling through when there were no failing CI jobs to dispatch
    // a fix for. Send the workflow back to fix-ci instead.
    const lastOutput = (state.lastMonitorResult && state.lastMonitorResult.output) || '';
    if (state._isConflicting || /merge conflict|cannot be merged/i.test(lastOutput)) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    // R11: infra-stuck branch — surface the diagnostic bundle (run IDs as
    // GitHub Actions URLs, signal IDs, attempt timestamps) and require
    // manual intervention. Mirrors auto-advance's 'surface' terminal action.
    if (state.failureCategory === 'infra-stuck') {
      const attempts = (state.infraRetry && state.infraRetry.attempts) || [];
      const owner = state.repoOwner || 'OWNER';
      const repo = state.repoName || 'REPO';
      const repoUrl = `https://github.com/${owner}/${repo}`;
      const header = `## Infra-stuck after ${attempts.length} retries`;
      const lines = attempts.map((a) => formatAttemptLine(a, repoUrl));
      const body = [header, ...lines].join('\n');
      return {
        type: 'follow_up_instruction',
        action: 'surface',
        payload: {
          reason: 'infra-stuck',
          attempts,
          repoUrl,
        },
        state: {
          ticket: state.ticketId,
          currentStep: 'report',
          attempt: state.attempt,
        },
        summary: body,
      };
    }

    // Write accountability report if it doesn't exist
    const reportPath = path.join(ctx.tasksDir, 'review-accountability.json');
    const skippedReviews = state._skippedReviewsCount || 0;
    const solvedReviews = state._solvedReviewsCount || 0;
    if (!fs.existsSync(reportPath)) {
      try {
        fs.writeFileSync(
          reportPath,
          JSON.stringify(
            {
              ticketId: state.ticketId,
              prNumber: state.prNumber,
              attempts: state.attempt || 1,
              completedAt: new Date().toISOString(),
              status: 'success',
              reviewComments: { solved: solvedReviews, skipped: skippedReviews },
            },
            null,
            2
          )
        );
      } catch {
        /* fail-open */
      }
    }

    state.status = 'complete';

    const skipSuffix = skippedReviews
      ? ` — ${solvedReviews} review${solvedReviews !== 1 ? 's' : ''} fixed, ${skippedReviews} skipped (see follow-up-comments.json for rationale).`
      : '';

    return {
      type: 'follow_up_instruction',
      action: 'complete',
      state: { ticket: state.ticketId, currentStep: 'report', attempt: state.attempt },
      summary: `Follow-up complete for ${state.ticketId} PR #${state.prNumber || '?'} after ${state.attempt || 1} attempt(s)${skipSuffix}`,
    };
  });
};
