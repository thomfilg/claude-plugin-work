#!/usr/bin/env node
'use strict';

/**
 * synapsys-lint — static trigger overlap audit (GH-534, Task 3 scaffold).
 *
 * This is the Task-3 scaffold: argv parsing, store discovery, scope filter,
 * disabled/expired skip, JSON envelope, and exit-code wiring. Pair scoring
 * (trigger×trigger, trigger×body, pretool×pretool) and `too-broad-trigger`
 * detection are added by Tasks 4–7.
 *
 * Programmatic entry point:
 *   const { lintStore } = require('./synapsys-lint');
 *   const result = lintStore({ cwd, scope, thresholds, onlyInvolving });
 */

const { setupCli, listMemories } = require('../lib/script-bootstrap');

// Named exit-code constants — single source of truth.
const EXIT_OK = 0;
const EXIT_HIGH_SEVERITY = 1;
const EXIT_INVALID_ARGS = 2;

const VALID_SCOPES = new Set(['project', 'shared', 'all']);

/**
 * Parse argv flags into a normalized options object. Returns `{ error }` when
 * a flag value is invalid so the CLI can exit with code 2.
 */
function parseArgs(flag) {
  const json = !!flag('json');
  const scopeRaw = flag('scope');
  const scope = scopeRaw === undefined || scopeRaw === true ? 'all' : String(scopeRaw);
  if (!VALID_SCOPES.has(scope)) {
    return { error: `invalid --scope=${scope} (expected project|shared|all)` };
  }

  const overlapRaw = flag('overlap-threshold');
  let overlapThreshold = 0.5;
  if (overlapRaw !== undefined && overlapRaw !== true) {
    const n = Number(overlapRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { error: `invalid --overlap-threshold=${overlapRaw} (expected float in [0,1])` };
    }
    overlapThreshold = n;
  }

  const bodyRaw = flag('body-density-threshold');
  let bodyDensityThreshold = 4;
  if (bodyRaw !== undefined && bodyRaw !== true) {
    const n = Number(bodyRaw);
    if (!Number.isInteger(n) || n < 1) {
      return { error: `invalid --body-density-threshold=${bodyRaw} (expected positive integer)` };
    }
    bodyDensityThreshold = n;
  }

  const onlyInvolvingRaw = flag('only-involving');
  const onlyInvolving =
    onlyInvolvingRaw === undefined || onlyInvolvingRaw === true
      ? null
      : String(onlyInvolvingRaw);

  return {
    json,
    scope,
    thresholds: { overlap: overlapThreshold, bodyDensity: bodyDensityThreshold },
    onlyInvolving,
  };
}

/**
 * Apply scope + disabled/expired filtering to the memory list returned by
 * `listMemories(cwd)`.
 */
function filterMemories(memories, scope) {
  return memories.filter((m) => {
    if (m.disabled) return false;
    if (m.expired) return false;
    const kind = m.store && m.store.kind;
    if (scope === 'shared') return kind === 'shared';
    if (scope === 'project') return kind !== 'shared';
    return true; // scope === 'all'
  });
}

/**
 * Programmatic entry point.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {'project'|'shared'|'all'} [opts.scope='all']
 * @param {{overlap?:number,bodyDensity?:number}} [opts.thresholds]
 * @param {string|null} [opts.onlyInvolving]
 * @returns {{
 *   pairs: object[],
 *   broadTriggers: object[],
 *   warnings: object[],
 *   errors: object[],
 *   memories: object[],
 *   exitCode: number
 * }}
 */
function lintStore(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const scope = (opts && opts.scope) || 'all';
  const memories = filterMemories(listMemories(cwd), scope);

  // Scaffold stage: no scoring yet. Tasks 4–7 populate `pairs` and
  // `broadTriggers`. Exit code stays 0 until a `high`-severity pair appears.
  const pairs = [];
  const broadTriggers = [];

  return {
    pairs,
    broadTriggers,
    warnings: [],
    errors: [],
    memories,
    exitCode: EXIT_OK,
  };
}

function formatJson(result) {
  return JSON.stringify({
    warnings: result.warnings,
    errors: result.errors,
    pairs: result.pairs,
    broadTriggers: result.broadTriggers,
  });
}

function formatHuman(result) {
  // Task-3 scaffold stub — Task 8 reimplements with full pair-header layout.
  const lines = [];
  lines.push(`pairs: ${result.pairs.length}`);
  lines.push(`broadTriggers: ${result.broadTriggers.length}`);
  return lines.join('\n');
}

/**
 * Scaffold stubs — real implementations land in Task 4 / Task 8.
 */
function scorePair() {
  return { score: 0, matchedTokens: [] };
}
function classifyPair() {
  return { severity: 'low', intentional: {} };
}

function main() {
  const { flag, cwd } = setupCli();
  const parsed = parseArgs(flag);
  if (parsed.error) {
    process.stderr.write(`synapsys-lint: ${parsed.error}\n`);
    process.exit(EXIT_INVALID_ARGS);
  }

  const result = lintStore({
    cwd,
    scope: parsed.scope,
    thresholds: parsed.thresholds,
    onlyInvolving: parsed.onlyInvolving,
  });

  if (parsed.json) {
    process.stdout.write(`${formatJson(result)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  lintStore,
  scorePair,
  classifyPair,
  formatHuman,
  formatJson,
  parseArgs,
  // Exit-code constants exported for tests / downstream callers.
  EXIT_OK,
  EXIT_HIGH_SEVERITY,
  EXIT_INVALID_ARGS,
};
