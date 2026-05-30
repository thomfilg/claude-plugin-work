'use strict';

/**
 * ui-catalog profile
 *
 * Thin config + structural mapper. All parsing goes through the shared
 * markdown-walker; all trigger derivation goes through the shared
 * inverted-index. No project-specific vocabulary, no hardcoded tag
 * maps — distinguishing terms come from TF-IDF over the catalog body.
 */

const walker = require('../../lib/consolidate-engine/markdown-walker');
const { InvertedIndex } = require('../../lib/consolidate-engine/inverted-index');

const CONFIG = {
  itemHeadingLevel: 3,
  fields: [
    { label: 'Purpose', key: 'purpose' },
    { label: 'Use Cases', key: 'useCases' },
    { label: 'Features', key: 'features' },
    { label: 'Location', key: 'location', stripBackticks: true },
    { label: 'Docs', key: 'docsPath', stripBackticks: true },
  ],
};

const TOP_K = 2;
const TFIDF_FIELDS = ['purpose', 'useCases', 'features'];

function parse(text /* , sourcePath */) {
  const raw = walker.walk(text, CONFIG);
  return raw.map((item) => ({ name: item.name, ...item.fields }));
}

function buildIndex(items) {
  const idx = new InvertedIndex();
  for (const item of items) {
    const text = TFIDF_FIELDS.map((k) => item[k] || '').join(' ');
    idx.add(item.name, text);
  }
  return idx.finalize();
}

const _cache = new WeakMap();
function indexFor(items) {
  if (!_cache.has(items)) _cache.set(items, buildIndex(items));
  return _cache.get(items);
}

function buildBody(item) {
  return [
    `# ${item.name}`,
    '',
    `**Purpose**: ${item.purpose}`,
    `**Use Cases**: ${item.useCases}`,
    `**Features**: ${item.features}`,
    `**Location**: ${item.location}`,
    `**Docs**: ${item.docsPath}`,
  ].join('\n');
}

function toMemory(item, ctx) {
  if (!item || typeof item.name !== 'string' || !item.name) return null;
  const peers = ctx && Array.isArray(ctx.peers) ? ctx.peers : [item];
  const idx = indexFor(peers);
  if (!idx.hasDoc(item.name)) return null;
  const terms = idx.topK(item.name, TOP_K);
  if (!terms.length) return null;
  return {
    name: `ui-component-${item.name}`,
    events: ['PreToolUse'],
    trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
    trigger_pretool_content: terms.map((t) => `\\b${t}\\b`),
    inject: 'full',
    body: buildBody(item),
  };
}

module.exports = {
  name: 'ui-catalog',
  description:
    'Parses packages/ui/components-catalog.md into per-component memories with TF-IDF-derived content matchers.',
  sources: ['packages/ui/components-catalog.md'],
  parse,
  toMemory,
};
