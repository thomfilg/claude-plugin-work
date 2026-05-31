/**
 * implement.test.js
 *
 * GH-410 Task 3: Tests for the implement step's auto-init descriptor wiring.
 *
 * Verifies the `### Type\ncheckpoint` task descriptor is threaded through
 * to `work-state.js task-init` via stdin so checkpoint tasks land in
 * `tasksMeta` with `kind: 'checkpoint'`.
 *
 * Mirrors the test harness in implement-step.test.js (GH-219 Task 16).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const implementStep = require('../steps/implement');

function makeState(overrides = {}) {
  return {
    hasTasks: true,
    workState: {
      status: 'in_progress',
      stepStatus: { implement: 'pending' },
      tasksMeta: {
        totalTasks: 3,
        currentTaskIndex: 0,
        tasks: [
          { id: 'task_1', status: 'pending', dependencies: [] },
          { id: 'task_2', status: 'pending', dependencies: [1] },
          { id: 'task_3', status: 'pending', dependencies: [1, 2] },
        ],
      },
      ...overrides.workState,
    },
    hasDiffVsMain: false,
    diffSummary: '',
    stepIs: (step) => overrides.stepStatus?.[step] ?? 'pending',
    ...overrides,
  };
}

function makeTaskData(tasks) {
  return tasks.map((t, i) => ({
    id: `task_${t.num ?? i + 1}`,
    num: t.num ?? i + 1,
    title: t.title ?? `Task ${t.num ?? i + 1} title`,
    type: t.type ?? 'backend',
    isCheckpoint: t.isCheckpoint ?? false,
    dependencies: t.dependencies ?? [],
    requirementsCovered: '',
    acceptanceCriteria: '',
    suggestedScope: '',
    rawContent: `## Task ${t.num ?? i + 1} — ${t.title ?? `Task ${t.num ?? i + 1} title`}`,
  }));
}

function makeCtx(overrides = {}) {
  const tasksDir = overrides.tasksDir ?? '/tmp/fake-tasks';
  const taskData = overrides.taskData ?? null;
  return {
    STEPS: { implement: 'implement' },
    safeName: 'GH-410',
    tasksDir,
    planningContext: '',
    getDocsPrompt: () => '',
    parseTasks: () => taskData,
    buildTaskPrompt: (task) =>
      `## Current Task: Task ${task.num} — ${task.title}\n\n### Task Details\n${task.rawContent}`,
    fileExists: () => false,
    path,
    execFileSync: () => '',
    workStatePath: path.join(__dirname, '..', 'work-state.js'),
    ...overrides,
  };
}

function captureStep(s, ctx) {
  const entries = [];
  function add(step, action, command, reason, meta) {
    entries.push({ step, action, command, reason, meta });
  }
  implementStep(add, s, ctx);
  return entries;
}

describe('implement step — auto-init descriptors (GH-410 Task 3)', () => {
  it('passes JSON descriptor array via stdin to task-init', () => {
    const taskData = makeTaskData([
      { num: 1, title: 'Backend', type: 'backend' },
      { num: 2, title: 'Wrap-up', type: 'checkpoint' },
    ]);
    const calls = [];
    const ctx = makeCtx({
      taskData,
      execFileSync: (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts && opts.input });
        return '';
      },
    });
    const s = makeState({
      workState: {
        status: 'in_progress',
        stepStatus: { implement: 'pending' },
      },
    });
    captureStep(s, ctx);

    const taskInit = calls.find((c) => Array.isArray(c.args) && c.args.includes('task-init'));
    assert.ok(taskInit, 'task-init invocation should occur');
    assert.ok(
      typeof taskInit.input === 'string' && taskInit.input.length > 0,
      'task-init must receive descriptor JSON via stdin'
    );
    const parsed = JSON.parse(taskInit.input);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].type, 'backend');
    assert.equal(parsed[1].type, 'checkpoint');
    assert.equal(parsed[0].num, 1);
    assert.equal(parsed[1].num, 2);
  });

  it('falls back to legacy count when stdin invocation throws', () => {
    const taskData = makeTaskData([{ num: 1, title: 'Solo', type: 'backend' }]);
    const calls = [];
    let throwOnce = true;
    const ctx = makeCtx({
      taskData,
      execFileSync: (cmd, args, opts) => {
        calls.push({ cmd, args, hasInput: !!(opts && opts.input) });
        if (throwOnce && opts && opts.input) {
          throwOnce = false;
          throw new Error('stdin path simulated failure');
        }
        return '';
      },
    });
    const s = makeState({
      workState: {
        status: 'in_progress',
        stepStatus: { implement: 'pending' },
      },
    });
    captureStep(s, ctx);

    assert.equal(calls.length, 2, 'should retry without stdin on failure');
    assert.equal(calls[0].hasInput, true);
    assert.equal(calls[1].hasInput, false);
    assert.equal(calls[1].args[calls[1].args.length - 1], '1');
  });
});
