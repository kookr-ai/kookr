import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RalphIterationDiffStats } from './ralph-iteration-log.js';

const execFileP = promisify(execFile);

/**
 * Per-iteration git baseline anchor for Ralph loops (issue #440).
 *
 * `createBaselineTag` tags the repo at the moment an iteration starts so the
 * controller can later compute a diff against that anchor. Both functions
 * fail soft — any git error returns null so callers can persist a "data
 * unavailable" sentinel that downstream convergence detection (M2) treats
 * as distinct from "no changes".
 */

export interface GitBaselineOptions {
  cwd: string;
  /** Allow tests to inject a fake exec. Defaults to node:child_process execFile. */
  execFileImpl?: typeof execFile;
}

const TAG_PREFIX = 'ralph/iter-';
const TAG_TIMEOUT_MS = 3_000;

/**
 * Tag HEAD as `ralph/iter-<n>-start` and return the tag name. Returns null on
 * any git failure (not a repo, detached HEAD with broken index, no permission,
 * tag already exists from a prior partial run, etc.). The tag is non-fatal —
 * a Ralph loop must run even when its workdir is not a git repo.
 *
 * The tag is force-overwritten on collision because a re-run after a crash
 * may legitimately re-tag the same iteration number. This also means callers
 * cannot rely on tag immutability across crashes.
 */
export async function createBaselineTag(
  iterationNumber: number,
  opts: GitBaselineOptions,
): Promise<string | null> {
  const tagName = `${TAG_PREFIX}${iterationNumber}-start`;
  const exec = opts.execFileImpl ?? execFile;
  try {
    await new Promise<void>((resolve, reject) => {
      exec(
        'git',
        ['tag', '-f', tagName],
        { cwd: opts.cwd, timeout: TAG_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return tagName;
  } catch {
    return null;
  }
}

/**
 * Compute `git diff --shortstat <baselineRef>` against HEAD. Returns null when
 * the diff command fails for any reason (baseline ref missing, broken index,
 * not a repo). Distinct from `{filesChanged: 0, insertions: 0, deletions: 0}`
 * which means "diff ran, found no changes" — convergence detection cares
 * about that distinction.
 */
export async function computeDiffStats(
  baselineRef: string,
  opts: GitBaselineOptions,
): Promise<RalphIterationDiffStats | null> {
  if (!baselineRef) return null;
  const exec = opts.execFileImpl ?? execFile;
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      exec(
        'git',
        ['diff', '--shortstat', baselineRef],
        { cwd: opts.cwd, timeout: TAG_TIMEOUT_MS },
        (err, sout) => (err ? reject(err) : resolve({ stdout: String(sout) })),
      );
    });
    return parseShortstat(stdout);
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --shortstat` output into structured counts.
 *
 * Empty output (no diff) → all-zero stats so callers can distinguish
 * "diff ran, no changes" from "diff failed" (null at the call site).
 *
 *   ` 3 files changed, 12 insertions(+), 4 deletions(-)`
 *   ` 1 file changed, 5 insertions(+)`
 *   ` 2 files changed, 3 deletions(-)`
 *
 * Regex captures each metric independently because git omits the
 * insertions/deletions clauses entirely when their count is zero.
 *
 * Exported for direct testing.
 */
export function parseShortstat(stdout: string): RalphIterationDiffStats {
  const result: RalphIterationDiffStats = {
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };
  if (!stdout.trim()) return result;
  const filesMatch = stdout.match(/(\d+)\s+files?\s+changed/);
  if (filesMatch) result.filesChanged = Number.parseInt(filesMatch[1], 10);
  const insMatch = stdout.match(/(\d+)\s+insertions?\(\+\)/);
  if (insMatch) result.insertions = Number.parseInt(insMatch[1], 10);
  const delMatch = stdout.match(/(\d+)\s+deletions?\(-\)/);
  if (delMatch) result.deletions = Number.parseInt(delMatch[1], 10);
  return result;
}
