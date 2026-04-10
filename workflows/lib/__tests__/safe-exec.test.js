/**
 * Tests for lib/safe-exec.js — safeExec shell-injection-safe command execution
 *
 * Run: node --test lib/__tests__/safe-exec.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { safeExec } = require('../safe-exec');

// ─── Basic execution ────────────────────────────────────────────────────────

describe('safeExec — basic execution', () => {
  it('runs a command and returns trimmed stdout', () => {
    const result = safeExec('echo', ['hello world']);
    assert.equal(result, 'hello world');
  });

  it('passes arguments correctly as separate array elements', () => {
    // printf with format + arg proves args are passed individually
    const result = safeExec('printf', ['%s-%s', 'foo', 'bar']);
    assert.equal(result, 'foo-bar');
  });

  it('handles commands with no arguments', () => {
    const result = safeExec('true');
    assert.equal(result, '');
  });
});

// ─── Defaults ───────────────────────────────────────────────────────────────

describe('safeExec — defaults', () => {
  it('defaults encoding to utf-8 (returns string, not Buffer)', () => {
    const result = safeExec('echo', ['utf8-test']);
    assert.equal(typeof result, 'string');
    assert.equal(result, 'utf8-test');
  });

  it('applies default timeout of 15000ms', () => {
    // We cannot easily assert the internal timeout value directly,
    // but we can verify a fast command succeeds (does not hang)
    const result = safeExec('echo', ['fast']);
    assert.equal(result, 'fast');
  });
});

// ─── Error / fallback handling ──────────────────────────────────────────────

describe('safeExec — error handling', () => {
  it('returns empty string on error by default', () => {
    const result = safeExec('false');
    assert.equal(result, '');
  });

  it('returns custom fallback value on error', () => {
    const result = safeExec('false', [], { fallback: 'N/A' });
    assert.equal(result, 'N/A');
  });

  it('returns fallback when command does not exist', () => {
    const result = safeExec('__nonexistent_command_abc123__', [], { fallback: 'missing' });
    assert.equal(result, 'missing');
  });
});

// ─── stderr suppression ─────────────────────────────────────────────────────

describe('safeExec — stderr suppression', () => {
  it('does not leak stderr to parent process', () => {
    // sh -c is used here solely to produce stderr; safeExec still uses execFileSync
    // We call a command that writes to stderr but succeeds
    const result = safeExec('sh', ['-c', 'echo ok >&1; echo err >&2']);
    assert.equal(result, 'ok');
  });
});

// ─── Shell injection safety ────────────────────────────────────────────────

describe('safeExec — shell injection safety', () => {
  it('treats shell metacharacters in args as literal strings', () => {
    const result = safeExec('printf', ['%s', '; echo injected']);
    assert.equal(result, '; echo injected');
  });
});

// ─── Custom options passthrough ─────────────────────────────────────────────

describe('safeExec — custom options', () => {
  it('accepts custom timeout via opts', () => {
    // A short timeout that still allows a fast command to succeed
    const result = safeExec('echo', ['quick'], { timeout: 5000 });
    assert.equal(result, 'quick');
  });

  it('accepts cwd via opts', () => {
    const result = safeExec('pwd', [], { cwd: '/tmp' });
    assert.equal(result, '/tmp');
  });

  it('returns fallback when command times out', () => {
    const result = safeExec('sleep', ['10'], { timeout: 1, fallback: 'timed-out' });
    assert.equal(result, 'timed-out');
  });
});
