/**
 * protect-state-files.js
 *
 * Generic, reusable file protection for Claude Code hooks.
 * Blocks AI from writing to protected files via any vector:
 *   - Edit / Write / MultiEdit (file_path basename)
 *   - Bash shell operators (>, >>, tee, cp, mv, dd of=)
 *   - Node.js fs calls in Bash (writeFileSync, appendFileSync, etc.)
 *
 * Usage:
 *   const { createFileProtector } = require('./lib/protect-state-files');
 *
 *   const protector = createFileProtector({
 *     isProtected: (filePath) => basename === '.secret.json',
 *     isExempt: (toolName, toolInput, hookData) => hookData.transcript_path?.includes('admin'),
 *   });
 *
 *   // In your hook handler:
 *   const result = protector.check(toolName, toolInput, hookData);
 *   if (result.blocked) {
 *     process.stderr.write(result.message);
 *     process.exit(2);
 *   }
 *   if (result.skipRemainingChecks) return; // file tool with no match — no further checks needed
 */

const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Tools that write via file_path */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Shell write operators — redirects, tee, cp, mv, dd */
const BASH_WRITE_OPS = /(?:>{1,2}|\btee\b|\bcp\b|\bmv\b|\bdd\b.*\bof=)/;

/** Node.js fs write calls executed via Bash (node -e, inline scripts) */
const NODE_FS_WRITES = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\b/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a Set of basenames from workflow definitions + extras.
 * Convenience for the common case of protecting state files by basename.
 *
 * @param {Array<{stateFile: string, evidenceFile: string}>} workflows
 * @param {string[]} [extraFiles]
 * @returns {Set<string>}
 */
function buildProtectedBasenames(workflows, extraFiles = []) {
  return new Set([
    ...workflows.map(wf => wf.stateFile),
    ...workflows.map(wf => wf.evidenceFile),
    ...extraFiles,
  ]);
}

/**
 * Create a basename-based isProtected function from a Set.
 * @param {Set<string>} basenames
 * @returns {(filePath: string) => string|null} — returns matched basename or null
 */
function basenameProtector(basenames) {
  return (filePath) => {
    const bn = path.basename(filePath);
    return basenames.has(bn) ? bn : null;
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a file protector instance.
 *
 * @param {object} opts
 * @param {(filePath: string) => string|null} opts.isProtected
 *   Returns a label (e.g. matched basename) if the file is protected, null otherwise.
 *   Called with the resolved file path from tool_input.
 *
 * @param {(toolName: string, toolInput: object, hookData?: object) => boolean} [opts.isExempt]
 *   Returns true if this specific call should be allowed despite targeting a protected file.
 *   Called before blocking. Defaults to () => false.
 *
 * @param {(match: string, vector: string) => string} [opts.formatMessage]
 *   Custom block message formatter. Receives the matched label and vector ('Edit'|'Bash'|etc).
 *   Defaults to a generic message.
 *
 * @returns {{ check: (toolName: string, toolInput: object, hookData?: object) => CheckResult }}
 *
 * @typedef {object} CheckResult
 * @property {boolean} blocked — true if the operation should be blocked
 * @property {string} [match] — the label from isProtected (e.g. basename)
 * @property {string} [vector] — the attack vector ('Edit'|'Write'|'MultiEdit'|'Bash')
 * @property {string} [message] — formatted block message
 * @property {boolean} skipRemainingChecks — true for file tools (Edit/Write/MultiEdit) whether blocked or not
 */
function createFileProtector(opts) {
  const { isProtected, isExempt = () => false, formatMessage } = opts;

  const defaultMessage = (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `Protected files must only be modified through their designated scripts.\n`;

  const fmt = formatMessage || defaultMessage;

  function check(toolName, toolInput, hookData) {
    // ── Vector 1: Edit / Write / MultiEdit ────────────────────────────────
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const filePath = toolInput?.file_path || '';
      if (!filePath) return { blocked: false, skipRemainingChecks: true };

      const match = isProtected(filePath);
      if (match && !isExempt(toolName, toolInput, hookData)) {
        return {
          blocked: true,
          match,
          vector: toolName,
          message: fmt(match, toolName),
          skipRemainingChecks: true,
        };
      }
      return { blocked: false, skipRemainingChecks: true };
    }

    // ── Vector 2: Bash shell writes ───────────────────────────────────────
    if (toolName === 'Bash') {
      const cmd = String(toolInput?.command || '');
      const hasShellWrite = BASH_WRITE_OPS.test(cmd);
      const hasNodeWrite = NODE_FS_WRITES.test(cmd);

      if (hasShellWrite || hasNodeWrite) {
        // Extract all file-path-like tokens from the command and check each
        const tokens = cmd.match(/[^\s"'|;&()]+/g) || [];
        for (const token of tokens) {
          const match = isProtected(token);
          if (match && !isExempt(toolName, toolInput, hookData)) {
            return {
              blocked: true,
              match,
              vector: 'Bash',
              message: fmt(match, 'Bash'),
              skipRemainingChecks: false,
            };
          }
        }
      }
    }

    return { blocked: false, skipRemainingChecks: false };
  }

  return { check };
}

module.exports = {
  FILE_WRITE_TOOLS,
  BASH_WRITE_OPS,
  NODE_FS_WRITES,
  buildProtectedBasenames,
  basenameProtector,
  createFileProtector,
};
