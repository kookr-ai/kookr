/**
 * `kookr ask` over the Telegram transport, end to end and hermetic: the real
 * ask service + store, the real Telegram integration, and the in-process fake
 * Telegram server. Button taps and replies are simulated by queueing updates.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchResult } from '../../shared/contracts/launch.js';
import type { TelegramHandle } from '../../shared/contracts/telegram.js';
import type { TaskStatus } from '../../core/task-status.js';
import { startFakeTelegram, type FakeTelegramServer } from '../../integrations/telegram/fake-telegram-server.js';
import { startTelegramTrigger } from '../../integrations/telegram/index.js';
import { AskService } from './ask-service.js';
import { AskStore } from './ask-store.js';

const USER = 4242;
const OTHER = 999;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { last = e; await sleep(20); }
  }
  throw last;
}

let tmp: string;
let fake: FakeTelegramServer;
let handle: TelegramHandle | null;
let service: AskService | null;
let store: AskStore;
let statuses: Map<string, TaskStatus>;
let deliver: ReturnType<typeof vi.fn>;
let clock: { now: number };
let updateId = 0;
const originalUrl = process.env.KOOKR_TELEGRAM_API_URL;

function audit(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(tmp, 'telegram', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Boot the integration with (default) or without the ask service wired in. */
async function boot(opts: { withAsks?: boolean } = {}): Promise<void> {
  store = await AskStore.open(tmp);
  service = new AskService({
    store,
    getNotifier: () => handle?.ask,
    taskStatus: (id) => statuses.get(id),
    deliverToTask: deliver,
    now: () => clock.now,
  });
  handle = await startTelegramTrigger({
    token: 'test-token',
    allowedUserIds: new Set([USER]),
    allowedProjects: [{ name: 'p', cwd: '/tmp/p' }],
    dataDir: tmp,
    dryRun: false,
    dashboardBaseUrl: 'http://localhost:4800',
    launchTask: vi.fn(async () => ({ task: { id: 't' }, queued: false }) as unknown as LaunchResult),
    llmClient: null,
    ...(opts.withAsks === false ? {} : { asks: service }),
  });
}

async function ask(over: Record<string, unknown> = {}) {
  const r = await service!.create({ taskId: 't1', question: 'Ship it?', context: 'CI is green', options: ['Yes', 'No'], ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.ask;
}

/** The inline keyboard of the nth question message the fake server saw. */
function keyboard(n = 0): Array<{ text: string; callback_data: string }> {
  const sent = fake.outbound.sendMessage.filter((m) => m.reply_markup);
  const markup = sent[n].reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  return markup.inline_keyboard.flat();
}

function tap(data: string, over: { from?: number; chatId?: number; messageId?: number; chatType?: 'private' | 'group' } = {}): void {
  fake.queueUpdates([{
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: over.from ?? USER },
      data,
      message: { message_id: over.messageId ?? 1, chat: { id: over.chatId ?? USER, type: over.chatType ?? 'private' } },
    },
  } as never]);
}

function reply(text: string, replyTo: number, from = USER): void {
  fake.queueUpdates([{
    update_id: ++updateId,
    message: {
      message_id: 900 + updateId,
      from: { id: from },
      chat: { id: from, type: 'private' },
      text,
      reply_to_message: { message_id: replyTo, chat: { id: from, type: 'private' } },
    },
  } as never]);
}

const toasts = () => fake.outbound.answerCallbackQuery.map((a) => a.text);

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kookr-ask-tg-'));
  fake = await startFakeTelegram();
  process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
  statuses = new Map([['t1', 'running' as TaskStatus]]);
  deliver = vi.fn(async () => ({ ok: true }));
  clock = { now: Date.now() };
  handle = null; service = null; updateId = 0;
});
afterEach(async () => {
  await service?.stop();
  if (handle) await handle.stop();
  await fake.stop();
  if (originalUrl === undefined) delete process.env.KOOKR_TELEGRAM_API_URL; else process.env.KOOKR_TELEGRAM_API_URL = originalUrl;
  rmSync(tmp, { recursive: true, force: true });
});

describe('kookr ask over Telegram', () => {
  it('sends the question with one button per option and records the message', async () => {
    await boot();
    const a = await ask();
    expect(fake.outbound.sendMessage).toHaveLength(1);
    const msg = fake.outbound.sendMessage[0];
    expect(msg.chat_id).toBe(USER);
    expect(msg.text).toContain('Ship it?');
    expect(msg.text).toContain('CI is green');
    expect(msg.text).toContain('reply to this message');
    expect(keyboard().map((b) => b.text)).toEqual(['Yes', 'No']);
    for (const b of keyboard()) {
      expect(b.callback_data).toMatch(/^ask:[0-9a-f]{12}:[0-3]:[0-9a-f]{16}$/);
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
    expect(store.get(a.id)?.delivery).toMatchObject({ chatId: USER });
    await waitFor(() => expect(audit().some((e) => e.kind === 'ask_sent' && e.askId === a.id)).toBe(true));
  });

  it('a button tap records the answer, edits the message and types it into the task', async () => {
    await boot();
    const a = await ask();
    const messageId = store.get(a.id)!.delivery!.messageId;
    tap(keyboard()[1].callback_data, { messageId });
    await waitFor(() => expect(store.get(a.id)?.state).toBe('answered'));
    expect(store.get(a.id)).toMatchObject({ answer: { kind: 'option', index: 1, label: 'No' }, answeredBy: USER, taskDelivery: 'delivered' });
    expect(deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${a.id}: No`);
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.message_id === messageId && e.text.startsWith('✅ Answered: No'))).toBe(true));
    await waitFor(() => expect(toasts()).toContain('Sent'));
    await waitFor(() => {
      const events = audit();
      expect(events.some((e) => e.kind === 'ask_answered' && e.via === 'button' && e.sender === USER)).toBe(true);
      expect(events.some((e) => e.kind === 'ask_finalized' && e.state === 'answered')).toBe(true);
    });
  });

  it('never writes callback data (the MAC), question or answer text to the audit log', async () => {
    await boot();
    const a = await ask({ question: 'Secretive question?' });
    const data = keyboard()[0].callback_data;
    tap(data, { messageId: store.get(a.id)!.delivery!.messageId });
    tap(`ask:${a.id}:0:${'0'.repeat(16)}`, { messageId: 1 });
    await waitFor(() => expect(store.get(a.id)?.state).toBe('answered'));
    await waitFor(() => expect(audit().filter((e) => e.kind === 'ask_rejected').length).toBeGreaterThan(0));
    const raw = readFileSync(join(tmp, 'telegram', 'audit.jsonl'), 'utf8');
    expect(raw).not.toContain(data.split(':')[3]);
    // The forged tap's data (id:index:mac) must not appear either — the rejected path is audited too.
    expect(raw).not.toContain('0'.repeat(16));
    expect(raw).not.toContain('Secretive question');
    expect(raw).not.toContain('callback_invalid');
  });

  it('ignores a tap from a user who is not allowlisted', async () => {
    await boot();
    const a = await ask();
    tap(keyboard()[0].callback_data, { from: OTHER, chatId: OTHER, messageId: store.get(a.id)!.delivery!.messageId });
    await sleep(300);
    expect(store.get(a.id)?.state).toBe('pending');
    expect(deliver).not.toHaveBeenCalled();
    await waitFor(() => expect(audit().some((e) => e.kind === 'dropped_unauthorized')).toBe(true));
  });

  it('rejects a forged MAC and a MAC borrowed from another option', async () => {
    await boot();
    const a = await ask();
    const messageId = store.get(a.id)!.delivery!.messageId;
    tap(`ask:${a.id}:0:${'a'.repeat(16)}`, { messageId });
    const borrowed = keyboard()[1].callback_data.split(':')[3];
    tap(`ask:${a.id}:0:${borrowed}`, { messageId });
    await waitFor(() => expect(toasts().filter((t) => t === 'Invalid button.')).toHaveLength(2));
    expect(store.get(a.id)?.state).toBe('pending');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects malformed callback data without touching the service', async () => {
    await boot();
    const a = await ask();
    tap('ask:../../etc:9:zz');
    tap(`ask:${a.id}:7:${'a'.repeat(16)}`);
    await waitFor(() => expect(toasts().filter((t) => t === 'Invalid button.')).toHaveLength(2));
    await waitFor(() => expect(audit().filter((e) => e.kind === 'ask_rejected' && e.reason === 'malformed')).toHaveLength(2));
    expect(store.get(a.id)?.state).toBe('pending');
  });

  it('rejects a tap whose message is not the ask message, or that comes from a group', async () => {
    await boot();
    const a = await ask();
    const data = keyboard()[0].callback_data;
    const real = store.get(a.id)!.delivery!.messageId;
    tap(data, { messageId: real + 50 });
    tap(data, { messageId: real, chatType: 'group' });
    await waitFor(() => expect(audit().filter((e) => e.kind === 'ask_rejected' && e.reason === 'wrong_chat')).toHaveLength(2));
    expect(store.get(a.id)?.state).toBe('pending');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a second tap is rejected as already answered and delivers nothing more', async () => {
    await boot();
    const a = await ask();
    const messageId = store.get(a.id)!.delivery!.messageId;
    tap(keyboard()[0].callback_data, { messageId });
    await waitFor(() => expect(store.get(a.id)?.state).toBe('answered'));
    tap(keyboard()[1].callback_data, { messageId });
    await waitFor(() => expect(toasts()).toContain('Already answered.'));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.get(a.id)?.answer).toMatchObject({ label: 'Yes' });
  });

  it('a free-text reply to the question message is the answer', async () => {
    await boot();
    const a = await ask();
    reply('ship it after lunch', store.get(a.id)!.delivery!.messageId);
    await waitFor(() => expect(store.get(a.id)?.state).toBe('answered'));
    expect(store.get(a.id)?.answer).toEqual({ kind: 'text', text: 'ship it after lunch' });
    expect(deliver).toHaveBeenCalledWith('t1', `Operator answered ask ${a.id}: (free text) ship it after lunch`);
    await waitFor(() => expect(audit().some((e) => e.kind === 'ask_answered' && e.via === 'text')).toBe(true));
  });

  it('refuses free text when the ask was created with --no-other, and a reply is never treated as a new task', async () => {
    await boot();
    const a = await ask({ allowText: false });
    expect(fake.outbound.sendMessage[0].text).not.toContain('reply to this message');
    reply('hello', store.get(a.id)!.delivery!.messageId);
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => m.text === 'This question only accepts the buttons.')).toBe(true));
    expect(store.get(a.id)?.state).toBe('pending');
  });

  it('a reply to an already-closed question gets a hint, not the spawn flow', async () => {
    await boot();
    const a = await ask();
    const messageId = store.get(a.id)!.delivery!.messageId;
    tap(keyboard()[0].callback_data, { messageId });
    await waitFor(() => expect(store.get(a.id)?.state).toBe('answered'));
    reply('actually no', messageId);
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => m.text === 'This question is already closed.')).toBe(true));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('an answer given in the dashboard edits the Telegram message, and a later tap or reply is told it was answered in Kookr', async () => {
    await boot();
    const a = await ask();
    const messageId = store.get(a.id)!.delivery!.messageId;
    expect((await service!.answerFromDashboard({ askId: a.id, optionIndex: 1 })).ok).toBe(true);

    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.message_id === messageId)).toBe(true));
    const edit = fake.outbound.editMessageText.find((e) => e.message_id === messageId)!;
    expect(edit.text).toContain('✅ Already answered in Kookr: No');
    expect(edit.text).toContain('Nothing more is needed here.');
    expect(edit.text).toContain('Ship it?');
    await waitFor(() => expect(audit().some((e) => e.kind === 'ask_finalized' && e.answeredVia === 'dashboard')).toBe(true));

    tap(keyboard()[0].callback_data, { messageId });
    await waitFor(() => expect(toasts()).toContain('You already answered this one in Kookr. Nothing more is needed here.'));
    // A forged button on the same question is still called forged, not "answered in Kookr".
    tap(`ask:${a.id}:0:${'0'.repeat(16)}`, { messageId });
    await waitFor(() => expect(toasts()).toContain('Invalid button.'));
    reply('actually yes', messageId);
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => m.text === 'You already answered this one in Kookr. Nothing more is needed here.')).toBe(true));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.get(a.id)).toMatchObject({ answeredVia: 'dashboard', answer: { label: 'No' } });
  });

  it('a rate-limited tap is rejected before the ask service is consulted', async () => {
    await boot();
    const a = await ask();
    const messageId = store.get(a.id)!.delivery!.messageId;
    // The shared limiter allows 10 per minute per user: burn it with bad taps, then tap the real button.
    for (let i = 0; i < 10; i++) tap(`ask:${a.id}:0:${'c'.repeat(16)}`, { messageId });
    tap(keyboard()[0].callback_data, { messageId });
    await waitFor(() => expect(toasts()).toContain('Rate limited. Try again in a minute.'));
    expect(store.get(a.id)?.state).toBe('pending');
  });

  it('sends the question to the spawning chat only while that user is still allowlisted', async () => {
    await boot();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    await handle!.stop();
    handle = null;
    mkdirSync(join(tmp, 'telegram'), { recursive: true });
    writeFileSync(join(tmp, 'telegram', 'state.json'), JSON.stringify({ offset: 0, spawnsByMs: [], origin: { t1: OTHER }, agentDefaultsByUser: {}, sentNotifications: {} }));
    await boot();
    await ask();
    expect(fake.outbound.sendMessage.at(-1)?.chat_id).toBe(USER);
  });

  it('a command-looking reply is not an answer', async () => {
    await boot();
    const a = await ask();
    reply('/tasks', store.get(a.id)!.delivery!.messageId);
    await sleep(300);
    expect(store.get(a.id)?.state).toBe('pending');
  });

  it('says so and delivers nothing when the task is gone by the time the operator answers', async () => {
    await boot();
    const a = await ask();
    statuses.set('t1', 'completed' as TaskStatus);
    tap(keyboard()[0].callback_data, { messageId: store.get(a.id)!.delivery!.messageId });
    await waitFor(() => expect(store.get(a.id)?.resolution).toBe('task_gone'));
    expect(deliver).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.text.includes('no longer running'))).toBe(true));
    await waitFor(() => expect(toasts()).toContain('The task is no longer running, so the answer was not delivered.'));
  });

  it('expiry edits the message to "expired" and notifies the live task once', async () => {
    await boot();
    const a = await ask({ timeoutSec: 60 });
    clock.now += 61_000;
    await service!.sweepExpired();
    expect(store.get(a.id)?.state).toBe('expired');
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.text.startsWith('⌛ Expired'))).toBe(true));
    expect(deliver).toHaveBeenCalledWith('t1', `Ask ${a.id} expired with no answer.`);
    tap(keyboard()[0].callback_data, { messageId: store.get(a.id)!.delivery!.messageId });
    await waitFor(() => expect(toasts()).toContain('This question expired.'));
  });

  it('a button from before a server restart still works (secret and asks are persisted)', async () => {
    await boot();
    const a = await ask();
    const data = keyboard()[0].callback_data;
    const messageId = store.get(a.id)!.delivery!.messageId;
    await service!.stop();
    await handle!.stop();
    handle = null;
    fake.outbound.sendMessage.length = 0;
    await boot();
    tap(data, { messageId });
    await waitFor(() => expect(store.get(a.id)?.state).toBe('answered'));
  });

  it('flag-off: without an ask service the handle has no notifier and ask buttons are inert', async () => {
    await boot({ withAsks: false });
    expect(handle!.ask).toBeUndefined();
    const created = await service!.create({ taskId: 't1', question: 'Q?', options: ['a', 'b'] });
    expect(created).toEqual({ ok: false, error: { code: 'not_configured' } });
    tap(`ask:${'a'.repeat(12)}:0:${'b'.repeat(16)}`);
    await waitFor(() => expect(toasts()).toContain('Questions are unavailable.'));
    expect(fake.outbound.sendMessage).toHaveLength(0);
  });
});
