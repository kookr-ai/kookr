import type { Monitor } from '../core/monitor.js';
import type { AgentState } from '../shared/contracts/agent-state.js';
import { type HookIngestion, mintEventId } from './hook-ingestion.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import type { AgentEvent, EventMeta } from '../core/types.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { LlmClient } from '../core/llm-client.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import type { RalphCycler } from '../core/ralph-cycler.js';
import type { RalphLoopService } from './ralph-loop-service.js';
import { createGitHubEventProcessor } from './event-processors/github-event-processor.js';
import { createInteractiveDenyProcessor } from './event-processors/interactive-deny-processor.js';
import { createPermissionBlockAlertProcessor } from './event-processors/permission-block-alert-processor.js';
import { createPermissionQuickActionsProcessor } from './event-processors/permission-quick-actions-processor.js';
import { createRalphStopProcessor } from './ralph/stop-event-processor.js';
import { createResponseAssistProcessor } from './event-processors/response-assist-processor.js';
import { createSessionActivityProcessor } from './event-processors/session-activity-processor.js';
import { createStopTokenScanProcessor } from './event-processors/stop-token-scan-processor.js';
import { createTokenAccountingProcessor } from './event-processors/token-accounting-processor.js';
import type { TerminalInputCoordinator } from './terminal-input-coordinator.js';
import type { UserInputDeliveryService } from './user-input-delivery-service.js';
import { buildSnapshotProjection } from './use-cases/snapshot-projection.js';

/**
 * Default event-loop delay p95 threshold (ms) above which non-critical full
 * snapshot rebuilds are shed (#1775). Aligned with WS load-shed / non-critical
 * timer pause so the same saturation signal trips multiple guards. `0` disables.
 */
export const DEFAULT_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS = 1_500;

export interface SnapshotShedConfig {
  /**
   * Event-loop delay p95 threshold in milliseconds. Non-critical snapshot
   * rebuilds skip when the latest sample is strictly greater than this value.
   * `0` disables shedding.
   */
  eventLoopDelayThresholdMs: number;
}

function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed < 0 ? 0 : parsed;
}

/**
 * Read snapshot-shed threshold from the environment. Invalid/blank → default;
 * `KOOKR_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS=0` disables shedding.
 */
export function readSnapshotShedConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SnapshotShedConfig {
  return {
    eventLoopDelayThresholdMs: readNonNegativeNumber(
      env.KOOKR_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS,
      DEFAULT_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS,
    ),
  };
}

/**
 * Pure decision: should a non-critical full-snapshot rebuild be skipped?
 * Fail-open on disabled threshold or missing/non-finite sample (#1775).
 * "Above threshold" is strict greater-than (matches timer-pause wording).
 */
export function shouldShedSnapshotRebuild(input: {
  eventLoopDelayP95Ms: number | null | undefined;
  thresholdMs: number;
}): boolean {
  const { eventLoopDelayP95Ms, thresholdMs } = input;
  if (!(thresholdMs > 0)) return false;
  if (eventLoopDelayP95Ms == null || !Number.isFinite(eventLoopDelayP95Ms)) return false;
  return eventLoopDelayP95Ms > thresholdMs;
}

/** Process-lifetime shed counter + config for `/metrics` / health (#1775). */
export interface SnapshotShedMetricsSnapshot {
  schemaVersion: 'snapshot-shed.v1';
  /** Configured threshold (ms); 0 means the gate is disabled. */
  thresholdMs: number;
  /** Last finite p95 sample consulted at a shed decision, or null. */
  lastEventLoopDelayP95Ms: number | null;
  /** Total non-critical full-snapshot rebuilds skipped since process start. */
  shedTotal: number;
}

export interface EventPipelineDeps {
  adapter: AgentAdapter;
  monitor: Monitor;
  taskStore: TaskStore;
  tokenTracker: TokenTracker;
  watchdog: Watchdog;
  githubScanner: GitHubScannerService;
  llmClient: LlmClient | null;
  serverCwd: string;
  broadcastToAll: (msg: ServerMessage) => void;
  telemetryLog?: DeferredTelemetryLogWriter;
  /**
   * Optional callback fired when an agent enters the `permission_blocked`
   * anomaly state. Used by the remote-chat integration (R16) to send a
   * Kookr alert to the chat that originated the spawn.
   *
   * The callback receives `(taskId, promptText)` where `promptText` is a
   * human-readable summary of the tool call awaiting approval (e.g.,
   * "Bash(git push origin feat-x)"). The pipeline isolates callback failures
   * behind the permission-alert circuit breaker so remote integration outages
   * degrade that alert path without interrupting event processing.
   *
   * See `docs/rfc/rfc-remote-chat-trigger.md` §7 (R16).
   */
  onPermissionBlocked?: (taskId: string, promptText: string) => void;
  /** Circuit breaker isolating remote permission-block alert callbacks from the event pipeline. */
  permissionAlertBreaker?: CircuitBreaker;
  /** Optional Ralph iteration cycler — drives the loop state machine on Stop events. */
  ralphCycler?: RalphCycler;
  /** Singleton Ralph loop service shared with routes and startup recovery. */
  ralphLoopService: RalphLoopService;
  /** Provides per-Kookr-session activityMeta for the snapshot. */
  hookIngestion?: HookIngestion;
  /** Optional publisher for refreshing remote task-share projections after local task state changes. */
  taskShareService?: { publishTaskProjectionForTask(taskId: string): void };
  terminalInputCoordinator?: TerminalInputCoordinator;
  /**
   * Fixed coalescing window (ms) for centralized snapshot broadcasts (#704 / #1778).
   * A burst of events within this window collapses to a single full-snapshot
   * rebuild plus a single WebSocket fan-out; the trailing flush always rebuilds
   * from the live monitor snapshot, so clients converge on final state.
   * Attention transitions (a newly-entered warning/critical anomaly) bypass
   * coalescing and flush immediately so "an agent needs you" is never delayed.
   *
   * When **omitted**, the pipeline uses an adaptive window
   * `max(16, min(250, f(eventLoopDelayP95, agentCount)))` so idle/single-agent
   * traffic stays snappy (~16ms) while multi-agent storms stretch toward 250ms
   * and leave the event loop free for terminal I/O (#1778).
   *
   * Set to a non-negative number to pin a fixed window (`0` disables coalescing
   * and flushes synchronously).
   */
  snapshotCoalesceWindowMs?: number;
  userInputDeliveries?: UserInputDeliveryService;
  /**
   * Latest sampled event-loop delay p95 (ms) for snapshot-shed (#1775) and
   * adaptive coalesce window (#1778). Reuses the resource-sampler value already
   * powering admission / WS load-shed. Fail-open for shed; missing/null samples
   * treat delay as 0 for adaptive window (healthy floor).
   */
  getEventLoopDelayP95Ms?: () => number | null | undefined;
  /**
   * Threshold (ms) for shedding non-critical full-snapshot rebuilds. Defaults
   * to {@link DEFAULT_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS}; `0` disables.
   */
  snapshotShedEventLoopDelayThresholdMs?: number;
}

/** Idle / healthy floor for adaptive snapshot coalesce (one display frame). */
export const MIN_SNAPSHOT_COALESCE_WINDOW_MS = 16;
/** Storm ceiling for adaptive snapshot coalesce (matches prior fixed default). */
export const MAX_SNAPSHOT_COALESCE_WINDOW_MS = 250;
/** Extra coalesce ms per live agent beyond the first (#1778). */
export const SNAPSHOT_COALESCE_MS_PER_AGENT = 8;
/**
 * @deprecated Prefer adaptive mode (omit fixed window) or
 * {@link MAX_SNAPSHOT_COALESCE_WINDOW_MS}. Kept as the historical fixed default
 * for callers that still pin a constant.
 */
export const DEFAULT_SNAPSHOT_COALESCE_WINDOW_MS = MAX_SNAPSHOT_COALESCE_WINDOW_MS;

/**
 * Pure map: event-loop delay p95 + fleet size → coalesce window (#1778).
 * `max(minMs, min(maxMs, minMs + delay + max(0, agents-1)*msPerAgent))`.
 * Missing/non-finite delay or agent count treat as 0 (healthy idle floor).
 */
export function computeAdaptiveSnapshotCoalesceWindowMs(input: {
  eventLoopDelayP95Ms?: number | null;
  agentCount?: number | null;
  minMs?: number;
  maxMs?: number;
  msPerAgent?: number;
}): number {
  const minMs = input.minMs ?? MIN_SNAPSHOT_COALESCE_WINDOW_MS;
  const maxMs = input.maxMs ?? MAX_SNAPSHOT_COALESCE_WINDOW_MS;
  const msPerAgent = input.msPerAgent ?? SNAPSHOT_COALESCE_MS_PER_AGENT;
  const floor = Number.isFinite(minMs) && minMs >= 0 ? minMs : MIN_SNAPSHOT_COALESCE_WINDOW_MS;
  const ceiling = Number.isFinite(maxMs) && maxMs >= floor ? maxMs : Math.max(floor, MAX_SNAPSHOT_COALESCE_WINDOW_MS);
  const delay =
    input.eventLoopDelayP95Ms != null && Number.isFinite(input.eventLoopDelayP95Ms) && input.eventLoopDelayP95Ms > 0
      ? input.eventLoopDelayP95Ms
      : 0;
  const agents =
    input.agentCount != null && Number.isFinite(input.agentCount) && input.agentCount > 0
      ? Math.floor(input.agentCount)
      : 0;
  const perAgent = Number.isFinite(msPerAgent) && msPerAgent > 0 ? msPerAgent : 0;
  const raw = floor + delay + Math.max(0, agents - 1) * perAgent;
  return Math.max(floor, Math.min(ceiling, Math.round(raw)));
}

/** Last adaptive/fixed coalesce decision for metrics (#1778). */
export interface SnapshotCoalesceMetricsSnapshot {
  schemaVersion: 'snapshot-coalesce.v1';
  /** `adaptive` when no fixed override; `fixed` when pinned via dep/env. */
  mode: 'adaptive' | 'fixed';
  minMs: number;
  maxMs: number;
  /** Pinned window when mode is `fixed`; null in adaptive mode. */
  fixedWindowMs: number | null;
  /** Last window (ms) used to arm the coalesce timer (or fixed pin). */
  lastEffectiveWindowMs: number;
  /** Last finite p95 sample consulted for adaptive arm, or null. */
  lastEventLoopDelayP95Ms: number | null;
  /** Last agent-count sample consulted for adaptive arm. */
  lastAgentCount: number;
}

/**
 * Cheap live-agent count for adaptive coalesce (#1778). Uses
 * {@link Monitor.getRetentionMetrics} only (map size — no payload copies).
 * Missing retention metrics → 0 (healthy floor); never calls getSnapshot so
 * the hook hot path does not rebuild full agent state just to arm a timer.
 */
function readLiveAgentCount(monitor: Monitor): number {
  const retention = (
    monitor as Monitor & { getRetentionMetrics?: () => { agents?: number } }
  ).getRetentionMetrics?.();
  if (retention && typeof retention.agents === 'number' && Number.isFinite(retention.agents)) {
    return Math.max(0, Math.floor(retention.agents));
  }
  return 0;
}

/**
 * Anomalies that warrant interrupting the operator — these bypass broadcast
 * coalescing so the dashboard reflects "needs attention" without the
 * coalescing-window delay. `info`-severity anomalies ride the coalesced path.
 */
function isAttentionAnomaly(anomaly: Anomaly | null | undefined): boolean {
  return !!anomaly && (anomaly.severity === 'warning' || anomaly.severity === 'critical');
}

function getProjectedAgentState(monitor: Monitor, taskStore: TaskStore, agentId: string): AgentState | undefined {
  const rawState = monitor.getAgentState(agentId);
  if (!rawState) return undefined;
  const ownerTask = taskStore.findTaskBySession(agentId);
  if (!ownerTask) return rawState;
  return buildSnapshotProjection({ monitorStates: [rawState], tasks: [ownerTask] })[0];
}

/**
 * Wire adapter events into the monitor, watchdog, token tracker, smart response assist,
 * and GitHub scanner. Returns a cleanup function to cancel any pending suggestions.
 */
export function wireEventPipeline(deps: EventPipelineDeps): {
  abortPendingSuggestion: (agentId: string, outcome?: 'used' | 'cleared') => void;
  /**
   * Force any pending coalesced snapshot broadcast to fan out now (#704).
   * Critical path: bypasses snapshot-shed under event-loop saturation (#1775).
   */
  flushSnapshotNow: () => void;
  /** In-memory shed counter + threshold for `/metrics` / health (#1775). */
  getSnapshotShedMetrics: () => SnapshotShedMetricsSnapshot;
  /** Last adaptive/fixed coalesce window decision (#1778). */
  getSnapshotCoalesceMetrics: () => SnapshotCoalesceMetricsSnapshot;
} {
  const {
    adapter, monitor, taskStore, tokenTracker, watchdog,
    githubScanner, llmClient, serverCwd, broadcastToAll,
    telemetryLog,
  } = deps;

  // --- Snapshot broadcast coalescing (#704 / #1778) --------------------------
  // Every processed hook event asks for a full-snapshot rebuild + fan-out. On a
  // busy fleet, a burst produces N redundant rebuilds and N fan-outs. We
  // collapse each window's worth of requests to a single trailing rebuild +
  // fan-out: a request marks the snapshot dirty and arms the timer ONLY if none
  // is pending — a fixed-window throttle, deliberately NOT a debounce (a
  // re-arming debounce would starve the flush indefinitely under sustained
  // hook traffic, issue #1749). The timer's flush rebuilds from the live
  // monitor snapshot, so the broadcast always reflects final state.
  // `flushSnapshotNow` is the immediate-flush escape used internally for
  // attention transitions and exposed on the wire result for callers that need
  // a synchronous flush (e.g. a future shutdown drain).
  //
  // #1775: when event-loop delay p95 is already saturated, non-critical
  // flushes skip the multi-MB rebuild+fan-out (leave dirty + re-arm) so the
  // loop can serve terminal I/O. Attention / force flushes fail open.
  //
  // #1778: when no fixed window is pinned, resolve the arm delay adaptively
  // from event-loop p95 + live agent count so idle stays ~16ms and storms
  // stretch toward 250ms.
  const fixedCoalesceWindowMs = deps.snapshotCoalesceWindowMs;
  const coalesceMode: 'adaptive' | 'fixed' =
    fixedCoalesceWindowMs === undefined ? 'adaptive' : 'fixed';
  const snapshotShedThresholdMs =
    deps.snapshotShedEventLoopDelayThresholdMs ?? DEFAULT_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS;
  let snapshotDirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotShedTotal = 0;
  let lastSnapshotShedSampleMs: number | null = null;
  let lastEffectiveCoalesceWindowMs =
    coalesceMode === 'fixed'
      ? fixedCoalesceWindowMs!
      : MIN_SNAPSHOT_COALESCE_WINDOW_MS;
  let lastCoalesceDelaySampleMs: number | null = null;
  let lastCoalesceAgentCount = 0;

  const resolveCoalesceWindowMs = (): number => {
    if (coalesceMode === 'fixed') {
      lastEffectiveCoalesceWindowMs = fixedCoalesceWindowMs!;
      return fixedCoalesceWindowMs!;
    }
    const p95 = deps.getEventLoopDelayP95Ms?.();
    if (p95 != null && Number.isFinite(p95)) {
      lastCoalesceDelaySampleMs = p95;
    } else {
      lastCoalesceDelaySampleMs = null;
    }
    const agentCount = readLiveAgentCount(monitor);
    lastCoalesceAgentCount = agentCount;
    const windowMs = computeAdaptiveSnapshotCoalesceWindowMs({
      eventLoopDelayP95Ms: p95,
      agentCount,
    });
    lastEffectiveCoalesceWindowMs = windowMs;
    return windowMs;
  };

  const armCoalesceTimer = (flush: () => void) => {
    if (flushTimer !== null) return;
    const windowMs = resolveCoalesceWindowMs();
    if (windowMs <= 0) return;
    flushTimer = setTimeout(flush, windowMs);
    // Don't let a pending coalesce window keep the process (or a test runner)
    // alive; the flush is best-effort UI state, not a durability guarantee.
    flushTimer.unref?.();
  };

  const flushSnapshotInternal = (opts?: { force?: boolean }) => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!snapshotDirty) return;

    if (!opts?.force) {
      const p95 = deps.getEventLoopDelayP95Ms?.();
      if (p95 != null && Number.isFinite(p95)) {
        lastSnapshotShedSampleMs = p95;
      }
      if (shouldShedSnapshotRebuild({
        eventLoopDelayP95Ms: p95,
        thresholdMs: snapshotShedThresholdMs,
      })) {
        snapshotShedTotal += 1;
        // Keep dirty and re-arm so a later quiet window converges once load drops.
        armCoalesceTimer(() => flushSnapshotInternal());
        return;
      }
    }

    snapshotDirty = false;
    broadcastToAll(createSnapshotMessage({
      monitor,
      serverCwd,
      activityMetaProvider: deps.hookIngestion,
      relationTaskStore: taskStore,
      terminalInputSnapshots: deps.terminalInputCoordinator,
      userInputDeliveryProvider: deps.userInputDeliveries,
    }));
  };

  /** Critical-path force flush (attention + external escape hatch). */
  const flushSnapshotNow = () => flushSnapshotInternal({ force: true });

  const broadcastSnapshot = () => {
    snapshotDirty = true;
    // Fixed window of 0 disables coalescing (sync flush). Adaptive never
    // resolves to 0 (floor is MIN), so only the fixed pin can take this path.
    if (coalesceMode === 'fixed' && fixedCoalesceWindowMs! <= 0) {
      flushSnapshotInternal();
      return;
    }
    armCoalesceTimer(() => flushSnapshotInternal());
  };
  const publishTaskProjection = (taskId: string) => {
    deps.taskShareService?.publishTaskProjectionForTask(taskId);
  };
  const getAgentState = (agentId: string) => getProjectedAgentState(monitor, taskStore, agentId);

  const tokenAccountingProcessor = createTokenAccountingProcessor({
    taskLookup: taskStore,
    transcriptRegistry: tokenTracker,
  });
  const permissionBlockAlertProcessor = createPermissionBlockAlertProcessor({
    taskLookup: taskStore,
    onPermissionBlocked: deps.onPermissionBlocked,
    permissionAlertBreaker: deps.permissionAlertBreaker,
  });
  // issue #1562: flag unattended tasks operator-needed when their agent attempts
  // a (deny-blocked) interactive tool, so the block is operator-visible instead
  // of an open-ended hang.
  const interactiveDenyProcessor = createInteractiveDenyProcessor({
    taskStore,
    log: (line) => console.debug(line),
  });
  const stopTokenScanProcessor = createStopTokenScanProcessor({
    tokenUsageWriter: taskStore,
    tokenScanner: tokenTracker,
    tokenActivityRecorder: watchdog,
    broadcastSnapshot,
    publishTaskProjection,
  });
  const sessionActivityProcessor = createSessionActivityProcessor({ taskLookup: taskStore });
  const ralphStopProcessor = createRalphStopProcessor({
    taskCostReader: tokenTracker,
    runningLoopHandlingEnabled: Boolean(deps.ralphCycler),
    ralphStopHandler: deps.ralphLoopService,
    broadcastSnapshot,
    publishTaskProjection,
  });
  const responseAssistProcessor = createResponseAssistProcessor({
    getAgentState,
    llmClient,
    broadcastToAll,
    telemetryLog,
  });
  const permissionQuickActionsProcessor = createPermissionQuickActionsProcessor({
    displayCapture: adapter,
    getAgentState,
    broadcastToAll,
  });
  const githubEventProcessor = createGitHubEventProcessor({
    githubScanner,
    taskLookup: taskStore,
  });

  const handleEvent = (tmuxName: string, event: AgentEvent, meta: EventMeta) => {
    tokenAccountingProcessor.process({ tmuxName, event });

    // Cross-session child events do not drive parent anomaly detection,
    // watchdog liveness, completion summaries, autonomy decisions, or the Ralph
    // cycler. `unknown` is treated conservatively as parent-ish so
    // events that arrive before the parent SessionStart still flow into
    // anomaly detection — V1 SHALL keep existing detection unless a record is
    // confidently classified as non-parent. See rfc §3.
    if (meta.parentage === 'child' || meta.parentage === 'foreign') return;

    const pipelineEvent: AgentEvent = event.type === 'user_prompt' && !event.hookLineId
      ? { ...event, hookLineId: String(meta.sequence) }
      : event;
    const inputState = deps.terminalInputCoordinator?.getSnapshot(tmuxName);
    switch (pipelineEvent.type) {
      case 'user_prompt':
        deps.userInputDeliveries?.observeProviderUserPrompt(
          tmuxName,
          pipelineEvent.prompt,
          pipelineEvent.hookLineId ?? String(meta.sequence),
          meta.observedAt,
        );
        void deps.terminalInputCoordinator?.markUserPromptSubmitted(tmuxName);
        break;
      case 'session_end':
        deps.userInputDeliveries?.finalizeSession(tmuxName);
        void deps.terminalInputCoordinator?.markSessionEnded(tmuxName);
        break;
      case 'tool_use':
        void deps.terminalInputCoordinator?.markToolStarted(tmuxName);
        break;
      case 'permission_request':
        void deps.terminalInputCoordinator?.markPermissionBlocked(tmuxName);
        break;
      case 'stop_failure':
        void deps.terminalInputCoordinator?.markStopFailure(tmuxName);
        break;
      case 'stop':
        void deps.terminalInputCoordinator?.markTurnStopped(tmuxName);
        break;
      case 'notification':
        if (pipelineEvent.notificationType === 'idle_prompt' && inputState) {
          void deps.terminalInputCoordinator?.markPromptReady(tmuxName, {
            observedEpoch: inputState.inputStateEpoch,
            observedReadinessVersion: inputState.readinessVersion,
          });
        }
        break;
    }

    // Recompute the end-to-end correlation id (#705) from the SAME stable
    // `(kookrSessionId, sequence)` the id was minted from at ingestion. Because
    // mintEventId is pure, this yields the identical id rather than a fresh one,
    // so the value is threaded unchanged into the derived finding via the monitor.
    const eventId = mintEventId(tmuxName, meta.sequence);

    // ⚠ ORDERING CONTRACT: pre-capture must precede processEvents();
    // post-capture must follow it. The anomaly-diff detects any transition
    // away from needs_input (e.g. tool_use, session_start) and clears stale suggestions.
    const preState = monitor.getAgentState(tmuxName);
    const wasNeedsInput = preState?.anomaly?.type === 'needs_input';

    monitor.processEvents(tmuxName, [pipelineEvent], { eventId });
    if (meta.origin === 'replay') {
      // Replayed hook history restores pairing/finding state but must not move
      // the liveness clock forward to the restart time.
      watchdog.recordEvents(tmuxName, [pipelineEvent], meta.observedAt, { updateLastEventAt: false });
    } else {
      watchdog.recordEvents(tmuxName, [pipelineEvent], meta.observedAt);
    }

    // Post-event: if anomaly transitioned away from needs_input, clear stale suggestions
    const postState = monitor.getAgentState(tmuxName);

    // Structured lineage log (#705): emit one line tying the correlation id to a
    // finding when an anomaly newly appears or changes type/severity/subType.
    // Persisting, unchanged findings are not re-logged to avoid per-event spam.
    const post = postState?.anomaly;
    const pre = preState?.anomaly;
    if (
      post &&
      (!pre ||
        pre.type !== post.type ||
        pre.severity !== post.severity ||
        pre.subType !== post.subType)
    ) {
      console.debug('[event-pipeline] finding', {
        eventId: post.eventId ?? eventId,
        agentId: tmuxName,
        anomalyType: post.type,
        severity: post.severity,
        eventType: pipelineEvent.type,
        sequence: meta.sequence,
      });
    }

    const isNeedsInput = postState?.anomaly?.type === 'needs_input';
    if (wasNeedsInput && !isNeedsInput) {
      console.debug(`[event-pipeline] needs_input cleared for ${tmuxName} by ${pipelineEvent.type}`);
      responseAssistProcessor.abortPendingSuggestion(tmuxName);
    }

    permissionBlockAlertProcessor.process({ tmuxName, preState, postState });
    // Runs before broadcastSnapshot/publishTaskProjection below so a newly set
    // operator-needed flag rides out on this event's broadcast (issue #1562).
    interactiveDenyProcessor.process({ tmuxName, event: pipelineEvent });

    const ownerTask = taskStore.findTaskBySession(tmuxName);
    // Persist the agent's latest turn state on its session as the durable signal
    // reconciliation later uses to tell a clean finish from a mid-turn crash when
    // the session dies (see reconciliation.ts `endedOnCleanTurn`, #693). Skip
    // `unknown` so a trailing `session_end` cannot erase a prior `completed_turn`.
    if (ownerTask) {
      const turnState = postState?.turnState;
      if (turnState && turnState !== 'unknown') {
        const session = ownerTask.sessions.find((s) => s.tmuxSession === tmuxName);
        if (session && session.lastTurnState !== turnState) {
          taskStore.updateSession(ownerTask.id, tmuxName, { lastTurnState: turnState });
        }
      }
    }
    sessionActivityProcessor.process(tmuxName);
    broadcastSnapshot();
    // Attention transition: an anomaly that newly becomes (or escalates to a
    // different type/severity within) warning/critical is a low-frequency,
    // latency-sensitive alert — flush immediately so it bypasses the coalescing
    // window. A persisting, unchanged attention anomaly stays coalesced so a
    // burst of stuck-state events doesn't fan out N times.
    if (
      isAttentionAnomaly(postState?.anomaly) &&
      (!isAttentionAnomaly(preState?.anomaly) ||
        preState?.anomaly?.type !== postState?.anomaly?.type ||
        preState?.anomaly?.severity !== postState?.anomaly?.severity)
    ) {
      flushSnapshotNow();
    }
    if (ownerTask) publishTaskProjection(ownerTask.id);

    // On stop/stop_failure events, immediately scan transcript for updated spending
    if (pipelineEvent.type === 'stop' || pipelineEvent.type === 'stop_failure') {
      const stopTask = ownerTask ?? undefined;
      stopTokenScanProcessor.process(stopTask);
      ralphStopProcessor.process(stopTask, tmuxName, pipelineEvent);
    }

    const agentState = getAgentState(tmuxName);
    responseAssistProcessor.process({ tmuxName, event: pipelineEvent, agentState });
    permissionQuickActionsProcessor.process({ tmuxName, agentState });
    githubEventProcessor.process({ tmuxName, event: pipelineEvent, postState });
  };

  // Wire adapter events to the shared event handler
  adapter.onEvent(handleEvent);

  return {
    abortPendingSuggestion: responseAssistProcessor.abortPendingSuggestion,
    flushSnapshotNow,
    getSnapshotShedMetrics: () => ({
      schemaVersion: 'snapshot-shed.v1',
      thresholdMs: snapshotShedThresholdMs,
      lastEventLoopDelayP95Ms: lastSnapshotShedSampleMs,
      shedTotal: snapshotShedTotal,
    }),
    getSnapshotCoalesceMetrics: () => ({
      schemaVersion: 'snapshot-coalesce.v1',
      mode: coalesceMode,
      minMs: MIN_SNAPSHOT_COALESCE_WINDOW_MS,
      maxMs: MAX_SNAPSHOT_COALESCE_WINDOW_MS,
      fixedWindowMs: coalesceMode === 'fixed' ? fixedCoalesceWindowMs! : null,
      lastEffectiveWindowMs: lastEffectiveCoalesceWindowMs,
      lastEventLoopDelayP95Ms: lastCoalesceDelaySampleMs,
      lastAgentCount: lastCoalesceAgentCount,
    }),
  };
}
