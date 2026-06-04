/**
 * Pure log-processing helpers extracted from `lib/steps/fix-ci.js` so that
 * the new `infra-classifier.js` (Signal 4 raw-log scanner) and the existing
 * `fix-ci` step can share the same prefix-stripping / noise-filtering logic
 * without one importing the other.
 *
 * Both functions are pure (no I/O, no globals) and safe to call in tests.
 */

'use strict';

/**
 * Strip the `"<JobName>\t<StepName>\t<ISO timestamp>\t"` prefix that
 * `gh run view --log-failed` prepends to each line.
 *
 * @param {string} line - A single line from gh's failed-log output.
 * @returns {string} The line with the gh prefix removed, or the original
 *   line unchanged if no prefix is present.
 */
function stripGhPrefix(line) {
  // gh log lines: "JobName\tStepName\t2026-05-12T10:14:53.123Z message"
  return line.replace(/^[^\t]+\t[^\t]+\t\d{4}-\d{2}-\d{2}T[^\s]+\s?/, '');
}

/**
 * Strip gh prefixes from each line of `rawLogs`, then drop runner/setup
 * noise lines while preserving error/assertion/test output. Falls back to
 * the tail of stripped raw logs if the filter removed everything.
 *
 * @param {string} rawLogs - Multi-line raw output from `gh run view --log-failed`.
 * @returns {string} A noise-filtered, prefix-stripped log string (≤6000 chars).
 */
function filterLogs(rawLogs) {
  const stripped = rawLogs.split('\n').map(stripGhPrefix);
  const filtered = stripped
    .filter((line) => {
      if (!line.trim()) return false;
      // Drop runner setup / housekeeping noise
      if (/##\[group\]|##\[endgroup\]|Runner Image|Operating System/i.test(line)) return false;
      if (
        /runner version|Secret source|Prepare workflow|Download action|Getting action/i.test(line)
      )
        return false;
      if (/Image:|Version:|Commit:|Build Date:|Worker ID:|Azure Region:/i.test(line)) return false;
      if (/Permissions|Actions: read|Contents: read|Metadata: read|PullRequests:/i.test(line))
        return false;
      if (
        /Temporarily overriding HOME|safe\.directory|extraheader|submodule foreach|##\[warning\]Node\.js \d+ actions are deprecated/i.test(
          line
        )
      )
        return false;
      if (/\[command\]\/usr\/bin\/git/.test(line)) return false;
      if (/RESOLVEDSTATS|Cleaning up orphan|Docker container caching/i.test(line)) return false;
      // Keep error markers, assertions, test names, meaningful output
      if (/error|fail|assert|expect|timeout|ERR_|✗|✕|FAIL|Error:|×/i.test(line)) return true;
      if (/\.(spec|test)\.(ts|js|tsx|jsx)/.test(line)) return true;
      if (/^\s+at\s/.test(line)) return true;
      if (/exit code|exit\s+\d|SIGTERM|SIGKILL|Process completed/i.test(line)) return true;
      if (/Run tests|Run e2e|playwright/i.test(line)) return true;
      return false;
    })
    .join('\n')
    .substring(0, 6000);
  if (filtered.trim()) return filtered;
  // Fallback: tail of stripped raw logs when filter removed everything
  return stripped
    .filter((l) => l.trim())
    .slice(-120)
    .join('\n')
    .substring(0, 6000);
}

module.exports = { stripGhPrefix, filterLogs };
