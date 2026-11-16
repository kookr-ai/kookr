import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  MAX_AUTOMATIC_RELANDS,
  nextPluginVersion,
  parseIntegrationBranch,
  parseSpawnOutput,
  normalizeTrainState,
  PLUGIN_JSON_PATH,
  pluginVersionOf,
  TRAIN_VERSION_BUMP_TRAILER,
  withPluginVersion,
  prNumberFromSubject,
  runTrainCycle,
  trainPrCommentMarker,
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
  /** Comments on each pull request, as GitHub would hold them across cycles and restarts. */
  prComments: Map<number, string[]>;
  spawns: Array<{ idempotencyKey: string; prompt: string }>;
  /** Key prefixes the fake server already holds a task for: spawning one replays it (#3986). */
  replayKeys: Set<string>;
  notes: Array<{ kind: TrainEventKind; detail: string }>;
  healthyCalls: number;
  deps: TrainDeps;
  commit(branch: string, files: Record<string, string>, subject: string): string;
  cycle(): Promise<CycleResult>;
  originRef(branch: string): string;
}

const roots: string[] = [];

function makeHarness(opts: { config?: boolean; integrationBranch?: boolean; seedVerified?: boolean; pluginVersion?: string } = {}): Harness {
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
  if (opts.pluginVersion !== undefined) {
    mkdirSync(join(seed, 'plugin/.claude-plugin'), { recursive: true });
    writeFileSync(join(seed, PLUGIN_JSON_PATH), pluginJson(opts.pluginVersion));
    writeFileSync(join(seed, 'plugin/README.md'), 'plugin\n');
  }
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
    prComments: new Map<number, string[]>(),
    spawns: [] as Array<{ idempotencyKey: string; prompt: string }>,
    replayKeys: new Set<string>(),
    notes: [] as Array<{ kind: TrainEventKind; detail: string }>,
    healthyCalls: 0,
  } as unknown as Harness;

  h.deps = {
    async writeFile(path, content) {
      writeFileSync(join(train, path), content);
    },
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
      async commentPullRequest(pr, marker, body) {
        // The contract of the real implementation: skip when a comment already carries the marker.
        const list = h.prComments.get(pr) ?? [];
        if (list.some((c) => c.includes(marker))) return;
        list.push(body);
        h.prComments.set(pr, list);
      },
    },
    spawner: {
      async spawn(req) {
        h.spawns.push(req);
        const replayed = [...h.replayKeys].some((k) => req.idempotencyKey.startsWith(k));
        return { replayed, taskId: `task-${req.idempotencyKey}` };
      },
    },
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
      else {
        mkdirSync(dirname(join(seed, name)), { recursive: true });
        writeFileSync(join(seed, name), content);
      }
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

/** A fix-task key without its culprit suffix (`train-fix-issue-1-2-<10 hex>` -> `train-fix-issue-1-2`). */
const keyBase = (key: string): string => key.replace(/-[0-9a-f]{10}$/, '');

function pluginJson(version: string): string {
  return `{\n  "name": "kookr-toolkit",\n  "version": "${version}",\n  "description": "demo"\n}\n`;
}

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

  it('reads kookr spawn --json: a new task, a replay, a failure, and output that names no task (#3986)', () => {
    const envelope = (details: Record<string, unknown>, ok = true) => JSON.stringify({ ok, code: ok ? 'OK' : 'SERVER_ERROR', message: ok ? 'created' : 'server unreachable', details });
    expect(parseSpawnOutput({ ok: true, stdout: `${envelope({ taskId: 't1', idempotentReplay: false })}\n`, stderr: '' }))
      .toEqual({ replayed: false, taskId: 't1' });
    // a warning line before the envelope does not hide it
    expect(parseSpawnOutput({ ok: true, stdout: `note: something\n${envelope({ taskId: 't2', idempotentReplay: true })}\n`, stderr: '' }))
      .toEqual({ replayed: true, taskId: 't2' });
    expect(() => parseSpawnOutput({ ok: false, stdout: envelope({}, false), stderr: '' })).toThrow('kookr spawn failed: server unreachable');
    expect(() => parseSpawnOutput({ ok: false, stdout: '', stderr: 'command not found' })).toThrow('kookr spawn failed: command not found');
    // exit 0 but nothing says which task: never assumed to be a new one
    expect(() => parseSpawnOutput({ ok: true, stdout: 'task_id=t3\n✓ Task created\n', stderr: '' })).toThrow('without naming a task');
    expect(() => parseSpawnOutput({ ok: true, stdout: envelope({ idempotentReplay: false }), stderr: '' })).toThrow('without naming a task');
    expect(() => parseSpawnOutput({ ok: true, stdout: envelope({ taskId: '' }), stderr: '' })).toThrow('without naming a task');
    expect(() => parseSpawnOutput({ ok: true, stdout: envelope({ taskId: 't4' }, false), stderr: '' })).toThrow('without naming a task');
    // the last envelope wins; a missing or non-boolean flag is not a replay
    expect(parseSpawnOutput({ ok: true, stdout: `${envelope({ taskId: 'a', idempotentReplay: true })}\n${envelope({ taskId: 'b' })}`, stderr: '' }))
      .toEqual({ replayed: false, taskId: 'b' });
    expect(parseSpawnOutput({ ok: true, stdout: envelope({ taskId: 'c', idempotentReplay: 'true' }), stderr: '' }))
      .toEqual({ replayed: false, taskId: 'c' });
    // a replayed task whose launch failed, or that was stopped, is no fix task
    for (const status of ['terminated', 'cancelled']) {
      expect(() => parseSpawnOutput({ ok: true, stdout: envelope({ taskId: 'd', idempotentReplay: true, task: { status } }), stderr: '' }))
        .toThrow(`which is ${status}`);
    }
    expect(parseSpawnOutput({ ok: true, stdout: envelope({ taskId: 'e', idempotentReplay: true, task: { status: 'inProgress' } }), stderr: '' }))
      .toEqual({ replayed: true, taskId: 'e' });
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
    expect(keyBase(h.spawns[0].idempotencyKey)).toBe('train-fix-issue-130-1');
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

  it('gives each failure its own fix-task key, so a lost state.json still starts a task for a new failure (#3986)', async () => {
    h = makeHarness();
    h.issues.set(501, [{ number: 5010, state: 'closed' }]);
    const first = h.commit('staging', { 'bad.txt': 'x' }, 'broken (#501)');
    expect((await h.cycle()).outcome).toBe('reverted');
    // state.json is lost or reset
    h.state.fixTasks = {};
    const second = h.commit('staging', { 'bad.txt': 'y' }, 'broken again (#501)');
    expect((await h.cycle()).outcome).toBe('reverted');

    const keys = h.spawns.map((s) => s.idempotencyKey);
    expect(keys).toEqual([`train-fix-issue-5010-1-${first.slice(0, 10)}`, `train-fix-issue-5010-1-${second.slice(0, 10)}`]);
    expect(new Set(keys).size).toBe(2);
    expect(h.state.fixTasks['issue-5010']).toBe(1);
  });

  it('counts a replayed key as the task of this failure, and starts nothing else (#3986)', async () => {
    h = makeHarness();
    h.issues.set(502, [{ number: 5020, state: 'closed' }]);
    // the server already holds this failure's task (kookr spawn re-sent a request that timed out)
    h.replayKeys.add('train-fix-issue-5020-1-');
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#502)');
    expect((await h.cycle()).outcome).toBe('reverted');

    expect(h.spawns).toHaveLength(1);
    expect(h.state.fixTasks['issue-5020']).toBe(1);
    const reverted = h.notes.find((n) => n.kind === 'reverted')?.detail ?? '';
    // the delivery tracker reads the first "fix task <key> spawned (...)" in the detail
    expect(/fix task (\S+) spawned \(automatic re-land (\d+) of (\d+)\)/.exec(reverted)?.slice(1))
      .toEqual([h.spawns[0].idempotencyKey, '1', '3']);
    expect(reverted).toContain('the server returned the task already started for this failure');
    expect(h.notes.map((n) => n.kind)).not.toContain('fix-spawn-failed');
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
    h.deps.spawner = { async spawn(req) { h.spawns.push(req); return { replayed: false, taskId: 'task-1' }; } };
    h.commit('staging', { 'bad.txt': 'y' }, 'broken again (#401)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns.map((s) => keyBase(s.idempotencyKey))).toEqual(['train-fix-ref-401-1']);
    expect(h.state.fixTasks['ref-401']).toBe(1);

    // With no linked issue, a later prompt speaks of the change, not an issue.
    h.commit('staging', { 'bad.txt': 'z' }, 'broken a third time (#401)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns.map((s) => keyBase(s.idempotencyKey))).toEqual(['train-fix-ref-401-1', 'train-fix-ref-401-2']);
    expect(h.spawns[1].prompt).toContain(
      'automatic re-land 2 of 3 for this change: 1 earlier automatic fix task(s) were already started for this change',
    );
    expect(h.spawns[1].prompt).not.toContain('this issue');
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

  it('counts the fix budget per issue: three re-lands under new PR numbers, then fix-budget-exhausted', async () => {
    h = makeHarness();
    // The original PR and its three re-lands all close the same issue.
    for (const pr of [13, 14, 15, 16]) h.issues.set(pr, [{ number: 130, state: 'open' }]);
    h.commit('staging', { 'bad.txt': 'x' }, 'broken (#13)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect((await h.cycle()).outcome).toBe('idle');
    for (const pr of [14, 15]) {
      h.commit('staging', { 'bad.txt': `again-${pr}` }, `re-land, still broken (#${pr})`);
      expect((await h.cycle()).outcome).toBe('reverted');
      expect((await h.cycle()).outcome).toBe('idle');
      expect(h.notes.map((n) => n.kind)).not.toContain('fix-budget-exhausted');
    }
    expect(h.spawns.map((s) => keyBase(s.idempotencyKey))).toEqual([
      'train-fix-issue-130-1', 'train-fix-issue-130-2', 'train-fix-issue-130-3',
    ]);
    expect(h.state.fixTasks['issue-130']).toBe(3);
    // Only a later attempt is told about the earlier fix tasks.
    expect(h.spawns[0].prompt).not.toContain('earlier automatic fix task');
    expect(h.spawns[1].prompt).toContain('automatic re-land 2 of 3 for this issue');
    expect(h.spawns[2].prompt).toContain(
      '2 earlier automatic fix task(s) were already started for this issue; check whether their pull requests were reverted',
    );

    // The third re-land fails as well: the change is still reverted, but no fourth task starts.
    h.commit('staging', { 'bad.txt': 'again-16' }, 're-land, still broken (#16)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns).toHaveLength(3);
    const exhausted = h.notes.find((n) => n.kind === 'fix-budget-exhausted');
    expect(exhausted?.detail).toContain('3 automatic fix task(s), the limit, were already started for this issue');
    expect(h.state.fixTasks['issue-130']).toBe(3);
  });

  it('continues an issue budget kept from an earlier run: the next task is attempt 2', async () => {
    h = makeHarness();
    // An earlier fix task for issue 130 was started in an earlier run; this run
    // saw no revert of it, so the prompt must not claim one.
    h.state.fixTasks['issue-130'] = 1;
    h.issues.set(17, [{ number: 130, state: 'open' }]);
    h.commit('staging', { 'bad.txt': 'x' }, 'another change for the same issue (#17)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns.map((s) => keyBase(s.idempotencyKey))).toEqual(['train-fix-issue-130-2']);
    expect(h.state.fixTasks['issue-130']).toBe(2);
    expect(h.spawns[0].prompt).toContain('automatic re-land 2 of 3 for this issue');
    expect(h.spawns[0].prompt).toContain(
      '1 earlier automatic fix task(s) were already started for this issue; check whether their pull requests were reverted',
    );
    expect(h.spawns[0].prompt).not.toContain('were reverted too');
  });

  it('keeps an issue budget at 1 when the spawn of attempt 2 fails', async () => {
    h = makeHarness();
    h.state.fixTasks['issue-130'] = 1;
    h.issues.set(18, [{ number: 130, state: 'open' }]);
    h.deps.spawner = { async spawn() { throw new Error('kookr spawn failed'); } };
    h.commit('staging', { 'bad.txt': 'x' }, 'broken re-land (#18)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.state.fixTasks['issue-130']).toBe(1);
    const failed = h.notes.find((n) => n.kind === 'fix-spawn-failed');
    expect(failed?.detail).toContain('train-fix-issue-130-2');
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

  it('with no linked issue, counts by the PR reference and stops after the third fix task', async () => {
    h = makeHarness();
    for (const content of ['a', 'b', 'c']) {
      h.commit('staging', { 'bad.txt': content }, 'broken (#13)');
      expect((await h.cycle()).outcome).toBe('reverted');
      expect((await h.cycle()).outcome).toBe('idle');
    }
    expect(h.spawns.map((s) => keyBase(s.idempotencyKey))).toEqual([
      'train-fix-ref-13-1', 'train-fix-ref-13-2', 'train-fix-ref-13-3',
    ]);
    expect(h.notes.map((n) => n.kind)).not.toContain('fix-budget-exhausted');
    h.commit('staging', { 'bad.txt': 'd' }, 'broken (#13)');
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.spawns).toHaveLength(3);
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
  describe('pull-request comments: what happened, why, what comes next (#3913)', () => {
    it('comments once on each promoted pull request with the commit, the verified head and the time, and never again', async () => {
      h = makeHarness();
      h.issues.set(61, [{ number: 610, state: 'open' }]);
      const first = h.commit('staging', { 'a.txt': '1' }, 'first (#61)');
      const head = h.commit('staging', { 'b.txt': '2' }, 'second (#62)');
      expect((await h.cycle()).outcome).toBe('promoted');

      const [c61, ...more61] = h.prComments.get(61) ?? [];
      expect(more61).toEqual([]);
      expect(c61).toContain('**Integration train: promoted.**');
      expect(c61).toContain(`reached \`main\` as ${first}`);
      // A batch: the first PR was verified as part of the later head.
      expect(c61).toContain(`passed on \`staging\` at ${head}, which contains this commit at 2026-01-01T00:00:00.000Z`);
      expect(c61).toContain('Next: nothing. Issue(s) #610 closed.');
      expect(c61).toContain(trainPrCommentMarker('promoted', first));
      const [c62, ...more62] = h.prComments.get(62) ?? [];
      expect(more62).toEqual([]);
      expect(c62).toContain('passed on this commit at 2026-01-01T00:00:00.000Z');
      expect(c62).toContain('Next: nothing.');

      // Later cycles, idle or promoting something else, add nothing to these.
      expect((await h.cycle()).outcome).toBe('idle');
      h.commit('staging', { 'c.txt': '3' }, 'third (#63)');
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.prComments.get(61)).toHaveLength(1);
      expect(h.prComments.get(62)).toHaveLength(1);
      expect(h.prComments.get(63)).toHaveLength(1);
    });

    it('does not comment when the promotion push is rejected, and comments once when the retry goes through', async () => {
      h = makeHarness();
      h.commit('staging', { 'a.txt': '1' }, 'one (#64)');
      h.rejectMainPush = true;
      expect((await h.cycle()).outcome).toBe('retry');
      expect(h.prComments.get(64)).toBeUndefined();
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.prComments.get(64)).toHaveLength(1);
    });

    it('comments once on a reverted pull request with the revert, a short failing tail and the fix task; never "promoted"', async () => {
      h = makeHarness();
      h.issues.set(72, [{ number: 720, state: 'open' }]);
      h.commit('staging', { 'a.txt': '1' }, 'good (#71)');
      const bad = h.commit('staging', { 'bad.txt': 'x' }, 'broken (#72)');
      const after = h.commit('staging', { 'c.txt': '3' }, 'after (#73)');
      expect((await h.cycle()).outcome).toBe('reverted');
      const revertSha = h.originRef('staging');

      const comments = h.prComments.get(72) ?? [];
      expect(comments).toHaveLength(1);
      const [c] = comments;
      expect(c).toContain('**Integration train: reverted.**');
      expect(c).toContain(`commit ${bad} failed the full test suite on \`staging\``);
      expect(c).toContain(`reverted it with ${revertSha}`);
      expect(c).toContain('AssertionError: bad.txt exists');
      expect(c).toMatch(/Next: the train started fix task `train-fix-issue-720-1-[0-9a-f]{10}` \(automatic re-land 1 of 3\)/);
      expect(c).toContain('Issue(s) #720 stay open until then.');
      expect(c).toContain(trainPrCommentMarker('reverted', bad));
      expect(c).not.toContain('promoted');
      // The PRs around it reached main and say so; the reverted one does not.
      expect(h.prComments.get(71)?.[0]).toContain('promoted');
      expect(h.prComments.get(73)?.[0]).toContain(`as ${after}`);

      expect((await h.cycle()).outcome).toBe('idle');
      expect(h.prComments.get(72)).toHaveLength(1);
      expect(h.prComments.get(71)).toHaveLength(1);
      expect(h.prComments.get(73)).toHaveLength(1);
    });

    it('says "needs a human" on the pull request once the fix budget is spent', async () => {
      h = makeHarness();
      h.issues.set(81, [{ number: 810, state: 'open' }]);
      h.state.fixTasks['issue-810'] = MAX_AUTOMATIC_RELANDS;
      h.commit('staging', { 'bad.txt': 'x' }, 'broken (#81)');
      expect((await h.cycle()).outcome).toBe('reverted');
      const [c] = h.prComments.get(81) ?? [];
      expect(c).toContain('Next: needs a human: 3 automatic fix task(s), the limit of 3, were already started for this issue');
      expect(h.spawns).toEqual([]);
    });

    it('speaks of the change, not an issue, when a budget with no linked issue is spent', async () => {
      h = makeHarness();
      h.state.fixTasks['ref-83'] = 3;
      h.commit('staging', { 'bad.txt': 'x' }, 'broken, no linked issue (#83)');
      expect((await h.cycle()).outcome).toBe('reverted');
      const [c] = h.prComments.get(83) ?? [];
      expect(c).toContain('Next: needs a human: 3 automatic fix task(s), the limit of 3, were already started for this change');
      expect(c).not.toContain('this issue');
      const exhausted = h.notes.find((n) => n.kind === 'fix-budget-exhausted');
      expect(exhausted?.detail).toContain('3 automatic fix task(s), the limit, were already started for this change');
      expect(exhausted?.detail).not.toContain('this issue');
      expect(h.spawns).toEqual([]);
    });

    it('keeps the failing tail in the pull-request comment short', async () => {
      h = makeHarness();
      const bad = h.commit('staging', { 'bad.txt': 'x' }, 'broken (#82)');
      const long = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const verify = h.deps.verify;
      h.deps.verify = async (sha) => {
        const r = await verify(sha);
        return r.ok ? r : { ...r, tail: long };
      };
      expect((await h.cycle()).outcome).toBe('reverted');
      const [c] = h.prComments.get(82) ?? [];
      expect(c).toContain(bad);
      expect(c).toContain('line 50');
      expect(c).toContain('line 31');
      expect(c).not.toContain('line 30\n');
    });

    it('a comment that fails to post does not stop the cycle', async () => {
      h = makeHarness();
      h.deps.github.commentPullRequest = async () => { throw new Error('gh: HTTP 502'); };
      const head = h.commit('staging', { 'a.txt': '1' }, 'one (#91)');
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.originRef('main')).toBe(head);
    });
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

  describe('plugin version bump (#3793)', () => {
    const versionAt = (ref: string): string | null =>
      pluginVersionOf(git(h.origin, 'show', `${ref}:${PLUGIN_JSON_PATH}`));

    for (const order of [['a', 'b'], ['b', 'a']]) {
      it(`bumps once for two plugin PRs merged in order ${order.join(', ')}, then promotes the bump`, async () => {
        h = makeHarness({ pluginVersion: '0.1.9' });
        // Neither PR touches plugin.json, so they cannot conflict on it.
        for (const name of order) h.commit('staging', { [`plugin/skills/${name}.md`]: name }, `skill ${name} (#${name === 'a' ? 1 : 2})`);
        const prHead = h.originRef('staging');

        const bumped = await h.cycle();
        expect(bumped).toMatchObject({ outcome: 'version-bumped', detail: 'plugin version 0.1.10' });
        expect(h.verifyCalls).toEqual([]); // verify happens on the next cycle
        expect(h.mainPushes).toEqual([]);
        const bumpSha = h.originRef('staging');
        expect(git(h.origin, 'rev-parse', `${bumpSha}^`)).toBe(prHead);
        expect(git(h.origin, 'diff', '--name-only', prHead, bumpSha)).toBe(PLUGIN_JSON_PATH);
        expect(git(h.origin, 'show', `${bumpSha}:${PLUGIN_JSON_PATH}`)).toBe(pluginJson('0.1.10').trim());
        expect(git(h.origin, 'log', '-1', '--format=%B', bumpSha)).toContain(TRAIN_VERSION_BUMP_TRAILER);

        expect((await h.cycle()).outcome).toBe('promoted');
        expect(h.originRef('main')).toBe(bumpSha);
        expect(versionAt('main')).toBe('0.1.10');
        expect(git(h.origin, 'show', 'main:plugin/skills/a.md')).toBe('a');
        expect(git(h.origin, 'show', 'main:plugin/skills/b.md')).toBe('b');
        expect((await h.cycle()).outcome).toBe('idle');

        // The next batch with plugin content gets the next version.
        h.commit('staging', { 'plugin/skills/c.md': 'c' }, 'skill c (#3)');
        expect((await h.cycle()).outcome).toBe('version-bumped');
        expect((await h.cycle()).outcome).toBe('promoted');
        expect(versionAt('main')).toBe('0.1.11');
      });
    }

    it('never changes the version for a batch that does not touch plugin/', async () => {
      h = makeHarness({ pluginVersion: '0.1.0' });
      const sha = h.commit('staging', { 'src.txt': 'x' }, 'not plugin (#1)');
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.originRef('main')).toBe(sha);
      expect(versionAt('main')).toBe('0.1.0');
    });

    it('does not bump again when the batch already ships a higher version', async () => {
      h = makeHarness({ pluginVersion: '0.1.0' });
      const sha = h.commit('staging', {
        'plugin/skills/a.md': 'a', [PLUGIN_JSON_PATH]: pluginJson('0.2.0'),
      }, 'skill with a manual bump (#1)');
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.originRef('main')).toBe(sha);
      expect(versionAt('main')).toBe('0.2.0');
    });

    it('does not bump a batch that only edits plugin.json', async () => {
      h = makeHarness({ pluginVersion: '0.1.0' });
      const sha = h.commit('staging', { [PLUGIN_JSON_PATH]: pluginJson('0.1.0').replace('demo', 'other') }, 'describe (#1)');
      expect((await h.cycle()).outcome).toBe('promoted');
      expect(h.originRef('main')).toBe(sha);
    });

    it('retries when the bump push is rejected, and halts after repeated rejections', async () => {
      h = makeHarness({ pluginVersion: '0.1.0' });
      const sha = h.commit('staging', { 'plugin/skills/a.md': 'a' }, 'skill (#1)');
      h.rejectPushesTo.add('staging');
      expect(await h.cycle()).toMatchObject({ outcome: 'retry', detail: 'plugin version bump push rejected' });
      expect(h.originRef('staging')).toBe(sha);
      expect((await h.cycle()).outcome).toBe('retry');
      expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'push-rejected' });
      h.rejectPushesTo.clear();
    });

    it('computes the next version and rewrites only the version value', () => {
      expect(nextPluginVersion('0.16.114', '0.16.114')).toBe('0.16.115');
      expect(nextPluginVersion('0.16.114', '0.16.99')).toBe('0.16.115');
      expect(nextPluginVersion('0.16.99', '0.16.114')).toBeNull();
      expect(nextPluginVersion('0.16.114', '0.17.0')).toBeNull();
      expect(nextPluginVersion('1.0.0', '0.99.99')).toBe('1.0.1');
      expect(nextPluginVersion('0.16.114-rc.1', '0.16.114-rc.1')).toBeNull();
      const text = '{\n  "name": "kookr-toolkit",\n  "version":  "0.1.0",\n  "x": {"version": "9"}\n}\n';
      expect(withPluginVersion(text, '0.1.1')).toBe(text.replace('"version":  "0.1.0"', '"version":  "0.1.1"'));
      expect(pluginVersionOf('{"name": "x"}')).toBeNull();
    });
  });
});

describe('a revert the train verified survives a moving integration branch (#4014)', () => {
  beforeEach(() => { h = undefined as unknown as Harness; });

  /** SHAs on origin's staging now: the bisect candidates. Any other SHA verified later is a train-made revert. */
  function knownShas(): Set<string> {
    git(h.seed, 'fetch', '-q', 'origin');
    return new Set(git(h.seed, 'rev-list', 'origin/staging').split('\n'));
  }

  /** Runs `during` the first time the train verifies a commit it made itself (its revert). */
  function onRevertVerify(known: Set<string>, during: () => void): void {
    const realVerify = h.deps.verify;
    let fired = false;
    h.deps.verify = async (sha) => {
      if (!known.has(sha) && !fired) { fired = true; during(); }
      return realVerify(sha);
    };
  }

  it('re-applies the verified revert on the moved head, pushes it in the same cycle, and the next cycle promotes', async () => {
    h = makeHarness();
    h.issues.set(42, [{ number: 420, state: 'closed' }]);
    h.commit('staging', { 'a.txt': '1' }, 'good (#41)');
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#42)');
    const known = knownShas();
    let late = '';
    onRevertVerify(known, () => { late = h.commit('staging', { 'late.txt': '1' }, 'merged during the check (#43)'); });

    const r = await h.cycle();
    expect(r.outcome).toBe('reverted');
    const staging = h.originRef('staging');
    // the revert sits on top of the commit that merged during its verify
    expect(git(h.origin, 'rev-parse', `${staging}^`)).toBe(late);
    expect(git(h.origin, 'log', '-1', '--format=%B', staging)).toContain(`This reverts commit ${culprit}`);
    expect(git(h.origin, 'show', `${staging}:late.txt`)).toBe('1');
    expect(gitSoft(h.origin, ['cat-file', '-e', `${staging}:bad.txt`]).ok).toBe(false);
    // the full suite ran once for a revert: the first one; the re-applied one was not verified
    const revertRuns = h.verifyCalls.filter((sha) => !known.has(sha));
    expect(revertRuns).toHaveLength(1);
    expect(revertRuns[0]).not.toBe(staging);
    // so it was not promoted
    expect(h.mainPushes).not.toContain(staging);
    expect(h.state.pendingRevert).toBeNull();
    expect(h.state.pushRejections).toBe(0);
    // the culprit's issue is handled once, naming the revert that was pushed
    expect(h.ghLog).toContain('reopen 420');
    expect(h.ghLog.find((l) => l.startsWith('comment 420:'))).toContain(staging);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].prompt).toContain(`Revert commit: ${staging}`);
    expect(h.notes.find((n) => n.kind === 'reverted')?.detail).toContain('not verified on this head yet');
    expect(h.notes.map((n) => n.kind)).not.toContain('revert-push-rejected');

    // the next ordinary cycle verifies the new head and promotes it
    const verifiesBefore = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.verifyCalls.slice(verifiesBefore)).toEqual([staging]);
    expect(h.originRef('main')).toBe(staging);
  });

  it('halts revert-conflict when the commit that merged during the check touches the reverted lines', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#51)');
    const known = knownShas();
    let late = '';
    onRevertVerify(known, () => { late = h.commit('staging', { 'bad.txt': 'y' }, 'edits the same lines (#52)'); });

    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'revert-conflict' });
    expect(r.detail).toContain('re-applying');
    expect(h.originRef('staging')).toBe(late);
    expect(h.spawns).toEqual([]);
    expect(h.state.pendingRevert).toBeNull();
    // the halt names the new head, so it stands until a ref moves again
    const verifies = h.verifyCalls.length;
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'revert-conflict' });
    expect(h.verifyCalls.length).toBe(verifies);
  });

  it('resumes an interrupted cycle at the revert, with no new bisect runs', async () => {
    h = makeHarness();
    h.commit('staging', { '1.txt': '1' }, 'one (#61)');
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#62)');
    h.commit('staging', { '3.txt': '3' }, 'three (#63)');
    h.commit('staging', { '4.txt': '4' }, 'four (#64)');
    const known = knownShas();
    // Keep a copy of what the train saved to disk mid-cycle. The process is
    // killed while the revert is being verified, so the save that ends a cycle
    // never happens: only the save made when the culprit was confirmed survives.
    let onDisk = '';
    h.deps.state = {
      load: () => h.state,
      save: (s) => { if (!onDisk && s.pendingRevert) onDisk = JSON.stringify(s); h.state = s; },
    };
    const realVerify = h.deps.verify;
    h.deps.verify = async (sha) => {
      if (!known.has(sha)) throw new Error('killed');
      return realVerify(sha);
    };
    await h.cycle();
    const saved = normalizeTrainState(JSON.parse(onDisk));
    expect(saved.pendingRevert).toMatchObject({ culprit, verified: false });
    expect(saved.pendingRevert?.failTail).toContain('AssertionError');

    // the train restarts from what was on disk
    h.state = saved;
    h.deps.verify = realVerify;
    h.notes.length = 0;
    const verifiesBefore = h.verifyCalls.length;
    const r = await h.cycle();
    expect(r.outcome).toBe('reverted');
    // one run only, the revert's: no head re-runs, no main check, no bisect steps
    const runs = h.verifyCalls.slice(verifiesBefore);
    expect(runs).toHaveLength(1);
    expect(known.has(runs[0])).toBe(false);
    const staging = h.originRef('staging');
    expect(runs[0]).toBe(staging);
    // verified in this cycle, so promoted at once
    expect(h.originRef('main')).toBe(staging);
    expect(h.state.pendingRevert).toBeNull();
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].prompt).toContain('AssertionError');
  });

  it('keeps the verified revert across cycles while its push is refused, alerts once, keeps it through a push-rejected halt, then pushes it without another verify', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#71)');
    h.rejectPushesTo.add('staging');
    expect(await h.cycle()).toMatchObject({ outcome: 'retry', detail: 'revert push rejected' });
    expect(h.state.pendingRevert).toMatchObject({ culprit, verified: true, rejections: 1 });
    expect(h.notes).toEqual([]);

    const verifies = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('retry');
    expect(h.verifyCalls.length).toBe(verifies); // no bisect, no second verify of the revert
    expect(h.notes.map((n) => n.kind)).toEqual(['revert-push-rejected']);
    expect(h.notes[0].detail).toContain('rejected 2 times in a row');
    expect(h.notes[0].detail).toContain(culprit.slice(0, 10));

    // a third refusal: no second alert; the train halts push-rejected and still remembers the culprit
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'push-rejected' });
    expect(h.notes.map((n) => n.kind)).toEqual(['revert-push-rejected', 'halted']);
    expect(h.state.pendingRevert).toMatchObject({ culprit, verified: true, rejections: 3, alerted: true });

    // the operator fixes the branch protection; a merge moves the head and clears the halt
    h.rejectPushesTo.clear();
    const moved = h.commit('staging', { 'other.txt': '1' }, 'unrelated (#72)');
    const r = await h.cycle();
    expect(r.outcome).toBe('reverted');
    // the moved head is verified once (#4031), red, so the remembered revert is pushed without another verify
    expect(h.verifyCalls.slice(verifies)).toEqual([moved]);
    expect(h.notes.filter((n) => n.kind === 'revert-push-rejected')).toHaveLength(1);
    const staging = h.originRef('staging');
    expect(git(h.origin, 'log', '-1', '--format=%B', staging)).toContain(`This reverts commit ${culprit}`);
    expect(h.mainPushes).not.toContain(staging);
    expect(h.state.pendingRevert).toBeNull();
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.originRef('main')).toBe(staging);
  });

  it('re-applies at most three times in one cycle, then leaves the remembered culprit to the next cycle', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#75)');
    // every push to staging loses the race: a merge lands just before it
    const realGit = h.deps.git;
    let stagingPushes = 0;
    h.deps.git = async (args) => {
      if (args[0] === 'push' && /:refs\/heads\/staging$/.test(args[args.length - 1])) {
        stagingPushes++;
        h.commit('staging', { [`race-${stagingPushes}.txt`]: '1' }, `race ${stagingPushes} (#7${stagingPushes + 5})`);
      }
      return realGit(args);
    };
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'retry', detail: 'revert push rejected' });
    expect(stagingPushes).toBe(1 + 3);
    expect(h.state.pendingRevert).toMatchObject({ culprit, verified: true, rejections: 4 });
    expect(h.state.pushRejections).toBe(1);
    expect(h.notes.map((n) => n.kind)).toEqual(['revert-push-rejected']);
    expect(h.spawns).toEqual([]);
  });

  it('forgets the culprit when a person reverts it while the train verifies its own revert', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#76)');
    const known = knownShas();
    onRevertVerify(known, () => {
      git(h.seed, 'fetch', '-q', 'origin');
      git(h.seed, 'checkout', '-q', '-B', 'staging', 'origin/staging');
      git(h.seed, 'revert', '--no-edit', culprit);
      git(h.seed, 'push', '-q', 'origin', 'staging');
    });
    const r = await h.cycle();
    expect(r.outcome).toBe('retry');
    expect(r.detail).toContain('already reverts it');
    expect(h.state.pendingRevert).toBeNull();
    expect(git(h.origin, 'log', '-1', '--format=%an', 'refs/heads/staging')).toBe('Train Test');
    expect(git(h.origin, 'log', '-1', '--format=%B', 'refs/heads/staging')).not.toContain('Kookr-Integration-Train');
    expect(h.spawns).toEqual([]);
    expect(h.notes.map((n) => n.kind)).not.toContain('reverted');
  });

  it('forgets the culprit when a fix that lands during the check makes its revert empty', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#77)');
    const known = knownShas();
    let fix = '';
    onRevertVerify(known, () => { fix = h.commit('staging', { 'bad.txt': '' }, 'remove the bad file (#78)'); });
    const r = await h.cycle();
    expect(r.outcome).toBe('retry');
    expect(r.detail).toContain('changes nothing');
    expect(h.state.pendingRevert).toBeNull();
    expect(h.originRef('staging')).toBe(fix);
    expect(h.spawns).toEqual([]);
  });

  it('forgets a remembered culprit that left the integration branch, and bisects the branch as it is now', async () => {
    h = makeHarness();
    const base = h.originRef('main');
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#79)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    expect(h.state.pendingRevert).toMatchObject({ culprit });
    h.rejectPushesTo.clear();
    // someone rewrites staging without the culprit, then the same change lands again as a new commit
    git(h.seed, 'fetch', '-q', 'origin');
    git(h.seed, 'checkout', '-q', '-B', 'staging', base);
    git(h.seed, 'push', '-q', '-f', 'origin', 'staging');
    const reland = h.commit('staging', { 'bad.txt': 'x' }, 're-land (#80)');
    const verifies = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('reverted');
    // the head was verified and bisected again, and the commit on the branch is the one reverted
    expect(h.verifyCalls.slice(verifies)).toContain(reland);
    const msg = git(h.origin, 'log', '-1', '--format=%B', 'refs/heads/staging');
    expect(msg).toContain(`This reverts commit ${reland}`);
    expect(msg).not.toContain(culprit);
  });

  it('does not revert a remembered culprit that already reached main', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#85)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    h.rejectPushesTo.clear();
    // a person pushes the culprit straight to main, then a merge lands on staging
    git(h.seed, 'push', '-q', 'origin', `${culprit}:refs/heads/main`);
    const head = h.commit('staging', { 'n.txt': '1' }, 'next (#86)');
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'main-unverified-red' });
    expect(h.originRef('staging')).toBe(head);
    expect(h.spawns).toEqual([]);
  });

  it('drops a remembered culprit that a person already reverted, and runs an ordinary cycle', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#81)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    h.rejectPushesTo.clear();
    git(h.seed, 'fetch', '-q', 'origin');
    git(h.seed, 'checkout', '-q', '-B', 'staging', 'origin/staging');
    git(h.seed, 'revert', '--no-edit', culprit);
    git(h.seed, 'push', '-q', 'origin', 'staging');
    const head = h.originRef('staging');

    const verifies = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.verifyCalls.slice(verifies)).toEqual([head]);
    expect(h.state.pendingRevert).toBeNull();
    expect(h.spawns).toEqual([]);
  });

  it('verifies a head that moved since the culprit was confirmed, and promotes it instead of reverting when a hand fix made it green (#4031)', async () => {
    h = makeHarness();
    h.issues.set(87, [{ number: 870, state: 'closed' }]);
    const culprit = h.commit('staging', { 'bad.txt': 'x', 'feature.txt': 'f' }, 'culprit (#87)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    expect(h.state.pendingRevert).toMatchObject({ culprit, verified: true, redHead: culprit });
    h.rejectPushesTo.clear();
    // a person fixes the failure by hand; the revert would still undo feature.txt
    const fix = h.commit('staging', { 'bad.txt': '' }, 'fix the failure by hand (#88)');

    const verifies = h.verifyCalls.length;
    const r = await h.cycle();
    expect(r.outcome).toBe('promoted');
    expect(h.verifyCalls.slice(verifies)).toEqual([fix]);
    expect(h.originRef('staging')).toBe(fix); // no revert pushed
    expect(h.originRef('main')).toBe(fix);
    expect(git(h.origin, 'show', `${fix}:feature.txt`)).toBe('f');
    expect(h.state.pendingRevert).toBeNull();
    expect(h.ghLog.some((l) => l === 'reopen 870' || l.startsWith('comment 870:'))).toBe(false);
    expect(h.spawns).toEqual([]);
    expect(h.notes.map((n) => n.kind)).not.toContain('reverted');
  });

  it('verifies a moved red head once, then not again while the revert push stays rejected (#4031)', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#97)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    const moved = h.commit('staging', { 'other.txt': '1' }, 'unrelated (#98)');
    const verifies = h.verifyCalls.length;
    expect(await h.cycle()).toMatchObject({ outcome: 'retry', detail: 'revert push rejected' });
    expect(h.verifyCalls.slice(verifies)).toEqual([moved]);
    expect(h.state.pendingRevert).toMatchObject({ culprit, redHead: moved });
    // the head is where it was last seen red: no further run (this third refusal in a row halts)
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'push-rejected' });
    expect(h.verifyCalls.slice(verifies)).toEqual([moved]);
    expect(h.state.pendingRevert).toMatchObject({ culprit, redHead: moved });
  });

  it('keeps nothing remembered when the promotion of a moved green head is rejected, and promotes it next cycle (#4031)', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x', 'feature.txt': 'f' }, 'culprit (#99)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    h.rejectPushesTo.clear();
    const fix = h.commit('staging', { 'bad.txt': '' }, 'fix by hand (#100)');
    const main = h.originRef('main');
    h.rejectMainPush = true;
    expect(await h.cycle()).toMatchObject({ outcome: 'retry', detail: 'promotion push rejected' });
    expect(h.originRef('main')).toBe(main);
    expect(h.originRef('staging')).toBe(fix);
    expect(h.state.pendingRevert).toBeNull();
    // counted, after the rejected revert push of the first cycle
    expect(h.state.pushRejections).toBe(2);
    expect((await h.cycle()).outcome).toBe('promoted');
    expect(h.originRef('main')).toBe(fix);
    expect(h.spawns).toEqual([]);
  });

  it('verifies the head before a remembered revert from a state file that does not say which head was red (#4031)', async () => {
    h = makeHarness();
    const culprit = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#89)');
    h.rejectPushesTo.add('staging');
    expect((await h.cycle()).outcome).toBe('retry');
    h.rejectPushesTo.clear();
    // written by the code before #4031: no redHead
    const { redHead: _dropped, ...legacy } = h.state.pendingRevert as NonNullable<TrainState['pendingRevert']>;
    h.state = normalizeTrainState(JSON.parse(JSON.stringify({ ...h.state, pendingRevert: legacy })));
    expect(h.state.pendingRevert).toMatchObject({ culprit, redHead: null });

    const verifies = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.verifyCalls.slice(verifies)).toEqual([culprit]); // the head once, red; the verified revert is not run again
    expect(git(h.origin, 'log', '-1', '--format=%B', 'refs/heads/staging')).toContain(`This reverts commit ${culprit}`);
  });

  /**
   * #91 breaks the branch. While its revert is verified, #92 (fine) and #93
   * (broken too) merge, and with `fineAfter` #96 (fine) on top, so the revert
   * is re-applied on top of them and pushed unverified. Returns the SHAs.
   */
  async function reappliedOverASecondCulprit(fineAfter = false): Promise<{ first: string; fine: string; second: string; revert: string }> {
    h.issues.set(93, [{ number: 930, state: 'closed' }]);
    const first = h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#91)');
    const known = knownShas();
    let fine = '';
    let second = '';
    let top = '';
    onRevertVerify(known, () => {
      fine = h.commit('staging', { 'fine.txt': '1' }, 'fine (#92)');
      second = h.commit('staging', { 'bad2.txt': 'y' }, 'also broken (#93)');
      top = fineAfter ? h.commit('staging', { 'fine2.txt': '1' }, 'fine too (#96)') : second;
    });
    expect((await h.cycle()).outcome).toBe('reverted');
    const revert = h.originRef('staging');
    expect(git(h.origin, 'rev-parse', `${revert}^`)).toBe(top);
    return { first, fine, second, revert };
  }

  it('finds a broken change below a red re-applied revert by bisecting with the first culprit reverted, and reverts it (#4031)', async () => {
    h = makeHarness();
    const { first, fine, second, revert } = await reappliedOverASecondCulprit();
    const spawnsBefore = h.spawns.length;
    const verifies = h.verifyCalls.length;

    const r = await h.cycle();
    expect(r.outcome).toBe('reverted');
    // head twice, main, the probe of #92, the new revert. #93's probe has the
    // head's tree (red twice already), so it is neither run nor re-run.
    expect(h.verifyCalls.length - verifies).toBe(5);
    const head = h.originRef('staging');
    expect(git(h.origin, 'rev-parse', `${head}^`)).toBe(revert);
    expect(git(h.origin, 'log', '-1', '--format=%B', head)).toContain(`This reverts commit ${second}`);
    expect(gitSoft(h.origin, ['cat-file', '-e', `${head}:bad.txt`]).ok).toBe(false);
    expect(gitSoft(h.origin, ['cat-file', '-e', `${head}:bad2.txt`]).ok).toBe(false);
    expect(git(h.origin, 'show', `${head}:fine.txt`)).toBe('1');
    // the second revert was verified on the real head, so it is promoted at once
    expect(h.originRef('main')).toBe(head);
    // the second culprit's issue and fix task; the first is not blamed again
    expect(h.ghLog).toContain('reopen 930');
    expect(h.spawns.slice(spawnsBefore).map((s) => keyBase(s.idempotencyKey))).toEqual(['train-fix-issue-930-1']);
    expect(git(h.origin, 'log', '--format=%B', `${revert}..${head}`)).not.toContain(first);
    expect(h.state.pendingRevert).toBeNull();
    expect(fine).not.toBe('');
    expect((await h.cycle()).outcome).toBe('idle');
  }, 30_000);

  it('remembers a second culprit with the head it saw red, and pushes its verified revert next cycle without another run (#4031)', async () => {
    h = makeHarness();
    const { second, revert } = await reappliedOverASecondCulprit();
    h.rejectPushesTo.add('staging');
    expect(await h.cycle()).toMatchObject({ outcome: 'retry', detail: 'revert push rejected' });
    expect(h.state.pendingRevert).toMatchObject({ culprit: second, verified: true, redHead: revert });
    expect(h.originRef('staging')).toBe(revert);

    h.rejectPushesTo.clear();
    const verifies = h.verifyCalls.length;
    expect((await h.cycle()).outcome).toBe('reverted');
    expect(h.verifyCalls.length).toBe(verifies);
    const head = h.originRef('staging');
    expect(git(h.origin, 'log', '-1', '--format=%B', head)).toContain(`This reverts commit ${second}`);
    expect(h.state.pendingRevert).toBeNull();
  }, 30_000);

  it('reverts nothing when the second culprit passes its confirming re-run (#4031)', async () => {
    h = makeHarness();
    const { revert } = await reappliedOverASecondCulprit(true);
    const known = knownShas();
    // probes are commits the train builds itself; the second red run of one is green
    const realVerify = h.deps.verify;
    const redRuns = new Map<string, number>();
    h.deps.verify = async (sha) => {
      const result = await realVerify(sha);
      if (known.has(sha) || result.ok) return result;
      const n = (redRuns.get(sha) ?? 0) + 1;
      redRuns.set(sha, n);
      return n === 2 ? { ok: true, tail: '' } : result;
    };
    const spawnsBefore = h.spawns.length;
    const main = h.originRef('main');

    expect(await h.cycle()).toMatchObject({ outcome: 'retry', detail: 'second culprit passed on re-run' });
    expect(h.originRef('staging')).toBe(revert);
    expect(h.originRef('main')).toBe(main);
    expect(h.spawns.length).toBe(spawnsBefore);
    expect(h.state.pendingRevert).toBeNull();
  }, 30_000);

  it('halts multiple-failures when reverting the first culprit on a commit below its red revert conflicts (#4031)', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#101)');
    const known = knownShas();
    onRevertVerify(known, () => {
      // #102 edits the culprit's lines and breaks something else; #103 restores them
      h.commit('staging', { 'bad.txt': 'y', 'bad2.txt': 'z' }, 'edits and breaks (#102)');
      h.commit('staging', { 'bad.txt': 'x' }, 'restores (#103)');
    });
    expect((await h.cycle()).outcome).toBe('reverted');
    const revert = h.originRef('staging');
    const main = h.originRef('main');
    const spawnsBefore = h.spawns.length;
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'multiple-failures' });
    expect(h.originRef('staging')).toBe(revert);
    expect(h.originRef('main')).toBe(main);
    expect(h.spawns.length).toBe(spawnsBefore);
  }, 30_000);

  it('halts multiple-failures when another train revert lies between a red revert and the change it reverts (#4031)', async () => {
    h = makeHarness();
    const trailer = 'Kookr-Integration-Train: revert';
    const first = h.commit('staging', { 'bad.txt': 'x' }, 'first (#111)');
    const second = h.commit('staging', { 'fine.txt': '1' }, 'second (#112)');
    h.commit('staging', { 'bad.txt': '' }, `Revert "first (#111)"\n\nThis reverts commit ${first}.\n\n${trailer}`);
    const head = h.commit('staging', { 'fine.txt': '' }, `Revert "second (#112)"\n\nThis reverts commit ${second}.\n\n${trailer}`);
    h.scripted.set(head, [false, false]);
    const r = await h.cycle();
    expect(r).toMatchObject({ outcome: 'halted', reason: 'multiple-failures' });
    expect(r.detail).toContain('another train revert');
    expect(h.originRef('staging')).toBe(head);
    expect(h.spawns).toEqual([]);
  });

  it('pushes nothing for a second culprit whose revert does not make the head pass: halts revert-not-sufficient (#4031)', async () => {
    h = makeHarness();
    h.commit('staging', { 'bad.txt': 'x' }, 'culprit (#94)');
    const known = knownShas();
    onRevertVerify(known, () => { h.commit('staging', { 'fine.txt': '1' }, 'fine (#95)'); });
    expect((await h.cycle()).outcome).toBe('reverted');
    const revert = h.originRef('staging');
    // red for a reason the revert of #95 does not remove either
    h.scripted.set(revert, [false, false]);
    const realVerify = h.deps.verify;
    h.deps.verify = async (sha) => {
      if (gitSoft(h.train, ['rev-parse', `${sha}^`]).stdout === revert) return { ok: false, tail: 'still red' };
      return realVerify(sha);
    };
    const main = h.originRef('main');
    const spawnsBefore = h.spawns.length;
    expect(await h.cycle()).toMatchObject({ outcome: 'halted', reason: 'revert-not-sufficient' });
    expect(h.originRef('main')).toBe(main);
    expect(h.originRef('staging')).toBe(revert);
    expect(h.spawns.length).toBe(spawnsBefore);
    expect(h.state.pendingRevert).toBeNull();
  }, 30_000);

  it('ignores a malformed remembered culprit in the state file', () => {
    expect(normalizeTrainState({ pendingRevert: { culprit: 'not-a-sha' } } as never).pendingRevert).toBeNull();
    expect(normalizeTrainState({}).pendingRevert).toBeNull();
    const sha = 'a'.repeat(40);
    expect(normalizeTrainState({ pendingRevert: { culprit: sha, verified: 'yes', rejections: -1 } } as never).pendingRevert)
      .toEqual({ culprit: sha, verified: false, failTail: '', rejections: 0, alerted: false, redHead: null });
    expect(normalizeTrainState({ pendingRevert: { culprit: sha, redHead: 'b'.repeat(40) } } as never).pendingRevert?.redHead)
      .toBe('b'.repeat(40));
    expect(normalizeTrainState({ pendingRevert: { culprit: sha, redHead: 'HEAD' } } as never).pendingRevert?.redHead).toBeNull();
  });
});
