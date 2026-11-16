/**
 * `kookr ask` policy and state machine (docs/rfc/rfc-kookr-ask.md).
 *
 * The service is transport-agnostic: Telegram is an injected `AskNotifier`, and
 * "type this into the task's session" is an injected function. It owns every
 * rule — limits, idempotency, credential scrubbing, callback MAC checks, the
 * one-time answer compare-and-set, task liveness and expiry — so the Telegram
 * integration stays a thin transport.
 *
 * There is one record per question and two ways to answer it: Telegram
 * (`answer`) and the dashboard, where Lucy asks the same question
 * (`answerFromDashboard`). Each entry point runs its own channel checks and
 * then the same closing steps (`settle`), so whichever channel answers first
 * wins and the other one is told. Listeners registered with `onChange` hear
 * about every question sent and every question that left `pending`; that is
 * how the dashboard learns of an answer given on Telegram.
 *
 * Every state transition is a synchronous compare-and-set on
 * `state === 'pending'` against the in-memory store, so two concurrent taps
 * produce exactly one winner.
 *
 * An answer reaches the agent in one place. While a `kookr ask --wait` poll is
 * attached (`pollForWaiter`), the answer is left for it to print and is typed
 * into the session only as a fallback, if that poll does not read it in time.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { redactCredentials } from '../../integrations/telegram/redact.js';
import { isTerminalStatus, type TaskStatus } from '../../core/task-status.js';
import { isWithinQuietHours, type QuietHoursWindow } from '../../shared/contracts/quiet-hours.js';
import {
  ASK_LIMITS,
  ASK_REMINDER_LIMITS,
  askLinkProblem,
  askReminderDue,
  type AskReminderSchedule,
  type AnswerInput,
  type AnswerResult,
  type AskChange,
  type AskChannel,
  type AskNotifier,
  type AskRecord,
  ASK_WAIT_POLL_INTERVAL_MS,
  type AskState,
  type AskView,
  type CreateAskInput,
  type CreateAskResult,
  type DashboardAnswerInput,
} from '../../shared/contracts/asks.js';
import type { AskStore } from './ask-store.js';

const HOUR_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
const MAC_HEX_CHARS = 16;
const STALE_EXPIRY_NOTICE_MS = 5 * 60 * 1000;
const MAX_ANSWER_TEXT_CHARS = ASK_LIMITS.maxAnswerTextChars;
/** A `kookr ask --wait` poll counts as attached for this long after it: five of its polls, room for a slow one on a busy host. */
export const ASK_WAIT_ATTACHED_MS = 5 * ASK_WAIT_POLL_INTERVAL_MS;
/**
 * How long an answer left for an attached `--wait` poll waits to be read before it is typed into
 * the task after all (the CLI was killed, or its `--wait=<s>` window ran out just before the answer).
 */
export const ASK_WAIT_FALLBACK_MS = 15_000;
/** Stands in for a question/context that looked like a credential (the detector's own sentinel points at a dashboard view asks do not have). */
const REDACTED_PLACEHOLDER = '[redacted — looked like a credential]';

/** Whether an ask with this lifetime (timeout, in ms) is long-lived: counted against its own pending cap. */
function isLongLived(lifetimeMs: number): boolean {
  return lifetimeMs > ASK_LIMITS.longLivedAfterSec * 1000;
}

export interface AskServiceDeps {
  store: AskStore;
  /** The Telegram notifier, or undefined while Telegram is not configured. Resolved lazily (Telegram starts after the routes). */
  getNotifier: () => AskNotifier | undefined;
  /** Status of a task, or undefined when the task is unknown. */
  taskStatus: (taskId: string) => TaskStatus | undefined;
  /**
   * Type text into the task's live session (the same path as `kookr reply`). When `sessionId` is
   * given, deliver only if the live session is still that one or continues it (`sessionContinues`),
   * so a fresh session that replaced it between the check and the delivery is not typed into.
   */
  deliverToTask: (taskId: string, text: string, sessionId?: string) => Promise<{ ok: boolean; reason?: string }>;
  /** The task's current live session id, or undefined when it has none. Asks are pinned to it at creation. */
  liveSession?: (taskId: string) => string | undefined;
  /**
   * Whether the task's live session is `sessionId` or a session that resumed its conversation
   * (crash recovery, operator Reopen). Without it (or `liveSession`), pinned asks are delivered as if unpinned.
   */
  sessionContinues?: (taskId: string, sessionId: string) => boolean;
  /**
   * The live reminder schedule and quiet hours (issue #3929), read on every sweep so a settings
   * change applies at once. Absent: no reminders are sent.
   */
  reminderSettings?: () => { schedule: AskReminderSchedule; quietHours: readonly QuietHoursWindow[] };
  now?: () => number;
  log?: (message: string) => void;
}

export function toAskView(ask: AskRecord): AskView {
  const { nonce: _nonce, ...view } = ask;
  return view;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export class AskService {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(change: AskChange) => void>();
  /**
   * Pending ask id → when a `kookr ask --wait` poll last read it. In memory only, so `start()` marks
   * every pending question as polled: a `--wait` still running across a restart polls again within
   * one interval, and an answer given before that poll is left for it instead of typed at once.
   */
  private readonly waitPolls = new Map<string, number>();
  /** Answered ask id → the timer that types the answer if the attached `--wait` poll does not read it first. */
  private readonly typeFallbacks = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: AskServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  // ---------------------------------------------------------------- listeners

  /**
   * Hear about every question sent (`created`, once its Telegram message exists),
   * every question that left `pending` (`resolved`: answered on either
   * channel, expired or cancelled) and, for an answered
   * one, the moment it is known whether the answer could be typed into the
   * task (`updated`). Returns an unsubscribe
   * function. A listener that throws is logged and never affects the ask.
   */
  onChange(listener: (change: AskChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(kind: AskChange['kind'], id: string): void {
    const ask = this.deps.store.get(id);
    if (!ask) return;
    for (const listener of this.listeners) {
      try {
        listener({ kind, ask });
      } catch (err) {
        this.log(`[asks] change listener failed ask=${id}: ${String(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Boot reconciliation + periodic expiry sweep. A pending ask with no Telegram
   * message can only be a crash between "stored" and "sent", so it is cancelled
   * rather than left to hang its waiter until expiry.
   */
  async start(): Promise<void> {
    for (const ask of this.deps.store.all()) {
      if (ask.state === 'pending' && !ask.delivery) {
        this.transition(ask.id, 'cancelled', 'delivery_failed');
      }
      // Whether a `--wait` is still polling this question was lost with the restart (issue #4040).
      // Counting one as attached costs a question nobody waits on at most `ASK_WAIT_FALLBACK_MS` of
      // delay if answered in the next few seconds; not counting it would type and print the answer.
      if (ask.state === 'pending' && ask.delivery) this.waitPolls.set(ask.id, this.now());
      // An answer left for a `--wait` poll when the server stopped: give a poll that is still running
      // the usual time to read it, then type it. Older ones are left alone, like stale expiry notices.
      if (ask.state === 'answered' && ask.taskDelivery === undefined && ask.answeredAt !== undefined
        && this.now() - ask.answeredAt <= STALE_EXPIRY_NOTICE_MS) {
        // Not known whether the Telegram message was closed before the stop, so the fallback closes it.
        this.armTypeFallback(ask.id, false);
      }
    }
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`[asks] sweep failed: ${String(err)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  /** One maintenance pass: enforce retention, expire overdue asks, then send the reminders owed. */
  private async tick(): Promise<void> {
    this.deps.store.prune(this.now());
    await this.sweepExpired();
    await this.sendDueReminders();
  }

  /**
   * Remind the operator of questions still waiting (issue #3929), as a reply to each question's
   * Telegram message. Nothing is sent during quiet hours: the points of the schedule that pass then
   * are owed as one reminder when they end (`askReminderDue`). Runs from the sweep only, never from
   * a read, so a busy `--wait` poll cannot speed reminders up.
   */
  async sendDueReminders(): Promise<void> {
    const settings = this.deps.reminderSettings?.();
    const notifier = this.deps.getNotifier();
    if (!settings || !notifier?.sendAskReminder) return;
    const now = this.now();
    if (isWithinQuietHours(settings.quietHours, new Date(now))) return;

    const all = this.deps.store.all();
    // A reminder Telegram refused does not count: an outage must not use up the hour's reminders.
    let sentLastHour = 0;
    for (const a of all) for (const r of a.reminders ?? []) if (!r.failed && now - r.at < HOUR_MS) sentLastHour++;
    // Least recently reminded first, so when the hourly bound holds some back, the same questions
    // do not take the whole budget again on the next sweep.
    const lastReminded = (a: AskRecord): number => a.reminders?.at(-1)?.at ?? a.createdAt;
    const waiting = all.filter((a) => a.state === 'pending' && a.delivery).sort((a, b) => lastReminded(a) - lastReminded(b));
    for (const ask of waiting) {
      // Answered or withdrawn while an earlier reminder of this sweep was being sent.
      if (this.deps.store.get(ask.id)?.state !== 'pending') continue;
      const due = askReminderDue(ask, settings.schedule, now);
      if (due === undefined) continue;
      // Held back, not dropped: it is still owed on the next sweep with room in the hour.
      if (sentLastHour >= ASK_REMINDER_LIMITS.maxPerHour) return;
      // Recorded before the send: a sweep that overlaps a slow send, or a restart in the middle of
      // it, must not send the same reminder twice. A send that fails is marked `failed` (issue #4040):
      // it no longer counts against the bounds, but it still sets the time of the last reminder, so
      // it is not retried until the next point of the schedule, ten minutes later at the earliest.
      const index = ask.reminders?.length ?? 0;
      this.deps.store.update(ask.id, (a) => {
        a.reminders = [...(a.reminders ?? []), { at: now, ...(due === 'before_close' ? { kind: 'before_close' as const } : {}) }];
      });
      sentLastHour++;
      try {
        const { messageId } = await notifier.sendAskReminder(ask, reminderText(ask, now));
        this.deps.store.update(ask.id, (a) => {
          const entry = a.reminders?.[index];
          if (entry) entry.messageId = messageId;
        });
        this.log(`[asks] reminder sent ask=${ask.id} kind=${due}`);
        // Closed during the send: the closing step could not delete a reminder it did not know yet.
        const current = this.deps.store.get(ask.id);
        if (current && current.state !== 'pending') await notifier.deleteAskReminder?.(current, messageId);
      } catch (err) {
        this.deps.store.update(ask.id, (a) => {
          const entry = a.reminders?.[index];
          if (entry) entry.failed = true;
        });
        sentLastHour--;
        this.log(`[asks] reminder failed ask=${ask.id}: ${String(err)}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const fallback of this.typeFallbacks.values()) clearTimeout(fallback);
    this.typeFallbacks.clear();
    await this.deps.store.flush();
  }

  // ------------------------------------------------------------------- create

  async create(input: CreateAskInput): Promise<CreateAskResult> {
    const notifier = this.deps.getNotifier();
    if (!notifier) return { ok: false, error: { code: 'not_configured' } };

    const status = this.deps.taskStatus(input.taskId);
    if (status === undefined) return { ok: false, error: { code: 'unknown_task' } };
    if (isTerminalStatus(status)) return { ok: false, error: { code: 'terminal_task' } };

    const key = input.idempotencyKey;
    if (key !== undefined) {
      if (key.length === 0 || key.length > ASK_LIMITS.maxIdempotencyKeyChars) {
        return invalid('idempotencyKey must be 1..128 characters');
      }
      const existing = this.deps.store.all().find((a) => a.taskId === input.taskId && a.idempotencyKey === key && a.state === 'pending');
      if (existing) {
        // The same question asked again from a session that replaced the pinned one (the task was
        // relaunched and asked again): the new session is now the one waiting, so the answer goes there.
        const session = this.deps.liveSession?.(input.taskId);
        if (session !== undefined && existing.sessionId !== session) {
          this.deps.store.update(existing.id, (a) => { a.sessionId = session; });
        }
        return { ok: true, ask: this.deps.store.get(existing.id) ?? existing, deduped: true, redacted: [] };
      }
    }

    const question = input.question.trim();
    if (question.length === 0 || question.length > ASK_LIMITS.maxQuestionChars) {
      return invalid(`question must be 1..${ASK_LIMITS.maxQuestionChars} characters`);
    }
    const context = input.context?.trim() || undefined;
    if (context !== undefined && context.length > ASK_LIMITS.maxContextChars) {
      return invalid(`context must be at most ${ASK_LIMITS.maxContextChars} characters`);
    }
    const options = input.options.map((o) => o.trim());
    if (options.length < 2 || options.length > ASK_LIMITS.maxOptions) {
      return invalid(`provide 2..${ASK_LIMITS.maxOptions} options`);
    }
    for (const label of options) {
      if (label.length === 0 || label.length > ASK_LIMITS.maxLabelChars || /[\r\n]/.test(label)) {
        return invalid(`each option must be a single line of 1..${ASK_LIMITS.maxLabelChars} characters`);
      }
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      return invalid('options must be distinct');
    }
    if (options.some((label) => redactCredentials(label) !== label)) {
      return { ok: false, error: { code: 'redacted_option' } };
    }
    const links = input.links ?? [];
    if (links.length > ASK_LIMITS.maxLinks) return invalid(`at most ${ASK_LIMITS.maxLinks} links`);
    for (const link of links) {
      const problem = askLinkProblem(link);
      if (problem) return invalid(problem);
      // A URL cannot be partly replaced with a placeholder and still open, so one that looks like it
      // carries a credential is refused outright.
      if (redactCredentials(link.url) !== link.url || (link.label !== undefined && redactCredentials(link.label) !== link.label)) {
        return invalid('a link looks like it contains a credential');
      }
    }
    const timeoutSec = input.timeoutSec ?? ASK_LIMITS.defaultTimeoutSec;
    if (!Number.isFinite(timeoutSec) || timeoutSec < ASK_LIMITS.minTimeoutSec || timeoutSec > ASK_LIMITS.maxTimeoutSec) {
      return invalid(`timeout must be ${ASK_LIMITS.minTimeoutSec}..${ASK_LIMITS.maxTimeoutSec} seconds`);
    }

    const limited = this.checkRateLimits(input.taskId, isLongLived(timeoutSec * 1000));
    if (limited) {
      this.log(`[asks] rate limited (${limited}) task=${input.taskId}`);
      return { ok: false, error: { code: 'rate_limited', scope: limited } };
    }

    const scrub = (text: string): string => (redactCredentials(text) === text ? text : REDACTED_PLACEHOLDER);
    const safeQuestion = scrub(question);
    const safeContext = context === undefined ? undefined : scrub(context);
    const redacted: Array<'question' | 'context'> = [];
    if (safeQuestion !== question) redacted.push('question');
    if (safeContext !== context) redacted.push('context');

    const createdAt = this.now();
    const sessionId = this.deps.liveSession?.(input.taskId);
    const ask: AskRecord = {
      id: randomBytes(6).toString('hex'),
      taskId: input.taskId,
      question: safeQuestion,
      ...(safeContext !== undefined ? { context: safeContext } : {}),
      options,
      ...(links.length > 0 ? { links: links.map((l) => ({ url: l.url, ...(l.label !== undefined ? { label: l.label.trim() } : {}) })) } : {}),
      allowText: input.allowText !== false,
      state: 'pending',
      createdAt,
      expiresAt: createdAt + timeoutSec * 1000,
      nonce: randomBytes(16).toString('hex'),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    this.deps.store.insert(ask);

    try {
      const delivery = await notifier.sendAsk(ask, (idx) => this.callbackData(ask, idx));
      this.deps.store.update(ask.id, (a) => { a.delivery = delivery; });
      // The ask may have been cancelled/expired while the send was in flight;
      // its message was not finalizable then (no delivery yet), so close it now.
      const current = this.deps.store.get(ask.id) as AskRecord;
      if (current.state !== 'pending') {
        await this.finalize(current, current.state === 'expired' ? '⌛ Expired — no answer.' : '🚫 Cancelled by the asking task.');
      } else {
        // Announced only now, with the Telegram message in place: an answer given
        // in the dashboard can then always close that message.
        this.emit('created', ask.id);
      }
    } catch (err) {
      this.transition(ask.id, 'cancelled', 'delivery_failed');
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[asks] delivery failed ask=${ask.id}: ${message}`);
      return { ok: false, error: { code: 'delivery_failed', message } };
    }
    return { ok: true, ask: this.deps.store.get(ask.id) ?? ask, deduped: false, redacted };
  }

  /**
   * `longLived`: whether the new ask is long-lived. Open asks count against the cap of their own kind
   * only, so opinion requests left open for days never block a short question, and the reverse.
   */
  private checkRateLimits(taskId: string, longLived: boolean): 'task_pending' | 'task_hourly' | 'global_hourly' | null {
    const since = this.now() - HOUR_MS;
    let pending = 0;
    let taskHourly = 0;
    let globalHourly = 0;
    for (const a of this.deps.store.all()) {
      if (a.createdAt < since) continue;
      globalHourly++;
      if (a.taskId === taskId) taskHourly++;
    }
    for (const a of this.deps.store.all()) {
      if (a.taskId === taskId && a.state === 'pending' && isLongLived(a.expiresAt - a.createdAt) === longLived) pending++;
    }
    if (pending >= (longLived ? ASK_LIMITS.maxLongLivedPendingPerTask : ASK_LIMITS.maxPendingPerTask)) return 'task_pending';
    if (taskHourly >= ASK_LIMITS.maxPerTaskPerHour) return 'task_hourly';
    if (globalHourly >= ASK_LIMITS.maxGlobalPerHour) return 'global_hourly';
    return null;
  }

  // -------------------------------------------------------------------- reads

  async get(id: string): Promise<AskRecord | undefined> {
    await this.sweepExpired();
    return this.deps.store.get(id);
  }

  async list(filter: { taskId?: string; state?: AskState } = {}): Promise<AskRecord[]> {
    await this.sweepExpired();
    return this.deps.store
      .all()
      .filter((a) => (filter.taskId === undefined || a.taskId === filter.taskId)
        && (filter.state === undefined || a.state === filter.state))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * One poll from `kookr ask --wait` (`GET /api/asks/:id?wait=1`). While such polls keep coming, an
   * answer is left for the CLI to print instead of also being typed into the session; the poll that
   * reads the answer cancels the typing (`taskDelivery: 'delivered'`). Any other read does not count.
   */
  async pollForWaiter(id: string): Promise<AskRecord | undefined> {
    await this.sweepExpired();
    const ask = this.deps.store.get(id);
    if (!ask) return undefined;
    if (ask.state === 'pending') this.waitPolls.set(id, this.now());
    const fallback = this.typeFallbacks.get(id);
    if (fallback !== undefined && ask.state === 'answered') {
      clearTimeout(fallback);
      this.typeFallbacks.delete(id);
      this.deps.store.update(id, (a) => { a.taskDelivery = 'delivered'; });
      this.emit('updated', id);
    }
    return this.deps.store.get(id);
  }

  /** Every stored ask, without the expiry sweep `list` runs first. For synchronous callers (the dashboard push). */
  all(): AskRecord[] {
    return this.deps.store.all();
  }

  /** The ask whose question message, or one of whose reminders, is (chatId, messageId). */
  findByMessage(chatId: number, messageId: number): AskRecord | undefined {
    return this.deps.store.all().find((a) => a.delivery?.chatId === chatId && isAskMessage(a, messageId));
  }

  // ------------------------------------------------------------------- cancel

  async cancel(id: string): Promise<{ ok: true; ask: AskRecord } | { ok: false; reason: 'not_found' | 'not_pending' }> {
    const ask = this.deps.store.get(id);
    if (!ask) return { ok: false, reason: 'not_found' };
    if (!this.transition(id, 'cancelled', 'cancelled')) return { ok: false, reason: 'not_pending' };
    const done = this.deps.store.get(id) as AskRecord;
    await this.finalize(done, '🚫 Cancelled by the asking task.');
    return { ok: true, ask: done };
  }

  // ------------------------------------------------------------------- answer

  callbackData(ask: AskRecord, optionIndex: number): string {
    return `ask:${ask.id}:${optionIndex}:${this.mac(ask, optionIndex)}`;
  }

  private mac(ask: AskRecord, optionIndex: number): string {
    return createHmac('sha256', this.deps.store.secret)
      .update(`${ask.id}|${optionIndex}|${ask.nonce}`)
      .digest('hex')
      .slice(0, MAC_HEX_CHARS);
  }

  /**
   * Record an operator answer that arrived over Telegram. The caller (the
   * Telegram integration) has already verified the sender is allowlisted; this
   * method verifies everything bound to the ask itself.
   */
  async answer(input: AnswerInput): Promise<AnswerResult> {
    const ask = this.deps.store.get(input.askId);
    if (!ask) return { ok: false, reason: 'not_found' };

    if (input.option) {
      if (typeof input.option.mac !== 'string' || !Number.isInteger(input.option.index)) {
        return { ok: false, reason: 'forged' };
      }
      const expected = Buffer.from(this.mac(ask, input.option.index));
      const given = Buffer.from(input.option.mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return { ok: false, reason: 'forged' };
      }
    }
    if (!ask.delivery || ask.delivery.chatId !== input.chatId || !isAskMessage(ask, input.messageId)) {
      return { ok: false, reason: 'wrong_chat', ask };
    }
    return this.settle(
      ask.id,
      input.option ? { optionIndex: input.option.index } : { text: input.text },
      { via: 'telegram', senderId: input.senderId },
    );
  }

  /**
   * Record an operator answer given in the dashboard, where Lucy asked the same
   * question. The caller (the dashboard socket) has already verified that the
   * connection belongs to the owner; there is no button MAC or chat to check.
   * The Telegram message is then edited to say the question was answered in
   * Kookr, so the operator's phone stops asking.
   */
  async answerFromDashboard(input: DashboardAnswerInput): Promise<AnswerResult> {
    // A question with no Telegram message yet was never shown in the dashboard either.
    if (!this.deps.store.get(input.askId)?.delivery) return { ok: false, reason: 'not_found' };
    const hasOption = input.optionIndex !== undefined;
    const hasText = input.text !== undefined;
    if (hasOption === hasText) return { ok: false, reason: 'bad_option', ask: this.deps.store.get(input.askId) };
    return this.settle(
      input.askId,
      hasOption ? { optionIndex: input.optionIndex } : { text: input.text },
      { via: 'dashboard' },
    );
  }

  /**
   * The closing steps shared by both channels: expiry, state, the chosen option
   * or text, task liveness, the one-time compare-and-set, typing the answer into
   * the task, and closing the Telegram message.
   */
  private async settle(
    askId: string,
    choice: { optionIndex?: number; text?: string },
    source: { via: AskChannel; senderId?: number },
  ): Promise<AnswerResult> {
    let ask = this.deps.store.get(askId);
    if (!ask) return { ok: false, reason: 'not_found' };

    if (ask.state === 'pending' && ask.expiresAt <= this.now()) await this.expire(ask.id);
    ask = this.deps.store.get(askId) as AskRecord;
    if (ask.state === 'expired') return { ok: false, reason: 'expired', ask };
    if (ask.state === 'cancelled') return { ok: false, reason: 'cancelled', ask };
    if (ask.state === 'answered') return { ok: false, reason: 'already_answered', ask };

    let answer: AskRecord['answer'];
    if (choice.optionIndex !== undefined) {
      const label = Number.isInteger(choice.optionIndex) ? ask.options[choice.optionIndex] : undefined;
      if (label === undefined) return { ok: false, reason: 'bad_option', ask };
      answer = { kind: 'option', index: choice.optionIndex, label };
    } else {
      if (!ask.allowText) return { ok: false, reason: 'text_not_allowed', ask };
      const text = (choice.text ?? '').trim();
      if (text.length === 0 || text.length > MAX_ANSWER_TEXT_CHARS) return { ok: false, reason: 'bad_option', ask };
      answer = { kind: 'text', text };
    }

    // The answer is always recorded. It is typed into the task only while the session that asked (or
    // one that resumed its conversation) can still read it: not once the task has ended, and not into
    // a fresh session that replaced the asker after a relaunch, because that session never saw the question.
    const skipReason = this.notTypedReason(ask);

    // One-time answer. There is no `await` between the state checks above and this write, so a
    // concurrent answer (a second tap, or the other channel) is refused by those checks; this
    // re-check only keeps the compare-and-set explicit should an `await` ever be added in between.
    if (this.deps.store.get(ask.id)?.state !== 'pending') {
      return { ok: false, reason: 'already_answered', ask: this.deps.store.get(ask.id) };
    }
    this.deps.store.update(ask.id, (a) => {
      a.state = 'answered';
      a.resolution = 'answered';
      a.answer = answer;
      a.answeredAt = this.now();
      a.resolvedAt = a.answeredAt;
      a.answeredVia = source.via;
      if (source.senderId !== undefined) a.answeredBy = source.senderId;
      if (skipReason !== undefined) a.taskDelivery = 'skipped';
    });
    const lastWaitPoll = this.waitPolls.get(ask.id);
    this.waitPolls.delete(ask.id);
    this.emit('resolved', ask.id);

    const done = this.deps.store.get(ask.id) as AskRecord;
    if (skipReason !== undefined) {
      await this.finalize(done, `${answerHeadline(done)}\nRecorded. ${skipReason}`);
      return { ok: true, ask: done, notTyped: skipReason };
    }
    if (lastWaitPoll !== undefined && this.now() - lastWaitPoll <= ASK_WAIT_ATTACHED_MS) {
      // A `kookr ask --wait` poll is attached and will print the answer: typing it too would hand the
      // agent the same answer twice. It is typed only if that poll does not read it in time.
      this.armTypeFallback(ask.id, true);
      await this.finalize(done, answerHeadline(done));
      return { ok: true, ask: done };
    }
    return { ok: true, ask: await this.typeAnswer(ask.id) };
  }

  /**
   * Type a recorded answer into the asking task and close the Telegram message with the outcome.
   * Runs at once when no `--wait` poll is attached, or later as the fallback for one that is.
   * `closed`: the message already shows the answer, so it is edited again only to add a warning
   * (Telegram refuses an edit that changes nothing).
   */
  private async typeAnswer(id: string, closed = false): Promise<AskRecord> {
    const ask = this.deps.store.get(id) as AskRecord;
    const answer = ask.answer as NonNullable<AskRecord['answer']>;
    const headline = answerHeadline(ask);
    // Checked again here because a fallback runs seconds after the answer: the task may have ended or been relaunched since.
    const skipReason = this.notTypedReason(ask);
    if (skipReason !== undefined) {
      this.deps.store.update(id, (a) => { a.taskDelivery = 'skipped'; });
      this.emit('updated', id);
      const done = this.deps.store.get(id) as AskRecord;
      await this.finalize(done, `${headline}\nRecorded. ${skipReason}`);
      return done;
    }

    // The text typed into the task is the same on both channels, so agents need not care which one answered.
    const label = answer.kind === 'option' ? answer.label : `(free text) ${oneLine(answer.text)}`;
    const delivered = await this.deliver(ask, `Operator answered ask ${ask.id}: ${label}`)
      .catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    this.deps.store.update(id, (a) => { a.taskDelivery = delivered.ok ? 'delivered' : 'failed'; });
    // The dashboard closed its card on `resolved`; tell it now whether the answer reached the task.
    this.emit('updated', id);

    const done = this.deps.store.get(id) as AskRecord;
    if (closed && delivered.ok) return done;
    await this.finalize(
      done,
      delivered.ok
        ? headline
        : `${headline}\n⚠️ Could not type it into the task (${delivered.reason ?? 'unknown'}). It can still read the answer via kookr ask --wait.`,
    );
    return done;
  }

  /** Type the answer after `ASK_WAIT_FALLBACK_MS` unless a `--wait` poll reads it first (`pollForWaiter`). */
  private armTypeFallback(id: string, closed: boolean): void {
    const timer = setTimeout(() => {
      this.typeFallbacks.delete(id);
      this.typeAnswer(id, closed).catch((err) => this.log(`[asks] fallback typing failed ask=${id}: ${String(err)}`));
    }, ASK_WAIT_FALLBACK_MS);
    timer.unref();
    this.typeFallbacks.set(id, timer);
  }

  // ------------------------------------------------------------------- expiry

  async sweepExpired(): Promise<void> {
    const due = this.deps.store.all().filter((a) => a.state === 'pending' && a.expiresAt <= this.now());
    for (const ask of due) await this.expire(ask.id);
  }

  private async expire(id: string): Promise<void> {
    if (!this.transition(id, 'expired', 'expired')) return;
    const ask = this.deps.store.get(id) as AskRecord;
    await this.finalize(ask, '⌛ Expired — no answer.');
    // After a long outage the boot sweep would otherwise type a burst of stale
    // notices into sessions that have long moved on: only notify when fresh.
    const status = this.deps.taskStatus(ask.taskId);
    const fresh = this.now() - ask.expiresAt <= STALE_EXPIRY_NOTICE_MS;
    if (fresh && status !== undefined && !isTerminalStatus(status) && !this.replacedByFreshSession(ask)) {
      await this.deliver(ask, `Ask ${ask.id} expired with no answer.`).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Type `text` into the asking task, restricted to the pinned session when the ask has one. */
  private deliver(ask: AskRecord, text: string): Promise<{ ok: boolean; reason?: string }> {
    return ask.sessionId === undefined
      ? this.deps.deliverToTask(ask.taskId, text)
      : this.deps.deliverToTask(ask.taskId, text, ask.sessionId);
  }

  /**
   * Whether a session that does not continue the pinned one is now live. False for unpinned asks, and
   * while no session is live at all (for example a Reopen still waiting for a worker slot): delivery is
   * then attempted as usual and, still bound to the pin, fails without typing. When true, the answer is
   * recorded and nothing is typed (`taskDelivery: 'skipped'`).
   */
  private replacedByFreshSession(ask: AskRecord): boolean {
    if (ask.sessionId === undefined || !this.deps.sessionContinues || !this.deps.liveSession) return false;
    if (this.deps.liveSession(ask.taskId) === undefined) return false;
    return !this.deps.sessionContinues(ask.taskId, ask.sessionId);
  }

  /** Why an answer must not be typed into the asking task now, or undefined when it may be. */
  private notTypedReason(ask: AskRecord): string | undefined {
    const status = this.deps.taskStatus(ask.taskId);
    if (status === undefined || isTerminalStatus(status)) return 'The task has ended, so nothing was typed into it.';
    if (this.replacedByFreshSession(ask)) return 'The task was relaunched in a new session since it asked, so nothing was typed into it.';
    return undefined;
  }

  /** CAS pending → `state`. Returns false when the ask was not pending. */
  private transition(id: string, state: AskState, resolution: NonNullable<AskRecord['resolution']>): boolean {
    const ask = this.deps.store.get(id);
    if (!ask || ask.state !== 'pending') return false;
    this.waitPolls.delete(id);
    this.deps.store.update(id, (a) => { a.state = state; a.resolution = resolution; a.resolvedAt = this.now(); });
    this.emit('resolved', id);
    return true;
  }

  /** Edit the Telegram message to its final text. Best effort: never throws. */
  private async finalize(ask: AskRecord, headline: string): Promise<void> {
    const notifier = this.deps.getNotifier();
    if (!notifier || !ask.delivery) return;
    try {
      await notifier.finalizeAsk(ask, `${headline}\n\n❓ ${ask.question}`);
    } catch (err) {
      this.log(`[asks] finalize failed ask=${ask.id}: ${String(err)}`);
    }
  }
}

/** Whether `messageId` is the question's Telegram message or one of its reminders (same chat). */
function isAskMessage(ask: AskRecord, messageId: number): boolean {
  return ask.delivery?.messageId === messageId || (ask.reminders ?? []).some((r) => r.messageId === messageId);
}

/** "10 min", "2 h", "2 h 5 min", "3 d 4 h": a duration in the two largest units that matter. */
export function formatWaitDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** The reminder text: how long the question has waited, when it closes, and how to answer it. */
export function reminderText(ask: AskRecord, now: number): string {
  // By code point, so an emoji is never cut in half.
  const chars = Array.from(ask.question);
  const short = chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : ask.question;
  return [
    `⏰ Still waiting for your answer: asked ${formatWaitDuration(now - ask.createdAt)} ago, closes in ${formatWaitDuration(ask.expiresAt - now)}.`,
    '',
    `❓ ${short}`,
    '',
    ask.allowText
      ? 'Tap the question above to answer with its buttons, or reply to this message with text.'
      : 'Tap the question above to answer with its buttons.',
  ].join('\n');
}

/** The first line of the closed Telegram message for an answered ask. */
function answerHeadline(ask: AskRecord): string {
  const chosen = ask.answer?.kind === 'text' ? ask.answer.text : ask.answer?.label ?? '';
  return ask.answeredVia === 'dashboard'
    ? `✅ Already answered in Kookr: ${chosen}\nNothing more is needed here.`
    : `✅ Answered: ${chosen}`;
}

function invalid(message: string): CreateAskResult {
  return { ok: false, error: { code: 'invalid', message } };
}
