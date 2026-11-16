/**
 * Per-task change list for the reading pane's Changes tab (#4024 item 4).
 * Design note: docs/rfc/rfc-reading-pane-changes-tab.md.
 *
 * Diffs a task's working directory against the merge base of the branch it
 * forked from: committed, staged and unstaged changes, plus new files that
 * `.gitignore` does not exclude. Git runs with array arguments (never a
 * shell), external diff drivers off, optional locks off, a timeout and an
 * output cap.
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { gitExecEnv } from '../core/git-helpers.js';
import type {
  TaskChangeFileResponse,
  TaskChangeHunk,
  TaskChangedFile,
  TaskChangesResponse,
  TaskChangeStatus,
} from '../shared/contracts/task-changes.js';

export type GitRunResult =
  | { ok: true; stdout: string }
  | { ok: false; exitCode: number | null; stdout: string; tooLarge: boolean };

export type GitRunner = (args: string[], cwd: string, opts?: { maxBuffer?: number }) => Promise<GitRunResult>;

/** Most files listed; the rest is cut and `truncated` is set. */
export const MAX_CHANGED_FILES = 500;
/** A single file's patch over this many bytes comes back as `too_large`. */
const MAX_PATCH_BYTES = 1024 * 1024;
/** A new (untracked) file over this many bytes is listed without line counts. */
const MAX_COUNTED_UNTRACKED_BYTES = 1024 * 1024;
const LIST_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

/** Bases always tried, after the task's own pull request base, in tie-break order. */
const FALLBACK_BASES = ['origin/main', 'origin/staging', 'origin/master'] as const;
/** A PR base branch name we are willing to pass to git as `origin/<name>`. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const defaultGitRunner: GitRunner = (args, cwd, opts) => new Promise((resolve) => {
  execFile('git', args, {
    cwd,
    env: { ...gitExecEnv(), GIT_OPTIONAL_LOCKS: '0' },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: opts?.maxBuffer ?? LIST_MAX_BUFFER,
    encoding: 'utf8',
  }, (err, stdout) => {
    if (!err) {
      resolve({ ok: true, stdout });
      return;
    }
    const e = err as NodeJS.ErrnoException & { code?: unknown };
    resolve({
      ok: false,
      exitCode: typeof e.code === 'number' ? e.code : null,
      stdout: typeof stdout === 'string' ? stdout : '',
      tooLarge: e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
  });
});

/** A pull request the task opened, as the GitHub state store knows it. */
export interface TaskPullRequestBase {
  branch: string;
  baseBranch: string;
}

interface ComputedChanges {
  response: TaskChangesResponse;
  /** Set when `response.kind` is `ok`. */
  repoRoot?: string;
  mergeBase?: string;
  untracked?: ReadonlySet<string>;
}

/**
 * The change list for a task whose working directory is `cwd`. `prs` are the
 * task's known pull requests: one whose head branch is the worktree's current
 * branch adds its base to the candidates (see `resolveBase`); the others are
 * ignored.
 */
export async function listTaskChanges(
  cwd: string | undefined,
  prs: readonly TaskPullRequestBase[],
  runGit: GitRunner = defaultGitRunner,
): Promise<TaskChangesResponse> {
  return (await computeTaskChanges(cwd, prs, runGit)).response;
}

/**
 * One file's patch. Returns `null` when `filePath` is not in the task's
 * change list, so the route can never be used to read any other file.
 */
export async function readTaskChangeFile(
  cwd: string | undefined,
  prs: readonly TaskPullRequestBase[],
  filePath: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<TaskChangeFileResponse | null> {
  const computed = await computeTaskChanges(cwd, prs, runGit);
  const { response } = computed;
  if (response.kind !== 'ok') return response;
  const entry = response.files.find((f) => f.path === filePath);
  if (!entry || !computed.repoRoot || !computed.mergeBase) return null;

  const common = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const args = computed.untracked?.has(entry.path)
    ? ['diff', '--no-index', ...common, '--', '/dev/null', entry.path]
    : ['diff', ...common, '-M', computed.mergeBase, '--', ...(entry.oldPath ? [entry.oldPath] : []), entry.path];
  const result = await runGit(args, computed.repoRoot, { maxBuffer: MAX_PATCH_BYTES });
  if (!result.ok && result.tooLarge) return { kind: 'too_large', path: entry.path };
  // `git diff --no-index` exits 1 when the files differ, which they always do here.
  const output = result.ok ? result.stdout : result.exitCode === 1 ? result.stdout : null;
  if (output === null) return { kind: 'unavailable', reason: 'not_git' };
  const hunks = parseUnifiedDiff(output);
  if (hunks.length === 0 && /^Binary files .* differ$/m.test(output)) return { kind: 'binary', path: entry.path };
  return { kind: 'patch', path: entry.path, hunks };
}

async function computeTaskChanges(
  cwd: string | undefined,
  prs: readonly TaskPullRequestBase[],
  runGit: GitRunner,
): Promise<ComputedChanges> {
  if (!cwd) return { response: { kind: 'unavailable', reason: 'no_cwd' } };
  if (!existsSync(cwd)) return { response: { kind: 'unavailable', reason: 'worktree_gone' } };

  const top = await runGit(['rev-parse', '--show-toplevel'], cwd);
  const repoRoot = top.ok ? top.stdout.trim() : '';
  if (!repoRoot) return { response: { kind: 'unavailable', reason: 'not_git' } };

  const branchOut = await runGit(['branch', '--show-current'], repoRoot);
  const branch = branchOut.ok && branchOut.stdout.trim() ? branchOut.stdout.trim() : null;

  const base = await resolveBase(repoRoot, branch, prs, runGit);
  if (!base) return { response: { kind: 'unavailable', reason: 'no_base' } };

  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '-z'];
  const [numstat, nameStatus, others] = await Promise.all([
    runGit([...diffArgs, '--numstat', base.mergeBase], repoRoot),
    runGit([...diffArgs, '--name-status', base.mergeBase], repoRoot),
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot),
  ]);
  if (!numstat.ok || !nameStatus.ok) return { response: { kind: 'unavailable', reason: 'not_git' } };

  const counts = parseNumstat(numstat.stdout);
  const files: TaskChangedFile[] = parseNameStatus(nameStatus.stdout).map((f) => {
    const c = counts.get(f.path);
    return { ...f, added: c?.added ?? null, removed: c?.removed ?? null };
  });

  // A listing that failed or overflowed its buffer is incomplete: keep what
  // arrived (minus a possibly cut last path) and say the list is cut, rather
  // than presenting the tracked changes as everything the task changed.
  let untrackedPaths: string[];
  let untrackedIncomplete = false;
  if (others.ok) {
    untrackedPaths = others.stdout.split('\0').filter(Boolean);
  } else {
    untrackedIncomplete = true;
    untrackedPaths = others.tooLarge ? others.stdout.split('\0').slice(0, -1).filter(Boolean) : [];
  }
  // A path git also reports as tracked (e.g. after `git rm --cached`) is listed once.
  const tracked = new Set(files.map((f) => f.path));
  untrackedPaths = untrackedPaths.filter((p) => !tracked.has(p));

  const untracked = new Set<string>();
  const room = Math.max(0, MAX_CHANGED_FILES - files.length);
  for (const p of untrackedPaths.slice(0, room)) {
    untracked.add(p);
    const added = await countNewFileLines(path.join(repoRoot, p));
    files.push({ path: p, status: 'added', added, removed: added === null ? null : 0 });
  }

  const total = files.length + Math.max(0, untrackedPaths.length - room);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    response: {
      kind: 'ok',
      baseRef: base.ref,
      branch,
      repoRoot,
      files: files.slice(0, MAX_CHANGED_FILES),
      truncated: total > MAX_CHANGED_FILES || untrackedIncomplete,
    },
    repoRoot,
    mergeBase: base.mergeBase,
    untracked,
  };
}

/**
 * The base to diff against: the candidate whose merge base is the fewest
 * commits behind HEAD. A branch cut from origin/staging is then not diffed
 * against origin/main, which would list every staging commit not yet
 * promoted. The task's own pull request base (a PR whose head branch is the
 * current branch) joins the candidates and wins a tie, but never overrides a
 * nearer base: in a repository whose pull requests open against main and are
 * retargeted to staging only at merge, trusting it would list every
 * unpromoted staging commit for the whole life of the PR.
 */
async function resolveBase(
  repoRoot: string,
  branch: string | null,
  prs: readonly TaskPullRequestBase[],
  runGit: GitRunner,
): Promise<{ ref: string; mergeBase: string } | null> {
  const own = branch ? prs.find((pr) => pr.branch === branch && SAFE_BRANCH.test(pr.baseBranch) && !pr.baseBranch.includes('..')) : undefined;
  const candidates = [...new Set([...(own ? [`origin/${own.baseBranch}`] : []), ...FALLBACK_BASES])];

  let best: { ref: string; mergeBase: string; ahead: number } | null = null;
  for (const ref of candidates) {
    const mb = await runGit(['merge-base', ref, 'HEAD'], repoRoot);
    const mergeBase = mb.ok ? mb.stdout.trim() : '';
    if (!mergeBase) continue;
    const count = await runGit(['rev-list', '--count', `${mergeBase}..HEAD`], repoRoot);
    const ahead = count.ok ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
    if (!Number.isFinite(ahead)) continue;
    // Strictly fewer only: on a tie the earlier candidate (the PR base) stays.
    if (!best || ahead < best.ahead) best = { ref, mergeBase, ahead };
  }
  return best ? { ref: best.ref, mergeBase: best.mergeBase } : null;
}

/** Parse `git diff --numstat -z`: `A\tD\tpath\0`, or `A\tD\t\0old\0new\0` for a rename. */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[i]);
    if (!m) continue;
    let filePath = m[3];
    if (filePath === '') {
      filePath = tokens[i + 2] ?? '';
      i += 2;
    }
    if (!filePath) continue;
    counts.set(filePath, {
      added: m[1] === '-' ? null : Number(m[1]),
      removed: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return counts;
}

/** Parse `git diff --name-status -z`: `M\0path\0`, or `R100\0old\0new\0`. */
export function parseNameStatus(out: string): Array<{ path: string; oldPath?: string; status: TaskChangeStatus }> {
  const files: Array<{ path: string; oldPath?: string; status: TaskChangeStatus }> = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      if (!newPath) continue;
      files.push(letter === 'R'
        ? { path: newPath, oldPath, status: 'renamed' }
        : { path: newPath, status: 'added' });
      continue;
    }
    const filePath = tokens[i + 1];
    i += 1;
    if (!filePath) continue;
    const status: TaskChangeStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    files.push({ path: filePath, status });
  }
  return files;
}

/** Parse a single-file unified diff into hunks; header lines before the first `@@` are skipped. */
export function parseUnifiedDiff(out: string): TaskChangeHunk[] {
  const hunks: TaskChangeHunk[] = [];
  let current: TaskChangeHunk | null = null;
  for (const line of out.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    const marker = line[0];
    if (marker === '+' || marker === '-' || marker === ' ' || marker === '\\') current.lines.push(line);
  }
  return hunks;
}

/**
 * Line count of a new file, or `null` when it is binary, too large to count,
 * or not a regular file. A symlink counts as one line: git diffs the link
 * itself (its target path), never the file it points to. The link is never
 * followed, so a link to a FIFO or a device cannot block the server.
 */
async function countNewFileLines(absPath: string): Promise<number | null> {
  let handle;
  try {
    const link = await lstat(absPath);
    if (link.isSymbolicLink()) return 1;
    if (!link.isFile()) return null;
    handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_COUNTED_UNTRACKED_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    await handle.read({ buffer: buf, offset: 0, length: st.size, position: 0 });
    if (buf.subarray(0, 8000).includes(0)) return null;
    if (buf.length === 0) return 0;
    let lines = 0;
    for (const byte of buf) if (byte === 10) lines++;
    return buf[buf.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
