/**
 * Ready-queue service (issue #3933): owns the durable queue file, the 30-second
 * tick that starts the next entry, and the health snapshot.
 *
 * The go/no-go rule and the entry bookkeeping are pure (src/core/ready-queue.ts).
 * The launch itself goes through an injected dispatcher that runs the real
 * `POST /api/tasks` handler (wired by task-routes), so a queued launch gets
 * exactly the validation, admission gates, idempotency and error answers of a
 * direct `kookr spawn`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { atomicWriteFile } from '../core/persistence-utils.js';
import {
  READY_QUEUE_MAX_QUEUED,
  READY_QUEUE_SCHEMA,
  READY_QUEUE_STALL_MS,
  applyReadyQueueLaunchOutcome,
  decideReadyQueueTick,
  parseReadyQueueFile,
  pruneReadyQueueEntries,
  readyQueueHead,
  readyQueueWaitText,
  recoverReadyQueueEntries,
  serializeReadyQueueFile,
  type ReadyQueueEntry,
  type ReadyQueueGateInputs,
  type ReadyQueueLaunchOutcome,
  type ReadyQueueTickDecision,
  type ReadyQueueWaitReason,
} from '../core/ready-queue.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

/** Tick period named by issue #3933. */
export const DEFAULT_READY_QUEUE_TICK_MS = 30_000;

export interface ReadyQueueDispatchRequest {
  body: Record<string, unknown>;
  launchSource: string;
  actor?: string;
}

export interface ReadyQueueDispatchResponse {
  status: number;
  /** Parsed `Retry-After` header, in seconds, when the answer carried one. */
  retryAfterSeconds?: number;
  body: unknown;
}

export type ReadyQueueDispatcher = (request: ReadyQueueDispatchRequest) => Promise<ReadyQueueDispatchResponse>;

export interface ReadyQueueServiceDeps {
  filePath: string;
  /** Read once per tick: drain, SAFE MODE, capacity ledger, host load. */
  getGateInputs: () => ReadyQueueGateInputs;
  /**
   * Operational-alert channel. Called once when an entry is marked failed
   * (`ready_queue_launch_failed`), and once when the head keeps getting the
   * same "retry later" refusal for 15 minutes (`ready_queue_head_refused`).
   */
  emitAlert?: (alert: AlertMessage) => void;
  now?: () => number;
  tickIntervalMs?: number;
  log?: (line: string) => void;
  newId?: () => string;
}

export interface ReadyQueueHealthSnapshot {
  schema: typeof READY_QUEUE_SCHEMA;
  /** Entries waiting to start (the queue length). */
  queued: number;
  launching: number;
  /** Failed entries still listed (kept 24h). */
  failed: number;
  head: {
    id: string;
    enqueuedAt: string;
    waitingForMs: number;
    attempts: number;
    waitReason: ReadyQueueWaitReason | null;
    /** e.g. "waiting: host load"; null before the first tick looked at the head. */
    waiting: string | null;
  } | null;
  /** True when the head has waited at least 15 minutes. */
  stalled: boolean;
  lastTickAt: string | null;
}

export class ReadyQueueFullError extends Error {
  readonly code = 'ready_queue_full';
  constructor(readonly limit: number) {
    super(`ready queue is full (${limit} queued entries)`);
  }
}

export type ReadyQueueRemoveResult = 'removed' | 'not_found' | 'launching';

/**
 * Build the tick's gate inputs from the live server state. Pure, so the
 * production composition is tested: SAFE MODE also holds while the settings
 * file failed to load (fail closed), and the reserved-slot view is passed
 * through only when the ledger has one.
 */
export function buildReadyQueueGateInputs(input: {
  accepting: boolean;
  automationKillSwitch: boolean;
  settingsLoadError: boolean;
  ledger: { free: number; freeForGeneralSources?: number; pendingQueueDepth: number };
  load1m: number;
  cpuCount: number;
  maxLoadPerCpu: number;
}): ReadyQueueGateInputs {
  return {
    accepting: input.accepting,
    automationEnabled: !input.automationKillSwitch && !input.settingsLoadError,
    free: input.ledger.free,
    ...(input.ledger.freeForGeneralSources !== undefined
      ? { freeForGeneralSources: input.ledger.freeForGeneralSources }
      : {}),
    pendingQueueDepth: input.ledger.pendingQueueDepth,
    loadPerCpu: input.cpuCount > 0 ? input.load1m / input.cpuCount : null,
    maxLoadPerCpu: input.maxLoadPerCpu,
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function taskIdFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { id?: unknown; task?: { id?: unknown } };
  if (typeof b.id === 'string' && b.id.length > 0) return b.id;
  if (typeof b.task?.id === 'string' && b.task.id.length > 0) return b.task.id;
  return undefined;
}

/**
 * Classify one `POST /api/tasks` answer. 2xx is a started task (a dedup or
 * idempotent replay included: the task the request names exists). 429 and 503
 * are "retry later" and never count as a failed attempt. Anything else is a
 * launch that failed to start.
 */
export function classifyReadyQueueDispatch(response: ReadyQueueDispatchResponse): ReadyQueueLaunchOutcome {
  const body = (typeof response.body === 'object' && response.body !== null ? response.body : {}) as {
    error?: unknown;
    code?: unknown;
    retryAfterSeconds?: unknown;
    retryAfterMs?: unknown;
  };
  const error = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  const code = typeof body.code === 'string' ? body.code : undefined;
  if (response.status >= 200 && response.status < 300) {
    const taskId = taskIdFromBody(response.body);
    if (taskId) return { kind: 'started', taskId };
    return { kind: 'failed', error: `launch answered HTTP ${response.status} without a task id` };
  }
  if (response.status === 429 || response.status === 503) {
    const retryAfterSeconds = response.retryAfterSeconds ?? readNumber(body.retryAfterSeconds);
    const retryAfterMs = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : readNumber(body.retryAfterMs);
    const reason = code === 'host_load_admission'
      ? 'host_load'
      : code === 'draining'
        ? 'draining'
        : code === 'pending_queue_full'
          ? 'no_free_slot'
          : 'retry_after';
    return {
      kind: 'refused',
      reason,
      error,
      ...(code ? { code } : {}),
      ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }
  return { kind: 'failed', error, ...(code ? { code } : {}) };
}

function describeRequest(request: Record<string, unknown>): string {
  const playbook = request.playbook as { path?: unknown } | undefined;
  if (playbook && typeof playbook.path === 'string') return `playbook ${playbook.path}`;
  const prompt = typeof request.prompt === 'string' ? request.prompt.replace(/\s+/g, ' ').trim() : '';
  return prompt.length > 80 ? `"${prompt.slice(0, 77)}..."` : `"${prompt}"`;
}

/**
 * The run of identical "retry later" answers the current head has received.
 * A 429/503 never counts as a failed attempt, so a refusal that never clears
 * (an auth preflight that keeps failing, a quota 429 with no `Retry-After`)
 * would hold every later entry behind the head with no alert at all.
 */
interface RefusalStreak {
  entryId: string;
  /** The refusal's error code, or its wait reason when the answer had no code. */
  code: string;
  /** Time of the first refusal in the run. */
  sinceMs: number;
}

export class ReadyQueueService {
  private entries: ReadyQueueEntry[] = [];
  private refusalStreak: RefusalStreak | null = null;
  /**
   * Entries that already got the `ready_queue_head_refused` alert. Kept in
   * memory only: after a restart the alert can fire once more if the head is
   * still refused 15 minutes later.
   */
  private readonly refusalAlerted = new Set<string>();
  private dispatcher: ReadyQueueDispatcher | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private loaded = false;
  private lastTickAt: number | null = null;
  private readonly deps: ReadyQueueServiceDeps;

  constructor(deps: ReadyQueueServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(`[ready-queue] ${line}`);
  }

  /** Wire the launch path (the POST /api/tasks handler). Until then ticks do nothing. */
  setDispatcher(dispatcher: ReadyQueueDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /**
   * Load the queue file. A missing file is an empty queue. An unreadable one is
   * moved aside (`.corrupt-<time>`) rather than overwritten, so its entries can
   * still be recovered by hand.
   */
  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.deps.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw !== null) {
      try {
        const { entries, dropped } = parseReadyQueueFile(raw);
        if (dropped > 0) this.log(`dropped ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} from ${this.deps.filePath}`);
        this.entries = pruneReadyQueueEntries(recoverReadyQueueEntries(entries), this.now());
      } catch (err) {
        const aside = `${this.deps.filePath}.corrupt-${this.now()}`;
        await rename(this.deps.filePath, aside).catch(() => undefined);
        this.log(`could not read ${this.deps.filePath} (${err instanceof Error ? err.message : String(err)}); moved it to ${aside}`);
        this.entries = [];
      }
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    const snapshot = serializeReadyQueueFile(this.entries);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.deps.filePath), { recursive: true });
        await atomicWriteFile(this.deps.filePath, snapshot);
      })
      .catch((err: unknown) => {
        this.log(`failed to write ${this.deps.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return this.writeChain;
  }

  private replace(updated: ReadyQueueEntry): void {
    this.entries = this.entries.map((entry) => (entry.id === updated.id ? updated : entry));
  }

  list(): ReadyQueueEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Add a launch request at the end of the queue. Enqueue is idempotent on the
   * request's idempotency key: re-sending the same request (a client retry
   * after a timeout) returns the entry already stored instead of adding one.
   */
  async enqueue(input: {
    request: Record<string, unknown>;
    launchSource: string;
    actor?: string;
  }): Promise<{ entry: ReadyQueueEntry; created: boolean }> {
    const requestedKey = typeof input.request.idempotencyKey === 'string' && input.request.idempotencyKey.length > 0
      ? input.request.idempotencyKey
      : undefined;
    if (requestedKey) {
      const existing = this.entries.find((entry) => entry.idempotencyKey === requestedKey);
      if (existing) return { entry: { ...existing }, created: false };
    }
    const queuedCount = this.entries.filter((entry) => entry.state === 'queued' || entry.state === 'launching').length;
    if (queuedCount >= READY_QUEUE_MAX_QUEUED) throw new ReadyQueueFullError(READY_QUEUE_MAX_QUEUED);
    const id = this.deps.newId ? this.deps.newId() : randomUUID().slice(0, 8);
    const idempotencyKey = requestedKey ?? `ready-queue:${id}`;
    const entry: ReadyQueueEntry = {
      id,
      request: { ...input.request, idempotencyKey },
      launchSource: input.launchSource,
      ...(input.actor ? { actor: input.actor } : {}),
      idempotencyKey,
      state: 'queued',
      enqueuedAt: new Date(this.now()).toISOString(),
      attempts: 0,
    };
    this.entries = [...this.entries, entry];
    await this.persist();
    return { entry: { ...entry }, created: true };
  }

  /** Remove an entry. One that is being started right now cannot be removed. */
  async remove(id: string): Promise<ReadyQueueRemoveResult> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return 'not_found';
    if (entry.state === 'launching') return 'launching';
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    if (this.refusalStreak?.entryId === id) this.refusalStreak = null;
    this.refusalAlerted.delete(id);
    await this.persist();
    return 'removed';
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs ?? DEFAULT_READY_QUEUE_TICK_MS);
    this.interval.unref?.();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.writeChain;
  }

  /**
   * One tick: start at most one entry. Exposed so tests drive it with a fake
   * clock. Never throws; a slow launch never overlaps the next tick.
   */
  async tick(): Promise<ReadyQueueTickDecision> {
    if (!this.loaded || this.ticking || !this.dispatcher) return { kind: 'idle' };
    this.ticking = true;
    try {
      const nowMs = this.now();
      this.lastTickAt = nowMs;
      const pruned = pruneReadyQueueEntries(this.entries, nowMs);
      const prunedAny = pruned.length !== this.entries.length;
      this.entries = pruned;

      let gates: ReadyQueueGateInputs;
      try {
        gates = this.deps.getGateInputs();
      } catch (err) {
        this.log(`could not read launch gates; skipping tick: ${err instanceof Error ? err.message : String(err)}`);
        if (prunedAny) await this.persist();
        return { kind: 'idle' };
      }
      const decision = decideReadyQueueTick(this.entries, gates, nowMs);
      if (decision.kind !== 'launch') {
        const head = decision.kind === 'wait'
          ? this.entries.find((entry) => entry.id === decision.entryId)
          : undefined;
        if (head && decision.kind === 'wait' && head.waitReason !== decision.reason) {
          this.replace({ ...head, waitReason: decision.reason });
          await this.persist();
        } else if (prunedAny) {
          await this.persist();
        }
        return decision;
      }

      const entry = this.entries.find((candidate) => candidate.id === decision.entryId)!;
      this.replace({ ...entry, state: 'launching' });
      await this.persist();

      let outcome: ReadyQueueLaunchOutcome;
      try {
        const response = await this.dispatcher({
          body: { ...entry.request, idempotencyKey: entry.idempotencyKey },
          launchSource: entry.launchSource,
          ...(entry.actor ? { actor: entry.actor } : {}),
        });
        outcome = classifyReadyQueueDispatch(response);
      } catch (err) {
        outcome = { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
      }

      const { entry: updated, becameFailed } = applyReadyQueueLaunchOutcome(entry, outcome, this.now());
      const final = becameFailed && !updated.alerted && this.deps.emitAlert
        ? { ...updated, alerted: true }
        : updated;
      this.replace(final);
      await this.persist();

      if (outcome.kind === 'started') {
        this.log(`started entry ${entry.id} as task ${outcome.taskId}`);
      } else if (outcome.kind === 'refused') {
        this.log(`entry ${entry.id} refused for now (${outcome.code ?? outcome.reason}): ${outcome.error}`);
      } else {
        this.log(`entry ${entry.id} failed to start (attempt ${final.attempts}): ${outcome.error}`);
      }
      if (becameFailed && final.alerted && !entry.alerted) this.sendFailedAlert(final);
      this.trackRefusal(final, outcome, this.now());
      return decision;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Follow the head's run of identical refusals. The run survives the `wait`
   * ticks in between (a `Retry-After` delay, a full fleet); it ends when the
   * entry gets any other answer or a different refusal code. Once one run has
   * lasted at least 15 minutes (two refusals or more), send one alert.
   * Measured in time, not in refusals, so a long `Retry-After` still alerts.
   */
  private trackRefusal(entry: ReadyQueueEntry, outcome: ReadyQueueLaunchOutcome, nowMs: number): void {
    if (outcome.kind !== 'refused') {
      if (this.refusalStreak?.entryId === entry.id) this.refusalStreak = null;
      if (outcome.kind === 'started' || entry.state === 'failed') this.refusalAlerted.delete(entry.id);
      return;
    }
    const code = outcome.code ?? outcome.reason;
    const streak = this.refusalStreak;
    if (!streak || streak.entryId !== entry.id || streak.code !== code) {
      this.refusalStreak = { entryId: entry.id, code, sinceMs: nowMs };
      return;
    }
    const refusedForMs = nowMs - streak.sinceMs;
    if (refusedForMs < READY_QUEUE_STALL_MS || this.refusalAlerted.has(entry.id) || !this.deps.emitAlert) return;
    this.refusalAlerted.add(entry.id);
    this.sendRefusedAlert(entry, code, refusedForMs);
  }

  private sendRefusedAlert(entry: ReadyQueueEntry, code: string, refusedForMs: number): void {
    const behind = this.entries.filter((candidate) => candidate.id !== entry.id && candidate.state === 'queued').length;
    const minutes = Math.floor(refusedForMs / 60_000);
    try {
      this.deps.emitAlert?.({
        type: 'alert',
        agentId: '',
        summary: `Ready queue: launch ${entry.id} has been refused (${code}) for ${minutes} minutes; `
          + `${behind} entr${behind === 1 ? 'y waits' : 'ies wait'} behind it`,
        details: `${describeRequest(entry.request)}: ${entry.lastError ?? 'no error text'}. `
          + 'The server keeps answering "retry later", which never counts as a failed attempt, so the entry '
          + `is retried with no limit. Fix the cause, or remove it with \`kookr queue remove ${entry.id}\`.`,
        severity: 'warning',
        operationalAlert: {
          key: `ready-queue-refused:${entry.id}`,
          metric: 'ready_queue_head_refused',
          state: 'fired',
        },
      });
    } catch (err) {
      this.log(`failed to send the head-refused alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendFailedAlert(entry: ReadyQueueEntry): void {
    try {
      this.deps.emitAlert?.({
        type: 'alert',
        agentId: '',
        summary: `Ready queue: launch ${entry.id} failed ${entry.attempts} times and was given up`,
        details: `${describeRequest(entry.request)}: ${entry.lastError ?? 'unknown error'}. `
          + `It stays in \`kookr queue list\` for 24 hours; remove it with \`kookr queue remove ${entry.id}\`.`,
        severity: 'warning',
        operationalAlert: {
          key: `ready-queue:${entry.id}`,
          metric: 'ready_queue_launch_failed',
          state: 'fired',
        },
      });
    } catch (err) {
      this.log(`failed to send the launch-failed alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Synchronous, in-memory: safe to call from the cached health body. */
  getHealthSnapshot(): ReadyQueueHealthSnapshot {
    const nowMs = this.now();
    const head = readyQueueHead(this.entries);
    const waitingForMs = head ? Math.max(0, nowMs - Date.parse(head.enqueuedAt)) : 0;
    return {
      schema: READY_QUEUE_SCHEMA,
      queued: this.entries.filter((entry) => entry.state === 'queued').length,
      launching: this.entries.filter((entry) => entry.state === 'launching').length,
      failed: this.entries.filter((entry) => entry.state === 'failed').length,
      head: head
        ? {
            id: head.id,
            enqueuedAt: head.enqueuedAt,
            waitingForMs: Number.isFinite(waitingForMs) ? waitingForMs : 0,
            attempts: head.attempts,
            waitReason: head.waitReason ?? null,
            waiting: head.waitReason ? readyQueueWaitText(head.waitReason) : null,
          }
        : null,
      stalled: head !== undefined && Number.isFinite(waitingForMs) && waitingForMs >= READY_QUEUE_STALL_MS,
      lastTickAt: this.lastTickAt === null ? null : new Date(this.lastTickAt).toISOString(),
    };
  }
}
