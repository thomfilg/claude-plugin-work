'use strict';

// GH-513 Task 5 — sticky-domain LRU + hysteresis store.
//
// Per-(sessionId, domain) tracking of activeStreak / quietStreak / lastSeenTs.
// - activeStreak >= STREAK_THRESHOLD flips a domain sticky.
// - quietStreak >= STREAK_THRESHOLD drops it back to non-sticky (and removes the entry).
// - Entries older than TTL_MS are evicted on load.
// - File writes are atomic via tmp + rename.
// - All load/save errors are swallowed (fail-open): callers see {} / no-op.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STREAK_THRESHOLD = 3;
const TTL_MS = 24 * 60 * 60 * 1000;

function defaultStatePath() {
  return path.join(os.homedir(), '.claude', 'synapsys', '.state', 'sticky-domains.json');
}

function loadStickyState({ filePath = defaultStatePath(), now = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const out = {};
  for (const sessionId of Object.keys(parsed)) {
    const session = parsed[sessionId];
    if (!session || typeof session !== 'object') continue;
    const kept = {};
    for (const domain of Object.keys(session)) {
      const entry = session[domain];
      if (!entry || typeof entry !== 'object') continue;
      const lastSeenTs = Number(entry.lastSeenTs) || 0;
      if (now - lastSeenTs > TTL_MS) continue; // evict
      kept[domain] = {
        activeStreak: Number(entry.activeStreak) || 0,
        quietStreak: Number(entry.quietStreak) || 0,
        sticky: entry.sticky === true,
        lastSeenTs,
      };
    }
    if (Object.keys(kept).length > 0) out[sessionId] = kept;
  }
  return out;
}

function saveStickyState({ state, filePath = defaultStatePath() }) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      // Cleanup tmp on rename failure.
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      throw e;
    }
  } catch (_) {
    // Fail-open.
  }
}

function nextStreak(prev, isActive) {
  const base = prev || { activeStreak: 0, quietStreak: 0, sticky: false };
  if (isActive) {
    return {
      activeStreak: (base.activeStreak || 0) + 1,
      quietStreak: 0,
      sticky: base.sticky === true,
    };
  }
  return {
    activeStreak: 0,
    quietStreak: (base.quietStreak || 0) + 1,
    sticky: base.sticky === true,
  };
}

function updateStickyState({ state, sessionId, rawActiveSet, now = Date.now() }) {
  const next = { ...(state || {}) };
  const prevSession = (state && state[sessionId]) || {};
  const session = { ...prevSession };

  const active = rawActiveSet instanceof Set ? rawActiveSet : new Set(rawActiveSet || []);

  // Domains we need to consider = active ∪ previously-tracked.
  const domains = new Set([...Object.keys(session), ...active]);

  for (const domain of domains) {
    const prev = session[domain];
    const isActive = active.has(domain);
    const stepped = nextStreak(prev, isActive);

    // Hysteresis flip.
    if (stepped.activeStreak >= STREAK_THRESHOLD) {
      stepped.sticky = true;
    }

    // Hysteresis drop.
    if (stepped.quietStreak >= STREAK_THRESHOLD) {
      // Remove entry entirely.
      delete session[domain];
      continue;
    }

    session[domain] = {
      activeStreak: stepped.activeStreak,
      quietStreak: stepped.quietStreak,
      sticky: stepped.sticky,
      lastSeenTs: now,
    };
  }

  if (Object.keys(session).length === 0) {
    delete next[sessionId];
  } else {
    next[sessionId] = session;
  }
  return next;
}

module.exports = {
  loadStickyState,
  saveStickyState,
  updateStickyState,
  nextStreak,
  defaultStatePath,
  STREAK_THRESHOLD,
  TTL_MS,
};
