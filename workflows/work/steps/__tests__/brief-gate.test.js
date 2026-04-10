/**
 * Unit tests for the brief-gate step module (GH-215, Task 4).
 *
 * Covers the four SKIP/RUN decision paths plus the post-resolve handler
 * behavior (rewrite-on-answer, no-op-on-cancel).
 *
 * Run: node --test workflows/work/steps/__tests__/brief-gate.test.js
 */

'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STEPS } = require('../../step-registry');

// ─── Test doubles matching bootstrap.test.js ────────────────────────────────

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
    hasBrief: true,
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

// ─── Fixture helpers ────────────────────────────────────────────────────────

const BRIEF_ALL_LOCAL = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  '- **Question:** How should we name the local helper?',
  '  - `scope: local`',
  '  - `rationale: scoped to this ticket only`',
  '  - `resolved: false`',
  '',
].join('\n');

const BRIEF_ONE_BLOCKING_ARCH = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  '- **Question:** Which queue backend should we adopt for cross-service jobs?',
  '  - `scope: architectural`',
  '  - `rationale: affects all downstream services`',
  '  - `resolved: false`',
  '',
].join('\n');

function makeTmpTasksDir(briefContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-gate-test-'));
  if (briefContent !== null) {
    fs.writeFileSync(path.join(dir, 'brief.md'), briefContent, 'utf8');
  }
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('brief-gate step', () => {
  let briefGateStep;
  let applyBriefResolutions;
  const createdDirs = [];
  const originalEnv = process.env.WORK_BRIEF_ENABLED;

  before(() => {
    const mod = require(path.join(__dirname, '..', 'brief-gate.js'));
    briefGateStep = typeof mod === 'function' ? mod : mod.briefGateStep;
    applyBriefResolutions = mod.applyBriefResolutions;
  });

  beforeEach(() => {
    delete process.env.WORK_BRIEF_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WORK_BRIEF_ENABLED;
    else process.env.WORK_BRIEF_ENABLED = originalEnv;
    while (createdDirs.length) rmrf(createdDirs.pop());
  });

  it('exports a function', () => {
    assert.equal(typeof briefGateStep, 'function');
  });

  it('SKIPs when WORK_BRIEF_ENABLED=0', () => {
    process.env.WORK_BRIEF_ENABLED = '0';
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /disabled/i);
  });

  it('SKIPs when no brief.md is present', () => {
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState({ hasBrief: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /no brief/i);
  });

  it('SKIPs when all questions are resolved (only-local brief)', () => {
    const dir = makeTmpTasksDir(BRIEF_ALL_LOCAL);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /resolved|no open/i);
  });

  it('RUNs with AskUserQuestion payload when a blocking architectural question exists', () => {
    const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.step, STEPS.brief_gate);
    assert.equal(entry.action, 'RUN');
    assert.equal(entry.command, 'AskUserQuestion');
    assert.match(entry.reason, /1 .*unresolved/i);
    assert.ok(entry.askUserQuestionPayload, 'RUN entry must carry askUserQuestionPayload');
    assert.ok(
      Array.isArray(entry.askUserQuestionPayload.questions) ||
        entry.askUserQuestionPayload.question,
      'payload must carry questions[] or a question field'
    );
    assert.equal(entry.onResolve, 'rewrite brief.md');
  });

  it('SKIPs (fail-open) when brief.md is unreadable', () => {
    const dir = makeTmpTasksDir(null); // no brief.md file
    createdDirs.push(dir);
    // But s.hasBrief is true — simulates stale state where brief vanished.
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState({ hasBrief: true }), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'SKIP');
  });

  describe('applyBriefResolutions (post-resolve handler)', () => {
    it('rewrites brief.md when resolutions are provided', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');

      const resolutions = new Map([
        [
          'Which queue backend should we adopt for cross-service jobs?',
          'Use SQS for all cross-service jobs.',
        ],
      ]);

      applyBriefResolutions(briefPath, resolutions);

      const updated = fs.readFileSync(briefPath, 'utf8');
      assert.match(updated, /resolved:\s*true/);
      assert.match(updated, /\*\*Resolution:\*\*\s*Use SQS/);
    });

    it('is a no-op when resolutions are undefined (user cancellation)', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      const before = fs.readFileSync(briefPath, 'utf8');

      applyBriefResolutions(briefPath, undefined);

      const after = fs.readFileSync(briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must be byte-identical on cancel');
    });

    it('is a no-op when resolutions map is empty', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      const before = fs.readFileSync(briefPath, 'utf8');

      applyBriefResolutions(briefPath, new Map());

      const after = fs.readFileSync(briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must be byte-identical on empty map');
    });
  });
});
