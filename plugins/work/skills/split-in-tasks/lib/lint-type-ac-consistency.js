'use strict';

const DOCS_EXEMPTION_PATTERNS = Object.freeze([
  /documentation[\s-]*exempt/i,
  /docs[-\s]?only/i,
  /no\s+RED[\/\s]GREEN(?:[\/\s]REFACTOR)?\s+(?:cycle\s+)?required/i,
  /documentation\/manifest only/i,
  /config[-\s]?only/i,
  /manifest[-\s]?only/i,
  /no\s+test(?:able)?\s+surface/i,
]);

function parseTaskType(section) {
  if (typeof section !== 'string') return null;
  const lines = section.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+Type\s*$/i.test(lines[i].trim())) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith('#')) break;
        return next.toLowerCase();
      }
    }
  }
  return null;
}

function findOffendingAcLine(acLines) {
  if (!Array.isArray(acLines)) return null;
  for (const line of acLines) {
    if (typeof line !== 'string') continue;
    for (const pattern of DOCS_EXEMPTION_PATTERNS) {
      if (pattern.test(line)) return line;
    }
  }
  return null;
}

function buildWarning({ file, taskNumber, acLine, declaredType }) {
  return {
    kind: 'D',
    file,
    message:
      `Task ${taskNumber}: Acceptance Criteria "${acLine}" declares ` +
      `docs-exemption but Type is "${declaredType}".`,
    hint: 'propose Type: docs',
  };
}

/**
 * Validate Type/AC consistency across a parsed tasks.md model.
 *
 * Input shape:
 *   { file: string, tasks: Array<{ number, section, acceptanceCriteria }> }
 *
 * For each task whose AC list contains a docs-exemption phrase from the
 * frozen DOCS_EXEMPTION_PATTERNS set, returns a SPLIT-WARNING record:
 *   { kind: 'D', file, message, hint: 'propose Type: docs' }
 * Returns null when the task's Type is "docs" (happy path) or when no
 * tasks have an exemption phrase.
 */
function lintTypeAcConsistency(taskModel) {
  if (!taskModel || !Array.isArray(taskModel.tasks)) return null;
  const file = taskModel.file || 'tasks.md';
  for (const task of taskModel.tasks) {
    if (!task) continue;
    const acLine = findOffendingAcLine(task.acceptanceCriteria);
    if (!acLine) continue;
    const declaredType = parseTaskType(task.section);
    if (declaredType === 'docs') continue;
    return buildWarning({
      file,
      taskNumber: task.number,
      acLine,
      declaredType: declaredType || 'unknown',
    });
  }
  return null;
}

module.exports = {
  lintTypeAcConsistency,
  DOCS_EXEMPTION_PATTERNS,
};
