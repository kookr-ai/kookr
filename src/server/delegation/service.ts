import { randomUUID } from 'node:crypto';
import type { A2aClient, A2aEndpoint, A2aOutcome } from './a2a-client.js';
import { buildTriagePrompt, fetchIssueForTriage, isKindImplemented, versionFor, type IssueSnapshot } from './prompts.js';
import {
  LEAK_GRACE_MS,
  checkWorkerTokens,
  computeDeadlineMs,
  pickWorker,
  readWorkerTokens,
  totalInFlight,
  type DelegationConfig,
  type ValidatedWorker,
} from './registry.js';
import { validateTriageResult } from './results.js';
import { snapshotKey, type SnapshotManager, type SnapshotRef } from './snapshots.js';
import {
  DELEGATION_KINDS,
  DELEGATION_SCHEMA_VERSION,
  isTerminalState,
  type Delegation,
  type DelegationDetail,
  type DelegationKind,
  type DelegationResult,
  type DelegationState,
  type DelegationStore,
  type DelegationStoreError,
  type FailureReason,
} from './store.js';

export type {
  Delegation,
  DelegationDetail,
  DelegationKind,
  DelegationResult,
  DelegationState,
  DelegationStoreError,
  FailureReason,
  TriageVerdict,
} from './store.js';

/**
 * The delegation service: the ONLY mutator of delegation state (RFC section 1).
 *
 * Plain-language summary. A caller asks for a job ("triage issue 42 of project X").
 * The service checks the request, picks a Hermes worker with a free slot, makes sure the
 * worker has a read-only snapshot of the code to read, writes the new record to disk, and
 * only then starts the job in the background and returns the record at once (HTTP 202 in
 * the routes). The background task sends `message/send`, which the worker answers when
 * the job ends, validates the reply against the result schema, and records the outcome.
 * Everything that can go wrong maps to one terminal state with a stated reason, and the
 * record always says whether the worker may still be running the job.
 *
 * Why the write comes first (write-ahead): if Kookr dies right after contacting the
 * worker, the record already exists, so on the next start the service can ask the worker
 * what became of the job (looked up by the Kookr-minted `contextId`) instead of losing it.
 * Reconciliation never claims a missing job is "safe to retry": the worker's tools may
 * already have had side effects, so a retry is always a new delegation (new contextId).
 *
 * Deliberately NOT done: no queue (a full pool is a synchronous `pool_busy`), no active
 * health probing (a transport error just parks a worker for a short while), no cancel
 * route (slice 2), and no use of `message/stream` (see a2a-client.ts).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ServiceErrorCode =
  | 'delegation_disabled'
  | 'invalid_request'
  | 'unknown_project'
  | 'not_implemented'
  | 'idempotency_conflict'
  | 'pool_busy'
  | 'pool_unavailable'
  | 'snapshot_failed'
  | 'issue_fetch_failed'
  | 'store_write_failed';

export interface ServiceError {
  code: ServiceErrorCode;
  message: string;
  httpStatus: number;
  retryAfterSec?: number;
  /** For `delegation_disabled`: what is missing or wrong (names only, never values). */
  missing?: string[];
  /** For store problems: the file the operator should inspect. */
  file?: string;
}

export type SubmitResult =
  | { ok: true; delegation: Delegation; created: boolean }
  | { ok: false; error: ServiceError };

export interface DisabledInfo {
  reason: string;
  missing: string[];
  file?: string;
}

export interface Timings {
  /** Default ceiling for a triage job (before the worker reply-timeout bound). */
  triageDeadlineMs: number;
  deadlineMarginSec: number;
  /** How long a transport error keeps a worker out of rotation. */
  unreachableCooldownMs: number;
  /** Poll period for learning the worker's task id after dispatch. */
  resolveIntervalMs: number;
  /** Poll period when following a task with `tasks/get`. */
  pollIntervalMs: number;
  /** How long recovery keeps retrying a worker that does not answer. */
  recoveryGraceMs: number;
  recoveryBackoffMs: readonly number[];
  /** After a restart, never time a job out sooner than this, so a lookup can run first. */
  reconcileMinWindowMs: number;
  callTimeoutMs: number;
  leakGraceMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  triageDeadlineMs: 240_000,
  deadlineMarginSec: 30,
  unreachableCooldownMs: 30_000,
  resolveIntervalMs: 1_000,
  pollIntervalMs: 2_000,
  recoveryGraceMs: 30_000,
  recoveryBackoffMs: [1_000, 2_000, 4_000, 8_000],
  reconcileMinWindowMs: 5_000,
  callTimeoutMs: 10_000,
  leakGraceMs: LEAK_GRACE_MS,
};

export interface DelegationServiceDeps {
  config: DelegationConfig;
  workers: readonly ValidatedWorker[];
  store: DelegationStore;
  client: A2aClient;
  snapshots: SnapshotManager;
  /** Reads token files; defaults to the real file reader. Called again on every request. */
  readTokens?: (workers: readonly ValidatedWorker[]) => Promise<Map<string, string | undefined>>;
  fetchIssue?: (githubRepo: string, issueNumber: number) => Promise<IssueSnapshot>;
  /** Re-read on every submit (ordered disable). Defaults to the loaded config value. */
  readAccepting?: () => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
  newId?: () => string;
  timings?: Partial<Timings>;
}

interface ValidRequest {
  kind: DelegationKind;
  projectId: string;
  issueRef?: number;
  key?: string;
  parentTaskId?: string;
}

interface Active {
  ctl: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

type Terminal = {
  state: Exclude<DelegationState, 'dispatching' | 'working'>;
  failureReason?: FailureReason;
  detail?: DelegationDetail;
  result?: DelegationResult;
  workMayStillBeRunning?: boolean;
  /** The worker answered (so `lastWorkerContactAt` advances). */
  contacted?: boolean;
};

const KEY_RE = /^[A-Za-z0-9._:@/-]{1,128}$/;
const RESULT_LABEL = 'UNTRUSTED worker output: validated against the triage schema, but authored by a model that read third-party text';
const EXCERPT_CHARS = 300;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DelegationService {
  private disabled?: DisabledInfo;
  private readonly active = new Map<string, Active>();
  private readonly unreachableUntil = new Map<string, number>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly t: Timings;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly readTokens: NonNullable<DelegationServiceDeps['readTokens']>;
  private readonly fetchIssue: NonNullable<DelegationServiceDeps['fetchIssue']>;
  private cleanupQueued = false;
  private stopped = false;

  /** Last successfully read value of the ordered-disable switch. */
  private lastAccepting: boolean;

  constructor(private readonly deps: DelegationServiceDeps) {
    this.lastAccepting = deps.config.acceptingNewDelegations !== false;
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.readTokens = deps.readTokens ?? ((ws) => readWorkerTokens(ws));
    this.fetchIssue =
      deps.fetchIssue ??
      ((repo, n) => fetchIssueForTriage(repo, n));
  }

  /** Load the store, then reconcile unfinished delegations in the background. */
  async start(): Promise<void> {
    const loaded = await this.deps.store.load();
    if (!loaded.ok) {
      this.disabled = { reason: loaded.error.code, missing: [loaded.error.message], file: loaded.error.file };
      this.event('disabled', { reason: loaded.error.code, file: loaded.error.file });
      return;
    }
    this.event('started', {
      workers: this.deps.workers.map((w) => w.name),
      projects: Object.keys(this.deps.config.projects),
      records: this.deps.store.list().length,
    });
    for (const rec of this.deps.store.list()) {
      if (isTerminalState(rec.state)) continue;
      this.event('reconcile_begin', { id: rec.id, state: rec.state, worker: rec.workerId, a2aTaskId: rec.a2aTaskId });
      const remaining = Math.max(this.t.reconcileMinWindowMs, rec.deadlineAt - this.now());
      this.arm(rec.id, remaining);
      this.track(rec.id, this.recover(rec.id));
    }
    this.queueSnapshotCleanup();
  }

  /** Stop timers and in-flight calls. Records stay as they are; the next start reconciles them. */
  stop(): void {
    this.stopped = true;
    for (const a of this.active.values()) {
      if (a.timer) clearTimeout(a.timer);
      a.ctl.abort();
    }
    this.active.clear();
  }

  /** Resolves when no background work is running (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  get disabledInfo(): DisabledInfo | undefined {
    return this.disabled;
  }

  /** False when the operator set `acceptingNewDelegations: false` (new submissions only). */
  async isAccepting(): Promise<boolean> {
    if (this.deps.readAccepting) {
      try {
        this.lastAccepting = await this.deps.readAccepting();
      } catch {
        // An unreadable switch keeps the last known value, so a broken or deleted config file
        // in the middle of an ordered disable does not silently re-open submissions.
      }
      return this.lastAccepting;
    }
    return this.deps.config.acceptingNewDelegations !== false;
  }

  get(id: string): Delegation | undefined {
    return this.deps.store.get(id);
  }

  list(filter: { parent?: string; activeOnly?: boolean } = {}): Delegation[] {
    return this.deps.store
      .list()
      .filter((r) => filter.parent === undefined || r.parentTaskId === filter.parent)
      .filter((r) => !filter.activeOnly || !isTerminalState(r.state))
      .sort((a, b) => b.submittedAt - a.submittedAt);
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async submit(raw: unknown): Promise<SubmitResult> {
    if (this.disabled) return { ok: false, error: this.disabledError() };
    const valid = this.validate(raw);
    if (!valid.ok) return valid;
    const req = valid.request;

    // Fast path: an equivalent unfinished delegation already exists (no I/O).
    const early = this.findIdempotent(this.deps.store.list(), req);
    if (early) return early.conflict ? { ok: false, error: idempotencyConflict() } : { ok: true, delegation: early.record, created: false };

    const tokens = await this.readTokens(this.deps.workers);
    const unusable = unusableWorkers(this.deps.workers, tokens, this.deps.config.weakTokenHashes ?? []);
    const preNow = this.now();
    const capErr = this.capError(this.deps.store.list(), preNow);
    if (capErr) return { ok: false, error: capErr };
    const pre = pickWorker(this.deps.store.list(), this.deps.workers, req.projectId, this.pickOptions(preNow, unusable));
    if (!pre.ok) return { ok: false, error: this.poolError(pre.reason) };

    const project = this.deps.config.projects[req.projectId]!;
    // Fetch the issue BEFORE taking the snapshot. The fetch can be slow (retries, timeouts), and
    // the snapshot is only shielded from cleanup for a bounded time after it is created; only fast
    // local steps (prompt building, the durable record write) may sit between the two.
    let issue: Awaited<ReturnType<typeof this.fetchIssue>>;
    try {
      issue = await this.fetchIssue(project.githubRepo, req.issueRef!);
    } catch (err) {
      this.event('issue_fetch_failed', { project: req.projectId, error: errName(err) });
      return { ok: false, error: { code: 'issue_fetch_failed', httpStatus: 502, message: 'could not fetch the issue from GitHub' } };
    }

    let snapshot: SnapshotRef;
    try {
      snapshot = await this.deps.snapshots.ensureCurrent(req.projectId);
    } catch (err) {
      this.event('snapshot_failed', { project: req.projectId, error: errName(err) });
      return { ok: false, error: { code: 'snapshot_failed', httpStatus: 502, message: 'could not create the read-only snapshot for this project' } };
    }

    let prompt: string;
    try {
      prompt = buildTriagePrompt({
        issue,
        projectId: req.projectId,
        containerSnapshotDir: `${this.deps.config.containerSnapshotsPath.replace(/\/+$/, '')}/${req.projectId}/${snapshot.sha}`,
      });
    } catch (err) {
      this.event('prompt_build_failed', { project: req.projectId, error: errName(err) });
      return { ok: false, error: { code: 'issue_fetch_failed', httpStatus: 502, message: 'could not build the job prompt from the issue' } };
    }

    // Write-ahead. Re-check idempotency, the caps and the worker choice against the
    // committed records inside the serialized writer, so concurrent requests cannot
    // both pass a check that only one of them should.
    type Decision =
      | { kind: 'dup'; record: Delegation; conflict: boolean }
      | { kind: 'error'; error: ServiceError }
      | { kind: 'created'; record: Delegation };
    let decision: Decision;
    try {
      decision = await this.deps.store.transact<Decision>((records) => {
        const dup = this.findIdempotent(records, req);
        if (dup) return { result: { kind: 'dup', record: dup.record, conflict: dup.conflict } };
        const now = this.now();
        const cap = this.capError(records, now);
        if (cap) return { result: { kind: 'error', error: cap } };
        const pick = pickWorker(records, this.deps.workers, req.projectId, this.pickOptions(now, unusable));
        if (!pick.ok) return { result: { kind: 'error', error: this.poolError(pick.reason) } };
        const deadlineMs = computeDeadlineMs(this.t.triageDeadlineMs, pick.worker.replyTimeoutSec, this.t.deadlineMarginSec);
        const record: Delegation = {
          id: this.newId(),
          schemaVersion: DELEGATION_SCHEMA_VERSION,
          kind: req.kind,
          projectId: req.projectId,
          ...(req.issueRef !== undefined ? { issueRef: req.issueRef } : {}),
          ...(req.key !== undefined ? { key: req.key } : {}),
          ...(req.parentTaskId !== undefined ? { parentTaskId: req.parentTaskId } : {}),
          workerId: pick.worker.name,
          baseSha: snapshot.sha,
          promptVersion: versionFor(req.kind),
          contextId: `kookr-${this.deps.store.id}-${randomUUID()}`,
          state: 'dispatching',
          submittedAt: now,
          deadlineAt: now + deadlineMs,
        };
        return { next: [...records, record], result: { kind: 'created', record } };
      });
    } catch (err) {
      this.event('store_write_failed', { error: errName(err) });
      return {
        ok: false,
        error: { code: 'store_write_failed', httpStatus: 500, message: 'could not persist the delegation record; nothing was dispatched', file: this.deps.store.file },
      };
    }

    if (decision.kind === 'dup') {
      return decision.conflict ? { ok: false, error: idempotencyConflict() } : { ok: true, delegation: decision.record, created: false };
    }
    if (decision.kind === 'error') return { ok: false, error: decision.error };

    const rec = decision.record;
    this.event('transition', { id: rec.id, to: 'dispatching', kind: rec.kind, project: rec.projectId, worker: rec.workerId, contextId: rec.contextId, baseSha: rec.baseSha });
    this.arm(rec.id, rec.deadlineAt - this.now());
    this.track(rec.id, this.dispatch(rec.id, prompt));
    return { ok: true, delegation: rec, created: true };
  }

  private validate(raw: unknown): { ok: true; request: ValidRequest } | { ok: false; error: ServiceError } {
    const bad = (message: string): { ok: false; error: ServiceError } => ({
      ok: false,
      error: { code: 'invalid_request', httpStatus: 400, message },
    });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('body must be a JSON object');
    const b = raw as Record<string, unknown>;
    if (typeof b.kind !== 'string' || !(DELEGATION_KINDS as readonly string[]).includes(b.kind)) {
      return bad(`kind must be one of: ${DELEGATION_KINDS.join(', ')}`);
    }
    const kind = b.kind as DelegationKind;
    if (typeof b.projectId !== 'string' || !Object.prototype.hasOwnProperty.call(this.deps.config.projects, b.projectId)) {
      return { ok: false, error: { code: 'unknown_project', httpStatus: 404, message: 'projectId is not a configured delegation project' } };
    }
    if (!isKindImplemented(kind)) {
      return { ok: false, error: { code: 'not_implemented', httpStatus: 501, message: `kind "${kind}" is not implemented in this slice` } };
    }
    let issueRef: number | undefined;
    if (b.issueRef !== undefined) {
      const n = typeof b.issueRef === 'string' && /^\d{1,9}$/.test(b.issueRef) ? Number(b.issueRef) : b.issueRef;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999_999_999) return bad('issueRef must be a positive integer');
      issueRef = n;
    }
    if (kind === 'triage' && issueRef === undefined) return bad('issueRef is required for kind "triage"');
    if (b.key !== undefined && (typeof b.key !== 'string' || !KEY_RE.test(b.key))) return bad('key must be 1-128 characters of [A-Za-z0-9._:@/-]');
    if (b.parentTaskId !== undefined && (typeof b.parentTaskId !== 'string' || !KEY_RE.test(b.parentTaskId))) {
      return bad('parentTaskId must be 1-128 characters of [A-Za-z0-9._:@/-]');
    }
    return {
      ok: true,
      request: {
        kind,
        projectId: b.projectId,
        ...(issueRef !== undefined ? { issueRef } : {}),
        ...(b.key !== undefined ? { key: b.key as string } : {}),
        ...(b.parentTaskId !== undefined ? { parentTaskId: b.parentTaskId as string } : {}),
      },
    };
  }

  /** A non-terminal delegation with the same (parentTaskId, key). `conflict` when it asked for something different. */
  private findIdempotent(records: readonly Delegation[], req: ValidRequest): { record: Delegation; conflict: boolean } | undefined {
    if (req.key === undefined) return undefined;
    const hit = records.find((r) => !isTerminalState(r.state) && r.key === req.key && (r.parentTaskId ?? '') === (req.parentTaskId ?? ''));
    if (!hit) return undefined;
    return { record: hit, conflict: hit.kind !== req.kind || hit.projectId !== req.projectId || hit.issueRef !== req.issueRef };
  }

  private capError(records: readonly Delegation[], now: number): ServiceError | undefined {
    if (totalInFlight(records, now, this.t.leakGraceMs) >= this.deps.config.maxDelegations) {
      return {
        code: 'pool_busy',
        httpStatus: 429,
        retryAfterSec: 30,
        message: `the global delegation cap (maxDelegations=${this.deps.config.maxDelegations}) is reached`,
      };
    }
    return undefined;
  }

  private poolError(reason: 'pool_busy' | 'pool_unavailable'): ServiceError {
    return reason === 'pool_busy'
      ? { code: 'pool_busy', httpStatus: 429, retryAfterSec: 30, message: 'every worker that serves this project is at its maxInFlight cap' }
      : { code: 'pool_unavailable', httpStatus: 503, message: 'no usable worker serves this project right now' };
  }

  private disabledError(): ServiceError {
    const d = this.disabled!;
    return {
      code: 'delegation_disabled',
      httpStatus: 503,
      message: `delegation is disabled: ${d.reason}`,
      missing: d.missing,
      ...(d.file ? { file: d.file } : {}),
    };
  }

  private pickOptions(now: number, unusable: ReadonlySet<string>) {
    return { now, graceMs: this.t.leakGraceMs, unreachable: this.currentlyUnreachable(now), unusable };
  }

  // -------------------------------------------------------------------------
  // Passive health
  // -------------------------------------------------------------------------

  private currentlyUnreachable(now: number): Set<string> {
    const out = new Set<string>();
    for (const [name, until] of this.unreachableUntil) {
      if (until > now) out.add(name);
      else this.unreachableUntil.delete(name);
    }
    return out;
  }

  private markUnreachable(worker: string, why: string): void {
    const until = this.now() + this.t.unreachableCooldownMs;
    if (!this.unreachableUntil.has(worker)) this.event('worker_unreachable', { worker, why, forMs: this.t.unreachableCooldownMs });
    this.unreachableUntil.set(worker, until);
  }

  // -------------------------------------------------------------------------
  // Background execution
  // -------------------------------------------------------------------------

  private track(id: string, p: Promise<void>): void {
    const wrapped: Promise<unknown> = p
      .catch(async (err: unknown) => {
        this.event('internal_error', { id, error: errName(err) });
        await this.terminate(id, {
          state: 'failed',
          failureReason: 'error',
          detail: { message: 'internal error while handling this delegation', untrusted: false },
          workMayStillBeRunning: true,
        }).catch(() => undefined);
      })
      .finally(() => this.background.delete(wrapped));
    this.background.add(wrapped);
  }

  /** Background work whose failure must not fail the delegation (best-effort helpers). */
  private trackQuiet(p: Promise<void>): void {
    const wrapped: Promise<unknown> = p
      .catch((err: unknown) => this.event('background_error', { error: errName(err) }))
      .finally(() => this.background.delete(wrapped));
    this.background.add(wrapped);
  }

  private arm(id: string, delayMs: number): void {
    const prev = this.active.get(id);
    if (prev?.timer) clearTimeout(prev.timer);
    const a: Active = prev ?? { ctl: new AbortController() };
    a.timer = setTimeout(() => this.track(id, this.onDeadline(id)), Math.max(0, delayMs));
    a.timer.unref?.();
    this.active.set(id, a);
  }

  private signalFor(id: string): AbortSignal | undefined {
    return this.active.get(id)?.ctl.signal;
  }

  private async onDeadline(id: string): Promise<void> {
    await this.terminate(id, {
      state: 'timed_out',
      detail: { message: 'Kookr deadline reached before the worker finished; the worker may still be running this job', untrusted: false },
      workMayStillBeRunning: true,
    });
  }

  private remainingMs(rec: Delegation): number {
    return Math.max(this.t.callTimeoutMs, rec.deadlineAt - this.now() + 5_000);
  }

  /** The worker plus its endpoint (token freshly read; distinct-token rule re-checked). */
  private async endpointFor(rec: Delegation): Promise<{ ok: true; ep: A2aEndpoint; worker: ValidatedWorker } | { ok: false; reason: string }> {
    const worker = this.deps.workers.find((w) => w.name === rec.workerId);
    if (!worker) return { ok: false, reason: 'worker is no longer in the configuration' };
    const tokens = await this.readTokens(this.deps.workers);
    const issue = checkWorkerTokens(this.deps.workers.map((w) => w.name), tokens, this.deps.config.weakTokenHashes ?? []).find((i) => i.worker === worker.name);
    if (issue) return { ok: false, reason: `worker token rejected by the registry (${issue.code})` };
    return { ok: true, ep: { url: worker.url, token: tokens.get(worker.name)!.trim() }, worker };
  }

  /** Initial dispatch: message/send, plus a poller that learns the worker's task id meanwhile. */
  private async dispatch(id: string, prompt: string): Promise<void> {
    const rec = this.deps.store.get(id);
    const signal = this.signalFor(id);
    if (!rec || isTerminalState(rec.state) || !signal) return;
    const endpoint = await this.endpointFor(rec);
    if (!endpoint.ok) {
      await this.fail(id, 'error', endpoint.reason, false, false);
      return;
    }
    const resolver = this.startTaskIdResolver(id, endpoint.ep, signal);
    let outcome: A2aOutcome;
    try {
      outcome = await this.deps.client.send(
        endpoint.ep,
        { contextId: rec.contextId, messageId: rec.id, text: prompt },
        { timeoutMs: this.remainingMs(rec), signal },
      );
    } finally {
      resolver.stop();
    }
    await this.handle(id, outcome, 'send');
  }

  private startTaskIdResolver(id: string, ep: A2aEndpoint, signal: AbortSignal): { stop(): void } {
    const local = new AbortController();
    const both = AbortSignal.any([signal, local.signal]);
    const loop = async () => {
      while (!both.aborted) {
        await sleep(this.t.resolveIntervalMs, both);
        if (both.aborted) return;
        const rec = this.deps.store.get(id);
        if (!rec || isTerminalState(rec.state) || rec.a2aTaskId) return;
        const l = await this.deps.client.listByContext(ep, rec.contextId, { timeoutMs: this.t.callTimeoutMs, signal: both });
        if (l.kind === 'tasks' && l.tasks.length > 0 && !both.aborted) {
          await this.learnTaskId(id, l.tasks[0]!.taskId);
          return;
        }
      }
    };
    this.trackQuiet(loop());
    return { stop: () => local.abort() };
  }

  /** Persist the worker's task id (and move dispatching -> working). */
  private async learnTaskId(id: string, taskId: string): Promise<void> {
    const changed = await this.deps.store.transact((records) => {
      const rec = records.find((r) => r.id === id);
      if (!rec || isTerminalState(rec.state) || rec.a2aTaskId === taskId) return { result: false };
      const next: Delegation = { ...rec, a2aTaskId: taskId, state: 'working', lastWorkerContactAt: this.now() };
      return { next: records.map((r) => (r.id === id ? next : r)), result: true };
    });
    if (changed) this.event('transition', { id, to: 'working', a2aTaskId: taskId });
  }

  private async touch(id: string): Promise<void> {
    await this.deps.store.transact((records) => {
      const rec = records.find((r) => r.id === id);
      if (!rec || isTerminalState(rec.state)) return { result: undefined };
      return { next: records.map((r) => (r.id === id ? { ...rec, lastWorkerContactAt: this.now() } : r)), result: undefined };
    });
  }

  /** Map one normalized worker outcome onto a delegation transition. */
  private async handle(id: string, outcome: A2aOutcome, origin: 'send' | 'follow' | 'recover'): Promise<void> {
    const signal = this.signalFor(id);
    if (signal?.aborted) return; // deadline or shutdown owns the outcome
    const rec = this.deps.store.get(id);
    if (!rec || isTerminalState(rec.state)) return;
    switch (outcome.kind) {
      case 'completed':
        await this.complete(id, outcome.text, outcome.truncated);
        return;
      case 'needs_input':
        await this.terminate(id, { state: 'failed', failureReason: 'needs_input', detail: workerDetail('worker asked a question instead of answering', outcome.text, outcome.truncated), contacted: true });
        return;
      case 'worker_failed':
        await this.terminate(id, {
          state: 'failed',
          failureReason: 'worker_failed',
          detail: workerDetail('worker reported FAILED; the work may still be running on the worker', outcome.text, outcome.truncated),
          workMayStillBeRunning: true,
          contacted: true,
        });
        return;
      case 'rejected':
        await this.terminate(id, { state: 'failed', failureReason: 'rejected', detail: workerDetail('worker rejected the job', outcome.text, outcome.truncated), contacted: true });
        return;
      case 'cancelled':
        await this.terminate(id, {
          state: 'cancelled',
          detail: workerDetail('task was cancelled on the worker (cancel does not stop work); the work may still be running', outcome.text, outcome.truncated),
          workMayStillBeRunning: true,
          contacted: true,
        });
        return;
      case 'accepted':
        await this.learnTaskId(id, outcome.taskId);
        await this.follow(id);
        return;
      case 'not_found':
        if (origin === 'send') await this.fail(id, 'error', 'worker answered "task not found" to the dispatch itself', true, false);
        else await this.workerLost(id);
        return;
      case 'unreachable':
        this.markUnreachable(rec.workerId, outcome.error);
        // A dropped message/send is harmless: the job may be running. Find out instead of guessing.
        await this.recover(id);
        return;
      case 'auth':
        this.markUnreachable(rec.workerId, 'auth');
        // If the job was already dispatched (task id known, or already working) an auth failure on
        // a later call says nothing about whether the worker is still running it.
        await this.fail(id, 'error', 'worker rejected the bearer token (authentication failed)', false, Boolean(rec.a2aTaskId) || rec.state === 'working');
        return;
      case 'error':
        await this.terminate(id, {
          state: 'failed',
          // An over-limit reply is a bad RESULT (RFC: over the cap => invalid_result), not a worker fault.
          failureReason: outcome.tooLarge ? 'invalid_result' : 'error',
          detail: { message: `unexpected worker response: ${outcome.message}`, untrusted: true },
          workMayStillBeRunning: true,
          contacted: true,
        });
        return;
    }
  }

  private async fail(id: string, reason: FailureReason, message: string, untrusted: boolean, mayRun: boolean): Promise<void> {
    await this.terminate(id, {
      state: 'failed',
      failureReason: reason,
      detail: { message, untrusted },
      ...(mayRun ? { workMayStillBeRunning: true } : {}),
    });
  }

  private async workerLost(id: string): Promise<void> {
    await this.terminate(id, {
      state: 'failed',
      failureReason: 'worker_lost',
      detail: {
        message: 'restarted_or_evicted: the worker has no record of this job (it restarted, evicted the task, or never received it). This is NOT proof that no side effects happened; a retry must be a new delegation.',
        untrusted: false,
      },
      workMayStillBeRunning: false,
      contacted: true,
    });
  }

  private async complete(id: string, text: string, truncated: boolean): Promise<void> {
    const rec = this.deps.store.get(id);
    if (!rec) return;
    if (truncated) {
      await this.terminate(id, {
        state: 'failed',
        failureReason: 'invalid_result',
        detail: workerDetail('reply exceeded the 64 KB result cap and was truncated', text, true),
        contacted: true,
      });
      return;
    }
    const snapshotDir = this.deps.snapshots.dirFor(rec.projectId, rec.baseSha);
    const verdict = await validateTriageResult(text, snapshotDir);
    if (!verdict.ok) {
      await this.terminate(id, { state: 'failed', failureReason: 'invalid_result', detail: workerDetail(verdict.reason, text, false), contacted: true });
      return;
    }
    await this.terminate(id, {
      state: 'completed',
      result: { untrusted: true, label: RESULT_LABEL, verdict: verdict.verdict, warnings: verdict.warnings },
      contacted: true,
    });
  }

  /** Follow a known task to its end: subscribe first, then poll `tasks/get`. */
  private async follow(id: string): Promise<void> {
    let useSubscribe = true;
    for (;;) {
      const rec = this.deps.store.get(id);
      const signal = this.signalFor(id);
      if (!rec || isTerminalState(rec.state) || !signal || signal.aborted) return;
      if (!rec.a2aTaskId) return;
      const endpoint = await this.endpointFor(rec);
      if (!endpoint.ok) {
        await this.fail(id, 'error', endpoint.reason, false, true);
        return;
      }
      const opts = { timeoutMs: this.remainingMs(rec), signal };
      const o = useSubscribe
        ? await this.deps.client.subscribe(endpoint.ep, rec.a2aTaskId, opts)
        : await this.deps.client.get(endpoint.ep, rec.a2aTaskId, { ...opts, timeoutMs: this.t.callTimeoutMs });
      if (o.kind === 'accepted') {
        await this.touch(id);
        useSubscribe = false;
        await sleep(this.t.pollIntervalMs, signal);
        continue;
      }
      if (o.kind === 'error' && useSubscribe) {
        useSubscribe = false; // subscribe unsupported or malformed; fall back to polling
        continue;
      }
      await this.handle(id, o, 'follow');
      return;
    }
  }

  /**
   * Reconcile one unfinished delegation with the worker (RFC section 3.3). Used at startup
   * and after a dropped dispatch connection.
   */
  private async recover(id: string): Promise<void> {
    const started = this.now();
    let attempt = 0;
    for (;;) {
      const rec = this.deps.store.get(id);
      const signal = this.signalFor(id);
      if (!rec || isTerminalState(rec.state) || !signal || signal.aborted) return;
      const endpoint = await this.endpointFor(rec);
      if (!endpoint.ok) {
        await this.fail(id, 'error', endpoint.reason, false, true);
        return;
      }
      const opts = { timeoutMs: this.t.callTimeoutMs, signal };
      let o: A2aOutcome;
      if (rec.a2aTaskId) {
        o = await this.deps.client.get(endpoint.ep, rec.a2aTaskId, opts);
      } else {
        const l = await this.deps.client.listByContext(endpoint.ep, rec.contextId, opts);
        if (l.kind === 'tasks') {
          if (l.tasks.length === 0) {
            await this.workerLost(id);
            return;
          }
          await this.learnTaskId(id, l.tasks[0]!.taskId);
          continue; // next pass collects the task via tasks/get
        }
        o = l;
      }
      if (signal.aborted) return;
      if (o.kind === 'unreachable') {
        this.markUnreachable(rec.workerId, o.error);
        if (this.now() - started >= this.t.recoveryGraceMs) {
          await this.terminate(id, {
            state: 'failed',
            failureReason: 'worker_unreachable',
            detail: { message: 'the worker did not answer within the recovery window; the job may still be running on it', untrusted: false },
            workMayStillBeRunning: true,
          });
          return;
        }
        const backoff = this.t.recoveryBackoffMs[Math.min(attempt, this.t.recoveryBackoffMs.length - 1)] ?? 1_000;
        attempt++;
        await sleep(backoff, signal);
        continue;
      }
      if (o.kind === 'accepted') {
        await this.learnTaskId(id, o.taskId);
        await this.follow(id);
        return;
      }
      await this.handle(id, o, 'recover');
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Terminal transitions
  // -------------------------------------------------------------------------

  /** Move a delegation to a terminal state. The first terminal write wins; later ones are no-ops. */
  private async terminate(id: string, t: Terminal): Promise<boolean> {
    let from: DelegationState | undefined;
    const done = await this.deps.store.transact((records) => {
      const rec = records.find((r) => r.id === id);
      if (!rec || isTerminalState(rec.state)) return { result: false };
      from = rec.state;
      const next: Delegation = {
        ...rec,
        state: t.state,
        ...(t.failureReason ? { failureReason: t.failureReason } : {}),
        ...(t.detail ? { detail: t.detail } : {}),
        ...(t.result ? { result: t.result } : {}),
        ...(t.workMayStillBeRunning !== undefined ? { workMayStillBeRunning: t.workMayStillBeRunning } : {}),
        ...(t.contacted ? { lastWorkerContactAt: this.now() } : {}),
        finishedAt: this.now(),
      };
      return { next: records.map((r) => (r.id === id ? next : r)), result: true };
    });
    if (!done) return false;
    const a = this.active.get(id);
    if (a) {
      if (a.timer) clearTimeout(a.timer);
      a.ctl.abort();
      this.active.delete(id);
    }
    const rec = this.deps.store.get(id);
    // Never log detail text or result bodies (worker-authored); codes and ids only.
    this.event('transition', {
      id,
      from,
      to: t.state,
      reason: t.failureReason,
      worker: rec?.workerId,
      a2aTaskId: rec?.a2aTaskId,
      workMayStillBeRunning: t.workMayStillBeRunning,
    });
    this.queueSnapshotCleanup();
    return true;
  }

  private queueSnapshotCleanup(): void {
    if (this.cleanupQueued || this.stopped) return;
    this.cleanupQueued = true;
    const p = (async () => {
      await Promise.resolve();
      this.cleanupQueued = false;
      // A function, so it is re-evaluated under the snapshot lock at deletion time.
      const keep = (): ReadonlySet<string> =>
        new Set(this.deps.store.list().filter((r) => !isTerminalState(r.state)).map((r) => snapshotKey(r.projectId, r.baseSha)));
      await this.deps.snapshots.cleanup(keep);
    })().catch((err: unknown) => this.event('snapshot_cleanup_failed', { error: errName(err) }));
    const wrapped: Promise<unknown> = p.finally(() => this.background.delete(wrapped));
    this.background.add(wrapped);
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.log(JSON.stringify({ component: 'delegation', event, ...fields }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unusableWorkers(
  workers: readonly ValidatedWorker[],
  tokens: ReadonlyMap<string, string | undefined>,
  extraWeakHashes: readonly string[] = [],
): Set<string> {
  return new Set(checkWorkerTokens(workers.map((w) => w.name), tokens, extraWeakHashes).flatMap((i) => (i.worker ? [i.worker] : [])));
}

function idempotencyConflict(): ServiceError {
  return {
    code: 'idempotency_conflict',
    httpStatus: 409,
    message: 'an unfinished delegation with this (parentTaskId, key) exists but was requested with a different kind, project or issue',
  };
}

/** A detail whose text came from the worker: kept short and flagged untrusted. */
function workerDetail(prefix: string, workerText: string, truncated: boolean): DelegationDetail {
  const excerpt = workerText.length > EXCERPT_CHARS ? `${workerText.slice(0, EXCERPT_CHARS)}...` : workerText;
  return {
    message: excerpt ? `${prefix}. Worker text (untrusted): ${JSON.stringify(excerpt)}` : prefix,
    untrusted: true,
    ...(truncated ? { truncated: true } : {}),
  };
}

function errName(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | undefined;
  return String(e?.code ?? e?.name ?? 'error');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
