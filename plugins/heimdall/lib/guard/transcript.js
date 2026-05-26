'use strict';

/**
 * Transcript inspection: find which unlock phrases the user has spoken in
 * their recent messages. Speaking a phrase lifts the lock for entries that
 * share it, for a short window of subsequent tool calls.
 */

const fs = require('node:fs');

function extractContentText(item) {
  if (item.type === 'text') return item.text || '';
  if (item.type !== 'tool_result') return '';
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return item.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
}

function messagesFromLine(line) {
  const out = [];
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'user' || !parsed.message) return out;
    const mc = parsed.message.content;
    if (typeof mc === 'string') {
      out.push(mc);
      return out;
    }
    if (!Array.isArray(mc)) return out;
    for (const item of mc) {
      const text = extractContentText(item);
      if (text) out.push(text);
    }
  } catch {
    /* skip malformed line */
  }
  return out;
}

function getRecentUserMessages(transcriptPath, count = 20) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
    const userMessages = [];
    for (const line of lines) userMessages.push(...messagesFromLine(line));
    return userMessages.slice(-count);
  } catch {
    return [];
  }
}

function stripSystemTags(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim();
}

// Heimdall's own block message is emitted on stderr and echoed back into the
// transcript as a tool_result. Skip any message bearing this signature so the
// hook can never unlock itself by quoting the phrase in its own output.
const OWN_BLOCK_SIGNATURE = 'ACTION REQUIRED: Call the AskUserQuestion';

/** Set of unlock phrases (lowercased) spoken in recent user messages. */
function findUnlockedPhrases(transcriptPath, entries) {
  const phrases = new Set(entries.map((e) => (e.unlockPhrase || '').toLowerCase()).filter(Boolean));
  const unlocked = new Set();
  for (const msg of getRecentUserMessages(transcriptPath, 20)) {
    if (msg.includes(OWN_BLOCK_SIGNATURE)) continue;
    const normalized = stripSystemTags(msg).replace(/\s+/g, ' ').toLowerCase();
    for (const phrase of phrases) {
      if (normalized === phrase || normalized.includes(`="${phrase}"`)) unlocked.add(phrase);
    }
  }
  return unlocked;
}

function isEntryUnlocked(entry, unlockedPhrases) {
  return unlockedPhrases.has((entry.unlockPhrase || '').toLowerCase());
}

module.exports = { getRecentUserMessages, findUnlockedPhrases, isEntryUnlocked };
