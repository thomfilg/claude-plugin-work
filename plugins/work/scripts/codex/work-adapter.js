#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseClaudeDelegates } = require('./parse-claude-delegates');

const DESTRUCTIVE_COMMAND_RE =
  /(^|[;&|]\s*)(rm\b|git\s+push\b|git\s+reset\s+--hard\b|git\s+clean\b|terraform\s+apply\b|terraform\s+destroy\b|kubectl\s+delete\b|docker\s+rm\b|drop\s+database\b)/i;

function resolvePluginRoot(env = process.env, startDir = __dirname) {
  if (env.CODEX_PLUGIN_ROOT) return path.resolve(env.CODEX_PLUGIN_ROOT);
  if (env.CLAUDE_PLUGIN_ROOT) return path.resolve(env.CLAUDE_PLUGIN_ROOT);
  return path.resolve(startDir, '..', '..');
}

function buildChildEnv(pluginRoot, env = process.env) {
  return {
    ...env,
    CODEX_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  };
}

function runWorkRunner({
  pluginRoot,
  ticketArgs,
  init = false,
  dryRun = false,
  env = process.env,
}) {
  const runner = path.join(pluginRoot, 'scripts', 'workflows', 'work', 'work-next.js');
  const args = [runner, ...ticketArgs];
  if (init) args.push('--init');
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: buildChildEnv(pluginRoot, env),
    encoding: 'utf8',
  });
  if (result.error) {
    return {
      action: 'blocked',
      reason: `Work runner failed to start: ${result.error.message}`,
      raw: { runner, ticketArgs, init, code: result.error.code },
    };
  }
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const instruction = parseRunnerOutput(stdout);
  if (!instruction) {
    const parsedDelegates = parseTextDelegates(stdout);
    if (parsedDelegates.length === 1) return withResultContract(parsedDelegates[0]);
    if (parsedDelegates.length > 1) {
      return {
        action: 'blocked',
        reason:
          'Work runner printed multiple delegates; Codex/model dispatch should split them explicitly',
        raw: { delegates: parsedDelegates, stdout, stderr, exitCode: result.status },
      };
    }
    return {
      action: 'blocked',
      reason: 'Work runner did not print parseable JSON',
      raw: { stdout, stderr, exitCode: result.status },
    };
  }
  if (result.status && instruction.action !== 'blocked') {
    return {
      action: 'blocked',
      reason: `Work runner exited with code ${result.status}`,
      raw: { instruction, stdout, stderr, exitCode: result.status },
    };
  }
  return normalizeRunnerInstruction(instruction, { pluginRoot, dryRun });
}

function parseRunnerOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf('\n{');
    if (start !== -1) {
      try {
        return JSON.parse(text.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeRunnerInstruction(instruction, options = {}) {
  if (!instruction || typeof instruction !== 'object') {
    return { action: 'blocked', reason: 'Runner instruction is not an object', raw: instruction };
  }
  if (instruction.action === 'complete') {
    return { action: 'complete', summary: instruction.summary, raw: instruction };
  }
  if (instruction.action === 'blocked') {
    return {
      action: 'blocked',
      reason: instruction.reason || instruction.suggestion || 'Work runner blocked',
      raw: instruction,
    };
  }
  if (instruction.action !== 'execute') {
    return {
      action: 'blocked',
      reason: `Unsupported runner action: ${instruction.action || '<missing>'}`,
      raw: instruction,
    };
  }

  if (Array.isArray(instruction.delegates) && instruction.delegates.length > 0) {
    const delegates = instruction.delegates.map((delegate) =>
      normalizeDelegate(delegate, instruction, options)
    );
    if (delegates.length === 1) return delegates[0];
    return {
      action: 'blocked',
      reason:
        'Runner emitted multiple delegates; dispatch them explicitly through Codex/model runtime',
      delegates,
      raw: instruction,
    };
  }
  return normalizeDelegate(instruction.delegate, instruction, options);
}

function normalizeDelegate(delegate, instruction = {}, options = {}) {
  if (!delegate || typeof delegate !== 'object') {
    const parsed = parseTextDelegates(JSON.stringify(instruction));
    if (parsed.length === 1) return withResultContract(parsed[0]);
    return {
      action: 'blocked',
      reason: 'Runner execute instruction did not include a delegate',
      raw: instruction,
    };
  }

  if (delegate.type === 'bash') {
    const command = normalizeShellCommand(delegate.command || delegate.prompt || '');
    return normalizeShellDelegate(command, delegate, options);
  }
  if (delegate.type === 'task') {
    if (delegate.agentType && delegate.prompt) {
      return withResultContract({
        action: 'dispatch_agent',
        agent: stripWorkPrefix(delegate.agentType),
        description: delegate.description || firstLine(delegate.prompt) || delegate.agentType,
        prompt: delegate.prompt,
      });
    }
    const parsed = parseTextDelegates(
      delegate.prompt || delegate.command || JSON.stringify(delegate)
    );
    if (parsed.length > 0) return withResultContract(parsed[0]);
  }
  if (delegate.type === 'skill') {
    if (delegate.name || delegate.skill) {
      return withResultContract({
        action: 'dispatch_skill',
        skill: stripWorkPrefix(delegate.name || delegate.skill),
        arguments: slashPromptArguments(delegate.prompt || '', delegate.name || delegate.skill),
        prompt: delegate.prompt || '',
      });
    }
    const parsed = parseTextDelegates(
      delegate.prompt || delegate.command || JSON.stringify(delegate)
    );
    if (parsed.length > 0) return withResultContract(parsed[0]);
  }

  const parsed = parseTextDelegates(
    delegate.prompt || delegate.command || JSON.stringify(delegate)
  );
  if (parsed.length === 1) return withResultContract(parsed[0]);
  return {
    action: 'blocked',
    reason: `Unsupported delegate type: ${delegate.type || '<missing>'}`,
    raw: delegate,
  };
}

function normalizeShellDelegate(command, delegate = {}, options = {}) {
  if (!command) {
    return { action: 'blocked', reason: 'Shell delegate has no command', raw: delegate };
  }
  if (!looksLikeShellCommand(command)) {
    return {
      action: 'blocked',
      reason:
        'Shell delegate is not a clear shell command; Codex/user should inspect it before running',
      raw: { action: 'run_shell', command, cwd: delegate.cwd, env: delegate.env },
    };
  }
  const shellInstruction = {
    action: 'run_shell',
    command,
    cwd: delegate.cwd,
    env: delegate.env,
  };
  if (isDestructiveCommand(command)) {
    return {
      action: 'blocked',
      reason:
        'Shell delegate appears destructive; Codex/user approval is required before running it',
      raw: shellInstruction,
    };
  }
  if (options.dryRun) return shellInstruction;
  const result = runShellCommand(command, {
    cwd: delegate.cwd || process.cwd(),
    env: { ...process.env, ...(delegate.env || {}) },
  });
  const resultFile = writeDelegateResult(result, options.resultDir);
  return {
    ...shellInstruction,
    result,
    resultFile,
    next: 'Run `node scripts/codex/work-adapter.js continue <ticket> --result-file <path>` after reviewing the result.',
  };
}

function runShellCommand(command, options = {}) {
  const result = spawnSync(command, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: true,
    encoding: 'utf8',
  });
  return {
    type: 'shell_result',
    command,
    cwd: options.cwd || process.cwd(),
    exitCode: result.status == null ? 1 : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

function writeDelegateResult(result, resultDir) {
  const dir = resultDir || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-work-adapter-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `delegate-result-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

function parseTextDelegates(text) {
  try {
    return parseClaudeDelegates(String(text || '')).map((delegate) => {
      if (delegate.type === 'codex_agent') {
        return {
          action: 'dispatch_agent',
          agent: delegate.agent,
          description: delegate.description,
          prompt: delegate.prompt,
        };
      }
      if (delegate.type === 'codex_skill') {
        return {
          action: 'dispatch_skill',
          skill: delegate.skill,
          arguments: delegate.arguments,
          prompt: delegate.prompt,
        };
      }
      return delegate;
    });
  } catch {
    return [];
  }
}

function isDestructiveCommand(command) {
  return DESTRUCTIVE_COMMAND_RE.test(String(command || ''));
}

function looksLikeShellCommand(command) {
  const first =
    String(command || '')
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim()) || '';
  return /^(cd|echo|printf|node|npm|pnpm|yarn|bun|git|gh|tmux|mkdir|cp|mv|ls|cat|sed|rg|grep|find|test|make|python3?|bash|sh|curl)\b/.test(
    first.trim()
  );
}

function normalizeShellCommand(command) {
  return String(command || '')
    .trim()
    .replace(/^Run:\s*/i, '')
    .replace(/^Run these commands in sequence:\s*/i, '')
    .trim();
}

function slashPromptArguments(prompt, skillName) {
  const text = String(prompt || '').trim();
  if (!text.startsWith('/')) return '';
  const normalizedSkill = stripWorkPrefix(skillName || '').replace(/^\//, '');
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return '';
  return match[1] === normalizedSkill ? (match[2] || '').trim() : text;
}

function withResultContract(instruction) {
  return {
    ...instruction,
    resultFileShape: resultFileShape(),
  };
}

function resultFileShape() {
  return {
    type: 'delegate_result',
    status: 'success|failure',
    summary: '<what happened>',
    output: '<agent/skill/shell output or artifact paths>',
  };
}

function firstLine(value) {
  return (
    String(value || '')
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || ''
  );
}

function stripWorkPrefix(value) {
  return String(value || '').replace(/^work-workflow:/, '');
}

function readResultFile(file) {
  if (!file) throw new Error('--result-file is required for continue');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const resultFileIndex = rest.indexOf('--result-file');
  const resultFile = resultFileIndex === -1 ? null : rest[resultFileIndex + 1];
  const ticketArgs = rest.filter((arg, index) => {
    if (arg === '--dry-run' || arg === '--result-file') return false;
    if (resultFileIndex !== -1 && index === resultFileIndex + 1) return false;
    return true;
  });
  return { command, ticketArgs, dryRun, resultFile };
}

function runCli(
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr }
) {
  const args = parseCliArgs(argv);
  if (!args.command || !['start', 'continue'].includes(args.command)) {
    io.stderr.write('Usage: node scripts/codex/work-adapter.js start <ticket> [--dry-run]\n');
    io.stderr.write(
      '   or: node scripts/codex/work-adapter.js continue <ticket> --result-file <path>\n'
    );
    return 2;
  }
  if (args.ticketArgs.length === 0) {
    io.stderr.write('A ticket or workflow argument is required.\n');
    return 2;
  }

  const pluginRoot = resolvePluginRoot();
  if (args.command === 'continue') {
    try {
      readResultFile(args.resultFile);
    } catch (error) {
      io.stdout.write(
        `${JSON.stringify({ action: 'blocked', reason: error.message, raw: { resultFile: args.resultFile } }, null, 2)}\n`
      );
      return 1;
    }
  }

  const runnerResult = runWorkRunner({
    pluginRoot,
    ticketArgs: args.ticketArgs,
    init: args.command === 'start',
    dryRun: args.dryRun,
  });
  io.stdout.write(`${JSON.stringify(runnerResult, null, 2)}\n`);
  return runnerResult.action === 'blocked' ? 1 : 0;
}

module.exports = {
  buildChildEnv,
  isDestructiveCommand,
  looksLikeShellCommand,
  normalizeDelegate,
  normalizeRunnerInstruction,
  parseRunnerOutput,
  readResultFile,
  resolvePluginRoot,
  resultFileShape,
  runCli,
  runShellCommand,
  runWorkRunner,
};

if (require.main === module) {
  process.exitCode = runCli();
}
