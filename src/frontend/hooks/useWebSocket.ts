import { useEffect, useRef, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { initTelemetry, track } from '../telemetry.js';
import type { ClientMessage } from '../../shared/protocol.js';

const RECONNECT_DELAY_MS = 2000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const disconnectedAtRef = useRef<number | null>(null);
  const hasConnectedRef = useRef(false);
  const {
    handleSnapshot,
    handleUpdate,
    handleAlert,
    handleGitHubUpdate,
    handlePlaybooks,
    handleSuggestion,
    handleProjectSummaries,
    handleAchievementUnlocked,
    handleQuotaStatus,
    handleCircuitBreakerStatus,
    handleDiagnosticReport,
    handleSchedules,
    handleWorkspaceView,
    handleWorkspaceCleanupDetail,
    handleWorkspaceStartWorkAck,
    handleSweepComplete,
    handleSweepBusy,
    handleOssAttempts,
    setConnected,
  } = useKookrStore();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
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
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
          }
        }, sessionId);
        track({ type: 'session_started', agentCount: useKookrStore.getState().agents.length });
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'snapshot':
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
            );
            // Fetch schedules on initial snapshot (connection established)
            fetch('/api/schedules').then(r => r.json()).then(handleSchedules).catch(() => {});
            break;
          case 'update':
            handleUpdate(msg.agentId, msg.state);
            break;
          case 'alert': {
            const severity = msg.severity === 'critical' || msg.severity === 'warning' ? 'error' : 'info';
            handleAlert(msg.agentId, msg.summary, severity);
            break;
          }
          case 'githubUpdate':
            handleGitHubUpdate(msg.taskId, msg.prs, msg.issues, msg.changes);
            break;
          case 'playbooks':
            handlePlaybooks(msg.playbooks, msg.cwd);
            break;
          case 'suggestion':
            handleSuggestion(msg.agentId, msg.suggestions, msg.quickActions);
            break;
          case 'projectSummaries':
            handleProjectSummaries(msg.projects);
            break;
          case 'contributionWarning':
            handleAlert('', msg.message, msg.severity === 'exceeded' ? 'error' : 'info');
            break;
          case 'achievement:unlocked':
            handleAchievementUnlocked({
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
            handleQuotaStatus(msg.quota);
            break;
          case 'circuitBreakerStatus':
            handleCircuitBreakerStatus(msg.breakers);
            break;
          case 'diagnosticReport':
            handleDiagnosticReport(msg.report);
            break;
          case 'schedules':
            handleSchedules({ revision: msg.revision, schedules: msg.schedules, status: msg.status });
            break;
          case 'scheduleFired':
            fetch('/api/schedules').then(r => r.json()).then(handleSchedules).catch(() => {});
            break;
          case 'workspaceView':
            handleWorkspaceView(msg.view, msg.error, msg.cleanupResult, msg.cleanupResults, msg.diagnosticLaunch);
            break;
          case 'workspaceCleanupDetail':
            handleWorkspaceCleanupDetail(msg.worktreePath, msg.detail, msg.error);
            break;
          case 'workspaceStartWorkAck':
            handleWorkspaceStartWorkAck(msg);
            break;
          case 'workspaceSweepComplete':
            handleSweepComplete({
              runId: msg.runId,
              startedAt: msg.startedAt,
              finishedAt: msg.finishedAt,
              projects: msg.projects,
            });
            break;
          case 'workspaceSweepBusy':
            handleSweepBusy({ holderPid: msg.holderPid, heldSince: msg.heldSince });
            break;
          case 'ossAttempts':
            handleOssAttempts(msg.store);
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (disconnectedAtRef.current === null) {
        disconnectedAtRef.current = Date.now();
      }
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [handleSnapshot, handleUpdate, handleAlert, handleGitHubUpdate, handlePlaybooks, handleSuggestion, handleProjectSummaries, handleAchievementUnlocked, handleQuotaStatus, handleCircuitBreakerStatus, handleDiagnosticReport, handleSchedules, handleWorkspaceView, handleWorkspaceCleanupDetail, handleWorkspaceStartWorkAck, handleSweepComplete, handleSweepBusy, handleOssAttempts, setConnected]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  return { send };
}
