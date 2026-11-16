/**
 * Reminders for unanswered `kookr ask` questions (issue #3929), on a fake clock: the schedule, the
 * stops (answer, withdrawal, expiry), quiet hours, restarts and the bounds that keep a phone quiet.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askReminderDue,
  DEFAULT_ASK_REMINDERS,
  validateAskReminders,
  type AskNotifier,
  type AskRecord,
  type AskReminderSchedule,
} from '../../shared/contracts/asks.js';
import type { QuietHoursWindow } from '../../shared/contracts/quiet-hours.js';
import type { TaskStatus } from '../../core/task-status.js';
import { AskService, formatWaitDuration } from './ask-service.js';
import { AskStore } from './ask-store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 09:00 local time: quiet hours are local wall-clock windows, so the tests build local dates. */
const START = new Date(2026, 10, 16, 9, 0, 0).getTime();

interface Harness {
  dir: string;
  store: AskStore;
  service: AskService;
  notifier: { sendAsk: ReturnType<typeof vi.fn>; finalizeAsk: ReturnType<typeof vi.fn>; sendAskReminder: ReturnType<typeof vi.fn> };
  clock: { now: number };
  settings: { schedule: AskReminderSchedule; quietHours: QuietHoursWindow[] };
}

let h: Harness;
let messageIds = 100;

async function harness(dir?: string, clock = { now: START }): Promise<Harness> {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'kookr-ask-reminders-'));
  const store = await AskStore.open(d);
  const notifier = {
    sendAsk: vi.fn(async () => ({ chatId: 42, messageId: messageIds++ })),
    finalizeAsk: vi.fn(async () => undefined),
    sendAskReminder: vi.fn(async () => ({ messageId: messageIds++ })),
  };
  const statuses = new Map<string, TaskStatus>(['t1', 't2', 't3', 't4'].map((t) => [t, 'running' as TaskStatus]));
  const settings = { schedule: { ...DEFAULT_ASK_REMINDERS }, quietHours: [] as QuietHoursWindow[] };
  const service = new AskService({
    store,
    getNotifier: () => notifier as unknown as AskNotifier,
    taskStatus: (id) => statuses.get(id),
    deliverToTask: vi.fn(async () => ({ ok: true })),
    reminderSettings: () => settings,
    now: () => clock.now,
  });
  return { dir: d, store, service, notifier, clock, settings };
}

async function ask(over: Partial<Parameters<AskService['create']>[0]> = {}): Promise<AskRecord> {
  const r = await h.service.create({ taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'], timeoutSec: 24 * 60 * 60, ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.ask;
}

/** Advance the fake clock to `until` (ms after START) in sweep-sized steps, sweeping each time. */
async function runUntil(until: number, step = 30_000): Promise<void> {
  while (h.clock.now < START + until) {
    h.clock.now = Math.min(h.clock.now + step, START + until);
    await h.service.sweepExpired();
    await h.service.sendDueReminders();
  }
}

/** When each reminder was sent, in minutes after START. */
const sentAtMinutes = (): number[] =>
  h.store.all().flatMap((a) => (a.reminders ?? []).map((r) => Math.round((r.at - START) / MIN))).sort((a, b) => a - b);

beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.service.stop(); await rm(h.dir, { recursive: true, force: true }); });

describe('ask reminders', () => {
  it('reminds a question open for 5 hours at 10 minutes, 1 hour and 5 hours, as a reply saying how long it waited', async () => {
    const a = await ask();
    await runUntil(5 * HOUR + 5 * MIN);
    expect(sentAtMinutes()).toEqual([10, 60, 300]);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(3);
    const [first] = h.notifier.sendAskReminder.mock.calls[0] as [AskRecord, string];
    expect(first.id).toBe(a.id);
    const texts = h.notifier.sendAskReminder.mock.calls.map((c) => c[1] as string);
    expect(texts[0]).toContain('asked 10 min ago, closes in 23 h 50 min');
    expect(texts[1]).toContain('asked 1 h ago, closes in 23 h');
    expect(texts[0]).toContain('Ship it?');
    expect(texts[0]).toContain('reply to this message with text');
    // Each sent reminder keeps its Telegram message id, so a reply to it can answer the question.
    expect(h.store.get(a.id)?.reminders?.every((r) => typeof r.messageId === 'number')).toBe(true);
  });

  it('sends nothing more once the question is answered in the dashboard', async () => {
    const a = await ask();
    await runUntil(15 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(1);
    expect((await h.service.answerFromDashboard({ askId: a.id, optionIndex: 0 })).ok).toBe(true);
    await runUntil(6 * HOUR, 5 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(1);
  });

  it('sends nothing more once the question is withdrawn', async () => {
    const a = await ask();
    await runUntil(15 * MIN);
    await h.service.cancel(a.id);
    await runUntil(6 * HOUR, 5 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(1);
  });

  it('a default 30-minute question is reminded at 10 and 20 minutes, then nothing after it expires', async () => {
    await ask({ timeoutSec: 30 * 60 });
    await runUntil(3 * HOUR, MIN);
    expect(sentAtMinutes()).toEqual([10, 20]);
    expect(h.store.all()[0].reminders?.map((r) => r.kind)).toEqual([undefined, 'before_close']);
    expect(h.store.all()[0].state).toBe('expired');
  });

  it('holds reminders back during quiet hours and sends one when they end', async () => {
    h.settings.quietHours = [{ start: '09:05', end: '12:00' }];
    await ask();
    // 09:10 and 10:00 fall in the window: they are owed as one reminder at 12:00, then 14:00 follows.
    await runUntil(5 * HOUR + 30 * MIN);
    expect(sentAtMinutes()).toEqual([180, 300]);
  });

  it('does not repeat a reminder after a restart', async () => {
    await ask();
    await runUntil(11 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(1);
    await h.service.stop();
    h = await harness(h.dir, h.clock);
    await runUntil(30 * MIN);
    expect(h.notifier.sendAskReminder).not.toHaveBeenCalled();
    await runUntil(61 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(1);
    expect(sentAtMinutes()).toEqual([10, 60]);
  });

  it('an empty schedule switches reminders off, the reminder before closing included', async () => {
    h.settings.schedule = { afterMinutes: [], thenEveryMinutes: 240, beforeCloseMinutes: 10 };
    await ask({ timeoutSec: 30 * 60 });
    await runUntil(40 * MIN, MIN);
    expect(h.notifier.sendAskReminder).not.toHaveBeenCalled();
  });

  it('sends at most six reminders an hour for all questions together; the rest come later, one each', async () => {
    for (const taskId of ['t1', 't2', 't3', 't4']) {
      await ask({ taskId });
      await ask({ taskId, question: 'And this?' });
    }
    await runUntil(11 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(6);
    // The two held back are reminded once the hour has room, and not twice for the points they missed.
    await runUntil(75 * MIN);
    const perAsk = h.store.all().map((a) => a.reminders?.length ?? 0);
    expect(perAsk.reduce((s, n) => s + n, 0)).toBe(12);
    expect(Math.max(...perAsk)).toBeLessThanOrEqual(2);
    expect(perAsk.every((n) => n >= 1)).toBe(true);
  });

  it('a failed send is recorded and not retried until the next point of the schedule', async () => {
    h.notifier.sendAskReminder.mockRejectedValueOnce(new Error('network down'));
    const a = await ask();
    await runUntil(30 * MIN);
    expect(h.notifier.sendAskReminder).toHaveBeenCalledTimes(1);
    expect(h.store.get(a.id)?.reminders).toEqual([{ at: START + 10 * MIN }]);
  });

  it('deletes a reminder whose question closed while it was being sent', async () => {
    const deleteAskReminder = vi.fn(async () => undefined);
    (h.notifier as Record<string, unknown>).deleteAskReminder = deleteAskReminder;
    const a = await ask();
    h.notifier.sendAskReminder.mockImplementationOnce(async () => {
      await h.service.cancel(a.id);
      return { messageId: 555 };
    });
    await runUntil(11 * MIN);
    expect(deleteAskReminder).toHaveBeenCalledWith(expect.objectContaining({ id: a.id, state: 'cancelled' }), 555);
  });

  it('a text reply to a reminder answers the question', async () => {
    const a = await ask();
    await runUntil(11 * MIN);
    const reminderId = h.store.get(a.id)!.reminders![0].messageId!;
    expect(h.service.findByMessage(42, reminderId)?.id).toBe(a.id);
    const r = await h.service.answer({ askId: a.id, senderId: 7, chatId: 42, messageId: reminderId, text: 'go ahead' });
    expect(r.ok).toBe(true);
    expect(h.store.get(a.id)?.answer).toEqual({ kind: 'text', text: 'go ahead' });
  });

  it('sends nothing without the settings or a notifier that can remind', async () => {
    const plain = await harness();
    delete (plain.notifier as Partial<typeof plain.notifier>).sendAskReminder;
    const prev = h;
    h = plain;
    await ask();
    await runUntil(2 * HOUR, 5 * MIN);
    expect(h.store.all()[0].reminders).toBeUndefined();
    await plain.service.stop();
    await rm(plain.dir, { recursive: true, force: true });
    h = prev;
  });
});

describe('askReminderDue', () => {
  const created = START;
  const week = 7 * 24 * HOUR;

  it('caps a question open for a week at six reminders of the schedule plus one before it closes', () => {
    const a: Pick<AskRecord, 'createdAt' | 'expiresAt' | 'reminders'> = { createdAt: created, expiresAt: created + week, reminders: [] };
    for (let t = created; t < a.expiresAt; t += MIN) {
      const due = askReminderDue(a, DEFAULT_ASK_REMINDERS, t);
      if (due) a.reminders!.push({ at: t, ...(due === 'before_close' ? { kind: 'before_close' as const } : {}) });
    }
    expect(a.reminders!.map((r) => Math.round((r.at - created) / MIN))).toEqual([10, 60, 300, 540, 780, 1020, week / MIN - 10]);
  });

  it('keeps two reminders of the same question at least ten minutes apart', () => {
    // A 15-minute question: the reminder before closing (5 min) comes first; the 10-minute one is then too close.
    const a = { createdAt: created, expiresAt: created + 15 * MIN, reminders: [{ at: created + 5 * MIN, kind: 'before_close' as const }] };
    expect(askReminderDue(a, DEFAULT_ASK_REMINDERS, created + 10 * MIN)).toBeUndefined();
    expect(askReminderDue(a, DEFAULT_ASK_REMINDERS, created + 14 * MIN)).toBeUndefined();
  });

  it('owes nothing once the question has expired', () => {
    expect(askReminderDue({ createdAt: created, expiresAt: created + HOUR }, DEFAULT_ASK_REMINDERS, created + 2 * HOUR)).toBeUndefined();
  });
});

describe('validateAskReminders', () => {
  it('defaults to 10 minutes, 1 hour, then every 4 hours, and 10 minutes before closing', () => {
    expect(validateAskReminders(undefined)).toEqual({ schedule: { afterMinutes: [10, 60], thenEveryMinutes: 240, beforeCloseMinutes: 10 }, warnings: [] });
  });

  it('sorts and de-duplicates the schedule and accepts an empty one', () => {
    expect(validateAskReminders({ afterMinutes: [60, 5, 60] }).schedule.afterMinutes).toEqual([5, 60]);
    expect(validateAskReminders({ afterMinutes: [] }).schedule.afterMinutes).toEqual([]);
    expect(validateAskReminders({ afterMinutes: [10], thenEveryMinutes: 0, beforeCloseMinutes: 0 })).toEqual({
      schedule: { afterMinutes: [10], thenEveryMinutes: 0, beforeCloseMinutes: 0 }, warnings: [],
    });
  });

  it.each([
    ['not an object', 'every hour'],
    ['a repeat faster than 30 minutes', { thenEveryMinutes: 5 }],
    ['a fractional minute', { afterMinutes: [1.5] }],
    ['a negative value', { beforeCloseMinutes: -1 }],
  ])('falls back to the default with a warning for %s', (_name, raw) => {
    const r = validateAskReminders(raw);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.schedule).toEqual(DEFAULT_ASK_REMINDERS);
  });

  it('keeps the first six entries of a longer schedule', () => {
    const r = validateAskReminders({ afterMinutes: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(r.schedule.afterMinutes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('formatWaitDuration', () => {
  it.each([
    [30_000, '1 min'],
    [10 * MIN, '10 min'],
    [HOUR, '1 h'],
    [HOUR + 5 * MIN, '1 h 5 min'],
    [24 * HOUR, '1 d'],
    [27 * HOUR + 10 * MIN, '1 d 3 h'],
  ])('%d ms reads %s', (ms, text) => {
    expect(formatWaitDuration(ms)).toBe(text);
  });
});
