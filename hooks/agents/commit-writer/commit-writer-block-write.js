#!/usr/bin/env node

/**
 * PreToolUse WHITELIST guard for commit-writer agent.
 *
 * WHITELIST approach: ONLY explicitly allowed commands pass. Everything else is BLOCKED.
 *
 * Allowed Bash commands (per segment after splitting on && || ; | newline):
 *   WRITE: git commit, git push (no --force/-f)
 *   READ:  git diff, git status, git log, git show, git rev-parse, git branch,
 *          git remote, git config, git ls-files, git cat-file, git describe,
 *          git shortlog, git name-rev, git for-each-ref, git tag (list only)
 *   SETUP: grep (package.json / commitlintrc check only), ls (commitlintrc check only)
 *
 * Uses exit codes:
 *   exit 0 = allow
 *   exit 2 = block (stderr message fed back to Claude)
 */

// Allowed git subcommands (read-only) — no mutation, no syncing, no staging
const ALLOWED_GIT_READ = new Set([
  'diff', 'status', 'log', 'show', 'rev-parse', 'branch',
  'remote', 'config', 'ls-files', 'cat-file', 'describe',
  'shortlog', 'name-rev', 'for-each-ref',
]);

function block(msg) {
  process.stderr.write(`COMMIT-WRITER GUARD: ${msg}\n`);
  process.exit(2);
}

function checkSegment(segment) {
  const s = segment.trim();
  if (!s) return; // skip empty segments from splits

  // ── git commands ──────────────────────────────────────────────────────────
  if (/^git\b/.test(s)) {
    const parts = s.split(/\s+/);
    const sub = parts[1]; // git <sub> ...

    if (!sub) block(`Bare 'git' command not allowed. Blocked: ${s.slice(0, 100)}`);

    // git commit — allowed (but not --amend to prevent history rewriting)
    if (sub === 'commit') {
      if (/--amend\b/.test(s)) {
        block(`'git commit --amend' is not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed
    }

    // git push — allowed, but never --force or -f
    if (sub === 'push') {
      if (/--force\b|-f\b/.test(s)) {
        block(`'git push --force' is not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed
    }

    // git tag — only listing (no -d, -a, -m, no creation)
    if (sub === 'tag') {
      if (!/^git\s+tag\s*(-l|--list)?(\s|$)/.test(s)) {
        block(`'git tag' only allowed for listing. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed
    }

    // All other allowed read-only subcommands
    if (ALLOWED_GIT_READ.has(sub)) {
      return; // allowed
    }

    // Everything else (reset, rebase, checkout, fetch, pull, add, rm, stash, merge, etc.) — BLOCKED
    block(`'git ${sub}' is not allowed. commit-writer only does: git commit, git push, and read-only git commands. Blocked: ${s.slice(0, 100)}`);
  }

  // ── grep — only for setup detection (package.json / commitlintrc) ─────────
  if (/^grep\b/.test(s)) {
    if (/package\.json|commitlintrc/.test(s)) {
      return; // allowed
    }
    block(`grep is only allowed for commitlint/cz setup detection. Blocked: ${s.slice(0, 100)}`);
  }

  // ── ls — only for commitlintrc check ─────────────────────────────────────
  if (/^ls\b/.test(s)) {
    if (/commitlintrc/.test(s)) {
      return; // allowed
    }
    block(`ls is only allowed for commitlintrc detection. Blocked: ${s.slice(0, 100)}`);
  }

  // ── echo — only harmless informational output ─────────────────────────────
  if (/^echo\b/.test(s)) {
    return; // allowed
  }

  // ── Everything else is BLOCKED ────────────────────────────────────────────
  block(`Command not in whitelist. commit-writer only runs git commit, git push, and read-only git commands. Blocked: ${s.slice(0, 100)}`);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    block(`Failed to parse hook input: ${err.message}`);
  }

  const toolName = hookData.tool_name || '';

  // Allow read-only tools unconditionally
  if (['Read', 'Grep', 'Glob', 'LS'].includes(toolName)) {
    process.exit(0);
  }

  // Bash — apply whitelist per segment
  if (toolName === 'Bash') {
    const command = (hookData.tool_input?.command || '').trim();
    if (!command) block('Empty command.');

    // Split on all shell separators including newlines
    const segments = command
      .split(/&&|\|\||[;|\n]/)
      .map(s => s.trim())
      .filter(Boolean);

    if (segments.length === 0) block('Empty command after parsing.');

    for (const seg of segments) {
      checkSegment(seg);
    }

    process.exit(0); // all segments passed
  }

  // Everything else (Write, Edit, Task, Skill, MultiEdit, etc.) — BLOCKED
  block(`Tool '${toolName}' is not allowed. commit-writer only uses: Read, Grep, Glob, and whitelisted Bash commands.`);
}

main().catch(err => {
  process.stderr.write(`COMMIT-WRITER GUARD ERROR: ${err.message}\n`);
  process.exit(2);
});
