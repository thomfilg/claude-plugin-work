/**
 * actions.js — what to do when a detector fires.
 *
 * Three actions, mapped from phase-registry.escalationFor():
 *   soft      → send a message into the agent prompt (no interrupt)
 *   interrupt → send Esc, wait, send message (used when soft nudge was ignored
 *               or when a spinner is clearly hung)
 *   alert     → no agent action; write to the maestro alert sink
 *
 * Nudge text is intentionally generic; the agent decides how to land
 * uncommitted work (the 'commit agent' is the orchestrator's commit-writer).
 * Avoid literal CLI strings that trip the enforce-agent-usage hook.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const alerts = require('./alerts');
const state = require('./state');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SKILL_NAME = process.env.SKILL_NAME || 'work';

// Restart-loop guard: how many auto-restarts within RESTART_WINDOW_MIN before
// we declare the session WEDGED and stop restarting. Caller is freed of state
// management — autoRestart() owns the marker.
const RESTART_LOOP_THRESHOLD = parseInt(process.env.RESTART_LOOP_THRESHOLD || '3', 10);
const RESTART_WINDOW_MIN = parseInt(process.env.RESTART_WINDOW_MIN || '30', 10);
const WEDGED_QUIET_MIN = parseInt(process.env.WEDGED_QUIET_MIN || '60', 10);

function msgFor(reason, mode) {
  const base = `MAESTRO (${mode}): ${reason}. Audit uncommitted files via git status. If any are present, dispatch the commit agent with 'autonomous' to land them, then push. Re-run task-next.js to advance the gate.`;
  if (mode === 'interrupt') {
    return `${base} I sent Esc to break any stuck subagent — do NOT re-dispatch the same one without diagnosing why it hung.`;
  }
  return base;
}

function soft(session, reason) {
  alerts.log(`${session} NUDGE soft: ${reason}`);
  tmux.sendLine(session, msgFor(reason, 'soft'));
}

function interrupt(session, reason) {
  alerts.log(`${session} NUDGE interrupt: ${reason}`);
  tmux.sendKey(session, 'Escape');
  // Brief pause so the TUI registers the Esc before we push text.
  // Use spawnSync('sleep') so we block without pinning a CPU core.
  spawnSync('sleep', ['1.5']);
  tmux.sendLine(session, msgFor(reason, 'interrupt'));
}

function alert(reasonObj) {
  alerts.alert(reasonObj);
}

/**
 * Auto-restart a dead -work session in place: kill the existing tmux
 * session, then relaunch `claude --dangerously-skip-permissions /<skill> <ticket>`
 * inside the worktree. Returns true if the restart command was issued.
 *
 * Ported from maestro-conduct.sh's auto-restart branch. Caller is responsible
 * for restart eligibility (only -work sessions) and for clearing per-ticket
 * markers after the restart so detectors don't fire against the stale state.
 */
function autoRestart({ session, ticket, worktree, silenceSec }) {
  if (!worktree || !fs.existsSync(worktree)) {
    alerts.log(`${session} AUTO-RESTART skipped: worktree ${worktree} not found`);
    return false;
  }

  // Restart-loop guard. Read the per-session marker once and decide whether
  // we're still in the "WEDGED quiet" window from a prior loop. The marker
  // shape:
  //   { restarts: [unix_ts, ...], wedgedUntil?: unix_ts }
  // restarts[] is pruned to the last RESTART_WINDOW_MIN.
  const now = state.now();
  const marker = state.read(session, 'restart-loop') || { restarts: [] };

  if (marker.wedgedUntil && marker.wedgedUntil > now) {
    // Already declared wedged — don't restart, don't re-alert. We logged on
    // entry; further silence triggers can re-read this marker silently.
    return false;
  }

  // Prune older entries outside the rolling window.
  const cutoff = now - RESTART_WINDOW_MIN * 60;
  const restarts = (marker.restarts || []).filter((t) => t >= cutoff);

  // If we'd be at-or-over the threshold AFTER this restart, declare wedged
  // INSTEAD of restarting. The operator must intervene.
  if (restarts.length + 1 >= RESTART_LOOP_THRESHOLD) {
    const wedgedUntil = now + WEDGED_QUIET_MIN * 60;
    state.write(session, 'restart-loop', { restarts: [...restarts, now], wedgedUntil });
    alerts.log(
      `${session} WEDGED — ${restarts.length + 1} auto-restarts in ${RESTART_WINDOW_MIN}m; suppressing restarts for ${WEDGED_QUIET_MIN}m`
    );
    alerts.alert({
      session,
      ticket,
      kind: 'wedged',
      restartsInWindow: restarts.length + 1,
      windowMin: RESTART_WINDOW_MIN,
      quietMin: WEDGED_QUIET_MIN,
      silenceSec,
    });
    return false;
  }

  // Record this restart and proceed.
  state.write(session, 'restart-loop', { restarts: [...restarts, now] });

  alerts.log(
    `${session} AUTO-RESTART after ${silenceSec}s silence — relaunching /${SKILL_NAME} ${ticket}`
  );
  // Kill the dead session (no-op if already gone).
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  // Relaunch in-place. argv form so the worktree path / ticket can't be
  // interpreted by a shell.
  spawnSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      worktree,
      `${CLAUDE_BIN} --dangerously-skip-permissions '/${SKILL_NAME} ${ticket}'`,
    ],
    { stdio: 'ignore' }
  );
  return true;
}

/**
 * freeCIGateSlot — kill the -work and -listen panes of a ticket whose PR has
 * reached CI gate (CLEAN/SUCCESS, awaiting operator merge). Emits a
 * structured alert kind=slot-freed so the orchestrator can bootstrap the next
 * ticket. Idempotent: writes a per-ticket marker so repeated pr-ready emits
 * on the same SHA don't try to kill an already-killed session.
 *
 * No-op if AUTO_FREE_CI_SLOT=0.
 */
function freeCIGateSlot({ session, ticket, prNumber, sha }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(session, 'slot-freed') || {};
  if (marker.sha === sha) return false; // already freed for this SHA
  // Kill -work and -listen panes. Tmux kill-session is idempotent; ignore errors.
  for (const suffix of ['work', 'listen']) {
    spawnSync('tmux', ['kill-session', '-t', `${ticket}-${suffix}`], { stdio: 'ignore' });
  }
  state.write(session, 'slot-freed', { sha, prNumber, freedAt: state.now() });
  alerts.log(
    `${session} SLOT-FREED at CI gate — PR #${prNumber} sha=${(sha || '').slice(0, 7)} awaiting operator merge; tmux -work + -listen killed`
  );
  alert({
    session,
    ticket,
    kind: 'slot-freed',
    prNumber,
    sha,
    reason: 'pr-ready at CI gate — auto-killed to free pool slot',
  });
  return true;
}

module.exports = { soft, interrupt, alert, autoRestart, freeCIGateSlot };
