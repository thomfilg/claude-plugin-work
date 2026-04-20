'use strict';

const config = require('../../lib/config');
const AppAccessStatus = require('./app-access-status');

/**
 * Validate a manifest entry for security and correctness.
 * @param {object} entry - App manifest entry
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifestEntry(entry) {
  const errors = [];

  // Port range validation (1024-65535)
  if (entry.defaultPort !== undefined) {
    if (typeof entry.defaultPort !== 'number' || entry.defaultPort < 1024 || entry.defaultPort > 65535) {
      errors.push(`Port ${entry.defaultPort} is outside valid range (1024-65535)`);
    }
  }

  // Shell injection prevention for startCommand
  if (entry.startCommand) {
    const dangerousChars = /[;|<>`]|\$[\({]|&&|>>/;
    if (dangerousChars.test(entry.startCommand)) {
      errors.push(`startCommand contains dangerous shell characters: ${entry.startCommand}`);
    }
  }

  // healthEndpoint path validation
  if (entry.healthEndpoint) {
    if (entry.healthEndpoint.startsWith('//')) {
      errors.push(`healthEndpoint must not start with "//": ${entry.healthEndpoint}`);
    }
    if (entry.healthEndpoint.includes('?')) {
      errors.push(`healthEndpoint must not contain query strings: ${entry.healthEndpoint}`);
    }
    if (!entry.healthEndpoint.startsWith('/')) {
      errors.push(`healthEndpoint must start with "/": ${entry.healthEndpoint}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Discover apps from WEB_APPS config with defaults applied.
 * Filters out invalid entries based on manifest validation.
 * @returns {Array<object>} Array of validated app configurations
 */
function discoverApps() {
  if (!config.WEB_APPS || !Array.isArray(config.WEB_APPS) || config.WEB_APPS.length === 0) return [];
  const map = config.webAppsMap();
  const entries = Object.entries(map).map(([name, fields]) => ({ name, ...fields }));
  return entries.filter(app => {
    const validation = validateManifestEntry(app);
    if (!validation.valid) {
      console.error(`[app-access] Skipping invalid app "${app.name}": ${validation.errors.join(', ')}`);
      return false;
    }
    return true;
  });
}

module.exports = { discoverApps, validateManifestEntry, AppAccessStatus };
