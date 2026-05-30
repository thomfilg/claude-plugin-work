'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InvertedIndex, tokenize } = require('../consolidate-engine/inverted-index');
const walker = require('../consolidate-engine/markdown-walker');

test('tokenize: lowercases, drops stopwords and short tokens', () => {
  const tokens = tokenize('The Quick brown fox is a, then.');
  // 'the','is','a','then' are stopwords; nothing under 3 chars survives.
  assert.deepEqual(tokens, ['quick', 'brown', 'fox']);
});

test('tokenize: empty / non-string returns []', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('InvertedIndex: topK ranks distinguishing terms above shared ones', () => {
  const idx = new InvertedIndex();
  idx.add('button', 'interactive button primitive for forms');
  idx.add('input', 'text input primitive for forms');
  idx.add('table', 'tabular data display for grids');
  idx.finalize();

  // "button" appears only in the Button doc -> high IDF -> top of list.
  const top = idx.topK('button', 3);
  assert.ok(top.includes('button'), `expected 'button' in top-3, got ${top.join(',')}`);
  // "forms" appears in 2/3 -> non-distinguishing but still present below.
  // "primitive" appears in 2/3 likewise.
});

test('InvertedIndex: terms present in every doc are filtered out (zero signal)', () => {
  const idx = new InvertedIndex();
  idx.add('a', 'shared shared');
  idx.add('b', 'shared shared');
  idx.finalize();
  // "shared" is in every doc -> filtered.
  const top = idx.topK('a', 5);
  assert.deepEqual(top, [], `expected no terms when all are shared, got ${top.join(',')}`);
});

test('InvertedIndex: topK before finalize throws', () => {
  const idx = new InvertedIndex();
  idx.add('a', 'foo bar baz');
  assert.throws(() => idx.topK('a', 3), /finalize/);
});

test('InvertedIndex: add after finalize throws', () => {
  const idx = new InvertedIndex();
  idx.add('a', 'foo');
  idx.finalize();
  assert.throws(() => idx.add('b', 'bar'), /finalize/);
});

test('InvertedIndex: duplicate docId throws', () => {
  const idx = new InvertedIndex();
  idx.add('a', 'foo');
  assert.throws(() => idx.add('a', 'bar'), /duplicate/);
});

test('InvertedIndex: ties broken alphabetically for determinism', () => {
  const idx = new InvertedIndex();
  // Two unique terms with identical tf=1 in only this doc -> identical idf+tf.
  idx.add('a', 'zebra apple');
  idx.add('b', 'unique-b');
  idx.finalize();
  const top = idx.topK('a', 2);
  // 'apple' before 'zebra' alphabetically when scores tie.
  assert.deepEqual(top, ['apple', 'zebra']);
});

test('markdown-walker: H3 boundaries with bold-prefixed fields', () => {
  const text = [
    '# Title',
    '## Section',
    '### Alpha',
    '**Purpose**: First component.',
    '**Location**: `path/to/Alpha`',
    '',
    '### Beta',
    '**Purpose**: Second component.',
    '**Location**: `path/to/Beta`',
  ].join('\n');

  const items = walker.walk(text, {
    itemHeadingLevel: 3,
    fields: [
      { label: 'Purpose', key: 'purpose' },
      { label: 'Location', key: 'location', stripBackticks: true },
    ],
  });

  assert.equal(items.length, 2, `expected 2 items, got ${items.length}`);
  assert.equal(items[0].name, 'Alpha');
  assert.equal(items[0].fields.purpose, 'First component.');
  assert.equal(items[0].fields.location, 'path/to/Alpha');
  assert.equal(items[1].name, 'Beta');
  assert.equal(items[1].fields.location, 'path/to/Beta');
});

test('markdown-walker: ignores headings inside fenced code blocks', () => {
  const text = [
    '### Real',
    '**Purpose**: keep.',
    '',
    '```md',
    '### NotReal',
    '**Purpose**: should be ignored.',
    '```',
    '',
    '### Another',
    '**Purpose**: keep.',
  ].join('\n');

  const items = walker.walk(text, {
    itemHeadingLevel: 3,
    fields: [{ label: 'Purpose', key: 'purpose' }],
  });

  const names = items.map((i) => i.name);
  assert.deepEqual(names, ['Real', 'Another'], `got ${names.join(',')}`);
});

test('markdown-walker: empty / non-string returns []', () => {
  assert.deepEqual(walker.walk('', { itemHeadingLevel: 3, fields: [] }), []);
});

test('markdown-walker: invalid itemHeadingLevel throws', () => {
  assert.throws(() => walker.walk('### x', { itemHeadingLevel: 0, fields: [] }), /1\.\.6/);
  assert.throws(() => walker.walk('### x', { itemHeadingLevel: 7, fields: [] }), /1\.\.6/);
});

test('markdown-walker: body includes raw section lines (for downstream indexing)', () => {
  const text = '### Foo\n**Purpose**: A\nExtra note line.\n';
  const items = walker.walk(text, {
    itemHeadingLevel: 3,
    fields: [{ label: 'Purpose', key: 'purpose' }],
  });
  assert.equal(items.length, 1);
  assert.ok(items[0].body.includes('Extra note line.'), `body=${items[0].body}`);
});
