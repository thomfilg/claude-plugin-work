'use strict';

/**
 * protect-task-scope.js — per-Type closed-allowlist tests (GH-528 item 5).
 *
 * Each kind:
 *   - tests-only → write target must be *.test.* / *.spec.*
 *   - docs → write target must be *.md
 *   - config → write target must be in config allowlist
 *   - ci → write target must be dot-github/workflows/** etc.
 *   - tdd-code → unchanged (no per-Type restriction)
 *
 * Plus:
 *   - Type-line edit in tasks.md is blocked (Write + Edit + MultiEdit).
 *   - One-shot env bypass (REASON+TARGET) still works through per-Type layer.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'protect-task-scope.js');
const WORK_STATE_FILENAME = '.work' + '-state.json';
const TICKET = 'TEST-528';

function writeWorkState(tasksDir) {
  fs.writeFileSync(
    path.join(tasksDir, WORK_STATE_FILENAME),
    JSON.stringify({
      ticketId: TICKET,
      stepStatus: { ticket: 'completed', implement: 'in_progress' },
      tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task_1', status: 'in_progress' }] },
    })
  );
}

function writeTasksMd(tasksDir, { type, filesInScope }) {
  const lines = [
    '## Task 1 — sample',
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    ...filesInScope.map((f) => `- ${f}`),
    '',
  ];
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
}

function runHook({ tasksBase, cwd, toolName, toolInput, env = {} }) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      PROTECT_TASK_SCOPE_TICKET_ID: TICKET,
      PROTECT_TASK_SCOPE_BYPASS_REASON: '',
      PROTECT_TASK_SCOPE_BYPASS_TARGET: '',
      ...env,
    },
  });
}

describe('protect-task-scope — per-Type allowlist', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-type-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('Type=tests-only — *.test.js target ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'tests-only', filesInScope: ['src/**'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.test.js'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=tests-only — src/foo.js target BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'tests-only', filesInScope: ['src/**'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 2, `expected block; stdout=${r.stdout}`);
    assert.match(r.stderr, /tests-only/);
  });

  it('Type=docs — README.md ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*.md'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'README.md'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=docs — src/foo.js BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /docs allowlist/);
  });

  it('Type=config — package.json ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'config', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'package.json'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=config — src/server.js BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'config', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/server.js'), content: 'x' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /config allowlist/);
  });

  it('Type=ci — dot-github/workflows/ci.yml ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'ci', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, '.git' + 'hub/workflows/ci.yml'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=ci — src/foo.js BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'ci', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ci allowlist/);
  });

  it('Type=tdd-code — existing behavior unchanged (no per-Type restriction)', () => {
    writeTasksMd(tasksDir, { type: 'tdd-code', filesInScope: ['src/**'] });
    // Even non-test, non-md file is allowed because tdd-code has no allowlist.
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow for tdd-code; stderr=${r.stderr}`);
  });

  it('one-shot bypass pair still works for per-Type layer', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
    const target = path.join(tmpHome, 'src/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'emergency docs ship',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/foo.js',
      },
    });
    assert.equal(r.status, 0, `expected bypass to allow; stderr=${r.stderr}`);
  });
});

describe('protect-task-scope — Type-line edit guard', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-type-line-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
    writeTasksMd(tasksDir, { type: 'tdd-code', filesInScope: ['src/**'] });
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('Write to tasks.md that flips Type tdd-code → docs is BLOCKED', () => {
    const newContent = [
      '## Task 1 — sample',
      '',
      '### Type',
      'docs',
      '',
      '### Files in scope',
      '- src/**',
      '',
    ].join('\n');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        content: newContent,
      },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /### Type/);
  });

  it('Write to tasks.md that preserves Type lines is permitted by Type-line guard (other gates may still block)', () => {
    const sameContent = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        content: sameContent,
      },
    });
    // Note: scope check may still block (tasks.md is not under src/**), but
    // the message must not mention `### Type`.
    assert.doesNotMatch(r.stderr || '', /refusing to modify `### Type`/);
  });

  it('Edit tool whose patch changes `### Type` line is BLOCKED', () => {
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: '### Type\ntdd-code',
        new_string: '### Type\ndocs',
      },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /### Type/);
  });
});
