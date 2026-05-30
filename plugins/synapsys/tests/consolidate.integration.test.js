'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'synapsys-consolidate.js');
const SAMPLE_REPO = path.join(__dirname, 'fixtures', 'sample-repo');

function mkTmpOut(label) {
  return path.join(
    os.tmpdir(),
    `synapsys-consolidate-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
}

function runConsolidate(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
  });
}

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'sample-repo',
  'packages',
  'ui',
  'components-catalog.md'
);

test('sample-repo components-catalog.md fixture exists and contains parseable component headings', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), `expected fixture at ${FIXTURE_PATH} to exist`);

  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const headings = text.split(/^### /m).slice(1);

  assert.ok(
    headings.length >= 4,
    `expected at least 4 '### ' component blocks in fixture, found ${headings.length}`
  );
});

test('ui-catalog profile parses a catalog markdown into atomic items', () => {
  const modPath = path.join(__dirname, '..', 'scripts', 'consolidate-profiles', 'ui-catalog.js');
  assert.ok(fs.existsSync(modPath), `expected ui-catalog profile at ${modPath}`);
  const mod = require(modPath);

  assert.equal(mod.name, 'ui-catalog', 'exports.name must be "ui-catalog"');
  assert.equal(typeof mod.description, 'string', 'exports.description must be a string');
  assert.deepEqual(
    mod.sources,
    ['packages/ui/components-catalog.md'],
    'exports.sources must list components-catalog.md path'
  );
  assert.equal(typeof mod.parse, 'function', 'exports.parse must be a function');
  assert.equal(typeof mod.toMemory, 'function', 'exports.toMemory must be a function');

  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);

  assert.ok(Array.isArray(items), 'parse() must return an array');
  assert.ok(items.length >= 4, `expected at least 4 parsed items, got ${items.length}`);

  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  const button = byName.Button;
  assert.ok(button, 'parse() must include a Button item');
  assert.equal(button.name, 'Button');
  assert.equal(button.purpose, 'Standard interactive button primitive for forms and actions.');
  assert.equal(button.useCases, 'Form submission, dialog confirmation, toolbar actions.');
  assert.equal(button.features, 'Variants (primary/secondary/ghost), loading state, icon support.');
  // Backticks must be stripped from location/docsPath.
  assert.equal(button.location, 'packages/ui/src/primitives/Button.tsx');
  assert.equal(button.docsPath, 'packages/ui/docs/Button.md');

  const dataGrid = byName.DataGrid;
  assert.ok(dataGrid, 'parse() must include a DataGrid item');
  assert.equal(dataGrid.location, 'packages/ui/src/data/DataGrid.tsx');
});

test('Button memory shape: TF-IDF-derived content matchers from body text', () => {
  const mod = require(
    path.join(__dirname, '..', 'scripts', 'consolidate-profiles', 'ui-catalog.js')
  );
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);
  const button = items.find((i) => i.name === 'Button');
  assert.ok(button, 'fixture must include Button');

  const memory = mod.toMemory(button, { peers: items });
  assert.ok(memory && typeof memory === 'object', 'toMemory(Button) must return an object');

  assert.equal(memory.name, 'ui-component-Button', 'memory.name');
  assert.deepEqual(memory.events, ['PreToolUse'], 'memory.events');
  assert.deepEqual(
    memory.trigger_pretool,
    ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
    'memory.trigger_pretool'
  );
  assert.equal(memory.inject, 'full', 'memory.inject');

  // Matchers are TF-IDF-derived `\b<term>\b` patterns from the body text.
  assert.ok(
    Array.isArray(memory.trigger_pretool_content) && memory.trigger_pretool_content.length > 0,
    'trigger_pretool_content must be a non-empty array'
  );
  for (const pat of memory.trigger_pretool_content) {
    assert.match(pat, /^\\b[a-z0-9_-]+\\b$/, `each matcher must be \\b<term>\\b, got: ${pat}`);
  }
  // "button" is the highest-IDF term unique to the Button entry — must
  // appear in the derived matchers.
  assert.ok(
    memory.trigger_pretool_content.some((p) => p === '\\bbutton\\b'),
    `expected \\bbutton\\b in matchers, got: ${memory.trigger_pretool_content.join(',')}`
  );

  assert.equal(typeof memory.body, 'string', 'memory.body must be a string');
  assert.ok(memory.body.includes(button.purpose), 'body must include the component purpose');
  assert.ok(
    memory.body.includes('packages/ui/src/primitives/Button.tsx'),
    'body must reference the Location path'
  );
});

test('DataGrid memory shape: TF-IDF surfaces distinguishing terms (no hardcoded MUI hatch)', () => {
  const mod = require(
    path.join(__dirname, '..', 'scripts', 'consolidate-profiles', 'ui-catalog.js')
  );
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);
  const dataGrid = items.find((i) => i.name === 'DataGrid');
  assert.ok(dataGrid, 'fixture must include DataGrid');

  const memory = mod.toMemory(dataGrid, { peers: items });
  assert.ok(memory && typeof memory === 'object', 'toMemory(DataGrid) must return an object');

  assert.equal(memory.name, 'ui-component-DataGrid', 'memory.name');
  assert.ok(
    Array.isArray(memory.trigger_pretool_content) && memory.trigger_pretool_content.length > 0,
    'trigger_pretool_content must be a non-empty array'
  );
  for (const pat of memory.trigger_pretool_content) {
    assert.match(pat, /^\\b[a-z0-9_-]+\\b$/, `each matcher must be \\b<term>\\b, got: ${pat}`);
  }
  // TF-IDF must surface at least one term unique to the DataGrid entry in
  // the fixture (i.e. not shared with Button/Text/Heading/Paragraph/Alpha/Beta).
  const joined = memory.trigger_pretool_content.join(',');
  assert.match(
    joined,
    /admin|column|tabular|virtualization|filtering|sorting|dataset|grid|pagination/,
    `expected a DataGrid-distinguishing term, got: ${joined}`
  );
});

test('End-to-end consolidate run produces a valid writable manifest deterministically', () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `expected driver script at ${SCRIPT_PATH}`);

  const outA = mkTmpOut('e2e-a');
  const outB = mkTmpOut('e2e-b');

  const runA = runConsolidate([`--repo=${SAMPLE_REPO}`, '--profile=ui-catalog', `--out=${outA}`]);
  assert.equal(runA.status, 0, `run A should exit 0, got ${runA.status}. stderr=${runA.stderr}`);
  assert.ok(fs.existsSync(outA), `run A should write manifest at ${outA}`);

  const rawA = fs.readFileSync(outA, 'utf8');
  const manifestA = JSON.parse(rawA);
  assert.ok(Array.isArray(manifestA.memories), 'manifest.memories must be an array');
  assert.ok(
    manifestA.memories.length > 0,
    `expected at least one memory from ui-catalog, got ${manifestA.memories.length}`
  );
  for (const mem of manifestA.memories) {
    assert.equal(typeof mem.name, 'string', 'each memory.name must be a string');
    assert.ok(mem.name.length > 0, 'memory.name must be non-empty');
    assert.ok(Array.isArray(mem.events), 'memory.events must be an array');
    assert.equal(typeof mem.body, 'string', 'memory.body must be a string');
  }
  assert.ok(rawA.endsWith('\n'), 'manifest must end with newline');
  assert.ok(rawA.includes('\n  '), 'manifest must be pretty-printed JSON');

  const runB = runConsolidate([`--repo=${SAMPLE_REPO}`, '--profile=ui-catalog', `--out=${outB}`]);
  assert.equal(runB.status, 0, `run B should exit 0, got ${runB.status}. stderr=${runB.stderr}`);
  const rawB = fs.readFileSync(outB, 'utf8');
  assert.equal(rawB, rawA, 'two consecutive runs must produce byte-identical manifests');

  assert.ok(
    !/\b\d{13}\b/.test(rawA),
    'manifest must not embed a Date.now()-like 13-digit timestamp'
  );
  assert.ok(
    !new RegExp(`\\b${process.pid}\\b`).test(rawA),
    'manifest body must not embed the current PID'
  );

  try {
    fs.unlinkSync(outA);
  } catch (_) {
    /* ignore */
  }
  try {
    fs.unlinkSync(outB);
  } catch (_) {
    /* ignore */
  }
});

test('Unknown content-matcher collision emits a stderr warning and keeps the first', () => {
  const driver = require(SCRIPT_PATH);
  assert.equal(
    typeof driver.mergeCollisions,
    'function',
    'synapsys-consolidate.js must export a mergeCollisions(memories) helper'
  );

  const memories = [
    {
      name: 'ui-component-Beta',
      events: ['PreToolUse'],
      trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
      trigger_pretool_content: ['\\bcollide\\b'],
      inject: 'full',
      body: '# Beta',
    },
    {
      name: 'ui-component-Alpha',
      events: ['PreToolUse'],
      trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
      trigger_pretool_content: ['\\bcollide\\b'],
      inject: 'full',
      body: '# Alpha',
    },
  ];

  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return originalWrite(chunk, ...rest);
  };

  let result;
  try {
    result = driver.mergeCollisions(memories);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(Array.isArray(result), 'mergeCollisions must return an array');
  const survivors = result.filter(
    (m) => m.name === 'ui-component-Alpha' || m.name === 'ui-component-Beta'
  );
  assert.equal(
    survivors.length,
    1,
    `collision must keep exactly one of Alpha/Beta, got ${survivors.length}`
  );

  assert.match(
    captured,
    /\[synapsys-consolidate\] unexpected matcher collision/,
    `expected stderr warning prefix, got: ${captured}`
  );
  assert.match(captured, /ui-component-Alpha/, `warning must name Alpha, got: ${captured}`);
  assert.match(captured, /ui-component-Beta/, `warning must name Beta, got: ${captured}`);
  assert.ok(
    captured.indexOf('ui-component-Alpha') < captured.indexOf('ui-component-Beta'),
    `warning must alphabetise component names, got: ${captured}`
  );
});

test('consolidate skill confirms before overwriting a manually-authored memory', () => {
  const SKILL_PATH = path.join(__dirname, '..', 'skills', 'consolidate', 'SKILL.md');

  assert.ok(fs.existsSync(SKILL_PATH), `expected consolidate skill at ${SKILL_PATH}`);

  const raw = fs.readFileSync(SKILL_PATH, 'utf8');

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'SKILL.md must start with YAML frontmatter');
  const frontmatter = fmMatch[1];
  assert.match(
    frontmatter,
    /user-invocable:\s*true/,
    `frontmatter must declare user-invocable: true, got:\n${frontmatter}`
  );
  assert.match(
    frontmatter,
    /allowed-tools:[^\n]*AskUserQuestion/,
    `allowed-tools must include AskUserQuestion, got:\n${frontmatter}`
  );

  const requiredStrings = [
    'synapsys-crystallize-lint.js',
    'synapsys-crystallize-write.js',
    'synapsys-test.js',
    '--force --store=',
    'AskUserQuestion',
    '.consolidate-registry.json',
    'proceed',
    'skip-conflicts',
    'cancel',
    'delete stale',
    'would overwrite manual',
  ];
  for (const needle of requiredStrings) {
    assert.ok(
      raw.includes(needle),
      `SKILL.md body must contain the literal string ${JSON.stringify(needle)}`
    );
  }
});

test('Missing source file is skipped with a stderr warning, not a crash', () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `expected driver script at ${SCRIPT_PATH}`);

  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-consolidate-empty-repo-'));
  const outPath = mkTmpOut('missing-source');

  const result = runConsolidate([
    `--repo=${emptyRepo}`,
    '--profile=ui-catalog',
    `--out=${outPath}`,
  ]);

  assert.ok(
    result.status === 0 || result.status === 1,
    `expected graceful exit (0 or 1), got status=${result.status} signal=${result.signal} stderr=${result.stderr}`
  );
  assert.equal(result.signal, null, 'process must not be killed by a signal');

  assert.match(
    result.stderr,
    /\[synapsys-consolidate\] source not found:/,
    `expected stderr to contain "[synapsys-consolidate] source not found:", got: ${result.stderr}`
  );
  assert.match(
    result.stderr,
    /\(profile: ui-catalog\)/,
    `expected stderr to attribute missing source to "ui-catalog" profile, got: ${result.stderr}`
  );

  try {
    fs.unlinkSync(outPath);
  } catch (_) {
    /* ignore */
  }
  try {
    fs.rmdirSync(emptyRepo, { recursive: true });
  } catch (_) {
    /* ignore */
  }
});
