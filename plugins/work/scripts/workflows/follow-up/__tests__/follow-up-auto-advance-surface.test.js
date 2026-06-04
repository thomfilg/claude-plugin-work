'use strict';

/**
 * Task 6.2 (RED): hooks/follow-up-auto-advance.js must treat
 * `action: 'surface'` as a terminal instruction — same as 'blocked' — so the
 * auto-advance loop stops and a user-visible message containing the surface
 * reason (e.g. 'infra-stuck') is emitted.
 *
 * Two complementary checks:
 *   1. End-to-end: run the hook with a stubbed `follow-up-next.js` returning
 *      `{action:'surface', payload:{reason:'infra-stuck'}}` — assert exit 0,
 *      banner printed, single invocation (no loop), 'infra-stuck' in stdout.
 *   2. Source-text: hook source mentions 'surface' alongside 'blocked' in the
 *      action-dispatch / terminal-set handling.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(
  __dirname,
  '..',
  'hooks',
  'follow-up-auto-advance.js'
);
const HOOK_SRC = fs.readFileSync(HOOK_PATH, 'utf8');

const MARKER = '.follow-up-orchestrator.pid';

let TASKS_BASE;
let WORKTREES_BASE;
let STUB_NEXT_PATH;
let INVOCATION_LOG;
let TMP_ROOT;

function setupStub(stubInstruction) {
  // Use the FOLLOW_UP_NEXT_PATH test seam so we can run the REAL hook in place
  // (no staging needed). Production code never sets that env var.
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-aa-surface-'));
  WORKTREES_BASE = TMP_ROOT;
  TASKS_BASE = path.join(TMP_ROOT, 'tasks');
  fs.mkdirSync(TASKS_BASE, { recursive: true });

  STUB_NEXT_PATH = path.join(TMP_ROOT, 'follow-up-next.js');
  INVOCATION_LOG = path.join(TMP_ROOT, 'invocations.log');

  const stub = [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    `fs.appendFileSync(${JSON.stringify(INVOCATION_LOG)}, "called\\n");`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(stubInstruction))});`,
    'process.exit(0);',
  ].join('\n');
  fs.writeFileSync(STUB_NEXT_PATH, stub, { mode: 0o755 });
}

function writeMarker(ticket) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  // Tag the marker with the current session + worktree so the hook
  // claims it as its own.
  // Omit worktreeRoot so the marker is treated as legacy (non-foreign) by
  // findActiveMarker; sessionId match makes it explicitly owned by us.
  fs.writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({
      ticket,
      startedAt: new Date().toISOString(),
      workflow: '/follow-up',
      sessionId: 'sess-test',
    })
  );
}

function runStagedHook(hookData, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [STAGED_HOOK_PATH], {
      input: JSON.stringify(hookData),
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: 'sess-test',
        WORKTREES_BASE,
        TASKS_BASE,
        ...env,
      },
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

describe('follow-up-auto-advance hook — surface action (Task 6.2)', () => {
  let stageRoot;

  afterEach(() => {
    if (stageRoot) {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      stageRoot = null;
    }
    if (TASKS_BASE && fs.existsSync(TASKS_BASE)) {
      // TASKS_BASE lives under a separate tmp; remove its parent.
      const parent = path.dirname(TASKS_BASE);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('treats action:surface as terminal and emits a user-visible message', () => {
    ({ stageRoot } = setupStagedHook({
      action: 'surface',
      payload: { reason: 'infra-stuck' },
      summary: 'Surface: infra-stuck after 3 retries',
    }));
    writeMarker('GH-508');

    const r = runStagedHook({
      tool_name: 'Task',
      transcript_path: '/tmp/t.jsonl',
      session_id: 'sess-test',
    });

    assert.equal(r.exitCode, 0, `hook should exit 0; got ${r.exitCode}`);
    assert.match(
      r.stdout,
      /infra-stuck/,
      'hook stdout must contain the surface reason'
    );
    assert.match(
      r.stdout,
      /SURFACE|surface/,
      'hook stdout must include a SURFACE banner identifying the terminal action'
    );

    // Single invocation of follow-up-next — the hook MUST NOT loop after surface.
    const calls = fs.existsSync(INVOCATION_LOG)
      ? fs.readFileSync(INVOCATION_LOG, 'utf8').split('\n').filter(Boolean)
      : [];
    assert.equal(
      calls.length,
      1,
      `expected exactly 1 invocation of follow-up-next (surface is terminal); got ${calls.length}`
    );
  });

  it('hook source declares surface alongside blocked in the terminal-action handling', () => {
    assert.match(
      HOOK_SRC,
      /['"]surface['"]/,
      "hook source must reference the 'surface' action literal"
    );
    // Mirrors the existing 'blocked' handling: either an explicit branch or a
    // TERMINAL_ACTIONS set listing blocked + surface (+ complete).
    const hasSurfaceBranch =
      /action\s*===\s*['"]surface['"]/.test(HOOK_SRC) ||
      /TERMINAL_ACTIONS[\s\S]{0,200}surface/.test(HOOK_SRC);
    assert.ok(
      hasSurfaceBranch,
      "hook must dispatch on action==='surface' (or include it in a TERMINAL_ACTIONS set) the way 'blocked' is dispatched"
    );
  });
});
