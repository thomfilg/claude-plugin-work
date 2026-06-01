'use strict';

/**
 * create-phase-runner.js
 *
 * Factory that produces a self-paced `main(argv)` runner for `*-next.js`
 * workflows (brief, spec, ci, tasks, task-review, reports, pr-review,
 * completion, cleanup, qa, pr, code). Lifted from `brief-next.js`'s `main()`
 * orchestrator so each per-workflow runner can collapse to a thin wrapper.
 *
 * Contract:
 *   const main = createPhaseRunner({
 *     scriptName,         // e.g. 'brief-next.js' (used in messages + footer)
 *     phaseStateCliPath,  // absolute path to <foo>-phase-state.js
 *     initialPhase,       // e.g. BRIEF_INITIAL_PHASE
 *     getPhase,           // (name) => { next, validate(ctx), instructions(ctx) }
 *     usageHint,          // string printed to stderr on missing/invalid argv
 *   });
 *   main(process.argv);
 *
 * Per invocation:
 *   1. Resolve ticket context (tasks dir, manifest, linked siblings, memory plugin).
 *   2. Look up the current phase via the phase-state CLI.
 *   3. Ask the registered phase handler whether to advance (`validate(ctx)`).
 *   4. On ok + handler.next: record evidence + transition.
 *      On errors[]: render the block prefix.
 *      Otherwise: print current phase instructions (waiting).
 *   5. Print header + body + next-action footer.
 *
 * Exit codes: 0 = advanced or waiting, 2 = blocked or die().
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveTasksBaseWithFallback, resolveWorktreeRoot } = require('../ticket-validation');

let logNextScriptEvent;
try {
  ({ logNextScriptEvent } = require('../next-script-log'));
} catch {
  logNextScriptEvent = () => {};
}

/**
 * @param {object} opts
 * @param {string} opts.scriptName
 * @param {string} opts.phaseStateCliPath
 * @param {string} opts.initialPhase
 * @param {(name: string) => { next: string|null, validate: Function, instructions: Function }} opts.getPhase
 * @param {string} opts.usageHint
 * @returns {(argv: string[]) => void}
 */
function createPhaseRunner(opts) {
  const { scriptName, phaseStateCliPath, initialPhase, getPhase, usageHint } = opts;
  if (!scriptName || !phaseStateCliPath || !initialPhase || typeof getPhase !== 'function') {
    throw new Error('createPhaseRunner: missing required option(s)');
  }
  const usage = usageHint || `usage: ${scriptName} <TICKET>`;

  // ─── die() ───────────────────────────────────────────────────────────────
  function die(msg) {
    process.stderr.write(`${scriptName}: ${msg}\n`);
    process.exit(2);
  }

  // ─── Companion token snapshot / remint ───────────────────────────────────
  let _companionTokenSnapshot = null;

  function snapshotCompanionToken(stateCliBasename, ticketId) {
    try {
      const dir = process.env.CLAUDE_WRITE_TOKEN_DIR || '/tmp/.claude-write-tokens';
      const bareTicket = ticketId ? String(ticketId).split('/')[0] : null;
      const keyed = bareTicket ? path.join(dir, `${stateCliBasename}.${bareTicket}`) : null;
      const legacy = path.join(dir, stateCliBasename);
      const file = keyed && fs.existsSync(keyed) ? keyed : fs.existsSync(legacy) ? legacy : null;
      if (!file) return;
      _companionTokenSnapshot = { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* fail-open — phase recording will surface the missing token */
    }
  }

  function mintCompanionToken() {
    if (!_companionTokenSnapshot) return false;
    try {
      fs.mkdirSync(path.dirname(_companionTokenSnapshot.path), { recursive: true, mode: 0o700 });
      const data = { ..._companionTokenSnapshot.data, timestamp: Date.now() };
      fs.writeFileSync(_companionTokenSnapshot.path, JSON.stringify(data), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Memory plugin detection (best-effort, optional) ─────────────────────
  function detectMemoryPlugin(env = process.env) {
    try {
      const { loadMemoryPluginCandidates } = require('../../work-brief/lib/memory-plugin-config');
      const home = require('node:os').homedir();
      const candidates = loadMemoryPluginCandidates(env);
      for (const c of candidates) {
        for (const base of c.manifestGlob) {
          const dir = path.join(home, base);
          if (!fs.existsSync(dir)) continue;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          if (entries.some((e) => c.probe.test(e.name))) return c;
        }
      }
    } catch {
      /* memory plugin module is brief-specific; absence is fine */
    }
    return null;
  }

  // ─── related-tickets.json reading ────────────────────────────────────────
  function readRelatedManifest(tasksDir) {
    const p = path.join(tasksDir, 'related-tickets.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  function listLinkedIds(manifest) {
    if (!manifest) return [];
    const ids = new Set();
    if (manifest.parent && manifest.parent.id) ids.add(manifest.parent.id);
    for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo']) {
      for (const e of manifest[key] || []) if (e && e.id) ids.add(e.id);
    }
    return [...ids];
  }

  // ─── Phase state CLI wrappers ────────────────────────────────────────────
  function callPhaseCli(args) {
    mintCompanionToken();
    const r = spawnSync(process.execPath, [phaseStateCliPath, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
  }

  function getCurrentPhase(ticket) {
    const r = callPhaseCli(['current', ticket]);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.out.trim().split('\n').pop()).currentPhase;
    } catch {
      return null;
    }
  }

  function ensureInit(ticket) {
    const r = callPhaseCli(['init', ticket]);
    if (r.code !== 0) die(`Could not init phase state:\n${r.out}`);
  }

  function recordPhase(ticket, phase, summary) {
    return callPhaseCli(['record', ticket, phase, '--summary', summary || '']);
  }

  function transitionPhase(ticket, target) {
    return callPhaseCli(['transition', ticket, target]);
  }

  function advancePhase(ticket, phase, verdict, handler) {
    if (verdict.ok && handler.next) {
      const rec = recordPhase(ticket, phase, verdict.summary || '');
      if (rec.code !== 0) {
        return { advanced: false, phase, blockReason: `Could not record phase ${phase}:\n${rec.out}` };
      }
      const t = transitionPhase(ticket, handler.next);
      if (t.code !== 0) {
        return { advanced: false, phase, blockReason: `Could not transition to ${handler.next}:\n${t.out}` };
      }
      return { advanced: true, phase: handler.next, blockReason: '' };
    }
    if (Array.isArray(verdict.errors) && verdict.errors.length > 0) {
      return { advanced: false, phase, blockReason: verdict.errors.join('\n') };
    }
    return { advanced: false, phase, blockReason: '' };
  }

  function renderAndExit({ ticket, phase, ctx, advanced, blockReason, memory, linkedIds, startedAt }) {
    const resultLine = advanced
      ? '  result: PHASE ADVANCED'
      : blockReason
        ? '  result: BLOCKED'
        : '  result: WAITING';
    const header = [
      `${scriptName.replace(/\.js$/, '')}: ${ticket}`,
      `  tasks dir: ${ctx.tasksDir}`,
      `  current phase (after this run): ${phase}`,
      `  memory plugin: ${memory ? memory.name : '(none detected)'}`,
      `  linked tickets: ${linkedIds.length}${linkedIds.length ? ` (${linkedIds.join(', ')})` : ''}`,
      resultLine,
      '',
    ].join('\n');
    const instructions = getPhase(phase).instructions(ctx);
    const body =
      blockReason && !advanced
        ? [`## ❌ Phase ${phase.toUpperCase()} blocked`, '', '```', blockReason, '```', '', '---', '', instructions].join('\n')
        : instructions;
    process.stdout.write(header + '\n' + body);
    try {
      const { renderNextActionFooter } = require('../next-action-footer');
      process.stdout.write(
        renderNextActionFooter({ scriptName, ticket, phase, terminalPhase: 'done', advanced, blockReason })
      );
    } catch {
      /* footer is optional; absence must not break the runner */
    }
    const exitCode = blockReason && !advanced ? 2 : 0;
    logNextScriptEvent(scriptName.replace(/\.js$/, ''), {
      event: 'completed',
      ticket,
      phase,
      advanced,
      blocked: Boolean(blockReason),
      blockReason: blockReason ? blockReason.slice(0, 500) : null,
      linkedTickets: linkedIds.length,
      memoryPlugin: memory ? memory.name : null,
      exitCode,
      durationMs: Date.now() - startedAt,
    });
    process.exit(exitCode);
  }

  // ─── Orchestrator ────────────────────────────────────────────────────────
  function main(argv) {
    const startedAt = Date.now();
    const ticket = argv.slice(2)[0];
    if (!ticket || /^-/.test(ticket)) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }
    logNextScriptEvent(scriptName.replace(/\.js$/, ''), {
      event: 'invoked',
      ticket,
      cwd: process.cwd(),
      agent: process.env.CLAUDE_CURRENT_AGENT || null,
    });
    snapshotCompanionToken(path.basename(phaseStateCliPath), ticket);
    const tasksBase = resolveTasksBaseWithFallback();
    const tasksDir = path.join(tasksBase, ticket);
    if (!fs.existsSync(tasksDir)) die(`tasks dir not found: ${tasksDir}`);
    const manifest = readRelatedManifest(tasksDir);
    const linkedIds = listLinkedIds(manifest);
    const memory = detectMemoryPlugin();
    const worktreeRoot = resolveWorktreeRoot() || path.dirname(tasksBase);
    ensureInit(ticket);
    const startPhase = getCurrentPhase(ticket) || initialPhase;
    const ctx = { ticket, tasksDir, tasksBase, manifest, linkedIds, memory, worktreeRoot };
    const handler = getPhase(startPhase);
    const verdict = handler.validate(ctx);
    const { advanced, phase, blockReason } = advancePhase(ticket, startPhase, verdict, handler);
    renderAndExit({ ticket, phase, ctx, advanced, blockReason, memory, linkedIds, startedAt });
  }

  return main;
}

module.exports = { createPhaseRunner };
