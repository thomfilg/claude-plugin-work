/**
 * Implement step enrichment.
 *
 * Prepends a clear instruction to delegate immediately to a developer agent
 * without trying to run TDD commands directly (they're agent-gated).
 */

'use strict';

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const prefix =
      'IMPORTANT: Do NOT run tdd-phase-state.js or any TDD commands directly. ' +
      'Delegate IMMEDIATELY to the developer agent (developer-nodejs-tdd). ' +
      'The developer agent will handle TDD initialization and all implementation work.\n\n';

    // Only prepend if it's a skill delegation (work-implement)
    if (entry.agentType === 'skill') {
      entry.agentPrompt = prefix + entry.agentPrompt;
    }
  });
};
