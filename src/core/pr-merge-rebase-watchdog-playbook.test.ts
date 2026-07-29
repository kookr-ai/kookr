import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';
import { KB_LESSON_SKIP_MARKER } from './kb-lesson-classifier.js';

/**
 * Contract tests for the PR merge/rebase watchdog playbook (issue #1666). The
 * watchdog is a scheduled supervision playbook whose whole value is that it acts
 * on the two stuck PR states (BEHIND / DIRTY) the batch playbooks never revisit,
 * honors a dry-run, and never silently drops a conflicting PR. Those load-bearing
 * behaviors are asserted here so an edit that drops them fails CI rather than
 * quietly shipping a watchdog that leaves PRs stuck.
 */
describe('pr-merge-rebase-watchdog playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'pr-merge-rebase-watchdog.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'pr-merge-rebase-watchdog.md', '/');

  test('parses with a name and description', () => {
    expect(pb.name).toBe('PR Merge/Rebase Watchdog');
    expect(pb.description.length).toBeGreaterThan(0);
  });

  test('is a loopable/schedulable workflow with a stop predicate', () => {
    expect(pb.tags).toContain('workflow');
    expect(pb.tags).toContain('loopable');
    // A loopable playbook gets an effective loop budget resolved.
    expect(pb.effectiveLoop).toBeDefined();
    expect(pb.loop?.stopPredicate).toContain('.watchdog-stop');
  });

  test('is delivery pre-authorized and auto-closes on signal like the batch playbook', () => {
    expect(pb.deliveryPreAuthorized).toBe(true);
    expect(pb.autoCloseOnSignal).toBe(true);
  });

  test('exposes dryRun as a required select defaulting to a no-write mode', () => {
    const param = pb.parameters.find((p) => p.name === 'dryRun');
    expect(param).toBeDefined();
    expect(param!.required).toBe(true);
    // Default must not silently perform writes.
    expect(param!.default).toBe('false');
    expect(param!.type).toBe('select');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['false', 'true']);
  });

  test('dry-run is honored in the body, not just declared as a parameter', () => {
    // A regression that kept dryRun defaulting to false but stopped honoring it
    // in the procedure would pass the parameter test above — assert the body
    // actually gates writes and self-terminates a looped dry run.
    expect(pb.body).toContain('DRY-RUN:');
    expect(pb.body).toMatch(/Don't write anything in dry-run/i);
    expect(pb.body).toMatch(/dry run also stops after this single reporting pass/i);
  });

  test('merges only when mergeAfterUpdate allows it, defaulting to merge-when-safe', () => {
    const param = pb.parameters.find((p) => p.name === 'mergeAfterUpdate');
    expect(param).toBeDefined();
    expect(param!.default).toBe('true');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['false', 'true']);
    expect(pb.body).toContain('{{mergeAfterUpdate}}');
  });

  test('scopes to the automation account by default, not arbitrary authors', () => {
    const param = pb.parameters.find((p) => p.name === 'authorScope');
    expect(param).toBeDefined();
    expect(param!.default).toBe('mine');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['any', 'mine']);
    // The interpolation placeholder must actually be used in the body.
    expect(pb.body).toContain('{{authorScope}}');
  });

  test('offers a dirtyPolicy so DIRTY PRs are never left silent', () => {
    const param = pb.parameters.find((p) => p.name === 'dirtyPolicy');
    expect(param).toBeDefined();
    // Safe default: flag for a human, not auto-spawn resolver tasks.
    expect(param!.default).toBe('flag');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['flag', 'spawn']);
    expect(pb.body).toContain('{{dirtyPolicy}}');
    // The headline invariant of issue #1666: a DIRTY PR is never left silent.
    expect(pb.body).toMatch(/Never leave a `DIRTY` PR untouched/);
    expect(pb.body).toMatch(/Don't leave a DIRTY PR silent/i);
  });

  test('classifies PRs by mergeStateStatus and handles BEHIND + DIRTY explicitly', () => {
    expect(pb.body).toContain('mergeStateStatus');
    expect(pb.body).toContain('BEHIND');
    expect(pb.body).toContain('DIRTY');
    // BEHIND is updated via the version-independent REST update-branch endpoint,
    // because the shipped gh may predate `gh pr update-branch`.
    expect(pb.body).toContain('pulls/$N/update-branch');
  });

  test('rebases Dependabot PRs through a comment, not a manual push', () => {
    expect(pb.body).toContain('@dependabot rebase');
    expect(pb.body).toMatch(/Don't push directly to a Dependabot branch/i);
  });

  test('respects merge gates via the repo merge wrapper and does not merge in the update tick', () => {
    expect(pb.body).toContain('pnpm merge');
    expect(pb.body).toMatch(/Don't merge a BEHIND PR in the same tick you update it/i);
  });

  test('emits the post-task lesson decision before completion-ready', () => {
    expect(pb.body).toContain('kb remember --kb=agent-task-lessons');
    // Assert the skip marker against the classifier's constant (not a hardcoded
    // literal) so a drift in the constant is caught here, matching the sibling
    // implement-github-issue playbook contract test.
    expect(pb.body).toContain(KB_LESSON_SKIP_MARKER);
    expect(pb.body).toContain('completion-ready');
  });
});
