'use strict';

/**
 * lib/test-strategy.js — GH-590
 *
 * - `KINDS` enum (AC1)
 * - `synthesizeCommand(strategy, envrc)` (AC2)
 * - `validatePeerCitation(strategy, allTasks, citingTask)` (AC11)
 *
 * Pure module; no side effects. `validatePeerCitation` consumes
 * `fileMatchesScope` from the existing `task-scope-globs.js` helper.
 */

const { fileMatchesScope } = require('./task-scope-globs');

const KINDS = Object.freeze({
  UNIT: 'unit',
  INTEGRATION: 'integration',
  E2E: 'e2e',
  VERIFIED_BY: 'verified-by',
  WIRING_CITATION: 'wiring-citation',
  CUSTOM: 'custom',
});

const ENVELOPE_VAR_BY_KIND = Object.freeze({
  [KINDS.UNIT]: 'TEST_UNIT_COMMAND',
  [KINDS.INTEGRATION]: 'TEST_INTEGRATION_COMMAND',
  [KINDS.E2E]: 'TEST_E2E_COMMAND',
});

/**
 * Look up the envelope shell command for a given kind from the parsed
 * `.envrc` vars bag. Returns the verbatim command string or `null`
 * when unset.
 */
function resolveEnvelope(envrc, kind) {
  const varName = ENVELOPE_VAR_BY_KIND[kind];
  if (!varName) return null;
  const vars = (envrc && envrc.vars) || {};
  const value = vars[varName];
  return typeof value === 'string' && value.length > 0 ? { varName, value } : null;
}

/**
 * Synthesise the runnable test command for a Test Strategy block.
 *
 * - `unit` / `integration`: returns the envelope string with
 *   `CHANGED_FILES="<entry>"` prefixed when the corresponding env var is
 *   set, else `pnpm test <entry>` as the pre-envelope fallback.
 * - `verified-by` / `wiring-citation`: returns `null` — no command to run
 *   (the citing task piggybacks on a peer's tests).
 * - `custom`: returns `strategy.command` (preferred) or `strategy.customBody`
 *   (legacy fenced-bash body) verbatim.
 */
function synthesizeCommand(strategy, envrc) {
  if (!strategy || typeof strategy !== 'object') return null;
  const { kind } = strategy;

  if (kind === KINDS.VERIFIED_BY || kind === KINDS.WIRING_CITATION) {
    return null;
  }

  if (kind === KINDS.CUSTOM) {
    if (typeof strategy.command === 'string' && strategy.command.length > 0) {
      return strategy.command;
    }
    return typeof strategy.customBody === 'string' ? strategy.customBody : null;
  }

  if (kind === KINDS.UNIT || kind === KINDS.INTEGRATION || kind === KINDS.E2E) {
    const entry = strategy.entry;
    if (typeof entry !== 'string' || entry.length === 0) return null;

    const envelope = resolveEnvelope(envrc, kind);
    if (envelope) {
      return `CHANGED_FILES="${entry}" eval "$${envelope.varName}"`;
    }
    return `pnpm test ${entry}`;
  }

  return null;
}

/**
 * Decide whether the peer's `entry` transitively references any path in
 * the citing task's scope. Direct glob match wins; otherwise we strip
 * the `.test.` / `.spec.` infix and `__tests__/` segment to derive the
 * implied source path that the test exercises and match that against
 * scope.
 */
function entryReferencesScope(entry, scopeGlobs) {
  if (typeof entry !== 'string' || !Array.isArray(scopeGlobs)) return false;
  if (fileMatchesScope(entry, scopeGlobs)) return true;

  const candidates = new Set();
  // Strip `.test.` / `.spec.` infix → `foo.test.js` becomes `foo.js`.
  const stripped = entry.replace(/\.(?:test|spec)(\.[a-zA-Z0-9]+)$/, '$1');
  if (stripped !== entry) candidates.add(stripped);

  // Strip `__tests__/` segment → `lib/__tests__/foo.js` becomes `lib/foo.js`.
  const noTestsDir = stripped.replace(/(^|\/)__tests__\//, '$1');
  if (noTestsDir !== stripped) candidates.add(noTestsDir);

  for (const c of candidates) {
    if (fileMatchesScope(c, scopeGlobs)) return true;
  }
  return false;
}

/**
 * True when every path in `citingScope` is matched by at least one glob in
 * `peerScope`. This is the wiring-citation contract: the citing task's
 * surface is fully owned (and therefore tested) by the peer.
 */
function peerScopeCoversCitingScope(peerScope, citingScope) {
  if (!Array.isArray(peerScope) || !Array.isArray(citingScope)) return false;
  if (citingScope.length === 0) return false;
  for (const path of citingScope) {
    if (typeof path !== 'string' || !fileMatchesScope(path, peerScope)) return false;
  }
  return true;
}

function findTaskByHeading(allTasks, heading) {
  if (!Array.isArray(allTasks) || typeof heading !== 'string') return null;
  const numMatch = heading.match(/^Task\s+(\d+)\b/);
  const wantNum = numMatch ? Number(numMatch[1]) : null;
  for (const t of allTasks) {
    if (!t) continue;
    if (t.heading === heading) return t;
    if (wantNum !== null && t.num === wantNum) return t;
  }
  return null;
}

/**
 * Validate a `verified-by` / `wiring-citation` peer pointer:
 *   (a) the peer exists in `allTasks`,
 *   (b) the peer's strategy kind is `unit` or `integration`,
 *   (c) the peer's `entry` path matches at least one glob in the citing
 *       task's `### Files in scope` (via `fileMatchesScope`).
 *
 * Returns `string[]` of error messages — empty array means valid.
 */
function validatePeerCitation(strategy, allTasks, citingTask) {
  const errors = [];
  if (!strategy || typeof strategy !== 'object') return errors;

  const { kind } = strategy;
  const peer = strategy.peer || strategy.verifiedBy;
  if (kind !== KINDS.VERIFIED_BY && kind !== KINDS.WIRING_CITATION) {
    return errors;
  }

  const citingHeading =
    (citingTask &&
      (citingTask.heading || (citingTask.num != null ? `Task ${citingTask.num}` : null))) ||
    '<unknown task>';

  if (typeof peer !== 'string' || peer.length === 0) {
    errors.push(`${citingHeading}: Test Strategy kind=${kind} is missing the peer field`);
    return errors;
  }

  const peerTask = findTaskByHeading(allTasks, peer);
  if (!peerTask) {
    errors.push(`${citingHeading}: Test Strategy peer "${peer}" not found in tasks.md`);
    return errors;
  }

  const peerStrategy = peerTask.testStrategy || peerTask.strategy || {};
  if (peerStrategy.kind !== KINDS.UNIT && peerStrategy.kind !== KINDS.INTEGRATION) {
    errors.push(
      `${citingHeading}: Test Strategy peer "${peer}" has kind=${peerStrategy.kind || '<missing>'}; expected kind=unit or kind=integration`
    );
    return errors;
  }

  const citingScope = (citingTask && citingTask.filesInScope) || [];
  const peerScope = (peerTask && peerTask.filesInScope) || [];
  const peerEntry = peerStrategy.entry;
  const scopeSuperset = peerScopeCoversCitingScope(peerScope, citingScope);
  const entryOverlap =
    typeof peerEntry === 'string' && entryReferencesScope(peerEntry, citingScope);
  if (!scopeSuperset && !entryOverlap) {
    errors.push(
      `${citingHeading}: Test Strategy peer "${peer}" does not cover this task's Files in scope (peer's filesInScope must be a superset, or peer's entry "${peerEntry}" must match)`
    );
  }

  return errors;
}

module.exports = {
  KINDS,
  synthesizeCommand,
  validatePeerCitation,
  // Exported for the REFACTOR-phase helper test seam.
  resolveEnvelope,
};
