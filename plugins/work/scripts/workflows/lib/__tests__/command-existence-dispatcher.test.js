'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Deferred require — module may not exist yet in RED. We probe behaviorally so
// the failure surface is a wrong/missing answer, not a load error.
const MODULE_PATH = path.join(__dirname, '..', 'command-existence-dispatcher.js');

function loadModule() {
  if (!fs.existsSync(MODULE_PATH)) {
    return {
      __missing: true,
      dispatch: () => ({ ok: false, errors: ['__module_missing__'] }),
    };
  }
  // Clear require cache so per-test fs setup is picked up by any internal memo.
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function baseCtx(worktree, overrides = {}) {
  return {
    worktree,
    packageJson: overrides.packageJson || null,
    envrc: overrides.envrc || null,
    taskHeading: overrides.taskHeading || 'Task 7 — example',
  };
}

describe('lib/command-existence-dispatcher.js — dispatch()', () => {
  it('pnpm-script-hit: pnpm <script-that-exists> returns ok:true with no errors', () => {
    const root = mkdtemp('cmd-disp-pnpm-hit-');
    try {
      writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'node --test' } }),
      );
      const { dispatch } = loadModule();
      const result = dispatch('pnpm test', baseCtx(root));
      assert.equal(result.ok, true, `expected ok:true, got errors=${JSON.stringify(result.errors)}`);
      assert.deepEqual(result.errors, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('pnpm-script-miss-with-suggestions (AC14 part 1): missing script returns Levenshtein top-3', () => {
    const root = mkdtemp('cmd-disp-pnpm-miss-');
    try {
      writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          scripts: {
            'dev:typecheck': 'tsc --noEmit',
            'dev:test': 'vitest',
            'dev:check': 'biome check',
            build: 'tsc -p .',
            lint: 'biome lint',
          },
        }),
      );
      const { dispatch } = loadModule();
      // Typo: dev:typcheck (missing 'e')
      const result = dispatch('pnpm dev:typcheck', baseCtx(root));
      assert.equal(result.ok, false);
      assert.equal(result.errors.length, 1, `expected exactly 1 error, got ${JSON.stringify(result.errors)}`);
      const msg = result.errors[0];
      assert.match(msg, /dev:typcheck/, 'error names the missing script');
      assert.match(msg, /dev:typecheck/, 'error suggests dev:typecheck (top-1)');
      assert.match(msg, /Task 7/, 'error prefixed with task heading (P1.3)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('node-file-hit: `node path/to/file.js` for existing file returns ok:true', () => {
    const root = mkdtemp('cmd-disp-nodehit-');
    try {
      writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
      writeFile(path.join(root, 'scripts', 'run.js'), '// noop\n');
      const { dispatch } = loadModule();
      const result = dispatch('node scripts/run.js', baseCtx(root));
      assert.equal(result.ok, true, `expected ok:true, errors=${JSON.stringify(result.errors)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('node-file-miss: `node missing.js` returns error naming the missing file', () => {
    const root = mkdtemp('cmd-disp-nodemiss-');
    try {
      writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
      const { dispatch } = loadModule();
      const result = dispatch('node scripts/does-not-exist.js', baseCtx(root));
      assert.equal(result.ok, false);
      assert.ok(result.errors.length >= 1);
      assert.match(result.errors[0], /does-not-exist\.js/);
      assert.match(result.errors[0], /Task 7/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bare-binary-hit: a bare binary on PATH (node) resolves via command -v', () => {
    const root = mkdtemp('cmd-disp-bare-hit-');
    try {
      writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
      const { dispatch } = loadModule();
      // `node` is guaranteed available in this test runner.
      const result = dispatch('node --version', baseCtx(root));
      assert.equal(result.ok, true, `errors=${JSON.stringify(result.errors)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bare-binary-miss-no-dep: unknown binary not on PATH and not in manifest deps fails', () => {
    const root = mkdtemp('cmd-disp-bare-miss-');
    try {
      writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {}, dependencies: {}, devDependencies: {} }));
      const { dispatch } = loadModule();
      const result = dispatch('definitely-not-a-real-binary-xyz123 --flag', baseCtx(root));
      assert.equal(result.ok, false);
      assert.match(result.errors[0], /definitely-not-a-real-binary-xyz123/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('$VAR-resolve-recursive: `eval "$TEST_UNIT_COMMAND"` resolves via .envrc and redispatches', () => {
    const root = mkdtemp('cmd-disp-var-');
    try {
      writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      writeFile(path.join(root, '.envrc'), 'export TEST_UNIT_COMMAND="pnpm test"\n');
      const { dispatch } = loadModule();
      const result = dispatch('eval "$TEST_UNIT_COMMAND"', baseCtx(root));
      assert.equal(result.ok, true, `expected ok:true, errors=${JSON.stringify(result.errors)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('empty-body (AC8): empty / whitespace-only command body is rejected', () => {
    const root = mkdtemp('cmd-disp-empty-');
    try {
      writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
      const { dispatch } = loadModule();
      const result = dispatch('   ', baseCtx(root));
      assert.equal(result.ok, false);
      assert.ok(result.errors.length >= 1, 'must emit at least one error');
      assert.match(result.errors[0], /empty/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC14 two-errors case: `pnpm dev:typecheck && grep -q foo bar.ts` produces exactly the two AC14 errors', () => {
    const root = mkdtemp('cmd-disp-ac14-');
    try {
      writeFile(
        path.join(root, 'package.json'),
        // No dev:typecheck script. grep is a bare binary (resolved via command -v).
        // bar.ts is missing on disk too — but AC14 only requires the pnpm-script
        // error and the grep-resolution / file-target dual; the canonical AC14
        // case is two errors collected (no short-circuit).
        JSON.stringify({ scripts: { test: 'node --test' } }),
      );
      writeFile(path.join(root, 'bar.ts'), '// exists so grep target check is not the failure\n');
      const { dispatch } = loadModule();
      const result = dispatch('pnpm dev:typecheck && grep -q foo bar.ts', baseCtx(root));
      assert.equal(result.ok, false);
      // AC9: collected failures, no short-circuit. The dev:typecheck miss must
      // be present even though it is the FIRST segment. AC14 wording: "produces
      // two errors".
      assert.equal(
        result.errors.length,
        2,
        `AC14 requires exactly two errors; got ${result.errors.length}: ${JSON.stringify(result.errors)}`,
      );
      const joined = result.errors.join('\n');
      assert.match(joined, /dev:typecheck/, 'first error names missing dev:typecheck script');
      // Second error: grep resolved via command -v but bar.ts dispatched? Per
      // AC14 the second error confirms grep resolved; for safety the test just
      // checks the second segment surfaced as an error string.
      assert.match(joined, /grep/, 'second error mentions grep segment');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
