'use strict';

/**
 * Tests for the infra-retry step handler.
 *
 * Deliverable 3.1.1 (RED): short-circuit / bypass cases (1-4).
 *  1. WORK_AUTO_RETRY_INFRA unset → return null, no classify call.
 *  2. failureCategory='conflict' → return null, no classify.
 *  3. failureCategory='review_failure' → return null, no classify.
 *  4. classify() returns 'code-failure' → return null.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// Resolve target modules so we can patch them via the require cache.
const STEP_PATH = require.resolve('../lib/steps/infra-retry');
const CLASSIFIER_PATH = require.resolve('../lib/infra-classifier');
const GET_CONFIG_PATH = require.resolve(
  path.resolve(__dirname, '..', '..', 'lib', 'get-config')
);

function loadStep({ envFlag, classifyImpl }) {
  // Clear caches so each test gets a fresh module wired to fresh mocks.
  delete require.cache[STEP_PATH];
  delete require.cache[CLASSIFIER_PATH];
  delete require.cache[GET_CONFIG_PATH];

  const classifyCalls = [];
  const classify = (...args) => {
    classifyCalls.push(args);
    return classifyImpl
      ? classifyImpl(...args)
      : { classification: 'code-failure', signals: [], evidence: {} };
  };

  // Patch the infra-classifier module via cache injection.
  require.cache[CLASSIFIER_PATH] = {
    id: CLASSIFIER_PATH,
    filename: CLASSIFIER_PATH,
    loaded: true,
    exports: { classify, __test__: {} },
  };

  // Patch get-config to control WORK_AUTO_RETRY_INFRA without touching env.
  const getConfig = (key) => {
    if (key === 'WORK_AUTO_RETRY_INFRA') return envFlag;
    return undefined;
  };
  require.cache[GET_CONFIG_PATH] = {
    id: GET_CONFIG_PATH,
    filename: GET_CONFIG_PATH,
    loaded: true,
    exports: getConfig,
  };

  const stepModule = require(STEP_PATH);
  const handlers = Object.create(null);
  const register = (name, fn) => {
    handlers[name] = fn;
  };
  stepModule(register);
  return { handler: handlers['infra-retry'], classifyCalls };
}

describe('infra-retry step — short-circuits and bypasses (RED 3.1.1)', () => {
  it('case 1: WORK_AUTO_RETRY_INFRA unset → returns null and never calls classify', () => {
    const { handler, classifyCalls } = loadStep({ envFlag: undefined });
    const state = { failureCategory: 'ci_failure', infraRetry: { count: 0, attempts: [] } };
    const ctx = {};
    const result = handler(state, ctx);
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 0, 'classify must not be invoked when feature is off');
  });

  it('case 2: failureCategory=conflict → returns null and never calls classify', () => {
    const { handler, classifyCalls } = loadStep({ envFlag: 'true' });
    const state = { failureCategory: 'conflict' };
    const result = handler(state, {});
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 0, 'merge conflicts bypass classifier entirely');
  });

  it('case 3: failureCategory=review_failure → returns null and never calls classify', () => {
    const { handler, classifyCalls } = loadStep({ envFlag: 'true' });
    const state = { failureCategory: 'review_failure' };
    const result = handler(state, {});
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 0, 'review failures bypass classifier entirely');
  });

  it('case 4: classify returns code-failure → returns null (no retry dispatched)', () => {
    const { handler, classifyCalls } = loadStep({
      envFlag: 'true',
      classifyImpl: () => ({ classification: 'code-failure', signals: [], evidence: {} }),
    });
    const state = { failureCategory: 'ci_failure', runId: '12345', infraRetry: { count: 0, attempts: [] } };
    const result = handler(state, {});
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 1, 'classifier must be consulted exactly once');
  });
});
