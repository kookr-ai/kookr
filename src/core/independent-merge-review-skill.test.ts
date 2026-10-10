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

  test('re-bases the rationale on fresh-context + exact-head + hard-gate, not cross-vendor (RFC #3415)', () => {
    // The value is independence + exact-head + the hard gate, NOT that a
    // different vendor catches more (that cross-vendor claim was falsified).
    expect(skill).toMatch(/fresh context \+ exact-head binding \+ the hard gate/i);
    expect(skill).toMatch(/cross-vendor guarantee/i);
    // Pin the load-bearing falsification evidence itself, not just its phrasing,
    // so corrupting the numbers fails the test (not only a harmless reword).
    expect(skill).toMatch(/591 verdicts/i);
    expect(skill).toMatch(/5\.6% vs 3\.1%/);
    expect(skill).toMatch(/p=0\.20/);
    // The correct positive rationale for Codex-primary is availability — pinning
    // this guards the intent better than a negative assertion could, since the
    // disclaimer sentence itself contains "different vendor catches more".
    expect(skill).toMatch(/primary only for \*\*availability\*\*/i);
    expect(skill).toMatch(/same-vendor fallback is therefore acceptable/i);
  });

  test('names a reviewer strength floor, placed in the spawn step, so the fallback is never silently weaker (RFC #3415)', () => {
    expect(skill).toMatch(/Strength floor/i);
    expect(skill).toMatch(/full reviewing strength/i);
    // Never a cheap/nit-tier model like the pre-push lint-like lane now uses —
    // pin the full referent, not the near-free bare "lint-like" token.
    expect(skill).toMatch(/cheap\/nit-tier model/i);
    expect(skill).toMatch(/`pre-pr-review` `lint-like` lane/i);
    // The floor's safety argument ("runs at the strength floor in §2") depends on
    // the floor living inside the spawn step — assert position, not just presence.
    const spawnStep = skill.indexOf('### 2. Spawn the reviewer');
    const floorIdx = skill.indexOf('Strength floor');
    expect(spawnStep).toBeGreaterThan(0);
    expect(floorIdx).toBeGreaterThan(spawnStep);
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
