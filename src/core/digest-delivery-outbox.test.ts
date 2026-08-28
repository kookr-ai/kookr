import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  computeContentHash,
  DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS,
  DIGEST_OUTBOX_SCHEMA,
  type DigestDeliveryRecord,
  deliverDigest,
  deliveryKey,
  defaultDigestOutboxDir,
  digestOutboxRecordsPath,
  type ControlRoomPostFn,
  type ControlRoomPostResult,
  listUnreconciled,
  pruneTerminalRecords,
  readDigestRecords,
  reconcile,
  saveDigest,
} from './digest-delivery-outbox.js';

async function tempSpoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-digest-outbox-'));
}

/** A control-room chokepoint whose reply per attempt is scripted. */
function scriptedPost(replies: ControlRoomPostResult[]): {
  post: ControlRoomPostFn;
  calls: Array<{ key: string; attempt: number }>;
} {
  const calls: Array<{ key: string; attempt: number }> = [];
  let i = 0;
  const post: ControlRoomPostFn = async (req) => {
    calls.push({ key: req.key, attempt: req.attempt });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply ?? { outcome: 'failed', error: 'no scripted reply' };
  };
  return { post, calls };
}

const DAY = '2026-08-23';
const CHANNEL = 'control-room';
const CONTENT = '66 merged changes today';

describe('saveDigest', () => {
  test('creates a durable saved record keyed by day + channel + content hash', async () => {
    const dir = await tempSpoolDir();
    const res = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    expect(res.outcome).toBe('created');
    expect(res.record.state).toBe('saved');
    expect(res.record.key).toBe(
      deliveryKey({ reportDay: DAY, channel: CHANNEL, contentHash: computeContentHash(CONTENT) }),
    );

    // Survives a re-read from disk.
    const byKey = await readDigestRecords(dir);
    expect(byKey.get(res.record.key)?.content).toBe(CONTENT);
  });

  test('re-saving the same digest is idempotent and returns the existing record', async () => {
    const dir = await tempSpoolDir();
    const first = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const second = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    expect(second.outcome).toBe('exists');
    expect(second.record.key).toBe(first.record.key);
    expect((await readDigestRecords(dir)).size).toBe(1);
  });

  test('rejects missing report day, channel, or content', async () => {
    const dir = await tempSpoolDir();
    await expect(saveDigest(dir, { reportDay: ' ', channel: CHANNEL, content: CONTENT })).rejects.toThrow(/reportDay/);
    await expect(saveDigest(dir, { reportDay: DAY, channel: '', content: CONTENT })).rejects.toThrow(/channel/);
    await expect(saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: '   ' })).rejects.toThrow(/content/);
  });
});

describe('readDigestRecords corruption guard', () => {
  test('drops a record whose key does not match its identity fields', async () => {
    const dir = await tempSpoolDir();
    const contentHash = computeContentHash(CONTENT);
    const tampered: DigestDeliveryRecord = {
      schemaVersion: DIGEST_OUTBOX_SCHEMA,
      key: 'attacker-supplied-key', // does not equal deliveryKey(...)
      reportDay: DAY,
      channel: CHANNEL,
      contentHash,
      content: CONTENT,
      state: 'saved',
      attemptCount: 0,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    };
    await writeFile(
      digestOutboxRecordsPath(dir),
      JSON.stringify({ schemaVersion: DIGEST_OUTBOX_SCHEMA, records: [tampered] }),
      'utf8',
    );
    expect((await readDigestRecords(dir)).size).toBe(0);
  });

  test('drops a record whose content hash does not match its content', async () => {
    const dir = await tempSpoolDir();
    const rec = {
      schemaVersion: DIGEST_OUTBOX_SCHEMA,
      key: deliveryKey({ reportDay: DAY, channel: CHANNEL, contentHash: 'deadbeef' }),
      reportDay: DAY,
      channel: CHANNEL,
      contentHash: 'deadbeef', // not the hash of CONTENT
      content: CONTENT,
      state: 'saved',
      attemptCount: 0,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    };
    await writeFile(
      digestOutboxRecordsPath(dir),
      JSON.stringify({ schemaVersion: DIGEST_OUTBOX_SCHEMA, records: [rec] }),
      'utf8',
    );
    expect((await readDigestRecords(dir)).size).toBe(0);
  });
});

describe('deliverDigest', () => {
  test('confirmed response marks the record posted with the message id', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post, calls } = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-1' }]);

    const out = await deliverDigest(dir, record.key, post);
    expect(out.outcome).toBe('posted');
    if (out.outcome === 'posted') {
      expect(out.record.state).toBe('posted');
      expect(out.record.messageId).toBe('msg-1');
      expect(out.record.attemptCount).toBe(1);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(record.key);
  });

  test('a post timeout leaves a durable failed state with the response error', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post } = scriptedPost([{ outcome: 'timeout', error: 'ETIMEDOUT posting to control room' }]);

    const out = await deliverDigest(dir, record.key, post);
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') expect(out.reason).toBe('timeout');

    // Durable: reloaded from disk still failed, with the error and attempt time.
    const reloaded = (await readDigestRecords(dir)).get(record.key)!;
    expect(reloaded.state).toBe('failed');
    expect(reloaded.lastError).toContain('ETIMEDOUT');
    expect(reloaded.lastAttemptAt).toBeTruthy();
    expect(reloaded.content).toBe(CONTENT); // retained for a later retry
  });

  test('an exception thrown by the chokepoint is treated as a timeout failure', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const post: ControlRoomPostFn = async () => {
      throw new Error('socket hang up');
    };
    const out = await deliverDigest(dir, record.key, post);
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') {
      expect(out.reason).toBe('timeout');
      expect(out.record.lastError).toContain('socket hang up');
    }
  });

  test('an ambiguous response stays failed (never blindly marked posted)', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post } = scriptedPost([{ outcome: 'ambiguous', error: 'no ack within window' }]);

    const out = await deliverDigest(dir, record.key, post);
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') expect(out.reason).toBe('ambiguous');
    expect((await readDigestRecords(dir)).get(record.key)?.state).toBe('failed');
  });

  test('a duplicate run against a posted record does not re-post', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post, calls } = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-1' }]);

    await deliverDigest(dir, record.key, post);
    const again = await deliverDigest(dir, record.key, post);

    expect(again.outcome).toBe('already_posted');
    // The chokepoint was invoked exactly once across both runs — no duplicate.
    expect(calls).toHaveLength(1);
  });

  test('returns not_found for an unknown key without posting', async () => {
    const dir = await tempSpoolDir();
    const post = vi.fn(async (): Promise<ControlRoomPostResult> => ({ outcome: 'confirmed' }));
    const out = await deliverDigest(dir, 'missing-key', post);
    expect(out.outcome).toBe('not_found');
    expect(post).not.toHaveBeenCalled();
  });

  test('honours the bounded retry ceiling and stops posting once exhausted', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post, calls } = scriptedPost([{ outcome: 'failed', error: 'boom' }]);
    const maxAttempts = 3;

    for (let i = 0; i < maxAttempts; i++) {
      const out = await deliverDigest(dir, record.key, post, { maxAttempts });
      expect(out.outcome).toBe('failed');
    }
    // The ceiling is now reached — further deliveries refuse to post.
    const exhausted = await deliverDigest(dir, record.key, post, { maxAttempts });
    expect(exhausted.outcome).toBe('exhausted');
    expect(calls).toHaveLength(maxAttempts);
  });

  test('the default attempt bound is the ceiling deliverDigest enforces', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post, calls } = scriptedPost([{ outcome: 'failed', error: 'down' }]);
    // Consume exactly the default number of attempts, then expect exhaustion.
    for (let i = 0; i < DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS; i++) {
      expect((await deliverDigest(dir, record.key, post)).outcome).toBe('failed');
    }
    expect((await deliverDigest(dir, record.key, post)).outcome).toBe('exhausted');
    expect(calls).toHaveLength(DEFAULT_DIGEST_OUTBOX_MAX_ATTEMPTS);
  });
});

describe('content change vs already-posted digest', () => {
  test('a changed body creates a new key without overwriting the posted digest', async () => {
    const dir = await tempSpoolDir();
    const original = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post } = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-1' }]);
    await deliverDigest(dir, original.record.key, post);

    // Same day + channel, different content → a different key, a new saved record.
    const revised = await saveDigest(dir, {
      reportDay: DAY,
      channel: CHANNEL,
      content: `${CONTENT} (corrected: 67)`,
    });
    expect(revised.outcome).toBe('created');
    expect(revised.record.key).not.toBe(original.record.key);
    expect(revised.record.state).toBe('saved');

    // The original confirmed delivery is untouched.
    const byKey = await readDigestRecords(dir);
    expect(byKey.get(original.record.key)?.state).toBe('posted');
    expect(byKey.get(revised.record.key)?.state).toBe('saved');
    expect(byKey.size).toBe(2);
  });

  test('re-saving an already-posted digest reports already_posted and never resets it', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const { post } = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-1' }]);
    await deliverDigest(dir, record.key, post);

    const resave = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    expect(resave.outcome).toBe('already_posted');
    expect(resave.record.state).toBe('posted');
  });
});

describe('reconcile', () => {
  test('retries a failed record on the next run and confirms without duplicates', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });

    // First run: the post times out → failed.
    const first = scriptedPost([{ outcome: 'timeout', error: 'ETIMEDOUT' }]);
    await deliverDigest(dir, record.key, first.post);
    expect((await listUnreconciled(dir)).map((r) => r.key)).toEqual([record.key]);

    // Next scheduled run reconciles: this time the control room confirms.
    const second = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-late' }]);
    const summary = await reconcile(dir, second.post);

    expect(summary.attempted).toBe(1);
    expect(summary.posted).toBe(1);
    expect(summary.stillFailed).toBe(0);
    expect(second.calls).toHaveLength(1);
    // The retry reused the same idempotency key, so the control room could dedup.
    expect(second.calls[0]!.key).toBe(record.key);
    expect((await readDigestRecords(dir)).get(record.key)?.state).toBe('posted');
    expect(await listUnreconciled(dir)).toHaveLength(0);
  });

  test('does not re-post an already-confirmed delivery during reconcile', async () => {
    const dir = await tempSpoolDir();
    // One digest confirmed, another still failed.
    const good = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: 'A' });
    const bad = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: 'B' });
    await deliverDigest(dir, good.record.key, scriptedPost([{ outcome: 'confirmed', messageId: 'ok' }]).post);
    await deliverDigest(dir, bad.record.key, scriptedPost([{ outcome: 'timeout', error: 't' }]).post);

    const { post, calls } = scriptedPost([{ outcome: 'confirmed', messageId: 'ok-b' }]);
    const summary = await reconcile(dir, post);

    // Only the failed record 'B' was retried; the posted record 'A' was skipped.
    expect(summary.attempted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(bad.record.key);
    expect((await readDigestRecords(dir)).get(good.record.key)?.messageId).toBe('ok');
  });

  test('recovers a record stranded in posting by a crash without duplicating', async () => {
    const dir = await tempSpoolDir();
    const contentHash = computeContentHash(CONTENT);
    const key = deliveryKey({ reportDay: DAY, channel: CHANNEL, contentHash });
    // Simulate a crash between the pre-post write and the response: a record
    // durably persisted in `posting`, never settled.
    const stranded: DigestDeliveryRecord = {
      schemaVersion: DIGEST_OUTBOX_SCHEMA,
      key,
      reportDay: DAY,
      channel: CHANNEL,
      contentHash,
      content: CONTENT,
      state: 'posting',
      attemptCount: 1,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      lastAttemptAt: '2026-08-23T00:00:00.000Z',
    };
    await writeFile(
      digestOutboxRecordsPath(dir),
      JSON.stringify({ schemaVersion: DIGEST_OUTBOX_SCHEMA, records: [stranded] }),
      'utf8',
    );

    const { post, calls } = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-recovered' }]);
    const summary = await reconcile(dir, post);

    expect(summary.attempted).toBe(1);
    expect(summary.posted).toBe(1);
    // Reused the same idempotency key so the control room could dedup a delivery
    // that may already have landed before the crash.
    expect(calls[0]!.key).toBe(key);
    expect((await readDigestRecords(dir)).get(key)?.state).toBe('posted');
  });

  test('retries a failed record until the bound, then stops retrying it', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    const maxAttempts = 2;
    const { post, calls } = scriptedPost([{ outcome: 'failed', error: 'still down' }]);

    // Attempt 1 (direct) consumes one attempt and lands failed.
    const first = await deliverDigest(dir, record.key, post, { maxAttempts });
    expect(first.outcome).toBe('failed');

    // reconcile retries once more (attempt 2 = the bound) → still failed.
    const r1 = await reconcile(dir, post, { maxAttempts });
    expect(r1.attempted).toBe(1);
    expect(r1.stillFailed).toBe(1);
    const afterR1 = (await readDigestRecords(dir)).get(record.key)!;
    expect(afterR1.state).toBe('failed');
    expect(afterR1.attemptCount).toBe(maxAttempts);

    // The budget is spent: reconcile no longer retries it, so no further posts.
    const r2 = await reconcile(dir, post, { maxAttempts });
    expect(r2.attempted).toBe(0);
    expect(calls).toHaveLength(maxAttempts);

    // A budget-spent failure is still surfaced to an operator.
    expect((await listUnreconciled(dir)).map((r) => r.key)).toEqual([record.key]);
  });

  test('reconcile drives a saved record a crash left before its first attempt', async () => {
    const dir = await tempSpoolDir();
    const { record } = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    expect(record.state).toBe('saved');

    const { post, calls } = scriptedPost([{ outcome: 'confirmed', messageId: 'msg-first' }]);
    const summary = await reconcile(dir, post);

    expect(summary.attempted).toBe(1);
    expect(summary.posted).toBe(1);
    expect(calls[0]!.key).toBe(record.key);
    expect((await readDigestRecords(dir)).get(record.key)?.state).toBe('posted');
  });

  test('prunes terminal records older than the retention window, keeps live ones', async () => {
    const dir = await tempSpoolDir();
    const longAgo = new Date('2020-01-01T00:00:00Z');
    const stale = await saveDigest(dir, { reportDay: '2020-01-01', channel: CHANNEL, content: 'old' }, { now: longAgo });
    const fresh = await saveDigest(dir, { reportDay: DAY, channel: CHANNEL, content: CONTENT });
    // Confirm the stale one long ago so its updatedAt is well past retention.
    await deliverDigest(dir, stale.record.key, scriptedPost([{ outcome: 'confirmed', messageId: 'x' }]).post, { now: longAgo });
    // `fresh` stays saved (unconfirmed) — must never be pruned.

    const pruned = await pruneTerminalRecords(dir, { now: new Date('2026-08-28T00:00:00Z') });
    expect(pruned).toBe(1);
    const byKey = await readDigestRecords(dir);
    expect(byKey.has(stale.record.key)).toBe(false);
    expect(byKey.has(fresh.record.key)).toBe(true);
  });
});

describe('defaultDigestOutboxDir', () => {
  test('honours the env override', () => {
    expect(defaultDigestOutboxDir({ KOOKR_DIGEST_OUTBOX_DIR: '/custom/spool' })).toBe('/custom/spool');
  });

  test('falls back to a user-scoped path under ~/.kookr', () => {
    const dir = defaultDigestOutboxDir({ HOME: '/home/tester' });
    expect(dir).toContain('/home/tester/.kookr');
    expect(dir).toContain('digest-outbox');
  });
});
