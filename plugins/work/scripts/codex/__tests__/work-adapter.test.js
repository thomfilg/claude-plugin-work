const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../work-adapter');

describe('work-adapter', () => {
  it('normalizes runner JSON into dry-run shell instructions', () => {
    const instruction = {
      type: 'work_instruction',
      action: 'execute',
      delegate: {
        type: 'bash',
        description: 'say hello',
        command: 'echo hello',
      },
    };

    const normalized = adapter.normalizeRunnerInstruction(instruction, { dryRun: true });

    assert.equal(normalized.action, 'run_shell');
    assert.equal(normalized.command, 'echo hello');
  });

  it('parses Claude Task(...) text into dispatch_agent', () => {
    const instruction = {
      type: 'work_instruction',
      action: 'execute',
      delegate: {
        type: 'task',
        prompt:
          'Task(description: "Review", subagent_type: "code-checker", prompt: "Review the diff")',
      },
    };

    const normalized = adapter.normalizeRunnerInstruction(instruction, { dryRun: true });

    assert.equal(normalized.action, 'dispatch_agent');
    assert.equal(normalized.agent, 'code-checker');
    assert.equal(normalized.description, 'Review');
    assert.equal(normalized.prompt, 'Review the diff');
    assert.ok(normalized.resultFileShape);
  });

  it('parses Claude Skill(...) text into dispatch_skill', () => {
    const instruction = {
      type: 'work_instruction',
      action: 'execute',
      delegate: {
        type: 'skill',
        prompt: 'Skill(name: "tests-review", arguments: "GH-123")',
      },
    };

    const normalized = adapter.normalizeRunnerInstruction(instruction, { dryRun: true });

    assert.equal(normalized.action, 'dispatch_skill');
    assert.equal(normalized.skill, 'tests-review');
    assert.equal(normalized.arguments, 'GH-123');
    assert.ok(normalized.resultFileShape);
  });

  it('blocks destructive shell commands', () => {
    const instruction = {
      type: 'work_instruction',
      action: 'execute',
      delegate: {
        type: 'bash',
        command: 'git push origin HEAD',
      },
    };

    const normalized = adapter.normalizeRunnerInstruction(instruction, { dryRun: false });

    assert.equal(normalized.action, 'blocked');
    assert.match(normalized.reason, /destructive/i);
  });

  it('resolves plugin root from CODEX_PLUGIN_ROOT before CLAUDE_PLUGIN_ROOT', () => {
    const root = adapter.resolvePluginRoot(
      {
        CODEX_PLUGIN_ROOT: '/tmp/codex-root',
        CLAUDE_PLUGIN_ROOT: '/tmp/claude-root',
      },
      '/tmp/ignored/scripts/codex'
    );

    assert.equal(root, path.resolve('/tmp/codex-root'));
  });

  it('falls back from CLAUDE_PLUGIN_ROOT to filesystem location', () => {
    assert.equal(
      adapter.resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: '/tmp/claude-root' }, '/tmp/x/scripts/codex'),
      path.resolve('/tmp/claude-root')
    );
    assert.equal(
      adapter.resolvePluginRoot({}, '/tmp/plugin/scripts/codex'),
      path.resolve('/tmp/plugin')
    );
  });
});
