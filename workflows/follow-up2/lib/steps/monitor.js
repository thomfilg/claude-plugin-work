/**
 * Step: monitor — Check PR CI status + reviews.
 *
 * Calls follow-up-pr.js functions as a module (not subprocess).
 * This allows tests to mock ghExec and verify the full flow.
 *
 * Uses the exported functions: getPRInfo, checkCI, getReviews, formatReport.
 * formatReport produces the same output the agent would see from the CLI.
 */

'use strict';

const path = require('path');

module.exports = function registerMonitor(register) {
  register('monitor', (state, ctx) => {
    const followUpPr = require(path.join(ctx.workScriptsDir, 'follow-up-pr.js'));
    const { getPRInfo, checkCI, getReviews, formatReport, decideNextAction } = followUpPr;

    const prArg = state.prNumber || undefined;

    let prInfo, ci, reviews;
    try {
      prInfo = getPRInfo(prArg);
    } catch (err) {
      state.lastMonitorResult = { exitCode: 2, output: `Error getting PR info: ${err.message}` };
      return null;
    }

    if (!prInfo || !prInfo.number) {
      state.lastMonitorResult = { exitCode: 2, output: 'No PR found.' };
      return null;
    }

    if (prInfo.state === 'MERGED') {
      state.lastMonitorResult = { exitCode: 0, output: `PR #${prInfo.number} is merged.` };
      state.currentStep = 'report';
      return null;
    }

    try {
      ci = checkCI(prInfo.number);
    } catch (err) {
      state.lastMonitorResult = { exitCode: 2, output: `Error checking CI: ${err.message}` };
      return null;
    }

    try {
      reviews = getReviews(prInfo.number);
    } catch (err) {
      // Reviews are supplementary — fail-open
      reviews = {
        all: [],
        comments: [],
        actionable: [],
        blocking: [],
        nonBlocking: [],
        pendingBots: [],
        hasBlocking: false,
        hasActionable: false,
      };
    }

    // Build the same formatted output the CLI produces
    let output = '';
    try {
      const attempt = state.attempt || 1;
      const maxAttempts = state.maxAttempts || 40;
      output = formatReport(prInfo, ci, reviews, attempt, maxAttempts, {});
    } catch {
      // Fallback: build minimal output from raw data
      const lines = [];
      lines.push(`PR: #${prInfo.number} — ${prInfo.title || ''}`);
      lines.push(`CI: ${ci.status || 'unknown'}`);
      if (reviews.hasBlocking) {
        lines.push(`Reviews: ${reviews.blocking.length} BLOCKING`);
      } else if (reviews.pendingBots && reviews.pendingBots.length > 0) {
        lines.push('Reviews: Awaiting bot reviews');
      } else {
        lines.push('Reviews: CLEAR');
      }
      output = lines.join('\n');
    }

    // Determine exit code: 0 = all clear, 1 = issues remain
    const ciOk = ci.status === 'passing' || ci.status === 'no-checks';
    const reviewsOk =
      !reviews.hasBlocking && (!reviews.pendingBots || reviews.pendingBots.length === 0);
    const exitCode = ciOk && reviewsOk ? 0 : 1;

    state.lastMonitorResult = { exitCode, output: output.substring(0, 3000) };

    if (exitCode === 0) {
      state.currentStep = 'report';
    }

    return null;
  });
};
