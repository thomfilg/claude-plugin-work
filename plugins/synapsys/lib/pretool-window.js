'use strict';

/**
 * pretool-window — bounded per-session expectations + per-turn behavior-changed
 * dedup primitives for the heuristic divergence emitter (path A) and self-report
 * scan (path B).
 *
 * Pure in-memory module: no `node:fs`, no timers, no async I/O. Event-count
 * eviction only (spec §Architecture/Window). All public functions are wrapped
 * fail-open so a thrown error never propagates into the dispatcher.
 */

const DEFAULT_MAX = 32;
const DEFAULT_INTERVENING = 1;

let WINDOW_MAX = DEFAULT_MAX;
let WINDOW_INTERVENING = DEFAULT_INTERVENING;

/** sessionId -> Map<memoryName, { expected, ageEvents }> (insertion-ordered) */
const expectations = new Map();
/** sessionId -> Set<memoryName> dedup per Stop turn */
const turnDedup = new Map();

function getSessionMap(sessionId) {
  let m = expectations.get(sessionId);
  if (!m) {
    m = new Map();
    expectations.set(sessionId, m);
  }
  return m;
}

function enforceCap(sessionMap) {
  while (sessionMap.size > WINDOW_MAX) {
    const oldestKey = sessionMap.keys().next().value;
    if (oldestKey === undefined) break;
    sessionMap.delete(oldestKey);
  }
}

function recordExpectation(sessionId, memoryName, expectedCommand) {
  try {
    const sessionMap = getSessionMap(sessionId);
    // Re-insert to mark as most recently added for LRU-style eviction.
    sessionMap.delete(memoryName);
    sessionMap.set(memoryName, { expected: expectedCommand, ageEvents: 0 });
    enforceCap(sessionMap);
  } catch (_e) {
    // fail-open
  }
}

function resolveExpectation(sessionId, observedCommand) {
  try {
    const sessionMap = expectations.get(sessionId);
    if (!sessionMap || sessionMap.size === 0) {
      return { divergent: false, expectations: [] };
    }
    // First check for any exact match — match clears all entries for that
    // memory (and is non-divergent).
    for (const [memoryName, entry] of sessionMap) {
      if (entry.expected === observedCommand) {
        sessionMap.delete(memoryName);
        return { divergent: false, expectations: [] };
      }
    }
    // No match: age every entry. Entries whose age now exceeds the intervening
    // budget are reported as divergent and evicted.
    const divergent = [];
    for (const [memoryName, entry] of Array.from(sessionMap.entries())) {
      entry.ageEvents += 1;
      if (entry.ageEvents > WINDOW_INTERVENING) {
        divergent.push({ memoryName, expected: entry.expected });
        sessionMap.delete(memoryName);
      }
    }
    if (divergent.length > 0) {
      return { divergent: true, expectations: divergent };
    }
    return { divergent: false, expectations: [] };
  } catch (_e) {
    return { divergent: false, expectations: [] };
  }
}

function evictStale(sessionId) {
  try {
    const sessionMap = expectations.get(sessionId);
    if (!sessionMap) return;
    enforceCap(sessionMap);
  } catch (_e) {
    // fail-open
  }
}

function markBehaviorChanged(sessionId, memoryName) {
  try {
    let set = turnDedup.get(sessionId);
    if (!set) {
      set = new Set();
      turnDedup.set(sessionId, set);
    }
    if (set.has(memoryName)) return false;
    set.add(memoryName);
    return true;
  } catch (_e) {
    return false;
  }
}

function clearTurnDedup(sessionId) {
  try {
    turnDedup.delete(sessionId);
  } catch (_e) {
    // fail-open
  }
}

function setWindowOverrides(opts) {
  try {
    if (opts && typeof opts.max === 'number') WINDOW_MAX = opts.max;
    if (opts && typeof opts.intervening === 'number') WINDOW_INTERVENING = opts.intervening;
  } catch (_e) {
    // fail-open
  }
}

module.exports = {
  PRETOOL_WINDOW_MAX: DEFAULT_MAX,
  PRETOOL_WINDOW_INTERVENING: DEFAULT_INTERVENING,
  recordExpectation,
  resolveExpectation,
  evictStale,
  markBehaviorChanged,
  clearTurnDedup,
  setWindowOverrides,
};
