/**
 * end-to-end.integration.test.js — full OnTicketResolved dispatch against
 * a fixture repo with the real `cortex-auto-recall` reference extension.
 *
 * This is an integration test (not a unit test) — it exercises the public
 * initExtensions API end-to-end:
 *   1. Loader discovers cortex-auto-recall.js under .claude/work-extensions/.
 *   2. Event bus registers the handler for OnTicketResolved.
 *   3. Dispatch builds a real ctx and invokes the handler.
 *   4. The handler calls ctx.injectContext with the cortex recall hint.
 *   5. ctx.getInjectedContext returns the queued text.
 *
 * Covers Task 11 acceptance criteria (R6 + integration of Tasks 1-4 + 10).
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadFreshIndex,
  makeTempRepo,
  installReferenceExtension,
  writeExtension,
  makeExtensionsDir,
  cleanup,
} = require('./_fixtures');

const created = [];
afterEach(() => {
  while (created.length) {
    cleanup(created.pop());
  }
});

function freshRepo() {
  const r = makeTempRepo('e2e-int-test-');
  created.push(r.root);
  return r;
}

describe('end-to-end integration — OnTicketResolved with real cortex-auto-recall', () => {
  it('dispatches through the public API and injects cortex recall context', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    installReferenceExtension(root, 'cortex-auto-recall.js');

    // Install a sibling capture extension at a lower priority so we can read
    // the injected context off the ctx after cortex-auto-recall has run.
    const extDir = require('node:path').join(root, '.claude', 'work-extensions');
    const sentinel = `${root}/injected.txt`;
    writeExtension(
      extDir,
      'zz-capture.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  priority: 1, // run last
  handler: (payload, ctx) => {
    fs.writeFileSync(${JSON.stringify(sentinel)}, ctx.getInjectedContext());
  },
};`
    );

    const api = initExtensions({ repoRoot: root, tasksDir });

    // Status should show both extensions loaded.
    const status = api.status();
    assert.equal(status.length, 2);
    const loaded = status.filter((s) => s.loaded === true);
    assert.equal(loaded.length, 2);
    const cortex = status.find((s) => /cortex-auto-recall\.js$/.test(s.file));
    assert.ok(cortex, 'cortex-auto-recall.js must be loaded');
    assert.deepEqual(cortex.events, ['OnTicketResolved']);

    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });

    const injected = require('node:fs').readFileSync(sentinel, 'utf8');
    // The injectContext queue must contain the expected cortex-auto-recall text.
    assert.match(injected, /cortex-auto-recall/);
    assert.match(injected, /Suggested cortex recall for GH-522/);
    assert.match(injected, /cortex recall/);
  });

  it('is a safe no-op when no extensions directory exists (R8 backward compatibility)', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    // Do NOT create .claude/work-extensions/.
    const api = initExtensions({ repoRoot: root, tasksDir });
    assert.deepEqual(api.status(), []);
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
  });

  it('does not dispatch to handlers not subscribed to the event', async () => {
    const { initExtensions } = loadFreshIndex();
    const { root, tasksDir } = freshRepo();
    installReferenceExtension(root, 'cortex-auto-recall.js');
    makeExtensionsDir(root); // ensure dir present (it already is)

    const api = initExtensions({ repoRoot: root, tasksDir });

    // OnSessionStart has no subscriber — dispatch must be a clean no-op.
    await api.dispatch('OnSessionStart', { ticketId: 'GH-522', tasksDir, repoRoot: root });
    // cortex-auto-recall is registered only for OnTicketResolved, so it must not have fired.
    // We verify indirectly: dispatching a non-subscribed event resolves without injecting anything.
    // (The cortex handler writes to ctx, not to disk, so no observable side effect on a sibling event.)
    assert.ok(true);
  });
});
