/**
 * manifest.js — read/write helpers for orchestration manifests at
 * ~/.cache/maestro/sessions/<topic>.json.
 *
 * The daemon already READS manifests (findNextEligibleTask). This module
 * adds WRITE support so phase transitions (bootstrap, slot-freed, dead-end,
 * auto-restart) round-trip into the manifest — operator sees a live view of
 * pool state without polling tmux.
 */
const fs = require('fs');
const path = require('path');

const SESSION_MANIFEST_DIR =
  process.env.MAESTRO_SESSION_DIR ||
  path.join(process.env.HOME || '/tmp', '.cache', 'maestro', 'sessions');

function listManifestFiles() {
  if (!fs.existsSync(SESSION_MANIFEST_DIR)) return [];
  return fs
    .readdirSync(SESSION_MANIFEST_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(SESSION_MANIFEST_DIR, f));
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(file, manifest) {
  try {
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the manifest file + task entry for a ticket id. First match across
 * all manifests wins. Returns { file, manifest, task } or null.
 */
function findTask(taskId) {
  for (const file of listManifestFiles()) {
    const manifest = readManifest(file);
    if (!manifest || !Array.isArray(manifest.tasks)) continue;
    const task = manifest.tasks.find((t) => t.id === taskId);
    if (task) return { file, manifest, task };
  }
  return null;
}

/**
 * Update a task's status/note in whichever manifest owns it. No-op if the
 * task is not registered — manifests are append-only by the operator; the
 * daemon never invents new entries.
 */
function updateTaskStatus(taskId, status, note) {
  const hit = findTask(taskId);
  if (!hit) return false;
  hit.task.status = status;
  if (note !== undefined) hit.task.note = note;
  hit.task.updatedAt = new Date().toISOString();
  return writeManifest(hit.file, hit.manifest);
}

/**
 * Reconcile manifest task statuses against live tmux work-sessions.
 *
 *   - Each ticket with a live `<TICKET>-work` tmux session is marked
 *     `in_progress` (if not already terminal: awaiting-merge|blocked|done).
 *   - Each ticket currently `in_progress` whose tmux session vanished
 *     (killed by operator or by daemon rotation) is marked `stopped`.
 *
 * Terminal statuses are NEVER overwritten — operator owns those transitions.
 */
const TERMINAL = new Set(['awaiting-merge', 'blocked', 'done']);

function syncFromTmux(activeWorkSessions) {
  const aliveTickets = new Set(
    (activeWorkSessions || [])
      .map((s) => (s.match(/^(GH-\d+)-work$/) || [])[1])
      .filter(Boolean)
  );
  for (const file of listManifestFiles()) {
    const m = readManifest(file);
    if (!m || !Array.isArray(m.tasks)) continue;
    let dirty = false;
    for (const task of m.tasks) {
      if (TERMINAL.has(task.status)) continue;
      const isAlive = aliveTickets.has(task.id);
      if (isAlive && task.status !== 'in_progress') {
        task.status = 'in_progress';
        task.note = 'tmux session detected by daemon';
        task.updatedAt = new Date().toISOString();
        dirty = true;
      } else if (!isAlive && task.status === 'in_progress') {
        task.status = 'stopped';
        task.note = 'tmux session gone (killed or exited)';
        task.updatedAt = new Date().toISOString();
        dirty = true;
      }
    }
    if (dirty) writeManifest(file, m);
  }
}

/**
 * Pool-size check. Sums `slots` across all manifests (or per-topic) and
 * compares to current live work-session count. Returns true if pool is full.
 */
function poolFull(activeWorkSessions) {
  let totalSlots = 0;
  for (const file of listManifestFiles()) {
    const m = readManifest(file);
    if (!m) continue;
    if (typeof m.slots === 'number') totalSlots += m.slots;
  }
  if (totalSlots <= 0) return false;
  const live = (activeWorkSessions || []).filter((s) => /^GH-\d+-work$/.test(s)).length;
  return live >= totalSlots;
}

module.exports = {
  listManifestFiles,
  readManifest,
  writeManifest,
  findTask,
  updateTaskStatus,
  syncFromTmux,
  poolFull,
};
