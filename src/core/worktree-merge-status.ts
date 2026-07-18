/**
 * Shared merge-status checks for worktree cleanup.
 *
 * The completion dialog and the cleanup sweep must agree about both the
 * baseline ref and what it means for a branch to be merged. Keep the Git
 * probes here so those consumers cannot drift apart again.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CleanupClassification } from './workspace-types.js';
import { gitExecEnv, gitIn, runGitIn } from './git-helpers.js';
import { resolveDefaultBranch } from './repo-policy-resolver.js';

export type WorktreeMergeClassification = Extract<
  CleanupClassification,
  'merged' | 'patch_equivalent' | 'unique_commits'
>;

export interface WorktreeMergeStatus {
  /** The ref used as the merge baseline, normally origin/<default>. */
  baselineRef: string;
  classification: WorktreeMergeClassification;
  reasonCode: string;
  recoveryGuidance: string;
  /** The merge probes failed, so the caller should fail closed if needed. */
  mergeCheckFailed?: true;
  /** Raw SHA-reachability count, useful as display-only evidence. */
  aheadCount?: number;
  /** The display-only ahead count could not be computed. */
  aheadCountCheckFailed?: true;
}

export interface ResolveWorktreeMergeStatusOptions {
  /** Use a caller-resolved baseline, e.g. a configured repo profile. */
  baselineRef?: string;
  /** Local fallback is safe only for known/local repositories without origin refs. */
  allowLocalFallback?: boolean;
  /** Also compute the raw ahead count for UI evidence. */
  includeAheadCount?: boolean;
}

/**
 * Resolve and classify a worktree branch.
 *
 * The default is the remote-tracking default branch as of the last fetch. A
 * read-only completion query deliberately does not fetch from the network.
 * A three-way tree merge compares the branch's aggregate change with the
 * baseline, so a multi-commit branch that was squash-merged into one baseline
 * commit is recognized even though no individual commit has a matching patch.
 */
export async function resolveWorktreeMergeStatus(
  repoPath: string,
  branch: string,
  options: ResolveWorktreeMergeStatusOptions = {},
): Promise<WorktreeMergeStatus | undefined> {
  const baselineRef = options.baselineRef ?? await resolveDefaultBranch(repoPath, {
    allowLocalFallback: options.allowLocalFallback ?? true,
  });
  if (!baselineRef) return undefined;

  const ancestorCheck = await runGitIn(
    repoPath,
    ['merge-base', '--is-ancestor', branch, baselineRef],
    { maxAttempts: 1 },
  );
  let classification: WorktreeMergeClassification;
  let reasonCode: string;
  let recoveryGuidance: string;
  let mergeCheckFailed = false;

  // `merge-base --is-ancestor` exits 1 for the expected "not an ancestor"
  // result. Any other failure is an inability to prove merge status and must
  // remain blocked; treating it as the expected result would let a later empty
  // probe fail open as patch-equivalent.
  if (ancestorCheck.kind === 'ok') {
    classification = 'merged';
    reasonCode = 'ancestor_of_baseline';
    recoveryGuidance = 'Branch is fully merged. Safe to remove.';
  } else if (ancestorCheck.kind !== 'failed' || ancestorCheck.exitCode !== 1) {
    classification = 'unique_commits';
    reasonCode = 'merge_check_failed';
    recoveryGuidance = 'Could not verify whether the branch is merged. Review before removing.';
    mergeCheckFailed = true;
  } else {
    const uniquePatchesResult = await runGitIn(
      repoPath,
      ['log', '--oneline', '--cherry-pick', '--right-only', `${baselineRef}...${branch}`],
      { maxAttempts: 1 },
    );

    if (uniquePatchesResult.kind !== 'ok') {
      classification = 'unique_commits';
      reasonCode = 'has_unique_commits';
      recoveryGuidance = 'Branch has commits not in the baseline. Review before removing.';
      mergeCheckFailed = true;
    } else {
      const uniquePatches = uniquePatchesResult.stdout;
      const aggregatePatchEquivalent = uniquePatches.length > 0
        ? await isAggregatePatchEquivalent(repoPath, baselineRef, branch)
        : false;

      if (uniquePatches.length === 0 || aggregatePatchEquivalent) {
        classification = 'patch_equivalent';
        reasonCode = uniquePatches.length === 0 ? 'no_unique_patches' : 'aggregate_patch_equivalent';
        recoveryGuidance = 'Branch adds no unique patches vs baseline (likely squash-merged). Safe to remove.';
      } else {
        classification = 'unique_commits';
        reasonCode = 'has_unique_commits';
        recoveryGuidance = 'Branch has commits not in the baseline. Review before removing.';
      }
    }
  }

  if (!options.includeAheadCount) {
    return {
      baselineRef,
      classification,
      reasonCode,
      recoveryGuidance,
      ...(mergeCheckFailed ? { mergeCheckFailed: true } : {}),
    };
  }

  const counts = await gitIn(repoPath, 'rev-list', '--left-right', '--count', `${baselineRef}...${branch}`);
  const countParts = counts?.split(/\s+/) ?? [];
  const aheadCount = countParts.length === 2 && /^\d+$/.test(countParts[1]!)
    ? Number(countParts[1])
    : undefined;
  const aheadCountCheckFailed = aheadCount === undefined;

  return {
    baselineRef,
    classification,
    reasonCode,
    recoveryGuidance,
    ...(mergeCheckFailed ? { mergeCheckFailed: true } : {}),
    ...(aheadCount !== undefined ? { aheadCount } : {}),
    ...(aheadCountCheckFailed ? { aheadCountCheckFailed: true } : {}),
  };
}

/**
 * Check whether the branch's complete change is already represented by the
 * baseline, independent of how many commits produced that change.
 *
 * Git's `--cherry-pick` log mode compares commits one at a time, so it misses
 * a multi-commit branch that was combined into one squash commit. A temporary
 * index lets Git perform a read-only three-way merge of the common ancestor,
 * baseline, and branch. If the merged tree is exactly the baseline tree, the
 * branch contributes no net change that is absent from the baseline.
 */
async function isAggregatePatchEquivalent(
  repoPath: string,
  baselineRef: string,
  branch: string,
): Promise<boolean> {
  const mergeBase = await gitIn(repoPath, 'merge-base', baselineRef, branch);
  if (!mergeBase) return false;

  let tempDir: string;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'kookr-merge-index-'));
  } catch {
    return false;
  }
  const indexPath = join(tempDir, 'index');
  const env = { ...gitExecEnv(), GIT_INDEX_FILE: indexPath };
  try {
    const readTree = await runGitIn(
      repoPath,
      ['read-tree', '-m', mergeBase, baselineRef, branch],
      { env, maxAttempts: 1 },
    );
    if (readTree.kind !== 'ok') return false;

    const mergedTree = await runGitIn(repoPath, ['write-tree'], { env, maxAttempts: 1 });
    if (mergedTree.kind !== 'ok') return false;

    const baselineTree = await gitIn(repoPath, 'rev-parse', `${baselineRef}^{tree}`);
    return baselineTree !== null && mergedTree.stdout === baselineTree;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
