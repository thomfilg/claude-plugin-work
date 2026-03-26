/**
 * Step 1 (ticket) → Step 2 (bootstrap) enforcement checklist.
 *
 * Verifies ALL enforcement rules at the ticket step:
 * - Rule 4: CLI bypass prevention
 * - Rule 5: Output file protection
 * - Rule 3: State file protection
 * - Rule 1: Step command matching
 * - PostToolUse evidence recording
 * - Transition validation (soft step + orchestrator target validation)
 * - Post-transition state verification
 * - Edge cases (fail-open)
 *
 * Run: node --test hooks/__tests__/step-ticket-to-bootstrap.test.js
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

const TEST_TICKET = `STEP1-${process.pid}`;
const TASKS_DIR = path.join(TASKS_BASE, TEST_TICKET);

const ALL_STEPS = [
  'ticket', 'bootstrap', 'brief', 'spec', 'implement', 'quality',
  'commit', 'check', 'test_enhancement', 'pr', 'ready', 'follow_up',
  'ci', 'cleanup', 'reports', 'complete',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function runHook(hookData, hookType = 'PreToolUse', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_HOOK_TYPE: hookType,
        ENFORCE_HOOK_TICKET_ID: TEST_TICKET,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
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

function readState() {
  return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.work-state.json'), 'utf8'));
}

function writeEvidence(evidence) {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, '.step-evidence.json'), JSON.stringify(evidence, null, 2));
}

function readEvidence() {
  try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.step-evidence.json'), 'utf8')); } catch { return {}; }
}

function clearEvidence() {
  try { fs.unlinkSync(path.join(TASKS_DIR, '.step-evidence.json')); } catch {}
}

function readActions() {
  try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.work-actions.json'), 'utf8')); } catch { return []; }
}

function runOrchestrator(args) {
  try {
    const out = execSync(`node ${ORCHESTRATOR_PATH} ${args}`, { encoding: 'utf8', env: { ...process.env }, timeout: 10000 });
    return JSON.parse(out);
  } catch (e) {
    try { return JSON.parse(e.stdout || '{}'); } catch { return { error: true, message: e.message }; }
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Step 1 (ticket) → Step 2 (bootstrap) checklist', () => {

  beforeEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  });

  // ═══ 1. Pre-Step: State Initialization ═══

  describe('1. State initialization', () => {
    it('init creates 16 steps all pending', () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      const st = readState();
      assert.equal(Object.keys(st.stepStatus).length, 16);
      assert.ok(Object.values(st.stepStatus).every(v => v === 'pending'));
      assert.equal(st.status, 'in_progress');
    });

    it('state file created at correct path', () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      assert.ok(fs.existsSync(path.join(TASKS_DIR, '.work-state.json')));
    });
  });

  // ═══ 2. Set ticket to in_progress ═══

  describe('2. Ticket step activation', () => {
    it('ticket is in_progress with 15 pending', () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      const st = readState();
      assert.equal(st.stepStatus.ticket, 'in_progress');
      assert.equal(Object.values(st.stepStatus).filter(v => v === 'pending').length, 15);
    });
  });

  // ═══ 3. Rule 4: CLI bypass (BLOCKED) ═══

  describe('3. Rule 4: CLI bypass blocked', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    it('set-step ticket completed → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} ticket completed` } });
      assert.equal(code, 2);
    });

    it('set-step bootstrap in_progress → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} bootstrap in_progress` } });
      assert.equal(code, 2);
    });

    it('set-check → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-check ${TEST_TICKET} quality ok` } });
      assert.equal(code, 2);
    });

    it('add-error → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} add-error ${TEST_TICKET} ticket "err"` } });
      assert.equal(code, 2);
    });

    it('set-test-enhancement → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-test-enhancement ${TEST_TICKET} skipped true` } });
      assert.equal(code, 2);
    });

    it('chained get + set-step → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} get ${TEST_TICKET} && node ${WORK_STATE_PATH} set-step ${TEST_TICKET} ticket completed` } });
      assert.equal(code, 2);
    });

    it('blocked message includes Direct state mutation', async () => {
      const { stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} ticket completed` } });
      assert.ok(stderr.includes('Direct state mutation'));
    });

    it('blocked message includes transition hint', async () => {
      const { stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} ticket completed` } });
      assert.ok(stderr.includes('transition'));
    });

    it('actions log records rule:4', async () => {
      await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} ticket completed` } });
      const actions = readActions();
      assert.ok(actions.some(a => a.meta?.rule === 4));
    });
  });

  // ═══ 4. Rule 4: Allowed CLI commands ═══

  describe('4. Rule 4: Allowed CLI commands', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    it('get → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} get ${TEST_TICKET}` } });
      assert.equal(code, 0);
    });

    it('resume-info → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} resume-info ${TEST_TICKET}` } });
      assert.equal(code, 0);
    });

    it('init → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} init ${TEST_TICKET}` } });
      assert.equal(code, 0);
    });

    it('active-subtask → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} active-subtask ${TEST_TICKET}` } });
      assert.equal(code, 0);
    });
  });

  // ═══ 5. Rule 5: Output file protection (BLOCKED at ticket) ═══

  describe('5. Rule 5: Output files blocked at ticket step', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    for (const [file, step] of [
      ['brief.md', 'brief'], ['spec.md', 'spec'],
      ['tests.check.md', 'check'], ['code-review.check.md', 'check'],
      ['completion.check.md', 'check'], ['tests-feedback.jsonl', 'test_enhancement'],
    ]) {
      it(`Write ${file} → blocked (owns: ${step})`, async () => {
        const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, file), content: 'x' } });
        assert.equal(code, 2);
      });
    }

    it('Edit brief.md → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), old_string: 'a', new_string: 'b' } });
      assert.equal(code, 2);
    });

    it('Bash redirect > brief.md → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(TASKS_DIR, 'brief.md')}` } });
      assert.equal(code, 2);
    });

    it('blocked message includes owning step', async () => {
      const { stderr } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: 'x' } });
      assert.ok(stderr.includes('brief'));
    });

    it('blocked message includes transition hint', async () => {
      const { stderr } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: 'x' } });
      assert.ok(stderr.includes('transition'));
    });
  });

  // ═══ 6. Rule 5: Allowed file operations ═══

  describe('6. Rule 5: Unprotected files allowed at ticket', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    for (const file of ['implement.md', 'README.md', 'notes.txt']) {
      it(`Write ${file} → allowed`, async () => {
        const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, file), content: 'x' } });
        assert.equal(code, 0);
      });
    }
  });

  // ═══ 7. Rule 3: State file protection (regression) ═══

  describe('7. Rule 3: State file protection', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    for (const file of ['.work-state.json', '.step-evidence.json', '.work-actions.json']) {
      it(`Write ${file} → blocked`, async () => {
        const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, file), content: '{}' } });
        assert.equal(code, 2);
      });
    }

    it('Bash redirect > .work-state.json → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `echo {} > ${path.join(TASKS_DIR, '.work-state.json')}` } });
      assert.equal(code, 2);
    });
  });

  // ═══ 8. Rule 1: Step command matching ═══

  describe('8. Rule 1: Step command matching at ticket', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    it('Task "ticket..." → allowed (matches ticket step)', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { description: 'ticket fetch details', subagent_type: 'general-purpose' } });
      assert.equal(code, 0);
    });

    it('Agent "ticket..." → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Agent', tool_input: { description: 'ticket lookup', subagent_type: 'general-purpose' } });
      assert.equal(code, 0);
    });

    const blockedCommands = [
      ['Task(brief-writer)', { tool_name: 'Task', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } }],
      ['Task(spec-writer)', { tool_name: 'Task', tool_input: { subagent_type: 'spec-writer', description: 'gen spec' } }],
      ['Skill(work-implement)', { tool_name: 'Skill', tool_input: { skill: 'work-implement' } }],
      ['Task(quality-checker)', { tool_name: 'Task', tool_input: { subagent_type: 'quality-checker' } }],
      ['Task(commit-writer)', { tool_name: 'Task', tool_input: { subagent_type: 'commit-writer' } }],
      ['Skill(check)', { tool_name: 'Skill', tool_input: { skill: 'check' } }],
      ['Skill(test-coordination)', { tool_name: 'Skill', tool_input: { skill: 'test-coordination' } }],
      ['Skill(follow-up-pr)', { tool_name: 'Skill', tool_input: { skill: 'follow-up-pr' } }],
      ['Skill(work-pr)', { tool_name: 'Skill', tool_input: { skill: 'work-pr' } }],
      ['Skill(bootstrap)', { tool_name: 'Skill', tool_input: { skill: 'bootstrap' } }],
    ];

    for (const [label, hookData] of blockedCommands) {
      it(`${label} → blocked (wrong step)`, async () => {
        const { code } = await runHook(hookData);
        assert.equal(code, 2);
      });
    }
  });

  // ═══ 9. PostToolUse: Evidence recording ═══

  describe('9. Evidence recording', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      clearEvidence();
    });

    it('PostToolUse creates evidence file', async () => {
      await runHook({ tool_name: 'Task', tool_input: { description: 'ticket fetch', subagent_type: 'general-purpose' } }, 'PostToolUse');
      assert.ok(fs.existsSync(path.join(TASKS_DIR, '.step-evidence.json')));
    });

    it('evidence has ticket.executed = true', async () => {
      await runHook({ tool_name: 'Task', tool_input: { description: 'ticket fetch', subagent_type: 'general-purpose' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(ev.ticket?.executed, true);
    });

    it('only ticket has evidence', async () => {
      await runHook({ tool_name: 'Task', tool_input: { description: 'ticket fetch', subagent_type: 'general-purpose' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(Object.keys(ev).length, 1);
      assert.ok('ticket' in ev);
    });

    it('timestamp is recorded', async () => {
      await runHook({ tool_name: 'Task', tool_input: { description: 'ticket fetch', subagent_type: 'general-purpose' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.ok(ev.ticket?.timestamp);
      assert.ok(!isNaN(Date.parse(ev.ticket.timestamp)));
    });
  });

  // ═══ 10. Transition to bootstrap (soft step) ═══

  describe('10. Transition to bootstrap', () => {
    it('without evidence → allowed (ticket is soft)', async () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      clearEvidence();
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} bootstrap` } });
      assert.equal(code, 0);
    });

    it('with evidence → allowed', async () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      await runHook({ tool_name: 'Task', tool_input: { description: 'ticket fetch', subagent_type: 'general-purpose' } }, 'PostToolUse');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} bootstrap` } });
      assert.equal(code, 0);
    });
  });

  // ═══ 11. Invalid transition targets ═══

  describe('11. Invalid transition targets', () => {
    beforeEach(() => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
    });

    it('hook allows transition command from soft step (orchestrator validates targets)', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 0, 'hook allows — target validation is orchestrator responsibility');
    });

    it('orchestrator rejects ticket→implement', () => {
      const result = runOrchestrator(`transition ${TEST_TICKET} implement`);
      assert.equal(result.error, true);
    });

    it('orchestrator rejects ticket→complete', () => {
      const result = runOrchestrator(`transition ${TEST_TICKET} complete`);
      assert.equal(result.error, true);
    });
  });

  // ═══ 12. Post-transition state ═══

  describe('12. Post-transition state', () => {
    it('after ticket→bootstrap: ticket=completed, bootstrap=in_progress', () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      runOrchestrator(`transition ${TEST_TICKET} bootstrap`);
      const st = readState();
      assert.equal(st.stepStatus.ticket, 'completed');
      assert.equal(st.stepStatus.bootstrap, 'in_progress');
      assert.equal(st.status, 'in_progress');
    });

    it('evidence file preserved after transition', () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      writeEvidence({ ticket: { executed: true, command: 'ticket', tool: 'Task', timestamp: new Date().toISOString() } });
      runOrchestrator(`transition ${TEST_TICKET} bootstrap`);
      assert.ok(fs.existsSync(path.join(TASKS_DIR, '.step-evidence.json')));
    });
  });

  // ═══ 13. Edge cases ═══

  describe('13. Edge cases', () => {
    it('no state file → fail-open', async () => {
      // No init, no state file
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: 'echo hello' } });
      assert.equal(code, 0);
    });

    it('corrupt state JSON → fail-open', async () => {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
      fs.writeFileSync(path.join(TASKS_DIR, '.work-state.json'), 'NOT_JSON');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: 'echo hello' } });
      assert.equal(code, 0);
    });

    it('empty ticket ID → skip all checks', async () => {
      execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
      setState('ticket');
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} ticket completed` } },
        'PreToolUse',
        { ENFORCE_HOOK_TICKET_ID: '' },
      );
      assert.equal(code, 0, 'empty ticket → no enforcement');
    });
  });
});
