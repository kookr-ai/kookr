import { useEffect, useRef, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { initTelemetry, track } from '../telemetry.js';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';
import { isSystemResourceStatus } from '../resource-status.js';
import type { TransportSessionSlice, TriageNavigationSlice } from '../store/store-types.js';
import { recordInbound, recordOutbound } from '../bug-report-recorder.js';
import { createReconnectingSocket, type ReconnectingSocket } from '../reconnecting-socket.js';
import { DeltaSequenceTracker } from '../delta-sequence.js';
import { measureSync } from '../debug-timeline.js';

// Stale-socket callbacks are ignored silently in the controller; here we count
// them and emit at most one compact telemetry event per window so a burst of
// zombie events (reconnect storm, StrictMode churn) can't flood the buffer.
const STALE_TELEMETRY_WINDOW_MS = 10_000;

export function parseServerMessageForClient(data: string): unknown | null {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export function recordAndParseServerMessageForClient(data: string): unknown | null {
  const parsed = parseServerMessageForClient(data);
  recordInbound(data, parsed);
  return parsed;
}

export function recordClientMessageForSend(msg: ClientMessage): void {
  recordOutbound(msg);
}

export function workspaceRefreshMessageAfterSweep(
  msg: Extract<ServerMessage, { type: 'workspaceSweepComplete' }>,
  currentWorkspaceProjectId: string | null | undefined,
): Extract<ClientMessage, { type: 'workspace:getView' }> | null {
  if (!currentWorkspaceProjectId) return null;
  const currentProjectWasSwept = msg.projects.some((project) => (
    project.kind === 'ok' && project.projectId === currentWorkspaceProjectId
  ));
  return currentProjectWasSwept
    ? { type: 'workspace:getView', projectId: currentWorkspaceProjectId }
    : null;
}

export function dispatchSnapshotMessageForClient(
  msg: Record<string, any>,
  handleSnapshot: TransportSessionSlice['handleSnapshot'],
): void {
  // Sample main-thread cost of applying a full snapshot (store merge + sticky fields).
  // Samples only land when duration >= LONG_TASK_THRESHOLD_MS.
  measureSync('snapshot-apply', () => {
    handleSnapshot(
      msg.agents,
      msg.serverCwd,
      msg.build,
      msg.serverStartedAt,
      msg.sttEnabled,
      msg.sttUrl,
      msg.totalSpendUsd,
      msg.achievements,
      msg.availableAgentTypes,
      msg.defaultAgentType,
      msg.workspaceEnabled,
      msg.sweepRunning,
      msg.maxActiveTasks,
      msg.speechCapabilities,
      msg.coordinator,
      msg.ttsUrl,
      msg.bypassAllPermissions,
      msg.drainStatus,
      msg.sweepProgress,
    );
    // Sticky: only overwrite the cached graph when the server actually shipped
    // one. High-frequency event-pipeline broadcasts omit it on purpose, and we
    // want the detail panel to keep rendering the last-known relations until
    // the next full snapshot refresh.
    if (Array.isArray(msg.taskRelations)) {
      useKookrStore.setState({ taskRelations: msg.taskRelations });
    }
    // Sticky: remember the last completed sweep's runId so a reconnecting client
    // can reconstruct its Removed manifest from the ledger. Partial/high-frequency
    // snapshots omit it — never clear on absence.
    if (typeof msg.lastSweepRunId === 'string') {
      useKookrStore.getState().setLastSweepRunId(msg.lastSweepRunId);
    }
    // Sticky SAFE MODE (issue #1710): only overwrite when the server shipped the
    // field. High-frequency partial snapshots omit it on purpose.
    if (msg.safeMode && typeof msg.safeMode === 'object') {
      const engaged = msg.safeMode.engaged === true;
      useKookrStore.setState({
        safeMode: engaged
          ? {
              engaged: true,
              ...(typeof msg.safeMode.since === 'string' ? { since: msg.safeMode.since } : {}),
            }
          : { engaged: false },
      });
    }
  }, { agentCount: Array.isArray(msg.agents) ? msg.agents.length : undefined });
}

export function dispatchAlertMessageForClient(
  msg: Record<string, any>,
  handleAlert: TriageNavigationSlice['handleAlert'],
): void {
  const severity = msg.severity === 'critical' || msg.severity === 'warning' ? 'error' : 'info';
  handleAlert(msg.agentId, msg.summary, severity, msg.details || undefined);
}

export function dispatchCoordinatorSnapshotMessageForClient(msg: Record<string, any>): void {
  useKookrStore.setState({ coordinator: msg.coordinator });
}

export function useWebSocket() {
  const controllerRef = useRef<ReconnectingSocket | null>(null);
  const disconnectedAtRef = useRef<number | null>(null);
  const hasConnectedRef = useRef(false);
  const hasHydratedProjectSidebarRef = useRef(false);
  // The server rebroadcasts full snapshots at high frequency (event pipeline),
  // so per-connection side effects (the /api/schedules refresh) must run only
  // on the first snapshot after each connect, not on every snapshot.
  const hasFetchedSchedulesForConnectionRef = useRef(false);
  // #1754 Stage 1: tracks the server's delta-stream position `(epoch, seq)` from
  // snapshots and decides the resync reason if a delta ever arrives. Created once
  // and persisted across reconnects (the next snapshot always re-bases it).
  const deltaTrackerRef = useRef<DeltaSequenceTracker | null>(null);
  if (deltaTrackerRef.current === null) deltaTrackerRef.current = new DeltaSequenceTracker();

  useEffect(() => {
    // Bounded diagnostics for ignored stale-socket callbacks. Counts accumulate
    // across the controller's lifetime; telemetry is coalesced to one event per
    // window so a zombie-event burst stays cheap. The counts are cumulative so
    // a later emission still carries the full tally.
    const staleEventCounts = { open: 0, message: 0, close: 0, error: 0 };
    let lastStaleTelemetryAt = 0;

    const controller = createReconnectingSocket<WebSocket>({
      createSocket: () => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return new WebSocket(`${protocol}//${window.location.host}/ws`);
      },
      onStaleEvent: (kind) => {
        staleEventCounts[kind] += 1;
        const now = Date.now();
        if (now - lastStaleTelemetryAt < STALE_TELEMETRY_WINDOW_MS) return;
        lastStaleTelemetryAt = now;
        // Descriptive, count-suffixed keys to match the surrounding telemetry
        // naming (websocket_reconnect.disconnectDurationMs, session_started.
        // agentCount). Counts are cumulative for the controller's lifetime.
        track({
          type: 'websocket_stale_event',
          staleOpenCount: staleEventCounts.open,
          staleMessageCount: staleEventCounts.message,
          staleCloseCount: staleEventCounts.close,
          staleErrorCount: staleEventCounts.error,
        });
      },
      // Only report "connected" once the server actually delivers data (it
      // sends a full snapshot immediately on connect). A proxy or restarting
      // server can accept the upgrade and instantly drop it — counting that
      // as connected made the connection indicator flap on every retry.
      establishOn: 'first-message',
      onOpen: () => {
        hasFetchedSchedulesForConnectionRef.current = false;
      },
      onEstablished: () => {
        useKookrStore.getState().setConnected(true);
        // Track reconnect if we were disconnected
        if (disconnectedAtRef.current !== null) {
          track({ type: 'websocket_reconnect', disconnectDurationMs: Date.now() - disconnectedAtRef.current });
          disconnectedAtRef.current = null;
        }
        // Track session start on first connection
        if (!hasConnectedRef.current) {
          hasConnectedRef.current = true;
          const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
          initTelemetry((msg) => {
            controllerRef.current?.send(JSON.stringify(msg));
          }, sessionId);
          track({ type: 'session_started', agentCount: useKookrStore.getState().agents.length });
        }
      },
      onLost: () => {
        useKookrStore.getState().setConnected(false);
        hasHydratedProjectSidebarRef.current = false;
        if (disconnectedAtRef.current === null) {
          disconnectedAtRef.current = Date.now();
        }
      },
      onMessage: (event) => {
        const parsed = recordAndParseServerMessageForClient(String(event.data));
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;
        try {
          const msg = parsed as Record<string, any>;
          const store = useKookrStore.getState();
          switch (msg.type) {
            case 'snapshot':
              // #1754 Stage 1: adopt the snapshot's `(epoch, seq)`. A snapshot
              // always re-bases the client, so this also clears any pending gap.
              deltaTrackerRef.current?.onSnapshot({ epoch: msg.epoch, seq: msg.seq });
              dispatchSnapshotMessageForClient(msg, store.handleSnapshot);
              // Counters / streak ride alongside achievements but live on the
              // achievements slice — write them directly via setState.
              if (msg.achievementCounters || msg.achievementStreak) {
                useKookrStore.setState({
                  ...(msg.achievementCounters ? { achievementCounters: msg.achievementCounters } : {}),
                  ...(msg.achievementStreak ? { achievementStreak: msg.achievementStreak } : {}),
                });
              }
              if (!hasHydratedProjectSidebarRef.current) {
                hasHydratedProjectSidebarRef.current = true;
                store.hydrateProjectSidebarFromServer().catch(() => {
                  hasHydratedProjectSidebarRef.current = false;
                });
              }
              // Refresh schedules once per connection (the first snapshot marks
              // the connection as serving); pushed 'schedules'/'scheduleFired'
              // messages keep them current afterwards.
              if (!hasFetchedSchedulesForConnectionRef.current) {
                hasFetchedSchedulesForConnectionRef.current = true;
                fetch('/api/schedules').then(r => r.json()).then(store.handleSchedules).catch(() => {});
              }
              break;
            case 'update':
              store.handleUpdate(msg.agentId, msg.state);
              break;
            case 'delta': {
              // #1754 Stage 2: apply in-order deltas; resync on epoch/seq gap.
              const tracker = deltaTrackerRef.current;
              if (!tracker) break;
              const position = { epoch: msg.epoch as string, seq: msg.seq as number };
              const verdict = tracker.evaluateDelta(position);
              if (verdict.action === 'resync') {
                const resync: ClientMessage = {
                  type: 'requestResync',
                  reason: verdict.reason,
                  haveSeq: tracker.haveSeq,
                };
                const sent = controllerRef.current?.send(JSON.stringify(resync)) ?? false;
                if (sent) recordClientMessageForSend(resync);
                break;
              }
              try {
                measureSync('delta-apply', () => {
                  store.handleDelta({
                    agents: msg.agents,
                    taskRelations: msg.taskRelations,
                    aggregates: msg.aggregates,
                  });
                }, {
                  upsertCount: Array.isArray(msg.agents?.upserts) ? msg.agents.upserts.length : 0,
                  removedCount: Array.isArray(msg.agents?.removed) ? msg.agents.removed.length : 0,
                });
                tracker.advance(position);
              } catch {
                // Apply failure → resync escape hatch (same reasons as Stage 1).
                const resync: ClientMessage = {
                  type: 'requestResync',
                  reason: 'apply_error',
                  haveSeq: tracker.haveSeq,
                };
                const sent = controllerRef.current?.send(JSON.stringify(resync)) ?? false;
                if (sent) recordClientMessageForSend(resync);
              }
              break;
            }
            case 'alert': {
              dispatchAlertMessageForClient(msg, store.handleAlert);
              break;
            }
            case 'githubUpdate':
              store.handleGitHubUpdate(msg.taskId, msg.prs, msg.issues, msg.changes);
              break;
            case 'playbooks':
              store.handlePlaybooks(msg.playbooks, msg.cwd, msg.capabilities);
              break;
            case 'suggestion':
              store.handleSuggestion(msg.agentId, msg.suggestions, msg.quickActions);
              break;
            case 'projectSummaries':
              store.handleProjectSummaries(msg.projects);
              break;
            case 'coordinator.snapshot':
              dispatchCoordinatorSnapshotMessageForClient(msg);
              break;
            case 'dashboardSelection':
              store.handleDashboardSelection({
                selectedTaskId: msg.selectedTaskId,
                selectedSessionId: msg.selectedSessionId,
                selectionVersion: msg.selectionVersion,
              });
              break;
            case 'emptyEnterDecision':
              break;
            case 'contributionWarning':
              store.handleAlert('', msg.message, msg.severity === 'exceeded' ? 'error' : 'info');
              break;
            case 'achievement:unlocked':
              store.handleAchievementUnlocked({
                id: msg.id,
                name: msg.name,
                emoji: msg.emoji,
                description: msg.description,
                unlockedAt: msg.unlockedAt,
                timestamp: Date.now(),
              });
              break;
            case 'achievement:reset:ack':
              // Dispatch DOM event for AchievementsPanel to handle
              window.dispatchEvent(new CustomEvent('achievement-reset-ack', { detail: msg }));
              break;
            case 'quotaStatus':
              store.handleQuotaStatus(msg.quota);
              break;
            case 'resourceStatus':
              if (isSystemResourceStatus(msg.status)) {
                store.handleResourceStatus(msg.status, Date.now());
              }
              break;
            case 'circuitBreakerStatus':
              store.handleCircuitBreakerStatus(msg.breakers);
              break;
            case 'diagnosticReport':
              store.handleDiagnosticReport(msg.report);
              break;
            case 'schedules':
              store.handleSchedules({ revision: msg.revision, schedules: msg.schedules, status: msg.status });
              break;
            case 'scheduleFired':
              fetch('/api/schedules').then(r => r.json()).then(store.handleSchedules).catch(() => {});
              break;
            case 'workspaceView':
              store.handleWorkspaceView(msg.view, msg.error, msg.cleanupResult, msg.cleanupResults, msg.diagnosticLaunch);
              break;
            case 'workspaceCleanupDetail':
              store.handleWorkspaceCleanupDetail(msg.worktreePath, msg.detail, msg.error);
              break;
            case 'worktreeCleanupVerdicts':
              store.handleWorktreeCleanupVerdicts(msg.taskId, msg.verdicts, msg.error);
              break;
            case 'workspaceSweepProgress':
              store.handleSweepProgress(msg);
              break;
            case 'workspaceBulkRemoveProgress':
              store.handleBulkRemoveProgress(msg);
              break;
            case 'workspaceSweepComplete':
              store.handleSweepComplete({
                runId: msg.runId,
                startedAt: msg.startedAt,
                finishedAt: msg.finishedAt,
                projects: msg.projects,
                report: msg.report,
              });
              {
                const refresh = workspaceRefreshMessageAfterSweep(msg, store.workspaceView?.projectId);
                if (refresh) {
                  store.setWorkspaceLoading(true);
                  const sent = controllerRef.current?.send(JSON.stringify(refresh)) ?? false;
                  if (sent) recordClientMessageForSend(refresh);
                }
              }
              break;
            case 'workspaceSweepBusy':
              store.handleSweepBusy({ holderPid: msg.holderPid, heldSince: msg.heldSince });
              break;
            case 'workspaceSweepReport':
              store.handleSweepReport({ runId: msg.runId, report: msg.report });
              break;
            case 'ossAttempts':
              store.handleOssAttempts(msg.store);
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      },
    });

    controllerRef.current = controller;
    controller.start();
    return () => {
      controllerRef.current = null;
      controller.stop();
    };
  }, []);

  const send = useCallback((msg: ClientMessage): boolean => {
    const controller = controllerRef.current;
    if (!controller) return false;
    const sent = controller.send(JSON.stringify(msg));
    if (sent) recordClientMessageForSend(msg);
    return sent;
  }, []);

  return { send };
}
