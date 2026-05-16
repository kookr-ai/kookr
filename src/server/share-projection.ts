import type { AttentionQueue } from '../core/attention-queue.js';
import type { Task } from '../core/tasks.js';
import type { NodeId } from '../remote/ids.js';
import type { RemoteTaskProjectionStatus, RemoteTaskProjectionV1 } from '../remote/share-contract.js';

export const REMOTE_TASK_LABEL_MAX_LENGTH = 80;

function hasNeedsInputFinding(task: Task, queue?: AttentionQueue): boolean {
  return task.sessions.some((session) => queue?.peek(session.tmuxSession)?.type === 'needs_input');
}

function hasAnyFinding(task: Task, queue?: AttentionQueue): boolean {
  return task.sessions.some((session) => queue?.peek(session.tmuxSession) !== null);
}

export function sanitizeRemoteTaskLabel(input: string | undefined, taskId: string): string {
  const raw = input ?? '';
  const filtered = raw
    .replace(/[^A-Za-z0-9 .,!?@#:()+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REMOTE_TASK_LABEL_MAX_LENGTH)
    .trim();
  return filtered.length > 0 ? filtered : `Task ${taskId.slice(0, 8)}`;
}

function toProjectionStatus(task: Task, needsInput: boolean): RemoteTaskProjectionStatus {
  if (needsInput && task.status !== 'completed' && task.status !== 'terminated' && task.status !== 'cancelled') {
    return 'needsInput';
  }
  switch (task.status) {
    case 'open':
      return 'open';
    case 'pending':
      return 'pending';
    case 'inProgress':
      return 'inProgress';
    case 'completed':
      return 'completed';
    case 'terminated':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function projectTaskForRemoteShare(
  task: Task,
  opts: { nodeId: NodeId; queue?: AttentionQueue },
): RemoteTaskProjectionV1 {
  const needsInput = hasNeedsInputFinding(task, opts.queue);
  return {
    schemaVersion: 'remote-task-projection.v1',
    nodeId: opts.nodeId,
    taskId: task.id,
    taskLabel: sanitizeRemoteTaskLabel(task.name, task.id),
    status: toProjectionStatus(task, needsInput),
    hasFinding: hasAnyFinding(task, opts.queue),
    needsInput,
    updatedAt: task.updatedAt.toISOString(),
  };
}
