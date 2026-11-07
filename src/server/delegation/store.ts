import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../core/persistence-utils.js';

/**
 * Durable store for Kookr→Hermes delegations (RFC `rfc-kookr-hermes-delegation`, section 3).
 *
 * Plain-language summary: one JSON file (`<kookrDir>/delegations.json`) holds every
 * delegation record. Exactly one in-process writer touches it, one update at a time,
 * and each update is written to a temp file, fsynced and renamed over the real file, so
 * a crash leaves either the old file or the new file, never half of one. The service
 * awaits the write of the `dispatching` record BEFORE it contacts the worker (a
 * write-ahead record), so a Kookr restart can always find out what it had started.
 *
 * Why a missing file and a broken file are treated differently: a missing file is the
 * normal first boot (empty store). A file that cannot be parsed, or that declares a
 * `schemaVersion` this code does not know, must NOT read as "no delegations" - that
 * would orphan in-flight worker jobs. It disables delegation with a typed error naming
 * the file, and the operator inspects or removes it.
 *
 * This file also owns the record types ("types beside the writer"): there is only one
 * TypeScript consumer family (this directory), so no shared contract file exists.
 */

export const DELEGATION_SCHEMA_VERSION = 1 as const;

export const DELEGATION_KINDS = ['triage', 'test_audit'] as const;
export type DelegationKind = (typeof DELEGATION_KINDS)[number];

export const DELEGATION_STATES = [
  'dispatching',
  'working',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];

export const FAILURE_REASONS = [
  'worker_unreachable',
  'worker_lost',
  'worker_failed',
  'rejected',
  'needs_input',
  'invalid_result',
  'error',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export function isTerminalState(state: DelegationState): boolean {
  return state !== 'dispatching' && state !== 'working';
}

/**
 * A human-readable explanation attached to a terminal state. `untrusted` is true when
 * any part of `message` came from the worker (which may have read hostile issue text):
 * consumers must treat it as data, never as an instruction.
 */
export interface DelegationDetail {
  message: string;
  untrusted: boolean;
  /** The worker text was cut to the result cap. */
  truncated?: boolean;
}

export const TRIAGE_TYPES = ['bug', 'feature', 'chore', 'spike', 'umbrella', 'question', 'docs'] as const;
export const TRIAGE_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const TRIAGE_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export const TRIAGE_RISKS = ['low', 'medium', 'high'] as const;

export interface TriageVerdict {
  type: (typeof TRIAGE_TYPES)[number];
  priority: (typeof TRIAGE_PRIORITIES)[number];
  size: (typeof TRIAGE_SIZES)[number];
  ready_to_implement: boolean;
  needs_info: string[];
  related_issues: Array<number | string>;
  risk: (typeof TRIAGE_RISKS)[number];
  files_likely_touched: string[];
  summary: string;
  recommended_next_step: string;
}

/** Validated worker output. Always worker-authored, hence always `untrusted`. */
export interface DelegationResult {
  untrusted: true;
  label: string;
  verdict: TriageVerdict;
  /** Non-fatal problems found while validating (e.g. cited paths absent from the snapshot). */
  warnings: string[];
}

export interface Delegation {
  id: string;
  schemaVersion: typeof DELEGATION_SCHEMA_VERSION;
  kind: DelegationKind;
  projectId: string;
  /** Issue number the triage covers (triage only). */
  issueRef?: number;
  /** Caller-supplied idempotency key, scoped by `parentTaskId`. */
  key?: string;
  parentTaskId?: string;
  /** Worker name from the registry (never a URL). */
  workerId: string;
  /** Commit the worker's read-only snapshot was cut from. */
  baseSha: string;
  promptVersion: string;
  /** Client-minted conversation id, `kookr-<instanceId>-<uuid>`. */
  contextId: string;
  /** Worker-minted task id, learned after dispatch via `tasks/list {contextId}`. */
  a2aTaskId?: string;
  state: DelegationState;
  failureReason?: FailureReason;
  detail?: DelegationDetail;
  /** True when the worker may still be running this job (timeout, FAILED, cancel). */
  workMayStillBeRunning?: boolean;
  /** Epoch milliseconds on Kookr's clock. The worker's timestamps are never used. */
  submittedAt: number;
  deadlineAt: number;
  lastWorkerContactAt?: number;
  finishedAt?: number;
  result?: DelegationResult;
}

export interface DelegationFileData {
  schemaVersion: typeof DELEGATION_SCHEMA_VERSION;
  /** Stable id of this Kookr instance, embedded in every contextId. */
  instanceId: string;
  delegations: Delegation[];
}

/** Why the store cannot be used. `file` is always the path the operator should look at. */
export interface DelegationStoreError {
  code: 'store_unparseable' | 'store_unknown_schema' | 'store_unreadable';
  file: string;
  message: string;
}

// Tolerant reader: unknown fields are preserved (`loose`) so a newer slice's extra
// fields survive a round trip through this code, and ignored by consumers.
const detailSchema = z.looseObject({
  message: z.string(),
  untrusted: z.boolean(),
  truncated: z.boolean().optional(),
});

const recordSchema = z.looseObject({
  id: z.string().min(1),
  schemaVersion: z.literal(DELEGATION_SCHEMA_VERSION),
  kind: z.enum(DELEGATION_KINDS),
  projectId: z.string(),
  issueRef: z.number().int().optional(),
  key: z.string().optional(),
  parentTaskId: z.string().optional(),
  workerId: z.string(),
  baseSha: z.string(),
  promptVersion: z.string(),
  contextId: z.string().min(1),
  a2aTaskId: z.string().optional(),
  state: z.enum(DELEGATION_STATES),
  failureReason: z.enum(FAILURE_REASONS).optional(),
  detail: detailSchema.optional(),
  workMayStillBeRunning: z.boolean().optional(),
  submittedAt: z.number(),
  deadlineAt: z.number(),
  lastWorkerContactAt: z.number().optional(),
  finishedAt: z.number().optional(),
  result: z.looseObject({ untrusted: z.literal(true), label: z.string(), verdict: z.unknown(), warnings: z.array(z.string()) }).optional(),
});

const fileSchema = z.looseObject({
  schemaVersion: z.number(),
  instanceId: z.string().min(1),
  delegations: z.array(z.unknown()),
});

export const DEFAULT_MAX_TERMINAL_RECORDS = 200;

export type StoreLoadResult = { ok: true } | { ok: false; error: DelegationStoreError };

/**
 * The single writer. `transact` is the only mutation entry point: callers hand it a
 * pure function over the committed records and get back what the function decided.
 * Calls run strictly one after another, so two concurrent updates cannot lose each
 * other, and the check-then-insert needed for idempotency is atomic.
 */
export class DelegationStore {
  private records: Delegation[] = [];
  private instanceId: string;
  private extra: Record<string, unknown> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(
    readonly file: string,
    private readonly options: {
      maxTerminalRecords?: number;
      /** Mints the instance id the first time the store is created. */
      newInstanceId: () => string;
    },
  ) {
    this.instanceId = options.newInstanceId();
  }

  get id(): string {
    return this.instanceId;
  }

  /** Committed (durable) records. Reads never see a record whose write has not finished. */
  list(): readonly Delegation[] {
    return this.records;
  }

  get(id: string): Delegation | undefined {
    return this.records.find((r) => r.id === id);
  }

  async load(): Promise<StoreLoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = [];
        this.loaded = true;
        return { ok: true };
      }
      return {
        ok: false,
        error: { code: 'store_unreadable', file: this.file, message: `cannot read ${this.file}: ${errorCode(err)}` },
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: { code: 'store_unparseable', file: this.file, message: `${this.file} is not valid JSON` } };
    }
    const head = fileSchema.safeParse(json);
    if (!head.success) {
      return { ok: false, error: { code: 'store_unparseable', file: this.file, message: `${this.file} does not have the expected top-level shape` } };
    }
    if (head.data.schemaVersion !== DELEGATION_SCHEMA_VERSION) {
      return {
        ok: false,
        error: {
          code: 'store_unknown_schema',
          file: this.file,
          message: `${this.file} has schemaVersion ${head.data.schemaVersion}; this build understands ${DELEGATION_SCHEMA_VERSION}`,
        },
      };
    }
    const parsed: Delegation[] = [];
    for (const item of head.data.delegations) {
      const r = recordSchema.safeParse(item);
      if (!r.success) {
        return { ok: false, error: { code: 'store_unparseable', file: this.file, message: `${this.file} contains a malformed delegation record` } };
      }
      parsed.push(r.data as unknown as Delegation);
    }
    const { schemaVersion: _s, instanceId, delegations: _d, ...extra } = head.data;
    void _s; void _d;
    this.instanceId = instanceId;
    this.extra = extra;
    this.records = parsed;
    this.loaded = true;
    return { ok: true };
  }

  /**
   * Run `fn` against the committed records. `fn` returns the next full record list
   * (or `undefined` for "no change") plus a result for the caller. The next list is
   * pruned, written atomically, and only then becomes visible to readers. A failed
   * write rejects and leaves the committed state untouched.
   */
  transact<T>(
    fn: (records: readonly Delegation[]) => { next?: Delegation[]; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (!this.loaded) throw new Error('delegation store used before load()');
      const outcome = fn(this.records);
      if (outcome.next === undefined) return outcome.result;
      const pruned = pruneTerminal(outcome.next, this.options.maxTerminalRecords ?? DEFAULT_MAX_TERMINAL_RECORDS);
      await this.write(pruned);
      this.records = pruned;
      return outcome.result;
    };
    const p = this.queue.then(run, run);
    // Keep the chain alive after a failure so later updates are not blocked forever.
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async write(records: Delegation[]): Promise<void> {
    const data: DelegationFileData & Record<string, unknown> = {
      ...this.extra,
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      instanceId: this.instanceId,
      delegations: records,
    };
    await mkdir(dirname(this.file), { recursive: true });
    await atomicWriteFile(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }
}

/** Keep every non-terminal record and only the newest `max` terminal ones. */
export function pruneTerminal(records: Delegation[], max: number): Delegation[] {
  const terminal = records.filter((r) => isTerminalState(r.state));
  if (terminal.length <= max) return records;
  const drop = new Set(
    [...terminal]
      .sort((a, b) => (b.finishedAt ?? b.submittedAt) - (a.finishedAt ?? a.submittedAt))
      .slice(max)
      .map((r) => r.id),
  );
  return records.filter((r) => !drop.has(r.id));
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? 'unknown error';
}
