import { stat } from 'node:fs/promises';
import type { Task, TaskLaunchHealthSummary, TaskStore } from '../core/tasks.js';
import type { LaunchOpts, LaunchResult as SharedLaunchResult } from '../shared/contracts/launch.js';
import type { DeliveryAuthorization, TaskDispositionReason } from '../shared/contracts/task.js';
import {
  type AgentType,
  type AgentSelection,
  type AgentFallbackPolicy,
  DEFAULT_AGENT_TYPE,
  ROUND_ROBIN_AGENT_TYPE,
  resolveRoundRobinAgent,
  resolvePinnedAgentFallback,
  isValidEffortForAgent,
  effortLevelsForAgent,
  isValidModelForAgent,
  modelsForAgent,
} from '../core/agent-types.js';
import type { AgentSubstitutionHop } from '../shared/contracts/task.js';
import { filterLaunchableAgentTypes } from '../adapters/grok-auth-availability.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { LaunchDependency } from '../core/playbook.js';
import {
  redactDiagnosticText,
  type DependencyPreflightRunner,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { appendAuditRow } from '../core/audit-log.js';
import { defaultVerdictPath } from '../core/ralph-iteration-verdict.js';
import { MAX_ACTIVE_TASKS } from './config.js';
import { registerNewAgent, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { hashPrompt } from './hash-prompt.js';
import { runLaunchDependencyPreflights } from './launch-dependency-runner.js';
import { canonicalizeCwd } from './cwd.js';
import { normalizePromptFileReferences } from './prompt-file-paths.js';
import { applyWorktreeGuardrails, type DeliveryPolicy } from './worktree-guardrails.js';
import type { IdempotencyLedger } from '../core/idempotency-ledger.js';
import { isTerminalStatus } from '../core/task-status.js';
import { buildCapacityLedger, isReservedSlotLaunch, type CapacityLedger } from '../core/capacity-ledger.js';
import { spawnBudgetKey, type SpawnRateLimiter, type SpawnRateVerdict } from '../core/spawn-rate-limiter.js';
import { evaluateHostLoadAdmission, type HostLoadSample } from '../core/host-load-admission.js';
import {
  evaluateQuotaHeadroomAdmission,
  QUOTA_NO_HEADROOM_UTILIZATION,
  type QuotaHeadroomSample,
} from '../core/quota-headroom-admission.js';
import type { PlanQuotaBindingCache } from '../core/plan-quota-binding-cache.js';
import { LaunchPhaseTracker, type LaunchPhaseTimings } from '../core/launch-phase-timings.js';
import {
  classifyLaunchFailureReason,
  type LaunchOutcomeMetrics,
} from '../core/launch-outcome-metrics.js';
import type { RelaunchArbiter, RelaunchLease } from './relaunch-arbiter.js';
import { isAutonomousLaunchSource } from '../core/automation-kill-switch.js';
import {
  buildTaskLaunchIntent,
  launchIntentPins,
  sameLaunchIntent,
  validatePersistedLaunchIntent,
} from '../core/task-launch-intent.js';

export type { LaunchOpts } from '../shared/contracts/launch.js';
export type LaunchResult = SharedLaunchResult<Task>;

export interface LaunchTaskServerOptions {
  /** Server-internal policy resolved from trusted launch context, never from shared LaunchOpts. */
  deliveryPolicy?: DeliveryPolicy;
  /**
   * Bypass the SAFE-MODE autonomous-launch gate for this launch (issue #2672).
   * Set ONLY by the schedule runner for the cross-repo orchestrator fire, so
   * that schedule keeps ticking during SAFE MODE (it snapshots, honors the
   * pause, and spawns nothing). Never derived from a client-supplied
   * `LaunchOpts` — this is a trusted, server-internal channel.
   */
  safeModeExempt?: boolean;
}

export interface LaunchServiceDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  /** Optional live session probe used to keep dedup from trusting stale inProgress records. */
  terminalBackend?: Pick<TerminalBackend, 'isAlive'>;
  /** Live getter for max concurrent tasks. Falls back to static default if not provided. */
  getMaxActiveTasks?: () => number;
  /**
   * Live getter for the configured default agent selection. Falls back to the
   * registry default if not provided. May return the `round-robin` sentinel,
   * which {@link roundRobinCursor} resolves to a concrete agent.
   */
  getDefaultAgentType?: () => AgentSelection;
  /**
   * Round-robin rotation cursor. `peek()` reads the rotation index for the
   * next launch *without* advancing; `advance()` moves the cursor forward and
   * persists it. The launch service peeks when resolving the `round-robin`
   * sentinel and advances only once a task record is actually committed, so a
   * deduplicated or rejected launch never consumes a rotation slot and skews
   * the alternation.
   */
  roundRobinCursor?: { peek: () => number; advance: () => void };
  /**
   * Boot-reliability failover precondition (issue #1898, WS1.6). Given the set
   * of currently-registered adapter types, returns the subset whose recent
   * boot-latency signal is unhealthy — passed to {@link resolveRoundRobinAgent}
   * so the rotation deprioritizes them (while a healthy alternative remains)
   * instead of selecting a boot-unreliable agent that then hangs until the
   * fire() wall-clock cap (#1708) trips. Omitted in tests / deployments without
   * the monitor: the rotation then applies no deprioritization.
   */
  getDeprioritizedAgentTypes?: (available: readonly AgentType[]) => readonly AgentType[];
  /**
   * Grok session/OIDC usability for launch-time agent selection (issue #2194).
   * When `false`, round-robin and plan-quota rotation exclude `grok-build` so
   * a healthy non-Grok backend is preferred over a known-auth-failed slot.
   * Absent ⇒ no auth filter (back-compat). Never consults API-key auth.
   */
  isGrokAuthUsable?: () => boolean;
  /**
   * Optional refresh of the Grok auth usability cache before agent selection
   * (issue #2194). Best-effort; a probe fault must not fail the launch.
   */
  refreshGrokAuthAvailability?: () => Promise<void>;
  /**
   * Automatic fallback policy (issue #2001). Applied when plan-quota admission
   * rotates off claude-code and when schedule WS1.3 substitutes a pin. Absent
   * ⇒ no filter (back-compat for older wiring/tests). Production wires this
   * from `settings.disallowAgentFallback` / `settings.agentFallbackAllowlist`.
   */
  getAgentFallbackPolicy?: () => AgentFallbackPolicy;
  /**
   * Feed one launch's boot latency (from the #1589 phase timings) into the
   * boot-reliability monitor, at every launch finalization (success or
   * abandonment). Best-effort; never called with an unresolved sentinel agent.
   */
  recordLaunchBootLatency?: (agentType: AgentType, timings: LaunchPhaseTimings) => void;
  interactionLog?: DeferredInteractionLogWriter;
  /**
   * Shared `audit.jsonl` path (issue #2500). When set, a launch abandoned after
   * its dtach master came up writes a `session.reap`-shaped audit row (actor
   * `system:launch-service`) as it links + reaps that late master — the same
   * durable evidence the periodic {@link SessionReaperService} sweep emits, so
   * an operator can confirm this out-of-sweep reap fired. Omitted (older
   * wiring/tests) ⇒ no audit row (the record + kill still happen).
   */
  auditLogPath?: string;
  dependencyPreflightRunner?: DependencyPreflightRunner;
  /**
   * Operator drain gate (issue #659). When provided and returning false, the
   * node is draining and {@link launchTask} refuses new launches by throwing
   * {@link DrainModeError}. Omitted (or always-true) means the node accepts
   * launches normally — in-flight agents are never affected either way.
   */
  isAccepting?: () => boolean;
  /**
   * Automation kill-switch (issue #1710 / #1699 WS0.4). When provided and
   * returning false, autonomous launches (`launchSource: 'schedule'`) are
   * refused with {@link AutomationKillSwitchError}. Manual sources remain
   * accepted. Omitted means automation enabled (back-compat).
   */
  isAutomationEnabled?: () => boolean;
  /**
   * Test seam for the launch cwd existence check (RFC F12). E2E specs launch
   * tasks into the fictional `/test/project` against FakeTerminalBackend,
   * where nothing is ever spawned in that directory; a no-op override keeps
   * those launches accepted. Omitted in production: launches into a missing
   * cwd are rejected with {@link CwdValidationError}.
   */
  validateLaunchCwd?: (cwd: string) => Promise<void>;
  /** True when launches should be audited as running without permission prompts. */
  bypassAllPermissions?: boolean;
  /**
   * Durable idempotency ledger (issue #1526 Phase B). When provided AND the
   * launch request carries `opts.idempotencyKey`, {@link launchTask} routes
   * through the reserve/replay wrapper instead of launching directly.
   * Omitted, or a launch with no key, behaves exactly as before (no
   * idempotency protection) — this keeps every existing caller unaffected.
   */
  idempotencyLedger?: IdempotencyLedger;
  /**
   * Live getter for the adapter-launch hard timeout, in milliseconds (issue
   * #1526 Phase C / #1528, `launchTimeoutSeconds` setting). Read per launch so
   * a settings change applies without a restart. Absent (older wiring/tests)
   * or non-positive/non-finite values fall back to
   * {@link DEFAULT_LAUNCH_TIMEOUT_MS}.
   */
  getLaunchTimeoutMs?: () => number;
  /**
   * Live getter for the pending-queue depth limit (issue #1526 Phase C / C3,
   * `maxPendingTasks` setting). When a launch would pend at capacity and the
   * pending count is already at this limit, `launchTask` throws
   * {@link PendingQueueFullError} instead of silently enqueueing. Absent
   * falls back to {@link DEFAULT_MAX_PENDING_TASKS}.
   */
  getMaxPendingTasks?: () => number;
  /**
   * Per-source spawn budget (issue #1526 Phase C / C3, `spawnBurstLimit` /
   * `spawnBurstWindowMinutes` settings). When provided, task creation is
   * counted per launch source (actor-qualified via `opts.launchActorId`);
   * exceeding the sliding-window budget throws {@link SpawnBurstLimitError}.
   * Schedule-fired launches (`launchSource: 'schedule'`) are exempt — see the
   * limiter's module docs for why. Absent (older wiring/tests) means no
   * budget enforcement.
   */
  spawnRateLimiter?: SpawnRateLimiter;
  /**
   * Reserved self-maintenance slot count (issue #1564, `reservedActiveSlots`
   * setting). When provided and > 0, a launch whose source/actor is NOT in
   * {@link getReservedSlotSources} is admitted only while the active count is
   * below `maxActiveTasks - reservedActiveSlots`; at or above that it pends
   * instead of consuming a reserved slot. Privileged launches use the full
   * `maxActiveTasks`. Absent (older wiring/tests) ⇒ no reservation, unchanged.
   */
  getReservedActiveSlots?: () => number;
  /**
   * Live getter for the privileged reserved-slot source/actor identifiers
   * (issue #1564, `reservedSlotSources` setting). A launch is privileged when
   * its `launchSource` or attributed `launchActorId` matches an entry. Absent
   * ⇒ empty list (no launch is privileged, so the reservation, if any, holds
   * slots back from everyone — the conservative default).
   */
  getReservedSlotSources?: () => readonly string[];
  /**
   * Rich capacity-ledger snapshot for backpressure error bodies (issue #1526
   * Phase C / C3). Wired in production to the SAME builder `GET /api/health`
   * uses (watchdog-aware `hungSuspect` classification) so a 429 body and the
   * health endpoint tell one story. Absent, a degraded snapshot is built from
   * the task store alone (hungSuspect always 0).
   */
  getCapacityLedger?: () => CapacityLedger;
  /**
   * CPU-aware task admission (issue #1630). Live getter for the load-per-core
   * threshold (`KOOKR_MAX_HOST_LOAD_PER_CPU`). When it returns a value > 0 AND
   * {@link getHostLoadSample} is wired, a launch is rejected with
   * {@link HostLoadAdmissionError} while the sampled 1-minute load average per
   * logical CPU exceeds this threshold — so a burst of compile/test-heavy tasks
   * cannot saturate the shared host and starve the supervisor event loop.
   * `0`/absent disables the gate (behavior unchanged). Unlike the pending-queue
   * guard this fires regardless of active-task count: host saturation is a
   * function of aggregate CPU, not task count.
   */
  getMaxHostLoadPerCpu?: () => number;
  /**
   * Host load sampler for the admission gate above. Production wires this to
   * `os.loadavg()` / `os.cpus()`; tests inject a fixed sample. Only consulted
   * when {@link getMaxHostLoadPerCpu} returns a positive threshold.
   */
  getHostLoadSample?: () => HostLoadSample;
  /**
   * Live Anthropic quota headroom for claude-code admission (issue #1894 /
   * #1699 WS1.2, extended by #1936). When provided, a `claude-code` launch
   * that would enter an exhausted plan window is first offered a healthy
   * alternate via the same rotation order as schedule WS1.3
   * ({@link resolvePinnedAgentFallback}, excluding claude-code). Only when no
   * preflight-registered alternate exists does the gate reject with
   * {@link QuotaHeadroomAdmissionError}. Must return a *live* sample (adapter
   * `getLiveHeadroom()`), never a stale periodic-poll snapshot; return `null`
   * when the live poll fails so the gate fails open (unless
   * {@link planQuotaBindingCache} is still bound from a prior deny). Other
   * agent types are not gated (QuotaAdapter is Anthropic-only). Absent
   * (older wiring/tests) ⇒ no quota gate.
   */
  getLiveQuotaHeadroom?: () => Promise<QuotaHeadroomSample | null>;
  /**
   * Binding-window cache for plan-quota exhaustion (issue #1936). When a live
   * sample denies claude-code, the cache records the reset (or a short
   * fallback TTL) so subsequent launches short-circuit without re-polling.
   * Absent ⇒ no cache (every launch re-polls when the getter is wired).
   */
  planQuotaBindingCache?: PlanQuotaBindingCache;
  /**
   * Live utilization threshold (0–100) for the plan-quota admission gate
   * (issue #2185). Non-positive disables the gate entirely — including the
   * {@link planQuotaBindingCache} short-circuit — so claude-code launches are
   * always admitted. Absent ⇒ {@link QUOTA_NO_HEADROOM_UTILIZATION}.
   */
  getQuotaHeadroomThreshold?: () => number;
  /**
   * Hot-path issue claim (RFC PR 1b). When provided AND the launch opts carry
   * `claimIssue`, {@link launchTask} interleaves a synchronous CAS with
   * `createTask`. Absent (flag off / older wiring) ⇒ claimIssue is a no-op
   * unless {@link relaunchArbiter} is wired (issue #1711 hard lease gate).
   */
  issueClaimRegistry?: {
    ownerRecord(key: { repo: string; number: number }): { taskId: string; ownerName?: string; ownerStatus: string; worktreePath?: string; claimedAt: string; sessionId?: string } | null;
    claim(
      key: { repo: string; number: number },
      claimant: { taskId: string; sessionId?: string },
      opts?: { force?: boolean },
    ): { ok: true; reentrant: boolean } | { ok: false; owner: { taskId: string; ownerName?: string; ownerStatus: string; worktreePath?: string; claimedAt: string; sessionId?: string; repo: string; number: number } };
    safeReleaseAllFor(taskId: string, reason?: 'released' | 'dead_reclaim' | 'orphan_reclaim'): unknown[];
  };
  /**
   * Lease-gated relaunch arbiter (issue #1711 / #1699 WS0.5). When provided
   * AND the launch opts carry `claimIssue`, {@link launchTask} requires a
   * held relaunch lease before the task may proceed — mutual exclusion across
   * actuators plus a post-release backoff window. Absent ⇒ claimIssue path
   * behaves as before (registry-only, or R7 no-op when neither is wired).
   */
  relaunchArbiter?: Pick<
    RelaunchArbiter,
    'evaluate' | 'tryAcquire' | 'release' | 'isHeld' | 'getLease'
  >;
  /**
   * Async claim-key repo resolution (phase a of R4). Called when
   * `opts.claimIssue` is set and at least one of the issue-claim registry or
   * the relaunch arbiter is wired. Must complete before the synchronous
   * critical section.
   */
  resolveClaimRepo?: (input: {
    cwd: string;
    repoFlag?: string;
  }) => Promise<{ ok: true; repo: string } | { ok: false; code: string; message: string }>;
  /**
   * Force-flush task state after a successful grant (R5). Optional for tests.
   */
  flushTasks?: () => Promise<void>;
  /**
   * Per-agent-type launch success/failure counters (issue #1808). When wired,
   * every non-queued adapter launch records one outcome so
   * `GET /api/diagnostics/launch-outcomes` can show failure rates without log
   * spelunking. Optional — older wiring/tests omit it with no behaviour change.
   */
  launchOutcomeMetrics?: LaunchOutcomeMetrics;
}

/**
 * Default pending-queue depth limit. Mirrors the `maxPendingTasks` settings
 * default (24); the settings range is 4–200.
 */
export const DEFAULT_MAX_PENDING_TASKS = 24;

/**
 * Default hard ceiling on one `adapter.launch()` await (issue #1528). Mirrors
 * the `launchTimeoutSeconds` settings default (180s); the settings range is
 * 30–900s.
 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 180_000;

/**
 * Default `Retry-After` (seconds) advertised when a launch is refused because
 * the node is draining / redeploying (issue #1976). Short enough that a client
 * that respects the header retries inside the target API-blackout window
 * (ideally under 1s, max under 5s for a fast prod restart), and always ≥1 so
 * the HTTP header is well-formed.
 */
export const DEFAULT_DRAIN_RETRY_AFTER_SECONDS = 2;

/** Structured reason on a drain-gated launch 503 (issue #1976). */
export type DrainReason = 'draining' | 'redeploying';

/**
 * Thrown by {@link launchTask} when the server is in operator drain mode and is
 * refusing new task launches. Callers map this to HTTP 503 with a `Retry-After`
 * header and a structured `{ reason, retryAfterSeconds }` body (issues #659 /
 * #1976) so orchestrators treat the refusal as "wait and retry" rather than an
 * outage.
 */
export class DrainModeError extends Error {
  readonly code = 'draining';
  /** Machine-readable cause: operator drain or a redeploy blackout. */
  readonly reason: DrainReason;
  /** Seconds also sent as the `Retry-After` response header (always ≥ 1). */
  readonly retryAfterSeconds: number;
  constructor(options: { reason?: DrainReason; retryAfterSeconds?: number } = {}) {
    const reason = options.reason ?? 'draining';
    super(
      reason === 'redeploying'
        ? 'Server is redeploying; not accepting new task launches'
        : 'Server is draining; not accepting new task launches',
    );
    this.name = 'DrainModeError';
    this.reason = reason;
    this.retryAfterSeconds = Math.max(
      1,
      Math.floor(options.retryAfterSeconds ?? DEFAULT_DRAIN_RETRY_AFTER_SECONDS),
    );
  }
}

/**
 * Thrown by {@link launchTask} when the automation kill-switch is engaged and
 * the launch is autonomous (issue #1710). Manual launches are unaffected.
 */
export class AutomationKillSwitchError extends Error {
  readonly code = 'safe_mode';
  constructor() {
    super('SAFE MODE — automation kill-switch engaged; autonomous launches halted');
    this.name = 'AutomationKillSwitchError';
  }
}

/**
 * Thrown by {@link launchTask} when `--claim-issue` / `claimIssue` targets an
 * issue already owned by another live task (RFC R4/R15). No task record is
 * created. The API maps this to HTTP 409 with `code: 'issue_claim_held'`.
 */
export class IssueClaimHeldError extends Error {
  readonly code = 'issue_claim_held';
  readonly owner: {
    taskId: string;
    ownerName?: string;
    ownerStatus: string;
    worktreePath?: string;
    claimedAt: string;
    sessionId?: string;
    repo: string;
    number: number;
  };
  constructor(owner: IssueClaimHeldError['owner']) {
    const name = owner.ownerName ? ` (${owner.ownerName})` : '';
    super(
      `Issue ${owner.repo}#${owner.number} is already claimed by task ${owner.taskId}${name}`,
    );
    this.name = 'IssueClaimHeldError';
    this.owner = owner;
  }
}

export function isIssueClaimHeldError(err: unknown): err is IssueClaimHeldError {
  return err instanceof IssueClaimHeldError;
}

/**
 * Thrown when claim-key repo resolution fails for a `--claim-issue` launch
 * (ambiguous bare name, mismatch, unresolvable). API → 400.
 */
export class IssueClaimRepoError extends Error {
  readonly code = 'issue_claim_repo';
  readonly resolveCode: string;
  constructor(message: string, resolveCode: string) {
    super(message);
    this.name = 'IssueClaimRepoError';
    this.resolveCode = resolveCode;
  }
}

export function isIssueClaimRepoError(err: unknown): err is IssueClaimRepoError {
  return err instanceof IssueClaimRepoError;
}

/**
 * Thrown by {@link launchTask} when the relaunch arbiter denies a `claimIssue`
 * launch (another actuator holds the lease, or the post-release backoff
 * window is still open). No task record is created. Maps to HTTP 409 with
 * `code: 'relaunch_denied'` (issue #1711).
 */
export class RelaunchDeniedError extends Error {
  readonly code = 'relaunch_denied';
  readonly reason: 'held' | 'backoff';
  readonly key: { repo: string; number: number };
  readonly retryAfterMs?: number;
  readonly holderId?: string;
  readonly lease?: RelaunchLease;
  constructor(
    reason: 'held' | 'backoff',
    key: { repo: string; number: number },
    detail: { retryAfterMs?: number; lease?: RelaunchLease } = {},
  ) {
    const where = `${key.repo}#${key.number}`;
    const msg =
      reason === 'backoff'
        ? `Relaunch of ${where} denied: backoff window open` +
          (detail.retryAfterMs !== undefined ? ` (retry after ${detail.retryAfterMs}ms)` : '')
        : `Relaunch of ${where} denied: lease held` +
          (detail.lease ? ` by ${detail.lease.holderId}` : '');
    super(msg);
    this.name = 'RelaunchDeniedError';
    this.reason = reason;
    this.key = key;
    if (detail.retryAfterMs !== undefined) this.retryAfterMs = detail.retryAfterMs;
    if (detail.lease) {
      this.lease = detail.lease;
      this.holderId = detail.lease.holderId;
    }
  }
}

export function isRelaunchDeniedError(err: unknown): err is RelaunchDeniedError {
  return err instanceof RelaunchDeniedError;
}

/**
 * Thrown by {@link launchTask} when `claimIssue` was requested but no
 * issue-claim / relaunch lease is held after the admission CAS — the hard
 * admission gate (issue #1711). No live agent is spawned. Maps to HTTP 409
 * with `code: 'issue_claim_lease_required'`.
 */
export class IssueClaimLeaseRequiredError extends Error {
  readonly code = 'issue_claim_lease_required';
  readonly key: { repo: string; number: number };
  constructor(key: { repo: string; number: number }, detail?: string) {
    super(
      detail ??
        `Launch of ${key.repo}#${key.number} rejected: no issue-claim lease is held`,
    );
    this.name = 'IssueClaimLeaseRequiredError';
    this.key = key;
  }
}

export function isIssueClaimLeaseRequiredError(
  err: unknown,
): err is IssueClaimLeaseRequiredError {
  return err instanceof IssueClaimLeaseRequiredError;
}

/**
 * Thrown by {@link launchTask} when a per-task `effort` override is not valid
 * for the resolved agent type (#681). Validation happens here — not at the
 * route — because a `round-robin` selection only resolves to a concrete agent
 * inside this service, and `minimal`/`none`/`ultra` (codex-only) are
 * agent-specific. The API maps this to HTTP 400.
 */
export class EffortValidationError extends Error {
  readonly code = 'invalid_effort';
  constructor(message: string) {
    super(message);
    this.name = 'EffortValidationError';
  }
}

/** Type guard for {@link EffortValidationError}, for callers mapping to 400. */
export function isEffortValidationError(err: unknown): err is EffortValidationError {
  return err instanceof EffortValidationError;
}

/**
 * Thrown by {@link launchTask} when a per-task `model` pin is not on the
 * resolved agent's known-model allowlist (#1518). Same placement as effort
 * validation (after round-robin resolves). The API maps this to HTTP 400.
 */
export class ModelValidationError extends Error {
  readonly code = 'invalid_model';
  constructor(message: string) {
    super(message);
    this.name = 'ModelValidationError';
  }
}

/** Type guard for {@link ModelValidationError}, for callers mapping to 400. */
export function isModelValidationError(err: unknown): err is ModelValidationError {
  return err instanceof ModelValidationError;
}

/**
 * Thrown by {@link launchTask} when the requested working directory does not
 * exist (or is not a directory) on this machine. Validated up front — before
 * any task record or terminal session is created — because launching into a
 * missing cwd otherwise fails seconds later with a cryptic backend error
 * ("dtach socket did not appear...") that buries the real cause (RFC F12).
 * The REST API maps this to HTTP 400; the WS path surfaces it as an alert
 * whose summary leads with the missing-directory cause.
 */
export class CwdValidationError extends Error {
  readonly code = 'invalid_cwd';
  constructor(message: string) {
    super(message);
    this.name = 'CwdValidationError';
  }
}

/** Type guard for {@link CwdValidationError}, for callers mapping to 400. */
export function isCwdValidationError(err: unknown): err is CwdValidationError {
  return err instanceof CwdValidationError;
}

/**
 * Thrown by {@link launchTask} when `adapter.launch()` does not settle within
 * the configured `launchTimeoutSeconds` (issue #1526 Phase C / #1528). By the
 * time this propagates, the launch has already been cleaned up exactly like a
 * thrown launch: reservation released (`endLaunch`) and the task DISPOSED —
 * marked terminal with a `launch_timeout` {@link Task.disposition} rather than
 * deleted (issue #1588), so the record stays queryable, a terminal task can't
 * block dedup, no capacity slot stays held, and a retry with the same
 * idempotency key replays this task instead of creating a sibling. A
 * schedule-fired launch that hits this records `dispatch_failed`
 * (reasonCode `launch_error`) through the runner's normal error path.
 */
export class LaunchTimeoutError extends Error {
  readonly code = 'launch_timeout';
  constructor(agentType: string, taskId: string, timeoutMs: number) {
    super(
      `Agent launch timed out after ${Math.round(timeoutMs / 1000)}s ` +
      `(agent ${agentType}, task ${taskId}) — launch abandoned and task cleaned up`,
    );
    this.name = 'LaunchTimeoutError';
  }
}

/** Type guard for {@link LaunchTimeoutError}. */
export function isLaunchTimeoutError(err: unknown): err is LaunchTimeoutError {
  return err instanceof LaunchTimeoutError;
}

/**
 * Thrown by {@link launchTask} when a launch would pend at capacity but the
 * pending queue is already at its depth limit (issue #1526 Phase C / C3,
 * FM3). Carries the capacity-ledger snapshot so every surface can render WHY:
 * REST maps this to HTTP 429 with the ledger in the body, the WS path renders
 * the breakdown into its alert, and a schedule fire records `dispatch_failed`
 * with reasonCode `pending_queue_full` — never a silent drop. Thrown BEFORE
 * any task record exists, so there is nothing to clean up.
 */
export class PendingQueueFullError extends Error {
  readonly code = 'pending_queue_full';
  constructor(
    /** Capacity-ledger snapshot at rejection time (same shape as `GET /api/health` `capacity`). */
    readonly capacity: CapacityLedger,
    /** The `maxPendingTasks` limit that was hit. */
    readonly maxPendingTasks: number,
  ) {
    super(
      `Pending queue is full (${capacity.pendingQueueDepth}/${maxPendingTasks} queued, ` +
      `${capacity.active}/${capacity.maxActiveTasks} active) — launch rejected. ` +
      'Retry after capacity frees, or raise maxPendingTasks.',
    );
    this.name = 'PendingQueueFullError';
  }
}

/** Type guard for {@link PendingQueueFullError}, for callers mapping to 429. */
export function isPendingQueueFullError(err: unknown): err is PendingQueueFullError {
  return err instanceof PendingQueueFullError;
}

/**
 * Thrown by {@link launchTask} when the caller's per-source spawn budget is
 * exhausted (issue #1526 Phase C / C3, `spawnBurstLimit` per
 * `spawnBurstWindowMinutes`). Same 429-with-ledger shape as
 * {@link PendingQueueFullError}, distinct code so a runaway caller can tell
 * "you specifically are bursting" apart from "the shared queue is full".
 * Thrown before any task record exists. Schedule fires never hit this — they
 * are exempt from the budget.
 */
export class SpawnBurstLimitError extends Error {
  readonly code = 'spawn_burst_limit';
  /** Budget bucket that was exhausted (launch source, actor-qualified when attributed). */
  readonly source: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly retryAfterMs: number;
  constructor(
    verdict: SpawnRateVerdict,
    /** Capacity-ledger snapshot at rejection time. */
    readonly capacity: CapacityLedger,
  ) {
    super(
      `Spawn burst limit reached for source "${verdict.source}": ` +
      `${verdict.count}/${verdict.limit} launches in the last ${Math.round(verdict.windowMs / 60_000)}m — ` +
      `launch rejected. Retry in ~${Math.ceil(verdict.retryAfterMs / 1000)}s.`,
    );
    this.name = 'SpawnBurstLimitError';
    this.source = verdict.source;
    this.limit = verdict.limit;
    this.windowMs = verdict.windowMs;
    this.retryAfterMs = verdict.retryAfterMs;
  }
}

/** Type guard for {@link SpawnBurstLimitError}, for callers mapping to 429. */
export function isSpawnBurstLimitError(err: unknown): err is SpawnBurstLimitError {
  return err instanceof SpawnBurstLimitError;
}

/**
 * Thrown by {@link launchTask} when CPU-aware admission (issue #1630) rejects a
 * launch because the host 1-minute load average per core exceeds the
 * configured `KOOKR_MAX_HOST_LOAD_PER_CPU` threshold. Same 429-with-ledger
 * shape as the other backpressure rejections, distinct code so a caller can
 * tell "the host is CPU-saturated" apart from "the queue is full". Thrown
 * before any task record exists. Unlike the other guards it can fire even
 * below `maxActiveTasks`: a handful of compile-heavy tasks saturate the host
 * regardless of task count.
 */
export class HostLoadAdmissionError extends Error {
  readonly code = 'host_load_admission';
  constructor(
    /** Capacity-ledger snapshot at rejection time. */
    readonly capacity: CapacityLedger,
    /** Sampled 1-minute load average per logical CPU. */
    readonly loadPerCpu: number,
    /** The configured load-per-core threshold that was exceeded. */
    readonly maxLoadPerCpu: number,
  ) {
    super(
      `Host CPU load is ${loadPerCpu.toFixed(2)} per core ` +
      `(threshold ${maxLoadPerCpu.toFixed(2)}) — launch rejected to protect the ` +
      'supervisor event loop from CPU starvation. Retry once host load drops, ' +
      'or raise/disable KOOKR_MAX_HOST_LOAD_PER_CPU.',
    );
    this.name = 'HostLoadAdmissionError';
  }
}

/** Type guard for {@link HostLoadAdmissionError}, for callers mapping to 429. */
export function isHostLoadAdmissionError(err: unknown): err is HostLoadAdmissionError {
  return err instanceof HostLoadAdmissionError;
}

/**
 * Thrown by {@link launchTask} when live quota-headroom admission (issue #1894 /
 * #1936) rejects a claude-code launch because a plan window is exhausted AND
 * no healthy alternate agent is registered to rotate onto. Same 429-with-ledger
 * shape as the other backpressure rejections, distinct code so a caller can
 * tell "Anthropic quota is empty" apart from "host is CPU-saturated". Thrown
 * before any task record exists. Carries `admission: 'rejected'` +
 * `reason: 'plan_quota'` so supervisors/feeder can short-circuit blind retries.
 */
export class QuotaHeadroomAdmissionError extends Error {
  readonly code = 'quota_headroom_admission';
  /** Structured admission decision (issue #1936). Always `rejected` on throw. */
  readonly admission = 'rejected' as const;
  /** Machine-readable reject reason (issue #1936). */
  readonly reason = 'plan_quota' as const;
  constructor(
    /** Capacity-ledger snapshot at rejection time. */
    readonly capacity: CapacityLedger,
    /** Highest window utilization (0–100) that triggered the deny. */
    readonly maxUtilization: number,
    /** Exhaustion threshold that was met or exceeded. */
    readonly threshold: number,
    /** Binding window reset time when known (ISO 8601), else null. */
    readonly resetsAt: string | null,
  ) {
    const resetHint = resetsAt
      ? ` Retry after the binding window resets (${resetsAt}).`
      : ' Retry once plan quota resets.';
    super(
      `Anthropic plan quota is exhausted (utilization ${maxUtilization.toFixed(0)}% ` +
      `≥ threshold ${threshold.toFixed(0)}%) — launch rejected so the session is ` +
      `not started into a known-empty window (no healthy alternate agent).${resetHint}`,
    );
    this.name = 'QuotaHeadroomAdmissionError';
  }
}

/** Type guard for {@link QuotaHeadroomAdmissionError}, for callers mapping to 429. */
export function isQuotaHeadroomAdmissionError(err: unknown): err is QuotaHeadroomAdmissionError {
  return err instanceof QuotaHeadroomAdmissionError;
}

/**
 * Capacity-ledger snapshot for backpressure error bodies. Prefers the wired
 * health-grade builder; falls back to a task-store-only snapshot (no watchdog
 * ⇒ `hungSuspect` reads 0) so the error body always carries a breakdown.
 */
function snapshotCapacityLedger(deps: LaunchServiceDeps, maxActive: number): CapacityLedger {
  if (deps.getCapacityLedger) return deps.getCapacityLedger();
  const reservedActiveSlots = deps.getReservedActiveSlots?.();
  return buildCapacityLedger(deps.taskStore.listTasks(), {
    now: Date.now(),
    maxActiveTasks: maxActive,
    isHungSuspect: () => false,
    isLaunching: (task) => deps.taskStore.hasFreshLaunchReservation(task.id),
    // Issue #1564: reflect the reservation in the degraded snapshot too, so a
    // backpressure error body carries the same guarantee /api/health shows.
    ...(reservedActiveSlots !== undefined
      ? { reservedActiveSlots, reservedSlotSources: deps.getReservedSlotSources?.() ?? [] }
      : {}),
  });
}

/**
 * Effective active-task cap for THIS launch (issue #1564). Privileged
 * (reserved-slot) launches see the full `maxActive`; every other launch is
 * capped at `maxActive - reservedActiveSlots` so it cannot consume a slot the
 * reservation is holding for kookr self-maintenance. Absent reservation
 * (`getReservedActiveSlots` unset or 0) ⇒ `maxActive` for everyone, unchanged.
 */
function effectiveMaxActiveForLaunch(
  deps: LaunchServiceDeps,
  maxActive: number,
  launchSource: string,
  launchActorId: string | undefined,
): number {
  const reserved = deps.getReservedActiveSlots?.() ?? 0;
  if (reserved <= 0) return maxActive;
  const reservedSources = deps.getReservedSlotSources?.() ?? [];
  if (isReservedSlotLaunch(launchSource, launchActorId, reservedSources)) return maxActive;
  return Math.max(0, maxActive - reserved);
}

/**
 * Race one adapter launch against the hard timeout (issue #1528).
 *
 * On timeout, the caller cleans up (endLaunch, then DISPOSES the task terminal
 * with a `launch_timeout` disposition rather than deleting it — issue #1588)
 * and moves on; the underlying promise is NOT cancelled — adapters expose no
 * abort hook for an in-flight launch — so this helper pins down what a LATE
 * settlement can do:
 *
 * - Late REJECTION is swallowed (logged). The common case: the task is now
 *   terminal, so the adapter's own `taskStore.addSession` throws ("Cannot
 *   attach session to terminal task") and the launch rejects on its own — the
 *   same self-clean the old `deleteTask` produced via "Task not found", now via
 *   the terminal guard (issue #1588) so the disposed record stays session-free.
 *   NOTE the honest caveat: if the adapter created a terminal session before
 *   that throw, the session process leaks until reconcile reports it — boot and
 *   periodic `reconcile()` list sessions with no owning task as `orphans`
 *   (logged, not killed). In the #1528 incident the hang was *before* session
 *   creation (buildAgentLaunchContext), so the typical timeout leaks nothing.
 * - Late RESOLUTION (a session id came back after we gave up) is neutralized
 *   with the one cleanup hook adapters do expose: `adapter.stop(sessionId)`
 *   kills the orphaned terminal session, best-effort. State cannot be
 *   corrupted either way — the success path (posture stamping, round-robin
 *   advance, registerNewAgent) only runs when the race resolves in time, and a
 *   late `addSession` onto the terminated disposed task is refused outright, so
 *   the record never gains a phantom session.
 */
async function raceLaunchAgainstTimeout(
  launchPromise: Promise<string>,
  timeoutMs: number,
  ctx: {
    taskId: string;
    agentType: AgentType;
    adapter: Pick<import('../adapters/agent-adapter.js').AgentAdapter, 'stop'>;
    /**
     * Shared reap guard (issue #2500). When the caller already links + reaps the
     * abandoned session via `onSessionCreated` (the common case), a late
     * RESOLUTION of the same promise must NOT `stop()` the same id a second time
     * and log a misleading "orphaned session" warning. If provided and already
     * `reaped`, the late-settle stop is skipped; otherwise this handler claims it.
     */
    reapGuard?: { reaped: boolean };
  },
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      launchPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new LaunchTimeoutError(ctx.agentType, ctx.taskId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      // Settle-once: whatever the abandoned launch does later is observed,
      // logged, and defused — never allowed back into launch state.
      launchPromise.then(
        (sessionId) => {
          // Issue #2500: the abandon path may already have linked + reaped this
          // exact session via `onSessionCreated`. Skip a redundant second stop()
          // (and its misleading "orphaned session" warning) when it did.
          if (ctx.reapGuard) {
            if (ctx.reapGuard.reaped) return;
            ctx.reapGuard.reaped = true;
          }
          console.warn(
            `[launch] adapter ${ctx.agentType} settled LATE after timeout for task ${ctx.taskId} ` +
            `(session ${sessionId}) — stopping orphaned session`,
          );
          void Promise.resolve(ctx.adapter.stop(sessionId)).catch((stopErr) => {
            console.warn(
              `[launch] failed to stop late-settled session ${sessionId}: ` +
              `${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
            );
          });
        },
        (err) => {
          console.warn(
            `[launch] abandoned launch for task ${ctx.taskId} rejected after timeout (ignored): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
  }
}

/** Resolve the effective launch timeout from the live getter, defensively. */
function resolveLaunchTimeoutMs(deps: LaunchServiceDeps): number {
  const value = deps.getLaunchTimeoutMs?.();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_LAUNCH_TIMEOUT_MS;
}

/** Fail fast when the launch cwd is missing or not a directory (RFC F12). */
async function assertLaunchCwdExists(cwd: string): Promise<void> {
  let stats;
  try {
    stats = await stat(cwd);
  } catch {
    throw new CwdValidationError(`Working directory does not exist: ${cwd}`);
  }
  if (!stats.isDirectory()) {
    throw new CwdValidationError(`Working directory is not a directory: ${cwd}`);
  }
}

/** Active statuses — tasks in these states block duplicate submissions. */
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

function allowRemoteChatCodex(): boolean {
  return process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1';
}

/**
 * Check if an active task with the same prompt hash and canonical cwd already
 * exists. Uses the live-task view so a large completed-task pile is not cloned
 * on every spawn. Returns the existing task if found, undefined otherwise.
 *
 * Dedup key is (promptHash, agentType, canonicalCwd). Two launches with the
 * same prompt in different directories are different tasks; two launches with
 * the same prompt in the same directory — even reached via symlink, trailing
 * slash, relative path, or case-aliased path on case-insensitive FS — dedup
 * to the first.
 */
export function checkSubmission(
  taskStore: TaskStore,
  prompt: string,
  agentType: AgentType,
  cwd: string,
  pins: { model?: string; effort?: string } = {},
): Task | undefined {
  const hash = hashPrompt(prompt);
  const canonicalIncoming = canonicalizeCwd(cwd);
  // Live objects only — do not mutate. listTasks() would clone every historical
  // record on the spawn admission path (issue #2435).
  for (const task of taskStore.viewLiveTasks()) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    if (task.agentType !== agentType) continue;
    if (hashPrompt(task.prompt) !== hash) continue;
    if (canonicalizeCwd(task.cwd) !== canonicalIncoming) continue;
    // Legacy tasks without a persisted intent must not silently dedup a new
    // launch: the two records may have different provider pins. New tasks
    // created by TaskStore carry an explicit unpinned intent.
    if (!sameLaunchIntent(task.launchIntent, agentType, pins)) continue;
    // Verify live status — don't rely on cached state
    const liveTask = taskStore.getTask(task.id);
    if (liveTask && liveTask.agentType === agentType && ACTIVE_STATUSES.has(liveTask.status)) {
      return liveTask;
    }
  }
  return undefined;
}

function isSessionTerminal(session: Task['sessions'][number]): boolean {
  return session.lastStatus === 'completed' || session.lastStatus === 'aborted';
}

function isRalphLoopActive(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

async function hasLiveBackingSession(
  task: Task,
  terminalBackend: Pick<TerminalBackend, 'isAlive'>,
): Promise<boolean> {
  const sessions = task.sessions.filter((session) => !isSessionTerminal(session));
  if (sessions.length === 0) return false;

  for (const session of sessions) {
    try {
      if (await terminalBackend.isAlive(session.tmuxSession)) return true;
    } catch {
      // Treat backend probe failures like a missing session for dedup. The
      // stale record will be reconciled below instead of blocking a retry.
    }
  }
  return false;
}

function reconcileStaleDuplicate(taskStore: TaskStore, task: Task): void {
  const current = taskStore.getTask(task.id);
  if (!current || current.status !== 'inProgress') return;

  for (const session of current.sessions) {
    if (!isSessionTerminal(session)) {
      taskStore.updateSession(current.id, session.tmuxSession, { lastStatus: 'completed' });
    }
  }

  const updated = taskStore.getTask(current.id);
  if (
    updated?.status === 'inProgress'
    && (updated.sessions.length === 0 || updated.sessions.every(isSessionTerminal))
  ) {
    taskStore.terminateTask(updated.id, {
      reason: 'unknown',
      detail: 'stale duplicate reconciled at launch (dead sessions)',
    });
  }
}

async function validateDuplicateCandidate(
  deps: LaunchServiceDeps,
  candidate: Task,
): Promise<Task | undefined> {
  if (candidate.status !== 'inProgress') return candidate;
  if (isRalphLoopActive(candidate)) return candidate;
  if (!deps.terminalBackend) return candidate;
  if (await hasLiveBackingSession(candidate, deps.terminalBackend)) return candidate;

  reconcileStaleDuplicate(deps.taskStore, candidate);
  return undefined;
}

/**
 * Unified launch orchestration: create task, check concurrency, launch via
 * adapter, and run post-launch registration. Used by both the WS message
 * router and the REST API.
 *
 * Idempotency (issue #1526 Phase B) is a thin wrapper around the core launch
 * logic ({@link launchTaskCore}) rather than woven through it: when
 * `opts.idempotencyKey` and `deps.idempotencyLedger` are both present, this
 * function reserves the key, delegates to `launchTaskCore` for the entire
 * existing launch pipeline (validation, dedup, concurrency, adapter launch),
 * and finalizes or releases the reservation based on the outcome. Every
 * existing caller that never sets `idempotencyKey` is byte-for-byte
 * unaffected — the wrapper is skipped entirely.
 */
export async function launchTask(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
  serverOpts: LaunchTaskServerOptions = {},
): Promise<LaunchResult> {
  if (opts.idempotencyKey === undefined || !deps.idempotencyLedger) {
    return launchTaskCore(deps, opts, serverOpts);
  }
  return launchTaskIdempotent(deps, opts, serverOpts, deps.idempotencyLedger, opts.idempotencyKey);
}

/**
 * Whether a store-resident task should be handed back as a replay, or
 * treated as though its reservation never happened (issue #1526 Phase B
 * review item 2).
 *
 * A non-terminal task (open/pending/inProgress) is always replayable — it's
 * the same live task the caller is retrying for.
 *
 * A TERMINAL task is replayable when either:
 *  - it actually ran (`sessions.length > 0`): an agent was launched (it may
 *    have completed, or died and been terminated — either way real work
 *    happened, so replaying it is the point of this feature; re-launching
 *    would duplicate that work); or
 *  - it carries a pre-session `disposition` (issue #1588): a launch-timeout /
 *    launch-error / stale-open-launch path disposed of it before any session.
 *    Returning it as a replay is exactly the create-then-lose fix — the caller
 *    gets the original disposed task (with its reason visible) instead of the
 *    key being cleared and a duplicate task being created.
 *
 * A terminal, zero-session task with NO disposition never ran at all — e.g. it
 * was queued at the concurrency cap (`launchTaskCore`'s maxActive branch never
 * calls `adapter.launch`) and then reaped, cancelled, or TTL-expired before
 * promotion ever launched it. Replaying that dead reference would hand the
 * caller a task that will never do the work it's retrying for, so this case is
 * deliberately NOT a replay: the stale entry is cleared and the caller competes
 * for ownership again, actually launching the work.
 */
function isReplayableTask(task: Task): boolean {
  return !isTerminalStatus(task.status) || task.sessions.length > 0 || task.disposition !== undefined;
}

/**
 * Marker linking a thrown launch error back to the persisted, disposed task
 * `launchTaskCore` left behind (issue #1588). `launchTaskIdempotent` reads it
 * to finalize the idempotency key to that task — so a retry returns the
 * disposed task — instead of releasing the key and letting the retry create a
 * sibling. A Symbol key never shows up in JSON serialization of the error.
 */
const DISPOSED_TASK_ID = Symbol('kookr.disposedTaskId');

function markDisposedTask(err: unknown, taskId: string): void {
  if (err && typeof err === 'object') {
    (err as Record<symbol, unknown>)[DISPOSED_TASK_ID] = taskId;
  }
}

function disposedTaskId(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const value = (err as Record<symbol, unknown>)[DISPOSED_TASK_ID];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Marker carrying the per-phase launch timings (issue #1589) back to the
 * schedule runner on a thrown launch. A schedule fire that fails records
 * `dispatch_failed` WITHOUT ever calling `markExecutionAccepted`, so its ledger
 * row has no taskId to link the disposed task by — the runner reads this off
 * the error instead and stamps the timings onto the `dispatch_failed` row, so a
 * failed fire is diagnosable straight from the ledger. A Symbol key never shows
 * up in JSON serialization of the error.
 */
const LAUNCH_PHASE_TIMINGS = Symbol('kookr.launchPhaseTimings');

function attachLaunchPhaseTimings(err: unknown, timings: LaunchPhaseTimings): void {
  if (err && typeof err === 'object') {
    (err as Record<symbol, unknown>)[LAUNCH_PHASE_TIMINGS] = timings;
  }
}

/** Read the per-phase launch timings attached to a thrown launch error (issue #1589). */
export function launchPhaseTimingsOf(err: unknown): LaunchPhaseTimings | undefined {
  if (err && typeof err === 'object') {
    const value = (err as Record<symbol, unknown>)[LAUNCH_PHASE_TIMINGS];
    if (value && typeof value === 'object') return value as LaunchPhaseTimings;
  }
  return undefined;
}

/**
 * Reserve/replay wrapper (see {@link launchTask} docs). Loops rather than
 * recursing when a reservation resolves to "try again" (the owner's launch
 * failed, a replay pointed at a since-deleted task, or a replay pointed at a
 * terminal task that never actually ran — see {@link isReplayableTask}) —
 * every case means this call should now compete for ownership itself.
 */
async function launchTaskIdempotent(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
  serverOpts: LaunchTaskServerOptions,
  ledger: IdempotencyLedger,
  idempotencyKey: string,
): Promise<LaunchResult> {
  for (;;) {
    const reservation = ledger.reserveOrWait(idempotencyKey);

    if (reservation.kind === 'replay') {
      const task = deps.taskStore.getTask(reservation.taskId);
      if (task && isReplayableTask(task)) {
        return {
          task,
          queued: task.status === 'pending',
          idempotentReplay: true,
          ...(reservation.duplicate ? { duplicate: true } : {}),
        };
      }
      // Either the finalized task no longer exists (e.g. deleted), or it's
      // terminal-and-never-ran (issue #1526 Phase B review item 2) — the key
      // must not stay permanently bound to a dead/non-working reference.
      await ledger.clear(idempotencyKey);
      continue;
    }

    if (reservation.kind === 'wait') {
      const outcome = await reservation.wait();
      if (outcome.ok) {
        const task = deps.taskStore.getTask(outcome.taskId);
        if (task && isReplayableTask(task)) {
          return {
            task,
            queued: task.status === 'pending',
            idempotentReplay: true,
            ...(outcome.duplicate ? { duplicate: true } : {}),
          };
        }
        // Task missing, or terminal-and-never-ran. The owner already
        // finalized this key, so the next `reserveOrWait` call below returns
        // 'replay' (not 'own') and the branch above clears it — no need to
        // duplicate the clear() call here.
      }
      continue;
    }

    // reservation.kind === 'own'
    let result: LaunchResult;
    try {
      result = await launchTaskCore(deps, opts, serverOpts);
    } catch (err) {
      const disposedId = disposedTaskId(err);
      if (disposedId && deps.taskStore.getTask(disposedId)) {
        // launchTaskCore left a persisted, disposed task behind (issue #1588:
        // launch timeout / launch error). Finalize the key to it so a retry
        // returns THIS disposed task (idempotentReplay) with its reason
        // visible, never a silently-created sibling. finalize() never rejects.
        await reservation.finalize(disposedId);
      } else {
        // No lasting record (a validation/backpressure rejection before
        // createTask) — release so a retry is treated as fresh.
        await reservation.release();
      }
      throw err;
    }
    // A real task now exists — possibly with a live spawned agent. From here
    // on we must NEVER throw or release() (issue #1526 Phase B review item
    // 1): `finalize` is best-effort by design (see IdempotencyLedger docs)
    // and its returned promise never rejects, so a ledger persist failure
    // can only cost cross-restart durability, never turn this success into
    // an error for the caller or drop same-process replay protection.
    await reservation.finalize(result.task.id, result.duplicate === true);
    return result;
  }
}

async function launchTaskCore(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
  serverOpts: LaunchTaskServerOptions = {},
): Promise<LaunchResult> {
  const { taskStore, adapterRegistry, lifecycleDeps } = deps;
  // Per-phase launch instrumentation (issue #1589). Timing starts at the top of
  // the launch pipeline so the `preflight` phase captures the pre-reservation
  // work (cwd check, advisory dependency preflight, worktree guardrails, dedup,
  // backpressure, createTask) — the reported symptom is `POST /api/tasks` held
  // >90s, which includes exactly that window. The tracker is only persisted once
  // a launch actually reaches the adapter; a dedup hit or a queued-at-capacity
  // return is not a launch attempt and records nothing.
  const phaseTracker = new LaunchPhaseTracker();
  phaseTracker.enter('preflight');
  // Operator drain gate (issue #659): refuse new launches while draining, before
  // any task record or side effect is created. In-flight agents are untouched.
  if (deps.isAccepting && !deps.isAccepting()) {
    throw new DrainModeError();
  }
  // Automation kill-switch (issue #1710): refuse autonomous launches only.
  // Manual sources (api/ui/cli/websocket/remote) stay accepted so an operator
  // can still intervene while SAFE MODE is engaged. The cross-repo orchestrator
  // fire carries `serverOpts.safeModeExempt` (issue #2672) so its own agent
  // launch is allowed through — it must keep ticking to auto-resume the fleet.
  if (
    deps.isAutomationEnabled
    && !deps.isAutomationEnabled()
    && isAutonomousLaunchSource(opts.launchSource)
    && !serverOpts.safeModeExempt
  ) {
    throw new AutomationKillSwitchError();
  }
  // Fail fast on a missing working directory (RFC F12) — before dedup, task
  // creation, or any spawn attempt, so the caller gets the actual cause
  // instead of a delayed "dtach socket did not appear" session failure and no
  // cleanup is needed.
  await (deps.validateLaunchCwd ?? assertLaunchCwdExists)(opts.cwd);
  const maxActive = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
  // Resolve the agent for this launch. An explicit per-launch request wins
  // over the configured default; either may be the `round-robin` sentinel,
  // which is resolved to a concrete agent *here* — before dedup and task
  // creation — so the task record always stores a concrete agent type.
  // issue #2194: refresh Grok session-auth cache before selection so RR and
  // plan-quota rotation do not keep landing on an auth-expired grok-build.
  if (deps.refreshGrokAuthAvailability) {
    try {
      await deps.refreshGrokAuthAvailability();
    } catch (err) {
      console.warn(
        '[launch] Grok auth availability refresh failed (continuing with last known verdict):',
        err instanceof Error ? err.message : err,
      );
    }
  }
  const requestedAgent: AgentSelection =
    opts.agentType ??
    deps.getDefaultAgentType?.() ??
    adapterRegistry.getDefaultType() ??
    DEFAULT_AGENT_TYPE;
  const isRoundRobin = requestedAgent === ROUND_ROBIN_AGENT_TYPE;
  // Registered ∩ Grok-auth-launchable (issue #2194): an expired session must
  // not consume a round-robin slot when a healthy non-Grok backend remains.
  const launchableTypes = filterLaunchableAgentTypes(adapterRegistry.getTypes(), {
    grokAuthUsable: deps.isGrokAuthUsable?.() ?? true,
  });
  // `peek` (not advance): the rotation cursor must only move once a task is
  // actually committed, so a deduplicated or rejected launch does not consume
  // a rotation slot. The matching `advance()` calls fire after `createTask`.
  let agentType: AgentType = isRoundRobin
    ? resolveRoundRobinAgent(
        deps.roundRobinCursor?.peek() ?? 0,
        launchableTypes,
        // Boot-reliability failover precondition (#1898): skip agents whose
        // recent boot latency is unhealthy while a healthier one is registered.
        deps.getDeprioritizedAgentTypes?.(launchableTypes) ?? [],
      )
    : requestedAgent;
  // Per-task effort/model pins may be dropped if plan-quota rotation (#1936)
  // substitutes a different agent — same as schedule WS1.3 substitution.
  let effectiveEffort: string | undefined = opts.effort;
  let effectiveModel: string | undefined = opts.model;
  // Populated when plan-quota admission rotates claude-code onto an alternate.
  let planQuotaRotation: {
    fromAgent: AgentType;
    toAgent: AgentType;
    maxUtilization: number;
    threshold: number;
    resetsAt: string | null;
  } | undefined;
  // Full substitution chain (issue #2001): prior schedule hops + optional
  // quota_rotate hop. Stamped on task metadata and returned to the caller.
  const agentSubstitutionChain: AgentSubstitutionHop[] = [
    ...(opts.priorAgentSubstitutions ?? []),
  ];

  // Validate a per-task effort override against the *resolved* agent's allowed
  // set (#681), before any side effect or task record. Done here — not at the
  // route — because round-robin only resolves to a concrete agent now, and the
  // allowed set is agent-specific (`minimal`/`none`/`ultra` are codex-only). The
  // per-agent-type *default* is applied inside the adapter and
  // validated when settings are saved, so it is not re-checked here.
  if (effectiveEffort !== undefined && !isValidEffortForAgent(agentType, effectiveEffort)) {
    throw new EffortValidationError(
      `Invalid effort "${effectiveEffort}" for agent ${agentType}; ` +
      `valid levels: ${effortLevelsForAgent(agentType).join(', ')}`,
    );
  }

  // Validate a per-task model pin against the *resolved* agent's allowlist
  // (#1518). Same placement as effort — after round-robin, before side effects.
  // No silent fallback: unknown models throw rather than launch with the CLI
  // default. codex-cli / grok-build currently have empty allowlists.
  if (effectiveModel !== undefined && !isValidModelForAgent(agentType, effectiveModel)) {
    const valid = modelsForAgent(agentType);
    throw new ModelValidationError(
      valid.length === 0
        ? `Invalid model "${effectiveModel}" for agent ${agentType}; this agent does not accept a per-task model pin`
        : `Invalid model "${effectiveModel}" for agent ${agentType}; ` +
          `valid models: ${valid.join(', ')} (dated suffixes of those bases also accepted)`,
    );
  }

  // R19 trust-boundary check (rfc-remote-chat-trigger §4): Telegram-spawned
  // Codex is opt-in because its permission model is more permissive than
  // Claude Code's supervised path. The integration checks this before
  // confirmation; this server-side check is the defense-in-depth boundary.
  if (
    opts.launchSource === 'remote-chat-telegram' &&
    agentType !== 'claude-code' &&
    !(agentType === 'codex-cli' && allowRemoteChatCodex())
  ) {
    throw new Error(
      `R19: remote-chat-telegram tasks cannot use ${agentType} unless KOOKR_REMOTE_CHAT_ALLOW_CODEX=1`,
    );
  }

  const dependencyFindings = sanitizeLaunchPreflightFindings(await collectAdvisoryDependencyFindings(
    deps.dependencyPreflightRunner ?? runLaunchDependencyPreflights,
    opts.dependencies,
  ));
  const launchHealthSummary = summarizeLaunchHealth(dependencyFindings);
  const launchNote = formatLaunchNote(dependencyFindings);

  const userPrompt = normalizePromptFileReferences(opts.prompt, opts.cwd);
  const deliveryAuthorization: DeliveryAuthorization = serverOpts.deliveryPolicy ?? 'pre-authorized';
  const guardedPrompt = await applyWorktreeGuardrails(opts.prompt, opts.cwd, deliveryAuthorization);
  const effectivePrompt = normalizePromptFileReferences(guardedPrompt, opts.cwd);
  const bypassAllPermissions = deps.bypassAllPermissions === true;

  // Dedup: if an active task with the same prompt and canonical cwd exists,
  // return it idempotently
  if (!opts.disableDedup) {
    let staleDuplicate: Task | undefined;
    let existing: Task | undefined;
    while ((existing = checkSubmission(taskStore, effectivePrompt, agentType, opts.cwd, {
      model: effectiveModel,
      effort: effectiveEffort,
    }))) {
      const activeDuplicate = await validateDuplicateCandidate(deps, existing);
      if (activeDuplicate) {
        const canonicalCwd = canonicalizeCwd(opts.cwd);
        console.log(`[dedup] Rejected duplicate prompt (existing task ${activeDuplicate.id}, status=${activeDuplicate.status}, cwd=${canonicalCwd})`);
        await deps.interactionLog?.append({
          type: 'submission_rejected_dedup',
          existingTaskId: activeDuplicate.id,
          promptHash: hashPrompt(effectivePrompt),
          canonicalCwd,
          timestamp: nowISO(),
        });
        return { task: activeDuplicate, queued: false, duplicate: true };
      }
      staleDuplicate = existing;
    }
    if (staleDuplicate) {
      console.log(`[dedup] Ignored stale duplicate prompt (existing task ${staleDuplicate.id}, status=${staleDuplicate.status}, cwd=${canonicalizeCwd(opts.cwd)})`);
    }
  }

  // --- Issue-claim key resolution (RFC PR 1b, R4 phase a; #1711 arbiter) ---
  // Async, so it runs BEFORE the no-await critical section below. Flag-off or
  // missing claimIssue → strict early no-op (R7): no resolve, no throw — unless
  // the relaunch arbiter is wired, in which case claimIssue is a hard lease
  // path (issue #1711).
  let resolvedClaimKey: { repo: string; number: number } | undefined;
  const claimPathActive = Boolean(
    opts.claimIssue &&
      deps.resolveClaimRepo &&
      (deps.issueClaimRegistry || deps.relaunchArbiter),
  );
  if (claimPathActive && opts.claimIssue && deps.resolveClaimRepo) {
    const number = opts.claimIssue.number;
    if (!Number.isInteger(number) || number <= 0) {
      throw new IssueClaimRepoError(
        `claimIssue.number must be a positive integer (got: ${String(number)})`,
        'invalid_number',
      );
    }
    const resolution = await deps.resolveClaimRepo({
      cwd: opts.cwd,
      ...(opts.claimIssue.repo !== undefined ? { repoFlag: opts.claimIssue.repo } : {}),
    });
    if (!resolution.ok) {
      throw new IssueClaimRepoError(resolution.message, resolution.code);
    }
    resolvedClaimKey = { repo: resolution.repo, number };
  }

  // --- Server-side backpressure (issue #1526 Phase C / C3, #1630, #1894, #1936) ---
  // These guards run AFTER dedup (an idempotent replay of an existing task
  // must never be rejected — it creates nothing) and BEFORE createTask (a
  // rejected launch must leave no task record). The live quota poll below is
  // the only await in this block; the subsequent capacity/host-load checks
  // stay synchronous with createTask so the counts they read cannot go stale
  // relative to each other.
  //
  // 0) Live quota-headroom admission (issue #1894 / #1699 WS1.2 + #1936).
  //    Claude Code only — QuotaAdapter polls the Anthropic plan window.
  //    Checked before host-load / burst tokens so an exhausted-quota path
  //    never consumes spawn budget. Unlike host-load, schedule fires are NOT
  //    exempt: the whole point of this gate is to stop autonomous dispatch
  //    into a known empty window. Fail-open when the live poll returns null
  //    and no binding-window cache is active.
  //
  //    On deny (#1936): rotate to a healthy alternate using the same order as
  //    schedule WS1.3 (`resolvePinnedAgentFallback`, treating claude-code as
  //    unavailable for this launch) before hard-rejecting. Rotation still
  //    requires a preflight-registered alternate — we never silently burn a
  //    second paid provider without an adapter present.
  // Operator-tunable threshold (issue #2185): non-positive disables the whole
  // gate — cached binding-window decisions included — so a run-down window can
  // still be spent on explicitly chosen claude-code work.
  const quotaHeadroomThreshold =
    deps.getQuotaHeadroomThreshold?.() ?? QUOTA_NO_HEADROOM_UTILIZATION;
  if (
    quotaHeadroomThreshold > 0 &&
    (deps.getLiveQuotaHeadroom || deps.planQuotaBindingCache) &&
    agentType === 'claude-code'
  ) {
    const cache = deps.planQuotaBindingCache;
    const cached = cache?.get() ?? null;
    // Re-check the cached exhaustion against the *current* threshold: raising
    // the threshold mid-window must not keep denying off a stale, stricter
    // decision.
    let decision = cached && cached.maxUtilization >= quotaHeadroomThreshold
      ? {
          admit: false as const,
          maxUtilization: cached.maxUtilization,
          threshold: quotaHeadroomThreshold,
          resetsAt: cached.resetsAt,
        }
      : null;
    if (!decision && deps.getLiveQuotaHeadroom) {
      const sample = await deps.getLiveQuotaHeadroom();
      const live = evaluateQuotaHeadroomAdmission(sample, quotaHeadroomThreshold);
      if (!live.admit) {
        cache?.markExhausted(live);
        decision = {
          admit: false,
          maxUtilization: live.maxUtilization,
          threshold: live.threshold,
          resetsAt: live.resetsAt,
        };
      }
    }
    if (decision && !decision.admit) {
      // Exclude claude-code so the pin is treated as unavailable; fall back to
      // the first healthy registered agent in canonical order (WS1.3). Only
      // `substituted` is reachable with the exclude filter (pin never stays
      // "available"). Walk remaining candidates if a substitute fails the R19
      // remote-chat trust boundary so we never rotate onto a forbidden agent.
      // issue #2194: also strip auth-expired grok-build from rotation candidates.
      const available = filterLaunchableAgentTypes(
        adapterRegistry.getTypes().filter((t) => t !== 'claude-code'),
        { grokAuthUsable: deps.isGrokAuthUsable?.() ?? true },
      );
      const deprioritized = deps.getDeprioritizedAgentTypes?.(available) ?? [];
      const fallbackPolicy = deps.getAgentFallbackPolicy?.();
      let toAgent: AgentType | null = null;
      let remaining = available;
      while (remaining.length > 0) {
        const fallback = resolvePinnedAgentFallback(
          'claude-code',
          remaining,
          deprioritized,
          fallbackPolicy,
        );
        if (fallback.kind !== 'substituted') break;
        const candidate = fallback.agentType;
        // R19: re-apply after rotation. A telegram launch that requested
        // claude-code must not land on codex/grok when the env flag is off.
        if (
          opts.launchSource === 'remote-chat-telegram' &&
          candidate !== 'claude-code' &&
          !(candidate === 'codex-cli' && allowRemoteChatCodex())
        ) {
          remaining = remaining.filter((t) => t !== candidate);
          continue;
        }
        toAgent = candidate;
        break;
      }
      if (toAgent) {
        const fromAgent = agentType;
        // Drop pins that are invalid for the substitute (schedule WS1.3 drops
        // all pins on substitution; we only drop ones the substitute rejects).
        if (effectiveEffort !== undefined && !isValidEffortForAgent(toAgent, effectiveEffort)) {
          effectiveEffort = undefined;
        }
        if (effectiveModel !== undefined && !isValidModelForAgent(toAgent, effectiveModel)) {
          effectiveModel = undefined;
        }
        agentType = toAgent;
        planQuotaRotation = {
          fromAgent,
          toAgent,
          maxUtilization: decision.maxUtilization,
          threshold: decision.threshold,
          resetsAt: decision.resetsAt,
        };
        agentSubstitutionChain.push({
          reason: 'quota_rotate',
          from: fromAgent,
          to: toAgent,
        });
        console.warn(
          `[backpressure] Anthropic quota utilization ${decision.maxUtilization.toFixed(0)}% ` +
          `≥ threshold ${decision.threshold.toFixed(0)}% — rotating agent ` +
          `${fromAgent} → ${toAgent}` +
          (decision.resetsAt ? ` (resets ${decision.resetsAt})` : ''),
        );
      } else {
        console.warn(
          `[backpressure] Anthropic quota utilization ${decision.maxUtilization.toFixed(0)}% ` +
          `≥ threshold ${decision.threshold.toFixed(0)}% — rejecting claude-code launch ` +
          `(no healthy alternate)` +
          (decision.resetsAt ? ` (resets ${decision.resetsAt})` : ''),
        );
        throw new QuotaHeadroomAdmissionError(
          snapshotCapacityLedger(deps, maxActive),
          decision.maxUtilization,
          decision.threshold,
          decision.resetsAt,
        );
      }
    }
  }

  // 1) CPU-aware admission (issue #1630). Checked next so a host-saturation
  //    rejection never consumes a per-source burst token. Opt-in and
  //    disabled by default (threshold 0), and — unlike the guards below —
  //    independent of active-task count: a handful of compile/test-heavy
  //    tasks saturate the shared host regardless of how many tasks are
  //    "active". Schedule fires are exempt for the same reason the spawn
  //    budget exempts them (operator-configured cadence, already bounded).
  const hostLoadThreshold = deps.getMaxHostLoadPerCpu?.() ?? 0;
  if (hostLoadThreshold > 0 && deps.getHostLoadSample && (opts.launchSource ?? 'api') !== 'schedule') {
    const decision = evaluateHostLoadAdmission(deps.getHostLoadSample(), hostLoadThreshold);
    if (!decision.admit) {
      console.warn(
        `[backpressure] host CPU load ${decision.loadPerCpu.toFixed(2)}/core ` +
        `exceeds threshold ${decision.threshold.toFixed(2)} — rejecting launch`,
      );
      throw new HostLoadAdmissionError(
        snapshotCapacityLedger(deps, maxActive),
        decision.loadPerCpu,
        decision.threshold,
      );
    }
  }

  // 2) Per-source spawn budget. Checked before the queue-depth guard: it
  //    identifies the misbehaving CALLER, which is more actionable than the
  //    shared-queue state — a runaway burst should see "you are bursting"
  //    even once it has also
  //    filled the queue. Schedule fires are exempt (see SpawnRateLimiter
  //    module docs): their cadence is operator-configured and already bounded
  //    by per-schedule coalescing + dead-man alerting.
  const launchSourceForBudget = opts.launchSource ?? 'api';
  // Reserved self-maintenance capacity (issue #1564): a non-privileged launch
  // (e.g. a lucy burst) is capped below the full pool so the last
  // `reservedActiveSlots` slots stay available for kookr self-maintenance.
  // Privileged launches (source/actor in `reservedSlotSources`) see the full
  // cap. Absent reservation ⇒ `effectiveMaxActive === maxActive`, unchanged.
  const effectiveMaxActive = effectiveMaxActiveForLaunch(
    deps,
    maxActive,
    launchSourceForBudget,
    opts.launchActorId,
  );
  if (deps.spawnRateLimiter && launchSourceForBudget !== 'schedule') {
    const verdict = deps.spawnRateLimiter.tryAcquire(
      spawnBudgetKey(launchSourceForBudget, opts.launchActorId),
    );
    if (!verdict.allowed) {
      console.warn(
        `[backpressure] spawn burst limit hit for source "${verdict.source}" ` +
        `(${verdict.count}/${verdict.limit} in ${Math.round(verdict.windowMs / 60_000)}m)`,
      );
      throw new SpawnBurstLimitError(verdict, snapshotCapacityLedger(deps, maxActive));
    }
  }

  // 3) Pending-queue depth limit (FM3). Only bites when the launch would
  //    actually pend (node at capacity): below capacity the task launches
  //    immediately and queue depth is irrelevant, so behavior is unchanged.
  if (taskStore.getActiveCount() >= effectiveMaxActive) {
    const maxPending = deps.getMaxPendingTasks?.() ?? DEFAULT_MAX_PENDING_TASKS;
    if (taskStore.getPendingCount() >= maxPending) {
      console.warn(
        `[backpressure] pending queue full (${taskStore.getPendingCount()}/${maxPending}) at capacity — rejecting launch`,
      );
      throw new PendingQueueFullError(snapshotCapacityLedger(deps, maxActive), maxPending);
    }
  }

  // --- Issue-claim / relaunch-lease CAS (RFC PR 1b, R4 phase b; #1711) ---
  // Fully synchronous: check maps → createTask → acquire/claim. No await
  // between check and set. Denied → throw with NO task created.
  if (resolvedClaimKey && deps.relaunchArbiter) {
    const decision = deps.relaunchArbiter.evaluate(resolvedClaimKey);
    if (!decision.admit) {
      if (decision.reason === 'backoff') {
        throw new RelaunchDeniedError('backoff', resolvedClaimKey, {
          retryAfterMs: decision.retryAfterMs,
        });
      }
      throw new RelaunchDeniedError('held', resolvedClaimKey, { lease: decision.lease });
    }
  }
  if (resolvedClaimKey && deps.issueClaimRegistry) {
    const holder = deps.issueClaimRegistry.ownerRecord(resolvedClaimKey);
    if (holder) {
      throw new IssueClaimHeldError({
        ...resolvedClaimKey,
        taskId: holder.taskId,
        ownerStatus: holder.ownerStatus,
        claimedAt: holder.claimedAt,
        ...(holder.ownerName !== undefined ? { ownerName: holder.ownerName } : {}),
        ...(holder.worktreePath !== undefined ? { worktreePath: holder.worktreePath } : {}),
        ...(holder.sessionId !== undefined ? { sessionId: holder.sessionId } : {}),
      });
    }
  }

  const task = taskStore.createTask({
    prompt: effectivePrompt,
    userPrompt,
    cwd: opts.cwd,
    criteria: opts.criteria,
    parentTaskId: opts.parentTaskId,
    // Launch provenance signals (issue #1583). createTask derives the immutable
    // Task.provenance from these plus parentTaskId; the metadata.launchSource
    // stamp below stays for the backpressure/promotion-guard consumers.
    launchSource: opts.launchSource,
    scheduleId: opts.scheduleId,
    agentType,
    launchIntent: buildTaskLaunchIntent(agentType, {
      model: effectiveModel,
      effort: effectiveEffort,
    }),
    name: opts.name,
    playbookId: opts.playbookId,
    projectId: opts.projectId,
    playbookParameterValues: opts.playbookParameterValues,
    // metadata.launchSource (issue #1526 Phase C / C3): stamp provenance on
    // the record so the promotion posture guard can recognize schedule-fired
    // pendings as self-releasing. Additive — absent when no source was given.
    // agentSubstitutionChain (issue #2001): full schedule_sub + quota_rotate
    // hops so receipts match the final agentType after multi-hop cascade.
    metadata: (opts.metadataIntent || opts.launchSource || agentSubstitutionChain.length > 0)
      ? {
          ...(opts.metadataIntent ? { intent: opts.metadataIntent } : {}),
          ...(opts.launchSource ? { launchSource: opts.launchSource } : {}),
          ...(agentSubstitutionChain.length > 0
            ? { agentSubstitutionChain: [...agentSubstitutionChain] }
            : {}),
        }
      : undefined,
    launchHealthSummary,
    launchNote,
    deliveryAuthorization,
    autoCloseOnSignal: opts.autoCloseOnSignal,
    unattended: opts.unattended,
    migratedFromTaskId: opts.migratedFromTaskId,
  });

  if (resolvedClaimKey && deps.relaunchArbiter) {
    const acquire = deps.relaunchArbiter.tryAcquire(resolvedClaimKey, task.id);
    if (!acquire.ok) {
      taskStore.deleteTask(task.id);
      if (acquire.reason === 'backoff') {
        throw new RelaunchDeniedError('backoff', resolvedClaimKey, {
          retryAfterMs: acquire.retryAfterMs,
        });
      }
      throw new RelaunchDeniedError('held', resolvedClaimKey, { lease: acquire.lease });
    }
  }

  if (resolvedClaimKey && deps.issueClaimRegistry) {
    const claimResult = deps.issueClaimRegistry.claim(resolvedClaimKey, { taskId: task.id });
    if (!claimResult.ok) {
      // Single-threaded so this should be unreachable after the pre-check;
      // keep it as a self-healing backstop: no orphaned task without a claim.
      deps.relaunchArbiter?.release(resolvedClaimKey, task.id);
      taskStore.deleteTask(task.id);
      throw new IssueClaimHeldError(claimResult.owner);
    }
  }

  // Hard admission gate (issue #1711): a claimIssue launch must hold a lease.
  // When the arbiter is wired the relaunch lease is required; when the issue-
  // claim registry is wired the durable claim is required. If either is
  // missing after the CAS above, dispose the task and refuse — no launch
  // without a held lease.
  if (resolvedClaimKey && (deps.relaunchArbiter || deps.issueClaimRegistry)) {
    const arbiterHeld =
      !deps.relaunchArbiter ||
      deps.relaunchArbiter.getLease(resolvedClaimKey)?.holderId === task.id;
    const claimHeld =
      !deps.issueClaimRegistry ||
      deps.issueClaimRegistry.ownerRecord(resolvedClaimKey)?.taskId === task.id;
    if (!arbiterHeld || !claimHeld) {
      deps.relaunchArbiter?.release(resolvedClaimKey, task.id);
      deps.issueClaimRegistry?.safeReleaseAllFor(task.id, 'released');
      taskStore.deleteTask(task.id);
      throw new IssueClaimLeaseRequiredError(resolvedClaimKey);
    }
  }

  if (taskStore.getActiveCount() >= effectiveMaxActive) {
    const queuedTask = taskStore.pendTask(task.id);
    // The task record is committed (queued for promotion), so the round-robin
    // launch consumed its slot — advance the rotation.
    if (isRoundRobin) deps.roundRobinCursor?.advance();
    if (resolvedClaimKey && deps.flushTasks) {
      try {
        await deps.flushTasks();
      } catch (err) {
        console.error(
          `[issue-claims] flush after grant failed for task ${task.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      task: queuedTask,
      queued: true,
      ...(planQuotaRotation
        ? {
            admission: 'rotated' as const,
            reason: 'plan_quota' as const,
            fromAgent: planQuotaRotation.fromAgent,
            toAgent: planQuotaRotation.toAgent,
            maxUtilization: planQuotaRotation.maxUtilization,
            threshold: planQuotaRotation.threshold,
            resetsAt: planQuotaRotation.resetsAt,
          }
        : {}),
      ...(agentSubstitutionChain.length > 0
        ? { agentSubstitutionChain: [...agentSubstitutionChain] }
        : {}),
    };
  }

  // PR4: ralph-loop launches need verdict env injected so iteration 0 can
  // write a verdict. Subsequent iterations get this via `launchFreshRuntime`;
  // this fills the gap on the first launch.
  // #681 / #1518: thread per-task effort and model pins through to the adapter.
  // Per-agent-type effort defaults are resolved inside the adapter; model has
  // no Kookr-global default for claude-code. When none of these are set,
  // adapterOpts stays `undefined`; the adapter still selects its CLI defaults.
  // Always carries the per-phase instrumentation callback (issue #1589) so the
  // adapter can mark the `session-create`/`agent-boot`/`ack` boundaries that
  // live inside `adapter.launch()`; the other fields stay conditional so a
  // launch with none of them is byte-identical to pre-#1589 apart from onPhase.
  const adapter = adapterRegistry.get(agentType);
  // Issue #2500: an abandoned launch (top-level launch timeout) that already
  // brought up a dtach master during `session-create` must LINK that master to
  // the task and REAP it — otherwise the reaper finds a live master with no
  // owning task and classifies it `unowned` (reaped only after 24h, or 2h under
  // dtach pressure), which is exactly what tripped the soft bound. The adapter
  // reports the master id via `onSessionCreated` the moment it exists; we record
  // it here and, once (or if already) timed out, link + kill it.
  const abandon: { timedOut: boolean; sessionId: string | undefined; reaped: boolean } = {
    timedOut: false,
    sessionId: undefined,
    reaped: false,
  };
  const linkAndReapAbandonedSession = (sessionId: string): void => {
    // Link first (terminal-safe, idempotent) so the reaper owns the master as a
    // `terminal-task-leak` (60s) even if the async kill below races a sweep,
    // and so a restart never re-attaches it (recorded `lastStatus: 'aborted'`).
    try {
      taskStore.recordAbandonedLaunchSession(task.id, {
        tmuxSession: sessionId,
        agentType,
        cwd: opts.cwd,
        createdAt: new Date(),
      });
    } catch (linkErr) {
      console.warn(
        `[launch] failed to link abandoned session ${sessionId} to task ${task.id}: ` +
        `${linkErr instanceof Error ? linkErr.message : String(linkErr)}`,
      );
    }
    if (abandon.reaped) return;
    abandon.reaped = true;
    // Operator signal (issue #2500): the incident that motivated this fix was
    // diagnosed from `audit.jsonl` `session.reap` rows + the reaper's orphan
    // counters. This reap runs OUTSIDE the periodic sweep, so mirror the
    // reaper's evidence here — a positive intent line now, and the durable
    // `session.reap` row (actor `system:launch-service`) only AFTER
    // `adapter.stop()` actually resolves. Matching the reaper's contract
    // (session-reaper.ts: `killSession` then audit row, and NO success row when
    // the kill throws), a failed kill must never leave a false "reaped" trail —
    // the session is already recorded on the task, so the next reaper sweep
    // still reaps it as a terminal-task-leak.
    console.warn(
      `[launch] linking + reaping abandoned-launch session ${sessionId} for terminal task ${task.id} ` +
      `(agent ${agentType}) — owned as terminal-task-leak (60s), not left as a 24h unowned orphan`,
    );
    // TERM -> grace -> KILL + socket removal via the adapter's stop() (issue
    // #1528 race helper does the same on a late RESOLUTION; this covers the
    // common case where the launch never resolves at all).
    void Promise.resolve(adapter.stop(sessionId)).then(
      () => {
        void appendAuditRow(deps.auditLogPath, {
          type: 'session.reap',
          timestamp: nowISO(),
          actor: 'system:launch-service',
          sessionId,
          taskId: task.id,
          kind: 'terminal-task-leak',
          signal: 'SIGTERM_then_SIGKILL',
          reason:
            'launch abandoned after session-create (top-level launch timeout) — late dtach master linked and reaped',
        });
      },
      (stopErr) => {
        console.warn(
          `[launch] failed to reap abandoned session ${sessionId} for task ${task.id} ` +
          '(recorded on the task; the next reaper sweep reaps it as a terminal-task-leak): ' +
          `${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
        );
      },
    );
  };
  const adapterOpts: import('../adapters/agent-adapter.js').AdapterLaunchOptions = {
    onPhase: (phase) => phaseTracker.enter(phase),
    onSessionCreated: (sessionId) => {
      abandon.sessionId = sessionId;
      // Late creation: the launch was already abandoned when the master came up
      // ("session socket appears shortly after abandon"). Link + reap it now.
      if (abandon.timedOut) linkAndReapAbandonedSession(sessionId);
    },
    ...(opts.ralphVerdictEnv
      ? {
          extraEnv: {
            RALPH_VERDICT_FILE: defaultVerdictPath(opts.cwd, task.id),
            RALPH_ITERATION: '0',
          },
        }
      : {}),
    ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
    ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
    ...(opts.sandboxProfile ? { sandboxProfile: opts.sandboxProfile } : {}),
  };

  // #700 defense-in-depth: reserve the just-created task for this launch so a
  // concurrent promoter can never race it, and so getActiveCount counts the
  // in-flight launch against the cap (audit item 1, second launch site).
  phaseTracker.enter('reserve');
  taskStore.beginLaunch(task.id);
  // The disposition guard wraps ONLY the launch race — the point before which
  // no session has attached. Post-attach bookkeeping (posture stamping, audit
  // append) runs AFTER this block, so a bookkeeping fault can never dispose a
  // task that already reached a live session (issue #1588 review).
  try {
    // Hard timeout around the adapter launch (issue #1526 Phase C / #1528):
    // a launch that hangs (CPU saturation wedging the spawn path) fails fast
    // through the SAME catch/cleanup as any thrown launch instead of holding
    // its beginLaunch reservation — and its schedule's 'reserved' execution —
    // for hours. Late settlement of the abandoned promise is defused inside
    // the race helper.
    await raceLaunchAgainstTimeout(
      adapter.launch(task.id, promptWithLaunchNote(task), opts.cwd, undefined, adapterOpts),
      resolveLaunchTimeoutMs(deps),
      { taskId: task.id, agentType, adapter, reapGuard: abandon },
    );
  } catch (err) {
    // Never silently delete a persisted task (issue #1588). A launch that
    // timed out or threw before any session attached still left a real record;
    // deleting it (the old behaviour) erased the evidence AND let a retried
    // POST with the same idempotency key create a duplicate. Instead, record a
    // queryable disposition and mark the task terminal so:
    //   - `GET /api/tasks/:id` shows WHY it died (reason + timestamp), and
    //   - a retry finalizes on this task (see launchTaskIdempotent) and gets it
    //     back as an idempotent replay rather than a sibling.
    // The round-robin cursor was not advanced yet, so the rotation is untouched.
    // A terminal task never matches the active-only dedup, so future retries
    // are not blocked (the original goal of the delete) — they simply replay.
    // A late-settling abandoned launch cannot corrupt this terminal record:
    // TaskStore.addSession refuses to attach a session to a terminal task.
    taskStore.endLaunch(task.id);
    // Issue #2500: if a dtach master came up during `session-create` (or comes
    // up shortly after this abandon — the late `onSessionCreated` handles that
    // case), link it to the task BEFORE the terminal transition so the reaper
    // owns it as a `terminal-task-leak` (60s), and reap it so a late boot cannot
    // outlive the abandoned launch. Done before setDisposition/terminate so the
    // link lands while the task is still non-terminal; the record method is
    // terminal-safe regardless.
    abandon.timedOut = true;
    if (abandon.sessionId) linkAndReapAbandonedSession(abandon.sessionId);
    // R5b: release any issue claim / relaunch lease granted above so a failed
    // launch cannot leave an orphaned map entry / phantom granted audit row.
    // safeRelease never throws; lifecycle wrappers would also release on
    // terminate, but terminateTask below bypasses those wrappers. Arbiter
    // release starts the post-failure backoff window (#1711).
    if (resolvedClaimKey) {
      deps.relaunchArbiter?.release(resolvedClaimKey, task.id);
    }
    deps.issueClaimRegistry?.safeReleaseAllFor(task.id, 'released');
    // Instrumentation (issue #1589): the launch was abandoned mid-phase. abort()
    // flags the in-flight phase as `incompletePhase` — the phase that consumed
    // the time. Persist it on the disposed task (so `GET /api/tasks/:id` shows
    // WHERE it hung) and attach it to the error so a schedule fire's
    // `dispatch_failed` ledger row can carry the same breakdown without a taskId
    // link. Both are best-effort and must never mask the original launch error.
    phaseTracker.abort();
    const phaseTimings = phaseTracker.snapshot();
    taskStore.setLaunchPhaseTimings(task.id, phaseTimings);
    attachLaunchPhaseTimings(err, phaseTimings);
    const reason: TaskDispositionReason = isLaunchTimeoutError(err) ? 'launch_timeout' : 'launch_error';
    taskStore.setDisposition(task.id, {
      reason,
      at: nowISO(),
      source: 'launch-service',
      detail: err instanceof Error ? err.message : String(err),
    });
    try {
      taskStore.terminateTask(task.id);
    } catch (terminateErr) {
      // Best-effort: the disposition (the queryable evidence) is already
      // written, so a failed terminal transition must not mask the original
      // launch error the caller needs to see.
      console.error(`[launch] failed to terminate disposed task ${task.id}:`, terminateErr);
    }
    deps.launchOutcomeMetrics?.record({
      agentType,
      outcome: 'failure',
      reason: classifyLaunchFailureReason(err),
    });
    // Boot-reliability failover precondition (#1898): a launch abandoned in
    // `agent-boot` is exactly the boot-latency evidence the rotation uses to
    // deprioritize this agent on the next round-robin selection. Recorded here
    // — after the #1588 disposition/terminate bookkeeping and alongside the
    // other best-effort metrics — so instrumentation can never pre-empt the
    // queryable disposition or mask the original launch error.
    deps.recordLaunchBootLatency?.(agentType, phaseTimings);
    markDisposedTask(err, task.id);
    throw err;
  }
  // --- Launch succeeded: a session is attached and the agent is live. ---
  deps.launchOutcomeMetrics?.record({ agentType, outcome: 'success' });
  // Instrumentation (issue #1589): finalize and persist the full
  // `preflight → reserve → session-create → agent-boot → ack` breakdown on the
  // task so a slow-but-successful launch is as diagnosable as a failed one.
  phaseTracker.complete();
  const successPhaseTimings = phaseTracker.snapshot();
  taskStore.setLaunchPhaseTimings(task.id, successPhaseTimings);
  // Boot-reliability failover precondition (#1898): a healthy `agent-boot`
  // sample lets a previously-deprioritized agent self-heal back into rotation.
  deps.recordLaunchBootLatency?.(agentType, successPhaseTimings);
  if (bypassAllPermissions) {
    const launchPermissionPosture = {
      bypassAllPermissions: true as const,
      mode: 'bypass-all' as const,
      capturedAt: nowISO(),
    };
    taskStore.setLaunchPermissionPosture(task.id, launchPermissionPosture);
    // Best-effort audit append: an interaction-log I/O fault must NOT fail —
    // or dispose — a launch that already spawned an agent (issue #1588 review).
    try {
      await deps.interactionLog?.append({
        type: 'task_launch_permission_posture',
        taskId: task.id,
        agentType,
        bypassAllPermissions: true,
        mode: 'bypass-all',
        timestamp: launchPermissionPosture.capturedAt,
      });
    } catch (logErr) {
      console.error(`[launch] failed to append launch-permission-posture audit for task ${task.id}:`, logErr);
    }
  } else {
    taskStore.setLaunchPermissionPosture(task.id, undefined);
  }
  // The launch succeeded — advance the rotation now that the task is live.
  if (isRoundRobin) deps.roundRobinCursor?.advance();
  // R5: force-flush after grant so the claim survives a crash before the
  // next coalesced save.
  if (resolvedClaimKey && deps.flushTasks) {
    try {
      await deps.flushTasks();
    } catch (err) {
      console.error(
        `[issue-claims] flush after grant failed for task ${task.id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const source = opts.launchSource ?? 'api';
  console.log(`[launch] source=${source} agent=${agentType} taskId=${task.id} cwd=${opts.cwd}`);
  const launchedTask = taskStore.getTask(task.id) ?? task;
  await registerNewAgent(launchedTask, lifecycleDeps);
  return {
    task: launchedTask,
    queued: false,
    ...(planQuotaRotation
      ? {
          admission: 'rotated' as const,
          reason: 'plan_quota' as const,
          fromAgent: planQuotaRotation.fromAgent,
          toAgent: planQuotaRotation.toAgent,
          maxUtilization: planQuotaRotation.maxUtilization,
          threshold: planQuotaRotation.threshold,
          resetsAt: planQuotaRotation.resetsAt,
        }
      : {}),
    ...(agentSubstitutionChain.length > 0
      ? { agentSubstitutionChain: [...agentSubstitutionChain] }
      : {}),
  };
}

export function promptWithLaunchNote(task: Pick<Task, 'prompt' | 'launchNote'>): string {
  return task.launchNote ? `${task.launchNote}\n\n${task.prompt}` : task.prompt;
}

function summarizeLaunchHealth(findings: LaunchPreflightFinding[]): TaskLaunchHealthSummary | undefined {
  if (findings.length === 0) return undefined;
  return {
    degradedDependencies: [...new Set(findings.map((finding) => finding.dependency))],
    findings,
  };
}

function sanitizeLaunchPreflightFindings(findings: LaunchPreflightFinding[]): LaunchPreflightFinding[] {
  return findings.map((finding) => ({
    ...finding,
    ...(finding.detail ? { detail: redactDiagnosticText(finding.detail, 500) } : {}),
  }));
}

function formatLaunchNote(findings: LaunchPreflightFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const lines = findings.map((finding) => {
    const detail = finding.detail ? ` Detail: ${finding.detail}` : '';
    return `- ${finding.summary} (${finding.category}).${detail} Recommended action: ${finding.recommendedAction}`;
  });
  return [
    '[Kookr launch warning] One or more advisory launch dependencies are degraded. Continue the task without assuming those services are available.',
    ...lines,
  ].join('\n');
}

async function collectAdvisoryDependencyFindings(
  runner: DependencyPreflightRunner,
  dependencies: LaunchDependency[] | undefined,
): Promise<LaunchPreflightFinding[]> {
  try {
    return await runner(dependencies);
  } catch (err) {
    console.warn('[launch] advisory dependency preflight failed internally:', err);
    if (!dependencies?.includes('kb')) return [];
    return [{
      dependency: 'kb',
      status: 'failed',
      category: 'unknown',
      summary: 'KB dependency preflight could not complete',
      detail: redactDiagnosticText(err instanceof Error ? err.message : String(err), 500),
      recommendedAction: 'Run `kb doctor --format=json` manually and address the reported KB failure.',
    }];
  }
}

/**
 * Launch a fresh runtime session for an already-existing task (used by the
 * Ralph loop service to re-inject the loop prompt after each iteration).
 * Returns the new tmux session name.
 *
 * Deliberately NOT subject to the drain gate (issue #659): this continues
 * *in-flight* work on an existing task rather than creating a new one, and
 * drain's contract is that already-running agents and in-flight work run to
 * completion. The cordon is enforced on {@link launchTask} (new-task creation)
 * and on the scheduler, not here.
 */
export async function launchFreshTaskSession(
  deps: LaunchServiceDeps,
  task: Task,
  prompt: string,
  opts?: import('../adapters/agent-adapter.js').AdapterLaunchOptions,
): Promise<string> {
  const intent = validatePersistedLaunchIntent(task);
  if (!intent.ok) {
    deps.taskStore.setRelaunchDisposition(task.id, {
      outcome: 'not_relaunched',
      source: 'ralph',
      reason: intent.reason,
      at: nowISO(),
      detail: intent.detail,
    });
    throw new Error(`Automatic Ralph relaunch refused for task ${task.id}: ${intent.detail}`);
  }
  const pins = launchIntentPins(intent.intent);
  const { effort: _ignoredEffort, model: _ignoredModel, ...callerOpts } = opts ?? {};
  const sessionId = await deps.adapterRegistry.get(task.agentType).launch(
    task.id,
    prompt,
    task.cwd,
    undefined,
    {
      ...callerOpts,
      ...(pins.effort !== undefined ? { effort: pins.effort } : {}),
      ...(pins.model !== undefined ? { model: pins.model } : {}),
    },
  );
  const launchedTask = deps.taskStore.getTask(task.id) ?? task;
  await registerNewAgent(launchedTask, deps.lifecycleDeps);
  return sessionId;
}
