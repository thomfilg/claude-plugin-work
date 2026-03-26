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
 * /work at step pr). Each workflow is checked independently.
 *
 * Fail-open: Any error → exit 0 (allow).
 */

const fs = require('fs');
const path = require('path');

// (Patch 11) Gate transient stderr logging behind debug env var — declared early for use in handlers
const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

// (Patch 2) didBlock flag — if we've decided to block, errors after that must preserve the block
let didBlock = false;

// (Patch 1+2) Fail-open error handlers — registered BEFORE any require that could fail
process.on('uncaughtException', (err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] uncaught: ${err?.message}\n`);
  process.exit(didBlock ? 2 : 0);
});
process.on('unhandledRejection', (err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] unhandled rejection: ${err?.message}\n`);
  process.exit(didBlock ? 2 : 0);
});

// (Patch 1) Lazy-load appendAction with fallback
let appendAction;
try {
  appendAction = require(path.join(__dirname, '..', 'lib', 'work-actions')).appendAction;
} catch {
  appendAction = () => {};
}

// ─── Configuration ──────────────────────────────────────────────────────────

const getConfig = require(path.join(__dirname, '..', 'lib', 'get-config'));
const TASKS_BASE = getConfig('TASKS_BASE') || (() => {
  const wb = getConfig.orExit('WORKTREES_BASE'); // only required if TASKS_BASE isn't set
  return path.join(wb, 'tasks');
})();

// ─── Workflow Definitions ───────────────────────────────────────────────────
//
// Each workflow defines its own state file, step-to-command mapping,
// transition pattern, exemptions, and soft steps.

const { STEPS, ALL_STEPS: WORK_STEPS } = require(path.join(__dirname, '..', 'lib', 'step-registry'));

const WORKFLOWS = [
  {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: WORK_STEPS,
    // Soft steps allow transition without evidence — these are optional or metadata-only steps.
    // NOTE: brief/spec were soft before GH-89 but are now enforced (require evidence + output files).
    softSteps: new Set([
      STEPS.ticket,                           // metadata fetch only
      STEPS.ready, STEPS.reports,             // operational steps — no code changes to enforce
    ]),
    // Tool can be a string or array — some runtimes emit Agent instead of Task.
    commandMap: [
      { step: STEPS.ticket,           tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.ticket}\\b`, 'i') },
      { step: STEPS.bootstrap,        tool: 'Skill',           field: 'skill',         pattern: /^bootstrap$/ },
      { step: STEPS.bootstrap,        tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.bootstrap}\\b`, 'i') },
      { step: STEPS.brief,            tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?brief-writer$/ },
      { step: STEPS.brief,            tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.brief}\\b`, 'i') },
      { step: STEPS.spec,             tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?spec-writer$/ },
      { step: STEPS.spec,             tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.spec}\\b`, 'i') },
      { step: STEPS.implement,        tool: 'Skill',           field: 'skill',         pattern: /^work-implement$/ },
      { step: STEPS.quality,          tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?quality-checker$/ },
      { step: STEPS.quality,          tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.quality}\\b`, 'i') },
      { step: STEPS.quality,          tool: 'Bash',            field: 'command',       pattern: /^\s*(LOW_CONCURRENCY=\d+\s+)?((pnpm|npm)\s+(run\s+)?dev:check\b|([\w./-]*\/)?dev-check\.sh(\s+--[\w-]+)*)/ },
      { step: STEPS.commit,           tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?commit-writer$/ },
      { step: STEPS.check,            tool: 'Skill',           field: 'skill',         pattern: /^check$/ },
      { step: STEPS.cleanup,          tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.cleanup}\\b`, 'i') },
      { step: STEPS.test_enhancement, tool: 'Skill',           field: 'skill',         pattern: /^test-coordination$/ },
      { step: STEPS.follow_up,        tool: 'Skill',           field: 'skill',         pattern: /^follow-up-pr$/ },
      { step: STEPS.pr,               tool: 'Skill',           field: 'skill',         pattern: /^work-pr$/ },
      { step: STEPS.ready,            tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.ready}\\b`, 'i') },
      { step: STEPS.ci,               tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.ci}\\b`, 'i') },
      { step: STEPS.reports,          tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.reports}\\b`, 'i') },
      { step: STEPS.complete,         tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.complete}\\b`, 'i') },
      { step: STEPS.complete,         tool: 'Bash',            field: 'command',       pattern: /work-state\.js\s+complete(\s|$)/ },
    ],
    transitionPattern: /work-orchestrator\.js\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /work-orchestrator\.js\s+(plan|transitions|graph)/,
      /work-state\.js\s+(get|resume-info|init)/,
    ],
    // Rule 4: Block direct CLI state mutations (GH-89).
    // Prevents agents from calling work-state.js with mutating subcommands
    // to bypass the step enforcement system. Checked globally in PreToolUse.
    blockedPatterns: [
      /work-state\.js\s+set-step\b/,
      /work-state\.js\s+set-check\b/,
      /work-state\.js\s+set-test-enhancement\b/,
      /work-state\.js\s+add-error\b/,
    ],
    // Step-gated output file protection (GH-89 Layer 2).
    // Maps output file basenames to the step that owns them.
    // Write/Edit/MultiEdit to these files is blocked unless the owning step is in_progress.
    outputProtection: {
      'brief.md':              STEPS.brief,
      'spec.md':               STEPS.spec,
      'tests.check.md':        STEPS.check,
      'code-review.check.md':  STEPS.check,
      'completion.check.md':   STEPS.check,
      'tests-feedback.jsonl':  STEPS.test_enhancement,
    },
    // Expected output files per step (GH-89 Layer 3).
    // Transition from a step is blocked unless ALL listed files exist in TASKS_BASE/TICKET/.
    expectedOutputs: {
      [STEPS.brief]: ['brief.md'],
      [STEPS.spec]:  ['spec.md'],
      [STEPS.check]: ['tests.check.md', 'code-review.check.md', 'completion.check.md'],
    },
    // Sub-workflow validation (GH-89 Layer 4).
    // Before transitioning out of these steps, verify the sub-workflow completed.
    subWorkflowValidation: {
      [STEPS.pr]: { stateFile: '.workflow-state.json', requiredWorkflow: 'work-pr', requiredStatus: 'completed' },
    },
    transitionHint: `node ${path.join(__dirname, 'work-orchestrator.js')} transition`,
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
    softSteps: new Set(['1_preflight', '2_setup', '4_screenshot_gate', '6_summary']),
    commandMap: [
      { step: '3_pr_gen',       tool: 'Task',  field: 'subagent_type', pattern: /^(work-workflow:)?pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Agent', field: 'subagent_type', pattern: /^(work-workflow:)?pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+create/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+edit/ },
      { step: '5_post_pr_gen',  tool: 'Task',  field: 'subagent_type', pattern: /^(work-workflow:)?pr-post-generator$/ },
      { step: '5_post_pr_gen',  tool: 'Agent', field: 'subagent_type', pattern: /^(work-workflow:)?pr-post-generator$/ },     ],
    transitionPattern: /workflow-engine\.js\s+work-pr\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /workflow-engine\.js\s+work-pr\s+(plan|transitions|graph)/,
      /workflow-state\.js\s+work-pr\s+(get|resume-info|init)/,
    ],
    blockedPatterns: [
      /workflow-state\.js\s+\S+\s+set-step\b/,
      /workflow-state\.js\s+\S+\s+add-error\b/,
      /workflow-state\.js\s+\S+\s+complete\b/,
    ],
    transitionHint: `node ${path.join(__dirname, '..', 'lib', 'workflow-engine.js')} work-pr transition`,
  },
];

// Protected state file basenames — block direct Edit/Write/MultiEdit/Bash writes
const { buildProtectedBasenames, basenameProtector, createFileProtector } = require(path.join(__dirname, '..', 'lib', 'protect-state-files'));
const PROTECTED_STATE_BASENAMES = buildProtectedBasenames(WORKFLOWS, ['.work-actions.json', '.pr-update-sha']);

// Map each protected basename to its workflow's transition hint
const BASENAME_TO_HINT = {};
for (const wf of WORKFLOWS) {
  for (const bn of [path.basename(wf.stateFile), path.basename(wf.evidenceFile)]) {
    BASENAME_TO_HINT[bn] = wf.transitionHint;
  }
}

// Exempt orchestrator and workflow-engine scripts from Vector 3 (script bypass detection)
// These are the legitimate writers of state files.
const EXEMPT_SCRIPTS = new Set([
  'work-orchestrator.js',
  'workflow-engine.js',
  'work-state.js',
  'workflow-state.js',
  'session-guard.js',
]);

// Trusted directories where exempt scripts are allowed to live.
// Only scripts resolved under these paths are exempt — prevents basename spoofing.
const TRUSTED_SCRIPT_DIRS = [
  path.resolve(__dirname),                           // hooks/
  path.resolve(__dirname, '..', 'lib'),              // lib/
  path.resolve(__dirname, '..', 'scripts'),          // scripts/
];

const stateFileProtector = createFileProtector({
  isProtected: basenameProtector(PROTECTED_STATE_BASENAMES),
  isExempt: (toolName, toolInput) => {
    if (toolName !== 'Bash') return false;
    const cmd = String(toolInput?.command || '').trim();
    if (!cmd) return false;

    // Never exempt commands that directly target a protected basename.
    // This prevents bypass via: echo "work-orchestrator.js" > .work-state.json
    for (const bn of PROTECTED_STATE_BASENAMES) {
      if (cmd.includes(bn)) return false;
    }

    // Only exempt actual execution of exempt scripts via Node.
    // Handles: cd ... && node ..., env prefixes, Node flags, quoted paths
    // Not anchored to ^ so it matches node anywhere in a chained command
    const nodePattern =
      /(?:^|&&|;|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:node|nodejs)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/;
    const nodeMatch = cmd.match(nodePattern);
    if (nodeMatch) {
      const scriptPath = nodeMatch[1] || nodeMatch[2] || nodeMatch[3];
      const scriptBase = path.basename(scriptPath);
      if (!EXEMPT_SCRIPTS.has(scriptBase)) return false;

      // Verify the script lives in a trusted directory (prevents basename spoofing)
      // Use realpathSync to resolve symlinks — a symlink under a trusted dir pointing outside is denied
      try {
        const resolved = fs.realpathSync(path.resolve(scriptPath));
        if (TRUSTED_SCRIPT_DIRS.some(dir => resolved.startsWith(dir + path.sep))) return true;
      } catch { /* realpathSync failed (file doesn't exist) — deny */ }
      return false;
    }

    return false; // Tests: Vector 3 exempt scripts + trusted path + untrusted path + env prefix + quoted path
  },
  formatMessage: (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `State files must only be modified through the orchestrator/workflow-engine scripts.\n`,
});

// Pre-compute output protection basenames from all workflows
// Maps basename → { step, stateFile, steps, workflowName, hint }
const OUTPUT_BASENAMES = {};
for (const wf of WORKFLOWS) {
  if (!wf.outputProtection) continue;
  for (const [bn, step] of Object.entries(wf.outputProtection)) {
    OUTPUT_BASENAMES[bn] = {
      step,
      stateFile: wf.stateFile,
      steps: wf.steps,
      workflowName: wf.name,
      hint: wf.transitionHint,
    };
  }
}

// (Patch 7) Validate workflow config at startup
function validateWorkflow(wf) {
  const stepSet = new Set(wf.steps);

  for (const s of wf.softSteps) {
    if (!stepSet.has(s)) throw new Error(`[${wf.name}] softSteps references unknown step: ${s}`);
  }

  for (const m of wf.commandMap) {
    if (!stepSet.has(m.step)) throw new Error(`[${wf.name}] commandMap references unknown step: ${m.step}`);
    if (m.field === undefined) throw new Error(`[${wf.name}] commandMap missing field for step: ${m.step}`);
  }

  if (wf.blockedPatterns) {
    for (const p of wf.blockedPatterns) {
      if (!(p instanceof RegExp)) throw new Error(`[${wf.name}] blockedPatterns must contain RegExp instances`);
    }
  }

  if (wf.expectedOutputs) {
    for (const [step, files] of Object.entries(wf.expectedOutputs)) {
      if (!stepSet.has(step)) throw new Error(`[${wf.name}] expectedOutputs references unknown step: ${step}`);
      if (!Array.isArray(files) || files.length === 0) throw new Error(`[${wf.name}] expectedOutputs[${step}] must be a non-empty array`);
    }
  }

  if (wf.outputProtection) {
    for (const [bn, step] of Object.entries(wf.outputProtection)) {
      if (!stepSet.has(step)) throw new Error(`[${wf.name}] outputProtection['${bn}'] references unknown step: ${step}`);
    }
  }

  if (wf.subWorkflowValidation) {
    for (const [step, config] of Object.entries(wf.subWorkflowValidation)) {
      if (!stepSet.has(step)) throw new Error(`[${wf.name}] subWorkflowValidation references unknown step: ${step}`);
      if (!config.stateFile) throw new Error(`[${wf.name}] subWorkflowValidation[${step}] missing stateFile`);
      if (!config.requiredWorkflow) throw new Error(`[${wf.name}] subWorkflowValidation[${step}] missing requiredWorkflow`);
      if (!config.requiredStatus) throw new Error(`[${wf.name}] subWorkflowValidation[${step}] missing requiredStatus`);
    }
  }
}

try {
  for (const wf of WORKFLOWS) validateWorkflow(wf);
} catch (e) {
  process.stderr.write(`WARNING: workflow config invalid: ${String(e?.message || e)}\n`);
  // fail-open: config errors don't block tool use
}

// Agents legitimately used by /check that should bypass /work step blocking
const CHECK_AGENTS = new Set([
  'quality-checker', 'work-workflow:quality-checker',
  'code-checker', 'work-workflow:code-checker',
  'completion-checker', 'work-workflow:completion-checker',
  'qa-feature-tester', 'work-workflow:qa-feature-tester',
  'qa-api-tester', 'work-workflow:qa-api-tester',
]);

// Pre-index commandMap by tool name for O(1) lookup
function buildCommandIndex(commandMap) {
  const index = {};
  for (const mapping of commandMap) {
    const tools = Array.isArray(mapping.tool) ? mapping.tool : [mapping.tool];
    for (const tool of tools) {
      if (!index[tool]) index[tool] = [];
      index[tool].push(mapping);
    }
  }
  return index;
}

for (const wf of WORKFLOWS) {
  wf.commandIndex = buildCommandIndex(wf.commandMap);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Cache git branch per invocation
let _cachedTicketId;
let _ticketIdResolved = false;

// (Patch 9+12) Resolve HEAD for worktrees: .git is a file containing "gitdir: <path>"
function resolveGitHead() {
  const dotgitPath = '.git';
  const dotgit = fs.readFileSync(dotgitPath, 'utf-8').trim();

  // Worktree case: .git is a file containing "gitdir: <path>"
  if (dotgit.startsWith('gitdir: ')) {
    const rawGitdir = dotgit.slice('gitdir: '.length);
    // (Patch 12) Resolve relative gitdir paths relative to the directory containing .git
    const gitdir = path.resolve(path.dirname(dotgitPath), rawGitdir);
    return fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf-8').trim();
  }

  // Not a worktree pointer — unexpected content
  throw new Error('unexpected .git content');
}

function getTicketId() {
  if (_ticketIdResolved) return _cachedTicketId;
  _ticketIdResolved = true;
  // Allow override for testing — empty string explicitly opts out (no git fallback)
  if ('ENFORCE_HOOK_TICKET_ID' in process.env) {
    _cachedTicketId = process.env.ENFORCE_HOOK_TICKET_ID || null;
    return _cachedTicketId;
  }
  // (Patch 6+9) Worktree-aware .git/HEAD read — no subprocess spawn
  try {
    let head;
    try {
      // Try worktree-aware read first (.git as file)
      head = resolveGitHead();
    } catch {
      // Fallback: normal repo (.git is a directory)
      head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
    }
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    const match = ref.match(/[A-Z]+-\d+/);
    _cachedTicketId = match ? match[0] : null;
  } catch {
    _cachedTicketId = null;
  }
  return _cachedTicketId;
}

function loadStateFile(ticketId, stateFile) {
  const p = path.join(TASKS_BASE, ticketId, stateFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Dual in_progress detection — warn but still fail-open
function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  const active = steps.filter(s => state.stepStatus[s] === 'in_progress');
  if (active.length > 1) {
    process.stderr.write(`WARNING: Multiple steps in_progress: ${active.join(', ')}. Using first.\n`);
  }
  return active[0] || null;
}

function loadEvidence(ticketId, evidenceFile) {
  const p = path.join(TASKS_BASE, ticketId, evidenceFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

// Atomic evidence writes — write to tmp then rename
function saveEvidence(ticketId, evidenceFile, evidence) {
  const dir = path.join(TASKS_BASE, ticketId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, evidenceFile);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(evidence, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Match a tool call to a workflow step using the pre-indexed command map.
 * Returns the step name or null if no match.
 */
function matchToolToStep(toolName, toolInput, commandIndex) {
  const mappings = commandIndex[toolName];
  if (!mappings) return null;

  for (const mapping of mappings) {
    // Tool-only match (no field pattern needed)
    if (mapping.field === null) return mapping.step;

    // Safer field coercion — handle non-string values
    const raw = toolInput?.[mapping.field];
    const value = typeof raw === 'string' ? raw : (raw == null ? '' : JSON.stringify(raw));
    if (mapping.pattern && mapping.pattern.test(value)) return mapping.step;
  }
  return null;
}

/**
 * Check if a Bash command is exempted for a specific workflow.
 */
function isExempt(toolName, toolInput, exemptPatterns) {
  if (toolName !== 'Bash') return false;
  // (Patch 13) Consistent String() coercion
  const cmd = String(toolInput?.command || '');
  return exemptPatterns.some(p => p.test(cmd));
}

/**
 * Check if a Bash command matches any blocked pattern for a workflow.
 * Blocked patterns are always-deny — checked BEFORE exempt patterns.
 */
function isBlocked(toolName, toolInput, patterns) {
  if (!patterns || patterns.length === 0) return false;
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput?.command || '').trim();
  if (!cmd) return false;
  return patterns.some(p => p.test(cmd));
}

/**
 * Check if a file write targets a step-gated output file.
 * Returns { blocked, bn, owningStep, currentStep, workflowName, hint } or null.
 */
function checkOutputProtection(toolName, toolInput, ticketId) {
  if (Object.keys(OUTPUT_BASENAMES).length === 0) return null;

  let targetBn;
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    targetBn = path.basename(toolInput?.file_path || '');
  } else if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '');
    // Only check commands with write operators
    if (/>{1,2}|\btee\b|\bcp\b|\bmv\b/.test(cmd)) {
      const tokens = (cmd.match(/[^\s"'|;&()]+/g) || []).map(t => path.basename(t));
      targetBn = tokens.find(t => OUTPUT_BASENAMES[t]);
    }
  }

  if (!targetBn) return null;
  const info = OUTPUT_BASENAMES[targetBn];
  if (!info) return null;

  const state = loadStateFile(ticketId, info.stateFile);
  const currentStep = state ? getCurrentStep(state, info.steps) : null;
  if (currentStep === info.step) return null; // Owning step is active → allow

  return {
    blocked: true,
    bn: targetBn,
    owningStep: info.step,
    currentStep,
    workflowName: info.workflowName,
    hint: info.hint,
  };
}

/**
 * Parse a transition command for a specific workflow.
 * Returns { isTransition: true, ticket, targetStep, raw } or { isTransition: false }.
 */
function parseTransition(toolName, toolInput, transitionPattern) {
  if (toolName !== 'Bash') return { isTransition: false };
  // (Patch 4) Coerce command to string
  const cmd = String(toolInput?.command || '');
  const match = cmd.match(transitionPattern);
  if (match) {
    return { isTransition: true, ticket: match[1], targetStep: match[2], raw: cmd };
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

  // Rule 5: Block writes to step-gated output files (GH-89 Layer 2)
  // Must run BEFORE Rule 3 because Rule 3's skipRemainingChecks exits early for file tools.
  const rule5 = checkOutputProtection(toolName, toolInput, ticketId);
  if (rule5?.blocked) {
    didBlock = true;
    if (rule5.workflowName === 'work') {
      appendAction(ticketId, { step: rule5.owningStep, what: `BLOCKED: write to ${rule5.bn} (step ${rule5.owningStep} not in_progress)`, meta: { rule: 5 } });
    }
    process.stderr.write(
      `BLOCKED [${rule5.workflowName}]: Cannot write '${rule5.bn}' — step '${rule5.owningStep}' is not in_progress.\n` +
      `This file can only be written during the '${rule5.owningStep}' step.\n` +
      `Current step: ${rule5.currentStep || 'none'}\n` +
      `To unblock: transition to the '${rule5.owningStep}' step first.\n` +
      `Use: ${rule5.hint} ${ticketId} ${rule5.owningStep}\n`
    );
    process.exit(2);
  }

  // Rule 3: Block direct writes to workflow state files
  // Prevents agents from bypassing the state machine by directly editing state files
  const rule3 = stateFileProtector.check(toolName, toolInput);
  if (rule3.blocked) {
    didBlock = true;
    const hint = BASENAME_TO_HINT[rule3.match] || WORKFLOWS[0].transitionHint;
    process.stderr.write(
      rule3.message +
      `Use: ${hint} ${ticketId} <step>\n`
    );
    process.exit(2);
  }
  if (rule3.skipRemainingChecks) return; // Edit/Write/MultiEdit — skip per-workflow loop

  // Rule 4: Block direct CLI state mutations (GH-89)
  // Checked globally (even when workflow is not active) to prevent agents from
  // creating or modifying state via CLI. Mirrors Rule 3's global placement.
  for (const wf of WORKFLOWS) {
    if (isBlocked(toolName, toolInput, wf.blockedPatterns)) {
      didBlock = true;
      if (wf.name === 'work') {
        appendAction(ticketId, { step: '(blocked)', what: 'BLOCKED: direct CLI state mutation', meta: { rule: 4 } });
      }
      process.stderr.write(
        `BLOCKED [${wf.name}]: Direct state mutation via CLI is not allowed.\n` +
        `State must only be modified through transition commands.\n` +
        `Use: ${wf.transitionHint} ${ticketId} <step>\n`
      );
      process.exit(2);
    }
  }

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
      // (Patch 10) Validate target is a real step in this workflow
      if (!wf.steps.includes(transition.targetStep)) continue;

      // Ticket-aware transition — skip if transition targets a different ticket
      if (transition.ticket !== ticketId) continue;

      // Rule 2: Block transition if current step's command wasn't executed
      if (wf.softSteps.has(currentStep)) {
        // Soft steps skip evidence check but still check expected outputs (GH-89 Layer 3)
        if (wf.expectedOutputs?.[currentStep]) {
          const tasksDir = path.join(TASKS_BASE, ticketId);
          const missing = wf.expectedOutputs[currentStep].filter(f => !fs.existsSync(path.join(tasksDir, f)));
          if (missing.length > 0) {
            didBlock = true;
            if (wf.name === 'work') {
              appendAction(ticketId, { step: currentStep, what: `BLOCKED: missing output files: ${missing.join(', ')}`, meta: { rule: 2 } });
            }
            process.stderr.write(
              `BLOCKED [${wf.name}]: Cannot transition from '${currentStep}' — expected output files missing.\n` +
              `Missing files:\n` +
              missing.map(f => `  - ${f}\n`).join('') +
              `Run the step's command to generate these files, then transition.\n` +
              `Use: ${wf.transitionHint} ${ticketId} ${transition.targetStep}\n`
            );
            process.exit(2);
          }
        }
        continue;
      }

      const evidence = loadEvidence(ticketId, wf.evidenceFile);

      // GH-89 Layer 3: Compound evidence — check BOTH agent execution AND output files
      if (evidence[currentStep]?.executed) {
        // Agent evidence exists — now also check expected outputs
        if (wf.expectedOutputs?.[currentStep]) {
          const tasksDir = path.join(TASKS_BASE, ticketId);
          const missing = wf.expectedOutputs[currentStep].filter(f => !fs.existsSync(path.join(tasksDir, f)));
          if (missing.length > 0) {
            didBlock = true;
            if (wf.name === 'work') {
              appendAction(ticketId, { step: currentStep, what: `BLOCKED: missing output files: ${missing.join(', ')}`, meta: { rule: 2 } });
            }
            process.stderr.write(
              `BLOCKED [${wf.name}]: Cannot transition from '${currentStep}' — expected output files missing.\n` +
              `The step command was executed but output files were not generated.\n` +
              `Missing files:\n` +
              missing.map(f => `  - ${f}\n`).join('') +
              `Re-run the step's command to generate these files, then transition.\n` +
              `Use: ${wf.transitionHint} ${ticketId} ${transition.targetStep}\n`
            );
            process.exit(2);
          }
        }
        // GH-89 Layer 4: Sub-workflow validation
        if (wf.subWorkflowValidation?.[currentStep]) {
          const subVal = wf.subWorkflowValidation[currentStep];
          const subState = loadStateFile(ticketId, subVal.stateFile);
          if (!subState || subState.workflow !== subVal.requiredWorkflow || subState.status !== subVal.requiredStatus) {
            didBlock = true;
            const subStatus = subState ? `${subState.workflow}:${subState.status}` : 'not found';
            if (wf.name === 'work') {
              appendAction(ticketId, { step: currentStep, what: `BLOCKED: sub-workflow not completed (${subStatus})`, meta: { rule: 2, subWorkflow: subVal.requiredWorkflow } });
            }
            process.stderr.write(
              `BLOCKED [${wf.name}]: Cannot transition from '${currentStep}' — sub-workflow '${subVal.requiredWorkflow}' not completed.\n` +
              `Sub-workflow status: ${subStatus}\n` +
              `Expected: ${subVal.requiredWorkflow}:${subVal.requiredStatus}\n` +
              `Run the step's command to complete the sub-workflow first.\n` +
              `Use: ${wf.transitionHint} ${ticketId} ${transition.targetStep}\n`
            );
            process.exit(2);
          }
        }

        continue; // All checks passed → allow
      }

      // (Patch 5) Multi-command expected hint — show all valid commands with field names
      const expectedMappings = wf.commandMap.filter(m => m.step === currentStep);
      const expectedLines = expectedMappings.length > 0
        ? expectedMappings.map(m => {
            const toolName = Array.isArray(m.tool) ? m.tool.join('/') : m.tool;
            if (m.field == null) return `${toolName} (any call)`;
            const pat = m.pattern ? m.pattern.toString() : '(any)';
            return `${toolName}.${m.field} matches ${pat}`;
          })
        : ['expected command'];

      // (Patch 4) Use transition.raw for attempted command
      const transitionCmd = transition.raw || '(unknown)';

      if (wf.name === 'work') {
        appendAction(ticketId, { step: currentStep, what: 'BLOCKED: transition without evidence', meta: { rule: 2 } });
      }
      didBlock = true;
      process.stderr.write(
        `BLOCKED [${wf.name}]: Cannot transition from ${currentStep} — expected command not executed.\n` +
        `Attempted: ${transitionCmd}\n` +
        `Expected one of:\n` +
        expectedLines.map(s => `  - ${s}\n`).join('') +
        `Run the expected command first, then transition.\n`
      );
      process.exit(2);
    }

    // 5. Map tool call to a step in THIS workflow (Rule 1)
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandIndex);
    if (!matchedStep) continue; // Not a step command for this workflow → skip

    // Skip /work blocking for agents legitimately used by /check
    if (wf.name === 'work' && matchedStep !== currentStep) {
      const agentType = toolInput?.subagent_type || '';
      if (CHECK_AGENTS.has(agentType)) {
        const checkState = loadStateFile(ticketId, '.workflow-state.json');
        if (checkState?.workflow === 'check' && checkState?.status === 'in_progress') {
          continue; // Allow — /check owns this agent
        }
      }
    }

    // Rule 1: Block if matched step ≠ currentStep
    if (matchedStep !== currentStep) {
      const cmdDesc = toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)';
      if (wf.name === 'work') {
        const truncDesc = String(cmdDesc).substring(0, 80);
        appendAction(ticketId, { step: matchedStep, what: `BLOCKED: ${truncDesc} (step ${matchedStep} not in_progress)`, meta: { rule: 1 } });
      }
      didBlock = true;
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
      // (Patch 10) Validate target is a real step in this workflow
      if (!wf.steps.includes(transition.targetStep)) continue;

      // (Patch 3) Ticket-aware transition gate — mirror PreToolUse
      if (transition.ticket !== ticketId) continue;

      if (currentStep && transition.targetStep) {
        const currentIdx = wf.steps.indexOf(currentStep);
        const targetIdx = wf.steps.indexOf(transition.targetStep);

        // Backward transition: clear evidence for steps AFTER target through current
        // Target step itself is preserved — we're going TO it, so redo everything after
        if (targetIdx >= 0 && currentIdx >= 0 && targetIdx < currentIdx) {
          const evidence = loadEvidence(ticketId, wf.evidenceFile);
          for (let i = targetIdx + 1; i <= currentIdx; i++) {
            delete evidence[wf.steps[i]];
          }
          saveEvidence(ticketId, wf.evidenceFile, evidence);
        }
      }
      continue; // Don't also record evidence for transition commands
    }

    // 4. Map tool call to step and record evidence
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandIndex);
    if (!matchedStep) continue;

    // (Patch 14) Strengthen pr evidence: verify .pr-update-sha matches HEAD
    if (wf.name === 'work' && matchedStep === STEPS.pr) {
      const tasksDir = path.join(TASKS_BASE, ticketId);
      const prShaFile = path.join(tasksDir, '.pr-update-sha');
      let prShaOk = false;
      try {
        let head;
        try { head = resolveGitHead(); } catch {
          head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
        }
        const ref = head.startsWith('ref: ') ? head.slice(5) : head;
        // For ref pointers, we can't easily get the SHA without git — skip validation
        if (/^[0-9a-f]{40}$/.test(ref)) {
          const storedSha = fs.readFileSync(prShaFile, 'utf-8').trim();
          prShaOk = storedSha === ref;
        } else {
          // Can't compare ref to SHA — trust the file exists
          prShaOk = fs.existsSync(prShaFile);
        }
      } catch {
        prShaOk = false;
      }
      if (!prShaOk) {
        if (DEBUG) process.stderr.write(`[enforce] pr: pr-update-sha missing or stale\n`);
        continue; // Skip evidence recording — PR wasn't actually updated
      }
    }

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
      } else if (toolName === 'Task' || toolName === 'Agent') {
        const label = toolInput?.subagent_type || String(toolInput?.description || 'unknown').substring(0, 60);
        what = `${toolName}(${label})`;
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

// (Patch 8) Harden main() — guard empty stdin and log errors
async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    if (!input.trim()) return; // Empty stdin → allow

    const hookData = JSON.parse(input);
    const hookType = process.env.CLAUDE_HOOK_TYPE || 'PostToolUse';

    if (hookType === 'PreToolUse') {
      handlePreToolUse(hookData);
    } else if (hookType === 'PostToolUse') {
      handlePostToolUse(hookData);
    }
  } catch (err) {
    if (DEBUG) process.stderr.write(`[enforce-step-workflow] fail-open: ${err?.message}\n`);
  }
}

main().catch((err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] fatal: ${err?.message}\n`);
});
