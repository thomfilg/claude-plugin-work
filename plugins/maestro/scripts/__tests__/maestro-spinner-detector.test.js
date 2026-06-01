// Regression tests for detectors/spinner.js.
//
// The detector must fire ONLY when a live spinner glyph is present alongside
// a multi-minute timer. Stale post-completion summary lines like
// "Cooked for 40m 35s" — emitted with no glyph after a tool finishes — must
// be ignored, otherwise the conductor sends a false Esc + nudge mid-idle.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SPINNER_LIB = path.resolve(
  __dirname,
  '..',
  'lib',
  'maestro-conduct',
  'detectors',
  'spinner.js'
);

function freshDetector(env = {}) {
  delete require.cache[require.resolve(SPINNER_LIB)];
  Object.assign(process.env, env);
  return require(SPINNER_LIB);
}

test('live spinner past threshold fires spinner-hang', () => {
  const detector = freshDetector({ SPINNER_THRESHOLD_MIN: '15' });
  const pane = ['idle status bar', '✻ Synthesizing… (40m 35s · ↓ 78.2k tokens)', ''].join('\n');
  const hit = detector.detect({ pane });
  assert.strictEqual(hit.hit, true);
  assert.strictEqual(hit.kind, 'spinner-hang');
  assert.strictEqual(hit.elapsedMin, 40);
});

test('live spinner under threshold does NOT fire', () => {
  const detector = freshDetector({ SPINNER_THRESHOLD_MIN: '15' });
  const pane = '* Hashing… (3m 7s · ↓ 2.1k tokens)\n';
  assert.strictEqual(detector.detect({ pane }).hit, false);
});

test('completion summary WITHOUT glyph is IGNORED — does not trigger hang', () => {
  // Bug guard: "Cooked for 40m 35s" with no leading glyph used to match the
  // detector's loose regex and trigger a false spinner-hang interrupt.
  const detector = freshDetector({ SPINNER_THRESHOLD_MIN: '15' });
  const pane = [
    '> /work GH-465 finished',
    'Cooked for 40m 35s · 1 monitor still running',
    'idle prompt > ',
  ].join('\n');
  assert.strictEqual(detector.detect({ pane }).hit, false);
});

test('live gerund spinner with "still running" tail fires past threshold', () => {
  const detector = freshDetector({ SPINNER_THRESHOLD_MIN: '15' });
  const pane = '* Cooking for 40m 35s · 1 monitor still running\n';
  const hit = detector.detect({ pane });
  assert.strictEqual(hit.hit, true);
  assert.strictEqual(hit.elapsedMin, 40);
});

test('past-tense glyph line ("Cooked for") is IGNORED even with leading glyph', () => {
  // Even with the leading glyph, "Cooked" is past tense — a completion line,
  // not a live spinner. The gerund "-ing" requirement (parity with the bash
  // pane_has_live_spinner) means this must not fire.
  const detector = freshDetector({ SPINNER_THRESHOLD_MIN: '15' });
  const pane = '* Cooked for 40m 35s · 1 monitor still running\n';
  assert.strictEqual(detector.detect({ pane }).hit, false);
});

test('multiple lines: takes the last LIVE gerund spinner, ignores past-tense/no-glyph lines', () => {
  const detector = freshDetector({ SPINNER_THRESHOLD_MIN: '15' });
  const pane = [
    'Cooked for 99m 0s', // no glyph, past tense → ignored
    '* Cooked for 80m 0s', // glyph but past tense → ignored
    '✽ Frosting… (20m 12s)', // glyph + gerund → MATCHES
    'Cooked for 50m 0s', // ignored
  ].join('\n');
  const hit = detector.detect({ pane });
  assert.strictEqual(hit.hit, true);
  assert.strictEqual(
    hit.elapsedMin,
    20,
    'only glyph + gerund counts as a live spinner; past-tense and no-glyph lines are ignored'
  );
});
