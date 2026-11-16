/**
 * Ready queue (issue #3933): an ordered, durable list of launch requests that
 * Kookr starts by itself, one per tick, when a slot for ordinary launches is
 * free and the host is not overloaded.
 *
 * It is NOT the overflow queue. The overflow queue (`pending` tasks, see
 * docs/reference/backpressure.md) holds launches that already became task
 * records and found no slot; it is capped at `maxPendingTasks` and expires
 * entries after `pendingTaskTtlMinutes`. A ready-queue entry is only a stored
 * `POST /api/tasks` request: no task exists until the tick starts it, so a
 * long backlog costs nothing and never expires.
 *
 * This module is pure: entry shapes, the per-tick go/no-go decision, the
 * bookkeeping after a launch attempt, and the on-disk format. The timer, the
 * file writes and the launch itself live in `src/server/ready-queue-service.ts`.
 */

export const READY_QUEUE_SCHEMA = 'ready-queue.v1' as const;
export const READY_QUEUE_FILE_NAME = 'ready-queue.json';
/** Failed launch attempts after which an entry is marked failed (issue #3933). */
export const READY_QUEUE_MAX_ATTEMPTS = 3;
/** Queued entries the store accepts; bounds the file and `kookr queue list`. */
export const READY_QUEUE_MAX_QUEUED = 500;
/** Started and failed entries stay listed this long, then are pruned. */
export const READY_QUEUE_FINISHED_RETENTION_MS = 24 * 60 * 60_000;
/** A head waiting at least this long is reported as stalled by `kookr status`. */
export const READY_QUEUE_STALL_MS = 15 * 60_000;

export type ReadyQueueEntryState = 'queued' | 'launching' | 'started' | 'failed';

export type ReadyQueueWaitReason =
  | 'no_free_slot'
  | 'host_load'
  | 'draining'
  | 'automation_paused'
  | 'retry_after'
  | 'launch_failed';

export const READY_QUEUE_WAIT_REASON_TEXT: Record<ReadyQueueWaitReason, string> = {
  no_free_slot: 'no free slot',
  host_load: 'host load',
  draining: 'server draining for a deploy',
  automation_paused: 'automation paused (SAFE MODE)',
  retry_after: 'server asked to retry later',
  launch_failed: 'last launch attempt failed; retrying',
};

/** Human form of a wait reason, as `/api/health` and `kookr status` print it. */
export function readyQueueWaitText(reason: ReadyQueueWaitReason): string {
  return `waiting: ${READY_QUEUE_WAIT_REASON_TEXT[reason]}`;
}

export interface ReadyQueueEntry {
  id: string;
  /** The `POST /api/tasks` body, exactly as `kookr spawn` built it. */
  request: Record<string, unknown>;
  /** `X-Kookr-Launch-Source` of the original enqueue (`cli`, `ui` or `api`). */
  launchSource: string;
  /** `X-Kookr-Actor` of the original enqueue, when one was sent. */
  actor?: string;
  /**
   * Idempotency key sent with every launch attempt. A crash between the launch
   * and the state write re-sends the same key, so the server replays the task
   * it already created instead of starting a second one.
   */
  idempotencyKey: string;
  state: ReadyQueueEntryState;
  enqueuedAt: string;
  /** Failed launch attempts so far ("retry later" refusals do not count). */
  attempts: number;
  /** ISO time before which the entry is not tried (a "retry after" answer). */
  notBefore?: string;
  /** Why the entry is not starting yet; set while it is the head. */
  waitReason?: ReadyQueueWaitReason;
  lastError?: string;
  /** Error code of the last refusal or failure, when the server gave one. */
  lastErrorCode?: string;
  taskId?: string;
  startedAt?: string;
  failedAt?: string;
  /** The one "launch failed" alert was sent (persisted so a restart does not resend it). */
  alerted?: boolean;
}

export interface ReadyQueueFile {
  schema: typeof READY_QUEUE_SCHEMA;
  entries: ReadyQueueEntry[];
}

/** Inputs the tick reads once; every gate fails closed except host load (see below). */
export interface ReadyQueueGateInputs {
  /** False while the server drains for a deploy. */
  accepting: boolean;
  /** False in SAFE MODE (automation kill switch). */
  automationEnabled: boolean;
  /** Free slots in the whole pool. */
  free: number;
  /** Free slots once the reserved slots are kept back; absent when none are reserved. */
  freeForGeneralSources?: number;
  /** Launches already waiting in the overflow queue. */
  pendingQueueDepth: number;
  /** Host 1-minute load average divided by CPU count; null when unavailable. */
  loadPerCpu: number | null;
  /** Load-per-CPU limit; `0` disables the check. */
  maxLoadPerCpu: number;
}

export type ReadyQueueTickDecision =
  | { kind: 'idle' }
  | { kind: 'wait'; entryId: string; reason: ReadyQueueWaitReason }
  | { kind: 'launch'; entryId: string };

/** The entry the next tick may start: the oldest one still queued. */
export function readyQueueHead(entries: readonly ReadyQueueEntry[]): ReadyQueueEntry | undefined {
  return entries.find((entry) => entry.state === 'queued');
}

/**
 * Decide what one tick does. Strictly in order: only the head is considered,
 * so an entry never overtakes an older one.
 *
 * Slot rule: start only when a slot for ordinary launches is free AND the
 * overflow queue is empty. The reserved slots stay reserved (a queued launch
 * is an ordinary launch), and a launch started while others already pend would
 * only join the overflow queue, where it can expire.
 *
 * Host load fails open: an unreadable load sample does not block the queue,
 * the same rule the launch-time host-load gate uses.
 */
export function decideReadyQueueTick(
  entries: readonly ReadyQueueEntry[],
  gates: ReadyQueueGateInputs,
  nowMs: number,
): ReadyQueueTickDecision {
  const head = readyQueueHead(entries);
  if (!head) return { kind: 'idle' };
  const wait = (reason: ReadyQueueWaitReason): ReadyQueueTickDecision => ({
    kind: 'wait',
    entryId: head.id,
    reason,
  });
  if (!gates.accepting) return wait('draining');
  if (!gates.automationEnabled) return wait('automation_paused');
  if (head.notBefore !== undefined) {
    const notBeforeMs = Date.parse(head.notBefore);
    if (Number.isFinite(notBeforeMs) && notBeforeMs > nowMs) {
      return wait('retry_after');
    }
  }
  const generalFree = Math.min(gates.free, gates.freeForGeneralSources ?? gates.free);
  if (generalFree < 1 || gates.pendingQueueDepth > 0) return wait('no_free_slot');
  if (
    gates.maxLoadPerCpu > 0
    && gates.loadPerCpu !== null
    && Number.isFinite(gates.loadPerCpu)
    && gates.loadPerCpu > gates.maxLoadPerCpu
  ) {
    return wait('host_load');
  }
  return { kind: 'launch', entryId: head.id };
}

/** What one launch attempt returned, already classified by the service. */
export type ReadyQueueLaunchOutcome =
  | { kind: 'started'; taskId: string }
  /** The server refused for now ("retry later"); not a failed attempt. */
  | {
      kind: 'refused';
      reason: Extract<ReadyQueueWaitReason, 'retry_after' | 'host_load' | 'draining' | 'no_free_slot'>;
      retryAfterMs?: number;
      error: string;
      code?: string;
    }
  /** The launch failed to start; counts as one attempt. */
  | { kind: 'failed'; error: string; code?: string };

export interface ApplyLaunchOutcomeResult {
  entry: ReadyQueueEntry;
  /** True exactly once: when this outcome moved the entry to `failed`. */
  becameFailed: boolean;
}

/** Return the entry as it stands after a launch attempt. Pure; never mutates. */
export function applyReadyQueueLaunchOutcome(
  entry: ReadyQueueEntry,
  outcome: ReadyQueueLaunchOutcome,
  nowMs: number,
): ApplyLaunchOutcomeResult {
  const nowIso = new Date(nowMs).toISOString();
  const base: ReadyQueueEntry = { ...entry };
  delete base.notBefore;
  delete base.waitReason;
  if (outcome.kind === 'started') {
    delete base.lastError;
    delete base.lastErrorCode;
    return {
      entry: { ...base, state: 'started', taskId: outcome.taskId, startedAt: nowIso },
      becameFailed: false,
    };
  }
  if (outcome.kind === 'refused') {
    return {
      entry: {
        ...base,
        state: 'queued',
        waitReason: outcome.reason,
        lastError: outcome.error,
        ...(outcome.code ? { lastErrorCode: outcome.code } : {}),
        ...(outcome.retryAfterMs !== undefined && outcome.retryAfterMs > 0
          ? { notBefore: new Date(nowMs + outcome.retryAfterMs).toISOString() }
          : {}),
      },
      becameFailed: false,
    };
  }
  const attempts = entry.attempts + 1;
  const failed = attempts >= READY_QUEUE_MAX_ATTEMPTS;
  return {
    entry: {
      ...base,
      attempts,
      state: failed ? 'failed' : 'queued',
      lastError: outcome.error,
      ...(outcome.code ? { lastErrorCode: outcome.code } : {}),
      ...(failed ? { failedAt: nowIso } : { waitReason: 'launch_failed' as const }),
    },
    becameFailed: failed,
  };
}

/**
 * Boot recovery. An entry found `launching` was being started when the server
 * stopped, so whether its task exists is unknown. It goes back to `queued` in
 * the same place; the next tick re-sends the same idempotency key, and the
 * server either replays the task it created or starts it now. Either way it
 * starts once.
 */
export function recoverReadyQueueEntries(entries: readonly ReadyQueueEntry[]): ReadyQueueEntry[] {
  return entries.map((entry) => (entry.state === 'launching' ? { ...entry, state: 'queued' } : entry));
}

/** Drop started and failed entries older than the retention window. */
export function pruneReadyQueueEntries(
  entries: readonly ReadyQueueEntry[],
  nowMs: number,
  retentionMs: number = READY_QUEUE_FINISHED_RETENTION_MS,
): ReadyQueueEntry[] {
  return entries.filter((entry) => {
    const finishedAt = entry.state === 'started'
      ? entry.startedAt
      : entry.state === 'failed'
        ? entry.failedAt
        : undefined;
    if (finishedAt === undefined) return true;
    const finishedMs = Date.parse(finishedAt);
    return !Number.isFinite(finishedMs) || nowMs - finishedMs < retentionMs;
  });
}

const ENTRY_STATES: ReadonlySet<string> = new Set(['queued', 'launching', 'started', 'failed']);

function isEntry(value: unknown): value is ReadyQueueEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.request === 'object' && v.request !== null && !Array.isArray(v.request)
    && typeof v.launchSource === 'string'
    && typeof v.idempotencyKey === 'string'
    && typeof v.state === 'string' && ENTRY_STATES.has(v.state)
    && typeof v.enqueuedAt === 'string'
    && typeof v.attempts === 'number' && Number.isInteger(v.attempts) && v.attempts >= 0;
}

/**
 * Parse the queue file. Malformed entries are dropped one by one (and counted)
 * rather than discarding the whole queue; a file with the wrong shape or schema
 * throws so the caller can keep the bad file aside instead of overwriting it.
 */
export function parseReadyQueueFile(raw: string): { entries: ReadyQueueEntry[]; dropped: number } {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ready queue file is not a JSON object');
  }
  const file = parsed as { schema?: unknown; entries?: unknown };
  if (file.schema !== READY_QUEUE_SCHEMA) {
    throw new Error(`ready queue file has schema ${JSON.stringify(file.schema)}, expected ${READY_QUEUE_SCHEMA}`);
  }
  if (!Array.isArray(file.entries)) throw new Error('ready queue file has no entries array');
  const entries = file.entries.filter(isEntry);
  return { entries, dropped: file.entries.length - entries.length };
}

export function serializeReadyQueueFile(entries: readonly ReadyQueueEntry[]): string {
  const file: ReadyQueueFile = { schema: READY_QUEUE_SCHEMA, entries: [...entries] };
  return `${JSON.stringify(file, null, 2)}\n`;
}
