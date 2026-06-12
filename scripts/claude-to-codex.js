#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const DROP_SKILL_FIELDS = new Set(['allowed-tools', 'user-invocable', 'argument-hint']);
const COPY_DIRS = ['scripts', 'docs', 'references', 'external_scripts'];
const COPY_ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', 'open-channel.md'];
const EXCLUDED_DIRS = new Set([
  '.claude-plugin',
  '.in_use',
  '.git',
  'node_modules',
  'dist',
  'codex-plugins',
  '.cache',
]);

function run(rawArgs, io = console) {
  const options = parseArgs(rawArgs);
  const warnings = [];
  const written = [];
  const mappings = [];

  if (!options.plugin || !options.out) {
    usage();
    process.exit(1);
  }

  const pluginRoot = path.join(ROOT, 'plugins', options.plugin);
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  assertFile(manifestPath, `Claude manifest not found for plugin "${options.plugin}"`);

  if (options.clean && !options.dryRun && fs.existsSync(options.out)) {
    fs.rmSync(options.out, { recursive: true, force: true });
  }

  const claudeManifest = readJson(manifestPath);
  const codexManifest = buildCodexManifest(claudeManifest, options.plugin);
  writeJson(
    path.join(options.out, '.codex-plugin', 'plugin.json'),
    codexManifest,
    options,
    written,
    mappings,
    manifestPath
  );

  convertSkills(pluginRoot, options, written, mappings, warnings);
  convertAgents(pluginRoot, options, written, mappings, warnings);
  copyRuntimeDirs(pluginRoot, options, written, mappings);
  convertHooks(pluginRoot, options, written, mappings, warnings);
  generateReadme(options, claudeManifest, written, mappings);
  generateNotes(pluginRoot, options, written, mappings, warnings);
  generateAdapterDoc(options, written, mappings);
  generateSetupEnv(options, written, mappings);

  if (options.dryRun) {
    for (const mapping of mappings) {
      io.log(`${rel(mapping.src)} -> ${rel(mapping.dest)}`);
    }
    printSummary(mappings.length, warnings, true, io);
    return { written, mappings, warnings };
  }

  validateOutput(options.out);
  printSummary(written.length, warnings, false, io);
  return { written, mappings, warnings };
}

function main() {
  run(process.argv.slice(2));
}

function parseArgs(args) {
  const options = { clean: false, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--plugin') options.plugin = args[++i];
    else if (arg === '--out') options.out = path.resolve(ROOT, args[++i]);
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  console.error(
    'Usage: node scripts/claude-to-codex.js --plugin <name> --out <dir> [--clean] [--dry-run]'
  );
}

function assertFile(file, message) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildCodexManifest(source, pluginName) {
  const author =
    typeof source.author === 'object' && source.author
      ? source.author
      : { name: String(source.author || 'Local') };
  const description =
    source.description || `${pluginName} plugin imported from Claude Code assets.`;
  const displayName = titleCase(pluginName);

  return {
    name: source.name || pluginName,
    version: source.version || '0.0.0',
    description,
    author,
    license: source.license || 'MIT',
    keywords: Array.isArray(source.keywords) ? source.keywords : [],
    skills: './skills/',
    interface: {
      displayName,
      shortDescription: truncate(description, 120),
      longDescription: description,
      developerName: author.name || 'Local',
      category: 'Productivity',
      capabilities: ['Interactive', 'Write'],
      defaultPrompt: [
        `Use ${displayName} skills for a ticket workflow.`,
        `Run the ${displayName} workflow adapter plan.`,
      ],
      brandColor: '#2563EB',
    },
  };
}

function convertSkills(pluginRoot, options, written, mappings, warnings) {
  const skillsRoot = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsRoot)) return;

  for (const source of walkFiles(skillsRoot)) {
    const relative = path.relative(skillsRoot, source);
    const dest = path.join(options.out, 'skills', relative);
    if (path.basename(source) === 'SKILL.md') {
      let content = fs.readFileSync(source, 'utf8');
      content = rewriteSkillMarkdown(content, source, warnings);
      if (
        options.plugin === 'work' &&
        path.relative(pluginRoot, source) === path.join('skills', 'work', 'SKILL.md')
      ) {
        content = addWorkCompatibilityNote(content);
      }
      content = content.replaceAll('CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT');
      writeFile(dest, content, options, written, mappings, source);
    } else {
      copyFile(source, dest, options, written, mappings);
    }
  }
}

function rewriteSkillMarkdown(content, source, warnings) {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    warnings.push(`${rel(source)} has no YAML frontmatter`);
    return content;
  }
  const name = parsed.data.name;
  const description = parsed.data.description;
  if (!name || !description) {
    warnings.push(`${rel(source)} frontmatter is missing name or description`);
  }
  const clean = {};
  if (name) clean.name = name;
  if (description) clean.description = description;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key in clean || DROP_SKILL_FIELDS.has(key)) continue;
    clean[key] = value;
  }
  return `${formatYaml(clean)}\n${parsed.body.replace(/^\n/, '')}`;
}

function addWorkCompatibilityNote(content) {
  const note = [
    '> Codex compatibility note:',
    '> Claude `Task` delegates map to Codex sub-agent spawning when available.',
    '> Claude `Skill` delegates map to reading or invoking generated Codex skills.',
    '> Claude `Monitor` has no direct Codex equivalent in v1; use a long-running shell session or disable that path.',
    '',
  ].join('\n');
  const parsed = parseFrontmatter(content);
  if (!parsed) return `${note}${content}`;
  return `${parsed.rawFrontmatter}\n${note}${parsed.body.replace(/^\n/, '')}`;
}

function convertAgents(pluginRoot, options, written, mappings, warnings) {
  const agentsRoot = path.join(pluginRoot, 'agents');
  if (!fs.existsSync(agentsRoot)) return;

  for (const source of walkFiles(agentsRoot).filter((file) => file.endsWith('.md'))) {
    const content = fs
      .readFileSync(source, 'utf8')
      .replaceAll('CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      warnings.push(`${rel(source)} has no YAML frontmatter; skipping agent`);
      continue;
    }
    const name = parsed.data.name || kebabCase(path.basename(source, '.md'));
    const description = parsed.data.description || '';
    if (!parsed.data.name || !description) {
      warnings.push(`${rel(source)} frontmatter is missing name or description`);
    }
    let body = parsed.body.replace(/^\n/, '');
    if (body.includes("'''")) {
      body = body.replaceAll("'''", '` ` `');
      warnings.push(
        `${rel(source)} contained TOML literal delimiter text; replaced in generated agent body`
      );
    }
    const toml = [
      `name = ${tomlString(name)}`,
      `description = ${tomlString(description)}`,
      "developer_instructions = '''",
      body,
      "'''",
      '',
    ].join('\n');
    const dest = path.join(options.out, 'agents', `${kebabCase(name)}.toml`);
    writeFile(dest, toml, options, written, mappings, source);
  }
}

function copyRuntimeDirs(pluginRoot, options, written, mappings) {
  for (const dir of COPY_DIRS) {
    const sourceRoot = path.join(pluginRoot, dir);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const source of walkFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, source);
      copyFile(source, path.join(options.out, dir, relative), options, written, mappings);
    }
  }

  for (const file of COPY_ROOT_FILES) {
    const source = path.join(pluginRoot, file);
    if (!fs.existsSync(source)) continue;
    copyFile(source, path.join(options.out, file), options, written, mappings);
  }
}

function convertHooks(pluginRoot, options, written, mappings, warnings) {
  const hooksRoot = path.join(pluginRoot, 'hooks');
  if (!fs.existsSync(hooksRoot)) return;

  for (const source of walkFiles(hooksRoot)) {
    const relative = path.relative(hooksRoot, source);
    const dest = path.join(options.out, 'hooks', relative);
    if (relative === 'hooks.json') {
      const hooksJson = readJson(source);
      const converted = convertHooksJson(hooksJson, source, warnings);
      writeJson(dest, converted, options, written, mappings, source);
    } else {
      copyFile(source, dest, options, written, mappings);
    }
  }
}

function convertHooksJson(hooksJson, source, warnings) {
  const converted = {
    ...hooksJson,
    hooks: {},
    disabledHooks: {},
    disabledReason:
      'Disabled until these Claude hook commands are ported behind a Codex runtime adapter.',
  };
  for (const [event, blocks] of Object.entries(hooksJson.hooks || {})) {
    const normalizedEvent = normalizeHookEvent(event, source, warnings);
    converted.disabledHooks[normalizedEvent] = (
      converted.disabledHooks[normalizedEvent] || []
    ).concat((blocks || []).map(convertHookBlock));
  }
  if (Object.keys(converted.disabledHooks).length === 0) delete converted.disabledHooks;
  return converted;
}

function normalizeHookEvent(event, source, warnings) {
  const knownEvents = new Set([
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'SessionStart',
    'PreCompact',
    'Stop',
  ]);
  if (!knownEvents.has(event)) {
    warnings.push(`${rel(source)} contains unrecognized hook event "${event}"; preserving it`);
  }
  return event;
}

function convertHookBlock(block) {
  return {
    ...block,
    hooks: (block.hooks || []).map((hook) => ({
      ...hook,
      command: typeof hook.command === 'string' ? normalizeHookCommand(hook.command) : hook.command,
    })),
  };
}

function normalizeHookCommand(command) {
  return command;
}

function generateReadme(options, manifest, written, mappings) {
  const text = `# ${titleCase(options.plugin)} Codex Plugin

Generated from Claude Code plugin assets in \`plugins/${options.plugin}\`.

## Generate

\`\`\`bash
node scripts/claude-to-codex.js --plugin ${options.plugin} --out ./codex-plugins/${options.plugin} --clean
\`\`\`

Use \`--clean\` to remove the output directory before regeneration. Without \`--clean\`, generated files are overwritten and unrelated files are left in place.

## Runtime Environment

The copied scripts still expect the Claude workflow environment. For compatibility, export:

\`\`\`bash
source ./setup-env.sh
export WORKTREES_BASE=<path to worktrees>
export TASKS_BASE=<path to task artifacts>
export REPO_NAME=<repository name>
export TICKET_PROVIDER=jira # or github/linear
export JIRA_PROJECT_KEY=<project key>
\`\`\`

Use \`source /absolute/path/to/codex-plugins/${options.plugin}/setup-env.sh\` when running from outside the generated plugin root. The helper exports both \`CODEX_PLUGIN_ROOT\` and \`CLAUDE_PLUGIN_ROOT\` to the generated plugin root; source it instead of executing it if the exports need to persist in your current shell.

For GitHub-backed tickets, configure the same \`gh\` CLI authentication and repository environment that the original Claude scripts require. For Linear-backed tickets, configure the Linear MCP or API variables used by your local workflow.

## Conversion Status

- Skills are copied with Codex-compatible frontmatter.
- Agents are converted from Claude Markdown to Codex TOML with \`developer_instructions\`.
- Scripts, docs, references, and external scripts are copied for local use.
- Claude hooks are copied into \`hooks/hooks.json\` as disabled reference data. They are not active until ported behind a Codex runtime adapter.
- Slash command Markdown is not converted in v1; use generated skills and the adapter design instead.

Source manifest: \`${manifest.name || options.plugin}@${manifest.version || '0.0.0'}\`
`;
  writeFile(
    path.join(options.out, 'README.md'),
    text,
    options,
    written,
    mappings,
    'generated:README'
  );
}

function generateNotes(pluginRoot, options, written, mappings, warnings) {
  const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  const convertedHooksPath = path.join(options.out, 'hooks', 'hooks.json');
  const lines = [
    '# Claude To Codex Notes',
    '',
    'This package is generated from Claude Code plugin assets. Claude hooks are copied under `hooks/hooks.json` for reference only and are not active in Codex.',
    '',
    'Hooks are not registered through `.codex-plugin/plugin.json`; the manifest must stay free of a `hooks` field for local validation. The copied hook definitions live under `disabledHooks` until a runtime adapter can translate Claude hook payloads and tool names into Codex-native behavior.',
    '',
    'Hook commands still use Claude compatibility environment variables. Source `./setup-env.sh` to export both `CODEX_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` before running copied scripts manually.',
    '',
    '## Hooks',
    '',
  ];

  if (fs.existsSync(convertedHooksPath)) {
    const hooksJson = readJson(convertedHooksPath);
    for (const entry of listHooks(hooksJson)) {
      lines.push(`- \`${entry.event}\` matcher \`${entry.matcher}\`: \`${entry.command}\``);
    }
  } else {
    lines.push('- No `hooks/hooks.json` file found.');
    warnings.push(`${rel(hooksPath)} not found; no hook notes generated`);
  }

  lines.push(
    '',
    '## Manual Runtime Ports',
    '',
    '- Implement Codex runtime delegation outside Node. Codex tools are model/runtime APIs, not shell APIs.',
    '- Keep `CLAUDE_PLUGIN_ROOT=<codex plugin root>` exported until scripts are migrated to `CODEX_PLUGIN_ROOT`.',
    '- Recreate required hook policy as explicit runner logic or Codex-native guardrails before moving entries from `disabledHooks` to `hooks`.',
    ''
  );
  writeFile(
    path.join(options.out, 'CLAUDE_TO_CODEX_NOTES.md'),
    `${lines.join('\n')}\n`,
    options,
    written,
    mappings,
    hooksPath
  );
}

function listHooks(hooksJson) {
  const result = [];
  for (const [event, blocks] of Object.entries(hooksJson.disabledHooks || hooksJson.hooks || {})) {
    for (const block of blocks || []) {
      for (const hook of block.hooks || []) {
        result.push({
          event,
          matcher: block.matcher || '',
          command: hook.command || hook.type || '',
        });
      }
    }
  }
  return result;
}

function generateAdapterDoc(options, written, mappings) {
  if (options.plugin !== 'work') return;
  const text = `# Codex Work Adapter Design

This document describes the v1 adapter loop for running the imported \`/work\` workflow from Codex.

## Commands

Start a workflow:

\`\`\`bash
node scripts/codex/work-adapter.js start <ticket-or-args...>
\`\`\`

Preview the next instruction without running shell delegates:

\`\`\`bash
node scripts/codex/work-adapter.js start <ticket> --dry-run
\`\`\`

Continue after Codex or a user has completed an agent/skill delegate:

\`\`\`bash
node scripts/codex/work-adapter.js continue <ticket> --result-file <path>
\`\`\`

The adapter resolves the plugin root from \`CODEX_PLUGIN_ROOT\`, then \`CLAUDE_PLUGIN_ROOT\`, then its own filesystem location. It exports both variables to the underlying \`scripts/workflows/work/work-next.js\` process.

## Output Contract

The adapter parses runner JSON and prints one normalized JSON instruction:

- \`{ "action": "run_shell", "command": "...", "cwd": "...", "env": {...} }\`
- \`{ "action": "dispatch_agent", "agent": "...", "description": "...", "prompt": "..." }\`
- \`{ "action": "dispatch_skill", "skill": "...", "arguments": "...", "prompt": "..." }\`
- \`{ "action": "complete", "summary": "..." }\`
- \`{ "action": "blocked", "reason": "...", "raw": ... }\`

Safe shell delegates are run by Node. The adapter captures \`stdout\`, \`stderr\`, and \`exitCode\`, then writes a delegate result JSON file and prints its path. Commands that look destructive, such as \`rm\`, \`git push\`, or \`terraform apply\`, are blocked for Codex/user approval instead of being run automatically.

Agent and skill delegates are not executed by Node. Codex runtime/model code should dispatch them, then save a result file before calling \`continue\`.

Result file shape:

\`\`\`json
{
  "type": "delegate_result",
  "status": "success",
  "summary": "What happened",
  "output": "Agent, skill, or shell output and artifact paths"
}
\`\`\`

## Delegate Parsing

\`scripts/codex/parse-claude-delegates.js\` recognizes the imported Claude delegation forms and normalizes them for a Codex adapter loop:

- \`Task(description: "...", prompt: "...", subagent_type: "...")\` -> \`{ type: "codex_agent", agent, description, prompt, source: "claude-task" }\`
- \`Skill(name: "...", arguments: "...")\` or \`Skill(skill: "...", arguments: "...")\` -> \`{ type: "codex_skill", skill, arguments, prompt, source: "claude-skill" }\`
- Shorthand forms used in the imported docs, such as \`Task(brief-writer): ...\` and \`Skill(test-coordination): ...\`, are parsed into the same structures when enough information is present.

For quick parser inspection:

\`\`\`bash
node scripts/codex/parse-claude-delegates.js < input.txt
\`\`\`

## Boundary

Do not implement Codex tool calls inside Node. Codex tools such as sub-agent spawning and skill invocation are model/runtime APIs, not shell APIs. Node should only parse imported Claude delegation text, emit structured delegates, and run safe shell delegates. Codex runtime/model code dispatches \`dispatch_agent\` and \`dispatch_skill\` instructions.
`;
  writeFile(
    path.join(options.out, 'docs', 'codex-work-adapter.md'),
    text,
    options,
    written,
    mappings,
    'generated:adapter-doc'
  );
}

function generateSetupEnv(options, written, mappings) {
  const text = `#!/usr/bin/env bash
# Source this file so exported variables persist in your current shell:
#   source ./setup-env.sh

_codex_setup_script="\${BASH_SOURCE[0]:-$0}"
_codex_plugin_root="$(cd -- "$(dirname -- "$_codex_setup_script")" && pwd -P)"

export CODEX_PLUGIN_ROOT="$_codex_plugin_root"
export CLAUDE_PLUGIN_ROOT="$_codex_plugin_root"

if [[ "\${BASH_SOURCE[0]:-}" == "$0" ]]; then
  echo "Configured CODEX_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT for this process only."
  echo "Run 'source $_codex_setup_script' if these exports need to persist in your current shell."
fi

unset _codex_setup_script
unset _codex_plugin_root
`;
  writeFile(
    path.join(options.out, 'setup-env.sh'),
    text,
    options,
    written,
    mappings,
    'generated:setup-env',
    0o755
  );
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const raw = content.slice(4, end);
  const body = content.slice(end + 4);
  const data = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (value === '|') {
      const block = [];
      while (i + 1 < lines.length && /^(?:\s+|$)/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^ {2}/, ''));
      }
      value = block.join('\n').replace(/\n+$/, '');
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    data[key] = value;
  }
  return {
    data,
    body,
    rawFrontmatter: formatYaml(data).trimEnd(),
  };
}

function formatYaml(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (String(value).includes('\n')) {
      lines.push(`${key}: |`);
      for (const line of String(value).split('\n')) lines.push(`  ${line}`);
    } else {
      lines.push(`${key}: ${formatYamlScalar(value)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function formatYamlScalar(value) {
  if (value === true || value === 'true') return 'true';
  if (value === false || value === 'false') return 'false';
  return JSON.stringify(String(value));
}

function writeJson(dest, value, options, written, mappings, source) {
  writeFile(dest, `${JSON.stringify(value, null, 2)}\n`, options, written, mappings, source);
}

function writeFile(dest, content, options, written, mappings, source, mode) {
  mappings.push({ src: source, dest });
  if (options.dryRun) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, normalizeGeneratedText(content));
  if (mode !== undefined) fs.chmodSync(dest, mode);
  written.push(dest);
}

function copyFile(source, dest, options, written, mappings) {
  mappings.push({ src: source, dest });
  if (options.dryRun) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const content = fs.readFileSync(source);
  if (content.includes(0)) {
    fs.writeFileSync(dest, content);
  } else {
    fs.writeFileSync(dest, normalizeGeneratedText(content.toString('utf8')));
  }
  fs.chmodSync(dest, fs.statSync(source).mode);
  written.push(dest);
}

function normalizeGeneratedText(content) {
  return String(content)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '\n');
}

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function validateOutput(outDir) {
  JSON.parse(fs.readFileSync(path.join(outDir, '.codex-plugin', 'plugin.json'), 'utf8'));

  const skillsDir = path.join(outDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const skill of walkFiles(skillsDir).filter((file) => path.basename(file) === 'SKILL.md')) {
      const parsed = parseFrontmatter(fs.readFileSync(skill, 'utf8'));
      if (!parsed?.data.name || !parsed?.data.description) {
        throw new Error(`Generated skill is missing name or description: ${rel(skill)}`);
      }
    }
  }

  const agentsDir = path.join(outDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const agent of walkFiles(agentsDir).filter((file) => file.endsWith('.toml'))) {
      const content = fs.readFileSync(agent, 'utf8');
      const delimiters = content.match(/'''/g) || [];
      if (delimiters.length !== 2) {
        throw new Error(`Generated TOML has unbalanced multiline literal string: ${rel(agent)}`);
      }
      if (!/^name = ".+"/m.test(content) || !/^description = /m.test(content)) {
        throw new Error(`Generated TOML is missing required fields: ${rel(agent)}`);
      }
    }
  }
}

function printSummary(count, warnings, dryRun, io = console) {
  io.log(`${dryRun ? 'Planned' : 'Generated'} files: ${count}`);
  io.log(`Warnings: ${warnings.length}`);
  for (const warning of warnings) io.log(`- ${warning}`);
}

function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function kebabCase(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function truncate(value, length) {
  const string = String(value);
  return string.length <= length ? string : `${string.slice(0, length - 3)}...`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function rel(file) {
  if (String(file).startsWith('generated:')) return file;
  return path.relative(ROOT, file);
}

module.exports = { run };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
