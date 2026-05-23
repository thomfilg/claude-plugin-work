/**
 * Tests for the GH-398 (ECHO-4552 Issue 2) dispatcher-level early-return in
 * work-next.js.
 *
 * The short-circuit fires only when BOTH:
 *   - state.status === 'completed', AND
 *   - state.stepStatus.complete === 'completed'
 *
 * Spawns work-next.js via child_process.spawnSync against an isolated TASKS_BASE.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const WORK_NEXT = pathMod.join(__dirname, '..', 'work-next.js');

function runWorkNext(ticket, tmpBase, extraEnv = {}) {
  const env = {
    ...process.env,
    TASKS_BASE: tmpBase,
    SESSION_GUARD_ENABLED: '0',
    TICKET_PROVIDER: 'jira',
    TICKET_PROJECT_KEY: 'ECHO',
    ...extraEnv,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  const res = spawnSync(process.execPath, [WORK_NEXT, ticket], {
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  const stdout = String(res.stdout || '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(stdout.slice(start, i + 1));
        start = -1;
      }
    }
  }
  const last = objects[objects.length - 1];
  const parsed = last ? JSON.parse(last) : null;
  return { res, stdout, stderr: String(res.stderr || ''), parsed };
}

function writeState(tmpBase, ticket, overrides = {}) {
  const ticketDir = pathMod.join(tmpBase, ticket);
  fs.mkdirSync(ticketDir, { recursive: true });
  const stepStatus = {
    ticket: 'completed',
    bootstrap: 'completed',
    brief: 'completed',
    brief_gate: 'completed',
    spec: 'completed',
    spec_gate: 'completed',
    tasks: 'completed',
    tasks_gate: 'completed',
    implement: 'completed',
    commit: 'completed',
    task_review: 'completed',
    check: 'completed',
    pr: 'completed',
    ready: 'completed',
    follow_up: 'completed',
    ci: 'completed',
    cleanup: 'completed',
    reports: 'completed',
    complete: 'completed',
    ...(overrides.stepStatus || {}),
  };
  const state = {
    ticketId: ticket,
    ticketBase: ticket,
    ticketSuffix: null,
    ticketSeparator: '-',
    currentStep: 18,
    status: 'completed',
    ...overrides,
    stepStatus,
  };
  fs.writeFileSync(
    pathMod.join(ticketDir, '.work-state.json'),
    JSON.stringify(state, null, 2)
  );
  return state;
}

describe('work-next.js — dispatcher early-return on terminal completed state (GH-398)', () => {
  it('short-circuits when status=completed AND stepStatus.complete=completed', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-resume-'));
    try {
      writeState(tmpBase, 'ECHO-4552');
      const { parsed } = runWorkNext('ECHO-4552', tmpBase);
      assert.ok(parsed, 'expected JSON output on stdout');
      assert.equal(parsed.action, 'complete');
      assert.ok(
        typeof parsed.summary === 'string' &&
          /already complete.*Session released/i.test(parsed.summary),
        `expected short-circuit summary, got: ${JSON.stringify(parsed)}`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('does NOT short-circuit when status=completed but stepStatus.complete is pending', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-resume-partial-'));
    try {
      writeState(tmpBase, 'ECHO-4555', { stepStatus: { complete: 'pending' } });
      const { parsed } = runWorkNext('ECHO-4555', tmpBase);
      assert.ok(parsed, 'expected JSON output');
      // Both conditions are required — partial completion must NOT short-circuit.
      const isShortCircuitSummary =
        typeof parsed.summary === 'string' &&
        /already complete.*Session released/i.test(parsed.summary);
      assert.equal(
        isShortCircuitSummary,
        false,
        'short-circuit must NOT fire when stepStatus.complete is pending'
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('is deterministic on unchanged completed state', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-resume-det-'));
    try {
      writeState(tmpBase, 'ECHO-4554');
      const first = runWorkNext('ECHO-4554', tmpBase);
      const second = runWorkNext('ECHO-4554', tmpBase);
      assert.ok(first.parsed && second.parsed, 'both invocations must emit JSON');
      assert.equal(first.parsed.action, 'complete');
      assert.equal(second.parsed.action, 'complete');
      const strip = (obj) =>
        JSON.parse(JSON.stringify(obj, (k, v) => (k === 'lastPlanTimestamp' ? undefined : v)));
      assert.deepEqual(
        strip(first.parsed),
        strip(second.parsed),
        'two invocations on unchanged completed state must produce identical output (modulo lastPlanTimestamp)'
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
