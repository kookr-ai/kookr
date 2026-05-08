import type { AgentEvent, Anomaly, AnomalyType, TokenUsage, WorktreeHealth } from './types.js';
import type { CompletionDigest } from './completion-digest.js';
import type { TaskStore } from './tasks.js';
import type { AttentionQueue } from './attention-queue.js';
import type { SnoozeSuppressionTracker } from './snooze-suppression.js';
import type { WatchdogVerdict } from './watchdog.js';
import { detectAnomalies, evaluateAnomalies } from './anomaly-detector.js';
import { projectDisplayLabel } from './project-identity.js';
import {
  recordDetectionCheck,
  recordDetectionFire,
  recordSubagentOrphans,
  recordSubagentTtlEviction,
  recordSuppression,
  type AnomalyDetectorConfig,
} from './detection-stats.js';

export interface AgentState {
  agentId: string;
  events: AgentEvent[];
  anomaly: Anomaly | null;
  snoozedUntil?: number; // ms since epoch — set when agent is snoozed in the attention queue
  suppressed?: boolean; // true when auto-suppressed due to repeated liveness snoozes
  taskId?: string;
  taskName?: string;
  taskStatus?: import('./types.js').TaskStatus;
  description?: string; // full task prompt, shown on hover
  cwd?: string;
  agentType?: import('../core/agent-types.js').AgentType;
  startedAt?: string; // ISO 8601
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
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
  autonomy?: import('./tasks.js').AutonomyLevel;
  ralphLoop?: import('./tasks.js').RalphLoopState;
}

const DEFAULT_WINDOW_SIZE = 50;

/**
 * Time after which an outstanding subagent entry is considered stale and dropped.
 * Caps the duration of needs_input suppression when a SubagentStop event is lost
 * (process SIGKILL, watcher drop, etc). 30 minutes is ~3× the longest legitimate
 * background subagent observed in production hook logs at design time.
 */
const SUBAGENT_TTL_MS = 30 * 60 * 1000;

function anomalyFingerprint(anomaly: Anomaly): string {
  return `${anomaly.type}:${anomaly.subType ?? ''}:${anomaly.explanation}`;
}

export class Monitor {
  private agentEvents = new Map<string, AgentEvent[]>();
  private stoppedAgents = new Set<string>();
  private windowSize: number;
  /** Monotonic per-agent event counts for self-diagnostic rate checks. */
  private _eventCounts = new Map<string, number>();
  private lastRecordedAnomalyFingerprint = new Map<string, string>();
  /**
   * Outstanding background subagents per parent agent. Each subagent tracked with
   * its Date.now() at SubagentStart so a lazy TTL eviction caps suppression
   * duration when the matching SubagentStop is lost.
   * Outer key: parent agentId (tmux session name). Inner key: subagentId from the hook.
   */
  private outstandingSubagents = new Map<string, Map<string, number>>();

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
  processEvents(agentId: string, events: AgentEvent[]): void {
    // Guard: reject events for explicitly stopped agents (prevents hook watcher race)
    if (this.stoppedAgents.has(agentId)) return;

    // Increment monotonic event counter for self-diagnostic
    this._eventCounts.set(agentId, (this._eventCounts.get(agentId) ?? 0) + events.length);

    // Append to existing events, capped at windowSize
    const existing = this.agentEvents.get(agentId) ?? [];
    const combined = [...existing, ...events];
    const capped = combined.length > this.windowSize
      ? combined.slice(combined.length - this.windowSize)
      : combined;
    this.agentEvents.set(agentId, capped);

    // Update subagent tracking before detection so suppression sees current state
    for (const event of events) {
      this.updateSubagentTracking(agentId, event);
    }

    // Run anomaly detection, then apply subagent-aware suppression.
    // recordSuppression fires only here (the write path), not inside the helper —
    // getEventAnomaly is read by snapshot/timer paths and would otherwise inflate
    // the counter once per snapshot tick instead of once per suppressed Stop.
    const evaluation = evaluateAnomalies(capped, agentId, this.anomalyConfig);
    const rawAnomaly = evaluation.anomaly;
    const anomaly = this.suppressIfSubagentsRunning(rawAnomaly, agentId);
    this.recordDetectionTelemetry(agentId, evaluation.checkedTypes, anomaly);
    if (rawAnomaly?.type === 'needs_input' && anomaly === null) {
      recordSuppression('needs_input');
    }

    if (anomaly) {
      this.attentionQueue.enqueue(agentId, anomaly);
    } else {
      // No anomaly — remove from queue if present
      this.attentionQueue.remove(agentId);
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
    return this.suppressIfSubagentsRunning(raw, agentId);
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
      if (queued && queued.type === anomaly.type) {
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
    options: { paneCaptureSucceeded: boolean },
  ): boolean {
    const actionable = verdict.status === 'needs_input'
      || verdict.status === 'permission_blocked'
      || verdict.status === 'stale_agent'
      || verdict.status === 'hook_disconnected';

    if (actionable) {
      const anomaly = verdict.anomaly;
      // Suppression tracker opts the agent out of queue entry but the UI still
      // needs to reflect the suppressed state, so report "changed" either way.
      if (this.suppressionTracker?.shouldSuppress(agentId, anomaly.type)) {
        return true;
      }
      this.attentionQueue.enqueue(agentId, anomaly);
      return true;
    }

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

    const isWatchdogOwnedType = queued.type === 'needs_input'
      || queued.type === 'permission_blocked'
      || queued.type === 'stale_agent'
      || queued.type === 'hook_disconnected';
    if (!isWatchdogOwnedType) return false;

    this.attentionQueue.purge(agentId);
    return true;
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

    // Only inject if the agent is actually waiting for input
    const last = events[events.length - 1];
    if (!last) return false;
    const isWaiting = last.type === 'stop'
      || last.type === 'stop_failure'
      || last.type === 'notification'
      || last.type === 'permission_request'
      || (last.type === 'tool_use' && last.toolName === 'AskUserQuestion');
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
    this.attentionQueue.purge(agentId);
    this.flushAndDeleteSubagents(agentId);
    this.stoppedAgents.add(agentId);
  }

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
   * flushes the map for the agent and emits the orphan metric if non-empty.
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
  private evictStaleSubagents(agentId: string, now: number): number {
    const map = this.outstandingSubagents.get(agentId);
    if (!map) return 0;
    let evicted = 0;
    for (const [subagentId, startedAt] of map) {
      if (now - startedAt > SUBAGENT_TTL_MS) {
        map.delete(subagentId);
        evicted++;
      }
    }
    if (evicted > 0) recordSubagentTtlEviction(evicted);
    return map.size;
  }

  /**
   * Suppress needs_input when one or more background subagents are still running
   * for the agent. Other anomaly types pass through unchanged.
   *
   * The parent agent's Stop hook fires whenever its turn ends — including while
   * waiting for a background subagent (Agent tool with run_in_background: true)
   * to complete. Without this gate every such Stop is misclassified as
   * needs_input. See docs/rfc/rfc-subagent-aware-needs-input.md.
   *
   * This helper is side-effect free w.r.t. recordSuppression so it can be safely
   * called from both write (processEvents) and read (getEventAnomaly) paths.
   * The write path increments the counter; the read path does not.
   */
  private suppressIfSubagentsRunning(anomaly: Anomaly | null, agentId: string): Anomaly | null {
    if (anomaly?.type !== 'needs_input') return anomaly;
    const remaining = this.evictStaleSubagents(agentId, Date.now());
    return remaining > 0 ? null : anomaly;
  }

  /**
   * Get current state snapshot for all known agents.
   * Enriches each agent with task metadata when a linked task exists.
   *
   * @internal Prefer `getSnapshotAgentsForClient` (WebSocket / UI) or
   * `getSnapshotAgentsRaw` (debug endpoints, server-internal use) from
   * `src/server/use-cases/get-snapshot.ts`. Direct callers must be listed
   * in the approved-callers CI guard — see
   * `docs/rfc/rfc-snapshot-payload-slimming.md`.
   */
  getSnapshot(): AgentState[] {
    // Build a lookup: tmuxSession → { task, session } for O(1) enrichment
    const sessionIndex = new Map<string, { taskId: string; name?: string; prompt: string; cwd: string; agentType: import('./agent-types.js').AgentType; createdAt: Date; playbookId?: string; playbookParameterValues?: Record<string, string>; projectId?: string; projectDisplayLabel: string; gitBranch?: string; gitCommit?: string; gitIsWorktree?: boolean; worktreeHealth?: WorktreeHealth; worktreeHealthObservedAt?: string; worktreeRegistryStale?: boolean }>();
    for (const task of this.taskStore.getAllTasks()) {
      for (const session of task.sessions) {
        sessionIndex.set(session.tmuxSession, {
          taskId: task.id,
          name: task.name,
          prompt: task.prompt,
          cwd: session.cwd,
          agentType: session.agentType,
          createdAt: session.createdAt,
          playbookId: task.playbookId,
          playbookParameterValues: task.playbookParameterValues,
          projectId: task.projectId,
          projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: session.cwd }),
          gitBranch: session.gitBranch,
          gitCommit: session.gitCommit,
          gitIsWorktree: session.gitIsWorktree,
          worktreeHealth: session.worktreeHealth,
          worktreeHealthObservedAt: session.worktreeHealthObservedAt,
          worktreeRegistryStale: session.worktreeRegistryStale,
        });
      }
    }

    const states: AgentState[] = [];
    for (const [agentId, events] of this.agentEvents) {
      const anomaly = this.getCurrentAnomaly(agentId);
      const state: AgentState = { agentId, events, anomaly };

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

      const meta = sessionIndex.get(agentId);
      if (meta) {
        state.taskId = meta.taskId;
        state.taskName = meta.name ?? truncatePrompt(meta.prompt, 60);
        state.description = meta.prompt;
        state.cwd = meta.cwd;
        state.agentType = meta.agentType;
        state.startedAt = meta.createdAt.toISOString();
        state.playbookId = meta.playbookId;
        state.playbookParameterValues = meta.playbookParameterValues;
        state.gitBranch = meta.gitBranch;
        state.gitCommit = meta.gitCommit;
        state.gitIsWorktree = meta.gitIsWorktree;
        state.worktreeHealth = meta.worktreeHealth;
        state.worktreeHealthObservedAt = meta.worktreeHealthObservedAt;
        state.worktreeRegistryStale = meta.worktreeRegistryStale;
        state.projectId = meta.projectId;
        state.projectDisplayLabel = meta.projectDisplayLabel;
        // Enrich with token usage, task status, and autonomy from the task
        const task = this.taskStore.getTask(meta.taskId);
        if (task) {
          state.taskStatus = task.status;
          state.autonomy = task.autonomy;
          state.ralphLoop = task.ralphLoop;
          if (task.tokenUsage) {
            state.tokenUsage = task.tokenUsage;
          }
        }
      }

      states.push(state);
    }

    // Include pending and completed/cancelled tasks as synthetic entries
    for (const task of this.taskStore.getAllTasks()) {
      if (task.status === 'pending') {
        states.push({
          agentId: `pending-${task.id}`,
          events: [],
          anomaly: null,
          taskId: task.id,
          taskName: task.name ?? truncatePrompt(task.prompt, 60),
          taskStatus: 'pending',
          description: task.prompt,
          cwd: task.cwd,
          agentType: task.agentType,
          startedAt: task.createdAt.toISOString(),
          playbookId: task.playbookId,
          playbookParameterValues: task.playbookParameterValues,
          projectId: task.projectId,
          projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: task.cwd }),
          autonomy: task.autonomy,
          ralphLoop: task.ralphLoop,
        });
      } else if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'terminated') {
        // Terminal-state tasks included as synthetic entries so they surface
        // in the dashboard's Completed pane. Without this, 'terminated' tasks
        // would be invisible — and a user couldn't acknowledge them, defeating
        // rfc-task-loss-prevention D1.
        //
        // Only include if not already represented (agent may have been unregistered)
        if (!states.some((s) => s.taskId === task.id)) {
          const lastSession = task.sessions[task.sessions.length - 1];
          states.push({
            agentId: lastSession?.tmuxSession ?? `done-${task.id}`,
            events: [],
            anomaly: null,
            taskId: task.id,
            taskName: task.name ?? truncatePrompt(task.prompt, 60),
            taskStatus: task.status,
            description: task.prompt,
            cwd: lastSession?.cwd ?? task.cwd,
            agentType: lastSession?.agentType ?? task.agentType,
            startedAt: task.createdAt.toISOString(),
            playbookId: task.playbookId,
            playbookParameterValues: task.playbookParameterValues,
            projectId: task.projectId,
            projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: lastSession?.cwd ?? task.cwd }),
            tokenUsage: task.tokenUsage,
            gitBranch: lastSession?.gitBranch,
            gitCommit: lastSession?.gitCommit,
            gitIsWorktree: lastSession?.gitIsWorktree,
            worktreeHealth: lastSession?.worktreeHealth,
            worktreeHealthObservedAt: lastSession?.worktreeHealthObservedAt,
            worktreeRegistryStale: lastSession?.worktreeRegistryStale,
            completionDigest: task.completionDigest,
            completionFeedback: task.completionFeedback,
            autonomy: task.autonomy,
            ralphLoop: task.ralphLoop,
          });
        }
      }
    }

    return states;
  }
}

/** Truncate a prompt to maxLen chars at a word boundary, adding "..." if truncated. */
function truncatePrompt(prompt: string, maxLen: number): string {
  if (prompt.length <= maxLen) return prompt;
  const truncated = prompt.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...';
}
