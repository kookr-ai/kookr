/**
 * Post-recovery critical-schedule re-arm + queue-fill kick (issue #2196).
 *
 * After multi-day outages / daemon restarts the fleet can return meta-only
 * while:
 *   1. Allowlisted residual schedules stay `enabled=false` (ops drift)
 *   2. Free slots sit idle with an empty queue and no product refill
 *
 * This service:
 *   A. Re-enables allowlisted critical schedules that lack an operator hold
 *   B. When free≥N + empty queue + healthy dispatch: at most one scout+batch
 *      kick per product repo per UTC day (skips when scout/batch already active).
 *      A create-then-`launch_error` (expired Grok session login) does not
 *      persist the UTC-day key or stamp `lastStarvationScoutAt`, so the next
 *      tick can retry (issue #2744). No pay-per-token API-key auth path.
 *
 * Pure decisions live in `core/critical-schedule-rearm` and
 * `core/post-recovery-queue-fill`. This module owns timer, durable day keys,
 * audit rows, and launches (reusing starvation scout/batch helpers).
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from '../core/persistence-utils.js';
import { appendAuditRow } from '../core/audit-log.js';
import {
  decideCriticalScheduleRearm,
  type CriticalRearmScheduleView,
} from '../core/critical-schedule-rearm.js';
import {
  decidePostRecoveryQueueFill,
  POST_RECOVERY_KICK_STATE_SCHEMA,
  POST_RECOVERY_MIN_FREE_SLOTS,
  postRecoveryKickIdempotencyKey,
  type PostRecoveryKickRepoState,
} from '../core/post-recovery-queue-fill.js';
import {
  defaultCheckoutGuess,
  isParallelIssueBatchInFlightForRepo,
  isParallelIssueBatchPlaybookId,
  isValidRepoFullName,
  repoToPlaybookSlug,
  STARVATION_SCOUT_LAUNCH_ERROR_RETRY_CAP,
} from '../core/pipeline-starvation.js';
import {
  countTerminatedAtLaunchIdeaScoutsForRepo,
  isIdeaScoutInFlightForRepo,
} from '../core/pipeline-starvation-ideation.js';
import { isTerminatedAtLaunch } from '../shared/contracts/task.js';
import {
  loadPipelineStarvationState,
  savePipelineStarvationState,
} from '../core/pipeline-starvation-state.js';
import { projectIdFromRepoSpecifier } from '../core/project-identity.js';
import type { Schedule } from '../core/schedule.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import { preparePlaybookLaunchWithMetadata } from './use-cases/playbook-launch.js';

export const POST_RECOVERY_PROVENANCE = 'post-recovery' as const;

/** Default tick period — recovery is not urgent; 60s matches idle-refinery. */
export const DEFAULT_POST_RECOVERY_TICK_MS = 60_000;

export interface ProductBatchRepoCandidate {
  repo: string;
  localPath?: string;
}

export interface PostRecoveryServiceDeps {
  /** List all schedules (enabled + disabled). */
  listSchedules: () => readonly Schedule[];
  /** Persist-enabled toggle (clears hold on enable). */
  setEnabled: (id: string, enabled: boolean) => Promise<unknown> | unknown;
  taskStore: TaskStore;
  /** Same capacity ledger as health / idle-refinery. */
  getCapacityLedger: () => CapacityLedger;
  launcher: (opts: LaunchOpts) => Promise<LaunchResult>;
  /**
   * True when dispatch can launch product work (not fleet-wide auth_expired /
   * zero launchable agents). Defaults to true when omitted.
   */
  isDispatchHealthy?: () => boolean;
  /** Operator drain gate. */
  isAccepting?: () => boolean;
  /** Automation kill-switch (SAFE MODE). */
  isAutomationEnabled?: () => boolean;
  /** `~/.kookr` for audit.jsonl. */
  kookrDir?: string;
  /** Override durable post-recovery kick state dir (tests). */
  kickStateDir?: string;
  /** Override pipeline-starvation state dir when arming scout-complete kick. */
  starvationStateDir?: string;
  now?: () => number;
  log?: (line: string) => void;
  tickIntervalMs?: number;
  /** Free-slot floor (default {@link POST_RECOVERY_MIN_FREE_SLOTS}). */
  minFreeSlots?: number;
}

export interface RearmResult {
  rearmed: Array<{ id: string; name: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}

export interface QueueFillKickResult {
  repo: string;
  kicked: boolean;
  reason?: string;
  scoutTaskId?: string;
  utcDay?: string;
}

export class PostRecoveryService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  /**
   * Critical-schedule re-arm runs once per process lifetime (boot recovery).
   * Continuous re-arm every tick would thrash intentional Pause and spam audit.
   * Queue-fill kicks still run every tick (UTC-day gated).
   */
  private criticalRearmDone = false;
  private readonly deps: PostRecoveryServiceDeps;

  constructor(deps: PostRecoveryServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private auditPath(): string | undefined {
    return this.deps.kookrDir ? join(this.deps.kookrDir, 'audit.jsonl') : undefined;
  }

  private kickStateDir(): string {
    if (this.deps.kickStateDir) return this.deps.kickStateDir;
    // When kookrDir is set (prod `~/.kookr` or test temp), keep kick state under it.
    if (this.deps.kookrDir) {
      return join(this.deps.kookrDir, 'playbook-state', 'post-recovery-queue-fill');
    }
    return join(homedir(), '.kookr', 'playbook-state', 'post-recovery-queue-fill');
  }

  start(): void {
    if (this.interval) return;
    const period = this.deps.tickIntervalMs ?? DEFAULT_POST_RECOVERY_TICK_MS;
    this.interval = setInterval(() => {
      void this.tick();
    }, period);
    this.interval.unref?.();
    // Deferred first pass (not sync-on-listen): lets startup recovery finish
    // and avoids competing with boot hooks under test load. Still well inside
    // one schedule tick after daemon start.
    const firstDelayMs = Math.min(5_000, period);
    const first = setTimeout(() => {
      void this.tick();
    }, firstDelayMs);
    first.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * One recovery pass: re-arm critical schedules, then queue-fill kicks for
   * product batch repos. Exposed for tests. Never throws.
   */
  async tick(): Promise<{ rearm: RearmResult; kicks: QueueFillKickResult[] }> {
    const empty: { rearm: RearmResult; kicks: QueueFillKickResult[] } = {
      rearm: { rearmed: [], skipped: [] },
      kicks: [],
    };
    if (this.stopped) return empty;
    if (this.ticking) return empty;
    this.ticking = true;
    try {
      if (this.deps.isAccepting && !this.deps.isAccepting()) {
        return empty;
      }
      if (this.deps.isAutomationEnabled && !this.deps.isAutomationEnabled()) {
        return empty;
      }

      let rearm: RearmResult = { rearmed: [], skipped: [] };
      if (!this.criticalRearmDone) {
        rearm = await this.rearmCriticalSchedules();
        this.criticalRearmDone = true;
      }
      const kicks = await this.runQueueFillKicks();
      return { rearm, kicks };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[post-recovery] tick failed: ${message}`);
      return empty;
    } finally {
      this.ticking = false;
    }
  }

  /** Re-enable allowlisted critical schedules without operator hold. */
  async rearmCriticalSchedules(): Promise<RearmResult> {
    const schedules = this.deps.listSchedules();
    const views: CriticalRearmScheduleView[] = schedules.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      operatorHold: s.operatorHold,
      stopReason: s.stopReason,
      playbook: { path: s.playbook.path },
    }));

    const rearmed: RearmResult['rearmed'] = [];
    const skipped: RearmResult['skipped'] = [];
    const nowMs = this.now();

    for (const schedule of views) {
      const decision = decideCriticalScheduleRearm(schedule);
      if (!decision.rearm) {
        // Only audit/skip-log allowlisted holds so noise stays low.
        if (decision.reason === 'operator_hold') {
          skipped.push({ id: schedule.id, name: schedule.name, reason: decision.reason });
        }
        continue;
      }
      try {
        await this.deps.setEnabled(schedule.id, true);
        rearmed.push({ id: schedule.id, name: schedule.name });
        this.deps.log?.(
          `[post-recovery] re-armed critical schedule "${schedule.name}" (${schedule.id})`,
        );
        await appendAuditRow(this.auditPath(), {
          action: 'critical_schedule_rearm',
          provenance: POST_RECOVERY_PROVENANCE,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          playbookPath: schedule.playbook.path,
          at: new Date(nowMs).toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        skipped.push({ id: schedule.id, name: schedule.name, reason: `error:${message}` });
        this.deps.log?.(
          `[post-recovery] re-arm failed for "${schedule.name}": ${message}`,
        );
      }
    }

    return { rearmed, skipped };
  }

  /** Capacity-gated, per-repo, once-per-UTC-day scout kicks. */
  async runQueueFillKicks(): Promise<QueueFillKickResult[]> {
    const ledger = this.deps.getCapacityLedger();
    const effectiveFree = Math.min(
      ledger.free,
      ledger.freeForGeneralSources ?? ledger.free,
    );
    const dispatchHealthy = this.deps.isDispatchHealthy?.() ?? true;
    const tasks = this.deps.taskStore.listTasks();
    const candidates = collectProductBatchRepos(this.deps.listSchedules());
    const results: QueueFillKickResult[] = [];
    const nowMs = this.now();
    const minFree = this.deps.minFreeSlots ?? POST_RECOVERY_MIN_FREE_SLOTS;
    // Local free budget so multi-repo product fleets cannot over-spawn in one
    // tick against a frozen ledger snapshot (W1).
    let freeBudget = effectiveFree;

    for (const candidate of candidates) {
      const priorKick = await loadKickState(candidate.repo, this.kickStateDir());
      const scoutInFlight = isIdeaScoutInFlightForRepo(candidate.repo, tasks);
      const batchInFlight = isParallelIssueBatchInFlightForRepo(candidate.repo, tasks);
      const decision = decidePostRecoveryQueueFill({
        free: freeBudget,
        pendingQueueDepth: ledger.pendingQueueDepth,
        dispatchHealthy,
        scoutOrBatchInFlight: scoutInFlight || batchInFlight,
        lastKickUtcDay: priorKick?.lastKickUtcDay ?? null,
        repo: candidate.repo,
        minFreeSlots: minFree,
        nowMs,
      });

      if (!decision.kick) {
        results.push({
          repo: candidate.repo,
          kicked: false,
          reason: decision.reason,
          utcDay: decision.utcDay,
        });
        continue;
      }

      const utcDayStartMs = Date.parse(`${decision.utcDay}T00:00:00.000Z`);
      const launchErrorRetries = Number.isFinite(utcDayStartMs)
        ? countTerminatedAtLaunchIdeaScoutsForRepo(candidate.repo, tasks, utcDayStartMs)
        : 0;
      if (launchErrorRetries >= STARVATION_SCOUT_LAUNCH_ERROR_RETRY_CAP) {
        const message =
          `scout launch_error retry budget exhausted (${launchErrorRetries} today)`;
        this.deps.log?.(
          `[post-recovery] queue-fill kick skipped for ${candidate.repo}: ${message}`,
        );
        await appendAuditRow(this.auditPath(), {
          action: 'post_recovery_queue_fill_kick_failed',
          provenance: POST_RECOVERY_PROVENANCE,
          repo: candidate.repo,
          utcDay: decision.utcDay,
          error: message,
          at: new Date(nowMs).toISOString(),
        });
        results.push({
          repo: candidate.repo,
          kicked: false,
          reason: `error:${message}`,
          utcDay: decision.utcDay,
        });
        continue;
      }

      try {
        const launch = await this.spawnRecoveryScout(
          candidate,
          decision.utcDay,
          nowMs,
          launchErrorRetries,
        );
        const launched = this.deps.taskStore.getTask(launch.task.id) ?? launch.task;
        if (isTerminatedAtLaunch(launched)) {
          const detail = launched.disposition?.detail?.trim()
            || launched.disposition?.reason
            || 'launch_error';
          const message = `scout died at launch (${detail})`;
          this.deps.log?.(
            `[post-recovery] queue-fill kick failed for ${candidate.repo}: ${message}`
            + ' — not stamping lastStarvationScoutAt',
          );
          await appendAuditRow(this.auditPath(), {
            action: 'post_recovery_queue_fill_kick_failed',
            provenance: POST_RECOVERY_PROVENANCE,
            repo: candidate.repo,
            utcDay: decision.utcDay,
            scoutTaskId: launched.id,
            error: message,
            disposition: launched.disposition?.reason ?? 'launch_error',
            at: new Date(nowMs).toISOString(),
          });
          results.push({
            repo: candidate.repo,
            kicked: false,
            reason: `error:${message}`,
            utcDay: decision.utcDay,
          });
          continue;
        }
        const scoutTaskId = launched.id;

        // Arm starvation scout-complete batch kick so implement re-enters when
        // the scout finishes (reuses #1715 R5 path when KOOKR_PIPELINE_BATCH_KICK
        // is on; still records lastStarvationScoutTaskId for open-episode match).
        await this.armStarvationKickAfterScout(candidate.repo, scoutTaskId, nowMs);

        const nextState: PostRecoveryKickRepoState = {
          schemaVersion: POST_RECOVERY_KICK_STATE_SCHEMA,
          repo: candidate.repo,
          lastKickUtcDay: decision.utcDay,
          lastKickAt: new Date(nowMs).toISOString(),
          lastKickScoutTaskId: scoutTaskId,
          updatedAt: new Date(nowMs).toISOString(),
        };
        await saveKickState(nextState, this.kickStateDir());

        await appendAuditRow(this.auditPath(), {
          action: 'post_recovery_queue_fill_kick',
          provenance: POST_RECOVERY_PROVENANCE,
          repo: candidate.repo,
          utcDay: decision.utcDay,
          scoutTaskId,
          queued: launch.queued === true,
          free: freeBudget,
          pendingQueueDepth: ledger.pendingQueueDepth,
          at: new Date(nowMs).toISOString(),
        });

        this.deps.log?.(
          `[post-recovery] queue-fill kick for ${candidate.repo} → scout ${scoutTaskId}`
          + `${launch.queued ? ' (queued)' : ''}`,
        );

        // One successful kick consumes a free slot from this tick's budget.
        freeBudget = Math.max(0, freeBudget - 1);

        results.push({
          repo: candidate.repo,
          kicked: true,
          scoutTaskId,
          utcDay: decision.utcDay,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log?.(
          `[post-recovery] queue-fill kick failed for ${candidate.repo}: ${message}`,
        );
        await appendAuditRow(this.auditPath(), {
          action: 'post_recovery_queue_fill_kick_failed',
          provenance: POST_RECOVERY_PROVENANCE,
          repo: candidate.repo,
          utcDay: decision.utcDay,
          error: message,
          at: new Date(nowMs).toISOString(),
        });
        results.push({
          repo: candidate.repo,
          kicked: false,
          reason: `error:${message}`,
          utcDay: decision.utcDay,
        });
      }
    }

    return results;
  }

  private async spawnRecoveryScout(
    candidate: ProductBatchRepoCandidate,
    utcDay: string,
    nowMs: number,
    launchErrorRetries = 0,
  ): Promise<LaunchResult> {
    const localPath = candidate.localPath?.trim() || '';
    const projectId = projectIdFromRepoSpecifier(candidate.repo) ?? undefined;
    const taskTargetCwd = localPath || defaultCheckoutGuess(candidate.repo);

    const prepared = await preparePlaybookLaunchWithMetadata({
      cwd: taskTargetCwd,
      playbookPath: 'repository-idea-scout.md',
      scope: 'plugin',
      parameterValues: {
        repoFullName: candidate.repo,
        localPath: localPath || '',
        workProfile: 'balanced',
        workloadSize: 'quick-shortlist',
        publishBehavior: 'publish-safe',
        minimumIssueScan: '100',
        useKnowledgeBase: 'auto',
        extraInstruction:
          `Post-recovery queue-fill kick (issue #2196, provenance=${POST_RECOVERY_PROVENANCE}, `
          + `utcDay=${utcDay}). Free capacity returned with an empty queue after outage/restart. `
          + `Prefer single-PR-safe leaves; do not invent low-product work.`,
      },
      taskTargetCwd,
      taskTargetCwdExplicit: true,
    });

    const launchOpts: LaunchOpts = {
      ...prepared.launchOpts,
      playbookId: prepared.launchOpts.playbookId ?? 'repository-idea-scout.md',
      projectId: prepared.launchOpts.projectId ?? projectId,
      launchSource: 'api',
      disableDedup: true,
      autoCloseOnSignal: true,
      idempotencyKey: postRecoveryKickIdempotencyKey(
        candidate.repo,
        utcDay,
        launchErrorRetries,
      ),
      name: `Idea scout (post-recovery fill): ${candidate.repo}`,
    };

    return this.deps.launcher(launchOpts);
  }

  private async armStarvationKickAfterScout(
    repo: string,
    scoutTaskId: string,
    nowMs: number,
  ): Promise<void> {
    try {
      const prior = await loadPipelineStarvationState(repo, {
        stateDir: this.deps.starvationStateDir,
        nowMs,
      });
      const nowIso = new Date(nowMs).toISOString();
      const next = {
        ...prior,
        lastStarvationScoutAt: nowIso,
        lastStarvationScoutTaskId: scoutTaskId,
        kickBatchWhenScoutCompletes: true,
        kickBatchWhenScoutCompletesAt: nowIso,
        updatedAt: nowIso,
      };
      await savePipelineStarvationState(next, { stateDir: this.deps.starvationStateDir });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(
        `[post-recovery] failed to arm starvation batch kick for ${repo}: ${message}`,
      );
    }
  }
}

/**
 * Product repos to consider for post-recovery fill: unique repoFullName from
 * parallel-issue-batch schedules (enabled or disabled). Disabled experimental
 * batches still name the product repo so recovery can refill after outage;
 * per-day + in-flight gates prevent thrash.
 */
export function collectProductBatchRepos(
  schedules: readonly Schedule[],
): ProductBatchRepoCandidate[] {
  const byRepo = new Map<string, ProductBatchRepoCandidate>();
  for (const schedule of schedules) {
    if (!isParallelIssueBatchPlaybookId(schedule.playbook.path)) continue;
    const repo = (
      schedule.playbook.parameters?.repoFullName
      ?? schedule.playbook.parameters?.repo
      ?? ''
    ).trim();
    if (!isValidRepoFullName(repo)) continue;
    const localPath = (schedule.playbook.parameters?.localPath ?? '').trim() || undefined;
    const key = repo.toLowerCase();
    const existing = byRepo.get(key);
    // Prefer enabled schedule's localPath when merging duplicates.
    if (!existing) {
      byRepo.set(key, { repo, localPath });
    } else if (schedule.enabled && localPath) {
      byRepo.set(key, { repo, localPath });
    } else if (!existing.localPath && localPath) {
      byRepo.set(key, { repo, localPath });
    }
  }
  return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

function kickStatePath(stateDir: string, repo: string): string {
  return join(stateDir, `${repoToPlaybookSlug(repo)}.json`);
}

async function loadKickState(
  repo: string,
  stateDir: string,
): Promise<PostRecoveryKickRepoState | null> {
  try {
    const raw = await readFile(kickStatePath(stateDir, repo), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PostRecoveryKickRepoState>;
    if (parsed.schemaVersion !== POST_RECOVERY_KICK_STATE_SCHEMA) return null;
    if (typeof parsed.repo !== 'string') return null;
    return {
      schemaVersion: POST_RECOVERY_KICK_STATE_SCHEMA,
      repo: parsed.repo,
      lastKickUtcDay: typeof parsed.lastKickUtcDay === 'string' ? parsed.lastKickUtcDay : undefined,
      lastKickAt: typeof parsed.lastKickAt === 'string' ? parsed.lastKickAt : undefined,
      lastKickScoutTaskId:
        typeof parsed.lastKickScoutTaskId === 'string' ? parsed.lastKickScoutTaskId : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

async function saveKickState(
  state: PostRecoveryKickRepoState,
  stateDir: string,
): Promise<void> {
  const path = kickStatePath(stateDir, state.repo);
  await mkdir(dirname(path), { recursive: true });
  // lastKickScoutTaskId is operator-private — match sibling secret stores
  // (settings.json, share-grants) with owner-only mode via fchmod after umask.
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
