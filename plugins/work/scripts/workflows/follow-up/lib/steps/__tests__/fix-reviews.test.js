'use strict';

// fix-reviews.test.js — Task 7 (GH-537): assert delegate-block strings use
// the new --mark-locally-solved / --mark-locally-skipped flag names and
// include the --also-resolve-on-github caveat + example.
//
// Strategy: read fix-reviews.js as source text and assert the substrings
// appear (or are absent). This mirrors monitor.test.js's source-text style.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIX_REVIEWS_PATH = path.resolve(__dirname, '..', 'fix-reviews.js');
const SOURCE = fs.readFileSync(FIX_REVIEWS_PATH, 'utf8');

describe('fix-reviews delegate block (Task 7)', () => {
  it('Delegate-block text in fix-reviews.js uses the new flag names', () => {
    assert.ok(
      SOURCE.includes('--mark-locally-solved'),
      'expected delegate block to reference --mark-locally-solved',
    );
    assert.ok(
      SOURCE.includes('--mark-locally-skipped'),
      'expected delegate block to reference --mark-locally-skipped',
    );
    assert.ok(
      !SOURCE.includes('--solve-comment'),
      'expected NO remaining references to --solve-comment',
    );
    assert.ok(
      !SOURCE.includes('--skip-comment'),
      'expected NO remaining references to --skip-comment',
    );
  });

  it('uses --mark-locally-solved instead of --solve-comment', () => {
    assert.ok(
      SOURCE.includes('--mark-locally-solved'),
      'expected delegate block to reference --mark-locally-solved',
    );
    assert.ok(
      !SOURCE.includes('--solve-comment'),
      'expected NO remaining references to --solve-comment',
    );
  });

  it('uses --mark-locally-skipped instead of --skip-comment', () => {
    assert.ok(
      SOURCE.includes('--mark-locally-skipped'),
      'expected delegate block to reference --mark-locally-skipped',
    );
    assert.ok(
      !SOURCE.includes('--skip-comment'),
      'expected NO remaining references to --skip-comment',
    );
  });

  it('references --also-resolve-on-github flag and the "does NOT resolve" caveat', () => {
    assert.ok(
      SOURCE.includes('--also-resolve-on-github'),
      'expected delegate block to mention --also-resolve-on-github',
    );
    assert.ok(
      /does NOT resolve/i.test(SOURCE),
      'expected delegate block to contain caveat phrase "does NOT resolve"',
    );
  });

  it('shows an example pairing --mark-locally-solved with --also-resolve-on-github', () => {
    // The example must contain both flag names on the same line (or close together)
    // so an operator can copy-paste the opt-in form.
    const lines = SOURCE.split('\n');
    const hasPairLine = lines.some(
      (l) => l.includes('--mark-locally-solved') && l.includes('--also-resolve-on-github'),
    );
    assert.ok(
      hasPairLine,
      'expected an example line pairing --mark-locally-solved with --also-resolve-on-github',
    );
  });
});
