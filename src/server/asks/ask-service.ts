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
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { redactCredentials } from '../../integrations/telegram/redact.js';
import { isTerminalStatus, type TaskStatus } from '../../core/task-status.js';
import {
  ASK_LIMITS,
  type AnswerInput,
  type AnswerResult,
  type AskChange,
  type AskChannel,
  type AskNotifier,
  type AskRecord,
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
const MAX_ANSWER_TEXT_CHARS = 1000;
/** Stands in for a question/context that looked like a credential (the detector's own sentinel points at a dashboard view asks do not have). */
const REDACTED_PLACEHOLDER = '[redacted — looked like a credential]';

export interface AskServiceDeps {
  store: AskStore;
  /** The Telegram notifier, or undefined while Telegram is not configured. Resolved lazily (Telegram starts after the routes). */
  getNotifier: () => AskNotifier | undefined;
  /** Status of a task, or undefined when the task is unknown. */
  taskStatus: (taskId: string) => TaskStatus | undefined;
  /** Type text into the task's live session (the same path as `kookr reply`). */
  deliverToTask: (taskId: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
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

  constructor(private readonly deps: AskServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  // ---------------------------------------------------------------- listeners

  /**
   * Hear about every question sent (`created`, once its Telegram message exists),
   * every question that left `pending` (`resolved`: answered on either
   * channel, expired, cancelled, or its task went away) and, for an answered
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
    }
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`[asks] sweep failed: ${String(err)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  /** One maintenance pass: enforce retention, then expire overdue asks. */
  private async tick(): Promise<void> {
    this.deps.store.prune(this.now());
    await this.sweepExpired();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      if (existing) return { ok: true, ask: existing, deduped: true, redacted: [] };
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
    const timeoutSec = input.timeoutSec ?? ASK_LIMITS.defaultTimeoutSec;
    if (!Number.isFinite(timeoutSec) || timeoutSec < ASK_LIMITS.minTimeoutSec || timeoutSec > ASK_LIMITS.maxTimeoutSec) {
      return invalid(`timeout must be ${ASK_LIMITS.minTimeoutSec}..${ASK_LIMITS.maxTimeoutSec} seconds`);
    }

    const limited = this.checkRateLimits(input.taskId);
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
    const ask: AskRecord = {
      id: randomBytes(6).toString('hex'),
      taskId: input.taskId,
      question: safeQuestion,
      ...(safeContext !== undefined ? { context: safeContext } : {}),
      options,
      allowText: input.allowText !== false,
      state: 'pending',
      createdAt,
      expiresAt: createdAt + timeoutSec * 1000,
      nonce: randomBytes(16).toString('hex'),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
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

  private checkRateLimits(taskId: string): 'task_pending' | 'task_hourly' | 'global_hourly' | null {
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
      if (a.taskId === taskId && a.state === 'pending') pending++;
    }
    if (pending >= ASK_LIMITS.maxPendingPerTask) return 'task_pending';
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

  /** Every stored ask, without the expiry sweep `list` runs first. For synchronous callers (the dashboard push). */
  all(): AskRecord[] {
    return this.deps.store.all();
  }

  findByMessage(chatId: number, messageId: number): AskRecord | undefined {
    return this.deps.store.all().find((a) => a.delivery?.chatId === chatId && a.delivery.messageId === messageId);
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
    if (!ask.delivery || ask.delivery.chatId !== input.chatId || ask.delivery.messageId !== input.messageId) {
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

    // Do not type into a session whose task is gone.
    const status = this.deps.taskStatus(ask.taskId);
    if (status === undefined || isTerminalStatus(status)) {
      this.transition(ask.id, 'cancelled', 'task_gone');
      const gone = this.deps.store.get(ask.id) as AskRecord;
      await this.finalize(gone, '⚠️ The task is no longer running — your answer was not delivered.');
      return { ok: false, reason: 'task_gone', ask: gone };
    }

    // One-time answer: synchronous CAS, so a concurrent answer (a second tap, or
    // the other channel) loses here.
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
    });
    this.emit('resolved', ask.id);

    // The text typed into the task is the same on both channels, so agents need not care which one answered.
    const label = answer.kind === 'option' ? answer.label : `(free text) ${oneLine(answer.text)}`;
    const delivered = await this.deps.deliverToTask(ask.taskId, `Operator answered ask ${ask.id}: ${label}`)
      .catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    this.deps.store.update(ask.id, (a) => { a.taskDelivery = delivered.ok ? 'delivered' : 'failed'; });
    // The dashboard closed its card on `resolved`; tell it now whether the answer reached the task.
    this.emit('updated', ask.id);

    const done = this.deps.store.get(ask.id) as AskRecord;
    const chosen = answer.kind === 'option' ? answer.label : answer.text;
    const headline = source.via === 'dashboard'
      ? `✅ Already answered in Kookr: ${chosen}\nNothing more is needed here.`
      : `✅ Answered: ${chosen}`;
    await this.finalize(
      done,
      delivered.ok
        ? headline
        : `${headline}\n⚠️ Could not type it into the task (${delivered.reason ?? 'unknown'}). It can still read the answer via kookr ask --wait.`,
    );
    return { ok: true, ask: done };
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
    if (fresh && status !== undefined && !isTerminalStatus(status)) {
      await this.deps.deliverToTask(ask.taskId, `Ask ${ask.id} expired with no answer.`).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ helpers

  /** CAS pending → `state`. Returns false when the ask was not pending. */
  private transition(id: string, state: AskState, resolution: NonNullable<AskRecord['resolution']>): boolean {
    const ask = this.deps.store.get(id);
    if (!ask || ask.state !== 'pending') return false;
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

function invalid(message: string): CreateAskResult {
  return { ok: false, error: { code: 'invalid', message } };
}
