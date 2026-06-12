#!/usr/bin/env node

const fs = require('node:fs');

class ClaudeDelegateParseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClaudeDelegateParseError';
    this.details = details;
  }
}

function parseClaudeTask(text) {
  const tasks = parseClaudeTasks(text);
  if (tasks.length !== 1) {
    throw new ClaudeDelegateParseError(
      `expected exactly one Task(...) call, found ${tasks.length}`
    );
  }
  return tasks[0];
}

function parseClaudeTasks(text, options = {}) {
  return parseCallsOfKind(text, 'Task', parseTaskCall, options);
}

function parseClaudeSkill(text) {
  const skills = parseClaudeSkills(text);
  if (skills.length !== 1) {
    throw new ClaudeDelegateParseError(
      `expected exactly one Skill(...) call, found ${skills.length}`
    );
  }
  return skills[0];
}

function parseClaudeSkills(text, options = {}) {
  return parseCallsOfKind(text, 'Skill', parseSkillCall, options);
}

function parseClaudeDelegates(text, options = {}) {
  const calls = findDelegateCalls(String(text || ''), ['Task', 'Skill']);
  if (calls.length === 0) {
    if (options.lenient) return [];
    throw new ClaudeDelegateParseError('no Task(...) or Skill(...) delegate found');
  }

  const delegates = [];
  const errors = [];
  for (const call of calls) {
    try {
      const parsed = call.kind === 'Task' ? parseTaskCall(call) : parseSkillCall(call);
      delegates.push(
        call.kind === 'Task' ? toCodexAgentDelegate(parsed) : toCodexSkillDelegate(parsed)
      );
    } catch (error) {
      if (!options.lenient) throw error;
      errors.push({ message: error.message, start: call.start, text: call.text });
    }
  }
  if (options.lenient) delegates.errors = errors;
  return delegates;
}

function toCodexAgentDelegate(parsedTask) {
  const missing = [];
  if (!parsedTask.agent) missing.push('subagent_type');
  if (!parsedTask.prompt) missing.push('prompt');
  if (missing.length > 0) {
    throw new ClaudeDelegateParseError(
      `Task(...) missing required field(s): ${missing.join(', ')}`,
      {
        task: parsedTask,
      }
    );
  }
  return {
    type: 'codex_agent',
    agent: parsedTask.agent,
    description: parsedTask.description || firstLine(parsedTask.prompt) || parsedTask.agent,
    prompt: parsedTask.prompt,
    source: 'claude-task',
  };
}

function toCodexSkillDelegate(parsedSkill) {
  if (!parsedSkill.skill) {
    throw new ClaudeDelegateParseError('Skill(...) missing required field(s): name or skill', {
      skill: parsedSkill,
    });
  }
  return {
    type: 'codex_skill',
    skill: parsedSkill.skill,
    arguments: parsedSkill.arguments || '',
    prompt: parsedSkill.prompt || '',
    source: 'claude-skill',
  };
}

function parseCallsOfKind(text, kind, parser, options) {
  const calls = findDelegateCalls(String(text || ''), [kind]);
  if (calls.length === 0) {
    if (options.lenient) return [];
    throw new ClaudeDelegateParseError(`no ${kind}(...) call found`);
  }
  const parsed = [];
  const errors = [];
  for (const call of calls) {
    try {
      parsed.push(parser(call));
    } catch (error) {
      if (!options.lenient) throw error;
      errors.push({ message: error.message, start: call.start, text: call.text });
    }
  }
  if (options.lenient) parsed.errors = errors;
  return parsed;
}

function parseTaskCall(call) {
  const { fields, positional } = parseArguments(call.args);
  let agent = fields.subagent_type || fields.agent || positional[0] || '';
  let prompt = fields.prompt || positional.slice(1).join(', ') || call.blockPrompt || '';
  let description = fields.description || firstLine(prompt) || '';
  const task = {
    agent: cleanAgentName(agent),
    description: cleanText(description),
    prompt: cleanText(prompt),
    source: 'claude-task',
    raw: call.text,
  };
  const missing = [];
  if (!task.agent) missing.push('subagent_type');
  if (!task.prompt) missing.push('prompt');
  if (missing.length > 0) {
    throw new ClaudeDelegateParseError(
      `Task(...) missing required field(s): ${missing.join(', ')}`,
      {
        task,
      }
    );
  }
  return task;
}

function parseSkillCall(call) {
  const { fields, positional } = parseArguments(call.args);
  const skill = fields.name || fields.skill || positional[0] || '';
  const explicitArgs = fields.arguments || fields.args || positional.slice(1).join(', ') || '';
  const prompt = fields.prompt || '';
  const args = explicitArgs || (prompt ? '' : call.blockPrompt);
  const parsed = {
    skill: cleanSkillName(skill),
    arguments: cleanText(args),
    prompt: cleanText(prompt),
    source: 'claude-skill',
    raw: call.text,
  };
  if (!parsed.skill) {
    throw new ClaudeDelegateParseError('Skill(...) missing required field(s): name or skill', {
      skill: parsed,
    });
  }
  return parsed;
}

function parseArguments(rawArgs) {
  const args = stripOptionalObjectWrapper(rawArgs.trim());
  const parts = splitTopLevel(args, ',').filter((part) => part.trim());
  const fields = {};
  const positional = [];
  for (const part of parts) {
    const separator = findTopLevelSeparator(part);
    if (separator) {
      const key = normalizeKey(part.slice(0, separator.index));
      fields[key] = parseValue(part.slice(separator.index + 1));
    } else {
      positional.push(parseValue(part));
    }
  }
  return { fields, positional };
}

function findDelegateCalls(text, kinds) {
  const calls = [];
  let index = 0;
  while (index < text.length) {
    const next = findNextKind(text, kinds, index);
    if (!next) break;
    const { kind, start } = next;
    if (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) {
      index = start + kind.length + 1;
      continue;
    }
    const open = start + kind.length;
    const close = findMatching(text, open, '(', ')');
    if (close === -1)
      throw new ClaudeDelegateParseError(`unterminated ${kind}(...) call`, { start });
    const blockPrompt = readColonPromptBlock(text, close + 1);
    const end = blockPrompt ? blockPrompt.end : close + 1;
    calls.push({
      kind,
      start,
      end,
      args: text.slice(open + 1, close),
      text: text.slice(start, end),
      blockPrompt: blockPrompt ? blockPrompt.prompt : '',
    });
    index = Math.max(end, close + 1);
  }
  return calls;
}

function findNextKind(text, kinds, fromIndex) {
  let best = null;
  for (const kind of kinds) {
    const start = text.indexOf(`${kind}(`, fromIndex);
    if (start !== -1 && (!best || start < best.start)) best = { kind, start };
  }
  return best;
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readColonPromptBlock(text, fromIndex) {
  let i = fromIndex;
  while (i < text.length && /[ \t]/.test(text[i])) i += 1;
  if (text[i] !== ':') return null;
  i += 1;
  while (i < text.length && /[ \t]/.test(text[i])) i += 1;
  const lineEnd = text.indexOf('\n', i);
  if (lineEnd === -1) {
    const prompt = text.slice(i).trim();
    return prompt ? { prompt, end: text.length } : null;
  }
  const sameLine = text.slice(i, lineEnd).trim();
  if (sameLine) return { prompt: sameLine, end: lineEnd };

  const lines = text.slice(lineEnd + 1).split(/\n/);
  const promptLines = [];
  let consumed = lineEnd + 1;
  for (const line of lines) {
    const length = line.length + 1;
    if (line.trim() === '') {
      promptLines.push('');
      consumed += length;
      continue;
    }
    if (!/^[ \t]/.test(line)) break;
    promptLines.push(line.replace(/^[ \t]{1,2}/, ''));
    consumed += length;
  }
  const prompt = promptLines.join('\n').replace(/\s+$/, '');
  return prompt ? { prompt, end: consumed } : null;
}

function stripOptionalObjectWrapper(args) {
  if (!args.startsWith('{') || !args.endsWith('}')) return args;
  return findMatching(args, 0, '{', '}') === args.length - 1 ? args.slice(1, -1) : args;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function findTopLevelSeparator(text) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') depth -= 1;
    else if ((char === ':' || char === '=') && depth === 0) return { index: i, char };
  }
  return null;
}

function parseValue(raw) {
  const value = raw.trim().replace(/,\s*$/, '');
  if (!value) return '';
  const quote = value[0];
  if ((quote === '"' || quote === "'" || quote === '`') && value[value.length - 1] === quote) {
    return value.slice(1, -1).replace(/\\([\s\S])/g, (match, char) => {
      if (char === quote || char === '\\') return char;
      if (char === 'n') return '\n';
      if (char === 't') return '\t';
      return match;
    });
  }
  return value;
}

function normalizeKey(key) {
  return key.replace(/^["'`]|["'`]$/g, '').trim();
}

function cleanAgentName(value) {
  return cleanText(value).replace(/^work-workflow:/, '');
}

function cleanSkillName(value) {
  return cleanText(value)
    .replace(/^work-workflow:/, '')
    .replace(/^\//, '');
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function firstLine(value) {
  return (
    cleanText(value)
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || ''
  );
}

function runCli() {
  const lenient = process.argv.includes('--lenient');
  const input = fs.readFileSync(0, 'utf8');
  try {
    const delegates = parseClaudeDelegates(input, { lenient });
    const payload =
      lenient && delegates.errors?.length ? { delegates, errors: delegates.errors } : delegates;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  ClaudeDelegateParseError,
  parseClaudeTask,
  parseClaudeTasks,
  parseClaudeSkill,
  parseClaudeSkills,
  parseClaudeDelegates,
  toCodexAgentDelegate,
  toCodexSkillDelegate,
};

if (require.main === module) runCli();
