/**
 * policies/agent-authorization.js
 *
 * Authorization helpers for agent/script gating extracted from enforce-step-workflow.js.
 *
 * Provides:
 *   - isTrustedScriptPath(scriptPath, trustedDirs): realpath-resolves & checks containment
 *   - expandPluginRoot(scriptPath): expands $CLAUDE_PLUGIN_ROOT for hook contexts
 *   - extractSubCommand(cmd, nodeMatch, scriptBasename): pulls the first/second non-flag arg
 *   - isSafeSubCommand(scriptBasename, subCmd, safeMap): membership check vs allowlist
 *   - isExemptScriptInvocation(cmd, opts): full Vector-3 exemption decision
 *
 * No process.exit, no logging. All decisions returned as booleans.
 */

const fs = require('fs');
const path = require('path');
const { getNodeInvocations } = require('./command-matching');

/**
 * Resolve symlinks and verify the script lives under one of the trusted directories.
 * Returns false on any FS error (file missing, permission denied) — fail-closed.
 */
function isTrustedScriptPath(scriptPath, trustedDirs) {
  try {
    const resolved = fs.realpathSync(path.resolve(scriptPath));
    return trustedDirs.some((dir) => resolved.startsWith(dir + path.sep));
  } catch {
    return false;
  }
}

/**
 * Expand `$CLAUDE_PLUGIN_ROOT` and `${CLAUDE_PLUGIN_ROOT}` in script paths.
 * Hook context does not perform shell variable expansion, so we do it here.
 */
function expandPluginRoot(scriptPath) {
  if (!process.env.CLAUDE_PLUGIN_ROOT) return scriptPath;
  return scriptPath
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.env.CLAUDE_PLUGIN_ROOT)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, process.env.CLAUDE_PLUGIN_ROOT);
}

/**
 * Extract the sub-command argument from a Bash command segment containing a node invocation.
 *
 * For workflow-state.js the sub-command is the 2nd non-flag arg (1st is workflow name).
 * For all other gated state scripts (e.g. work-state.js) it is the 1st non-flag arg.
 */
function extractSubCommand(cmd, nodeMatch, scriptBasename) {
  const afterScript = cmd.slice(nodeMatch.index + nodeMatch[0].length).trim();
  const args = afterScript.split(/\s+/).filter((a) => a && !a.startsWith('-'));
  const subCmdIndex = scriptBasename === 'workflow-state.js' ? 1 : 0;
  const rawSubCmd = args[subCmdIndex] || '';
  return rawSubCmd.replace(/^['"]|['"]$/g, '');
}

/**
 * Check if a sub-command is allowlisted for a particular state script.
 * Scripts with no entry in safeMap are unrestricted (return true).
 */
function isSafeSubCommand(scriptBasename, subCmd, safeMap) {
  const safeSet = safeMap[scriptBasename];
  if (!safeSet) return true;
  return safeSet.has(subCmd);
}

/**
 * Decide whether a Bash command should be exempted from state-file write protection
 * because it is a legitimate exempt-script invocation (e.g. workflow-engine.js get).
 *
 * Returns true ONLY when ALL invocations in the command satisfy:
 *   1. The script basename is in `exemptScripts`
 *   2. The resolved script path lives under a trusted directory
 *   3. The sub-command is in the safeSubcommands allowlist (if any)
 *
 * Any reference to a protected basename in the command itself disqualifies exemption,
 * preventing bypass via `echo "..." > .work-state.json` chained with an exempt invocation.
 *
 * @param {string} cmd
 * @param {object} opts
 * @param {Set<string>} opts.exemptScripts
 * @param {object} opts.safeSubcommands — { [scriptBasename]: Set<string> }
 * @param {string[]} opts.trustedDirs
 * @param {Set<string>} opts.protectedBasenames
 */
function isExemptScriptInvocation(cmd, opts) {
  const { exemptScripts, safeSubcommands, trustedDirs, protectedBasenames } = opts;
  const cmdStr = String(cmd || '').trim();
  if (!cmdStr) return false;

  // Disqualify if any protected basename appears literally in the command
  for (const bn of protectedBasenames) {
    if (cmdStr.includes(bn)) return false;
  }

  const matches = getNodeInvocations(cmdStr);
  if (matches.length === 0) return false;

  for (const nodeMatch of matches) {
    const rawScriptPath = nodeMatch[1] || nodeMatch[2] || nodeMatch[3];
    const scriptPath = expandPluginRoot(rawScriptPath);
    const scriptBase = path.basename(scriptPath);

    if (!exemptScripts.has(scriptBase)) return false;
    if (!isTrustedScriptPath(scriptPath, trustedDirs)) return false;

    const subCmd = extractSubCommand(cmdStr, nodeMatch, scriptBase);
    if (!isSafeSubCommand(scriptBase, subCmd, safeSubcommands)) return false;
  }

  return true;
}

module.exports = {
  isTrustedScriptPath,
  expandPluginRoot,
  extractSubCommand,
  isSafeSubCommand,
  isExemptScriptInvocation,
};
