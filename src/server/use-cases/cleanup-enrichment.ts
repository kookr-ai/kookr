/**
 * Cleanup enrichment helpers — shared git-read primitives used by both
 * the cleanup inspector (list-level) and the cleanup detail query
 * (review-modal-level).
 *
 * Keeping the commit and dirty enrichment in one place prevents the
 * two consumers from drifting on ahead/behind parsing, dirty-status
 * categorization, or subprocess timeout handling.
 *
 * This module is read-only: it spawns git subprocesses, parses output,
 * and returns structured results. It never mutates repository state.
 */

import { execFile as execFileCb } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type {
  CleanupCommitSummary,
  CleanupDirtySummary,
  CleanupFileSample,
} from '../../core/workspace-types.js';

const execFile = promisify(execFileCb);

/** Default per-subprocess timeout. 15 s tolerates large `git status`
 *  on WSL / cold filesystems without false-positive timeouts on
 *  normal-sized worktrees. */
export const DEFAULT_ENRICHMENT_TIMEOUT_MS = 15_000;

export const DIRTY_SAMPLE_LIMIT = 20;

/** Field separator used in `git log --format=...%x1f...` output, so
 *  the multi-field commit record can be split safely regardless of
 *  author/subject content. */
const GIT_FIELD_SEPARATOR = '';

export type EnrichmentOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error' };

export interface CommitEnrichmentInput {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baselineRef: string;
  timeoutMs?: number;
}

/**
 * Compute ahead/behind counts vs the baseline and the last commit on
 * HEAD. Returns `{ kind: 'error' }` if any git subprocess fails or
 * times out.
 */
export async function runCommitEnrichment(
  input: CommitEnrichmentInput,
): Promise<EnrichmentOutcome<CleanupCommitSummary>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ENRICHMENT_TIMEOUT_MS;

  const counts = await runGit({
    cwd: input.repoPath,
    args: ['rev-list', '--left-right', '--count', `${input.baselineRef}...${input.branch}`],
    timeoutMs,
  });
  if (counts.kind === 'error') return { kind: 'error' };

  const [behindCount, aheadCount] = parseAheadBehind(counts.stdout);

  const lastCommit = await runGit({
    cwd: input.worktreePath,
    args: ['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s', 'HEAD'],
    timeoutMs,
  });
  if (lastCommit.kind === 'error') return { kind: 'error' };

  const [lastCommitSha, lastCommitAuthor, lastCommitAt, lastCommitSubject] =
    lastCommit.stdout.split(GIT_FIELD_SEPARATOR);

  return {
    kind: 'ok',
    value: {
      aheadCount,
      behindCount,
      lastCommitSha,
      lastCommitAuthor,
      lastCommitAt,
      lastCommitSubject,
    },
  };
}

export interface DirtyEnrichmentResult {
  rawStatus: string;
  summary?: CleanupDirtySummary;
  sample?: CleanupFileSample[];
}

/**
 * Run `git status --porcelain=v1` and parse it into structured counts
 * and a bounded file sample. Returns `{ kind: 'error' }` on failure.
 */
export async function runDirtyEnrichment(
  worktreePath: string,
  timeoutMs: number = DEFAULT_ENRICHMENT_TIMEOUT_MS,
): Promise<EnrichmentOutcome<DirtyEnrichmentResult>> {
  const status = await runGit({
    cwd: worktreePath,
    args: ['status', '--porcelain=v1'],
    timeoutMs,
  });
  if (status.kind === 'error') return { kind: 'error' };

  const parsed = parsePorcelainStatus(status.stdout);
  return { kind: 'ok', value: { rawStatus: status.stdout, ...parsed } };
}

/** Parse `git status --porcelain` output into counts and a sample. */
export function parsePorcelainStatus(rawStatus: string | undefined | null): {
  summary?: CleanupDirtySummary;
  sample?: CleanupFileSample[];
} {
  if (rawStatus === null || rawStatus === undefined) {
    return {};
  }

  const lines = rawStatus.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return {};
  }

  const summary: CleanupDirtySummary = {
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
  };
  const sample: CleanupFileSample[] = [];

  for (const line of lines) {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    categorizeStatus(summary, status);
    if (sample.length < DIRTY_SAMPLE_LIMIT) {
      sample.push({ path, status });
    }
  }

  return { summary, sample };
}

function categorizeStatus(summary: CleanupDirtySummary, status: string): void {
  if (status === '??') {
    summary.untracked += 1;
    return;
  }
  if (status.includes('R')) {
    summary.renamed += 1;
    return;
  }
  if (status.includes('A')) {
    summary.added += 1;
    return;
  }
  if (status.includes('D')) {
    summary.deleted += 1;
    return;
  }
  summary.modified += 1;
}

function parseAheadBehind(rawCounts: string | undefined): [number, number] {
  if (!rawCounts) return [0, 0];
  const parts = rawCounts.trim().split(/\s+/);
  return [
    Number.parseInt(parts[0] ?? '0', 10) || 0,
    Number.parseInt(parts[1] ?? '0', 10) || 0,
  ];
}

interface RunGitArgs {
  cwd: string;
  args: string[];
  timeoutMs: number;
}

type RunGitResult = { kind: 'ok'; stdout: string } | { kind: 'error' };

async function runGit({ cwd, args, timeoutMs }: RunGitArgs): Promise<RunGitResult> {
  const started = Date.now();
  try {
    // Strip GIT_DIR / GIT_WORK_TREE so cwd is authoritative (same
    // contract as core/git-helpers.ts `gitIn`). These env vars leak
    // from git hooks and otherwise override --work-tree / cwd.
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const { stdout } = await execFile('git', args, { cwd, env, timeout: timeoutMs });
    return { kind: 'ok', stdout: stdout.replace(/\n+$/, '') };
  } catch (err) {
    logEnrichmentFailure({
      subprocess: args[0] ?? 'git',
      cwd,
      elapsedMs: Date.now() - started,
      err,
    });
    return { kind: 'error' };
  }
}

interface EnrichmentFailure {
  subprocess: string;
  cwd: string;
  elapsedMs: number;
  err: unknown;
}

function logEnrichmentFailure(failure: EnrichmentFailure): void {
  const errAny = failure.err as {
    code?: number | string;
    signal?: string;
    stderr?: string | Buffer;
    killed?: boolean;
  } | null;
  const stderrRaw = errAny?.stderr;
  const stderr = typeof stderrRaw === 'string'
    ? stderrRaw
    : Buffer.isBuffer(stderrRaw) ? stderrRaw.toString('utf8') : '';

  // eslint-disable-next-line no-console
  console.warn('[cleanup-enrichment] subprocess failed', {
    subprocess: failure.subprocess,
    cwd: redactHome(failure.cwd),
    elapsedMs: failure.elapsedMs,
    exitCode: errAny?.code ?? null,
    signal: errAny?.signal ?? null,
    killed: errAny?.killed ?? false,
    stderr: stderr.slice(0, 512),
  });
}

/**
 * Replace the user's home directory in a path with `~`. Keeps warn
 * logs useful without leaking usernames into issues or aggregators.
 */
export function redactHome(path: string): string {
  const home = homedir();
  if (home && path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  if (home && path === home) return '~';
  return path;
}
