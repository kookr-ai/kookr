import type { AgentState } from '../shared/protocol.js';
import { isTerminalStatus, type TaskStatus } from '../shared/contracts/task-status.js';
import { compareCompletedAgents, computeFinishedAtMs } from './agent-buckets.js';

/**
 * Older completed-task history (issue #2760).
 *
 * Live dashboard snapshots only keep a bounded completed tail (active tasks
 * plus the seven-day daily/predelete window). Records past that window live in
 * the durable archive (`GET /api/tasks/archive`). This module is the client
 * contract for paging that archive: parse a page, merge it with live rows
 * without duplicates, and compute the `before` bound so the default view
 * never requests the full archive.
 */

/** Schema id returned by `GET /api/tasks/archive`. */
export const TASK_ARCHIVE_SCHEMA_VERSION = 'task-archive.v1';

/** Page size for the Completed-history "Load older" control. Smaller than the
 *  server default (50) so a click stays responsive. */
export const COMPLETED_HISTORY_PAGE_LIMIT = 20;

/** How many all-duplicate archive pages to skip automatically before giving
 *  the user another click. Live rows often overlap the newest archive page. */
export const MAX_EMPTY_ARCHIVE_PAGE_SKIPS = 5;

/** Wire shape of one archived task. Dates arrive as ISO strings. */
export interface ArchivedTaskJson {
  id?: unknown;
  taskId?: unknown;
  name?: unknown;
  status?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  userPrompt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  finishedAt?: unknown;
  terminatedAt?: unknown;
  agentType?: unknown;
  projectId?: unknown;
  playbookId?: unknown;
  playbookParameterValues?: unknown;
  priority?: unknown;
  tokenUsage?: unknown;
  completionDigest?: unknown;
  completionFeedback?: unknown;
  ralphLoop?: unknown;
  unattended?: unknown;
  operatorNeeded?: unknown;
  parentTaskId?: unknown;
  childTaskIds?: unknown;
  blocks?: unknown;
  blocked_by?: unknown;
  sessions?: unknown;
  disposition?: unknown;
  metadata?: unknown;
}

export interface ArchivedTaskRecordJson {
  archivedAt: string;
  lastActivityMs: number;
  task: ArchivedTaskJson;
}

export interface TaskArchivePage {
  schemaVersion: typeof TASK_ARCHIVE_SCHEMA_VERSION;
  count: number;
  records: ArchivedTaskRecordJson[];
  nextCursor?: string;
  skippedCorruptLines?: number;
}

function isTaskArchivePage(value: unknown): value is TaskArchivePage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Partial<TaskArchivePage>;
  if (page.schemaVersion !== TASK_ARCHIVE_SCHEMA_VERSION) return false;
  if (typeof page.count !== 'number' || !Number.isFinite(page.count)) return false;
  if (!Array.isArray(page.records)) return false;
  if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') return false;
  return page.records.every(isArchivedTaskRecord);
}

function isArchivedTaskRecord(value: unknown): value is ArchivedTaskRecordJson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<ArchivedTaskRecordJson>;
  return typeof record.archivedAt === 'string'
    && typeof record.lastActivityMs === 'number'
    && Number.isFinite(record.lastActivityMs)
    && !!record.task
    && typeof record.task === 'object'
    && !Array.isArray(record.task);
}

/** Parse a `GET /api/tasks/archive` body. Returns an Error for a malformed page
 *  so the caller can show the archive-error state instead of throwing through
 *  the UI. */
export function parseTaskArchivePage(body: unknown): TaskArchivePage | Error {
  if (!isTaskArchivePage(body)) {
    return new Error('Older history response was not a task-archive page');
  }
  return body;
}

export function liveTerminalTaskIds(agents: readonly AgentState[]): Set<string> {
  const ids = new Set<string>();
  for (const agent of agents) {
    if (!agent.taskId || !isTerminalTaskStatus(agent.taskStatus)) continue;
    ids.add(agent.taskId);
  }
  return ids;
}

function isTerminalTaskStatus(status: AgentState['taskStatus']): status is TaskStatus {
  return status !== undefined && isTerminalStatus(status);
}

/** Oldest live completed/cancelled/terminated finish time, used as `before`
 *  so the first archive page starts after what the snapshot already shows. */
export function oldestLiveCompletedMs(agents: readonly AgentState[]): number | null {
  let oldest: number | null = null;
  for (const agent of agents) {
    if (!isTerminalTaskStatus(agent.taskStatus)) continue;
    const ms = computeFinishedAtMs(agent);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest;
}

/**
 * Live completed rows are kept as-is (the snapshot already decided membership).
 * Archived rows append only when their task id is not already on a live row,
 * so paging older history cannot duplicate the bounded snapshot.
 */
export function mergeCompletedHistory(
  live: readonly AgentState[],
  archived: readonly AgentState[],
): AgentState[] {
  const liveIds = new Set(
    live.map((agent) => agent.taskId).filter((id): id is string => Boolean(id)),
  );
  const seenArchived = new Set<string>();
  const extra: AgentState[] = [];
  for (const agent of archived) {
    const id = agent.taskId ?? agent.agentId;
    if (liveIds.has(id) || seenArchived.has(id)) continue;
    seenArchived.add(id);
    extra.push(agent);
  }
  return [...live, ...extra].sort(compareCompletedAgents);
}

export function scopeArchivedAgents(
  archived: readonly AgentState[],
  selectedProject: string | null,
): AgentState[] {
  if (!selectedProject) return [...archived];
  return archived.filter((agent) => agent.projectId === selectedProject);
}

export function archiveErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'body' in err) {
    const body = (err as { body: unknown }).body;
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Failed to load older history';
}
