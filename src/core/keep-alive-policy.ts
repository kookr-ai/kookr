/**
 * Who may keep a warned task alive, and for how long (issue #4241).
 *
 * `POST /api/tasks/:id/keep-alive` extends the deadline of a task the
 * hungSuspect TTL reclaim (or the 3h hung-task reaper) has warned. The caller
 * names itself with its own `KOOKR_TASK_ID`, which `kookr keep-alive` sends:
 *
 * - no caller task id: the operator, at a terminal or a script;
 * - the target's parent (`target.parentTaskId === callerTaskId`): the lead
 *   that started the worker and knows why it is silent;
 * - anyone else, including the task itself, is refused. A silent task that
 *   could extend itself would never be reclaimed.
 *
 * The server listens on loopback with no per-task credential, so the caller id
 * is taken on trust: this rule stops an agent from extending a task by
 * mistake, not one that lies about who it is.
 *
 * Pure: no I/O, no clock.
 */

import { MAX_AGENT_KEEP_ALIVE_MS } from './reap-warning-coordinator.js';
import { sanitizeCommand } from './long-running-jobs.js';

/** Longest reason kept on the warning, the audit row and the disposition. */
export const MAX_KEEP_ALIVE_REASON_CHARS = 300;

export interface KeepAliveTaskView {
  id: string;
  name?: string;
  parentTaskId?: string;
}

export type KeepAliveAuthorization =
  | { ok: true; actor: string; actorName: string }
  | { ok: false; status: 403; code: 'self_keep_alive' | 'not_parent'; message: string };

export function authorizeKeepAlive(input: {
  target: KeepAliveTaskView;
  callerTaskId?: string;
  getTask: (id: string) => KeepAliveTaskView | undefined;
}): KeepAliveAuthorization {
  const caller = input.callerTaskId?.trim();
  if (!caller) return { ok: true, actor: 'operator', actorName: 'operator' };
  if (caller === input.target.id) {
    return {
      ok: false,
      status: 403,
      code: 'self_keep_alive',
      message: 'A task cannot keep itself alive. Its parent task or the operator can.',
    };
  }
  if (input.target.parentTaskId !== caller) {
    return {
      ok: false,
      status: 403,
      code: 'not_parent',
      message: `Task ${caller} is not the parent of task ${input.target.id}. Only its parent task or the operator can keep it alive.`,
    };
  }
  const parent = input.getTask(caller);
  return { ok: true, actor: `task:${caller}`, actorName: parent?.name?.trim() || caller };
}

export type KeepAliveRequestParse =
  | { ok: true; forMs: number; reason: string; callerTaskId?: string }
  | { ok: false; message: string };

/** Validate the JSON body `{ forMs, reason, callerTaskId? }`. */
export function parseKeepAliveRequest(body: unknown): KeepAliveRequestParse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.forMs !== 'number' || !Number.isFinite(o.forMs) || o.forMs <= 0) {
    return { ok: false, message: 'forMs must be a positive number of milliseconds' };
  }
  if (o.forMs > MAX_AGENT_KEEP_ALIVE_MS) {
    return { ok: false, message: `one keep-alive is at most ${MAX_AGENT_KEEP_ALIVE_MS / 60_000} minutes` };
  }
  if (typeof o.reason !== 'string') return { ok: false, message: 'reason is required' };
  const reason = sanitizeCommand(o.reason, MAX_KEEP_ALIVE_REASON_CHARS);
  if (!reason) return { ok: false, message: 'reason is required' };
  if (o.callerTaskId !== undefined && typeof o.callerTaskId !== 'string') {
    return { ok: false, message: 'callerTaskId must be a string' };
  }
  return {
    ok: true,
    forMs: Math.round(o.forMs),
    reason,
    ...(typeof o.callerTaskId === 'string' && o.callerTaskId.trim() ? { callerTaskId: o.callerTaskId.trim() } : {}),
  };
}

/** Shortest task-id prefix the route resolves (the `<id8>` in the parent line). */
export const MIN_KEEP_ALIVE_ID_PREFIX = 8;

export type TaskIdResolution =
  | { kind: 'found'; id: string }
  | { kind: 'ambiguous'; ids: string[] }
  | { kind: 'none' };

/** Resolve a full task id, or a prefix of at least 8 characters shared by exactly one task. */
export function resolveTaskIdRef(ids: readonly string[], ref: string): TaskIdResolution {
  if (ids.includes(ref)) return { kind: 'found', id: ref };
  if (ref.length < MIN_KEEP_ALIVE_ID_PREFIX) return { kind: 'none' };
  const matches = ids.filter((id) => id.startsWith(ref)).sort();
  if (matches.length === 1) return { kind: 'found', id: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', ids: matches };
  return { kind: 'none' };
}
