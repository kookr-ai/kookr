import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { applySafe, buildReport, buildUsage, isLiveTask, isRebuildableIgnored, parseArgs, realDeps, resolveApiBase, setExecEnvForTests } from './disk-reclaim.mjs';

// Hermetic git: temp repos only, no ambient config (also injected into the script's own git calls).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
const DAY = 86_400_000;
// The fake clock runs 10 days ahead, so every freshly committed fixture is "idle".
const FAKE_NOW = () => Date.now() + 10 * DAY;

let tmp, root, dataDir, origin, main;

beforeAll(() => setExecEnvForTests(GIT_ENV));
afterAll(() => setExecEnvForTests({}));

function commitFile(repo, name, content = name) {
  writeFileSync(join(repo, name), content);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', `add ${name}`);
}

/** Linked worktree under `root` on a new branch with one commit; optionally merged into origin/main. */
function addWorktree(name, { merge = false } = {}) {
  const path = join(root, name);
  git(main, 'worktree', 'add', '-q', '-b', name, path, 'origin/main');
  commitFile(path, `${name}.txt`);
  if (merge) mergeBranch(name);
  return path;
}

function mergeBranch(name) {
  git(main, 'merge', '-q', '--ff-only', name);
  git(main, 'push', '-q', 'origin', 'main');
  git(main, 'fetch', '-q', 'origin');
}

/** Shift a directory's mtime `days` into the past (negative: into the fake clock's present). */
function age(path, days) {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}

/** node_modules with content; package.json and a lockfile unless disabled. */
function addNodeModules(checkout, { pkg = true, lock = true } = {}) {
  mkdirSync(join(checkout, 'node_modules'));
  writeFileSync(join(checkout, 'node_modules', 'pkg.js'), 'module.exports = 1;');
  if (pkg) writeFileSync(join(checkout, 'package.json'), '{}');
  if (lock) writeFileSync(join(checkout, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
}

function deps(over = {}) {
  return {
    ...realDeps({}),
    now: FAKE_NOW,
    df: async () => ({ device: 'fake', mount: '/', totalBytes: 100e9, freeBytes: 3e9, freePercent: 3 }),
    processCwds: async () => ({ ok: true, paths: [] }),
    fetchTasks: async () => ({ ok: true, tasks: [] }),
    runningInstalls: async () => ({ ok: true, procs: [] }),
    dockerInfo: async () => null,
    toolCaches: async () => [],
    kookrPrune: async () => null,
    homeReview: async () => [],
    ...over,
  };
}

function opts(over = {}) {
  return { ...parseArgs([], {}, tmp), roots: [root], dataDir, minIdleDays: 2, minSafeBytes: 1, minReviewBytes: 1, concurrency: 4, timeoutS: 60, untilFreePercent: 100, ...over };
}

const find = (report, path) => [...report.safe, ...report.review].find((i) => i.path === path);
const runReal = (cmd, args) => Promise.resolve({ code: 0, stdout: execFileSync(cmd, args, { env: GIT_ENV, encoding: 'utf8' }), stderr: '' });
const readLog = () => readFileSync(join(dataDir, 'disk-reclaim.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'disk-reclaim-test-')));
  root = join(tmp, 'root');
  dataDir = join(tmp, 'data');
  origin = join(tmp, 'origin.git');
  main = join(root, 'main');
  mkdirSync(root);
  mkdirSync(dataDir);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'remote', 'add', 'origin', origin);
  commitFile(main, 'README');
  commitFile(main, '.gitignore', 'runs/\nnode_modules/\ndist/\n*.ckpt\n*.log\n.cache/\ndata/out/\n');
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('classification', () => {
  test('a merged, clean, idle worktree is SAFE', async () => {
    const wt = addWorktree('done', { merge: true });
    const r = await buildReport(opts(), deps());
    expect(find(r, wt)).toMatchObject({ tier: 'SAFE', kind: 'worktree', branch: 'done', mainRepo: main });
  });

  test('main checkouts and plain directories are never SAFE as worktrees', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'a.txt'), 'x');
    const r = await buildReport(opts(), deps());
    expect(r.safe.filter((i) => i.kind === 'worktree')).toHaveLength(0);
    expect(find(r, main)).toMatchObject({ tier: 'REVIEW', kind: 'checkout' });
    expect(find(r, plain)).toMatchObject({ tier: 'REVIEW', kind: 'directory' });
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

  test('detached HEAD: merged is SAFE without a branch, unmerged is REVIEW', async () => {
    const merged = join(root, 'det-merged');
    const unmerged = join(root, 'det-unmerged');
    git(main, 'worktree', 'add', '-q', '--detach', merged, 'origin/main');
    git(main, 'worktree', 'add', '-q', '--detach', unmerged, 'origin/main');
    commitFile(unmerged, 'extra.txt');
    const r = await buildReport(opts(), deps());
    expect(find(r, merged)).toMatchObject({ tier: 'SAFE', branch: null });
    expect(find(r, unmerged)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, unmerged).reason).toMatch(/unpushed/);
  });

  test('upstream gone is SAFE; a branch merely NAMED like "gone" is not', async () => {
    const gone = addWorktree('squash-merged');
    git(gone, 'push', '-q', '-u', 'origin', 'squash-merged');
    git(main, 'push', '-q', 'origin', '--delete', 'squash-merged');
    git(main, 'fetch', '-q', '--prune', 'origin');
    const badge = addWorktree('fix-gone-badge');
    git(badge, 'branch', '-u', 'origin/main');
    const r = await buildReport(opts(), deps());
    expect(find(r, gone)).toMatchObject({ tier: 'SAFE' });
    expect(find(r, gone).reason).toMatch(/upstream branch gone/);
    expect(find(r, badge)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, badge).reason).toMatch(/unpushed/);
  });

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

  test('a live task occupies its session cwds, not just task.cwd', async () => {
    const sibling = addWorktree('task-sibling', { merge: true });
    const tasks = [{ id: 's', status: 'inProgress', cwd: main, sessionCwds: [sibling] }];
    const r = await buildReport(opts(), deps({ fetchTasks: async () => ({ ok: true, tasks }) }));
    expect(find(r, sibling)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, sibling).reason).toMatch(/task s/);
  });

  test('terminated tasks count as live only when crash recovery relaunches them', () => {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    expect(isLiveTask({ status: 'terminated', terminationReason: 'server-restart', terminatedAt: iso(now - DAY) }, now)).toBe(true);
    expect(isLiveTask({ status: 'terminated', terminationReason: 'server-restart', terminatedAt: iso(now - 30 * DAY) }, now)).toBe(false);
    expect(isLiveTask({ status: 'terminated', terminationReason: 'manual', terminatedAt: iso(now) }, now)).toBe(false);
    expect(isLiveTask({ status: 'completed' }, now)).toBe(false);
    expect(isLiveTask({ status: 'pending' }, now)).toBe(true);
  });

  test('an unreachable Kookr API or a failed process probe makes nothing SAFE, caches and Kookr data included', async () => {
    addWorktree('done2', { merge: true });
    const extras = {
      toolCaches: async () => [{ tool: 'npm', dir: tmp, bytes: 10, command: ['npm', 'cache', 'clean', '--force'], estimate: 'exact' }],
      kookrPrune: async () => ({ bytes: 100, command: ['kookr', 'maintenance', 'prune'] }),
    };
    for (const broken of [
      { fetchTasks: async () => ({ ok: false, error: 'down', tasks: [] }) },
      { processCwds: async () => ({ ok: false, paths: [], error: 'no /proc' }) },
      { processCwds: async () => { throw new Error('boom'); } },
    ]) {
      const r = await buildReport(opts(), deps({ ...extras, ...broken }));
      expect(r.safe).toHaveLength(0);
      expect(r.review.some((i) => i.kind === 'tool-cache' && /unknown/.test(i.reason))).toBe(true);
      expect(r.review.some((i) => i.kind === 'kookr-data' && /unknown/.test(i.reason))).toBe(true);
    }
  });

  test('tool caches are SAFE only with no live task and no package manager running', async () => {
    const cache = { tool: 'npm', dir: tmp, bytes: 10, command: ['npm', 'cache', 'clean', '--force'], estimate: 'exact' };
    const base = { toolCaches: async () => [cache] };
    const clean = await buildReport(opts(), deps(base));
    expect(clean.safe.map((i) => i.kind)).toContain('tool-cache');
    const live = await buildReport(opts(), deps({ ...base, fetchTasks: async () => ({ ok: true, tasks: [{ id: 'x', status: 'inProgress', cwd: '/nowhere' }] }) }));
    expect(live.review.find((i) => i.kind === 'tool-cache').reason).toMatch(/live Kookr task/);
    const installing = await buildReport(opts(), deps({ ...base, runningInstalls: async () => ({ ok: true, procs: ['pnpm install'] }) }));
    expect(installing.review.find((i) => i.kind === 'tool-cache').reason).toMatch(/package manager running/);
  });

  test('Kookr data: default-age prune is SAFE, the lowered-age extra is REVIEW only', async () => {
    const kookrPrune = async (_dir, { lowered }) => ({ bytes: lowered ? 1000 : 100, command: ['kookr', 'maintenance', 'prune', lowered ? '--max-age-days' : '--dir'] });
    const r = await buildReport(opts(), deps({ kookrPrune }));
    expect(r.safe.find((i) => i.kind === 'kookr-data').bytes).toBe(100);
    const extra = r.review.find((i) => i.kind === 'kookr-data-aggressive');
    expect(extra.bytes).toBe(900);
    expect(extra.reason).toMatch(/finished-task history/);
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

  test('node_modules needs package.json, a lockfile, and must be untracked', async () => {
    const noLock = addWorktree('nm-nolock');
    const noPkg = addWorktree('nm-nopkg');
    const tracked = addWorktree('nm-tracked');
    addNodeModules(noLock, { lock: false });
    addNodeModules(noPkg, { pkg: false });
    addNodeModules(tracked);
    git(tracked, 'add', '-f', 'node_modules/pkg.js');
    git(tracked, 'commit', '-q', '-m', 'track node_modules');
    writeFileSync(join(tracked, 'node_modules', 'pkg.js'), 'LOCAL EDIT');
    const r = await buildReport(opts(), deps());
    for (const p of [noLock, noPkg, tracked]) expect(find(r, join(p, 'node_modules'))).toBeUndefined();
    expect(find(r, noLock).reason).toMatch(/no lockfile/);
    expect(find(r, noPkg).reason).toMatch(/no package\.json/);
    expect(find(r, tracked).reason).toMatch(/tracked by git/);
    expect(find(r, tracked).reason).toMatch(/uncommitted/); // tracked node_modules edits are not hidden from the dirty check
  });

  test('a symlinked node_modules is never a dependencies item', async () => {
    const wt = addWorktree('nm-link');
    const outside = join(tmp, 'elsewhere');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.js'), 'x');
    symlinkSync(outside, join(wt, 'node_modules'));
    writeFileSync(join(wt, 'package.json'), '{}');
    writeFileSync(join(wt, 'package-lock.json'), '{}');
    const r = await buildReport(opts(), deps());
    expect(r.safe.filter((i) => i.kind === 'dependencies')).toHaveLength(0);
  });

  test('locked worktrees are REVIEW', async () => {
    const wt = addWorktree('locked-wt', { merge: true });
    git(main, 'worktree', 'lock', wt);
    const r = await buildReport(opts(), deps());
    expect(find(r, wt)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, wt).reason).toMatch(/locked/);
  });
});

describe('ignored files and hidden edits', () => {
  test('rebuildable detection is directory-only and first-component based', () => {
    expect(isRebuildableIgnored('node_modules/')).toBe(true);
    expect(isRebuildableIgnored('packages/a/node_modules/')).toBe(true);
    expect(isRebuildableIgnored('dist/')).toBe(true);
    expect(isRebuildableIgnored('data/dist/')).toBe(false);
    expect(isRebuildableIgnored('out/model.ckpt')).toBe(false);
    expect(isRebuildableIgnored('eval.log')).toBe(false);
    expect(isRebuildableIgnored('.eslintcache')).toBe(false);
    expect(isRebuildableIgnored('tsconfig.tsbuildinfo')).toBe(false);
  });

  test('ignored content makes a merged worktree REVIEW; only node_modules/dist stays SAFE', async () => {
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

  test.each([
    ['an ignored file under a rebuildable-looking directory', 'out/model.ckpt', 'out/model.ckpt'],
    ['an ignored directory nested below a normal one', 'data/out/x.bin', 'data/out/'],
    ['an ignored log file', 'eval.log', 'eval.log'],
  ])('%s is content, so REVIEW', async (_label, file, shown) => {
    const wt = addWorktree('ign-case', { merge: true });
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), 'x');
    const r = await buildReport(opts(), deps());
    expect(find(r, wt)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, wt).reason).toContain(shown);
  });

  test('a nested worktree inside an ignored .cache/ directory makes the parent REVIEW', async () => {
    const parent = addWorktree('nest-parent', { merge: true });
    git(main, 'worktree', 'add', '-q', '-b', 'nest-child', join(parent, '.cache', 'wt'), 'origin/main');
    writeFileSync(join(parent, '.cache', 'wt', 'wip.txt'), 'uncommitted');
    const r = await buildReport(opts(), deps());
    expect(find(r, parent)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, parent).reason).toMatch(/nested \.git/);
  });

  test.each([
    ['skip-worktree', '--skip-worktree'],
    ['assume-unchanged', '--assume-unchanged'],
  ])('%s edits are invisible to git status but still send the worktree to REVIEW', async (_label, flag) => {
    const wt = addWorktree(`hidden${flag.replace(/-/g, '')}`, { merge: true });
    git(wt, 'update-index', flag, 'README');
    writeFileSync(join(wt, 'README'), 'local only edit');
    expect(git(wt, 'status', '--porcelain').trim()).toBe('');
    const r = await buildReport(opts(), deps());
    expect(find(r, wt)).toMatchObject({ tier: 'REVIEW' });
    expect(find(r, wt).reason).toMatch(/hidden by skip-worktree\/assume-unchanged: README/);
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

    const lines = readLog();
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatchObject({ tier: 'SAFE', ok: true });
    expect(lines.map((l) => l.kind).sort()).toEqual(['dependencies', 'worktree']);
    expect(lines.find((l) => l.kind === 'worktree').command).toMatch(/worktree remove/);
    expect(lines.find((l) => l.kind === 'worktree').command).not.toMatch(/--force/);
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
    expect(res.actions).toHaveLength(2);
    for (const a of res.actions) expect(a).toMatchObject({ ok: false, command: null });
    expect(res.actions.find((a) => a.path === wt).error).toMatch(/skipped: no longer SAFE.*in use/);
    expect(res.actions.find((a) => a.path === wt2).error).toMatch(/skipped: no longer SAFE.*uncommitted/);
    expect(readLog()).toHaveLength(2);
  });

  test('refuses a worktree that gained an ignored file, or a hidden edit, after the scan', async () => {
    const ignoredLate = addWorktree('late-ignored', { merge: true });
    const hiddenLate = addWorktree('late-hidden', { merge: true });
    const d = deps();
    const o = opts();
    const report = await buildReport(o, d);
    expect(report.safe).toHaveLength(2);
    mkdirSync(join(ignoredLate, 'runs'));
    writeFileSync(join(ignoredLate, 'runs', 'adapter.bin'), 'precious');
    git(hiddenLate, 'update-index', '--skip-worktree', 'README');
    writeFileSync(join(hiddenLate, 'README'), 'secret edit');
    const res = await applySafe(report, o, d);
    expect(existsSync(join(ignoredLate, 'runs', 'adapter.bin'))).toBe(true);
    expect(readFileSync(join(hiddenLate, 'README'), 'utf8')).toBe('secret edit');
    expect(res.actions).toHaveLength(2);
    expect(res.actions.find((a) => a.path === ignoredLate).error).toMatch(/skipped: no longer SAFE.*ignored files/);
    expect(res.actions.find((a) => a.path === hiddenLate).error).toMatch(/skipped: no longer SAFE.*hidden/);
  });

  test('stops once free space reaches --until-free-percent', async () => {
    const a = addWorktree('stop-a', { merge: true });
    const b = addWorktree('stop-b', { merge: true });
    const o = opts({ untilFreePercent: 10 });
    let free = 3;
    const d = deps({ df: async () => ({ device: 'f', mount: '/', totalBytes: 100e9, freeBytes: free * 1e9, freePercent: free }) });
    const report = await buildReport(o, d);
    // The worktree removal alone "frees" 8 points: 3% to 11% >= 10%.
    const run = (cmd, args) => {
      if (args.includes('worktree')) free += 8;
      return runReal(cmd, args);
    };
    const res = await applySafe(report, o, { ...d, run });
    expect(res.actions).toHaveLength(1);
    expect([a, b].filter((p) => existsSync(p))).toHaveLength(1);
  });

  test('tool-cache and kookr-data run their command via the injected runner; caches go last; a non-zero exit is logged', async () => {
    const wt = addWorktree('order-wt', { merge: true });
    const toolCaches = async () => [{ tool: 'npm', dir: tmp, bytes: 9_999_999, command: ['npm', 'cache', 'clean', '--force'], estimate: 'exact' }];
    const kookrPrune = async (_d, { lowered }) => (lowered ? null : { bytes: 50, command: ['kookr', 'maintenance', 'prune', '--dir', dataDir] });
    const d = deps({ toolCaches, kookrPrune });
    const o = opts();
    const report = await buildReport(o, d);
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'kookr') return Promise.resolve({ code: 2, stdout: '', stderr: 'prune exploded' });
      if (cmd === 'npm') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return runReal(cmd, args);
    };
    const res = await applySafe(report, o, { ...d, run });
    expect(calls[calls.length - 1]).toBe('npm cache clean --force'); // cache last despite being the biggest item
    expect(calls.some((c) => c.startsWith('kookr maintenance prune --dir'))).toBe(true);
    const k = res.actions.find((a) => a.kind === 'kookr-data');
    expect(k).toMatchObject({ ok: false });
    expect(k.error).toMatch(/kookr failed: prune exploded/);
    expect(res.actions.find((a) => a.kind === 'tool-cache')).toMatchObject({ ok: true, command: 'npm cache clean --force' });
    expect(existsSync(wt)).toBe(false);
    expect(readLog()).toHaveLength(3);
  });

  test('a cache is skipped at apply time if a live task appeared since the scan', async () => {
    const toolCaches = async () => [{ tool: 'npm', dir: tmp, bytes: 9, command: ['npm', 'cache', 'clean', '--force'], estimate: 'exact' }];
    let calls = 0;
    const d = deps({ toolCaches, fetchTasks: async () => ({ ok: true, tasks: ++calls > 1 ? [{ id: 'n', status: 'pending', cwd: '/x' }] : [] }) });
    const o = opts();
    const report = await buildReport(o, d);
    const res = await applySafe(report, o, { ...d, run: () => { throw new Error('must not run'); } });
    expect(res.actions[0].error).toMatch(/skipped: not SAFE now: 1 live Kookr task/);
  });

  test('worktree remove failing is logged as not ok and leaves the tree; branch -d failing is only a note', async () => {
    const wt = addWorktree('fail-remove', { merge: true });
    const wt2 = addWorktree('fail-branch', { merge: true });
    const d = deps();
    const o = opts();
    const report = await buildReport(o, d);
    const run = (cmd, args) => {
      if (args.includes('remove') && args.includes(wt)) return Promise.resolve({ code: 1, stdout: '', stderr: 'locked by someone' });
      if (args.includes('branch')) return Promise.resolve({ code: 1, stdout: '', stderr: 'not fully merged' });
      return runReal(cmd, args);
    };
    const res = await applySafe(report, o, { ...d, run });
    expect(existsSync(wt)).toBe(true);
    expect(res.actions.find((a) => a.path === wt)).toMatchObject({ ok: false });
    expect(res.actions.find((a) => a.path === wt).error).toMatch(/git worktree remove failed: locked by someone/);
    expect(existsSync(wt2)).toBe(false);
    const ok = res.actions.find((a) => a.path === wt2);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.note).toMatch(/branch kept/);
  });

  test('refuses forged items: outside the roots, or a symlinked node_modules', async () => {
    const outside = join(tmp, 'outside');
    git(main, 'worktree', 'add', '-q', '-b', 'outside-branch', outside, 'origin/main');
    const linkTarget = join(tmp, 'link-target');
    mkdirSync(linkTarget);
    writeFileSync(join(linkTarget, 'precious.js'), 'x');
    const wt = addWorktree('nm-link2');
    symlinkSync(linkTarget, join(wt, 'node_modules'));
    const forged = {
      safe: [
        { tier: 'SAFE', kind: 'worktree', path: outside, bytes: 5, branch: 'outside-branch', mainRepo: main },
        { tier: 'SAFE', kind: 'dependencies', path: join(wt, 'node_modules'), checkoutPath: wt, bytes: 4 },
        { tier: 'REVIEW', kind: 'worktree', path: wt, bytes: 3, mainRepo: main },
      ],
    };
    const res = await applySafe(forged, opts(), deps());
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(linkTarget, 'precious.js'))).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(res.actions).toHaveLength(3);
    expect(res.actions.every((a) => !a.ok)).toBe(true);
    expect(res.actions[0].error).toMatch(/not a direct child of a scanned root/);
    expect(res.actions[1].error).toMatch(/skipped: no longer SAFE/);
    expect(res.actions[2].error).toMatch(/not tier SAFE/);
  });
});

describe('options and probes', () => {
  test('defaults and validation', () => {
    expect(parseArgs([], {}, tmp).untilFreePercent).toBe(10);
    expect(parseArgs(['--apply', 'safe'], {}, tmp).apply).toBe(true);
    expect(() => parseArgs(['--apply', 'all'], {}, tmp)).toThrow(/safe/);
    expect(() => parseArgs(['--bogus'], {}, tmp)).toThrow(/Unknown/);
  });

  test('--roots refuses /, the home directory, the data dir and parents of ~/.ssh or ~/.config', () => {
    const home = join(tmp, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    for (const bad of ['/', home, join(home, '.kookr'), '~']) {
      expect(() => parseArgs(['--roots', bad], {}, home)).toThrow(/refusing --roots/);
    }
    expect(() => parseArgs(['--roots', '~/git'], {}, home)).not.toThrow();
  });

  test('the API port must match the data dir, otherwise fail closed', () => {
    expect(resolveApiBase({}, '/h/.kookr')).toEqual({ base: 'http://127.0.0.1:4800' });
    expect(resolveApiBase({}, '/h/.kookr-4801')).toEqual({ base: 'http://127.0.0.1:4801' });
    expect(resolveApiBase({ KOOKR_PORT: '4801' }, '/h/.kookr-4801')).toEqual({ base: 'http://127.0.0.1:4801' });
    expect(resolveApiBase({ KOOKR_PORT: '4801' }, '/h/.kookr').error).toMatch(/does not match/);
    expect(resolveApiBase({ KOOKR_API_BASE_URL: 'http://127.0.0.1:4900' }, '/h/.kookr').error).toMatch(/does not match/);
    expect(resolveApiBase({}, '/tmp/custom-data').error).toMatch(/no KOOKR_PORT/);
    expect(resolveApiBase({ KOOKR_PORT: '4900' }, '/tmp/custom-data')).toEqual({ base: 'http://127.0.0.1:4900' });
    expect(resolveApiBase({ KOOKR_PORT: 'auto' }, '/h/.kookr').error).toMatch(/not numeric/);
  });

  test('buildUsage reports unknown when a probe failed', () => {
    const u = buildUsage({ ok: true, paths: [] }, { ok: false, error: 'down', tasks: [] });
    expect(u.inUse('/x')).toMatchObject({ state: 'unknown' });
    expect(u.unknown).toBe(true);
  });
});
