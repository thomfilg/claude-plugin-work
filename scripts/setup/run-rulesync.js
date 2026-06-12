#!/usr/bin/env node

const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = resolve(__dirname, '..', '..');
const CONFIG_FILES = [
  'rulesync.jsonc',
  'rulesync.config.ts',
  'rulesync.config.js',
  '.rulesyncrc.json',
];

function hasConfig() {
  return CONFIG_FILES.some((file) => existsSync(resolve(ROOT, file)));
}

if (process.env.CI === 'true') {
  console.log('[rulesync] Skipping in CI.');
  process.exit(0);
}

if (!hasConfig()) {
  console.log('[rulesync] No rulesync config found; skipping.');
  process.exit(0);
}

const result = spawnSync('npx', ['rulesync', 'generate'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[rulesync] Failed to start npx rulesync generate: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
