const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');

// Save original env
const originalEnv = { ...process.env };

// Keys set by config.js that we need to clean between tests
const CONFIG_KEYS = [
  'JIRA_PROJECT_KEY', 'JIRA_BASE_URL', 'JIRA_ASSIGNEE_EMAIL',
  'TICKET_PROVIDER', 'TICKET_PROJECT_KEY',
  'REPO_NAME', 'GITHUB_ORG', 'WORKTREES_BASE', 'TASKS_BASE',
  'FOLLOW_UP_PR_POLL_REVIEWS', 'BASE_BRANCH', 'WEB_APPS',
];

function resetEnv() {
  for (const key of CONFIG_KEYS) delete process.env[key];
}

function freshRequire(mod) {
  const resolved = require.resolve(mod);
  delete require.cache[resolved];
  // Also clear ticket-provider cache since config imports it
  try { delete require.cache[require.resolve('../ticket-provider')]; } catch { /* */ }
  return require(mod);
}

describe('config', () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    Object.assign(process.env, originalEnv);
  });

  // ─── WEB_APPS parsing ───────────────────────────────────────────────────

  describe('WEB_APPS parsing', () => {
    it('parses valid JSON array', () => {
      process.env.WEB_APPS = JSON.stringify([
        { name: 'app-a', defaultPort: 3000, type: 'vite' },
        { name: 'app-b', defaultPort: 4000, type: 'remix' },
      ]);
      const config = freshRequire('../config');
      assert.equal(config.WEB_APPS.length, 2);
      assert.equal(config.WEB_APPS[0].name, 'app-a');
      assert.equal(config.WEB_APPS[1].defaultPort, 4000);
    });

    it('returns empty array for invalid JSON', () => {
      process.env.WEB_APPS = 'not-json{{{';
      const config = freshRequire('../config');
      assert.deepEqual(config.WEB_APPS, []);
    });

    it('returns empty array for non-array JSON', () => {
      process.env.WEB_APPS = '{"name":"oops"}';
      const config = freshRequire('../config');
      assert.deepEqual(config.WEB_APPS, []);
    });

    it('returns empty array when WEB_APPS is unset', () => {
      const config = freshRequire('../config');
      assert.deepEqual(config.WEB_APPS, []);
    });
  });

  // ─── webAppNames ────────────────────────────────────────────────────────

  describe('webAppNames', () => {
    it('returns names from valid entries', () => {
      process.env.WEB_APPS = JSON.stringify([
        { name: 'app-a', defaultPort: 3000, type: 'vite' },
        { name: 'app-b', defaultPort: 4000, type: 'remix' },
      ]);
      const config = freshRequire('../config');
      assert.deepEqual(config.webAppNames(), ['app-a', 'app-b']);
    });

    it('skips entries without name', () => {
      process.env.WEB_APPS = JSON.stringify([
        { name: 'good', defaultPort: 3000, type: 'vite' },
        { defaultPort: 4000, type: 'remix' },
        null,
        { name: '', defaultPort: 5000, type: 'vite' },
      ]);
      const config = freshRequire('../config');
      assert.deepEqual(config.webAppNames(), ['good']);
    });

    it('returns empty array when no apps configured', () => {
      const config = freshRequire('../config');
      assert.deepEqual(config.webAppNames(), []);
    });
  });

  // ─── webAppsMap ─────────────────────────────────────────────────────────

  describe('webAppsMap', () => {
    it('builds map from valid entries', () => {
      process.env.WEB_APPS = JSON.stringify([
        { name: 'app-a', defaultPort: 3000, type: 'vite' },
      ]);
      const config = freshRequire('../config');
      const map = config.webAppsMap();
      assert.deepEqual(map['app-a'], { defaultPort: 3000, type: 'vite' });
    });

    it('skips malformed entries (null, missing name)', () => {
      process.env.WEB_APPS = JSON.stringify([
        null,
        { defaultPort: 3000 },
        { name: 'valid', defaultPort: 5000, type: 'remix' },
      ]);
      const config = freshRequire('../config');
      const map = config.webAppsMap();
      assert.equal(Object.keys(map).length, 1);
      assert.deepEqual(map['valid'], { defaultPort: 5000, type: 'remix' });
    });

    it('returns prototype-free object', () => {
      const config = freshRequire('../config');
      const map = config.webAppsMap();
      assert.equal(Object.getPrototypeOf(map), null);
    });
  });

  // ─── getBaseBranch ──────────────────────────────────────────────────────

  describe('getBaseBranch', () => {
    // We test the logic in a real git repo (the current repo)
    // These tests verify sanitization and fallback logic

    it('returns a string starting with origin/', () => {
      const config = freshRequire('../config');
      const branch = config.getBaseBranch();
      assert.ok(branch.startsWith('origin/'), `Expected origin/ prefix, got: ${branch}`);
    });

    it('accepts cwd option', () => {
      const config = freshRequire('../config');
      // Use current directory — should not throw
      const branch = config.getBaseBranch({ cwd: process.cwd() });
      assert.ok(typeof branch === 'string');
    });

    it('sanitizes BASE_BRANCH by stripping refs/remotes/ prefix', () => {
      process.env.BASE_BRANCH = 'refs/remotes/origin/main';
      const config = freshRequire('../config');
      const branch = config.getBaseBranch();
      // Should strip to 'main' then reconstruct as 'origin/main'
      assert.ok(!branch.includes('refs/remotes/'), `Should strip refs/remotes/, got: ${branch}`);
    });

    it('sanitizes BASE_BRANCH by stripping origin/ prefix', () => {
      process.env.BASE_BRANCH = 'origin/main';
      const config = freshRequire('../config');
      const branch = config.getBaseBranch();
      // Should not result in origin/origin/main
      assert.ok(!branch.includes('origin/origin/'), `Double origin/ prefix, got: ${branch}`);
    });

    it('strips special characters from BASE_BRANCH', () => {
      process.env.BASE_BRANCH = 'main; rm -rf /';
      const config = freshRequire('../config');
      const branch = config.getBaseBranch();
      // Sanitization removes semicolon, spaces, etc.
      assert.ok(!branch.includes(';'), `Should strip semicolons, got: ${branch}`);
      assert.ok(!branch.includes(' '), `Should strip spaces, got: ${branch}`);
    });

    it('rejects revspec operators (..)', () => {
      process.env.BASE_BRANCH = 'main..HEAD';
      const config = freshRequire('../config');
      const branch = config.getBaseBranch();
      // '..' should be collapsed — the sanitized value won't match a real ref
      // so it falls through to auto-detection
      assert.ok(!branch.includes('..'), `Should reject revspec, got: ${branch}`);
    });

    it('falls through when BASE_BRANCH ref does not exist', () => {
      process.env.BASE_BRANCH = 'nonexistent-branch-xyz-999';
      const config = freshRequire('../config');
      const branch = config.getBaseBranch();
      // Should fall through to detection, not return origin/nonexistent-branch-xyz-999
      assert.notEqual(branch, 'origin/nonexistent-branch-xyz-999');
    });

    it('returns fallback origin/main when nothing else works', () => {
      // Use a non-git directory to ensure all git commands fail
      const config = freshRequire('../config');
      const branch = config.getBaseBranch({ cwd: '/tmp' });
      assert.equal(branch, 'origin/main');
    });
  });

  // ─── prefixTicketId ─────────────────────────────────────────────────────

  describe('prefixTicketId', () => {
    it('prefixes numeric input with TICKET_PROJECT_KEY', () => {
      process.env.TICKET_PROJECT_KEY = 'MYPROJ';
      const config = freshRequire('../config');
      assert.equal(config.prefixTicketId('123'), 'MYPROJ-123');
    });

    it('uppercases non-numeric input', () => {
      const config = freshRequire('../config');
      assert.equal(config.prefixTicketId('proj-456'), 'PROJ-456');
    });
  });

  // ─── Path helpers ───────────────────────────────────────────────────────

  describe('path helpers', () => {
    it('worktreeDir uses REPO_NAME and ticket', () => {
      process.env.REPO_NAME = 'test-repo';
      process.env.WORKTREES_BASE = '/tmp/wt';
      const config = freshRequire('../config');
      assert.equal(config.worktreeDir('PROJ-1'), '/tmp/wt/test-repo-PROJ-1');
    });

    it('tasksDir uses TASKS_BASE', () => {
      process.env.TASKS_BASE = '/tmp/tasks';
      const config = freshRequire('../config');
      assert.equal(config.tasksDir('PROJ-1'), '/tmp/tasks/PROJ-1');
    });

    it('repoDir uses WORKTREES_BASE and REPO_NAME', () => {
      process.env.WORKTREES_BASE = '/tmp/wt';
      process.env.REPO_NAME = 'my-repo';
      const config = freshRequire('../config');
      assert.equal(config.repoDir(), '/tmp/wt/my-repo');
    });
  });
});
