import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INDEPENDENT_REVIEW_MARKER,
  REVIEW_SKIPPED_TIMEOUT_LABEL,
  REQUIRE_REVIEW_ENV,
} from './independent-review.js';

/**
 * Contract tests for the distributed independent-merge-review skill.
 * Issue #3027: consuming repos such as Lucy document independent review as
 * advisory; the skill used to claim it was a merge gate on every repo.
 */
describe('independent-merge-review skill (issue #3027)', () => {
  const skillPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'skills',
    'independent-merge-review',
    'SKILL.md',
  );
  const skill = readFileSync(skillPath, 'utf-8');

  test('keeps the verdict-comment literals in sync with independent-review.ts', () => {
    expect(skill).toContain(INDEPENDENT_REVIEW_MARKER);
    expect(skill).toContain(REVIEW_SKIPPED_TIMEOUT_LABEL);
    expect(skill).toContain(REQUIRE_REVIEW_ENV);
  });

  test('documents the hard-gate vs advisory repo-policy split', () => {
    expect(skill).toMatch(/Repo policy split/i);
    expect(skill).toContain('kookr-ai/kookr');
    expect(skill).toMatch(/independent review is advisory/i);
    expect(skill).toMatch(/never become a task blocker/i);
    expect(skill).toMatch(/Do not weaken/);
    expect(skill).toMatch(/#3027/);
  });

  test('classifies kookr-ai/kookr as hard before the CLAUDE.md advisory grep', () => {
    const classifyStart = skill.indexOf('**Classify:**');
    expect(classifyStart).toBeGreaterThan(0);
    const classify = skill.slice(classifyStart, classifyStart + 600);
    expect(classify).toContain('if [ "$REPO" = "kookr-ai/kookr" ]; then');
    expect(classify).toContain('REVIEW_POLICY=hard');
    expect(classify).toContain("grep -qiE 'independent review is advisory'");
    expect(classify).toContain('REVIEW_POLICY=advisory');
    const hardIdx = classify.indexOf('REVIEW_POLICY=hard');
    const advisoryIdx = classify.indexOf('REVIEW_POLICY=advisory');
    const elseIdx = classify.lastIndexOf('REVIEW_POLICY=hard');
    expect(hardIdx).toBeGreaterThan(0);
    expect(advisoryIdx).toBeGreaterThan(hardIdx);
    expect(elseIdx).toBeGreaterThan(advisoryIdx);
  });
});
