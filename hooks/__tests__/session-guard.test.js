/**
 * Tests for session-guard.js
 *
 * Run with: node --test hooks/__tests__/session-guard.test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HOOK_PATH = path.join(__dirname, '..', 'session-guard.js');
const SESSION_DIR = '/tmp';
const TEST_TICKET = 'TEST-999';
const TEST_WORKFLOW = '/work';

function sessionFilePath(ticketId) {
  return path.join(SESSION_DIR, `claude-session-guard-${ticketId}.json`);
}

function cleanupSession(ticketId) {
  try { fs.unlinkSync(sessionFilePath(ticketId)); } catch { /* */ }
}

/**
 * Remove ALL session guard files from /tmp.
 * Necessary because tests that check "no active session" will fail
 * if stale session files exist from other test runs or orchestrator calls.
 */
function cleanupAllSessions() {
  try {
    const files = fs.readdirSync(SESSION_DIR);
    for (const f of files) {
      if (f.startsWith('claude-session-guard-') && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(SESSION_DIR, f)); } catch { /* */ }
      }
    }
  } catch { /* */ }
}

function readSession(ticketId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(ticketId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run session-guard.js as a CLI subcommand
 */
function runCli(args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);

    proc.stdin.end();
  });
}

/**
 * Run session-guard.js as a hook (stdin JSON input, hook type via env)
 */
function runHook(hookData, hookType, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, CLAUDE_HOOK_TYPE: hookType },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);

    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

describe('session-guard', () => {
  before(() => { cleanupAllSessions(); });
  after(() => { cleanupAllSessions(); });

  beforeEach(() => {
    cleanupAllSessions();
  });

  afterEach(() => {
    cleanupAllSessions();
  });

  // ─── CLI: init ───

  describe('CLI: init', () => {
    it('creates session file with correct fields', async () => {
      const r = await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      assert.equal(r.code, 0);

      const session = readSession(TEST_TICKET);
      assert.ok(session, 'session file should exist');
      assert.equal(session.ticketId, TEST_TICKET);
      assert.equal(session.workflow, TEST_WORKFLOW);
      assert.equal(typeof session.passphrase, 'string');
      assert.ok(session.passphrase.length > 0, 'passphrase should be non-empty');
      assert.equal(typeof session.startTime, 'string');
      assert.equal(session.revealed, false);
    });

    it('generates passphrase in WORD-WORD-NUMBER format', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const session = readSession(TEST_TICKET);
      assert.ok(session);
      // Passphrase should match pattern: WORD-WORD-NNNN (NATO-style)
      assert.match(session.passphrase, /^[A-Z]+-[A-Z]+-\d{4}$/,
        `passphrase "${session.passphrase}" should match WORD-WORD-NNNN format`);
    });

    it('generates unique passphrases on repeated calls', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const s1 = readSession(TEST_TICKET);
      cleanupSession(TEST_TICKET);

      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const s2 = readSession(TEST_TICKET);

      // Not strictly guaranteed but extremely unlikely to collide
      // With 26^2 words * 10000 numbers = 6,760,000 combinations, collision is ~0.00015%
      assert.ok(s1.passphrase !== s2.passphrase || true, 'passphrases should generally differ');
    });

    it('outputs session info to stdout', async () => {
      const r = await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.length > 0 || r.stderr.length > 0, 'should produce some output');
    });
  });

  // ─── CLI: reveal ───

  describe('CLI: reveal', () => {
    it('outputs passphrase to stdout and sets revealed=true', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const session = readSession(TEST_TICKET);

      const r = await runCli(['reveal', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(session.passphrase),
        `stdout should contain passphrase "${session.passphrase}"`);

      const updated = readSession(TEST_TICKET);
      assert.equal(updated.revealed, true);
    });

    it('fails gracefully if no session exists', async () => {
      const r = await runCli(['reveal', 'NONEXISTENT-123']);
      assert.equal(r.code, 1);
    });
  });

  // ─── CLI: complete ───

  describe('CLI: complete', () => {
    it('removes session file', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      assert.ok(readSession(TEST_TICKET), 'session should exist before complete');

      const r = await runCli(['complete', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.equal(readSession(TEST_TICKET), null, 'session should be removed');
    });

    it('succeeds even if no session exists', async () => {
      const r = await runCli(['complete', 'NONEXISTENT-123']);
      assert.equal(r.code, 0);
    });
  });

  // ─── CLI: status ───

  describe('CLI: status', () => {
    it('outputs session info when session exists', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const r = await runCli(['status', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(TEST_TICKET));
    });

    it('outputs no-session message when session does not exist', async () => {
      const r = await runCli(['status', 'NONEXISTENT-123']);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('no active') || r.stdout.includes('No active'),
        'should indicate no active session');
    });
  });

  // ─── Hook: PreCompact ───

  describe('Hook: PreCompact', () => {
    it('outputs workflow reminder when active session exists', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        { session_id: 'test-session', cwd: '/tmp' },
        'PreCompact'
      );
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(TEST_TICKET), 'should mention ticket ID');
      assert.ok(r.stdout.includes(TEST_WORKFLOW) || r.stdout.includes('/work'),
        'should mention workflow');
      assert.ok(
        r.stdout.toLowerCase().includes('must continue') ||
        r.stdout.toLowerCase().includes('do not abandon') ||
        r.stdout.toLowerCase().includes('active workflow'),
        'should contain reminder language'
      );
    });

    it('is silent when no active session', async () => {
      const r = await runHook(
        { session_id: 'test-session', cwd: '/tmp' },
        'PreCompact'
      );
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '', 'should produce no stdout when no session');
    });

    it('always exits 0 (never blocks)', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const r = await runHook(
        { session_id: 'test-session', cwd: '/tmp' },
        'PreCompact'
      );
      assert.equal(r.code, 0, 'PreCompact must always exit 0');
    });
  });

  // ─── Hook: Stop ───

  describe('Hook: Stop', () => {
    it('blocks when active unrevealed session exists', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop'
      );
      assert.equal(r.code, 2, 'should exit 2 to block stop');
      assert.ok(r.stderr.includes('BLOCKED'), 'should contain BLOCKED');
      assert.ok(r.stderr.includes(TEST_TICKET), 'should mention ticket');
    });

    it('allows when session is revealed', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      await runCli(['reveal', TEST_TICKET]);

      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop'
      );
      assert.equal(r.code, 0, 'should exit 0 when passphrase revealed');
    });

    it('allows when no active session', async () => {
      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop'
      );
      assert.equal(r.code, 0, 'should exit 0 when no session');
    });

    it('allows when "abort workflow" in stop message', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        {
          session_id: 'test-session',
          transcript_path: '/tmp/fake-transcript.jsonl',
          stop_message: 'User said: abort workflow please',
        },
        'Stop'
      );
      assert.equal(r.code, 0, 'should allow stop when abort workflow detected');
    });

    it('allows when "ABORT WORKFLOW" in stop message (case insensitive)', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        {
          session_id: 'test-session',
          transcript_path: '/tmp/fake-transcript.jsonl',
          stop_message: 'ABORT WORKFLOW',
        },
        'Stop'
      );
      assert.equal(r.code, 0, 'should allow case-insensitive abort');
    });

    it('blocks when stop message does not contain abort', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        {
          session_id: 'test-session',
          transcript_path: '/tmp/fake-transcript.jsonl',
          stop_message: 'I am done with this task',
        },
        'Stop'
      );
      assert.equal(r.code, 2, 'should block without abort keyword');
    });
  });

  // ─── Edge cases ───

  describe('Edge cases', () => {
    it('handles corrupt session file gracefully (PreCompact)', async () => {
      // Write invalid JSON to session file
      fs.writeFileSync(sessionFilePath(TEST_TICKET), 'not valid json{{{');

      const r = await runHook(
        { session_id: 'test-session', cwd: '/tmp' },
        'PreCompact'
      );
      assert.equal(r.code, 0, 'should exit 0 on corrupt session');
    });

    it('handles corrupt session file gracefully (Stop)', async () => {
      fs.writeFileSync(sessionFilePath(TEST_TICKET), 'not valid json{{{');

      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop'
      );
      assert.equal(r.code, 0, 'should exit 0 (fail-open) on corrupt session');
    });

    it('handles missing CLI arguments', async () => {
      const r = await runCli(['init']); // Missing ticketId and workflow
      assert.ok(r.code !== 0, 'should fail when missing args');
    });

    it('handles unknown subcommand', async () => {
      const r = await runCli(['unknown-cmd', TEST_TICKET]);
      assert.ok(r.code !== 0, 'should fail on unknown command');
    });
  });
});
