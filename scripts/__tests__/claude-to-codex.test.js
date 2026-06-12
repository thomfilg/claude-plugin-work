const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const { run } = require(path.join(repoRoot, 'scripts', 'claude-to-codex.js'));
const testRoot = path.join(os.tmpdir(), `claude-to-codex-test-${process.pid}`);

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function runImporter(args) {
  const lines = [];
  run(args, { log: (line) => lines.push(line) });
  return lines.join('\n');
}

describe('claude-to-codex importer', () => {
  it('dry-runs without writing the output directory', () => {
    const out = path.join(testRoot, 'dry-run');
    const stdout = runImporter(['--plugin', 'work', '--out', out, '--dry-run']);

    assert.match(stdout, /plugins\/work\/\.claude-plugin\/plugin\.json ->/);
    assert.match(stdout, /Planned files: \d+/);
    assert.strictEqual(fs.existsSync(out), false);
  });

  it('generates and validates a Codex work plugin skeleton', () => {
    const out = path.join(testRoot, 'codex-work');
    const stdout = runImporter(['--plugin', 'work', '--out', out, '--clean']);

    assert.match(stdout, /Generated files: \d+/);
    assert.match(stdout, /Warnings: 0/);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, '.codex-plugin', 'plugin.json'), 'utf8')
    );
    assert.strictEqual(manifest.skills, './skills/');
    assert.ok(manifest.interface);
    assert.strictEqual(manifest.hooks, undefined);
    assert.strictEqual(Object.hasOwn(manifest, 'hooks'), false);

    const skill = fs.readFileSync(path.join(out, 'skills', 'work', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: "work"\n/m);
    assert.match(skill, /Codex compatibility note/);
    assert.doesNotMatch(
      skill.slice(0, skill.indexOf('---', 4)),
      /allowed-tools|user-invocable|argument-hint/
    );
    assert.match(skill, /CODEX_PLUGIN_ROOT/);

    const briefSkill = fs.readFileSync(path.join(out, 'skills', 'brief', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(briefSkill, /Codex compatibility note/);

    const agent = fs.readFileSync(path.join(out, 'agents', 'commit-writer.toml'), 'utf8');
    assert.match(agent, /^name = "commit-writer"/m);
    assert.match(agent, /^developer_instructions = '''/m);

    assert.strictEqual(fs.existsSync(path.join(out, 'AGENTS.md')), true);
    assert.strictEqual(fs.existsSync(path.join(out, 'CLAUDE.md')), true);
    assert.strictEqual(fs.existsSync(path.join(out, 'open-channel.md')), true);
    assert.strictEqual(fs.existsSync(path.join(out, 'external_scripts', 'symlink.js')), true);
    assert.strictEqual(fs.existsSync(path.join(out, 'scripts', 'codex', 'work-adapter.js')), true);
    assert.strictEqual(fs.existsSync(path.join(out, '.in_use')), false);
    assert.strictEqual(fs.existsSync(path.join(out, '.claude-plugin')), false);

    const setupEnvPath = path.join(out, 'setup-env.sh');
    assert.strictEqual(fs.existsSync(setupEnvPath), true);
    assert.notStrictEqual(fs.statSync(setupEnvPath).mode & 0o111, 0);
    const setupEnv = fs.readFileSync(setupEnvPath, 'utf8');
    assert.match(setupEnv, /CODEX_PLUGIN_ROOT/);
    assert.match(setupEnv, /CLAUDE_PLUGIN_ROOT/);

    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    assert.match(readme, /setup-env\.sh/);
    assert.match(readme, /disabled reference data/);

    const hooksPath = path.join(out, 'hooks', 'hooks.json');
    assert.strictEqual(fs.existsSync(hooksPath), true);
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.deepStrictEqual(hooks.hooks, {});
    assert.ok(hooks.disabledHooks.UserPromptSubmit);
    assert.ok(hooks.disabledHooks.PreToolUse);
    assert.ok(hooks.disabledHooks.PostToolUse);
    assert.strictEqual(hooks.hooks.user_prompt_submit, undefined);
    const hookCommands = JSON.stringify(hooks.disabledHooks);
    assert.match(hookCommands, /\$\{CLAUDE_PLUGIN_ROOT\}/);

    const notes = fs.readFileSync(path.join(out, 'CLAUDE_TO_CODEX_NOTES.md'), 'utf8');
    assert.match(notes, /reference only/);
    assert.match(notes, /disabledHooks/);
    assert.match(notes, /hooks\/hooks\.json/);
  });
});
