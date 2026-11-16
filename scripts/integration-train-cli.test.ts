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
import { readProcessArgv, resolveRepoKey } from '../src/server/integration-train-runtime.js';

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
  /** This repository's state directory, `<kookrDir>/integration-train/<key>`. */
  stateDir: string;
  worktree: string;
  callLog: string;
  /** Answers of the stub `gh`: `pr.json` (pr view) and `issue-<n>.json` (REST issue endpoint). */
  ghData: string;
  signalDir: string;
  commit(branch: string, files: Record<string, string>, subject: string): string;
  ref(branch: string): string;
  cycle(extra?: string[]): { status: number | null; stderr: string };
  /** Runs any CLI command from the launching checkout. */
  cli(args: string[]): { status: number | null; stdout: string; stderr: string };
  env: NodeJS.ProcessEnv;
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
    // The pull request's existing comment bodies (#3913): ghData/comments-<n>.txt, none by default.
    '  "api --paginate repos/{owner}/{repo}/issues/"*"/comments"*)',
    '    n="${3%/comments}"; n="${n##*/}"',
    `    if [ -f "${ghData}/comments-$n.txt" ]; then cat "${ghData}/comments-$n.txt"; fi ;;`,
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

  // The outbox must be a temp dir: the default is the operator's real one.
  const env: NodeJS.ProcessEnv = {
    ...gitExecEnv(), ...IDENTITY, KOOKR_DIR: kookrDir, KOOKR_OPERATOR_SIGNAL_DIR: signalDir,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI, ...args], {
      cwd: launch, encoding: 'utf8', env, timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    root, origin, launch, kookrDir, worktree, callLog, ghData, signalDir, env, cli,
    stateDir: join(kookrDir, 'integration-train', resolveRepoKey(launch)),
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
      const r = cli(['cycle', '--verify-cmd', VERIFY, '--worktree', worktree, ...extra]);
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

const pidsToKill: number[] = [];

afterEach(() => {
  for (const pid of pidsToKill.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A long-lived process whose command line reads `node -e <body> <argv...>`. It is
 * started through a shell that exits at once, so it is not this test's child:
 * like a real detached train, it is reaped by the system when it dies instead
 * of lingering as a zombie while this process is blocked in spawnSync.
 */
function fakeProcess(argv: string[], body = 'setInterval(() => {}, 1000)'): { pid: number } {
  const quoted = [process.execPath, '-e', body, ...argv]
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const r = spawnSync('sh', ['-c', `${quoted} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  const pid = Number(r.stdout.trim());
  pidsToKill.push(pid);
  return { pid };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

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

  it('comments once on the promoted pull request, and not when GitHub already holds that comment (#3913)', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(head);
    const reads = s.calls().filter((c) => c.startsWith('gh api --paginate repos/{owner}/{repo}/issues/1/comments'));
    expect(reads).toHaveLength(1);
    const posts = s.calls().filter((c) => c.startsWith('gh pr comment 1 --body '));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('Integration train: promoted.');

    // A restarted train whose comment already reached GitHub posts nothing.
    const t = makeSandbox();
    const again = t.commit('staging', { 'a.txt': '1' }, 'one (#2)');
    writeFileSync(join(t.ghData, 'comments-2.txt'), `an earlier report\n<!-- kookr-integration-train:promoted:${again} -->\n`);
    expect(t.cycle().status).toBe(0);
    expect(t.ref('main')).toBe(again);
    expect(t.calls().filter((c) => c.startsWith('gh api --paginate repos/{owner}/{repo}/issues/2/comments'))).toHaveLength(1);
    expect(t.calls().filter((c) => c.startsWith('gh pr comment '))).toEqual([]);
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
    // the delivery service sends a batch in file-name order: that is event order
    const byFileName = readdirSync(s.signalDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()
      .map((f) => (JSON.parse(readFileSync(join(s.signalDir, f), 'utf8')) as { kind: string }).kind);
    expect(byFileName).toEqual(['alert', 'clear']);
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

  it('keeps the red run\'s log when the head is re-run green, and records its failing test files', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    const marker = join(s.root, 'ran-once');
    // Red the first time, with failure lines shaped like scripts/verify.sh's
    // concurrent train mode (lane prefix, vitest project name); green after.
    const redOnce = [
      `if [ -e '${marker}' ]; then echo all green; exit 0; fi`,
      `touch '${marker}'`,
      "echo '[unit_lane]  FAIL  |serial| src/server/slow.test.ts > suite > times out under load'",
      "echo '[unit_lane]  FAIL  src/core/other.test.ts > races'",
      "echo '[unit_lane]  FAIL  |serial| src/server/slow.test.ts > suite > second case'",
      'exit 1',
    ].join('; ');

    expect(s.cycle(['--verify-cmd', redOnce]).status).toBe(0);
    expect(s.ref('main')).toBe(head); // the flake re-run was green: promoted
    const short = head.slice(0, 10);
    const red = readFileSync(join(s.stateDir, `verify-${short}.run1.log`), 'utf8');
    expect(red).toContain('FAIL  |serial| src/server/slow.test.ts');
    const green = readFileSync(join(s.stateDir, `verify-${short}.log`), 'utf8');
    expect(green).toContain('all green');
    expect(green).not.toContain('FAIL');

    const files = ['src/core/other.test.ts', 'src/server/slow.test.ts'];
    const trainLog = readFileSync(join(s.stateDir, 'train.log'), 'utf8');
    expect(trainLog).toContain(`${short} was red, then green on re-run; failing test files of the red run: ${files.join(', ')}`);
    const events = readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; sha?: string; files?: string[]; log?: string });
    expect(events).toEqual([expect.objectContaining({
      kind: 'red-then-green', sha: head, files, log: join(s.stateDir, `verify-${short}.run1.log`),
    })]);
    // a record for fixing tests, not an alert
    expect(s.signals()).toEqual([]);
  }, 120_000);

  it('does nothing while another live process holds the lock', () => {
    const s = makeSandbox();
    const base = s.ref('main');
    s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    mkdirSync(s.stateDir, { recursive: true });
    // this test process is alive, so the lock is live
    writeFileSync(join(s.stateDir, 'train.lock'), String(process.pid));

    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(base);
    expect(existsSync(s.worktree)).toBe(false);
  }, 120_000);

  it('takes over a lock left by a dead process', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    mkdirSync(s.stateDir, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(join(s.stateDir, 'train.lock'), dead.stdout.trim());

    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(head);
    expect(existsSync(join(s.stateDir, 'train.lock'))).toBe(false);
  }, 120_000);

  it('keeps its lock and state per repository', () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    // another repository's train holds its own lock and is halted
    const other = join(s.kookrDir, 'integration-train', 'someone-else');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'train.lock'), String(process.pid));
    writeFileSync(join(other, 'state.json'), JSON.stringify({ halted: { reason: 'base-red', main: 'a', integration: 'b', at: 'x' } }));

    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).toBe(head);
    expect(JSON.parse(readFileSync(join(s.stateDir, 'last-cycle.json'), 'utf8')).outcome).toBe('promoted');
    expect(existsSync(join(other, 'last-cycle.json'))).toBe(false);
  }, 120_000);

  it('stop does not signal a live process that is not the train', async () => {
    const s = makeSandbox();
    const stranger = fakeProcess(['some-other-program']);
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(join(s.stateDir, 'train.pid'), String(stranger.pid));

    const r = s.cli(['stop']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('is not the integration train');
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(stranger.pid)).toBe(true);
    expect(existsSync(join(s.stateDir, 'train.pid'))).toBe(false);
  }, 120_000);

  it('stop signals the process when it is the train', async () => {
    const s = makeSandbox();
    const train = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(join(s.stateDir, 'train.pid'), String(train.pid));

    const r = s.cli(['stop']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped integration train (pid ${train.pid})`);
    expect(await until(() => !alive(train.pid), 5_000)).toBe(true);
  }, 120_000);

  // Issue #3847: during a hand-over `run-info.json` names the successor while
  // `train.pid` still names its predecessor.
  it('stop also stops the train that run-info.json names when train.pid names another one', async () => {
    const s = makeSandbox();
    const old = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
    const successor = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(join(s.stateDir, 'train.pid'), String(old.pid));
    writeFileSync(join(s.stateDir, 'run-info.json'), JSON.stringify({ pid: successor.pid, restartRequests: true }));

    const r = s.cli(['stop']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped integration train (pid ${old.pid})`);
    expect(r.stdout).toContain(`stopped integration train (pid ${successor.pid})`);
    expect(await until(() => !alive(old.pid) && !alive(successor.pid), 5_000)).toBe(true);
    expect(existsSync(join(s.stateDir, 'train.pid'))).toBe(false);
  }, 120_000);

  it('stop also stops a successor the old train records while the stop waits for it to exit', async () => {
    const s = makeSandbox();
    mkdirSync(s.stateDir, { recursive: true });
    const pidFile = join(s.stateDir, 'train.pid');
    const successor = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
    // The old train confirms its successor just as the SIGTERM lands, then exits alone.
    const ready = join(s.root, 'old-ready');
    const old = fakeProcess([CLI, 'run', '--worktree', s.worktree], [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(pidFile)}, '${successor.pid}'); process.exit(0); });`,
      `fs.writeFileSync(${JSON.stringify(ready)}, '');`,
      'setInterval(() => {}, 1000);',
    ].join(' '));
    expect(await until(() => existsSync(ready), 10_000)).toBe(true);
    writeFileSync(pidFile, String(old.pid));

    const r = s.cli(['stop']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped integration train (pid ${old.pid})`);
    expect(r.stdout).toContain(`stopped integration train (pid ${successor.pid})`);
    // no train is left running that train.pid does not name
    expect(await until(() => !alive(successor.pid), 5_000)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  }, 120_000);

  it('restart replaces a train of the old shared layout, keeps its options and carries its state over', async () => {
    const s = makeSandbox();
    const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    // A train started before #3796: state and pid directly in integration-train/.
    const legacy = join(s.kookrDir, 'integration-train');
    mkdirSync(legacy, { recursive: true });
    const old = fakeProcess([CLI, 'run', '--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1']);
    writeFileSync(join(legacy, 'train.pid'), String(old.pid));
    writeFileSync(join(legacy, 'state.json'), JSON.stringify({ fixTasks: { 'issue-9': 1 }, alerting: false }));

    // while the old train runs, a cycle of the new code waits for it
    expect(s.cycle().status).toBe(0);
    expect(s.ref('main')).not.toBe(head);

    const r = s.cli(['restart']);
    // registered for cleanup before any assertion can fail
    const pid = Number(readFileSync(join(s.stateDir, 'train.pid'), 'utf8'));
    pidsToKill.push(pid);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped integration train (pid ${old.pid})`);
    // the new train runs with the old one's options (worktree, verify, interval)
    expect(await until(() => { try { return s.ref('main') === head; } catch { return false; } }, 60_000)).toBe(true);
    expect(existsSync(join(s.worktree, 'a.txt'))).toBe(true);
    expect(JSON.parse(readFileSync(join(s.stateDir, 'state.json'), 'utf8')).fixTasks).toEqual({ 'issue-9': 1 });
    expect(existsSync(join(legacy, 'state.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.stateDir, 'start-args.json'), 'utf8'))).toEqual([
      '--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1',
    ]);

    const status = JSON.parse(s.cli(['status']).stdout) as { running: boolean; pid: number };
    expect(status).toMatchObject({ running: true, pid });
    expect(s.cli(['stop']).status).toBe(0);
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
  }, 120_000);

  // Issue #3841: a deploy restarts the train; that must never kill a verify in flight.
  describe('restart after a deploy', () => {
    const trainPid = (s: Sandbox): number | null => {
      try { return Number(readFileSync(join(s.stateDir, 'train.pid'), 'utf8').trim()) || null; } catch { return null; }
    };
    const trainLog = (s: Sandbox): string => {
      try { return readFileSync(join(s.stateDir, 'train.log'), 'utf8'); } catch { return ''; }
    };
    /** Starts a real train and waits until its run loop has recorded itself. */
    async function startTrain(s: Sandbox, args: string[]): Promise<number> {
      const r = s.cli(['start', ...args]);
      expect(r.status).toBe(0);
      const pid = trainPid(s);
      expect(pid).not.toBeNull();
      pidsToKill.push(pid as number);
      expect(await until(() => {
        try { return JSON.parse(readFileSync(join(s.stateDir, 'run-info.json'), 'utf8')).pid === pid; } catch { return false; }
      }, 30_000)).toBe(true);
      return pid as number;
    }
    /** Waits for train.pid to name a live process other than `old`, and returns it. */
    async function successorOf(s: Sandbox, old: number): Promise<number> {
      let next: number | null = null;
      const ok = await until(() => { next = trainPid(s); return next !== null && next !== old && alive(next); }, 60_000);
      if (next !== null) pidsToKill.push(next);
      expect(ok).toBe(true);
      return next as unknown as number;
    }
    const argsAfterRun = (pid: number): string[] => {
      const argv = readProcessArgv(pid) ?? [];
      return argv.slice(argv.indexOf('run') + 1);
    };

    it('returns at once, lets the verify in flight finish and promote, then hands over to a new process with the same options', async () => {
      const s = makeSandbox();
      const head = s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
      const marks = join(s.root, 'verify-marks');
      const slowVerify = `echo start >> '${marks}'; sleep 15; echo done >> '${marks}'`;
      const args = ['--worktree', s.worktree, '--workers', '3', '--interval', '1', '--verify-cmd', slowVerify];
      const old = await startTrain(s, args);
      expect(await until(() => existsSync(marks), 60_000)).toBe(true);

      const r = s.cli(['restart']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`restart requested: integration train (pid ${old})`);
      // returned while the verify is still running, and did not touch it
      expect(readFileSync(marks, 'utf8')).toBe('start\n');
      expect(alive(old)).toBe(true);
      expect(s.ref('main')).not.toBe(head);
      expect(JSON.parse(s.cli(['status']).stdout)).toMatchObject({ running: true, pid: old, restartPending: { requestedAt: expect.any(String) } });

      // the verify completes and promotes; only then does a new process take over
      expect(await until(() => s.ref('main') === head, 60_000)).toBe(true);
      const next = await successorOf(s, old);
      expect(await until(() => !alive(old), 10_000)).toBe(true);
      expect(argsAfterRun(next)).toEqual(args);
      expect(readFileSync(marks, 'utf8')).toBe('start\ndone\n'); // one verify, never killed and re-run
      const log = trainLog(s);
      expect(log.indexOf('cycle: promoted')).toBeGreaterThan(-1);
      expect(log.indexOf('re-executing after the cycle (restart requested)')).toBeGreaterThan(log.indexOf('cycle: promoted'));
      expect(log).toContain(`handed over to pid ${next}`);
      // the successor runs no cycle before the old train has exited (#3848)
      const exitedLine = `pid ${old} has exited; first cycle starts`;
      expect(await until(() => {
        const l = trainLog(s);
        return l.includes(exitedLine) && l.indexOf('cycle: ', l.indexOf(exitedLine)) > -1;
      }, 30_000)).toBe(true);
      const after = trainLog(s);
      const handedOver = after.indexOf(`handed over to pid ${next}`);
      const waited = after.indexOf(exitedLine);
      expect(waited).toBeGreaterThan(handedOver);
      expect(after.slice(handedOver, waited)).not.toContain('cycle: ');
      expect(existsSync(join(s.stateDir, 'restart-request.json'))).toBe(false);
      expect(JSON.parse(s.cli(['status']).stdout)).toMatchObject({ running: true, pid: next, restartPending: null });

      expect(s.cli(['stop']).status).toBe(0);
      expect(await until(() => !alive(next), 10_000)).toBe(true);
    }, 180_000);

    it('re-executes between cycles by itself when the launching checkout HEAD changed', async () => {
      const s = makeSandbox();
      const args = ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1'];
      const old = await startTrain(s, args);
      // a deploy moved the checkout, and its restart request never came
      git(s.launch, 'commit', '-q', '--allow-empty', '-m', 'deployed');

      const next = await successorOf(s, old);
      expect(await until(() => !alive(old), 10_000)).toBe(true);
      expect(trainLog(s)).toContain('re-executing after the cycle (checkout HEAD moved from');
      expect(argsAfterRun(next)).toEqual(args);
      expect(s.cli(['stop']).status).toBe(0);
      expect(await until(() => !alive(next), 10_000)).toBe(true);
    }, 180_000);

    it('starts a train when none is running, and drops a request a dead train left behind', async () => {
      const s = makeSandbox();
      mkdirSync(s.stateDir, { recursive: true });
      writeFileSync(join(s.stateDir, 'restart-request.json'), JSON.stringify({ requestedAt: '2026-11-15T00:00:00Z', args: [] }));
      const args = ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1'];

      const r = s.cli(['restart', ...args]);
      const pid = trainPid(s);
      if (pid !== null) pidsToKill.push(pid);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`integration train started (pid ${pid})`);
      expect(pid !== null && alive(pid)).toBe(true);
      expect(existsSync(join(s.stateDir, 'restart-request.json'))).toBe(false);
      expect(await until(() => argsAfterRun(pid as number).length > 0, 10_000)).toBe(true);
      expect(argsAfterRun(pid as number)).toEqual(args);
      expect(s.cli(['stop']).status).toBe(0);
    }, 120_000);

    it('a halted train applies a restart at once, with the options the restart gave', async () => {
      const s = makeSandbox();
      mkdirSync(s.stateDir, { recursive: true });
      // a standing halt on the current refs: each cycle returns at once
      writeFileSync(join(s.stateDir, 'state.json'), JSON.stringify({
        halted: { reason: 'base-red', main: s.ref('main'), integration: s.ref('staging'), at: '2026-11-15T00:00:00Z' },
      }));
      const old = await startTrain(s, ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '600']);
      expect(await until(() => trainLog(s).includes('cycle: halted'), 30_000)).toBe(true);

      const given = ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1', '--workers', '2'];
      const r = s.cli(['restart', ...given]);
      expect(r.stdout).toContain('restart requested');
      // well within the 600 s interval: the request is checked every second
      const next = await successorOf(s, old);
      expect(argsAfterRun(next)).toEqual(given);
      expect(JSON.parse(readFileSync(join(s.stateDir, 'start-args.json'), 'utf8'))).toEqual(given);
      expect(s.cli(['stop']).status).toBe(0);
    }, 180_000);

    it('keeps running the old train when its successor fails to start, and retries the request after a cycle, up to three times', async () => {
      const s = makeSandbox();
      const args = ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1'];
      const old = await startTrain(s, args);
      // options the successor rejects: it exits before its run loop starts
      const requestedAt = new Date().toISOString();
      writeFileSync(join(s.stateDir, 'restart-request.json'), JSON.stringify({
        requestedAt, args: ['--bogus'], cwd: s.launch, script: CLI,
      }));

      // #3850: the request is not dropped on the first failure; it is tried
      // again after the next cycle, and given up after the third failure
      expect(await until(() => trainLog(s).includes('failed 3 times, giving up'), 120_000)).toBe(true);
      const log = trainLog(s);
      expect(log.split('re-execution failed, this process keeps running').length - 1).toBe(3);
      const retry = log.indexOf('re-executing after the cycle (restart requested, attempt 2 of 3)');
      expect(retry).toBeGreaterThan(log.indexOf('failed (attempt 1 of 3); trying again after the next cycle'));
      expect(log.lastIndexOf('cycle: ', retry)).toBeGreaterThan(log.indexOf('failed (attempt 1 of 3)'));
      expect(log).toContain('re-executing after the cycle (restart requested, attempt 3 of 3)');
      const events = readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; detail: string });
      expect(events.map((e) => e.kind)).toEqual(['restart-failed', 'restart-failed', 'restart-failed']);
      expect(events[2].detail).toContain(`restart requested at ${requestedAt} failed 3 times, giving up`);
      // the old train still honours the next restart request
      expect(JSON.parse(readFileSync(join(s.stateDir, 'run-info.json'), 'utf8')).pid).toBe(old);
      expect(alive(old)).toBe(true);
      expect(trainPid(s)).toBe(old);
      expect(JSON.parse(readFileSync(join(s.stateDir, 'start-args.json'), 'utf8'))).toEqual(args);
      expect(existsSync(join(s.stateDir, 'restart-request.json'))).toBe(false);
      expect(JSON.parse(s.cli(['status']).stdout)).toMatchObject({ running: true, pid: old, restartPending: null });
      expect(s.cli(['stop']).status).toBe(0);
      expect(await until(() => !alive(old), 10_000)).toBe(true);
    }, 180_000);

    it('stop during a hand-over stops both the old train and its unconfirmed successor', async () => {
      const s = makeSandbox();
      const old = await startTrain(s, ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1']);
      // a successor that looks like the train but never starts its run loop
      const slow = join(s.root, 'slow', 'integration-train.mjs');
      mkdirSync(dirname(slow), { recursive: true });
      const successorFile = join(s.root, 'successor.pid');
      writeFileSync(slow, [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(successorFile)}, String(process.pid));`,
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'));
      writeFileSync(join(s.stateDir, 'restart-request.json'), JSON.stringify({
        requestedAt: new Date().toISOString(), args: [], cwd: s.launch, script: slow,
      }));
      expect(await until(() => existsSync(successorFile), 60_000)).toBe(true);
      const successor = Number(readFileSync(successorFile, 'utf8'));
      pidsToKill.push(successor);
      // the old train is still the one on record while the hand-over is unconfirmed
      expect(trainPid(s)).toBe(old);

      const r = s.cli(['stop']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`stopped integration train (pid ${old})`);
      expect(await until(() => !alive(old) && !alive(successor), 10_000)).toBe(true);
    }, 180_000);

    it('restart files a request for the train run-info.json names while train.pid still names its predecessor (#3849)', async () => {
      const s = makeSandbox();
      const old = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
      const successor = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
      mkdirSync(s.stateDir, { recursive: true });
      writeFileSync(join(s.stateDir, 'train.pid'), String(old.pid));
      writeFileSync(join(s.stateDir, 'run-info.json'), JSON.stringify({ pid: successor.pid, restartRequests: true }));

      const r = s.cli(['restart']);
      const now = trainPid(s);
      if (now !== null && now !== old.pid) pidsToKill.push(now); // a wrongly started train
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`restart requested: integration train (pid ${successor.pid})`);
      expect(r.stdout).not.toContain('stopped integration train');
      expect(alive(old.pid) && alive(successor.pid)).toBe(true);
      expect(now).toBe(old.pid);
      expect(existsSync(join(s.stateDir, 'restart-request.json'))).toBe(true);
    }, 120_000);

    it('restart keeps an option value that reads --now (#3851)', async () => {
      const s = makeSandbox();
      const args = ['--worktree', s.worktree, '--verify-cmd', '--now', '--interval', '600'];
      const r = s.cli(['restart', ...args]);
      const pid = trainPid(s);
      if (pid !== null) pidsToKill.push(pid);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`integration train started (pid ${pid})`);
      expect(JSON.parse(readFileSync(join(s.stateDir, 'start-args.json'), 'utf8'))).toEqual(args);
      expect(s.cli(['stop']).status).toBe(0);
    }, 120_000);

    it('restart rejects bad options at once instead of filing them for a running train', async () => {
      const s = makeSandbox();
      const old = await startTrain(s, ['--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1']);

      const r = s.cli(['restart', '--bogus']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('unknown option --bogus');
      expect(existsSync(join(s.stateDir, 'restart-request.json'))).toBe(false);
      expect(alive(old)).toBe(true);
      expect(trainPid(s)).toBe(old);
      expect(s.cli(['stop']).status).toBe(0);
    }, 120_000);

    it('stops and starts a train started by code that ignores restart requests', async () => {
      const s = makeSandbox();
      // a run loop of pre-#3841 code in the keyed directory: no run-info.json
      const old = fakeProcess([CLI, 'run', '--worktree', s.worktree]);
      mkdirSync(s.stateDir, { recursive: true });
      writeFileSync(join(s.stateDir, 'train.pid'), String(old.pid));

      const r = s.cli(['restart', '--worktree', s.worktree, '--verify-cmd', VERIFY, '--interval', '1']);
      const next = trainPid(s);
      if (next !== null) pidsToKill.push(next);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`stopped integration train (pid ${old.pid})`);
      expect(r.stdout).not.toContain('restart requested');
      expect(next).not.toBe(old.pid);
      expect(existsSync(join(s.stateDir, 'restart-request.json'))).toBe(false);
      expect(s.cli(['stop']).status).toBe(0);
    }, 120_000);

    it('restart --now stops the train at once, even mid-verify', async () => {
      const s = makeSandbox();
      s.commit('staging', { 'a.txt': '1' }, 'one (#1)');
      const marks = join(s.root, 'verify-marks');
      const old = await startTrain(s, [
        '--worktree', s.worktree, '--interval', '1', '--verify-cmd', `echo start >> '${marks}'; sleep 60`,
      ]);
      expect(await until(() => existsSync(marks), 60_000)).toBe(true);

      const r = s.cli(['restart', '--now']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`stopped integration train (pid ${old})`);
      expect(alive(old)).toBe(false);
      const next = trainPid(s) as number;
      pidsToKill.push(next);
      expect(next).not.toBe(old);
      expect(argsAfterRun(next)).not.toContain('--now');
      expect(s.cli(['stop']).status).toBe(0);
    }, 180_000);
  });

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
