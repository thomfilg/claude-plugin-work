'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function load() {
  try {
    delete require.cache[require.resolve('../pretool-window')];
  } catch (_e) {
    // module not yet implemented — return an empty stub so individual
    // assertions fail (behavior gap) instead of the whole file failing to
    // load (structural error).
    return {};
  }
  try {
    return require('../pretool-window');
  } catch (_e) {
    return {};
  }
}

test('recordExpectation + matching resolveExpectation clears entry (AC2 slice)', () => {
  const win = load();
  win.setWindowOverrides({ max: 32, intervening: 1 });
  const sessionId = 'sess-1';
  win.recordExpectation(sessionId, 'mem-a', 'git push');
  const result = win.resolveExpectation(sessionId, 'git push');
  assert.equal(result.divergent, false);
  // After a match the entry is cleared; second resolve sees no expectations.
  const again = win.resolveExpectation(sessionId, 'git push');
  assert.equal(again.divergent, false);
  assert.ok(!again.expectations || again.expectations.length === 0);
});

test('resolveExpectation flags divergence only after PRETOOL_WINDOW_INTERVENING events (AC1, AC3)', () => {
  const win = load();
  win.setWindowOverrides({ max: 32, intervening: 1 });
  const sessionId = 'sess-2';
  win.recordExpectation(sessionId, 'mem-b', 'git push');
  // First non-matching observation: still within intervening grace window — not yet divergent.
  const r1 = win.resolveExpectation(sessionId, 'ls');
  assert.equal(r1.divergent, false);
  // Second non-matching observation: exceeds intervening budget — divergent.
  const r2 = win.resolveExpectation(sessionId, 'pwd');
  assert.equal(r2.divergent, true);
  assert.ok(Array.isArray(r2.expectations));
  const names = r2.expectations.map((e) => e.memoryName);
  assert.ok(names.includes('mem-b'));
  // Expectation has been evicted after being reported divergent.
  const r3 = win.resolveExpectation(sessionId, 'pwd');
  assert.equal(r3.divergent, false);
});

test('per-session map respects PRETOOL_WINDOW_MAX cap (oldest evicted first)', () => {
  const win = load();
  win.setWindowOverrides({ max: 3, intervening: 1 });
  const sessionId = 'sess-3';
  win.recordExpectation(sessionId, 'm1', 'cmd1');
  win.recordExpectation(sessionId, 'm2', 'cmd2');
  win.recordExpectation(sessionId, 'm3', 'cmd3');
  win.recordExpectation(sessionId, 'm4', 'cmd4'); // should evict m1
  // Resolving cmd1 should NOT find a match (m1 evicted).
  const r = win.resolveExpectation(sessionId, 'cmd1');
  assert.equal(r.divergent, false);
  // But cmd4 should match.
  const r2 = win.resolveExpectation(sessionId, 'cmd4');
  assert.equal(r2.divergent, false);
});

test('exports PRETOOL_WINDOW_MAX=32 and PRETOOL_WINDOW_INTERVENING=1 constants', () => {
  const win = load();
  assert.equal(win.PRETOOL_WINDOW_MAX, 32);
  assert.equal(win.PRETOOL_WINDOW_INTERVENING, 1);
  assert.equal(typeof win.setWindowOverrides, 'function');
});

test('markBehaviorChanged returns true first time and false on repeat per turn; clearTurnDedup resets', () => {
  const win = load();
  const sessionId = 'sess-4';
  assert.equal(win.markBehaviorChanged(sessionId, 'mem-x'), true);
  assert.equal(win.markBehaviorChanged(sessionId, 'mem-x'), false);
  // Different memory not affected.
  assert.equal(win.markBehaviorChanged(sessionId, 'mem-y'), true);
  win.clearTurnDedup(sessionId);
  assert.equal(win.markBehaviorChanged(sessionId, 'mem-x'), true);
});
