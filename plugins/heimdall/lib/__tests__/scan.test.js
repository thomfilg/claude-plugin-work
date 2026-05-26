// Tests for the install-time scan: catalog → existing-path suggestions.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/scan.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCAN = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-scan.js');
const INIT = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-init.js');
const PROTECT = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-protect.js');

let repo;

function scanJson(kind) {
  const out = execFileSync('node', [SCAN, `--kind=${kind}`, `--cwd=${repo}`, '--json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

before(() => {
  // Real (non-temp) repo so the guard's temp-path exemption is irrelevant and
  // existence checks are meaningful.
  // Under os.tmpdir() (not the dev tree) so the worktree ancestor-walk can't
  // discover an ambient real store and dedupe suggestions away. Scan doesn't
  // use the guard's temp-path exemption, so tmpdir is safe here.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-scan-it-'));
  // Real git repo so getRepoRoot() resolves to THIS dir, not the outer repo
  // (an empty .git dir would let `git rev-parse` walk up to the real repo).
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.mkdirSync(path.join(repo, '.github'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  // NOTE: packages/ui intentionally absent.
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('heimdall-scan', () => {
  it('suggests only existing repo paths for a local install', () => {
    const ids = scanJson('local')
      .map((s) => s.id)
      .sort();
    assert.deepEqual(ids, ['claude-config', 'github-dir', 'root-package-json']);
  });

  it('does not suggest packages/ui because it does not exist', () => {
    assert.ok(!scanJson('local').some((s) => s.id === 'packages-ui'));
  });

  it('never suggests the home-anchored ~/.claude for a local install', () => {
    const cc = scanJson('local').find((s) => s.id === 'claude-config');
    assert.deepEqual(cc.protect, ['.claude'], 'only the repo .claude, not ~/.claude');
  });

  it('carries allowedPaths/trustedSubdirs on the claude-config suggestion', () => {
    const cc = scanJson('local').find((s) => s.id === 'claude-config');
    assert.ok(cc.allowedPaths.includes('plans'));
    assert.ok(cc.trustedSubdirs.includes('hooks'));
  });

  it('drops suggestions already covered by an existing lock', () => {
    execFileSync('node', [INIT, '--kind=local', `--cwd=${repo}`], { encoding: 'utf8' });
    execFileSync(
      'node',
      [PROTECT, '--kind=local', `--cwd=${repo}`, '--phrase=edit .github', '--paths=.github'],
      { encoding: 'utf8' }
    );
    assert.ok(
      !scanJson('local').some((s) => s.id === 'github-dir'),
      '.github now protected → not re-suggested'
    );
  });
});
