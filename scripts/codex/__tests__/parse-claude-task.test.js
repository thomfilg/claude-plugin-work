const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const { parseClaudeTask, parseClaudeTasks, toCodexAgentDelegate } = require(
  path.join(repoRoot, 'plugins', 'work', 'scripts', 'codex', 'parse-claude-task.js')
);

describe('parse-claude-task', () => {
  it('parses a single-line Task(...) with equals separators', () => {
    const task = parseClaudeTask(
      'Task(description="Review changes", prompt="Check the diff", subagent_type="code-checker")'
    );

    assert.deepStrictEqual(toCodexAgentDelegate(task), {
      type: 'codex_agent',
      agent: 'code-checker',
      description: 'Review changes',
      prompt: 'Check the diff',
      source: 'claude-task',
    });
  });

  it('parses a multiline Task(...) with colon separators', () => {
    const task = parseClaudeTask(`Task(
  description: 'Run QA',
  subagent_type: "work-workflow:qa-feature-tester",
  prompt: \`Open the app.
Run the smoke suite.\`
)`);

    assert.strictEqual(task.agent, 'qa-feature-tester');
    assert.strictEqual(task.description, 'Run QA');
    assert.strictEqual(task.prompt, 'Open the app.\nRun the smoke suite.');
  });

  it('parses multiple Task(...) calls in one input', () => {
    const tasks = parseClaudeTasks(`
Task(description: "One", subagent_type: "brief-writer", prompt: "Draft brief")
Task(description: "Two", subagent_type: "spec-writer", prompt: "Draft spec")
`);

    assert.deepStrictEqual(
      tasks.map((task) => task.agent),
      ['brief-writer', 'spec-writer']
    );
  });

  it('preserves quoted strings with commas inside prompt text', () => {
    const task = parseClaudeTask(
      'Task(description: "Commit", subagent_type: "commit-writer", prompt: "Commit foo, bar, and baz")'
    );

    assert.strictEqual(task.prompt, 'Commit foo, bar, and baz');
  });

  it('parses shorthand Task(agent): prompt blocks found in skills', () => {
    const task = parseClaudeTask(`Task(brief-writer):
  Generate a product brief.
  Include constraints, risks, and open questions.

Next step.`);

    assert.strictEqual(task.agent, 'brief-writer');
    assert.strictEqual(
      task.prompt,
      'Generate a product brief.\nInclude constraints, risks, and open questions.'
    );
    assert.strictEqual(toCodexAgentDelegate(task).type, 'codex_agent');
  });

  it('throws a clear error when subagent_type is missing', () => {
    assert.throws(
      () => parseClaudeTask('Task(description: "No agent", prompt: "Do work")'),
      /missing required field\(s\): subagent_type/
    );
  });

  it('throws a clear error when prompt is missing', () => {
    assert.throws(
      () => parseClaudeTask('Task(description: "No prompt", subagent_type: "code-checker")'),
      /missing required field\(s\): prompt/
    );
  });

  it('throws a clear error when no Task call is found', () => {
    assert.throws(() => parseClaudeTasks('No delegation here'), /no Task\(\.\.\.\) call found/);
  });
});
