/**
 * dispatch.test.js — G6 priority chain through the public `initExtensions` API.
 *
 * Verifies:
 *   - Multiple handlers per event run in priority-descending order.
 *   - Equal priority uses lexical filename ascending as tiebreaker.
 *   - `passthrough` continues the chain (each handler in sequence still runs).
 *   - Dispatch awaits async handlers in order.
 *
 * Covers Task 11 acceptance criteria (G6, R9).
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadFreshIndex,
  makeTempRepo,
  makeExtensionsDir,
  writeExtension,
  cleanup,
} = require('./_fixtures');

const created = [];
afterEach(() => {
  while (created.length) {
    cleanup(created.pop());
  }
});

function freshRepo() {
  const r = makeTempRepo('dispatch-test-');
  created.push(r.root);
  return r;
}

/** Build an extension body that appends a tag to a shared sentinel JSON array. */
function appenderExt(sentinelPath, tag, priority) {
  return `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: ${priority},
  handler: (payload, ctx) => {
    const order = JSON.parse(fs.readFileSync(${JSON.stringify(sentinelPath)}, 'utf8'));
    order.push(${JSON.stringify(tag)});
    fs.writeFileSync(${JSON.stringify(sentinelPath)}, JSON.stringify(order));
    ctx.passthrough();
  },
};`;
}

describe('dispatch — G6 priority chain through initExtensions', () => {
  it('runs handlers in priority-descending order across multiple extensions', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    const sentinel = `${root}/order.json`;
    require('node:fs').writeFileSync(sentinel, '[]');

    // priority 10 (lowest), 50 (default-ish), 90 (highest)
    writeExtension(extDir, 'low.js', appenderExt(sentinel, 'low-10', 10));
    writeExtension(extDir, 'mid.js', appenderExt(sentinel, 'mid-50', 50));
    writeExtension(extDir, 'high.js', appenderExt(sentinel, 'high-90', 90));

    const api = initExtensions({ repoRoot: root, tasksDir });
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });

    const order = JSON.parse(require('node:fs').readFileSync(sentinel, 'utf8'));
    assert.deepEqual(order, ['high-90', 'mid-50', 'low-10']);
  });

  it('breaks priority ties by lexical filename ascending', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    const sentinel = `${root}/tiebreak.json`;
    require('node:fs').writeFileSync(sentinel, '[]');

    // Same priority — must order by filename ascending: a, b, c.
    writeExtension(extDir, 'c-third.js', appenderExt(sentinel, 'c', 50));
    writeExtension(extDir, 'a-first.js', appenderExt(sentinel, 'a', 50));
    writeExtension(extDir, 'b-second.js', appenderExt(sentinel, 'b', 50));

    const api = initExtensions({ repoRoot: root, tasksDir });
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });

    const order = JSON.parse(require('node:fs').readFileSync(sentinel, 'utf8'));
    assert.deepEqual(order, ['a', 'b', 'c']);
  });

  it('passthrough continues the chain — every subsequent handler still runs', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    const sentinel = `${root}/chain.json`;
    require('node:fs').writeFileSync(sentinel, '[]');

    writeExtension(extDir, 'h1.js', appenderExt(sentinel, 'h1', 70));
    writeExtension(extDir, 'h2.js', appenderExt(sentinel, 'h2', 60));
    writeExtension(extDir, 'h3.js', appenderExt(sentinel, 'h3', 50));

    const api = initExtensions({ repoRoot: root, tasksDir });
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });

    const order = JSON.parse(require('node:fs').readFileSync(sentinel, 'utf8'));
    assert.deepEqual(order, ['h1', 'h2', 'h3']);
  });

  it('awaits async handlers in priority order', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    const sentinel = `${root}/async.json`;
    require('node:fs').writeFileSync(sentinel, '[]');

    writeExtension(
      extDir,
      'slow-high.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: 90,
  handler: async (payload, ctx) => {
    await new Promise((r) => setTimeout(r, 15));
    const o = JSON.parse(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));
    o.push('slow-high');
    fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(o));
  },
};`
    );
    writeExtension(
      extDir,
      'fast-low.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: 10,
  handler: (payload, ctx) => {
    const o = JSON.parse(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));
    o.push('fast-low');
    fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(o));
  },
};`
    );

    const api = initExtensions({ repoRoot: root, tasksDir });
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });

    const order = JSON.parse(require('node:fs').readFileSync(sentinel, 'utf8'));
    // Even though fast-low is synchronous, the dispatcher must await slow-high first.
    assert.deepEqual(order, ['slow-high', 'fast-low']);
  });
});
