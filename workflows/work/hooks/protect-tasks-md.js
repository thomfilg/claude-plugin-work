#!/usr/bin/env node

/**
 * PreToolUse hook: Protect tasks.md from edits outside allowed steps.
 *
 * GH-258 Task 5: Blocks Edit/Write/MultiEdit/Bash to tasks.md when the current
 * workflow step is NOT `tasks` or `task_review`. Fail-open on errors.
 *
 * Refactored to use createArtifactProtector factory (GH-258 code review).
 *
 * Allowed steps: tasks, task_review
 * All other steps: blocked (exit 2)
 * No workflow active: allowed (exit 0, fail-open)
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { createArtifactProtector } = require(path.join(__dirname, '..', '..', 'lib', 'protect-artifact-files'));

const ALLOWED_STEPS = new Set(['tasks', 'task_review']);

// Use 'tasks' as the canonical step name for the factory rule.
// The getStepInProgress wrapper maps task_review → tasks so the factory
// single-step check passes for both allowed steps.
const CANONICAL_STEP = 'tasks';

/**
 * Get the ticket ID from TICKET_ID env var or derive from branch name.
 * @param {object} [hookData]
 * @returns {string|null}
 */
function getTicketId(hookData) {
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
    if (!match) return null;
    let ticketId = match[1];
    try {
      const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
      ticketId = config.safeTicketId(ticketId);
    } catch { /* use raw if config unavailable */ }
    return ticketId;
  } catch {
    return null;
  }
}

/**
 * Get the current in_progress step from .work-state.json.
 * Returns the canonical step name ('tasks') when either tasks or task_review
 * is in_progress, so the factory's single-step rule works correctly.
 * @param {string} ticketId
 * @returns {string|null}
 */
function getStepInProgress(ticketId) {
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase) return null;

    // GH-258: ticketId is already sanitized by getTicketId (via config.safeTicketId)
    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const stepStatus = state.stepStatus || {};

    for (const [step, status] of Object.entries(stepStatus)) {
      if (status === 'in_progress') {
        // Map allowed steps to canonical step so the factory rule matches
        return ALLOWED_STEPS.has(step) ? CANONICAL_STEP : step;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const protector = createArtifactProtector({
  artifacts: [{ basename: 'tasks.md', step: CANONICAL_STEP }],
  getStepInProgress,
  getTicketId,
});

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  const result = protector.check(toolName, toolInput, hookData);
  if (result.blocked) {
    process.stderr.write(result.message);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0); // fail-open
});
