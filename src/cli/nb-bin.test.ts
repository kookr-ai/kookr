// Tests for the rerouted `bin/nb.js` shim. kookr no longer vendors the notebook
// CLI — the shim resolves and runs the public `agent-notebook` package, pins
// NB_DIR to the kookr location, and (Objective C) commits every notebook
// mutation when NB_DIR is a git repo so a daily job can push the history.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// The .gitignore the host setup writes into the notebook repo so only the
// lesson files are versioned (not the churny usage ring / retro sentinels).
const NOTEBOOK_GITIGNORE = '.nb-usage.log\n.nb-usage.log.tmp\n.retro-*\n.nb.lock\n*.tmp\n';

// Strip inherited GIT_* vars so this test's own `git -C <tmpdir>` calls target
// the temp repo and can never leak into the real repo — notably under the
// pre-push hook, where git exports GIT_DIR/GIT_WORK_TREE and they would override
// `-C`. Mirrors src/core/git-helpers NESTED_GIT_ENV_VARS.
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_WORK_TREE',
  ]) delete env[k];
  return env;
}

const BIN = join(process.cwd(), 'bin/nb.js');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-bin-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run `node bin/nb.js <argv>` with NB_DIR=dir; capture stdout/exit. */
function nb(args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('node', [BIN, ...args], {
      env: { ...cleanGitEnv(), NB_DIR: dir, ...extraEnv },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { code: err.status ?? -1, out: err.stdout?.toString() ?? '' };
  }
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: cleanGitEnv() }).trim();
}

function initRepo(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 'nb@test']);
  git(['config', 'user.name', 'nb test']);
  writeFileSync(join(dir, '.gitignore'), NOTEBOOK_GITIGNORE);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'init']);
}

describe('bin/nb.js — dogfooded package', () => {
  test('runs the public agent-notebook package (version line)', () => {
    const r = nb(['--version']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nb (agent-notebook)');
  });

  test('add then show round-trips a lesson under the pinned NB_DIR', () => {
    expect(nb(['add', 'patcher', 'prefer execFileSync, array args']).code).toBe(0);
    const show = nb(['show', 'patcher']);
    expect(show.out).toContain('prefer execFileSync, array args');
  });
});

describe('bin/nb.js — per-change git auto-commit (Objective C)', () => {
  test('commits each mutation when NB_DIR is a git repo; reads do not commit', () => {
    initRepo();
    const before = git(['rev-list', '--count', 'HEAD']);
    nb(['add', 'patcher', 'lesson about locks']);
    nb(['vote', 'patcher', 'locks', '+1']);
    const afterMutations = Number(git(['rev-list', '--count', 'HEAD']));
    expect(afterMutations).toBe(Number(before) + 2); // one commit per mutation
    expect(git(['log', '-1', '--format=%s'])).toMatch(/^nb vote patcher/);

    nb(['show', 'patcher']); // a read
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(afterMutations); // no new commit
  });

  test('tracks only lesson files — the usage log/sentinels stay ignored', () => {
    initRepo();
    nb(['add', 'patcher', 'x']);
    nb(['show', 'patcher']); // a read churns the usage log
    const tracked = git(['ls-files']);
    expect(tracked).toContain('patcher.md');
    expect(tracked).not.toContain('.nb-usage.log');
  });

  test('NB_GIT_AUTOCOMMIT=0 disables the auto-commit', () => {
    initRepo();
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    nb(['add', 'patcher', 'no commit please'], { NB_GIT_AUTOCOMMIT: '0' });
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before); // unchanged
  });

  test('is fail-open when NB_DIR is not a git repo (mutation still succeeds)', () => {
    const r = nb(['add', 'patcher', 'works without git']);
    expect(r.code).toBe(0);
    expect(nb(['show', 'patcher']).out).toContain('works without git');
  });

  test('a mutation that changes nothing (duplicate add) creates no commit', () => {
    initRepo();
    nb(['add', 'patcher', 'same lesson']);
    const afterFirst = Number(git(['rev-list', '--count', 'HEAD']));
    nb(['add', 'patcher', 'same lesson']); // dedup-skipped → nothing staged
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(afterFirst); // no empty commit
  });

  test('is fail-open when the git commit itself fails (mutation still succeeds)', () => {
    initRepo();
    // A pre-commit hook that always rejects makes `git commit` fail while the
    // notebook write still lands — exercises the autoCommit() catch in bin/nb.js.
    const hookPath = join(dir, '.git/hooks/pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    const r = nb(['add', 'patcher', 'lands despite failing commit']);
    expect(r.code).toBe(0); // the nb call never fails on a git error
    expect(nb(['show', 'patcher']).out).toContain('lands despite failing commit');
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before); // commit was rejected
  });

  test('auto-commit targets NB_DIR even when a hostile GIT_DIR is exported', () => {
    // Under a git hook, git exports GIT_DIR/GIT_WORK_TREE; unstripped they would
    // override `-C <NB_DIR>` and commit to the wrong repo. Point them at a decoy
    // repo and assert the commit lands in NB_DIR, not the decoy.
    initRepo();
    const decoy = mkdtempSync(join(tmpdir(), 'kookr-nb-decoy-'));
    try {
      const dgit = (args: string[]) =>
        execFileSync('git', ['-C', decoy, ...args], { encoding: 'utf-8', env: cleanGitEnv() });
      dgit(['init', '-q']);
      dgit(['config', 'user.email', 'd@d']);
      dgit(['config', 'user.name', 'd']);
      dgit(['commit', '--quiet', '--allow-empty', '-m', 'decoy-init']);
      const nbBefore = Number(git(['rev-list', '--count', 'HEAD']));
      const decoyBefore = Number(dgit(['rev-list', '--count', 'HEAD']).trim());

      nb(['add', 'patcher', 'lands in NB_DIR not the decoy'], {
        GIT_DIR: join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
      });

      expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(nbBefore + 1); // NB_DIR got it
      expect(Number(dgit(['rev-list', '--count', 'HEAD']).trim())).toBe(decoyBefore); // decoy untouched
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test('a derived @-scoped role (orchestrator@owner-repo) round-trips through the package', () => {
    // Re-anchors the three-way charset agreement: sanitizeRoleSegment (launcher)
    // ↔ hook role regex ↔ the package SAFE_ROLE all accept `role@owner-repo`.
    const role = 'orchestrator@acme-widgets';
    expect(nb(['add', role, 'per-repo orchestrator lesson']).code).toBe(0);
    expect(nb(['show', role]).out).toContain('per-repo orchestrator lesson');
  });
});

describe('bin/nb.js — `nb roles` discovery (reuse, not reinvent)', () => {
  test('reports an empty store without crashing', () => {
    const r = nb(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no notebooks yet');
  });

  test('lists existing roles with lesson counts, richest first', () => {
    nb(['add', 'code-review', 'one']);
    nb(['add', 'patch-author', 'a']);
    nb(['add', 'patch-author', 'b']);
    nb(['add', 'patch-author', 'c']);
    const r = nb(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('patch-author');
    expect(r.out).toContain('code-review');
    expect(r.out).toContain('3 lessons');
    expect(r.out).toMatch(/\b1 lesson\b/); // singular — and must NOT render "1 lessons"
    expect(r.out).not.toContain('1 lessons');
    // richest first: patch-author (3) is listed before code-review (1)
    expect(r.out.indexOf('patch-author')).toBeLessThan(r.out.indexOf('code-review'));
  });

  test('excludes non-.md files (usage log, stray files) from the listing', () => {
    nb(['add', 'real-role', 'x']); // writes real-role.md (and a .nb-usage.log) into NB_DIR
    writeFileSync(join(dir, 'notes.txt'), 'not a notebook');
    const r = nb(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('real-role');
    expect(r.out).toMatch(/roles — 1 in/); // only the .md file counts — not notes.txt / .nb-usage.log
    expect(r.out).not.toContain('notes');
  });

  test('is read-only — listing roles creates no git commit', () => {
    initRepo();
    nb(['add', 'patcher', 'x']);
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    nb(['roles']);
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before); // no commit from a read
  });

  test('accepts `list` and `ls` as aliases for `roles` (agents guess these)', () => {
    nb(['add', 'alpha', 'l1']);
    nb(['add', 'beta', 'l1']);
    const roles = nb(['roles']);
    const list = nb(['list']);
    const ls = nb(['ls']);
    for (const r of [list, ls]) {
      expect(r.code).toBe(0); // the guessed names succeed instead of erroring
      expect(r.out).toContain('alpha');
      expect(r.out).toContain('beta');
    }
    // aliases render the same listing as the canonical command
    expect(list.out).toBe(roles.out);
    expect(ls.out).toBe(roles.out);
  });
});
