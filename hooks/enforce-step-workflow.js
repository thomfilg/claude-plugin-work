#!/usr/bin/env node

/**
 * enforce-step-workflow.js
 *
 * Enforces two rules for MULTIPLE workflow state machines (/work and /work-pr):
 *
 * Rule 1 (PreToolUse — step command gate):
 *   Block a step's command unless that step is `in_progress`.
 *
 * Rule 2 (PreToolUse — transition gate):
 *   Block transitioning away from a step unless its expected command was executed.
 *
 * PostToolUse:
 *   Records evidence that a step's command was executed.
 *   Clears evidence on backward transitions.
 *
 * Both /work and /work-pr can be active simultaneously (work-pr runs inside
 * /work at step 9_pr). Each workflow is checked independently.
 *
 * Fail-open: Any error → exit 0 (allow).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { appendAction } = require(path.join(__dirname, '..', 'lib', 'work-actions'));

// ─── Configuration ──────────────────────────────────────────────────────────

const WORKTREES_BASE = '/home/node/worktrees';
const TASKS_BASE = path.join(WORKTREES_BASE, 'tasks');

// ─── Workflow Definitions ───────────────────────────────────────────────────
//
// Each workflow defines its own state file, step-to-command mapping,
// transition pattern, exemptions, and soft steps.

const WORKFLOWS = [
  {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: [
      '1_ticket', '2_bootstrap', '3_implement', '4_quality',
      '5_commit', '6_check', '7_cleanup', '8_test_enhancement',
      '9_pr', '10_ready', '11_ci', '12_reports', '13_complete',
    ],
    softSteps: new Set(['1_ticket', '12_reports']),
    commandMap: [
      // Skill-based steps (still delegated via Skill)
      { step: '3_implement',        tool: 'Skill', field: 'skill', pattern: /^work-implement$/ },
      { step: '6_check',            tool: 'Skill', field: 'skill', pattern: /^check$/ },
      { step: '8_test_enhancement', tool: 'Skill', field: 'skill', pattern: /^test-coordination$/ },
      { step: '9_pr',               tool: 'Skill', field: 'skill', pattern: /^work-pr$/ },
      // Task-based steps (subagent_type matching)
      { step: '5_commit',           tool: 'Task',  field: 'subagent_type', pattern: /^commit-writer$/ },
      { step: '4_quality',          tool: 'Task',  field: 'subagent_type', pattern: /^quality-checker$/ },
      // Task-based steps (description matching)
      { step: '1_ticket',           tool: 'Task',  field: 'description', pattern: /^1_ticket/i },
      { step: '4_quality',          tool: 'Task',  field: 'description', pattern: /^4_quality/i },
      { step: '7_cleanup',          tool: 'Task',  field: 'description', pattern: /^7_cleanup/i },
      { step: '10_ready',           tool: 'Task',  field: 'description', pattern: /^10_ready/i },
      { step: '11_ci',              tool: 'Task',  field: 'description', pattern: /^11_ci/i },
      { step: '12_reports',         tool: 'Task',  field: 'description', pattern: /^12_reports/i },
      { step: '13_complete',        tool: 'Task',  field: 'description', pattern: /^13_complete/i },
    ],
    transitionPattern: /work-orchestrator\.js\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /work-orchestrator\.js\s+(plan|transitions?|graph)/,
      /work-state\.js\s+(get|resume-info|init)/,
    ],
    transitionHint: 'node ~/.claude/plugins/cache/work-workflow/work-workflow/1.0.0/hooks/work-orchestrator.js transition',
  },
  {
    name: 'work-pr',
    stateFile: '.workflow-state.json',
    evidenceFile: '.step-evidence-work-pr.json',
    isActive: (state) => state?.status === 'in_progress' && state?.workflow === 'work-pr',
    steps: [
      '1_preflight', '2_setup', '3_pr_gen',
      '4_screenshot_gate', '5_post_pr_gen', '6_summary',
    ],
    softSteps: new Set(['1_preflight', '2_setup', '6_summary']),
    commandMap: [
      { step: '3_pr_gen',       tool: 'Task',  field: 'subagent_type', pattern: /^pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+create/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+edit/ },
      { step: '5_post_pr_gen',  tool: 'Task',  field: 'subagent_type', pattern: /^pr-post-generator$/ },
    ],
    transitionPattern: /workflow-engine\.js\s+work-pr\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /workflow-engine\.js\s+work-pr\s+(plan|transitions?|graph)/,
      /workflow-state\.js\s+work-pr\s+(get|resume-info|init)/,
    ],
    transitionHint: 'node ~/.claude/plugins/cache/work-workflow/work-workflow/1.0.0/lib/workflow-engine.js work-pr transition',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTicketId() {
  try {
    const branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    const match = branch.match(/APPSUPEN-\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function loadStateFile(ticketId, stateFile) {
  const p = path.join(TASKS_BASE, ticketId, stateFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  for (const step of steps) {
    if (state.stepStatus[step] === 'in_progress') return step;
  }
  return null;
}

function loadEvidence(ticketId, evidenceFile) {
  const p = path.join(TASKS_BASE, ticketId, evidenceFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function saveEvidence(ticketId, evidenceFile, evidence) {
  const dir = path.join(TASKS_BASE, ticketId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, evidenceFile), JSON.stringify(evidence, null, 2));
}

/**
 * Match a tool call to a workflow step using a command map.
 * Returns the step name or null if no match.
 */
function matchToolToStep(toolName, toolInput, commandMap) {
  for (const mapping of commandMap) {
    if (mapping.tool !== toolName) continue;

    // Tool-only match (no field pattern needed)
    if (mapping.field === null) return mapping.step;

    // Field pattern match
    const value = toolInput?.[mapping.field] || '';
    if (mapping.pattern && mapping.pattern.test(value)) return mapping.step;
  }
  return null;
}

/**
 * Check if a Bash command is exempted for a specific workflow.
 */
function isExempt(toolName, toolInput, exemptPatterns) {
  if (toolName !== 'Bash') return false;
  const cmd = toolInput?.command || '';
  return exemptPatterns.some(p => p.test(cmd));
}

/**
 * Parse a transition command for a specific workflow.
 * Returns { isTransition: true, ticket, targetStep } or { isTransition: false }.
 */
function parseTransition(toolName, toolInput, transitionPattern) {
  if (toolName !== 'Bash') return { isTransition: false };
  const cmd = toolInput?.command || '';
  const match = cmd.match(transitionPattern);
  if (match) {
    return { isTransition: true, ticket: match[1], targetStep: match[2] };
  }
  return { isTransition: false };
}

// ─── PreToolUse ─────────────────────────────────────────────────────────────

function handlePreToolUse(hookData) {
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // 1. Find active ticket
  const ticketId = getTicketId();
  if (!ticketId) return; // No ticket context → allow

  // 2. Check each workflow independently
  for (const wf of WORKFLOWS) {
    const state = loadStateFile(ticketId, wf.stateFile);
    if (!state || !wf.isActive(state)) continue; // Workflow not active → skip

    const currentStep = getCurrentStep(state, wf.steps);
    if (!currentStep) continue; // No step in_progress → skip

    // 3. Check exemptions for this workflow
    if (isExempt(toolName, toolInput, wf.exemptPatterns)) continue;

    // 4. Check if this is a transition command for THIS workflow (Rule 2)
    const transition = parseTransition(toolName, toolInput, wf.transitionPattern);
    if (transition.isTransition) {
      // Rule 2: Block transition if current step's command wasn't executed
      if (wf.softSteps.has(currentStep)) continue; // Soft steps don't need evidence

      const evidence = loadEvidence(ticketId, wf.evidenceFile);
      if (evidence[currentStep]?.executed) continue; // Evidence exists → allow

      // Find expected command description
      const expectedMapping = wf.commandMap.find(m => m.step === currentStep);
      const expectedDesc = expectedMapping
        ? `${expectedMapping.tool}: ${expectedMapping.pattern || '(any call)'}`
        : 'expected command';

      if (wf.name === 'work') {
        appendAction(ticketId, { step: currentStep, what: 'BLOCKED: transition without evidence', meta: { rule: 2 } });
      }
      process.stderr.write(
        `BLOCKED [${wf.name}]: Cannot transition from ${currentStep} — expected command not executed.\n` +
        `Expected: ${expectedDesc}\n` +
        `Run the expected command first, then transition.\n`
      );
      process.exit(2);
    }

    // 5. Map tool call to a step in THIS workflow (Rule 1)
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandMap);
    if (!matchedStep) continue; // Not a step command for this workflow → skip

    // Rule 1: Block if matched step ≠ currentStep
    if (matchedStep !== currentStep) {
      const cmdDesc = toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)';
      if (wf.name === 'work') {
        const truncDesc = String(cmdDesc).substring(0, 80);
        appendAction(ticketId, { step: matchedStep, what: `BLOCKED: ${truncDesc} (step ${matchedStep} not in_progress)`, meta: { rule: 1 } });
      }
      process.stderr.write(
        `BLOCKED [${wf.name}]: Cannot run '${cmdDesc}' — step ${matchedStep} is not in_progress.\n` +
        `Current step: ${currentStep} (in_progress)\n` +
        `Call transition first:\n` +
        `  ${wf.transitionHint} ${ticketId} ${matchedStep}\n`
      );
      process.exit(2);
    }

    // Matched step IS current step → allow (for this workflow)
  }
}

// ─── PostToolUse ────────────────────────────────────────────────────────────

function handlePostToolUse(hookData) {
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // 1. Find active ticket
  const ticketId = getTicketId();
  if (!ticketId) return;

  // 2. Process each active workflow
  for (const wf of WORKFLOWS) {
    const state = loadStateFile(ticketId, wf.stateFile);
    if (!state || !wf.isActive(state)) continue;

    const currentStep = getCurrentStep(state, wf.steps);

    // 3. Check if this is a transition command — clear evidence on backward transitions
    const transition = parseTransition(toolName, toolInput, wf.transitionPattern);
    if (transition.isTransition) {
      if (currentStep && transition.targetStep) {
        const currentIdx = wf.steps.indexOf(currentStep);
        const targetIdx = wf.steps.indexOf(transition.targetStep);

        // Backward transition: clear evidence for steps in the range
        if (targetIdx >= 0 && currentIdx >= 0 && targetIdx < currentIdx) {
          const evidence = loadEvidence(ticketId, wf.evidenceFile);
          for (let i = targetIdx; i <= currentIdx; i++) {
            delete evidence[wf.steps[i]];
          }
          saveEvidence(ticketId, wf.evidenceFile, evidence);
        }
      }
      continue; // Don't also record evidence for transition commands
    }

    // 4. Map tool call to step and record evidence
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandMap);
    if (!matchedStep) continue;

    const evidence = loadEvidence(ticketId, wf.evidenceFile);
    evidence[matchedStep] = {
      executed: true,
      command: toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)',
      tool: toolName,
      timestamp: new Date().toISOString(),
    };
    saveEvidence(ticketId, wf.evidenceFile, evidence);

    // Log action for the /work workflow
    if (wf.name === 'work') {
      let what;
      if (toolName === 'Skill') {
        what = `Skill(${toolInput?.skill || 'unknown'})`;
      } else if (toolName === 'Task') {
        what = `Task(${toolInput?.subagent_type || 'unknown'})`;
      } else if (toolName === 'Bash') {
        what = String(toolInput?.command || '').substring(0, 80);
      } else {
        what = toolName;
      }
      appendAction(ticketId, { step: matchedStep, what });
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const hookType = process.env.CLAUDE_HOOK_TYPE || 'PostToolUse';

  if (hookType === 'PreToolUse') {
    handlePreToolUse(hookData);
  } else if (hookType === 'PostToolUse') {
    handlePostToolUse(hookData);
  }
}

main().catch(() => {});
