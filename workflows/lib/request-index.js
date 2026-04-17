/**
 * request-index.js — Atomic counter ledger for out-of-flow request allocation (GH-219 Task 10)
 *
 * Manages `.request-index.json` per ticket directory with collision-safe increments.
 * Format: `{ "userSeq": n, "aiSeq": m, "version": 1 }`
 *
 * Uses the atomic rename pattern (write temp → rename) from session-guard.js.
 *
 * Requirements:
 *   R9:  Out-of-flow user routing — `user-request-${n}`
 *   R10: Out-of-flow AI routing — `ai-request-${n}`
 *   R11: Persistent `.request-index.json` with collision-safe increments
 *   R7:  Allocator completion — wires the stubs from Task 9
 *
 * @module request-index
 */

const fs = require('fs');
const path = require('path');

const { USER_REQUEST_PREFIX, AI_REQUEST_PREFIX } = require('./allocate-output-folder');

// ─── Constants ───────────────────────────────────────────────────────────────

const INDEX_FILENAME = '.request-index.json';
const INDEX_VERSION = 1;

/** @type {RegExp} Reject path-traversal sequences, backslashes, and null bytes */
const UNSAFE_TICKET_RE = /\.\.|[\\]|\x00/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve TASKS_BASE from environment.
 * @returns {string}
 */
function resolveTasksBase() {
  if (process.env.TASKS_BASE) return process.env.TASKS_BASE;
  throw new Error('TASKS_BASE is not configured. Set the TASKS_BASE environment variable.');
}

/**
 * Validate ticket ID — fail-closed before any filesystem I/O.
 * @param {unknown} ticketId
 */
function validateTicketId(ticketId) {
  if (typeof ticketId !== 'string' || ticketId.length === 0) {
    throw new Error(
      `Invalid ticket ID: expected non-empty string, received ${typeof ticketId === 'string' ? '""' : typeof ticketId}`
    );
  }
  if (UNSAFE_TICKET_RE.test(ticketId)) {
    throw new Error(
      `Invalid ticket ID: contains unsafe characters (path traversal, backslash, or null byte): "${ticketId}"`
    );
  }
}

/**
 * Sanitize ticket ID for filesystem paths using config.safeTicketId when available.
 * @param {string} ticketId
 * @returns {string}
 */
function sanitizeId(ticketId) {
  try {
    const config = require('./config');
    if (config && typeof config.safeTicketId === 'function') {
      return config.safeTicketId(ticketId);
    }
  } catch {
    // fallback to raw ID
  }
  return ticketId;
}

/**
 * Resolve the ticket directory path.
 * @param {string} ticketId
 * @returns {string}
 */
function ticketDir(ticketId) {
  return path.join(resolveTasksBase(), sanitizeId(ticketId));
}

/**
 * Resolve the `.request-index.json` path for a ticket.
 * @param {string} ticketId
 * @returns {string}
 */
function indexPath(ticketId) {
  return path.join(ticketDir(ticketId), INDEX_FILENAME);
}

/**
 * @typedef {Object} RequestIndex
 * @property {number} userSeq - Current user request sequence number
 * @property {number} aiSeq - Current AI request sequence number
 * @property {number} version - Schema version
 */

/**
 * Read the current index from disk. Returns zeroed defaults if the file does not exist.
 * @param {string} ticketId
 * @returns {RequestIndex}
 */
function readIndex(ticketId) {
  validateTicketId(ticketId);
  const filePath = indexPath(ticketId);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      userSeq: typeof raw.userSeq === 'number' ? raw.userSeq : 0,
      aiSeq: typeof raw.aiSeq === 'number' ? raw.aiSeq : 0,
      version: INDEX_VERSION,
    };
  } catch {
    return { userSeq: 0, aiSeq: 0, version: INDEX_VERSION };
  }
}

/**
 * Write index atomically: write to temp file, then rename.
 * Pattern borrowed from session-guard.js writeSessionAtomic.
 * @param {string} ticketId
 * @param {RequestIndex} data
 */
function writeIndexAtomic(ticketId, data) {
  const target = indexPath(ticketId);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o644 });
  try {
    try {
      fs.unlinkSync(target);
    } catch {
      /* ENOENT — target doesn't exist yet */
    }
    fs.renameSync(tmp, target);
  } catch (renameErr) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* cleanup best-effort */
    }
    throw renameErr;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AllocationResult
 * @property {number} seq - The allocated sequence number
 * @property {string} segment - Directory segment name (e.g. "user-request-1")
 * @property {string} root - Absolute path to the allocated directory
 */

/**
 * Allocate the next user-request folder, incrementing the counter atomically.
 *
 * @param {string} ticketId
 * @returns {AllocationResult}
 */
function nextUserRequest(ticketId) {
  validateTicketId(ticketId);
  const current = readIndex(ticketId);
  const nextSeq = current.userSeq + 1;
  const updated = { ...current, userSeq: nextSeq };
  writeIndexAtomic(ticketId, updated);

  const segment = `${USER_REQUEST_PREFIX}${nextSeq}`;
  const root = path.join(ticketDir(ticketId), segment);
  fs.mkdirSync(root, { recursive: true });

  return { seq: nextSeq, segment, root };
}

/**
 * Allocate the next ai-request folder, incrementing the counter atomically.
 *
 * @param {string} ticketId
 * @returns {AllocationResult}
 */
function nextAiRequest(ticketId) {
  validateTicketId(ticketId);
  const current = readIndex(ticketId);
  const nextSeq = current.aiSeq + 1;
  const updated = { ...current, aiSeq: nextSeq };
  writeIndexAtomic(ticketId, updated);

  const segment = `${AI_REQUEST_PREFIX}${nextSeq}`;
  const root = path.join(ticketDir(ticketId), segment);
  fs.mkdirSync(root, { recursive: true });

  return { seq: nextSeq, segment, root };
}

module.exports = {
  nextUserRequest,
  nextAiRequest,
  readIndex,
  INDEX_FILENAME,
  INDEX_VERSION,
};
