/**
 * Durable retro-verify queue for merges made without CI verification (issue #1689).
 *
 * When CI is billing-blocked or otherwise signal-absent, PRs can merge to the
 * base branch with no verification (see the CI-signal-absent merge gate, #1688).
 * Nothing re-checks those commits once verification capacity returns, so a
 * latent regression in a blind-merged batch can reach prod before the suite is
 * ever run against it.
 *
 * This module is the durable core of the fix: every merge made under a
 * signal-absent regime (or explicitly `verified-locally`) is enqueued with its
 * SHA + PR number + reason. When CI/capacity recovers, a background drain
 * re-runs verification against each queued commit via an injected `verify`
 * callback; on failure it files a P1 identifying the offending commit via an
 * injected `fileP1` callback. The queue dedups by SHA (idempotent enqueue),
 * is bounded by size + age, and is JSONL-file-backed so it survives a daemon
 * restart.
 *
 * The daemon-side wiring (the CI-recovery probe that triggers the drain, the
 * concrete verification runner, and the GitHub P1 filer) live outside this
 * module and are injected as callbacks — same split as the signal outbox
 * (#1541), where the durable queue is decoupled from HTTP delivery.
 *
 * Spool path is user-scoped (`~/.kookr/playbook-state/retro-verify-queue/`),
 * the same trust boundary as the signal outbox and lesson-write spool.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const RETRO_VERIFY_QUEUE_SCHEMA = 'retro-verify-queue.v1' as const;
export const RETRO_VERIFY_QUEUE_DIR_REL = join('playbook-state', 'retro-verify-queue');
export const RETRO_VERIFY_QUEUE_PENDING_FILE = 'pending.jsonl';

/** Hard cap on queued entries so a long signal-absent window cannot grow unbounded. */
export const DEFAULT_RETRO_VERIFY_MAX_ENTRIES = 500;

/**
 * Drop entries older than this (default 30 days). Recovery can lag by days, so
 * this is intentionally longer than the signal outbox's 48h — but still bounded
 * so an abandoned queue self-cleans.
 */
export const DEFAULT_RETRO_VERIFY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetroVerifyEntry {
  schemaVersion: typeof RETRO_VERIFY_QUEUE_SCHEMA;
  /** Merged commit SHA. Idempotency key; the queue dedups on this. Lowercased. */
  sha: string;
  /** GitHub PR number that merged this commit (0 when unknown). */
  prNumber: number;
  /** owner/repo the commit belongs to. */
  repo: string;
  /** Why it was enqueued, e.g. 'ci-signal-absent' or 'verified-locally'. */
  reason: string;
  /** ISO timestamp the entry was first enqueued. */
  createdAt: string;
  attemptCount?: number;
  lastError?: string;
  /**
   * Set true once verification has already failed for this commit but the P1
   * filing has not yet succeeded. A re-drain then retries only the P1 filing,
   * without re-running the (expensive, already-conclusive) verification.
   */
  verifyFailed?: boolean;
  /**
   * The verification failure reason, captured when `verifyFailed` is first set.
   * Kept distinct from `lastError` (which may hold a later P1-filing/transport
   * error) so the eventually-filed P1 still reports *why the commit is bad*,
   * not why an intermediate filing attempt hiccuped.
   */
  verifyError?: string;
}

export interface EnqueueRetroVerifyResult {
  enqueued: boolean;
  reason: 'enqueued' | 'duplicate';
  sha: string;
  path: string;
  /** Entries dropped by the size/age bound during this enqueue. */
  pruned: number;
}

/** Result of verifying a single queued commit. */
export type VerifyResult =
  /** Verification ran and passed — dequeue the entry. */
  | { outcome: 'pass' }
  /** Verification ran and failed — file a P1, then dequeue. */
  | { outcome: 'fail'; error?: string }
  /** CI/capacity still not recovered — keep for a later drain. */
  | { outcome: 'unavailable'; error?: string };

export type VerifyFn = (entry: RetroVerifyEntry) => Promise<VerifyResult>;

/** Result of filing a P1 for a failed retro-verification. */
export interface FileP1Result {
  filed: boolean;
  /** Optional human-readable reference (issue URL/number) for logging. */
  issueRef?: string;
}

export type FileP1Fn = (entry: RetroVerifyEntry, error?: string) => Promise<FileP1Result>;

export interface DrainRetroVerifyResult {
  attempted: number;
  passed: number;
  failed: number;
  unavailable: number;
  p1Filed: number;
  remaining: number;
  passedShas: string[];
  failedShas: string[];
  p1FiledShas: string[];
}

export function defaultRetroVerifyQueueDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KOOKR_RETRO_VERIFY_QUEUE_DIR?.trim();
  if (override) return override;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.kookr', RETRO_VERIFY_QUEUE_DIR_REL);
}

export function retroVerifyQueuePendingPath(spoolDir: string): string {
  return join(spoolDir, RETRO_VERIFY_QUEUE_PENDING_FILE);
}

/** Normalize a SHA for use as the idempotency key: trim + lowercase. */
export function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function buildRetroVerifyEntry(input: {
  sha: string;
  prNumber?: number;
  repo: string;
  reason: string;
  createdAt?: string;
  attemptCount?: number;
  lastError?: string;
  verifyFailed?: boolean;
}): RetroVerifyEntry {
  const sha = normalizeSha(input.sha);
  if (!sha) throw new Error('sha is required');
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`invalid sha: ${input.sha}`);
  const repo = input.repo.trim();
  if (!repo) throw new Error('repo is required');
  const reason = input.reason.trim();
  if (!reason) throw new Error('reason is required');
  const prNumber = input.prNumber ?? 0;
  if (!Number.isInteger(prNumber) || prNumber < 0) {
    throw new Error(`invalid prNumber: ${String(input.prNumber)}`);
  }
  return {
    schemaVersion: RETRO_VERIFY_QUEUE_SCHEMA,
    sha,
    prNumber,
    repo,
    reason,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(typeof input.attemptCount === 'number' ? { attemptCount: input.attemptCount } : {}),
    ...(input.lastError ? { lastError: input.lastError.slice(0, 500) } : {}),
    ...(input.verifyFailed ? { verifyFailed: true } : {}),
  };
}

function isValidEntry(parsed: Partial<RetroVerifyEntry>): parsed is RetroVerifyEntry {
  return (
    parsed.schemaVersion === RETRO_VERIFY_QUEUE_SCHEMA
    && typeof parsed.sha === 'string'
    && parsed.sha.length > 0
    && typeof parsed.prNumber === 'number'
    && Number.isInteger(parsed.prNumber)
    && typeof parsed.repo === 'string'
    && parsed.repo.length > 0
    && typeof parsed.reason === 'string'
    && parsed.reason.length > 0
    && typeof parsed.createdAt === 'string'
  );
}

/** Read and parse the pending queue; malformed lines are skipped, dedup by SHA. */
export async function readPendingRetroVerify(spoolDir: string): Promise<RetroVerifyEntry[]> {
  const path = retroVerifyQueuePendingPath(spoolDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const bySha = new Map<string, RetroVerifyEntry>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RetroVerifyEntry>;
      if (isValidEntry(parsed)) {
        bySha.set(parsed.sha, {
          schemaVersion: RETRO_VERIFY_QUEUE_SCHEMA,
          sha: parsed.sha,
          prNumber: parsed.prNumber,
          repo: parsed.repo,
          reason: parsed.reason,
          createdAt: parsed.createdAt,
          ...(typeof parsed.attemptCount === 'number' ? { attemptCount: parsed.attemptCount } : {}),
          ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
          ...(parsed.verifyFailed === true ? { verifyFailed: true } : {}),
          ...(typeof parsed.verifyError === 'string' ? { verifyError: parsed.verifyError } : {}),
        });
      }
    } catch {
      // tolerate corrupt lines
    }
  }
  return Array.from(bySha.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Apply size + age bounds. Oldest entries are dropped first when over the
 * max-entry cap. Returns the kept list and how many were pruned.
 */
export function boundRetroVerifyQueue(
  entries: readonly RetroVerifyEntry[],
  opts: {
    now?: Date;
    maxEntries?: number;
    maxAgeMs?: number;
  } = {},
): { kept: RetroVerifyEntry[]; pruned: number } {
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxEntries = opts.maxEntries ?? DEFAULT_RETRO_VERIFY_MAX_ENTRIES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RETRO_VERIFY_MAX_AGE_MS;

  const fresh = entries.filter((e) => {
    const created = Date.parse(e.createdAt);
    if (!Number.isFinite(created)) return false;
    return nowMs - created <= maxAgeMs;
  });
  const ageDropped = entries.length - fresh.length;

  let kept = fresh;
  let sizeDropped = 0;
  if (kept.length > maxEntries) {
    const sorted = [...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    sizeDropped = sorted.length - maxEntries;
    kept = sorted.slice(sizeDropped);
  }

  return { kept, pruned: ageDropped + sizeDropped };
}

async function rewritePending(spoolDir: string, entries: RetroVerifyEntry[]): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  const path = retroVerifyQueuePendingPath(spoolDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = entries.length === 0
    ? ''
    : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

/**
 * Enqueue a merged commit for retro-verification. Duplicate SHAs are skipped so
 * a concurrent/retry enqueue never double-queues the same commit. Bounds are
 * enforced on every enqueue.
 */
export async function enqueueRetroVerify(
  spoolDir: string,
  entry: RetroVerifyEntry,
  opts: {
    now?: Date;
    maxEntries?: number;
    maxAgeMs?: number;
  } = {},
): Promise<EnqueueRetroVerifyResult> {
  await mkdir(spoolDir, { recursive: true });
  const path = retroVerifyQueuePendingPath(spoolDir);
  const existing = await readPendingRetroVerify(spoolDir);
  if (existing.some((e) => e.sha === entry.sha)) {
    return { enqueued: false, reason: 'duplicate', sha: entry.sha, path, pruned: 0 };
  }
  const { kept, pruned } = boundRetroVerifyQueue([...existing, entry], opts);
  // If the brand-new entry was itself pruned (queue at cap with equal-age
  // edge-cases), force-keep it by dropping one more oldest non-self entry.
  if (!kept.some((e) => e.sha === entry.sha)) {
    const withoutSelf = boundRetroVerifyQueue(existing, {
      ...opts,
      maxEntries: Math.max(0, (opts.maxEntries ?? DEFAULT_RETRO_VERIFY_MAX_ENTRIES) - 1),
    }).kept;
    await rewritePending(spoolDir, [...withoutSelf, entry]);
    return { enqueued: true, reason: 'enqueued', sha: entry.sha, path, pruned: pruned + 1 };
  }
  await rewritePending(spoolDir, kept);
  return { enqueued: true, reason: 'enqueued', sha: entry.sha, path, pruned };
}

/**
 * Remove an entry by SHA. No-op when absent. Returns true when an entry was
 * removed.
 */
export async function removeRetroVerifyEntry(spoolDir: string, sha: string): Promise<boolean> {
  const key = normalizeSha(sha);
  const pending = await readPendingRetroVerify(spoolDir);
  const next = pending.filter((e) => e.sha !== key);
  if (next.length === pending.length) return false;
  await rewritePending(spoolDir, next);
  return true;
}

/**
 * Drain the queue by re-verifying each pending commit via `verify`. On a `pass`
 * the entry is dequeued. On a `fail` the entry is handed to `fileP1` (if given)
 * and dequeued once a P1 is filed; if `fileP1` throws or reports `filed:false`
 * the entry is kept and marked `verifyFailed` so the next drain retries only
 * the P1 filing (not the verification). On `unavailable` (CI/capacity still
 * down) the entry is kept for a later drain.
 *
 * An entry already marked `verifyFailed` skips `verify` entirely and goes
 * straight to the `fileP1` retry — the verification verdict is durable.
 */
export async function drainRetroVerifyQueue(opts: {
  spoolDir: string;
  verify: VerifyFn;
  fileP1?: FileP1Fn;
  now?: Date;
  maxEntries?: number;
  maxAgeMs?: number;
}): Promise<DrainRetroVerifyResult> {
  const raw = await readPendingRetroVerify(opts.spoolDir);
  const { kept: pending } = boundRetroVerifyQueue(raw, {
    now: opts.now,
    maxEntries: opts.maxEntries,
    maxAgeMs: opts.maxAgeMs,
  });
  if (pending.length !== raw.length) {
    await rewritePending(opts.spoolDir, pending);
  }

  const empty: DrainRetroVerifyResult = {
    attempted: 0,
    passed: 0,
    failed: 0,
    unavailable: 0,
    p1Filed: 0,
    remaining: 0,
    passedShas: [],
    failedShas: [],
    p1FiledShas: [],
  };
  if (pending.length === 0) return empty;

  const remaining: RetroVerifyEntry[] = [];
  const passedShas: string[] = [];
  const failedShas: string[] = [];
  const p1FiledShas: string[] = [];
  let passed = 0;
  let failed = 0;
  let unavailable = 0;
  let p1Filed = 0;

  // Attempt to file a P1 for a failed commit and decide the entry's fate.
  // Shared by fresh failures and verifyFailed retries. `verifyError` is the
  // verification failure reason — the P1's payload — and is preserved across
  // retries independently of `lastError` (which tracks the latest P1-filing
  // hiccup) so the filed P1 always names the real cause.
  const handleFailure = async (entry: RetroVerifyEntry, verifyError?: string): Promise<void> => {
    failed += 1;
    failedShas.push(entry.sha);
    if (!opts.fileP1) {
      // Caller opted out of P1 filing: dequeue the failed entry.
      return;
    }
    let result: FileP1Result;
    try {
      result = await opts.fileP1(entry, verifyError);
    } catch (err) {
      remaining.push({
        ...entry,
        verifyFailed: true,
        ...(verifyError ? { verifyError } : {}),
        attemptCount: (entry.attemptCount ?? 0) + 1,
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
      return;
    }
    if (result.filed) {
      p1Filed += 1;
      p1FiledShas.push(entry.sha);
      return;
    }
    // P1 not filed and no throw: keep for retry, remembering the verify cause.
    remaining.push({
      ...entry,
      verifyFailed: true,
      ...(verifyError ? { verifyError, lastError: verifyError.slice(0, 500) } : {}),
      attemptCount: (entry.attemptCount ?? 0) + 1,
    });
  };

  for (const entry of pending) {
    // Verification already failed on a prior drain — only the P1 filing is
    // outstanding. Retry the filing without re-running verification, passing the
    // preserved verify cause (not the transient P1-filing error) to the filer.
    if (entry.verifyFailed) {
      await handleFailure(entry, entry.verifyError);
      continue;
    }

    let result: VerifyResult;
    try {
      result = await opts.verify(entry);
    } catch (err) {
      result = {
        outcome: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.outcome === 'pass') {
      passed += 1;
      passedShas.push(entry.sha);
      continue;
    }
    if (result.outcome === 'fail') {
      await handleFailure(entry, result.error);
      continue;
    }
    // unavailable: keep for a later drain. Prefer the new error, else keep the
    // prior one.
    unavailable += 1;
    const carriedError = result.error?.slice(0, 500) ?? entry.lastError;
    remaining.push({
      ...entry,
      attemptCount: (entry.attemptCount ?? 0) + 1,
      ...(carriedError ? { lastError: carriedError } : {}),
    });
  }

  await rewritePending(opts.spoolDir, remaining);

  return {
    attempted: pending.length,
    passed,
    failed,
    unavailable,
    p1Filed,
    remaining: remaining.length,
    passedShas,
    failedShas,
    p1FiledShas,
  };
}
