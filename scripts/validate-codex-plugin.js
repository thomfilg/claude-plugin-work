#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const TODO_MARKER = '[TODO:';
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HEX_COLOR_RE = /^#[0-9A-F]{6}$/i;

function main() {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) {
    console.error('Usage: node scripts/validate-codex-plugin.js <plugin-path>');
    process.exit(2);
  }

  const resolvedRoot = path.resolve(pluginRoot);
  const errors = validatePlugin(resolvedRoot);
  if (errors.length > 0) {
    console.log('Plugin validation failed:');
    for (const error of errors) console.log(`- ${error}`);
    process.exit(1);
  }
  console.log(`Plugin validation passed: ${resolvedRoot}`);
}

function validatePlugin(pluginRoot) {
  const errors = [];
  const manifest = loadJsonObject(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), errors);
  if (!manifest) return errors;

  rejectTodoMarkers(manifest, '$', errors);
  validateManifestShape(pluginRoot, manifest, errors);
  return errors;
}

function loadJsonObject(file, errors) {
  if (!isFile(file)) {
    errors.push('missing `.codex-plugin/plugin.json`');
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    errors.push('`.codex-plugin/plugin.json` must be valid JSON');
    return null;
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    errors.push('`.codex-plugin/plugin.json` must contain a JSON object');
    return null;
  }
  return payload;
}

function rejectTodoMarkers(value, fieldPath, errors) {
  if (typeof value === 'string') {
    if (value.includes(TODO_MARKER))
      errors.push(`${fieldPath} still contains a \`[TODO: ...]\` placeholder`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectTodoMarkers(item, `${fieldPath}[${index}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      rejectTodoMarkers(item, `${fieldPath}.${key}`, errors);
  }
}

function validateManifestShape(pluginRoot, manifest, errors) {
  rejectUnknownFields(
    manifest,
    new Set([
      'id',
      'name',
      'version',
      'description',
      'skills',
      'apps',
      'mcpServers',
      'interface',
      'author',
      'homepage',
      'repository',
      'license',
      'keywords',
    ]),
    'plugin.json',
    errors
  );

  validateOptionalNonEmptyString(manifest, 'id', errors);
  requireNonEmptyString(manifest, 'name', errors);
  const version = requireNonEmptyString(manifest, 'version', errors);
  if (version && !SEMVER_RE.test(version))
    errors.push('plugin.json field `version` must be strict semver');
  requireNonEmptyString(manifest, 'description', errors);

  const author = requireObject(manifest, 'author', errors);
  if (author) {
    rejectUnknownFields(author, new Set(['name', 'email', 'url']), 'author', errors);
    requireNonEmptyString(author, 'name', errors, 'author');
    validateOptionalNonEmptyString(author, 'email', errors, 'author');
    validateOptionalHttpsUrl(author, 'url', errors, 'author');
  }

  validateOptionalContractPath(manifest, 'skills', 'skills', errors);
  validateOptionalContractPath(manifest, 'apps', '.app.json', errors);
  validateOptionalContractPath(manifest, 'mcpServers', '.mcp.json', errors);
  validateSkillManifests(pluginRoot, errors);

  const pluginInterface = requireObject(manifest, 'interface', errors);
  if (!pluginInterface) return;
  rejectUnknownFields(
    pluginInterface,
    new Set([
      'displayName',
      'shortDescription',
      'longDescription',
      'developerName',
      'category',
      'capabilities',
      'websiteURL',
      'privacyPolicyURL',
      'termsOfServiceURL',
      'brandColor',
      'composerIcon',
      'logo',
      'screenshots',
      'defaultPrompt',
      'default_prompt',
    ]),
    'interface',
    errors
  );
  for (const field of [
    'displayName',
    'shortDescription',
    'longDescription',
    'developerName',
    'category',
  ]) {
    requireNonEmptyString(pluginInterface, field, errors, 'interface');
  }
  if (!('defaultPrompt' in pluginInterface) && !('default_prompt' in pluginInterface)) {
    errors.push(
      'plugin.json field `interface.defaultPrompt` or `interface.default_prompt` is required'
    );
  }
  if (
    !Array.isArray(pluginInterface.capabilities) ||
    !pluginInterface.capabilities.every((value) => typeof value === 'string' && value.trim())
  ) {
    errors.push('plugin.json field `interface.capabilities` must be an array of strings');
  }
  for (const field of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    validateOptionalHttpsUrl(pluginInterface, field, errors, 'interface');
  }
  if (
    pluginInterface.brandColor !== undefined &&
    (typeof pluginInterface.brandColor !== 'string' ||
      !HEX_COLOR_RE.test(pluginInterface.brandColor))
  ) {
    errors.push('plugin.json field `interface.brandColor` must use `#RRGGBB`');
  }
  for (const field of ['composerIcon', 'logo']) {
    validateOptionalAssetPath(pluginRoot, pluginRoot, pluginInterface, field, errors);
  }
  if (pluginInterface.screenshots !== undefined && !Array.isArray(pluginInterface.screenshots)) {
    errors.push('plugin.json field `interface.screenshots` must be an array');
  }
}

function validateSkillManifests(pluginRoot, errors) {
  const skillsRoot = path.join(pluginRoot, 'skills');
  if (!isDirectory(skillsRoot)) return;

  for (const entry of fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    validateSkillManifest(path.join(skillsRoot, entry.name), entry.name, errors);
  }
}

function validateSkillManifest(skillRoot, skillName, errors) {
  const skillPath = path.join(skillRoot, 'SKILL.md');
  if (!isFile(skillPath)) {
    errors.push(`skill \`${skillName}\` is missing \`SKILL.md\``);
    return;
  }
  const contents = fs.readFileSync(skillPath, 'utf8');
  if (!contents.startsWith('---\n')) {
    errors.push(`skill \`${skillName}\` must start with YAML frontmatter`);
    return;
  }
  const frontmatterEnd = contents.indexOf('\n---', 4);
  if (frontmatterEnd === -1) {
    errors.push(`skill \`${skillName}\` frontmatter is not closed`);
    return;
  }
  const frontmatter = parseSimpleYaml(contents.slice(4, frontmatterEnd));
  if (!frontmatter || typeof frontmatter !== 'object') {
    errors.push(`skill \`${skillName}\` frontmatter must be an object`);
    return;
  }
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) {
    errors.push(`skill \`${skillName}\` frontmatter field \`name\` must be non-empty`);
  }
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
    errors.push(`skill \`${skillName}\` frontmatter field \`description\` must be non-empty`);
  }
  const disableModelInvocation =
    frontmatter['disable-model-invocation'] ?? frontmatter.disable_model_invocation;
  if (disableModelInvocation !== undefined && disableModelInvocation !== false) {
    errors.push(
      `skill \`${skillName}\` frontmatter field \`disable-model-invocation\` must be false`
    );
  }
}

function parseSimpleYaml(source) {
  const result = {};
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!match) return null;
    const key = match[1];
    let value = match[2];
    if (value === '|') {
      const block = [];
      while (i + 1 < lines.length && /^(?:\s+|$)/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^ {2}/, ''));
      }
      value = block.join('\n').replace(/\n+$/, '');
    } else if (value === 'false') {
      value = false;
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    result[key] = value;
  }
  return result;
}

function requireObject(payload, key, errors) {
  const value = payload[key];
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    errors.push(`plugin.json field \`${key}\` must be an object`);
    return null;
  }
  return value;
}

function requireNonEmptyString(payload, key, errors, prefix) {
  const value = payload[key];
  const field = prefix ? `${prefix}.${key}` : key;
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`plugin.json field \`${field}\` must be a non-empty string`);
    return null;
  }
  return value;
}

function validateOptionalNonEmptyString(payload, key, errors, prefix) {
  if (payload[key] === undefined) return;
  const field = prefix ? `${prefix}.${key}` : key;
  if (typeof payload[key] !== 'string' || !payload[key].trim()) {
    errors.push(`plugin.json field \`${field}\` must be a non-empty string`);
  }
}

function rejectUnknownFields(payload, allowedKeys, prefix, errors) {
  for (const key of Object.keys(payload).sort()) {
    if (!allowedKeys.has(key))
      errors.push(`${prefix} field \`${key}\` is not accepted by plugin validation`);
  }
}

function validateOptionalHttpsUrl(payload, key, errors, prefix) {
  if (payload[key] === undefined) return;
  try {
    const parsed = new URL(payload[key]);
    if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error('invalid');
  } catch {
    errors.push(`plugin.json field \`${prefix}.${key}\` must be an absolute \`https://\` URL`);
  }
}

function validateOptionalContractPath(payload, key, expected, errors) {
  if (payload[key] === undefined) return;
  if (typeof payload[key] !== 'string' || normalizeContractPath(payload[key]) !== expected) {
    errors.push(`plugin.json field \`${key}\` must resolve to \`${expected}\``);
  }
}

function normalizeContractPath(rawPath) {
  if (path.isAbsolute(rawPath)) return null;
  const normalized = path.posix.normalize(rawPath.replaceAll('\\', '/')).replace(/\/+$/, '');
  return normalized === '.' ? null : normalized;
}

function validateOptionalAssetPath(baseDir, allowedRoot, payload, key, errors) {
  if (payload[key] === undefined) return;
  validateAssetPath(baseDir, allowedRoot, payload[key], `interface.${key}`, errors);
}

function validateAssetPath(baseDir, allowedRoot, rawPath, field, errors) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    errors.push(`plugin.json field \`${field}\` must be a non-empty relative path`);
    return;
  }
  if (
    path.isAbsolute(rawPath) ||
    rawPath.split(/[\\/]+/).some((part) => part === '' || part === '.' || part === '..')
  ) {
    errors.push(`plugin.json field \`${field}\` must stay inside the plugin archive`);
    return;
  }
  const resolvedPath = path.resolve(baseDir, rawPath);
  const resolvedRoot = path.resolve(allowedRoot);
  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`) || !isFile(resolvedPath)) {
    errors.push(`plugin.json field \`${field}\` points to a missing file`);
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

if (require.main === module) main();

module.exports = { validatePlugin };
