import type { AgentActivityMeta, AgentEvent, Anomaly, AnomalyType, TokenUsage, TurnState, WorktreeHealth } from './types.js';
import type { CompletionDigest } from './completion-digest.js';
import type { TaskDependencyEdge, TaskLaunchPermissionPosture } from '../shared/contracts/task.js';
import type { Task, TaskLaunchHealthSummary, TaskStore } from './tasks.js';
import type { UserInputDeliverySnapshot } from '../shared/contracts/user-input-delivery.js';
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
import { lastAssistantMessage } from './transcript-parser.js';

export interface AgentState {
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
}

const DEFAULT_WINDOW_SIZE = 50;

/**
 * Time after which an outstanding subagent entry is considered stale and dropped.
 * Caps the duration of needs_input suppression when a SubagentStop event is lost
 * (process SIGKILL, watcher drop, etc). 30 minutes is ~3× the longest legitimate
 * background subagent observed in production hook logs at design time.
 */
const SUBAGENT_TTL_MS = 30 * 60 * 1000;

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
 * Minimum number of distinct agents producing `hook_disconnected` verdicts
 * within {@link SYSTEMIC_HOOK_STALL_WINDOW_MS} for the monitor to treat the
 * silence as a systemic hook-pipeline stall (server restart, relay backlog,
 * a CLI that stopped emitting hooks) rather than a per-agent fault.
 *
 * When the hook pipeline stalls globally, every active agent goes hook-silent
 * within a tick or two, so minting one finding per agent is pure noise — a
 * single infra event surfaces as N false positives. Field data showed two
 * distinct agents flagged `hook_disconnected` 17s apart, both ~200s silent;
 * the user flagged both as false positives. At or above this count the
 * per-agent findings are suppressed and any already-queued ones are purged.
 *
 * The signal counts recent *verdicts*, not currently-queued entries. Counting
 * queued entries oscillated: the guard purged the queue, which reset the
 * count below threshold, which re-admitted the next agent's finding ~1s
 * later — an endless admit→purge limit cycle that surfaced a rotating
 * one-second finding (and dashboard chime) for every hook-silent agent.
 */
const SYSTEMIC_HOOK_STALL_MIN_AGENTS = 2;

/**
 * How long a `hook_disconnected` verdict keeps counting toward the systemic
 * hook-stall signal. Must span several watchdog ticks (5s in production) so
 * agents whose verdicts alternate between `hook_disconnected` and
 * `stale_agent` (pane sometimes frozen) stay counted while the stall lasts.
 */
const SYSTEMIC_HOOK_STALL_WINDOW_MS = 60_000;

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
  private windowSize: number;
  /** Monotonic per-agent event counts for self-diagnostic rate checks. */
  private _eventCounts = new Map<string, number>();
  private lastRecordedAnomalyFingerprint = new Map<string, string>();
  private lastEventAnomaly = new Map<string, Anomaly>();
  /**
   * Last time each agent produced a `hook_disconnected` watchdog verdict
   * (raw, pre-suppression). Entries older than
   * {@link SYSTEMIC_HOOK_STALL_WINDOW_MS} are pruned lazily on read.
   */
  private hookDisconnectedVerdictAt = new Map<string, number>();
  /**
   * Consecutive actionable watchdog verdicts of the same type, per agent.
   * Reset by any non-actionable verdict. Drives the
   * {@link WATCHDOG_DEBOUNCE_TYPES} flicker debounce.
   */
  private watchdogVerdictStreak = new Map<string, { type: string; count: number }>();
  private findingEvidenceAuditor = new FindingEvidenceAuditor();
  private agentTranscriptPaths = new Map<string, string>();
  /**
   * Outstanding background subagents per parent agent. Each subagent tracked with
   * its Date.now() at SubagentStart so a lazy TTL eviction caps suppression
   * duration when the matching SubagentStop is lost.
   * Outer key: parent agentId (tmux session name). Inner key: subagentId from the hook.
   */
  private outstandingSubagents = new Map<string, Map<string, number>>();
  /** Completion signal ids suppressed because the parent Stop was stale behind TTL-evicted subagents. */
  private suppressedCompletionSignalIds = new Map<string, Set<string>>();
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
        this.hookDisconnectedVerdictAt.set(agentId, Date.now());
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
      if (
        anomaly.type === 'hook_disconnected'
        && this.countRecentHookDisconnectedVerdicts() >= SYSTEMIC_HOOK_STALL_MIN_AGENTS
      ) {
        recordSuppression('hook_disconnected', 'systemic_hook_stall');
        const events = this.agentEvents.get(agentId) ?? [];
        this.findingEvidenceAuditor.observe(agentId, anomaly, events, {
          source: 'watchdog_tick',
          paneText: options.paneText,
        });
        this.findingEvidenceAuditor.observe(agentId, null, events, {
          source: 'watchdog_tick',
          paneText: options.paneText,
          suppressionReason: 'systemic_hook_stall',
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
   */
  isPermissionBlocked(agentId: string): boolean {
    const events = this.agentEvents.get(agentId);
    if (!events || events.length === 0) return false;
    return events[events.length - 1].type === 'permission_request';
  }

  /**
   * Get all agent IDs that currently have a permission_blocked finding.
   */
  getPermissionBlockedAgents(): string[] {
    const blocked: string[] = [];
    for (const [agentId, events] of this.agentEvents) {
      if (this.stoppedAgents.has(agentId)) continue;
      if (events.length > 0 && events[events.length - 1].type === 'permission_request') {
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
   * Expose raw task records for server-side snapshot projection.
   * Monitor deliberately does not turn these into dashboard AgentState entries.
   */
  getTaskSnapshot(): Task[] {
    return this.taskStore.getAllTasks();
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
  unregisterAgent(agentId: string): void {
    this.agentEvents.delete(agentId);
    this._eventCounts.delete(agentId);
    this.lastRecordedAnomalyFingerprint.delete(agentId);
    this.lastEventAnomaly.delete(agentId);
    this.hookDisconnectedVerdictAt.delete(agentId);
    this.watchdogVerdictStreak.delete(agentId);
    this.findingEvidenceAuditor.deleteAgent(agentId);
    this.agentTranscriptPaths.delete(agentId);
    this.attentionQueue.purge(agentId);
    this.flushAndDeleteSubagents(agentId);
    this.stoppedAgents.add(agentId);
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
   * Update outstanding-subagent tracking for one event. SubagentStart adds the
   * subagentId with a Date.now() timestamp; SubagentStop removes it; session_end
   * flushes the map for the agent and emits the orphan metric if non-empty. A
   * Stop hook with explicit zero active background tasks/crons is authoritative
   * provider evidence that no subordinate work remains, so it clears stale
   * entries without counting them as orphans.
   */
  private updateSubagentTracking(agentId: string, event: AgentEvent): void {
    if (event.type === 'subagent_start' && event.agentId) {
      let map = this.outstandingSubagents.get(agentId);
      if (!map) {
        map = new Map();
        this.outstandingSubagents.set(agentId, map);
      }
      map.set(event.agentId, Date.now());
    } else if (event.type === 'subagent_stop' && event.agentId) {
      this.outstandingSubagents.get(agentId)?.delete(event.agentId);
    } else if (
      event.type === 'stop'
      && event.activeBackgroundTaskCount === 0
      && event.activeSessionCronCount === 0
    ) {
      this.outstandingSubagents.delete(agentId);
    } else if (event.type === 'session_end') {
      this.flushAndDeleteSubagents(agentId);
    }
  }

  /**
   * Drop the outstanding-subagent map for an agent. If non-empty, increment the
   * orphan counter (these are subagents whose SubagentStop never arrived). Single
   * idempotent helper so the dual cleanup paths (session_end and unregisterAgent)
   * cannot double-count.
   */
  private flushAndDeleteSubagents(agentId: string): void {
    const map = this.outstandingSubagents.get(agentId);
    if (map && map.size > 0) {
      recordSubagentOrphans(map.size, 1);
    }
    this.outstandingSubagents.delete(agentId);
  }

  /**
   * Drop subagent entries older than SUBAGENT_TTL_MS. Caps suppression duration
   * when SubagentStop is lost (SIGKILL, watcher drop). Returns surviving size.
   *
   * Eviction is lazy: it only runs when suppressIfSubagentsRunning is called.
   * If the parent agent emits no further events that trigger anomaly detection,
   * stale entries persist until session_end or unregisterAgent. Acceptable —
   * memory is bounded by SubagentStart count, and session teardown always clears.
   */
  private evictStaleSubagents(
    agentId: string,
    now: number,
    options: { markSnapshotTtlEviction?: boolean } = {},
  ): number {
    const map = this.outstandingSubagents.get(agentId);
    if (!map) return 0;
    let evicted = 0;
    for (const [subagentId, startedAt] of map) {
      if (now - startedAt > SUBAGENT_TTL_MS) {
        map.delete(subagentId);
        evicted++;
      }
    }
    if (evicted > 0) {
      recordSubagentTtlEviction(evicted);
      if (options.markSnapshotTtlEviction ?? true) {
        this.ttlEvictedSubagentEventCounts.set(agentId, this._eventCounts.get(agentId) ?? 0);
      }
    }
    return map.size;
  }

  /**
   * Suppress watchdog-routed anomaly types when one or more background subagents
   * are still running for the agent. Other anomaly types pass through unchanged.
   *
   * Three types are eligible: `needs_input`, `stale_agent`, `hook_disconnected`.
   *
   * - `needs_input`: the parent's Stop hook fires whenever its turn ends, including
   *   while waiting on a `run_in_background` subagent. See rfc-subagent-aware-needs-input.md.
   * - `stale_agent` / `hook_disconnected`: while a background subagent is doing the
   *   work, the parent emits no hook events for minutes and its pane may not change
   *   meaningfully — the watchdog tick would otherwise mint a false-positive finding.
   *   See rfc-supervisor-stale-agent-false-positives.md.
   *
   * `permission_blocked` is deliberately excluded — a parent blocked on permission
   * is genuinely blocked regardless of subagent state.
   *
   * This helper is side-effect free w.r.t. recordSuppression so it can be safely
   * called from both write (processEvents, applyWatchdogVerdict) and read
   * (getEventAnomaly) paths. The write paths increment the counter.
   */
  private suppressIfSubagentsRunning(
    anomaly: Anomaly | null,
    agentId: string,
    options: { markSnapshotTtlEviction?: boolean } = {},
  ): Anomaly | null {
    if (!anomaly) return anomaly;
    if (
      anomaly.type !== 'needs_input'
      && anomaly.type !== 'stale_agent'
      && anomaly.type !== 'hook_disconnected'
    ) {
      return anomaly;
    }
    const remaining = this.evictStaleSubagents(agentId, Date.now(), options);
    return remaining > 0 ? null : anomaly;
  }

  /**
   * Count distinct agents that produced a `hook_disconnected` watchdog
   * verdict within the last {@link SYSTEMIC_HOOK_STALL_WINDOW_MS}. Prunes
   * expired entries as it goes. Unlike the former queue-based count, this
   * signal is unaffected by the systemic purge, so it cannot oscillate.
   */
  private countRecentHookDisconnectedVerdicts(now = Date.now()): number {
    let count = 0;
    for (const [agentId, verdictAt] of this.hookDisconnectedVerdictAt) {
      if (now - verdictAt > SYSTEMIC_HOOK_STALL_WINDOW_MS) {
        this.hookDisconnectedVerdictAt.delete(agentId);
        continue;
      }
      count += 1;
    }
    return count;
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
   * cleanup) and resolve each with a matching `systemic_hook_stall` audit
   * record so no agent's finding vanishes silently from the review pipeline.
   * The candidate (caller's agent) is purged too — its own resolution record
   * is emitted by the caller — so a re-firing candidate is not double-counted.
   */
  private purgeSystemicHookStallSiblings(candidateAgentId: string, paneText?: string): void {
    for (const { agentId, anomaly } of this.attentionQueue.inspectActive()) {
      if (anomaly.type !== 'hook_disconnected') continue;
      this.attentionQueue.purge(agentId);
      if (agentId === candidateAgentId) continue;
      this.findingEvidenceAuditor.observe(agentId, null, this.agentEvents.get(agentId) ?? [], {
        source: 'watchdog_tick',
        paneText,
        suppressionReason: 'systemic_hook_stall',
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
    const outstandingBeforeEviction = this.outstandingSubagents.get(agentId)?.size ?? 0;
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
  }

  private isSuppressedCompletionSignal(agentId: string, signalId: string): boolean {
    return this.suppressedCompletionSignalIds.get(agentId)?.has(signalId) ?? false;
  }

  /**
   * Get raw live monitor state for all known agents.
   *
   * This is intentionally limited to event/anomaly/queue-derived state. The
   * server snapshot use case owns task metadata enrichment and synthetic
   * pending/terminal entries.
   */
  getSnapshot(): AgentState[] {
    const states: AgentState[] = [];
    for (const [agentId, events] of this.agentEvents) {
      const turnState = this.deriveTurnStateForSnapshot(agentId, events);
      const currentAnomaly = this.getCurrentAnomaly(agentId);
      const anomaly = this.shouldSuppressSnapshotNeedsInput(agentId, events, currentAnomaly)
        ? null
        : currentAnomaly;
      const state: AgentState = {
        agentId,
        events,
        anomaly,
        turnState,
        lastEventSeq: events.at(-1)?.eventSeq ?? 0,
      };
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

      states.push(state);
    }
    return states;
  }
}
