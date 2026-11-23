import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/**
 * Issue #4138: reviewers are handed the branch diff. A two-dot diff against a
 * stale local `main` shows files the branch never touched (or base additions as
 * deletions), so both files must name the three-dot diff against the fetched base.
 */
describe('review diff uses the fetched base with three dots (#4138)', () => {
  const root = join(import.meta.dirname, '..', '..', 'plugin');
  const skill = readFileSync(join(root, 'skills', 'pre-pr-review', 'SKILL.md'), 'utf-8');
  const verifier = readFileSync(join(root, 'agents', 'change-verifier.md'), 'utf-8');
  // A diff whose left side is local `main` (two or three dots), e.g. `git diff main..HEAD`.
  const localMainDiff = /git diff[^`\n]*(?<![\w/])main\.\.\.?HEAD/;

  test('pre-pr-review never diffs against local main or with two dots', () => {
    expect(skill).not.toMatch(/(?<!\.)\.\.HEAD/);
    expect(skill).not.toMatch(localMainDiff);
  });

  test('pre-pr-review builds the specialist context from the fetched base', () => {
    expect(skill).toMatch(/PR context:[^\n]*`git fetch origin`[^\n]*`git diff "\$BASE_REF"\.\.\.HEAD`/);
    expect(skill).toMatch(/Prepare context: `git fetch origin`, then `git diff "\$BASE_REF"\.\.\.HEAD` and `git diff --stat "\$BASE_REF"\.\.\.HEAD`/);
  });

  test('change-verifier names the three-dot diff against the fetched base for scope', () => {
    const scope = verifier.split('\n').find((l) => l.includes('Check scope')) ?? '';
    expect(scope).toMatch(/`git fetch origin`/);
    expect(scope).toMatch(/`git diff "\$BASE_REF"\.\.\.HEAD`/);
    expect(verifier).not.toMatch(/(?<!\.)\.\.HEAD/);
    expect(verifier).not.toMatch(localMainDiff);
  });
});

/**
 * Issue #4225: the same stale-base mistake in the skill an agent reads right
 * before it pushes (kookr-pre-push) and in the OSS contribution skill. Also
 * sweeps every skill/agent markdown file so a new local-`main` diff fails here.
 */
describe('pre-push and contribution skills diff against the fetched base (#4225)', () => {
  const repoRoot = join(import.meta.dirname, '..', '..');
  // A diff whose left side is local `main` (two or three dots), e.g. `git diff main...HEAD`.
  const localMainDiff = /(?<![\w/])main\.\.\.?HEAD/;

  test('kookr-pre-push scope step fetches origin and uses the three-dot diff against BASE_REF', () => {
    const skill = readFileSync(join(repoRoot, '.claude', 'skills', 'kookr-pre-push', 'SKILL.md'), 'utf-8');
    const start = skill.indexOf('### 1. Check scope before pushing');
    expect(start).toBeGreaterThan(0);
    const next = skill.indexOf('\n### 2.', start);
    const step1 = skill.slice(start, next > 0 ? next : undefined);
    expect(step1).toMatch(/^git fetch origin$/m);
    expect(step1).toMatch(/^BASE_REF=\$\{BASE_REF:-origin\/main\}/m);
    expect(step1).toMatch(/^git diff --stat "\$BASE_REF"\.\.\.HEAD$/m);
    expect(step1).toMatch(/^git diff "\$BASE_REF"\.\.\.HEAD$/m);
    expect(step1.indexOf('git fetch origin')).toBeLessThan(step1.indexOf('git diff'));
    expect(skill).not.toMatch(/(?<!\.)\.\.HEAD/);
    expect(skill).not.toMatch(localMainDiff);
  });

  test('pr-contribution-excellence diffs against the fetched upstream branch', () => {
    const dir = join(repoRoot, 'plugin', 'skills', 'pr-contribution-excellence');
    const skill = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    const codex = readFileSync(join(dir, 'repo', 'openai-codex.md'), 'utf-8');
    expect(skill.match(/git diff upstream\/<default>\.\.\.HEAD/g)?.length).toBe(3);
    expect(codex).toMatch(/git fetch upstream && git diff upstream\/main\.\.\.HEAD/);
    expect(skill).not.toMatch(localMainDiff);
    expect(codex).not.toMatch(localMainDiff);
  });

  test('no skill, agent or CLAUDE.md diffs against local main', () => {
    const files: string[] = [join(repoRoot, 'CLAUDE.md')];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.md')) files.push(path);
      }
    };
    walk(join(repoRoot, 'plugin'));
    walk(join(repoRoot, '.claude', 'skills'));
    const offenders = files.flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => localMainDiff.test(line))
        .map(({ i }) => `${relative(repoRoot, file)}:${i + 1}`),
    );
    expect(files.length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
