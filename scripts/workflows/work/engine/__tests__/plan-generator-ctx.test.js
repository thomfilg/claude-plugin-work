/**
 * Tests for workflows/work/engine/plan-generator.js — GH-398 Task 2
 *
 * Verifies that `ctx.workState` is plumbed into the per-step ctx object
 * passed to every handler in STEP_PIPELINE. Downstream consumers
 * (`spec-gate`, `tasks-gate`) need this field to short-circuit on
 * `stepStatus[gate] === "completed"` during resume.
 *
 * Strategy: install a stub step handler into STEP_PIPELINE that captures
 * the ctx it receives, run generatePlan() with a known workState fixture
 * embedded in the inspected state object, then assert ctx.workState
 * equals the fixture by deep-equality.
 *
 * Run: node --test scripts/workflows/work/engine/__tests__/plan-generator-ctx.test.js
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { generatePlan } = require(path.join(__dirname, '..', 'plan-generator'));
const stepsIndex = require(path.join(__dirname, '..', '..', 'steps'));
const { STEPS } = require(path.join(__dirname, '..', '..', 'step-registry'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    tp: {
      sanitizeTicketIdForPath: (t) => t,
      getProviderConfig: () => ({}),
      getCreateTicketAgentType: () => 'general-purpose',
      getCreateTicketPrompt: () => null,
      getFetchTicketPrompt: () => 'Fetch ticket.',
      getTransitionPrompt: () => 'Move ticket.',
    },
    TDD_PROTOCOL: '',
    TDD_GATED_STEPS: [],
    STEPS,
    parseTasks: () => [],
    buildTaskPrompt: () => '',
    fileExists: () => false,
    run: () => '',
    WORKTREES_BASE: '/tmp/worktrees',
    TASKS_BASE: '/tmp/tasks',
    MAIN_WORKTREE_FOLDER: 'my-project',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    tasksDirExists: true,
    hasStateFile: false,
    currentStep: 'brief',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    branch: null,
    headSha: null,
    hasDiffVsMain: false,
    diffSummary: '',
    hasCommitWithTicket: false,
    hasUncommitted: false,
    uncommittedCount: 0,
    hasUnpushed: false,
    lastCommitMsg: '',
    pr: null,
    reports: {},
    allReportsPass: true,
    missingReports: [],
    failedReports: [],
    prUpdateSha: null,
    postPrUpdateSha: null,
    prEverUpdated: false,
    prShaMatch: false,
    hasBrief: false,
    hasSpec: false,
    hasTasks: false,
    hasDevSession: false,
    workState: null,
    stepIs: () => 'unknown',
    ...overrides,
  };
}

/**
 * Install a capturing stub at the END of STEP_PIPELINE for the duration of
 * a single test. Returns a teardown function that restores the original
 * pipeline. The stub records the ctx object the orchestrator passed it.
 */
function installCapturingStub() {
  const captured = { ctx: null, called: false };
  const stub = (_add, _state, ctx) => {
    captured.called = true;
    captured.ctx = ctx;
  };
  stepsIndex.STEP_PIPELINE.push(stub);
  return {
    captured,
    restore: () => {
      const idx = stepsIndex.STEP_PIPELINE.indexOf(stub);
      if (idx >= 0) stepsIndex.STEP_PIPELINE.splice(idx, 1);
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('plan-generator ctx.workState plumbing (GH-398 Task 2)', () => {
  let activeStub = null;
  afterEach(() => {
    if (activeStub) {
      activeStub.restore();
      activeStub = null;
    }
  });

  it('exposes ctx.workState to step handlers when state.workState is provided', () => {
    const fixture = {
      status: 'in_progress',
      currentStep: 'spec_gate',
      stepStatus: {
        spec_gate: 'completed',
        tasks_gate: 'pending',
      },
    };

    activeStub = installCapturingStub();
    const state = makeState({ workState: fixture });

    generatePlan('TEST-100', null, state, false, null, null, makeDeps());

    assert.ok(activeStub.captured.called, 'stub handler should have been invoked');
    assert.ok(activeStub.captured.ctx, 'stub should have received a ctx object');
    assert.ok(
      'workState' in activeStub.captured.ctx,
      'ctx must include a workState property (was undefined)'
    );
    assert.deepEqual(
      activeStub.captured.ctx.workState,
      fixture,
      'ctx.workState must mirror the loaded .work-state.json fixture'
    );
  });

  it('exposes ctx.workState as null when no .work-state.json has been loaded', () => {
    activeStub = installCapturingStub();
    const state = makeState({ workState: null });

    generatePlan('TEST-100', null, state, false, null, null, makeDeps());

    assert.ok(activeStub.captured.called);
    assert.ok(
      'workState' in activeStub.captured.ctx,
      'ctx must include workState property even when null'
    );
    assert.equal(
      activeStub.captured.ctx.workState,
      null,
      'ctx.workState must be null when state.workState is null'
    );
  });
});
