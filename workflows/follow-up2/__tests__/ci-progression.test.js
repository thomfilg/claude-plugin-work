'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── Import triage step handler ────────────────────────────────────────────

const handlers = Object.create(null);
require('../lib/steps/triage')(function (name, fn) {
  handlers[name] = fn;
});
const triage = handlers['triage'];

function makeState(exitCode, output) {
  return {
    ticketId: 'GH-123',
    currentStep: 'triage',
    lastMonitorResult: { exitCode, output },
    failureCategory: null,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CI progression scenarios', () => {
  describe('Scenario 1: 3 pipelines → all green', () => {
    it('triage routes PENDING to monitor', () => {
      const state = makeState(
        1,
        'CI: PENDING (3 running, 0 passed)\n  ⏳ shard 1 — running\n  ⏳ shard 2 — running\n  ⏳ shard 3 — running\nReviews: CLEAR'
      );
      triage(state, {});
      assert.equal(state.currentStep, 'monitor');
    });

    it('triage routes PASSED to report', () => {
      const state = makeState(
        1,
        'CI: PASSED (all 3 checks)\n  ✓ shard 1 — passed\n  ✓ shard 2 — passed\n  ✓ shard 3 — passed\nReviews: CLEAR'
      );
      triage(state, {});
      assert.equal(state.currentStep, 'report');
    });

    it('progressive: PENDING → PENDING → PENDING → PASSED', () => {
      const outputs = [
        'CI: PENDING (3 running, 0 passed)\nReviews: CLEAR',
        'CI: PENDING (2 running, 1 passed)\nReviews: CLEAR',
        'CI: PENDING (1 running, 2 passed)\nReviews: CLEAR',
        'CI: PASSED (all 3 checks)\nReviews: CLEAR',
      ];

      for (let i = 0; i < outputs.length; i++) {
        const state = makeState(1, outputs[i]);
        triage(state, {});
        if (i < 3) {
          assert.equal(state.currentStep, 'monitor', `step ${i}: should loop back`);
        } else {
          assert.equal(state.currentStep, 'report', `step ${i}: should complete`);
        }
      }
    });
  });

  describe('Scenario 2: 3 pipelines → 2 green + 1 neutral', () => {
    it('CANCELLED without merge block goes to report', () => {
      const state = makeState(
        1,
        'CI: CANCELLED (1 cancelled, 2 passed)\n  ⊘ Compare Runtime — cancelled\n  ✓ shard 1 — passed\n  ✓ shard 2 — passed\nReviews: CLEAR'
      );
      triage(state, {});
      assert.equal(state.currentStep, 'report');
      assert.equal(state.failureCategory, null);
    });

    it('progressive: PENDING × 3 → CANCELLED (non-blocking)', () => {
      const outputs = [
        'CI: PENDING (3 running)\nReviews: CLEAR',
        'CI: PENDING (2 running, 1 passed)\nReviews: CLEAR',
        'CI: PENDING (1 running, 2 passed)\nReviews: CLEAR',
        'CI: CANCELLED (1 cancelled, 2 passed)\nReviews: CLEAR',
      ];
      const expected = ['monitor', 'monitor', 'monitor', 'report'];

      for (let i = 0; i < outputs.length; i++) {
        const state = makeState(1, outputs[i]);
        triage(state, {});
        assert.equal(state.currentStep, expected[i], `step ${i}`);
      }
    });
  });

  describe('Scenario 3: 3 pipelines → 2 green + 1 neutral + merge conflict', () => {
    it('conflict detected after CI finishes', () => {
      const state = makeState(
        1,
        'CI: CANCELLED (1 cancelled, 2 passed)\nReviews: CLEAR\nThis branch cannot be merged — merge conflict'
      );
      triage(state, {});
      assert.equal(state.currentStep, 'fix-ci');
      assert.equal(state.failureCategory, 'conflict');
    });

    it('progressive: PENDING × 3 → CANCELLED + conflict', () => {
      const outputs = [
        'CI: PENDING (3 running)\nReviews: CLEAR',
        'CI: PENDING (2 running, 1 passed)\nReviews: CLEAR',
        'CI: PENDING (1 running, 2 passed)\nReviews: CLEAR',
        'CI: CANCELLED (1 cancelled, 2 passed)\nReviews: CLEAR\nmerge conflict detected',
      ];
      const expected = [
        { step: 'monitor', cat: null },
        { step: 'monitor', cat: null },
        { step: 'monitor', cat: null },
        { step: 'fix-ci', cat: 'conflict' },
      ];

      for (let i = 0; i < outputs.length; i++) {
        const state = makeState(1, outputs[i]);
        triage(state, {});
        assert.equal(state.currentStep, expected[i].step, `step ${i}: currentStep`);
        assert.equal(state.failureCategory, expected[i].cat, `step ${i}: failureCategory`);
      }
    });
  });
});
