'use strict';

/**
 * TDD ownership graph (GH-590, AC10/AC15).
 *
 * Given the parsed tasks from a `tasks.md`, this module computes which task(s)
 * transitively exercise each path declared in any `### Files in scope` block,
 * and surfaces paths that an owner declares but no task actually covers.
 *
 * "Transitively exercise" = some task's Test Strategy `entry` references a
 * path that, under `fileMatchesScope`, matches the candidate path. Tasks
 * declaring `kind: verified-by` or `kind: wiring-citation` cover their own
 * scope by citation (peer is validated separately by `validatePeerCitation`).
 *
 * Docs-only policy: a task whose `Files in scope` is 100% `*.md` is NOT
 * auto-covered — it must declare `kind: wiring-citation` or
 * `kind: verified-by`. Otherwise its docs paths are reported as orphans.
 *
 * Public API:
 *   - buildCoverageGraph(tasks): Map<path, Set<taskNum>>
 *   - findOrphanedPaths(tasks, graph): { path, owner, remediation }[]
 */

const { fileMatchesScope } = require('./task-scope-globs');

const MD_EXT_RE = /\.md$/i;
const CITATION_KINDS = new Set(['verified-by', 'wiring-citation']);
const ENTRY_KINDS = new Set(['unit', 'integration']);

/**
 * Predicate: every file-in-scope path is a Markdown doc.
 *
 * @param {string[]} paths
 * @returns {boolean}
 */
function isDocsOnlyScope(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every((p) => typeof p === 'string' && MD_EXT_RE.test(p));
}

/**
 * Build a coverage graph keyed by every path declared in any task's
 * `### Files in scope`. The value is the set of task numbers that
 * transitively cover that path.
 *
 * Coverage rules:
 *   - A task with `kind: unit`/`integration` covers any of its own
 *     scope paths whose glob matches the strategy's `entry`.
 *   - A task with citation kinds (`verified-by`/`wiring-citation`)
 *     covers its own scope paths by citation (peer validation is
 *     handled elsewhere).
 *   - A task may also transitively cover a peer task's path when its
 *     `entry` matches that peer's scope.
 *
 * @param {Array<object>} tasks
 * @returns {Map<string, Set<number>>}
 */
function buildCoverageGraph(tasks) {
  /** @type {Map<string, Set<number>>} */
  const graph = new Map();
  if (!Array.isArray(tasks)) return graph;

  // Seed the graph with every declared path.
  for (const t of tasks) {
    const files = Array.isArray(t && t.filesInScope) ? t.filesInScope : [];
    for (const p of files) {
      if (typeof p === 'string' && p) {
        if (!graph.has(p)) graph.set(p, new Set());
      }
    }
  }

  // Apply coverage from each task's strategy.
  for (const t of tasks) {
    const strat = t && t.testStrategy;
    if (!strat || typeof strat !== 'object') continue;
    const kind = strat.kind;
    const ownScope = Array.isArray(t.filesInScope) ? t.filesInScope : [];

    if (CITATION_KINDS.has(kind)) {
      // Citation kinds cover their own scope by reference.
      for (const p of ownScope) graph.get(p).add(t.num);
      continue;
    }

    if (ENTRY_KINDS.has(kind) && typeof strat.entry === 'string' && strat.entry) {
      const entry = strat.entry;
      // For every path in the graph, mark task as a coverer if its entry
      // matches that path's owning scope.
      for (const [path] of graph) {
        // The task covers a path iff its `entry` is "in scope" of that path:
        // i.e. some task's scope (including this task's) globs match entry,
        // and the path itself is among those scope paths.
        // Simpler: a unit/integration test entry covers the path when the
        // path matches a scope glob list that includes the entry.
        // For the common case where files-in-scope contains the entry
        // verbatim, this is just an entry === path check on either side,
        // OR the entry path lies under the same scope as `path`.
        if (
          entry === path ||
          fileMatchesScope(entry, [path]) ||
          fileMatchesScope(path, [entry])
        ) {
          graph.get(path).add(t.num);
        }
      }

      // Also: any of this task's own scope paths whose glob matches `entry`.
      for (const p of ownScope) {
        if (
          entry === p ||
          fileMatchesScope(entry, [p]) ||
          fileMatchesScope(p, [entry])
        ) {
          graph.get(p).add(t.num);
        }
      }
    }
  }

  return graph;
}

/**
 * Default three-option remediation strings, kept stable so AC15's
 * assertion text remains anchored.
 *
 * @param {object} task
 * @returns {string[]}
 */
function _remediationOptions(task) {
  const heading = (task && task.heading) || `Task ${task && task.num}`;
  return [
    `fold into peer task that already exercises this path`,
    `declare kind: wiring-citation with verified-by: <peer task> in ${heading}`,
    `add a test entry to this task (kind: unit or kind: integration with entry: <path>)`,
  ];
}

/**
 * Identify paths declared in some task's `Files in scope` that no task's
 * test strategy actually covers, OR docs-only tasks that fail the
 * wiring-citation policy.
 *
 * @param {Array<object>} tasks
 * @param {Map<string, Set<number>>} graph
 * @returns {{ path: string, owner: number, remediation: string[] }[]}
 */
function findOrphanedPaths(tasks, graph) {
  /** @type {{ path: string, owner: number, remediation: string[] }[]} */
  const out = [];
  if (!Array.isArray(tasks) || !(graph instanceof Map)) return out;

  // Map every path to its declaring task (first owner wins; ownership
  // uniqueness is enforced separately by validateUniqueOwnership).
  /** @type {Map<string, object>} */
  const owners = new Map();
  for (const t of tasks) {
    const files = Array.isArray(t && t.filesInScope) ? t.filesInScope : [];
    for (const p of files) {
      if (typeof p === 'string' && p && !owners.has(p)) owners.set(p, t);
    }
  }

  for (const [path, coverers] of graph) {
    const owner = owners.get(path);
    if (!owner) continue;

    const ownerScope = Array.isArray(owner.filesInScope) ? owner.filesInScope : [];
    const ownerStrat = owner.testStrategy || null;
    const ownerKind = ownerStrat && ownerStrat.kind;

    // Docs-only policy: an owner whose entire scope is *.md must declare a
    // citation kind. Otherwise every docs path it owns is an orphan.
    if (isDocsOnlyScope(ownerScope) && !CITATION_KINDS.has(ownerKind)) {
      out.push({
        path,
        owner: owner.num,
        remediation: _remediationOptions(owner),
      });
      continue;
    }

    if (!coverers || coverers.size === 0) {
      out.push({
        path,
        owner: owner.num,
        remediation: _remediationOptions(owner),
      });
    }
  }

  return out;
}

module.exports = {
  buildCoverageGraph,
  findOrphanedPaths,
  // Exposed for testing / docs.
  isDocsOnlyScope,
};
