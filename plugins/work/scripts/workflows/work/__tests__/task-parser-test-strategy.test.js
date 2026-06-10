/**
 * Tests for task-parser.js — extractTestStrategy + testStrategy field (GH-590 Task 10).
 *
 * Covers AC1 (parser side of the enum): recognizes `### Test Strategy` block,
 * reads `kind:` / `entry:` / `verified-by:` / custom fenced body.
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/work/__tests__/task-parser-test-strategy.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const taskParser = require(path.join(__dirname, '..', 'lib', 'task-parser'));
const { parseTasks, extractTestStrategy } = taskParser;

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-parser-strategy-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeTasksFile(content) {
  fs.writeFileSync(path.join(tmpDir, 'tasks.md'), content, 'utf-8');
}

describe('extractTestStrategy', () => {
  it('is exported from task-parser', () => {
    assert.equal(typeof extractTestStrategy, 'function');
  });

  it('returns {kind: "unit", entry} for kind=unit with entry', () => {
    const body = `Some preamble

### Test Strategy
\`\`\`yaml
kind: unit
entry: plugins/work/scripts/workflows/lib/__tests__/foo.test.js
\`\`\`

### Test Command
\`\`\`bash
pnpm test foo
\`\`\`
`;
    const strategy = extractTestStrategy(body);
    assert.ok(strategy, 'strategy should not be null');
    assert.equal(strategy.kind, 'unit');
    assert.equal(
      strategy.entry,
      'plugins/work/scripts/workflows/lib/__tests__/foo.test.js'
    );
  });

  it('returns {kind: "verified-by", verifiedBy} for verified-by peer reference', () => {
    const body = `### Test Strategy
\`\`\`yaml
kind: verified-by
verified-by: Task 6
\`\`\`
`;
    const strategy = extractTestStrategy(body);
    assert.ok(strategy);
    assert.equal(strategy.kind, 'verified-by');
    assert.equal(strategy.verifiedBy, 'Task 6');
  });

  it('returns {kind: "custom", customBody} for kind=custom with body', () => {
    const body = `### Test Strategy
\`\`\`yaml
kind: custom
\`\`\`
\`\`\`bash
pnpm dev:typecheck && grep -q foo bar.ts
\`\`\`
`;
    const strategy = extractTestStrategy(body);
    assert.ok(strategy);
    assert.equal(strategy.kind, 'custom');
    assert.ok(
      strategy.customBody && strategy.customBody.includes('pnpm dev:typecheck'),
      `customBody should contain the custom command, got: ${JSON.stringify(strategy.customBody)}`
    );
    assert.ok(strategy.customBody.includes('grep -q foo bar.ts'));
  });

  it('returns null when only legacy `### Test Command` is present (no Test Strategy block)', () => {
    const body = `### Test Command
\`\`\`bash
pnpm test legacy
\`\`\`
`;
    const strategy = extractTestStrategy(body);
    assert.equal(strategy, null);
  });
});

describe('parseTasks — testStrategy field', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('emits testStrategy field on parsed task when Test Strategy block is present', () => {
    writeTasksFile(`## Task 1 — Strategy example

### Type
backend

### Test Strategy
\`\`\`yaml
kind: unit
entry: lib/__tests__/x.test.js
\`\`\`

### Test Command
\`\`\`bash
pnpm test x
\`\`\`
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.ok(
      'testStrategy' in task,
      `parsed task should have testStrategy field; got keys: ${Object.keys(task).join(', ')}`
    );
    assert.ok(task.testStrategy, 'testStrategy should not be null when block present');
    assert.equal(task.testStrategy.kind, 'unit');
    assert.equal(task.testStrategy.entry, 'lib/__tests__/x.test.js');
    // Legacy field still populated:
    assert.ok(task.testCommand && task.testCommand.includes('pnpm test x'));
  });

  it('emits testStrategy === null when only legacy Test Command is present', () => {
    writeTasksFile(`## Task 1 — Legacy only

### Type
backend

### Test Command
\`\`\`bash
pnpm test legacy
\`\`\`
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    const task = tasks[0];
    assert.ok('testStrategy' in task);
    assert.equal(task.testStrategy, null);
    assert.ok(task.testCommand && task.testCommand.includes('pnpm test legacy'));
  });
});
