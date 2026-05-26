'use strict';

/**
 * Orchestrates the per-tool checks and returns a verdict:
 *   { exitCode: 0 } → allow   |   { exitCode: 2, message } → block.
 */

const os = require('node:os');
const path = require('node:path');
const { findProtectedPathRef, findProtectedTarget, resolvePathSafe } = require('./paths');
const {
  hasGenericWriteIntent,
  isReadOnlyBashCommand,
  bashTargetsProtectedTarget,
} = require('./bash');
const { isReadOnlyTaskPrompt } = require('./task');
const { findUnlockedPhrases, isEntryUnlocked } = require('./transcript');
const { checkScriptBypass } = require('./scripts-bypass');

const ALLOW = { exitCode: 0, message: '' };

function blockMessage(reason, entry, matchContext) {
  // NOTE: deliberately avoid the `label="<phrase>"` token here. This message is
  // emitted on stderr and echoed back into the transcript as a tool_result; if it
  // contained `="<phrase>"` it would match the AskUserQuestion-answer heuristic in
  // findUnlockedPhrases and self-unlock the lock on the next tool call.
  let msg = `BLOCKED (heimdall): ${reason}\n`;
  if (entry) {
    const label = entry.unlockPhrase || `edit ${path.basename(entry.dir)}`;
    msg += `\nACTION REQUIRED: Call the AskUserQuestion tool with EXACTLY these two options:\n`;
    msg += `  Option 1 label -> ${label}  (Allow writing to ${path.basename(entry.dir)})\n`;
    msg += `  Option 2 label -> Skip  (Skip this operation)\n`;
    msg += `\nDo NOT ask in plain text. Do NOT try alternative approaches. Call AskUserQuestion NOW.\n`;
  }
  if (matchContext) msg += `MATCH: ${matchContext}\n`;
  return msg;
}

function block(reason, entry, ctx) {
  return { exitCode: 2, message: blockMessage(reason, entry, ctx) };
}

function isInAllowedSubdir(entry, normalizedPath) {
  if (entry.isFile || !entry.allowedPaths) return false;
  const relPath = path.relative(entry.dir, normalizedPath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return false;
  return entry.allowedPaths.includes(relPath.split(path.sep)[0]);
}

function evaluateFileTool(toolInput, entries, unlocked) {
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!filePath) return ALLOW;
  const normalizedPath = resolvePathSafe(filePath);
  const entry = findProtectedTarget(normalizedPath, entries);
  if (!entry) return ALLOW;
  if (isInAllowedSubdir(entry, normalizedPath)) return ALLOW;
  if (isEntryUnlocked(entry, unlocked)) return ALLOW;
  const shown = normalizedPath.replace(os.homedir(), '~');
  const kind = entry.isFile ? 'a protected file' : 'in a protected directory';
  return block(`${shown} is ${kind}`, entry, 'file-tool ' + path.basename(entry.dir));
}

function evaluateTask(toolInput, entries, unlocked) {
  const combined = JSON.stringify(toolInput).slice(0, 20000);
  const entry = findProtectedPathRef(combined, entries);
  if (!entry) return ALLOW;
  if (isEntryUnlocked(entry, unlocked)) return ALLOW;
  if (isReadOnlyTaskPrompt(combined)) return ALLOW;
  return block(
    `Task prompt references protected path (${path.basename(entry.dir)})`,
    entry,
    'task-prompt ' + path.basename(entry.dir)
  );
}

function evaluateBashScripts(command, entries, unlocked) {
  const collapsedCmd = command.replace(/\s*\n+\s*/g, ' ');
  for (const entry of entries) {
    if (entry.isFile) continue;
    const res = checkScriptBypass(collapsedCmd, entry, entries);
    if (!res.blocked) continue;
    if (res.error) return { exitCode: 2, message: `BLOCKED: ${res.error}. Blocking for safety.\n` };
    if (isEntryUnlocked(entry, unlocked)) return ALLOW;
    return block(
      `Script "${res.scriptPath}" writes to protected path (${path.basename(entry.dir)})`,
      entry,
      'script-write ' + path.basename(entry.dir)
    );
  }
  return ALLOW;
}

function evaluateBash(toolInput, entries, unlocked) {
  const command = toolInput.command || '';
  if (isReadOnlyBashCommand(command)) return ALLOW;

  const bashResult = bashTargetsProtectedTarget(command, entries);
  if (bashResult) {
    if (isEntryUnlocked(bashResult.entry, unlocked)) return ALLOW;
    const ctx =
      (bashResult.matchType === 'absolute-path' ? 'bash-absolute-path-write ' : 'bash-write ') +
      path.basename(bashResult.entry.dir);
    return block('Bash command targets protected path', bashResult.entry, ctx);
  }

  return evaluateBashScripts(command, entries, unlocked);
}

const HANDLERS = {
  Edit: evaluateFileTool,
  Write: evaluateFileTool,
  MultiEdit: evaluateFileTool,
  Task: evaluateTask,
  Bash: evaluateBash,
};

/** Evaluate one tool call against entries. */
function evaluate({ toolName, toolInput, transcriptPath, entries }) {
  if (!entries || entries.length === 0) return ALLOW;
  const handler = HANDLERS[toolName];
  if (!handler) return ALLOW;
  const unlocked = findUnlockedPhrases(transcriptPath, entries);
  return handler(toolInput || {}, entries, unlocked);
}

module.exports = { evaluate, blockMessage, ALLOW };
