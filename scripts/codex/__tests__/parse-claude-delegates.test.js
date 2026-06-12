const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const parser = require(
  path.join(repoRoot, 'plugins', 'work', 'scripts', 'codex', 'parse-claude-delegates.js')
);

describe('parse-claude-delegates', () => {
  it('parses a single-line Task(...)', () => {
    const task = parser.parseClaudeTask(
      'Task(description="Review changes", prompt="Check the diff", subagent_type="code-checker")'
    );

    assert.deepStrictEqual(parser.toCodexAgentDelegate(task), {
      type: 'codex_agent',
      agent: 'code-checker',
      description: 'Review changes',
      prompt: 'Check the diff',
      source: 'claude-task',
    });
  });

  it('parses a multiline Task(...)', () => {
    const task = parser.parseClaudeTask(`Task(
  description: 'Run QA',
  subagent_type: "work-workflow:qa-feature-tester",
  prompt: \`Open the app.
Run the smoke suite.\`
)`);

    assert.strictEqual(task.agent, 'qa-feature-tester');
    assert.strictEqual(task.description, 'Run QA');
    assert.strictEqual(task.prompt, 'Open the app.\nRun the smoke suite.');
  });

  it('parses multiple Task(...) calls', () => {
    const tasks = parser.parseClaudeTasks(`
Task(description: "One", subagent_type: "brief-writer", prompt: "Draft brief")
Task(description: "Two", subagent_type: "spec-writer", prompt: "Draft spec")
`);

    assert.deepStrictEqual(
      tasks.map((task) => task.agent),
      ['brief-writer', 'spec-writer']
    );
  });

  it('parses a single-line Skill(...)', () => {
    const skill = parser.parseClaudeSkill('Skill(name="tests-review", arguments="GH-123")');

    assert.deepStrictEqual(parser.toCodexSkillDelegate(skill), {
      type: 'codex_skill',
      skill: 'tests-review',
      arguments: 'GH-123',
      prompt: '',
      source: 'claude-skill',
    });
  });

  it('parses a multiline Skill(...)', () => {
    const skill = parser.parseClaudeSkill(`Skill(
  skill: "work-workflow:tests-create",
  arguments: \`GH-123 --task 2\`,
  prompt: "Use feedback, then write tests."
)`);

    assert.strictEqual(skill.skill, 'tests-create');
    assert.strictEqual(skill.arguments, 'GH-123 --task 2');
    assert.strictEqual(skill.prompt, 'Use feedback, then write tests.');
  });

  it('parses multiple Skill(...) calls', () => {
    const skills = parser.parseClaudeSkills(
      'Skill("tests-review") and Skill(skill: "tests-create")'
    );

    assert.deepStrictEqual(
      skills.map((skill) => skill.skill),
      ['tests-review', 'tests-create']
    );
  });

  it('parses Skill(name): argument shorthand found in skills', () => {
    const skill = parser.parseClaudeSkill('Skill(test-coordination): TICKET_ID');

    assert.strictEqual(skill.skill, 'test-coordination');
    assert.strictEqual(skill.arguments, 'TICKET_ID');
    assert.strictEqual(skill.prompt, '');
  });

  it('parses mixed Task(...) and Skill(...) calls into delegates', () => {
    const delegates = parser.parseClaudeDelegates(`
Task(subagent_type: "commit-writer", prompt: "Commit foo")
Skill(name: "follow-up", arguments: "GH-123")
`);

    assert.deepStrictEqual(
      delegates.map((delegate) => delegate.type),
      ['codex_agent', 'codex_skill']
    );
  });

  it('preserves quoted strings with commas', () => {
    const delegates = parser.parseClaudeDelegates(
      'Task(subagent_type: "commit-writer", prompt: "Commit foo, bar, and baz") Skill(name: "tests-review", arguments: "GH-1, task 2")'
    );

    assert.strictEqual(delegates[0].prompt, 'Commit foo, bar, and baz');
    assert.strictEqual(delegates[1].arguments, 'GH-1, task 2');
  });

  it('throws a clear error when Task subagent_type is missing', () => {
    assert.throws(
      () => parser.parseClaudeTask('Task(description: "No agent", prompt: "Do work")'),
      /missing required field\(s\): subagent_type/
    );
  });

  it('throws a clear error when Task prompt is missing', () => {
    assert.throws(
      () => parser.parseClaudeTask('Task(description: "No prompt", subagent_type: "code-checker")'),
      /missing required field\(s\): prompt/
    );
  });

  it('throws a clear error when Skill name is missing', () => {
    assert.throws(
      () => parser.parseClaudeSkill('Skill(arguments: "GH-123")'),
      /missing required field\(s\): name or skill/
    );
  });

  it('throws a clear error when no delegates are found', () => {
    assert.throws(
      () => parser.parseClaudeDelegates('No delegation here'),
      /no Task\(\.\.\.\) or Skill\(\.\.\.\) delegate found/
    );
  });
});
