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
 *     startLine: number,   // 0-indexed, inclusive — the `- **Question:**` line
 *     endLine: number      // 0-indexed, inclusive — the LAST non-blank
 *                          //   content line of the block (never a trailing
 *                          //   blank separator). Consumers can safely use
 *                          //   `lines.slice(startLine, endLine + 1)` to
 *                          //   extract the block without picking up a
 *                          //   trailing blank or `split('\n')` artifact.
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
// Match any ATX heading (h1..h6). A heading at any level after the
// `## Open Questions` line terminates the section — without this, an h1
// (e.g. a second top-level title later in a multi-document markdown) or
// an h3+ subheading would let the parser bleed into unrelated content.
const ANY_HEADING = /^#{1,6}\s+/;
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
 * Given the exclusive end of a block, walk backward to find the index of the
 * last non-blank line that actually belongs to this block. Returns a value
 * `>= blockStart` so the block is always at least one line wide (the header).
 * This tightens the `endLine` contract: consumers (e.g. Task 2's rewriter)
 * can slice `lines.slice(startLine, endLine + 1)` without picking up the
 * blank separator between blocks or the trailing empty element produced by
 * `split('\n')` on a trailing-newline string.
 */
function findLastContentLine(lines, blockStart, blockEnd) {
  let last = blockEnd - 1;
  while (last > blockStart && (lines[last] === undefined || lines[last].trim() === '')) {
    last -= 1;
  }
  return last;
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
  const endLine = findLastContentLine(lines, blockStart, blockEnd);

  // Fallback: missing or invalid scope → legacy/malformed coercion.
  if (!fields.has('scope') || scopeClass === 'unknown') {
    return {
      questionText,
      scope: 'local',
      rationale: fields.get('rationale') || '',
      resolved: true,
      startLine: blockStart,
      endLine,
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
    endLine,
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

/**
 * (P1 extension point — Task 11)
 *
 * Downgrade a specific open question's scope to `'local'`, with a required
 * human-authored justification. This is the escape hatch referenced in
 * spec.md §Open Questions & Decisions and tasks.md R21: a way for authors
 * to acknowledge a cross-ticket or architectural question that would
 * otherwise block the workflow, and explicitly accept the risk of treating
 * it as local scope.
 *
 * P0 scope (this file): this stub exists as the designated anchor point so
 * Task 11's P1 implementation has an explicit contract to extend. It is
 * exported (throwing) so that any accidental caller fails loudly rather
 * than silently coercing behavior.
 *
 * P1 plan (Task 11):
 *   1. Accept `(questionText, justification)` where both are non-empty
 *      strings; reject empty justifications with a validation error.
 *   2. Return a mutation descriptor `{ questionText, newScope: 'local',
 *      justification, timestamp }` that Task 2's `applyResolutions`
 *      rewriter can consume to rewrite the block in-place, appending a
 *      `- \`downgrade-justification: <text>\`` subfield and setting the
 *      scope to `local`.
 *   3. The gate (Task 3) will then treat the downgraded question as
 *      non-blocking, preserving the author's decision in the brief file
 *      for audit.
 *
 * @param {string} _questionText  The exact text of the question to downgrade.
 * @param {string} _justification A non-empty human-authored justification.
 * @returns {never} Always throws until Task 11 implements it.
 * @throws {Error} with message containing "not implemented" and "P1".
 */
function downgradeToLocal(_questionText, _justification) {
  throw new Error('downgradeToLocal is not implemented — P1 escape hatch (Task 11)');
}

module.exports = {
  parse,
  findBlocking,
  classify,
  downgradeToLocal,
  SCOPES,
};
