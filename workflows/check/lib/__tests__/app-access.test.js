'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../../lib/config');

describe('discoverApps', () => {
  let discoverApps;

  beforeEach(() => {
    // Clear require cache so module re-reads config each time
    delete require.cache[require.resolve('../app-access')];
    discoverApps = require('../app-access').discoverApps;
  });

  it('returns parsed entries with defaults from WEB_APPS config', () => {
    config.WEB_APPS = [
      { name: 'my-app', defaultPort: 3000, type: 'vite' },
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'my-app');
    assert.equal(apps[0].defaultPort, 3000);
    assert.equal(apps[0].type, 'vite');
    assert.equal(apps[0].appType, 'web');
    assert.equal(apps[0].healthEndpoint, '/');
    assert.equal(apps[0].startCommand, 'pnpm dev --filter=my-app');
  });

  it('returns empty array when WEB_APPS is empty', () => {
    config.WEB_APPS = [];
    const apps = discoverApps();
    assert.deepStrictEqual(apps, []);
  });

  it('returns empty array when WEB_APPS is undefined', () => {
    config.WEB_APPS = undefined;
    const apps = discoverApps();
    assert.deepStrictEqual(apps, []);
  });

  it('returns entries for single-app repo', () => {
    config.WEB_APPS = [
      { name: 'solo-app', defaultPort: 4000, type: 'remix', appType: 'api' },
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'solo-app');
    assert.equal(apps[0].appType, 'api');
    assert.equal(apps[0].healthEndpoint, '/health');
  });

  it('returns entries for multi-app repo', () => {
    config.WEB_APPS = [
      { name: 'app-a', defaultPort: 3000, type: 'vite' },
      { name: 'app-b', defaultPort: 3001, type: 'remix', appType: 'api' },
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 2);
    assert.equal(apps[0].name, 'app-a');
    assert.equal(apps[1].name, 'app-b');
  });

  it('skips entries without name', () => {
    config.WEB_APPS = [
      { defaultPort: 3000, type: 'vite' },
      { name: 'valid-app', defaultPort: 3001, type: 'vite' },
      null,
      {},
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'valid-app');
  });

  it('applies default healthEndpoint "/" for web appType', () => {
    config.WEB_APPS = [{ name: 'web-app', defaultPort: 3000, type: 'vite' }];
    const apps = discoverApps();
    assert.equal(apps[0].healthEndpoint, '/');
  });

  it('applies default healthEndpoint "/health" for api appType', () => {
    config.WEB_APPS = [{ name: 'api-app', defaultPort: 3000, type: 'vite', appType: 'api' }];
    const apps = discoverApps();
    assert.equal(apps[0].healthEndpoint, '/health');
  });

  it('preserves custom healthEndpoint when provided', () => {
    config.WEB_APPS = [
      { name: 'custom-app', defaultPort: 3000, type: 'vite', healthEndpoint: '/ready' },
    ];
    const apps = discoverApps();
    assert.equal(apps[0].healthEndpoint, '/ready');
  });

  it('preserves custom startCommand when provided', () => {
    config.WEB_APPS = [
      { name: 'custom-app', defaultPort: 3000, type: 'vite', startCommand: 'npm start' },
    ];
    const apps = discoverApps();
    assert.equal(apps[0].startCommand, 'npm start');
  });

  it('skips apps that fail manifest validation', () => {
    config.WEB_APPS = [
      { name: 'bad-app', defaultPort: 80, type: 'vite' },
      { name: 'good-app', defaultPort: 3000, type: 'vite' },
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'good-app');
  });
});

describe('validateManifestEntry', () => {
  const { validateManifestEntry } = require('../app-access');

  it('valid entry passes validation', () => {
    const result = validateManifestEntry({
      name: 'my-app',
      defaultPort: 3000,
      healthEndpoint: '/health',
      startCommand: 'pnpm dev --filter=my-app',
    });
    assert.equal(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  // Shell injection tests
  it('rejects startCommand with semicolon', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      startCommand: 'pnpm dev; rm -rf /',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('dangerous shell characters'));
  });

  it('rejects startCommand with pipe', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      startCommand: 'pnpm dev | cat /etc/passwd',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('dangerous shell characters'));
  });

  it('rejects startCommand with &&', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      startCommand: 'pnpm dev && rm -rf /',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('dangerous shell characters'));
  });

  it('rejects startCommand with backticks', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      startCommand: 'pnpm dev `whoami`',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('dangerous shell characters'));
  });

  it('rejects startCommand with $()', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      startCommand: 'pnpm dev $(whoami)',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('dangerous shell characters'));
  });

  // Port range tests
  it('rejects port below 1024', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 80,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('outside valid range'));
  });

  it('rejects port above 65535', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 70000,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('outside valid range'));
  });

  it('accepts port in valid range', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 3000,
    });
    assert.equal(result.valid, true);
  });

  it('accepts port at lower boundary (1024)', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 1024,
    });
    assert.equal(result.valid, true);
  });

  it('accepts port at upper boundary (65535)', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 65535,
    });
    assert.equal(result.valid, true);
  });

  // healthEndpoint tests
  it('rejects healthEndpoint starting with "//"', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      healthEndpoint: '//evil.com',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('must not start with "//"'));
  });

  it('rejects healthEndpoint with query strings', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      healthEndpoint: '/health?token=abc',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('must not contain query strings'));
  });

  it('rejects healthEndpoint not starting with "/"', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      healthEndpoint: 'health',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('must start with "/"'));
  });

  it('accepts valid healthEndpoint', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      healthEndpoint: '/api/health',
    });
    assert.equal(result.valid, true);
  });

  it('returns multiple errors for multiple violations', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 80,
      startCommand: 'pnpm dev; bad',
      healthEndpoint: 'no-slash',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3);
  });
});
