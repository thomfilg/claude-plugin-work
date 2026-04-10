'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Execute a command safely using execFileSync (no shell interpolation).
 *
 * Drop-in replacement for the legacy `run()` helper that used `execSync`,
 * eliminating shell-injection risk by passing arguments as an array.
 *
 * @param {string} command  — absolute or PATH-resolved executable name
 * @param {string[]} [args] — argument list (never concatenated into a shell string)
 * @param {object}  [opts]  — options forwarded to execFileSync, plus:
 * @param {*}       [opts.fallback=''] — value returned when the command fails
 * @param {number}  [opts.timeout=15000] — execution timeout in ms
 * @param {string}  [opts.encoding='utf-8'] — output encoding
 * @param {string}  [opts.cwd] — working directory
 * @returns {string} trimmed stdout on success, or `opts.fallback` on error
 */
function safeExec(command, args = [], opts = {}) {
  const { fallback = '', ...execOpts } = opts;

  const finalOpts = {
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...execOpts,
  };

  try {
    return execFileSync(command, args, finalOpts).trim();
  } catch {
    return fallback;
  }
}

module.exports = { safeExec };
