'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderStatus, resolveSessionId } = require('../scripts/synapsys-recall.js');
const cortexHook = require('../lib/cortex-hook.js');

test('renderStatus lists each query string and its result count', () => {
  const cache = {
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [{ id: 'm1' }, { id: 'm2' }],
        ranAt: '2026-06-10T00:00:00.000Z',
      },
      {
        query: 'cortex recall keywords',
        projectId: 'claude-plugin-work',
        results: [{ id: 'm3' }],
        ranAt: '2026-06-10T00:00:01.000Z',
      },
    ],
  };

  const out = renderStatus(cache);
  const lines = out.split('\n').filter(Boolean);

  // One line per query record.
  assert.equal(lines.length, 2);

  // Each line shows the query string and its result count.
  assert.match(out, /GH-519/);
  assert.match(out, /\b2\b/);
  assert.match(out, /cortex recall keywords/);
  assert.match(out, /\b1\b/);
});

test('renderStatus prints a clear message when no cache exists', () => {
  assert.match(renderStatus(null), /no auto-recall this session/i);
  assert.match(renderStatus(undefined), /no auto-recall this session/i);
  assert.match(renderStatus({ queries: [] }), /no auto-recall this session/i);
});

test('recall CLI and cortex hook resolve the SAME session id for an env-sourced id', () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'env-session-abc';
  try {
    const payload = { session_id: 'payload-should-be-overridden' };
    const cliId = resolveSessionId({ payload });
    const hookId = cortexHook.sessionIdOf(payload);
    assert.equal(cliId, 'env-session-abc');
    assert.equal(cliId, hookId);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

test('recall CLI and cortex hook resolve the SAME session id from payload.session_id', () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const payload = { session_id: 'payload-xyz_123' };
    const cliId = resolveSessionId({ payload });
    const hookId = cortexHook.sessionIdOf(payload);
    assert.equal(cliId, 'payload-xyz_123');
    assert.equal(cliId, hookId);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});
