// Tests for Heimdall lock-store discovery + config IO.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/lock-store.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { MARKER, FOLDER, discoverStores, readConfig, writeConfig } = require(
  path.resolve(__dirname, '..', 'lock-store')
);

const PROTECT_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-protect.js');
const INIT_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-init.js');

let base;
let local;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-store-'));
  local = path.join(base, 'repo');
  fs.mkdirSync(local, { recursive: true });
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('store discovery', () => {
  it('finds a local store once its marker exists', () => {
    assert.equal(discoverStores(local).length, 0, 'no store before init');
    const storeDir = path.join(local, '.claude', FOLDER);
    writeConfig(storeDir, { kind: 'local', locks: [] });
    assert.ok(fs.existsSync(path.join(storeDir, MARKER)));
    const stores = discoverStores(local);
    assert.equal(stores.length, 1);
    assert.equal(stores[0].kind, 'local');
  });
});

describe('init + protect scripts', () => {
  let repo;

  before(() => {
    repo = path.join(base, 'repo2');
    fs.mkdirSync(repo, { recursive: true });
  });

  it('init creates an empty store, protect adds a lock block', () => {
    execFileSync('node', [INIT_SCRIPT, '--kind=local', `--cwd=${repo}`], { encoding: 'utf8' });
    const storeDir = path.join(repo, '.claude', FOLDER);
    assert.deepEqual(readConfig(storeDir).locks, []);

    execFileSync(
      'node',
      [
        PROTECT_SCRIPT,
        '--kind=local',
        `--cwd=${repo}`,
        '--phrase=edit .claude',
        '--paths=.claude,~/.claude',
        '--allowed=plans',
      ],
      { encoding: 'utf8' }
    );
    const cfg = readConfig(storeDir);
    assert.equal(cfg.locks.length, 1);
    assert.equal(cfg.locks[0].unlockPhrase, 'edit .claude');
    assert.deepEqual(cfg.locks[0].protect, ['.claude', '~/.claude']);
    assert.deepEqual(cfg.locks[0].allowedPaths, ['plans']);
  });

  it('protect merges paths into an existing block by phrase', () => {
    execFileSync(
      'node',
      [
        PROTECT_SCRIPT,
        '--kind=local',
        `--cwd=${repo}`,
        '--phrase=edit .claude',
        '--paths=extra-dir',
      ],
      { encoding: 'utf8' }
    );
    const cfg = readConfig(path.join(repo, '.claude', FOLDER));
    assert.equal(cfg.locks.length, 1, 'still one block — merged, not appended');
    assert.ok(cfg.locks[0].protect.includes('extra-dir'));
  });
});
