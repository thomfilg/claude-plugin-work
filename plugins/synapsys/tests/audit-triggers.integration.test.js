'use strict';

/**
 * Integration tests for `scripts/synapsys-lint.js` (GH-534).
 *
 * Task 3 scope (RED phase): scaffold binary + argv parsing + scope filtering.
 * Only the following Task-3 scenarios are exercised here:
 *   - "--scope=shared narrows discovery to the shared tier"  (AC-G8)
 *   - "Disabled and expired memories are skipped"            (AC-G9)
 *
 * Tasks 4–8 add the remaining scenarios.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'synapsys-lint.js');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'store-overlap');
const PROJ_CWD = path.join(FIXTURE_ROOT, 'proj');
const FAKE_HOME = path.join(FIXTURE_ROOT, 'home');

function runLint(args, opts) {
  const env = Object.assign(
    {},
    process.env,
    { HOME: FAKE_HOME, NO_COLOR: '1' },
    (opts && opts.env) || {}
  );
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
}

test('--scope=shared narrows discovery to the shared tier', () => {
  // With --scope=shared, the project tier overlap pair (mem-active-a vs mem-active-b)
  // must NOT be considered — only the shared-tier memory is visible.
  // At Task-3 scaffold stage `pairs` is empty regardless; we additionally assert
  // the JSON envelope shape and exit code 0.
  const r = runLint([`--cwd=${PROJ_CWD}`, '--scope=shared', '--json']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.ok(env, `stdout was not parseable JSON:\n${r.stdout}`);
  for (const key of ['warnings', 'errors', 'pairs', 'broadTriggers']) {
    assert.ok(key in env, `envelope missing key '${key}': ${JSON.stringify(env)}`);
    assert.ok(Array.isArray(env[key]), `envelope.${key} must be an array`);
  }
  // Scaffold stage: pair arrays are empty (filled by Tasks 4–7).
  assert.equal(env.pairs.length, 0, 'scaffold-stage pairs must be empty');
  assert.equal(env.broadTriggers.length, 0, 'scaffold-stage broadTriggers must be empty');

  // Cross-check: --scope=project against the same fixture must observe the
  // project-tier memories (so the scope filter is actually distinguishing tiers).
  // We verify by asking for them via the programmatic `lintStore` entry point.
  const { lintStore } = require(CLI);
  const sharedResult = lintStore({ cwd: PROJ_CWD, scope: 'shared' });
  const projectResult = lintStore({ cwd: PROJ_CWD, scope: 'project' });
  assert.ok(
    sharedResult.memories.length < projectResult.memories.length,
    `scope=shared (${sharedResult.memories.length}) must see fewer memories than scope=project (${projectResult.memories.length})`
  );
  for (const m of sharedResult.memories) {
    assert.equal(m.store.kind, 'shared', `scope=shared yielded non-shared memory ${m.name}`);
  }
  for (const m of projectResult.memories) {
    assert.notEqual(m.store.kind, 'shared', `scope=project yielded shared memory ${m.name}`);
  }
});

test('Disabled and expired memories are skipped', () => {
  const { lintStore } = require(CLI);
  // scope=all so we capture project + shared.
  const result = lintStore({ cwd: PROJ_CWD, scope: 'all' });
  const names = result.memories.map((m) => m.name);
  assert.ok(names.includes('mem-active-a'), `active memory should be present, got ${names.join(',')}`);
  assert.ok(names.includes('mem-active-b'), `active memory should be present, got ${names.join(',')}`);
  assert.ok(!names.includes('mem-disabled'), `disabled memory must be skipped, got ${names.join(',')}`);
  assert.ok(!names.includes('mem-expired'), `expired memory must be skipped, got ${names.join(',')}`);

  // Exit code at scaffold stage is 0 (no high pairs yet).
  const r = runLint([`--cwd=${PROJ_CWD}`, '--scope=all', '--json']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.ok(env, 'JSON envelope must parse');
  assert.deepEqual(env.pairs, [], 'scaffold-stage pairs empty');
  assert.deepEqual(env.broadTriggers, [], 'scaffold-stage broadTriggers empty');
});
