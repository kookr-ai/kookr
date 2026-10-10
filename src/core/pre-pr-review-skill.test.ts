import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contract tests for the pre-pr-review skill's §8 per-lane model policy and
 * context-pack reuse rule (RFC #3415 Part 1.1 / 1.2). These pin the PR's actual
 * behavioral change — the lint-like → cheap-model downgrade and the
 * correctness/test strength requirement — so a silent revert or an accidental
 * downgrade of correctness/test fails here. The runtime is prose consumed by an
 * LLM agent, so these are instruction-presence assertions (same pattern as
 * independent-merge-review-skill.test.ts), not an exercise of review behavior.
 */
describe('pre-pr-review skill §8 per-lane model (RFC #3415)', () => {
  const skill = readFileSync(
    join(import.meta.dirname, '..', '..', 'plugin', 'skills', 'pre-pr-review', 'SKILL.md'),
    'utf-8',
  );
  const section8 = (() => {
    const start = skill.indexOf('### 8. Subagent Review');
    expect(start).toBeGreaterThan(0);
    const next = skill.indexOf('\n### 9.', start);
    return skill.slice(start, next > 0 ? next : undefined);
  })();

  test('pins the lint-like lane to a cheap model inside §8', () => {
    expect(section8).toMatch(/Per-lane model — cheap for nits, strong for defects/i);
    // The lint-like spawn example carries an explicit cheap model override.
    expect(section8).toMatch(/model: "sonnet".*role=lint-like/);
  });

  test('keeps correctness and test on the strong model (no silent downgrade)', () => {
    expect(section8).toMatch(/`correctness` and `test` on the default\/strong model/i);
    // test is explicitly not a pure nit and stays strong until its own A/B clears.
    expect(section8).toMatch(/`test` is downgraded only if its own\s+A\/B shows no finding loss/i);
  });

  test('documents context-pack reuse as an optimization, excluding the merge reviewer (1.2)', () => {
    expect(section8).toMatch(/Use a review context pack when one exists/i);
    expect(section8).toMatch(/never a precondition/i);
    // The pack must never reach the blind independent merge reviewer.
    expect(section8).toMatch(/pre-push panel only/i);
    expect(section8).toMatch(/must stay blind to the implementer/i);
  });
});
