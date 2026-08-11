import type { AgentActivityMeta, AgentEvent, Anomaly, AnomalyType, TokenUsage, TurnState, WorktreeHealth } from './types.js';
import type { CompletionDigest } from './completion-digest.js';
import type { TaskDependencyEdge, TaskLaunchPermissionPosture } from '../shared/contracts/task.js';
import type { Task, TaskLaunchHealthSummary, TaskStore } from './tasks.js';
import { isAgedTerminalTask } from './tasks.js';
import type { UserInputDeliverySnapshot } from '../shared/contracts/user-input-delivery.js';
import type { SessionHealthSnapshot } from '../shared/contracts/session-health.js';
import type { AttentionQueue } from './attention-queue.js';
import type { SnoozeSuppressionTracker } from './snooze-suppression.js';
import type { WatchdogVerdict } from './watchdog.js';
import { anomalyFingerprint } from './anomaly-fingerprint.js';
import { detectAnomalies, evaluateAnomalies } from './anomaly-detector.js';
import { deriveTurnState } from './turn-state.js';
import { deriveLatestCompletionSignal } from './completion-signal.js';
import type { LatestCompletionSignal } from '../shared/contracts/completion-signal.js';
import {
  recordDetectionCheck,
  recordDetectionFire,
  recordSubagentOrphans,
  recordSubagentTtlEviction,
  recordSuppression,
  type AnomalyDetectorConfig,
} from './detection-stats.js';
import {
  FindingEvidenceAuditor,
  type FindingEvidenceAuditRecord,
} from './finding-evidence-audit.js';
import { OutstandingSubagentTracker } from './outstanding-subagents.js';
import {
  SYSTEMIC_HOOK_STALL_REASON,
  SystemicHookStallTracker,
} from './systemic-hook-stall.js';
import { lastAssistantMessage } from './transcript-parser.js';

/**
 * Live agent state produced by {@link Monitor}.
 *
 * Wire/client SSOT is {@link import('../shared/contracts/agent-state.js').AgentState}
 * (`shared/contracts/agent-state.ts`). This type is the narrow live/internal
 * shape: it intentionally omits projection-only dashboard fields
 * (`childRollup`, `effectiveAttentionSeverity`, `pendingSignal`, `reapOutcome`,
 * `stuckReason`, `terminalInputSnapshot`) which snapshot builders attach via
 * {@link import('./monitor-agent-state.js').toClientAgentState}. See issue #1460.
 */
export interface MonitorAgentState {
  agentId: string;
  events: AgentEvent[];
  anomaly: Anomaly | null;
  /**
   * Current turn state of the live agent, derived from its event window.
   * Distinct from `taskStatus` (persisted lifecycle): an interactive task can
   * remain `inProgress` while its turn state is `completed_turn`. Absent for
   * synthetic pending/terminal entries that have no live event window.
   */
  turnState?: TurnState;
  latestCompletionSignal?: LatestCompletionSignal;
  snoozedUntil?: number; // ms since epoch — set when agent is snoozed in the attention queue
  suppressed?: boolean; // true when auto-suppressed due to repeated liveness snoozes
  taskId?: string;
  taskName?: string;
  taskStatus?: import('./types.js').TaskStatus;
  priority?: import('../shared/contracts/task.js').TaskPriority;
  parentTaskId?: string;
  childTaskIds?: string[];
  blocks?: TaskDependencyEdge[];
  blocked_by?: TaskDependencyEdge[];
  description?: string; // full task prompt, shown on hover
  cwd?: string;
  agentType?: import('../core/agent-types.js').AgentType;
  startedAt?: string; // ISO 8601
  /** ISO timestamp for the first terminal transition on synthetic terminal rows. */
  finishedAt?: string;
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
  launchHealthSummary?: TaskLaunchHealthSummary;
  launchPermissionPosture?: TaskLaunchPermissionPosture;
  tokenUsage?: TokenUsage;
  gitBranch?: string;
  gitCommit?: string;
  gitIsWorktree?: boolean;
  worktreeHealth?: WorktreeHealth;
  worktreeHealthObservedAt?: string;
  worktreeRegistryStale?: boolean;
  projectId?: string;
  projectDisplayLabel?: string;
  completionDigest?: CompletionDigest;
  completionFeedback?: import('./tasks.js').TaskCompletionFeedback;
  ralphLoop?: import('./tasks.js').RalphLoopState;
  /** True when the task was launched unattended/autonomous (issue #1562). */
  unattended?: boolean;
  /**
   * Operator-needed marker (issue #1562): set when an unattended agent's
   * interactive-tool call was denied. Projected from the task record so the
   * dashboard can surface the block instead of an open-ended hang.
   */
  operatorNeeded?: import('../shared/contracts/operator-needed.js').OperatorNeeded;
  /** Activity-panel disclosure counters; populated at snapshot time from
   *  {@link HookIngestion}. See rfc-activity-log-reliability §9. */
  activityMeta?: AgentActivityMeta;
  userInputDeliveries?: UserInputDeliverySnapshot[];
  /** Multi-sample evidence captured for the active supervisor finding. */
  findingEvidenceAudit?: FindingEvidenceAuditRecord;
  /**
   * Sequence number of the last event in {@link events}, or `0` when the
   * window is empty (including synthetic pending/terminal entries). Populated
   * by {@link Monitor.getSnapshot} so speak-summary consumers can detect when
   * fresh activity arrived between cache hit and TTS playback.
   */
  lastEventSeq?: number;
  /** Cross-signal terminal/session health supplied by the server read model. */
  sessionHealth?: SessionHealthSnapshot;
}

/**
 * @deprecated Prefer {@link MonitorAgentState} for live monitor state, or
 * `AgentState` from `shared/contracts/agent-state` for the wire/client DTO.
 * Kept as an alias so existing `import { AgentState } from './monitor'` sites
 * keep compiling during the #1460 transition.
 */
export type AgentState = MonitorAgentState;

const DEFAULT_WINDOW_SIZE = 50;

/**
 * Grace period before an unowned, dead-session monitor agent is swept
 * (issue #1763). An agent must be observed with no owning task for at least
 * this long before {@link Monitor.sweepUnownedDeadAgents} unregisters it, so a
 * brand-new session whose task record has not landed yet is never darkened.
 * Comfortably longer than the ~5s reaper tick and the task/session
 * registration window, short enough to reclaim residual leaks promptly.
 */
export const UNOWNED_MONITOR_AGENT_SWEEP_GRACE_MS = 60_000;

/**
 * Cap on the per-agent set of suppressed completion-signal ids (issue #1612).
 * A long-lived agent that repeatedly ends a turn behind a background subagent
 * adds one id per completion signal with no natural eviction, so the set grew
 * unbounded within a single session. Only the newest signal is ever re-queried
 * (older turns are superseded), so keeping the most recent N ids preserves the
 * suppression contract while bounding retention.
 */
const MAX_SUPPRESSED_COMPLETION_SIGNAL_IDS = 128;

/**
 * Upper bound on the {@link Monitor.stoppedAgents} tombstone set. An id is added
 * on `unregisterAgent` and only removed if the *same* id later re-registers.
 * Because live agents are keyed by unique (non-reused) session ids, the removal
 * path effectively never fires, so without a cap the set grows for the lifetime
 * of the process — steady, unbounded RSS growth on a busy multi-agent host.
 *
 * The set is bounded as a FIFO with oldest-first eviction, mirroring the
 * `auth-throttle` `sources` map. The cap is generous so eviction only ever
 * touches long-gone agents: a tombstone's whole job is to suppress a straggler
 * event that arrives shortly after unregister, and 4096 recently-stopped agents
 * covers any realistic late-event window.
 */
export const MONITOR_STOPPED_AGENTS_MAX = 4096;

/**
 * Anomaly types (and watchdog verdict statuses) whose lifecycle is owned by
 * the watchdog tick path. Centralized so the actionable filter, the
 * non-actionable purge guard, and the suppressed-verdict purge guard all
 * agree on which queue entries the watchdog may legitimately remove.
 * Typed as `string` rather than `AnomalyType` so the same set can be queried
 * with `WatchdogVerdict['status']` (a wider union) without unsafe casts.
 */
const WATCHDOG_OWNED_TYPES: ReadonlySet<string> = new Set([
  'needs_input',
  'permission_blocked',
  'stale_agent',
  'hook_disconnected',
]);

function isWatchdogOwnedType(type: string | undefined): boolean {
  return type !== undefined && WATCHDOG_OWNED_TYPES.has(type);
}

function findingTranscriptContextEnabled(): boolean {
  const raw = process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT;
  return raw === 'true' || raw === '1';
}

/**
 * Watchdog-owned types that must persist for {@link WATCHDOG_DEBOUNCE_MIN_STREAK}
 * *consecutive* actionable verdicts before they are queued. `stale_agent` and
 * `hook_disconnected` are threshold findings derived from elapsed silence — a
 * single tick's verdict routinely flips back to healthy on the next tick when
 * a lagging hook event lands, producing sub-second finding flicker in the
 * dashboard. `needs_input` and `permission_blocked` are evidence-backed (pane
 * dialog / structured hook) and surface immediately.
 */
const WATCHDOG_DEBOUNCE_TYPES: ReadonlySet<string> = new Set(['stale_agent', 'hook_disconnected']);
const WATCHDOG_DEBOUNCE_MIN_STREAK = 2;

export class Monitor {
  private agentEvents = new Map<string, AgentEvent[]>();
  private stoppedAgents = new Set<string>();
  /**
   * First time (epoch ms) each agent was observed *continuously* unowned AND
   * dead (session not live) by {@link sweepUnownedDeadAgents} (issue #1763).
   * Drives the grace period that avoids racing task creation / session
   * registration. Reset the moment the agent regains an owner OR its session
   * is seen live again, so a single transient `listSessions()` omission of a
   * still-live orphan cannot accumulate grace and darken it. Cleared on sweep.
   */
  private agentFirstUnownedDeadAt = new Map<string, number>();
  private windowSize: number;
  /** Monotonic per-agent event counts for self-diagnostic rate checks. */
  private _eventCounts = new Map<string, number>();
  private lastRecordedAnomalyFingerprint = new Map<string, string>();
  private lastEventAnomaly = new Map<string, Anomaly>();
  /**
   * Consecutive actionable watchdog verdicts of the same type, per agent.
   * Reset by any non-actionable verdict. Drives the
   * {@link WATCHDOG_DEBOUNCE_TYPES} flicker debounce.
   */
  private watchdogVerdictStreak = new Map<string, { type: string; count: number }>();
  private findingEvidenceAuditor = new FindingEvidenceAuditor();
  private agentTranscriptPaths = new Map<string, string>();
  /**
   * Outstanding-subagent policy (TTL + suppression). Extracted from Monitor so
   * the pure tracking/suppression policy is independently unit-testable
   * (issue #1464 first slice).
   */
  private outstandingSubagents = new OutstandingSubagentTracker();
  /**
   * Systemic hook-pipeline stall suppressor. Pure verdict-window signal +
   * suppress decision; queue purge / telemetry remain on Monitor
   * (issue #1464 first-slice continuation).
   */
  private systemicHookStall = new SystemicHookStallTracker();
  /** Completion signal ids suppressed because the parent Stop was stale behind TTL-evicted subagents. */
  private suppressedCompletionSignalIds = new Map<string, Set<string>>();
  private sessionHealthProvider?: (agentId: string, turnState: TurnState) => SessionHealthSnapshot | undefined;
  /** Event count at which an outstanding subagent set was TTL-evicted before snapshot turn-state projection. */
  private ttlEvictedSubagentEventCounts = new Map<string, number>();

  constructor(
    private taskStore: TaskStore,
    private attentionQueue: AttentionQueue,
    private anomalyConfig?: Partial<AnomalyDetectorConfig>,
    windowSize = DEFAULT_WINDOW_SIZE,
    private suppressionTracker?: SnoozeSuppressionTracker,
  ) {
    this.windowSize = windowSize;
  }

  /**
   * Update the anomaly detector config at runtime. Uses atomic reference swap
   * (merge with existing) so that fields not included in the update are preserved.
   */
  setAnomalyConfig(config: Partial<AnomalyDetectorConfig>): void {
    this.anomalyConfig = { ...this.anomalyConfig, ...config };
  }

  /** Attach the live cross-signal health read model without coupling core to server services. */
  setSessionHealthProvider(
    provider: (agentId: string, turnState: TurnState) => SessionHealthSnapshot | undefined,
  ): void {
    this.sessionHealthProvider = provider;
  }

  /**
   * Process new events for an agent.
   * Appends to the existing event window (capped at windowSize) and runs anomaly detection.
   * Silently drops events for explicitly stopped agents to prevent resurrection.
   */
  processEvents(agentId: string, events: AgentEvent[], opts?: { eventId?: string }): void {
    // Guard: reject events for explicitly stopped agents (prevents hook watcher race)
    if (this.stoppedAgents.has(agentId)) return;

    const previousCount = this._eventCounts.get(agentId) ?? 0;
    const sequencedEvents = events.map((event, index) => ({
      ...event,
      eventSeq: previousCount + index + 1,
    } as AgentEvent));

    // Increment monotonic event counter for self-diagnostic and client-side
    // activity history merging. The sequence distinguishes repeated identical
    // hook events when the UI receives overlapping windowed snapshots.
    this._eventCounts.set(agentId, previousCount + events.length);

    // Append to existing events, capped at windowSize
    const existing = this.agentEvents.get(agentId) ?? [];
    const combined = [...existing, ...sequencedEvents];
    const capped = combined.length > this.windowSize
      ? combined.slice(combined.length - this.windowSize)
      : combined;
    this.agentEvents.set(agentId, capped);
    this.rememberTranscriptPath(agentId, sequencedEvents);

    // Update subagent tracking before detection so suppression sees current state
    for (const event of sequencedEvents) {
      this.updateSubagentTracking(agentId, event);
    }

    // Run anomaly detection, then apply subagent-aware suppression.
    // recordSuppression fires only here (the write path), not inside the helper —
    // getEventAnomaly is read by snapshot/timer paths and would otherwise inflate
    // the counter once per snapshot tick instead of once per suppressed Stop.
    const evaluation = evaluateAnomalies(capped, agentId, this.anomalyConfig);
    const rawAnomaly = evaluation.anomaly;
    const anomaly = this.stabilizeEventAnomaly(
      agentId,
      this.withTranscriptContext(
        this.suppressIfSubagentsRunning(rawAnomaly, agentId, { markSnapshotTtlEviction: false }),
        agentId,
      ),
      opts?.eventId,
    );
    this.recordDetectionTelemetry(agentId, evaluation.checkedTypes, anomaly);
    if (rawAnomaly?.type === 'needs_input' && anomaly === null) {
      recordSuppression('needs_input', 'subagent_running');
    }

    if (anomaly) {
      this.attentionQueue.enqueue(agentId, anomaly);
      this.findingEvidenceAuditor.observe(agentId, anomaly, capped, { source: 'event' });
    } else {
      // No anomaly — remove from queue if present
      this.attentionQueue.remove(agentId);
      this.findingEvidenceAuditor.observe(agentId, null, capped, { source: 'event' });
    }
  }

  /**
   * Register an agent with no events yet (e.g. just launched).
   * Clears any prior stopped state so relaunched agents work correctly.
   */
  registerAgent(agentId: string): void {
    this.stoppedAgents.delete(agentId);
    this.lastRecordedAnomalyFingerprint.delete(agentId);
    if (!this.agentEvents.has(agentId)) {
      this.agentEvents.set(agentId, []);
    }
  }

  /**
   * Get the anomaly derived strictly from the agent's event window.
   * Does not consult queue-only watchdog fallbacks.
   */
  getEventAnomaly(agentId: string): Anomaly | null {
    const events = this.agentEvents.get(agentId) ?? [];
    const raw = detectAnomalies(events, agentId, this.anomalyConfig);
    const anomaly = this.withTranscriptContext(this.suppressIfSubagentsRunning(raw, agentId), agentId);
    return anomaly ? this.withStableEventDetectedAt(agentId, anomaly) : null;
  }

  /**
   * Get the current anomaly for UI/state purposes.
   * Falls back to active queue anomalies so watchdog findings are visible even
   * when they are not derived from hook events.
   */
  getCurrentAnomaly(agentId: string): Anomaly | null {
    let anomaly = this.getEventAnomaly(agentId);
    const queued = this.attentionQueue.peek(agentId);
    if (anomaly) {
      if (queued && anomalyFingerprint(queued) === anomalyFingerprint(anomaly)) {
        anomaly = { ...anomaly, detectedAt: queued.detectedAt };
      }
      return anomaly;
    }
    return queued;
  }

  /**
   * Apply a watchdog verdict. Monitor is the single owner of the Anomaly union,
   * so this method — not lifecycle-timers — decides whether to enqueue, preserve,
   * or clear the finding. Returns true if something actionable happened (either
   * a finding was enqueued/suppressed, or a stale queue-only verdict was cleared),
   * which the caller uses to decide whether to broadcast a snapshot.
   *
   * Reconciliation rule (formerly `shouldClearQueueOnlyWatchdogAnomaly` in
   * lifecycle-timers): when the verdict is non-actionable (healthy/quiet/etc)
   * AND pane capture succeeded AND there is no event-derived anomaly, clear any
   * leftover queue-only finding. This matches the original predicate exactly
   * and now lives next to the state machine it reads from.
   */
  applyWatchdogVerdict(
    agentId: string,
    verdict: WatchdogVerdict,
    options: { paneCaptureSucceeded: boolean; paneText?: string },
  ): boolean {
    // Explicit-literal form (rather than `isWatchdogOwnedType(verdict.status)`)
    // so TypeScript narrows the discriminated union and verdict.anomaly is
    // typed below. The literals here match WATCHDOG_OWNED_TYPES.
    const actionable = verdict.status === 'needs_input'
      || verdict.status === 'permission_blocked'
      || verdict.status === 'stale_agent'
      || verdict.status === 'hook_disconnected';

    if (actionable) {
      const rawAnomaly = this.withTranscriptContext(verdict.anomaly, agentId) ?? verdict.anomaly;
      // One actionable verdict = one watchdog evaluation of this type. Recorded
      // pre-suppression so detection-stats rates read as admitted/raised for
      // watchdog-owned types (the event path records its own checks).
      recordDetectionCheck(rawAnomaly.type);
      // Feed the systemic-stall signal from the raw verdict, before any
      // suppression: the signal must reflect what the watchdog observed, not
      // what survived suppression — deriving it from queue state is what
      // caused the admit→purge oscillation.
      if (rawAnomaly.type === 'hook_disconnected') {
        this.systemicHookStall.recordVerdict(agentId);
      }
      const anomaly = this.suppressIfSubagentsRunning(rawAnomaly, agentId);
      if (anomaly === null) {
        // Subagent suppressor swallowed the verdict. Clear any prior queued
        // watchdog-owned finding that the same suppressor would also have
        // swallowed, mirroring the non-actionable purge guard below: only
        // purge watchdog-owned types, and only when no event-derived anomaly
        // is currently shadowing the queue.
        recordSuppression(rawAnomaly.type, 'subagent_running');
        const queued = this.attentionQueue.peek(agentId);
        if (queued && isWatchdogOwnedType(queued.type) && !this.getEventAnomaly(agentId)) {
          this.attentionQueue.purge(agentId);
        }
        // Audit trail: surface the suppressed verdict as a resolved record
        // tagged possible_false_positive. Two-step (create-then-resolve) so
        // the M3/M4 review pipeline sees the would-have-been anomaly, not
        // just a silent drop.
        const events = this.agentEvents.get(agentId) ?? [];
        this.findingEvidenceAuditor.observe(agentId, rawAnomaly, events, {
          source: 'watchdog_tick',
          paneText: options.paneText,
        });
        this.findingEvidenceAuditor.observe(agentId, null, events, {
          source: 'watchdog_tick',
          paneText: options.paneText,
          suppressionReason: 'subagent_running',
        });
        return true;
      }

      const eventAnomaly = this.getEventAnomaly(agentId);
      if (eventAnomaly) {
        // Event-derived findings are the source of truth when hook evidence is
        // present; watchdog verdicts should not replace or re-age that finding.
        const queued = this.attentionQueue.peek(agentId);
        this.attentionQueue.enqueue(agentId, eventAnomaly);
        return !queued
          || anomalyFingerprint(queued) !== anomalyFingerprint(eventAnomaly)
          || queued.detectedAt.getTime() !== eventAnomaly.detectedAt.getTime();
      }
      // Suppression tracker opts the agent out of queue entry but the UI still
      // needs to reflect the suppressed state, so report "changed" either way.
      if (this.suppressionTracker?.shouldSuppress(agentId, anomaly.type)) {
        recordSuppression(anomaly.type, 'snooze_false_positive');
        return true;
      }
      // Flicker debounce: silence-derived findings must hold for consecutive
      // ticks before surfacing. A first-tick verdict is recorded but produces
      // no queue entry, no audit record, and no broadcast.
      const streak = this.bumpWatchdogStreak(agentId, anomaly.type);
      if (WATCHDOG_DEBOUNCE_TYPES.has(anomaly.type) && streak < WATCHDOG_DEBOUNCE_MIN_STREAK) {
        return false;
      }
      // Systemic hook-stall guard: when multiple agents go hook-silent at once
      // the hook pipeline (not any single agent) is the cause. Suppress this
      // finding and purge any sibling hook_disconnected entries so one infra
      // blip does not surface as N per-agent false positives. The verdict-window
      // signal keeps suppressing for as long as ≥2 agents keep producing
      // hook_disconnected verdicts — the purge cannot reset it.
      if (this.systemicHookStall.shouldSuppress(anomaly.type)) {
        recordSuppression('hook_disconnected', SYSTEMIC_HOOK_STALL_REASON);
        const events = this.agentEvents.get(agentId) ?? [];
        this.findingEvidenceAuditor.observe(agentId, anomaly, events, {
          source: 'watchdog_tick',
          paneText: options.paneText,
        });
        this.findingEvidenceAuditor.observe(agentId, null, events, {
          source: 'watchdog_tick',
          paneText: options.paneText,
          suppressionReason: SYSTEMIC_HOOK_STALL_REASON,
        });
        this.purgeSystemicHookStallSiblings(agentId, options.paneText);
        return true;
      }
      // Fire telemetry only on a genuine queue transition: re-enqueues of the
      // same finding (same fingerprint) preserve detectedAt and are not new
      // detections. Watchdog fires were previously never recorded at all,
      // leaving detection-stats blind to stale_agent/hook_disconnected storms.
      const queuedBefore = this.attentionQueue.peek(agentId);
      this.attentionQueue.enqueue(agentId, anomaly);
      if (!queuedBefore || anomalyFingerprint(queuedBefore) !== anomalyFingerprint(anomaly)) {
        recordDetectionFire(anomaly.type);
      }
      this.findingEvidenceAuditor.observe(agentId, anomaly, this.agentEvents.get(agentId) ?? [], {
        source: 'watchdog_tick',
        paneText: options.paneText,
      });
      return true;
    }

    // Non-actionable verdict: the consecutive-verdict streak is broken.
    this.watchdogVerdictStreak.delete(agentId);

    // Non-actionable: the watchdog believes the agent is healthy / in grace /
    // running a tool / etc. If a leftover watchdog-enqueued finding is still on
    // the queue, clear it — but only when pane capture succeeded (otherwise we
    // cannot distinguish "agent recovered" from "we just couldn't read it").
    // When an event-derived anomaly already exists, leave the queue alone;
    // processEvents is responsible for that entry.
    if (!options.paneCaptureSucceeded) return false;
    const queued = this.attentionQueue.peek(agentId);
    if (!queued) return false;
    const eventAnomaly = this.getEventAnomaly(agentId);
    if (eventAnomaly) return false;

    if (!isWatchdogOwnedType(queued.type)) return false;

    this.attentionQueue.purge(agentId);
    this.findingEvidenceAuditor.observe(agentId, null, this.agentEvents.get(agentId) ?? []);
    return true;
  }

  /**
   * Capture a periodic evidence observation for the current finding. The
   * watchdog owns pane capture, so lifecycle-timers calls this after each tick.
   */
  sampleFindingEvidence(agentId: string, paneText?: string, now: Date = new Date()): boolean {
    const anomaly = this.getCurrentAnomaly(agentId);
    return this.findingEvidenceAuditor.observe(agentId, anomaly, this.agentEvents.get(agentId) ?? [], {
      source: 'watchdog_tick',
      paneText,
      now,
    });
  }

  getFindingEvidenceAuditRecords(): FindingEvidenceAuditRecord[] {
    return this.findingEvidenceAuditor.getRecords();
  }

  getFindingEvidenceReviewCandidates(limit?: number): FindingEvidenceAuditRecord[] {
    return this.findingEvidenceAuditor.getReviewCandidates(limit);
  }

  /**
   * Inject a synthetic input_received event so the anomaly detector
   * sees that the user has responded and clears needs_input immediately,
   * instead of waiting for the next real hook event from Claude Code.
   * Returns true if state actually changed (finding cleared).
   */
  markInputReceived(agentId: string): boolean {
    if (this.stoppedAgents.has(agentId)) return false;
    const events = this.agentEvents.get(agentId);
    if (!events) return false;

    // Only inject if the agent is actually waiting for input. Prefer the
    // derived anomaly state over the raw last event so trailing bookkeeping
    // events (for example SubagentStop after Stop) do not make a visible
    // needs_input finding impossible to clear.
    const last = events[events.length - 1];
    if (!last) return false;
    const currentAnomaly = this.getCurrentAnomaly(agentId);
    const isWaiting = last.type === 'stop'
      || last.type === 'stop_failure'
      || last.type === 'notification'
      || last.type === 'permission_request'
      || (last.type === 'tool_use' && last.toolName === 'AskUserQuestion')
      || currentAnomaly?.type === 'needs_input'
      || currentAnomaly?.type === 'permission_blocked';
    if (!isWaiting) return false;

    const syntheticEvent: AgentEvent = {
      type: 'input_received',
      sessionId: last.sessionId,
    };
    this.processEvents(agentId, [syntheticEvent]);
    return true;
  }

  /**
   * Check if an agent is currently blocked on a permission request.
   *
   * Uses the derived anomaly (same trim + AskUserQuestion exclusion as
   * `detectPermissionBlocked`) rather than the raw last event, so a trailing
   * `notification(idle_prompt)` after a permission_request does not make
   * remote approval throw "session is not permission-blocked" (#1367).
   */
  isPermissionBlocked(agentId: string): boolean {
    return this.getCurrentAnomaly(agentId)?.type === 'permission_blocked';
  }

  /**
   * Get all agent IDs that currently have a permission_blocked finding.
   */
  getPermissionBlockedAgents(): string[] {
    const blocked: string[] = [];
    for (const agentId of this.agentEvents.keys()) {
      if (this.stoppedAgents.has(agentId)) continue;
      if (this.isPermissionBlocked(agentId)) {
        blocked.push(agentId);
      }
    }
    return blocked;
  }

  /**
   * Get the current event window for an agent (read-only snapshot).
   * Useful for capturing events before unregistering (e.g., for digest generation).
   */
  getAgentEvents(agentId: string): AgentEvent[] {
    return this.agentEvents.get(agentId) ?? [];
  }

  /** Get monotonic per-agent event counts (for self-diagnostic). */
  getEventCounts(): Record<string, number> {
    return Object.fromEntries(this._eventCounts);
  }

  /**
   * Read-only retention counts for the memory ledger (issue #1612). Cheap map
   * sizes and a summed retained-event count — no payload copies — so a soak can
   * attribute RSS growth to the monitor's per-agent windows and Maps.
   */
  getRetentionMetrics(): Record<string, number> {
    let retainedEvents = 0;
    for (const events of this.agentEvents.values()) retainedEvents += events.length;
    let suppressedCompletionSignalIds = 0;
    for (const ids of this.suppressedCompletionSignalIds.values()) suppressedCompletionSignalIds += ids.size;
    return {
      agents: this.agentEvents.size,
      retainedEvents,
      stoppedAgents: this.stoppedAgents.size,
      transcriptPaths: this.agentTranscriptPaths.size,
      suppressedCompletionSignalAgents: this.suppressedCompletionSignalIds.size,
      suppressedCompletionSignalIds,
      outstandingSubagentParents: this.outstandingSubagents.parentCount(),
      outstandingSubagents: this.outstandingSubagents.totalOutstanding(),
      ttlEvictedSubagentCounts: this.ttlEvictedSubagentEventCounts.size,
      unownedDeadGraceTracked: this.agentFirstUnownedDeadAt.size,
    };
  }

  /**
   * Expose raw task records for server-side snapshot projection.
   * Monitor deliberately does not turn these into dashboard AgentState entries.
   * Pass `excludeTerminalBeforeMs` to skip aged terminal tasks BEFORE the
   * per-task clone (issue #1749 follow-up): the client snapshot path discards
   * them anyway, and cloning 800 terminal tasks per snapshot build (~78 MB of
   * transient garbage) was a heap-limit OOM driver. Raw/debug callers omit it
   * and keep full-fidelity history.
   *
   * Tasks owning a session that is live in this monitor's agent map are ALWAYS
   * kept regardless of age: the projection suppresses a live monitor state via
   * the session index built from these tasks, and dropping the owner would
   * leak the state as an unattributed "ghost" agent in client snapshots
   * (agentId === session.tmuxSession === this map's key).
   */
  getTaskSnapshot(opts?: {
    excludeTerminalBeforeMs?: number;
    maxTerminalTasks?: number;
  }): Task[] {
    if (opts?.excludeTerminalBeforeMs === undefined) {
      return this.taskStore.listTasksForSnapshot(opts);
    }
    return this.taskStore.listTasksForSnapshot({
      ...opts,
      protectSessionIds: new Set(this.agentEvents.keys()),
    });
  }

  /**
   * Re-evaluate the Ralph zero-diff signal after the Ralph cycler has updated
   * loop state. Returns true when the queue was mutated (signal inserted or
   * cleared) so callers can decide whether to broadcast a new snapshot.
   *
   * No-op stub: the full anomaly signal requires additional wiring not included
   * in this recovery slice. Always returns false.
   */
  refreshRalphZeroDiffStreak(_agentId: string): boolean {
    return false;
  }

  /**
   * Remove an agent from monitoring (e.g. session completed or explicitly stopped).
   * Marks the agent as stopped so late-arriving events are silently dropped.
   */
  /**
   * Unregister every agent whose owning task is terminal AND aged past
   * `cutoffMs` (issue #1761). `agentEvents` has no other sweep: startup hook
   * replay re-populates an entry for every historical session (measured 819 on
   * a 814-task store), and reconciliation terminal paths never call
   * {@link unregisterAgent}. Left unswept, those entries (a) leak per-agent
   * retention for the life of the process, (b) make every snapshot build walk
   * hundreds of dead states, and (c) neutralize the #1760 pre-clone filter —
   * its ghost-agent guard must keep any task owning a live agentEvents key, so
   * a fully-populated map protects (and re-clones) nearly the whole store.
   *
   * Uses the same age cutoff as the snapshot payload diet: recent terminal
   * tasks keep their monitor state (and any attention findings —
   * {@link unregisterAgent} purges the attention queue, which is only safe
   * once a finding is stale). Callers pass
   * `now - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS`.
   *
   * Sweeping is TERMINAL for the entry: {@link unregisterAgent} adds the id to
   * `stoppedAgents`, and {@link processEvents} refuses to resurrect stopped
   * agents — a late hook replay after the sweep is dropped, not re-created.
   * That is deliberate (no re-sweep churn), and it is also why
   * `skipSessionIds` exists: an agent whose session is STILL ALIVE (task
   * terminal in store but the session lives on — the reaper's "leak class 2",
   * or a session deliberately spared by `KOOKR_REAP_ORPHAN_SESSIONS=false`)
   * must never be swept, or its monitoring goes permanently dark until the
   * next {@link registerAgent}. The session reaper passes its live-session
   * list here.
   *
   * Returns the number of agents unregistered.
   */
  sweepAgedTerminalAgents(cutoffMs: number, opts?: { skipSessionIds?: ReadonlySet<string> }): number {
    // Invert ownership once (O(tasks + agents)) instead of a per-agent
    // findTaskBySession scan. viewTasks is the non-cloning read view — this
    // method reads-and-drops synchronously.
    const ownerBySession = new Map<string, Task>();
    for (const task of this.taskStore.viewTasks()) {
      for (const session of task.sessions) ownerBySession.set(session.tmuxSession, task);
    }
    let swept = 0;
    for (const agentId of [...this.agentEvents.keys()]) {
      if (opts?.skipSessionIds?.has(agentId)) continue;
      const owner = ownerBySession.get(agentId);
      if (owner && isAgedTerminalTask(owner, cutoffMs)) {
        this.unregisterAgent(agentId);
        swept++;
      }
    }
    return swept;
  }

  /**
   * Unregister every agent whose session is owned by NO task in the store AND
   * is not currently live, once it has been unowned longer than `graceMs`
   * (issue #1763). This is the residual leak that {@link sweepAgedTerminalAgents}
   * cannot reach: that sweep only touches agents whose owning task is terminal
   * and aged, but startup hook replay re-registers an entry for every historical
   * session — including sessions whose task was already deleted
   * ({@link TaskStore.deleteTask}/`pruneAgedTaskRecords` unregister only a
   * deleted task's OWN sessions from the monitor, not these orphans). Left
   * unswept, each unowned entry (a) leaks per-agent retention for the life of
   * the process, and (b) is pushed un-enriched by `buildSnapshotProjection`
   * (no `sessionIndex` meta ⇒ a `taskId`-less "ghost" agent card, the exact
   * shape #1760 eliminated for the aged-terminal cause).
   *
   * Two guards keep this from racing a session's own creation:
   *  - `liveSessionIds`: a session still live in the backend is NEVER swept.
   *    A brand-new session is registered in the monitor before its task record
   *    lands but is live in tmux, so it is skipped until ownership catches up.
   *    A live orphan deliberately spared by `KOOKR_REAP_ORPHAN_SESSIONS=false`
   *    is likewise never darkened.
   *  - `graceMs`: an agent must have been *continuously* unowned AND dead for
   *    at least this long before it is swept. {@link registerAgent} creates an
   *    empty-window entry, so "no events yet" is not a reliable staleness
   *    signal — the grace clock ({@link agentFirstUnownedDeadAt}) is tracked
   *    explicitly and reset the moment the agent regains an owner OR its
   *    session is seen live again. Resetting on liveness (not just ownership)
   *    is what makes the sweep robust to a transient `listSessions()` omission:
   *    a single tick where a still-live orphan drops out of the backend
   *    enumeration cannot elapse the grace period, so it takes `graceMs` of
   *    sustained absence — not one flake — to sweep.
   *
   * Sweeping is TERMINAL (via {@link unregisterAgent} → `stoppedAgents`), which
   * is safe here precisely because the session is both unowned and dead: no
   * legitimate future events exist, and a reused session id is resurrected by
   * {@link registerAgent}. Returns the number of agents unregistered.
   */
  sweepUnownedDeadAgents(opts: {
    liveSessionIds: ReadonlySet<string>;
    graceMs: number;
    now?: number;
  }): number {
    const now = opts.now ?? Date.now();
    // Every session id referenced by ANY task, regardless of task status — an
    // agent id absent from this set has no owning task. Non-cloning read view.
    const ownedSessionIds = new Set<string>();
    for (const task of this.taskStore.viewTasks()) {
      for (const session of task.sessions) ownedSessionIds.add(session.tmuxSession);
    }
    let swept = 0;
    for (const agentId of [...this.agentEvents.keys()]) {
      // Only accumulate grace while the agent is BOTH unowned AND dead. Any
      // tick where it is owned or its session is live resets the clock, so the
      // grace period measures *continuous* sweepable time — a brand-new
      // session still registering, or a live orphan that flickers out of one
      // `listSessions()` snapshot, never banks toward the sweep.
      const sweepable = !ownedSessionIds.has(agentId) && !opts.liveSessionIds.has(agentId);
      if (!sweepable) {
        this.agentFirstUnownedDeadAt.delete(agentId);
        continue;
      }
      const firstUnownedDeadAt = this.agentFirstUnownedDeadAt.get(agentId) ?? now;
      if (!this.agentFirstUnownedDeadAt.has(agentId)) {
        this.agentFirstUnownedDeadAt.set(agentId, now);
      }
      if (now - firstUnownedDeadAt >= opts.graceMs) {
        this.unregisterAgent(agentId);
        swept++;
      }
    }
    return swept;
  }

  /**
   * Combined stale-Monitor-state sweep for the session reaper (issues #1761 +
   * #1763): unregisters agents of aged terminal tasks AND agents whose session
   * is owned by no task and not live, returning the summed count. The two
   * populations are disjoint (an owned agent is never touched by the unowned
   * sweep), so the sum is an exact unregister count. `agedTerminalCutoffMs` is
   * precomputed by the caller (`now - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS`) so
   * core stays free of the server-layer snapshot constant. Live sessions are
   * excluded from both classes.
   */
  sweepStaleAgents(opts: {
    liveSessionIds: ReadonlySet<string>;
    agedTerminalCutoffMs: number;
    unownedGraceMs: number;
    now?: number;
  }): number {
    return (
      this.sweepAgedTerminalAgents(opts.agedTerminalCutoffMs, { skipSessionIds: opts.liveSessionIds })
      + this.sweepUnownedDeadAgents({
        liveSessionIds: opts.liveSessionIds,
        graceMs: opts.unownedGraceMs,
        now: opts.now,
      })
    );
  }

  unregisterAgent(agentId: string): void {
    this.agentEvents.delete(agentId);
    this.agentFirstUnownedDeadAt.delete(agentId);
    this._eventCounts.delete(agentId);
    this.lastRecordedAnomalyFingerprint.delete(agentId);
    this.lastEventAnomaly.delete(agentId);
    this.systemicHookStall.clear(agentId);
    this.watchdogVerdictStreak.delete(agentId);
    this.findingEvidenceAuditor.deleteAgent(agentId);
    this.agentTranscriptPaths.delete(agentId);
    this.attentionQueue.purge(agentId);
    this.flushAndDeleteSubagents(agentId);
    // Per-agent retention that no other path cleans up (issue #1612): both are
    // only ever read for the same agentId, so dropping them at teardown cannot
    // affect any surviving agent's projection.
    this.suppressedCompletionSignalIds.delete(agentId);
    this.ttlEvictedSubagentEventCounts.delete(agentId);
    this.addStoppedAgent(agentId);
  }

  /**
   * Tombstone an agent id, keeping {@link stoppedAgents} bounded as a FIFO with
   * oldest-first eviction (see {@link MONITOR_STOPPED_AGENTS_MAX}). Re-adding an
   * id that is already present is a no-op for ordering (Set semantics), which is
   * fine: agent ids are unique per launch, so this only matters for a repeated
   * unregister of the same id and does not disturb the eviction window.
   */
  private addStoppedAgent(agentId: string): void {
    this.stoppedAgents.add(agentId);
    while (this.stoppedAgents.size > MONITOR_STOPPED_AGENTS_MAX) {
      const oldest = this.stoppedAgents.keys().next().value;
      if (oldest === undefined) break;
      this.stoppedAgents.delete(oldest);
    }
  }

  private stabilizeEventAnomaly(
    agentId: string,
    anomaly: Anomaly | null,
    eventId?: string,
  ): Anomaly | null {
    if (!anomaly) {
      this.lastEventAnomaly.delete(agentId);
      return null;
    }
    // Stamp the triggering event's correlation id (#705) before stabilizing.
    // withStableEventDetectedAt keeps the FIRST occurrence's id for a persisting
    // finding (same fingerprint), so the lineage id points at the event that
    // originally raised the finding and is stable across replay/reconnect.
    const stamped = eventId !== undefined ? { ...anomaly, eventId } : anomaly;
    const stable = this.withStableEventDetectedAt(agentId, stamped);
    this.lastEventAnomaly.set(agentId, stable);
    return stable;
  }

  private rememberTranscriptPath(agentId: string, events: AgentEvent[]): void {
    for (const event of events) {
      if (
        (event.type === 'session_start' || event.type === 'stop' || event.type === 'stop_failure')
        && event.transcriptPath
      ) {
        this.agentTranscriptPaths.set(agentId, event.transcriptPath);
      }
    }
  }

  private withTranscriptContext(anomaly: Anomaly | null, agentId: string): Anomaly | null {
    if (!anomaly) return null;
    if (!findingTranscriptContextEnabled()) return anomaly;
    if (anomaly.type !== 'needs_input' && anomaly.type !== 'stale_agent') return anomaly;
    if (anomaly.transcriptContext?.lastAssistantMessage) return anomaly;

    const transcriptPath = this.agentTranscriptPaths.get(agentId);
    if (!transcriptPath) return anomaly;

    const message = lastAssistantMessage(transcriptPath);
    if (!message) return anomaly;

    return {
      ...anomaly,
      transcriptContext: {
        lastAssistantMessage: message,
      },
    };
  }

  private withStableEventDetectedAt(agentId: string, anomaly: Anomaly): Anomaly {
    const previous = this.lastEventAnomaly.get(agentId);
    if (!previous || anomalyFingerprint(previous) !== anomalyFingerprint(anomaly)) return anomaly;
    // Preserve both the first-seen detectedAt and the first-seen correlation id
    // (#705) so a finding that persists across snapshot/read ticks keeps a
    // stable lineage id even though those read paths don't carry a fresh one.
    return {
      ...anomaly,
      detectedAt: previous.detectedAt,
      ...(previous.eventId !== undefined ? { eventId: previous.eventId } : {}),
    };
  }

  // Event-path detection telemetry. The watchdog path records its own
  // check/fire counts inline in applyWatchdogVerdict (it dedups fires on a
  // queue-transition fingerprint rather than this method's
  // lastRecordedAnomalyFingerprint), so the two idioms are intentional, not drift.
  private recordDetectionTelemetry(
    agentId: string,
    checkedTypes: AnomalyType[],
    anomaly: Anomaly | null,
  ): void {
    for (const type of checkedTypes) {
      recordDetectionCheck(type);
    }

    if (!anomaly) {
      this.lastRecordedAnomalyFingerprint.delete(agentId);
      return;
    }

    const fingerprint = anomalyFingerprint(anomaly);
    if (this.lastRecordedAnomalyFingerprint.get(agentId) === fingerprint) return;

    recordDetectionFire(anomaly.type);
    this.lastRecordedAnomalyFingerprint.set(agentId, fingerprint);
  }

  /**
   * Forward one event into the outstanding-subagent tracker. session_end flushes
   * via {@link flushAndDeleteSubagents} so orphan telemetry stays on the Monitor
   * write path; start/stop/zero-background Stop live in the tracker.
   */
  private updateSubagentTracking(agentId: string, event: AgentEvent): void {
    if (event.type === 'session_end') {
      this.flushAndDeleteSubagents(agentId);
      return;
    }
    this.outstandingSubagents.updateFromEvent(agentId, event);
  }

  /**
   * Drop the outstanding-subagent map for an agent. If non-empty, increment the
   * orphan counter (these are subagents whose SubagentStop never arrived). Single
   * idempotent helper so the dual cleanup paths (session_end and unregisterAgent)
   * cannot double-count.
   */
  private flushAndDeleteSubagents(agentId: string): void {
    const orphanCount = this.outstandingSubagents.flush(agentId);
    if (orphanCount > 0) {
      recordSubagentOrphans(orphanCount, 1);
    }
  }

  /**
   * Drop subagent entries older than the tracker TTL. Caps suppression duration
   * when SubagentStop is lost (SIGKILL, watcher drop). Returns surviving size.
   *
   * Eviction is lazy: it only runs when suppressIfSubagentsRunning is called.
   * Telemetry and snapshot TTL-eviction markers stay on Monitor; the tracker is
   * pure map mutation.
   */
  private evictStaleSubagents(
    agentId: string,
    now: number,
    options: { markSnapshotTtlEviction?: boolean } = {},
  ): number {
    const { remaining, evicted } = this.outstandingSubagents.evictStale(agentId, now);
    if (evicted > 0) {
      recordSubagentTtlEviction(evicted);
      if (options.markSnapshotTtlEviction ?? true) {
        this.ttlEvictedSubagentEventCounts.set(agentId, this._eventCounts.get(agentId) ?? 0);
      }
    }
    return remaining;
  }

  /**
   * Suppress watchdog-routed anomaly types when one or more background subagents
   * are still running for the agent. Policy lives in
   * {@link OutstandingSubagentTracker.suppressIfRunning}; this wrapper records
   * TTL telemetry / snapshot markers and remains free of recordSuppression so
   * it can be called from both write and read paths.
   */
  private suppressIfSubagentsRunning(
    anomaly: Anomaly | null,
    agentId: string,
    options: { markSnapshotTtlEviction?: boolean } = {},
  ): Anomaly | null {
    const result = this.outstandingSubagents.suppressIfRunning(anomaly, agentId, Date.now());
    if (result.evicted > 0) {
      recordSubagentTtlEviction(result.evicted);
      if (options.markSnapshotTtlEviction ?? true) {
        this.ttlEvictedSubagentEventCounts.set(agentId, this._eventCounts.get(agentId) ?? 0);
      }
    }
    return result.anomaly;
  }

  /**
   * Advance the agent's consecutive same-type actionable verdict streak and
   * return the new count. A verdict of a different type restarts the streak
   * at 1; non-actionable verdicts delete the entry (see applyWatchdogVerdict).
   */
  private bumpWatchdogStreak(agentId: string, type: string): number {
    const prev = this.watchdogVerdictStreak.get(agentId);
    const count = prev && prev.type === type ? prev.count + 1 : 1;
    this.watchdogVerdictStreak.set(agentId, { type, count });
    return count;
  }

  /**
   * Purge every *sibling* queued `hook_disconnected` finding (systemic-stall
   * cleanup) and resolve each with a matching {@link SYSTEMIC_HOOK_STALL_REASON}
   * audit record so no agent's finding vanishes silently from the review
   * pipeline. The candidate (caller's agent) is purged too — its own resolution
   * record is emitted by the caller — so a re-firing candidate is not
   * double-counted. Side-effectful queue/audit work stays on Monitor; the pure
   * suppress decision lives in {@link SystemicHookStallTracker}.
   */
  private purgeSystemicHookStallSiblings(candidateAgentId: string, paneText?: string): void {
    for (const { agentId, anomaly } of this.attentionQueue.inspectActive()) {
      if (anomaly.type !== 'hook_disconnected') continue;
      this.attentionQueue.purge(agentId);
      if (agentId === candidateAgentId) continue;
      this.findingEvidenceAuditor.observe(agentId, null, this.agentEvents.get(agentId) ?? [], {
        source: 'watchdog_tick',
        paneText,
        suppressionReason: SYSTEMIC_HOOK_STALL_REASON,
      });
    }
  }

  /**
   * Derive the agent's current turn state for the snapshot.
   *
   * A parent agent that emitted `Stop` while a background subagent is still
   * running has not really finished its turn — work is ongoing — so report
   * `running` instead of `completed_turn`. This mirrors the needs_input
   * suppression in {@link suppressIfSubagentsRunning} so the turn-state badge
   * and the anomaly state stay consistent.
   */
  private deriveTurnStateForSnapshot(agentId: string, events: AgentEvent[]): TurnState {
    const turnState = deriveTurnState(events);
    const outstandingBeforeEviction = this.outstandingSubagents.size(agentId);
    const remainingAfterEviction = this.evictStaleSubagents(agentId, Date.now());
    if (turnState === 'completed_turn' && remainingAfterEviction > 0) {
      return 'running';
    }
    const latestCompletionSignal = turnState === 'completed_turn'
      ? this.deriveLatestCompletionSignalForAgent(agentId, events)
      : undefined;
    const ttlEvictedAtEventCount = this.ttlEvictedSubagentEventCounts.get(agentId);
    this.ttlEvictedSubagentEventCounts.delete(agentId);
    const ttlEvictedBeforeProjection = ttlEvictedAtEventCount === (this._eventCounts.get(agentId) ?? 0);
    if (
      turnState === 'completed_turn'
      && (outstandingBeforeEviction > 0 || ttlEvictedBeforeProjection)
      && remainingAfterEviction === 0
    ) {
      if (latestCompletionSignal) this.rememberSuppressedCompletionSignal(agentId, latestCompletionSignal.id);
      return 'running';
    }
    if (
      turnState === 'completed_turn'
      && latestCompletionSignal
      && this.isSuppressedCompletionSignal(agentId, latestCompletionSignal.id)
    ) {
      return 'running';
    }
    return turnState;
  }

  private deriveLatestCompletionSignalForAgent(agentId: string, events: AgentEvent[]): LatestCompletionSignal | undefined {
    return deriveLatestCompletionSignal({
      taskId: this.taskStore.findTaskBySession(agentId)?.id ?? agentId,
      agentId,
      taskStatus: 'inProgress',
      events,
    });
  }

  private shouldSuppressSnapshotNeedsInput(agentId: string, events: AgentEvent[], anomaly: Anomaly | null): boolean {
    if (anomaly?.type !== 'needs_input') return false;
    const latestCompletionSignal = this.deriveLatestCompletionSignalForAgent(agentId, events);
    return latestCompletionSignal !== undefined
      && this.isSuppressedCompletionSignal(agentId, latestCompletionSignal.id);
  }

  private rememberSuppressedCompletionSignal(agentId: string, signalId: string): void {
    let ids = this.suppressedCompletionSignalIds.get(agentId);
    if (!ids) {
      ids = new Set();
      this.suppressedCompletionSignalIds.set(agentId, ids);
    }
    ids.add(signalId);
    // Bound the set: evict oldest ids (Set preserves insertion order) so a
    // long-lived agent cannot accumulate them without limit (issue #1612).
    while (ids.size > MAX_SUPPRESSED_COMPLETION_SIGNAL_IDS) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
  }

  private isSuppressedCompletionSignal(agentId: string, signalId: string): boolean {
    return this.suppressedCompletionSignalIds.get(agentId)?.has(signalId) ?? false;
  }

  private buildAgentState(agentId: string, events: AgentEvent[]): MonitorAgentState {
    const turnState = this.deriveTurnStateForSnapshot(agentId, events);
    const currentAnomaly = this.getCurrentAnomaly(agentId);
    const anomaly = this.shouldSuppressSnapshotNeedsInput(agentId, events, currentAnomaly)
      ? null
      : currentAnomaly;
    const state: MonitorAgentState = {
      agentId,
      events,
      anomaly,
      turnState,
      lastEventSeq: events.at(-1)?.eventSeq ?? 0,
    };
    const sessionHealth = this.sessionHealthProvider?.(agentId, turnState);
    if (sessionHealth) state.sessionHealth = sessionHealth;
    const findingEvidenceAudit = this.findingEvidenceAuditor.getActiveRecord(agentId);
    if (findingEvidenceAudit) state.findingEvidenceAudit = findingEvidenceAudit;

    // Mark snoozed agents so the frontend can filter them from findings
    const snoozedUntil = this.attentionQueue.getSnoozedUntil(agentId);
    if (snoozedUntil !== null) {
      state.snoozedUntil = snoozedUntil;
    }

    // Mark suppressed agents — hidden when an active non-liveness finding exists
    if (this.suppressionTracker?.isSuppressed(agentId)) {
      const hasActiveNonLiveness = anomaly !== null
        && anomaly.type !== 'stale_agent'
        && anomaly.type !== 'hook_disconnected';
      if (!hasActiveNonLiveness) {
        state.suppressed = true;
      }
    }

    return state;
  }

  /**
   * Get raw live monitor state for one known agent.
   *
   * Preserves `getSnapshot().find(...)` semantics for missing agents by
   * returning undefined when the agent has no live event window.
   */
  getAgentState(agentId: string): MonitorAgentState | undefined {
    const events = this.agentEvents.get(agentId);
    if (events === undefined) return undefined;
    return this.buildAgentState(agentId, events);
  }

  /**
   * Return the live turn state without building a MonitorAgentState. Server-side
   * diagnostics use this to keep REST projections aligned with WebSocket
   * snapshots without recursively asking the health provider for a snapshot.
   */
  getLiveTurnState(agentId: string): TurnState | undefined {
    const events = this.agentEvents.get(agentId);
    if (events === undefined) return undefined;
    return this.deriveTurnStateForSnapshot(agentId, events);
  }

  /**
   * Get raw live monitor state for all known agents.
   *
   * This is intentionally limited to event/anomaly/queue-derived state. The
   * server snapshot use case owns task metadata enrichment and synthetic
   * pending/terminal entries.
   */
  getSnapshot(): MonitorAgentState[] {
    const states: MonitorAgentState[] = [];
    for (const [agentId, events] of this.agentEvents) {
      states.push(this.buildAgentState(agentId, events));
    }
    return states;
  }
}
