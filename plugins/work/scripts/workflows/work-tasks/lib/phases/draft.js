/**
 * Phase: draft — every `## Task N` block must have required subsections.
 *
 * Reuses the existing task-parser via lazy require so the parser owns the
 * truth about what a task block looks like.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');
const { parseShapeFromSpec } = require('../../../work-spec/lib/component-shape');
const { getConfig } = require('../../../lib/config');

let parseTasks;
try {
  ({ parseTasks } = require('../../../work/lib/task-parser'));
} catch {
  parseTasks = null;
}

// GH-590 Task 11: feature-flagged Test Strategy + TDD-ownership validators.
// Loaded lazily and tolerantly so the legacy path keeps working if any of
// the helper modules are unavailable.
let strategyModule = null;
let dispatcherModule = null;
let ownershipModule = null;
let envrcModule = null;
try {
  strategyModule = require('../../../lib/test-strategy');
} catch {
  strategyModule = null;
}
try {
  dispatcherModule = require('../../../lib/command-existence-dispatcher');
} catch {
  dispatcherModule = null;
}
try {
  ownershipModule = require('../../../lib/tdd-ownership-graph');
} catch {
  ownershipModule = null;
}
try {
  envrcModule = require('../../../lib/envrc-resolver');
} catch {
  envrcModule = null;
}

const STRATEGY_FLAG_KEY = 'WORK_TEST_STRATEGY_VALIDATOR';
const STRATEGY_FLAG_ON_VALUE = '1';

const REQUIRED_SUBSECTIONS = [
  'Type',
  'Dependencies',
  'Requirements Covered',
  'Acceptance Criteria',
  'Files in scope',
];

const SHARED_PATH_RE = /(^|\/)(shared|ui|packages\/ui|src\/shared|src\/ui|components\/shared)\//i;

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseTaskBlocks(text) {
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  const blocks = [];
  for (let i = 1; i < parts.length; i += 2) {
    const num = Number(parts[i]);
    const rest = parts[i + 1] || '';
    // First line after the number is the title (after the dash).
    const firstNewline = rest.indexOf('\n');
    const titleLine = firstNewline === -1 ? rest : rest.slice(0, firstNewline);
    const body = rest.replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    blocks.push({ num, title: titleLine.replace(/^[\s—\-:]+/, '').trim(), body });
  }
  return blocks;
}

function extractFilesInScope(body) {
  // Split on `### ` headings and locate the "Files in scope" section.
  const sections = body.split(/^###\s+/m);
  let target = null;
  for (const sec of sections) {
    if (/^Files in scope\b/.test(sec)) {
      target = sec.replace(/^Files in scope\b[^\n]*\n?/, '');
      break;
    }
  }
  if (target == null) return [];
  const files = [];
  for (const line of target.split('\n')) {
    if (/^###\s/.test(line)) break;
    const bullet = line.match(/^\s*[-*]\s+`?([^`\s]+)`?/);
    if (bullet) files.push(bullet[1]);
  }
  return files;
}

function validateSharedComponentOrdering(tasksDir, taskBlocks) {
  const errors = [];
  const { rows } = parseShapeFromSpec(path.join(tasksDir, 'spec.md'));
  const genericRows = rows.filter((r) => r.isGenericSplit);
  if (genericRows.length === 0) return errors; // nothing to enforce
  if (taskBlocks.length === 0) return errors; // earlier check already reports

  // Locate the task ACTUALLY numbered 1 (per `## Task 1` heading), not just
  // the first task in document order. Authors sometimes write tasks
  // out-of-order in the file; the scaffold-first rule applies to Task 1 by
  // number, which is the implement-gate's anchor. If no `## Task 1` exists,
  // fall back to the first task in document order and report its real number.
  const task1 = taskBlocks.find((t) => t.num === 1) || taskBlocks[0];
  const taskLabel = `Task ${task1.num}`;
  const filesInTask = extractFilesInScope(task1.body);
  const taskTouchesShared = filesInTask.some((f) => SHARED_PATH_RE.test(f));

  const sharedNames = genericRows
    .map((r) => r.genericName)
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  const taskMentionsSharedName = sharedNames.some((n) => {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(task1.title) || re.test(task1.body);
  });

  if (!taskTouchesShared) {
    errors.push(
      `${taskLabel} must scaffold the shared component(s) declared Generic-split in spec.md's \`## Component Shape Decision\` (${genericRows
        .map((r) => `\`${r.proposed}\` → \`${r.genericName || '?'}\``)
        .join(
          ', '
        )}), but ${taskLabel}'s \`### Files in scope\` contains no path under \`shared/\`, \`ui/\`, \`packages/ui/\`, or similar. Reorder so the generic shell lands first; page-specific wrappers depend on it.`
    );
  }
  if (sharedNames.length > 0 && !taskMentionsSharedName) {
    errors.push(
      `${taskLabel} must mention the shared component name(s) from the Generic-split decision (${sharedNames
        .map((n) => `\`${n}\``)
        .join(
          ', '
        )}) in its title or body so the implement-gate can match the scaffold to the decision.`
    );
  }
  return errors;
}

function strategyFlagOn() {
  try {
    const v = getConfig(STRATEGY_FLAG_KEY);
    return v === STRATEGY_FLAG_ON_VALUE;
  } catch {
    return process.env[STRATEGY_FLAG_KEY] === STRATEGY_FLAG_ON_VALUE;
  }
}

function loadStrategyContext(tasksDir) {
  let parsedTasks = null;
  if (parseTasks) {
    try {
      parsedTasks = parseTasks(tasksDir);
    } catch {
      parsedTasks = null;
    }
  }
  let envrc = null;
  if (envrcModule && typeof envrcModule.findNearestEnvrc === 'function') {
    try {
      envrc = envrcModule.findNearestEnvrc(tasksDir);
    } catch {
      envrc = null;
    }
  }
  let packageJson = null;
  if (envrcModule && typeof envrcModule.findNearestPackageJson === 'function') {
    try {
      packageJson = envrcModule.findNearestPackageJson(tasksDir) || null;
    } catch {
      packageJson = null;
    }
  }
  return { parsedTasks, envrc, packageJson };
}

function taskHeadingFor(task) {
  if (!task) return '<unknown task>';
  if (task.title) return `Task ${task.num} — ${task.title}`;
  return `Task ${task.num}`;
}

/**
 * Extract the raw bash/shell fence body inside a task's `### Test Strategy`
 * section when the parser did not classify it as a recognized kind. This
 * mirrors the `kind: custom` synthesis at the integration layer so authors
 * who drop a single bash fence under `### Test Strategy` still get the
 * command-existence dispatcher's enforcement.
 *
 * @param {string} rawContent
 * @returns {string|null}
 */
function extractRawStrategyBody(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent) return null;
  // Locate `### Test Strategy` section body.
  const m = rawContent.match(
    /(?:^|\n)###\s+Test Strategy[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/
  );
  if (!m) return null;
  const body = m[1];
  // Walk fenced blocks and return the first non-empty body that does NOT
  // look like a yaml `kind:` key block.
  const lines = body.split('\n');
  let inFence = false;
  let buf = [];
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (!inFence) {
        inFence = true;
        buf = [];
      } else {
        const content = buf.join('\n').trim();
        if (content && !/^\s*kind\s*:/m.test(content)) return content;
        inFence = false;
        buf = [];
      }
      continue;
    }
    if (inFence) buf.push(raw);
  }
  return null;
}

/**
 * GH-590 Task 11 / AC9 + AC14: feature-flagged Test Strategy validator.
 *
 * Walks every parsed task's `testStrategy`, synthesizes the runnable command
 * (or treats the custom body verbatim), and dispatches it through the
 * command-existence checker. Collects all errors — does NOT short-circuit.
 *
 * No-op when WORK_TEST_STRATEGY_VALIDATOR !== '1' (AC17) or when any
 * required helper module is missing.
 *
 * @param {string} tasksDir
 * @param {{ parsedTasks: object[]|null, envrc: object|null, manifest: object|null }} ctx
 * @returns {string[]}
 */
function validateTestStrategy(tasksDir, ctx) {
  const errors = [];
  if (!strategyFlagOn()) return errors;
  if (!strategyModule || !dispatcherModule) return errors;

  const parsedTasks = (ctx && ctx.parsedTasks) || null;
  if (!Array.isArray(parsedTasks)) return errors;

  const envrc = (ctx && ctx.envrc) || null;
  const packageJson = (ctx && ctx.packageJson) || null;

  for (const task of parsedTasks) {
    let strategy = task && task.testStrategy;
    const heading = taskHeadingFor(task);

    // Integration-layer fallback: if the task declares a `### Test Strategy`
    // block whose first fence is a raw shell body (no `kind:` line), treat
    // it as `kind: custom` so the command-existence dispatcher still fires.
    // This mirrors the AC8 intent (empty/prose-only rejection) and AC14
    // (custom-body dispatch) for authors using the minimal fence shape.
    if (!strategy || typeof strategy !== 'object') {
      const rawBody = task && task.rawContent ? extractRawStrategyBody(task.rawContent) : null;
      if (rawBody) {
        strategy = { kind: 'custom', customBody: rawBody };
      } else {
        continue;
      }
    }

    // Peer-citation validation (AC11) for verified-by / wiring-citation.
    if (typeof strategyModule.validatePeerCitation === 'function') {
      try {
        const peerErrors = strategyModule.validatePeerCitation(strategy, parsedTasks, task) || [];
        for (const e of peerErrors) errors.push(e);
      } catch {
        /* peer-citation helper unstable — keep going */
      }
    }

    let command = null;
    try {
      command = strategyModule.synthesizeCommand(strategy, envrc);
    } catch {
      command = null;
    }
    if (!command) continue; // verified-by / wiring-citation skip synthesis.

    const dispatchCtx = {
      worktree: tasksDir,
      packageJson,
      envrc,
      taskHeading: heading,
    };
    try {
      const result = dispatcherModule.dispatch(command, dispatchCtx);
      if (result && Array.isArray(result.errors)) {
        for (const e of result.errors) errors.push(e);
      }
    } catch (err) {
      errors.push(`${heading}: command-existence dispatcher failed: ${err && err.message}`);
    }
  }

  return errors;
}

/**
 * GH-590 Task 11 / AC10: feature-flagged TDD-ownership graph validator.
 *
 * Builds the coverage graph from parsed tasks and reports orphaned paths
 * (paths declared in `### Files in scope` that no task's strategy exercises).
 *
 * No-op when WORK_TEST_STRATEGY_VALIDATOR !== '1'.
 *
 * @param {string} _tasksDir
 * @param {{ parsedTasks: object[]|null }} ctx
 * @returns {string[]}
 */
function validateTddOwnership(_tasksDir, ctx) {
  const errors = [];
  if (!strategyFlagOn()) return errors;
  if (!ownershipModule) return errors;

  const parsedTasks = (ctx && ctx.parsedTasks) || null;
  if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) return errors;

  let graph = null;
  try {
    graph = ownershipModule.buildCoverageGraph(parsedTasks);
  } catch {
    return errors;
  }
  let orphans = [];
  try {
    orphans = ownershipModule.findOrphanedPaths(parsedTasks, graph) || [];
  } catch {
    return errors;
  }

  // GH-590 Task 11 wiring: narrow the bare-graph orphan set so legitimate
  // test-source pairings (e.g. `entry: foo.test.ts` covering `foo.ts`) do
  // NOT false-positive at the integration layer. We strip the `.test.` /
  // `.spec.` infix and the `__tests__/` segment from any task's entry and
  // compare to the orphan path — mirroring the same mapping that
  // test-strategy.entryReferencesScope applies internally.
  const realOrphans = orphans.filter((o) => {
    if (!o || !o.path) return false;
    for (const t of parsedTasks) {
      const strat = t && t.testStrategy;
      if (!strat || typeof strat !== 'object') continue;
      const entry = strat.entry;
      if (typeof entry !== 'string' || !entry) continue;
      if (entry === o.path) return false;
      const stripped = entry.replace(/\.(?:test|spec)(\.[a-zA-Z0-9]+)$/, '$1');
      if (stripped === o.path) return false;
      const noTestsDir = stripped.replace(/(^|\/)__tests__\//, '$1');
      if (noTestsDir === o.path) return false;
    }
    return true;
  });

  for (const orphan of realOrphans) {
    if (!orphan || !orphan.path) continue;
    const heading = `Task ${orphan.owner}`;
    const remediation = Array.isArray(orphan.remediation)
      ? orphan.remediation.map((r) => `  - ${r}`).join('\n')
      : '';
    errors.push(
      `${heading}: \`${orphan.path}\` is owned by ${heading} but no task's Test Strategy entry transitively touches it. Remediation options:\n${remediation}`
    );
  }
  return errors;
}

function runStrategyValidators(tasksDir) {
  if (!strategyFlagOn()) return [];
  const ctx = loadStrategyContext(tasksDir);
  const errors = [];
  errors.push(...validateTestStrategy(tasksDir, ctx));
  errors.push(...validateTddOwnership(tasksDir, ctx));
  return errors;
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const p = path.join(tasksDir, 'tasks.md');
  const text = readFile(p);
  if (!text) {
    errors.push(`Missing ${p}.`);
    return errors;
  }
  // Must have at least one `## Task N` block.
  const blocks = text.match(/^##\s+Task\s+\d+/gm) || [];
  if (blocks.length === 0) {
    errors.push(
      `tasks.md has zero \`## Task N\` blocks. Decompose the spec into at least one numbered task.`
    );
    return errors;
  }
  // For each block, check required subsections.
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  for (let i = 1; i < parts.length; i += 2) {
    const num = parts[i];
    const body = (parts[i + 1] || '').replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    for (const sub of REQUIRED_SUBSECTIONS) {
      const re = new RegExp(`^###\\s+${sub}\\b`, 'm');
      if (!re.test(body)) {
        errors.push(`Task ${num} is missing required subsection \`### ${sub}\`.`);
      }
    }
  }
  // If the spec's Component Shape Decision chose Generic-split for any
  // component, Task 1 must scaffold the shared shell before page wrappers.
  // This is the ECHO-4452 lesson translated into an implementation-order rule.
  const taskBlocks = parseTaskBlocks(text);
  errors.push(...validateSharedComponentOrdering(tasksDir, taskBlocks));
  // GH-590 Task 11: feature-flagged validators. No-op when flag off (AC17).
  errors.push(...runStrategyValidators(tasksDir));
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  let count = 0;
  if (parseTasks) {
    try {
      const tasks = parseTasks(ctx.tasksDir);
      count = (tasks && tasks.length) || 0;
    } catch {
      /* parser quirk — already validated structure above */
    }
  }
  return { ok: true, summary: `${count} task block(s) parsed` };
}

function instructions(ctx) {
  return [
    `# tasks-next — Phase 3 of 7: DRAFT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `Write the full \`${path.join(ctx.tasksDir, 'tasks.md')}\`. Each task is a section:`,
    '',
    '```markdown',
    '## Task 1 — <one-line title>',
    '',
    '### Type',
    'frontend | backend | wiring | e2e | devops | fullstack | checkpoint',
    '',
    '### Dependencies',
    'Task 0 (or "none")',
    '',
    '### Requirements Covered',
    '- R1',
    '- R2',
    '',
    '### Acceptance Criteria',
    '- bullet1',
    '- bullet2',
    '',
    '### Files in scope',
    '- `path/to/file.ts`',
    '',
    '### Files explicitly out of scope',
    '- `path/sibling-owned/file.ts` — owned by ECHO-XXXX',
    '',
    // Spec §P0#7 (Cross-Task Dependencies): authors list paths owned by other
    // tasks that this task legitimately needs to edit. The block is parsed by
    // `scripts/workflows/work/lib/task-parser.js` (see `crossTaskDeps`); the
    // scope-bypass hook (`protect-task-scope.js`) treats these paths as
    // pre-authorized edits without requiring `PROTECT_TASK_SCOPE_BYPASS_REASON`.
    '### Cross-Task Dependencies',
    '<!-- files owned by other tasks that this task legitimately needs to edit; one bullet per path, optional `(owned by Task N)` suffix -->',
    '- `src/shared/schema.ts` (owned by Task 4)',
    '',
    '### Test Command',
    '```bash',
    '# Use the canonical envelope so repos can override the runner via .envrc.',
    '# Pick ONE of: $TEST_UNIT_COMMAND, $TEST_INTEGRATION_COMMAND, $TEST_E2E_COMMAND.',
    '# Never hardcode `pnpm test`/`pnpm vitest`/etc. — the implement-gate runs this verbatim.',
    'CHANGED_FILES="path/to/file.test.ts" eval "$TEST_UNIT_COMMAND"',
    '```',
    '```',
    '',
    'Keep the `## Extracted Requirements` section at the top of the file.',
    '',
    '### Shared-component ordering (when spec declared Generic-split)',
    '',
    'If `spec.md`\'s `## Component Shape Decision` has any row whose Decision is **Generic-split** (e.g. "Split: Generic `Table` + Specific `UsersTable`"), Task 1 MUST scaffold the generic shell:',
    '- Title or body mentions the generic component name (e.g. `Table`).',
    '- `### Files in scope` contains at least one path under `shared/`, `ui/`, `packages/ui/`, `src/shared/`, `src/ui/`, or `components/shared/`.',
    '- Page-specific wrapper tasks declare Task 1 in their `### Dependencies`.',
    '',
    'This translates the spec-level "build the shell once" decision into an implementation-order constraint. Without it, the developer agent can inline the shell in the page-specific task and silently duplicate work (the ECHO-4452 pattern).',
    '',
    '### What I will check before advancing',
    '- At least one `## Task N` block',
    `- Each task has \`### ${REQUIRED_SUBSECTIONS.join('\`, \`### ')}\` subsections`,
    '- If spec declared Generic-split, Task 1 mentions the shared component name and lists a shared/ui path in `### Files in scope`',
    '',
    'Re-invoke me when the tasks are filled out.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.draft, {
    next: TASKS_PHASES.traceability,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.REQUIRED_SUBSECTIONS = REQUIRED_SUBSECTIONS;
module.exports.parseTaskBlocks = parseTaskBlocks;
module.exports.extractFilesInScope = extractFilesInScope;
module.exports.validateSharedComponentOrdering = validateSharedComponentOrdering;
module.exports.SHARED_PATH_RE = SHARED_PATH_RE;
module.exports.validateTestStrategy = validateTestStrategy;
module.exports.validateTddOwnership = validateTddOwnership;
module.exports.WORK_TEST_STRATEGY_VALIDATOR = STRATEGY_FLAG_KEY;
