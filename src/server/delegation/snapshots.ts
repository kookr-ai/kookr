import { spawn, execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from './registry.js';

const execFile = promisify(execFileCb);

/**
 * Immutable per-commit snapshots of a project (RFC section 10, "Checkout lifecycle").
 *
 * Plain-language summary: a worker reads the repository through a read-only mount of one
 * "snapshots root". For each job Kookr makes sure `<root>/<projectId>/<commit-sha>/` exists,
 * holding exactly the files git tracks at that commit, and tells the worker that path. A
 * snapshot is never edited after it is created, so a worker never sees a half-updated
 * tree; a newer commit simply gets a newer directory; and a directory is deleted only
 * when no unfinished delegation refers to it.
 *
 * How it is built: `git -C <repoDir> archive <sha>` is piped into `tar -x`. Both are run
 * with argument arrays (no shell), so a project id or sha can never be interpreted as
 * shell syntax. Only tracked files are copied and there is no `.git` directory, so
 * nothing in the mount can point back at the real checkout or run a hook on the host.
 * The tree is extracted into a temporary sibling and renamed into place, so a crash
 * never leaves a half-extracted `<sha>` directory.
 *
 * Known limits (documented, not enforced): files that are TRACKED are copied as-is. This
 * module does not scan for secrets, so a secret committed to the repository reaches the
 * worker; untracked and ignored files (a local `.env`, build output) never do. Files marked
 * `export-ignore` in `.gitattributes` are omitted by `git archive`. The default-branch
 * HEAD is read from the local checkout and is not fetched, so the snapshot is as fresh
 * as that checkout.
 */

export const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TMP_PREFIX = '.tmp-';
const STALE_TMP_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 30_000;

export interface SnapshotRef {
  projectId: string;
  sha: string;
  /** Host path of the snapshot directory (used for path verification). */
  dir: string;
}

export interface SnapshotManager {
  /** Resolve the project's default-branch HEAD and make sure its snapshot exists. */
  ensureCurrent(projectId: string): Promise<SnapshotRef>;
  /** Host directory for a (project, sha); does not check existence. */
  dirFor(projectId: string, sha: string): string;
  /**
   * Delete snapshot directories that are neither in `keep` nor pinned. `keep` may be a function so
   * it is evaluated fresh, under the per-snapshot lock, at the moment of each deletion (a set computed
   * earlier could miss a delegation recorded since). Returns what was removed.
   */
  cleanup(keep: ReadonlySet<string> | (() => ReadonlySet<string>)): Promise<string[]>;
}

export interface SnapshotManagerOptions {
  /** Test seam: how long a call pins its snapshot against cleanup (default 60 s). */
  pinMs?: number;
  root: string;
  projects: Readonly<Record<string, ProjectConfig>>;
  log?: (line: string) => void;
}

/** How long a creation pins its snapshot against cleanup, giving the caller time to record a delegation. */
const PIN_MS = 60_000;

export function snapshotKey(projectId: string, sha: string): string {
  return `${projectId}/${sha}`;
}

export function createSnapshotManager(options: SnapshotManagerOptions): SnapshotManager {
  const { root, projects } = options;
  const pinMs = options.pinMs ?? PIN_MS;
  const log = options.log ?? (() => undefined);
  const inFlight = new Map<string, Promise<SnapshotRef>>();
  /** Per-call pins (key -> count): each ensureCurrent call shields its snapshot from cleanup for a while. */
  const pins = new Map<string, number>();
  /** Per-snapshot mutex: creation and removal of one (project, sha) never overlap. */
  const locks = new Map<string, Promise<void>>();

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    locks.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === chain) locks.delete(key);
    }
  }

  const dirFor = (projectId: string, sha: string) => join(root, projectId, sha);

  async function create(projectId: string, sha: string, repoDir: string): Promise<SnapshotRef> {
    const dest = dirFor(projectId, sha);
    if (await isDirectory(dest)) return { projectId, sha, dir: dest };
    const parent = join(root, projectId);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const tmp = join(parent, `${TMP_PREFIX}${randomUUID()}`);
    await mkdir(tmp, { mode: 0o755 });
    try {
      await pipeArchiveInto(repoDir, sha, tmp);
      try {
        await rename(tmp, dest);
      } catch (err) {
        // Another creator won the race; theirs is identical (same commit), keep it.
        if (!(await isDirectory(dest))) throw err;
        await rm(tmp, { recursive: true, force: true });
      }
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    log(`snapshot created project=${projectId} sha=${sha}`);
    return { projectId, sha, dir: dest };
  }

  return {
    dirFor,

    async ensureCurrent(projectId) {
      const project = projects[projectId];
      if (!project) throw new Error(`unknown project "${projectId}"`);
      const sha = await resolveDefaultBranchSha(project);
      const key = snapshotKey(projectId, sha);
      // Pin first, per call: the caller keeps the snapshot alive by recording a delegation that
      // references it, and until then this pin shields it from cleanup. Each call releases only
      // its own pin, so an earlier call's timer cannot unpin a later call's snapshot.
      pins.set(key, (pins.get(key) ?? 0) + 1);
      const unpinLater = (): void => {
        setTimeout(() => {
          const n = (pins.get(key) ?? 1) - 1;
          if (n <= 0) pins.delete(key);
          else pins.set(key, n);
        }, pinMs).unref?.();
      };
      const existing = inFlight.get(key);
      if (existing) {
        void existing.then(unpinLater, unpinLater);
        return existing;
      }
      const p = withLock(key, () => create(projectId, sha, project.repoDir)).finally(() => {
        inFlight.delete(key);
        unpinLater();
      });
      inFlight.set(key, p);
      return p;
    },

    async cleanup(keep) {
      const removed: string[] = [];
      for (const projectId of Object.keys(projects)) {
        const projectDir = join(root, projectId);
        let entries: string[];
        try {
          entries = await readdir(projectDir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = join(projectDir, name);
          if (name.startsWith(TMP_PREFIX)) {
            const st = await stat(full).catch(() => undefined);
            if (st && Date.now() - st.mtimeMs > STALE_TMP_MS) {
              await rm(full, { recursive: true, force: true }).catch(() => undefined);
            }
            continue;
          }
          if (!SHA_RE.test(name)) continue; // never touch anything we did not create
          const key = snapshotKey(projectId, name);
          // Decide and detach under the lock, so a concurrent ensureCurrent either runs before (and
          // pins/records the snapshot, which this check sees) or after (and recreates it). The
          // directory is renamed away atomically; the slow recursive delete happens after.
          const graveyard = join(projectDir, `${TMP_PREFIX}del-${randomUUID()}`);
          const detached = await withLock(key, async () => {
            const keepNow = typeof keep === 'function' ? keep() : keep;
            if (keepNow.has(key) || (pins.get(key) ?? 0) > 0 || inFlight.has(key)) return false;
            try {
              await rename(full, graveyard);
              return true;
            } catch {
              return false;
            }
          });
          if (!detached) continue;
          try {
            await rm(graveyard, { recursive: true, force: true });
            removed.push(key);
            log(`snapshot removed project=${projectId} sha=${name}`);
          } catch (err) {
            log(`snapshot removal failed project=${projectId} sha=${name} code=${(err as NodeJS.ErrnoException).code ?? 'unknown'}`);
          }
        }
      }
      return removed;
    },
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Environment for the git child processes, with every variable that redirects git to a
 * different repository removed. Git sets `GIT_DIR`, `GIT_INDEX_FILE` and friends while it runs
 * a hook (and some tooling exports them), so inheriting them would make `git -C <repoDir>`
 * operate on the wrong repository.
 */
export function cleanGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|NAMESPACE|SUPER_PREFIX|QUARANTINE_PATH|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(k)) continue;
    out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', repoDir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    env: cleanGitEnv(),
  });
  return stdout.trim();
}

async function tryRevParse(repoDir: string, ref: string): Promise<string | undefined> {
  try {
    const sha = await git(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return SHA_RE.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commit at the head of the project's default branch. Order: the configured
 * `defaultBranch`, else the branch `origin/HEAD` points at, else `main`, else `master`.
 * For each branch name the local branch is preferred, then its `origin/` counterpart.
 */
export async function resolveDefaultBranchSha(project: Pick<ProjectConfig, 'repoDir' | 'defaultBranch'>): Promise<string> {
  const names: string[] = [];
  if (project.defaultBranch) {
    names.push(project.defaultBranch);
  } else {
    try {
      const head = await git(project.repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (head.startsWith('origin/')) names.push(head.slice('origin/'.length));
    } catch {
      /* no origin/HEAD */
    }
    names.push('main', 'master');
  }
  for (const name of names) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      const sha = await tryRevParse(project.repoDir, ref);
      if (sha) return sha;
    }
  }
  throw new Error('could not resolve the default branch head of the project checkout');
}

/** `git archive <sha> | tar -x -C dest`, argument arrays only, failures from either side reject. */
function pipeArchiveInto(repoDir: string, sha: string, dest: string): Promise<void> {
  if (!SHA_RE.test(sha)) return Promise.reject(new Error('refusing to archive a non-sha ref'));
  return new Promise<void>((resolve, reject) => {
    const archive = spawn('git', ['-C', repoDir, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv() });
    const tar = spawn('tar', ['-x', '-f', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveErr = '';
    let tarErr = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        archive.kill('SIGKILL');
        tar.kill('SIGKILL');
        reject(err);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => done(new Error('snapshot creation timed out')), 120_000);
    timer.unref?.();
    archive.stderr.on('data', (c: Buffer) => { archiveErr = (archiveErr + c.toString()).slice(-500); });
    tar.stderr.on('data', (c: Buffer) => { tarErr = (tarErr + c.toString()).slice(-500); });
    archive.stdout.pipe(tar.stdin);
    tar.stdin.on('error', () => undefined); // EPIPE if tar exits early; its exit code reports it
    let archiveCode: number | null | undefined;
    let tarCode: number | null | undefined;
    const check = () => {
      if (archiveCode === undefined || tarCode === undefined) return;
      if (archiveCode !== 0) return done(new Error(`git archive failed (${archiveCode}): ${archiveErr.trim()}`));
      if (tarCode !== 0) return done(new Error(`tar extraction failed (${tarCode}): ${tarErr.trim()}`));
      done();
    };
    archive.on('error', (e) => done(e));
    tar.on('error', (e) => done(e));
    archive.on('close', (code) => { archiveCode = code; check(); });
    tar.on('close', (code) => { tarCode = code; check(); });
  });
}
