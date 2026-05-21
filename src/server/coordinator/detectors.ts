import { hashPrompt } from '../hash-prompt.js';
import { canonicalizeCwd } from '../launch-service.js';
import { normalizePromptFileReferences } from '../prompt-file-paths.js';
import type { Task } from '../../core/tasks.js';
import type { CoordinatorDetectorOutput } from '../../shared/contracts/coordinator.js';

export interface CoordinatorAuditTailProvider {
  getCoordinatorAuditTail(): CoordinatorAuditTailRow[];
}

export type CoordinatorTask = Task & {
  anomaly?: unknown;
  followUp?: unknown;
  followUpRequired?: boolean;
  nextAction?: unknown;
  metadata?: {
    intent?: string;
  };
};

export interface CoordinatorSnapshot {
  tasks: readonly CoordinatorTask[];
}

export interface CoordinatorAuditTailRow {
  taskId?: string;
  timestamp?: string | number | Date;
  observedAt?: string | number | Date;
  ts?: string | number | Date;
  hook_event_name?: string;
  rawHookEventName?: string;
  type?: string;
  event?: {
    type?: string;
  };
  envelope?: {
    taskId?: string;
    kookrSessionId?: string;
    observedAt?: string | number | Date;
    rawHookEventName?: string;
  };
}

export interface RunDetectorsOptions {
  now?: Date;
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

export function runDetectors(
  snapshot: CoordinatorSnapshot,
  auditTail: readonly CoordinatorAuditTailRow[],
  opts: RunDetectorsOptions = {},
): CoordinatorDetectorOutput[] {
  const { tasks } = snapshot;
  const now = opts.now ?? new Date();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return [
    ...detectStaleTasks(tasks, auditTail, now, staleAfterMs),
    ...detectDuplicateTasks(tasks),
    ...detectDoneNotClearedTasks(tasks),
  ];
}

function detectStaleTasks(
  tasks: readonly CoordinatorTask[],
  auditTail: readonly CoordinatorAuditTailRow[],
  now: Date,
  staleAfterMs: number,
): CoordinatorDetectorOutput[] {
  const taskIdsBySession = buildTaskIdsBySession(tasks);
  const lastPostToolUseByTask = new Map<string, Date>();

  for (const row of auditTail) {
    if (!isPostToolUseRow(row)) continue;
    const taskId = rowTaskId(row, taskIdsBySession);
    if (!taskId) continue;
    const observedAt = rowObservedAt(row);
    if (!observedAt) continue;
    const prior = lastPostToolUseByTask.get(taskId);
    if (!prior || observedAt > prior) lastPostToolUseByTask.set(taskId, observedAt);
  }

  const out: CoordinatorDetectorOutput[] = [];
  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const lastPostToolUseAt = lastPostToolUseByTask.get(task.id);
    const fallbackActivityAt = latestActiveSessionStartedAt(task);
    const activityAt = latestDate(lastPostToolUseAt, fallbackActivityAt);
    if (!activityAt) continue;

    const ageMs = now.getTime() - activityAt.getTime();
    if (ageMs < staleAfterMs) continue;
    out.push({
      detectorId: 'stale',
      taskId: task.id,
      evidence: {
        ageMs,
        staleAfterMs,
        lastPostToolUseAt: lastPostToolUseAt?.toISOString() ?? null,
        fallbackActivityAt: lastPostToolUseAt ? null : activityAt.toISOString(),
      },
    });
  }
  return out;
}

function detectDuplicateTasks(tasks: readonly CoordinatorTask[]): CoordinatorDetectorOutput[] {
  const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const groups = new Map<string, { promptHash: string; tasks: CoordinatorTask[] }>();

  for (const task of activeTasks) {
    if (task.metadata?.intent === 'keep_as_duplicate') continue;
    const promptHash = hashPrompt(normalizePromptFileReferences(task.prompt, task.cwd));
    const duplicateKey = `${task.agentType}\0${canonicalizeCwd(task.cwd)}\0${promptHash}`;
    const group = groups.get(duplicateKey) ?? { promptHash, tasks: [] };
    group.tasks.push(task);
    groups.set(duplicateKey, group);
  }

  const out: CoordinatorDetectorOutput[] = [];
  for (const { promptHash, tasks: group } of groups.values()) {
    if (group.length < 2) continue;
    const clusterTaskIds = group.map((task) => task.id).sort();
    const canonicalCwd = canonicalizeCwd(group[0]!.cwd);
    const agentType = group[0]!.agentType;
    for (const task of group) {
      out.push({
        detectorId: 'duplicate',
        taskId: task.id,
        evidence: {
          promptHash,
          agentType,
          canonicalCwd,
          clusterTaskIds,
          peerTaskIds: clusterTaskIds.filter((id) => id !== task.id),
        },
      });
    }
  }
  return out;
}

function detectDoneNotClearedTasks(tasks: readonly CoordinatorTask[]): CoordinatorDetectorOutput[] {
  const out: CoordinatorDetectorOutput[] = [];
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completionDigest) continue;
    if (hasFollowUpSignal(task)) continue;
    if (task.anomaly) continue;
    out.push({
      detectorId: 'done_not_cleared',
      taskId: task.id,
      evidence: {
        hasCompletionDigest: true,
        completionFeedbackPresent: Boolean(task.completionFeedback),
      },
    });
  }
  return out;
}

function hasFollowUpSignal(task: CoordinatorTask): boolean {
  if (task.followUpRequired === true) return true;
  if (task.followUp !== undefined && task.followUp !== null) return true;
  if (task.nextAction !== undefined && task.nextAction !== null) return true;
  return false;
}

function buildTaskIdsBySession(tasks: readonly CoordinatorTask[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const task of tasks) {
    for (const session of task.sessions ?? []) {
      if (session.tmuxSession) out.set(session.tmuxSession, task.id);
    }
  }
  return out;
}

function latestActiveSessionStartedAt(task: CoordinatorTask): Date | undefined {
  let latest: Date | undefined;
  for (const session of task.sessions ?? []) {
    if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
    const createdAt = parseDate(session.createdAt);
    if (!createdAt) continue;
    if (!latest || createdAt > latest) latest = createdAt;
  }
  return latest;
}

function latestDate(...dates: Array<Date | undefined>): Date | undefined {
  let latest: Date | undefined;
  for (const date of dates) {
    if (!date) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

function rowTaskId(row: CoordinatorAuditTailRow, taskIdsBySession: ReadonlyMap<string, string>): string | undefined {
  if (row.taskId) return row.taskId;
  if (row.envelope?.taskId) return row.envelope.taskId;
  if (row.envelope?.kookrSessionId) return taskIdsBySession.get(row.envelope.kookrSessionId);
  return undefined;
}

function rowObservedAt(row: CoordinatorAuditTailRow): Date | undefined {
  return parseDate(row.observedAt)
    ?? parseDate(row.timestamp)
    ?? parseDate(row.ts)
    ?? parseDate(row.envelope?.observedAt);
}

function isPostToolUseRow(row: CoordinatorAuditTailRow): boolean {
  return row.hook_event_name === 'PostToolUse'
    || row.rawHookEventName === 'PostToolUse'
    || row.envelope?.rawHookEventName === 'PostToolUse'
    || row.event?.type === 'tool_result'
    || row.type === 'tool_result';
}

function parseDate(value: string | number | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
