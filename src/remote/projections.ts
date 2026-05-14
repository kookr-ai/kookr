import type { Task } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

export interface ReplayableTaskProjection {
  taskId: string;
  status: Task['status'];
  updatedAt: string;
  sessionIds: string[];
}

export interface ReplayableAlertProjection {
  agentId: string;
  severity: Extract<ServerMessage, { type: 'alert' }>['severity'];
  summary: string;
  serverRevision?: number;
}

export function projectTaskForRemoteReplay(task: Task): ReplayableTaskProjection {
  return {
    taskId: task.id,
    status: task.status,
    updatedAt: task.updatedAt.toISOString(),
    sessionIds: task.sessions.map((session) => session.tmuxSession),
  };
}

export function projectAlertForRemoteReplay(
  alert: Extract<ServerMessage, { type: 'alert' }>,
  serverRevision?: number,
): ReplayableAlertProjection {
  return {
    agentId: alert.agentId,
    severity: alert.severity,
    summary: alert.summary,
    ...(serverRevision !== undefined ? { serverRevision } : {}),
  };
}
