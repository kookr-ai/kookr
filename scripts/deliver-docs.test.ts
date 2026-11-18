// Issue #4181: the delivery skills and the implement playbook name `pnpm deliver`
// as the default delivery path in this repository, say what to do when it stops,
// and keep the individual commands as the fallback.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { STEP_NAMES } from './deliver.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8');

const PRE_PUSH = '.claude/skills/kookr-pre-push/SKILL.md';
const POST_PUSH = '.claude/skills/kookr-post-push/SKILL.md';
const PLAYBOOK = 'plugin/playbooks/implement-github-issue.md';

describe('pnpm deliver is the default delivery path (issue #4181)', () => {
  test.each([PRE_PUSH, POST_PUSH, PLAYBOOK])('%s names pnpm deliver and how to resume after a stop', (path) => {
    const text = read(path);
    expect(text).toContain('pnpm deliver');
    expect(text).toMatch(/--from (review-marker|pr-body|wait-verdict|merge)/);
    // The default body file is outside the worktree, where `kookr pr-checklist verify` refuses to read it.
    expect(text).toContain('--body-file .tmp/pr-body.md');
  });

  test('the pre-push skill lists every pnpm deliver step, in order, and a stop row per step that can stop', () => {
    const text = read(PRE_PUSH);
    const section = text.slice(text.indexOf('### 3. Deliver with `pnpm deliver`'), text.indexOf('### 4. '));
    expect(section.length).toBeGreaterThan(0);
    const stepRows = [...section.matchAll(/^\| `([a-z-]+)` \| /gm)].map((m) => m[1]);
    expect(stepRows).toEqual([...STEP_NAMES]);
    for (const step of STEP_NAMES.filter((s) => s !== 'pr-gate-marker')) {
      expect(section).toMatch(new RegExp(`^\\| \`${step}\`, `, 'm'));
    }
    // The manual marker and push steps stay documented, as the fallback.
    expect(text).toContain('scripts/write-review-state-marker.sh --status approved');
    expect(text).toMatch(/git push --set-upstream origin/);
    expect(text.indexOf('### 3. Deliver with `pnpm deliver`')).toBeLessThan(text.indexOf('### 4. Write the review-gate marker'));
  });

  test('the post-push skill keeps kookr merge as the fallback of the merge step', () => {
    const text = read(POST_PUSH);
    expect(text).toContain('## Default path in this repository: `pnpm deliver`');
    expect(text).toContain('kookr merge <PR_NUMBER> --repo kookr-ai/kookr');
    expect(text.indexOf('pnpm deliver')).toBeLessThan(text.indexOf('kookr merge <PR_NUMBER>'));
  });

  test('the playbook scopes pnpm deliver to kookr-ai/kookr and keeps the guard before the PR step', () => {
    const text = read(PLAYBOOK);
    const block = text.slice(text.indexOf('**In `kookr-ai/kookr`: deliver with `pnpm deliver`'), text.indexOf('**Other repositories**'));
    expect(block.length).toBeGreaterThan(0);
    for (const step of STEP_NAMES) expect(block).toContain(`\`${step}\``);
    expect(block).toContain('every other repository skips this block');
    const guard = block.indexOf('pr_create_guard');
    expect(guard).toBeGreaterThan(block.indexOf('--to push'));
    expect(guard).toBeLessThan(block.indexOf('--from pr --to pr'));
    // Phase 8 resumes it for the verdict wait and the merge, and keeps the wrapper as the fallback.
    const phase8 = text.slice(text.indexOf('## Phase 8:'), text.indexOf('## Phase 8.5:'));
    expect(phase8).toContain('pnpm deliver --repo "$REPO" --body-file .tmp/pr-body.md --from wait-verdict');
    expect(phase8).toContain('kookr merge <PR_NUMBER> --repo "$REPO"');
  });
});
