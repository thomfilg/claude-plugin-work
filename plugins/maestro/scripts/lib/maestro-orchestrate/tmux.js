/**
 * tmux.js — tmux session helpers.
 *
 * Pure side-effect wrappers around tmux CLI calls. No detection logic.
 */
const { execSync, spawnSync } = require('child_process');

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    return '';
  }
}

function shVoid(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command via argv (no shell) so arguments containing shell metacharacters
 * (backticks, $, \, quotes) cannot trigger command substitution or word-splitting.
 * Returns true on exit code 0, false otherwise.
 */
function spawnVoid(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'ignore' });
  return res.status === 0;
}

/** Run a command via argv and return stdout, or '' on failure. */
function spawnOut(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0 || !res.stdout) return '';
  return res.stdout.toString();
}

/** List sessions matching a regex (default GH-*-work). */
function listSessions(pattern = /^GH-[A-Z0-9-]+-work$/) {
  return sh('tmux ls 2>/dev/null')
    .split('\n')
    .map((l) => l.split(':')[0])
    .filter((name) => pattern.test(name));
}

/** Capture pane (visible + extra scrollback so tall menus aren't truncated). */
function capture(session) {
  return spawnOut('tmux', ['capture-pane', '-t', session, '-p', '-S', '-100']);
}

/**
 * Send a literal string into a session prompt + Enter to submit.
 *
 * Uses spawnSync argv form (no shell) so shell metacharacters in `text`
 * (e.g. backticks, $, \, quotes) — which can flow in from external sources
 * like bot review titles fetched via the GitHub API — cannot trigger
 * command substitution or arbitrary shell execution.
 */
function sendLine(session, text) {
  // End ensures we're at end-of-line so Enter submits instead of inserting newline.
  spawnVoid('tmux', ['send-keys', '-t', session, String(text)]);
  spawnVoid('tmux', ['send-keys', '-t', session, 'End']);
  spawnVoid('tmux', ['send-keys', '-t', session, 'Enter']);
}

/** Send a raw key (Escape, Enter, etc.). */
function sendKey(session, key) {
  spawnVoid('tmux', ['send-keys', '-t', session, String(key)]);
}

/** Ensure a session exists; create it as a no-op holding session if missing. */
function ensureSession(session) {
  if (spawnVoid('tmux', ['has-session', '-t', session])) return;
  // The holding-loop body is a fixed string literal — not user-controlled — so
  // executing it through `sh -c` here is safe. The session name is passed as a
  // separate argv element so it cannot break out of the argument boundary.
  spawnVoid('tmux', [
    'new-session',
    '-d',
    '-s',
    session,
    'while :; do read line; echo "[$(date +%T)] $line"; done',
  ]);
}

module.exports = { listSessions, capture, sendLine, sendKey, ensureSession };
