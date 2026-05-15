import type { Task } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { PushAlertKind } from './push.js';

export interface ReplayableTaskProjection {
  taskId: string;
  taskShortLabel: string;
  status: Task['status'];
  agentType?: Task['agentType'];
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
}

export interface ReplayableAlertProjection {
  alertId: string;
  agentId: string;
  alertKind: PushAlertKind;
  severity: Extract<ServerMessage, { type: 'alert' }>['severity'];
  summary: string;
  serverRevision?: number;
}

export function projectTaskForRemoteReplay(task: Task): ReplayableTaskProjection {
  return {
    taskId: task.id,
    taskShortLabel: redactReplayTaskShortLabel(task.name ?? task.prompt, task.id),
    status: task.status,
    agentType: task.agentType,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    sessionIds: task.sessions.map((session) => session.tmuxSession),
  };
}

function redactReplayTaskShortLabel(input: string | undefined, taskId: string): string {
  // Keep this local instead of importing push.ts: the remote load-purity gate
  // requires each src/remote runtime module to load without cascading imports.
  const raw = input ?? '';
  const secretPatterns = [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]{16,}\b/gi,
    /\b[A-Fa-f0-9]{32,}\b/g,
    /\b[A-Za-z0-9+/]{24,}={0,2}\b/g,
  ];
  if (secretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(raw);
  })) {
    return `Task ${taskId.slice(0, 8)}`;
  }

  const filtered = raw
    .replace(/[^A-Za-z0-9 .,!?-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  return filtered.length >= 4 ? filtered : `Task ${taskId.slice(0, 8)}`;
}

export function projectAlertForRemoteReplay(
  alert: Extract<ServerMessage, { type: 'alert' }>,
  serverRevision?: number,
): ReplayableAlertProjection {
  return {
    alertId: `${alert.agentId}:${serverRevision ?? 'local'}`,
    agentId: alert.agentId,
    alertKind: alert.severity === 'critical' ? 'blocked' : 'findings',
    severity: alert.severity,
    summary: alert.summary,
    ...(serverRevision !== undefined ? { serverRevision } : {}),
  };
}
