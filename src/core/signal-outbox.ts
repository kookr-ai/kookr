/**
 * Durable client-side signal outbox for agent → daemon signals (issue #1541).
 *
 * Agents run `kookr signal <verb>`. Delivery is fire-and-forget against the
 * local daemon; when the daemon is restarting / unreachable the signal used to
 * time out and leave the agent wedged in `finishedAwaitingAck` with a burned
 * final turn. The outbox write-behinds every signal **before** the HTTP POST
 * so a transient failure still exits 0 (durably queued). A background drain
 * (server-side service + opportunistic CLI retry) flushes the spool when the
 * daemon is reachable again. Server-side dedup is by `signalId`.
 *
 * Spool path is user-scoped (`~/.kookr/playbook-state/signal-outbox/`), same
 * trust boundary as the lesson-write spool (#1519).
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentSignalKind } from '../shared/contracts/agent-signal.js';
import { isAgentSignalKind } from '../shared/contracts/agent-signal.js';

export const SIGNAL_OUTBOX_SCHEMA = 'signal-outbox.v1' as const;
export const SIGNAL_OUTBOX_DIR_REL = join('playbook-state', 'signal-outbox');
export const SIGNAL_OUTBOX_PENDING_FILE = 'pending.jsonl';

/** Hard cap on pending entries so a long daemon outage cannot grow unbounded. */
export const DEFAULT_SIGNAL_OUTBOX_MAX_ENTRIES = 200;

/** Drop entries older than this (default 48h). */
export const DEFAULT_SIGNAL_OUTBOX_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface SignalOutboxEntry {
  schemaVersion: typeof SIGNAL_OUTBOX_SCHEMA;
  /** Client-generated idempotency key; server dedups on this. */
  signalId: string;
  taskId: string;
  kind: AgentSignalKind;
  note?: string;
  /** ISO timestamp the entry was first enqueued. */
  createdAt: string;
  /** Preferred base URL captured at enqueue time (may be stale). */
  baseUrl?: string;
  lastError?: string;
  attemptCount?: number;
}

export interface AppendSignalResult {
  appended: boolean;
  reason: 'appended' | 'duplicate';
  signalId: string;
  path: string;
  /** Entries dropped by the size/age bound during this append. */
  pruned: number;
}

export type DeliverSignalResult =
  | { outcome: 'delivered' }
  | { outcome: 'permanent_fail'; error?: string }
  | { outcome: 'transient_fail'; error?: string };

export type DeliverSignalFn = (entry: SignalOutboxEntry) => Promise<DeliverSignalResult>;

export interface DrainSignalResult {
  attempted: number;
  delivered: number;
  permanentFailed: number;
  transientFailed: number;
  remaining: number;
  deliveredIds: string[];
  failedIds: string[];
}

export function defaultSignalOutboxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KOOKR_SIGNAL_OUTBOX_DIR?.trim();
  if (override) return override;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.kookr', SIGNAL_OUTBOX_DIR_REL);
}

export function signalOutboxPendingPath(spoolDir: string): string {
  return join(spoolDir, SIGNAL_OUTBOX_PENDING_FILE);
}

export function newSignalId(): string {
  return randomUUID();
}

export function buildSignalOutboxEntry(input: {
  signalId?: string;
  taskId: string;
  kind: AgentSignalKind;
  note?: string;
  createdAt?: string;
  baseUrl?: string;
  lastError?: string;
  attemptCount?: number;
}): SignalOutboxEntry {
  const taskId = input.taskId.trim();
  if (!taskId) throw new Error('taskId is required');
  if (!isAgentSignalKind(input.kind)) throw new Error(`unknown signal kind: ${String(input.kind)}`);
  const note = input.note?.trim();
  return {
    schemaVersion: SIGNAL_OUTBOX_SCHEMA,
    signalId: input.signalId?.trim() || newSignalId(),
    taskId,
    kind: input.kind,
    ...(note ? { note } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.lastError ? { lastError: input.lastError.slice(0, 500) } : {}),
    ...(typeof input.attemptCount === 'number' ? { attemptCount: input.attemptCount } : {}),
  };
}

function isValidEntry(parsed: Partial<SignalOutboxEntry>): parsed is SignalOutboxEntry {
  return (
    parsed.schemaVersion === SIGNAL_OUTBOX_SCHEMA
    && typeof parsed.signalId === 'string'
    && parsed.signalId.length > 0
    && typeof parsed.taskId === 'string'
    && parsed.taskId.length > 0
    && isAgentSignalKind(parsed.kind)
    && typeof parsed.createdAt === 'string'
  );
}

/** Read and parse the pending outbox; malformed lines are skipped. */
export async function readPendingSignals(spoolDir: string): Promise<SignalOutboxEntry[]> {
  const path = signalOutboxPendingPath(spoolDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const byId = new Map<string, SignalOutboxEntry>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SignalOutboxEntry>;
      if (isValidEntry(parsed)) {
        byId.set(parsed.signalId, {
          schemaVersion: SIGNAL_OUTBOX_SCHEMA,
          signalId: parsed.signalId,
          taskId: parsed.taskId,
          kind: parsed.kind,
          createdAt: parsed.createdAt,
          ...(typeof parsed.note === 'string' && parsed.note ? { note: parsed.note } : {}),
          ...(typeof parsed.baseUrl === 'string' && parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
          ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
          ...(typeof parsed.attemptCount === 'number' ? { attemptCount: parsed.attemptCount } : {}),
        });
      }
    } catch {
      // tolerate corrupt lines
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Apply size + age bounds. Oldest entries are dropped first when over the
 * max-entry cap. Returns the kept list and how many were pruned.
 */
export function boundSignalOutbox(
  entries: readonly SignalOutboxEntry[],
  opts: {
    now?: Date;
    maxEntries?: number;
    maxAgeMs?: number;
  } = {},
): { kept: SignalOutboxEntry[]; pruned: number } {
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxEntries = opts.maxEntries ?? DEFAULT_SIGNAL_OUTBOX_MAX_ENTRIES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SIGNAL_OUTBOX_MAX_AGE_MS;

  const fresh = entries.filter((e) => {
    const created = Date.parse(e.createdAt);
    if (!Number.isFinite(created)) return false;
    return nowMs - created <= maxAgeMs;
  });
  const ageDropped = entries.length - fresh.length;

  let kept = fresh;
  let sizeDropped = 0;
  if (kept.length > maxEntries) {
    // Drop oldest first (fresh is already sorted oldest→newest by callers, but
    // re-sort defensively).
    const sorted = [...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    sizeDropped = sorted.length - maxEntries;
    kept = sorted.slice(sizeDropped);
  }

  return { kept, pruned: ageDropped + sizeDropped };
}

async function rewritePending(spoolDir: string, entries: SignalOutboxEntry[]): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  const path = signalOutboxPendingPath(spoolDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = entries.length === 0
    ? ''
    : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

/**
 * Append a signal to the durable outbox. Duplicate signalIds are skipped so a
 * concurrent/retry write never double-queues the same signal. Bounds are
 * enforced on every append.
 */
export async function appendSignalOutbox(
  spoolDir: string,
  entry: SignalOutboxEntry,
  opts: {
    now?: Date;
    maxEntries?: number;
    maxAgeMs?: number;
  } = {},
): Promise<AppendSignalResult> {
  await mkdir(spoolDir, { recursive: true });
  const path = signalOutboxPendingPath(spoolDir);
  const existing = await readPendingSignals(spoolDir);
  if (existing.some((e) => e.signalId === entry.signalId)) {
    return { appended: false, reason: 'duplicate', signalId: entry.signalId, path, pruned: 0 };
  }
  const { kept, pruned } = boundSignalOutbox([...existing, entry], opts);
  // If the brand-new entry was itself pruned (spool at cap with equal age
  // edge-cases), force-keep it by dropping one more oldest non-self entry.
  if (!kept.some((e) => e.signalId === entry.signalId)) {
    const withoutSelf = boundSignalOutbox(existing, {
      ...opts,
      maxEntries: Math.max(0, (opts.maxEntries ?? DEFAULT_SIGNAL_OUTBOX_MAX_ENTRIES) - 1),
    }).kept;
    await rewritePending(spoolDir, [...withoutSelf, entry]);
    return {
      appended: true,
      reason: 'appended',
      signalId: entry.signalId,
      path,
      pruned: pruned + 1,
    };
  }
  await rewritePending(spoolDir, kept);
  return { appended: true, reason: 'appended', signalId: entry.signalId, path, pruned };
}

/**
 * Remove a delivered (or permanently-failed) entry by signalId. No-op when
 * absent. Returns true when an entry was removed.
 */
export async function removeSignalOutboxEntry(
  spoolDir: string,
  signalId: string,
): Promise<boolean> {
  const pending = await readPendingSignals(spoolDir);
  const next = pending.filter((e) => e.signalId !== signalId);
  if (next.length === pending.length) return false;
  await rewritePending(spoolDir, next);
  return true;
}

/**
 * Drain the outbox by delivering each pending entry via `deliver`.
 * Successfully delivered and permanent failures are removed; transient
 * failures stay for a later drain.
 */
export async function drainSignalOutbox(opts: {
  spoolDir: string;
  deliver: DeliverSignalFn;
  now?: Date;
  maxEntries?: number;
  maxAgeMs?: number;
}): Promise<DrainSignalResult> {
  const raw = await readPendingSignals(opts.spoolDir);
  const { kept: pending } = boundSignalOutbox(raw, {
    now: opts.now,
    maxEntries: opts.maxEntries,
    maxAgeMs: opts.maxAgeMs,
  });
  // Persist bound result when age/size dropped anything even before deliver.
  if (pending.length !== raw.length) {
    await rewritePending(opts.spoolDir, pending);
  }

  if (pending.length === 0) {
    return {
      attempted: 0,
      delivered: 0,
      permanentFailed: 0,
      transientFailed: 0,
      remaining: 0,
      deliveredIds: [],
      failedIds: [],
    };
  }

  const remaining: SignalOutboxEntry[] = [];
  const deliveredIds: string[] = [];
  const failedIds: string[] = [];
  let delivered = 0;
  let permanentFailed = 0;
  let transientFailed = 0;

  for (const entry of pending) {
    let result: DeliverSignalResult;
    try {
      result = await opts.deliver(entry);
    } catch (err) {
      result = {
        outcome: 'transient_fail',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.outcome === 'delivered') {
      delivered += 1;
      deliveredIds.push(entry.signalId);
      continue;
    }
    if (result.outcome === 'permanent_fail') {
      permanentFailed += 1;
      failedIds.push(entry.signalId);
      continue;
    }
    transientFailed += 1;
    failedIds.push(entry.signalId);
    remaining.push({
      ...entry,
      attemptCount: (entry.attemptCount ?? 0) + 1,
      lastError: result.error?.slice(0, 500) ?? entry.lastError,
    });
  }

  await rewritePending(opts.spoolDir, remaining);

  return {
    attempted: pending.length,
    delivered,
    permanentFailed,
    transientFailed,
    remaining: remaining.length,
    deliveredIds,
    failedIds,
  };
}
