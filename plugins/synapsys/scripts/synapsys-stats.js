#!/usr/bin/env node
'use strict';

/**
 * synapsys:stats — aggregate per-memory telemetry from
 * `.telemetry/*.jsonl` files across discoverable stores and emit three
 * sections (Top influencers / Noise candidates / Never-fired) within
 * a time window selectable via `--last=<Nd>` (default `7d`).
 *
 * Pure helpers (parseWindow, readJsonlInWindow, aggregate, formatSections)
 * are exported for unit tests; CLI runs only when invoked directly.
 */

const {
  fs,
  path,
  setupCli,
  discoverStores,
  listMemoriesFromStore,
} = require(require('node:path').join(__dirname, '..', 'lib', 'script-bootstrap'));

const NOISE_FIRED_THRESHOLD = 10;

function parseWindow(spec) {
  const s = String(spec || '7d').trim();
  const m = s.match(/^(\d+)d$/i);
  const days = m ? parseInt(m[1], 10) : 7;
  return days * 24 * 60 * 60 * 1000;
}

function telemetryDirFor(store) {
  return path.join(store.dir, '.telemetry');
}

function listJsonlFiles(telDir) {
  let entries;
  try {
    entries = fs.readdirSync(telDir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(telDir, n));
}

function readJsonlInWindow(file, cutoffMs) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (stat.mtimeMs < cutoffMs) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // malformed line — skip, fail-open
    }
  }
  return out;
}

function aggregate(cwd, { windowMs }) {
  const cutoff = Date.now() - windowMs;
  const stores = discoverStores(cwd);
  const counts = new Map(); // name → { fired, cited }
  const known = new Set();

  for (const store of stores) {
    for (const mem of listMemoriesFromStore(store)) {
      if (mem && mem.name) known.add(mem.name);
    }
    for (const file of listJsonlFiles(telemetryDirFor(store))) {
      const events = readJsonlInWindow(file, cutoff);
      for (const ev of events) {
        if (!ev || !ev.memory || !ev.event) continue;
        const c = counts.get(ev.memory) || { fired: 0, cited: 0 };
        if (ev.event === 'fired') c.fired += 1;
        else if (ev.event === 'cited') c.cited += 1;
        counts.set(ev.memory, c);
      }
    }
  }

  // Include zero-fire known memories so Never-fired can list them.
  for (const name of known) {
    if (!counts.has(name)) counts.set(name, { fired: 0, cited: 0 });
  }

  const perMemory = Array.from(counts.entries()).map(([name, c]) => ({
    name,
    fired: c.fired,
    cited: c.cited,
    known: known.has(name),
  }));

  return { perMemory, known: Array.from(known) };
}

function formatSections(stats, { color = false } = {}) {
  const { perMemory } = stats;

  const top = perMemory
    .filter((m) => m.cited > 0)
    .sort((a, b) => {
      if (b.cited !== a.cited) return b.cited - a.cited;
      return b.fired * b.cited - a.fired * a.cited;
    });

  const noise = perMemory
    .filter((m) => m.fired >= NOISE_FIRED_THRESHOLD && m.cited === 0)
    .sort((a, b) => b.fired - a.fired);

  const never = perMemory
    .filter((m) => m.known && m.fired === 0 && m.cited === 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = [];
  lines.push('Top influencers (fired × cited):');
  if (top.length === 0) lines.push('  (none)');
  for (const m of top) {
    const ratio = m.fired === 0 ? 0 : (m.cited / m.fired).toFixed(2);
    lines.push(`  ${m.name}   fired:${m.fired}  cited:${m.cited}  influence:${ratio}  keep`);
  }
  lines.push('');
  lines.push('Noise candidates (fired ≥10, cited:0):');
  if (noise.length === 0) lines.push('  (none)');
  for (const m of noise) {
    lines.push(`  ${m.name}   fired:${m.fired}  cited:${m.cited}  narrow trigger or delete`);
  }
  lines.push('');
  lines.push('Never-fired (consider deletion or session-start docs instead):');
  if (never.length === 0) lines.push('  (none)');
  for (const m of never) {
    lines.push(`  ${m.name}   fired:0  cited:0`);
  }
  void color;
  return lines.join('\n') + '\n';
}

function main() {
  const { flag, cwd } = setupCli();
  const windowMs = parseWindow(flag('last') || '7d');
  const useColor = !flag('no-color');
  let stats;
  try {
    stats = aggregate(cwd, { windowMs });
  } catch (err) {
    process.stderr.write(`synapsys:stats: aggregation error: ${err.message}\n`);
    stats = { perMemory: [], known: [] };
  }
  if (flag('json')) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  } else {
    process.stdout.write(formatSections(stats, { color: useColor }));
  }
  process.exit(0);
}

module.exports = {
  parseWindow,
  readJsonlInWindow,
  aggregate,
  formatSections,
};

if (require.main === module) {
  main();
}
