import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ASK_LIMITS, type AskNotifier, type AskRecord } from '../../shared/contracts/asks.js';
import { TTSClientError } from '../../adapters/tts-client.js';
import type { TaskStatus } from '../../core/task-status.js';
import type { TaskStatus as ContractTaskStatus } from '../../shared/contracts/task-status.js';
import { registerAskRoutes } from '../routes/ask-routes.js';
import { ASK_WAIT_ATTACHED_MS, ASK_WAIT_FALLBACK_MS, AskService } from './ask-service.js';
import { AskStore } from './ask-store.js';
import type { LucyUnpromptedEntry } from '../lucy-unprompted.js';

interface Harness {
  dir: string;
  store: AskStore;
  service: AskService;
  notifier: { sendAsk: ReturnType<typeof vi.fn>; finalizeAsk: ReturnType<typeof vi.fn> };
  deliver: ReturnType<typeof vi.fn>;
  statuses: Map<string, TaskStatus>;
  clock: { now: number };
}

let h: Harness;
let nextMessageId = 100;

async function harness(opts: { notifier?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-asks-'));
  const store = await AskStore.open(dir);
  const notifier = {
    sendAsk: vi.fn(async () => ({ chatId: 42, messageId: nextMessageId++ })),
    finalizeAsk: vi.fn(async () => undefined),
  };
  const deliver = vi.fn(async () => ({ ok: true }));
  const statuses = new Map<string, TaskStatus>([['t1', 'running' as TaskStatus], ['t2', 'running' as TaskStatus]]);
  const clock = { now: 1_000_000 };
  const service = new AskService({
    store,
    getNotifier: () => (opts.notifier === false ? undefined : (notifier as unknown as AskNotifier)),
    taskStatus: (id) => statuses.get(id),
    deliverToTask: deliver,
    now: () => clock.now,
  });
  return { dir, store, service, notifier, deliver, statuses, clock };
}

const base = { taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'] };

async function createOk(over: Partial<Parameters<AskService['create']>[0]> = {}): Promise<AskRecord> {
  const r = await h.service.create({ ...base, ...over });
  if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
  return r.ask;
}

function tap(ask: AskRecord, index: number, over: Record<string, unknown> = {}) {
  const cb = h.service.callbackData(ask, index).split(':');
  return h.service.answer({
    askId: ask.id, senderId: 7, chatId: ask.delivery!.chatId, messageId: ask.delivery!.messageId,
    option: { index, mac: cb[3] }, ...over,
  });
}

beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.service.stop(); await rm(h.dir, { recursive: true, force: true }); });

describe('AskService.create', () => {
  it('is unavailable without a notifier and stores nothing', async () => {
    const off = await harness({ notifier: false });
    const r = await off.service.create(base);
    expect(r).toEqual({ ok: false, error: { code: 'not_configured' } });
    expect(off.store.all()).toEqual([]);
    await rm(off.dir, { recursive: true, force: true });
  });

  it('creates a pending ask, sends it, and records the message coordinates', async () => {
    const ask = await createOk();
    expect(ask.state).toBe('pending');
    expect(ask.id).toMatch(/^[0-9a-f]{12}$/);
    expect(ask.delivery).toEqual({ chatId: 42, messageId: 100 });
    expect(h.notifier.sendAsk).toHaveBeenCalledOnce();
  });

  it('rejects unknown and terminal tasks', async () => {
    expect(await h.service.create({ ...base, taskId: 'nope' })).toMatchObject({ error: { code: 'unknown_task' } });
    h.statuses.set('t1', 'completed' as TaskStatus);
    expect(await h.service.create(base)).toMatchObject({ error: { code: 'terminal_task' } });
  });

  it.each([
    ['one option', { options: ['Only'] }],
    ['five options', { options: ['a', 'b', 'c', 'd', 'e'] }],
    ['duplicate options', { options: ['A', 'a'] }],
    ['overlong label', { options: ['x'.repeat(49), 'b'] }],
    ['multiline label', { options: ['a\nb', 'c'] }],
    ['empty question', { question: '  ' }],
    ['overlong question', { question: 'q'.repeat(601) }],
    ['overlong context', { context: 'c'.repeat(1501) }],
    ['timeout too small', { timeoutSec: 1 }],
    ['timeout too large', { timeoutSec: 999_999 }],
    ['timeout just over 7 days', { timeoutSec: 7 * 24 * 60 * 60 + 1 }],
  ])('rejects %s', async (_name, over) => {
    expect(await h.service.create({ ...base, ...over })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(h.notifier.sendAsk).not.toHaveBeenCalled();
  });

  it('scrubs credentials from question/context and reports it', async () => {
    const r = await h.service.create({ ...base, question: 'Use token abc?', context: 'fine context' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.ask.question).toBe('[redacted — looked like a credential]');
    expect(r.ask.context).toBe('fine context');
    expect(r.redacted).toEqual(['question']);
  });

  it('refuses an option label that looks like a credential', async () => {
    const r = await h.service.create({ ...base, options: ['ghp_' + 'a'.repeat(30), 'No'] });
    expect(r).toMatchObject({ ok: false, error: { code: 'redacted_option' } });
  });

  it('stores links with trimmed labels and hands them to the notifier (#3929)', async () => {
    const ask = await createOk({ links: [{ url: 'https://claude.ai/artifact/abc', label: '  Open mockups ' }, { url: 'https://github.com/o/r/pull/1' }] });
    expect(ask.links).toEqual([{ url: 'https://claude.ai/artifact/abc', label: 'Open mockups' }, { url: 'https://github.com/o/r/pull/1' }]);
    expect(h.notifier.sendAsk.mock.calls[0][0].links).toEqual(ask.links);
    expect((await createOk({ question: 'no links' })).links).toBeUndefined();
  });

  it.each([
    [[{ url: 'http://example.com' }], /https/],
    [[{ url: `https://example.com/${'a'.repeat(481)}` }], /500/],
    [[{ url: 'https://user:pw@example.com' }], /password/],
    [[{ url: 'https://a.example' }, { url: 'https://b.example' }, { url: 'https://c.example' }], /at most 2/],
    [[{ url: 'https://a.example', label: '' }], /label/],
    [[{ url: 'https://example.com/?access_token=abc' }], /credential/],
    [[{ url: 'https://example.com/a\u0000b' }], /control characters/],
    [[{ url: 'https://a.example', label: 'my token abc' }], /credential/],
    [[{ url: 'https://a.example', label: 'Open\nmockups' }], /single line/],
  ])('refuses links %j', async (links, message) => {
    const r = await h.service.create({ ...base, links });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringMatching(message) } });
    expect(h.notifier.sendAsk).not.toHaveBeenCalled();
  });

  it('dedupes on (task, idempotencyKey) only while the ask is pending', async () => {
    const a = await createOk({ idempotencyKey: 'k' });
    const again = await h.service.create({ ...base, idempotencyKey: 'k' });
    expect(again).toMatchObject({ ok: true, deduped: true });
    expect(h.notifier.sendAsk).toHaveBeenCalledOnce();
    await tap(a, 0);
    const third = await h.service.create({ ...base, idempotencyKey: 'k' });
    expect(third).toMatchObject({ ok: true, deduped: false });
  });

  it('enforces per-task pending, per-task hourly and global hourly limits', async () => {
    await createOk({ question: 'q1' }); await createOk({ question: 'q2' }); await createOk({ question: 'q3' });
    expect(await h.service.create({ ...base, question: 'q4' }))
      .toMatchObject({ error: { code: 'rate_limited', scope: 'task_pending' } });

    // Cancel them so the pending cap is not what trips next: hourly cap of 6 per task.
    for (const a of h.store.all()) await h.service.cancel(a.id);
    await createOk({ question: 'q4' }); await createOk({ question: 'q5' }); await createOk({ question: 'q6' });
    for (const a of h.store.all().filter((x) => x.state === 'pending')) await h.service.cancel(a.id);
    expect(await h.service.create({ ...base, question: 'q7' }))
      .toMatchObject({ error: { code: 'rate_limited', scope: 'task_hourly' } });

    // Hourly window slides.
    h.clock.now += 61 * 60 * 1000;
    expect((await h.service.create({ ...base, question: 'q8' })).ok).toBe(true);
  });

  it('counts long-lived open asks against their own cap, so opinion requests never block a short question (#3966)', async () => {
    const twoDays = 48 * 60 * 60;
    for (let i = 1; i <= 3; i++) await createOk({ question: `opinion ${i}`, timeoutSec: twoDays });
    // Three opinion requests left open for two days: a short question is still accepted.
    const short = await createOk({ question: 'short 1' });
    expect(short.expiresAt - short.createdAt).toBe(ASK_LIMITS.defaultTimeoutSec * 1000);
    await createOk({ question: 'short 2' });
    await createOk({ question: 'short 3' });
    // The short pool is full. Long-lived asks still go through below.
    expect(await h.service.create({ ...base, question: 'short 4' }))
      .toMatchObject({ error: { code: 'rate_limited', scope: 'task_pending' } });

    h.clock.now += 61 * 60 * 1000; // past the hourly cap of 6, nothing has expired
    for (let i = 4; i <= 6; i++) await createOk({ question: `opinion ${i}`, timeoutSec: twoDays });
    h.clock.now += 61 * 60 * 1000;
    for (let i = 7; i <= 10; i++) await createOk({ question: `opinion ${i}`, timeoutSec: twoDays });
    expect(await h.service.create({ ...base, question: 'opinion 11', timeoutSec: twoDays }))
      .toMatchObject({ error: { code: 'rate_limited', scope: 'task_pending' } });
    expect(h.store.all().filter((a) => a.state === 'pending' && a.question.startsWith('opinion'))).toHaveLength(ASK_LIMITS.maxLongLivedPendingPerTask);
  });

  it('puts an ask with a timeout of exactly the threshold in the short pool and one second more in the long-lived pool', async () => {
    const edge = ASK_LIMITS.longLivedAfterSec;
    for (let i = 1; i <= 3; i++) await createOk({ question: `edge ${i}`, timeoutSec: edge });
    expect(await h.service.create({ ...base, question: 'default timeout' }))
      .toMatchObject({ error: { code: 'rate_limited', scope: 'task_pending' } });
    expect((await h.service.create({ ...base, question: 'just over', timeoutSec: edge + 1 })).ok).toBe(true);
  });

  it('enforces the global hourly cap across tasks', async () => {
    for (let i = 0; i < 20; i++) {
      h.statuses.set(`g${i}`, 'running' as TaskStatus);
      await createOk({ taskId: `g${i}`, question: `q${i}` });
    }
    expect(await h.service.create({ ...base, taskId: 't2' }))
      .toMatchObject({ error: { code: 'rate_limited', scope: 'global_hourly' } });
  });

  it('cancels the ask and reports 502-style failure when Telegram delivery throws', async () => {
    h.notifier.sendAsk.mockRejectedValueOnce(new Error('boom'));
    const r = await h.service.create(base);
    expect(r).toMatchObject({ ok: false, error: { code: 'delivery_failed' } });
    expect(h.store.all()[0]).toMatchObject({ state: 'cancelled', resolution: 'delivery_failed' });
  });
});

describe('AskService.answer', () => {
  it('records a button answer once and types it into the task', async () => {
    const ask = await createOk();
    const r = await tap(ask, 1);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', answer: { kind: 'option', index: 1, label: 'No' }, answeredBy: 7, taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: No`);
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(expect.objectContaining({ id: ask.id }), expect.stringContaining('Answered: No'));
  });

  it('lets exactly one of two concurrent taps win', async () => {
    const ask = await createOk();
    const [a, b] = await Promise.all([tap(ask, 0), tap(ask, 1)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ reason: 'already_answered' });
    expect(h.deliver).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate tap after the answer', async () => {
    const ask = await createOk();
    await tap(ask, 0);
    expect(await tap(ask, 0)).toMatchObject({ ok: false, reason: 'already_answered' });
  });

  it('rejects forged MACs, MACs for another option, and unknown asks', async () => {
    const ask = await createOk();
    const wrong = await h.service.answer({ askId: ask.id, senderId: 7, chatId: 42, messageId: 100, option: { index: 0, mac: '0'.repeat(16) } });
    expect(wrong).toMatchObject({ ok: false, reason: 'forged' });
    const otherOption = h.service.callbackData(ask, 1).split(':')[3];
    const swapped = await h.service.answer({ askId: ask.id, senderId: 7, chatId: 42, messageId: 100, option: { index: 0, mac: otherOption } });
    expect(swapped).toMatchObject({ ok: false, reason: 'forged' });
    const short = await h.service.answer({ askId: ask.id, senderId: 7, chatId: 42, messageId: 100, option: { index: 0, mac: 'x' } });
    expect(short).toMatchObject({ ok: false, reason: 'forged' });
    expect(await h.service.answer({ askId: 'ffffffffffff', senderId: 7, chatId: 42, messageId: 1, option: { index: 0, mac: 'a' } }))
      .toMatchObject({ ok: false, reason: 'not_found' });
    expect(h.store.get(ask.id)?.state).toBe('pending');
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('rejects non-string MACs and non-integer option indexes without throwing', async () => {
    const ask = await createOk();
    const base2 = { askId: ask.id, senderId: 7, chatId: 42, messageId: ask.delivery!.messageId };
    for (const option of [
      { index: 0, mac: 5 as unknown as string },
      { index: Number.NaN, mac: 'a'.repeat(16) },
      { index: -1, mac: 'a'.repeat(16) },
      { index: 0.5, mac: 'a'.repeat(16) },
    ]) {
      expect(await h.service.answer({ ...base2, option })).toMatchObject({ ok: false, reason: 'forged' });
    }
    expect(h.store.get(ask.id)?.state).toBe('pending');
  });

  it('rejects a MAC minted for a different ask (nonce binding)', async () => {
    const a = await createOk({ question: 'a' });
    const b = await createOk({ question: 'b' });
    const macForA = h.service.callbackData(a, 0).split(':')[3];
    const r = await h.service.answer({ askId: b.id, senderId: 7, chatId: 42, messageId: b.delivery!.messageId, option: { index: 0, mac: macForA } });
    expect(r).toMatchObject({ ok: false, reason: 'forged' });
  });

  it('rejects an answer from a different chat or message', async () => {
    const ask = await createOk();
    expect(await tap(ask, 0, { chatId: 43 })).toMatchObject({ ok: false, reason: 'wrong_chat' });
    expect(await tap(ask, 0, { messageId: 999 })).toMatchObject({ ok: false, reason: 'wrong_chat' });
    expect(h.store.get(ask.id)?.state).toBe('pending');
  });

  it('accepts a free-text reply and rejects it when text is disallowed', async () => {
    const ask = await createOk();
    const r = await h.service.answer({ askId: ask.id, senderId: 7, chatId: 42, messageId: ask.delivery!.messageId, text: ' ship\nit later ' });
    expect(r).toMatchObject({ ok: true, ask: { answer: { kind: 'text', text: 'ship\nit later' } } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: (free text) ship it later`);

    const strict = await createOk({ allowText: false, question: 'strict' });
    const s = await h.service.answer({ askId: strict.id, senderId: 7, chatId: 42, messageId: strict.delivery!.messageId, text: 'hi' });
    expect(s).toMatchObject({ ok: false, reason: 'text_not_allowed' });
  });

  it('accepts a 7-day question', async () => {
    const ask = await createOk({ timeoutSec: 7 * 24 * 60 * 60 });
    expect(ask.expiresAt - ask.createdAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('records an answer given after the task ended, types nothing, and says so', async () => {
    const ask = await createOk({ timeoutSec: 2 * 24 * 60 * 60 });
    h.statuses.set('t1', 'completed' as TaskStatus);
    h.clock.now += 36 * 60 * 60 * 1000;
    const r = await tap(ask, 0);
    expect(r).toMatchObject({
      ok: true,
      notTyped: 'The task has ended, so nothing was typed into it.',
      ask: { state: 'answered', resolution: 'answered', answer: { kind: 'option', index: 0, label: 'Yes' }, taskDelivery: 'skipped' },
    });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('✅ Answered: Yes\nRecorded. The task has ended, so nothing was typed into it.'),
    );
    // Read back later (GET /api/asks/:id goes through get()).
    expect(await h.service.get(ask.id)).toMatchObject({ state: 'answered', answer: { label: 'Yes' }, taskDelivery: 'skipped' });
    // One answer only.
    expect(await tap(ask, 1)).toMatchObject({ ok: false, reason: 'already_answered' });
  });

  it('records an answer for a task that no longer exists at all', async () => {
    const ask = await createOk();
    h.statuses.delete('t1');
    expect(await tap(ask, 1)).toMatchObject({ ok: true, ask: { state: 'answered', answer: { label: 'No' }, taskDelivery: 'skipped' } });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('still refuses an answer after expiry even when the task has ended', async () => {
    const ask = await createOk({ timeoutSec: 60 });
    h.statuses.set('t1', 'completed' as TaskStatus);
    h.clock.now += 61_000;
    expect(await tap(ask, 0)).toMatchObject({ ok: false, reason: 'expired' });
    expect(h.store.get(ask.id)?.answer).toBeUndefined();
  });

  it('records the answer but flags delivery failure when typing into the task fails', async () => {
    const ask = await createOk();
    h.deliver.mockResolvedValueOnce({ ok: false, reason: 'no live session for this task' });
    const r = await tap(ask, 0);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', taskDelivery: 'failed' } });
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Could not type'));
  });

  it('rejects an answer that arrives after expiry', async () => {
    const ask = await createOk({ timeoutSec: 60 });
    h.clock.now += 61_000;
    expect(await tap(ask, 0)).toMatchObject({ ok: false, reason: 'expired' });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Ask ${ask.id} expired with no answer.`);
  });
});

describe('expiry, cancel and boot reconciliation', () => {
  it('expires overdue asks: edits the message and notifies a live task once', async () => {
    const ask = await createOk({ timeoutSec: 60 });
    h.clock.now += 61_000;
    await h.service.sweepExpired();
    await h.service.sweepExpired();
    expect(h.store.get(ask.id)).toMatchObject({ state: 'expired', resolution: 'expired' });
    expect(h.notifier.finalizeAsk).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledOnce();
  });

  it('does not notify a terminal task, nor spam stale notices after a long outage', async () => {
    const a = await createOk({ timeoutSec: 60 });
    h.statuses.set('t1', 'completed' as TaskStatus);
    h.clock.now += 61_000;
    await h.service.sweepExpired();
    expect(h.store.get(a.id)?.state).toBe('expired');
    expect(h.deliver).not.toHaveBeenCalled();

    h.statuses.set('t2', 'running' as TaskStatus);
    const b = await createOk({ taskId: 't2', timeoutSec: 60 });
    h.clock.now += 7 * 60 * 1000;
    await h.service.sweepExpired();
    expect(h.store.get(b.id)?.state).toBe('expired');
    expect(h.notifier.finalizeAsk).toHaveBeenCalledTimes(2);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('closes the Telegram message when the ask is cancelled while the send is in flight', async () => {
    let release!: () => void;
    h.notifier.sendAsk.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ chatId: 42, messageId: 555 });
    }));
    const pending = h.service.create(base);
    await vi.waitFor(() => expect(h.store.all()).toHaveLength(1));
    h.store.update(h.store.all()[0].id, (a) => { a.state = 'cancelled'; a.resolution = 'cancelled'; });
    release();
    await pending;
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }), expect.stringContaining('Cancelled'));
  });

  it('closes the Telegram message as expired when the ask expires while the send is in flight', async () => {
    let release!: () => void;
    h.notifier.sendAsk.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ chatId: 42, messageId: 556 });
    }));
    const kinds: string[] = [];
    h.service.onChange((c) => kinds.push(c.kind));
    const pending = h.service.create({ ...base, timeoutSec: 30 });
    await vi.waitFor(() => expect(h.store.all()).toHaveLength(1));
    h.clock.now += 31_000;
    await h.service.sweepExpired();
    // The sweep cannot close a message that has not been sent yet.
    expect(h.notifier.finalizeAsk).not.toHaveBeenCalled();
    release();
    const r = await pending;
    expect(r).toMatchObject({ ok: true, ask: { state: 'expired', delivery: { chatId: 42, messageId: 556 } } });
    expect(h.notifier.finalizeAsk).toHaveBeenCalledOnce();
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'expired', delivery: { chatId: 42, messageId: 556 } }),
      expect.stringContaining('Expired'),
    );
    expect(kinds).not.toContain('created');
  });

  it('start() enforces retention and the sweep tick expires overdue asks', async () => {
    const old = await createOk({ question: 'old' });
    await tap(old, 0);
    const overdue = await createOk({ question: 'overdue', timeoutSec: 60 });
    h.clock.now += 8 * 24 * 60 * 60 * 1000;
    await h.service.start();
    expect(h.store.get(old.id)).toBeUndefined();
    expect(h.store.get(overdue.id)?.state).toBe('expired');
  });

  it('cancel is one-shot', async () => {
    const ask = await createOk();
    expect(await h.service.cancel(ask.id)).toMatchObject({ ok: true, ask: { state: 'cancelled' } });
    expect(await h.service.cancel(ask.id)).toEqual({ ok: false, reason: 'not_pending' });
    expect(await h.service.cancel('nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('survives a restart: reloads asks, keeps button MACs valid, cancels undelivered ones', async () => {
    const ask = await createOk();
    h.store.insert({ ...ask, id: 'aaaaaaaaaaaa', delivery: undefined, nonce: 'n' });
    await h.store.flush();

    const store2 = await AskStore.open(h.dir);
    const svc2 = new AskService({
      store: store2, getNotifier: () => h.notifier as unknown as AskNotifier,
      taskStatus: (id) => h.statuses.get(id), deliverToTask: h.deliver, now: () => h.clock.now,
    });
    await svc2.start();
    await svc2.stop();
    expect(store2.get('aaaaaaaaaaaa')).toMatchObject({ state: 'cancelled', resolution: 'delivery_failed' });
    const reloaded = store2.get(ask.id) as AskRecord;
    expect(reloaded.state).toBe('pending');
    expect(svc2.callbackData(reloaded, 0)).toBe(h.service.callbackData(ask, 0));
  });
});

describe('session pinning (#3548)', () => {
  /** The live session of each task; a relaunch replaces it. */
  let live: Map<string, string>;
  /** Sessions that resumed another one's conversation: resumed -> resumed from. */
  let resumedFrom: Map<string, string>;
  let pinned: AskService;

  beforeEach(() => {
    live = new Map([['t1', 'sess-a'], ['t2', 'sess-b']]);
    resumedFrom = new Map();
    pinned = new AskService({
      store: h.store,
      getNotifier: () => h.notifier as unknown as AskNotifier,
      taskStatus: (id) => h.statuses.get(id),
      deliverToTask: h.deliver,
      liveSession: (id) => live.get(id),
      sessionContinues: (id, sessionId) => {
        for (let s = live.get(id); s !== undefined; s = resumedFrom.get(s)) if (s === sessionId) return true;
        return false;
      },
      now: () => h.clock.now,
    });
  });

  async function createPinned(over: Partial<Parameters<AskService['create']>[0]> = {}): Promise<AskRecord> {
    const r = await pinned.create({ ...base, ...over });
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
    return r.ask;
  }

  function tapPinned(ask: AskRecord, index: number) {
    return pinned.answer({
      askId: ask.id, senderId: 7, chatId: ask.delivery!.chatId, messageId: ask.delivery!.messageId,
      option: { index, mac: pinned.callbackData(ask, index).split(':')[3] },
    });
  }

  it('records the session that was live when the question was asked', async () => {
    const ask = await createPinned();
    expect(ask.sessionId).toBe('sess-a');
  });

  it('types the answer into the pinned session while it is still live', async () => {
    const ask = await createPinned();
    const r = await tapPinned(ask, 1);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: No`, 'sess-a');
  });

  it('records but does not type the answer into a fresh session after a relaunch, and tells the operator', async () => {
    const ask = await createPinned();
    live.set('t1', 'sess-relaunched'); // the task is still running, in a session that never saw the question
    const r = await tapPinned(ask, 0);
    expect(r).toMatchObject({
      ok: true,
      notTyped: 'The task was relaunched in a new session since it asked, so nothing was typed into it.',
      ask: { state: 'answered', answer: { label: 'Yes' }, taskDelivery: 'skipped' },
    });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Recorded. The task was relaunched'));
  });

  it('types the answer into a session that resumed the asking conversation (crash recovery, Reopen)', async () => {
    const ask = await createPinned();
    live.set('t1', 'sess-resumed');
    resumedFrom.set('sess-resumed', 'sess-a');
    const r = await tapPinned(ask, 1);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: No`, 'sess-a');
  });

  it('records a dashboard answer after a relaunch the same way, without typing it', async () => {
    const ask = await createPinned();
    live.set('t1', 'sess-relaunched');
    const r = await pinned.answerFromDashboard({ askId: ask.id, optionIndex: 0 });
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', answeredVia: 'dashboard', taskDelivery: 'skipped' } });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('records the answer while no session is live (a resume may be pending), with delivery still bound to the pin', async () => {
    const ask = await createPinned();
    live.delete('t1');
    h.deliver.mockResolvedValueOnce({ ok: false, reason: 'no live session for this task' });
    const r = await tapPinned(ask, 1);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', answer: { label: 'No' }, taskDelivery: 'failed' } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: No`, 'sess-a');
  });

  it('re-pins a pending ask when the relaunched session asks the same question again', async () => {
    const first = await createPinned({ idempotencyKey: 'k' });
    live.set('t1', 'sess-relaunched');
    const again = await pinned.create({ ...base, idempotencyKey: 'k' });
    expect(again).toMatchObject({ ok: true, deduped: true, ask: { id: first.id, sessionId: 'sess-relaunched' } });
    expect(h.notifier.sendAsk).toHaveBeenCalledOnce();
    const r = await tapPinned(first, 1);
    expect(r).toMatchObject({ ok: true, ask: { taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${first.id}: No`, 'sess-relaunched');
  });

  it('keeps the pin when the same question is asked again while no session is live', async () => {
    const first = await createPinned({ idempotencyKey: 'k' });
    live.delete('t1');
    const again = await pinned.create({ ...base, idempotencyKey: 'k' });
    expect(again).toMatchObject({ ok: true, deduped: true, ask: { id: first.id, sessionId: 'sess-a' } });
  });

  it('does not type the expiry notice into a session that replaced the pinned one', async () => {
    const stale = await createPinned({ timeoutSec: 60 });
    const kept = await createPinned({ taskId: 't2', timeoutSec: 60 });
    live.set('t1', 'sess-relaunched');
    h.clock.now += 61_000;
    await pinned.sweepExpired();
    expect(h.store.get(stale.id)?.state).toBe('expired');
    expect(h.store.get(kept.id)?.state).toBe('expired');
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledWith('t2', `Ask ${kept.id} expired with no answer.`, 'sess-b');
  });

  it('still delivers an unpinned ask (recorded before pinning, or with no live session) to the live session', async () => {
    live.delete('t1');
    const ask = await createPinned();
    expect(ask.sessionId).toBeUndefined();
    live.set('t1', 'sess-later');
    const r = await tapPinned(ask, 1);
    expect(r).toMatchObject({ ok: true, ask: { taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: No`);
  });

  it('types a --wait fallback only into the pinned session, and not after a fresh relaunch (#3824)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const kept = await createPinned({ question: 'Kept?' });
      await pinned.pollForWaiter(kept.id);
      await tapPinned(kept, 0);
      await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS);
      await new Promise<void>((r) => setImmediate(r));
      expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${kept.id}: Yes`, 'sess-a');

      const replaced = await createPinned({ question: 'Replaced?' });
      await pinned.pollForWaiter(replaced.id);
      await tapPinned(replaced, 0);
      live.set('t1', 'sess-relaunched');
      await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS);
      await new Promise<void>((r) => setImmediate(r));
      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(h.store.get(replaced.id)?.taskDelivery).toBe('skipped');
    } finally {
      await pinned.stop();
      vi.useRealTimers();
    }
  });

  it('keeps the pinned session across a restart', async () => {
    const ask = await createPinned();
    await h.store.flush();
    const reopened = await AskStore.open(h.dir);
    expect(reopened.get(ask.id)?.sessionId).toBe('sess-a');
  });
});

describe('an attached kookr ask --wait poll (#3824)', () => {
  /** Lets the fallback's awaits (typing, closing the Telegram message) run after its timer fired. */
  const settled = () => new Promise<void>((r) => setImmediate(r));

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('leaves the answer for the waiting command and never types it once that command read it', async () => {
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    const changes: string[] = [];
    h.service.onChange((c) => changes.push(c.kind));

    const r = await tap(ask, 1);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered', answer: { label: 'No' } } });
    expect(r.ok && r.ask.taskDelivery).toBeUndefined();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.notifier.finalizeAsk).toHaveBeenLastCalledWith(expect.anything(), '✅ Answered: No\n\n❓ Ship it?');

    const read = await h.service.pollForWaiter(ask.id);
    expect(read).toMatchObject({ state: 'answered', answer: { label: 'No' }, taskDelivery: 'delivered' });
    expect(changes).toEqual(['resolved', 'updated']);

    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS * 2);
    await settled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('types the answer once as a fallback when the waiting command stops polling', async () => {
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    await tap(ask, 0);
    const closings = h.notifier.finalizeAsk.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS - 1);
    expect(h.deliver).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settled();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: Yes`);
    expect(h.store.get(ask.id)?.taskDelivery).toBe('delivered');
    // The Telegram message already shows the answer: no second, identical edit.
    expect(h.notifier.finalizeAsk).toHaveBeenCalledTimes(closings);
    // A poll arriving after the fallback typed it changes nothing.
    await h.service.pollForWaiter(ask.id);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('types the answer at once when the last --wait poll is too old', async () => {
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    h.clock.now += ASK_WAIT_ATTACHED_MS + 1;
    const r = await tap(ask, 0);
    expect(r).toMatchObject({ ok: true, ask: { taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('counts only ?wait=1 reads: a plain GET /api/asks/:id leaves the answer to be typed at once', async () => {
    const app = new Hono();
    registerAskRoutes(app, { service: h.service });
    const plain = await createOk({ question: 'Plain read?' });
    expect((await app.request(`/api/asks/${plain.id}`)).status).toBe(200);
    await tap(plain, 0);
    expect(h.deliver).toHaveBeenCalledTimes(1);

    const waited = await createOk({ question: 'Waited read?' });
    expect((await app.request(`/api/asks/${waited.id}?wait=1`)).status).toBe(200);
    await tap(waited, 0);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const read = await (await app.request(`/api/asks/${waited.id}?wait=1`)).json();
    expect(read.ask).toMatchObject({ state: 'answered', taskDelivery: 'delivered' });
    expect((await app.request('/api/asks/zzz?wait=1')).status).toBe(404);
  });

  it('types nothing from the fallback when the task ended in the meantime, and tells the operator', async () => {
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    await tap(ask, 0);
    h.statuses.set('t1', 'completed' as TaskStatus);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS);
    await settled();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.store.get(ask.id)?.taskDelivery).toBe('skipped');
    expect(h.notifier.finalizeAsk).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('Recorded. The task has ended'));
  });

  it('warns the operator when the fallback could not type the answer', async () => {
    h.deliver.mockResolvedValueOnce({ ok: false, reason: 'no live session' });
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    await tap(ask, 0);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS);
    await settled();
    expect(h.store.get(ask.id)?.taskDelivery).toBe('failed');
    expect(h.notifier.finalizeAsk).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('Could not type it into the task (no live session)'));
  });

  it('after a restart, types a recent answer that was left for a waiter, but not an old one or one already typed', async () => {
    const recent = await createOk({ question: 'Recent?' });
    const old = await createOk({ question: 'Old?' });
    const typed = await createOk({ question: 'Typed?' });
    for (const ask of [recent, old]) await h.service.pollForWaiter(ask.id);
    await tap(old, 0);
    h.clock.now += 10 * 60 * 1000;
    await h.service.pollForWaiter(recent.id);
    await tap(recent, 0);
    // No waiter: typed at once, a few seconds before the restart.
    await tap(typed, 1);
    expect(h.store.get(typed.id)?.taskDelivery).toBe('delivered');
    h.deliver.mockClear();
    await h.service.stop();
    await h.store.flush();

    const store = await AskStore.open(h.dir);
    const restarted = new AskService({
      store,
      getNotifier: () => h.notifier as unknown as AskNotifier,
      taskStatus: (id) => h.statuses.get(id),
      deliverToTask: h.deliver,
      now: () => h.clock.now,
    });
    await restarted.start();
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS);
    await settled();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${recent.id}: Yes`);
    expect(store.get(old.id)?.taskDelivery).toBeUndefined();
    await restarted.stop();
  });

  it('after a restart, leaves the answer for a --wait poll that reads it before the fallback fires', async () => {
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    await tap(ask, 0);
    await h.service.stop();
    await h.store.flush();

    const store = await AskStore.open(h.dir);
    const restarted = new AskService({
      store,
      getNotifier: () => h.notifier as unknown as AskNotifier,
      taskStatus: (id) => h.statuses.get(id),
      deliverToTask: h.deliver,
      now: () => h.clock.now,
    });
    await restarted.start();
    expect(await restarted.pollForWaiter(ask.id)).toMatchObject({ state: 'answered', taskDelivery: 'delivered' });
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS * 2);
    await settled();
    expect(h.deliver).not.toHaveBeenCalled();
    await restarted.stop();
  });

  /** Stop the service and start a new one over the same directory, as a server restart does. */
  async function restart(): Promise<void> {
    await h.service.stop();
    await h.store.flush();
    const store = await AskStore.open(h.dir);
    const service = new AskService({
      store,
      getNotifier: () => h.notifier as unknown as AskNotifier,
      taskStatus: (id) => h.statuses.get(id),
      deliverToTask: h.deliver,
      now: () => h.clock.now,
    });
    await service.start();
    h = { ...h, store, service };
  }

  it('after a restart, leaves an answer given before the --wait polls again for that poll, not typed as well (#4040)', async () => {
    const ask = await createOk();
    await h.service.pollForWaiter(ask.id);
    await restart();
    // Answered one second after the restart, before the still-running `kookr ask --wait` polls the new server.
    h.clock.now += 1_000;
    const r = await tap(ask, 0);
    expect(r).toMatchObject({ ok: true, ask: { state: 'answered' } });
    expect(r.ok && r.ask.taskDelivery).toBeUndefined();
    expect(h.deliver).not.toHaveBeenCalled();

    expect(await h.service.pollForWaiter(ask.id)).toMatchObject({ state: 'answered', taskDelivery: 'delivered' });
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS * 2);
    await settled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('after a restart, types the answer to a question nobody waits on: after the fallback delay at first, at once later', async () => {
    const early = await createOk({ question: 'Early?' });
    const later = await createOk({ question: 'Later?' });
    await restart();
    h.clock.now += 1_000;
    await tap(early, 0);
    expect(h.deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ASK_WAIT_FALLBACK_MS);
    await settled();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenLastCalledWith('t1', `Operator answered ask ${early.id}: Yes`);

    // Past the grace no `--wait` claimed it: typed at once, as before the restart.
    h.clock.now += ASK_WAIT_ATTACHED_MS;
    const r = await tap(later, 1);
    expect(r).toMatchObject({ ok: true, ask: { taskDelivery: 'delivered' } });
    expect(h.deliver).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenLastCalledWith('t1', `Operator answered ask ${later.id}: No`);
  });
});

describe('AskStore', () => {
  it('keeps the secret stable across reopen and refuses to regenerate it on a read error', async () => {
    const again = await AskStore.open(h.dir);
    expect(again.secret.equals(h.store.secret)).toBe(true);
    // A directory where the secret file should be is a non-ENOENT read error (EISDIR).
    const { mkdtemp: mk, mkdir } = await import('node:fs/promises');
    const dir2 = await mk(join(tmpdir(), 'kookr-asks-eisdir-'));
    await mkdir(join(dir2, 'asks', 'secret'), { recursive: true });
    await expect(AskStore.open(dir2)).rejects.toThrow();
    await rm(dir2, { recursive: true, force: true });
  });

  it('writes the secret and store with 0600 and a schemaVersion', async () => {
    await createOk();
    await h.store.flush();
    expect((await stat(join(h.dir, 'asks', 'secret'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(h.dir, 'asks', 'asks.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(h.dir, 'asks', 'asks.json'), 'utf-8')).schemaVersion).toBe(1);
  });

  it('prunes terminal asks past retention but never pending ones', async () => {
    const done = await createOk({ question: 'done' });
    await tap(done, 0);
    const pending = await createOk({ question: 'pending' });
    h.store.prune(h.clock.now + 8 * 24 * 60 * 60 * 1000);
    expect(h.store.get(done.id)).toBeUndefined();
    expect(h.store.get(pending.id)).toBeDefined();
  });
});

describe('ask routes', () => {
  function appFor(service: AskService | undefined): Hono {
    const app = new Hono();
    registerAskRoutes(app, { service });
    return app;
  }
  const post = (app: Hono, body: unknown) => app.request('/api/asks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('503s when Telegram is not configured and reads are empty (flag-off behaviour)', async () => {
    const app = appFor(undefined);
    const r = await post(app, base);
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('not_configured');
    expect(await (await app.request('/api/asks')).json()).toMatchObject({ asks: [] });
    expect((await app.request('/api/asks/abc')).status).toBe(404);
  });

  it('creates (201), dedupes (200), reads, lists and cancels; never leaks the nonce', async () => {
    const app = appFor(h.service);
    const created = await post(app, { ...base, idempotencyKey: 'k1' });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.ask.nonce).toBeUndefined();
    expect((await post(app, { ...base, idempotencyKey: 'k1' })).status).toBe(200);

    const one = await (await app.request(`/api/asks/${body.ask.id}`)).json();
    expect(one.ask).toMatchObject({ id: body.ask.id, state: 'pending' });
    expect(JSON.stringify(one)).not.toContain('nonce');
    const list = await (await app.request('/api/asks?state=pending&taskId=t1')).json();
    expect(list.asks).toHaveLength(1);
    expect((await app.request('/api/asks?state=bogus')).status).toBe(400);

    expect((await app.request(`/api/asks/${body.ask.id}/cancel`, { method: 'POST' })).status).toBe(200);
    expect((await app.request(`/api/asks/${body.ask.id}/cancel`, { method: 'POST' })).status).toBe(409);
    expect((await app.request('/api/asks/zzz/cancel', { method: 'POST' })).status).toBe(404);
  });

  it('adds the task name and whether the task has ended to each listed or read ask, in the same order', async () => {
    const statuses: Record<string, ContractTaskStatus> = { t1: 'inProgress' };
    const app = new Hono();
    registerAskRoutes(app, {
      service: h.service,
      taskName: (id) => (id === 't1' ? 'Fix login' : undefined),
      taskStatus: (id) => statuses[id],
    });
    const first = await (await post(app, { ...base, question: 'first?', idempotencyKey: 'k-first' })).json();
    const before = await (await app.request(`/api/asks/${first.ask.id}`)).json();
    expect(before.ask).toMatchObject({ id: first.ask.id, taskName: 'Fix login', taskEnded: false, question: 'first?', state: 'pending' });
    expect(JSON.stringify(before)).not.toContain('nonce');

    statuses.t1 = 'completed';
    const listed = await (await app.request('/api/asks?taskId=t1')).json();
    expect(listed.asks).toHaveLength(1);
    expect(listed.asks[0]).toMatchObject({ id: first.ask.id, taskName: 'Fix login', taskEnded: true });
    expect((await (await app.request(`/api/asks/${first.ask.id}`)).json()).ask.taskEnded).toBe(true);

    // A task that no longer exists counts as ended.
    delete statuses.t1;
    expect((await (await app.request('/api/asks')).json()).asks[0].taskEnded).toBe(true);
  });

  it('rejects a non-object JSON body with 400, not 500', async () => {
    const app = appFor(h.service);
    for (const raw of ['null', '[]', '"x"', '7']) {
      const r = await app.request('/api/asks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      expect(r.status).toBe(400);
    }
  });

  it.each([
    [{ ...base, taskId: 'nope' }, 404],
    [{ ...base, options: ['a'] }, 400],
    [{ question: 'x', options: ['a', 'b'] }, 400],
    [{ ...base, options: 'a' }, 400],
    [{ ...base, timeoutSec: 'soon' }, 400],
  ])('maps %j to HTTP %i', async (payload, status) => {
    expect((await post(appFor(h.service), payload)).status).toBe(status);
  });

  it('passes links through, refuses a malformed links field and an http link with 400', async () => {
    const app = appFor(h.service);
    const ok = await post(app, { ...base, links: [{ url: 'https://claude.ai/artifact/abc', label: 'Open mockups' }] });
    expect(ok.status).toBe(201);
    expect((await ok.json()).ask.links).toEqual([{ url: 'https://claude.ai/artifact/abc', label: 'Open mockups' }]);
    for (const links of ['https://x.example', [{ href: 'https://x.example' }], [{ url: 'https://x.example', label: 3 }], [null]]) {
      expect((await post(app, { ...base, taskId: 't2', links })).status).toBe(400);
    }
    expect((await post(app, { ...base, taskId: 't2', links: [{ url: 'http://x.example' }] })).status).toBe(400);
  });

  it('maps rate limits to 429 and redacted labels to 422', async () => {
    const app = appFor(h.service);
    for (let i = 0; i < 3; i++) await post(app, { ...base, question: `q${i}` });
    expect((await post(app, { ...base, question: 'q4' })).status).toBe(429);
    expect((await post(app, { ...base, taskId: 't2', options: ['ghp_' + 'a'.repeat(30), 'b'] })).status).toBe(422);
  });

  describe('POST /api/asks/:id/speak (Lucy reads the question)', () => {
    function speakApp(over: { ttsUrl?: string; synthesize?: ReturnType<typeof vi.fn> } = {}) {
      const synthesize = over.synthesize ?? vi.fn(async () => ({ audioBase64: 'UklGRg==', durationMs: 1234, generationTimeMs: 50 }));
      const recordSaid = vi.fn();
      const unprompted: LucyUnpromptedEntry[] = [];
      const app = new Hono();
      registerAskRoutes(app, {
        service: h.service,
        speech: {
          ttsUrl: 'ttsUrl' in over ? over.ttsUrl : 'http://tts.test',
          getVoice: () => 'af_heart',
          taskName: (id) => (id === 't1' ? 'Fix login' : undefined),
          lucyLog: { recordSaid, recordLiveTurn: vi.fn(), recordUi: vi.fn(), flush: async () => undefined },
          unprompted: { record: (entry) => { unprompted.push(entry); } },
          synthesize: synthesize as never,
        },
      });
      return { app, synthesize, recordSaid, unprompted };
    }
    const speak = (app: Hono, id: string) => app.request(`/api/asks/${id}/speak`, { method: 'POST' });

    it('returns the spoken question as a clip and logs what Lucy said', async () => {
      const ask = await createOk({ context: 'Background nobody should hear' });
      const { app, synthesize, recordSaid } = speakApp();
      const res = await speak(app, ask.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        text: 'The task Fix login needs your input: Ship it? Two choices are on my card.',
        audioBase64: 'UklGRg==', mimeType: 'audio/wav', durationMs: 1234, subject: 'Fix login', cached: false, usedFallback: false,
      });
      expect(body.clipId).toMatch(/^[0-9a-f-]{36}$/);
      expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ ttsUrl: 'http://tts.test', voice: 'af_heart', text: body.text, timeoutMs: 30_000 }));
      expect(recordSaid).toHaveBeenCalledWith(expect.objectContaining({ clipId: body.clipId, source: 'operator_ask', taskId: 't1', text: body.text }));
      expect(h.store.get(ask.id)?.state).toBe('pending');
    });

    it('records the question as something Lucy said unprompted, even when no clip can be made, until it is answered (issue #4143)', async () => {
      const ask = await createOk();
      // No speech service: the route answers 503 and the dashboard writes the words in her thread instead.
      const silent = speakApp({ ttsUrl: undefined });
      expect((await speak(silent.app, ask.id)).status).toBe(503);
      expect(silent.unprompted).toHaveLength(1);
      expect(silent.unprompted[0]).toMatchObject({
        key: `ask:${ask.id}`,
        text: 'The task Fix login needs your input: Ship it? Two choices are on my card.',
        tasks: [{ id: 't1', name: 'Fix login' }],
      });
      expect(silent.unprompted[0]!.stillOpen?.()).toBe(true);

      // A question nobody is about to hear (unknown, or closed) is not recorded.
      expect((await speak(silent.app, 'ffffffffffff')).status).toBe(404);
      await h.service.answerFromDashboard({ askId: ask.id, optionIndex: 0 });
      expect(silent.unprompted[0]!.stillOpen?.()).toBe(false);
      expect((await speak(silent.app, ask.id)).status).toBe(409);
      expect(silent.unprompted).toHaveLength(1);
    });

    it('tries once more when the speech service times out, as it does while loading a voice for the first time', async () => {
      const ask = await createOk();
      const synthesize = vi.fn()
        .mockRejectedValueOnce(new TTSClientError('timeout', 'TTS synthesize timed out after 15000ms'))
        .mockResolvedValueOnce({ audioBase64: 'UklGRg==', durationMs: 900, generationTimeMs: 40 });
      const { app } = speakApp({ synthesize });
      expect((await speak(app, ask.id)).status).toBe(200);
      expect(synthesize).toHaveBeenCalledTimes(2);

      const alwaysSlow = vi.fn().mockRejectedValue(new TTSClientError('timeout', 'still loading'));
      expect((await speak(speakApp({ synthesize: alwaysSlow }).app, ask.id)).status).toBe(502);
      expect(alwaysSlow).toHaveBeenCalledTimes(2);

      const broken = vi.fn().mockRejectedValue(new TTSClientError('http', 'TTS returned 500'));
      expect((await speak(speakApp({ synthesize: broken }).app, ask.id)).status).toBe(502);
      expect(broken).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown ask, 409s a closed one, 503s without a speech service and 502s when it fails', async () => {
      const ask = await createOk();
      expect((await speak(speakApp().app, 'ffffffffffff')).status).toBe(404);
      expect((await speak(speakApp({ ttsUrl: undefined }).app, ask.id)).status).toBe(503);
      const failing = speakApp({ synthesize: vi.fn(async () => { throw new Error('tts down'); }) });
      expect((await speak(failing.app, ask.id)).status).toBe(502);
      expect(failing.recordSaid).not.toHaveBeenCalled();
      await h.service.answerFromDashboard({ askId: ask.id, optionIndex: 0 });
      const closed = speakApp();
      expect((await speak(closed.app, ask.id)).status).toBe(409);
      expect(closed.synthesize).not.toHaveBeenCalled();
    });
  });

  it('exposes no route that records an answer', async () => {
    const app = appFor(h.service);
    const created = await (await post(app, base)).json();
    for (const path of [`/api/asks/${created.ask.id}/answer`, `/api/asks/${created.ask.id}`]) {
      expect((await app.request(path, { method: 'POST', body: '{"option":0}' })).status).toBe(404);
      expect((await app.request(path, { method: 'PUT', body: '{"option":0}' })).status).toBe(404);
    }
    expect(h.store.get(created.ask.id)?.state).toBe('pending');
  });
});

describe('AskService.answerFromDashboard (Lucy) and channel sync', () => {
  it('records a button answer, types the same text into the task and tells Telegram it was answered in Kookr', async () => {
    const ask = await createOk();
    const r = await h.service.answerFromDashboard({ askId: ask.id, optionIndex: 1 });
    expect(r.ok).toBe(true);
    expect(h.store.get(ask.id)).toMatchObject({
      state: 'answered', answeredVia: 'dashboard', answer: { kind: 'option', index: 1, label: 'No' }, taskDelivery: 'delivered',
    });
    expect(h.store.get(ask.id)?.answeredBy).toBeUndefined();
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${ask.id}: No`);
    const [, text] = h.notifier.finalizeAsk.mock.calls.at(-1) as [AskRecord, string];
    expect(text).toContain('Already answered in Kookr: No');
    expect(text).toContain('Nothing more is needed here.');
  });

  it('marks a Telegram answer with its channel and keeps the Telegram wording', async () => {
    const ask = await createOk();
    expect((await tap(ask, 0)).ok).toBe(true);
    expect(h.store.get(ask.id)).toMatchObject({ answeredVia: 'telegram', answeredBy: 7 });
    const [, text] = h.notifier.finalizeAsk.mock.calls.at(-1) as [AskRecord, string];
    expect(text).toContain('✅ Answered: Yes');
    expect(text).not.toContain('in Kookr');
  });

  it('gives exactly one winner when Telegram and the dashboard answer at the same time', async () => {
    const ask = await createOk();
    const [fromTelegram, fromDashboard] = await Promise.all([
      tap(ask, 0),
      h.service.answerFromDashboard({ askId: ask.id, optionIndex: 1 }),
    ]);
    expect([fromTelegram.ok, fromDashboard.ok].filter(Boolean)).toHaveLength(1);
    const loser = fromTelegram.ok ? fromDashboard : fromTelegram;
    expect(loser).toMatchObject({ ok: false, reason: 'already_answered' });
    expect(h.deliver).toHaveBeenCalledOnce();
  });

  it('refuses a dashboard answer after a Telegram answer, and a Telegram tap after a dashboard answer', async () => {
    const first = await createOk();
    await tap(first, 0);
    expect(await h.service.answerFromDashboard({ askId: first.id, optionIndex: 1 }))
      .toMatchObject({ ok: false, reason: 'already_answered', ask: { answeredVia: 'telegram' } });

    const second = await createOk({ question: 'Second?' });
    await h.service.answerFromDashboard({ askId: second.id, optionIndex: 1 });
    expect(await tap(second, 0)).toMatchObject({ ok: false, reason: 'already_answered', ask: { answeredVia: 'dashboard' } });
    expect(h.store.get(second.id)?.answer).toEqual({ kind: 'option', index: 1, label: 'No' });
  });

  it('accepts typed text only when the ask allows it, and rejects both-or-neither and bad indexes', async () => {
    const open = await createOk();
    expect(await h.service.answerFromDashboard({ askId: open.id })).toMatchObject({ ok: false, reason: 'bad_option' });
    expect(await h.service.answerFromDashboard({ askId: open.id, optionIndex: 0, text: 'x' })).toMatchObject({ ok: false, reason: 'bad_option' });
    expect(await h.service.answerFromDashboard({ askId: open.id, optionIndex: 9 })).toMatchObject({ ok: false, reason: 'bad_option' });
    expect(await h.service.answerFromDashboard({ askId: open.id, optionIndex: 0.5 })).toMatchObject({ ok: false, reason: 'bad_option' });
    expect(await h.service.answerFromDashboard({ askId: open.id, text: '   ' })).toMatchObject({ ok: false, reason: 'bad_option' });
    expect(h.store.get(open.id)?.state).toBe('pending');
    expect((await h.service.answerFromDashboard({ askId: open.id, text: ' do both ' })).ok).toBe(true);
    expect(h.store.get(open.id)?.answer).toEqual({ kind: 'text', text: 'do both' });
    expect(h.deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${open.id}: (free text) do both`);

    const closed = await createOk({ question: 'Buttons only?', allowText: false });
    expect(await h.service.answerFromDashboard({ askId: closed.id, text: 'hello' })).toMatchObject({ ok: false, reason: 'text_not_allowed' });
  });

  it('refuses unknown and expired asks, and records task-gone ones, the same way Telegram does', async () => {
    expect(await h.service.answerFromDashboard({ askId: 'ffffffffffff', optionIndex: 0 })).toEqual({ ok: false, reason: 'not_found' });

    const late = await createOk({ timeoutSec: 30 });
    h.clock.now += 31_000;
    expect(await h.service.answerFromDashboard({ askId: late.id, optionIndex: 0 })).toMatchObject({ ok: false, reason: 'expired' });

    const gone = await createOk({ taskId: 't2' });
    h.statuses.delete('t2');
    expect(await h.service.answerFromDashboard({ askId: gone.id, optionIndex: 0 })).toMatchObject({ ok: true, ask: { state: 'answered', taskDelivery: 'skipped' } });
    expect(h.deliver).not.toHaveBeenCalledWith('t2', expect.stringContaining('Operator answered'));
  });

  it('does not accept a dashboard answer for a question whose Telegram message does not exist yet', async () => {
    let release: (v: { chatId: number; messageId: number }) => void = () => undefined;
    h.notifier.sendAsk.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const creating = h.service.create(base);
    await vi.waitFor(() => expect(h.notifier.sendAsk).toHaveBeenCalled());
    const pending = h.store.all()[0];
    expect(await h.service.answerFromDashboard({ askId: pending.id, optionIndex: 0 })).toEqual({ ok: false, reason: 'not_found' });
    release({ chatId: 42, messageId: 999 });
    expect((await creating).ok).toBe(true);
    expect(h.store.get(pending.id)?.state).toBe('pending');
  });

  it('announces a question once its Telegram message exists, and every way it can close', async () => {
    const seen: string[] = [];
    const off = h.service.onChange((c) => seen.push(`${c.kind}:${c.ask.state}:${c.ask.resolution ?? '-'}:${c.ask.delivery ? 'sent' : 'unsent'}`));

    const answeredOnTelegram = await createOk();
    await tap(answeredOnTelegram, 0);
    const answeredInKookr = await createOk({ question: 'Two?' });
    await h.service.answerFromDashboard({ askId: answeredInKookr.id, optionIndex: 0 });
    const cancelled = await createOk({ question: 'Three?' });
    await h.service.cancel(cancelled.id);
    const expired = await createOk({ taskId: 't2', question: 'Four?', timeoutSec: 30 });
    h.clock.now += 31_000;
    await h.service.sweepExpired();
    expect(h.store.get(expired.id)?.state).toBe('expired');

    // An answered question is announced twice: when it closes, then when it is known whether the answer reached the task.
    expect(seen).toEqual([
      'created:pending:-:sent', 'resolved:answered:answered:sent', 'updated:answered:answered:sent',
      'created:pending:-:sent', 'resolved:answered:answered:sent', 'updated:answered:answered:sent',
      'created:pending:-:sent', 'resolved:cancelled:cancelled:sent',
      'created:pending:-:sent', 'resolved:expired:expired:sent',
    ]);
    expect(h.store.get(cancelled.id)?.resolvedAt).toBeTypeOf('number');

    off();
    await createOk({ taskId: 't2', question: 'Five?' });
    expect(seen).toHaveLength(10);
  });

  it('stamps when each question closed, whatever closed it', async () => {
    const answeredHere = await createOk();
    h.clock.now += 5_000;
    await h.service.answerFromDashboard({ askId: answeredHere.id, optionIndex: 0 });
    expect(h.store.get(answeredHere.id)).toMatchObject({ resolvedAt: h.clock.now, answeredAt: h.clock.now });

    const answeredThere = await createOk({ question: 'Two?' });
    h.clock.now += 7_000;
    await tap(answeredThere, 1);
    expect(h.store.get(answeredThere.id)).toMatchObject({ resolvedAt: h.clock.now, answeredAt: h.clock.now });

    const cancelled = await createOk({ question: 'Three?' });
    h.clock.now += 9_000;
    await h.service.cancel(cancelled.id);
    expect(h.store.get(cancelled.id)?.resolvedAt).toBe(h.clock.now);

    const gone = await createOk({ taskId: 't2', question: 'Four?' });
    h.clock.now += 11_000;
    h.statuses.delete('t2');
    await h.service.answerFromDashboard({ askId: gone.id, optionIndex: 0 });
    expect(h.store.get(gone.id)).toMatchObject({ resolution: 'answered', taskDelivery: 'skipped', resolvedAt: h.clock.now });
  });

  it('tells Telegram both that it was answered in Kookr and that the task could not be reached', async () => {
    h.deliver.mockResolvedValueOnce({ ok: false, reason: 'session gone' });
    const ask = await createOk();
    await h.service.answerFromDashboard({ askId: ask.id, optionIndex: 0 });
    const [, text] = h.notifier.finalizeAsk.mock.calls.at(-1) as [AskRecord, string];
    expect(text).toContain('Already answered in Kookr: Yes');
    expect(text).toContain('Could not type it into the task (session gone)');
    expect(h.store.get(ask.id)?.taskDelivery).toBe('failed');
  });

  it('tells listeners when the answer could not be typed into the task', async () => {
    const deliveries: Array<string | undefined> = [];
    h.service.onChange((c) => { if (c.kind !== 'created') deliveries.push(`${c.kind}:${c.ask.taskDelivery ?? 'unknown'}`); });
    h.deliver.mockResolvedValueOnce({ ok: false, reason: 'session gone' });
    const ask = await createOk();
    expect((await h.service.answerFromDashboard({ askId: ask.id, optionIndex: 0 })).ok).toBe(true);
    expect(deliveries).toEqual(['resolved:unknown', 'updated:failed']);
  });

  it('never announces a question that could not be sent, and survives a throwing listener', async () => {
    const kinds: string[] = [];
    h.service.onChange(() => { throw new Error('listener bug'); });
    h.service.onChange((c) => kinds.push(`${c.kind}:${c.ask.resolution ?? '-'}`));
    h.notifier.sendAsk.mockRejectedValueOnce(new Error('telegram down'));
    expect((await h.service.create(base)).ok).toBe(false);
    expect(kinds).toEqual(['resolved:delivery_failed']);
    const ok = await createOk({ question: 'Again?' });
    expect((await h.service.answerFromDashboard({ askId: ok.id, optionIndex: 0 })).ok).toBe(true);
  });
});

describe('AskService.createSystem (issue #4215)', () => {
  const systemInput = { system: 'interrupted-tasks', question: 'Resume 2 tasks?', options: ['Resume', 'Leave stopped'], allowText: false };

  it('asks without a task: no task check, a synthetic task id, and the system recorded', async () => {
    const r = await h.service.createSystem(systemInput);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.ask).toMatchObject({ taskId: 'system:interrupted-tasks', system: 'interrupted-tasks', state: 'pending' });
    expect(r.ask.sessionId).toBeUndefined();
    expect(h.notifier.sendAsk).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed system name', async () => {
    const r = await h.service.createSystem({ ...systemInput, system: 'Bad Name!' });
    expect(r.ok).toBe(false);
  });

  it('records the answer, types nothing, and tells listeners which option was chosen', async () => {
    const changes: Array<{ kind: string; label?: string }> = [];
    h.service.onChange((c) => changes.push({ kind: c.kind, ...(c.ask.answer?.kind === 'option' ? { label: c.ask.answer.label } : {}) }));
    const r = await h.service.createSystem(systemInput);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const result = await tap(r.ask, 0);
    expect(result.ok).toBe(true);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.store.get(r.ask.id)).toMatchObject({ state: 'answered', taskDelivery: 'skipped' });
    expect(changes).toContainEqual({ kind: 'resolved', label: 'Resume' });
    expect(h.notifier.finalizeAsk.mock.calls.at(-1)?.[1]).toContain('Recorded. Kookr acts on it.');
  });

  it('cancel closes the Telegram message with the given note', async () => {
    const r = await h.service.createSystem(systemInput);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await h.service.cancel(r.ask.id, 'No answer in time: 2 resumed.');
    expect(h.store.get(r.ask.id)?.state).toBe('cancelled');
    expect(h.notifier.finalizeAsk.mock.calls.at(-1)?.[1]).toContain('No answer in time: 2 resumed.');
  });

  it('the task-facing create still refuses an unknown task id', async () => {
    const r = await h.service.create({ ...base, taskId: 'system:interrupted-tasks' });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_task' } });
  });
});
