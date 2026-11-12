import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applySafe, buildReport, parseArgs, realDeps } from './disk-reclaim.mjs';

// Hermetic git: temp repos only, no ambient config.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

let tmp, root, dataDir, origin, main;

function commitFile(repo, name, content = name) {
  writeFileSync(join(repo, name), content);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', `add ${name}`);
}

/** Linked worktree under `root` on a new branch. */
function addWorktree(name, { merge = false } = {}) {
  const path = join(root, name);
  git(main, 'worktree', 'add', '-q', '-b', name, path, 'origin/main');
  commitFile(path, `${name}.txt`);
  if (merge) {
    git(main, 'merge', '-q', '--ff-only', name);
    git(main, 'push', '-q', 'origin', 'main');
    git(main, 'fetch', '-q', 'origin');
  }
  return path;
}

/** Shift a directory's mtime `days` into the past (negative: into the fake clock's present). */
function age(path, days) {
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, t, t);
}

// The fake clock runs 10 days ahead, so every freshly committed fixture is "idle".
const DAY = 86_400_000;
const FAKE_NOW = () => Date.now() + 10 * DAY;

function deps(over = {}) {
  return {
    ...realDeps({}),
    now: FAKE_NOW,
    df: async () => ({ device: 'fake', mount: '/', totalBytes: 100e9, freeBytes: 3e9, freePercent: 3 }),
    processCwds: async () => ({ ok: true, paths: [] }),
    fetchTasks: async () => ({ ok: true, tasks: [] }),
    dockerInfo: async () => null,
    toolCaches: async () => [],
    kookrPrune: async () => null,
    homeReview: async () => [],
    ...over,
  };
}

function opts(over = {}) {
  return { ...parseArgs([]), roots: [root], dataDir, minIdleDays: 2, minSafeBytes: 1, minReviewBytes: 1, concurrency: 4, timeoutS: 60, untilFreePercent: 100, ...over };
}

const find = (report, path) => [...report.safe, ...report.review].find((i) => i.path === path);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'disk-reclaim-test-')));
  root = join(tmp, 'root');
  dataDir = join(tmp, 'data');
  origin = join(tmp, 'origin.git');
  main = join(root, 'main');
  mkdirSync(root);
  mkdirSync(dataDir);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, main);
  git(main, 'checkout', '-q', '-b', 'main');
  commitFile(main, 'README');
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A node_modules directory with some content. */
function addNodeModules(checkout) {
  mkdirSync(join(checkout, 'node_modules'));
  writeFileSync(join(checkout, 'node_modules', 'pkg.js'), 'module.exports = 1;');
}

describe('classification', () => {
  test('a merged, clean, idle worktree is SAFE', async () => {
    const wt = addWorktree('done', { merge: true });
    const r = await buildReport(opts(), deps());
    expect(find(r, wt)).toMatchObject({ tier: 'SAFE', kind: 'worktree', branch: 'done', mainRepo: main });
  });

  test('dirty, unmerged, stashed and in-use worktrees are REVIEW', async () => {
    const dirty = addWorktree('dirty', { merge: true });
    const unmerged = addWorktree('unmerged');
    const stashed = addWorktree('stashed', { merge: true });
    const busy = addWorktree('busy', { merge: true });
    writeFileSync(join(dirty, 'wip.txt'), 'x');
    writeFileSync(join(stashed, 'README'), 'changed');
    git(stashed, 'stash', 'push', '-q', '-m', 'keep');
    const r = await buildReport(opts(), deps({ processCwds: async () => ({ ok: true, paths: [join(busy, 'sub')] }) }));
    for (const p of [dirty, unmerged, stashed, busy]) expect(find(r, p)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, dirty).reason).toMatch(/uncommitted/);
    expect(find(r, unmerged).reason).toMatch(/unpushed/);
    expect(find(r, stashed).reason).toMatch(/stash/);
    expect(find(r, busy).reason).toMatch(/in use \(process cwd/);
    expect(r.safe).toHaveLength(0);
  }, 60_000);

  test('a non-terminal Kookr task blocks SAFE; a terminal one does not', async () => {
    const busy = addWorktree('task-busy', { merge: true });
    const done = addWorktree('task-done', { merge: true });
    const tasks = [
      { id: 'a', status: 'inProgress', cwd: busy },
      { id: 'b', status: 'completed', cwd: done },
    ];
    const r = await buildReport(opts(), deps({ fetchTasks: async () => ({ ok: true, tasks }) }));
    expect(find(r, busy)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, busy).reason).toMatch(/task a/);
    expect(find(r, done)).toMatchObject({ tier: 'SAFE' });
  });

  test('an unreachable Kookr API makes nothing SAFE', async () => {
    addWorktree('done2', { merge: true });
    const r = await buildReport(opts(), deps({ fetchTasks: async () => ({ ok: false, error: 'down', tasks: [] }) }));
    expect(r.safe).toHaveLength(0);
    expect(r.inUseProbes.kookrTasks).toMatch(/failed/);
  });

  test('node_modules is SAFE when idle, and not SAFE when in use or recently active', async () => {
    const idle = addWorktree('deps-idle');
    const busy = addWorktree('deps-busy');
    const fresh = addWorktree('deps-fresh');
    for (const p of [idle, busy, fresh]) addNodeModules(p);
    age(fresh, -10); // modified "just now" on the fake clock
    const r = await buildReport(opts(), deps({ processCwds: async () => ({ ok: true, paths: [busy] }) }));
    expect(find(r, join(idle, 'node_modules'))).toMatchObject({ tier: 'SAFE', kind: 'dependencies' });
    expect(find(r, join(busy, 'node_modules'))).toBeUndefined();
    expect(find(r, join(fresh, 'node_modules'))).toBeUndefined();
    expect(find(r, busy).reason).toMatch(/in use/);
  });
});

describe('ignored files', () => {

  test('an ignored non-rebuildable file makes a merged worktree REVIEW; only node_modules/dist stays SAFE', async () => {
    writeFileSync(join(main, '.gitignore'), 'runs/\nnode_modules/\ndist/\n');
    git(main, 'add', '.gitignore');
    git(main, 'commit', '-q', '-m', 'ignore');
    git(main, 'push', '-q', 'origin', 'main');
    const holds = addWorktree('holds-ignored', { merge: true });
    const rebuildable = addWorktree('only-rebuildable', { merge: true });
    mkdirSync(join(holds, 'runs'));
    writeFileSync(join(holds, 'runs', 'result.json'), '{}');
    for (const d of ['node_modules', 'dist']) {
      mkdirSync(join(rebuildable, d));
      writeFileSync(join(rebuildable, d, 'x.js'), '1');
    }
    const r = await buildReport(opts(), deps());
    expect(find(r, holds)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, holds).reason).toMatch(/holds ignored files that would be deleted: runs\//);
    expect(find(r, rebuildable)).toMatchObject({ tier: 'SAFE', kind: 'worktree' });
  });

  test('apply refuses a worktree that gained an ignored file after the scan', async () => {
    writeFileSync(join(main, '.gitignore'), 'runs/\n');
    git(main, 'add', '.gitignore');
    git(main, 'commit', '-q', '-m', 'ignore');
    git(main, 'push', '-q', 'origin', 'main');
    const wt = addWorktree('late-ignored', { merge: true });
    const d = deps();
    const o = opts();
    const report = await buildReport(o, d);
    expect(find(report, wt)).toMatchObject({ tier: 'SAFE' });
    mkdirSync(join(wt, 'runs'));
    writeFileSync(join(wt, 'runs', 'adapter.bin'), 'precious');
    const res = await applySafe(report, o, d);
    expect(existsSync(join(wt, 'runs', 'adapter.bin'))).toBe(true);
    expect(res.actions[0].error).toMatch(/skipped: no longer SAFE.*ignored files/);
    expect(res.actions[0].command).toBeNull();
  });
});

describe('--apply safe', () => {
  test('removes only SAFE items, keeps REVIEW, deletes the merged branch, writes the audit log', async () => {
    const safe = addWorktree('apply-done', { merge: true });
    const unmerged = addWorktree('apply-unmerged');
    const withDeps = addWorktree('apply-deps');
    addNodeModules(withDeps);

    const d = deps();
    const o = opts();
    const report = await buildReport(o, d);
    expect(report.safe.map((i) => i.kind).sort()).toEqual(['dependencies', 'worktree']);
    const res = await applySafe(report, o, d);

    expect(existsSync(safe)).toBe(false);
    expect(git(main, 'branch', '--list', 'apply-done').trim()).toBe('');
    expect(existsSync(join(withDeps, 'node_modules'))).toBe(false);
    expect(existsSync(withDeps)).toBe(true); // the checkout itself stays
    expect(existsSync(unmerged)).toBe(true);
    expect(existsSync(main)).toBe(true);

    const lines = readFileSync(join(dataDir, 'disk-reclaim.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatchObject({ tier: 'SAFE', ok: true });
    expect(lines.map((l) => l.kind).sort()).toEqual(['dependencies', 'worktree']);
    expect(lines.find((l) => l.kind === 'worktree').command).toMatch(/worktree remove/);
    expect(res.freedByKind.worktree).toBeGreaterThan(0);
  });

  test('re-checks right before acting: a worktree that became in use or dirty is skipped', async () => {
    const wt = addWorktree('race-use', { merge: true });
    const wt2 = addWorktree('race-dirty', { merge: true });
    let probes = 0;
    const d = deps({
      processCwds: async () => {
        probes += 1;
        // The first call builds the report; later calls (the apply re-check) see a process in `wt`.
        return { ok: true, paths: probes > 1 ? [wt] : [] };
      },
    });
    const o = opts();
    const report = await buildReport(o, d);
    expect(report.safe).toHaveLength(2);
    writeFileSync(join(wt2, 'late.txt'), 'new work');
    const res = await applySafe(report, o, d);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(wt2)).toBe(true);
    expect(res.actions.every((a) => !a.ok && /skipped: no longer SAFE/.test(a.error))).toBe(true);
    expect(readFileSync(join(dataDir, 'disk-reclaim.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('stops once free space reaches --until-free-percent', async () => {
    const a = addWorktree('stop-a', { merge: true });
    const b = addWorktree('stop-b', { merge: true });
    const o = opts({ untilFreePercent: 10 });
    let free = 3;
    const d = deps({ df: async () => ({ device: 'f', mount: '/', totalBytes: 100e9, freeBytes: free * 1e9, freePercent: free }) });
    const report = await buildReport(o, d);
    // Each git command "frees" 8 points; the worktree removal alone pushes 3% to 11% >= 10%.
    const run = (cmd, args) => {
      if (args.includes('worktree')) free += 8;
      return Promise.resolve({ code: 0, stdout: execFileSync(cmd, args, { env: GIT_ENV, encoding: 'utf8' }), stderr: '' });
    };
    const res = await applySafe(report, o, { ...d, run });
    expect(res.actions).toHaveLength(1);
    expect([a, b].filter((p) => existsSync(p))).toHaveLength(1);
  });
});

describe('parseArgs', () => {
  test('defaults and validation', () => {
    expect(parseArgs([]).untilFreePercent).toBe(10);
    expect(parseArgs(['--apply', 'safe']).apply).toBe(true);
    expect(() => parseArgs(['--apply', 'all'])).toThrow(/safe/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown/);
  });
});
