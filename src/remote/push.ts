import type { RemoteNodeClient } from './node-client.js';
import type { RemoteStateDeltaEvent } from './control-events.js';
import type { ServerRevision } from './ids.js';
import type { Task } from '../core/tasks.js';

export type PushAlertKind = 'blocked' | 'permission-requested' | 'findings' | 'approval-updated';

export interface RedactedPushPayload {
  redactor: 'redactor.v1';
  nodeDisplayName: string;
  taskShortLabel: string;
  alertKind: PushAlertKind;
  alertId: string;
}

export interface PushAlertDeltaPayload {
  type: 'push.alert';
  payload: RedactedPushPayload;
}

const TASK_LABEL_ALLOWLIST = /[^A-Za-z0-9 .,!?-]+/g;
const MIN_SAFE_LABEL_LENGTH = 4;
const MAX_TASK_LABEL_LENGTH = 64;

const SECRET_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]{16,}\b/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{24,}={0,2}\b/g,
];

export function isPushDisabled(env: Partial<Pick<NodeJS.ProcessEnv, 'KOOKR_PUSH_DISABLED'>> = process.env): boolean {
  return env.KOOKR_PUSH_DISABLED === 'true';
}

export function taskLabelFallback(taskId: string): string {
  return `Task ${taskId.slice(0, 8)}`;
}

export function redactTaskShortLabel(input: string | undefined, taskId: string): string {
  const raw = input ?? '';
  if (SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(raw);
  })) {
    return taskLabelFallback(taskId);
  }

  const filtered = raw
    .replace(TASK_LABEL_ALLOWLIST, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TASK_LABEL_LENGTH)
    .trim();

  return filtered.length >= MIN_SAFE_LABEL_LENGTH ? filtered : taskLabelFallback(taskId);
}

export function makeRedactedPushPayload(opts: {
  nodeDisplayName?: string;
  taskId: string;
  taskLabel?: string;
  alertKind: PushAlertKind;
  alertId: string;
}): RedactedPushPayload {
  return {
    redactor: 'redactor.v1',
    nodeDisplayName: opts.nodeDisplayName?.trim() || 'Kookr',
    taskShortLabel: redactTaskShortLabel(opts.taskLabel, opts.taskId),
    alertKind: opts.alertKind,
    alertId: opts.alertId,
  };
}

export function makePermissionBlockedPushPayload(opts: {
  nodeDisplayName?: string;
  task: Task;
  alertId: string;
}): RedactedPushPayload {
  return makeRedactedPushPayload({
    nodeDisplayName: opts.nodeDisplayName,
    taskId: opts.task.id,
    taskLabel: opts.task.name ?? opts.task.prompt,
    alertKind: 'permission-requested',
    alertId: opts.alertId,
  });
}

export function publishPushAlertDelta(
  client: RemoteNodeClient | null,
  payload: RedactedPushPayload,
  opts: { now?: () => Date; env?: Partial<Pick<NodeJS.ProcessEnv, 'KOOKR_PUSH_DISABLED'>> } = {},
): boolean {
  if (!client || isPushDisabled(opts.env)) return false;
  const status = client.status;
  if (!status.relayConnected) return false;

  const event: RemoteStateDeltaEvent<PushAlertDeltaPayload> = {
    nodeId: status.nodeId,
    nodeEpoch: status.nodeEpoch,
    serverRevision: Date.now() as ServerRevision,
    ts: (opts.now ?? (() => new Date()))().toISOString(),
    kind: 'state.delta',
    payload: {
      type: 'push.alert',
      payload,
    },
  };
  return client.publish(event);
}

export function isPushAlertDeltaPayload(value: unknown): value is PushAlertDeltaPayload {
  const msg = value as Partial<PushAlertDeltaPayload>;
  return typeof value === 'object'
    && value !== null
    && msg.type === 'push.alert'
    && isRedactedPushPayload(msg.payload);
}

export function isRedactedPushPayload(value: unknown): value is RedactedPushPayload {
  const msg = value as Partial<RedactedPushPayload>;
  const keys = typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
  return typeof value === 'object'
    && value !== null
    && JSON.stringify(keys) === JSON.stringify(['alertId', 'alertKind', 'nodeDisplayName', 'redactor', 'taskShortLabel'])
    && msg.redactor === 'redactor.v1'
    && typeof msg.nodeDisplayName === 'string'
    && typeof msg.taskShortLabel === 'string'
    && (msg.alertKind === 'blocked' || msg.alertKind === 'permission-requested' || msg.alertKind === 'findings' || msg.alertKind === 'approval-updated')
    && typeof msg.alertId === 'string';
}
