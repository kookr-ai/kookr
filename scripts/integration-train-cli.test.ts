// End-to-end tests of the integration train's real wiring (issue #3788).
//
// scripts/integration-train.test.ts covers the decision logic with injected
// fakes. These tests run the actual CLI, so they cover what the fakes replace:
// the verify command really runs against the checked-out commit, the single
// instance lock, and the refusal to reset a directory the train does not own.
// `gh` and `kookr` are stubbed on PATH; git runs only in mkdtemp directories.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts/integration-train.ts');
// The CLI is launched from a temp checkout with no node_modules, so the tsx
// loader is passed by absolute URL instead of by package name.
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
// Red when the checked-out commit contains bad.txt. Runs in the train worktree.
const VERIFY = 'test ! -e bad.txt';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Train Test', GIT_AUTHOR_EMAIL: 'train@test.invalid',
  GIT_COMMITTER_NAME: 'Train Test', GIT_COMMITTER_EMAIL: 'train@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...gitExecEnv(), ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface Sandbox {
  root: string;
  origin: string;
  launch: string;
  kookrDir: string;
  worktree: string;
  callLog: string;
  /** Answers of the stub `gh`: `pr.json` (pr view) and `issue-<n>.json` (REST issue endpoint). */
  ghData: string;
  signalDir: string;
  commit(branch: string, files: Record<string, string>, subject: string): string;
  ref(branch: string): string;
  cycle(extra?: string[]): { status: number | null; stderr: string };
  calls(): string[];
  /** Operator signals in the outbox, oldest first. */
  signals(): Array<{ key: string; kind: string; title: string; detail?: string }>;
}

const roots: string[] = [];

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'integration-train-cli-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const launch = join(root, 'launch');
  const kookrDir = join(root, 'kookr-dir');
  const worktree = join(root, 'train-worktree');
  const bin = join(root, 'bin');
  const callLog = join(root, 'calls.log');
  const ghData = join(root, 'gh-data');
  const signalDir = join(root, 'operator-signals');
  mkdirSync(origin);
  mkdirSync(bin);
  mkdirSync(ghData);
  // GitHub gives no closing references for a PR that targets a non-default branch;
  // the issue is only in the body.
  writeFileSync(join(ghData, 'pr.json'), '{"closingIssuesReferences":[],"body":"Closes #42"}');
  git(origin, 'init', '--bare', '-q', '--initial-branch=main');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(seed, '.kookr'));
  writeFileSync(join(seed, '.kookr/delivery-gate.json'), '{"integrationBranch":"staging","prePushGate":"fast"}\n');
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'push', '-q', 'origin', 'main:refs/heads/staging');
  git(root, 'clone', '-q', origin, launch);

  // Stubs: record every call; `gh` answers the read shapes the train uses from
  // files in ghData (an issue with no file is open).
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    `printf 'gh %s\\n' "$*" >> "${callLog}"`,
    'case "$*" in',
    `  *closingIssuesReferences*) cat "${ghData}/pr.json" ;;`,
    '  *nameWithOwner*) echo \'{"nameWithOwner":"acme/kookr"}\' ;;',
    '  "api repos/{owner}/{repo}/issues/"*)',
    '    n="${2##*/}"',
    `    if [ -f "${ghData}/issue-$n.json" ]; then cat "${ghData}/issue-$n.json"; else echo '{"state":"open"}'; fi ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  // `kookr spawn` fails while ghData/spawn-fails exists.
  writeFileSync(join(bin, 'kookr'), [
    '#!/usr/bin/env bash',
    `printf 'kookr %s\\n' "$*" >> "${callLog}"`,
    `if [ "$1" = spawn ] && [ -e "${ghData}/spawn-fails" ]; then echo 'server unreachable' >&2; exit 3; fi`,
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'kookr'), 0o755);

  return {
    root, origin, launch, kookrDir, worktree, callLog, ghData, signalDir,
    commit(branch, files, subject) {
      git(seed, 'fetch', '-q', 'origin');
      git(seed, 'checkout', '-q', '-B', branch, `origin/${branch}`);
      for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content);
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', subject);
      git(seed, 'push', '-q', 'origin', branch);
      return git(seed, 'rev-parse', 'HEAD');
    },
    ref: (branch) => git(origin, 'rev-parse', `refs/heads/${branch}`),
    cycle(extra = []) {
      const r = spawnSync(
        process.execPath,
        ['--import', TSX_LOADER, CLI, 'cycle', '--verify-cmd', VERIFY, '--worktree', worktree, ...extra],
        {
          cwd: launch,
          encoding: 'utf8',
          // The outbox must be a temp dir: the default is the operator's real one.
          env: {
            ...gitExecEnv(), ...IDENTITY, KOOKR_DIR: kookrDir, KOOKR_OPERATOR_SIGNAL_DIR: signalDir,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
          },
          timeout: 60_000,
        },
      );
      return { status: r.status, stderr: r.stderr };
    },
    calls: () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : []),
    signals: () => (existsSync(signalDir) ? readdirSync(signalDir) : [])
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => JSON.parse(readFileSync(join(signalDir, f), 'utf8')) as {
        key: string; kind: string; title: string; detail?: string; createdAt: string;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key)),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('integration train CLI', () => {
  it('runs the verify command on the staging head and fast-forwards main to it when green', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');

    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(head);
    // the train worked in its own worktree, not in the launching checkout
    expect(git(s.launch, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(git(s.launch, 'status', '--porcelain')).toBe('');
    // linked issue 42 comes from the PR body, and is closed once main has the commit
    expect(s.calls().filter((c) => c.startsWith('gh issue close 42 '))).toHaveLength(1);
    // nothing was wrong, so nothing is signalled (no alert, no "recovered")
    expect(s.signals()).toEqual([]);
  }, 120_000);

  it('reverts the commit whose tree fails the verify command', () => {
    const s = makeSandbox();
    const bad = s.commit('staging', { 'bad.txt': 'x' }, 'broken (#7)');

    expect(s.cycle().status).toBe(0);
    const head = s.ref('staging');
    expect(git(s.origin, 'log', '-1', '--format=%B', head)).toContain(`This reverts commit ${bad}`);
    // the issue named only in the PR body was commented on and got the fix task
    expect(s.calls().some((c) => c.startsWith('gh issue comment 42 --body '))).toBe(true);
    const spawns = s.calls().filter((c) => c.startsWith('kookr spawn '));
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain('--idempotency-key train-fix-issue-42-1');
    // the operator is alerted once, with no "recovered" in front of it
    expect(s.signals().map((x) => [x.kind, x.title])).toEqual([['alert', 'integration train: reverted']]);
    expect(s.signals()[0].detail).toContain(`reverted ${bad} as ${head}`);

    // the verified revert was promoted in the same cycle; the next one is idle
    // and reports recovery, once
    expect(s.ref('main')).toBe(head);
    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(head);
    expect(s.cycle().status).toBe(0);
    expect(s.signals().map((x) => x.kind)).toEqual(['alert', 'clear']);
    expect(s.signals()[1].title).toBe('integration train recovered');
  }, 120_000);

  it('writes every event of one cycle to the outbox with its own detail', () => {
    const s = makeSandbox();
    writeFileSync(join(s.ghData, 'spawn-fails'), '');
    s.commit('staging', { 'bad.txt': 'x' }, 'broken (#7)');

    expect(s.cycle().status).toBe(0);
    const signals = s.signals();
    expect(signals.map((x) => x.title).sort()).toEqual([
      'integration train: fix-spawn-failed', 'integration train: reverted',
    ]);
    expect(new Set(signals.map((x) => x.key)).size).toBe(2);
    expect(signals.find((x) => x.title.endsWith('fix-spawn-failed'))?.detail).toContain('could not be spawned');
    expect(signals.find((x) => x.title.endsWith(': reverted'))?.detail).toContain('could not be spawned');
    expect(signals.every((x) => x.kind === 'alert')).toBe(true);
  }, 120_000);

  it('writes no "recovered" signal while the train is still halted', () => {
    const s = makeSandbox();
    // reverting the culprit conflicts with the commit after it: a halt
    s.commit('staging', { 'bad.txt': 'x' }, 'culprit (#21)');
    s.commit('staging', { 'bad.txt': 'y' }, 'builds on culprit (#22)');
    expect(s.cycle().status).toBe(0);
    expect(s.cycle().status).toBe(0); // standing halt
    s.commit('staging', { 'c.txt': '1' }, 'more (#23)'); // the ref moves; still conflicts
    expect(s.cycle().status).toBe(0);
    const signals = s.signals();
    expect(signals.map((x) => x.kind)).toEqual(['alert', 'alert']);
    expect(signals.every((x) => x.detail?.startsWith('revert-conflict: '))).toBe(true);
  }, 120_000);

  it('drops cross-repository closing references and numbers that are pull requests', () => {
    const s = makeSandbox();
    writeFileSync(join(s.ghData, 'pr.json'), JSON.stringify({
      closingIssuesReferences: [
        { number: 43, repository: { name: 'kookr', owner: { login: 'acme' } } },
        { number: 99, repository: { name: 'other', owner: { login: 'someone' } } },
      ],
      body: 'Closes #42 and fixes #50',
    }));
    writeFileSync(join(s.ghData, 'issue-50.json'), JSON.stringify({ state: 'open', pull_request: { url: 'x' } }));
    s.commit('staging', { 'a.txt': '1' }, 'one (#1)');

    expect(s.cycle().status).toBe(0);
    const closed = s.calls().filter((c) => c.startsWith('gh issue close ')).map((c) => c.split(' ')[3]);
    expect(closed.sort()).toEqual(['42', '43']);
    // #99 lives in another repository: never even looked up here
    expect(s.calls().some((c) => c.includes('issues/99'))).toBe(false);
    expect(s.calls().some((c) => / (reopen|comment|close) 50 /.test(c))).toBe(false);
  }, 120_000);

  it('runs its verify with the flaky re-run of scripts/verify.sh switched on', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    expect(s.cycle(['--verify-cmd', 'test "$KOOKR_VERIFY_FLAKY_RERUN" = 1']).status).toBe(0);
    expect(s.ref('main')).toBe(head);
  }, 120_000);

  it('does nothing while another live process holds the lock', () => {
    const s = makeSandbox();
    const base = s.ref('main');
    s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    mkdirSync(join(s.kookrDir, 'integration-train'), { recursive: true });
    // this test process is alive, so the lock is live
    writeFileSync(join(s.kookrDir, 'integration-train/train.lock'), String(process.pid));

    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(base);
    expect(existsSync(s.worktree)).toBe(false);
  }, 120_000);

  it('takes over a lock left by a dead process', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    mkdirSync(join(s.kookrDir, 'integration-train'), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(join(s.kookrDir, 'integration-train/train.lock'), dead.stdout.trim());

    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(head);
    expect(existsSync(join(s.kookrDir, 'integration-train/train.lock'))).toBe(false);
  }, 120_000);

  it('refuses to use a directory it did not create as its worktree', () => {
    const s = makeSandbox();
    const base = s.ref('main');
    s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    // someone's ordinary clone, with uncommitted work, at the worktree path
    git(s.root, 'clone', '-q', s.origin, s.worktree);
    writeFileSync(join(s.worktree, 'README.md'), 'precious local edit\n');

    const r = s.cycle();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not a worktree created by the integration train');
    expect(readFileSync(join(s.worktree, 'README.md'), 'utf8')).toBe('precious local edit\n');
    expect(s.ref('main')).toBe(base);
  }, 120_000);
});
