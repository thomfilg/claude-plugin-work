/**
 * Implement step enrichment.
 *
 * Overrides agentType to developer-nodejs-tdd (agent-gated for TDD scripts).
 * Builds a compact prompt with file references instead of embedding content.
 * The agent reads brief/spec/tasks from disk — no need to duplicate them in the prompt.
 */

'use strict';

const path = require('path');

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    // Resolve tdd-next.js via plugin root (not __dirname) to avoid agents rewriting
    // the dev repo path to the worktree cwd where work2/ doesn't exist.
    const { resolvePluginRoot } = require(path.join(__dirname, '..', 'resolve-plugin-root'));
    const pluginRoot = resolvePluginRoot(__dirname, 4);
    const tddNextPath = path.join(pluginRoot, 'workflows', 'work2', 'tdd-next.js');
    const ticket = ctx.ticket || 'TICKET';

    // Extract task number and title from the plan generator prompt
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of (\d+)/);
    const taskNum = taskMatch ? taskMatch[1] : null;
    const totalTasks = taskMatch ? taskMatch[2] : null;
    const taskFlag = taskNum ? ` --task ${taskNum}` : '';

    // Extract task title from prompt
    const titleMatch = entry.agentPrompt.match(/## Current Task: Task \d+ — (.+?)(?:\n|$)/);
    const taskTitle = titleMatch ? titleMatch[1].trim() : 'Implementation';

    // Read current TDD phase
    const { readPhase } = require(path.join(__dirname, '..', '..', 'tdd-next.js'));
    const tddState = readPhase(ticket.replace('#', 'GH-'), taskNum);
    const currentPhase = tddState?.currentPhase || 'red';
    const phaseLabel =
      {
        red: 'RED — write failing tests',
        green: 'GREEN — make tests pass with minimum code',
        refactor: 'REFACTOR — clean up code',
      }[currentPhase] || `${currentPhase} phase`;

    // Build compact prompt — agent reads files for details
    const tasksDir = ctx.tasksDir || '';
    const devPrompt = [
      `## Implement Task ${taskNum || '?'}/${totalTasks || '?'} — ${taskTitle}`,
      '',
      `### TDD Phase: ${phaseLabel}`,
      'Get phase commands:',
      '```bash',
      `node "${tddNextPath}" ${ticket}${taskFlag}`,
      '```',
      'Record evidence at each phase (init → red → green → refactor) or the task will be re-dispatched.',
      '',
      '### Required Reading (read IN FULL before implementing)',
      `- **Task details:** ${path.join(tasksDir, 'tasks.md')} (find "## Task ${taskNum}" section)`,
      `- **Spec:** ${path.join(tasksDir, 'spec.md')}`,
      `- **Brief:** ${path.join(tasksDir, 'brief.md')}`,
      '',
      '### Rules',
      `- Implement ONLY Task ${taskNum} deliverables`,
      '- Do NOT touch files reserved for other tasks',
      '- Do NOT invoke /work-implement or any other skill',
      '- Follow TDD: run tdd-next.js → do the work → record evidence → transition phase',
    ].join('\n');

    entry.agentPrompt = devPrompt;
    entry.agentType = 'developer-nodejs-tdd';
  });
};
