/**
 * Tests for work-auto-advance.js — PostToolUse hook for /work2.
 *
 * Tests the hook's guards (marker file, session matching) and output behavior.
 * Uses child_process.spawn with stdin to simulate hook invocation.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const hookPath = path.join(__dirname, '..', 'hooks', 'work-auto-advance.js');

function runHook(hookData, env = {}) {
  const input = JSON.stringify(hookData);
  try {
    const result = execFileSync(process.execPath, [hookPath], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout: result };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('work-auto-advance hook', () => {
  it('exits 0 silently when no stdin', () => {
    try {
      const result = execFileSync(process.execPath, [hookPath], {
        input: '',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Should exit cleanly with no output
      assert.equal(result.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0);
    }
  });

  it('exits 0 when no session_id in hookData', () => {
    const result = runHook({ tool_name: 'Task', tool_input: {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), '');
  });

  it('exits 0 when no matching marker file exists', () => {
    const result = runHook({
      tool_name: 'Task',
      tool_input: { description: 'brief generate brief' },
      session_id: 'no-match-session-12345',
    });
    assert.equal(result.exitCode, 0);
  });

  it('exits 0 when invalid JSON stdin', () => {
    try {
      const result = execFileSync(process.execPath, [hookPath], {
        input: 'not-json',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.equal(result.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0);
    }
  });
});
