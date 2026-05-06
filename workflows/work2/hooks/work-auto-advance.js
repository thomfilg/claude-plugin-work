#!/usr/bin/env node

/**
 * work-auto-advance.js — PostToolUse hook for /work2.
 *
 * After each Task/Skill completion at the orchestrator level, this hook:
 * 1. Checks if a /work2 session is active (marker file exists)
 * 2. Verifies we're at the orchestrator level (session_id matches marker)
 * 3. Calls work-next.js to get the next instruction
 * 4. Outputs the instruction via console.log() (visible to AI)
 *
 * Fail-open: Any error → exit 0 silently.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function main() {
  // Read hook input from stdin
  let hookData;
  try {
    const input = fs.readFileSync(0, 'utf8');
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Guard: need session_id
  const sessionId = hookData?.session_id;
  if (!sessionId) process.exit(0);

  // Guard: find active /work2 session via marker file
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  if (!TASKS_BASE) process.exit(0);

  // Scan for .work2-orchestrator.pid marker in TASKS_BASE subdirectories
  const marker = findActiveMarker(TASKS_BASE, sessionId);
  if (!marker) process.exit(0);

  // Guard: session must match (ensures we're at orchestrator level, not inside sub-agent)
  if (marker.sessionId !== sessionId) process.exit(0);

  // Call work-next.js
  const workNextPath = path.join(__dirname, '..', 'work-next.js');
  let result;
  try {
    result = execFileSync(process.execPath, [workNextPath, marker.ticket], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SESSION_ID: sessionId },
    });
  } catch {
    process.exit(0);
  }

  // Parse and output instruction
  let instruction;
  try {
    instruction = JSON.parse(result);
  } catch {
    process.exit(0);
  }

  // Only output if there's work to do
  if (instruction.action === 'execute') {
    console.log('');
    console.log('═══ WORK2: NEXT STEP ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('════════════════════════');
    console.log('');
  } else if (instruction.action === 'complete') {
    console.log('');
    console.log('═══ WORK2: COMPLETE ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('═══════════════════════');
    console.log('');
  } else if (instruction.action === 'blocked') {
    console.log('');
    console.log('═══ WORK2: BLOCKED ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('══════════════════════');
    console.log('');
  }

  process.exit(0);
}

/**
 * Scan TASKS_BASE for an active .work2-orchestrator.pid marker matching sessionId.
 * Returns the parsed marker or null.
 */
function findActiveMarker(tasksBase, sessionId) {
  try {
    const entries = fs.readdirSync(tasksBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(tasksBase, entry.name, '.work2-orchestrator.pid');
      if (!fs.existsSync(markerPath)) continue;
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (marker.sessionId === sessionId) return marker;
      } catch {
        continue;
      }
    }
  } catch {
    /* fail-open */
  }
  return null;
}

main();
