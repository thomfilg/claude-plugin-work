/**
 * Step 4 (spec) → Step 5 (implement) enforcement checklist.
 *
 * Spec is the second ENFORCED step with output file requirement.
 * Verifies:
 * - spec requires evidence + spec.md (compound evidence)
 * - spec.md can only be written at spec step
 * - Skill(work-implement) blocked at spec step
 * - After transition: implement step allows Skill(work-implement)
 * - TDD gating awareness (implement is TDD-gated when WORK_TDD_ENFORCE=1)
 *
 * Run: node --test hooks/__tests__/spec-implement.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-step-workflow.js');
const ORCHESTRATOR_PATH = path.join(__dirname, '..', 'work-orchestrator.js');
const WORK_STATE_PATH = path.join(__dirname, '..', 'work-state.js');
const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
const TASKS_BASE = getConfig.require('TASKS_BASE');

const TEST_TICKET = `STEP4-${process.pid}`;
const TASKS_DIR = path.join(TASKS_BASE, TEST_TICKET);

const ALL_STEPS = [
  'ticket', 'bootstrap', 'brief', 'spec', 'implement', 'quality',
  'commit', 'check', 'test_enhancement', 'pr', 'ready', 'follow_up',
  'ci', 'cleanup', 'reports', 'complete',
];

function runHook(hookData, hookType = 'PreToolUse', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_HOOK_TYPE: hookType, ENFORCE_HOOK_TICKET_ID: TEST_TICKET, ...env },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { resolve({ code, stdout, stderr }); });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

function setState(currentStep) {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
  const stateFile = path.join(TASKS_DIR, '.work-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {
    state = { ticketId: TEST_TICKET, description: 'test', currentStep: 1, status: 'in_progress', stepStatus: {}, checkProgress: {}, testEnhancement: { initialRating: 0, finalRating: 0, iterations: 0, skipped: false, skipReason: null }, errors: [], startTime: new Date().toISOString(), lastUpdate: new Date().toISOString() };
  }
  const idx = ALL_STEPS.indexOf(currentStep);
  state.stepStatus = {};
  ALL_STEPS.forEach((s, i) => { state.stepStatus[s] = i < idx ? 'completed' : i === idx ? 'in_progress' : 'pending'; });
  state.status = 'in_progress';
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function clearEvidence() { try { fs.unlinkSync(path.join(TASKS_DIR, '.step-evidence.json')); } catch {} }
function readEvidence() { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.step-evidence.json'), 'utf8')); } catch { return {}; } }

describe('Step 4 (spec) → Step 5 (implement) checklist', () => {

  beforeEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
    setState('spec');
  });

  afterEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  });

  // ═══ 1. Spec compound evidence ═══

  describe('1. Spec requires evidence + spec.md', () => {
    it('no evidence, no file → blocked', async () => {
      clearEvidence();
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 2);
    });

    it('evidence only, no spec.md → blocked', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'spec-writer' } }, 'PostToolUse');
      const { code, stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 2);
      assert.ok(stderr.includes('spec.md'));
    });

    it('file only, no evidence → blocked', async () => {
      clearEvidence();
      fs.writeFileSync(path.join(TASKS_DIR, 'spec.md'), '# Spec');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 2);
    });

    it('evidence + spec.md → allowed', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'spec-writer' } }, 'PostToolUse');
      fs.writeFileSync(path.join(TASKS_DIR, 'spec.md'), '# Spec\n## Architecture');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 0);
    });
  });

  // ═══ 2. Output protection ═══

  describe('2. Output protection at spec step', () => {
    it('spec.md at spec → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'spec.md'), content: '# Spec' } });
      assert.equal(code, 0);
    });

    it('spec.md at OTHER step → blocked', async () => {
      setState('implement');
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'spec.md'), content: 'tamper' } });
      assert.equal(code, 2);
    });

    it('brief.md at spec → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: 'x' } });
      assert.equal(code, 2);
    });
  });

  // ═══ 3. Step commands at spec ═══

  describe('3. Step commands at spec', () => {
    it('Task(spec-writer) → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'spec-writer' } });
      assert.equal(code, 0);
    });

    it('Task "spec ..." → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { description: 'spec technical analysis', subagent_type: 'general-purpose' } });
      assert.equal(code, 0);
    });

    it('Skill(work-implement) → blocked (wrong step)', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } });
      assert.equal(code, 2);
    });

    it('Task(commit-writer) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'commit-writer' } });
      assert.equal(code, 2);
    });
  });

  // ═══ 4. After transition: implement step ═══

  describe('4. At implement step', () => {
    beforeEach(() => { setState('implement'); });

    it('Skill(work-implement) → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } });
      assert.equal(code, 0);
    });

    it('Task(spec-writer) → blocked (wrong step)', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'spec-writer' } });
      assert.equal(code, 2);
    });

    it('spec.md protected at implement → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'spec.md'), content: 'tamper' } });
      assert.equal(code, 2);
    });

    it('brief.md protected at implement → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: 'tamper' } });
      assert.equal(code, 2);
    });

    it('evidence recorded for Skill(work-implement)', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(ev.implement?.executed, true);
    });

    it('transition to quality with evidence → allowed', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } }, 'PostToolUse');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} quality` } });
      assert.equal(code, 0);
    });

    it('transition to quality without evidence → blocked', async () => {
      clearEvidence();
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} quality` } });
      assert.equal(code, 2);
    });
  });

  // ═══ 5. CLI bypass still blocked ═══

  describe('5. CLI bypass', () => {
    it('set-step at spec → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} spec completed` } });
      assert.equal(code, 2);
    });

    it('set-step at implement → blocked', async () => {
      setState('implement');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} implement completed` } });
      assert.equal(code, 2);
    });
  });
});
