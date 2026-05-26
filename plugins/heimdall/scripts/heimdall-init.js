#!/usr/bin/env node
'use strict';

/**
 * Initialize a Heimdall lock store.
 *
 *   node heimdall-init.js --kind=<local|worktree|global> [--cwd=<path>]
 *
 * Creates the store directory and writes a `.heimdall.json` marker holding an
 * (initially empty) `locks` array. The marker is what makes the store
 * discoverable by the hook — heimdall only enforces locks from marked stores.
 *
 * Idempotent: re-running on an existing store preserves its locks and only
 * refreshes the marker metadata.
 */

const path = require('node:path');
const {
  MARKER,
  SCHEMA_VERSION,
  getProjectName,
  candidateStores,
  readConfig,
  writeConfig,
} = require(path.join(__dirname, '..', 'lib', 'lock-store'));

function parseArgs(argv) {
  const out = { kind: 'local', cwd: process.cwd() };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
const projectName = getProjectName(args.cwd);
const target = candidateStores(args.cwd, projectName).find((c) => c.kind === args.kind);

if (!target) {
  console.error(`unknown kind: ${args.kind} (use local|worktree|global)`);
  process.exit(1);
}

const existing = readConfig(target.dir);
const cfg = {
  schemaVersion: SCHEMA_VERSION,
  kind: args.kind,
  projectName,
  createdAt: existing?.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  locks: existing?.locks || [],
};
writeConfig(target.dir, cfg);

console.log(
  `initialized heimdall store at ${path.join(target.dir, MARKER)} ` +
    `(kind=${args.kind}, project=${projectName}, locks=${cfg.locks.length})`
);
