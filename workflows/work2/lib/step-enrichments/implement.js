/**
 * Implement step enrichment.
 *
 * Overrides agentType to developer-nodejs-tdd (agent-gated for TDD scripts).
 * Replaces the raw TDD protocol with tdd-next.js instructions.
 * The prompt is written FOR the developer agent (it does the work directly).
 */

'use strict';

const path = require('path');

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const tddNextPath = path.join(__dirname, '..', '..', 'tdd-next.js');
    const ticket = ctx.ticket || 'TICKET';

    // Extract task number from prompt if present
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of \d+/);
    const taskFlag = taskMatch ? ` --task ${taskMatch[1]}` : '';

    // Read current TDD phase
    const { readPhase } = require(path.join(__dirname, '..', '..', 'tdd-next.js'));
    const taskNum = taskMatch ? taskMatch[1] : null;
    const tddState = readPhase(ticket.replace('#', 'GH-'), taskNum);
    const currentPhase = tddState?.currentPhase || 'red';
    const phaseLabel =
      {
        red: 'RED — write failing tests',
        green: 'GREEN — make tests pass with minimum code',
        refactor: 'REFACTOR — clean up code',
      }[currentPhase] || `${currentPhase} phase`;

    // Strip the raw TDD protocol from the prompt (replaced by tdd-next.js)
    let prompt = entry.agentPrompt;
    const tddProtocolStart = prompt.indexOf('TDD protocol (hook-enforced');
    if (tddProtocolStart >= 0) {
      const afterProtocol = prompt.indexOf('\n## ', tddProtocolStart + 1);
      prompt =
        afterProtocol >= 0
          ? prompt.slice(0, tddProtocolStart) + prompt.slice(afterProtocol)
          : prompt.slice(0, tddProtocolStart);
    }

    // Build the prompt for the developer agent (it does the work, no re-delegation)
    const devPrompt = [
      `## Current TDD Phase: ${phaseLabel}`,
      taskMatch ? `## Task: ${taskMatch[1]}` : '',
      '',
      '## TDD Phase Commands',
      '',
      'Check current phase and get exact commands:',
      '```bash',
      `node "${tddNextPath}" ${ticket}${taskFlag}`,
      '```',
      '',
      '---',
      '',
      prompt.trim(),
    ].join('\n');

    entry.agentPrompt = devPrompt;
    // Override to developer agent (required for TDD script authorization)
    entry.agentType = 'developer-nodejs-tdd';
  });
};
