#!/usr/bin/env node
'use strict';

/**
 * Add (or extend) a lock block in a Heimdall store.
 *
 *   node heimdall-protect.js --phrase="edit .claude" --paths=".claude,~/.claude" [--kind=local] [--cwd=<path>]
 *
 * A lock block is the tuple { protect: [<dir|file>, ...], unlockPhrase }.
 * If a block with the same unlockPhrase already exists, the new paths are
 * merged into it (de-duplicated). Otherwise a new block is appended.
 *
 * --allowed=<a,b>  optional: subdirs always writable under a protected dir.
 * --trusted=<a,b>  optional: subdirs whose internal scripts are trusted.
 *
 * Requires the store to exist (run /heimdall:install first). Defaults to the
 * highest-precedence active store when --kind is omitted.
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
if (paths.length === 0) {
  console.error('missing --paths');
  process.exit(1);
}

// Resolve target store.
let storeDir;
if (args.kind) {
  const projectName = getProjectName(args.cwd);
  const target = candidateStores(args.cwd, projectName).find((c) => c.kind === args.kind);
  if (!target) {
    console.error(`unknown kind: ${args.kind}`);
    process.exit(1);
  }
  storeDir = target.dir;
} else {
  const stores = discoverStores(args.cwd);
  if (stores.length === 0) {
    console.error('no heimdall store found — run /heimdall:install first (or pass --kind).');
    process.exit(1);
  }
  storeDir = stores[0].dir;
}

const cfg = readConfig(storeDir);
if (!cfg) {
  console.error(`store not initialized at ${storeDir} — run /heimdall:install first.`);
  process.exit(1);
}

const existing = cfg.locks.find((l) => (l.unlockPhrase || '').trim() === phrase);
if (existing) {
  const set = new Set([...(existing.protect || []), ...paths]);
  existing.protect = [...set];
  if (args.allowed) existing.allowedPaths = splitList(args.allowed);
  if (args.trusted) existing.trustedSubdirs = splitList(args.trusted);
} else {
  const block = { protect: paths, unlockPhrase: phrase };
  if (args.allowed) block.allowedPaths = splitList(args.allowed);
  if (args.trusted) block.trustedSubdirs = splitList(args.trusted);
  cfg.locks.push(block);
}

cfg.schemaVersion = SCHEMA_VERSION;
cfg.updatedAt = new Date().toISOString();
writeConfig(storeDir, cfg);

const block = cfg.locks.find((l) => (l.unlockPhrase || '').trim() === phrase);
console.log(
  `protected [${block.protect.join(', ')}] under phrase "${phrase}" ` +
    `(store: ${storeDir}, ${cfg.locks.length} block(s) total)`
);
