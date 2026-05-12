#!/usr/bin/env node

/**
 * PreToolUse hook: Block agent writes to `task<N>/tdd-phase.json`.
 *
 * The /work2 implement-gate is the SOLE writer of this file (it captures
 * RED/GREEN/REFACTOR by running the task's `### Test Command` itself). The
 * gate writes via fs.writeFileSync from inside the orchestrator process, so
 * a PreToolUse hook on Edit/Write/MultiEdit only ever sees agent tool calls.
 * No allowlist is needed: there is no legitimate agent-tool write of this
 * file, ever.
 *
 * Failure mode this prevents: when the gate keeps failing (parser bug,
 * malformed test command, missing dependency, etc.), agents previously
 * unblocked themselves by hand-writing a synthetic tdd-phase.json with
 * fabricated RED/GREEN/REFACTOR cycles. That falsifies the audit trail.
 */

'use strict';

const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));

const TDD_PHASE_PATH_RE = /(^|[\\/])task\d+[\\/]tdd-phase\.json$/;

function blockMessage(filePath) {
  return [
    'BLOCKED: tdd-phase.json is written exclusively by the /work2 implement-gate.',
    '',
    `Path: ${filePath}`,
    'Why: TDD evidence must reflect actual test runs. The gate runs the',
    '     `### Test Command` from tasks.md and records RED/GREEN/REFACTOR',
    '     itself. Agent writes here would falsify the audit trail.',
    '',
    'What to do instead:',
    '  - Implement the task (edit source/test files only).',
    "  - Return when done. The gate will run the task's `### Test Command`",
    '    and record evidence automatically.',
    '  - If the gate keeps failing, READ the failure message in your next',
    '    prompt — it names the exact command and what to fix in tasks.md.',
    '',
  ].join('\n');
}

function extractCandidatePaths(toolName, toolInput) {
  const paths = [];
  if (toolInput && typeof toolInput.file_path === 'string') paths.push(toolInput.file_path);
  if (toolInput && typeof toolInput.path === 'string') paths.push(toolInput.path);
  // Bash: scan command tokens for any path matching the protected pattern.
  if (toolName === 'Bash' && toolInput && typeof toolInput.command === 'string') {
    const tokens = toolInput.command.split(/[\s'"|;&><()]+/);
    for (const t of tokens) {
      if (t && t.includes('tdd-phase.json')) paths.push(t);
    }
  }
  return paths;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    process.exit(0); // fail-open
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const candidates = extractCandidatePaths(toolName, toolInput);

  for (const p of candidates) {
    if (TDD_PHASE_PATH_RE.test(p)) {
      process.stderr.write(blockMessage(p));
      process.exit(2);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  try {
    logHookError(__filename, err);
  } catch {
    /* swallow */
  }
  process.exit(0); // fail-open
});
