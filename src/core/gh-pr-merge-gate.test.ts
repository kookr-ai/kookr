import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * Issue #3027: the global gh-pr-merge-gate must keep blocking bare merges on
 * kookr-ai/kookr, and must allow them on repos that document independent
 * review as advisory so Lucy agents are not stalled by the hook.
 */
const HOOK = join(import.meta.dirname, '..', '..', 'hooks', 'gh-pr-merge-gate.sh');

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(origin: string, claudeBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-pr-merge-gate-'));
  temps.push(dir);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  expect(init.status).toBe(0);
  const remote = spawnSync('git', ['remote', 'add', 'origin', origin], {
    cwd: dir,
    encoding: 'utf8',
  });
  expect(remote.status).toBe(0);
  writeFileSync(join(dir, 'CLAUDE.md'), claudeBody);
  return dir;
}

function runHook(
  cwd: string,
  extraEnv: Record<string, string>,
  command: string,
  unset: string[] = [],
): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, ...extraEnv };
  for (const key of unset) {
    delete env[key];
  }
  return execFileSync('bash', [HOOK], {
    cwd,
    env,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
}

function denied(stdout: string): boolean {
  return /"permissionDecision"\s*:\s*"deny"/.test(stdout);
}

const MERGE = 'gh pr merge 12 --squash --delete-branch';
const ADVISORY = '## No human merge gate — independent review is advisory verification\n';

describe('gh-pr-merge-gate.sh advisory-repo split (issue #3027)', () => {
  test('denies bare gh pr merge on kookr-ai/kookr even if CLAUDE.md is advisory', () => {
    const cwd = makeRepo('git@github.com:kookr-ai/kookr.git', ADVISORY);
    const out = runHook(cwd, { KOOKR_TASK_ID: 'task-1' }, MERGE);
    expect(denied(out)).toBe(true);
    expect(out).toContain('pnpm merge');
  });

  test('allows bare gh pr merge when origin is not kookr and CLAUDE.md is advisory', () => {
    const cwd = makeRepo('git@github.com:jeanibarz/lucy.git', ADVISORY);
    const out = runHook(cwd, { KOOKR_TASK_ID: 'task-1' }, MERGE);
    expect(out.trim()).toBe('');
    expect(denied(out)).toBe(false);
  });

  test('still denies a non-kookr repo whose CLAUDE.md does not opt out', () => {
    const cwd = makeRepo('https://github.com/jeanibarz/other.git', '# just a repo\n');
    const out = runHook(cwd, { KOOKR_TASK_ID: 'task-1' }, MERGE);
    expect(denied(out)).toBe(true);
  });

  test('KOOKR_MERGE_REQUIRE_REVIEW=0 remains an explicit kill-switch', () => {
    const cwd = makeRepo('git@github.com:kookr-ai/kookr.git', '# kookr\n');
    const out = runHook(
      cwd,
      { KOOKR_TASK_ID: 'task-1', KOOKR_MERGE_REQUIRE_REVIEW: '0' },
      MERGE,
    );
    expect(out.trim()).toBe('');
  });

  test('does nothing when KOOKR_TASK_ID is unset', () => {
    const cwd = makeRepo('git@github.com:kookr-ai/kookr.git', '# kookr\n');
    const out = runHook(cwd, {}, MERGE, ['KOOKR_TASK_ID']);
    expect(out.trim()).toBe('');
  });
});
