import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Issue #4139: the front-matter parser used to turn every checklist item that
 * contains a colon into an (empty) object, which `parseStringArray` then
 * dropped without a warning. The parse still succeeded, so a gate that only
 * checks "every bundled playbook parses" cannot catch it. This test counts the
 * items written in each bundled playbook's `checklist:` block with a plain line
 * scan, independent of the parser, and requires the parser to keep all of them.
 */

const PLAYBOOK_DIRS = ['plugin/playbooks', '.kookr/playbooks'];

/** Count the `- item` lines of the front-matter `checklist:` block. */
function countWrittenChecklistItems(content: string): number {
  const lines = content.trimStart().split('\n');
  let count = 0;
  let inChecklist = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('---')) break; // end of front matter
    if (/^checklist:\s*$/.test(line)) {
      inChecklist = true;
      continue;
    }
    if (!inChecklist || line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      inChecklist = false; // next top-level key
      continue;
    }
    if (/^\s+-\s/.test(line)) count++;
  }
  return count;
}

function listPlaybooks(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(dir, name));
}

describe('bundled playbooks keep every checklist item (#4139)', () => {
  for (const dir of PLAYBOOK_DIRS) {
    test(`${dir} holds playbooks with checklists`, () => {
      const files = listPlaybooks(dir);
      expect(files.length).toBeGreaterThan(0);
      const written = files.reduce(
        (total, file) => total + countWrittenChecklistItems(readFileSync(file, 'utf8')),
        0,
      );
      expect(written).toBeGreaterThan(0);
    });

    for (const file of listPlaybooks(dir)) {
      test(`${file} parses as many checklist items as it lists`, () => {
        const content = readFileSync(file, 'utf8');
        const playbook = parsePlaybook(content, file, process.cwd());
        expect(playbook.checklist).toHaveLength(countWrittenChecklistItems(content));
      });
    }
  }
});
