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
function walk(text, config) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const { itemHeadingLevel, fields = [], includeBodyLines = true } = config || {};
  if (!itemHeadingLevel || itemHeadingLevel < 1 || itemHeadingLevel > 6) {
    throw new Error('config.itemHeadingLevel must be 1..6');
  }
  const fieldMap = buildFieldMap(fields);
  const fieldLineRe = buildFieldLineRe(fields.map((f) => f.label));

  const annotated = annotateLines(text);
  const items = [];
  let current = null;
  const boundaryPrefix = '#'.repeat(itemHeadingLevel) + ' ';

  const commit = () => {
    if (!current) return;
    if (includeBodyLines) {
      current.body = current._bodyLines.join('\n');
    }
    delete current._bodyLines;
    items.push(current);
    current = null;
  };

  for (const { text: line, inFence, isFenceMarker } of annotated) {
    if (inFence || isFenceMarker) {
      if (current) current._bodyLines.push(line);
      continue;
    }
    if (line.startsWith(boundaryPrefix)) {
      commit();
      const m = HEADING_RE.exec(line);
      const name = m ? m[2].trim() : line.slice(boundaryPrefix.length).trim();
      if (!name) continue;
      current = { name, fields: {}, _bodyLines: [] };
      // Initialize known fields to empty string so consumers can rely on
      // shape regardless of which fields were present in source.
      for (const f of fields) current.fields[f.key] = '';
      continue;
    }
    if (!current) continue;
    current._bodyLines.push(line);
    if (!fieldLineRe) continue;
    const fm = fieldLineRe.exec(line.trim());
    if (!fm) continue;
    const fieldDef = fieldMap.get(fm[1]);
    if (!fieldDef) continue;
    const raw = fm[2].trim();
    current.fields[fieldDef.key] = fieldDef.stripBackticks ? stripBackticks(raw) : raw;
  }
  commit();
  return items;
}

module.exports = {
  walk,
  annotateLines,
  stripBackticks,
};
