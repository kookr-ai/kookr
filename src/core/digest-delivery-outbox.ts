/**
 * Durable, duplicate-safe outbox for digest delivery (issue #2799).
 *
 * Background: a daily report saves a digest (e.g. "66 merged changes"), then
 * posts it to the control room. When the post times out, the digest is safe on
 * disk but the *delivery* state is lost — the next reflection has to reconstruct
 * it by hand, and a blind retry can post the same message to Discord twice.
 *
 * This module makes each digest delivery a small durable record, keyed by
 * `(reportDay, channel, contentHash)`, moving through
 * `saved → posting → posted | failed`. Every send goes through a single injected
 * chokepoint (`ControlRoomPostFn`) — the module never talks to Discord (or any
 * transport) directly, so there is no path that bypasses the control room. The
 * record `key` doubles as the idempotency key handed to the chokepoint, so a
 * blind retry after an ambiguous timeout is deduplicated on the far side rather
 * than producing a second message.
 *
 * Reconciliation retries only `failed` records, up to a bounded attempt cap, and
 * never re-posts a `posted` record — a confirmed delivery is terminal. A content
 * change produces a different `contentHash`, hence a different key, so it is a
 * *new* delivery rather than an overwrite of an already-posted digest.
 *
 * Storage is user-scoped (`~/.kookr/playbook-state/digest-outbox/`), the same
 * trust boundary as the signal outbox (#1541) and lesson-write spool (#1519).
 *
 * Operating assumptions (matching the sibling signal outbox):
 * - **Single writer.** Like the signal outbox, the store is driven by the local
 *   daemon; `saveDigest` / `deliverDigest` / `reconcile` are not run
 *   concurrently against the same directory. The read-modify-write is atomic per
 *   file (`atomicWriteFile`) but not across the read, so concurrent writers
 *   could lose a record — out of scope under the single-writer model.
 * - **Duplicate-safety for the reached-but-unconfirmed case rests on the
 *   chokepoint deduping on `key`.** A timeout / ambiguous response cannot tell
 *   whether the message actually landed, so `reconcile` re-posts with the same
 *   idempotency `key`; the control room MUST dedup on it to avoid a second
 *   message. This module's job is to make that key stable and durable; a
 *   confirmed delivery is additionally guarded locally and never re-posted.
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';

export const DIGEST_OUTBOX_SCHEMA = 'digest-delivery-outbox.v1' as const;
export const DIGEST_OUTBOX_DIR_REL = join('playbook-state', 'digest-outbox');
export const DIGEST_OUTBOX_RECORDS_FILE = 'records.json';

/**
 * Bounded retry policy: a record that has consumed this many delivery attempts
 * without confirmation is left `failed` for an operator rather than retried
 * forever. Reconciliation and `deliverDigest` both honour it.
 */
export const DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS = 5;

/**
 * Retention for terminal records. A `posted` record is kept far past its report
 * day so a re-save of the identical digest is still recognised as a duplicate
 * and not re-posted; a `failed` record that has spent its whole attempt budget
 * is dead weight. Both are pruned by `reconcile` once older than this (default
 * 90 days) so `records.json` cannot grow without bound. Digests are daily, so
 * 90 days is far longer than any realistic re-save window.
 */
export const DEFAULT_DIGEST_OUTBOX_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Lifecycle states for a single digest delivery. */
export type DigestDeliveryState = 'saved' | 'posting' | 'posted' | 'failed';

export interface DigestDeliveryRecord {
  schemaVersion: typeof DIGEST_OUTBOX_SCHEMA;
  /** Deterministic idempotency key: `reportDay|channel|contentHash`. */
  key: string;
  /** Report day this digest belongs to, e.g. `2026-08-23`. */
  reportDay: string;
  /** Destination channel id (the control-room-routed target). */
  channel: string;
  /** Content hash — the identity of the digest body. */
  contentHash: string;
  /** The digest payload, retained so a `failed` record can be re-posted. */
  content: string;
  state: DigestDeliveryState;
  /** Number of delivery attempts consumed (bounded by maxAttempts). */
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  /** Last error text captured on a timeout/ambiguous/failed response. */
  lastError?: string;
  /** ISO timestamp of the most recent delivery attempt. */
  lastAttemptAt?: string;
  /** Control-room message id captured on a confirmed post (proof of delivery). */
  messageId?: string;
}

/** Result the control-room chokepoint returns for one post attempt. */
export type ControlRoomPostResult =
  | { outcome: 'confirmed'; messageId?: string }
  | { outcome: 'timeout'; error?: string }
  | { outcome: 'ambiguous'; error?: string }
  | { outcome: 'failed'; error?: string };

/**
 * The single send chokepoint. The outbox calls this and nothing else to deliver
 * a digest; `key` is the idempotency key the control room dedups on.
 */
export type ControlRoomPostFn = (req: {
  key: string;
  reportDay: string;
  channel: string;
  content: string;
  contentHash: string;
  attempt: number;
}) => Promise<ControlRoomPostResult>;

export type SaveDigestOutcome = 'created' | 'exists' | 'already_posted';

export interface SaveDigestResult {
  outcome: SaveDigestOutcome;
  record: DigestDeliveryRecord;
}

export type DeliverDigestOutcome =
  | { outcome: 'posted'; record: DigestDeliveryRecord }
  | { outcome: 'already_posted'; record: DigestDeliveryRecord }
  | { outcome: 'failed'; reason: 'timeout' | 'ambiguous' | 'failed'; record: DigestDeliveryRecord }
  | { outcome: 'exhausted'; record: DigestDeliveryRecord }
  | { outcome: 'not_found'; key: string };

export interface ReconcileResult {
  attempted: number;
  posted: number;
  stillFailed: number;
  exhausted: number;
  /** Terminal records dropped by retention during this reconcile. */
  pruned: number;
  results: DeliverDigestOutcome[];
}

export interface DeliverOpts {
  now?: Date;
  maxAttempts?: number;
}

export interface ReconcileOpts extends DeliverOpts {
  /** Retention window for pruning terminal records. */
  maxAgeMs?: number;
}

export function defaultDigestOutboxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KOOKR_DIGEST_OUTBOX_DIR?.trim();
  if (override) return override;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.kookr', DIGEST_OUTBOX_DIR_REL);
}

export function digestOutboxRecordsPath(spoolDir: string): string {
  return join(spoolDir, DIGEST_OUTBOX_RECORDS_FILE);
}

/** sha256 of the digest body, truncated to 32 hex chars (collision-safe here). */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

/** Deterministic idempotency key for a (day, channel, content) delivery. */
export function deliveryKey(input: {
  reportDay: string;
  channel: string;
  contentHash: string;
}): string {
  return `${input.reportDay}|${input.channel}|${input.contentHash}`;
}

interface DigestOutboxFile {
  schemaVersion: typeof DIGEST_OUTBOX_SCHEMA;
  records: DigestDeliveryRecord[];
}

const VALID_STATES: ReadonlySet<DigestDeliveryState> = new Set([
  'saved',
  'posting',
  'posted',
  'failed',
]);

function isValidRecord(parsed: Partial<DigestDeliveryRecord>): parsed is DigestDeliveryRecord {
  const shapeOk = (
    parsed.schemaVersion === DIGEST_OUTBOX_SCHEMA
    && typeof parsed.key === 'string'
    && parsed.key.length > 0
    && typeof parsed.reportDay === 'string'
    && typeof parsed.channel === 'string'
    && typeof parsed.contentHash === 'string'
    && typeof parsed.content === 'string'
    && typeof parsed.state === 'string'
    && VALID_STATES.has(parsed.state as DigestDeliveryState)
    && typeof parsed.attemptCount === 'number'
    && typeof parsed.createdAt === 'string'
    && typeof parsed.updatedAt === 'string'
  );
  if (!shapeOk) return false;
  // Corruption guard: the key must be the canonical function of its identity
  // fields and the hash must match the content, or a tampered/rotted record
  // could be posted under a mislabelled key.
  const expectedHash = computeContentHash(parsed.content!);
  if (parsed.contentHash !== expectedHash) return false;
  const expectedKey = deliveryKey({
    reportDay: parsed.reportDay!,
    channel: parsed.channel!,
    contentHash: expectedHash,
  });
  return parsed.key === expectedKey;
}

/**
 * Read all delivery records keyed by their idempotency key. Malformed records
 * are skipped; on a later duplicate key the last valid one wins.
 */
export async function readDigestRecords(spoolDir: string): Promise<Map<string, DigestDeliveryRecord>> {
  const path = digestOutboxRecordsPath(spoolDir);
  const file = await readJsonFile<DigestOutboxFile>(path, {
    schemaVersion: DIGEST_OUTBOX_SCHEMA,
    records: [],
  });
  const byKey = new Map<string, DigestDeliveryRecord>();
  const rows = Array.isArray(file.records) ? file.records : [];
  for (const row of rows) {
    if (isValidRecord(row)) byKey.set(row.key, row);
  }
  return byKey;
}

async function writeDigestRecords(
  spoolDir: string,
  byKey: Map<string, DigestDeliveryRecord>,
): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  const path = digestOutboxRecordsPath(spoolDir);
  const records = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  await atomicWriteFile(path, `${JSON.stringify({ schemaVersion: DIGEST_OUTBOX_SCHEMA, records }, null, 2)}\n`);
}

/**
 * Ensure a durable `saved` record exists for this (day, channel, content).
 *
 * - New key → a fresh `saved` record (`created`).
 * - Existing key already `posted` → `already_posted`, left untouched: re-saving
 *   the identical digest never resets a confirmed delivery.
 * - Existing key in any other state → `exists`, returned unchanged so an
 *   in-flight or failed attempt keeps its attempt count and error.
 *
 * A changed body hashes differently, so it is a different key and a *new*
 * delivery rather than an overwrite of the already-posted digest.
 */
export async function saveDigest(
  spoolDir: string,
  input: { reportDay: string; channel: string; content: string },
  opts: { now?: Date } = {},
): Promise<SaveDigestResult> {
  const reportDay = input.reportDay.trim();
  const channel = input.channel.trim();
  if (!reportDay) throw new Error('reportDay is required');
  if (!channel) throw new Error('channel is required');
  if (!input.content.trim()) throw new Error('content is required');
  const contentHash = computeContentHash(input.content);
  const key = deliveryKey({ reportDay, channel, contentHash });

  const byKey = await readDigestRecords(spoolDir);
  const existing = byKey.get(key);
  if (existing) {
    return {
      outcome: existing.state === 'posted' ? 'already_posted' : 'exists',
      record: existing,
    };
  }

  const nowIso = (opts.now ?? new Date()).toISOString();
  const record: DigestDeliveryRecord = {
    schemaVersion: DIGEST_OUTBOX_SCHEMA,
    key,
    reportDay,
    channel,
    contentHash,
    content: input.content,
    state: 'saved',
    attemptCount: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  byKey.set(key, record);
  await writeDigestRecords(spoolDir, byKey);
  return { outcome: 'created', record };
}

/**
 * Attempt one delivery of the record at `key` through the control-room
 * chokepoint.
 *
 * - `posted` already → `already_posted`, with **no** call to `post`: a confirmed
 *   delivery is never re-sent, so a duplicate run cannot duplicate the message.
 * - attempt budget already spent → `exhausted`, with no call to `post`.
 * - otherwise transition `posting`, call `post` once with the key as the
 *   idempotency token, and land in `posted` (confirmed) or `failed`
 *   (timeout / ambiguous / failed) with the response error captured durably.
 */
export async function deliverDigest(
  spoolDir: string,
  key: string,
  post: ControlRoomPostFn,
  opts: DeliverOpts = {},
): Promise<DeliverDigestOutcome> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS;
  const byKey = await readDigestRecords(spoolDir);
  const record = byKey.get(key);
  if (!record) return { outcome: 'not_found', key };

  // A confirmed delivery is terminal — never re-post it.
  if (record.state === 'posted') return { outcome: 'already_posted', record };

  // Bounded retry ceiling: leave it failed for an operator, don't post again.
  if (record.attemptCount >= maxAttempts) {
    return { outcome: 'exhausted', record };
  }

  const nowIso = (opts.now ?? new Date()).toISOString();
  const attempt = record.attemptCount + 1;
  const posting: DigestDeliveryRecord = {
    ...record,
    state: 'posting',
    attemptCount: attempt,
    lastAttemptAt: nowIso,
    updatedAt: nowIso,
  };
  byKey.set(key, posting);
  await writeDigestRecords(spoolDir, byKey);

  let result: ControlRoomPostResult;
  try {
    result = await post({
      key: record.key,
      reportDay: record.reportDay,
      channel: record.channel,
      content: record.content,
      contentHash: record.contentHash,
      attempt,
    });
  } catch (err) {
    result = { outcome: 'timeout', error: err instanceof Error ? err.message : String(err) };
  }

  const settledAt = (opts.now ?? new Date()).toISOString();
  if (result.outcome === 'confirmed') {
    const posted: DigestDeliveryRecord = {
      ...posting,
      state: 'posted',
      updatedAt: settledAt,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
    delete (posted as { lastError?: string }).lastError;
    byKey.set(key, posted);
    await writeDigestRecords(spoolDir, byKey);
    return { outcome: 'posted', record: posted };
  }

  // timeout | ambiguous | failed → durable failed state with the response error.
  const failed: DigestDeliveryRecord = {
    ...posting,
    state: 'failed',
    updatedAt: settledAt,
    lastError: (result.error ?? result.outcome).slice(0, 500),
  };
  byKey.set(key, failed);
  await writeDigestRecords(spoolDir, byKey);
  return { outcome: 'failed', reason: result.outcome, record: failed };
}

/** A record needs recovery unless it is confirmed (`posted`) or dead (`failed`
 * with its whole attempt budget spent). */
function needsRecovery(r: DigestDeliveryRecord, maxAttempts: number): boolean {
  if (r.state === 'posted') return false;
  if (r.state === 'failed' && r.attemptCount >= maxAttempts) return false;
  return true;
}

/**
 * Every record that is not a confirmed delivery — surfaced to the next
 * scheduled run so an operator sees unresolved digests. This is a superset of
 * what `reconcile` retries: it also includes budget-spent `failed` records,
 * which `reconcile` no longer retries but which still need an operator's eyes.
 */
export async function listUnreconciled(spoolDir: string): Promise<DigestDeliveryRecord[]> {
  const byKey = await readDigestRecords(spoolDir);
  return Array.from(byKey.values())
    .filter((r) => r.state !== 'posted')
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Reconcile the outbox: drive every record that still needs delivery through
 * the chokepoint. This is the single, complete recovery loop — it covers
 * `failed` records (retry within the attempt bound), `saved` records a crash
 * left before their first attempt, and records stranded in `posting` by a crash
 * between the pre-post write and the response. Retrying any of these is safe
 * because the record `key` is the idempotency key, so a delivery that actually
 * landed is deduplicated on the far side rather than duplicated. Already-`posted`
 * records are never touched, so a confirmed delivery is not re-posted.
 *
 * After delivery, terminal records older than the retention window are pruned so
 * `records.json` stays bounded. Returns a per-record summary.
 */
export async function reconcile(
  spoolDir: string,
  post: ControlRoomPostFn,
  opts: ReconcileOpts = {},
): Promise<ReconcileResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS;
  const byKey = await readDigestRecords(spoolDir);
  const pendingKeys = Array.from(byKey.values())
    .filter((r) => needsRecovery(r, maxAttempts))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => r.key);

  const results: DeliverDigestOutcome[] = [];
  let posted = 0;
  let stillFailed = 0;
  let exhausted = 0;
  for (const key of pendingKeys) {
    const outcome = await deliverDigest(spoolDir, key, post, { ...opts, maxAttempts });
    results.push(outcome);
    if (outcome.outcome === 'posted' || outcome.outcome === 'already_posted') posted += 1;
    else if (outcome.outcome === 'exhausted') exhausted += 1;
    else stillFailed += 1;
  }

  const pruned = await pruneTerminalRecords(spoolDir, { ...opts, maxAttempts });

  return { attempted: pendingKeys.length, posted, stillFailed, exhausted, pruned, results };
}

/**
 * Drop terminal records older than the retention window: `posted` records (kept
 * only long enough to keep deduping re-saves) and `failed` records that have
 * spent their whole attempt budget (dead). Non-terminal records are always
 * kept — they still need action. Returns how many were pruned.
 */
export async function pruneTerminalRecords(
  spoolDir: string,
  opts: { now?: Date; maxAttempts?: number; maxAgeMs?: number } = {},
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_DIGEST_OUTBOX_MAX_AGE_MS;
  const nowMs = (opts.now ?? new Date()).getTime();
  const byKey = await readDigestRecords(spoolDir);

  let pruned = 0;
  for (const [key, r] of byKey) {
    const isDead = r.state === 'failed' && r.attemptCount >= maxAttempts;
    const isTerminal = r.state === 'posted' || isDead;
    if (!isTerminal) continue;
    const updated = Date.parse(r.updatedAt);
    if (!Number.isFinite(updated)) continue;
    if (nowMs - updated > maxAgeMs) {
      byKey.delete(key);
      pruned += 1;
    }
  }
  if (pruned > 0) await writeDigestRecords(spoolDir, byKey);
  return pruned;
}
