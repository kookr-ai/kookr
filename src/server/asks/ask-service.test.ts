import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AskNotifier, AskRecord } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../core/task-status.js';
import { registerAskRoutes } from '../routes/ask-routes.js';
import { AskService } from './ask-service.js';
import { AskStore } from './ask-store.js';

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

  it('does not deliver when the task is gone and says so', async () => {
    const ask = await createOk();
    h.statuses.set('t1', 'completed' as TaskStatus);
    const r = await tap(ask, 0);
    expect(r).toMatchObject({ ok: false, reason: 'task_gone', ask: { state: 'cancelled', resolution: 'task_gone' } });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.notifier.finalizeAsk).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no longer running'));
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

  it('maps rate limits to 429 and redacted labels to 422', async () => {
    const app = appFor(h.service);
    for (let i = 0; i < 3; i++) await post(app, { ...base, question: `q${i}` });
    expect((await post(app, { ...base, question: 'q4' })).status).toBe(429);
    expect((await post(app, { ...base, taskId: 't2', options: ['ghp_' + 'a'.repeat(30), 'b'] })).status).toBe(422);
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
