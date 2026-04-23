#!/usr/bin/env node

/**
 * PreToolUse hook: Protect tasks.md from edits outside allowed steps.
 *
 * GH-258 Task 5: Blocks Edit/Write/MultiEdit to tasks.md when the current
 * workflow step is NOT `tasks` or `task_review`. Fail-open on errors.
 *
 * Allowed steps: tasks, task_review
 * All other steps: blocked (exit 2)
 * No workflow active: allowed (exit 0, fail-open)
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));

const BLOCKED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const ALLOWED_STEPS = new Set(['tasks', 'task_review']);

/**
 * Get the ticket ID from TICKET_ID env var or derive from branch name.
 * @returns {string|null}
 */
function getTicketId() {
  if (process.env.TICKET_ID) return process.env.TICKET_ID;
  try {
    const branch = require('child_process')
      .execSync('git branch --show-current', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
    const match = branch.match(/^(GH-\d+|[A-Z]+-\d+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Get the current in_progress step from .work-state.json.
 * @param {string} ticketId
 * @returns {string|null}
 */
function getCurrentStep(ticketId) {
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase) return null;

    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const stepStatus = state.stepStatus || {};

    for (const [step, status] of Object.entries(stepStatus)) {
      if (status === 'in_progress') return step;
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Only check blocked tools
  if (!BLOCKED_TOOLS.has(toolName)) {
    process.exit(0);
  }

  // Get the file path being edited
  const filePath = toolInput.file_path || toolInput.path || '';

  // Only protect tasks.md
  if (path.basename(filePath) !== 'tasks.md') {
    process.exit(0);
  }

  // Get ticket ID — fail-open if unavailable
  const ticketId = getTicketId();
  if (!ticketId) {
    process.exit(0);
  }

  // Get current step — fail-open if unavailable
  const currentStep = getCurrentStep(ticketId);
  if (!currentStep) {
    process.exit(0);
  }

  // Allow edits during tasks and task_review steps
  if (ALLOWED_STEPS.has(currentStep)) {
    process.exit(0);
  }

  // Block edits to tasks.md in all other steps
  process.stderr.write(
    `tasks.md is protected during the '${currentStep}' step.\n\n` +
      `Edits to tasks.md are only allowed during the 'tasks' or 'task_review' steps.\n` +
      `Current step: ${currentStep}\n`
  );
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0); // fail-open
});
