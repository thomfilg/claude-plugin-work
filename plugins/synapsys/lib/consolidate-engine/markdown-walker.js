'use strict';

/**
 * Markdown walker — section-boundary detection + field-label extraction.
 *
 * Built-ins only (string + RegExp). Profiles supply a config describing
 * the section heading level that bounds an item and the field labels
 * (e.g. `Purpose`, `Location`) whose bold-prefixed lines become item
 * fields. Headings nested inside fenced code blocks are ignored.
 *
 * Output is a list of `{ name, fields }` objects plus the raw `body`
 * (text between the boundary heading and the next one). Profiles
 * consume `fields` for structured access and `body` for whole-section
 * indexing.
 */

const CODE_FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Split text into logical lines and tag whether each line is inside a
 * fenced code block. Code-fence transitions toggle the role.
 */
function annotateLines(text) {
  const lines = text.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    const isFence = CODE_FENCE_RE.test(line);
    if (isFence) {
      out.push({ text: line, inFence: true, isFenceMarker: true });
      inFence = !inFence;
      continue;
    }
    out.push({ text: line, inFence, isFenceMarker: false });
  }
  return out;
}

/**
 * Build a map of label → key from the config.fields array.
 * Profile fields look like `{ label: 'Purpose', key: 'purpose',
 * stripBackticks: true }`.
 */
function buildFieldMap(fields) {
  const map = new Map();
  for (const f of fields) {
    map.set(f.label, f);
  }
  return map;
}

function stripBackticks(value) {
  return value.replace(/^`+|`+$/g, '').trim();
}

function buildFieldLineRe(labels) {
  if (!labels.length) return null;
  // Escape regex metachars in labels (safety, even though our labels are
  // alphabetic). Join with `|` for alternation.
  const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\*\\*(${escaped.join('|')})\\*\\*:\\s*(.+)$`);
}

/**
 * Walk markdown into items.
 *
 * Config:
 *   itemHeadingLevel  number (1–6) — heading depth that bounds an item.
 *   fields            array of { label, key, stripBackticks? }
 *   includeBodyLines  boolean — if true, item.body retains the raw text
 *                     of the section (default true).
 */
function validateConfig(config) {
  const { itemHeadingLevel, fields = [], includeBodyLines = true } = config || {};
  if (!itemHeadingLevel || itemHeadingLevel < 1 || itemHeadingLevel > 6) {
    throw new Error('config.itemHeadingLevel must be 1..6');
  }
  return { itemHeadingLevel, fields, includeBodyLines };
}

function startItem(line, boundaryPrefix, fields) {
  const m = HEADING_RE.exec(line);
  const name = m ? m[2].trim() : line.slice(boundaryPrefix.length).trim();
  if (!name) return null;
  const item = { name, fields: {}, _bodyLines: [] };
  // Initialize known fields to empty string so consumers can rely on
  // shape regardless of which fields were present in source.
  for (const f of fields) item.fields[f.key] = '';
  return item;
}

function applyFieldLine(item, line, fieldLineRe, fieldMap) {
  if (!fieldLineRe) return;
  const fm = fieldLineRe.exec(line.trim());
  if (!fm) return;
  const fieldDef = fieldMap.get(fm[1]);
  if (!fieldDef) return;
  const raw = fm[2].trim();
  item.fields[fieldDef.key] = fieldDef.stripBackticks ? stripBackticks(raw) : raw;
}

function finalizeItem(item, includeBodyLines) {
  if (includeBodyLines) item.body = item._bodyLines.join('\n');
  delete item._bodyLines;
  return item;
}

function handleLine(state, entry) {
  const { line, inFence, isFenceMarker } = entry;
  const { boundaryPrefix, fields, fieldLineRe, fieldMap, includeBodyLines, items } = state;
  if (inFence || isFenceMarker) {
    if (state.current) state.current._bodyLines.push(line);
    return;
  }
  if (line.startsWith(boundaryPrefix)) {
    if (state.current) items.push(finalizeItem(state.current, includeBodyLines));
    state.current = startItem(line, boundaryPrefix, fields);
    return;
  }
  if (!state.current) return;
  state.current._bodyLines.push(line);
  applyFieldLine(state.current, line, fieldLineRe, fieldMap);
}

function walk(text, config) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const { itemHeadingLevel, fields, includeBodyLines } = validateConfig(config);
  const state = {
    boundaryPrefix: '#'.repeat(itemHeadingLevel) + ' ',
    fields,
    fieldMap: buildFieldMap(fields),
    fieldLineRe: buildFieldLineRe(fields.map((f) => f.label)),
    includeBodyLines,
    items: [],
    current: null,
  };
  for (const { text: line, inFence, isFenceMarker } of annotateLines(text)) {
    handleLine(state, { line, inFence, isFenceMarker });
  }
  if (state.current) state.items.push(finalizeItem(state.current, includeBodyLines));
  return state.items;
}

module.exports = {
  walk,
  annotateLines,
  stripBackticks,
};
