import { apiFetch, fetchJson, fetchResult, getJson, type ApiResult } from './client.js';
import type { AgentType } from '../../shared/contracts/agent-types.js';
import { parseTaskArchivePage, type TaskArchivePage } from '../completed-history.js';

/**
 * GET one task's full detail (prompt/criteria bodies), the payload the compact
 * list projection omits. Throws {@link ApiError} on a non-2xx.
 */
export function getTask<T>(taskId: string): Promise<T> {
  return getJson<T>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

/** GET the compact task list (cwd + session ids only). Throws on a non-2xx. */
export function getCompactTasks<T>(): Promise<T> {
  return getJson<T>('/api/tasks?view=compact');
}

/**
 * PATCH a task's dependency edges. Parses the body before inspecting `ok`
 * (matching the inline call) so the caller can surface a server error message.
 */
export function patchTaskEdges<T>(taskId: string, next: unknown): Promise<ApiResult<T>> {
  return fetchJson<T>(`/api/tasks/${encodeURIComponent(taskId)}/edges`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
}

async function getLatestOrThrow<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await apiFetch(path, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed with ${res.status}`);
  }
  // Strict success parse: a 2xx with an empty/unparseable body rejects (driving
  // the panel into its error state), matching the panels' original inline
  // `return res.json()` rather than yielding a `null` "ready" projection.
  return (await res.json()) as T;
}

/**
 * GET the evolution-run projection for a task. On a non-2xx throws the server's
 * `error` message, falling back to `Request failed with <status>`.
 */
export function getEvolutionRun<T>(taskId: string, signal: AbortSignal): Promise<T> {
  return getLatestOrThrow<T>(`/api/tasks/${encodeURIComponent(taskId)}/evolution`, signal);
}

/**
 * GET the Ralph-loop iteration read model for a task. Same error convention as
 * {@link getEvolutionRun}.
 */
export function getRalphLoopIterations<T>(taskId: string, signal: AbortSignal): Promise<T> {
  return getLatestOrThrow<T>(`/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/iterations`, signal);
}

/**
 * GET a task's suggested verification commands (the agent's "here's how to check
 * my work" steps). The terminal snapshot sheds `completionDigest.verificationCommands`
 * for payload size, so the Completed pane hydrates them from `GET /api/tasks/:id`.
 *
 * Returns the cleaned, non-empty command strings, or `[]` on a non-2xx, an
 * `{ error }` body, a missing field, or a malformed payload — so the caller can
 * render read-only with no error branch. Aborting the signal rejects the fetch.
 */
export async function getTaskVerificationCommands(taskId: string, signal: AbortSignal): Promise<string[]> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { signal });
  if (!res.ok) return [];
  const task = (await res.json().catch(() => null)) as
    | { error?: string; completionDigest?: { verificationCommands?: unknown } }
    | null;
  if (!task || task.error) return [];
  const raw = task.completionDigest?.verificationCommands;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

// --- Cross-agent task migration (RFC: rfc-cross-agent-task-migration) -----

/** One eligible migration candidate, as returned by `GET /api/tasks/migratable`. */
export interface MigratableEligibleCandidate {
  taskId: string;
  name: string | null;
  cwd: string;
  fromAgent: AgentType;
  status: string;
  eligible: true;
  worktreeShared: boolean;
}

/** One ineligible candidate, carrying the stable machine-readable block reason. */
export interface MigratableBlockedCandidate {
  taskId: string;
  eligible: false;
  reason: string;
  worktreeShared: boolean | null;
}

export type MigratableCandidate = MigratableEligibleCandidate | MigratableBlockedCandidate;

export interface MigratableResponse {
  targetAgent: AgentType;
  candidates: MigratableCandidate[];
}

export interface MigratableQuery {
  targetAgent: AgentType;
  fromAgent?: AgentType;
  includeCancelled?: boolean;
  onlyIsolated?: boolean;
}

/**
 * GET the migratable-candidate preview for a target agent. Returns the
 * ok/status/body envelope (rather than throwing) so callers — the batch
 * dialog's live count — can treat a transient failure as "unknown" instead of
 * an unhandled rejection.
 */
export function getMigratableTasks(
  query: MigratableQuery,
  signal?: AbortSignal,
): Promise<ApiResult<MigratableResponse | { error: string } | null>> {
  const params = new URLSearchParams({ targetAgent: query.targetAgent });
  if (query.fromAgent) params.set('fromAgent', query.fromAgent);
  if (query.includeCancelled) params.set('includeCancelled', 'true');
  if (query.onlyIsolated) params.set('onlyIsolated', 'true');
  return fetchResult<MigratableResponse | { error: string }>(
    `/api/tasks/migratable?${params.toString()}`,
    signal ? { signal } : undefined,
  );
}

export type MigrateOutcome = 'migrated' | 'queued' | 'blocked';

export interface MigrateTaskResult {
  taskId: string;
  outcome: MigrateOutcome;
  reason?: string;
  newTaskId?: string;
  worktreeShared?: boolean;
}

export type MigrateScopeInput =
  | { kind: 'ids'; taskIds: string[] }
  | { kind: 'all'; fromAgent?: AgentType; includeCancelled?: boolean };

export interface MigrateTasksRequestBody {
  targetAgent: AgentType;
  scope: MigrateScopeInput;
  effort?: string;
  setAsDefault?: boolean;
  onlyIsolated?: boolean;
}

export interface MigrateTasksResponse {
  targetAgent: AgentType;
  defaultUpdated: boolean;
  defaultUpdateReason?: string;
  results: MigrateTaskResult[];
}

/**
 * POST a migration request (single task or batch — see {@link MigrateScopeInput}).
 * Returns the ok/status/body envelope; the body is either the success shape
 * (narrow on `'results' in body`) or `{ error }` on a non-2xx.
 */
export function migrateTasks(
  body: MigrateTasksRequestBody,
): Promise<ApiResult<MigrateTasksResponse | { error: string }>> {
  return fetchJson<MigrateTasksResponse | { error: string }>('/api/tasks/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface ArchivedTasksQuery {
  limit?: number;
  /** ISO timestamp or epoch-ms; exclusive upper bound on lastActivityMs. */
  before?: string | number;
  cursor?: string;
}

/**
 * GET one page of durable terminal-task history (issue #2765/#2760). Throws
 * {@link ApiError} on a non-2xx, or an Error when the 2xx body is not a
 * `task-archive.v1` page — the Completed-history UI treats either as the
 * visible archive-error state.
 */
export async function getArchivedTasks(
  query: ArchivedTasksQuery = {},
  signal?: AbortSignal,
): Promise<TaskArchivePage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.before !== undefined) params.set('before', String(query.before));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const path = qs ? `/api/tasks/archive?${qs}` : '/api/tasks/archive';
  const body = await getJson<unknown>(path, signal ? { signal } : undefined);
  const parsed = parseTaskArchivePage(body);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}
