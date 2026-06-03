#!/usr/bin/env node
'use strict';

/**
 * synapsys-status — report the live active domain set for the current session.
 *
 *   node synapsys-status.js [--session-id=<id>] [--prompt=<text>]
 *                           [--tool=<ToolName:args>]... [--json] [--no-color]
 *
 * Reads:
 *   - Domain registry: $HOME/.claude/synapsys/DOMAINS.md (Task 2)
 *   - Sticky state:    $HOME/.claude/synapsys/.state/sticky-domains.json (Task 5)
 *
 * Computes the active-domain set via classifier + sticky carry-over (Task 6)
 * and prints each domain with signal attribution:
 *   - which leaf's `signal_prompt` matched, or
 *   - which leaf's `signal_pretool` matched, or
 *   - "sticky-carry" when the entry is carried by hysteresis.
 *
 * Fail-open: missing registry/state, parse errors, unknown signals → still
 * exits 0 with "no active domains" (or whatever subset we could compute).
 */

const path = require('node:path');
const os = require('node:os');

const { makeFlag } = require('../lib/cli-args');
const { loadDomainRegistry } = require('../lib/domains');
const { loadStickyState } = require('../lib/sticky-state');
const { classifyWithSticky, iterateLeafSignals } = require('../lib/classifier');

function parseArgs(argv) {
  const flag = makeFlag(argv);
  const tools = argv
    .filter((a) => a === '--tool' || a.startsWith('--tool='))
    .map((a) => (a.indexOf('=') === -1 ? '' : a.slice(a.indexOf('=') + 1)))
    .filter(Boolean);
  return {
    sessionId: typeof flag('session-id') === 'string' ? flag('session-id') : 'default',
    prompt: typeof flag('prompt') === 'string' ? flag('prompt') : '',
    tools,
    json: !!flag('json'),
    noColor: !!flag('no-color') || process.env.NO_COLOR === '1' || !process.stdout.isTTY,
  };
}

/**
 * For each active domain, work out *why* it is active.
 *
 * Priority order:
 *   1. signal_prompt match  → "prompt: /<re>/"
 *   2. signal_pretool match → "pretool: /<re>/ on <tool>"
 *   3. sticky carry         → "sticky-carry"
 *
 * @returns {Map<string, { kind: 'prompt'|'pretool'|'sticky', detail: string }>}
 */
function attribute({ active, registry, prompt, tools, stickySession }) {
  const attribution = new Map();
  // First pass: walk leaves once and record prompt/pretool matches.
  for (const { rootName, leafName, leaf } of iterateLeafSignals(registry)) {
    const rootKey = rootName;
    const leafKey = `${rootName}:${leafName}`;
    if (!active.has(rootKey) && !active.has(leafKey)) continue;

    // prompt
    for (const re of Array.isArray(leaf.signal_prompt) ? leaf.signal_prompt : []) {
      if (re && typeof re.test === 'function' && prompt && re.test(prompt)) {
        const a = { kind: 'prompt', detail: `signal_prompt ${re}` };
        if (!attribution.has(leafKey)) attribution.set(leafKey, a);
        if (!attribution.has(rootKey)) attribution.set(rootKey, a);
        break;
      }
    }
    // pretool
    if (!attribution.has(leafKey)) {
      for (const re of Array.isArray(leaf.signal_pretool) ? leaf.signal_pretool : []) {
        if (!re || typeof re.test !== 'function') continue;
        const hit = tools.find((t) => typeof t === 'string' && re.test(t));
        if (hit) {
          const a = { kind: 'pretool', detail: `signal_pretool ${re} on ${hit}` };
          if (!attribution.has(leafKey)) attribution.set(leafKey, a);
          if (!attribution.has(rootKey)) attribution.set(rootKey, a);
          break;
        }
      }
    }
  }
  // Sticky fallback for anything still unattributed.
  for (const domain of active) {
    if (attribution.has(domain)) continue;
    const stickyEntry = stickySession && stickySession[domain];
    if (stickyEntry && stickyEntry.sticky === true) {
      attribution.set(domain, { kind: 'sticky', detail: 'sticky-carry' });
    } else {
      attribution.set(domain, { kind: 'sticky', detail: 'carried' });
    }
  }
  return attribution;
}

function main(argv) {
  const opts = parseArgs(argv);
  const home = process.env.SYNAPSYS_HOME || process.env.HOME || os.homedir();
  const stickyPath = path.join(home, '.claude', 'synapsys', '.state', 'sticky-domains.json');

  let registry = { roots: new Map() };
  try {
    registry = loadDomainRegistry({ home });
  } catch (_) {
    // fail-open
  }

  let stickyState = {};
  try {
    stickyState = loadStickyState({ filePath: stickyPath });
  } catch (_) {
    // fail-open
  }

  let active = new Set();
  try {
    const result = classifyWithSticky({
      prompt: opts.prompt,
      recentToolCalls: opts.tools,
      registry,
      stickyState,
      sessionId: opts.sessionId,
    });
    active = result.activeDomains;
  } catch (_) {
    // fail-open
  }

  const stickySession = (stickyState && stickyState[opts.sessionId]) || {};
  const attribution = attribute({
    active,
    registry,
    prompt: opts.prompt,
    tools: opts.tools,
    stickySession,
  });

  if (opts.json) {
    const sortedActive = [...active].sort();
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: opts.sessionId,
          active: sortedActive,
          attribution: sortedActive.map((d) => ({
            domain: d,
            ...(attribution.get(d) || { kind: 'unknown', detail: '' }),
          })),
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  const C = opts.noColor
    ? new Proxy({}, { get: () => (s) => String(s) })
    : {
        dim: (s) => `\x1b[2m${s}\x1b[0m`,
        bold: (s) => `\x1b[1m${s}\x1b[0m`,
        cyan: (s) => `\x1b[36m${s}\x1b[0m`,
        green: (s) => `\x1b[32m${s}\x1b[0m`,
        yellow: (s) => `\x1b[33m${s}\x1b[0m`,
        magenta: (s) => `\x1b[35m${s}\x1b[0m`,
      };

  if (active.size === 0) {
    process.stdout.write(`${C.dim('no active domains')}\n`);
    return 0;
  }

  process.stdout.write(`${C.bold('Active domains')} ${C.dim('·')} session=${opts.sessionId}\n`);
  for (const domain of [...active].sort()) {
    const a = attribution.get(domain) || { kind: 'unknown', detail: '' };
    process.stdout.write(
      `  ${C.green(domain)}  ${C.dim('—')} ${C.magenta(a.kind)}: ${a.detail}\n`
    );
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (_) {
    // Last-resort fail-open.
    process.stdout.write('no active domains\n');
    process.exit(0);
  }
}

module.exports = { parseArgs, attribute, main };
