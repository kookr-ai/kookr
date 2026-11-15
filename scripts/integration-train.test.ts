import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';
import { CLOSING_KEYWORD_CASES } from './closing-keyword-cases.js';
import { vitestMaxWorkers } from './lib/vitest-max-workers.mjs';
import {
  type ClosingIssue,
  type CycleResult,
  type GitResult,
  type TrainDeps,
  type TrainEventKind,
  type TrainState,
  closingIssueNumbersFromText,
  emptyTrainState,
  isOutdatedLockfileFailure,
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
  /** SHAs whose verify cannot run at all (checkout or install failure). */
  infra: Set<string>;
  /** When set, the next push to main is rejected (someone else moved main). */
  rejectMainPush: boolean;
  /** Every push to these branches is rejected until the set is cleared. */
  rejectPushesTo: Set<string>;
  issues: Map<number, ClosingIssue[]>;
  ghLog: string[];
  spawns: Array<{ idempotencyKey: string; prompt: string }>;
  notes: Array<{ kind: TrainEventKind; detail: string }>;
  healthyCalls: number;
  deps: TrainDeps;
  commit(branch: string, files: Record<string, string>, subject: string): string;
  cycle(): Promise<CycleResult>;
  originRef(branch: string): string;
}

const roots: string[] = [];

function makeHarness(opts: { config?: boolean; integrationBranch?: boolean; seedVerified?: boolean } = {}): Harness {
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
    infra: new Set<string>(),
    rejectMainPush: false,
    rejectPushesTo: new Set<string>(),
    issues: new Map<number, ClosingIssue[]>(),
    ghLog: [] as string[],
    spawns: [] as Array<{ idempotencyKey: string; prompt: string }>,
    notes: [] as Array<{ kind: TrainEventKind; detail: string }>,
    healthyCalls: 0,
  } as unknown as Harness;

  h.deps = {
    async git(args) {
      const push = args.find((a) => /:refs\/heads\/main$/.test(a));
      const target = args[0] === 'push' ? /:refs\/heads\/(.+)$/.exec(args[args.length - 1])?.[1] : undefined;
      if (target !== undefined && h.rejectPushesTo.has(target)) {
        return { ok: false, stdout: '', stderr: `! [remote rejected] ${target} (protected branch hook declined)` };
      }
      if (args[0] === 'push' && push && h.rejectMainPush) {
        h.rejectMainPush = false;
        return { ok: false, stdout: '', stderr: '! [rejected] (fetch first)' };
      }
      const r = gitSoft(train, args);
      if (args[0] === 'push' && push && r.ok) h.mainPushes.push(push.split(':')[0]);
      return r;
    },
    async verify(sha) {
      h.verifyCalls.push(sha);
      const script = h.scripted.get(sha);
      let ok: boolean;
      if (script && script.length > 0) ok = script.shift() as boolean;
      else {
        ok = !gitSoft(train, ['cat-file', '-e', `${sha}:bad.txt`]).ok &&
          !gitSoft(train, ['cat-file', '-e', `${sha}:bad2.txt`]).ok;
      }
      if (h.infra.has(sha)) return { ok: false, infra: true, tail: 'pnpm install failed: registry unreachable' };
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
    notifier: {
      async notify(kind, detail) { h.notes.push({ kind, detail }); },
      async healthy() { h.healthyCalls++; },
    },
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
  // The base commit stands for a main the train already verified, as it is in
  // steady state. `seedVerified: false` is a train with no history yet.
  if (opts.seedVerified !== false) h.state.verifiedGreen.push(h.originRef('main'));
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

  it('reads closing keywords from a pull request body', () => {
    expect(closingIssueNumbersFromText('close #4\nfix #5\nresolve #6\nresolved #7\nfixes #8\nclosed #9')).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it.each(CLOSING_KEYWORD_CASES)('closing keywords: $name', ({ body, closes }) => {
    expect(closingIssueNumbersFromText(body)).toEqual(closes);
  });

  it('accepts only a positive integer as the vitest worker cap, else 4', () => {
    expect(vitestMaxWorkers('12')).toBe(12);
    expect(vitestMaxWorkers(' 7 ')).toBe(7);
    for (const bad of [undefined, '', '0', '-2', '2.5', '1e3', '0x10', 'four', '+3', '99999999999999999999']) {
      expect(vitestMaxWorkers(bad), String(bad)).toBe(4);
    }
  });

  it('recognises an outdated-lockfile install failure only', () => {
    expect(isOutdatedLockfileFailure('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"')).toBe(true);
    expect(isOutdatedLockfileFailure('ERR_PNPM_FETCH_404 registry unreachable')).toBe(false);
    expect(isOutdatedLockfileFailure('')).toBe(false);
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
    // Verified green earlier and red now: the environment changed, not the commit.
    h.state.verifiedGreen.push(h.commit('main', { 'bad.txt': 'x' }, 'broken main'));
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
    // one cycle: the last good commit, then the verified revert
    const stagingHead = h.originRef('staging');
    expect(h.originRef('main')).toBe(stagingHead);
    expect(h.mainPushes).toEqual([c2, stagingHead]);
    // promotion of c2 closed the open issue of PR #12
    expect(h.ghLog.some((l) => l.startsWith('close 120: Verified on main in '))).toBe(true);

    expect(git(h.origin, 'log', '-1', '--format=%s', stagingHead)).toContain('Revert');
    expect(git(h.origin, 'show', `${stagingHead}:4.txt`)).toBe('4');
    expect(gitSoft(h.origin, ['cat-file', '-e', `${stagingHead}:bad.txt`]).ok).toBe(false);

    expect(h.ghLog).toContain('reopen 130');
    const comment = h.ghLog.find((l) => l.startsWith('comment 130:')) ?? '';
    expect(comment).toContain(c3);
    expect(comment).toContain(stagingHead);
    expect(comment).toContain('AssertionError');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].idempotencyKey).toBe('train-fix-issue-130-1');
    expect(h.spawns[0].prompt).toContain('Closes #130');
    expect(h.spawns[0].prompt).toContain('origin/main');
    expect(h.spawns[0].prompt).toContain(`git cherry-pick ${c3}`);
    expect(h.state.fixTasks['issue-130']).toBe(1);
    expect(h.notes.map((n) => n.kind)).toContain('reverted');

    // the reverted PR reaches main together with its revert: its reopened issue
    // must stay open, while the PRs after it are closed as usual
    expect(h.ghLog.some((l) => l.startsWith('close 130:'))).toBe(false);
    expect(h.issues.get(13)?.[0].state).toBe('open');
    expect((await h.cycle()).outcome).toBe('idle');
  });

  it('halts revert-not-sufficient when the culprit was fixed forward and the head is red for another reason', async () => {
    h = makeHarness();
    // X is red at its own commit, F fixes it forward, H is red for a different reason.
    h.commit('staging', { 'bad.txt': 'x' }, 'x (#201)');
    h.commit('staging', { 'bad.txt': '' }, 'fix forward (#202)');
    const head = h.commit('staging', { 'bad2.txt': 'y' }, 'h (#203)');
    h.issues.set(201, [{ number: 2010, state: 'closed' }]);

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'revert-not-sufficient' });
    expect(r.detail).toContain('(x (#201))');
    expect(h.originRef('staging')).toBe(head);
    expect(h.originRef('main')).toBe(git(h.seed, 'rev-parse', 'origin/main'));
    expect(h.mainPushes).toEqual([]);
    expect(h.ghLog).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
    expect(git(h.train, 'rev-parse', 'HEAD')).toBe(head); // the local revert was discarded
    expect(h.healthyCalls).toBe(0);
  });

  it('halts train-error, pushing nothing, when the revert commit cannot be created', async () => {
    h = makeHarness();
    const head = h.commit('staging', { 'bad.txt': 'x' }, 'bad (#301)');
    const realGit = h.deps.git;
    h.deps.git = async (args) => (args[0] === 'commit'
      ? { ok: false, stdout: '', stderr: 'Author identity unknown' }
      : realGit(args));

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'train-error' });
    expect(r.detail).toContain('Author identity unknown');
    expect(h.originRef('staging')).toBe(head);
    expect(h.mainPushes).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(h.ghLog).toEqual([]);
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
  });

  it('does not consume the fix budget when the spawn fails, and notifies fix-spawn-failed', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#401)');
    h.deps.spawner = { async spawn() { throw new Error('kookr spawn failed'); } };
    const r = await h.cycle();
    expect(r.outcome).toBe('reverted');
    expect(h.state.fixTasks).toEqual({});
    const failed = h.notes.find((n) => n.kind === 'fix-spawn-failed');
    expect(failed?.detail).toContain('PR #401');
    expect(failed?.detail).toContain('train-fix-ref-401-1');

    // the budget is intact: the same PR failing again gets its task
    h.deps.spawner = { async spawn(req) { h.spawns.push(req); } };
    h.commit('staging', { 'bad.txt': 'y' }, 'broken again (#401)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns.map((s) => s.idempotencyKey)).toEqual(['train-fix-ref-401-1']);
    expect(h.state.fixTasks['ref-401']).toBe(1);
  });

  it('reports recovery once, on the first healthy cycle after an alert, never on a plain idle cycle', async () => {
    h = makeHarness();
    expect((await h.cycle()).outcome).toBe('idle');
    h.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    expect((await h.cycle()).outcome).toBe('promoted');
    h.commit('main', { 'm.txt': 'm' }, 'hotfix on main');
    expect((await h.cycle()).outcome).toBe('reconciled');
    expect(h.healthyCalls).toBe(0); // nothing was ever wrong

    h.commit('staging', { 'bad.txt': 'x' }, 'bad (#2)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.healthyCalls).toBe(0);
    expect(h.state.alerting).toBe(true);
    expect((await h.cycle()).outcome).toBe('idle');
    expect(h.healthyCalls).toBe(1);
    expect((await h.cycle()).outcome).toBe('idle');
    expect(h.healthyCalls).toBe(1); // once, not on every idle cycle
  });

  it('tries the recovery report again when it failed', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'bad (#2)');
    expect((await h.cycle()).outcome).toBe('reverted');
    h.deps.notifier.healthy = async () => { throw new Error('outbox not writable'); };
    expect((await h.cycle()).outcome).toBe('idle');
    expect(h.state.alerting).toBe(true);
    h.deps.notifier.healthy = async () => { h.healthyCalls++; };
    expect((await h.cycle()).outcome).toBe('idle');
    expect(h.healthyCalls).toBe(1);
    expect(h.state.alerting).toBe(false);
  });

  it('reports no recovery while halted, nor when a moved ref only leads to another halt', async () => {
    h = makeHarness();
    // Verified green earlier and red now: the environment changed, not the commit.
    h.state.verifiedGreen.push(h.commit('main', { 'bad.txt': 'x' }, 'broken main'));
    git(h.seed, 'fetch', '-q', 'origin');
    git(h.seed, 'checkout', '-q', '-B', 'staging', 'origin/staging');
    git(h.seed, 'merge', '-q', '--no-edit', 'origin/main');
    git(h.seed, 'push', '-q', 'origin', 'staging');
    h.commit('staging', { 'c.txt': '1' }, 'change (#5)');
    expect((await h.cycle()).outcome).toBe('halted');
    expect((await h.cycle()).outcome).toBe('halted'); // standing halt
    h.commit('staging', { 'd.txt': '1' }, 'another (#6)'); // the ref moves, main is still red
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'base-red' });
    expect(h.healthyCalls).toBe(0);
    expect(h.notes.map((n) => n.kind)).toEqual(['halted', 'halted']);
  });

  it('notifies every event of one cycle with its own detail', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#401)');
    h.deps.spawner = { async spawn() { throw new Error('kookr spawn failed'); } };
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.notes.map((n) => n.kind)).toEqual(['fix-spawn-failed', 'reverted']);
    expect(h.notes[0].detail).toContain('could not be spawned');
    expect(h.notes[1].detail).toContain('reverted ');
  });

  it('halts push-rejected after a push to main is rejected three cycles in a row', async () => {
    h = makeHarness();
    const base = h.originRef('main');
    h.commit('staging', { 'a.txt': '1' }, 'one (#111)');
    h.rejectPushesTo.add('main');
    expect((await h.cycle()).outcome).toBe('retry');
    expect((await h.cycle()).outcome).toBe('retry');
    expect(h.notes).toEqual([]);
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'push-rejected' });
    expect(r.detail).toContain('protected branch hook declined');
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
    expect(h.originRef('main')).toBe(base);
    // a standing halt: no more verifies, no more notifications
    const calls = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('halted');
    expect(h.verifyCalls.length).toBe(calls);
    expect(h.notes).toHaveLength(1);
  });

  it('does not halt when a push goes through after two rejections, and starts counting again', async () => {
    h = makeHarness();
    h.commit('staging', { 'a.txt': '1' }, 'one (#111)');
    h.rejectPushesTo.add('main');
    expect((await h.cycle()).outcome).toBe('retry');
    expect((await h.cycle()).outcome).toBe('retry');
    h.rejectPushesTo.clear();
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.state.pushRejections).toBe(0);
    h.commit('staging', { 'b.txt': '2' }, 'two (#112)');
    h.rejectPushesTo.add('main');
    expect((await h.cycle()).outcome).toBe('retry');
    expect((await h.cycle()).outcome).toBe('retry');
    expect(h.notes).toEqual([]);
  });

  it('halts push-rejected after a push to the integration branch is rejected three cycles in a row', async () => {
    h = makeHarness();
    h.commit('staging', { 's.txt': 's' }, 'staging work (#31)');
    h.commit('main', { 'm.txt': 'm' }, 'hotfix on main');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    expect((await h.cycle()).outcome).toBe('retry');
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'push-rejected' });
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
  });

  it('halts train-error once, not every interval, when the refs cannot be resolved', async () => {
    h = makeHarness();
    h.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    const realGit = h.deps.git;
    h.deps.git = async (args) => (args[0] === 'rev-parse'
      ? { ok: false, stdout: '', stderr: 'fatal: bad object' }
      : realGit(args));
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'train-error' });
    expect(r.detail).toContain('fatal: bad object');
    expect((await h.cycle()).outcome).toBe('halted');
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
    expect(h.verifyCalls).toEqual([]);
    // once git works again the halt (recorded with no refs) clears by itself
    h.deps.git = realGit;
    expect((await h.cycle()).outcome).toBe('promoted');
  });

  it('halts train-error when listing the candidate commits fails', async () => {
    h = makeHarness();
    h.commit('staging', { 'a.txt': '1' }, 'one (#1)');
    const realGit = h.deps.git;
    h.deps.git = async (args) => (args[0] === 'rev-list'
      ? { ok: false, stdout: '', stderr: 'fatal: corrupt pack' }
      : realGit(args));
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'train-error' });
    expect((await h.cycle()).outcome).toBe('halted');
    expect(h.notes.map((n) => n.kind)).toEqual(['halted']);
    expect(h.mainPushes).toEqual([]);
  });

  it('halts train-error, not reconcile-conflict, when the reconcile checkout or merge fails for another reason', async () => {
    h = makeHarness();
    h.commit('staging', { 's.txt': 's' }, 'staging work (#31)');
    h.commit('main', { 'm.txt': 'm' }, 'hotfix on main');
    const realGit = h.deps.git;
    h.deps.git = async (args) => (args[0] === 'checkout'
      ? { ok: false, stdout: '', stderr: 'fatal: unable to write index' }
      : realGit(args));
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'train-error' });
    expect(r.detail).toContain('unable to write index');

    h = makeHarness();
    const stagingHead = h.commit('staging', { 's.txt': 's' }, 'staging work (#31)');
    h.commit('main', { 'm.txt': 'm' }, 'hotfix on main');
    const realGit2 = h.deps.git;
    h.deps.git = async (args) => (args[0] === 'merge' && args[1] === '--no-edit'
      ? { ok: false, stdout: '', stderr: 'Committer identity unknown' }
      : realGit2(args));
    const r2 = await h.cycle();
    expect(r2).toMatchObject({ outcome: 'halted', reason: 'train-error' });
    expect(r2.detail).toContain('Committer identity unknown');
    expect(h.originRef('staging')).toBe(stagingHead);
  });

  it('never verifies or pushes a revert that changes nothing', async () => {
    h = makeHarness();
    // X adds bad.txt, F removes it again, H is harmless but red twice (scripted).
    // Reverting X at H changes nothing. Any commit the train creates would
    // verify green here, so only the empty-revert guard keeps it from pushing.
    h.commit('staging', { 'bad.txt': 'x' }, 'x (#201)');
    h.commit('staging', { 'bad.txt': '' }, 'fix forward (#202)');
    const head = h.commit('staging', { 'h.txt': '1' }, 'h (#203)');
    h.scripted.set(head, [false, false]);
    const known = new Set(git(h.seed, 'rev-list', 'origin/staging').split('\n'));
    const realVerify = h.deps.verify;
    h.deps.verify = async (sha) => {
      if (!known.has(sha)) {
        h.verifyCalls.push(sha);
        h.greens.push(sha);
        return { ok: true, tail: '' };
      }
      return realVerify(sha);
    };

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'revert-not-sufficient' });
    expect(r.detail).toContain('changes nothing');
    expect(h.verifyCalls.filter((sha) => !known.has(sha))).toEqual([]);
    expect(h.originRef('staging')).toBe(head);
    expect(h.mainPushes).toEqual([]);
    expect(h.ghLog).toEqual([]);
    expect(h.spawns).toEqual([]);
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

  it('halts instead of blaming a commit that predates a merge of main', async () => {
    h = makeHarness();
    // An innocent change and a bad one land on staging, then a hotfix goes
    // straight to main. Commits older than the reconcile merge do not contain
    // main, so "main is green" proves nothing about them.
    const innocent = h.commit('staging', { 'i.txt': '1' }, 'innocent (#91)');
    h.commit('staging', { 'bad.txt': 'x' }, 'bad (#92)');
    h.commit('main', { 'hotfix.txt': 'h' }, 'hotfix on main');
    expect((await h.cycle()).outcome).toBe('reconciled');
    const merged = h.originRef('staging');

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'culprit-is-merge' });
    expect(h.originRef('staging')).toBe(merged);
    expect(h.spawns).toHaveLength(0);
    expect(h.ghLog).toEqual([]);
    expect(h.verifyCalls).not.toContain(innocent); // never tested, so never blamed
    expect(h.notes.map((n) => n.kind)).toEqual(['main-bypassed', 'halted']);
  });

  it('halts revert-not-sufficient, pushing nothing, when a second failing change is in the batch', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'first bad (#81)');
    const head = h.commit('staging', { 'bad2.txt': 'x' }, 'second bad (#82)');

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'revert-not-sufficient' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.mainPushes).toEqual([]);
    expect(h.spawns).toHaveLength(0);
    expect(h.ghLog).toEqual([]);
  });

  it('halts multiple-failures when an earlier unpromoted revert now fails verify', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'first bad (#81)');
    h.rejectMainPush = true; // the revert is pushed to staging but not promoted
    expect((await h.cycle()).outcome).toBe('reverted');
    const revert = h.originRef('staging');
    const base = h.originRef('main');
    expect(base).not.toBe(revert);

    h.commit('staging', { 'bad2.txt': 'x' }, 'later bad (#82)');
    h.scripted.set(revert, [false]);
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'multiple-failures' });
    expect(h.originRef('main')).toBe(base);
  });

  it('bisects only after an unpromoted revert, so the reverted commit is not blamed again', async () => {
    h = makeHarness();
    const first = h.commit('staging', { 'bad.txt': 'x' }, 'first bad (#81)');
    h.rejectMainPush = true; // the first revert is pushed to staging but not promoted
    expect((await h.cycle()).outcome).toBe('reverted');
    const revertOfFirst = h.originRef('staging');
    expect(h.originRef('main')).not.toBe(revertOfFirst);
    // a new failing change merges before the revert was promoted
    const second = h.commit('staging', { 'bad2.txt': 'x' }, 'later bad (#83)');

    expect((await h.cycle()).outcome).toBe('reverted');
    const head = h.originRef('staging');
    expect(h.mainPushes).toEqual([revertOfFirst, head]); // the green revert was promoted on the way, then the new one
    expect(h.originRef('main')).toBe(head);
    expect(git(h.origin, 'log', '-1', '--format=%B', head)).toContain(`This reverts commit ${second}`);
    expect(git(h.origin, 'log', '--format=%B', `${revertOfFirst}..${head}`)).not.toContain(first);
    expect((await h.cycle()).outcome).toBe('idle');
  });

  it('halts without reverting when verify cannot run (install or checkout failure)', async () => {
    h = makeHarness();
    const first = h.commit('staging', { 'a.txt': '1' }, 'one (#101)');
    expect((await h.cycle()).outcome).toBe('promoted');
    const head = h.commit('staging', { 'pnpm-lock.yaml': 'new deps' }, 'bump (#102)');
    h.infra.add(head);

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'verify-infra' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.originRef('main')).toBe(first);
    expect(h.spawns).toHaveLength(0);
  });

  it('reports retry, not promoted, when the promotion push is rejected', async () => {
    h = makeHarness();
    const base = h.originRef('main');
    h.commit('staging', { 'a.txt': '1' }, 'one (#111)');
    h.rejectMainPush = true;
    expect((await h.cycle()).outcome).toBe('retry');
    expect(h.originRef('main')).toBe(base);
    expect(h.ghLog).toEqual([]); // no issue is closed for a promotion that did not happen
    expect((await h.cycle()).outcome).toBe('promoted');
  });

  it('counts the fix budget per issue, so a re-land under a new PR number does not get a second task', async () => {
    h = makeHarness();
    h.issues.set(13, [{ number: 130, state: 'open' }]);
    h.issues.set(14, [{ number: 130, state: 'open' }]);
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#13)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect((await h.cycle()).outcome).toBe('idle');
    h.commit('staging', { 'bad.txt': 'y' }, 're-land, still broken (#14)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns.map((s) => s.idempotencyKey)).toEqual(['train-fix-issue-130-1']);
    expect(h.notes.map((n) => n.kind)).toContain('fix-budget-exhausted');
  });

  it('halts on a red head when the integration branch is not a first-parent line from main', async () => {
    h = makeHarness();
    // A hotfix lands on main; a branch cut from it is merged into staging with a
    // real merge commit (by hand or the GitHub UI), not a squash. main is then
    // reachable from the head only through the second parent.
    h.commit('main', { 'hotfix.txt': 'h' }, 'hotfix on main');
    git(h.seed, 'fetch', '-q', 'origin');
    git(h.seed, 'checkout', '-q', '-B', 'feature', 'origin/main');
    writeFileSync(join(h.seed, 'bad.txt'), 'x');
    git(h.seed, 'add', '-A');
    git(h.seed, 'commit', '-q', '-m', 'feature work');
    git(h.seed, 'checkout', '-q', '-B', 'staging', 'origin/staging');
    git(h.seed, 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    git(h.seed, 'push', '-q', 'origin', 'staging');
    const head = h.originRef('staging');

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'history-shape' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.spawns).toHaveLength(0);
  });

  it('does not mistake a person\'s revert of an unrelated change for its own', async () => {
    h = makeHarness();
    const bad = h.commit('staging', { 'bad.txt': 'x' }, 'bad (#7)');
    const good = h.commit('staging', { 'g.txt': '1' }, 'good (#8)');
    git(h.seed, 'revert', '--no-edit', good); // a human changes their mind about #8
    git(h.seed, 'push', '-q', 'origin', 'staging');
    h.commit('staging', { 'n.txt': '1' }, 'next (#9)');

    expect((await h.cycle()).outcome).toBe('reverted');
    const head = h.originRef('staging');
    const message = git(h.origin, 'log', '-1', '--format=%B', head);
    expect(message).toContain(`This reverts commit ${bad}`);
    expect(message).toContain('Kookr-Integration-Train: revert');
    expect(h.originRef('main')).toBe(head);
    expect((await h.cycle()).outcome).toBe('idle');
  });

  it('does not spawn a second fix task for the same PR and notifies fix-budget-exhausted', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#13)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect((await h.cycle()).outcome).toBe('idle');
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
  describe('commits that reach main without the train (#3803)', () => {
    it('notices a direct merge, then verifies main once even though the integration branch equals it', async () => {
      h = makeHarness();
      // The #3802 shape: a squash-merge straight into main while staging is behind.
      const direct = h.commit('main', { 'flip.txt': '1' }, 'feat: the flip (#3802)');
      expect((await h.cycle()).outcome).toBe('reconciled');
      expect(h.originRef('staging')).toBe(direct);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].kind).toBe('main-bypassed');
      expect(h.notes[0].detail).toContain('feat: the flip (#3802)');
      expect(h.state.alerting).toBe(false); // a notice, so no "recovered" follows

      const r = await h.cycle();
      expect(r.outcome).toBe('idle');
      expect(h.verifyCalls).toEqual([direct]);
      expect(h.state.verifiedGreen).toContain(direct);
      expect(h.mainPushes).toEqual([]);

      expect((await h.cycle()).outcome).toBe('idle');
      expect(h.verifyCalls).toEqual([direct]); // verified once, not every cycle
      expect(h.healthyCalls).toBe(0);
    });

    it('halts main-unverified-red on a red direct merge, names it, and recovers through a fix on the integration branch', async () => {
      h = makeHarness();
      const ok = h.commit('main', { 'ok.txt': '1' }, 'fine direct merge (#70)');
      const bad = h.commit('main', { 'bad.txt': 'x' }, 'broken direct merge (#71)');
      expect((await h.cycle()).outcome).toBe('reconciled');
      expect(h.notes[0].detail).toContain('broken direct merge (#71)');
      expect(h.notes[0].detail).toContain('fine direct merge (#70)');

      const r = await h.cycle();
      expect(r).toMatchObject({ outcome: 'halted', reason: 'main-unverified-red' });
      expect(r.detail).toContain('broken direct merge (#71)');
      expect(r.detail).toContain('fine direct merge (#70)');
      expect(r.detail).not.toContain('base');
      expect(h.notes.map((n) => n.kind)).toEqual(['main-bypassed', 'halted']);
      expect(h.originRef('main')).toBe(bad);
      expect(h.state.verifiedGreen).not.toContain(bad);
      expect(h.state.verifiedGreen).not.toContain(ok);

      const calls = h.verifyCalls.length;
      expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'main-unverified-red' });
      expect(h.verifyCalls.length).toBe(calls); // a standing halt stays quiet
      expect(h.notes).toHaveLength(2);

      const fix = h.commit('staging', { 'bad.txt': '' }, 'fix: repair main (#72)');
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.originRef('main')).toBe(fix);
      expect(h.healthyCalls).toBe(1);
    });

    it('halts main-unverified-red, not base-red, when a red head sits on a red main that skipped the train', async () => {
      h = makeHarness();
      h.commit('staging', { 's.txt': 's' }, 'staging work (#80)');
      h.commit('main', { 'bad.txt': 'x' }, 'broken direct merge (#81)');
      expect((await h.cycle()).outcome).toBe('reconciled');
      const r = await h.cycle();
      expect(r).toMatchObject({ outcome: 'halted', reason: 'main-unverified-red' });
      expect(r.detail).toContain('broken direct merge (#81)');
      expect(h.mainPushes).toEqual([]);
      expect(h.spawns).toEqual([]);
    });

    it('verifies main on the first cycle of a train with no history', async () => {
      h = makeHarness({ seedVerified: false });
      const main = h.originRef('main');
      expect((await h.cycle()).outcome).toBe('idle');
      expect(h.verifyCalls).toEqual([main]);
      expect(h.state.verifiedGreen).toEqual([main]);
      expect(h.notes).toEqual([]);
    });

    it('halts verify-infra, not main-unverified-red, when the suite cannot run on an unverified main', async () => {
      h = makeHarness({ seedVerified: false });
      h.infra.add(h.originRef('main'));
      expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'verify-infra' });
    });
  });
});
