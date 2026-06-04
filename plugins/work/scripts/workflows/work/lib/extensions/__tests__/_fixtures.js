/**
 * _fixtures.js — shared test helpers for Task 11 cross-cutting suites.
 *
 * Pure helpers — no test logic, no node:test imports. Just temp-dir
 * + write-extension utilities used by:
 *   - dispatch.test.js
 *   - error-isolation.test.js
 *   - end-to-end.integration.test.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXTENSIONS_REL = path.join('.claude', 'work-extensions');
const INDEX_PATH = path.resolve(__dirname, '..', 'index.js');
const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');

/**
 * Force-fresh require of the public extensions entry point.
 * Clears the index module AND the event-bus module (the latter holds
 * module-level handler registry state).
 * @returns {{initExtensions: Function}}
 */
function loadFreshIndex() {
  delete require.cache[require.resolve(INDEX_PATH)];
  delete require.cache[require.resolve(EVENT_BUS_PATH)];
  return require(INDEX_PATH);
}

/**
 * Create a temp repo with `<root>/tasks/<ticket>` populated.
 * @param {string} [prefix]
 * @returns {{root: string, tasksDir: string}}
 */
function makeTempRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix || 'ext-fix-'}`));
  const tasksDir = path.join(root, 'tasks', 'GH-522');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir };
}

/**
 * Ensure `<repoRoot>/.claude/work-extensions/` exists and return its path.
 * @param {string} repoRoot
 * @returns {string}
 */
function makeExtensionsDir(repoRoot) {
  const extDir = path.join(repoRoot, EXTENSIONS_REL);
  fs.mkdirSync(extDir, { recursive: true });
  return extDir;
}

/**
 * Write an extension file with `body` source code into `extDir/name`.
 * @param {string} extDir
 * @param {string} name
 * @param {string} body
 * @returns {string} full path to the written file
 */
function writeExtension(extDir, name, body) {
  const full = path.join(extDir, name);
  fs.writeFileSync(full, body);
  return full;
}

/**
 * Copy the in-tree reference extension (from plugins/work/references/work-extensions/)
 * into the temp repo's `.claude/work-extensions/` directory so loader can find it.
 * @param {string} repoRoot
 * @param {string} referenceName e.g. 'cortex-auto-recall.js'
 * @returns {string} full path to the installed copy
 */
function installReferenceExtension(repoRoot, referenceName) {
  // __tests__ → extensions → lib → work → workflows → scripts → work → references
  const src = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'references',
    'work-extensions',
    referenceName
  );
  const extDir = makeExtensionsDir(repoRoot);
  const dst = path.join(extDir, referenceName);
  fs.copyFileSync(src, dst);
  return dst;
}

/**
 * Best-effort cleanup of a temp repo root.
 * @param {string} root
 */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  loadFreshIndex,
  makeTempRepo,
  makeExtensionsDir,
  writeExtension,
  installReferenceExtension,
  cleanup,
};
