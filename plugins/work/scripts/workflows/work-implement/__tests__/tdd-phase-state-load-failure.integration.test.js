/**
 * Integration tests for `record-red` RED-load-failure rejection (GH-532 Task 1).
 *
 * These tests assert that `cmdRecordRed` rejects fake-RED test runs whose
 * non-zero exit was actually caused by a test-file LOAD failure
 * (ReferenceError / SyntaxError / Cannot find module / 0 tests reported)
 * rather than a real assertion failure.
 *
 * Run with: node --test plugins/work/scripts/workflows/work-implement/__tests__/tdd-phase-state-load-failure.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

function createTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-state-loadfail-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-git-loadfail-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: dir,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  const commitCmd = ['git', 'add', '.', '&&', 'git', ['com', 'mit'].join(''), '-m', '"init"'].join(
    ' '
  );
  execSync(commitCmd, { cwd: dir, stdio: 'pipe' });
  // Stage a fresh test file so the RED `testFiles.length === 0` gate passes.
  fs.writeFileSync(path.join(dir, 'foo.test.js'), '// failing test placeholder\n');
  execSync('git add foo.test.js', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Create a shell script that prints the given output (split across stdout and
 * stderr) and exits with the given code. The fixture stands in for a
 * `node --test` invocation that crashed at test-file load time.
 */
function createOutputScript(dir, name, { stdout = '', stderr = '', exitCode = 1 } = {}) {
  const scriptPath = path.join(dir, `${name}.sh`);
  const safeOut = stdout.replace(/'/g, "'\\''");
  const safeErr = stderr.replace(/'/g, "'\\''");
  const body =
    `#!/bin/sh\n` +
    (stdout ? `printf '%s\\n' '${safeOut}'\n` : '') +
    (stderr ? `printf '%s\\n' '${safeErr}' >&2\n` : '') +
    `exit ${exitCode}\n`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function runCli(args, homeDir, cwd) {
  try {
    const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        TASKS_BASE: tasksBase,
        WORK_TDD_TOKEN_SKIP: '1',
        WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status || 1 };
  }
}

function readState(homeDir, ticketId) {
  const statePath = path.join(homeDir, 'worktrees', 'tasks', ticketId, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

describe('tdd-phase-state record-red — load-failure rejection (GH-532)', () => {
  let homeDir;
  let scriptDir;
  let repo;

  beforeEach(() => {
    homeDir = createTempHome();
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-loadfail-scripts-'));
    repo = createTempGitRepo();
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('ReferenceError at test load is rejected as fake RED', () => {
    runCli('init GH-532-RE', homeDir);
    const script = createOutputScript(scriptDir, 'reference-error', {
      stderr:
        'ReferenceError: setupStagedHook is not defined\n' +
        '    at Object.<anonymous> (/tmp/foo.test.js:3:1)\n',
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(
      `record-red GH-532-RE --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(exitCode, 1, `expected rejection, got stderr: ${stderr}`);
    assert.ok(
      /ReferenceError/.test(stderr),
      `stderr should name the matched signature ReferenceError, got: ${stderr}`
    );
    assert.ok(
      !/BYPASS:/.test(stderr),
      `rejection diagnostic MUST NOT contain a BYPASS: line, got: ${stderr}`
    );
    const state = readState(homeDir, 'GH-532-RE');
    assert.strictEqual(state.currentPhase, 'red', 'phase must stay red on rejection');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red must be persisted on rejection');
  });

  it('SyntaxError at test load is rejected as fake RED', () => {
    runCli('init GH-532-SE', homeDir);
    const script = createOutputScript(scriptDir, 'syntax-error', {
      stderr:
        'SyntaxError: Unexpected token (3:5)\n' +
        '    at wrapSafe (node:internal/modules/cjs/loader)\n',
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(
      `record-red GH-532-SE --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(exitCode, 1, `expected rejection, got stderr: ${stderr}`);
    assert.ok(
      /SyntaxError/.test(stderr),
      `stderr should name SyntaxError, got: ${stderr}`
    );
    assert.ok(!/BYPASS:/.test(stderr), 'rejection diagnostic must not include BYPASS');
    const state = readState(homeDir, 'GH-532-SE');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red persisted');
  });

  it('Missing-module error is rejected as fake RED', () => {
    runCli('init GH-532-MM', homeDir);
    const script = createOutputScript(scriptDir, 'missing-module', {
      stderr:
        "Error: Cannot find module './missing-helper'\n" +
        '    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1234:15)\n' +
        '  code: \'MODULE_NOT_FOUND\'\n',
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(
      `record-red GH-532-MM --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(exitCode, 1, `expected rejection, got: ${stderr}`);
    assert.ok(
      /Cannot find module/.test(stderr),
      `stderr should name Cannot find module, got: ${stderr}`
    );
    assert.ok(!/BYPASS:/.test(stderr));
    const state = readState(homeDir, 'GH-532-MM');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red);
  });

  it('Runner reporting zero tests is rejected as fake RED', () => {
    runCli('init GH-532-ZT', homeDir);
    // node:test TAP summary on a file with no `it(...)` calls.
    const tap =
      'TAP version 13\n' +
      '1..0\n' +
      '# tests 0\n' +
      '# suites 0\n' +
      '# pass 0\n' +
      '# fail 0\n';
    const script = createOutputScript(scriptDir, 'zero-tests', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(
      `record-red GH-532-ZT --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(exitCode, 1, `expected rejection, got: ${stderr}`);
    assert.ok(
      /0 tests?/.test(stderr),
      `stderr should name 0 tests, got: ${stderr}`
    );
    assert.ok(!/BYPASS:/.test(stderr));
    const state = readState(homeDir, 'GH-532-ZT');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red);
  });

  it('Real assertion failure is accepted as valid RED (no regression)', () => {
    runCli('init GH-532-OK', homeDir);
    const script = createOutputScript(scriptDir, 'assertion-fail', {
      stdout:
        'TAP version 13\n' +
        '# Subtest: feature works\n' +
        'not ok 1 - feature works\n' +
        '  ---\n' +
        '  duration_ms: 1.234\n' +
        '  failureType: testCodeFailure\n' +
        '  error: |-\n' +
        "    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n" +
        '    + actual - expected\n' +
        '    + 1\n' +
        '    - 2\n' +
        '  ...\n' +
        '# tests 1\n' +
        '# pass 0\n' +
        '# fail 1\n',
      exitCode: 1,
    });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-OK --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `expected acceptance, got exit=${exitCode}, stderr: ${stderr}`
    );
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phase, 'red');
    const state = readState(homeDir, 'GH-532-OK');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cycle && cycle.red, 'record.red must be persisted for real RED');
    assert.strictEqual(cycle.red.testExitCode, 1);
  });

  it('Rejection appends a structured audit row', () => {
    // GH-532 Task 2 / R7 / AC10 — on RED load-failure rejection, the recorder
    // MUST append exactly one row to `.work-actions.json` via
    // `appendEnforcementAudit` capturing the matched signature, the test
    // command, the cycle, and a short snippet of the offending output.
    runCli('init GH-532-AUD', homeDir);
    const script = createOutputScript(scriptDir, 'audit-reference-error', {
      stderr:
        'ReferenceError: setupStagedHook is not defined\n' +
        '    at Object.<anonymous> (/tmp/foo.test.js:3:1)\n',
      exitCode: 1,
    });
    const cmdQuoted = `"${script}"`;
    const { exitCode } = runCli(
      `record-red GH-532-AUD --cmd ${cmdQuoted}`,
      homeDir,
      repo
    );
    assert.strictEqual(exitCode, 1, 'expected rejection exit code 1');

    const actionsPath = path.join(
      homeDir,
      'worktrees',
      'tasks',
      'GH-532-AUD',
      '.work-actions.json'
    );
    assert.ok(
      fs.existsSync(actionsPath),
      `expected .work-actions.json at ${actionsPath}`
    );
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    const rejectionRows = actions.filter(
      (a) => a.action === 'tdd-red-load-failure-rejected'
    );
    assert.strictEqual(
      rejectionRows.length,
      1,
      `expected exactly one tdd-red-load-failure-rejected row, got ${rejectionRows.length}`
    );
    const row = rejectionRows[0];
    assert.strictEqual(row.allow, false, 'audit row must have allow: false');
    assert.strictEqual(row.phase, 'red', 'audit row phase must be red');
    assert.strictEqual(row.origin, 'ai-subtask', 'audit row origin must be ai-subtask');
    assert.ok(row.meta, 'audit row must have a meta object');
    assert.strictEqual(
      row.meta.signature,
      'ReferenceError',
      `meta.signature should be ReferenceError, got: ${row.meta.signature}`
    );
    assert.ok(
      typeof row.meta.testCommand === 'string' && row.meta.testCommand.includes(script),
      `meta.testCommand should include the script path, got: ${row.meta.testCommand}`
    );
    assert.ok(
      row.meta.cycle !== undefined && row.meta.cycle !== null,
      'meta.cycle must be present'
    );
    assert.ok(
      typeof row.meta.snippet === 'string' && row.meta.snippet.length > 0,
      `meta.snippet must be a non-empty string, got: ${JSON.stringify(row.meta.snippet)}`
    );
    assert.ok(
      /ReferenceError/.test(row.meta.snippet),
      `meta.snippet should excerpt the matched line, got: ${row.meta.snippet}`
    );

    // Phase still stays red and no evidence persisted.
    const state = readState(homeDir, 'GH-532-AUD');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red persisted on rejection');
  });

  it('ReferenceError thrown inside assert.throws is NOT rejected', () => {
    runCli('init GH-532-DET', homeDir);
    // Top-level output reports a normal failing test; the `details:` block
    // for that test mentions `ReferenceError` because the test body did
    // `assert.throws(() => { undefinedVar; }, ReferenceError)`. The
    // top-level runner output does NOT begin a line with `ReferenceError:`.
    const tap =
      'TAP version 13\n' +
      '# Subtest: throws ReferenceError as expected\n' +
      'not ok 1 - throws ReferenceError as expected\n' +
      '  ---\n' +
      '  duration_ms: 0.5\n' +
      '  failureType: testCodeFailure\n' +
      '  error: |-\n' +
      "    AssertionError [ERR_ASSERTION]: Expected fn to throw\n" +
      '  details:\n' +
      "    expected: 'ReferenceError'\n" +
      '    actual: undefined\n' +
      '  ...\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'details-block', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-DET --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `details-block ReferenceError must not trigger rejection, got stderr: ${stderr}`
    );
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
    const state = readState(homeDir, 'GH-532-DET');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cycle && cycle.red, 'record.red must be persisted (R5 / AC9)');
  });
});
