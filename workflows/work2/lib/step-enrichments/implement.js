/**
 * Implement step enrichment.
 *
 * Replaces the raw TDD protocol with tdd-next.js read-only instructions
 * and forces delegation to a developer agent (tdd-phase-state.js is agent-gated).
 * Injects brief, spec, and tasks content into the delegation prompt.
 */

'use strict';

const path = require('path');

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const { tasksDir, fs } = ctx;
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
        red: 'RED phase — write failing tests',
        green: 'GREEN phase — make tests pass with minimum code',
        refactor: 'REFACTOR phase — clean up code',
      }[currentPhase] || `${currentPhase} phase`;

    // Read artifacts for injection into the developer agent prompt
    function readArtifact(filename, maxLen) {
      try {
        const content = fs.readFileSync(path.join(tasksDir, filename), 'utf8');
        return content.length > maxLen
          ? content.slice(0, maxLen) +
              `\n\n[... truncated, read full file at: ${path.join(tasksDir, filename)}]`
          : content;
      } catch {
        return null;
      }
    }

    const brief = readArtifact('brief.md', 3000);
    const spec = readArtifact('spec.md', 5000);
    const tasks = readArtifact('tasks.md', 3000);

    // Build context block from available artifacts
    const contextParts = [];
    if (brief) contextParts.push(`## Brief\n\n${brief}`);
    if (spec) contextParts.push(`## Spec\n\n${spec}`);
    if (tasks) contextParts.push(`## Tasks\n\n${tasks}`);
    const contextBlock = contextParts.length > 0 ? '\n\n' + contextParts.join('\n\n') : '';

    // Strip the raw TDD protocol from the prompt (will be replaced)
    let prompt = entry.agentPrompt;
    const tddProtocolStart = prompt.indexOf('TDD protocol (hook-enforced');
    if (tddProtocolStart >= 0) {
      const afterProtocol = prompt.indexOf('\n## ', tddProtocolStart + 1);
      prompt =
        afterProtocol >= 0
          ? prompt.slice(0, tddProtocolStart) + prompt.slice(afterProtocol)
          : prompt.slice(0, tddProtocolStart);
    }

    const delegationBlock = [
      '## CRITICAL: Delegate to developer agent',
      '',
      'You MUST delegate implementation to one of these authorized developer agents:',
      '- **developer-nodejs-tdd** — Node.js/Express/NestJS backend (recommended for this project)',
      '- **developer-react-senior** — React applications',
      '- **developer-react-ui-architect** — React UI with visual design focus',
      '- **developer-devops** — Infrastructure/deployment/CI tasks',
      '',
      'Do NOT run tdd-phase-state.js yourself — it is agent-gated and WILL be blocked.',
      'Do NOT try different paths — ALL paths are blocked outside developer agents.',
      '',
      `**Current TDD phase: ${phaseLabel}**`,
      taskMatch ? `**Task: ${taskMatch[1]}**` : '',
      '',
      'Choose the appropriate agent and delegate the CURRENT PHASE:',
      '```',
      'Task(<chosen-agent>):',
      `  description: "implement ${taskMatch ? `task ${taskMatch[1]} ` : ''}${currentPhase} phase for ${ticket}"`,
      `  prompt: "Execute the ${currentPhase.toUpperCase()} phase${taskMatch ? ` of task ${taskMatch[1]}` : ''}. <include the implementation prompt and artifacts below>"`,
      '```',
      '',
      'After the agent completes ONE phase, call work-next.js again.',
      'It will detect the phase change and tell you what to delegate next.',
      '',
      '## TDD Phase Helper (read-only)',
      '',
      'The developer agent can check current TDD phase with:',
      '```bash',
      `node "${tddNextPath}" ${ticket}${taskFlag}`,
      '```',
      'This shows: current phase, allowed files, and exact commands to run.',
      'The tdd-phase-state.js commands in the output WILL work from inside the developer agent.',
      '',
      '---',
      '',
      '## Implementation Prompt (pass this to the developer agent)',
      '',
      prompt.trim(),
      contextBlock,
    ].join('\n');

    entry.agentPrompt = delegationBlock;
    // Override delegation type: must be task (not skill) so AI uses Task(developer-nodejs-tdd)
    // instead of Skill(work-implement) which can't call agent-gated scripts
    entry.agentType = 'developer-nodejs-tdd';
  });
};
