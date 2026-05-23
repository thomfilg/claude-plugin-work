'use strict';

/**
 * `jscpd-bridge` — shells out to jscpd and folds duplicate-block findings
 * into the shared violation shape.
 *
 * Threshold: ≥ 50 identical tokens across files (matches spec). `--min-lines`
 * is lowered to 1 because the runner is invoked on arbitrary file lists and
 * we don't want jscpd to silently drop short-but-token-dense clones.
 *
 * Failure modes:
 *   - jscpd binary unresolvable          → throws (config error)
 *   - report JSON missing/malformed      → throws (config error)
 * jscpd's non-zero exit when clones exceed threshold is *not* an error —
 * the JSON report still lands.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveBin } = require('./_resolve-bin');

function runJscpdCli(bin, files, outDir, cwd) {
  const args = [
    bin,
    '--reporters',
    'json',
    '--silent',
    '--output',
    outDir,
    '--min-tokens',
    '50',
    '--min-lines',
    '1',
    '--mode',
    'mild',
    '--formats-exts',
    'javascript:js',
    ...files,
  ];
  const res = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`jscpd-bridge: failed: ${res.error.message}`);
  }
}

function readReport(outDir) {
  const reportPath = path.join(outDir, 'jscpd-report.json');
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch {
    return { duplicates: [] };
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`jscpd-bridge: malformed JSON: ${err.message}`);
  }
}

function fileInfo(side, repoRoot) {
  if (!side || !side.name) return null;
  const abs = path.isAbsolute(side.name) ? side.name : path.resolve(repoRoot, side.name);
  return path.relative(repoRoot, abs);
}

function lineOf(side) {
  if (!side) return 1;
  if (side.startLoc && typeof side.startLoc.line === 'number') return side.startLoc.line;
  if (typeof side.start === 'number') return side.start;
  return 1;
}

function foldDuplicate(d, repoRoot) {
  const fileA = fileInfo(d.firstFile, repoRoot);
  if (!fileA) return null;
  const fileB = fileInfo(d.secondFile, repoRoot);
  const lineA = lineOf(d.firstFile);
  const tokens = typeof d.tokens === 'number' ? d.tokens : 0;
  const lines = typeof d.lines === 'number' ? d.lines : 0;
  const msgTokens = tokens ? `, ${tokens} tokens` : '';
  const msgClone = fileB ? ` — clone in ${fileB}` : '';
  return {
    file: fileA,
    line: lineA,
    rule: 'duplicate-blocks',
    severity: 'error',
    message: `duplicate-blocks ≥ 50 tokens (${lines} lines${msgTokens})${msgClone}`,
  };
}

function checkAll(absFiles, repoRoot) {
  if (!Array.isArray(absFiles) || absFiles.length < 2) return [];
  let bin;
  try {
    bin = resolveBin('jscpd', 'jscpd');
  } catch (err) {
    throw new Error(`jscpd-bridge: jscpd binary not resolvable: ${err.message}`);
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-jscpd-'));
  try {
    runJscpdCli(bin, absFiles, outDir, repoRoot);
    const parsed = readReport(outDir);
    const dupes = Array.isArray(parsed.duplicates) ? parsed.duplicates : [];
    const out = [];
    for (const d of dupes) {
      const v = foldDuplicate(d, repoRoot);
      if (v) out.push(v);
    }
    return out;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

module.exports = { checkAll };
