import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SHA_RE, cleanGitEnv, createSnapshotManager, resolveDefaultBranchSha, snapshotKey } from './snapshots.js';

let work: string;
let repo: string;
let root: string;

// Every git call targets the temp repo explicitly (-C) and carries an inline identity, so
// nothing touches the ambient checkout or any shared git config.
function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: cleanGitEnv() }).trim();
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'delegation-snap-'));
  repo = join(work, 'repo');
  root = join(work, 'snapshots');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: cleanGitEnv() });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const manager = (log: string[] = []) =>
  createSnapshotManager({ root, projects: { proj: { repoDir: repo, githubRepo: 'o/n' } }, log: (l) => log.push(l) });

describe('snapshots', () => {
  test('creates <root>/<project>/<sha> with tracked files only and no .git', async () => {
    writeFileSync(join(repo, 'untracked-secret.env'), 'TOKEN=abc');
    writeFileSync(join(repo, 'ignored.txt'), 'nope');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2; // uncommitted edit\n');
    const snap = await manager().ensureCurrent('proj');
    expect(snap.sha).toBe(git('rev-parse', 'main'));
    expect(snap.dir).toBe(join(root, 'proj', snap.sha));
    expect(readFileSync(join(snap.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n'); // committed content, not the working tree
    expect(existsSync(join(snap.dir, '.git'))).toBe(false);
    expect(existsSync(join(snap.dir, 'untracked-secret.env'))).toBe(false);
    expect(existsSync(join(snap.dir, 'ignored.txt'))).toBe(false);
    expect(readdirSync(join(root, 'proj'))).toEqual([snap.sha]); // no temp debris
    expect(statSync(snap.dir).mode & 0o005).toBe(0o005); // world-readable for the worker uid
  });

  test('uses the default branch head, not the checked-out feature branch', async () => {
    const mainSha = git('rev-parse', 'main');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'src/feature.ts'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature work');
    const snap = await manager().ensureCurrent('proj');
    expect(snap.sha).toBe(mainSha);
    expect(existsSync(join(snap.dir, 'src/feature.ts'))).toBe(false);
  });

  test('honours a configured defaultBranch and falls back to master', async () => {
    expect(await resolveDefaultBranchSha({ repoDir: repo, defaultBranch: 'main' })).toBe(git('rev-parse', 'main'));
    git('branch', '-m', 'main', 'master');
    expect(await resolveDefaultBranchSha({ repoDir: repo })).toBe(git('rev-parse', 'master'));
    await expect(resolveDefaultBranchSha({ repoDir: repo, defaultBranch: 'ghost' })).rejects.toThrow(/default branch/);
  });

  test('snapshots are immutable: an existing snapshot is reused, never rewritten', async () => {
    const m = manager();
    const first = await m.ensureCurrent('proj');
    writeFileSync(join(first.dir, 'marker'), 'x'); // a later visitor leaves a mark
    const second = await m.ensureCurrent('proj');
    expect(second.dir).toBe(first.dir);
    expect(existsSync(join(second.dir, 'marker'))).toBe(true); // proves it was not re-extracted
  });

  test('a new commit gets a new directory; the old one stays until cleaned', async () => {
    const m = manager();
    const a = await m.ensureCurrent('proj');
    writeFileSync(join(repo, 'src/b.ts'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    const b = await m.ensureCurrent('proj');
    expect(b.sha).not.toBe(a.sha);
    expect(readdirSync(join(root, 'proj')).sort()).toEqual([a.sha, b.sha].sort());
    expect(existsSync(join(a.dir, 'src/b.ts'))).toBe(false);
    expect(existsSync(join(b.dir, 'src/b.ts'))).toBe(true);
  });

  test('concurrent ensureCurrent calls share one creation', async () => {
    const log: string[] = [];
    const m = manager(log);
    const [x, y] = await Promise.all([m.ensureCurrent('proj'), m.ensureCurrent('proj')]);
    expect(x.dir).toBe(y.dir);
    expect(log.filter((l) => l.startsWith('snapshot created'))).toHaveLength(1);
  });

  test('cleanup removes unreferenced snapshots, keeps referenced ones, ignores foreign entries and stale temps', async () => {
    const m = manager();
    const a = await m.ensureCurrent('proj');
    writeFileSync(join(repo, 'src/b.ts'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    const b = await m.ensureCurrent('proj');
    mkdirSync(join(root, 'proj', 'notes-from-operator'));
    const staleTmp = join(root, 'proj', '.tmp-stale');
    mkdirSync(staleTmp);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(staleTmp, old, old);

    // `b` was just created and is pinned for a short window; `a` too. Release via a fresh manager.
    const m2 = manager();
    const removed = await m2.cleanup(new Set([snapshotKey('proj', b.sha)]));
    expect(removed).toEqual([snapshotKey('proj', a.sha)]);
    const left = readdirSync(join(root, 'proj')).sort();
    expect(left).toEqual([b.sha, 'notes-from-operator'].sort());
    expect(SHA_RE.test(b.sha)).toBe(true);
  });

  test('a snapshot being created right now is shielded from cleanup', async () => {
    const m = manager();
    const a = await m.ensureCurrent('proj'); // pinned for 60s
    expect(await m.cleanup(new Set())).toEqual([]);
    expect(existsSync(a.dir)).toBe(true);
  });

  test('unknown project and git failure surface as errors without leaving debris', async () => {
    await expect(manager().ensureCurrent('nope')).rejects.toThrow(/unknown project/);
    const bad = createSnapshotManager({ root, projects: { proj: { repoDir: join(work, 'not-a-repo'), githubRepo: 'o/n' } } });
    await expect(bad.ensureCurrent('proj')).rejects.toThrow();
    expect(existsSync(join(root, 'proj')) ? readdirSync(join(root, 'proj')) : []).toEqual([]);
  });

  test('shell metacharacters in a project id cannot be interpreted (array args, no shell)', async () => {
    const evil = `x;touch ${join(work, 'pwned')}`;
    const m = createSnapshotManager({ root, projects: { [evil]: { repoDir: repo, githubRepo: 'o/n' } } });
    const snap = await m.ensureCurrent(evil);
    expect(existsSync(join(work, 'pwned'))).toBe(false);
    expect(existsSync(snap.dir)).toBe(true);
  });
  test('git-hook environment variables that redirect git (GIT_DIR, GIT_INDEX_FILE, ...) cannot send it to another repository', async () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(root, 'not-a-repo', '.git');
    process.env.GIT_INDEX_FILE = join(root, 'not-a-repo', 'index');
    process.env.GIT_WORK_TREE = join(root, 'not-a-repo');
    try {
      const mgr = createSnapshotManager({ root: join(root, 'snapshots'), projects: { proj: { repoDir: repo, githubRepo: 'o/n' } } });
      const snap = await mgr.ensureCurrent('proj');
      expect(snap.sha).toMatch(SHA_RE);
      expect(existsSync(join(snap.dir, 'src', 'a.ts'))).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('cleanGitEnv drops repo-redirecting variables, keeps the rest, and disables prompts', () => {
    const env = cleanGitEnv({ GIT_DIR: '/x', GIT_INDEX_FILE: '/y', GIT_AUTHOR_NAME: 'keep', PATH: '/bin' });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_AUTHOR_NAME).toBe('keep');
    expect(env.PATH).toBe('/bin');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
  test('cleanup racing ensureCurrent never leaves a returned snapshot missing (many interleavings)', async () => {
    const mgr = createSnapshotManager({ root, projects: { proj: { repoDir: repo, githubRepo: 'o/n' } }, pinMs: 0 });
    const first = await mgr.ensureCurrent('proj');
    await new Promise((r) => setTimeout(r, 5)); // let the zero-length pin expire
    for (let i = 0; i < 25; i++) {
      const cleaning = mgr.cleanup(new Set());
      if (i % 3 === 0) await new Promise((r) => setImmediate(r));
      const ensuring = mgr.ensureCurrent('proj');
      const [, snap] = await Promise.all([cleaning, ensuring]);
      expect(snap.dir).toBe(first.dir);
      expect(existsSync(join(snap.dir, 'src', 'a.ts'))).toBe(true); // the returned snapshot is complete, always
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  test('cleanup evaluates a keep FUNCTION at deletion time, so a delegation recorded after cleanup started is respected', async () => {
    const mgr = createSnapshotManager({ root, projects: { proj: { repoDir: repo, githubRepo: 'o/n' } }, pinMs: 0 });
    const snap = await mgr.ensureCurrent('proj');
    await new Promise((r) => setTimeout(r, 5));
    let recorded = false;
    const key = snapshotKey('proj', snap.sha);
    const cleaning = mgr.cleanup(() => (recorded ? new Set([key]) : new Set()));
    recorded = true; // a delegation referencing the snapshot is recorded while cleanup is starting
    expect(await cleaning).toEqual([]);
    expect(existsSync(join(snap.dir, 'src', 'a.ts'))).toBe(true);
  });

  test('one call\'s pin expiring does not unpin a snapshot a later call just pinned', async () => {
    const mgr = createSnapshotManager({ root, projects: { proj: { repoDir: repo, githubRepo: 'o/n' } }, pinMs: 80 });
    const a = await mgr.ensureCurrent('proj');
    await new Promise((r) => setTimeout(r, 60));
    await mgr.ensureCurrent('proj'); // second call, pinned from now for 80 ms
    await new Promise((r) => setTimeout(r, 40)); // first pin has expired; second has not
    expect(await mgr.cleanup(new Set())).toEqual([]);
    expect(existsSync(join(a.dir, 'src', 'a.ts'))).toBe(true);
    await new Promise((r) => setTimeout(r, 120)); // both expired
    expect(await mgr.cleanup(new Set())).toEqual([snapshotKey('proj', a.sha)]);
  });
});
