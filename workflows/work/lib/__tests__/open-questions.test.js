/**
 * Tests for workflows/work/lib/open-questions.js
 *
 * Pure-logic parser module that reads brief.md Open Questions and extracts
 * structured blocks (scope, rationale, resolved).
 *
 * Run: node --test workflows/work/lib/__tests__/open-questions.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parse,
  findBlocking,
  classify,
  SCOPES,
  downgradeToLocal,
} = require('../open-questions');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_SINGLE_STRUCTURED = `# Product Brief

## Summary
Example brief.

## Open Questions

- **Question:** Should the gate be a hook or a step?
  - \`scope: architectural\`
  - \`rationale: affects workflow shape\`
  - \`resolved: false\`
`;

const FIXTURE_MULTIPLE_MIXED = `# Brief

## Open Questions

- **Question:** Where should the gate live?
  - \`scope: local\`
  - \`rationale: implementation detail\`
  - \`resolved: false\`
- **Question:** How do siblings coordinate router ownership?
  - \`scope: cross-ticket\`
  - \`rationale: affects multiple tickets\`
  - \`resolved: false\`
- **Question:** Should we migrate to a new framework?
  - \`scope: architectural\`
  - \`rationale: structural change\`
  - \`resolved: true\`
  - **Resolution:** No, defer to Q3 planning.

## Success Metrics
- Some metric.
`;

const FIXTURE_LEGACY_FREE_TEXT = `# Brief

## Open Questions
- Is the API rate limit 100 or 1000?
- Should we use Redis or Memcached?

## Out of Scope
- Nothing here.
`;

const FIXTURE_MALFORMED = `# Brief

## Open Questions

- **Question:** Broken question with no scope
  - \`rationale: missing scope field\`
  - \`resolved: false\`
`;

const FIXTURE_EMPTY_SECTION = `# Brief

## Open Questions

## Out of Scope
- Done.
`;

const FIXTURE_NO_SECTION = `# Brief

## Summary
Nothing to question here.

## Out of Scope
- Done.
`;

const FIXTURE_H1_AFTER_SECTION = `# Brief

## Open Questions

- **Question:** A real question
  - \`scope: architectural\`
  - \`rationale: r\`
  - \`resolved: false\`

# Second H1 Heading

- Not a question, should not be parsed
- Another stray bullet
`;

const FIXTURE_H3_AFTER_SECTION = `# Brief

## Open Questions

- **Question:** A real question
  - \`scope: architectural\`
  - \`rationale: r\`
  - \`resolved: false\`

### Sub Heading Inside Doc

- Not a question
`;

const FIXTURE_MISSING_RESOLVED = `# Brief

## Open Questions

- **Question:** Structured block without resolved field
  - \`scope: architectural\`
  - \`rationale: author forgot resolved\`
`;

// ─── parse() ────────────────────────────────────────────────────────────────

describe('open-questions: parse', () => {
  it('parses a single well-formed structured block', () => {
    const result = parse(FIXTURE_SINGLE_STRUCTURED);
    assert.equal(result.length, 1);
    const q = result[0];
    assert.equal(q.questionText, 'Should the gate be a hook or a step?');
    assert.equal(q.scope, 'architectural');
    assert.equal(q.rationale, 'affects workflow shape');
    assert.equal(q.resolved, false);
    assert.equal(typeof q.startLine, 'number');
    assert.equal(typeof q.endLine, 'number');
    assert.ok(q.endLine >= q.startLine);
  });

  it('parses multiple structured blocks with mixed scopes and resolutions', () => {
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    assert.equal(result.length, 3);

    assert.equal(result[0].scope, 'local');
    assert.equal(result[0].resolved, false);
    assert.equal(result[0].questionText, 'Where should the gate live?');

    assert.equal(result[1].scope, 'cross-ticket');
    assert.equal(result[1].resolved, false);

    assert.equal(result[2].scope, 'architectural');
    assert.equal(result[2].resolved, true);
    assert.equal(result[2].resolution, 'No, defer to Q3 planning.');
  });

  it('does not bleed past the Open Questions section into the next heading', () => {
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    // All blocks must end before the "## Success Metrics" line
    const sectionEndLine = FIXTURE_MULTIPLE_MIXED.split('\n').findIndex((l) =>
      l.startsWith('## Success Metrics')
    );
    for (const q of result) {
      assert.ok(q.endLine < sectionEndLine, `question ending at ${q.endLine} bled past section`);
    }
  });

  it('coerces legacy free-text bullets to { scope: local, resolved: true }', () => {
    const result = parse(FIXTURE_LEGACY_FREE_TEXT);
    assert.equal(result.length, 2);
    for (const q of result) {
      assert.equal(q.scope, 'local');
      assert.equal(q.resolved, true);
    }
    assert.equal(result[0].questionText, 'Is the API rate limit 100 or 1000?');
    assert.equal(result[1].questionText, 'Should we use Redis or Memcached?');
  });

  it('coerces malformed structured blocks (missing scope:) to { scope: local, resolved: true }', () => {
    const result = parse(FIXTURE_MALFORMED);
    assert.equal(result.length, 1);
    assert.equal(result[0].scope, 'local');
    assert.equal(result[0].resolved, true);
  });

  it('returns [] for a brief with no Open Questions section', () => {
    assert.deepEqual(parse(FIXTURE_NO_SECTION), []);
  });

  it('returns [] for an empty Open Questions section', () => {
    assert.deepEqual(parse(FIXTURE_EMPTY_SECTION), []);
  });

  it('returns [] for empty string input', () => {
    assert.deepEqual(parse(''), []);
  });

  it('does not crash on null/undefined input', () => {
    assert.deepEqual(parse(null), []);
    assert.deepEqual(parse(undefined), []);
  });

  it('does not bleed past an h1 heading that follows the section', () => {
    const result = parse(FIXTURE_H1_AFTER_SECTION);
    assert.equal(result.length, 1);
    assert.equal(result[0].questionText, 'A real question');
  });

  it('does not bleed past an h3 heading that follows the section', () => {
    const result = parse(FIXTURE_H3_AFTER_SECTION);
    assert.equal(result.length, 1);
    assert.equal(result[0].questionText, 'A real question');
  });

  it('endLine points to the last non-blank content line of each block', () => {
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    const lines = FIXTURE_MULTIPLE_MIXED.split('\n');
    for (const q of result) {
      assert.notEqual(
        lines[q.endLine].trim(),
        '',
        `endLine ${q.endLine} is blank: "${lines[q.endLine]}"`
      );
    }
  });

  it('endLine for a block with trailing blank before next block lands on last subfield', () => {
    // FIXTURE_MULTIPLE_MIXED has three structured blocks. The first block's
    // last non-blank content line is `  - \`resolved: false\``. We assert
    // that the first question's endLine matches that line, not a blank.
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    const lines = FIXTURE_MULTIPLE_MIXED.split('\n');
    assert.ok(lines[result[0].endLine].includes('resolved: false'));
  });

  it('treats a missing resolved: field as resolved: false on a valid structured block', () => {
    const result = parse(FIXTURE_MISSING_RESOLVED);
    assert.equal(result.length, 1);
    assert.equal(result[0].scope, 'architectural');
    assert.equal(result[0].resolved, false);
    assert.equal(result[0].rationale, 'author forgot resolved');
  });
});

// ─── findBlocking() ─────────────────────────────────────────────────────────

describe('open-questions: findBlocking', () => {
  it('returns an empty array for empty input', () => {
    assert.deepEqual(findBlocking([]), []);
  });

  it('returns an empty array when all questions are local', () => {
    const qs = [
      { scope: 'local', resolved: false },
      { scope: 'local', resolved: false },
    ];
    assert.deepEqual(findBlocking(qs), []);
  });

  it('filters out resolved architectural questions', () => {
    const qs = [
      { scope: 'architectural', resolved: true, questionText: 'a' },
      { scope: 'architectural', resolved: false, questionText: 'b' },
    ];
    const result = findBlocking(qs);
    assert.equal(result.length, 1);
    assert.equal(result[0].questionText, 'b');
  });

  it('returns both unresolved cross-ticket and architectural questions', () => {
    const qs = [
      { scope: 'local', resolved: false, questionText: 'a' },
      { scope: 'cross-ticket', resolved: false, questionText: 'b' },
      { scope: 'architectural', resolved: false, questionText: 'c' },
      { scope: 'architectural', resolved: true, questionText: 'd' },
    ];
    const result = findBlocking(qs);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((q) => q.questionText),
      ['b', 'c']
    );
  });

  it('returns empty when all architectural questions are resolved', () => {
    const qs = [
      { scope: 'architectural', resolved: true },
      { scope: 'architectural', resolved: true },
    ];
    assert.deepEqual(findBlocking(qs), []);
  });
});

// ─── classify() ─────────────────────────────────────────────────────────────

describe('open-questions: classify', () => {
  it('passes through valid scopes', () => {
    assert.equal(classify('local'), 'local');
    assert.equal(classify('cross-ticket'), 'cross-ticket');
    assert.equal(classify('architectural'), 'architectural');
  });

  it('normalizes whitespace and case', () => {
    assert.equal(classify('  local  '), 'local');
    assert.equal(classify('LOCAL'), 'local');
    assert.equal(classify('Cross-Ticket'), 'cross-ticket');
    assert.equal(classify('ARCHITECTURAL'), 'architectural');
  });

  it('returns unknown for invalid scope strings', () => {
    assert.equal(classify('global'), 'unknown');
    assert.equal(classify('system-wide'), 'unknown');
  });

  it('returns unknown for empty or missing input', () => {
    assert.equal(classify(''), 'unknown');
    assert.equal(classify('   '), 'unknown');
    assert.equal(classify(undefined), 'unknown');
    assert.equal(classify(null), 'unknown');
  });

  it('exports a frozen SCOPES allowlist', () => {
    assert.ok(Array.isArray(SCOPES));
    assert.ok(Object.isFrozen(SCOPES));
    assert.deepEqual([...SCOPES].sort(), ['architectural', 'cross-ticket', 'local']);
  });
});

// ─── downgradeToLocal() P1 extension point ──────────────────────────────────

describe('open-questions: downgradeToLocal (P1 extension point)', () => {
  it('is exported as a function', () => {
    assert.equal(typeof downgradeToLocal, 'function');
  });

  it('throws a "not implemented" error indicating P1 status', () => {
    assert.throws(
      () => downgradeToLocal('some question', 'some justification'),
      /not implemented|P1/i
    );
  });
});
