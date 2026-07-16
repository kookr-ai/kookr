import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CleanupCandidateAssessment,
  CleanupCandidateDetail,
} from '../../core/workspace-types.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { gitExecEnv } from '../../core/git-helpers.js';
import { deriveCleanupCapabilitiesForCandidate } from '../../core/workspace-cleanup-policy.js';
import { isProtectedBranch } from '../../adapters/worktree-safety.js';
import { inspectCleanupCandidates } from './cleanup-inspector.js';
import {
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  parsePorcelainStatus,
  runCommitEnrichment,
  runDirtyEnrichment,
} from './cleanup-enrichment.js';

const execFile = promisify(execFileCb);

export interface WorkspaceCleanupDetailDeps {
  policyResolver: RepoPolicyResolver;
  leaseService: WorktreeLeaseService;
}

export interface WorkspaceCleanupDetailInput {
  projectId: string;
  repoPath: string;
  worktreePath: string;
}

export async function getCleanupCandidateDetail(
  deps: WorkspaceCleanupDetailDeps,
  input: WorkspaceCleanupDetailInput,
): Promise<CleanupCandidateDetail> {
  const candidate = (await inspectCleanupCandidates(input.repoPath, input.projectId, {
    policyResolver: deps.policyResolver,
    leaseService: deps.leaseService,
  })).find((item) => item.worktreePath === input.worktreePath);

  if (!candidate || !candidate.worktreePath) {
    throw new Error('Cleanup candidate could not be revalidated');
  }

  return hydrateCleanupCandidateDetail(input.repoPath, candidate);
}

export async function hydrateCleanupCandidateDetail(
  repoPath: string,
  candidate: CleanupCandidateAssessment,
): Promise<CleanupCandidateDetail> {
  if (!candidate.worktreePath) {
    throw new Error('Cleanup candidate is missing a worktree path');
  }

  const headOid = await runGit(candidate.worktreePath, 'rev-parse', 'HEAD');
  const gitDir = (await runGit(candidate.worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir')) || undefined;
  const branchRefOid = isSymbolicBranch(candidate.branch)
    ? await runGit(repoPath, 'rev-parse', '--verify', `refs/heads/${candidate.branch}`)
    : undefined;
  const baselineOid = candidate.baselineSha
    ?? (candidate.baselineRef ? await runGit(repoPath, 'rev-parse', '--verify', candidate.baselineRef) : undefined);

  // Detail query always re-runs enrichment for freshness, regardless of
  // whether the incoming assessment already has list-level enrichment.
  // List enrichment is for triage ("does this row feel stale?"); detail
  // enrichment backs destructive actions ("about to delete this thing").
  // Different freshness requirements, same helpers.
  const dirtyOutcome = await runDirtyEnrichment(candidate.worktreePath, DEFAULT_ENRICHMENT_TIMEOUT_MS);
  const parsedStatus = dirtyOutcome.kind === 'ok'
    ? parsePorcelainStatus(dirtyOutcome.value.rawStatus)
    : {};
  const rawStatusForFingerprint = dirtyOutcome.kind === 'ok' ? dirtyOutcome.value.rawStatus : undefined;

  let commitSummary: CleanupCandidateDetail['commitSummary'];
  if (candidate.baselineRef && isSymbolicBranch(candidate.branch)) {
    const outcome = await runCommitEnrichment({
      repoPath,
      worktreePath: candidate.worktreePath,
      branch: candidate.branch,
      baselineRef: candidate.baselineRef,
    });
    if (outcome.kind === 'ok') {
      commitSummary = outcome.value;
    }
  }

  return {
    projectId: candidate.projectId,
    worktreePath: candidate.worktreePath,
    branch: candidate.branch,
    protectedBranch: candidate.protectedBranch ?? isProtectedBranch(candidate.branch),
    classification: candidate.classification,
    reasonCode: candidate.reasonCode,
    branchRefOid,
    headOid,
    gitDir,
    baselineOid,
    fingerprint: createCleanupFingerprint({
      headOid,
      gitDir,
      branchRefOid,
      baselineOid,
      statusDigest: normalizeStatusDigest(rawStatusForFingerprint),
    }),
    dirtySummary: parsedStatus.summary,
    dirtyFilesSample: parsedStatus.sample,
    commitSummary,
    capabilities: deriveCleanupCapabilitiesForCandidate(candidate),
  };
}

interface CleanupFingerprintInput {
  headOid?: string;
  gitDir?: string;
  branchRefOid?: string;
  baselineOid?: string;
  statusDigest: string;
}

export function createCleanupFingerprint(input: CleanupFingerprintInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

function isSymbolicBranch(branch: string): boolean {
  return !branch.startsWith('(detached at ');
}

function normalizeStatusDigest(rawStatus: string | undefined): string {
  if (rawStatus === undefined) {
    return 'status_failed';
  }

  return rawStatus
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort()
    .join('\n');
}

async function runGit(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', args, { cwd, env: gitExecEnv() });
    return stdout.replace(/\n+$/, '');
  } catch {
    return undefined;
  }
}
