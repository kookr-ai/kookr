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

/** Isolate fixture git from the ambient worktree (GIT_DIR / common-dir). */
function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...extra,
  };
  return env;
}

function makeRepo(origin: string, claudeBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-pr-merge-gate-'));
  temps.push(dir);
  const env = isolatedEnv(dir);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, env, encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
  const remote = spawnSync('git', ['remote', 'add', 'origin', origin], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  expect(remote.status, remote.stderr).toBe(0);
  writeFileSync(join(dir, 'CLAUDE.md'), claudeBody);
  return dir;
}

function runHook(
  cwd: string,
  extraEnv: Record<string, string>,
  command: string,
): string {
  return execFileSync('bash', [HOOK], {
    cwd,
    env: isolatedEnv(cwd, extraEnv),
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
    const out = runHook(cwd, {}, MERGE);
    expect(out.trim()).toBe('');
  });
});
