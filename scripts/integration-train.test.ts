import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';
import {
  type ClosingIssue,
  type CycleResult,
  type GitResult,
  type TrainDeps,
  type TrainEventKind,
  type TrainState,
  emptyTrainState,
  parseIntegrationBranch,
  prNumberFromSubject,
  runTrainCycle,
} from './lib/integration-train-core.js';

// Every git call runs against mkdtemp directories with the repo's sanitized env
// (the pre-push hook exports GIT_DIR, which would otherwise point git at the
// real worktree).
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

function gitSoft(cwd: string, args: string[]): GitResult {
  try {
    return { ok: true, stdout: git(cwd, ...args), stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

interface Harness {
  root: string;
  origin: string;
  seed: string;
  train: string;
  state: TrainState;
  greens: string[];
  verifyCalls: string[];
  mainPushes: string[];
  scripted: Map<string, boolean[]>;
  issues: Map<number, ClosingIssue[]>;
  ghLog: string[];
  spawns: Array<{ idempotencyKey: string; prompt: string }>;
  notes: Array<{ kind: TrainEventKind; detail: string }>;
  deps: TrainDeps;
  commit(branch: string, files: Record<string, string>, subject: string): string;
  cycle(): Promise<CycleResult>;
  originRef(branch: string): string;
}

const roots: string[] = [];

function makeHarness(opts: { config?: boolean; integrationBranch?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'integration-train-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const train = join(root, 'train');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '--initial-branch=main');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  if (opts.config !== false) {
    mkdirSync(join(seed, '.kookr'));
    writeFileSync(join(seed, '.kookr/delivery-gate.json'), '{"integrationBranch":"staging","prePushGate":"fast"}\n');
  }
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  if (opts.integrationBranch !== false) {
    git(seed, 'push', '-q', 'origin', 'main:refs/heads/staging');
  }
  git(root, 'clone', '-q', origin, train);

  const h = {
    root, origin, seed, train,
    state: emptyTrainState(),
    greens: [] as string[],
    verifyCalls: [] as string[],
    mainPushes: [] as string[],
    scripted: new Map<string, boolean[]>(),
    issues: new Map<number, ClosingIssue[]>(),
    ghLog: [] as string[],
    spawns: [] as Array<{ idempotencyKey: string; prompt: string }>,
    notes: [] as Array<{ kind: TrainEventKind; detail: string }>,
  } as unknown as Harness;

  h.deps = {
    async git(args) {
      const push = args.find((a) => /:refs\/heads\/main$/.test(a));
      const r = gitSoft(train, args);
      if (args[0] === 'push' && push && r.ok) h.mainPushes.push(push.split(':')[0]);
      return r;
    },
    async verify(sha) {
      h.verifyCalls.push(sha);
      const script = h.scripted.get(sha);
      let ok: boolean;
      if (script && script.length > 0) ok = script.shift() as boolean;
      else ok = !gitSoft(train, ['cat-file', '-e', `${sha}:bad.txt`]).ok;
      if (ok) h.greens.push(sha);
      return { ok, tail: ok ? '' : `FAIL at ${sha.slice(0, 7)}\nAssertionError: bad.txt exists` };
    },
    github: {
      async closingIssues(pr) {
        return (h.issues.get(pr) ?? []).map((i) => ({ ...i }));
      },
      async reopenIssue(n) {
        h.ghLog.push(`reopen ${n}`);
        for (const list of h.issues.values()) for (const i of list) if (i.number === n) i.state = 'open';
      },
      async closeIssue(n, comment) {
        h.ghLog.push(`close ${n}: ${comment}`);
        for (const list of h.issues.values()) for (const i of list) if (i.number === n) i.state = 'closed';
      },
      async commentIssue(n, body) {
        h.ghLog.push(`comment ${n}: ${body}`);
      },
    },
    spawner: { async spawn(req) { h.spawns.push(req); } },
    notifier: { async notify(kind, detail) { h.notes.push({ kind, detail }); } },
    state: { load: () => h.state, save: (s) => { h.state = s; } },
    log: () => {},
    now: () => new Date('2026-01-01T00:00:00Z'),
  };

  h.commit = (branch, files, subject) => {
    git(seed, 'fetch', '-q', 'origin');
    git(seed, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    for (const [name, content] of Object.entries(files)) {
      if (content === '') git(seed, 'rm', '-q', '-f', name);
      else writeFileSync(join(seed, name), content);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', subject);
    git(seed, 'push', '-q', 'origin', branch);
    return git(seed, 'rev-parse', 'HEAD');
  };
  h.cycle = () => runTrainCycle(h.deps);
  h.originRef = (branch) => git(origin, 'rev-parse', `refs/heads/${branch}`);
  return h;
}

let h: Harness;

afterEach(() => {
  // Invariant for every scenario: main only ever received SHAs the fake verify saw green.
  if (h) for (const sha of h.mainPushes) expect(h.greens).toContain(sha);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('helpers', () => {
  it('parses PR numbers and branch names', () => {
    expect(prNumberFromSubject('fix thing (#123)')).toBe(123);
    expect(prNumberFromSubject('fix thing')).toBeNull();
    expect(parseIntegrationBranch('{"integrationBranch":"staging"}')).toBe('staging');
    expect(parseIntegrationBranch('{"integrationBranch":"--evil"}')).toBeNull();
    expect(parseIntegrationBranch('not json')).toBeNull();
  });
});

describe('integration train cycle', () => {
  beforeEach(() => { h = undefined as unknown as Harness; });

  it('is not-configured without a config file, or without the integration branch', async () => {
    h = makeHarness({ config: false });
    expect((await h.cycle()).outcome).toBe('not-configured');
    h = makeHarness({ integrationBranch: false });
    expect((await h.cycle()).outcome).toBe('not-configured');
    expect(h.mainPushes).toEqual([]);
  });

  it('is idle when main and the integration branch agree', async () => {
    h = makeHarness();
    expect((await h.cycle()).outcome).toBe('idle');
    expect(h.verifyCalls).toEqual([]);
  });

  it('fast-forwards main to exactly the verified green head', async () => {
    h = makeHarness();
    h.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    const head = h.commit('staging', { 'b.txt': '2' }, 'two (#2)');
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.originRef('main')).toBe(head);
    expect(h.mainPushes).toEqual([head]);
  });

  it('promotes a flaky head after one red run and records it', async () => {
    h = makeHarness();
    const head = h.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    h.scripted.set(head, [false, true]);
    const r = await h.cycle();
    expect(r.outcome).toBe('promoted');
    expect(h.originRef('main')).toBe(head);
    expect(h.state.flakyHeads).toEqual([head]);
    expect(h.spawns).toEqual([]);
    expect(h.originRef('staging')).toBe(head);
  });

  it('halts when main itself is red, reverts nothing, and stays halted until a ref moves', async () => {
    h = makeHarness();
    h.commit('main', { 'bad.txt': 'x' }, 'broken main');
    git(h.seed, 'fetch', '-q', 'origin');
    git(h.seed, 'checkout', '-q', '-B', 'staging', 'origin/staging');
    git(h.seed, 'merge', '-q', '--no-edit', 'origin/main');
    git(h.seed, 'push', '-q', 'origin', 'staging');
    const head = h.commit('staging', { 'c.txt': '1' }, 'change (#5)');
    const stagingBefore = h.originRef('staging');
    const mainBefore = h.originRef('main');

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'base-red' });
    expect(h.originRef('staging')).toBe(stagingBefore);
    expect(h.originRef('main')).toBe(mainBefore);
    expect(h.mainPushes).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);

    const calls = h.verifyCalls.length;
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'base-red' });
    expect(h.verifyCalls.length).toBe(calls);

    h.commit('staging', { 'd.txt': '1' }, 'another (#6)');
    await h.cycle();
    expect(h.verifyCalls.length).toBeGreaterThan(calls);
    expect(head).not.toBe(h.originRef('staging'));
  });

  it('promotes the commit before the culprit, reverts the culprit, reopens the issue, spawns one fix task', async () => {
    h = makeHarness();
    h.issues.set(13, [{ number: 130, state: 'closed' }]);
    h.issues.set(12, [{ number: 120, state: 'open' }]);
    h.commit('staging', { '1.txt': '1' }, 'one (#11)');
    const c2 = h.commit('staging', { '2.txt': '2' }, 'two (#12)');
    const c3 = h.commit('staging', { 'bad.txt': 'x' }, 'three (#13)');
    h.commit('staging', { '4.txt': '4' }, 'four (#14)');
    h.commit('staging', { '5.txt': '5' }, 'five (#15)');

    const r = await h.cycle();
    expect(r.outcome).toBe('reverted');
    expect(h.originRef('main')).toBe(c2);
    expect(h.mainPushes).toEqual([c2]);
    // promotion of c2 closed the open issue of PR #12
    expect(h.ghLog.some((l) => l.startsWith('close 120: Verified on main in '))).toBe(true);

    const stagingHead = h.originRef('staging');
    expect(git(h.origin, 'log', '-1', '--format=%s', stagingHead)).toContain('Revert');
    expect(git(h.origin, 'show', `${stagingHead}:4.txt`)).toBe('4');
    expect(gitSoft(h.origin, ['cat-file', '-e', `${stagingHead}:bad.txt`]).ok).toBe(false);

    expect(h.ghLog).toContain('reopen 130');
    const comment = h.ghLog.find((l) => l.startsWith('comment 130:')) ?? '';
    expect(comment).toContain(c3);
    expect(comment).toContain(stagingHead);
    expect(comment).toContain('AssertionError');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].idempotencyKey).toBe('train-fix-13-1');
    expect(h.spawns[0].prompt).toContain('origin/main');
    expect(h.spawns[0].prompt).toContain(`git cherry-pick ${c3}`);
    expect(h.state.fixTasks['13']).toBe(1);
    expect(h.notes.map((n) => n.kind)).toContain('reverted');

    // next cycle: the reverted head is green and gets promoted
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.originRef('main')).toBe(stagingHead);
    // the reverted PR reaches main together with its revert: its reopened issue
    // must stay open, while the PRs after it are closed as usual
    expect(h.ghLog.some((l) => l.startsWith('close 130:'))).toBe(false);
    expect(h.issues.get(13)?.[0].state).toBe('open');
  });

  it('reverts nothing when the bisected culprit passes on a confirming re-run', async () => {
    h = makeHarness();
    h.commit('staging', { '1.txt': '1' }, 'one (#61)');
    const c2 = h.commit('staging', { '2.txt': '2' }, 'two (#62)');
    const head = h.commit('staging', { '3.txt': '3' }, 'three (#63)');
    h.scripted.set(head, [false, false]); // red twice: looks like a real failure
    h.scripted.set(c2, [false, true]); // red in the bisect, green on the confirming run

    const r = await h.cycle();
    expect(r.outcome).toBe('retry');
    expect(h.originRef('staging')).toBe(head);
    expect(h.spawns).toHaveLength(0);
    expect(h.ghLog).toEqual([]);
    expect(h.notes.map((n) => n.kind)).not.toContain('reverted');
  });

  it('re-verifies main on a red head even when the train verified that SHA before', async () => {
    h = makeHarness();
    const first = h.commit('staging', { 'a.txt': '1' }, 'one (#71)');
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.state.verifiedGreen).toContain(first);

    // the environment breaks: every commit now fails, including the promoted main
    const head = h.commit('staging', { 'b.txt': '2' }, 'two (#72)');
    h.scripted.set(head, [false, false]);
    h.scripted.set(first, [false]);
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'base-red' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.originRef('main')).toBe(first);
    expect(h.spawns).toHaveLength(0);
  });

  it('does not spawn a second fix task for the same PR and notifies fix-budget-exhausted', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#13)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect((await h.cycle()).outcome).toBe('promoted');
    h.commit('staging', { 'bad.txt': 'y' }, 'broken again (#13)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns).toHaveLength(1);
    expect(h.notes.map((n) => n.kind)).toContain('fix-budget-exhausted');
  });

  it('halts on a revert conflict and leaves the integration branch unchanged', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#21)');
    const head = h.commit('staging', { 'bad.txt': 'y' }, 'builds on culprit (#22)');
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'revert-conflict' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.spawns).toEqual([]);
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
  });

  it('reconciles a commit that went straight to main by merging it into the integration branch', async () => {
    h = makeHarness();
    h.commit('staging', { 's.txt': 's' }, 'staging work (#31)');
    const mainCommit = h.commit('main', { 'm.txt': 'm' }, 'hotfix on main');
    const r = await h.cycle();
    expect(r.outcome).toBe('reconciled');
    const staging = h.originRef('staging');
    expect(gitSoft(h.origin, ['merge-base', '--is-ancestor', mainCommit, staging]).ok).toBe(true);
    expect(h.mainPushes).toEqual([]);
    // next cycle verifies and promotes the merged head
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.originRef('main')).toBe(staging);
  });

  it('halts when reconciling main into the integration branch conflicts', async () => {
    h = makeHarness();
    h.commit('main', { 'README.md': 'main side\n' }, 'main edit');
    const head = h.commit('staging', { 'README.md': 'staging side\n' }, 'staging edit (#41)');
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'reconcile-conflict' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
  });

  it('closes the open closing-issues of promoted PR commits and leaves closed ones alone', async () => {
    h = makeHarness();
    h.issues.set(51, [{ number: 510, state: 'open' }, { number: 511, state: 'closed' }]);
    h.issues.set(52, [{ number: 520, state: 'open' }]);
    h.commit('staging', { 'a.txt': '1' }, 'first (#51)');
    const head = h.commit('staging', { 'b.txt': '2' }, 'second (#52)');
    expect((await h.cycle()).outcome).toBe('promoted');
    const short = head.slice(0, 10);
    expect(h.ghLog).toContain(`close 510: Verified on main in ${short}.`);
    expect(h.ghLog).toContain(`close 520: Verified on main in ${short}.`);
    expect(h.ghLog.some((l) => l.startsWith('close 511'))).toBe(false);
    expect(h.state.verifiedGreen).toContain(head);
  });
});
