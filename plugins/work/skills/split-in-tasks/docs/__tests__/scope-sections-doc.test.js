'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOC_PATH = path.join(__dirname, '..', 'scope-sections.md');

function readDoc() {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

test('scope-sections.md mentions joint ownership (substring "joint")', () => {
  const contents = readDoc();
  assert.match(
    contents,
    /joint/i,
    'expected scope-sections.md to mention "joint" (joint in-scope ownership worked example missing)'
  );
});

test('scope-sections.md mentions duplicate failure mode (substring "duplicate")', () => {
  const contents = readDoc();
  assert.match(
    contents,
    /duplicate/i,
    'expected scope-sections.md to mention "duplicate" (duplicate-in-scope worked example missing)'
  );
});

test('scope-sections.md uses the canonical sample path components/X.tsx', () => {
  const contents = readDoc();
  assert.ok(
    contents.includes('components/X.tsx'),
    'expected scope-sections.md to reference the canonical sample path "components/X.tsx" in the worked example'
  );
});

test('scope-sections.md has a heading mentioning both "Files in scope" and "duplicate" in the same section', () => {
  const contents = readDoc();
  const lines = contents.split('\n');

  // Find headings (lines starting with #) and their section bodies.
  const headingIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) headingIndices.push(i);
  }
  headingIndices.push(lines.length); // sentinel

  let found = false;
  for (let h = 0; h < headingIndices.length - 1; h++) {
    const headingLine = lines[headingIndices[h]];
    const sectionBody = lines.slice(headingIndices[h], headingIndices[h + 1]).join('\n');
    const headingMentionsBoth =
      /Files in scope/i.test(headingLine) && /duplicate/i.test(headingLine);
    const sectionMentionsBoth =
      /Files in scope/i.test(sectionBody) && /duplicate/i.test(sectionBody);
    if (headingMentionsBoth || sectionMentionsBoth) {
      found = true;
      break;
    }
  }

  assert.ok(
    found,
    'expected a heading (or its section body) in scope-sections.md to mention both "Files in scope" and "duplicate"'
  );
});
