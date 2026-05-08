/**
 * Step: monitor — Run follow-up-pr.js --once for a fast status check.
 *
 * Uses --once so the script does a single check (~15s) and returns immediately.
 * The follow-up2 orchestrator loop (monitor → triage → fix → push → monitor)
 * handles retries — we don't need follow-up-pr.js internal polling here.
 *
 * Exit codes: 0 = all clear, 1 = issues remain, 2 = error
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerMonitor(register) {
  register('monitor', (state, ctx) => {
    const scriptPath = path.join(ctx.workScriptsDir, 'follow-up-pr.js');
    const args = [scriptPath, '--once'];
    if (state.prNumber) args.push('--pr', String(state.prNumber));

    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, args, {
        encoding: 'utf8',
        timeout: 60000, // 1 min — --once is a single check
        cwd: ctx.worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      exitCode = 0;
    } catch (err) {
      exitCode = typeof err.status === 'number' ? err.status : 1;
      stdout =
        typeof err.stdout === 'string'
          ? err.stdout
          : Buffer.isBuffer(err.stdout)
            ? err.stdout.toString()
            : '';
      const stderr =
        typeof err.stderr === 'string'
          ? err.stderr
          : Buffer.isBuffer(err.stderr)
            ? err.stderr.toString()
            : '';
      if (stderr) stdout += '\n' + stderr;
    }

    state.lastMonitorResult = { exitCode, output: stdout.substring(0, 3000) };

    if (exitCode === 0) {
      // All clear — skip to report
      state.currentStep = 'report';
    }
    // exitCode 1 = issues remain → advance to triage
    // exitCode 2 = error → triage handles it

    return null;
  });
};
