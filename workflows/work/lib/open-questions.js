/**
 * workflows/work/lib/open-questions.js
 *
 * Pure-logic parser/classifier for the `## Open Questions` section of a
 * brief.md document. No I/O, no side effects, no external dependencies.
 *
 * Public API:
 *   - parse(markdown): Question[]
 *   - findBlocking(questions): Question[]
 *   - classify(scope): 'local' | 'cross-ticket' | 'architectural' | 'unknown'
 *   - SCOPES: readonly frozen allowlist of valid scope strings
 *
 * A Question is:
 *   {
 *     questionText: string,
 *     scope: 'local' | 'cross-ticket' | 'architectural',
 *     rationale: string,
 *     resolved: boolean,
 *     resolution?: string,
 *     startLine: number,   // 0-indexed, inclusive
 *     endLine: number      // 0-indexed, inclusive
 *   }
 *
 * Fallback behavior (fail-open):
 *   - Legacy free-text bullets (no `scope:` subfield) coerce to
 *     { scope: 'local', resolved: true } so pre-existing briefs do not
 *     retroactively block the workflow.
 *   - Malformed structured blocks that look structured (indented subfields)
 *     but are missing `scope:` also coerce to { scope: 'local', resolved: true }.
 *   - Any parse failure returns [] rather than throwing.
 */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Allowlist of valid scope classifications. Frozen so downstream modules can
 * safely import and reference without fear of mutation.
 */
const SCOPES = Object.freeze(['local', 'cross-ticket', 'architectural']);

const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/;
const ANY_HEADING = /^##\s+/;
const TOP_LEVEL_BULLET = /^-\s+/;
const QUESTION_BULLET = /^-\s+\*\*Question:\*\*\s*(.*)$/;
const LEGACY_BULLET = /^-\s+(.*)$/;
const SUBFIELD_LINE = /^\s{2,}-\s+`([^:`]+):\s*([^`]*)`\s*$/;
const RESOLUTION_LINE = /^\s{2,}-\s+\*\*Resolution:\*\*\s*(.*)$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Locate the line range (inclusive start, exclusive end) of the
 * `## Open Questions` section. Returns null if there is no such section.
 */
function findSectionRange(lines) {
  const startIdx = lines.findIndex((line) => OPEN_QUESTIONS_HEADING.test(line));
  if (startIdx === -1) return null;

  // Scan from the line after the heading for the next `## ` heading.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { start: startIdx + 1, end: endIdx };
}

/**
 * Scan forward from `startIdx` inside a section and return the exclusive end
 * index of the current block. A block ends at:
 *   - the next top-level bullet (`- ` at column 0),
 *   - the section end, or
 *   - a blank line followed by anything that isn't a continuation indent.
 * For simplicity and robustness, we stop at the next top-level bullet or
 * section end; blank lines within a block are tolerated but contribute
 * nothing.
 */
function findBlockEnd(lines, startIdx, sectionEnd) {
  for (let i = startIdx + 1; i < sectionEnd; i++) {
    if (TOP_LEVEL_BULLET.test(lines[i])) return i; // next top-level bullet
  }
  return sectionEnd;
}

/**
 * Extract key/value subfields and an optional resolution from a block's
 * interior lines. Returns `{ fields: Map, resolution?: string }`.
 * Keys are lowercased; values are trimmed.
 */
function readSubfields(blockLines) {
  const fields = new Map();
  let resolution;
  for (const line of blockLines) {
    const resMatch = line.match(RESOLUTION_LINE);
    if (resMatch) {
      resolution = resMatch[1].trim();
      continue;
    }
    const subMatch = line.match(SUBFIELD_LINE);
    if (subMatch) {
      fields.set(subMatch[1].trim().toLowerCase(), subMatch[2].trim());
    }
  }
  return { fields, resolution };
}

/**
 * Build a Question object from a range of lines. Applies fallback coercion
 * for legacy / malformed blocks.
 */
function buildQuestion(lines, blockStart, blockEnd) {
  const header = lines[blockStart];
  const questionMatch = header.match(QUESTION_BULLET);

  let questionText;
  if (questionMatch) {
    questionText = questionMatch[1].trim();
  } else {
    // Legacy-style bullet: `- <free text>` or `- **Label:** text`.
    // We still scan interior subfields — if the author supplied structured
    // metadata under a non-canonical header, we should honor it.
    const legacyMatch = header.match(LEGACY_BULLET);
    if (!legacyMatch) return null;
    questionText = legacyMatch[1].trim();
  }
  const interiorLines = lines.slice(blockStart + 1, blockEnd);

  const { fields, resolution } = readSubfields(interiorLines);
  const rawScope = fields.get('scope');
  const scopeClass = classify(rawScope);

  // Fallback: missing or invalid scope → legacy/malformed coercion.
  if (!fields.has('scope') || scopeClass === 'unknown') {
    return {
      questionText,
      scope: 'local',
      rationale: fields.get('rationale') || '',
      resolved: true,
      startLine: blockStart,
      endLine: blockEnd - 1,
    };
  }

  const rawResolved = (fields.get('resolved') || '').toLowerCase();
  const resolved = rawResolved === 'true';

  const question = {
    questionText,
    scope: scopeClass,
    rationale: fields.get('rationale') || '',
    resolved,
    startLine: blockStart,
    endLine: blockEnd - 1,
  };

  if (resolution !== undefined) {
    question.resolution = resolution;
  }
  return question;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse the `## Open Questions` section of a brief markdown document into
 * an array of Question objects. Never throws: malformed input produces
 * fallback entries or an empty array.
 */
function parse(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const lines = markdown.split('\n');
  const range = findSectionRange(lines);
  if (!range) return [];

  const questions = [];
  let i = range.start;
  while (i < range.end) {
    if (TOP_LEVEL_BULLET.test(lines[i])) {
      const blockEnd = findBlockEnd(lines, i, range.end);
      const q = buildQuestion(lines, i, blockEnd);
      if (q) questions.push(q);
      i = blockEnd;
    } else {
      i += 1;
    }
  }
  return questions;
}

/**
 * Return the subset of questions that block the workflow: unresolved
 * `cross-ticket` or `architectural` scope.
 */
function findBlocking(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (q) => q && !q.resolved && (q.scope === 'cross-ticket' || q.scope === 'architectural')
  );
}

/**
 * Normalize and validate a scope string. Unknown / empty / non-string input
 * maps to 'unknown'. All other valid scopes are returned in their canonical
 * lowercase form.
 */
function classify(scope) {
  if (typeof scope !== 'string') return 'unknown';
  const normalized = scope.trim().toLowerCase();
  if (!normalized) return 'unknown';
  return SCOPES.includes(normalized) ? normalized : 'unknown';
}

module.exports = {
  parse,
  findBlocking,
  classify,
  SCOPES,
};
