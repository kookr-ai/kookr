/**
 * Cross-project worktree sweep.
 *
 * Iterates every known project and delegates safe cleanup to the existing
 * `cleanupSafeWorkspaceCandidates()` per-project path. The sweep uses the
 * same safe classifications as the per-project panel: strict merged branches
 * and patch-equivalent branches produced by squash merges.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import { canSweepRemove } from '../../core/workspace-cleanup-policy.js';
import type { CleanupCandidateAssessment, CleanupResultSummary } from '../../core/workspace-types.js';
import type {
  SweepReport,
  SweepReportNotAnalyzed,
  WorkspaceSweepProgressSnapshot,
  WorkspaceSweepProgressStatus,
} from '../../shared/contracts/messages.js';
import {
  DEFAULT_STALE_THRESHOLD_DAYS,
  buildSweepReport,
  isBlockedClassification,
  isProbablySafe,
  type SweepReportMeasurements,
} from '../../core/sweep-report.js';
import { measureWorktreeFootprint } from '../../adapters/worktree-footprint.js';
import { scanIgnored } from '../../adapters/ignored-scan.js';
import { readProcessStartTimeMs } from '../../adapters/process-tree.js';
import {
  cleanupSafeWorkspaceCandidates,
  type WorkspaceCleanupDeps,
} from './workspace-cleanup-service.js';
import { hydrateCleanupCandidateDetail } from './workspace-cleanup-detail-query.js';

const execFile = promisify(execFileCb);

const PER_PROJECT_TIMEOUT_MS = 10 * 60_000;
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min
const FETCH_TIMEOUT_MS = 30_000;
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
] as const;

export type SweepProgressEvent = WorkspaceSweepProgressSnapshot & {
  result?: ProjectSweepResult;
};

export interface CrossProjectSweepDeps {
  cleanupDeps: WorkspaceCleanupDeps;
  projectConfigStore: ProjectConfigStore;
  taskStore: TaskStore;
  /** Pre-bound `(projectId) => Promise<repoPath>` — caller binds once. */
  resolveRepoPath: (projectId: string) => Promise<string>;
  /** Called when a project starts or finishes. */
  onProgress?: (progress: SweepProgressEvent) => void;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => Date;
  /** Injectable for tests. */
  lockDir?: string;
  perProjectTimeoutMs?: number;
  /** Staleness threshold (days) for the probably-safe bucket. Default 14. */
  staleThresholdDays?: number;
  /** Injectable OS process probe (liveness + start-time). Real probe by default. */
  processProbe?: ProcessProbe;
}

export type ProjectSweepResult =
  | { kind: 'ok'; projectId: string; summaries: CleanupResultSummary[]; elapsedMs: number }
  | { kind: 'skipped'; projectId: string; reason: 'repo_path_unresolved' }
  | { kind: 'failed'; projectId: string; code: 'timeout' | 'error'; message: string; elapsedMs: number };

export interface CrossProjectSweepResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  projects: ProjectSweepResult[];
  /** Disk-aware diagnosis report assembled from per-project measurement (PR 2). */
  report: SweepReport;
}

/** Per-project measurement side-channel feeding the pure report builder. */
interface ProjectReportInputs extends SweepReportMeasurements {
  safeCandidates: CleanupCandidateAssessment[];
  nonRemoved: CleanupCandidateAssessment[];
  summaries: CleanupResultSummary[];
}

interface ProjectSweepOutcome {
  result: ProjectSweepResult;
  reportInputs?: ProjectReportInputs;
  /** Pre-classification worktree count for the not-analyzed banner. */
  notAnalyzed?: SweepReportNotAnalyzed;
}

export type SweepOutcome =
  | { kind: 'completed'; result: CrossProjectSweepResult }
  | { kind: 'busy'; holderPid: number; heldSince: string };

let sweepProgress: WorkspaceSweepProgressSnapshot | null = null;
let lastCompletedRunId: string | null = null;

export function getSweepProgressSnapshot(): WorkspaceSweepProgressSnapshot | null {
  return sweepProgress ? { ...sweepProgress } : null;
}

/**
 * runId of the most recently completed sweep on this process (in-memory
 * pointer, not report retention). A reconnecting client uses it to request
 * reconstruction of the Removed manifest from the durable ledger.
 */
export function getLastCompletedSweepRunId(): string | null {
  return lastCompletedRunId;
}

/**
 * Union configStore and taskStore projects, deduped, deterministically ordered.
 * Exported for isolated testing.
 */
export function enumerateSweepProjects(
  configStore: ProjectConfigStore,
  taskStore: TaskStore,
): string[] {
  const seen = new Set<string>();
  for (const config of configStore.getAllConfigs()) {
    if (config.project) seen.add(config.project);
  }
  for (const task of taskStore.getAllTasks()) {
    const projectId = task.projectId;
    if (typeof projectId === 'string' && projectId.length > 0) {
      seen.add(projectId);
    }
  }
  return Array.from(seen).sort();
}

/**
 * Run the cross-project sweep. Returns either the completed result or a
 * `busy` marker if another process already holds the sweep lock.
 */
export async function runCrossProjectSweep(
  deps: CrossProjectSweepDeps,
): Promise<SweepOutcome> {
  const now = deps.now ?? (() => new Date());
  const lockDir = deps.lockDir ?? join(homedir(), '.kookr');
  const timeoutMs = deps.perProjectTimeoutMs ?? PER_PROJECT_TIMEOUT_MS;

  const lockAttempt = acquireSweepLock({
    lockDir,
    now,
    ttlMs: LOCK_TTL_MS,
    probe: deps.processProbe ?? defaultProcessProbe,
  });
  if (lockAttempt.kind === 'busy') {
    return { kind: 'busy', holderPid: lockAttempt.holderPid, heldSince: lockAttempt.heldSince };
  }

  const runId = randomUUID();
  const startedAt = now().toISOString();
  const nowMs = now().getTime();
  const thresholdDays = deps.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const projects: ProjectSweepResult[] = [];
  const reportInputs: ProjectReportInputs[] = [];
  const notAnalyzed: SweepReportNotAnalyzed[] = [];

  try {
    const projectIds = enumerateSweepProjects(deps.projectConfigStore, deps.taskStore);
    deps.logger?.info('workspace_sweep_start', { runId, total: projectIds.length });

    for (let offset = 0; offset < projectIds.length; offset++) {
      const projectId = projectIds[offset]!;
      const index = offset + 1;
      emitSweepProgress(deps, {
        runId,
        startedAt,
        index,
        total: projectIds.length,
        projectId,
        status: 'running',
        counts: countsForResults(projects),
      });
      const outcome = await sweepOneProject(projectId, deps, runId, timeoutMs, nowMs, thresholdDays);
      projects.push(outcome.result);
      if (outcome.reportInputs) reportInputs.push(outcome.reportInputs);
      if (outcome.notAnalyzed) notAnalyzed.push(outcome.notAnalyzed);
      emitSweepProgress(deps, {
        runId,
        startedAt,
        index,
        total: projectIds.length,
        projectId,
        status: progressStatusForResult(outcome.result),
        counts: countsForResults(projects),
        result: outcome.result,
      });
    }
  } finally {
    lockAttempt.release();
    sweepProgress = null;
  }

  const report = buildSweepReport({
    runId,
    generatedAt: now().toISOString(),
    nowMs,
    thresholdDays,
    summaries: reportInputs.flatMap((r) => r.summaries),
    safeCandidates: reportInputs.flatMap((r) => r.safeCandidates),
    nonRemoved: reportInputs.flatMap((r) => r.nonRemoved),
    footprints: mergeMaps(reportInputs.map((r) => r.footprints)),
    indexMtimes: mergeMaps(reportInputs.map((r) => r.indexMtimes)),
    ignoredScans: mergeMaps(reportInputs.map((r) => r.ignoredScans)),
    fingerprints: mergeMaps(reportInputs.map((r) => r.fingerprints)),
    notAnalyzed,
  });

  lastCompletedRunId = runId;
  deps.logger?.info('workspace_sweep_finish', { runId, projects: projects.length });

  return {
    kind: 'completed',
    result: {
      runId,
      startedAt,
      finishedAt: now().toISOString(),
      projects,
      report,
    },
  };
}

function mergeMaps<V>(maps: ReadonlyArray<ReadonlyMap<string, V>>): Map<string, V> {
  const merged = new Map<string, V>();
  for (const map of maps) {
    for (const [key, value] of map) merged.set(key, value);
  }
  return merged;
}

async function sweepOneProject(
  projectId: string,
  deps: CrossProjectSweepDeps,
  sweepRunId: string,
  timeoutMs: number,
  nowMs: number,
  thresholdDays: number,
): Promise<ProjectSweepOutcome> {
  const startedAt = Date.now();

  let repoPath: string;
  try {
    repoPath = await deps.resolveRepoPath(projectId);
  } catch {
    return { result: { kind: 'skipped', projectId, reason: 'repo_path_unresolved' } };
  }

  const sweepAttempt = deps.cleanupDeps.attemptRepository.createAttempt({
    type: 'cleanup',
    projectId,
    reasonCode: 'cross_project_sweep',
    source: 'cross_project_sweep',
    evidenceSummary: `Cross-project sweep ${sweepRunId} started for ${projectId}`,
    sweepRunId,
  });

  // Refresh refs before classification so recently merged remote branches are
  // visible to merge-base checks. Then converge half-deleted worktree state
  // from prior sweeps/crashes. Both are non-fatal: the per-candidate
  // classifier still reports visible skipped/blocked reasons where possible.
  await execFile('git', ['-C', repoPath, 'fetch', 'origin', '--prune'], { timeout: FETCH_TIMEOUT_MS, env: gitExecEnv() }).catch(() => undefined);
  await execFile('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 10_000, env: gitExecEnv() }).catch(() => undefined);

  // Cheap worktree count captured BEFORE the timeout-guarded classify so a
  // classification timeout can show a real "not analyzed — N worktrees" banner.
  const worktreeCount = await countWorktrees(repoPath);

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // `inspectCleanupCandidates` (the classification phase) does not observe the
  // abort signal, and the removal loop swallows per-candidate aborts and returns
  // normally — so `cleanupSafeWorkspaceCandidates` never rejects on abort. Racing
  // a rejecting timeout is what actually bounds a hung classification and makes
  // the timeout / "not analyzed" banner reachable; aborting the controller still
  // curtails any in-flight removal git subprocess.
  const timeoutGuard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const cleanupPromise = cleanupSafeWorkspaceCandidates(deps.cleanupDeps, {
      projectId,
      repoPath,
      classificationFilter: canSweepRemove,
      signal: controller.signal,
      sweepRunId,
    });
    // Swallow a late settlement of the losing promise if the timeout wins first.
    cleanupPromise.catch(() => undefined);
    const result = await Promise.race([cleanupPromise, timeoutGuard]);
    // Removal is done — stop the project abort clock so best-effort measurement
    // (each read has its own short timeout) can't trip a spurious timeout that
    // would discard the successful removal summaries.
    clearTimeout(timer);
    // Record success BEFORE measuring so a measurement hiccup can never demote a
    // completed removal to a failure.
    deps.cleanupDeps.attemptRepository.passAttempt(
      sweepAttempt.attemptId,
      `Cross-project sweep completed for ${projectId}; removed ${result.summaries.length} worktree(s)`,
    );

    let reportInputs: ProjectReportInputs;
    try {
      reportInputs = await measureProject(repoPath, result, nowMs, thresholdDays);
    } catch {
      // Defensive: measurement is read-only + best-effort; never fail the sweep.
      reportInputs = {
        safeCandidates: result.safeCandidates,
        nonRemoved: result.nonRemoved,
        summaries: result.summaries,
        footprints: new Map(),
        indexMtimes: new Map(),
        ignoredScans: new Map(),
        fingerprints: new Map(),
      };
    }

    return {
      result: {
        kind: 'ok',
        projectId,
        summaries: result.summaries,
        elapsedMs: Date.now() - startedAt,
      },
      reportInputs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (timedOut) {
      deps.cleanupDeps.attemptRepository.updateAttempt(sweepAttempt.attemptId, {
        status: 'timed_out',
        disposition: 'blocked',
        finishedAt: new Date().toISOString(),
        evidenceSummary: `Cross-project sweep timed out for ${projectId} after ${timeoutMs}ms`,
      });
      deps.logger?.warn('workspace_sweep_project_timeout', { sweepRunId, projectId, timeoutMs, worktreeCount });
      return {
        result: { kind: 'failed', projectId, code: 'timeout', message: `Timed out after ${timeoutMs}ms`, elapsedMs },
        notAnalyzed: { projectId, code: 'timeout', notAnalyzedCount: worktreeCount },
      };
    }
    deps.cleanupDeps.attemptRepository.blockAttempt(
      sweepAttempt.attemptId,
      err instanceof Error ? err.message : String(err),
    );
    deps.logger?.warn('workspace_sweep_project_error', {
      sweepRunId,
      projectId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      result: {
        kind: 'failed',
        projectId,
        code: 'error',
        message: err instanceof Error ? err.message : String(err),
        elapsedMs,
      },
      notAnalyzed: { projectId, code: 'error', notAnalyzedCount: worktreeCount },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the per-worktree disk footprint + git-index mtime for every worktree
 * still on disk (non-Blocked candidates), and — for probably-safe candidates
 * only — hydrate the fingerprint + gitignored-scan the bulk path (PR 3) needs.
 * All reads are best-effort with their own short timeouts; this is read-only.
 */
async function measureProject(
  repoPath: string,
  result: Awaited<ReturnType<typeof cleanupSafeWorkspaceCandidates>>,
  nowMs: number,
  thresholdDays: number,
): Promise<ProjectReportInputs> {
  const footprints = new Map<string, number | null>();
  const indexMtimes = new Map<string, number | null>();
  const ignoredScans = new Map<string, { hasSensitiveIgnored: boolean; sample: string[] }>();
  const fingerprints = new Map<string, string>();

  const removedBranches = new Set(result.summaries.map((s) => s.branch));
  // Worktrees still on disk: non-blocked non-removed candidates + safe
  // candidates whose removal failed (never entered `summaries`).
  const stillOnDisk: CleanupCandidateAssessment[] = [
    ...result.nonRemoved.filter((c) => !!c.worktreePath && !isBlockedClassification(c.classification)),
    ...result.safeCandidates.filter((c) => !!c.worktreePath && !removedBranches.has(c.branch)),
  ];

  for (const candidate of stillOnDisk) {
    const path = candidate.worktreePath!;
    if (footprints.has(path)) continue;
    const footprint = await measureWorktreeFootprint(path);
    footprints.set(path, footprint.footprintBytes);
    indexMtimes.set(path, footprint.lastTouchedMs);
  }

  for (const candidate of result.nonRemoved) {
    const path = candidate.worktreePath;
    if (!path) continue;
    if (!isProbablySafe(candidate, indexMtimes.get(path) ?? null, nowMs, thresholdDays)) continue;
    // Read-only hydration bounded to the probably-safe bucket (PR 3 carries
    // the fingerprint back for re-validation; the ignored-scan drives the
    // gitignored-risk warning).
    try {
      const detail = await hydrateCleanupCandidateDetail(repoPath, candidate);
      fingerprints.set(path, detail.fingerprint);
    } catch {
      // best-effort — a missing fingerprint just means PR 3 re-hydrates.
    }
    ignoredScans.set(path, await scanIgnored(path));
  }

  return {
    safeCandidates: result.safeCandidates,
    nonRemoved: result.nonRemoved,
    summaries: result.summaries,
    footprints,
    indexMtimes,
    ignoredScans,
    fingerprints,
  };
}

/** Count linked worktrees (excludes the main checkout). Best-effort → 0 on failure. */
async function countWorktrees(repoPath: string): Promise<number> {
  try {
    const { stdout } = await execFile('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      timeout: 10_000,
      env: gitExecEnv(),
    });
    const count = stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
    return Math.max(0, count - 1);
  } catch {
    return 0;
  }
}

function emitSweepProgress(deps: CrossProjectSweepDeps, event: SweepProgressEvent): void {
  const { result: _result, ...snapshot } = event;
  sweepProgress = snapshot;
  deps.onProgress?.(event);
}

function countsForResults(projects: ProjectSweepResult[]): WorkspaceSweepProgressSnapshot['counts'] {
  return projects.reduce(
    (acc, result) => {
      if (result.kind === 'ok') acc.done += 1;
      if (result.kind === 'skipped') acc.skipped += 1;
      if (result.kind === 'failed') acc.failed += 1;
      return acc;
    },
    { done: 0, skipped: 0, failed: 0 },
  );
}

function progressStatusForResult(result: ProjectSweepResult): Exclude<WorkspaceSweepProgressStatus, 'running'> {
  switch (result.kind) {
    case 'ok':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
  }
}

// ---------- Lock ----------

interface LockAcquired {
  kind: 'acquired';
  release(): void;
}

interface LockBusy {
  kind: 'busy';
  holderPid: number;
  heldSince: string;
}

/**
 * OS-level probe for a PID. Abstracted so the PID-recycle guard is testable
 * without spawning real processes.
 */
export interface ProcessProbe {
  /** True if `pid` maps to a live process (any owner). */
  isAlive(pid: number): boolean;
  /** Wall-clock start time (ms since epoch) of `pid`, or null if unknown. */
  startTimeMs(pid: number): number | null;
}

const defaultProcessProbe: ProcessProbe = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH → no such process. EPERM (and anything else) → alive but not ours.
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  startTimeMs(pid: number): number | null {
    return readProcessStartTimeMs(pid);
  },
};

/**
 * Slack (ms) absorbed when comparing a process start time against the lock's
 * recorded `startedAt`. The OS start time is coarse (`/proc` `btime` is
 * whole-second granularity), so a live PID is only treated as recycled when it
 * started measurably AFTER the lock. Anything within this window resolves to
 * "held" — the fail-safe side that never risks a double sweep.
 */
const START_TIME_SLACK_MS = 2_000;

type LivePidVerdict = 'held' | 'recycled' | 'unknown';

/**
 * Decide whether a live PID is the original lock holder or an unrelated
 * process that reused a recycled PID. The original holder started BEFORE it
 * wrote the lock; a recycled PID belongs to a process that started AFTER. When
 * the start time or the recorded timestamp is unreadable, return `unknown` so
 * the caller can fall back to its time-to-live heuristic.
 */
function classifyLivePid(
  holder: { pid: number; startedAt: string },
  probe: ProcessProbe,
): LivePidVerdict {
  const startMs = probe.startTimeMs(holder.pid);
  if (startMs === null) return 'unknown';
  const lockMs = Date.parse(holder.startedAt);
  if (Number.isNaN(lockMs)) return 'unknown';
  return startMs - lockMs > START_TIME_SLACK_MS ? 'recycled' : 'held';
}

function acquireSweepLock(opts: {
  lockDir: string;
  now: () => Date;
  ttlMs: number;
  probe: ProcessProbe;
}): LockAcquired | LockBusy {
  mkdirSync(opts.lockDir, { recursive: true });
  const lockPath = join(opts.lockDir, 'sweep.lock');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      const payload = JSON.stringify({ pid: process.pid, startedAt: opts.now().toISOString() });
      writeFileSync(fd, payload);
      closeSync(fd);
      return {
        kind: 'acquired',
        release() {
          try {
            unlinkSync(lockPath);
          } catch {
            // best-effort — if another process stole it, nothing useful to do.
          }
        },
      };
    } catch (err) {
      if (!isEExist(err)) throw err;
      if (attempt === 1) {
        // Second attempt also failed — fall through to report busy.
        break;
      }
      if (tryReclaimStaleLock(lockPath, opts.ttlMs, opts.probe)) continue;
      break;
    }
  }

  const holder = readLockHolder(lockPath);
  return { kind: 'busy', holderPid: holder.pid, heldSince: holder.startedAt };
}

function tryReclaimStaleLock(lockPath: string, ttlMs: number, probe: ProcessProbe): boolean {
  const holder = readLockHolder(lockPath);
  if (holder.pid > 0) {
    if (!probe.isAlive(holder.pid)) {
      // Process is dead — reclaim.
      reclaimLockFile(lockPath);
      return true;
    }
    // A live PID is authoritative: a legitimately slow sweep can exceed the
    // TTL while still running, so mtime staleness must NEVER override a live
    // holder (that would allow a concurrent double-sweep). The one exception
    // is a recycled PID — after a crash the OS can reassign the dead holder's
    // PID to an unrelated live process, wedging the lock forever. The start
    // time disambiguates: a PID that started AFTER the lock was written is a
    // recycled one and is reclaimed. When the start time is unreadable we
    // cannot prove recycling, so we stay on the fail-safe side and hold —
    // never risking a double-sweep on an unreadable-but-live PID.
    if (classifyLivePid(holder, probe) === 'recycled') {
      reclaimLockFile(lockPath);
      return true;
    }
    return false;
  }
  // Malformed lock file (no readable pid) — fall back to mtime TTL.
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      unlinkSync(lockPath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function reclaimLockFile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Someone else already did.
  }
}

/**
 * Process-wide sweep-running check based on the lock file.
 *
 * The lock file is the authoritative signal across all WebSocket clients
 * and co-resident Kookr instances. Using it here keeps the per-connection
 * MessageRouter out of the snapshot-fan-out path.
 */
export function isSweepInProgress(lockDir?: string, probe: ProcessProbe = defaultProcessProbe): boolean {
  const dir = lockDir ?? join(homedir(), '.kookr');
  const lockPath = join(dir, 'sweep.lock');
  const holder = readLockHolder(lockPath);
  if (holder.pid <= 0) return false;
  if (!probe.isAlive(holder.pid)) return false;
  // A live PID that demonstrably started after the lock was written is a
  // recycled PID, not the original sweep — report not-running. When the start
  // time is unknown, stay conservative and report running (matches the prior
  // EPERM behavior and keeps the UI from offering an overlapping sweep).
  return classifyLivePid(holder, probe) !== 'recycled';
}

function readLockHolder(lockPath: string): { pid: number; startedAt: string } {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const pid = typeof (parsed as { pid?: unknown }).pid === 'number'
        ? (parsed as { pid: number }).pid
        : 0;
      const startedAt = typeof (parsed as { startedAt?: unknown }).startedAt === 'string'
        ? (parsed as { startedAt: string }).startedAt
        : '';
      return { pid, startedAt };
    }
  } catch {
    // Missing or malformed lock file
  }
  return { pid: 0, startedAt: '' };
}

function isEExist(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

function gitExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) {
    delete env[name];
  }
  return env;
}
