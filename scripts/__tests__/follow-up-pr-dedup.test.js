const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeCommentHash, deduplicateBlockingBotComments, initState } = require('../follow-up-pr.js');

// ── computeCommentHash ──────────────────────────────────────────────────────

describe('computeCommentHash', () => {
  it('returns a hex string for valid inputs', () => {
    const hash = computeCommentHash('src/index.js', 'Fix this bug');
    assert.match(hash, /^[a-f0-9]+$/);
  });

  it('returns the same hash for identical path + body', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Fix this bug');
    assert.equal(a, b);
  });

  it('returns different hashes for different bodies (same path)', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Rename this variable');
    assert.notEqual(a, b);
  });

  it('returns different hashes for different paths (same body)', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/utils.js', 'Fix this bug');
    assert.notEqual(a, b);
  });

  it('handles null/undefined path gracefully', () => {
    const a = computeCommentHash(null, 'body');
    const b = computeCommentHash(undefined, 'body');
    assert.match(a, /^[a-f0-9]+$/);
    assert.equal(a, b);
  });

  it('handles null/undefined body gracefully', () => {
    const a = computeCommentHash('path', null);
    const b = computeCommentHash('path', undefined);
    assert.match(a, /^[a-f0-9]+$/);
    assert.equal(a, b);
  });

  it('normalizes whitespace so trailing spaces do not affect hash', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Fix this bug  \n');
    assert.equal(a, b);
  });
});

// ── deduplicateBlockingBotComments ──────────────────────────────────────────

describe('deduplicateBlockingBotComments', () => {
  let nextId = 1;
  const makeBotComment = (path, body, overrides = {}) => ({
    id: nextId++,
    author: 'copilot-pull-request-reviewer',
    body,
    path,
    line: 10,
    state: 'COMMENTED',
    priority: 'medium',
    ...overrides,
  });

  const makeHumanComment = (path, body, overrides = {}) => ({
    id: nextId++,
    author: 'octocat',
    body,
    path,
    line: 10,
    state: 'COMMENTED',
    priority: 'high',
    ...overrides,
  });

  it('returns unchanged lists when addressedBotComments is empty', () => {
    const blocking = [makeBotComment('a.js', 'Fix this')];
    const nonBlocking = [];
    const result = deduplicateBlockingBotComments(blocking, nonBlocking, []);
    assert.equal(result.blocking.length, 1);
    assert.equal(result.nonBlocking.length, 0);
  });

  it('moves a previously-addressed bot comment from blocking to nonBlocking', () => {
    const comment = makeBotComment('src/index.js', 'Fix this bug');
    const hash = computeCommentHash('src/index.js', 'Fix this bug');
    const addressed = [{ hash, path: 'src/index.js', author: 'copilot-pull-request-reviewer', snippet: 'Fix this bug' }];

    const result = deduplicateBlockingBotComments([comment], [], addressed);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.nonBlocking.length, 1);
    assert.equal(result.nonBlocking[0].body, 'Fix this bug');
    assert.equal(result.nonBlocking[0].deduplicated, true);
  });

  it('NEVER deduplicates human comments even if hash matches', () => {
    const humanComment = makeHumanComment('src/index.js', 'Fix this bug');
    const hash = computeCommentHash('src/index.js', 'Fix this bug');
    const addressed = [{ hash, path: 'src/index.js', author: 'octocat', snippet: 'Fix this bug' }];

    const result = deduplicateBlockingBotComments([humanComment], [], addressed);
    assert.equal(result.blocking.length, 1, 'human comment must remain blocking');
    assert.equal(result.nonBlocking.length, 0);
  });

  it('keeps new distinct bot comments as blocking', () => {
    const oldHash = computeCommentHash('a.js', 'Old issue');
    const addressed = [{ hash: oldHash, path: 'a.js', author: 'copilot-pull-request-reviewer', snippet: 'Old issue' }];
    const newComment = makeBotComment('a.js', 'New distinct issue');

    const result = deduplicateBlockingBotComments([newComment], [], addressed);
    assert.equal(result.blocking.length, 1, 'new bot comment must remain blocking');
    assert.equal(result.nonBlocking.length, 0);
  });

  it('handles mixed blocking list with bot and human comments', () => {
    const botComment = makeBotComment('src/a.js', 'Bot comment');
    const humanComment = makeHumanComment('src/a.js', 'Human comment');
    const hash = computeCommentHash('src/a.js', 'Bot comment');
    const addressed = [{ hash, path: 'src/a.js', author: 'copilot-pull-request-reviewer', snippet: 'Bot comment' }];

    const result = deduplicateBlockingBotComments([botComment, humanComment], [], addressed);
    assert.equal(result.blocking.length, 1, 'only human comment remains blocking');
    assert.equal(result.blocking[0].author, 'octocat');
    assert.equal(result.nonBlocking.length, 1, 'bot comment moved to nonBlocking');
  });

  it('deduplicates multiple bot comments at once', () => {
    const c1 = makeBotComment('a.js', 'Issue 1');
    const c2 = makeBotComment('b.js', 'Issue 2');
    const h1 = computeCommentHash('a.js', 'Issue 1');
    const h2 = computeCommentHash('b.js', 'Issue 2');
    const addressed = [
      { hash: h1, path: 'a.js', author: 'copilot-pull-request-reviewer', snippet: 'Issue 1' },
      { hash: h2, path: 'b.js', author: 'copilot-pull-request-reviewer', snippet: 'Issue 2' },
    ];

    const result = deduplicateBlockingBotComments([c1, c2], [], addressed);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.nonBlocking.length, 2);
  });

  it('preserves existing nonBlocking items', () => {
    const existingNonBlocking = [makeBotComment('c.js', 'nitpick', { priority: 'low' })];
    const botComment = makeBotComment('a.js', 'Fix this');
    const hash = computeCommentHash('a.js', 'Fix this');
    const addressed = [{ hash, path: 'a.js', author: 'copilot-pull-request-reviewer', snippet: 'Fix this' }];

    const result = deduplicateBlockingBotComments([botComment], existingNonBlocking, addressed);
    assert.equal(result.nonBlocking.length, 2, 'existing + deduplicated');
  });

  it('works with cursor-ai[bot] comments', () => {
    const comment = makeBotComment('x.js', '**severity**: medium\nFix this', { author: 'cursor-ai[bot]' });
    const hash = computeCommentHash('x.js', '**severity**: medium\nFix this');
    const addressed = [{ hash, path: 'x.js', author: 'cursor-ai[bot]', snippet: '**severity**: medium' }];

    const result = deduplicateBlockingBotComments([comment], [], addressed);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.nonBlocking.length, 1);
  });

  it('returns original arrays when no addressed hashes match', () => {
    const comment = makeBotComment('a.js', 'New issue');
    const addressed = [{ hash: 'deadbeef', path: 'other.js', author: 'copilot-pull-request-reviewer', snippet: 'old' }];

    const result = deduplicateBlockingBotComments([comment], [], addressed);
    assert.equal(result.blocking.length, 1);
    assert.equal(result.nonBlocking.length, 0);
  });
});

// ── initState with addressedBotComments ─────────────────────────────────────

describe('initState includes addressedBotComments', () => {
  it('has addressedBotComments as an empty array', () => {
    const state = initState({ number: 42, url: 'https://github.com/test/42', branch: 'feature' });
    assert.ok(Array.isArray(state.addressedBotComments));
    assert.equal(state.addressedBotComments.length, 0);
  });
});
