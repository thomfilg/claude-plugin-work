#!/usr/bin/env node
'use strict';

/**
 * Remove protection from a Heimdall store.
 *
 *   node heimdall-unprotect.js --phrase="edit .claude" [--paths=".claude"] [--kind=local] [--cwd=<path>]
 *
 * - With --phrase only: removes the entire lock block for that phrase.
 * - With --phrase + --paths: removes only those paths from the block; the
 *   block is deleted if it becomes empty.
 *
 * Searches all active stores when --kind is omitted, removing from each that
 * contains a matching block. Never deletes the store or its marker.
 */

const path = require('node:path');
const {
  getProjectName,
  candidateStores,
  discoverStores,
  readConfig,
  writeConfig,
  SCHEMA_VERSION,
} = require(path.join(__dirname, '..', 'lib', 'lock-store'));

function parseArgs(argv) {
  const out = { cwd: process.cwd() };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function splitList(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const args = parseArgs(process.argv);
const phrase = (args.phrase || '').trim();
const paths = splitList(args.paths);

if (!phrase) {
  console.error('missing --phrase');
  process.exit(1);
}

let storeDirs;
if (args.kind) {
  const projectName = getProjectName(args.cwd);
  const target = candidateStores(args.cwd, projectName).find((c) => c.kind === args.kind);
  if (!target) {
    console.error(`unknown kind: ${args.kind}`);
    process.exit(1);
  }
  storeDirs = [target.dir];
} else {
  const stores = discoverStores(args.cwd);
  if (stores.length === 0) {
    console.error('no heimdall store found.');
    process.exit(1);
  }
  storeDirs = stores.map((s) => s.dir);
}

let changed = 0;
for (const storeDir of storeDirs) {
  const cfg = readConfig(storeDir);
  if (!cfg) continue;
  const idx = cfg.locks.findIndex((l) => (l.unlockPhrase || '').trim() === phrase);
  if (idx === -1) continue;

  if (paths.length === 0) {
    cfg.locks.splice(idx, 1);
    console.log(`removed lock block "${phrase}" from ${storeDir}`);
  } else {
    const block = cfg.locks[idx];
    block.protect = (block.protect || []).filter((p) => !paths.includes(p));
    if (block.protect.length === 0) {
      cfg.locks.splice(idx, 1);
      console.log(`removed paths and emptied block "${phrase}" from ${storeDir}`);
    } else {
      console.log(
        `removed [${paths.join(', ')}] from "${phrase}"; remaining [${block.protect.join(', ')}] (${storeDir})`
      );
    }
  }
  cfg.schemaVersion = SCHEMA_VERSION;
  cfg.updatedAt = new Date().toISOString();
  writeConfig(storeDir, cfg);
  changed++;
}

if (changed === 0) {
  console.error(`no lock block with phrase "${phrase}" found in any store.`);
  process.exit(1);
}
