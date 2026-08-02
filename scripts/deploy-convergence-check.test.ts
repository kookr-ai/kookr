import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  exitCodeForResult,
  makeGitRunner,
  parseArgs,
  resolveGitTarget,
  runConvergenceProbe,
  triggerRedeploy,
  type GitTarget,
} from './deploy-convergence-check.js';

const NOW = Date.parse('2026-08-02T00:01:00.000Z');
const SERVING = 'bec9bdc';
const MAIN = 'a1b2c3d';

// map: key = args.join(' ') → string|null return
function stubGit(map: Record<string, string | null>): (args: string[]) => string | null {
  return (args: string[]) => {
    const key = args.join(' ');
    return key in map ? map[key] : null;
  };
}

function healthResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

// A minimal fetch stub that routes GET /api/health to `health` and records any
// POST /api/deploy/trigger call, replying with `triggerStatus`.
function stubFetch({
  health,
  triggerStatus = 200,
}: {
  health: unknown;
  triggerStatus?: number;
}) {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = async (url: string, init?: unknown) => {
    const method = ((init as { method?: string } | undefined)?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (url.endsWith('/api/deploy/trigger')) {
      return {
        ok: triggerStatus >= 200 && triggerStatus < 300,
        status: triggerStatus,
        async json() {
          return { status: 'deploying' };
        },
      };
    }
    return healthResponse(health);
  };
  return { fetchFn: fetchFn as never, calls };
}

// ---------------------------------------------------------------------------
// resolveGitTarget — git interaction, stubbed
// ---------------------------------------------------------------------------

describe('resolveGitTarget', () => {
  test('resolves target sha, commit time, and non-ancestry', () => {
    const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
    const git = stubGit({
      'rev-parse --short origin/main': MAIN,
      'show -s --format=%ct origin/main': String(committedSec),
      [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0000`,
      // not an ancestor → merge-base --is-ancestor exits non-zero → null
      [`merge-base --is-ancestor origin/main ${SERVING}0000`]: null,
    });
    const out: GitTarget = resolveGitTarget({ git, branch: 'main', servingSha: SERVING });
    expect(out.targetSha).toBe(MAIN);
    expect(out.targetCommittedAtMs).toBe(committedSec * 1000);
    expect(out.servingIncludesTarget).toBe(false);
  });

  test('reports ancestry true when merge-base succeeds', () => {
    const git = stubGit({
      'rev-parse --short origin/main': MAIN,
      'show -s --format=%ct origin/main': '1900000000',
      [`rev-parse --quiet --verify ${MAIN}^{commit}`]: `${MAIN}0000`,
      // ancestor → exit 0 → empty string (not null)
      [`merge-base --is-ancestor origin/main ${MAIN}0000`]: '',
    });
    const out = resolveGitTarget({ git, branch: 'main', servingSha: MAIN });
    expect(out.servingIncludesTarget).toBe(true);
  });

  test('leaves ancestry null when serving commit not in worktree', () => {
    const git = stubGit({
      'rev-parse --short origin/main': MAIN,
      'show -s --format=%ct origin/main': '1900000000',
      // serving commit unknown locally → rev-parse verify returns null
    });
    const out = resolveGitTarget({ git, branch: 'main', servingSha: SERVING });
    expect(out.servingIncludesTarget).toBeNull();
    expect(out.targetSha).toBe(MAIN);
  });
});

// ---------------------------------------------------------------------------
// runConvergenceProbe — end-to-end with stubbed fetch + git
// ---------------------------------------------------------------------------

describe('runConvergenceProbe', () => {
  test('converged → exit 0, baseline cleared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const { fetchFn } = stubFetch({ health: { build: { commitShort: MAIN } } });
      const git = stubGit({
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': '1900000000',
        [`rev-parse --quiet --verify ${MAIN}^{commit}`]: `${MAIN}0`,
        [`merge-base --is-ancestor origin/main ${MAIN}0`]: '',
      });
      const result = await runConvergenceProbe({ base: 'http://x', stateFile, fetchFn, git, nowMs: NOW });
      expect(result.state).toBe('converged');
      expect(exitCodeForResult(result)).toBe(0);
      expect(result.baselineWritten).toBe(true);
      const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(persisted.divergenceSince).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('merged-but-stale prod → exit 2 and POSTs the redeploy trigger on --act', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
      const { fetchFn, calls } = stubFetch({ health: { build: { commitShort: SERVING } } });
      const git = stubGit({
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': String(committedSec),
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      const result = await runConvergenceProbe({
        base: 'http://x',
        stateFile,
        act: true,
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(result.state).toBe('divergent');
      expect(exitCodeForResult(result)).toBe(2);
      expect(result.redeployRequested).toBeTruthy();
      expect(result.redeployRequested?.branch).toBe('main');
      expect(result.redeployRequested?.reason).toMatch(/#1883/);
      expect(result.redeployRequested?.status).toBe(200);
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/deploy/trigger'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('divergent without --act does NOT trigger a redeploy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
      const { fetchFn, calls } = stubFetch({ health: { build: { commitShort: SERVING } } });
      const git = stubGit({
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': String(committedSec),
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      const result = await runConvergenceProbe({
        base: 'http://x',
        stateFile,
        act: false,
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(result.state).toBe('divergent');
      expect(exitCodeForResult(result)).toBe(2);
      expect(result.redeployRequested).toBeNull();
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a 409 from the trigger (deploy already running) is treated as success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
      const { fetchFn } = stubFetch({ health: { build: { commitShort: SERVING } }, triggerStatus: 409 });
      const git = stubGit({
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': String(committedSec),
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      const result = await runConvergenceProbe({
        base: 'http://x',
        stateFile,
        act: true,
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(result.redeployRequested?.status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('probe gap (no sha on /api/health) → exit 1, no baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const { fetchFn } = stubFetch({ health: { status: 'ok' } }); // no build sha
      const git = stubGit({
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': '1900000000',
      });
      const result = await runConvergenceProbe({ base: 'http://x', stateFile, fetchFn, git, nowMs: NOW });
      expect(result.ok).toBe(false);
      expect(exitCodeForResult(result)).toBe(1);
      expect(result.baselineWritten).toBe(false);
      expect(existsSync(stateFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dev build (commitShort=dev) is an un-checkable gap → exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const { fetchFn } = stubFetch({ health: { build: { commitShort: 'dev', commitHash: 'dev' } } });
      const git = stubGit({ 'rev-parse --short origin/main': MAIN, 'show -s --format=%ct origin/main': '1900000000' });
      const result = await runConvergenceProbe({ base: 'http://x', stateFile, fetchFn, git, nowMs: NOW });
      expect(result.ok).toBe(false);
      expect(exitCodeForResult(result)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run classifies without writing baseline or acting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
      const { fetchFn, calls } = stubFetch({ health: { build: { commitShort: SERVING } } });
      const git = stubGit({
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': String(committedSec),
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      const result = await runConvergenceProbe({
        base: 'http://x',
        stateFile,
        act: true,
        dryRun: true,
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(result.state).toBe('divergent');
      expect(result.baselineWritten).toBe(false);
      expect(result.redeployRequested).toBeNull();
      expect(existsSync(stateFile)).toBe(false);
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('HTTP error on /api/health → throws (main() maps to exit 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const fetchFn = (async () => ({ ok: false, status: 503, async json() {} })) as never;
      const outcome = await runConvergenceProbe({
        base: 'http://x',
        stateFile,
        fetchFn,
        git: stubGit({}),
        nowMs: NOW,
      }).then(
        (r) => ({ threw: false as const, r }),
        (err: unknown) => ({ threw: true as const, err }),
      );
      expect(outcome.threw).toBe(true);
      if (outcome.threw) {
        expect((outcome.err as Error).message).toMatch(/503/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('triggerRedeploy', () => {
  test('throws on a non-2xx, non-409 trigger response', async () => {
    const fetchFn = (async () => ({ ok: false, status: 500, async json() { return {}; } })) as never;
    await expect(
      triggerRedeploy({ base: 'http://x', branch: 'main', reason: 'x', fetchFn, nowMs: NOW }),
    ).rejects.toThrow(/500/);
  });
});

describe('exitCodeForResult', () => {
  test('maps null/unknown → 1', () => {
    expect(exitCodeForResult(null)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// git fetch freshness (correctness review F1) — the probe must refresh the
// remote-tracking ref before comparing, or a stale origin/<branch> falsely
// reports "converged".
// ---------------------------------------------------------------------------

describe('runConvergenceProbe remote refresh', () => {
  // A git stub that records every invocation so we can assert the fetch.
  function trackingGit(map: Record<string, string | null>) {
    const gitCalls: string[] = [];
    const git = (args: string[]) => {
      const key = args.join(' ');
      gitCalls.push(key);
      return key in map ? map[key] : null;
    };
    return { git, gitCalls };
  }

  const convergedMap = {
    'fetch --quiet origin main': '',
    'rev-parse --short origin/main': MAIN,
    'show -s --format=%ct origin/main': '1900000000',
    [`rev-parse --quiet --verify ${MAIN}^{commit}`]: `${MAIN}0`,
    [`merge-base --is-ancestor origin/main ${MAIN}0`]: '',
  };

  test('fetches origin/<branch> before resolving the target by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const { fetchFn } = stubFetch({ health: { build: { commitShort: MAIN } } });
      const { git, gitCalls } = trackingGit(convergedMap);
      await runConvergenceProbe({
        base: 'http://x',
        stateFile: join(dir, 'baseline.json'),
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(gitCalls[0]).toBe('fetch --quiet origin main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refreshRemote:false skips the fetch (offline / already-fetched)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const { fetchFn } = stubFetch({ health: { build: { commitShort: MAIN } } });
      const { git, gitCalls } = trackingGit(convergedMap);
      await runConvergenceProbe({
        base: 'http://x',
        stateFile: join(dir, 'baseline.json'),
        refreshRemote: false,
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(gitCalls.some((c) => c.startsWith('fetch'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-tick baseline loop (test review F2) — divergence age must accrue from a
// persisted baseline when the merge commit time is unavailable, and the diverged
// baseline must be rewritten.
// ---------------------------------------------------------------------------

describe('runConvergenceProbe baseline persistence', () => {
  test('divergence age accrues from a pre-existing baseline; diverged baseline is rewritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      // Seed a baseline observed 40m ago, same target as origin/main now.
      writeFileSync(
        stateFile,
        JSON.stringify({
          targetSha: MAIN,
          divergenceSince: new Date(NOW - 40 * 60_000).toISOString(),
          state: 'divergent',
        }),
      );
      const { fetchFn } = stubFetch({ health: { build: { commitShort: SERVING } } });
      // No committer time available (show -s returns null) → classifier must
      // fall back to the persisted baseline's divergenceSince.
      const git = stubGit({
        'fetch --quiet origin main': '',
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': null,
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      const result = await runConvergenceProbe({ base: 'http://x', stateFile, fetchFn, git, nowMs: NOW });
      expect(result.state).toBe('divergent');
      expect(result.divergenceAgeMinutes).toBe(40);
      expect(result.baselineWritten).toBe(true);
      const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(persisted.targetSha).toBe(MAIN);
      expect(persisted.divergenceSince).toBe(new Date(NOW - 40 * 60_000).toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt baseline degrades to null instead of throwing (correctness review F4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      writeFileSync(stateFile, '{ this is not json');
      const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
      const { fetchFn } = stubFetch({ health: { build: { commitShort: SERVING } } });
      const git = stubGit({
        'fetch --quiet origin main': '',
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': String(committedSec),
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      // Must not throw; classifies from the merge time and overwrites the file.
      const result = await runConvergenceProbe({ base: 'http://x', stateFile, fetchFn, git, nowMs: NOW });
      expect(result.state).toBe('divergent');
      expect(result.baselineWritten).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Failed redeploy trigger (correctness review F2) — must stay DIVERGENT (exit 2)
// and record the error, NOT collapse to a "transient blip" exit 1.
// ---------------------------------------------------------------------------

describe('runConvergenceProbe redeploy failure', () => {
  test('a failing trigger under --act keeps exit 2 and records redeployError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      const stateFile = join(dir, 'baseline.json');
      const committedSec = Math.floor((NOW - 40 * 60_000) / 1000);
      const { fetchFn } = stubFetch({ health: { build: { commitShort: SERVING } }, triggerStatus: 500 });
      const git = stubGit({
        'fetch --quiet origin main': '',
        'rev-parse --short origin/main': MAIN,
        'show -s --format=%ct origin/main': String(committedSec),
        [`rev-parse --quiet --verify ${SERVING}^{commit}`]: `${SERVING}0`,
        [`merge-base --is-ancestor origin/main ${SERVING}0`]: null,
      });
      const result = await runConvergenceProbe({
        base: 'http://x',
        stateFile,
        act: true,
        fetchFn,
        git,
        nowMs: NOW,
      });
      expect(result.state).toBe('divergent');
      expect(exitCodeForResult(result)).toBe(2); // NOT swallowed to exit 1
      expect(result.redeployRequested).toBeNull();
      expect(result.redeployError).toMatch(/500/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs (test review F3) — flag parsing + grace validation guard
// (correctness review F3).
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('parses flags and strips a trailing slash from --base', () => {
    const a = parseArgs(['--act', '--no-fetch', '--branch', 'release', '--base', 'http://h:9/', '--grace-minutes', '30']);
    expect(a.act).toBe(true);
    expect(a.noFetch).toBe(true);
    expect(a.branch).toBe('release');
    expect(a.base).toBe('http://h:9');
    expect(a.thresholds.divergenceGraceMinutes).toBe(30);
    expect(a.stateFile).toMatch(/baseline\.json$/);
  });

  test('rejects a non-numeric --grace-minutes → keeps the default (no NaN)', () => {
    const a = parseArgs(['--grace-minutes', 'soon']);
    expect(a.thresholds.divergenceGraceMinutes).toBeUndefined();
  });

  test('rejects a negative --grace-minutes', () => {
    const a = parseArgs(['--grace-minutes', '-5']);
    expect(a.thresholds.divergenceGraceMinutes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real git runner (test review F1) — exercise makeGitRunner + resolveGitTarget
// against an actual temp repo so the "'' on success / null on failure" contract
// that all ancestry logic hinges on is verified, not just stubbed. Uses a
// mkdtemp repo (never the shared config) per the vitest git-repo-guard.
// ---------------------------------------------------------------------------

describe('makeGitRunner + resolveGitTarget against a real repo', () => {
  function initRepo(dir: string) {
    const git = makeGitRunner(dir);
    git(['init', '--quiet']);
    // Identity is passed per-commit so nothing touches the shared git config.
    const commit = (msg: string) =>
      git(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', msg]);
    return { git, commit };
  }

  test('ancestry true when serving includes origin/main; false when it does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-git-'));
    try {
      const { git, commit } = initRepo(dir);
      commit('A');
      const shaA = git(['rev-parse', 'HEAD']) as string;
      commit('B');
      const shaBShort = git(['rev-parse', '--short', 'HEAD']) as string;

      // origin/main = A (an ancestor of B). Serving = B → converged.
      git(['update-ref', 'refs/remotes/origin/main', shaA]);
      const included = resolveGitTarget({ git, branch: 'main', servingSha: shaBShort });
      expect(included.targetSha).toBeTruthy();
      expect(included.targetCommittedAtMs).toBeGreaterThan(0);
      expect(included.servingIncludesTarget).toBe(true);

      // origin/main = B, serving = A (A does NOT include B) → divergent.
      const shaAShort = git(['rev-parse', '--short', shaA]) as string;
      const shaB = git(['rev-parse', 'HEAD']) as string;
      git(['update-ref', 'refs/remotes/origin/main', shaB]);
      const missing = resolveGitTarget({ git, branch: 'main', servingSha: shaAShort });
      expect(missing.servingIncludesTarget).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ancestry is null when the serving commit is absent from the worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-git-'));
    try {
      const { git, commit } = initRepo(dir);
      commit('A');
      const shaA = git(['rev-parse', 'HEAD']) as string;
      git(['update-ref', 'refs/remotes/origin/main', shaA]);
      // A serving SHA that does not exist in this repo → rev-parse verify fails
      // → ancestry undecidable (null), classifier falls back to SHA identity.
      const out = resolveGitTarget({ git, branch: 'main', servingSha: 'deadbee' });
      expect(out.targetSha).toBeTruthy();
      expect(out.servingIncludesTarget).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: makeGitRunner must target `dir` even when the ambient
  // environment exports GIT_DIR/GIT_WORK_TREE (as git hook processes like
  // .hooks/pre-push do). GIT_DIR overrides `-C <dir>` for repo discovery, so an
  // unscrubbed runner would commit into the *parent* repo — exactly how PR
  // #1891 picked up stray "A"/"B" commits from this suite when it ran under the
  // pre-push hook. The runner scrubs GIT_DIR/GIT_WORK_TREE, so the decoy stays
  // empty and the target repo gets the commit.
  test('ignores an ambient GIT_DIR/GIT_WORK_TREE (does not leak into a parent repo)', () => {
    const target = mkdtempSync(join(tmpdir(), 'conv-git-target-'));
    const decoy = mkdtempSync(join(tmpdir(), 'conv-git-decoy-'));
    const savedGitDir = process.env.GIT_DIR;
    const savedWorkTree = process.env.GIT_WORK_TREE;
    try {
      makeGitRunner(target)(['init', '--quiet']);
      makeGitRunner(decoy)(['init', '--quiet']);

      // Simulate the hook environment: point the ambient GIT_DIR at the decoy.
      process.env.GIT_DIR = join(decoy, '.git');
      process.env.GIT_WORK_TREE = decoy;

      // Runner captures (scrubbed) env at creation; build it AFTER setting the
      // ambient vars so the test proves the scrub, not creation-time absence.
      const git = makeGitRunner(target);
      git(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'X']);

      // The commit landed in `target`, and the decoy (ambient GIT_DIR) is empty.
      expect(git(['rev-parse', 'HEAD'])).toBeTruthy();
      expect(makeGitRunner(decoy)(['rev-parse', 'HEAD'])).toBeNull();
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
      if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedWorkTree;
      rmSync(target, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});
