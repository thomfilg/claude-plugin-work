/**
 * Step: 5_phase1_agents — Launch code-checker and completion-checker in parallel.
 * Tests are already handled by 4_run_tests (deterministic script).
 *
 * Returns a parallel_tasks instruction on first call.
 * On subsequent calls, checks if reports exist and auto-advances.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerPhase1(register) {
  register('5_phase1_agents', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';

    // Already dispatched — check if reports exist
    if (state.dispatched === '5_phase1_agents') {
      const hasCodeReview = fs.existsSync(path.join(reportFolder, 'code-review.check.md'));
      const hasCompletion = fs.existsSync(path.join(reportFolder, 'completion.check.md'));
      if (hasCodeReview && hasCompletion) {
        return null; // all reports present → auto-advance
      }
    }

    state.dispatched = '5_phase1_agents';

    // Build structured verification context from planning artifacts
    let completionContext = '';
    try {
      const { buildCompletionContext } = require(
        path.join(__dirname, '..', 'step-enrichments', 'completion-context')
      );
      completionContext = buildCompletionContext(ctx.tasksDir, state.ticketId);
    } catch {
      completionContext = '(Could not load planning artifacts — verify against PR diff only)';
    }

    const completionPrompt = [
      `Verify ALL requirements for ${state.ticketId} against the actual code.`,
      `Write report to ${reportFolder}/completion.check.md. Changes hash: ${changesHash}`,
      '',
      '# Verification Context (pre-loaded from planning artifacts)',
      '',
      completionContext,
      '',
      '# Instructions',
      '',
      'Verify each layer in order (ticket → brief → spec → tasks).',
      'For EACH requirement/deliverable: grep or read the actual code to find evidence.',
      'Mark DELIVERED only with a code citation (file:line or diff excerpt).',
      'Mark INCOMPLETE if any P0 requirement lacks code evidence.',
    ].join('\n');

    return {
      type: 'check_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: '5_phase1_agents', progress: '5/9' },
      continue: true,
      delegate: {
        type: 'parallel_tasks',
        agents: [
          {
            agentType: 'work-workflow:code-checker',
            description: 'Code review',
            prompt: `Review code changes for ${state.ticketId}. Write report to ${reportFolder}/code-review.check.md. Changes hash: ${changesHash}`,
          },
          {
            agentType: 'work-workflow:completion-checker',
            description: 'Verify requirements',
            prompt: completionPrompt,
          },
        ],
        note: 'Launch ALL agents in parallel using multiple Task() calls in one message. Wait for all to complete.',
      },
    };
  });
};
