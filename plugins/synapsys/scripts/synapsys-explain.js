#!/usr/bin/env node
'use strict';

/**
 * synapsys-explain — per-memory trigger debugger CLI for synapsys (GH-443).
 *
 *   node synapsys-explain.js --event=UserPromptSubmit --prompt="<text>"
 *   node synapsys-explain.js --event=PreToolUse --tool=Edit --tool-input='{...}'
 *   node synapsys-explain.js --stdin   (reads raw hook event JSON from stdin)
 *   node synapsys-explain.js [...] --only=name1,name2 --verbose --store=<name|path>
 *
 * Exit codes:
 *   0 — Always when configuration is valid (regardless of fire count).
 *   2 — Misconfiguration: invalid stdin JSON, invalid --tool-input JSON,
 *       unknown --store, malformed --event.
 *
 * Output:
 *   Default → compact table `Memory | Fired (✓/✗) | Reason` with footer
 *             `N/M memories fired.`
 *   --verbose → per-memory detail blocks (events list, trigger regex,
 *               matched alternative/substring or gate label + first 3 body lines).
 */

const fs = require('node:fs');
const path = require('node:path');

const { makeFlag } = require(path.join(__dirname, '..', 'lib', 'cli-args'));
const memoryStore = require(path.join(__dirname, '..', 'lib', 'memory-store'));
const matcher = require(path.join(__dirname, '..', 'lib', 'matcher'));

const VALID_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'SessionStart',
  'Stop',
]);

const REASON_COL_MAX = 24;

function die(msg, code = 2) {
  process.stderr.write(`synapsys-explain: ${msg}\n`);
  process.exit(code);
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseStdinPayload(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`invalid stdin JSON: ${err.message}`, 2);
  }
}

function parseToolInput(raw) {
  if (raw === undefined || raw === '' || raw === true) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`invalid --tool-input JSON: ${err.message}`, 2);
  }
}

function loadStore(storeFlag, cwd) {
  const stores = memoryStore.discoverStores(cwd);
  if (!storeFlag || storeFlag === true) {
    return stores;
  }
  // Match by kind name first, then by absolute path.
  const byName = stores.filter((s) => s.kind === storeFlag);
  if (byName.length) return byName;
  const abs = path.resolve(storeFlag);
  const byPath = stores.filter((s) => path.resolve(s.dir) === abs);
  if (byPath.length) return byPath;
  die(`unknown --store "${storeFlag}" (no matching discovered store)`, 2);
}

function loadMemories(stores) {
  const all = [];
  for (const s of stores) {
    all.push(...memoryStore.listMemoriesFromStore(s));
  }
  return all;
}

function evaluateMemory(memory, event, payload) {
  if (event === 'UserPromptSubmit') {
    return matcher.matchPrompt(memory, payload.prompt || '');
  }
  if (event === 'PreToolUse') {
    return matcher.matchPreTool(memory, payload);
  }
  if (event === 'SessionStart') {
    return matcher.matchSession(memory);
  }
  if (event === 'Stop') {
    return matcher.matchStop(memory);
  }
  return { fired: false, reason: 'events-exclude' };
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function renderTable(results) {
  const nameWidth = Math.max(
    6,
    ...results.map((r) => r.memory.name.length)
  );
  const out = [];
  const header = `${'Memory'.padEnd(nameWidth)} | Fired | ${'Reason'.padEnd(REASON_COL_MAX)}`;
  out.push(header);
  out.push('-'.repeat(header.length));

  let fired = 0;
  for (const r of results) {
    const mark = r.result.fired ? '✓' : '✗';
    if (r.result.fired) fired++;
    const reason = r.result.fired ? '' : (r.result.reason || '');
    out.push(
      `${r.memory.name.padEnd(nameWidth)} | ${mark}     | ${truncate(reason, REASON_COL_MAX).padEnd(REASON_COL_MAX)}`
    );
  }
  out.push('');
  out.push(`${fired}/${results.length} memories fired.`);
  return out.join('\n') + '\n';
}

function eventTriggerSource(memory, event) {
  if (event === 'UserPromptSubmit') return memory.triggerPrompt || '';
  if (event === 'PreToolUse') {
    const parts = [];
    if (memory.triggerPretool && memory.triggerPretool.length) {
      parts.push(`pretool: ${memory.triggerPretool.join(', ')}`);
    }
    if (memory.triggerPretoolContent && memory.triggerPretoolContent.length) {
      parts.push(`content: ${memory.triggerPretoolContent.join(', ')}`);
    }
    return parts.join(' | ');
  }
  if (event === 'SessionStart') return `trigger_session: ${memory.triggerSession}`;
  if (event === 'Stop') return '(unconditional on Stop)';
  return '';
}

function renderVerboseBlock(memory, result, event) {
  const lines = [];
  lines.push(`# ${memory.name}`);
  const eventsList = memory.events
    .map((e) => (e === event ? `${e} ✓` : e))
    .join(', ');
  lines.push(`  events: ${eventsList}`);
  const trig = eventTriggerSource(memory, event);
  if (trig) lines.push(`  trigger: ${trig}`);

  if (result.fired) {
    lines.push(`  fired: ✓`);
    const m = result.matched || {};
    if (m.prompt_token !== undefined) {
      lines.push(`  matched.prompt_token: ${m.prompt_token}`);
    }
    if (m.prompt_substring !== undefined) {
      lines.push(`  matched.prompt_substring: ${m.prompt_substring}`);
    }
    if (m.pretool_pattern !== undefined) {
      lines.push(`  matched.pretool_pattern: ${m.pretool_pattern}`);
    }
    if (m.content_pattern !== undefined) {
      lines.push(`  matched.content_pattern: ${m.content_pattern}`);
    }
    if (m.content_substring !== undefined) {
      lines.push(`  matched.content_substring: ${m.content_substring}`);
    }
  } else {
    lines.push(`  fired: ✗  (gate: ${result.reason || 'unknown'})`);
    const bodyLines = (memory.body || '').split('\n').filter(Boolean).slice(0, 3);
    if (bodyLines.length) {
      lines.push('  body (first 3 lines):');
      for (const bl of bodyLines) lines.push(`    ${bl}`);
    }
  }
  return lines.join('\n');
}

function renderVerbose(results, event) {
  const out = [];
  let fired = 0;
  for (const r of results) {
    if (r.result.fired) fired++;
    out.push(renderVerboseBlock(r.memory, r.result, event));
    out.push('');
  }
  out.push(`${fired}/${results.length} memories fired.`);
  return out.join('\n') + '\n';
}

function main() {
  const flag = makeFlag(process.argv.slice(2));

  const useStdin = !!flag('stdin');
  let stdinPayload = {};
  if (useStdin) {
    const raw = readStdinSync();
    stdinPayload = parseStdinPayload(raw);
  }

  const event =
    flag('event') ||
    stdinPayload.hook_event_name ||
    'UserPromptSubmit';
  if (!VALID_EVENTS.has(event)) {
    die(`unknown --event "${event}" (expected one of ${[...VALID_EVENTS].join(', ')})`, 2);
  }

  const cwd = flag('cwd') || stdinPayload.cwd || process.cwd();
  const prompt = flag('prompt') !== undefined ? flag('prompt') : stdinPayload.prompt;
  const tool = flag('tool') !== undefined ? flag('tool') : stdinPayload.tool_name;
  let toolInput;
  if (flag('tool-input') !== undefined) {
    toolInput = parseToolInput(flag('tool-input'));
  } else if (stdinPayload.tool_input !== undefined) {
    toolInput = stdinPayload.tool_input;
  }

  const verbose = !!flag('verbose');
  const onlyRaw = flag('only');
  const only =
    typeof onlyRaw === 'string'
      ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : null;

  const stores = loadStore(flag('store'), cwd);
  let memories = loadMemories(stores);

  if (only && only.length) {
    const names = new Set(memories.map((m) => m.name));
    for (const n of only) {
      if (!names.has(n)) {
        process.stderr.write(
          `synapsys-explain: --only name "${n}" not found in store\n`
        );
      }
    }
    const onlySet = new Set(only);
    memories = memories.filter((m) => onlySet.has(m.name));
  }

  const payload = {
    hook_event_name: event,
    prompt: prompt === true ? '' : (prompt || ''),
    tool_name: tool === true ? '' : (tool || ''),
    tool_input: toolInput || {},
    cwd,
  };

  const results = memories.map((memory) => ({
    memory,
    result: evaluateMemory(memory, event, payload),
  }));

  const rendered = verbose ? renderVerbose(results, event) : renderTable(results);
  process.stdout.write(rendered);
  process.exit(0);
}

main();
