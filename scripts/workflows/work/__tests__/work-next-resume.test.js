/**
 * Tests for work-next.js terminal short-circuit on `state.status === 'completed'`.
 *
 * Covers Task 5 acceptance criteria for GH-398:
 *   - AC4: short-circuit when state.status === 'completed' && stepStatus.complete === 'pending'
 *   - AC5: determinism on unchanged input across two invocations
 *   - AC7: short-circuit when state.status === 'completed' && stepStatus.complete is undefined,
 *          payload back-fills stepStatus.complete = 'completed'.
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
  // Parse the LAST top-level JSON object on stdout. lastIndexOf('{') is unsafe
  // for nested payloads (it locks onto an inner brace and JSON.parse rejects
  // the trailing outer-object remainder). Walk the string and bracket-match
  // every top-level `{...}` instead.
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

function writeCompletedState(tmpBase, ticket, stepStatusOverrides = {}) {
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
    ...stepStatusOverrides,
  };
  const state = {
    ticketId: ticket,
    ticketBase: ticket,
    ticketSuffix: null,
    ticketSeparator: '-',
    currentStep: 18,
    status: 'completed',
    stepStatus,
  };
  fs.writeFileSync(
    pathMod.join(ticketDir, '.work-state.json'),
    JSON.stringify(state, null, 2)
  );
  return state;
}

describe('work-next.js — terminal short-circuit on state.status === "completed"', () => {
  it('work-next short-circuits on state.status completed regardless of stepStatus.complete', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-resume-ac4-'));
    try {
      writeCompletedState(tmpBase, 'ECHO-4552', { complete: 'pending' });
      const { parsed } = runWorkNext('ECHO-4552', tmpBase);
      assert.ok(parsed, 'expected JSON output on stdout');
      assert.equal(parsed.action, 'complete', `expected action=complete, got ${parsed.action}`);
      // The terminal short-circuit emits a distinctive summary referencing session release.
      // Without the Task 5 extension this path only fires when stepStatus.complete === 'completed';
      // here it is 'pending', so the assertion fails on current main.
      assert.ok(
        typeof parsed.summary === 'string' &&
          /already complete.*Session released/i.test(parsed.summary),
        `expected short-circuit summary "...already complete. Session released.", got: ${JSON.stringify(parsed)}`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('terminal short-circuit fires on state.status completed even when complete step missing', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-resume-ac7-'));
    try {
      // Build a state with status=completed but stepStatus.complete undefined
      const ticketDir = pathMod.join(tmpBase, 'ECHO-4553');
      fs.mkdirSync(ticketDir, { recursive: true });
      const state = {
        ticketId: 'ECHO-4553',
        ticketBase: 'ECHO-4553',
        ticketSuffix: null,
        ticketSeparator: '-',
        currentStep: 18,
        status: 'completed',
        stepStatus: {
          ticket: 'completed',
          bootstrap: 'completed',
          // intentionally NO 'complete' key
        },
      };
      fs.writeFileSync(
        pathMod.join(ticketDir, '.work-state.json'),
        JSON.stringify(state, null, 2)
      );

      const { parsed } = runWorkNext('ECHO-4553', tmpBase);
      assert.ok(parsed, 'expected JSON output');
      assert.equal(parsed.action, 'complete');
      // Short-circuit summary must fire — proves the terminal short-circuit branch ran.
      assert.ok(
        typeof parsed.summary === 'string' &&
          /already complete.*Session released/i.test(parsed.summary),
        `expected short-circuit summary, got: ${JSON.stringify(parsed)}`
      );
      // Returned payload back-fills stepStatus.complete = 'completed'
      const stepStatusOut =
        parsed.state?.stepStatus ||
        parsed.stepStatus ||
        parsed.state?.completedSteps; // tolerate either shape
      // Either explicit stepStatus map with complete=completed, or completedSteps array containing 'complete'
      const okMap =
        stepStatusOut &&
        typeof stepStatusOut === 'object' &&
        !Array.isArray(stepStatusOut) &&
        stepStatusOut.complete === 'completed';
      const okArr =
        Array.isArray(parsed.state?.completedSteps) &&
        parsed.state.completedSteps.includes('complete');
      assert.ok(
        okMap || okArr,
        `expected back-filled stepStatus.complete = 'completed', got payload: ${JSON.stringify(parsed)}`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('work-next is deterministic on unchanged input', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-resume-ac5-'));
    try {
      writeCompletedState(tmpBase, 'ECHO-4554', { complete: 'pending' });
      const first = runWorkNext('ECHO-4554', tmpBase);
      const second = runWorkNext('ECHO-4554', tmpBase);
      assert.ok(first.parsed && second.parsed, 'both invocations should emit JSON');
      assert.equal(first.parsed.action, 'complete');
      assert.equal(second.parsed.action, 'complete');

      // Strip volatile fields (lastPlanTimestamp anywhere in the object)
      const strip = (obj) => {
        const json = JSON.stringify(obj, (key, value) => {
          if (key === 'lastPlanTimestamp') return undefined;
          return value;
        });
        return JSON.parse(json);
      };
      assert.deepEqual(
        strip(first.parsed),
        strip(second.parsed),
        'two invocations on unchanged state must produce identical instructions (modulo lastPlanTimestamp)'
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
