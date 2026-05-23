/**
 * Unit tests for the tasks-gate step module (GH-398, Task 4).
 *
 * Covers the idempotent resume short-circuit: when
 * `ctx.workState.stepStatus.tasks_gate === "completed"`, the handler must
 * DEFER with reason matching /previously satisfied/i and MUST NOT call
 * `parseTasks` or `validateAll`.
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/tasks-gate.test.js
 */

'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STEPS } = require('../../step-registry');

// ─── Test doubles ────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    safeName: 'TEST-100',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    t: 'TEST-100',
    path,
    fileExists: (p) => fs.existsSync(p),
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    hasTasks: true,
    pr: null,
    ...overrides,
  };
}

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── tasks-gate idempotent resume short-circuit (GH-398, Task 4) ─────────────

describe('tasks-gate idempotent resume short-circuit (GH-398)', () => {
  let tasksGateStep;
  const createdDirs = [];

  before(() => {
    const mod = require(path.join(__dirname, '..', 'tasks-gate.js'));
    tasksGateStep = typeof mod === 'function' ? mod : mod.tasksGateStep;
  });

  afterEach(() => {
    while (createdDirs.length) rmrf(createdDirs.pop());
  });

  // AC2: tasks_gate skips re-validation when previously satisfied
  it('tasks_gate skips re-validation when previously satisfied', () => {
    // Use a tasksDir with intentionally invalid tasks.md content. If the handler
    // tried to parse or validate it, we would get a RUN action with
    // /work-workflow:split-in-tasks. The short-circuit must fire FIRST so we
    // get DEFER + "previously satisfied" without invoking parseTasks/validateAll.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-gate-resume-'));
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      '# Tasks\n\nNo task sections at all — would fail validation.\n',
      'utf8'
    );
    createdDirs.push(dir);

    // Spy on parseTasks and validateAll to assert neither is invoked.
    const taskParser = require('../../lib/task-parser');
    const taskScope = require('../../../lib/task-scope');
    const origParseTasks = taskParser.parseTasks;
    const origValidateAll = taskScope.validateAll;
    let parseTasksCalled = false;
    let validateAllCalled = false;
    taskParser.parseTasks = function (...args) {
      parseTasksCalled = true;
      return origParseTasks.apply(this, args);
    };
    taskScope.validateAll = function (...args) {
      validateAllCalled = true;
      return origValidateAll.apply(this, args);
    };

    try {
      const { add, entries } = makeAdd();
      const ctx = makeCtx({
        tasksDir: dir,
        workState: { stepStatus: { tasks_gate: 'completed' } },
      });
      tasksGateStep(add, makeState(), ctx);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].step, STEPS.tasks_gate);
      assert.equal(entries[0].action, 'DEFER');
      assert.match(entries[0].reason, /previously satisfied/i);
      assert.equal(parseTasksCalled, false, 'parseTasks must not be called on satisfied resume');
      assert.equal(validateAllCalled, false, 'validateAll must not be called on satisfied resume');
    } finally {
      taskParser.parseTasks = origParseTasks;
      taskScope.validateAll = origValidateAll;
    }
  });
});
