'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGateAlreadySatisfied } = require('../gate-resume');

test('isGateAlreadySatisfied returns false when workState is null', () => {
  assert.equal(isGateAlreadySatisfied(null, 'spec_gate'), false);
});

test('isGateAlreadySatisfied returns false when workState is undefined', () => {
  assert.equal(isGateAlreadySatisfied(undefined, 'spec_gate'), false);
});

test('isGateAlreadySatisfied returns false when workState has no stepStatus', () => {
  assert.equal(isGateAlreadySatisfied({}, 'spec_gate'), false);
});

test('isGateAlreadySatisfied returns false when stepStatus is missing the step', () => {
  assert.equal(isGateAlreadySatisfied({ stepStatus: {} }, 'spec_gate'), false);
});

test('isGateAlreadySatisfied returns false when stepStatus is "pending"', () => {
  assert.equal(
    isGateAlreadySatisfied({ stepStatus: { spec_gate: 'pending' } }, 'spec_gate'),
    false
  );
});

test('isGateAlreadySatisfied returns false when stepStatus is "in_progress"', () => {
  assert.equal(
    isGateAlreadySatisfied({ stepStatus: { tasks_gate: 'in_progress' } }, 'tasks_gate'),
    false
  );
});

test('isGateAlreadySatisfied returns true when stepStatus is "completed"', () => {
  assert.equal(
    isGateAlreadySatisfied({ stepStatus: { spec_gate: 'completed' } }, 'spec_gate'),
    true
  );
});

test('isGateAlreadySatisfied returns true for tasks_gate completed', () => {
  assert.equal(
    isGateAlreadySatisfied({ stepStatus: { tasks_gate: 'completed' } }, 'tasks_gate'),
    true
  );
});
