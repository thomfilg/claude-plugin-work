/**
 * error-isolation.test.js — G5 + G7 through the public `initExtensions` API.
 *
 * Verifies:
 *   - G5: a sync handler throw is caught, error logged, and subsequent handlers
 *     in the priority chain still run (treated as passthrough).
 *   - G5: dispatch itself never rejects when a handler throws (R6).
 *   - G7: a PhaseNotReadyError thrown from a handler that invoked a Phase 2 ctx
 *     method is caught and treated as passthrough; phase context surfaces in
 *     the logged error.
 *
 * Covers Task 11 acceptance criteria (G5, G7, R6).
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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
  const r = makeTempRepo('err-iso-test-');
  created.push(r.root);
  return r;
}

/**
 * Capture stderr writes for the duration of `fn`.
 * Restored even when `fn` throws.
 * @param {() => Promise<void>} fn
 * @returns {Promise<string>}
 */
async function withStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (buf) => {
    chunks.push(String(buf));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

describe('error isolation — G5 sync handler throw caught', () => {
  it('catches a throwing handler and runs subsequent handlers in the chain', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    const sentinel = `${root}/chain.json`;
    fs.writeFileSync(sentinel, '[]');

    // Highest priority — throws.
    writeExtension(
      extDir,
      'a-boom.js',
      `module.exports = {
  events: ['OnTicketResolved'],
  priority: 90,
  handler: () => { throw new Error('boom from a-boom'); },
};`
    );
    // Middle priority — records and continues.
    writeExtension(
      extDir,
      'b-mid.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: 50,
  handler: () => {
    const o = JSON.parse(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));
    o.push('b-mid');
    fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(o));
  },
};`
    );
    // Lowest priority — records.
    writeExtension(
      extDir,
      'c-low.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: 10,
  handler: () => {
    const o = JSON.parse(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));
    o.push('c-low');
    fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(o));
  },
};`
    );

    const api = initExtensions({ repoRoot: root, tasksDir });

    const stderr = await withStderr(async () => {
      await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
    });

    // The chain must continue past the throw.
    const order = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    assert.deepEqual(order, ['b-mid', 'c-low']);

    // The error must be logged (stderr warn line).
    assert.match(stderr, /boom from a-boom/);
    assert.match(stderr, /OnTicketResolved/);
  });

  it('dispatch never rejects even when every handler throws', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);

    writeExtension(
      extDir,
      'boom-1.js',
      `module.exports = {
  events: ['OnTicketResolved'],
  handler: () => { throw new Error('boom 1'); },
};`
    );
    writeExtension(
      extDir,
      'boom-2.js',
      `module.exports = {
  events: ['OnTicketResolved'],
  handler: () => { throw new Error('boom 2'); },
};`
    );

    const api = initExtensions({ repoRoot: root, tasksDir });

    let rejected = false;
    await withStderr(async () => {
      try {
        await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
      } catch {
        rejected = true;
      }
    });

    assert.equal(rejected, false, 'dispatch must never reject when a handler throws');
  });
});

describe('error isolation — G7 PhaseNotReadyError caught as passthrough', () => {
  it('Handler runtime error is caught and treated as passthrough', async () => {
    // This title verbatim covers the task-next scenario:
    // "Handler runtime error is caught and treated as passthrough".
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    const sentinel = `${root}/after-phase.json`;
    fs.writeFileSync(sentinel, '[]');

    // Handler calls a Phase 2 method → PhaseNotReadyError thrown.
    writeExtension(
      extDir,
      'a-phase2.js',
      `module.exports = {
  events: ['OnTicketResolved'],
  priority: 90,
  handler: (payload, ctx) => {
    // Phase 2 method must throw PhaseNotReadyError in Phase 1.
    ctx.handled({ result: 'nope' });
  },
};`
    );
    // Subsequent handler still records — proving the throw was treated as passthrough.
    writeExtension(
      extDir,
      'b-after.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: 10,
  handler: () => {
    const o = JSON.parse(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));
    o.push('after-phase2');
    fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(o));
  },
};`
    );

    const api = initExtensions({ repoRoot: root, tasksDir });

    const stderr = await withStderr(async () => {
      await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
    });

    const order = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    assert.deepEqual(order, ['after-phase2'], 'subsequent handler must run after PhaseNotReadyError');

    // Phase context surfaces — either the error name or the Phase 2 marker.
    assert.match(stderr, /Phase 2|PhaseNotReadyError|ctx\.handled/);
  });

  it('catches an explicit PhaseNotReadyError throw from a handler', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);

    writeExtension(
      extDir,
      'phase-throw.js',
      `module.exports = {
  events: ['OnTicketResolved'],
  handler: () => {
    const err = new Error('Phase 2 method ctx.block() not available');
    err.name = 'PhaseNotReadyError';
    throw err;
  },
};`
    );

    const api = initExtensions({ repoRoot: root, tasksDir });

    let rejected = false;
    const stderr = await withStderr(async () => {
      try {
        await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
      } catch {
        rejected = true;
      }
    });

    assert.equal(rejected, false, 'PhaseNotReadyError from a handler must not reject dispatch');
    assert.match(stderr, /Phase 2|PhaseNotReadyError/);
  });
});
